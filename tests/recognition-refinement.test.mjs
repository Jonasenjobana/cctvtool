import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CameraStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { fixtureCamera, syntheticSnapshots } from './calibration-fixtures.mjs';

const zeroPoseModel = 'wgs84-horizon-zero-pose-v1';
const actualZeroPose = { roll: -1.75, pitch: 2.1, yaw: 133.7, tiltOffset: 1.2 };

async function fixture(t, { noise = true, highTransform = (snapshot) => snapshot, seed = () => {}, groupPans = {}, ptzFor = () => ({}),
  livegbs = { configured: false }, includeValidation = false, zeroPose, savedZeroPose = zeroPose && { ...zeroPose, roll: 0, pitch: 0 },
  writeImages = !!zeroPose } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-refinement-test-'));
  const store = new CameraStore(dataDir);
  const input = Object.fromEntries(['name', 'serial', 'code', 'longitude', 'latitude', 'height',
    'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'].map((key) => [key, fixtureCamera[key]]));
  if (savedZeroPose) input.zeroPose = savedZeroPose;
  const camera = store.saveCamera(input);
  const actual = { ...camera, tiltOffset: 1.1, imageRoll: -0.8 };
  const groups = new Map(), observations = new Map();
  for (const [name, defaultPans] of [['base', zeroPose ? [355, 20, 100, 190, 255, 305] : [0, 60, 120, 180, 240, 300]],
    ['main', [173, 9, 291, 38, 212]], ['extra', [338, 111, 69]],
    ...(includeValidation || groupPans.validation ? [['validation', [17, 143, 267, 313]]] : [])]) {
    const pans = groupPans[name] || defaultPans;
    const snapshots = pans.map((pan, index) => {
      const high = name !== 'base';
      const generated = syntheticSnapshots({ camera: actual, zeroPose, pans: [pan], ptzOverrides: {
        Tilt: high ? 0.3 + index * 0.13 : 2 + index * 0.1, Zoom: high ? 12 + index * 1.3 : 3,
        HorizontalFieldAngle: high ? 11 - index * 0.4 : 24, VerticalFieldAngle: high ? 8 - index * 0.25 : 13.5,
        ...ptzFor(name, index, pan),
      } });
      const original = generated.snapshots[0], id = `${name}-${index}`;
      const snapshot = { ...original, id, groupId: name, scanIndex: index,
        width: index % 2 ? 1920 : 960, height: index % 2 ? 1080 : 540,
        fileName: `${id}.jpg`, imageUrl: `/api/snapshots/${id}/image`, contentType: 'image/jpeg' };
      const points = generated.observations[0].points.filter((_, column) => column !== 1)
        .map((point, column) => ({ ...point, y: point.y + (!high && noise ? (1 + column * 0.3) / snapshot.height : 0) }));
      observations.set(id, points);
      return high ? highTransform(snapshot, name, index) : snapshot;
    });
    store.addSnapshotGroup({ id: name, cameraId: camera.id, cameraName: camera.name, kind: 'scan', status: 'completed',
      createdAt: snapshots[0].createdAt, sampleCount: snapshots.length, completedCount: snapshots.length });
    snapshots.forEach((snapshot) => store.addSnapshot(snapshot));
    if (writeImages) await Promise.all(snapshots.map((snapshot) => writeFile(join(dataDir, 'snapshots', snapshot.fileName), snapshot.id)));
    groups.set(name, snapshots);
  }
  seed(store, camera, groups);
  store.close();
  const options = { dataDir, webDir: join(dataDir, 'missing-web'), livegbs, recognizer: {
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
      base: base ? { taskId: base.id, revision: base.revision, resultId: base.resultId, ...(base.baseModel ? { model: base.baseModel } : {}) } : null,
      supplemental: supplemental.map((entry) => ({ taskId: entry.id, revision: entry.revision })) },
  });
  f.base = (await f.post(await f.task('base'), 'generate')).json();
  assert.equal(f.base.result?.status, 'estimated', JSON.stringify(f.base));
  f.main = await f.task('main');
  f.extra = await f.task('extra');
  return f;
}

