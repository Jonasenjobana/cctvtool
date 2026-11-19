import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CameraStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { fixtureCamera, syntheticSnapshots } from './calibration-fixtures.mjs';

async function fixture(t, customRecognizer, { savedZeroPose, transformSnapshot = (snapshot) => snapshot, ...sampleOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-recognition-test-'));
  const store = new CameraStore(dataDir);
  const input = Object.fromEntries(['name', 'serial', 'code', 'longitude', 'latitude', 'height', 'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'].map((key) => [key, fixtureCamera[key]]));
  if (savedZeroPose) input.zeroPose = savedZeroPose;
  const camera = store.saveCamera(input);
  const actual = { ...camera, tiltOffset: 1.1, imageRoll: -0.8 };
  const { snapshots: inputs, observations } = syntheticSnapshots({ camera: actual, ...sampleOptions });
  const snapshots = inputs.map(transformSnapshot);
  store.addSnapshotGroup({ id: 'source-task', cameraId: camera.id, cameraName: camera.name, kind: 'scan', status: 'completed',
    createdAt: snapshots[0].createdAt, sampleCount: snapshots.length, completedCount: 0 });
  snapshots.forEach((snapshot, scanIndex) => store.addSnapshot({ ...snapshot, groupId: 'source-task', scanIndex,
    fileName: `${snapshot.id}.jpg`, imageUrl: `/api/snapshots/${snapshot.id}/image`, contentType: 'image/jpeg' }));
  store.close();
  if (sampleOptions.zeroPose) {
    await Promise.all(snapshots.map((snapshot) => writeFile(join(dataDir, 'snapshots', `${snapshot.id}.jpg`), 'fixture')));
  }
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

const zeroPoseModel = 'wgs84-horizon-zero-pose-v1';
const trueZeroPose = { roll: -4.25, pitch: 2.75, yaw: 128.5, tiltOffset: 1.85 };
const savedZeroPose = { ...trueZeroPose, roll: 0, pitch: 0 };
const postZeroPose = (f, id, revision = 0) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${id}/generate`,
  payload: { revision, model: zeroPoseModel } });
const measureZeroPose = (f, id, candidate, snapshotId) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${id}/zero-pose-measure`,
  payload: { revision: candidate.revision, resultId: candidate.resultId, snapshotId } });

test('识别任务按实际 P/T/FOV 生成零位候选，冻结 Yaw 和补偿并保留旧结果', async (t) => {
  const f = await fixture(t, undefined, { savedZeroPose, zeroPose: trueZeroPose, pans: [355, 20, 100, 190, 275] });
  const task = await createAndWait(f);
  const legacy = await post(f, task.id, 'generate', 0);
  assert.equal(legacy.statusCode, 200, legacy.body);
  const before = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json().items;
  const generated = await postZeroPose(f, task.id);
  assert.equal(generated.statusCode, 200, generated.body);
  const { zeroPoseCandidate: candidate, resultId, result } = generated.json();
  assert.equal(candidate.model, zeroPoseModel);
  assert.equal(candidate.status, 'estimated', candidate.message);
  assert.equal(candidate.stale, false);
  assert.notEqual(candidate.resultId, resultId);
  assert.equal(candidate.revision, task.revision);
  assert.deepEqual(candidate.generatedCamera, f.camera);
  assert.equal(candidate.zeroPose.yaw, trueZeroPose.yaw);
  assert.equal(candidate.zeroPose.tiltOffset, trueZeroPose.tiltOffset);
  assert.ok(Math.abs(candidate.zeroPose.roll - trueZeroPose.roll) < 1e-5, JSON.stringify(candidate.zeroPose));
  assert.ok(Math.abs(candidate.zeroPose.pitch - trueZeroPose.pitch) < 1e-5, JSON.stringify(candidate.zeroPose));
  assert.equal(candidate.fixedCalibration.imageRoll, 0);
  assert.equal(candidate.distinctPanCount, 5);
  assert.equal(candidate.panCoverageDegrees, 270);
  assert.deepEqual(candidate.sourceSnapshotIds, f.snapshots.map((snapshot) => snapshot.id));
  assert.ok(candidate.diagnostics.perSnapshot.every((row) => row.rmsResidualPixels < 0.01));
  assert.equal(resultId, legacy.json().resultId);
  assert.deepEqual(result, legacy.json().result);
  const preview = await measureZeroPose(f, task.id, candidate, 'synthetic-0');
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().resultId, candidate.resultId);
  assert.deepEqual(preview.json().zeroPose, candidate.zeroPose);
  const [row] = preview.json().perSnapshot;
  assert.equal(row.snapshotId, 'synthetic-0');
  assert.equal(row.pan, 355);
  assert.ok(row.theoreticalHorizon.length > 0);
  assert.ok(row.verticalResiduals.filter((entry) => entry.position !== 'center')
    .every(({ offsetPixels }) => offsetPixels !== null && Math.abs(offsetPixels) < 0.01));
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);
  await f.app.close();
  f.app = await createApp(f.options);
  const reopened = (await f.app.inject(`/api/recognition-tasks/${task.id}/items`)).json();
  assert.deepEqual(reopened.items, before);
  assert.deepEqual(reopened.task.zeroPoseCandidate, candidate);
});

