import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CameraStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { fixtureCamera, syntheticSnapshots } from './calibration-fixtures.mjs';

async function fixture(t, { noise = true, highTransform = (snapshot) => snapshot, seed = () => {}, groupPans = {}, ptzFor = () => ({}) } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-refinement-test-'));
  const store = new CameraStore(dataDir);
  const input = Object.fromEntries(['name', 'serial', 'code', 'longitude', 'latitude', 'height',
    'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'].map((key) => [key, fixtureCamera[key]]));
  const camera = store.saveCamera(input);
  const actual = { ...camera, tiltOffset: 1.1, imageRoll: -0.8 };
  const groups = new Map(), observations = new Map();
  for (const [name, defaultPans] of [['base', [0, 60, 120, 180, 240, 300]],
    ['main', [173, 9, 291, 38, 212]], ['extra', [338, 111, 69]]]) {
    const pans = groupPans[name] || defaultPans;
    const snapshots = pans.map((pan, index) => {
      const high = name !== 'base';
      const generated = syntheticSnapshots({ camera: actual, pans: [pan], ptzOverrides: {
        Tilt: high ? 0.3 + index * 0.13 : 2 + index * 0.1, Zoom: high ? 12 + index * 1.3 : 3,
        HorizontalFieldAngle: high ? 11 - index * 0.4 : 24, VerticalFieldAngle: high ? 8 - index * 0.25 : 13.5,
        ...ptzFor(name, index, pan),
      } });
      const original = generated.snapshots[0], id = `${name}-${index}`;
      const snapshot = { ...original, id, groupId: name, scanIndex: index,
        width: index % 2 ? 1920 : 960, height: index % 2 ? 1080 : 540,
        fileName: `${id}.jpg`, imageUrl: `/api/snapshots/${id}/image` };
      const points = generated.observations[0].points.filter((_, column) => column !== 1)
        .map((point, column) => ({ ...point, y: point.y + (!high && noise ? (1 + column * 0.3) / snapshot.height : 0) }));
      observations.set(id, points);
      return high ? highTransform(snapshot, name, index) : snapshot;
    });
    store.addSnapshotGroup({ id: name, cameraId: camera.id, cameraName: camera.name, kind: 'scan', status: 'completed',
      createdAt: snapshots[0].createdAt, sampleCount: snapshots.length, completedCount: snapshots.length });
    snapshots.forEach((snapshot) => store.addSnapshot(snapshot));
    groups.set(name, snapshots);
  }
  seed(store, camera, groups);
  store.close();
  const options = { dataDir, webDir: join(dataDir, 'missing-web'), livegbs: { configured: false }, recognizer: {
    async run(images, { onResult }) { for (const image of images) onResult({ snapshotId: image.snapshotId, points: observations.get(image.snapshotId) }); },
  } };
  const f = { app: await createApp(options), options, dataDir, camera, input, groups, observations };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-refinement-test-')) throw new Error('临时路径无效');
    await rm(target, { recursive: true, force: true });
  });
  f.task = async (name) => {
    const response = await f.app.inject({ method: 'POST', url: '/api/recognition-tasks', payload: { sourceTaskId: name } });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().id;
    for (let iteration = 0; iteration < 100; iteration++) {
      await new Promise((accept) => setTimeout(accept, 10));
      const task = (await f.app.inject(`/api/recognition-tasks/${id}`)).json();
      if (!['queued', 'running'].includes(task.status)) return task;
    }
    throw new Error('识别未结束');
  };
  f.get = async (id) => (await f.app.inject(`/api/recognition-tasks/${id}`)).json();
  f.post = (task, action, payload = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${task.id}/${action}`,
    payload: { revision: task.revision, ...payload } });
  f.select = (task, base, supplemental = [], selectionRevision = task.refinementSelection?.revision || 0) => f.app.inject({
    method: 'PUT', url: `/api/recognition-tasks/${task.id}/refinement-sources`, payload: { revision: task.revision, selectionRevision,
      base: base ? { taskId: base.id, revision: base.revision, resultId: base.resultId } : null,
      supplemental: supplemental.map((entry) => ({ taskId: entry.id, revision: entry.revision })) },
  });
  f.base = (await f.post(await f.task('base'), 'generate')).json();
  assert.equal(f.base.result?.status, 'estimated', JSON.stringify(f.base));
  f.main = await f.task('main');
  f.extra = await f.task('extra');
  return f;
}

test('联合精修来源独立持久化，重启恢复并拒绝旧选择版本', async (t) => {
  const f = await fixture(t);
  const saved = await f.select(f.main, f.base, [f.extra]);
  assert.equal(saved.statusCode, 200, saved.body);
  const selection = saved.json().refinementSelection;
  assert.equal(selection.revision, 1);
  assert.deepEqual(selection.base, { taskId: f.base.id, revision: 0, resultId: f.base.resultId });
  assert.deepEqual(selection.supplemental, [{ taskId: f.extra.id, revision: 0 }]);
  assert.equal(saved.json().result, null);
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.get(f.main.id)).refinementSelection, selection);
  assert.equal((await f.select(f.main, f.base, [])).statusCode, 409);
});

test('联合基础与多批随机高倍图生成独立候选和同批观测前后对照，不修改采样与设备', async (t) => {
  const f = await fixture(t);
  const before = (await f.app.inject('/api/cameras')).json();
  const baseBefore = await f.get(f.base.id);
  const itemsBefore = (await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items;
  const selected = await f.select(f.main, f.base, [f.extra]);
  assert.equal(selected.statusCode, 200, selected.body);
  const response = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const task = response.json(), result = task.refinement;
  assert.equal(result.status, 'estimated', result.message);
  assert.equal(result.model, 'wgs84-horizon-refinement-v1');
  assert.ok(result.resultId);
  assert.equal(result.stale, false);
  assert.deepEqual(result.baseCamera, { ...f.base.fitCamera, ...f.base.result.installation });
  assert.deepEqual(result.generatedCamera, f.camera);
  assert.equal(result.before.base.sampleCount, 6);
  assert.equal(result.before.high.sampleCount, 8);
  assert.equal(result.after.overall.sampleCount, 14);
  assert.ok(result.after.objective < result.before.objective);
  assert.ok(result.after.high.rmsResidualPixels < result.before.high.rmsResidualPixels);
  assert.ok(result.after.base.rmsResidualPixels <= 5);
  assert.ok(result.after.high.rmsResidualPixels <= 5);
  assert.deepEqual([...result.sourceSnapshotIds].sort(), [...f.groups.values()].flat().map((shot) => shot.id).sort());
  for (const key of ['pAxisPitch', 'pAxisRoll', 'tiltOffset', 'imageRoll']) {
    const truth = { pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 1.1, imageRoll: -0.8 }[key];
    assert.ok(Math.abs(result.installation[key] - truth) < 0.04, key);
  }
  assert.deepEqual(result.before.perSnapshot.map((row) => row.snapshotId), result.after.perSnapshot.map((row) => row.snapshotId));
  assert.ok(result.after.perSnapshot.every((row) => row.verticalResiduals.length === 3 && row.theoreticalHorizon.length > 0
    && row.timeAlignment === 'unverified' && Number.isFinite(row.directionDifferenceDegrees)));
  assert.equal(task.result, null);
  assert.deepEqual(await f.get(f.base.id), baseBefore);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), before);
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items, itemsBefore);
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.get(f.main.id)).refinement, result);
});

test('精修来源冲突拒绝旧基础编号、旧标注版本、重复任务及经另一识别任务复用的图片', async (t) => {
  const f = await fixture(t);
  const duplicate = await f.task('main');
  const attempts = [
    () => f.select(f.main, { ...f.base, resultId: 'old-result' }),
    () => f.select(f.main, { ...f.base, revision: 1 }),
    () => f.select(f.main, f.base, [f.main]),
    () => f.select(f.main, f.base, [duplicate]),
    () => f.select(f.main, f.base, [{ ...f.extra, revision: 1 }]),
  ];
  for (const attempt of attempts) {
    const response = await attempt();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await f.get(f.main.id)).refinementSelection, undefined);
  }
});

test('改变持久来源选择立即使旧候选过期，列表、条目和重启不会恢复旧候选', async (t) => {
  const f = await fixture(t);
  const selected = (await f.select(f.main, f.base, [f.extra])).json();
  const generated = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  assert.equal(generated.refinement.status, 'estimated', generated.refinement.message);
  const changed = await f.select(selected, f.base, []);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().refinement.stale, true);
  assert.match(changed.json().refinement.staleReasons.join('；'), /来源选择/);
  await f.app.close();
  f.app = await createApp(f.options);
  for (const task of [await f.get(f.main.id),
    (await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().task,
    (await f.app.inject('/api/recognition-tasks')).json().tasks.find((entry) => entry.id === f.main.id)]) {
    assert.equal(task.refinement.stale, true);
    assert.equal(task.refinement.resultId, generated.refinement.resultId);
  }
  const replacement = (await f.post(f.main, 'refine', { selectionRevision: 2 })).json();
  assert.equal(replacement.refinement.stale, false);
  assert.notEqual(replacement.refinement.resultId, generated.refinement.resultId);
  assert.equal((await f.post(f.main, 'refine', { selectionRevision: 1 })).statusCode, 409);
});

test('实时核对所有来源标注、基础重新生成、参与图和固定条件，四项当前修正不改变基础初值', async (t) => {
  const f = await fixture(t);
  let main = f.main, base = f.base, extra = f.extra, selectionRevision = 0;
  const generate = async () => {
    const saved = await f.select(main, base, [extra], selectionRevision);
    assert.equal(saved.statusCode, 200, saved.body);
    selectionRevision++;
    const response = await f.post(main, 'refine', { selectionRevision });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().refinement;
  };
  await generate();
  for (const role of ['main', 'extra', 'base']) {
    const source = { main, base, extra }[role];
    const item = (await f.app.inject(`/api/recognition-tasks/${source.id}/items`)).json().items[0];
    const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${source.id}/items/${item.snapshotId}`,
      payload: { revision: source.revision, ignored: true } });
    assert.equal(edited.statusCode, 200, edited.body);
    const stale = (await f.get(main.id)).refinement;
    assert.equal(stale.stale, true, role);
    assert.match(stale.staleReasons.join('；'), /标注/);
    if (role === 'main') main = edited.json().task;
    if (role === 'extra') extra = edited.json().task;
    if (role === 'base') base = (await f.post(edited.json().task, 'generate')).json();
    assert.equal((await generate()).stale, false);
  }
  base = (await f.post(base, 'generate')).json();
  assert.equal((await f.get(main.id)).refinement.stale, true);
  assert.match((await f.get(main.id)).refinement.staleReasons.join('；'), /基础.*结果/);
  const cameraUpdate = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`,
    payload: { ...f.input, pAxisPitch: 8, pAxisRoll: 4, tiltOffset: 3, imageRoll: 2 } });
  assert.equal(cameraUpdate.statusCode, 200, cameraUpdate.body);
  const generated = await generate();
  assert.deepEqual(generated.before.installation, base.result.installation);
  assert.deepEqual(generated.generatedCamera, cameraUpdate.json());
  assert.equal(generated.stale, false);
  const badConfiguration = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`,
    payload: { ...f.input, height: f.camera.height + 1 } });
  assert.equal(badConfiguration.statusCode, 200, badConfiguration.body);
  assert.equal((await f.get(main.id)).refinement.stale, true);
  assert.equal((await f.post(main, 'refine', { selectionRevision })).statusCode, 409);
  assert.equal((await f.get(main.id)).refinement.resultId, generated.resultId);
  await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: f.input });
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${generated.sourceSnapshotIds[0]}` })).statusCode, 204);
  const deleted = (await f.get(main.id)).refinement;
  assert.equal(deleted.stale, true);
  assert.match(deleted.staleReasons.join('；'), /截图.*删除/);
});

test('精修只接受同摄像头的正式基础结果', async (t) => {
  for (const options of [
    { seed: (store) => store.updateSnapshotGroup('base', { horizon: { phase: 'coarse' } }) },
    { seed: (store, camera) => {
      const other = store.saveCamera({ ...camera, id: undefined, code: 'other' });
      store.updateSnapshotGroup('extra', { cameraId: other.id });
    } },
  ]) {
    const f = await fixture(t, options);
    const response = await f.select(f.main, f.base, [f.extra]);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await f.get(f.main.id)).refinementSelection, undefined);
  }
});

test('历史采样参数保留旧配置，精修显式采用所选基础而不混入旧副本', async (t) => {
  const f = await fixture(t, { highTransform: (shot) => ({ ...shot,
    calibration: { ...shot.calibration, height: shot.calibration.height + 10, panOffset: shot.calibration.panOffset + 5 } }) });
  const itemsBefore = (await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items;
  const saved = await f.select(f.main, f.base, [f.extra]);
  assert.equal(saved.statusCode, 200, saved.body);
  const response = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().refinement;
  assert.equal(result.status, 'estimated', result.message);
  assert.equal(result.baseCamera.height, f.base.fitCamera.height);
  assert.equal(result.baseCamera.panOffset, f.base.fitCamera.panOffset);
  assert.ok(result.after.high.rmsResidualPixels < 1);
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items, itemsBefore);
});

test('同一批高倍图片改变顺序与任务拆分不改变两组等权的联合目标和候选', async (t) => {
  const f = await fixture(t);
  await f.select(f.main, f.base, [f.extra]);
  const original = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json().refinement;
  const items = [
    ...(await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items,
    ...(await f.app.inject(`/api/recognition-tasks/${f.extra.id}/items`)).json().items,
  ].reverse();
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  store.addRecognitionTask({ ...f.main, id: 'reordered-main', sampleCount: 2 }, items.slice(0, 2));
  store.addRecognitionTask({ ...f.extra, id: 'reordered-extra', sampleCount: 6 }, items.slice(2));
  store.close();
  f.app = await createApp(f.options);
  const main = await f.get('reordered-main'), extra = await f.get('reordered-extra');
  await f.select(main, f.base, [extra]);
  const response = await f.post(main, 'refine', { selectionRevision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const changed = response.json().refinement;
  assert.equal(changed.status, 'estimated', changed.message);
  assert.ok(changed.after.perSnapshot.every((row) => typeof row.taskId === 'string'));
  for (const key of ['pAxisPitch', 'pAxisRoll', 'tiltOffset', 'imageRoll']) {
    assert.ok(Math.abs(changed.installation[key] - original.installation[key]) < 1e-6, key);
  }
  assert.ok(Math.abs(changed.before.objective - original.before.objective) < 1e-10);
  assert.ok(Math.abs(changed.after.objective - original.after.objective) < 1e-10);
  assert.ok(Math.abs(changed.after.base.rmsResidualPixels - original.after.base.rmsResidualPixels) < 1e-6);
  assert.ok(Math.abs(changed.after.high.rmsResidualPixels - original.after.high.rmsResidualPixels) < 1e-6);
});

test('基准已应用仍可精修，精确观测在终止精度内返回无需修正并保留普通结果', async (t) => {
  const f = await fixture(t, { noise: false });
  const applied = await f.post(f.base, 'apply', { resultId: f.base.resultId });
  assert.equal(applied.statusCode, 200, applied.body);
  f.base = applied.json().task;
  const ordinary = (await f.post(f.main, 'generate')).json();
  const selected = await f.select(ordinary, f.base, [f.extra]);
  assert.equal(selected.statusCode, 200, selected.body);
  const generated = await f.post(ordinary, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const task = generated.json();
  assert.equal(task.refinement.status, 'no_change', task.refinement.message);
  assert.deepEqual(task.refinement.installation, f.base.result.installation);
  assert.deepEqual(task.refinement.before, task.refinement.after);
  assert.deepEqual(task.refinement.generatedCamera, applied.json().camera);
  assert.deepEqual(task.result, ordinary.result);
  assert.equal(task.resultId, ordinary.resultId);
  assert.equal(task.refinement.stale, false);
});

test('参与图原图测量在正式标注保存后重算基准，旧候选对照被拒绝且不借用独立复核', async (t) => {
  const f = await fixture(t);
  await f.select(f.main, f.base, [f.extra]);
  const measure = (task, mode, resultId) => f.post(task, 'refinement-measure', { selectionRevision: 1, mode, ...(resultId ? { resultId } : {}) });
  const original = await measure(f.main, 'before');
  assert.equal(original.statusCode, 200, original.body);
  assert.equal((await f.get(f.main.id)).refinement, undefined);
  const generated = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json().refinement;
  const candidate = await measure(f.main, 'after', generated.resultId);
  assert.equal(candidate.statusCode, 200, candidate.body);
  assert.deepEqual(candidate.json().perSnapshot.map((row) => row.rmsResidualPixels), generated.after.perSnapshot.map((row) => row.rmsResidualPixels));
  const item = (await f.app.inject(`/api/recognition-tasks/${f.main.id}/items`)).json().items[0];
  const points = item.points.map((point) => ({ ...point, y: point.y + 1 / item.snapshot.height }));
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.main.id}/items/${item.snapshotId}`,
    payload: { revision: 0, points } });
  const task = edited.json().task;
  assert.equal((await measure(task, 'after', generated.resultId)).statusCode, 409);
  const fresh = await measure(task, 'before');
  assert.equal(fresh.statusCode, 200, fresh.body);
  const before = original.json().perSnapshot.find((row) => row.snapshotId === item.snapshotId);
  const after = fresh.json().perSnapshot.find((row) => row.snapshotId === item.snapshotId);
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(after.verticalResiduals[index].offsetPixels - before.verticalResiduals[index].offsetPixels - 1) < 1e-6);
  assert.deepEqual((await f.get(f.main.id)).refinement.resultId, generated.resultId);
});