test('联合精修使用同一批低倍与多来源高倍原图求解零位姿态，保留固定参数和已有标定', async (t) => {
  const f = await fixture(t, { zeroPose: actualZeroPose });
  const base = (await f.post(f.base, 'generate', { model: zeroPoseModel })).json();
  assert.equal(base.zeroPoseCandidate?.status, 'estimated', JSON.stringify(base.zeroPoseCandidate));
  const selection = { ...base, baseModel: zeroPoseModel, resultId: base.zeroPoseCandidate.resultId };
  const saved = await f.select(f.main, selection, [f.extra]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().refinementSelection.base.model, zeroPoseModel);
  const generated = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const main = generated.json(), candidate = main.refinement;
  assert.equal(candidate.model, zeroPoseModel);
  assert.equal(candidate.status, 'estimated', candidate.message);
  assert.equal(candidate.stale, false, candidate.staleReasons.join('，'));
  assert.deepEqual(candidate.generatedCamera, f.camera);
  assert.deepEqual(candidate.baseCamera.zeroPose, base.zeroPoseCandidate.zeroPose);
  assert.deepEqual(candidate.before.zeroPose, base.zeroPoseCandidate.zeroPose);
  assert.equal(candidate.zeroPose.yaw, actualZeroPose.yaw);
  assert.equal(candidate.zeroPose.tiltOffset, actualZeroPose.tiltOffset);
  assert.ok(Math.abs(candidate.zeroPose.roll - actualZeroPose.roll) < 0.08);
  assert.ok(Math.abs(candidate.zeroPose.pitch - actualZeroPose.pitch) < 0.08);
  assert.equal(candidate.before.base.sampleCount, 6);
  assert.equal(candidate.before.high.sampleCount, 8);
  assert.ok(candidate.before.high.rmsResidualPixels > candidate.after.high.rmsResidualPixels);
  assert.ok(candidate.before.objective > candidate.after.objective);
  assert.deepEqual(candidate.sources[0], { role: 'base', taskId: base.id, revision: base.revision,
    model: zeroPoseModel, resultId: base.zeroPoseCandidate.resultId, inputSnapshotIds: base.zeroPoseCandidate.sourceSnapshotIds,
    sourceSnapshotIds: base.zeroPoseCandidate.sourceSnapshotIds });
  assert.deepEqual(candidate.sources.map((source) => source.sourceSnapshotIds.length), [6, 5, 3]);
  assert.ok(Math.abs(candidate.after.overall.rmsResidualPixels - Math.hypot(
    candidate.after.base.rmsResidualPixels, candidate.after.high.rmsResidualPixels,
  ) / Math.sqrt(2)) < 1e-9);

  for (const mode of ['before', 'after']) {
    const measured = await f.post(main, 'refinement-measure', { mode, selectionRevision: 1, resultId: candidate.resultId });
    assert.equal(measured.statusCode, 200, measured.body);
    assert.equal(measured.json().model, zeroPoseModel);
    assert.equal(measured.json().resultId, candidate.resultId);
    assert.deepEqual(measured.json().perSnapshot, candidate[mode].perSnapshot);
    assert.ok(measured.json().perSnapshot.every((row) => row.theoreticalHorizon.length && row.verticalResiduals.length === 3));
  }
  const original = await f.app.inject('/api/snapshots/extra-1/image');
  assert.equal(original.statusCode, 200, original.body);
  assert.equal(original.body, 'extra-1');
  const high = candidate.after.perSnapshot.find((row) => row.snapshotId === 'extra-1');
  assert.equal(high.taskId, f.extra.id);
  assert.equal(high.group, 'high');
  assert.equal(high.horizontalFieldAngle, 10.6);
  assert.equal(high.width, 1920);
  assert.equal(high.height, 1080);
  for (const residual of high.verticalResiduals) {
    assert.equal(residual.offsetPixels, (residual.observedY - residual.theoreticalY) * 1080);
  }
  assert.deepEqual(await f.get(base.id), base);
  assert.deepEqual(await f.get(f.extra.id), f.extra);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), [f.camera]);
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.get(main.id)).refinement, candidate);
});