test('零位候选排除异常样本，参与原图丢失后原候选只保留诊断', async (t) => {
  const f = await fixture(t, undefined, { zeroPose: { roll: -2.2, pitch: 1.5, yaw: fixtureCamera.panOffset, tiltOffset: fixtureCamera.tiltOffset },
    pans: [355, 20, 100, 190, 275, 290, 320, 40, 65, 120], transformSnapshot(snapshot, index) {
      if (index === 1) return { ...snapshot, poseChanged: true };
      if (index === 2) return { ...snapshot, ptz: { ...snapshot.ptz, raw: { ...snapshot.ptz.raw, HorizontalFieldAngle: null } } };
      if (index === 3) return { ...snapshot, code: 'wrong-channel' };
      if (index === 4) return { ...snapshot, width: 0 };
      return snapshot;
    } });
  const task = await createAndWait(f);
  const ignored = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/synthetic-0`,
    payload: { revision: 0, ignored: true } });
  assert.equal(ignored.statusCode, 200, ignored.body);
  const deleted = await f.app.inject({ method: 'DELETE', url: '/api/snapshots/synthetic-5' });
  assert.equal(deleted.statusCode, 204, deleted.body);
  await unlink(join(f.dataDir, 'snapshots', 'synthetic-6.jpg'));
  const generated = await postZeroPose(f, task.id, 1);
  assert.equal(generated.statusCode, 200, generated.body);
  const candidate = generated.json().zeroPoseCandidate;
  assert.equal(candidate.status, 'estimated', candidate.message);
  assert.ok(Math.abs(candidate.zeroPose.yaw - f.camera.panOffset) < 1e-10);
  assert.equal(candidate.zeroPose.tiltOffset, f.camera.tiltOffset);
  assert.deepEqual(candidate.sourceSnapshotIds, ['synthetic-7', 'synthetic-8', 'synthetic-9']);
  const exclusions = Object.fromEntries(candidate.excluded.map(({ snapshotId, reason }) => [snapshotId, reason]));
  assert.match(exclusions['synthetic-0'], /人工忽略/);
  assert.match(exclusions['synthetic-1'], /姿态发生变化/);
  assert.match(exclusions['synthetic-2'], /视场角无效/);
  assert.match(exclusions['synthetic-3'], /设备通道/);
  assert.match(exclusions['synthetic-4'], /图片尺寸无效/);
  assert.match(exclusions['synthetic-5'], /源截图已删除/);
  assert.match(exclusions['synthetic-6'], /截图文件缺失/);
  assert.equal((await measureZeroPose(f, task.id, candidate, 'synthetic-6')).statusCode, 409);
  await unlink(join(f.dataDir, 'snapshots', 'synthetic-7.jpg'));
  const reopened = (await f.app.inject(`/api/recognition-tasks/${task.id}`)).json().zeroPoseCandidate;
  assert.equal(reopened.resultId, candidate.resultId);
  assert.equal(reopened.stale, true);
  assert.match(reopened.staleReasons.join(' '), /参与原图已删除或缺失/);
  assert.equal((await measureZeroPose(f, task.id, candidate, 'synthetic-8')).statusCode, 409);
});

test('零位候选版本核对配置、正式标注和生成编号', async (t) => {
  const f = await fixture(t, undefined, { savedZeroPose, zeroPose: trueZeroPose });
  const task = await createAndWait(f);
  const first = (await postZeroPose(f, task.id)).json().zeroPoseCandidate;
  const second = (await postZeroPose(f, task.id)).json().zeroPoseCandidate;
  assert.notEqual(second.resultId, first.resultId);
  assert.equal((await measureZeroPose(f, task.id, first, 'synthetic-0')).statusCode, 409);
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/synthetic-0`,
    payload: { revision: 0, ignored: true } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.match(edited.json().task.zeroPoseCandidate.staleReasons.join(' '), /正式标注版本/);
  assert.equal((await measureZeroPose(f, task.id, second, 'synthetic-1')).statusCode, 409);
  const third = (await postZeroPose(f, task.id, 1)).json().zeroPoseCandidate;
  assert.equal(third.stale, false);
  const camera = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`,
    payload: { ...f.input, zeroPose: { ...savedZeroPose, yaw: savedZeroPose.yaw + 1 } } });
  assert.equal(camera.statusCode, 200, camera.body);
  const preview = await measureZeroPose(f, task.id, third, 'synthetic-1');
  assert.equal(preview.statusCode, 409, preview.body);
  assert.match(preview.json().message, /相机配置版本已变化/);
});

test('零位拟合报告无有效观测和矛盾标注，拒绝按失败候选预览', async (t) => {
  const f = await fixture(t, undefined, { savedZeroPose, zeroPose: trueZeroPose, pans: [25, 25],
    ptzOverrides: { Tilt: 2.2, Zoom: 3, HorizontalFieldAngle: 24, VerticalFieldAngle: 14 } });
  const task = await createAndWait(f);
  const points = f.observations[1].points.filter((_, index) => index !== 1)
    .map((point) => ({ ...point, y: point.y + 0.1 }));
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${task.id}/items/synthetic-1`,
    payload: { revision: 0, points } });
  assert.equal(edited.statusCode, 200, edited.body);
  const failed = (await postZeroPose(f, task.id, 1)).json().zeroPoseCandidate;
  assert.equal(failed.status, 'unreliable', failed.message);
  assert.equal(failed.zeroPose, null);
  assert.ok(failed.diagnostics.rmsResidualPixels > 5);
  assert.equal((await measureZeroPose(f, task.id, failed, 'synthetic-0')).statusCode, 409);

  await f.app.close();
  const store = new CameraStore(f.dataDir);
  try {
    store.addRecognitionTask({ ...task, id: 'empty-task', sampleCount: 0, completedCount: 0 }, []);
  } finally { store.close(); }
  f.app = await createApp(f.options);
  const generated = await postZeroPose(f, 'empty-task');
  assert.equal(generated.statusCode, 200, generated.body);
  const empty = generated.json().zeroPoseCandidate;
  assert.equal(empty.status, 'insufficient_data', empty.message);
  assert.equal(empty.zeroPose, null);
  assert.deepEqual(empty.sourceSnapshotIds, []);
});

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

