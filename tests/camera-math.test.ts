import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Matrix4, Transforms } from 'cesium';
import { createCameraPose, footprintSegments, frustumCorners, observationFov, videoFovPlane } from '../src/app/camera-math.ts';
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
    const plane = videoFovPlane(pose, 500, 16 / 9);
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

test('视频比例不匹配时通过透明留边保持原比例，不改变接口 FOV 或截面位置', () => {
  const pose = createCameraPose(camera, { ...ptz, HorizontalFieldAngle: 80, VerticalFieldAngle: 30 });
  const narrow = videoFovPlane(pose, 500, 1);
  const wide = videoFovPlane(pose, 500, 4);
  const aspect = Math.tan(40 * Math.PI / 180) / Math.tan(15 * Math.PI / 180);
  near(narrow.uvScale.x, aspect);
  near(narrow.uvScale.y, 1);
  near(wide.uvScale.x, 1);
  near(wide.uvScale.y, 4 / aspect);
  assert.deepEqual(narrow.matrix, wide.matrix);
  assert.equal(pose.horizontalFov, 80);
  assert.equal(pose.verticalFov, 30);
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
