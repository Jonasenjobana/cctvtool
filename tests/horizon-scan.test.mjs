import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.mjs';
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
        const actual = { ...f.camera, pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 8, imageRoll: -0.8 };
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

function startCoarse(f, changes = {}) {
  const { Pan: pan, Tilt: tilt, Zoom: zoom } = f.state.raw;
  return f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshot-scans`, payload: {
    basePtz: { pan, tilt, zoom }, panMin: 0, panMax: 150, settleMs: 0, moveTimeoutMs: 1000,
    horizon: { preScanZoom: 2, tiltMin: 0, tiltMax: 30 }, ...changes,
  } });
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
const startFine = (f, task, changes = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${task.id}/horizon-scan`,
  payload: { revision: task.revision, resultId: task.resultId, reviewed: true, ...changes } });

async function completedCoarse(f, changes) {
  const response = await startCoarse(f, changes);
  assert.equal(response.statusCode, 202, response.body);
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  const task = await waitRecognition(f, group.recognitionTaskId);
  assert.equal(task.result?.status, 'estimated', JSON.stringify(task));
  return { group, task };
}

test('海天线预扫在低倍率均匀覆盖两端，冻结发起时高倍率和视场角并保存实际低倍读数', async (t) => {
  const f = await fixture(t);
  const response = await startCoarse(f, { panMax: 30 });
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  assert.equal(accepted.sampleCount, 3);
  assert.deepEqual(accepted.horizon, { phase: 'coarse', targetZoom: 12, tiltMin: 0, tiltMax: 30,
    targetHorizontalFov: 30, targetVerticalFov: 20 });
  const group = await waitGroup(f, accepted.id);
  assert.equal(group.status, 'completed', group.error);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  assert.deepEqual(snapshots.map((item) => item.scanTarget), [0, 15, 30].map((pan) => ({ pan, tilt: 8, zoom: 2 })));
  assert.ok(snapshots.every((item) => item.ptz.raw.Zoom === 2 && item.ptz.raw.HorizontalFieldAngle === 80
    && item.ptz.raw.VerticalFieldAngle === 45 && item.timeAlignment === 'unverified'));
});

test('预扫拒绝无效倍率、T 区间、方向覆盖和目标 FOV，校验失败不会转动设备', async (t) => {
  const f = await fixture(t);
  for (const horizon of [
    { preScanZoom: 12, tiltMin: 0, tiltMax: 30 }, { preScanZoom: 20, tiltMin: 0, tiltMax: 30 },
    { preScanZoom: 2, tiltMin: 10, tiltMax: 30 }, { preScanZoom: 2, tiltMin: 0, tiltMax: 7 },
    { preScanZoom: 2, tiltMin: 30, tiltMax: 0 }, { preScanZoom: 2, tiltMin: 8, tiltMax: 8 },
  ]) assert.equal((await startCoarse(f, { horizon })).statusCode, 400, JSON.stringify(horizon));
  assert.equal((await startCoarse(f, { panMax: 29 })).statusCode, 400);
  f.state.raw.VerticalFieldAngle = null;
  assert.equal((await startCoarse(f)).statusCode, 502);
  assert.equal(f.state.targets.length, 0);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 0);
});

