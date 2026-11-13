import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { httpError } from './errors.mjs';
import { calibrationKeys, calibrationOf } from './store.mjs';
import { estimateInstallation } from './tilt-calibration.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const activeStatuses = ['queued', 'running'];
const fittedKeys = ['pAxisPitch', 'pAxisRoll', 'tiltOffset', 'imageRoll'];
const validPoints = (points) => Array.isArray(points) && points.length === 2
  && points.every((point) => [point.x, point.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
  && Math.abs(points[0].x - points[1].x) >= 0.1;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function horizonDiscontinuities(items) {
  const groups = new Map();
  for (const item of items) {
    if (!validPoints(item.detectedPoints) || item.snapshot.poseChanged) continue;
    const ptz = item.snapshot.ptz.raw;
    const key = JSON.stringify([ptz.Tilt, ptz.Zoom, ptz.HorizontalFieldAngle, ptz.VerticalFieldAngle]);
    const group = groups.get(key) || [];
    const [a, b] = item.detectedPoints;
    group.push({ id: item.snapshotId, pan: ptz.Pan, center: (a.y + b.y) / 2,
      angle: Math.atan2((b.y - a.y) * item.snapshot.height, (b.x - a.x) * item.snapshot.width) * 180 / Math.PI });
    groups.set(key, group);
  }
  const rejected = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => a.pan - b.pan);
    group.forEach((sample, index) => {
      const neighbors = group.slice(Math.max(0, index - 3), index + 4).filter((other) => other !== sample);
      if (neighbors.length < 3) return;
      for (const [key, floor, label] of [['angle', 3, '倾角'], ['center', 0.05, '归一化高度']]) {
        const center = median(neighbors.map((other) => other[key]));
        const deviation = median(neighbors.map((other) => Math.abs(other[key] - center)));
        if (Math.abs(sample[key] - center) > Math.max(floor, 3 * 1.4826 * deviation)) {
          rejected.set(sample.id, `海天线${label}相对附近截图发生突变，已自动忽略，可人工恢复`);
        }
      }
    });
  }
  return rejected;
}