test('历史安装结果转为零位姿态参与高倍联合精修，冻结原有基准和来源版本', async (t) => {
  const f = await fixture(t, { writeImages: true, includeValidation: true });
  const saved = await f.select(f.main, f.base, [f.extra]);
  assert.equal(saved.statusCode, 200, saved.body);
  const selectionRevision = saved.json().refinementSelection.revision;
  const baseline = await f.post(f.main, 'refinement-measure', { mode: 'before', selectionRevision });
  assert.equal(baseline.statusCode, 200, baseline.body);
  const generated = await f.post(f.main, 'refine', { model: zeroPoseModel, selectionRevision });
  assert.equal(generated.statusCode, 200, generated.body);
  const task = generated.json(), candidate = task.refinement;
  assert.equal(candidate.model, zeroPoseModel);
  assert.equal(candidate.status, 'estimated', candidate.message);
  assert.equal(candidate.stale, false, candidate.staleReasons.join('，'));
  assert.equal(candidate.sources[0].resultId, f.base.resultId);
  assert.equal(candidate.before.zeroPose.tiltOffset, f.base.result.installation.tiltOffset);
  assert.equal(candidate.before.zeroPose.imageRoll, f.base.result.installation.imageRoll);
  assert.equal(candidate.zeroPose.yaw, candidate.before.zeroPose.yaw);
  assert.deepEqual(candidate.sources.map((source) => source.sourceSnapshotIds.length), [6, 5, 3]);
  const before = await f.post(task, 'refinement-measure', { mode: 'before', selectionRevision, resultId: candidate.resultId });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().model, zeroPoseModel);
  assert.deepEqual(before.json().perSnapshot, candidate.before.perSnapshot);
  for (const row of before.json().perSnapshot) {
    const legacy = baseline.json().perSnapshot.find((entry) => entry.snapshotId === row.snapshotId);
    assert.ok(Math.abs(legacy.verticalOffsetPixels - row.verticalOffsetPixels) < 1e-8, row.snapshotId);
  }
  assert.deepEqual(await f.get(f.base.id), f.base);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), [f.camera]);
  const validation = await f.task('validation');
  const reviewed = await f.post(validation, 'validate', {
    referenceKind: 'zero-pose-refinement', referenceTaskId: task.id, referenceResultId: candidate.resultId,
    criteria: { minimumHighZoom: 10, maximumVerticalOffsetPixels: 5, maximumDirectionDifferenceDegrees: 0.5, maximumRmsPixels: 5 },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().status, 'passed', reviewed.body);
  const regenerated = await f.post(f.base, 'generate');
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  assert.equal((await f.get(task.id)).refinement.stale, true);
  const rejected = await f.post(task, 'refinement-measure', { mode: 'before', selectionRevision, resultId: candidate.resultId });
  assert.equal(rejected.statusCode, 409, rejected.body);
});