test('预扫完成自动关联识别，识别终态包含候选与角度残差且不应用设备配置', async (t) => {
  const f = await fixture(t);
  const response = await startCoarse(f);
  assert.equal(response.statusCode, 202, response.body);
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  assert.ok(group.recognitionTaskId, '截图完成时应已保存自动识别关联');
  const task = await waitRecognition(f, group.recognitionTaskId);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.result?.status, 'estimated', JSON.stringify(task.result));
  assert.equal(task.resultRevision, 0);
  assert.ok(Number.isFinite(task.result.diagnostics.rmsAngularResidualDegrees));
  assert.equal(task.appliedAt, null);
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);
  await f.app.close();
  f.app = await createApp(f.options);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${group.id}`)).json().recognitionTaskId, task.id);
  assert.equal((await f.app.inject(`/api/recognition-tasks/${task.id}`)).json().resultId, task.resultId);
});

test('复核粗结果后正式扫描恢复目标倍率、逐点补偿 T，并在完成后自动生成最终候选', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  const response = await startFine(f, task);
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  assert.equal(response.headers.location, `/api/snapshot-groups/${accepted.id}`);
  assert.equal(accepted.horizon.phase, 'fine');
  assert.equal(accepted.horizon.sourceRecognitionTaskId, task.id);
  assert.equal(accepted.horizon.sourceRevision, task.revision);
  assert.equal(accepted.horizon.sourceResultId, task.resultId);
  assert.deepEqual(accepted.targets.map((target) => target.pan), [15, 45, 75, 105, 135]);
  assert.ok(Math.max(...accepted.targets.map((target) => target.tilt)) - Math.min(...accepted.targets.map((target) => target.tilt)) > 1);
  assert.ok(accepted.targets.every((target) => target.zoom === 12));
  const group = await waitGroup(f, accepted.id);
  assert.equal(group.status, 'completed', group.error);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  assert.deepEqual(snapshots.map((item) => item.scanTarget), accepted.targets);
  for (const snapshot of snapshots) {
    const actual = { ...f.camera, pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 8, imageRoll: -0.8 };
    const { observations } = syntheticSnapshots({ camera: actual, pitch: actual.pAxisPitch, roll: actual.pAxisRoll,
      pans: [snapshot.ptz.raw.Pan], ptzOverrides: snapshot.ptz.raw });
    assert.ok(Math.abs(observations[0].points[1].y - 0.5) < 0.001, '独立椭球射线生成的中心海天线应接近画面中心');
    assert.equal(snapshot.ptz.raw.Tilt, snapshot.scanTarget.tilt);
    assert.equal(snapshot.ptz.raw.Zoom, 12);
  }
  const final = await waitRecognition(f, group.recognitionTaskId);
  assert.equal(final.status, 'completed', final.error);
  assert.equal(final.sourceTaskId, group.id);
  assert.ok(final.result, '最终识别终态应包含候选计算结果');
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);
});

test('正式扫描要求复核当前版本与当前合格结果，修改标注后必须重新生成并复核', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  const moves = f.state.targets.length;
  assert.equal((await startFine(f, task, { reviewed: false })).statusCode, 409);
  assert.equal((await startFine(f, task, { revision: 1 })).statusCode, 409);
  assert.equal((await startFine(f, task, { resultId: 'old-result' })).statusCode, 409);
  const regenerated = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${task.id}/generate`, payload: { revision: 0 } });
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  assert.equal((await startFine(f, task)).statusCode, 409);
  const item = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json().items[0];
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${item.snapshotId}`,
    payload: { revision: 0, ignored: true } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await startFine(f, { ...task, revision: 1 })).statusCode, 409);
  assert.equal(f.state.targets.length, moves);
});

test('只有已完成预扫能启动正式扫描，同一预扫的手动新一轮识别也可作为来源', async (t) => {
  const f = await fixture(t);
  let entered, release;
  const moving = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onMove = async (_target, index) => { if (index === 4) { entered(); await gate; } };
  const response = await startCoarse(f);
  const id = response.json().id;
  await moving;
  const pause = f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/pause` });
  try { await delay(10); } finally { release(); }
  assert.equal((await pause).json().status, 'paused');
  const manual = await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: id } });
  assert.equal(manual.statusCode, 202, manual.body);
  await waitRecognition(f, manual.json().id);
  const generated = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${manual.json().id}/generate`, payload: { revision: 0 } });
  assert.equal(generated.json().result?.status, 'estimated', generated.body);
  const task = generated.json();
  assert.equal((await startFine(f, task)).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/start` })).statusCode, 202);
  const coarse = await waitGroup(f, id);
  assert.equal(coarse.status, 'completed', coarse.error);
  assert.notEqual(coarse.recognitionTaskId, task.id);
  const fine = await startFine(f, task);
  assert.equal(fine.statusCode, 202, fine.body);
  assert.equal((await waitGroup(f, fine.json().id)).status, 'completed');
});

