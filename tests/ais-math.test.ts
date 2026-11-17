import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Matrix3, Matrix4, Transforms } from 'cesium';
import { vesselBodyDimensions, vesselGeometry } from '../src/app/ais-math.ts';
import { createCameraPose, pointTargetPtz } from '../src/app/camera-math.ts';
import type { VesselTarget } from '../src/app/ais.models.ts';

const vessel: VesselTarget = { mmsi: '123456789', time: '2026-11-13T08:00:00Z', longitude: 0, latitude: 0,
  heading: 0, cog: null, length: 100, width: 20, speed: 0 };
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

test('手动 ABCD 和船高共同决定船体大小与偏移，保留原始 AIS 长宽及报告位置', () => {
  const original = { ...vessel };
  const body = { a: 30, b: 90, c: 5, d: 25, height: 20 };
  const geometry = vesselGeometry(vessel, options, body)!;
  assert.deepEqual(geometry.abcd, { a: 30, b: 90, c: 5, d: 25 });
  assert.deepEqual(geometry.dimensions, new Cartesian3(30, 120, 20));
  assert.deepEqual(geometry.vessel, { length: 120, width: 30, heading: 0, height: 20 });
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0)), new Matrix4());
  const local = Matrix4.multiplyByPoint(inverse, geometry.position, new Cartesian3());
  near(local.x, 10); near(local.y, -30); near(local.z, 10);
  near(Cartographic.fromCartesian(geometry.position).height, 10);
  assert.deepEqual(vessel, original);
});

test('ABCD 方向优先船艏，无有效船艏时按 COG 计算中心与朝向且保留原始字段', () => {
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0)), new Matrix4());
  const preferred = vesselGeometry({ ...vessel, heading: 45, cog: 90 }, options)!;
  assert.equal(preferred.vessel.heading, 45);
  for (const heading of [null, -1, 360, 511, NaN]) {
    const target = { ...vessel, heading, cog: 90 }, original = { ...target };
    const geometry = vesselGeometry(target, options)!;
    assert.ok(geometry);
    const local = Matrix4.multiplyByPoint(inverse, geometry.position, new Cartesian3());
    near(local.x, 40); near(local.y, 0); near(local.z, 5);
    assert.equal(geometry.vessel.heading, 90);
    assert.deepEqual(target, original);
  }
  const manual = vesselGeometry({ ...vessel, heading: null, cog: 90 }, options,
    { a: 30, b: 90, c: 5, d: 25, height: 20 })!;
  const local = Matrix4.multiplyByPoint(inverse, manual.position, new Cartesian3());
  near(local.x, -30); near(local.y, -10); near(local.z, 10);
});

test('COG 0 度可作为北向，两种方向均不可用或尺寸缺失时保持报告点降级', () => {
  assert.equal(vesselGeometry({ ...vessel, heading: null, cog: 0 }, options)!.vessel.heading, 0);
  for (const cog of [null, -1, 360, 3600, NaN, Infinity]) {
    assert.equal(vesselGeometry({ ...vessel, heading: null, cog }, options), null);
  }
  assert.equal(vesselGeometry({ ...vessel, heading: null, cog: 90, length: null }, options), null);
});

test('手动尺寸可补足缺失的 AIS 长宽，允许零边距并拒绝退化或无效船体', () => {
  const body = { a: 0, b: 100, c: 0, d: 20, height: 12 };
  const missing = { ...vessel, length: null, width: null };
  assert.equal(vesselGeometry(missing, options), null);
  assert.deepEqual(vesselGeometry(missing, options, body)!.dimensions, new Cartesian3(20, 100, 12));
  assert.equal(vesselGeometry({ ...missing, heading: null }, options, body), null);
  assert.deepEqual(vesselBodyDimensions({ ...vessel, heading: null }, options), { a: 90, b: 10, c: 10, d: 10, height: 10 });
  for (const invalid of [{ ...body, a: -1 }, { ...body, b: 0 }, { ...body, d: 0 }, { ...body, height: 0 },
    { ...body, height: NaN }, { ...body, c: Infinity }]) {
    assert.equal(vesselGeometry(vessel, options, invalid), null);
  }
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