test('零位精修拒绝混用模型、旧版本和重复图片，来源更新和相机草稿修改使候选过期', async (t) => {
  const f = await fixture(t, { zeroPose: actualZeroPose });
  const base = (await f.post(f.base, 'generate', { model: zeroPoseModel })).json();
  const selection = { ...base, baseModel: zeroPoseModel, resultId: base.zeroPoseCandidate.resultId };
  const duplicate = await f.task('extra');
  for (const [request, message] of [
    [() => f.select(f.main, { ...base, baseModel: zeroPoseModel }, [f.extra]), /零位候选编号/],
    [() => f.select(f.main, { ...selection, baseModel: undefined }, [f.extra]), /基础标定来源/],
    [() => f.select(f.main, { ...selection, revision: selection.revision + 1 }, [f.extra]), /标注版本/],
    [() => f.select(f.main, selection, [{ ...f.extra, revision: f.extra.revision + 1 }]), /标注版本/],
    [() => f.select(f.main, selection, [f.extra, duplicate]), /重复截图/],
  ]) {
    const response = await request();
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, message);
    assert.equal((await f.get(f.main.id)).refinementSelection, undefined);
  }
  assert.equal((await f.select(f.main, selection, [f.extra])).statusCode, 200);
  const generated = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const main = generated.json(), resultId = main.refinement.resultId;
  const oldPreview = (mode) => f.post(main, 'refinement-measure', { mode, selectionRevision: 1, resultId });
  assert.equal((await f.post(main, 'refinement-measure', { mode: 'before', selectionRevision: 1, resultId: 'old' })).statusCode, 409);

  const modified = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.extra.id}/items/extra-0`,
    payload: { revision: f.extra.revision, ignored: true } });
  assert.equal(modified.statusCode, 200, modified.body);
  assert.match((await f.get(main.id)).refinement.staleReasons.join('，'), /正式标注版本/);
  assert.equal((await oldPreview('after')).statusCode, 409);

  const newBase = (await f.post(base, 'generate', { model: zeroPoseModel })).json();
  assert.match((await f.get(main.id)).refinement.staleReasons.join('，'), /基础零位候选/);
  assert.equal((await oldPreview('before')).statusCode, 409);
  const saved = await f.select(main, { ...selection, resultId: newBase.zeroPoseCandidate.resultId }, [modified.json().task]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(saved.json().refinement.stale);
  assert.equal(saved.json().refinement.resultId, resultId);
  const replacement = await f.post(main, 'refine', { selectionRevision: 2 });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal(replacement.json().refinement.stale, false);
  assert.notEqual(replacement.json().refinement.resultId, resultId);

  const camera = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: {
    ...f.input, zeroPose: { ...f.camera.zeroPose, yaw: f.camera.zeroPose.yaw + 1 },
  } });
  assert.equal(camera.statusCode, 200, camera.body);
  const reopened = await f.get(main.id);
  assert.match(reopened.refinement.staleReasons.join('，'), /相机配置版本/);
  assert.equal((await f.post(reopened, 'refinement-measure', {
    mode: 'after', selectionRevision: 2, resultId: reopened.refinement.resultId,
  })).statusCode, 409);
});

test('零位候选靠真实有效的较高倍率原图，恢复非参与图片不会改变已冻结的前后对照', async (t) => {
  const f = await fixture(t, { zeroPose: actualZeroPose, ptzFor: (name, index) => {
    if (name === 'base') return {};
    return { Zoom: name === 'extra' && index === 0 ? 14 : name === 'main' && index === 0 ? 30 : 3 };
  }, highTransform: (shot) => shot.id === 'main-0' ? { ...shot, poseChanged: true } : shot });
  const highImage = join(f.dataDir, 'snapshots', 'extra-0.jpg');
  await unlink(highImage);
  const base = (await f.post(f.base, 'generate', { model: zeroPoseModel })).json();
  const selection = { ...base, baseModel: zeroPoseModel, resultId: base.zeroPoseCandidate.resultId };
  assert.equal((await f.select(f.main, selection, [f.extra])).statusCode, 200);
  const generated = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const main = generated.json(), candidate = main.refinement;
  assert.equal(candidate.status, 'insufficient_data', candidate.message);
  assert.match(candidate.message, /倍率高于基础组/);
  assert.equal(candidate.zeroPose, null);
  assert.deepEqual(candidate.before, candidate.after);
  assert.equal(candidate.before.high.sampleCount, 6);
  assert.ok(candidate.excluded.some((row) => row.snapshotId === 'main-0' && /姿态发生变化/.test(row.reason)));
  assert.ok(candidate.excluded.some((row) => row.snapshotId === 'extra-0' && /文件缺失/.test(row.reason)));

  await writeFile(highImage, 'extra-0');
  for (const mode of ['before', 'after']) {
    const response = await f.post(main, 'refinement-measure', { mode, selectionRevision: 1, resultId: candidate.resultId });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().sourceSnapshotIds, candidate.sourceSnapshotIds);
    assert.deepEqual(response.json().excluded, candidate.excluded);
  }
  const regenerated = await f.post(main, 'refine', { selectionRevision: 1 });
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  const latest = regenerated.json().refinement;
  assert.equal(latest.status, 'estimated', latest.message);
  assert.ok(latest.sourceSnapshotIds.includes('extra-0'));
  await unlink(highImage);
  const reopened = await f.get(main.id);
  assert.match(reopened.refinement.staleReasons.join('，'), /原图文件缺失/);
  const failed = await f.post(reopened, 'refinement-measure', { mode: 'after', selectionRevision: 1, resultId: latest.resultId });
  assert.equal(failed.statusCode, 409, failed.body);
  assert.deepEqual(await f.get(main.id), reopened);
});

test('有效精修候选可供新截图固定参数独立复核，复核保持候选、设备和来源原值', async (t) => {
  const f = await fixture(t, { includeValidation: true, ptzFor: (name, index) => name === 'validation' && index % 2 === 0
    ? { Zoom: 4, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5, Tilt: 2 } : {} });
  f.main = (await f.post(f.main, 'generate')).json();
  assert.equal(f.main.result.status, 'estimated');
  await f.select(f.main, f.base, [f.extra]);
  const generated = await f.post(f.main, 'refine', { selectionRevision: 1 });
  assert.equal(generated.statusCode, 200, generated.body);
  const main = generated.json(), candidate = main.refinement;
  assert.equal(candidate.status, 'estimated', candidate.message);
  const validation = await f.task('validation');
  const before = await Promise.all([f.get(main.id), f.get(f.base.id), f.get(f.extra.id), f.get(validation.id)]);
  const cameras = (await f.app.inject('/api/cameras')).json();
  const ordinary = await f.post(validation, 'validate', { referenceTaskId: main.id, referenceResultId: main.resultId });
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(ordinary.json().reference.kind, 'ordinary');
  assert.deepEqual(ordinary.json().installation, main.result.installation);
  const response = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
    referenceResultId: candidate.resultId });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'passed', result.message);
  assert.equal(result.reference.kind, 'refinement');
  assert.equal(result.reference.resultId, candidate.resultId);
  assert.equal(result.reference.selectionRevision, candidate.selectionRevision);
  assert.deepEqual(result.reference.sources, candidate.sources);
  assert.deepEqual(result.installation, candidate.installation);
  assert.equal(result.sourceSnapshotIds.length, 4);
  assert.ok(result.perSnapshot.every((row) => row.rmsResidualPixels <= 5 && row.verticalResiduals.length === 3
    && Number.isFinite(row.rmsAngularResidualDegrees) && Number.isFinite(row.horizontalFieldAngle)));
  assert.deepEqual(await Promise.all([f.get(main.id), f.get(f.base.id), f.get(f.extra.id), f.get(validation.id)]), before);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameras);
});

test('零位精修复核排除全部来源参与图，应用状态写入失败回滚并可重试', async (t) => {
  const f = await fixture(t, { includeValidation: true, zeroPose: actualZeroPose });
  const base = (await f.post(f.base, 'generate', { model: zeroPoseModel })).json();
  assert.equal((await f.select(f.main, { ...base, baseModel: zeroPoseModel, resultId: base.zeroPoseCandidate.resultId }, [f.extra])).statusCode, 200);
  const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  assert.equal(main.refinement.status, 'estimated', main.refinement.message);
  const validation = await f.task('validation');
  const request = { referenceKind: 'zero-pose-refinement', referenceTaskId: main.id, referenceResultId: main.refinement.resultId,
    criteria: { minimumHighZoom: 10, maximumVerticalOffsetPixels: 5, maximumDirectionDifferenceDegrees: 0.5, maximumRmsPixels: 5 } };
  assert.equal((await f.post(f.extra, 'validate', request)).statusCode, 409);
  const reviewed = await f.post(validation, 'validate', request);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const { status, evidence } = reviewed.json();
  assert.equal(status, 'passed');
  assert.equal(evidence.source.selectionRevision, main.refinement.selectionRevision);
  assert.deepEqual(evidence.source.sources, main.refinement.sources);
  assert.deepEqual((await f.get(main.id)).refinement.validation, evidence);
  const apply = (changes = {}) => f.post(main, 'refinement-apply', { resultId: main.refinement.resultId, model: zeroPoseModel,
    validationId: evidence.id, ...changes });
  assert.equal((await apply({ model: undefined, validationId: undefined })).statusCode, 409);
  assert.equal((await apply({ resultId: base.zeroPoseCandidate.resultId })).statusCode, 409);
  const database = new DatabaseSync(join(f.dataDir, 'cctv.sqlite'));
  try {
    database.exec(`CREATE TRIGGER reject_zero_pose_refinement_application BEFORE UPDATE OF metadata ON recognition_tasks
      WHEN json_extract(NEW.metadata, '$.refinement.applied') = 1
      BEGIN SELECT RAISE(ABORT, '测试零位精修应用状态写入失败'); END`);
    const failed = await apply();
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);
    assert.equal((await f.get(main.id)).refinement.applied, false);
    database.exec('DROP TRIGGER reject_zero_pose_refinement_application');
  } finally { database.close(); }
  const applied = await apply();
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().camera.calibrationModel, zeroPoseModel);
  assert.deepEqual(applied.json().camera.activeZeroPose, main.refinement.zeroPose);
  assert.equal(applied.json().task.refinement.applied, true);
  assert.deepEqual(applied.json().task.result, main.result);
  assert.equal(applied.json().task.refinement.stale, false);
  for (const mode of ['before', 'after']) {
    const preview = await f.post(main, 'refinement-measure', { mode, selectionRevision: 1, resultId: main.refinement.resultId });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().sourceSnapshotIds, main.refinement.sourceSnapshotIds);
    assert.ok(preview.json().perSnapshot.some((row) => row.taskId === base.id && row.group === 'base'));
  }
  assert.equal((await apply()).statusCode, 409);
  await unlink(join(f.dataDir, 'snapshots', 'base-0.jpg'));
  assert.equal((await f.get(main.id)).refinement.stale, true);
  assert.equal((await f.post(main, 'refinement-measure', {
    mode: 'before', selectionRevision: 1, resultId: main.refinement.resultId,
  })).statusCode, 409);

  const regeneratedBase = (await f.post(base, 'generate', { model: zeroPoseModel })).json();
  assert.equal((await f.select(main, { ...regeneratedBase, baseModel: zeroPoseModel, resultId: regeneratedBase.zeroPoseCandidate.resultId },
    [f.extra])).statusCode, 200);
  const secondRefinement = await f.post(main, 'refine', { selectionRevision: 2 });
  assert.equal(secondRefinement.statusCode, 200, secondRefinement.body);
  assert.notEqual(secondRefinement.json().refinement.resultId, main.refinement.resultId);
  assert.ok(!secondRefinement.json().refinement.applied);
  const candidate = (await f.post(validation, 'generate', { model: zeroPoseModel })).json().zeroPoseCandidate;
  assert.equal(candidate.status, 'estimated', candidate.message);
  const overlap = await f.post(f.extra, 'validate', { referenceKind: 'zero-pose', referenceTaskId: validation.id,
    referenceResultId: candidate.resultId, criteria: request.criteria });
  assert.equal(overlap.statusCode, 409);
  assert.match(overlap.json().message, /旧基准的拟合图片存在重叠/);
});

test('手动应用精修只保存四项修正和独立应用状态，保留普通结果、其他任务与历史采样并拒绝重复请求', async (t) => {
  const f = await fixture(t, { includeValidation: true, savedZeroPose: actualZeroPose,
    seed(store, camera) { store.saveCamera(camera, camera.id, { calibrationModel: zeroPoseModel, activeZeroPose: actualZeroPose }); } });
  const ordinary = (await f.post(f.main, 'generate')).json();
  assert.equal(ordinary.result.status, 'estimated');
  await f.select(ordinary, f.base, [f.extra]);
  const main = (await f.post(ordinary, 'refine', { selectionRevision: 1 })).json();
  assert.equal(main.refinement.status, 'estimated', main.refinement.message);
  const cameras = (await f.app.inject('/api/cameras')).json(), camera = cameras.find((entry) => entry.id === main.cameraId);
  const snapshots = (await f.app.inject(`/api/cameras/${camera.id}/snapshots`)).json();
  const sources = await Promise.all([f.get(f.base.id), f.get(f.extra.id)]);
  const items = (await f.app.inject(`/api/recognition-tasks/${main.id}/items`)).json().items;
  assert.equal((await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId, installation: main.refinement.installation })).statusCode, 400);
  assert.equal((await f.post(main, 'refinement-apply', { revision: main.revision + 1, resultId: main.refinement.resultId })).statusCode, 409);
  const requests = await Promise.all([f.post(main, 'refinement-apply', { resultId: main.refinement.resultId }),
    f.post(main, 'refinement-apply', { resultId: main.refinement.resultId })]);
  assert.deepEqual(requests.map((response) => response.statusCode).sort(), [200, 409]);
  const applied = requests.find((response) => response.statusCode === 200).json();
  const { calibrationModel, activeZeroPose, ...legacyCamera } = camera;
  assert.equal(calibrationModel, zeroPoseModel);
  assert.deepEqual(activeZeroPose, actualZeroPose);
  assert.deepEqual(applied.camera, { ...legacyCamera, ...main.refinement.installation, updatedAt: applied.camera.updatedAt });
  assert.deepEqual(applied.task, { ...main, updatedAt: applied.task.updatedAt,
    refinement: { ...main.refinement, applied: true, appliedAt: applied.task.refinement.appliedAt } });
  assert.ok(applied.task.refinement.appliedAt);
  assert.deepEqual(await f.get(main.id), applied.task);
  assert.deepEqual(await Promise.all([f.get(f.base.id), f.get(f.extra.id)]), sources);
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${main.id}/items`)).json().items, items);
  assert.deepEqual((await f.app.inject(`/api/cameras/${camera.id}/snapshots`)).json(), snapshots);
  const validation = await f.task('validation');
  const result = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
    referenceResultId: main.refinement.resultId });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'passed');
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual(await f.get(main.id), applied.task);
  assert.equal((await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId })).statusCode, 409);
});

