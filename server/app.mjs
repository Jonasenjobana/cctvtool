import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CameraStore, calibrationKeys, calibrationOf } from './store.mjs';
import { LiveGbsClient } from './livegbs.mjs';
import { readImageInfo } from './image.mjs';
import { httpError } from './errors.mjs';
import { playbackSource } from './playback.mjs';
import { createScanPlan, ptzMatches, scanTarget, waitForScanTarget } from './snapshot-scan.mjs';
import { registerRecognitionRoutes } from './recognition.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const nullableNumber = (minimum, maximum) => ({ type: ['number', 'null'], minimum, maximum });
const calibrationProperties = {
  longitude: nullableNumber(-180, 180),
  latitude: nullableNumber(-90, 90),
  height: nullableNumber(0, 100000),
  pAxisPitch: { type: 'number', minimum: -180, maximum: 180 },
  pAxisRoll: { type: 'number', minimum: -180, maximum: 180 },
  panOffset: { type: 'number', minimum: -360, maximum: 360 },
  tiltOffset: { type: 'number', minimum: -180, maximum: 180 },
  imageRoll: { type: 'number', minimum: -180, maximum: 180 },
};
const calibrationSchema = {
  type: 'object', additionalProperties: false,
  properties: calibrationProperties, required: calibrationKeys,
};
const cameraSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    serial: { type: 'string', minLength: 1, maxLength: 100 },
    code: { type: 'string', minLength: 1, maxLength: 100 },
    ...calibrationProperties,
  },
  required: ['name', 'serial', 'code', ...calibrationKeys],
};
const preciseProperties = {
  pan: { type: 'number', minimum: 0, maximum: 360 },
  tilt: { type: 'number', minimum: 0, maximum: 360 },
  zoom: { type: 'number', minimum: 1 },
};
const pageSchema = { type: 'object', additionalProperties: false, properties: {
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
  offset: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,8})$' },
} };
const pageOptions = (query) => ({ ...(query.limit ? { limit: Number(query.limit) } : {}), offset: Number(query.offset || 0) });
const fieldLabels = {
  name: '名称', serial: '设备编号', code: '通道编号', longitude: '经度', latitude: '纬度', height: '高度',
  pAxisPitch: 'P 轴前后倾', pAxisRoll: 'P 轴左右倾', panOffset: '默认朝向',
  tiltOffset: 'T 偏移', imageRoll: '画面 Roll 修正',
  command: '控制指令', speed: '控制速度', pan: '目标 P', tilt: '目标 T', zoom: '目标 Z',
  basePtz: '基础 PTZ', panMin: '最小 P', panMax: '最大 P', settleMs: '稳定等待时间', moveTimeoutMs: '定位超时',
};

