import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInstallation } from '../server/tilt-calibration.mjs';
import { fixtureCamera, fixtureRange, syntheticSnapshots } from './calibration-fixtures.mjs';

const installation = { pAxisPitch: 0.02, pAxisRoll: -0.03, tiltOffset: 0.01, imageRoll: 0.05 };
const camera = { ...fixtureCamera, ...installation };
function validationData() {
  const data = syntheticSnapshots({ camera, pitch: installation.pAxisPitch, roll: installation.pAxisRoll,
    pans: [40, 91, 146, 200, 240], ptzOverrides: { Tilt: 0.1, Zoom: 53.7, HorizontalFieldAngle: 1.37, VerticalFieldAngle: 0.77 } });
  data.observations.forEach((observation) => observation.points.splice(1, 1));
  return data;
}

test('独立复核固定安装参数，在不同 P 的高倍样本上计算误差，不修改输入', () => {
  const data = validationData(), before = JSON.stringify({ camera, data });
  const result = evaluateInstallation(camera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.installation, installation);
  assert.ok(result.rmsResidualPixels < 1e-6);
  assert.equal(result.perSnapshot.length, data.snapshots.length);
  assert.equal(JSON.stringify({ camera, data }), before);
});

test('高倍标注垂直偏移时复核失败并保留有符号偏差，不通过重新拟合吸收误差', () => {
  const data = validationData();
  data.observations.forEach((observation, index) => observation.points.forEach((point) => { point.y += 10 / data.snapshots[index].height; }));
  const result = evaluateInstallation(camera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.installation, installation);
  for (const row of result.perSnapshot) {
    assert.ok(row.rmsResidualPixels > 9.9);
    assert.ok(Math.abs(row.verticalOffsetPixels - 10) < 0.02);
    assert.ok(row.rmsAngularResidualDegrees > 0);
  }
  assert.equal(result.failedSnapshotIds.length, data.snapshots.length);
});

test('相同角度误差在双倍分辨率下像素误差翻倍，角度误差保持一致', () => {
  const data = validationData(), snapshot = data.snapshots[0], observation = data.observations[0];
  observation.points.forEach((point) => { point.y += 6 / snapshot.height; });
  const low = evaluateInstallation(camera, [snapshot], [observation], fixtureRange);
  const high = evaluateInstallation(camera, [{ ...snapshot, width: snapshot.width * 2, height: snapshot.height * 2 }], [observation], fixtureRange);
  assert.ok(Math.abs(high.rmsResidualPixels - 2 * low.rmsResidualPixels) < 1e-8);
  assert.ok(Math.abs(high.rmsAngularResidualDegrees - low.rmsAngularResidualDegrees) < 1e-10);
});

test('总体 RMS 低于门槛时，单张超差仍不能宣称全部复核通过', () => {
  const data = validationData();
  data.observations[0].points.forEach((point) => { point.y += 8 / data.snapshots[0].height; });
  const result = evaluateInstallation(camera, data.snapshots, data.observations, fixtureRange);
  assert.ok(result.rmsResidualPixels < 5);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failedSnapshotIds, [data.snapshots[0].id]);
});

test('固定参数将理论海天线移出图像时保留超差，垂直偏差返回空值', () => {
  const data = validationData();
  const result = evaluateInstallation({ ...camera, tiltOffset: camera.tiltOffset + 2 }, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'failed');
  assert.ok(result.perSnapshot.every((row) => row.verticalOffsetPixels === null && row.rmsResidualPixels > 5));
});

test('复核明确排除移动样本，无有效样本时不宣称通过', () => {
  const data = validationData();
  data.snapshots.forEach((snapshot) => { snapshot.poseChanged = true; });
  const result = evaluateInstallation(camera, data.snapshots, data.observations, fixtureRange);
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.excluded.length, data.snapshots.length);
  assert.equal(result.rmsResidualPixels, null);
});