test('精修应用状态写入失败时回滚相机修正，故障解除后同一候选可重试', async (t) => {
  const f = await fixture(t);
  await f.select(f.main, f.base, [f.extra]);
  const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  assert.equal(main.refinement.status, 'estimated', main.refinement.message);
  const cameras = (await f.app.inject('/api/cameras')).json();
  // 在真实测试库边界注入第二次写入故障，全部结果仍由 HTTP 观察。
  const database = new DatabaseSync(join(f.dataDir, 'cctv.sqlite'));
  try {
    database.exec(`CREATE TRIGGER reject_refinement_application BEFORE UPDATE OF metadata ON recognition_tasks
      WHEN json_extract(NEW.metadata, '$.refinement.applied') = 1
      BEGIN SELECT RAISE(ABORT, '测试精修应用状态写入失败'); END`);
    const response = await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId });
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameras);
    assert.deepEqual(await f.get(main.id), main);
    database.exec('DROP TRIGGER reject_refinement_application');
  } finally { database.close(); }
  const retry = await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().task.refinement.applied, true);
});

test('精修独立复核排除基础、主任务和补充任务全部参与图，允许新标识的重复姿态截图', async (t) => {
  const f = await fixture(t, { groupPans: { validation: [173, 9, 291, 38, 212] } });
  await f.select(f.main, f.base, [f.extra]);
  const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  assert.equal(main.refinement.status, 'estimated');
  for (const name of ['base', 'main', 'extra']) {
    const duplicate = await f.task(name);
    const response = await f.post(duplicate, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
      referenceResultId: main.refinement.resultId });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /重叠/);
  }
  const independent = await f.task('validation');
  const result = await f.post(independent, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
    referenceResultId: main.refinement.resultId });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'passed', result.body);
  assert.deepEqual(result.json().perSnapshot.map((row) => row.pan), [173, 9, 291, 38, 212]);
});

