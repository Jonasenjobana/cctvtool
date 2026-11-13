import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Matrix4, Transforms } from 'cesium';
import { createCameraPose, footprintSegments, frustumCorners, observationFov, pointTargetPtz, videoFovPlane } from '../src/app/camera-math.ts';
import type { CameraDraft, RawPtz } from '../src/app/models.ts';

const camera: CameraDraft = {
  name: 'test', serial: '01', code: '02', longitude: 113.9, latitude: 22.1, height: 100,
  pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0,
};
const ptz: RawPtz = { Pan: 0, Tilt: 0, Zoom: 15, HorizontalFieldAngle: 4.32, VerticalFieldAngle: 2.43 };
const near = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} ≠ ${b}`);

test('无底座倾斜时安装朝向与 P 角偏移等价，原始 PTZ 保持不变，零值位置有效', () => {
  const position = { ...camera, longitude: 0, latitude: 0, height: 0 };
  const pose = createCameraPose({ ...position, panOffset: 90 }, ptz);
  const enu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(pose.position), new Matrix4());
  const direction = Matrix4.multiplyByPointAsVector(enu, pose.direction, new Cartesian3());
  near(direction.x, 1);
  near(direction.y, 0);
  near(direction.z, 0);
  near(Cartesian3.distance(pose.direction, createCameraPose(position, { ...ptz, Pan: 90 }).direction), 0);
  assert.equal(ptz.Pan, 0);
});

test('倾斜 P 轴固定，转 P 等价于绕该世界轴的独立 Rodrigues 旋转', () => {
  const setup = { ...camera, pAxisPitch: 12, pAxisRoll: -7, panOffset: 17 };
  const before = createCameraPose(setup, { ...ptz, Pan: 30, Tilt: 6 });
  const after = createCameraPose(setup, { ...ptz, Pan: 120, Tilt: 6 });
  near(Cartesian3.distance(before.panAxis, after.panAxis), 0);
  const axis = before.panAxis;
  const angle = -Math.PI / 2;
  const rotated = Cartesian3.multiplyByScalar(before.direction, Math.cos(angle), new Cartesian3());
  Cartesian3.add(rotated, Cartesian3.multiplyByScalar(Cartesian3.cross(axis, before.direction, new Cartesian3()), Math.sin(angle), new Cartesian3()), rotated);
  Cartesian3.add(rotated, Cartesian3.multiplyByScalar(axis, Cartesian3.dot(axis, before.direction) * (1 - Math.cos(angle)), new Cartesian3()), rotated);
  near(Cartesian3.distance(rotated, after.direction), 0);
  near(Cartesian3.dot(after.right, after.direction), 0);
  near(Cartesian3.dot(Cartesian3.cross(after.right, after.direction, new Cartesian3()), after.up), 1);
});

test('视锥严格使用接口 HFOV/VFOV，与 Zoom 的取值范围无关', () => {
  const pose = createCameraPose(camera, { ...ptz, Zoom: 999 });
  const [corner] = frustumCorners(pose, 100);
  const relative = Cartesian3.subtract(corner, pose.position, new Cartesian3());
  near(Cartesian3.dot(relative, pose.direction), 100, 1e-7);
  near(Cartesian3.dot(relative, pose.right), -100 * Math.tan(4.32 * Math.PI / 360), 1e-7);
  near(Cartesian3.dot(relative, pose.up), 100 * Math.tan(2.43 * Math.PI / 360), 1e-7);
  const changed = createCameraPose(camera, { ...ptz, HorizontalFieldAngle: 8 });
  assert.ok(Cartesian3.distance(frustumCorners(changed, 100)[0], changed.position) > Cartesian3.distance(corner, pose.position));
  for (const bad of [null, 0, -1, 180, NaN]) {
    assert.throws(() => createCameraPose(camera, { ...ptz, HorizontalFieldAngle: bad }), /视场角/);
  }
  assert.throws(() => createCameraPose({ ...camera, longitude: null }, ptz), /经度/);
});

test('最佳观察在横竖视口均将完整画面限制在约 65% 范围', () => {
  const pose = createCameraPose(camera, ptz);
  for (const aspect of [0.5, 1, 16 / 9, 3]) {
    const fov = observationFov(pose, aspect);
    const tanVertical = Math.tan(fov / 2) / Math.max(1, aspect);
    const horizontalRatio = Math.tan(pose.horizontalFov * Math.PI / 360) / (tanVertical * aspect);
    const verticalRatio = Math.tan(pose.verticalFov * Math.PI / 360) / tanVertical;
    assert.ok(horizontalRatio <= 0.650000001);
    assert.ok(verticalRatio <= 0.650000001);
    near(Math.max(horizontalRatio, verticalRatio), 0.65);
  }
});

test('覆盖线只包含有限距离内的正向椭球交点，朝天时没有虚假覆盖', () => {
  const down = createCameraPose(camera, { ...ptz, Tilt: 30 });
  const segments = footprintSegments(down);
  assert.ok(segments.length > 0);
  for (const point of segments.flat()) {
    assert.ok(Cartesian3.distance(point, down.position) < 10000);
    near(Cartographic.fromCartesian(point).height, 0, 1e-5);
  }
  assert.deepEqual(footprintSegments(down, 10), []);
  assert.deepEqual(footprintSegments(createCameraPose(camera, { ...ptz, Tilt: -30 })), []);
});

test('视频截面四角与原始 FOV 一致，随倾斜 P 轴和 PTZ 变化，画面方向正确', () => {
  for (const pan of [0, 93, 359]) {
    const pose = createCameraPose({ ...camera, pAxisPitch: 12, pAxisRoll: -7, panOffset: 17 }, { ...ptz, Pan: pan, Tilt: 15 });
    const plane = videoFovPlane(pose, 500);
    const vertices = [[-.5, .5], [.5, .5], [.5, -.5], [-.5, -.5]];
    const expected = frustumCorners(pose, 500);
    vertices.forEach(([x, y], index) => {
      const actual = Matrix4.multiplyByPoint(plane.matrix, new Cartesian3(x, y, 0), new Cartesian3());
      near(Cartesian3.distance(actual, expected[index]), 0, 1e-8);
    });
    const center = Matrix4.multiplyByPoint(plane.matrix, Cartesian3.ZERO, new Cartesian3());
    near(Cartesian3.distance(center, pose.position), 500, 1e-8);
    const normal = Matrix4.multiplyByPointAsVector(plane.matrix, Cartesian3.UNIT_Z, new Cartesian3());
    near(Cartesian3.dot(normal, pose.direction), -1);
  }
});

test('视频完整像素与两个独立 FOV 对应，和同一空间点的投影重合', () => {
  for (const [horizontalFov, verticalFov] of [[17.11, 9.62], [30.8, 17.94], [80, 30]]) {
    const pose = createCameraPose(camera, { ...ptz, HorizontalFieldAngle: horizontalFov, VerticalFieldAngle: verticalFov });
    const plane = videoFovPlane(pose, 500);
    const inverse = Matrix4.inverse(plane.matrix, new Matrix4());
    for (const [x, y] of [[0, 0], [0.15, 0.2], [0.5, 0.5], [0.9, 0.85], [1, 1]]) {
      const point = Cartesian3.add(pose.position, Cartesian3.multiplyByScalar(pose.direction, 500, new Cartesian3()), new Cartesian3());
      Cartesian3.add(point, Cartesian3.multiplyByScalar(pose.right,
        500 * (2 * x - 1) * Math.tan(horizontalFov * Math.PI / 360), new Cartesian3()), point);
      Cartesian3.add(point, Cartesian3.multiplyByScalar(pose.up,
        500 * (1 - 2 * y) * Math.tan(verticalFov * Math.PI / 360), new Cartesian3()), point);
      const local = Matrix4.multiplyByPoint(inverse, point, new Cartesian3());
      near(0.5 + local.x * plane.uvScale.x, x, 1e-8);
      near(0.5 - local.y * plane.uvScale.y, y, 1e-8);
    }
    assert.equal(pose.horizontalFov, horizontalFov);
    assert.equal(pose.verticalFov, verticalFov);
  }
});

test('T 偏移正值上抬，画面 Roll 绕最终光轴旋转，两者不改变 P 轴或原始 PTZ', () => {
  const angle = 0.73 * Math.PI / 180;
  const setup = { ...camera, pAxisPitch: 12, pAxisRoll: -7, panOffset: 17 };
  for (const pan of [0, 90, 207]) {
    const reading = { ...ptz, Pan: pan, Tilt: 30 };
    const original = { ...reading };
    const base = createCameraPose(setup, { ...reading, Tilt: 30 - 1.64 });
    const corrected = createCameraPose({ ...setup, tiltOffset: 1.64, imageRoll: 0.73 }, reading);
    near(Cartesian3.distance(base.direction, corrected.direction), 0);
    near(Cartesian3.distance(base.panAxis, corrected.panAxis), 0);
    const expectedRight = Cartesian3.add(
      Cartesian3.multiplyByScalar(base.right, Math.cos(angle), new Cartesian3()),
      Cartesian3.multiplyByScalar(base.up, -Math.sin(angle), new Cartesian3()), new Cartesian3());
    near(Cartesian3.distance(expectedRight, corrected.right), 0);
    near(Cartesian3.dot(corrected.right, corrected.up), 0);
    assert.deepEqual(reading, original);
  }
  assert.throws(() => createCameraPose({ ...camera, tiltOffset: null }, ptz), /T 偏移/);
  assert.throws(() => createCameraPose({ ...camera, imageRoll: NaN }, ptz), /Roll/);
});

test('P 轴前后倾与局部 T 偏移在一个 P 朝向相似，转 P 后不可互换', () => {
  const fromMount = (pan: number) => createCameraPose({ ...camera, pAxisPitch: 5 }, { ...ptz, Pan: pan });
  const fromTilt = (pan: number) => createCameraPose({ ...camera, tiltOffset: 5 }, { ...ptz, Pan: pan });
  near(Cartesian3.distance(fromMount(0).direction, fromTilt(0).direction), 0);
  assert.ok(Cartesian3.distance(fromMount(90).direction, fromTilt(90).direction) > 0.05);
  assert.ok(Cartesian3.distance(fromMount(90).panAxis, fromTilt(90).panAxis) > 0.05);
});

test('临时点反算的原始 P/T 将光轴指向目标，覆盖安装倾斜、偏移和不同当前姿态', () => {
  for (const setup of [camera, { ...camera, pAxisPitch: 12, pAxisRoll: -7, panOffset: 17, tiltOffset: 1.64, imageRoll: 23 }]) {
    for (const target of [
      { longitude: 113.91, latitude: 22.1 }, { longitude: 113.9, latitude: 22.11 },
      { longitude: 113.88, latitude: 22.09 }, { longitude: 113.94, latitude: 22.13 },
    ]) {
      for (const [Pan, Tilt] of [[0, 0], [359, 30], [180, -30], [90, 60]]) {
        const reading = { ...ptz, Pan, Tilt, Zoom: 8.8 };
        const original = { ...reading };
        const result = pointTargetPtz(setup, reading, target);
        const pose = createCameraPose(setup, { ...reading, Pan: result.pan, Tilt: result.tilt });
        const expected = Cartesian3.normalize(Cartesian3.subtract(
          Cartesian3.fromDegrees(target.longitude, target.latitude, 0), pose.position, new Cartesian3(),
        ), new Cartesian3());
        near(Cartesian3.distance(pose.direction, expected), 0, 1e-10);
        assert.ok(result.pan >= 0 && result.pan < 360);
        assert.ok(result.tilt >= -90 && result.tilt <= 90);
        assert.equal(result.zoom, 8.8);
        assert.deepEqual(reading, original);
      }
    }
  }
});

test('临时点反算在有符号 T 范围内选择较近的解，竖直指向保留当前 P', () => {
  const target = { longitude: camera.longitude!, latitude: camera.latitude! + 0.01 };
  const normal = pointTargetPtz(camera, { ...ptz, Pan: 180, Tilt: 0 }, target);
  assert.ok(normal.tilt < 90);
  near(Math.min(normal.pan, 360 - normal.pan), 0, 1e-8);
  const tilted = { ...camera, pAxisPitch: -25, tiltOffset: 80 };
  const forward = pointTargetPtz(tilted, { ...ptz, Pan: 0, Tilt: 60 }, target);
  assert.ok(forward.tilt > 0 && forward.tilt < 90);
  near(Math.min(forward.pan, 360 - forward.pan), 0, 1e-8);
  const inverted = pointTargetPtz(tilted, { ...ptz, Pan: 180, Tilt: -80 }, target);
  assert.ok(inverted.tilt > -90 && inverted.tilt < 0);
  near(inverted.pan, 180, 1e-8);
  const vertical = pointTargetPtz({ ...camera, longitude: 0, latitude: 0 }, { ...ptz, Pan: 123, Tilt: 25 }, {
    longitude: 0, latitude: 0,
  });
  near(vertical.pan, 123, 1e-8);
  near(vertical.tilt, 90, 1e-8);
});

test('临时点反算随位置高度更新，保持倍率且不依赖 FOV 或画面 Roll', () => {
  const setup = { ...camera, longitude: 0, latitude: 0 };
  const target = { longitude: 0, latitude: 0.01 };
  const reading = { Pan: 30, Tilt: 10, Zoom: 37 };
  const low = pointTargetPtz(setup, reading, target);
  const high = pointTargetPtz({ ...setup, height: 200 }, reading, target);
  assert.ok(high.tilt > low.tilt);
  const east = pointTargetPtz(setup, reading, { longitude: 0.01, latitude: 0 });
  near(east.pan, 90, 1e-8);
  assert.deepEqual(pointTargetPtz({ ...setup, imageRoll: 71 }, reading, target), low);
  assert.equal(high.zoom, 37);
});

test('临时点反算在跨经度 180°和极区使用同一 WGS84 目标方向', () => {
  for (const [setup, target] of [
    [{ ...camera, longitude: 179.99, latitude: 55 }, { longitude: -179.99, latitude: 55.001 }],
    [{ ...camera, longitude: 0, latitude: 90 }, { longitude: 120, latitude: 89.99 }],
  ] as [CameraDraft, { longitude: number; latitude: number }][]) {
    const result = pointTargetPtz(setup, ptz, target);
    const pose = createCameraPose(setup, { ...ptz, Pan: result.pan, Tilt: result.tilt });
    const expected = Cartesian3.normalize(Cartesian3.subtract(
      Cartesian3.fromDegrees(target.longitude, target.latitude, 0), pose.position, new Cartesian3(),
    ), new Cartesian3());
    near(Cartesian3.distance(pose.direction, expected), 0, 1e-10);
  }
});

test('临时点反算明确拒绝缺少安装参数、非法读数、重合及椭球遮挡的目标', () => {
  const target = { longitude: 113.91, latitude: 22.1 };
  assert.throws(() => pointTargetPtz({ ...camera, height: null }, ptz, target), /高度/);
  assert.throws(() => pointTargetPtz({ ...camera, pAxisPitch: null }, ptz, target), /前后倾/);
  assert.throws(() => pointTargetPtz(camera, { ...ptz, Tilt: NaN }, target), /云台 T/);
  for (const Tilt of [-91, 91, 359.9]) assert.throws(() => pointTargetPtz(camera, { ...ptz, Tilt }, target), /当前 T/);
  assert.throws(() => pointTargetPtz(camera, { ...ptz, Zoom: 0 }, target), /倍率/);
  assert.throws(() => pointTargetPtz(camera, ptz, { longitude: 181, latitude: 22 }), /经纬度/);
  assert.throws(() => pointTargetPtz({ ...camera, height: 0 }, ptz, {
    longitude: camera.longitude!, latitude: camera.latitude!,
  }), /重合/);
  assert.throws(() => pointTargetPtz(camera, ptz, { longitude: -66.1, latitude: -22.1 }), /可视范围/);
  assert.throws(() => pointTargetPtz({ ...camera, tiltOffset: 90 }, ptz, target), /不可达/);
});

test('临时点追踪保留上抬负 T，不包装成 300 多度', () => {
  const setup = { ...camera, longitude: 0, latitude: 0, height: 6.6, tiltOffset: -1 };
  const result = pointTargetPtz(setup, { Pan: 0, Tilt: 2, Zoom: 8 }, { longitude: 0, latitude: 0.01 });
  assert.ok(result.tilt < 0 && result.tilt > -1, `应为小幅负 T，实际 ${result.tilt}`);
  assert.equal(result.zoom, 8);
});