test('高倍组过滤无效姿态、FOV、尺寸、忽略和缺图后再计权，基础只使用原拟合参与图', async (t) => {
  const f = await fixture(t, { highTransform: (shot) => {
    if (shot.id === 'main-0') return { ...shot, poseChanged: true };
    if (shot.id === 'main-1') return { ...shot, ptz: { ...shot.ptz, raw: { ...shot.ptz.raw, HorizontalFieldAngle: 0 } } };
    if (shot.id === 'extra-0') return { ...shot, width: 0 };
    return shot;
  } });
  const edit = async (task, snapshotId) => {
    const response = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${snapshotId}`,
      payload: { revision: task.revision, ignored: true } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().task;
  };
  const main = await edit(f.main, 'main-2');
  const base = (await f.post(await edit(f.base, 'base-0'), 'generate')).json();
  await f.app.inject({ method: 'DELETE', url: '/api/snapshots/extra-1' });
  await f.select(main, base, [f.extra]);
  const generated = await f.post(main, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const result = generated.json().refinement;
  assert.equal(result.before.base.sampleCount, 5);
  assert.equal(result.before.high.sampleCount, 3);
  assert.equal(result.sourceSnapshotIds.includes('base-0'), false);
  for (const id of ['main-0', 'main-1', 'main-2', 'extra-0', 'extra-1']) {
    assert.ok(result.excluded.some((row) => row.snapshotId === id && row.reason));
    assert.equal(result.sourceSnapshotIds.includes(id), false);
  }
  assert.equal(result.sources.find((source) => source.role === 'base').inputSnapshotIds.includes('base-0'), false);
  assert.ok(Math.abs(result.before.objective - (result.before.base.rmsResidualPixels ** 2 + result.before.high.rmsResidualPixels ** 2) / 4) < 1e-8);
});

test('有效高倍组为空或只有低倍率时返回明确原因，过滤掉的高倍率不能满足参与条件', async (t) => {
  for (const highTransform of [(shot) => ({ ...shot, poseChanged: true }),
    (shot) => ({ ...shot, poseChanged: shot.id === 'main-0', ptz: { ...shot.ptz,
      raw: { ...shot.ptz.raw, Zoom: shot.id === 'main-0' ? 30 : 2 } } }),
  ]) {
    const f = await fixture(t, { highTransform });
    await f.select(f.main, f.base, [f.extra]);
    const response = await f.post(f.main, 'refine', { selectionRevision: 1 });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json().refinement;
    assert.equal(result.status, 'insufficient_data', result.message);
    assert.equal(result.installation, null);
    assert.ok(result.diagnostics.failures.length > 0);
    assert.ok(result.before.base.sampleCount > 0);
  }
});

test('总体低误差不能掩盖高倍组超差，固定模型保留相反方向的真实残差', async (t) => {
  const f = await fixture(t);
  let main = f.main, extra = f.extra;
  for (const name of ['main', 'extra']) {
    let task = name === 'main' ? main : extra;
    const items = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json().items;
    for (const [index, item] of items.entries()) {
      const sign = index % 2 ? -1 : 1;
      const response = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/${item.snapshotId}`,
        payload: { revision: task.revision, points: item.points.map((point) => ({ ...point, y: point.y + sign * 6.9 / item.snapshot.height })) } });
      assert.equal(response.statusCode, 200, response.body);
      task = response.json().task;
    }
    if (name === 'main') main = task; else extra = task;
  }
  await f.select(main, f.base, [extra]);
  const response = await f.post(main, 'refine', { selectionRevision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().refinement;
  assert.equal(result.status, 'unreliable', result.message);
  assert.equal(result.installation, null);
  assert.ok(result.after.overall.rmsResidualPixels <= 5, String(result.after.overall.rmsResidualPixels));
  assert.ok(result.after.high.rmsResidualPixels > 5);
  assert.match(result.message, /高倍组 RMS/);
  assert.ok(result.after.perSnapshot.some((row) => row.verticalOffsetPixels > 0));
  assert.ok(result.after.perSnapshot.some((row) => row.verticalOffsetPixels < 0));
});