test('精修独立复核按逐图门槛拒绝单图超差，无有效验证观测时不宣称通过', async (t) => {
  const f = await fixture(t, { includeValidation: true });
  await f.select(f.main, f.base, [f.extra]);
  const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  let validation = await f.task('validation');
  const items = (await f.app.inject(`/api/recognition-tasks/${validation.id}/items`)).json().items;
  const first = items[0];
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${validation.id}/items/${first.snapshotId}`,
    payload: { revision: validation.revision, points: first.points.map((point) => ({ ...point, y: point.y + 8 / first.snapshot.height })) } });
  assert.equal(edited.statusCode, 200, edited.body);
  validation = edited.json().task;
  const validate = () => f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
    referenceResultId: main.refinement.resultId });
  const response = await validate();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.ok(result.rmsResidualPixels < 5, response.body);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failedSnapshotIds, [first.snapshotId]);
  assert.deepEqual(result.installation, main.refinement.installation);
  for (const item of items) {
    const ignored = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${validation.id}/items/${item.snapshotId}`,
      payload: { revision: validation.revision, ignored: true } });
    assert.equal(ignored.statusCode, 200, ignored.body);
    validation = ignored.json().task;
  }
  const empty = await validate();
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().status, 'insufficient_data');
  assert.equal(empty.json().rmsResidualPixels, null);
  assert.equal(empty.json().excluded.length, items.length);
  assert.deepEqual(await f.get(main.id), main);
});