async function independentValidationFixture(t, { transformSnapshot = (snapshot) => snapshot,
  transformItem = (item) => item, empty = false, referencePhase } = {}) {
  const f = await fixture(t);
  const source = await createAndWait(f);
  const generated = await post(f, source.id, 'generate', 0);
  assert.equal(generated.statusCode, 200, generated.body);
  f.reference = generated.json();
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  try {
    if (referencePhase) store.updateSnapshotGroup(source.sourceTaskId, { horizon: { phase: referencePhase } });
    const task = { ...source, id: 'validation-task', sourceTaskId: 'validation-source', result: null, resultId: null };
    store.addSnapshotGroup({ id: task.sourceTaskId, cameraId: f.camera.id, cameraName: f.camera.name,
      kind: 'scan', status: 'completed', createdAt: source.createdAt, sampleCount: f.snapshots.length, completedCount: f.snapshots.length });
    const items = f.snapshots.map((snapshot, index) => {
      const copy = transformSnapshot({ ...snapshot, id: `validation-${index}`, groupId: task.sourceTaskId, fileName: `validation-${index}.jpg` }, index);
      store.addSnapshot(copy);
      const points = f.observations[index].points.filter((_, column) => column !== 1);
      return transformItem({ snapshotId: copy.id, snapshot: copy, detectedPoints: points, points, ignored: false, source: 'manual', ignoreReason: '' }, index);
    });
    store.addRecognitionTask({ ...task, sampleCount: empty ? 0 : items.length }, empty ? [] : items);
    f.validationTask = task;
  } finally { store.close(); }
  f.app = await createApp(f.options);
  f.validate = (changes = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${f.validationTask.id}/validate`,
    payload: { revision: 0, referenceTaskId: f.reference.id, referenceResultId: f.reference.resultId, ...changes } });
  return f;
}

const comparisonZeroPose = { roll: 0.07, pitch: 0.03, yaw: fixtureCamera.panOffset, tiltOffset: 0.13 };
const validationCriteria = {
  minimumHighZoom: 30, maximumVerticalOffsetPixels: 5, maximumDirectionDifferenceDegrees: 0.1, maximumRmsPixels: 5,
};

async function zeroPoseValidationFixture(t, { transformItem = (item) => item, baselineSnapshotId } = {}) {
  const f = await fixture(t, undefined, { savedZeroPose: { ...comparisonZeroPose, roll: 0, pitch: 0 },
    zeroPose: comparisonZeroPose, pans: [355, 20, 100, 190, 275] });
  const source = await createAndWait(f);
  const generated = await postZeroPose(f, source.id);
  assert.equal(generated.statusCode, 200, generated.body);
  f.reference = generated.json();
  f.candidate = f.reference.zeroPoseCandidate;
  assert.equal(f.candidate.status, 'estimated', f.candidate.message);
  await f.app.close();
  const store = new CameraStore(f.dataDir);
  try {
    const task = { ...source, id: 'zero-pose-validation', sourceTaskId: 'zero-pose-validation-source', sampleCount: 3 };
    store.addSnapshotGroup({ id: task.sourceTaskId, cameraId: f.camera.id, cameraName: f.camera.name, kind: 'scan',
      status: 'completed', createdAt: source.createdAt, sampleCount: task.sampleCount, completedCount: task.sampleCount });
    const samples = [
      { snapshot: f.snapshots[0], points: f.observations[0].points },
      ...[355, 100].map((pan) => {
        const { snapshots, observations } = syntheticSnapshots({ camera: f.camera, zeroPose: comparisonZeroPose, pans: [pan],
          ptzOverrides: { Tilt: 0.13, Zoom: 30, HorizontalFieldAngle: 3, VerticalFieldAngle: 2 } });
        return { snapshot: snapshots[0], points: observations[0].points };
      }),
    ];
    const items = [];
    for (const [index, { snapshot, points }] of samples.entries()) {
      const id = `validation-${index}`;
      const copy = { ...snapshot, id, groupId: task.sourceTaskId, fileName: `${id}.jpg` };
      store.addSnapshot(copy);
      await writeFile(join(f.dataDir, 'snapshots', copy.fileName), 'fixture');
      const saved = points.filter((_, column) => column !== 1).map((point) => ({ ...point,
        y: point.y + (index === 0 ? 3 / snapshot.height : 0) }));
      items.push(transformItem({ snapshotId: id, snapshot: copy, detectedPoints: saved, points: saved, ignored: false,
        source: 'manual', ignoreReason: '' }, index, f));
    }
    store.addRecognitionTask(task, items);
    if (baselineSnapshotId) {
      store.addRecognitionTask({ ...source, id: 'old-applied-recognition', resultId: 'old-applied-result', resultRevision: 0,
        appliedRevision: 0, appliedAt: f.camera.updatedAt, fitCamera: f.camera, result: {
          model: 'wgs84-horizon-installation-v1', status: 'estimated', applied: true,
          installation: { pAxisPitch: 0, pAxisRoll: 0, tiltOffset: 0, imageRoll: 0 }, sourceSnapshotIds: [baselineSnapshotId],
        } }, []);
    }
    f.validationTask = task;
  } finally { store.close(); }
  f.app = await createApp(f.options);
  f.validateZeroPose = (changes = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${f.validationTask.id}/validate`,
    payload: { revision: 0, referenceTaskId: f.reference.id, referenceResultId: f.candidate.resultId,
      referenceKind: 'zero-pose', criteria: validationCriteria, ...changes } });
  return f;
}

