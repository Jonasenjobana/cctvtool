import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { CameraStore } from '../server/store.mjs';
import { createScanPlan, ptzMatches, scanTarget } from '../server/snapshot-scan.mjs';
import { httpError } from '../server/errors.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const cameraInput = { name: '扫描摄像头', serial: 'scan-device', code: 'scan-channel', longitude: 113.9, latitude: 22.1,
  height: 12, pAxisPitch: 1.2, pAxisRoll: -2, panOffset: 90, tiltOffset: 1, imageRoll: 0.5 };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-scan-test-'));
  const state = { raw: { Pan: 60, Tilt: 2.8, Zoom: 15, HorizontalFieldAngle: 30, VerticalFieldAngle: 20 },
    targets: [], stops: 0, onMove: null, onRead: null, ignoreMove: false, failAt: 0, stopFails: false, changeDuringImage: false };
  const livegbs = {
    configured: true,
    async readPtz() {
      await state.onRead?.();
      const now = new Date().toISOString();
      return { raw: { ...state.raw }, requestedAt: now, receivedAt: now, durationMs: 1 };
    },
    async preciseControl(camera, target) {
      state.targets.push({ ...target });
      await state.onMove?.(state.targets.length);
      if (state.targets.length === state.failAt) throw httpError(502, '模拟精确定位失败');
      if (!state.ignoreMove) state.raw = { ...state.raw, Pan: target.pan, Tilt: target.tilt, Zoom: target.zoom };
    },
    async continuousControl(camera, command) {
      assert.equal(command, 'stop');
      state.stops++;
      if (state.stopFails) throw httpError(502, '模拟停止失败');
    },
    async snapshot() {
      if (state.changeDuringImage) state.raw = { ...state.raw, Pan: state.raw.Pan + 1 };
      const now = new Date().toISOString();
      return { bytes: png, requestedAt: now, receivedAt: now, durationMs: 1, snapshotTime: null };
    },
  };
  const options = { dataDir, livegbs, webDir: join(dataDir, 'no-web') };
  const f = { dataDir, state, options, app: await createApp(options) };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-scan-test-')) {
      throw new Error('扫描测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  const saved = await f.app.inject({ method: 'POST', url: '/api/cameras', payload: cameraInput });
  assert.equal(saved.statusCode, 201, saved.body);
  f.camera = saved.json();
  return f;
}

