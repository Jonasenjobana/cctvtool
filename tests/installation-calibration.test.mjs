import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInstallation } from '../server/tilt-calibration.mjs';
import { syntheticSnapshots, fixtureCamera, fixtureRange } from './calibration-fixtures.mjs';
import { horizonDiscontinuities } from '../server/recognition.mjs';

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

test('四参数拟合拒绝不足或狭窄方向，错误标注不能得到可应用结果', () => {
  const narrow = syntheticSnapshots({ pans: [0, 5, 10] });
  assert.equal(estimateInstallation(fixtureCamera, narrow.snapshots, narrow.observations, fixtureRange).status, 'insufficient_data');
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
