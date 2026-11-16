import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.mjs';
import { CameraStore, calibrationOf } from '../server/store.mjs';
import { httpError } from '../server/errors.mjs';
import { syntheticSnapshots } from './calibration-fixtures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const cameraInput = { name: '海天线扫描', serial: 'horizon-device', code: 'horizon-channel',
  longitude: 113.91319, latitude: 22.04331, height: 12, pAxisPitch: 0, pAxisRoll: 0,
  panOffset: 93.2, tiltOffset: 8, imageRoll: 0 };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-horizon-scan-test-'));
  const state = { raw: { Pan: 60, Tilt: 8, Zoom: 12, HorizontalFieldAngle: 30, VerticalFieldAngle: 20 },
    targets: [], captures: 0, stops: 0, onRead: null, onMove: null, onStop: null, checkError: null, runError: null, ignored: false };
  let f;
  const livegbs = {
    configured: true,
    async readPtz() {
      await state.onRead?.();
      const now = new Date().toISOString();
      return { raw: { ...state.raw }, requestedAt: now, receivedAt: now, durationMs: 1 };
    },
    async preciseControl(_camera, target) {
      state.targets.push({ ...target });
      await state.onMove?.(target, state.targets.length);
      state.raw = { ...state.raw, Pan: target.pan, Tilt: target.tilt, Zoom: target.zoom,
        HorizontalFieldAngle: target.zoom === 2 ? 80 : 30, VerticalFieldAngle: target.zoom === 2 ? 45 : 20 };
    },
    async continuousControl(_camera, command) {
      assert.equal(command, 'stop');
      state.stops++;
      await state.onStop?.();
    },
    async snapshot() {
      state.captures++;
      const now = new Date().toISOString();
      return { bytes: png, requestedAt: now, receivedAt: now, durationMs: 1, snapshotTime: null };
    },
  };
  const recognizer = {
    check() { if (state.checkError) throw state.checkError; },
    async run(images, { signal, onResult }) {
      if (state.runError) throw state.runError;
      const snapshots = (await f.app.inject(`/api/cameras/${f.camera.id}/snapshots`)).json();
      for (const image of images) {
        signal.throwIfAborted();
        const snapshot = snapshots.find((item) => item.id === image.snapshotId);
        const actual = { ...f.camera };
        const { observations } = syntheticSnapshots({ camera: actual, pitch: actual.pAxisPitch, roll: actual.pAxisRoll,
          pans: [snapshot.ptz.raw.Pan], ptzOverrides: snapshot.ptz.raw });
        onResult({ snapshotId: image.snapshotId,
          points: state.ignored ? [] : observations[0].points.filter((_, index) => index !== 1) });
      }
    },
  };
  const options = { dataDir, livegbs, recognizer, webDir: join(dataDir, 'no-web') };
  f = { app: await createApp(options), options, state, dataDir };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-horizon-scan-test-')) {
      throw new Error('海天线扫描测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  const saved = await f.app.inject({ method: 'POST', url: '/api/cameras', payload: cameraInput });
  assert.equal(saved.statusCode, 201, saved.body);
  f.camera = saved.json();
  return f;
}

async function waitFor(f, url, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await f.app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    const value = response.json();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error(`等待任务超时：${url}`);
}

