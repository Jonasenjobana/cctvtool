import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CameraStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { fixtureCamera, syntheticSnapshots } from './calibration-fixtures.mjs';

async function fixture(t, customRecognizer, sampleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-recognition-test-'));
  const store = new CameraStore(dataDir);
  const input = Object.fromEntries(['name', 'serial', 'code', 'longitude', 'latitude', 'height', 'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'].map((key) => [key, fixtureCamera[key]]));
  const camera = store.saveCamera(input);
  const actual = { ...camera, tiltOffset: 1.1, imageRoll: -0.8 };
  const { snapshots, observations } = syntheticSnapshots({ camera: actual, ...sampleOptions });
  store.addSnapshotGroup({ id: 'source-task', cameraId: camera.id, cameraName: camera.name, kind: 'scan', status: 'completed',
    createdAt: snapshots[0].createdAt, sampleCount: snapshots.length, completedCount: 0 });
  snapshots.forEach((snapshot, scanIndex) => store.addSnapshot({ ...snapshot, groupId: 'source-task', scanIndex,
    fileName: `${snapshot.id}.jpg`, imageUrl: `/api/snapshots/${snapshot.id}/image`, contentType: 'image/jpeg' }));
  store.close();
  const recognizer = customRecognizer || { async run(images, { onResult }) {
    for (const image of images) {
      onResult({ snapshotId: image.snapshotId, points: observations.find((item) => item.snapshotId === image.snapshotId).points.filter((_, index) => index !== 1) });
    }
  } };
  const options = { dataDir, recognizer, webDir: join(dataDir, 'missing-web'), livegbs: { configured: false } };
  const f = { app: await createApp(options), options, camera, input, snapshots, observations, dataDir };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-recognition-test-')) throw new Error('临时路径无效');
    await rm(target, { recursive: true, force: true });
  });
  return f;
}

async function createAndWait(f) {
  const response = await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: 'source-task' } });
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json().id;
  for (let iteration = 0; iteration < 100; iteration++) {
    await new Promise((accept) => setTimeout(accept, 10));
    const task = (await f.app.inject(`/api/recognition-tasks/${id}`)).json();
    if (!['queued', 'running'].includes(task.status)) return task;
  }
  throw new Error('识别未结束');
}
const post = async (f, id, action, revision) => {
  const task = action === 'apply' ? (await f.app.inject(`/api/recognition-tasks/${id}`)).json() : null;
  return f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${id}/${action}`,
    payload: { revision, ...(task ? { resultId: task.resultId || 'no-result' } : {}) } });
};

test('全景参考线对已有识别任务缺省为空，未知任务返回 404', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const response = await f.app.inject(`/api/recognition-tasks/${task.id}/panorama-guide`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { guide: null, revision: 0 });
  assert.equal((await f.app.inject('/api/recognition-tasks/unknown/panorama-guide')).statusCode, 404);
});

test('全景参考线独立保存并在重启后恢复，不改变正式标注、安装结果或应用状态', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const annotated = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${f.snapshots[0].id}`,
    payload: { revision: 0, ignored: true, points: f.observations[0].points.filter((_, index) => index !== 1) } });
  assert.equal(annotated.statusCode, 200, annotated.body);
  const generated = await post(f, task.id, 'generate', 1);
  assert.equal(generated.statusCode, 200, generated.body);
  assert.equal(generated.json().result.status, 'estimated');
  const pageBefore = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json();
  const cameraBefore = (await f.app.inject('/api/cameras')).json();
  const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
  const line = { kind: 'line', points: [{ heading: 6.1, elevation: -0.01 }, { heading: 6.4, elevation: 0.02 }] };
  const saved = await f.app.inject({ method: 'PUT', url, payload: { guide: line, revision: 0 } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { guide: line, revision: 1 });
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json(), pageBefore);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameraBefore);
  const applied = await post(f, task.id, 'apply', 1);
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedPage = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json();
  const appliedCamera = (await f.app.inject('/api/cameras')).json();
  const quadratic = { kind: 'quadratic', points: [
    { heading: 6.1, elevation: -0.01 }, { heading: 6.3, elevation: 0.04 }, { heading: 6.4, elevation: 0.02 },
  ] };
  const curved = await f.app.inject({ method: 'PUT', url, payload: { guide: quadratic, revision: 1 } });
  assert.equal(curved.statusCode, 200, curved.body);
  assert.deepEqual(curved.json(), { guide: quadratic, revision: 2 });
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.app.inject(url)).json(), { guide: quadratic, revision: 2 });
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json(), appliedPage);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), appliedCamera);
  const removed = await f.app.inject({ method: 'PUT', url, payload: { guide: null, revision: 2 } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { guide: null, revision: 3 });
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json(), appliedPage);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), appliedCamera);
});

