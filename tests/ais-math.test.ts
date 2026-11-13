import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Matrix3, Matrix4, Transforms } from 'cesium';
import { isInCameraView, vesselGeometry } from '../src/app/ais-math.ts';
import { createCameraPose, pointTargetPtz } from '../src/app/camera-math.ts';
import type { VesselTarget } from '../src/app/ais.models.ts';

const vessel: VesselTarget = { mmsi: '123456789', time: '2026-11-13T08:00:00Z', longitude: 0, latitude: 0,
  heading: 0, length: 100, width: 20, speed: 0 };
const options = { antennaFromSternRatio: 0.1, antennaFromPortRatio: 0.5, heightMeters: 10 };
const near = (actual: number, expected: number, tolerance = 0.001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} / ${expected}`);

test('默认 ABCD 对应 100×20 米船，船体中心向船艏偏移 40 米并保留原始报告位置', () => {
  const original = { ...vessel };
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0)), new Matrix4());
  const north = vesselGeometry(vessel, options)!;
  assert.deepEqual(north.abcd, { a: 90, b: 10, c: 10, d: 10 });
  assert.deepEqual(north.dimensions, new Cartesian3(20, 100, 10));
  const local = Matrix4.multiplyByPoint(inverse, north.position, new Cartesian3());
  near(local.x, 0); near(local.y, 40); near(local.z, 5);
  near(Cartographic.fromCartesian(north.position).height, 5);
  const east = vesselGeometry({ ...vessel, heading: 90 }, options)!;
  const eastLocal = Matrix4.multiplyByPoint(inverse, east.position, new Cartesian3());
  near(eastLocal.x, 40); near(eastLocal.y, 0);
  const forward = Matrix3.multiplyByVector(Matrix3.fromQuaternion(east.orientation), Cartesian3.UNIT_Y, new Cartesian3());
  near(Cartesian3.dot(forward, Cartesian3.UNIT_Y), 1);
  assert.deepEqual(vessel, original);
});

test('显示按摄像头实际 FOV 和距离筛选，追踪船体部分进入视场时仍保留', () => {
  const camera = { name: '', serial: '', code: '', longitude: 0, latitude: 0, height: 100,
    pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0 };
  const pose = createCameraPose(camera, { Pan: 0, Tilt: 5.2, Zoom: 4, HorizontalFieldAngle: 20, VerticalFieldAngle: 10 });
  const inside = Cartesian3.fromDegrees(0, 0.01);
  assert.equal(isInCameraView(pose, inside, 10000), true);
  assert.equal(isInCameraView(pose, inside, 1000), false);
  assert.equal(isInCameraView(pose, Cartesian3.fromDegrees(0.01, 0.01), 10000), false);
  assert.equal(isInCameraView(pose, Cartesian3.fromDegrees(0, -0.01), 10000), false);
  const edge = Cartesian3.fromDegrees(0.0022, 0.01, 5);
  assert.equal(isInCameraView(pose, edge, 10000), false);
  assert.equal(isInCameraView(pose, edge, 10000, 80), true);
});

test('追踪可瞄准估算长方体的空间中心，普通海面点仍保持零高程', () => {
  const camera = { name: '', serial: '', code: '', longitude: 0, latitude: 0, height: 100,
    pAxisPitch: 2, pAxisRoll: -3, panOffset: 20, tiltOffset: 1, imageRoll: 5 };
  const reading = { Pan: 0, Tilt: 5, Zoom: 4, HorizontalFieldAngle: 20, VerticalFieldAngle: 10 };
  const target = { longitude: 0, latitude: 0.01, height: 20 };
  const aim = pointTargetPtz(camera, reading, target);
  const pose = createCameraPose(camera, { ...reading, Pan: aim.pan, Tilt: aim.tilt });
  const direction = Cartesian3.normalize(Cartesian3.subtract(Cartesian3.fromDegrees(0, 0.01, 20), pose.position, new Cartesian3()), new Cartesian3());
  near(Cartesian3.dot(direction, pose.direction), 1, 1e-12);
  assert.notEqual(aim.tilt, pointTargetPtz(camera, reading, { longitude: 0, latitude: 0.01 }).tilt);
});

test('来源可覆盖天线比例，尺寸或船艏缺失时不伪造船体，非法估算参数被拒绝', () => {
  const geometry = vesselGeometry(vessel, { ...options, antennaFromSternRatio: 0.2, antennaFromPortRatio: 0.25 })!;
  assert.deepEqual(geometry.abcd, { a: 80, b: 20, c: 5, d: 15 });
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0)), new Matrix4());
  const local = Matrix4.multiplyByPoint(inverse, geometry.position, new Cartesian3());
  near(local.x, 5); near(local.y, 30);
  for (const target of [{ ...vessel, heading: null }, { ...vessel, heading: 511 }, { ...vessel, length: null }, { ...vessel, width: 0 }]) {
    assert.equal(vesselGeometry(target, options), null);
  }
  for (const settings of [{ ...options, heightMeters: 0 }, { ...options, antennaFromSternRatio: 2 }]) {
    assert.equal(vesselGeometry(vessel, settings), null);
  }
});