function startScan(f, changes = {}) {
  const { Pan: pan, Tilt: tilt, Zoom: zoom } = f.state.raw;
  return f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshot-scans`,
    payload: { basePtz: { pan, tilt, zoom }, panMin: 0, panMax: 150, settleMs: 0, moveTimeoutMs: 1000, ...changes } });
}

async function waitForGroup(f, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await f.app.inject(`/api/snapshot-groups/${id}`);
    assert.equal(response.statusCode, 200, response.body);
    const group = response.json();
    if (!['running', 'pausing'].includes(group.status)) return group;
    await delay(20);
  }
  throw new Error('等待扫描任务超时');
}

test('扇区按 HFOV 向上取整并等分取中心，150°/30°产生 5 个位置，固定基础 T/Z', () => {
  const basePtz = { pan: 60, tilt: 2.8, zoom: 15 };
  const plan = createScanPlan({ basePtz, panMin: 0, panMax: 150 }, 30);
  assert.equal(plan.sampleCount, 5);
  assert.deepEqual(Array.from({ length: plan.sampleCount }, (_, index) => scanTarget(plan, index)),
    [15, 45, 75, 105, 135].map((pan) => ({ pan, tilt: 2.8, zoom: 15 })));
  const uneven = createScanPlan({ basePtz, panMin: 100, panMax: 251 }, 30);
  assert.equal(uneven.sampleCount, 6);
  assert.ok(uneven.panStep < 30);
  assert.ok(scanTarget(uneven, 0).pan > 100 && scanTarget(uneven, 5).pan < 251);
  assert.equal(createScanPlan({ basePtz, panMin: 0, panMax: 150 }, 0.5).sampleCount, 300);
  assert.throws(() => createScanPlan({ basePtz, panMin: 150, panMax: 150 }, 30), /P.*跨度/);
  for (const fov of [0, null, NaN, 180]) assert.throws(() => createScanPlan({ basePtz, panMin: 0, panMax: 150 }, fov), /视场角/);
  assert.throws(() => createScanPlan({ basePtz, panMin: 0, panMax: 360 }, 0.001), /10000/);
  for (const tilt of [-91, 91, 359.9275]) {
    assert.throws(() => createScanPlan({ basePtz: { ...basePtz, tilt }, panMin: 0, panMax: 30 }, 30), /基础 T/);
  }
});

test('P 按环形角比较，T 直接比较有符号差值，不接受 359 度包装成负角', () => {
  const raw = { Pan: 359.95, Tilt: -0.0725, Zoom: 8 };
  const target = { pan: 0.05, tilt: -0.0725, zoom: 8 };
  assert.equal(ptzMatches(raw, target), true);
  assert.equal(ptzMatches({ ...raw, Tilt: 359.9275 }, target), false);
  assert.equal(ptzMatches({ ...raw, Tilt: 0.2 }, target), false);
});

test('普通扫描接受负 T，并在控制、快照与任务记录中保留原值', async (t) => {
  const f = await fixture(t);
  f.state.raw.Tilt = -2.8;
  const response = await startScan(f, { panMax: 30 });
  assert.equal(response.statusCode, 202, response.body);
  const group = await waitForGroup(f, response.json().id);
  assert.equal(group.status, 'completed', group.error);
  assert.equal(group.basePtz.tilt, -2.8);
  assert.deepEqual(f.state.targets, [{ pan: 15, tilt: -2.8, zoom: 15 }]);
  const { snapshots } = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json();
  assert.equal(snapshots[0].ptz.raw.Tilt, -2.8);
  assert.equal(snapshots[0].scanTarget.tilt, -2.8);
});

test('普通截图从大 P 跨 0° 到小 P，347° 到 9° 只采样 22° 且固定 T/Z', () => {
  const basePtz = { pan: 347, tilt: 2.8, zoom: 15 };
  const plan = createScanPlan({ basePtz, panMin: 347, panMax: 9 }, 8);
  assert.equal(plan.panMin, 347);
  assert.equal(plan.panMax, 9);
  assert.equal(plan.sampleCount, 3);
  assert.equal(plan.panStep, 22 / 3);
  assert.deepEqual(Array.from({ length: plan.sampleCount }, (_, index) => scanTarget(plan, index)),
    [350.666667, 358, 5.333333].map((pan) => ({ pan, tilt: 2.8, zoom: 15 })));
});

test('普通截图正确处理 0°/360° 边界，保留全周扫描并拒绝零跨度', () => {
  const basePtz = { pan: 347, tilt: 2.8, zoom: 15 };
  const zeroCenter = createScanPlan({ basePtz, panMin: 347, panMax: 13 }, 30);
  assert.equal(zeroCenter.sampleCount, 1);
  assert.equal(scanTarget(zeroCenter, 0).pan, 0);
  const from360 = createScanPlan({ basePtz, panMin: 360, panMax: 9 }, 3);
  assert.deepEqual(Array.from({ length: from360.sampleCount }, (_, index) => scanTarget(from360, index).pan), [1.5, 4.5, 7.5]);
  const toZero = createScanPlan({ basePtz, panMin: 350, panMax: 0 }, 5);
  assert.deepEqual(Array.from({ length: toZero.sampleCount }, (_, index) => scanTarget(toZero, index).pan), [352.5, 357.5]);
  assert.equal(createScanPlan({ basePtz, panMin: 0, panMax: 360 }, 30).sampleCount, 12);
  for (const [panMin, panMax] of [[9, 9], [0, 0], [360, 360], [360, 0]]) {
    assert.throws(() => createScanPlan({ basePtz, panMin, panMax }, 30), /P.*范围|P.*跨度/);
  }
});

test('跨 0° 任务保存短扇区，重启后从未完成位置继续并保留原始 T/Z', async (t) => {
  const f = await fixture(t);
  f.state.raw = { ...f.state.raw, Pan: 347, HorizontalFieldAngle: 8 };
  f.state.failAt = 3;
  t.mock.method(console, 'error', () => {});
  const response = await startScan(f, { panMin: 347, panMax: 9 });
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  assert.equal(accepted.sampleCount, 3);
  assert.equal(accepted.panStep, 22 / 3);
  const failed = await waitForGroup(f, accepted.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.completedCount, 2);
  await f.app.close();
  f.app = await createApp(f.options);
  const restored = (await f.app.inject(`/api/snapshot-groups/${accepted.id}`)).json();
  assert.equal(restored.panMin, 347);
  assert.equal(restored.panMax, 9);
  assert.equal(restored.panStep, 22 / 3);
  f.state.failAt = 0;
  f.state.raw = { ...f.state.raw, Tilt: 8, Zoom: 40 };
  const resumed = await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${accepted.id}/start` });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const completed = await waitForGroup(f, accepted.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completedCount, 3);
  const images = (await f.app.inject(`/api/snapshot-groups/${accepted.id}/snapshots`)).json().snapshots;
  assert.deepEqual(images.map((image) => image.scanIndex), [0, 1, 2]);
  assert.deepEqual(images.map((image) => image.scanTarget),
    [350.666667, 358, 5.333333].map((pan) => ({ pan, tilt: 2.8, zoom: 15 })));
  assert.deepEqual(images.map((image) => image.ptz.raw.Pan), [350.666667, 358, 5.333333]);
  assert.ok(images.every((image) => image.ptz.raw.Tilt === 2.8 && image.ptz.raw.Zoom === 15));
});