test('多控制点贝塞尔参考线可保存和重启恢复，点数边界不影响已保存结果', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
  const guide = { kind: 'bezier', points: [
    { heading: 6.1, elevation: 0 }, { heading: 6.2, elevation: 0.02 },
    { heading: 6.3, elevation: 0 }, { heading: 6.4, elevation: -0.01 },
    { heading: 6.5, elevation: 0 },
  ] };
  const before = (await f.app.inject(`/api/recognition-tasks/${task.id}`)).json();
  const saved = await f.app.inject({ method: 'PUT', url, payload: { guide, revision: 0 } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { guide, revision: 1 });
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.app.inject(url)).json(), { guide, revision: 1 });
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${task.id}`)).json(), before);
  for (const length of [3, 4, 6, 67]) {
    const invalid = { kind: 'bezier', points: Array.from({ length }, (_, index) => ({ heading: index / 20, elevation: 0 })) };
    const response = await f.app.inject({ method: 'PUT', url, payload: { guide: invalid, revision: 1 } });
    assert.equal(response.statusCode, 400, `点数 ${length}：${response.body}`);
  }
  assert.deepEqual((await f.app.inject(url)).json(), { guide, revision: 1 });
  const maximum = { kind: 'bezier', points: Array.from({ length: 65 }, (_, index) => ({ heading: index / 20, elevation: 0 })) };
  assert.equal((await f.app.inject({ method: 'PUT', url, payload: { guide: maximum, revision: 1 } })).statusCode, 200);
});

test('全景参考线拒绝非法形状和非有限坐标，失败不产生参考线版本', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
  for (const guide of [
    { kind: 'line', points: [{ heading: 0, elevation: 0 }] },
    { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 0 }, { heading: 2, elevation: 0 }] },
    { kind: 'quadratic', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 0 }] },
    { kind: 'cubic', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [null, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [{ heading: 0 }, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [{ heading: '0', elevation: 0 }, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [{ heading: 0, elevation: null }, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [{ heading: 0, elevation: 0, x: 0 }, { heading: 1, elevation: 0 }] },
    { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 0 }], extra: true },
    {}, [], false,
  ]) {
    const response = await f.app.inject({ method: 'PUT', url, payload: { guide, revision: 0 } });
    assert.equal(response.statusCode, 400, JSON.stringify({ guide, response: response.json() }));
  }
  for (const field of ['heading', 'elevation']) {
    const point = field === 'heading' ? '{"heading":1e309,"elevation":0}' : '{"heading":1,"elevation":1e309}';
    const response = await f.app.inject({ method: 'PUT', url, headers: { 'content-type': 'application/json' },
      payload: `{"revision":0,"guide":{"kind":"line","points":[{"heading":0,"elevation":0},${point}]}}` });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual((await f.app.inject(url)).json(), { guide: null, revision: 0 });
});

test('全景参考线拒绝退化和超过一周的方位，保留展开方向与弧线控制点', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
  for (const guide of [
    { kind: 'line', points: [{ heading: 1, elevation: 0 }, { heading: 1, elevation: 1 }] },
    { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: 1e-10, elevation: 1 }] },
    { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: 2 * Math.PI + 0.01, elevation: 0 }] },
    { kind: 'quadratic', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 1 }, { heading: 0, elevation: 2 }] },
    { kind: 'quadratic', points: [{ heading: 0, elevation: 0 }, { heading: 7, elevation: 1 }, { heading: 1, elevation: 0 }] },
  ]) {
    const response = await f.app.inject({ method: 'PUT', url, payload: { guide, revision: 0 } });
    assert.equal(response.statusCode, 400, JSON.stringify({ guide, response: response.json() }));
  }
  assert.deepEqual((await f.app.inject(url)).json(), { guide: null, revision: 0 });
  const quadratic = { kind: 'quadratic', points: [
    { heading: 7, elevation: -4 }, { heading: 9, elevation: 12 }, { heading: 8, elevation: 3 },
  ] };
  const curve = await f.app.inject({ method: 'PUT', url, payload: { guide: quadratic, revision: 0 } });
  assert.equal(curve.statusCode, 200, curve.body);
  assert.deepEqual(curve.json(), { guide: quadratic, revision: 1 });
  const fullCircle = { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: -2 * Math.PI, elevation: 0 }] };
  const full = await f.app.inject({ method: 'PUT', url, payload: { guide: fullCircle, revision: 1 } });
  assert.equal(full.statusCode, 200, full.body);
  assert.deepEqual(full.json(), { guide: fullCircle, revision: 2 });
});

test('全景参考线要求明确的形状和可安全递增的整数版本', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
  for (const payload of [
    { guide: null, revision: Number.MAX_SAFE_INTEGER },
    { guide: null, revision: 1e20 },
    { guide: null, revision: -1 },
    { guide: null, revision: 0.5 },
    { guide: null, revision: '0' },
    { guide: null }, { revision: 0 }, { guide: null, revision: 0, ignored: true },
  ]) {
    const response = await f.app.inject({ method: 'PUT', url, payload });
    assert.equal(response.statusCode, 400, JSON.stringify({ payload, response: response.json() }));
  }
  assert.deepEqual((await f.app.inject(url)).json(), { guide: null, revision: 0 });
});

test('全景参考线按任务隔离，删除保留版本，并发旧版本保存返回 409', async (t) => {
  const f = await fixture(t);
  const first = await createAndWait(f);
  const line = { kind: 'line', points: [{ heading: -1, elevation: 0.01 }, { heading: 1, elevation: 0.01 }] };
  const firstUrl = `/api/recognition-tasks/${first.id}/panorama-guide`;
  const saved = await f.app.inject({ method: 'PUT', url: firstUrl, payload: { guide: line, revision: 0 } });
  assert.equal(saved.statusCode, 200, saved.body);
  const second = await createAndWait(f);
  const secondUrl = `/api/recognition-tasks/${second.id}/panorama-guide`;
  assert.deepEqual((await f.app.inject(secondUrl)).json(), { guide: null, revision: 0 });
  const independent = await f.app.inject({ method: 'PUT', url: secondUrl, payload: { guide: line, revision: 0 } });
  assert.equal(independent.statusCode, 200, independent.body);
  const removed = await f.app.inject({ method: 'PUT', url: firstUrl, payload: { guide: null, revision: 1 } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { guide: null, revision: 2 });
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.app.inject(firstUrl)).json(), { guide: null, revision: 2 });
  assert.deepEqual((await f.app.inject(secondUrl)).json(), { guide: line, revision: 1 });
  const stale = await f.app.inject({ method: 'PUT', url: firstUrl, payload: { guide: line, revision: 1 } });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual((await f.app.inject(firstUrl)).json(), { guide: null, revision: 2 });
  const repeated = await f.app.inject({ method: 'PUT', url: firstUrl, payload: { guide: null, revision: 2 } });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.deepEqual(repeated.json(), { guide: null, revision: 3 });
  const attempts = await Promise.all([line, null].map((guide) => f.app.inject({ method: 'PUT', url: firstUrl,
    payload: { guide, revision: 3 } })));
  assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 409]);
  const winner = attempts.find((response) => response.statusCode === 200).json();
  assert.equal(winner.revision, 4);
  assert.deepEqual((await f.app.inject(firstUrl)).json(), winner);
  const missing = await f.app.inject({ method: 'PUT', url: '/api/recognition-tasks/unknown/panorama-guide',
    payload: { guide: line, revision: 0 } });
  assert.equal(missing.statusCode, 404, missing.body);
});

test('识别任务持久化、手动标注和忽略、重新计算、一键应用完整流程', async (t) => {
  const f = await fixture(t);
  let task = await createAndWait(f);
  assert.equal(task.status, 'completed');
  assert.equal(task.completedCount, 6);
  const generated = await post(f, task.id, 'generate', 0);
  assert.equal(generated.statusCode, 200, generated.body);
  task = generated.json();
  assert.equal(task.result.status, 'estimated');
  const shot = f.snapshots[0];
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${shot.id}`,
    payload: { revision: 0, ignored: true } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().task.result, null);
  assert.equal((await post(f, task.id, 'apply', 1)).statusCode, 409);
  assert.equal((await post(f, task.id, 'generate', 0)).statusCode, 409);
  const restored = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${shot.id}`,
    payload: { revision: 1, ignored: false, points: f.observations[0].points.filter((_, index) => index !== 1) } });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().item.source, 'manual');
  await f.app.close();
  f.app = await createApp(f.options);
  const page = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json();
  assert.equal(page.items[0].source, 'manual');
  assert.equal(page.task.revision, 2);
  task = (await post(f, task.id, 'generate', 2)).json();
  assert.equal(task.result.status, 'estimated');
  const applied = await post(f, task.id, 'apply', 2);
  assert.equal(applied.statusCode, 200, applied.body);
  const camera = applied.json().camera;
  for (const [key, value] of Object.entries({ pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 1.1, imageRoll: -0.8 })) {
    assert.ok(Math.abs(camera[key] - value) < 1e-3, key);
  }
  for (const key of ['name', 'serial', 'code', 'longitude', 'latitude', 'height', 'panOffset']) assert.equal(camera[key], f.camera[key]);
  const original = (await f.app.inject(`/api/cameras/${camera.id}/snapshots`)).json();
  assert.deepEqual(original[0].ptz, f.snapshots.at(-1).ptz);
  assert.deepEqual(original[0].calibration, f.snapshots.at(-1).calibration);
  assert.equal((await post(f, task.id, 'apply', 2)).statusCode, 409);
  const previousResultId = applied.json().task.resultId;
  const regenerated = (await post(f, task.id, 'generate', 2)).json();
  assert.notEqual(regenerated.resultId, previousResultId);
  assert.equal(regenerated.appliedRevision, null);
  const staleApply = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${task.id}/apply`,
    payload: { revision: 2, resultId: previousResultId } });
  assert.equal(staleApply.statusCode, 409);
  assert.equal((await post(f, task.id, 'apply', 2)).statusCode, 200);
});

