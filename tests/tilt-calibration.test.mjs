import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationRange, estimatePAxisTilt, panCoverage } from '../server/tilt-calibration.mjs';
import { fixtureCamera, fixtureRange, syntheticSnapshots } from './calibration-fixtures.mjs';

test('从独立射线生成的海天线恢复 P 轴倾斜，包含高度与不同分辨率/FOV', () => {
  for (const height of [6.6, 100]) {
    const camera = { ...fixtureCamera, height };
    const data = syntheticSnapshots({ camera });
    const before = JSON.stringify({ camera, data });
    const result = estimatePAxisTilt(camera, data.snapshots, data.observations, fixtureRange);
    assert.equal(result.status, 'estimated', JSON.stringify(result));
    assert.ok(Math.abs(result.installation.pAxisPitch - 1.25) < 0.00001);
    assert.ok(Math.abs(result.installation.pAxisRoll + 2.1) < 0.00001);
    assert.ok(result.diagnostics.rmsResidualPixels < 0.0001);
    assert.equal(result.fixedCalibration.panOffset, 93.2);
    assert.equal(result.applied, false);
    assert.equal(JSON.stringify({ camera, data }), before);
  }
});

test('轻微图像标注误差仍可拟合，明显误标不能作为有效倾斜数据输出', () => {
  const data = syntheticSnapshots();
  data.observations.forEach((observation, index) => observation.points.forEach((point, column) => {
    point.y += ((index + column) % 2 ? 0.4 : -0.4) / data.snapshots[index].height;
  }));
  const result = estimatePAxisTilt(fixtureCamera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'estimated');
  assert.ok(Math.abs(result.installation.pAxisPitch - 1.25) < 0.01);
  assert.ok(result.diagnostics.rmsResidualPixels < 1);
  data.observations[0].points.forEach((point) => { point.y += 50 / data.snapshots[0].height; });
  const bad = estimatePAxisTilt(fixtureCamera, data.snapshots, data.observations, fixtureRange);
  assert.equal(bad.status, 'unreliable');
  assert.equal(bad.installation, null);
  assert.ok(bad.diagnostics.perSnapshot[0].rmsResidualPixels > 5);
});

test('P 轴拟合固定采用当前 T 偏移和画面 Roll，非零修正不会被误算成 P 轴倾斜', () => {
  const camera = { ...fixtureCamera, tiltOffset: 1.64, imageRoll: 0.73 };
  const data = syntheticSnapshots({ camera });
  for (const snapshot of data.snapshots) snapshot.calibration = { ...snapshot.calibration, tiltOffset: 0, imageRoll: 0 };
  const result = estimatePAxisTilt(camera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'estimated', JSON.stringify(result));
  assert.ok(Math.abs(result.installation.pAxisPitch - 1.25) < 0.00001);
  assert.ok(Math.abs(result.installation.pAxisRoll + 2.1) < 0.00001);
  assert.equal(result.fixedCalibration.tiltOffset, 1.64);
  assert.equal(result.fixedCalibration.imageRoll, 0.73);
  assert.ok(result.diagnostics.rmsResidualPixels < 0.0001);
  assert.throws(() => estimatePAxisTilt({ ...camera, tiltOffset: NaN }, data.snapshots, data.observations, fixtureRange), /T 偏移/);
});

test('样本不足、P 方向集中、移动样本和无效原始数据明确报告', () => {
  const data = syntheticSnapshots();
  const one = estimatePAxisTilt(fixtureCamera, data.snapshots, data.observations.slice(0, 1), fixtureRange);
  assert.equal(one.status, 'insufficient_data');
  assert.equal(one.installation, null);
  const narrow = syntheticSnapshots({ pans: [359, 1, 4] });
  assert.equal(estimatePAxisTilt(fixtureCamera, narrow.snapshots, narrow.observations, fixtureRange).status, 'insufficient_data');
  data.snapshots[0].poseChanged = true;
  data.snapshots[1].ptz.raw.HorizontalFieldAngle = null;
  data.snapshots[2].serial = 'another-device';
  const result = estimatePAxisTilt(fixtureCamera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'estimated', JSON.stringify(result));
  assert.equal(result.excluded.length, 3);
  assert.deepEqual(result.sourceSnapshotIds, ['synthetic-3', 'synthetic-4', 'synthetic-5']);
});

test('拒绝摄像头/时间串样、重复截图、错误标注与缺失安装位置', () => {
  const data = syntheticSnapshots();
  assert.throws(() => estimatePAxisTilt({ ...fixtureCamera, longitude: null }, data.snapshots, data.observations, fixtureRange), /经纬度/);
  assert.throws(() => estimatePAxisTilt(fixtureCamera, data.snapshots, [...data.observations, data.observations[0]], fixtureRange), /重复/);
  assert.throws(() => estimatePAxisTilt(fixtureCamera, [{ ...data.snapshots[0], cameraId: 'other' }], data.observations.slice(0, 1), fixtureRange), /摄像头或时间段/);
  assert.throws(() => estimatePAxisTilt(fixtureCamera, data.snapshots, data.observations,
    { startTime: '2026-11-09T00:30:00Z', endTime: '2026-11-09T01:00:00Z' }), /摄像头或时间段/);
  const wrong = [{ snapshotId: data.snapshots[0].id, points: [{ x: -1, y: 0.5 }, { x: 1, y: 0.5 }] }];
  assert.throws(() => estimatePAxisTilt(fixtureCamera, data.snapshots, wrong, fixtureRange), /归一化/);
});

test('时间段采用明确时区，跨 P 零点按圆周覆盖计算', () => {
  assert.deepEqual(calibrationRange('2026-11-09T08:00:00+08:00', '2026-11-09T09:00:00+08:00'),
    { startTime: '2026-11-09T00:00:00.000Z', endTime: '2026-11-09T01:00:00.000Z' });
  assert.throws(() => calibrationRange('2026-11-09T08:00:00', '2026-11-09T09:00:00'), /时区/);
  assert.throws(() => calibrationRange('2026-11-09T09:00:00Z', '2026-11-09T08:00:00Z'), /时间段/);
  assert.deepEqual(panCoverage([350, 10, 30]), { distinctPanCount: 3, panCoverageDegrees: 40 });
});