test('扫描立即返回任务组，逐点精确定位后保存真实前后 PTZ，任务与组内图片均分页', async (t) => {
  const f = await fixture(t);
  const calibration = { ...cameraInput, pAxisPitch: 3 };
  for (const key of ['name', 'serial', 'code']) delete calibration[key];
  const response = await startScan(f, { calibration });
  assert.equal(response.statusCode, 202, response.body);
  const accepted = response.json();
  assert.equal(accepted.sampleCount, 5);
  assert.equal(accepted.completedCount, 0);
  assert.equal(response.headers.location, `/api/snapshot-groups/${accepted.id}`);
  const group = await waitForGroup(f, accepted.id);
  assert.equal(group.status, 'completed');
  assert.equal(group.completedCount, 5);
  assert.equal(group.snapshotCount, 5);
  assert.equal(f.state.stops, 1);
  assert.deepEqual(f.state.targets.map((target) => target.pan), [15, 45, 75, 105, 135]);
  assert.ok(f.state.targets.every((target) => target.tilt === 2.8 && target.zoom === 15));
  const first = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots?limit=2`)).json();
  const second = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots?limit=3&offset=2`)).json();
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 2);
  assert.equal(second.nextOffset, null);
  const snapshots = [...first.snapshots, ...second.snapshots];
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.id)).size, 5);
  snapshots.forEach((snapshot, index) => {
    assert.equal(snapshot.groupId, group.id);
    assert.equal(snapshot.scanIndex, index);
    assert.equal(snapshot.ptz.raw.Pan, f.state.targets[index].pan);
    assert.deepEqual(snapshot.ptz.raw, snapshot.ptzAfter.raw);
    assert.deepEqual(snapshot.calibration, calibration);
    assert.equal(snapshot.usesDraft, true);
    assert.equal(snapshot.timeAlignment, 'unverified');
  });
  assert.equal((await f.app.inject(snapshots[0].imageUrl)).statusCode, 200);
  const manual = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} });
  assert.equal(manual.statusCode, 201);
  const groups = (await f.app.inject(`/api/cameras/${f.camera.id}/snapshot-groups?limit=1`)).json();
  assert.equal(groups.total, 2);
  assert.equal(groups.groups.length, 1);
  assert.equal(groups.nextOffset, 1);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 1);
  const readOnly = new CameraStore(f.dataDir, { readOnly: true });
  try {
    const page = readOnly.querySnapshots(f.camera.id, { startTime: '2000-01-01', endTime: '2100-01-01', groupId: group.id });
    assert.equal(page.total, 5);
    assert.ok(page.snapshots.every((snapshot) => snapshot.groupId === group.id));
  } finally { readOnly.close(); }
  await f.app.close();
  f.app = await createApp(f.options);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${group.id}`)).json().snapshotCount, 5);
});

test('暂停排在在途精确定位之后，继续从未完成位置开始，保持原任务 T/Z 且不重复保存已完成点', async (t) => {
  const f = await fixture(t);
  let release;
  let arrived;
  const entered = new Promise((accept) => { arrived = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onMove = async (index) => { if (index === 2) { arrived(); await gate; } };
  const accepted = await startScan(f);
  const id = accepted.json().id;
  await entered;
  const pause = f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/pause` });
  try {
    await delay(20);
    assert.equal(f.state.stops, 0);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: cameraInput })).statusCode, 409);
    assert.equal((await startScan(f)).statusCode, 409);
    const saved = (await f.app.inject(`/api/snapshot-groups/${id}/snapshots`)).json().snapshots[0];
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${saved.id}` })).statusCode, 409);
  } finally { release(); }
  const paused = await pause;
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().status, 'paused');
  assert.equal(paused.json().completedCount, 1);
  assert.equal(paused.json().snapshotCount, 1);
  assert.equal(f.state.stops, 1);
  f.state.raw = { ...f.state.raw, Tilt: 8, Zoom: 40 };
  const resume = await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/start` });
  assert.equal(resume.statusCode, 202, resume.body);
  const completed = await waitForGroup(f, id);
  assert.equal(completed.status, 'completed');
  const images = (await f.app.inject(`/api/snapshot-groups/${id}/snapshots`)).json().snapshots;
  assert.deepEqual(images.map((snapshot) => snapshot.scanIndex), [0, 1, 2, 3, 4]);
  assert.ok(images.every((snapshot) => snapshot.ptz.raw.Tilt === 2.8 && snapshot.ptz.raw.Zoom === 15));
  assert.equal(f.state.targets.filter((target) => target.pan === 15).length, 1);
  assert.equal((await f.app.inject('/api/snapshot-tasks')).json().total, 1);
});