test('网页识别允许 22° 跨零样本生成并应用参数，单张不可辨识结果拒绝应用', async (t) => {
  for (const pans of [[347, 358, 9], [0]]) {
    const f = await fixture(t, undefined, { pans,
      ptzOverrides: { Tilt: 2, Zoom: 8.8, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5 } });
    const task = await createAndWait(f);
    const response = await post(f, task.id, 'generate', 0);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json().result;
    const apply = await post(f, task.id, 'apply', 0);
    if (pans.length === 3) {
      assert.equal(result.status, 'estimated', JSON.stringify(result));
      assert.equal(result.panCoverageDegrees, 22);
      assert.equal(apply.statusCode, 200, apply.body);
      for (const [key, value] of Object.entries({ pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 1.1, imageRoll: -0.8 })) {
        assert.ok(Math.abs(apply.json().camera[key] - value) < 1e-4, key);
      }
    } else {
      assert.equal(result.status, 'unreliable', JSON.stringify(result));
      assert.equal(result.installation, null);
      assert.equal(apply.statusCode, 409);
      assert.deepEqual((await f.app.inject('/api/cameras')).json().find((camera) => camera.id === f.camera.id), f.camera);
    }
  }
});

test('配置变化和源截图删除阻止应用旧结果', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  await post(f, task.id, 'generate', 0);
  await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...f.input, height: f.input.height + 1 } });
  assert.equal((await post(f, task.id, 'apply', 0)).statusCode, 409);
  await post(f, task.id, 'generate', 0);
  await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${f.snapshots[0].id}` });
  assert.equal((await post(f, task.id, 'apply', 0)).statusCode, 409);
  const generated = (await post(f, task.id, 'generate', 0)).json();
  assert.ok(generated.result.excluded.some((item) => item.reason === '源截图已删除'));
});

test('接口拒绝非法点位、跨任务截图和无效源任务', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const update = (snapshotId, points) => f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${snapshotId}`, payload: { revision: 0, points } });
  assert.equal((await update(f.snapshots[0].id, [{ x: 0.1, y: 0.5 }, { x: 0.11, y: 0.5 }])).statusCode, 400);
  assert.equal((await update(f.snapshots[0].id, [{ x: 0.1, y: 2 }, { x: 0.9, y: 0.5 }])).statusCode, 400);
  assert.equal((await update('unknown', [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }])).statusCode, 404);
  const ignored = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${f.snapshots[0].id}`,
    payload: { revision: 0, ignored: true, points: [{ x: 0.1, y: 0.5 }, { x: 0.11, y: 0.5 }] } });
  assert.equal(ignored.statusCode, 200, ignored.body);
  const restore = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${f.snapshots[0].id}`,
    payload: { revision: 1, ignored: false } });
  assert.equal(restore.statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: 'unknown' } })).statusCode, 404);
});