const waitGroup = (f, id) => waitFor(f, `/api/snapshot-groups/${id}`, (group) => !['running', 'pausing'].includes(group.status));
const waitRecognition = (f, id) => waitFor(f, `/api/recognition-tasks/${id}`, (task) => !['queued', 'running'].includes(task.status));
async function seedLegacy(f, phase = 'fine') {
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  const pans = phase === 'coarse' ? [0, 15, 30] : [15, 45, 75, 105, 135];
  const targets = pans.map((pan, index) => ({ pan, tilt: 8 + (phase === 'fine' ? index * 0.001 : 0), zoom: phase === 'coarse' ? 2 : 12 }));
  const group = { id: `legacy-${phase}-${Date.now()}-${f.state.targets.length}`, cameraId: f.camera.id, cameraName: f.camera.name,
    serial: f.camera.serial, code: f.camera.code, kind: 'scan', status: 'paused', createdAt: new Date().toISOString(),
    finishedAt: null, completedCount: 0, error: null, sampleCount: targets.length,
    basePtz: { pan: 60, tilt: 8, zoom: 12 }, panMin: 0, panMax: phase === 'coarse' ? 30 : 150,
    panStep: phase === 'coarse' ? 15 : 30, horizontalFieldAngle: 30, settleMs: 0, moveTimeoutMs: 1000,
    calibration: calibrationOf(f.camera), ...(phase === 'fixed' ? {} : { targets, horizon: {
      phase, targetZoom: 12, tiltMin: 0, tiltMax: 30, targetHorizontalFov: 30, targetVerticalFov: 20,
      ...(phase === 'fine' ? { angularMarginDegrees: 0.02, sourceRecognitionTaskId: 'legacy-source', sourceRevision: 0, sourceResultId: 'legacy-result' } : {}),
    } }),
  };
  try { store.addSnapshotGroup(group); } finally { store.close(); }
  f.app = await createApp(f.options);
  return group;
}

async function resumeLegacy(f, phase) {
  const group = await seedLegacy(f, phase);
  return f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${group.id}/start` });
}

test('新建拒绝旧预扫参数，原高倍率创建路由移除且不驱动设备', async (t) => {
  const f = await fixture(t);
  const payload = { controlPoints: [{ pan: 0, tilt: 8, zoom: 2 }, { pan: 30, tilt: 8, zoom: 2 }],
    maxPanStep: 15, horizon: { preScanZoom: 2, tiltMin: 0, tiltMax: 30 } };
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshot-scans`, payload })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/recognition-tasks/old-task/horizon-scan',
    payload: { revision: 0, resultId: 'old-result', reviewed: true } })).statusCode, 404);
  assert.equal(f.state.targets.length, 0);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 0);
});

test('新多点任务不自动识别，完成后可独立手动创建识别任务', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshot-scans`, payload: {
    controlPoints: [{ pan: 0, tilt: 8, zoom: 2 }, { pan: 60, tilt: 8.2, zoom: 12 }], maxPanStep: 30, settleMs: 0,
  } });
  assert.equal(response.statusCode, 202, response.body);
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  assert.equal(group.horizon, undefined);
  assert.equal(group.recognitionTaskId, undefined);
  assert.equal((await f.app.inject('/api/recognition-tasks')).json().total, 0);
  const created = await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: group.id } });
  assert.equal(created.statusCode, 202, created.body);
  const task = await waitRecognition(f, created.json().id);
  assert.equal(task.status, 'completed', task.error);
  const snapshots = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json().snapshots;
  assert.deepEqual(snapshots.map((image) => image.ptz.raw.Zoom), [2, 7, 12]);
  assert.deepEqual(snapshots.map((image) => image.ptz.raw.HorizontalFieldAngle), [80, 30, 30]);
  assert.deepEqual(snapshots.map((image) => image.ptz.raw.Tilt), [8, 8.1, 8.2]);
});

test('历史普通任务保留原中心点采样规则，恢复不重算为新端点计划', async (t) => {
  const f = await fixture(t);
  const response = await resumeLegacy(f, 'fixed');
  assert.equal(response.statusCode, 202, response.body);
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  assert.deepEqual(f.state.targets, [15, 45, 75, 105, 135].map((pan) => ({ pan, tilt: 8, zoom: 12 })));
  assert.equal(group.controlPoints, undefined);
});

test('历史预扫识别失败保留截图完成状态与自动关联错误', async (t) => {
  const f = await fixture(t);
  f.state.checkError = httpError(503, '模拟模型环境缺失');
  const response = await resumeLegacy(f, 'coarse');
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  assert.equal(group.snapshotCount, 3);
  assert.match(group.recognitionError, /模拟模型环境缺失/);
  assert.deepEqual(f.state.targets, [0, 15, 30].map((pan) => ({ pan, tilt: 8, zoom: 2 })));
});

test('正式扫描按实际 VFOV 检查余量，无效或过小视场明确失败并保留已完成样本', async (t) => {
  const f = await fixture(t);
  const moves = f.state.targets.length;
  f.state.onRead = () => {
    if (f.state.targets.length >= moves + 2) {
      f.state.raw.HorizontalFieldAngle = 0.1;
      f.state.raw.VerticalFieldAngle = 0.05;
    }
  };
  const response = await resumeLegacy(f, 'fine');
  assert.equal(response.statusCode, 202, response.body);
  const failed = await waitGroup(f, response.json().id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /余量/);
  assert.equal(failed.completedCount, 1);
  assert.equal(failed.snapshotCount, 1);
  f.state.onRead = () => { f.state.raw.VerticalFieldAngle = null; };
  const resumed = await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${failed.id}/start` });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const invalid = await waitGroup(f, failed.id);
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.error, /视场角/);
  assert.equal(invalid.snapshotCount, 1);
});

