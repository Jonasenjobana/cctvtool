import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Ellipsoid, IntersectionTests, Ray } from 'cesium';
import { estimateInstallation } from '../server/tilt-calibration.mjs';
import { syntheticSnapshots, fixtureCamera, fixtureRange } from './calibration-fixtures.mjs';
import { horizonDiscontinuities } from '../server/recognition.mjs';
import { createCameraPose } from '../src/app/camera-math.ts';

function rayAngularResidual(calibration, snapshot, point) {
  const raw = snapshot.ptz.raw;
  const pose = createCameraPose(calibration, raw);
  const direction = Cartesian3.clone(pose.direction);
  Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.right,
    (2 * point.x - 1) * Math.tan(raw.HorizontalFieldAngle * Math.PI / 360), new Cartesian3()), direction);
  Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.up,
    (1 - 2 * point.y) * Math.tan(raw.VerticalFieldAngle * Math.PI / 360), new Cartesian3()), direction);
  const scaled = Cartesian3.normalize(Cartesian3.multiplyComponents(
    direction, Ellipsoid.WGS84.oneOverRadii, new Cartesian3(),
  ), new Cartesian3());
  const radial = Cartesian3.normalize(Cartesian3.multiplyComponents(
    pose.position, Ellipsoid.WGS84.oneOverRadii, new Cartesian3(),
  ), new Cartesian3());
  const up = Cartesian3.normalize(Cartesian3.subtract(radial,
    Cartesian3.multiplyByScalar(scaled, Cartesian3.dot(radial, scaled), new Cartesian3()), new Cartesian3()), new Cartesian3());
  // 独立旋转真实观测射线，以椭球命中分界测量需要补偿的角度，不复算拟合器的反正弦残差。
  const hits = (degrees) => {
    const angle = degrees * Math.PI / 180;
    const rotated = Cartesian3.add(Cartesian3.multiplyByScalar(scaled, Math.cos(angle), new Cartesian3()),
      Cartesian3.multiplyByScalar(up, Math.sin(angle), new Cartesian3()), new Cartesian3());
    Cartesian3.multiplyComponents(rotated, Ellipsoid.WGS84.radii, rotated);
    const hit = IntersectionTests.rayEllipsoid(new Ray(pose.position, rotated), Ellipsoid.WGS84);
    return Boolean(hit && hit.start > 0);
  };
  let sea = -1, sky = 1;
  assert.ok(hits(sea) && !hits(sky));
  for (let iteration = 0; iteration < 50; iteration++) {
    const middle = (sea + sky) / 2;
    if (hits(middle)) sea = middle; else sky = middle;
  }
  return -(sea + sky) / 2;
}

for (const fixed of [false, true]) {
  test(`四参数恢复已知安装姿态，${fixed ? '固定 T/Z 扫描' : '不同 T/Z 与尺寸'}`, () => {
    const actual = { ...fixtureCamera, tiltOffset: 1.1, imageRoll: -0.8 };
    const { snapshots, observations } = syntheticSnapshots({ camera: actual,
      ...(fixed ? { ptzOverrides: { Tilt: 2, Zoom: 8.8, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5 } } : {}) });
    const result = estimateInstallation(fixtureCamera, snapshots, observations, fixtureRange);
    assert.equal(result.status, 'estimated', JSON.stringify(result));
    for (const [key, value] of Object.entries({ pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 1.1, imageRoll: -0.8 })) {
      assert.ok(Math.abs(result.installation[key] - value) < 1e-5, key);
    }
    assert.equal(result.applied, false);
    assert.ok(result.diagnostics.conditionNumber < 1e8);
  });
}

test('四参数拟合角度 RMS 来自参与图像的真实观测射线残差', () => {
  const { snapshots, observations } = syntheticSnapshots();
  observations.forEach((observation, index) => observation.points.forEach((point, column) => {
    point.y += ((index + column) % 2 ? 1 : -1) / snapshots[index].height;
  }));
  const result = estimateInstallation(fixtureCamera, snapshots, observations, fixtureRange);
  assert.equal(result.status, 'estimated');
  const calibration = { ...fixtureCamera, ...result.installation };
  const perImageSquares = observations.map((observation, index) => observation.points.reduce((sum, point) =>
    sum + rayAngularResidual(calibration, snapshots[index], point) ** 2, 0) / observation.points.length);
  const expected = Math.sqrt(perImageSquares.reduce((sum, value) => sum + value, 0) / snapshots.length);
  assert.ok(expected > 0.001);
  assert.ok(Math.abs(result.diagnostics.rmsAngularResidualDegrees - expected) < 1e-7,
    JSON.stringify({ actual: result.diagnostics.rmsAngularResidualDegrees, expected }));
});