test('零位独立复核用同批原图测量已保存四参数和冻结候选并保存版本证据', async (t) => {
  const f = await zeroPoseValidationFixture(t);
  const response = await f.validateZeroPose();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const { baseline, candidate, perSnapshot, evidence } = result;
  assert.equal(result.status, 'passed', result.message);
  assert.equal(baseline.model, 'wgs84-horizon-installation-v1');
  assert.equal(candidate.model, zeroPoseModel);
  assert.deepEqual(candidate.zeroPose, f.candidate.zeroPose);
  assert.deepEqual(perSnapshot.map(({ snapshotId }) => snapshotId), ['validation-0', 'validation-1', 'validation-2']);
  const [repeat, high] = perSnapshot;
  assert.deepEqual([repeat.pan, repeat.tilt, repeat.zoom], [355, 2, 3]);
  assert.deepEqual([high.pan, high.tilt, high.zoom], [355, 0.13, 30]);
  assert.ok(repeat.candidate.verticalResiduals.every(({ offsetPixels }) => Math.abs(offsetPixels - 3) < 0.05));
  assert.ok(Math.abs(high.candidate.directionDifferenceDegrees) < 1e-4);
  assert.ok(high.candidate.rmsResidualPixels < 0.01);
  assert.ok(high.baseline.rmsResidualPixels > 5);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.source.resultId, f.candidate.resultId);
  assert.deepEqual(evidence.source.sourceSnapshotIds, f.candidate.sourceSnapshotIds);
  assert.deepEqual(evidence.camera, { id: f.camera.id, updatedAt: f.camera.updatedAt });
  assert.deepEqual(evidence.validation, { taskId: f.validationTask.id, revision: 0,
    sourceSnapshotIds: ['validation-0', 'validation-1', 'validation-2'] });
  assert.deepEqual(evidence.criteria, validationCriteria);
  const reference = (await f.app.inject(`/api/recognition-tasks/${f.reference.id}`)).json();
  assert.deepEqual(reference.zeroPoseCandidate.validation, evidence);
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);

  const stricter = await f.validateZeroPose({ criteria: { ...validationCriteria, maximumVerticalOffsetPixels: 2 } });
  assert.equal(stricter.statusCode, 200, stricter.body);
  assert.deepEqual(stricter.json().failedSnapshotIds, ['validation-0']);
  assert.deepEqual(stricter.json().perSnapshot[0].failures, ['左端垂直偏差', '中点垂直偏差', '右端垂直偏差']);
});