test('设备配置或配置版本改变后拒绝旧粗结果，重新生成后才可启动正式扫描', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  const changed = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...cameraInput, height: 13 } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await startFine(f, task)).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: cameraInput })).statusCode, 200);
  assert.equal((await startFine(f, task)).statusCode, 409, '恢复字段值后配置版本仍已改变');
  const regenerated = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${task.id}/generate`, payload: { revision: 0 } });
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  const response = await startFine(f, regenerated.json());
  assert.equal(response.statusCode, 202, response.body);
  assert.equal((await waitGroup(f, response.json().id)).status, 'completed');
});

test('参与粗拟合的原图文件或源记录删除后拒绝启动，保留已有截图与任务', async (t) => {
  const f = await fixture(t);
  const { group, task } = await completedCoarse(f);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  const moves = f.state.targets.length;
  const filePath = join(f.dataDir, 'snapshots', snapshots[0].fileName);
  await unlink(filePath);
  assert.equal((await startFine(f, task)).statusCode, 409);
  await writeFile(filePath, png);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${snapshots[1].id}` })).statusCode, 204);
  assert.equal((await startFine(f, task)).statusCode, 409);
  assert.equal(f.state.targets.length, moves);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${group.id}`)).json().status, 'completed');
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 1);
});

test('正式扫描按实际 VFOV 检查余量，无效或过小视场明确失败并保留已完成样本', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  const moves = f.state.targets.length;
  f.state.onRead = () => {
    if (f.state.targets.length >= moves + 2) {
      f.state.raw.HorizontalFieldAngle = 0.1;
      f.state.raw.VerticalFieldAngle = 0.05;
    }
  };
  const response = await startFine(f, task);
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

test('正式扫描在任何移动前拒绝目标倍率余量不足的整份计划', async (t) => {
  const f = await fixture(t);
  f.state.raw.VerticalFieldAngle = 0.05;
  const { task } = await completedCoarse(f);
  const moves = f.state.targets.length;
  const response = await startFine(f, task);
  assert.equal(response.statusCode, 502, response.body);
  assert.match(response.json().message, /余量/);
  assert.equal(f.state.targets.length, moves);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 1);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: cameraInput })).statusCode, 200);
});

test('正式扫描先解出全部可达 T，任一目标不可达时不创建任务或提前转动设备', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f, { horizon: { preScanZoom: 2, tiltMin: 0, tiltMax: 8 } });
  const moves = f.state.targets.length;
  const response = await startFine(f, task);
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().message, /不可达/);
  assert.equal(f.state.targets.length, moves);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 1);
});

test('识别创建失败、检测失败和无有效标注都保留截图完成状态并明确展示各自结果', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const mode of ['create-failed', 'detect-failed', 'no-horizon']) {
    const f = await fixture(t);
    if (mode === 'create-failed') f.state.checkError = httpError(503, '模拟识别环境不可用');
    if (mode === 'detect-failed') f.state.runError = httpError(500, '模拟检测失败');
    if (mode === 'no-horizon') f.state.ignored = true;
    const response = await startCoarse(f, { panMax: 30 });
    assert.equal(response.statusCode, 202, response.body);
    const group = await waitGroup(f, response.json().id);
    assert.equal(group.status, 'completed', mode);
    assert.equal(group.snapshotCount, 3);
    if (mode === 'create-failed') {
      assert.match(group.recognitionError, /模拟识别环境不可用/);
      assert.equal(group.recognitionTaskId, undefined);
      assert.equal((await f.app.inject('/api/recognition-tasks')).json().total, 0);
    } else {
      const task = await waitRecognition(f, group.recognitionTaskId);
      assert.equal(task.status, mode === 'detect-failed' ? 'failed' : 'completed');
      if (mode === 'detect-failed') assert.match(task.error, /模拟检测失败/);
      else assert.equal(task.result?.status, 'insufficient_data');
      assert.equal((await startFine(f, task, { resultId: task.resultId || 'no-result' })).statusCode, 409);
    }
  }
});

test('正式任务暂停后冻结计划与标定跨重启保留，粗标注和配置后续改变不重算，通道冲突拒绝续扫', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  let entered, release;
  const moving = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  const moves = f.state.targets.length;
  f.state.onMove = async (_target, index) => { if (index === moves + 2) { entered(); await gate; } };
  const response = await startFine(f, task);
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  await moving;
  const pause = f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/pause` });
  try { await delay(10); assert.equal(f.state.stops, 1); } finally { release(); }
  const paused = (await pause).json();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.completedCount, 1);
  const item = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json().items[0];
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${item.snapshotId}`,
    payload: { revision: 0, ignored: true } })).statusCode, 200);
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
  const { task } = await completedCoarse(f);
  const moves = f.state.targets.length;
  f.state.onMove = (_target, index) => { if (index === moves + 2) throw httpError(502, '模拟正式扫描定位失败'); };
  f.state.onStop = () => { throw httpError(502, '模拟停止失败'); };
  const response = await startFine(f, task);
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

test('预扫拍满后停止失败，手动停止成功可只重试完成收尾并继续正式扫描', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(t);
  f.state.onStop = () => { throw httpError(502, '模拟停止失败'); };
  const response = await startCoarse(f);
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
  assert.equal(task.result?.status, 'estimated', JSON.stringify(task.result));
  assert.equal((await resume()).statusCode, 409, '已完成任务不能重复收尾');
  const fine = await startFine(f, task);
  assert.equal(fine.statusCode, 202, fine.body);
  assert.equal((await waitGroup(f, fine.json().id)).status, 'completed');
});

test('预扫拍满后异常重启保留中断状态，手动收尾不再定位或补拍并可正式扫描', async (t) => {
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
      payload: { basePtz: { pan: raw.Pan, tilt: raw.Tilt, zoom: raw.Zoom }, panMin: 0, panMax: 150,
        settleMs: 0, moveTimeoutMs: 1000, horizon: { preScanZoom: 2, tiltMin: 0, tiltMax: 30 } } });
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
  const task = await waitRecognition(f, completed.recognitionTaskId);
  assert.equal(task.result?.status, 'estimated', JSON.stringify(task.result));
  const fine = await startFine(f, task);
  assert.equal(fine.statusCode, 202, fine.body);
  assert.equal((await waitGroup(f, fine.json().id)).status, 'completed');
});

test('窄视场使用实际 T 容差，保存真实读数而不以控制目标覆盖，并拒绝超容差偏差', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  let bias = 0.03;
  f.state.onRead = () => {
    if (f.state.raw.Zoom === 12) {
      const target = f.state.targets.at(-1);
      f.state.raw.Tilt = target.tilt + bias;
      f.state.raw.HorizontalFieldAngle = 2;
      f.state.raw.VerticalFieldAngle = 1;
    }
  };
  const response = await startFine(f, task);
  const group = await waitGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  assert.ok(snapshots.every((item) => Math.abs(item.ptz.raw.Tilt - item.scanTarget.tilt - 0.03) < 1e-10));
  assert.ok(snapshots.every((item) => item.ptzAfter.raw.Tilt === item.ptz.raw.Tilt));
  bias = 0.1;
  const second = await startFine(f, task);
  assert.equal(second.statusCode, 202, second.body);
  const failed = await waitGroup(f, second.json().id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /时限/);
  assert.equal(failed.snapshotCount, 0);
});

test('并行复核请求只启动一份正式任务，停止等待在途定位后取消且不再采样', async (t) => {
  const f = await fixture(t);
  const { task } = await completedCoarse(f);
  let entered, release;
  const moving = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onMove = async () => { entered(); await gate; };
  const responses = await Promise.all([startFine(f, task), startFine(f, task)]);
  assert.deepEqual(responses.map((item) => item.statusCode).sort(), [202, 409]);
  const accepted = responses.find((item) => item.statusCode === 202).json();
  await moving;
  const stop = f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'stop' } });
  try { await delay(10); assert.equal(f.state.stops, 1); } finally { release(); }
  assert.equal((await stop).statusCode, 200);
  const cancelled = await waitGroup(f, accepted.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.snapshotCount, 0);
  assert.equal(cancelled.recognitionTaskId, undefined);
});

test('服务关闭等待扫描停止和识别关联保存，重启不会重放扫描或排队模型', async (t) => {
  const f = await fixture(t);
  let entered, release;
  const stopping = new Promise((accept) => { entered = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onStop = async () => { entered(); await gate; };
  const response = await startCoarse(f, { panMax: 30 });
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