export function createEssldRecognizer() {
  const python = resolve(root, process.env.ESSLD_PYTHON || 'data/essld/.venv/Scripts/python.exe');
  const upstream = resolve(root, process.env.ESSLD_UPSTREAM || 'data/essld/upstream');
  return {
    check() {
      if (!existsSync(python) || !existsSync(join(upstream, 'weights/dceunetex.pth'))) {
        throw httpError(503, '本地 ESSLD 环境或权重不存在，请按 README 配置 ESSLD_PYTHON 和 ESSLD_UPSTREAM');
      }
    },
    run(images, { signal, onResult }) {
      return new Promise((accept, reject) => {
        const child = spawn(python, ['-u', join(root, 'scripts/essld-recognize.py'), '--upstream', upstream], {
          cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '', failure;
        const stop = () => {
          if (process.platform === 'win32' && child.pid) {
            // venv 启动器可能另起 Python 子进程，需要一并终止本次识别进程树。
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', (error) => { console.error('终止模型进程失败', error); child.kill(); });
          } else child.kill();
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
        child.stdin.on('error', (error) => { failure ||= error; });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (!line.trim() || failure || signal.aborted) return;
          try { onResult(JSON.parse(line)); } catch (error) { failure = error; stop(); }
        });
        child.once('error', (error) => { failure = error; });
        child.once('close', (code) => {
          signal.removeEventListener('abort', stop);
          lines.close();
          if (signal.aborted) return reject(signal.reason);
          if (failure) return reject(failure);
          if (code !== 0) {
            console.error('ESSLD 进程失败', stderr);
            return reject(httpError(500, '本地模型执行失败，请检查 Python 依赖及后端日志'));
          }
          accept();
        });
        child.stdin.end(JSON.stringify(images));
      });
    },
  };
}

export function registerRecognitionRoutes(app, { store, dataDir, isBusy, startHorizonScan, recognizer = createEssldRecognizer() }) {
  store.interruptRecognitionTasks();
  const queued = [];
  let current = null, closing = false;

  function editable(id, revision) {
    const task = store.getRecognitionTask(id);
    if (activeStatuses.includes(task.status)) throw httpError(409, '请等待识别结束或取消后再编辑');
    if (task.revision !== revision) throw httpError(409, '识别任务已被修改，请刷新后重试');
    return task;
  }

  function installationChanges(task) {
    const camera = store.getCamera(task.cameraId);
    const items = store.recognitionItems(task.id);
    const selected = items.filter((item) => !item.ignored && !item.missing && validPoints(item.points));
    const snapshots = selected.map((item) => item.snapshot);
    const dates = items.map((item) => +new Date(item.snapshot.createdAt));
    const result = estimateInstallation(camera, snapshots, selected.map((item) => ({ snapshotId: item.snapshotId, points: item.points })), {
      startTime: new Date(Math.min(...dates)).toISOString(), endTime: new Date(Math.max(...dates) + 1).toISOString(),
    });
    result.excluded.push(...items.filter((item) => item.ignored || item.missing).map((item) => ({ snapshotId: item.snapshotId,
      reason: item.missing ? '源截图已删除' : item.ignoreReason })));
    return { result, resultId: randomUUID(), resultRevision: task.revision, appliedAt: null, appliedRevision: null,
      fitCamera: { ...calibrationOf(camera), serial: camera.serial, code: camera.code, updatedAt: camera.updatedAt } };
  }

  function createTask(sourceTaskId, { autoGenerate = false } = {}) {
    if (closing) throw httpError(503, '识别服务正在关闭，请稍后手动创建识别任务');
    recognizer.check?.();
    const group = store.getSnapshotGroup(sourceTaskId);
    if (group.kind !== 'scan' || activeStatuses.includes(group.status) || group.status === 'pausing') {
      throw httpError(409, '请先暂停截图任务或等待采样结束');
    }
    const source = store.listGroupSnapshots(group.id, { limit: 10000, offset: 0 }).snapshots;
    if (!source.length) throw httpError(400, '截图任务中没有可识别的图片');
    const now = new Date().toISOString();
    const task = { id: randomUUID(), sourceTaskId: group.id, cameraId: group.cameraId, cameraName: group.cameraName,
      status: 'queued', createdAt: now, updatedAt: now, finishedAt: null, sampleCount: source.length, completedCount: 0,
      revision: 0, result: null, resultId: null, error: null, appliedAt: null, appliedRevision: null, model: 'ESSLD',
      ...(autoGenerate ? { autoGenerate: true } : {}) };
    store.addRecognitionTask(task, source.map((snapshot) => ({ snapshotId: snapshot.id, snapshot,
      detectedPoints: [], points: [], source: 'model', ignored: true, ignoreReason: '等待模型识别', detection: null })), autoGenerate);
    queued.push(task.id);
    setImmediate(() => void pump());
    return task;
  }

  async function pump() {
    if (current || closing || !queued.length) return;
    const id = queued.shift();
    if (store.getRecognitionTask(id).status !== 'queued') return pump();
    const controller = new AbortController();
    const run = async () => {
      store.updateRecognitionTask(id, { status: 'running', completedCount: 0, error: null });
      const items = store.recognitionItems(id);
      const seen = new Set();
      try {
        const directory = resolve(dataDir, 'snapshots');
        const images = items.map((item) => {
          const path = resolve(directory, item.snapshot.fileName);
          if (dirname(path) !== directory) throw httpError(500, '截图文件路径无效');
          return { snapshotId: item.snapshotId, path, width: item.snapshot.width, height: item.snapshot.height };
        });
        await recognizer.run(images, { signal: controller.signal, onResult: (result) => {
          if (!items.some((item) => item.snapshotId === result.snapshotId) || seen.has(result.snapshotId)) {
            throw httpError(500, '模型返回了错误或重复的截图编号');
          }
          seen.add(result.snapshotId);
          const points = validPoints(result.points) ? result.points : [];
          const reason = result.error || (points.length ? '' : '未得到画面内有效海天线，请手动标注或忽略');
          store.updateRecognitionItem(id, result.snapshotId, {
            detectedPoints: points, points, source: 'model', ignored: !points.length, ignoreReason: reason,
            detection: { coarseLine: result.coarseLine, finalLine: result.finalLine,
              refinementStatus: result.refinementStatus, warnings: result.warnings || [], elapsedMs: result.elapsedMs, error: result.error || null },
          });
          store.updateRecognitionTask(id, { completedCount: seen.size });
        } });
        if (seen.size !== items.length) throw httpError(500, '模型未返回全部截图的识别结果');
        const detected = store.recognitionItems(id);
        const rejected = horizonDiscontinuities(detected);
        for (const item of detected) {
          const reason = item.snapshot.poseChanged ? '截图前后姿态发生变化' : rejected.get(item.snapshotId);
          if (reason) store.updateRecognitionItem(id, item.snapshotId, { ignored: true, ignoreReason: reason });
        }
        let candidate = {};
        const task = store.getRecognitionTask(id);
        if (task.autoGenerate) {
          try { candidate = installationChanges(task); } catch (error) {
            console.error('自动生成安装候选失败', error);
            candidate = { error: `识别已完成，候选计算失败：${error.statusCode ? error.message : '请检查后端日志'}` };
          }
        }
        // 候选与完成状态一起保存，轮询终态的页面无需等待第二次更新。
        store.updateRecognitionTask(id, { ...candidate, status: 'completed', finishedAt: new Date().toISOString() });
      } catch (error) {
        if (!controller.signal.aborted) console.error('识别任务失败', error);
        store.updateRecognitionTask(id, { status: controller.signal.aborted ? (closing ? 'interrupted' : 'cancelled') : 'failed',
          error: controller.signal.aborted ? (closing ? '服务关闭，识别已中断' : null)
            : error.statusCode ? error.message : '识别执行失败，请检查后端日志', finishedAt: new Date().toISOString() });
      }
    };
    // 先设置 current，再执行异步任务，避免两个请求同时启动模型。
    current = { id, controller, task: null };
    current.task = run().finally(() => { current = null; if (!closing) void pump(); });
    await current.task;
  }

  const revisionSchema = { type: 'integer', minimum: 0 };
  const bodyWithRevision = { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: revisionSchema } };
  const paging = { type: 'object', additionalProperties: false, properties: {
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, offset: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,8})$' },
  } };
  const pageOptions = (query) => ({ limit: Number(query.limit || 30), offset: Number(query.offset || 0) });

  app.post('/api/recognition-tasks', { schema: { body: { type: 'object', additionalProperties: false,
    required: ['sourceTaskId'], properties: { sourceTaskId: { type: 'string', minLength: 1 } },
  } } }, async (request, reply) => {
    return reply.code(202).send(createTask(request.body.sourceTaskId));
  });
  app.get('/api/recognition-tasks', { schema: { querystring: paging } }, async (request) => store.listRecognitionTasks(pageOptions(request.query)));
  app.get('/api/recognition-tasks/:id', async (request) => store.getRecognitionTask(request.params.id));
  app.get('/api/recognition-tasks/:id/items', { schema: { querystring: paging } }, async (request) => {
    const task = store.getRecognitionTask(request.params.id);
    const options = pageOptions(request.query);
    const items = store.recognitionItems(task.id, options);
    return { task, items, total: task.sampleCount, offset: options.offset,
      nextOffset: options.offset + items.length < task.sampleCount ? options.offset + items.length : null };
  });
  app.post('/api/recognition-tasks/:id/cancel', async (request) => {
    const task = store.getRecognitionTask(request.params.id);
    if (current?.id === task.id) {
      const running = current;
      running.controller.abort();
      await running.task;
    } else if (task.status === 'queued') store.updateRecognitionTask(task.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    return store.getRecognitionTask(task.id);
  });
  app.put('/api/recognition-tasks/:id/items/:snapshotId', { schema: { body: {
    ...bodyWithRevision, properties: { ...bodyWithRevision.properties, ignored: { type: 'boolean' },
      points: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false,
        required: ['x', 'y'], properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } } } },
    },
  } } }, async (request) => {
    const task = editable(request.params.id, request.body.revision);
    const previous = store.getRecognitionItem(task.id, request.params.snapshotId);
    const points = request.body.points || previous.points;
    const ignored = request.body.ignored ?? previous.ignored;
    if (!ignored && !validPoints(points)) throw httpError(400, '请先标注横向跨度至少为图宽 10% 的海天线，再参与计算');
    return store.transaction(() => {
      const item = store.updateRecognitionItem(task.id, previous.snapshotId, { points, ignored,
        ...(request.body.points ? { source: 'manual' } : {}), ignoreReason: ignored ? '已人工忽略' : '' });
      const updated = store.updateRecognitionTask(task.id, { revision: task.revision + 1, result: null, resultId: null });
      return { task: updated, item };
    });
  });
  app.post('/api/recognition-tasks/:id/generate', { schema: { body: bodyWithRevision } }, async (request) => {
    const task = editable(request.params.id, request.body.revision);
    return store.updateRecognitionTask(task.id, installationChanges(task));
  });
  app.post('/api/recognition-tasks/:id/horizon-scan', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'resultId', 'reviewed'], properties: { ...bodyWithRevision.properties,
      resultId: { type: 'string', minLength: 1 }, reviewed: { type: 'boolean' } },
  } } }, async (request, reply) => {
    const task = editable(request.params.id, request.body.revision);
    if (!request.body.reviewed) throw httpError(409, '请先人工复核当前版本与计算结果的海天线标注');
    if (task.result?.status !== 'estimated' || task.resultRevision !== task.revision) {
      throw httpError(409, '请先生成通过质量检查的最新粗标定结果');
    }
    if (task.resultId !== request.body.resultId) throw httpError(409, '计算结果已重新生成，请刷新并复核最新结果');
    const source = store.getSnapshotGroup(task.sourceTaskId);
    if (source.kind !== 'scan' || source.status !== 'completed' || source.horizon?.phase !== 'coarse') {
      throw httpError(409, '只能从已完成的低倍率海天线预扫启动正式扫描');
    }
    const camera = store.getCamera(task.cameraId);
    if ([...calibrationKeys, 'serial', 'code', 'updatedAt'].some((key) => camera[key] !== task.fitCamera?.[key])
      || source.serial !== camera.serial || source.code !== camera.code) {
      throw httpError(409, '摄像头配置或通道已变化，请重新生成并复核粗标定');
    }
    const items = store.recognitionItems(task.id);
    const directory = resolve(dataDir, 'snapshots');
    if (task.result.sourceSnapshotIds.some((id) => {
      const item = items.find((value) => value.snapshotId === id);
      if (!item || item.missing) return true;
      const path = resolve(directory, item.snapshot.fileName);
      return dirname(path) !== directory || !existsSync(path);
    })) throw httpError(409, '参与粗标定的源截图或图片文件已删除，请重新生成并复核');
    const group = startHorizonScan(source, task);
    return reply.code(202).header('Location', `/api/snapshot-groups/${group.id}`).send(group);
  });
  app.post('/api/recognition-tasks/:id/apply', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'resultId'], properties: { ...bodyWithRevision.properties, resultId: { type: 'string', minLength: 1 } },
  } } }, async (request) => {
    const task = editable(request.params.id, request.body.revision);
    if (isBusy(task.cameraId)) throw httpError(409, '该摄像头正在控制或截图，请停止后再应用');
    if (task.result?.status !== 'estimated' || task.resultRevision !== task.revision) throw httpError(409, '请先生成通过质量检查的最新计算结果');
    if (task.resultId !== request.body.resultId) throw httpError(409, '计算结果已重新生成，请刷新并复核最新结果');
    if (task.appliedRevision === task.revision) throw httpError(409, '本版结果已经应用');
    const camera = store.getCamera(task.cameraId);
    if ([...calibrationKeys, 'serial', 'code'].some((key) => camera[key] !== task.fitCamera[key])) {
      throw httpError(409, '摄像头配置已变化，请重新生成数据后再应用');
    }
    if (store.recognitionItems(task.id).some((item) => task.result.sourceSnapshotIds.includes(item.snapshotId) && item.missing)) {
      throw httpError(409, '参与计算的截图已删除，请重新生成数据');
    }
    return store.transaction(() => {
      const installation = Object.fromEntries(fittedKeys.map((key) => [key, task.result.installation[key]]));
      const updatedCamera = store.saveCamera({ ...camera, ...installation }, camera.id);
      const updated = store.updateRecognitionTask(task.id, { appliedAt: new Date().toISOString(), appliedRevision: task.revision,
        result: { ...task.result, applied: true } });
      return { task: updated, camera: updatedCamera };
    });
  });
  return { createTask,
    async close() { closing = true; if (current) { const running = current; running.controller.abort(); await running.task; } } };
}