test('通过独立复核的普通零位候选只应用一次，保存草稿仍独立于生效模型', async (t) => {
  const f = await zeroPoseValidationFixture(t);
  const apply = (changes = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${f.reference.id}/apply`,
    payload: { revision: f.reference.revision, resultId: f.candidate.resultId, model: zeroPoseModel, ...changes } });
  assert.equal((await apply({ validationId: 'unverified' })).statusCode, 409);
  const { evidence } = (await f.validateZeroPose()).json();
  assert.equal(evidence.status, 'passed');
  const responses = await Promise.all([apply({ validationId: evidence.id }), apply({ validationId: evidence.id })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  const { task, camera } = responses.find((response) => response.statusCode === 200).json();
  assert.equal(camera.calibrationModel, zeroPoseModel);
  assert.deepEqual(camera.activeZeroPose, f.candidate.zeroPose);
  assert.deepEqual(camera.zeroPose, f.candidate.zeroPose);
  assert.equal(task.zeroPoseCandidate.applied, true);
  assert.deepEqual(task.zeroPoseCandidate.validation, evidence);
  assert.deepEqual(task.result, f.reference.result);
  const draft = { ...camera.zeroPose, yaw: 5 };
  const saved = await f.app.inject({ method: 'PUT', url: `/api/cameras/${camera.id}`, payload: { ...f.input, zeroPose: draft } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().zeroPose, draft);
  assert.deepEqual(saved.json().activeZeroPose, f.candidate.zeroPose);
  await f.app.close();
  f.app = await createApp(f.options);
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], saved.json());

  const legacy = await post(f, f.reference.id, 'generate', f.reference.revision);
  assert.equal(legacy.json().result.status, 'estimated', legacy.json().result.message);
  const restored = await post(f, f.reference.id, 'apply', f.reference.revision);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().camera.calibrationModel, undefined);
  assert.equal(restored.json().camera.activeZeroPose, undefined);
  assert.deepEqual(restored.json().camera.zeroPose, draft);
});

test('普通零位应用拒绝跨模型编号、失败或被替换的复核以及缺失的复核原图', async (t) => {
  const f = await zeroPoseValidationFixture(t);
  const legacy = (await post(f, f.reference.id, 'generate', f.reference.revision)).json();
  const apply = (validationId, changes = {}) => f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${f.reference.id}/apply`,
    payload: { revision: f.reference.revision, resultId: f.candidate.resultId, model: zeroPoseModel, validationId, ...changes } });
  const passed = (await f.validateZeroPose()).json().evidence;
  assert.equal((await apply(passed.id, { resultId: legacy.resultId })).statusCode, 409);
  assert.equal((await apply(undefined, { model: undefined })).statusCode, 409);
  const failed = (await f.validateZeroPose({ criteria: { ...validationCriteria, maximumVerticalOffsetPixels: 2 } })).json().evidence;
  assert.equal(failed.status, 'failed');
  assert.equal((await apply(passed.id)).statusCode, 409);
  assert.equal((await apply(failed.id)).statusCode, 409);

  const latest = (await f.validateZeroPose()).json().evidence;
  await unlink(join(f.dataDir, 'snapshots', 'validation-1.jpg'));
  const missing = await apply(latest.id);
  assert.equal(missing.statusCode, 409, missing.body);
  assert.match(missing.json().message, /独立复核参与原图/);
  assert.deepEqual((await f.app.inject('/api/cameras')).json()[0], f.camera);
  assert.equal((await f.app.inject(`/api/recognition-tasks/${f.reference.id}`)).json().zeroPoseCandidate.applied, false);
});

test('零位独立复核报告逐图超差及相对旧基准的退化', async (t) => {
  const f = await zeroPoseValidationFixture(t, {
    transformItem(item, index, fixture) {
      if (index !== 1) return item;
      const { observations } = syntheticSnapshots({ camera: fixture.camera, pitch: 0, roll: 0, pans: [355],
        ptzOverrides: item.snapshot.ptz.raw });
      const points = observations[0].points.filter((_, column) => column !== 1);
      return { ...item, points, detectedPoints: points };
    },
  });
  const response = await f.validateZeroPose();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'failed', result.message);
  assert.equal(result.evidence.status, 'failed');
  assert.deepEqual(result.failedSnapshotIds, ['validation-1']);
  const row = result.perSnapshot.find(({ snapshotId }) => snapshotId === 'validation-1');
  assert.ok(row.baseline.rmsResidualPixels < 0.01);
  assert.ok(row.failures.includes('像素 RMS'));
  assert.ok(row.regressions.includes('像素 RMS'));
});

test('零位独立复核标明高倍覆盖不足及缺失原图', async (t) => {
  const f = await zeroPoseValidationFixture(t);
  await unlink(join(f.dataDir, 'snapshots', 'validation-2.jpg'));
  const response = await f.validateZeroPose();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'insufficient_coverage', result.message);
  assert.equal(result.coverage.highPoseCount, 1);
  assert.equal(result.coverage.lowSnapshotCount, 1);
  assert.deepEqual(result.excluded, [{ snapshotId: 'validation-2', reason: '源截图文件缺失' }]);
  assert.deepEqual(result.evidence.validation.sourceSnapshotIds, ['validation-0', 'validation-1']);
});