export async function createApp({
  recognizer,
  dataDir = resolve(projectDir, process.env.DATA_DIR || 'data'),
  webDir = join(projectDir, 'dist/web/browser'),
  livegbs = new LiveGbsClient({
    baseUrl: process.env.LIVEGBS_URL,
    username: process.env.LIVEGBS_USERNAME,
    password: process.env.LIVEGBS_PASSWORD,
    timeoutMs: Number(process.env.LIVEGBS_TIMEOUT_MS || 15000),
  }),
} = {}) {
  const app = Fastify({ logger: false, bodyLimit: 65536, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const store = new CameraStore(dataDir);
  store.interruptSnapshotGroups();
  const operations = new Set();
  const moving = new Map();
  const pendingControls = new Map();
  const pendingStops = new Map();
  const activeScans = new Map();
  const isBusy = (id) => operations.has(id) || moving.has(id) || pendingStops.has(id);
  const recognition = registerRecognitionRoutes(app, { store, dataDir, isBusy, recognizer });
  app.addHook('onClose', async () => {
    const stopped = await Promise.allSettled([...moving.keys()].map((id) => stopDevice(id, 129)));
    for (const result of stopped) if (result.status === 'rejected') console.error('关闭服务时停止云台失败', result.reason);
    await recognition.close();
    store.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      const fields = [...new Set(error.validation.map((item) => {
        const key = item.instancePath.split('/').at(-1) || item.params.missingProperty;
        return fieldLabels[key] || '参数';
      }))];
      return reply.code(400).send({ message: `请检查${fields.join('、')}的格式和范围` });
    }
    const status = error.statusCode || 500;
    if (status >= 500 && !error.statusCode) console.error('后端操作失败', error);
    return reply.code(status).send({ message: error.statusCode ? error.message : '保存或读取失败，请检查后端日志' });
  });

  async function withDeviceOperation(id, action) {
    if (isBusy(id)) throw httpError(409, '该摄像头正在控制或截图，请先停止控制后重试');
    operations.add(id);
    try { return await action(); } finally { operations.delete(id); }
  }

  async function trackControl(id, action) {
    if (isBusy(id)) throw httpError(409, '该摄像头正在控制或截图，请先停止控制后重试');
    const task = withDeviceOperation(id, action);
    pendingControls.set(id, task);
    try { return await task; } finally {
      if (pendingControls.get(id) === task) pendingControls.delete(id);
    }
  }

  async function stopDevice(id, speed, action = 'cancel') {
    const scan = activeScans.get(id);
    if (scan && action === 'cancel') scan.action = 'cancel';
    if (pendingStops.has(id)) return pendingStops.get(id);
    const camera = moving.get(id) || store.getCamera(id);
    const pending = pendingControls.get(id);
    const task = (async () => {
      // 启动失败也可能已经驱动设备，仍在它结束后发送 stop；扫描初始化也遵守此顺序。
      if (pending) { try { await pending; } catch { /* 原请求向其调用方保留失败响应。 */ } }
      const currentScan = activeScans.get(id);
      if (currentScan) {
        if (currentScan.action !== 'cancel') currentScan.action = action;
        currentScan.controller.abort();
        // 等待在途精确定位或截图返回，扫描任务随后发送 stop，避免 stop 被迟到定位覆盖。
        await currentScan.task;
        if (currentScan.stopError) throw currentScan.stopError;
        return { command: 'stop', speed, sentAt: new Date().toISOString() };
      }
      await livegbs.continuousControl(camera, 'stop', speed);
      moving.delete(id);
      return { command: 'stop', speed, sentAt: new Date().toISOString() };
    })();
    pendingStops.set(id, task);
    try { return await task; } finally {
      if (pendingStops.get(id) === task) pendingStops.delete(id);
    }
  }

  async function captureSnapshot(camera, calibration, scan) {
    const before = await livegbs.readPtz(camera);
    scan?.signal.throwIfAborted();
    if (scan && !ptzMatches(before.raw, scan.target, scan.panTolerance)) throw httpError(502, '截图前云台偏离目标，自动截图已终止');
    const image = await livegbs.snapshot(camera);
    scan?.signal.throwIfAborted();
    const after = await livegbs.readPtz(camera);
    scan?.signal.throwIfAborted();
    const poseChanged = ['Pan', 'Tilt', 'Zoom', 'HorizontalFieldAngle', 'VerticalFieldAngle']
      .some((key) => before.raw[key] !== after.raw[key]);
    if (scan && (poseChanged || !ptzMatches(after.raw, scan.target, scan.panTolerance))) {
      throw httpError(502, '截图期间云台姿态发生变化，本张未保存，自动截图已终止');
    }
    const info = readImageInfo(image.bytes);
    const id = randomUUID();
    const fileName = `${id}.${info.extension}`;
    const filePath = join(dataDir, 'snapshots', fileName);
    const snapshot = {
      id, cameraId: camera.id, cameraName: camera.name, serial: camera.serial, code: camera.code,
      imageUrl: `/api/snapshots/${id}/image`, fileName,
      width: info.width, height: info.height, contentType: info.contentType, bytes: image.bytes.length,
      createdAt: new Date().toISOString(), requestedAt: image.requestedAt,
      receivedAt: image.receivedAt, durationMs: image.durationMs, snapshotTime: image.snapshotTime,
      ptz: before, ptzAfter: after, calibration,
      usesDraft: calibrationKeys.some((key) => calibration[key] !== camera[key]),
      poseChanged, timeAlignment: 'unverified',
      ...(scan ? { groupId: scan.groupId, scanIndex: scan.index, scanTarget: scan.target } : {}),
    };
    const file = await open(filePath, 'wx');
    try {
      try { await file.writeFile(image.bytes); } finally { await file.close(); }
      scan?.signal.throwIfAborted();
      store.addSnapshot(snapshot);
    } catch (error) {
      try { await unlink(filePath); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '截图元数据保存及图片清理失败');
      }
      throw error;
    }
    return snapshot;
  }

  async function runSnapshotGroup(camera, group, scan) {
    let status = 'completed';
    let errorMessage = null;
    try {
      // 启动接口先返回分组编号，长时间扫描由后端独立执行。
      await new Promise((accept) => setImmediate(accept));
      for (let index = group.completedCount; index < group.sampleCount; index++) {
        scan.controller.signal.throwIfAborted();
        const target = scanTarget(group, index);
        await livegbs.preciseControl(camera, target);
        await waitForScanTarget(livegbs, camera, target, group, scan.controller.signal);
        await captureSnapshot(camera, group.calibration, {
          groupId: group.id, index, target, panTolerance: Math.min(0.15, group.panStep / 4), signal: scan.controller.signal,
        });
      }
    } catch (error) {
      const aborted = scan.controller.signal.aborted && (error === scan.controller.signal.reason || error.name === 'AbortError');
      status = aborted ? (scan.action === 'pause' ? 'paused' : 'cancelled') : 'failed';
      errorMessage = status !== 'failed' ? null : error.statusCode ? error.message : '自动截图失败，请检查后端日志';
      if (status === 'failed' && !error.statusCode) console.error('自动截图失败', error);
    }
    try {
      await livegbs.continuousControl(camera, 'stop', 129);
      moving.delete(camera.id);
    } catch (error) {
      scan.stopError = error;
      status = 'failed';
      errorMessage = `${errorMessage ? `${errorMessage}；` : ''}停止云台失败，请点击停止重试`;
      console.error('自动截图结束时停止云台失败', error);
    }
    try {
      if (store.getSnapshotGroup(group.id).completedCount >= group.sampleCount && !scan.stopError) status = 'completed';
      store.updateSnapshotGroup(group.id, { status, error: errorMessage, finishedAt: status === 'paused' ? null : new Date().toISOString() });
    } finally {
      operations.delete(camera.id);
      activeScans.delete(camera.id);
    }
  }

  function startSnapshotGroup(camera, group) {
    const scan = { groupId: group.id, controller: new AbortController(), task: null, stopError: null, action: null };
    activeScans.set(camera.id, scan);
    moving.set(camera.id, camera);
    scan.task = runSnapshotGroup(camera, group, scan).catch((error) => {
      console.error('自动截图分组状态保存失败', error);
      scan.stopError = httpError(500, '自动截图状态保存失败，请检查后端日志');
    });
  }

  app.get('/api/health', async () => ({ status: 'ok', livegbsConfigured: livegbs.configured }));
  app.get('/api/playback', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { cameraId: { type: 'string', minLength: 1 } },
  } } }, async (request) => playbackSource(livegbs.baseUrl, process.env.LIVEGBS_SMS_ID,
    request.query.cameraId ? store.getCamera(request.query.cameraId) : undefined));
  app.get('/api/cameras', async () => store.listCameras());
  app.post('/api/cameras', { schema: { body: cameraSchema } }, async (request, reply) => {
    const input = { ...request.body };
    for (const key of ['name', 'serial', 'code']) {
      input[key] = input[key].trim();
      if (!input[key]) throw httpError(400, `请填写${fieldLabels[key]}`);
    }
    return reply.code(201).send(store.saveCamera(input));
  });
  app.put('/api/cameras/:id', { schema: { body: cameraSchema } }, async (request) => {
    if (isBusy(request.params.id)) throw httpError(409, '该摄像头正在控制或截图，请先停止控制后保存');
    const input = { ...request.body };
    for (const key of ['name', 'serial', 'code']) {
      input[key] = input[key].trim();
      if (!input[key]) throw httpError(400, `请填写${fieldLabels[key]}`);
    }
    return store.saveCamera(input, request.params.id);
  });
  app.get('/api/cameras/:id/ptz', async (request) => livegbs.readPtz(store.getCamera(request.params.id)));

  app.post('/api/cameras/:id/control', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['command'],
      properties: {
        command: { type: 'string', enum: ['left', 'right', 'up', 'down', 'upleft', 'upright', 'downleft', 'downright', 'zoomin', 'zoomout', 'stop'] },
        speed: { type: 'integer', minimum: 0, maximum: 255, default: 129 },
      },
    } },
  }, async (request) => {
    const id = request.params.id;
    const { command, speed } = request.body;
    if (command === 'stop') return stopDevice(id, speed);
    return trackControl(id, async () => {
      const camera = store.getCamera(id);
      moving.set(id, camera);
      await livegbs.continuousControl(camera, command, speed);
      return { command, speed, sentAt: new Date().toISOString() };
    });
  });

  app.post('/api/cameras/:id/precise', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['pan', 'tilt', 'zoom'],
      properties: preciseProperties,
    } },
  }, async (request) => trackControl(request.params.id, async () => {
    const camera = store.getCamera(request.params.id);
    const target = { ...request.body };
    await livegbs.preciseControl(camera, target);
    return { target, sentAt: new Date().toISOString() };
  }));

  app.get('/api/cameras/:id/snapshots', async (request) => store.listSnapshots(request.params.id));
  app.get('/api/cameras/:id/snapshot-groups', { schema: { querystring: pageSchema } }, async (request) =>
    store.listSnapshotGroups(request.params.id, pageOptions(request.query)));
  app.get('/api/snapshot-tasks', { schema: { querystring: {
    ...pageSchema, properties: { ...pageSchema.properties, cameraId: { type: 'string', minLength: 1 } },
  } } }, async (request) => store.listSnapshotTasks({ ...pageOptions(request.query), cameraId: request.query.cameraId }));
  app.get('/api/snapshot-groups/:id', async (request) => store.getSnapshotGroup(request.params.id));
  app.get('/api/snapshot-groups/:id/snapshots', { schema: { querystring: pageSchema } }, async (request) =>
    store.listGroupSnapshots(request.params.id, pageOptions(request.query)));
  app.post('/api/cameras/:id/snapshot-scans', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['basePtz', 'panMin', 'panMax'],
      properties: {
        basePtz: { type: 'object', additionalProperties: false, required: ['pan', 'tilt', 'zoom'], properties: preciseProperties },
        panMin: { type: 'number', minimum: 0, maximum: 360 },
        panMax: { type: 'number', minimum: 0, maximum: 360 },
        settleMs: { type: 'integer', minimum: 0, maximum: 10000, default: 1000 },
        moveTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000 },
        calibration: calibrationSchema,
      },
    } },
  }, async (request, reply) => {
    const id = request.params.id;
    if (isBusy(id)) throw httpError(409, '该摄像头正在控制或截图，请先停止后重试');
    operations.add(id);
    const preparation = (async () => {
      const camera = store.getCamera(id);
      const current = await livegbs.readPtz(camera);
      if (!ptzMatches(current.raw, request.body.basePtz)) {
        throw httpError(409, '当前 PTZ 与基础 PTZ 不一致，请先调整设备并重新回读');
      }
      const plan = createScanPlan(request.body, current.raw.HorizontalFieldAngle);
      const group = { id: randomUUID(), cameraId: id, cameraName: camera.name, serial: camera.serial, code: camera.code,
        kind: 'scan', createdAt: new Date().toISOString(), finishedAt: null, status: 'running',
        ...plan, calibration: request.body.calibration || calibrationOf(camera), completedCount: 0, error: null };
      store.addSnapshotGroup(group);
      startSnapshotGroup(camera, group);
      return group;
    })();
    pendingControls.set(id, preparation);
    try {
      const group = await preparation;
      return reply.code(202).header('Location', `/api/snapshot-groups/${group.id}`).send(store.getSnapshotGroup(group.id));
    } catch (error) {
      if (!activeScans.has(id)) operations.delete(id);
      throw error;
    } finally {
      if (pendingControls.get(id) === preparation) pendingControls.delete(id);
    }
  });
  app.post('/api/snapshot-tasks/:id/cancel', async (request) => {
    const group = store.getSnapshotGroup(request.params.id);
    const scan = activeScans.get(group.cameraId);
    if (scan?.groupId === group.id) {
      await stopDevice(group.cameraId, 129);
    } else if (group.kind === 'scan' && group.status === 'paused') {
      store.updateSnapshotGroup(group.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    }
    return store.getSnapshotGroup(group.id);
  });
  app.post('/api/snapshot-tasks/:id/pause', async (request) => {
    const group = store.getSnapshotGroup(request.params.id);
    if (group.status === 'paused') return group;
    const scan = activeScans.get(group.cameraId);
    if (scan?.groupId !== group.id) throw httpError(409, '该任务当前未在执行');
    store.updateSnapshotGroup(group.id, { status: 'pausing' });
    await stopDevice(group.cameraId, 129, 'pause');
    return store.getSnapshotGroup(group.id);
  });
  app.post('/api/snapshot-tasks/:id/start', async (request, reply) => {
    const group = store.getSnapshotGroup(request.params.id);
    if (group.kind !== 'scan' || !['paused', 'failed', 'interrupted'].includes(group.status)
      || group.completedCount >= group.sampleCount) throw httpError(409, '该任务不能继续执行');
    if (isBusy(group.cameraId)) throw httpError(409, '该摄像头正在控制或截图，请先停止后重试');
    const camera = store.getCamera(group.cameraId);
    if (camera.serial !== group.serial || camera.code !== group.code) throw httpError(409, '摄像头通道已变更，不能继续原任务');
    operations.add(camera.id);
    try {
      store.updateSnapshotGroup(group.id, { status: 'running', error: null, finishedAt: null });
      startSnapshotGroup(camera, group);
      return reply.code(202).send(store.getSnapshotGroup(group.id));
    } catch (error) {
      if (!activeScans.has(camera.id)) operations.delete(camera.id);
      throw error;
    }
  });
  app.post('/api/cameras/:id/snapshots', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: { calibration: calibrationSchema },
    } },
  }, async (request, reply) => {
    const record = await withDeviceOperation(request.params.id, async () => {
      const camera = store.getCamera(request.params.id);
      const calibration = request.body?.calibration || calibrationOf(camera);
      return captureSnapshot(camera, calibration);
    });
    return reply.code(201).send(record);
  });
  app.delete('/api/snapshots/:id', async (request, reply) => {
    const record = store.getSnapshot(request.params.id);
    await withDeviceOperation(record.cameraId, async () => {
      const directory = resolve(dataDir, 'snapshots');
      const original = resolve(directory, record.fileName);
      const staged = `${original}.delete-${randomUUID()}`;
      if (dirname(original) !== directory || dirname(staged) !== directory) throw httpError(500, '截图文件路径无效');
      let stagedFile = false;
      try { await rename(original, staged); stagedFile = true; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try { store.deleteSnapshot(record.id); } catch (error) {
        if (stagedFile) {
          try { await rename(staged, original); } catch (restoreError) {
            throw new AggregateError([error, restoreError], '删除截图失败，恢复图片失败');
          }
        }
        throw error;
      }
      if (stagedFile) {
        try { await unlink(staged); } catch (error) {
          console.error('截图记录已删除，但暂存图片清理失败', error);
          throw httpError(500, '截图记录已删除，但图片文件清理失败，请检查后端日志');
        }
      }
    });
    return reply.code(204).send();
  });
  app.get('/api/snapshots/:id/image', async (request, reply) => {
    const record = store.getSnapshot(request.params.id);
    const filePath = join(dataDir, 'snapshots', record.fileName);
    if (!existsSync(filePath)) throw httpError(404, '截图文件不存在');
    return reply.type(record.contentType).header('Cache-Control', 'private, max-age=3600').send(createReadStream(filePath));
  });

  const hasWeb = existsSync(join(webDir, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ message: '请求地址不存在' });
  });
  return app;
}