test('扫描初始化回读仍在途时 stop 等待初始化结束并取消任务，不会在 stop 之后启动扫描', async (t) => {
  const f = await fixture(t);
  let release;
  let arrived;
  const entered = new Promise((accept) => { arrived = accept; });
  const gate = new Promise((accept) => { release = accept; });
  let first = true;
  f.state.onRead = async () => { if (first) { first = false; arrived(); await gate; } };
  const starting = startScan(f);
  await entered;
  const stop = f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'stop' } });
  try { await delay(20); assert.equal(f.state.stops, 0); } finally { release(); }
  const response = await starting;
  assert.equal(response.statusCode, 202, response.body);
  assert.equal((await stop).statusCode, 200);
  const group = await waitForGroup(f, response.json().id);
  assert.equal(group.status, 'cancelled');
  assert.equal(f.state.targets.length, 0);
  assert.equal(group.snapshotCount, 0);
});

test('中途定位失败保留同组已完成图片，失败后可继续，停止失败保留设备锁直到 stop 重试成功', async (t) => {
  const f = await fixture(t);
  f.state.failAt = 2;
  f.state.stopFails = true;
  const logs = t.mock.method(console, 'error', () => {});
  const response = await startScan(f);
  const id = response.json().id;
  const failed = await waitForGroup(f, id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.snapshotCount, 1);
  assert.match(failed.error, /停止云台失败/);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/start` })).statusCode, 409);
  f.state.stopFails = false;
  const stop = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'stop' } });
  assert.equal(stop.statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/start` })).statusCode, 202);
  assert.equal((await waitForGroup(f, id)).snapshotCount, 5);
  assert.ok(logs.mock.calls.length >= 1);
});