test('零位独立复核拒绝其他任务引用的原始拟合图片及过期版本', async (t) => {
  const f = await zeroPoseValidationFixture(t, {
    transformItem(item, index, fixture) {
      if (index !== 0) return item;
      const snapshot = { ...fixture.snapshots[0], fileName: 'synthetic-0.jpg' };
      return { ...item, snapshot, snapshotId: snapshot.id };
    },
  });
  const overlap = await f.validateZeroPose();
  assert.equal(overlap.statusCode, 409, overlap.body);
  assert.match(overlap.json().message, /拟合图片存在重叠/);
  const staleResult = await f.validateZeroPose({ referenceResultId: 'old-id' });
  assert.equal(staleResult.statusCode, 409, staleResult.body);
  assert.match(staleResult.json().message, /候选编号/);
  const staleMarking = await f.validateZeroPose({ revision: 1 });
  assert.equal(staleMarking.statusCode, 409, staleMarking.body);
  assert.match(staleMarking.json().message, /识别任务已被修改/);
  const noCriteria = await f.validateZeroPose({ criteria: undefined });
  assert.equal(noCriteria.statusCode, 400, noCriteria.body);
  const updated = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...f.input, name: '相机新名称' } });
  assert.equal(updated.statusCode, 200, updated.body);
  const staleCamera = await f.validateZeroPose();
  assert.equal(staleCamera.statusCode, 409, staleCamera.body);
  assert.match(staleCamera.json().message, /相机配置版本已变化/);
});

test('零位独立复核同时排除已生效旧基准实际使用的原图', async (t) => {
  const f = await zeroPoseValidationFixture(t, { baselineSnapshotId: 'validation-0' });
  const response = await f.validateZeroPose();
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().message, /旧基准的拟合图片存在重叠/);
});

test('独立复核使用另一任务的固定结果，不改变设备、标注、拟合或应用状态', async (t) => {
  const f = await independentValidationFixture(t);
  const camerasBefore = (await f.app.inject('/api/cameras')).json();
  const itemsUrl = `/api/recognition-tasks/${f.validationTask.id}/items`;
  const itemsBefore = (await f.app.inject(itemsUrl)).json();
  const referenceBefore = (await f.app.inject(`/api/recognition-tasks/${f.reference.id}`)).json();
  const response = await f.validate();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'passed');
  assert.equal(response.json().reference.resultId, f.reference.resultId);
  assert.deepEqual(response.json().installation, f.reference.result.installation);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), camerasBefore);
  assert.deepEqual((await f.app.inject(itemsUrl)).json(), itemsBefore);
  assert.deepEqual((await f.app.inject(`/api/recognition-tasks/${f.reference.id}`)).json(), referenceBefore);
  const id = f.validationTask.id;
  const edit = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${id}/items/validation-0`,
    payload: { revision: 0, points: itemsBefore.items[0].points.map((point) => ({ ...point, y: point.y + 30 / itemsBefore.items[0].snapshot.height })) } });
  assert.equal(edit.statusCode, 200, edit.body);
  const failed = await f.validate({ revision: 1 });
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.json().status, 'failed');
  assert.ok(failed.json().failedSnapshotIds.includes('validation-0'));
  assert.deepEqual(failed.json().installation, f.reference.result.installation);
});

test('独立复核拒绝复用拟合图片、旧标注版本、旧结果编号与已变化的固定配置', async (t) => {
  const f = await independentValidationFixture(t);
  const overlap = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${f.reference.id}/validate`,
    payload: { revision: 0, referenceTaskId: f.reference.id, referenceResultId: f.reference.resultId } });
  assert.equal(overlap.statusCode, 409, overlap.body);
  const duplicate = await createAndWait(f);
  const duplicateCheck = await f.app.inject({ method: 'POST', url: `/api/recognition-tasks/${duplicate.id}/validate`,
    payload: { revision: 0, referenceTaskId: f.reference.id, referenceResultId: f.reference.resultId } });
  assert.equal(duplicateCheck.statusCode, 409, duplicateCheck.body);
  assert.equal((await f.validate({ revision: 1 })).statusCode, 409);
  assert.equal((await f.validate({ referenceResultId: 'old-result' })).statusCode, 409);
  assert.equal((await f.validate({ installation: f.reference.result.installation })).statusCode, 400);
  await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...f.input, height: f.input.height + 1 } });
  assert.equal((await f.validate()).statusCode, 409);
});