test('服务关闭会中断任务，重启不会重新调用模型', async (t) => {
  let started;
  const ready = new Promise((accept) => { started = accept; });
  const f = await fixture(t, { async run(_images, { signal }) { started(); await new Promise((accept) => signal.addEventListener('abort', accept, { once: true })); signal.throwIfAborted(); } });
  const response = await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: 'source-task' } });
  const id = response.json().id;
  await ready;
  assert.equal((await post(f, id, 'generate', 0)).statusCode, 409);
  await f.app.close();
  f.app = await createApp(f.options);
  const task = (await f.app.inject(`/api/recognition-tasks/${id}`)).json();
  assert.equal(task.status, 'interrupted');
});

test('识别串行排队，取消排队和执行中的任务后队列可继续', async (t) => {
  let calls = 0, notify;
  const started = new Promise((accept) => { notify = accept; });
  const f = await fixture(t, { async run(images, { signal, onResult }) {
    calls++;
    if (calls === 1) {
      notify();
      await new Promise((accept) => signal.addEventListener('abort', accept, { once: true }));
      signal.throwIfAborted();
    }
    for (const image of images) onResult({ snapshotId: image.snapshotId, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] });
  } });
  const create = () => f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: 'source-task' } });
  const first = (await create()).json();
  await started;
  const second = (await create()).json();
  assert.equal((await f.app.inject(`/api/recognition-tasks/${second.id}`)).json().status, 'queued');
  for (const task of [first, second]) {
    const url = `/api/recognition-tasks/${task.id}/panorama-guide`;
    assert.deepEqual((await f.app.inject(url)).json(), { guide: null, revision: 0 });
    for (const guide of [null, { kind: 'line', points: [{ heading: 0, elevation: 0 }, { heading: 1, elevation: 0 }] }]) {
      const blocked = await f.app.inject({ method: 'PUT', url, payload: { guide, revision: 0 } });
      assert.equal(blocked.statusCode, 409, blocked.body);
    }
    assert.deepEqual((await f.app.inject(url)).json(), { guide: null, revision: 0 });
  }
  const cancel = (id) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${id}/cancel`, payload: {} });
  assert.equal((await cancel(second.id)).json().status, 'cancelled');
  assert.equal((await cancel(first.id)).json().status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal((await createAndWait(f)).status, 'completed');
  assert.equal(calls, 2);
});