test('正式任务暂停后冻结计划与标定跨重启保留，配置后续改变不重算，通道冲突拒绝续扫', async (t) => {
  const f = await fixture(t);
  let entered, release;
  const moving = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  const moves = f.state.targets.length;
  f.state.onMove = async (_target, index) => { if (index === moves + 2) { entered(); await gate; } };
  const response = await resumeLegacy(f, 'fine');
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  await moving;
  const pause = f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/pause` });
  try { await delay(10); assert.equal(f.state.stops, 0); } finally { release(); }
  const paused = (await pause).json();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.completedCount, 1);
  const update = (code) => f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`,
    payload: { ...cameraInput, code, pAxisPitch: 35 } });
  assert.equal((await update('another-channel')).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/start` })).statusCode, 409);
  assert.equal((await update(cameraInput.code)).statusCode, 200);
  await f.app.close();
  f.app = await createApp(f.options);
  f.state.raw = { ...f.state.raw, Pan: 250, Tilt: 50, Zoom: 99 };
  const restart = await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/start` });
  assert.equal(restart.statusCode, 202, restart.body);
  const completed = await waitGroup(f, accepted.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.targets, accepted.targets);
  assert.deepEqual(completed.calibration, accepted.calibration);
  assert.deepEqual(completed.horizon, accepted.horizon);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${accepted.id}/snapshots`)).json();
  assert.deepEqual(snapshots.map((item) => item.scanIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(snapshots.map((item) => item.scanTarget), accepted.targets);
  assert.ok(snapshots.every((item) => item.calibration.pAxisPitch === accepted.calibration.pAxisPitch));
});

test('正式扫描停止失败持续占用设备，手动 stop 成功后才可按冻结计划继续', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(t);
  const moves = f.state.targets.length;
  f.state.onMove = (_target, index) => { if (index === moves + 2) throw httpError(502, '模拟正式扫描定位失败'); };
  f.state.onStop = () => { throw httpError(502, '模拟停止失败'); };
  const response = await resumeLegacy(f, 'fine');
  const accepted = response.json();
  const failed = await waitGroup(f, accepted.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /停止云台失败/);
  assert.equal(failed.snapshotCount, 1);
  const resume = () => f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/start` });
  assert.equal((await resume()).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: cameraInput })).statusCode, 409);
  f.state.onStop = null;
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'stop' } })).statusCode, 200);
  assert.equal((await resume()).statusCode, 202);
  const completed = await waitGroup(f, accepted.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.snapshotCount, 5);
  assert.deepEqual(completed.targets, accepted.targets);
});