test('原图基准对照返回理论海天线、左中右向下为正的像素差及独立误差口径', async (t) => {
  const f = await independentValidationFixture(t);
  const items = (await f.app.inject(`/api/recognition-tasks/${f.validationTask.id}/items`)).json().items;
  const original = items.find((item) => item.snapshotId === 'validation-0');
  const points = original.points.map((point) => ({ ...point, y: point.y + 12 / original.snapshot.height }));
  const saved = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.validationTask.id}/items/${original.snapshotId}`,
    payload: { revision: 0, points } });
  assert.equal(saved.statusCode, 200, saved.body);
  const response = await f.validate({ revision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const row = response.json().perSnapshot.find((entry) => entry.snapshotId === original.snapshotId);
  assert.ok(row.theoreticalHorizon.length > 0, '原图应有可见理论线');
  assert.ok(row.theoreticalHorizon.flat().every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  assert.deepEqual(row.verticalResiduals.map((residual) => residual.position), ['left', 'center', 'right']);
  assert.deepEqual(row.verticalResiduals.map((residual) => residual.x), [0.1, 0.5, 0.9]);
  for (const residual of row.verticalResiduals) {
    assert.ok(Math.abs(residual.offsetPixels - 12) < 0.05, JSON.stringify(residual));
    assert.ok(residual.observedY > residual.theoreticalY);
  }
  assert.equal(row.verticalOffsetPixels, row.verticalResiduals[1].offsetPixels);
  assert.ok(Math.abs(row.directionDifferenceDegrees) < 0.01);
  assert.equal(row.horizontalFieldAngle, original.snapshot.ptz.raw.HorizontalFieldAngle);
  assert.equal(row.verticalFieldAngle, original.snapshot.ptz.raw.VerticalFieldAngle);
  assert.equal(row.timeAlignment, 'unverified');
  assert.ok(row.rmsResidualPixels > 11 && row.rmsAngularResidualDegrees > 0);
});

test('原图理论海天线不可见时明确返回不可比较原因，几何残差继续保留', async (t) => {
  const f = await independentValidationFixture(t, { transformSnapshot: (snapshot) => ({ ...snapshot,
    ptz: { ...snapshot.ptz, raw: { ...snapshot.ptz.raw, Tilt: 80 } } }) });
  const response = await f.validate();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'failed');
  for (const row of response.json().perSnapshot) {
    assert.deepEqual(row.theoreticalHorizon, []);
    assert.equal(row.verticalOffsetPixels, null);
    for (const residual of row.verticalResiduals) {
      assert.equal(residual.theoreticalY, null);
      assert.equal(residual.offsetPixels, null);
      assert.equal(residual.unavailableReason, '理论海天线未经过该图像竖线');
    }
    assert.ok(row.rmsResidualPixels > 5 && Number.isFinite(row.rmsResidualPixels));
    assert.ok(row.rmsAngularResidualDegrees > 0 && Number.isFinite(row.rmsAngularResidualDegrees));
  }
});

test('原图基准对照在没有截图条目的历史任务上返回无有效样本', async (t) => {
  const f = await independentValidationFixture(t, { empty: true });
  const response = await f.validate();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'insufficient_data');
  assert.deepEqual(response.json().perSnapshot, []);
  assert.equal(response.json().rmsResidualPixels, null);
});

test('原图测量逐项说明移动、无效姿态、通道、尺寸、正式标注和忽略项的排除原因', async (t) => {
  const f = await independentValidationFixture(t, {
    transformSnapshot: (snapshot, index) => {
      if (index === 0) return { ...snapshot, poseChanged: true };
      if (index === 1) return { ...snapshot, ptz: { ...snapshot.ptz, raw: { ...snapshot.ptz.raw, HorizontalFieldAngle: 0 } } };
      if (index === 2) return { ...snapshot, code: 'other-channel' };
      if (index === 3) return { ...snapshot, width: 0 };
      return snapshot;
    },
    transformItem: (item, index) => index === 4 ? { ...item, points: [{ x: 0.4, y: 0.5 }, { x: 0.45, y: 0.5 }] }
      : index === 5 ? { ...item, ignored: true, ignoreReason: '已人工忽略' } : item,
  });
  const response = await f.validate();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'insufficient_data');
  const reasons = Object.fromEntries(response.json().excluded.map((item) => [item.snapshotId, item.reason]));
  assert.match(reasons['validation-4'] || '', /标注.*10%/);
  assert.match(reasons['validation-0'], /发生变化/);
  assert.match(reasons['validation-1'], /PTZ.*无效/);
  assert.match(reasons['validation-2'], /通道/);
  assert.match(reasons['validation-3'], /尺寸/);
  assert.equal(reasons['validation-5'], '已人工忽略');
});

test('原图向上偏差为负，相同角度在双倍尺寸下像素差翻倍且保存后更新', async (t) => {
  let firstSnapshot;
  const f = await independentValidationFixture(t, { transformSnapshot: (snapshot, index) => {
    if (index === 0) firstSnapshot = snapshot;
    return index === 1 ? { ...snapshot, width: firstSnapshot.width * 2, height: firstSnapshot.height * 2, ptz: firstSnapshot.ptz } : snapshot;
  } });
  const items = (await f.app.inject(`/api/recognition-tasks/${f.validationTask.id}/items`)).json().items;
  const original = items.find((item) => item.snapshotId === 'validation-0');
  const points = original.points.map((point) => ({ ...point, y: point.y - 6 / original.snapshot.height }));
  for (const revision of [0, 1]) {
    const saved = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.validationTask.id}/items/validation-${revision}`,
      payload: { revision, points } });
    assert.equal(saved.statusCode, 200, saved.body);
  }
  assert.equal((await f.validate()).statusCode, 409, '不能使用保存前的版本');
  const response = await f.validate({ revision: 2 });
  assert.equal(response.statusCode, 200, response.body);
  const low = response.json().perSnapshot.find((row) => row.snapshotId === 'validation-0');
  const high = response.json().perSnapshot.find((row) => row.snapshotId === 'validation-1');
  assert.equal(high.width, 2 * low.width);
  assert.equal(high.height, 2 * low.height);
  assert.deepEqual(high.theoreticalHorizon, low.theoreticalHorizon);
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(low.verticalResiduals[index].offsetPixels + 6) < 0.05);
    assert.ok(Math.abs(high.verticalResiduals[index].offsetPixels - 2 * low.verticalResiduals[index].offsetPixels) < 1e-8);
  }
  assert.ok(Math.abs(high.rmsResidualPixels - 2 * low.rmsResidualPixels) < 1e-8);
  assert.ok(Math.abs(high.rmsAngularResidualDegrees - low.rmsAngularResidualDegrees) < 1e-10);
});