test('精修复核与应用逐项拒绝全部来源标注、基础重算、选择变化和旧候选编号，冲突保持数据原值', async (t) => {
  const f = await fixture(t, { includeValidation: true }), validation = await f.task('validation');
  let main = f.main, base = f.base, extra = f.extra;
  const generate = async () => {
    const selected = await f.select(main, base, [extra]);
    assert.equal(selected.statusCode, 200, selected.body);
    main = selected.json();
    const generated = await f.post(main, 'refine', { selectionRevision: main.refinementSelection.revision });
    assert.equal(generated.statusCode, 200, generated.body);
    main = generated.json();
    assert.equal(main.refinement.status, 'estimated', main.refinement.message);
  };
  const reject = async (resultId = main.refinement.resultId) => {
    main = await f.get(main.id);
    const cameras = (await f.app.inject('/api/cameras')).json();
    const assessment = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id, referenceResultId: resultId });
    assert.equal(assessment.statusCode, 409, assessment.body);
    const application = await f.post(main, 'refinement-apply', { resultId });
    assert.equal(application.statusCode, 409, application.body);
    assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameras);
    assert.deepEqual(await f.get(main.id), main);
  };
  for (const sourceId of [base.id, main.id, extra.id]) {
    await generate();
    const source = await f.get(sourceId);
    const item = (await f.app.inject(`/api/recognition-tasks/${sourceId}/items`)).json().items[0];
    const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${sourceId}/items/${item.snapshotId}`,
      payload: { revision: source.revision, ...(sourceId === extra.id ? { ignored: true }
        : { points: item.points.map((point) => ({ ...point, y: point.y + 1 / item.snapshot.height })) }) } });
    assert.equal(edited.statusCode, 200, edited.body);
    await reject();
    if (sourceId === base.id) {
      const recalculated = await f.post(edited.json().task, 'generate');
      assert.equal(recalculated.statusCode, 200, recalculated.body);
      base = recalculated.json();
    } else if (sourceId === extra.id) extra = edited.json().task;
  }
  await generate();
  base = (await f.post(base, 'generate')).json();
  await reject();
  await generate();
  const changed = await f.select(main, base, []);
  assert.equal(changed.statusCode, 200, changed.body);
  main = changed.json();
  await reject();
  await generate();
  const previousId = main.refinement.resultId;
  main = (await f.post(main, 'refine', { selectionRevision: main.refinementSelection.revision })).json();
  assert.notEqual(main.refinement.resultId, previousId);
  await reject(previousId);
});

test('精修应用核对完整配置和更新时间，当前四修正改变仍可固定候选独立复核', async (t) => {
  const f = await fixture(t, { includeValidation: true }), validation = await f.task('validation');
  await f.select(f.main, f.base, [f.extra]);
  let input = { ...f.input };
  for (const change of [{ name: '改名后的设备' }, { maxZoom: f.camera.maxZoom + 1 },
    { pAxisPitch: 8, pAxisRoll: 4, tiltOffset: 3, imageRoll: 2 }, {}]) {
    const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
    assert.equal(main.refinement.status, 'estimated', main.refinement.message);
    input = { ...input, ...change };
    await new Promise((accept) => setTimeout(accept, 2));
    const updated = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.notEqual(updated.json().updatedAt, main.refinement.generatedCamera.updatedAt);
    const response = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
      referenceResultId: main.refinement.resultId });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'passed', response.body);
    assert.deepEqual(response.json().installation, main.refinement.installation);
    const application = await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId });
    assert.equal(application.statusCode, 409, application.body);
    assert.match(application.json().message, /配置已变化/);
    assert.deepEqual(await f.get(main.id), main);
    assert.deepEqual((await f.app.inject('/api/cameras')).json().find((camera) => camera.id === f.camera.id), updated.json());
  }
});

test('基础、主任务、补充参与图删除或固定安装条件变化后，精修复核与应用均拒绝且不部分写入', async (t) => {
  for (const changed of ['base', 'main', 'extra', 'fixed']) {
    const f = await fixture(t, { includeValidation: true }), validation = await f.task('validation');
    await f.select(f.main, f.base, [f.extra]);
    const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
    assert.equal(main.refinement.status, 'estimated', main.refinement.message);
    if (changed === 'fixed') {
      const update = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...f.input, height: f.camera.height + 1 } });
      assert.equal(update.statusCode, 200, update.body);
    } else {
      const source = main.refinement.sources.find((entry) => entry.taskId === f[changed].id);
      const deletion = await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${source.sourceSnapshotIds[0]}` });
      assert.equal(deletion.statusCode, 204, deletion.body);
    }
    const current = await f.get(main.id), cameras = (await f.app.inject('/api/cameras')).json();
    assert.equal(current.refinement.stale, true, changed);
    assert.match(current.refinement.staleReasons.join('；'), changed === 'fixed' ? /固定安装条件/ : /参与截图已删除/);
    const response = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
      referenceResultId: main.refinement.resultId });
    assert.equal(response.statusCode, 409, response.body);
    const application = await f.post(current, 'refinement-apply', { resultId: main.refinement.resultId });
    assert.equal(application.statusCode, 409, application.body);
    assert.deepEqual(await f.get(main.id), current);
    assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameras);
  }
});