test('四参数拟合接受两张或跨 0° 的 22° 样本，仍要求可辨识并恢复真实参数', () => {
  const actual = { ...fixtureCamera, tiltOffset: 1.1, imageRoll: -0.8 };
  for (const pans of [[0, 120], [347, 358, 9]]) {
    const data = syntheticSnapshots({ camera: actual, pans,
      ptzOverrides: { Tilt: 2, Zoom: 8.8, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5 } });
    data.observations.forEach((observation) => { observation.points.splice(1, 1); });
    const before = JSON.stringify(data);
    const result = estimateInstallation(fixtureCamera, data.snapshots, data.observations, fixtureRange);
    assert.equal(result.status, 'estimated', JSON.stringify({ pans, result }));
    for (const [key, value] of Object.entries({ pAxisPitch: 1.25, pAxisRoll: -2.1, tiltOffset: 1.1, imageRoll: -0.8 })) {
      assert.ok(Math.abs(result.installation[key] - value) < 1e-4, key);
    }
    assert.ok(result.diagnostics.conditionNumber < 1e8);
    assert.equal(JSON.stringify(data), before);
  }
});

test('四参数拟合对单张或重复姿态保留不可辨识检查，不输出可应用参数', () => {
  for (const pans of [[0], [0, 0, 0]]) {
    const data = syntheticSnapshots({ pans,
      ptzOverrides: { Tilt: 2, Zoom: 8.8, HorizontalFieldAngle: 24, VerticalFieldAngle: 13.5 } });
    data.observations.forEach((observation) => { observation.points.splice(1, 1); });
    const result = estimateInstallation(fixtureCamera, data.snapshots, data.observations, fixtureRange);
    assert.equal(result.status, 'unreliable', JSON.stringify({ pans, result }));
    assert.equal(result.installation, null);
    assert.ok(result.diagnostics.conditionNumber === null || result.diagnostics.conditionNumber >= 1e8);
  }
});

test('四参数拟合没有有效停稳样本时返回数据不足', () => {
  const data = syntheticSnapshots();
  const empty = estimateInstallation(fixtureCamera, data.snapshots, [], fixtureRange);
  assert.equal(empty.status, 'insufficient_data');
  assert.equal(empty.installation, null);
  data.snapshots.forEach((snapshot) => { snapshot.poseChanged = true; });
  const excluded = estimateInstallation(fixtureCamera, data.snapshots, data.observations, fixtureRange);
  assert.equal(excluded.status, 'insufficient_data');
  assert.equal(excluded.installation, null);
  assert.equal(excluded.excluded.length, data.snapshots.length);
});

test('四参数拟合的错误标注不能得到可应用结果', () => {
  const { snapshots, observations } = syntheticSnapshots();
  observations[2].points = [{ x: 0.1, y: 0.05 }, { x: 0.9, y: 0.95 }];
  const result = estimateInstallation(fixtureCamera, snapshots, observations, fixtureRange);
  assert.equal(result.status, 'unreliable');
  assert.equal(result.installation, null);
});

test('四参数使用合法点位与相同设备样本，忽略无效采样', () => {
  const { snapshots, observations } = syntheticSnapshots();
  snapshots[0].poseChanged = true;
  const result = estimateInstallation(fixtureCamera, snapshots, observations, fixtureRange);
  assert.equal(result.status, 'estimated');
  assert.equal(result.excluded[0].snapshotId, snapshots[0].id);
  observations[1].points[0].y = 2;
  assert.throws(() => estimateInstallation(fixtureCamera, snapshots, observations, fixtureRange), /归一化/);
});

test('同组局部突变过滤不会把图像分辨率变化当作高度跳变', () => {
  const angles = [1, 1.3, 0.8, -9.56, 9.72, 1.2, 0.9, 1.1, 1];
  const items = angles.map((angle, index) => {
    const width = index % 2 ? 1920 : 960, height = width * 9 / 16;
    const offset = Math.tan(angle * Math.PI / 180) * 0.4 * width / height;
    return { snapshotId: String(index), detectedPoints: [{ x: 0.1, y: 0.5 - offset }, { x: 0.9, y: 0.5 + offset }],
      snapshot: { width, height, ptz: { raw: { Pan: index * 7, Tilt: 2, Zoom: 8.8, HorizontalFieldAngle: 7.3, VerticalFieldAngle: 4.03 } } } };
  });
  assert.deepEqual([...horizonDiscontinuities(items).keys()].sort(), ['3', '4']);
  assert.equal(horizonDiscontinuities(items.slice(0, 1)).size, 0);
});