test('原图标注左右反向偏移保留方向差和几何误差，中心偏差不能代替全部测量', async (t) => {
  const f = await independentValidationFixture(t);
  const items = (await f.app.inject(`/api/recognition-tasks/${f.validationTask.id}/items`)).json().items;
  const original = items.find((item) => item.snapshotId === 'validation-0');
  const saved = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.validationTask.id}/items/${original.snapshotId}`,
    payload: { revision: 0, points: original.points.map((point, index) => ({ ...point, y: point.y + (index ? 8 : -8) / original.snapshot.height })) } });
  assert.equal(saved.statusCode, 200, saved.body);
  const response = await f.validate({ revision: 1 });
  assert.equal(response.statusCode, 200, response.body);
  const row = response.json().perSnapshot.find((entry) => entry.snapshotId === original.snapshotId);
  assert.ok(Math.abs(row.verticalResiduals[0].offsetPixels + 8) < 0.05);
  assert.ok(Math.abs(row.verticalOffsetPixels) < 0.05);
  assert.ok(Math.abs(row.verticalResiduals[2].offsetPixels - 8) < 0.05);
  assert.ok(row.directionDifferenceDegrees > 1 && row.directionDifferenceDegrees < 1.3);
  assert.ok(row.rmsResidualPixels > 7.9 && row.rmsAngularResidualDegrees > 0);
});

test('已应用基准仍可测量，来源正式标注变化或参与截图删除后不能继续使用旧基准', async (t) => {
  const f = await independentValidationFixture(t);
  const applied = await post(f, f.reference.id, 'apply', 0);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal((await f.validate()).statusCode, 200);
  const deleted = await f.app.inject({ method: 'DELETE', url: `/api/snapshots/${f.reference.result.sourceSnapshotIds[0]}` });
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await f.validate()).statusCode, 409);
  const edited = await f.app.inject({ method: 'PUT', url: `/api/recognition-tasks/${f.reference.id}/items/${f.reference.result.sourceSnapshotIds[1]}`,
    payload: { revision: 0, ignored: true } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await f.validate()).statusCode, 409);
});

test('原图基准来源拒绝历史预扫粗结果，未知来源保持未找到响应', async (t) => {
  const f = await independentValidationFixture(t, { referencePhase: 'coarse' });
  const response = await f.validate();
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().message, /历史预扫粗结果仅供查看/);
  assert.equal((await f.validate({ referenceTaskId: 'unknown-reference' })).statusCode, 404);
});

test('正式标注保存和回读保留 0.001 原图像素的变化', async (t) => {
  const f = await fixture(t);
  const task = await createAndWait(f);
  const path = `/api/recognition-tasks/${task.id}/items`;
  const original = (await f.app.inject(`${path}?limit=1`)).json().items[0];
  const height = original.snapshot.height;
  const points = original.points.map((point) => ({ ...point, y: point.y + 0.001 / height }));
  const saved = await f.app.inject({ method: 'PUT', url: `${path}/${original.snapshotId}`, payload: { revision: task.revision, points } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().item.points, points);
  const reloaded = (await f.app.inject(`${path}?limit=1`)).json().items[0];
  assert.deepEqual(reloaded.points, points);
  assert.ok(Math.abs((reloaded.points[0].y - original.points[0].y) * height - 0.001) < 1e-10);
});

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
