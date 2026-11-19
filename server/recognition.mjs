import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { httpError } from './errors.mjs';
import { calibrationKeys, calibrationOf } from './store.mjs';
import { estimateInstallation, estimateZeroPose, evaluateInstallation, refineInstallation, ZERO_POSE_MODEL } from './tilt-calibration.mjs';
import { refinementInputs, refinementStaleReasons, withRefinementState } from './installation-refinement.mjs';
import { requireZeroPoseCandidate, zeroPoseCandidateStaleReasons } from './zero-pose-candidate.mjs';
import { evaluateZeroPoseValidation, validPoints, zeroPoseValidationCriteriaSchema } from './zero-pose-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const activeStatuses = ['queued', 'running'];
const fittedKeys = ['pAxisPitch', 'pAxisRoll', 'tiltOffset', 'imageRoll'];
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

export function registerRecognitionRoutes(app, { store, dataDir, isBusy, recognizer = createEssldRecognizer() }) {
  store.interruptRecognitionTasks();
  const queued = [];
  let current = null, closing = false;

  function withRecognitionState(task) {
    if (task.zeroPoseCandidate) {
      const staleReasons = zeroPoseCandidateStaleReasons(store, task);
      task = { ...task, zeroPoseCandidate: { ...task.zeroPoseCandidate, stale: staleReasons.length > 0, staleReasons } };
    }
    return withRefinementState(store, task);
  }

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

  function zeroPoseChanges(task) {
    if (store.getSnapshotGroup(task.sourceTaskId).horizon?.phase === 'coarse') {
      throw httpError(409, '历史预扫粗结果仅供查看，请从正式截图任务生成零位候选');
    }
    const camera = store.getCamera(task.cameraId);
    const selected = [], excluded = [];
    for (const item of store.recognitionItems(task.id)) {
      let reason;
      if (item.missing) reason = '源截图已删除';
      else if (item.snapshot.cameraId !== task.cameraId) reason = '截图不属于该摄像头';
      else if (item.ignored) reason = item.ignoreReason || '已忽略';
      else if (!validPoints(item.points)) reason = '海天线正式标注无效';
      else if (!store.hasSnapshotImage(item.snapshot)) reason = '源截图文件缺失';
      if (reason) excluded.push({ snapshotId: item.snapshotId, reason }); else selected.push(item);
    }
    const dates = selected.length ? selected.map((item) => +new Date(item.snapshot.createdAt)) : [+new Date(task.createdAt)];
    const result = estimateZeroPose(camera, selected.map((item) => item.snapshot), selected.map(({ snapshotId, points }) => ({ snapshotId, points })), {
      startTime: new Date(Math.min(...dates)).toISOString(), endTime: new Date(Math.max(...dates) + 1).toISOString(),
    });
    return { zeroPoseCandidate: { ...result, excluded: [...excluded, ...result.excluded], resultId: randomUUID(),
      revision: task.revision, generatedCamera: camera, applied: false, appliedAt: null } };
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
  const guidePoint = { type: 'object', additionalProperties: false, required: ['heading', 'elevation'],
    properties: { heading: { type: 'number' }, elevation: { type: 'number' } } };
  const guideSchema = { anyOf: [{ type: 'null' }, ...[['line', 2, 2], ['quadratic', 3, 3], ['bezier', 5, 65]].map(([kind, minimum, maximum]) => ({
    type: 'object', additionalProperties: false, required: ['kind', 'points'], properties: {
      kind: { type: 'string', const: kind }, points: { type: 'array', minItems: minimum, maxItems: maximum, items: guidePoint },
    },
  }))] };
  const paging = { type: 'object', additionalProperties: false, properties: {
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, offset: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,8})$' },
  } };
  const pageOptions = (query) => ({ limit: Number(query.limit || 30), offset: Number(query.offset || 0) });

  app.post('/api/recognition-tasks', { schema: { body: { type: 'object', additionalProperties: false,
    required: ['sourceTaskId'], properties: { sourceTaskId: { type: 'string', minLength: 1 } },
  } } }, async (request, reply) => {
    return reply.code(202).send(createTask(request.body.sourceTaskId));
  });
  app.get('/api/recognition-tasks', { schema: { querystring: paging } }, async (request) => {
    const page = store.listRecognitionTasks(pageOptions(request.query));
    return { ...page, tasks: page.tasks.map(withRecognitionState) };
  });
  app.get('/api/recognition-tasks/:id', async (request) => withRecognitionState(store.getRecognitionTask(request.params.id)));
  app.get('/api/recognition-tasks/:id/panorama-guide', async (request) => store.getRecognitionPanoramaGuide(request.params.id));
  app.put('/api/recognition-tasks/:id/panorama-guide', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'guide'], properties: {
      revision: { ...revisionSchema, maximum: Number.MAX_SAFE_INTEGER - 1 }, guide: guideSchema,
    },
  } } }, async (request) => {
    const task = store.getRecognitionTask(request.params.id);
    if (activeStatuses.includes(task.status)) throw httpError(409, '请等待识别结束或取消后再编辑');
    const { guide, revision } = request.body;
    if (guide) {
      if (guide.kind === 'bezier' && guide.points.length % 2 !== 1) throw httpError(400, '分段贝塞尔需要交替排列控制点与连接节点');
      if (guide.points.some((point) => !Number.isFinite(point.heading) || !Number.isFinite(point.elevation))) {
        throw httpError(400, '全景参考线坐标必须为有限数值');
      }
      const headings = guide.points.map((point) => point.heading);
      if (Math.abs(headings.at(-1) - headings[0]) <= 1e-9 || Math.max(...headings) - Math.min(...headings) > 2 * Math.PI) {
        throw httpError(400, '全景参考线起终点需要有效方位跨度，全部点的方位范围不能超过一周');
      }
    }
    return store.saveRecognitionPanoramaGuide(task.id, revision, guide);
  });
  app.get('/api/recognition-tasks/:id/items', { schema: { querystring: paging } }, async (request) => {
    const task = store.getRecognitionTask(request.params.id);
    const options = pageOptions(request.query);
    const items = store.recognitionItems(task.id, options);
    return { task: withRecognitionState(task), items, total: task.sampleCount, offset: options.offset,
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
      return { task: withRecognitionState(updated), item };
    });
  });
  app.post('/api/recognition-tasks/:id/generate', { schema: { body: {
    ...bodyWithRevision, properties: { ...bodyWithRevision.properties,
      model: { type: 'string', enum: ['wgs84-horizon-installation-v1', ZERO_POSE_MODEL] } },
  } } }, async (request) => {
    const { revision, model } = request.body;
    if (model === ZERO_POSE_MODEL) return store.transaction(() => {
      const task = editable(request.params.id, revision);
      return withRecognitionState(store.updateRecognitionTask(task.id, zeroPoseChanges(task)));
    });
    const task = editable(request.params.id, revision);
    return withRecognitionState(store.updateRecognitionTask(task.id, installationChanges(task)));
  });
  app.post('/api/recognition-tasks/:id/zero-pose-measure', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'resultId', 'snapshotId'],
    properties: { ...bodyWithRevision.properties, resultId: { type: 'string', minLength: 1 }, snapshotId: { type: 'string', minLength: 1 } },
  } } }, async (request) => {
    const { revision, resultId, snapshotId } = request.body;
    const task = editable(request.params.id, revision);
    const candidate = requireZeroPoseCandidate(store, task, resultId, revision);
    if (!candidate.sourceSnapshotIds.includes(snapshotId)) throw httpError(409, '该原图未参与零位候选拟合');
    const { snapshot, points } = store.getRecognitionItem(task.id, snapshotId);
    const { model, zeroPose, perSnapshot, excluded } = evaluateInstallation({ ...candidate.generatedCamera, zeroPose: candidate.zeroPose },
      [snapshot], [{ snapshotId, points }], candidate, ZERO_POSE_MODEL);
    return { taskId: task.id, revision, resultId, model, zeroPose, perSnapshot, excluded };
  });
  const sourceVersion = { type: 'object', additionalProperties: false, required: ['taskId', 'revision'], properties: {
    taskId: { type: 'string', minLength: 1 }, revision: revisionSchema,
  } };
  app.put('/api/recognition-tasks/:id/refinement-sources', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'selectionRevision', 'base', 'supplemental'], properties: {
      ...bodyWithRevision.properties, selectionRevision: { ...revisionSchema, maximum: Number.MAX_SAFE_INTEGER - 1 },
      base: { anyOf: [{ type: 'null' }, { ...sourceVersion, required: ['taskId', 'revision', 'resultId'],
        properties: { ...sourceVersion.properties, resultId: { type: 'string', minLength: 1 } } }] },
      supplemental: { type: 'array', items: sourceVersion },
    },
  } } }, async (request) => store.transaction(() => {
    const task = editable(request.params.id, request.body.revision);
    if ((task.refinementSelection?.revision || 0) !== request.body.selectionRevision) {
      throw httpError(409, '精修来源选择已变化，请刷新后重试');
    }
    const { base, supplemental, selectionRevision } = request.body;
    if (base) refinementInputs(store, task, { base, supplemental });
    return withRecognitionState(store.updateRecognitionTask(task.id, { refinementSelection: { revision: selectionRevision + 1, base, supplemental } }));
  }));
  app.post('/api/recognition-tasks/:id/refine', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'selectionRevision'], properties: {
      ...bodyWithRevision.properties, selectionRevision: revisionSchema,
    },
  } } }, async (request) => {
    const task = editable(request.params.id, request.body.revision);
    if (task.refinementSelection?.revision !== request.body.selectionRevision) throw httpError(409, '精修来源选择已变化，请刷新后重试');
    const input = refinementInputs(store, task, task.refinementSelection);
    const result = refineInstallation({ ...input.camera, ...input.baseCamera }, input.selected.map((item) => item.snapshot),
      input.selected.map((item) => ({ snapshotId: item.snapshotId, points: item.points })), input.range, input.baseSnapshotIds);
    const taskBySnapshot = new Map(input.selected.map((item) => [item.snapshotId, item.taskId]));
    for (const comparison of [result.before, result.after]) {
      comparison.perSnapshot = comparison.perSnapshot.map((row) => ({ ...row, taskId: taskBySnapshot.get(row.snapshotId) }));
    }
    result.excluded.push(...input.excluded);
    const refinement = { ...result, resultId: randomUUID(), selectionRevision: task.refinementSelection.revision,
      baseCamera: input.baseCamera, generatedCamera: input.camera,
      sources: input.sources.map((source) => ({ ...source, sourceSnapshotIds: result.sourceSnapshotIds.filter((id) => source.inputSnapshotIds.includes(id)) })),
      stale: false, staleReasons: [], appliedAt: null };
    return store.transaction(() => {
      const currentTask = editable(task.id, task.revision);
      if (currentTask.refinementSelection?.revision !== refinement.selectionRevision) throw httpError(409, '精修来源选择已变化，请刷新后重试');
      const latest = refinementInputs(store, currentTask, currentTask.refinementSelection);
      if (Object.keys(input.camera).some((key) => input.camera[key] !== latest.camera[key])) {
        throw httpError(409, '计算期间摄像头配置已变化，请重新生成精修候选');
      }
      const changed = refinementStaleReasons(store, { ...currentTask, refinement });
      if (changed.length) throw httpError(409, changed.join('；'));
      return withRecognitionState(store.updateRecognitionTask(task.id, { refinement }));
    });
  });
  app.post('/api/recognition-tasks/:id/refinement-measure', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'selectionRevision', 'mode'], properties: {
      ...bodyWithRevision.properties, selectionRevision: revisionSchema,
      mode: { type: 'string', enum: ['before', 'after'] }, resultId: { type: 'string', minLength: 1 },
    },
  } } }, async (request) => {
    const task = editable(request.params.id, request.body.revision);
    if (task.refinementSelection?.revision !== request.body.selectionRevision) throw httpError(409, '精修来源选择已变化，请刷新后重试');
    const input = refinementInputs(store, task, task.refinementSelection);
    const after = request.body.mode === 'after';
    if (after && (!task.refinement || task.refinement.resultId !== request.body.resultId)) throw httpError(409, '精修候选编号已变化，请刷新后重试');
    if (after) {
      const changed = refinementStaleReasons(store, task);
      if (changed.length) throw httpError(409, changed.join('；'));
    }
    const result = evaluateInstallation({ ...input.camera, ...input.baseCamera, ...(after ? task.refinement.after.installation : {}) },
      input.selected.map((item) => item.snapshot), input.selected.map((item) => ({ snapshotId: item.snapshotId, points: item.points })), input.range);
    const taskBySnapshot = new Map(input.selected.map((item) => [item.snapshotId, item.taskId]));
    result.perSnapshot = result.perSnapshot.map((row) => ({ ...row, taskId: taskBySnapshot.get(row.snapshotId),
      group: input.baseSnapshotIds.includes(row.snapshotId) ? 'base' : 'high' }));
    result.excluded.push(...input.excluded);
    return { ...result, taskId: task.id, revision: task.revision, selectionRevision: task.refinementSelection.revision,
      mode: request.body.mode, resultId: after ? task.refinement.resultId : null };
  });
  app.post('/api/recognition-tasks/:id/validate', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'referenceTaskId', 'referenceResultId'], properties: {
      ...bodyWithRevision.properties, referenceTaskId: { type: 'string', minLength: 1 }, referenceResultId: { type: 'string', minLength: 1 },
      referenceKind: { type: 'string', enum: ['ordinary', 'refinement', 'zero-pose'] },
      criteria: zeroPoseValidationCriteriaSchema,
    },
  } } }, async (request) => {
    const { revision, referenceTaskId, referenceResultId, criteria } = request.body;
    const kind = request.body.referenceKind || 'ordinary';
    if (kind === 'zero-pose') return store.transaction(() => {
      const task = editable(request.params.id, revision);
      const reference = store.getRecognitionTask(referenceTaskId);
      const candidate = requireZeroPoseCandidate(store, reference, referenceResultId);
      const result = evaluateZeroPoseValidation(store, task, reference, candidate, kind, criteria);
      store.updateRecognitionTask(reference.id, { zeroPoseCandidate: { ...candidate, validation: result.evidence } });
      return result;
    });
    if (criteria) throw httpError(400, '验收门槛仅用于零位候选的独立复核');
    const task = editable(request.params.id, revision);
    const reference = store.getRecognitionTask(referenceTaskId);
    if (reference.id === task.id || reference.cameraId !== task.cameraId) {
      throw httpError(409, '请选择同一摄像头的另一识别任务作为标定来源');
    }
    let fittedResult = reference.result, fitCamera = reference.fitCamera, resultId = reference.resultId;
    if (kind === 'refinement') {
      fittedResult = reference.refinement;
      fitCamera = fittedResult?.baseCamera;
      resultId = fittedResult?.resultId;
      if (activeStatuses.includes(reference.status) || fittedResult?.status !== 'estimated'
        || fittedResult.model !== 'wgs84-horizon-refinement-v1' || resultId !== request.body.referenceResultId) {
        throw httpError(409, '精修来源没有合格的最新候选，或候选编号已变化，请刷新后重试');
      }
      const changed = refinementStaleReasons(store, reference);
      if (changed.length) throw httpError(409, changed.join('；'));
    } else {
      if (activeStatuses.includes(reference.status) || reference.result?.status !== 'estimated'
        || reference.result.model !== 'wgs84-horizon-installation-v1' || reference.resultRevision !== reference.revision
        || reference.resultId !== request.body.referenceResultId) {
        throw httpError(409, '标定来源没有合格的最新结果，或结果已变化，请刷新后重试');
      }
      if (store.getSnapshotGroup(reference.sourceTaskId).horizon?.phase === 'coarse') {
        throw httpError(409, '历史预扫粗结果仅供查看，请选择正式标定结果');
      }
    }
    const camera = store.getCamera(task.cameraId);
    if (['longitude', 'latitude', 'height', 'panOffset', 'serial', 'code'].some((key) => camera[key] !== fitCamera?.[key])) {
      throw httpError(409, '安装位置、默认朝向或设备通道已变化，请重新生成标定来源结果');
    }
    const fittedIds = new Set(fittedResult.sourceSnapshotIds);
    if (store.recognitionItems(reference.id).some((item) => fittedIds.has(item.snapshotId) && item.missing)) {
      throw httpError(409, '标定来源的参与截图已删除，请重新生成标定结果');
    }
    const items = store.recognitionItems(task.id);
    const selected = items.filter((item) => !item.ignored && !item.missing && validPoints(item.points));
    if (selected.some((item) => fittedIds.has(item.snapshotId))) {
      throw httpError(409, '复核图片与拟合图片存在重叠，请使用未参与拟合的独立截图');
    }
    const dates = items.length ? items.map((item) => +new Date(item.snapshot.createdAt)) : [+new Date(task.createdAt)];
    const result = evaluateInstallation({ ...camera, ...fitCamera, ...fittedResult.installation },
      selected.map((item) => item.snapshot), selected.map((item) => ({ snapshotId: item.snapshotId, points: item.points })), {
        startTime: new Date(Math.min(...dates)).toISOString(), endTime: new Date(Math.max(...dates) + 1).toISOString(),
      });
    result.excluded.push(...items.filter((item) => item.ignored || item.missing || !validPoints(item.points)).map((item) => ({ snapshotId: item.snapshotId,
      reason: item.missing ? '源截图已删除' : item.ignored ? item.ignoreReason : '海天线正式标注无效或横向跨度不足图片宽度的 10%' })));
    return { ...result, taskId: task.id, revision: task.revision, reference: { kind, taskId: reference.id, resultId,
      revision: reference.revision, createdAt: reference.createdAt,
      ...(kind === 'refinement' ? { selectionRevision: fittedResult.selectionRevision, sources: fittedResult.sources } : {}) } };
  });
  app.post('/api/recognition-tasks/:id/refinement-apply', { schema: { body: {
    ...bodyWithRevision, required: ['revision', 'resultId'], properties: { ...bodyWithRevision.properties, resultId: { type: 'string', minLength: 1 } },
  } } }, async (request) => store.transaction(() => {
    // 写锁取得后重读候选、全部来源及完整相机版本，校验和两项写入属于同一次事务。
    const task = editable(request.params.id, request.body.revision);
    const candidate = task.refinement;
    if (!candidate || candidate.resultId !== request.body.resultId) throw httpError(409, '精修候选编号已变化，请刷新并复核最新结果');
    if (candidate.status !== 'estimated' || candidate.model !== 'wgs84-horizon-refinement-v1') throw httpError(409, '请先生成通过质量检查的精修候选');
    if (candidate.applied || candidate.appliedAt) throw httpError(409, '本版精修候选已经应用');
    const changed = refinementStaleReasons(store, task);
    if (changed.length) throw httpError(409, changed.join('；'));
    const camera = store.getCamera(task.cameraId);
    if (Object.keys(camera).some((key) => camera[key] !== candidate.generatedCamera[key])) {
      throw httpError(409, '摄像头配置已变化，请重新生成精修候选后再应用');
    }
    if (isBusy(task.cameraId)) throw httpError(409, '该摄像头正在控制或截图，请停止后再应用');
    const installation = Object.fromEntries(fittedKeys.map((key) => [key, candidate.installation[key]]));
    const updatedCamera = store.saveCamera({ ...camera, ...installation }, camera.id);
    const updated = store.updateRecognitionTask(task.id, { refinement: { ...candidate, applied: true, appliedAt: new Date().toISOString() } });
    return { task: withRecognitionState(updated), camera: updatedCamera };
  }));
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
      return { task: withRecognitionState(updated), camera: updatedCamera };
    });
  });
  return { createTask,
    async close() { closing = true; if (current) { const running = current; running.controller.abort(); await running.task; } } };
}
