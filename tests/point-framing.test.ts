import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { createCameraPose, estimateVesselZoom, pointTargetPtz, vesselCorners } from '../src/app/camera-math.ts';
import type { VesselDimensions } from '../src/app/camera-math.ts';
import type { CameraDraft, RawPtz } from '../src/app/models.ts';

const camera: CameraDraft = { name: 'test', serial: '01', code: '02', longitude: 0, latitude: 0, height: 10,
  pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0 };
const reading: RawPtz = { Pan: 0, Tilt: 1, Zoom: 4, HorizontalFieldAngle: 20, VerticalFieldAngle: 10 };
const point = { longitude: 0, latitude: 0.01 };
const vessel: VesselDimensions = { length: 100, width: 20, heading: 90 };
const near = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} / ${expected}`);

function frame(target = point, size = vessel, setup = camera, maxZoom = 73, raw = reading) {
  const aim = pointTargetPtz(setup, raw, target);
  return estimateVesselZoom(setup, raw, target, size, aim, maxZoom);
}

test('船体长宽以船艏真北朝向建立角点，船高可选且输入保持原样', () => {
  const size = { length: 100, width: 20, heading: 0, height: 15 };
  const original = { ...size };
  const points = vesselCorners(point, size);
  assert.equal(points.length, 8);
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(point.longitude, point.latitude, 0)), new Matrix4());
  const local = points.map((position) => Matrix4.multiplyByPoint(inverse, position, new Cartesian3()));
  near(Math.max(...local.map((value) => value.x)) - Math.min(...local.map((value) => value.x)), 20);
  near(Math.max(...local.map((value) => value.y)) - Math.min(...local.map((value) => value.y)), 100);
  near(Math.max(...local.map((value) => value.z)), 15);
  const east = vesselCorners(point, { ...size, heading: 90 })
    .map((position) => Matrix4.multiplyByPoint(inverse, position, new Cartesian3()));
  near(Math.max(...east.map((value) => value.x)) - Math.min(...east.map((value) => value.x)), 100);
  assert.equal(vesselCorners(point, vessel).length, 4);
  const north = vesselCorners(point, { ...vessel, heading: 0 });
  vesselCorners(point, { ...vessel, heading: 360 }).forEach((position, index) => near(Cartesian3.distance(position, north[index]), 0));
  assert.deepEqual(size, original);
});

test('倍率随距离和船艏朝向变化，侧看长船比正对船头使用更低倍率', () => {
  const side = frame();
  const bow = frame(point, { ...vessel, heading: 0 });
  assert.ok(side.zoom < bow.zoom);
  const far = frame({ ...point, latitude: 0.02 });
  assert.ok(far.zoom > side.zoom);
  assert.ok(far.distanceMeters > side.distanceMeters);
  near(side.zoom * 10, Math.round(side.zoom * 10));
});

test('使用最终估算 FOV 投影整船角点，横纵占比均不超过 50%且不出画面', () => {
  for (const setup of [camera, { ...camera, pAxisPitch: 5, pAxisRoll: -3, panOffset: 23, tiltOffset: 1, imageRoll: 37 }]) {
    for (const heading of [0, 37, 90, 173, 270]) {
      const size = { ...vessel, heading, height: 30 };
      const aim = pointTargetPtz(setup, reading, point);
      const result = estimateVesselZoom(setup, reading, point, size, aim, 73);
      const scale = reading.Zoom / result.zoom;
      const pose = createCameraPose(setup, { ...reading, Pan: aim.pan, Tilt: aim.tilt, Zoom: result.zoom,
        HorizontalFieldAngle: 2 * Math.atan(Math.tan(CesiumMath.toRadians(reading.HorizontalFieldAngle! / 2)) * scale) * 180 / Math.PI,
        VerticalFieldAngle: 2 * Math.atan(Math.tan(CesiumMath.toRadians(reading.VerticalFieldAngle! / 2)) * scale) * 180 / Math.PI });
      const pixels = vesselCorners(point, size).map((corner) => {
        const ray = Cartesian3.subtract(corner, pose.position, new Cartesian3());
        const depth = Cartesian3.dot(ray, pose.direction);
        return { u: 0.5 + Cartesian3.dot(ray, pose.right) / (2 * depth * Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2))),
          v: 0.5 - Cartesian3.dot(ray, pose.up) / (2 * depth * Math.tan(CesiumMath.toRadians(pose.verticalFov / 2))) };
      });
      const width = Math.max(...pixels.map((value) => value.u)) - Math.min(...pixels.map((value) => value.u));
      const height = Math.max(...pixels.map((value) => value.v)) - Math.min(...pixels.map((value) => value.v));
      assert.ok(width <= 0.5 + 1e-12 && height <= 0.5 + 1e-12);
      assert.ok(pixels.every(({ u, v }) => u >= -1e-12 && u <= 1 + 1e-12 && v >= -1e-12 && v <= 1 + 1e-12));
      near(result.widthFraction, width);
      near(result.heightFraction, height);
    }
  }
});

test('船高和画面 Roll 会改变需要约束的纵向尺寸', () => {
  const flat = frame(point, { ...vessel, heading: 0 });
  const tall = frame(point, { ...vessel, heading: 0, height: 50 });
  assert.ok(tall.zoom < flat.zoom);
  assert.ok(tall.heightFraction <= 0.5);
  const side = frame();
  const rolled = frame(point, vessel, { ...camera, imageRoll: 90 });
  assert.ok(rolled.zoom < side.zoom);
  assert.ok(rolled.heightFraction <= 0.5);
});

test('32 和 73 倍上限均受约束，最低倍率装不下时明确失败', () => {
  const distant = { longitude: 0, latitude: 0.04 };
  const narrow = { ...vessel, width: 10, heading: 0 };
  assert.equal(frame(distant, narrow, camera, 32).zoom, 32);
  assert.equal(frame(distant, narrow, camera, 73).zoom, 73);
  assert.throws(() => frame({ longitude: 0, latitude: 0.001 }, { length: 30, width: 100, heading: 0 }), /1 倍.*50%/);
  assert.throws(() => frame({ longitude: 0, latitude: 0.001 }, { length: 300, width: 20, heading: 0 }), /镜头前方/);
});

test('缺少真实 FOV、非法尺寸或倍率上限时不生成伪造的估算值', () => {
  for (const size of [{ ...vessel, length: 0 }, { ...vessel, width: NaN }, { ...vessel, heading: 361 }, { ...vessel, height: -1 }]) {
    assert.throws(() => frame(point, size), /船长|船宽|朝向|船高/);
  }
  for (const max of [0, NaN, Infinity]) assert.throws(() => frame(point, vessel, camera, max), /倍率|上限/);
  assert.throws(() => frame(point, vessel, camera, 73, { ...reading, HorizontalFieldAngle: null }), /视场角/);
  assert.throws(() => frame(point, vessel, camera, 73, { ...reading, VerticalFieldAngle: 0 }), /视场角/);
  assert.deepEqual(frame(point, { ...vessel, height: 0 }), frame(point, vessel));
});