test('预扫拍满后停止失败，手动停止成功可只重试完成收尾且不创建新扫描', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(t);
  f.state.onStop = () => { throw httpError(502, '模拟停止失败'); };
  const response = await resumeLegacy(f, 'coarse');
  assert.equal(response.statusCode, 202, response.body);
  const failed = await waitGroup(f, response.json().id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.completedCount, failed.sampleCount);
  assert.equal(failed.snapshotCount, failed.sampleCount);
  assert.match(failed.error, /停止云台失败/);
  assert.equal(failed.recognitionTaskId, undefined);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${failed.id}/snapshots`)).json();
  const moves = f.state.targets.length, captures = f.state.captures;
  const resume = () => f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${failed.id}/start` });
  assert.equal((await resume()).statusCode, 409, '停止失败仍占用设备');
  f.state.onStop = null;
  const stopped = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'stop' } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  const resumed = await resume();
  assert.equal(resumed.statusCode, 202, resumed.body);
  const completed = await waitGroup(f, failed.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.error, null);
  assert.equal(completed.completedCount, completed.sampleCount);
  assert.equal(f.state.targets.length, moves, '收尾不重复精确定位');
  assert.equal(f.state.captures, captures, '收尾不补拍');
  assert.equal(f.state.stops, 3, '原收尾、手动停止及恢复收尾各执行一次停止');
  assert.deepEqual((await f.app.inject(`/api/snapshot-groups/${failed.id}/snapshots`)).json().snapshots, snapshots);
  const task = await waitRecognition(f, completed.recognitionTaskId);
  assert.equal(task.status, 'completed', task.error);
  assert.equal((await resume()).statusCode, 409, '已完成任务不能重复收尾');
});

test('多点任务拍满后异常重启保留中断状态，手动收尾不再定位或补拍', async (t) => {
  const f = await fixture(t);
  await f.app.close();
  // 隔离执行并在最终 stop 挂起时终止线程，保留真实持久化进度，不改写任务状态。
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from 'node:worker_threads';
    import { createApp } from ${JSON.stringify(new URL('../server/app.mjs', import.meta.url).href)};
    parentPort.on('message', () => {});
    let raw = workerData.raw, groupId, statusCode, captures = 0;
    const targets = [];
    const app = await createApp({ dataDir: workerData.dataDir, webDir: workerData.webDir,
      recognizer: { check() {}, async run() {} }, livegbs: {
        configured: true,
        async readPtz() {
          const now = new Date().toISOString();
          return { raw: { ...raw }, requestedAt: now, receivedAt: now, durationMs: 1 };
        },
        async preciseControl(_camera, target) {
          targets.push(target);
          raw = { ...raw, Pan: target.pan, Tilt: target.tilt, Zoom: target.zoom,
            HorizontalFieldAngle: 80, VerticalFieldAngle: 45 };
        },
        async snapshot() {
          captures++;
          const now = new Date().toISOString();
          return { bytes: Buffer.from(workerData.png), requestedAt: now, receivedAt: now, durationMs: 1, snapshotTime: null };
        },
        async continuousControl() {
          const group = (await app.inject('/api/snapshot-groups/' + groupId)).json();
          parentPort.postMessage({ group, statusCode, raw, targets, captures });
          await new Promise(() => {});
        },
      } });
    const response = await app.inject({ method: 'POST', url: '/api/cameras/' + workerData.cameraId + '/snapshot-scans',
      payload: { controlPoints: [{ pan: 0, tilt: 8, zoom: 2 }, { pan: 30, tilt: 8, zoom: 2 }],
        maxPanStep: 15, settleMs: 0, moveTimeoutMs: 1000 } });
    groupId = response.json().id;
    statusCode = response.statusCode;
    if (statusCode !== 202) parentPort.postMessage({ statusCode, error: response.body });
  `)}`), { workerData: { dataDir: f.dataDir, webDir: f.options.webDir, cameraId: f.camera.id, raw: f.state.raw, png } });
  let crashed;
  try { [crashed] = await once(worker, 'message', { signal: AbortSignal.timeout(15000) }); }
  finally { await worker.terminate(); }
  assert.equal(crashed.statusCode, 202, crashed.error);
  assert.equal(crashed.group.status, 'running');
  assert.equal(crashed.group.completedCount, crashed.group.sampleCount);
  assert.equal(crashed.group.snapshotCount, crashed.group.sampleCount);
  assert.equal(crashed.captures, crashed.group.sampleCount);
  assert.equal(crashed.targets.length, crashed.group.sampleCount);
  f.state.raw = crashed.raw;
  f.app = await createApp(f.options);
  const interrupted = (await f.app.inject(`/api/snapshot-groups/${crashed.group.id}`)).json();
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.recognitionTaskId, undefined);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${interrupted.id}/snapshots`)).json();
  assert.equal(f.state.targets.length, 0, '重启不自动定位');
  assert.equal(f.state.captures, 0, '重启不自动抓图');
  assert.equal(f.state.stops, 0, '重启不自动驱动设备');
  const resumed = await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${interrupted.id}/start` });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const completed = await waitGroup(f, interrupted.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.error, null);
  assert.equal(completed.completedCount, completed.sampleCount);
  assert.equal(f.state.targets.length, 0, '收尾不重复精确定位');
  assert.equal(f.state.captures, 0, '收尾不补拍');
  assert.equal(f.state.stops, 1, '手动恢复只重新确认停止');
  assert.deepEqual((await f.app.inject(`/api/snapshot-groups/${interrupted.id}/snapshots`)).json().snapshots, snapshots);
  assert.equal(completed.recognitionTaskId, undefined);
});