test('高倍观测集中且量级悬殊时保留四参数不可辨识诊断，不用阻尼制造合格候选', async (t) => {
  const actual = { ...fixtureCamera, tiltOffset: 1.1, imageRoll: -0.8 };
  let low = 0, high = 5;
  // 仍通过独立椭球射线夹具寻找海天线居中的实际 T，窄视场观测重新生成。
  for (let iteration = 0; iteration < 40; iteration++) {
    const tilt = (low + high) / 2;
    const generated = syntheticSnapshots({ camera: actual, pans: [0], ptzOverrides: { Tilt: tilt, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5 } });
    if (generated.observations[0].points[1].y > 0.5) low = tilt; else high = tilt;
  }
  const f = await fixture(t, { groupPans: { main: [0, 0], extra: [0] }, ptzFor: (name) => name === 'base' ? {} : {
    Tilt: (low + high) / 2, Zoom: 30, HorizontalFieldAngle: 0.001, VerticalFieldAngle: 0.0005,
  } });
  await f.select(f.main, f.base, [f.extra]);
  const response = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().refinement;
  assert.equal(result.status, 'unreliable', result.message);
  assert.equal(result.installation, null);
  assert.match(result.message, /不可可靠辨识/);
  assert.ok(result.diagnostics.conditionNumber === null || result.diagnostics.conditionNumber >= 1e8);
  assert.equal(result.after.high.sampleCount, 3);
});

test('来源去重检查全部引用，基础未参与图也不能通过补充任务重复引用', async (t) => {
  const f = await fixture(t);
  const edit = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.base.id}/items/base-0`,
    payload: { revision: 0, ignored: true } });
  const base = (await f.post(edit.json().task, 'generate')).json();
  assert.equal(base.result.sourceSnapshotIds.includes('base-0'), false);
  const item = (await f.app.inject(`/api/recognition-tasks/${base.id}/items`)).json().items.find((entry) => entry.snapshotId === 'base-0');
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  store.addRecognitionTask({ ...f.extra, id: 'duplicate-unused', sampleCount: 1 }, [{ ...item, ignored: false }]);
  store.close();
  f.app = await createApp(f.options);
  const response = await f.select(f.main, base, [await f.get('duplicate-unused')]);
  assert.equal(response.statusCode, 409, response.body);
});