test('精修应用拒绝正在执行的设备操作，占用解除后可应用且复核和应用不另发设备动作', async (t) => {
  let notify, release, controls = 0;
  const started = new Promise((accept) => { notify = accept; });
  const hold = new Promise((accept) => { release = accept; });
  const f = await fixture(t, { includeValidation: true, livegbs: { configured: true, async preciseControl() { controls++; notify(); await hold; } } });
  await f.select(f.main, f.base, [f.extra]);
  const main = (await f.post(f.main, 'refine', { selectionRevision: 1 })).json();
  const validation = await f.task('validation');
  const cameras = (await f.app.inject('/api/cameras')).json();
  const motion = f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/precise`, payload: { pan: 17, tilt: 2, zoom: 4 } });
  await started;
  try {
    const application = await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId });
    assert.equal(application.statusCode, 409, application.body);
    assert.match(application.json().message, /正在控制或截图/);
    const assessment = await f.post(validation, 'validate', { referenceKind: 'refinement', referenceTaskId: main.id,
      referenceResultId: main.refinement.resultId });
    assert.equal(assessment.statusCode, 200, assessment.body);
    assert.equal(controls, 1);
    assert.deepEqual(await f.get(main.id), main);
    assert.deepEqual((await f.app.inject('/api/cameras')).json(), cameras);
  } finally { release(); await motion; }
  const applied = await f.post(main, 'refinement-apply', { resultId: main.refinement.resultId });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(controls, 1);
});

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
  const f = await fixture(t, { savedZeroPose: actualZeroPose });
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
  assert.equal((await f.post(task, 'refinement-apply', { resultId: task.refinement.resultId })).statusCode, 409);
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
    assert.equal((await f.post(response.json(), 'refinement-apply', { resultId: result.resultId })).statusCode, 409);
  }
});

test('总体低误差不能掩盖高倍组超差，固定模型保留相反方向的真实残差', async (t) => {
  const f = await fixture(t, { writeImages: true, includeValidation: true });
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
  assert.equal((await f.post(response.json(), 'refinement-apply', { resultId: result.resultId })).statusCode, 409);

  const generated = await f.post(main, 'refine', { selectionRevision: 1, model: zeroPoseModel });
  assert.equal(generated.statusCode, 200, generated.body);
  const candidate = generated.json().refinement;
  assert.equal(candidate.status, 'estimated', candidate.message);
  assert.ok(candidate.zeroPose);
  assert.ok(candidate.after.high.rmsResidualPixels > 5);
  assert.match(candidate.message, /高倍组 RMS .*超过 5 像素参考值/);
  const preview = await f.post(main, 'refinement-measure', { selectionRevision: 1, mode: 'after', resultId: candidate.resultId });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json().zeroPose, candidate.zeroPose);
  const reviewed = await f.post(await f.task('validation'), 'validate', {
    referenceKind: 'zero-pose-refinement', referenceTaskId: main.id, referenceResultId: candidate.resultId,
    criteria: { minimumHighZoom: 10, maximumVerticalOffsetPixels: 5, maximumDirectionDifferenceDegrees: 0.5, maximumRmsPixels: 5 },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().evidence.source.resultId, candidate.resultId);
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