test('窄视场使用实际 T 容差，保存真实读数而不以控制目标覆盖，并拒绝超容差偏差', async (t) => {
  const f = await fixture(t);
  let bias = 0.03;
  f.state.onRead = () => {
    if (f.state.raw.Zoom === 12) {
      const target = f.state.targets.at(-1);
      f.state.raw.Tilt = target.tilt + bias;
      f.state.raw.HorizontalFieldAngle = 2;
      f.state.raw.VerticalFieldAngle = 1;
    }
  };
  const response = await resumeLegacy(f, 'fine');
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  assert.ok(snapshots.every((item) => Math.abs(item.ptz.raw.Tilt - item.scanTarget.tilt - 0.03) < 1e-10));
  assert.ok(snapshots.every((item) => item.ptzAfter.raw.Tilt === item.ptz.raw.Tilt));
  bias = 0.1;
  const second = await resumeLegacy(f, 'fine');
  assert.equal(second.statusCode, 202, second.body);
  const failed = await waitGroup(f, second.json().id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /时限/);
  assert.equal(failed.snapshotCount, 0);
});

test('服务关闭等待扫描停止和识别关联保存，重启不会重放扫描或排队模型', async (t) => {
  const f = await fixture(t);
  let entered, release;
  const stopping = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onStop = async () => { entered(); await gate; };
  const response = await resumeLegacy(f, 'coarse');
  const id = response.json().id;
  await stopping;
  let closed = false;
  const closing = f.app.close().then(() => { closed = true; });
  try { await delay(10); assert.equal(closed, false); } finally { release(); }
  await closing;
  f.state.onStop = null;
  const moves = f.state.targets.length;
  f.app = await createApp(f.options);
  const group = (await f.app.inject(`/api/snapshot-groups/${id}`)).json();
  assert.equal(group.status, 'completed');
  assert.ok(group.recognitionTaskId);
  const task = (await f.app.inject(`/api/recognition-tasks/${group.recognitionTaskId}`)).json();
  assert.ok(['interrupted', 'completed'].includes(task.status), task.status);
  await delay(20);
  assert.equal(f.state.targets.length, moves);
  assert.equal((await f.app.inject('/api/recognition-tasks')).json().total, 1);
});