test('取消任务等待在途请求后停止，重启不自动驱动设备，paused 状态可持久化', async (t) => {
  const f = await fixture(t);
  let release;
  let arrived;
  const entered = new Promise((accept) => { arrived = accept; });
  const gate = new Promise((accept) => { release = accept; });
  f.state.onMove = async () => { arrived(); await gate; };
  const response = await startScan(f);
  const id = response.json().id;
  await entered;
  const cancel = f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/cancel` });
  try { await delay(20); assert.equal(f.state.stops, 0); } finally { release(); }
  assert.equal((await cancel).json().status, 'cancelled');
  assert.equal(f.state.targets.length, 1);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${id}`)).json().snapshotCount, 0);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/snapshot-tasks/${id}/start` })).statusCode, 409);
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  try {
    store.updateSnapshotGroup(id, { status: 'paused' });
    const group = store.getSnapshotGroup(id);
    store.addSnapshotGroup({ ...group, id: 'interrupted-task', status: 'running' });
  } finally { store.close(); }
  const moves = f.state.targets.length;
  f.app = await createApp(f.options);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${id}`)).json().status, 'paused');
  assert.equal((await f.app.inject('/api/snapshot-groups/interrupted-task')).json().status, 'interrupted');
  assert.equal(f.state.targets.length, moves);
});

test('无效基础 PTZ、范围、FOV、分页参数不会驱动设备；未到位超时和截图时姿态变化不会存坏样本', async (t) => {
  const f = await fixture(t);
  assert.equal((await startScan(f, { basePtz: { pan: 60, tilt: 2.8, zoom: 10 } })).statusCode, 409);
  assert.equal((await startScan(f, { panMin: 150, panMax: 150 })).statusCode, 400);
  assert.equal((await startScan(f, { panMin: 360, panMax: 0 })).statusCode, 400);
  assert.equal((await startScan(f, { panMax: 361 })).statusCode, 400);
  f.state.raw.HorizontalFieldAngle = null;
  assert.equal((await startScan(f)).statusCode, 502);
  assert.equal(f.state.targets.length, 0);
  assert.equal((await f.app.inject('/api/snapshot-tasks?limit=101')).statusCode, 400);
  assert.equal((await f.app.inject('/api/snapshot-tasks?offset=-1')).statusCode, 400);
  f.state.raw.HorizontalFieldAngle = 30;
  f.state.ignoreMove = true;
  const timeout = await startScan(f);
  const timedOut = await waitForGroup(f, timeout.json().id);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.snapshotCount, 0);
  assert.match(timedOut.error, /时限/);
  f.state.ignoreMove = false;
  f.state.changeDuringImage = true;
  const changed = await startScan(f);
  const failed = await waitForGroup(f, changed.json().id);
  assert.equal(failed.snapshotCount, 0);
  assert.match(failed.error, /姿态发生变化/);
  assert.deepEqual(await readdir(join(f.dataDir, 'snapshots')), []);
});

test('删除单张会清理图片和记录，数据库拒绝删除时还原原图，不影响同组其他样本', async (t) => {
  const f = await fixture(t);
  const accepted = await startScan(f, { panMax: 60 });
  const group = await waitForGroup(f, accepted.json().id);
  const images = (await f.app.inject(`/api/snapshot-groups/${group.id}/snapshots`)).json().snapshots;
  const db = new DatabaseSync(join(f.dataDir, 'cctv.sqlite'));
  db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'test delete failure'); END;");
  const logs = t.mock.method(console, 'error', () => {});
  const failed = await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${images[0].id}` });
  assert.equal(failed.statusCode, 500);
  assert.equal((await f.app.inject(images[0].imageUrl)).statusCode, 200);
  assert.equal((await f.app.inject(`/api/snapshot-groups/${group.id}`)).json().snapshotCount, 2);
  assert.equal((await readdir(join(f.dataDir, 'snapshots'))).length, 2);
  assert.ok(logs.mock.calls.length >= 1);
  db.exec('DROP TRIGGER refuse_delete');
  db.close();
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${images[0].id}` })).statusCode, 204);
  assert.equal((await f.app.inject(images[0].imageUrl)).statusCode, 404);
  assert.equal((await f.app.inject(images[1].imageUrl)).statusCode, 200);
  const remaining = (await f.app.inject(`/api/snapshot-groups/${group.id}`)).json();
  assert.equal(remaining.snapshotCount, 1);
  assert.equal(remaining.completedCount, 2);
  assert.equal((await readdir(join(f.dataDir, 'snapshots'))).length, 1);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${images[0].id}` })).statusCode, 404);
});
