import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ellipsoid, IntersectionTests, Ray } from 'cesium';
import { createCameraPose } from '../src/app/camera-math.ts';
import { horizonOffsetDegrees, solveHorizonTilt } from '../server/horizon-control.mjs';
import { fixtureCamera } from './calibration-fixtures.mjs';

function hitsSea(calibration, pan, tilt) {
  const pose = createCameraPose(calibration, {
    Pan: pan, Tilt: tilt, Zoom: 8, HorizontalFieldAngle: 6, VerticalFieldAngle: 3,
  });
  const hit = IntersectionTests.rayEllipsoid(new Ray(pose.position, pose.direction), Ellipsoid.WGS84);
  return Boolean(hit && hit.start > 0);
}

function rayHorizonTilt(calibration, pan, skyTilt, seaTilt) {
  assert.equal(hitsSea(calibration, pan, skyTilt), false);
  assert.equal(hitsSea(calibration, pan, seaTilt), true);
  for (let iteration = 0; iteration < 55; iteration++) {
    const middle = (skyTilt + seaTilt) / 2;
    if (hitsSea(calibration, pan, middle)) seaTilt = middle;
    else skyTilt = middle;
  }
  return (skyTilt + seaTilt) / 2;
}

test('T 反求使中心射线位于独立椭球射线的海天分界', () => {
  const tilt = solveHorizonTilt(fixtureCamera, { pan: 70, referenceTilt: 1, tiltMin: 0, tiltMax: 90 });
  assert.ok(tilt > 0 && tilt < 1);
  assert.equal(hitsSea(fixtureCamera, 70, tilt - 0.0001), false);
  assert.equal(hitsSea(fixtureCamera, 70, tilt + 0.0001), true);
});

test('不可达的同分支海天线拒绝截边、负角包装与反向切线解', () => {
  const calibration = { ...fixtureCamera, pAxisPitch: -5 };
  assert.equal(hitsSea(calibration, 0, 0), true);
  assert.equal(hitsSea(calibration, 0, 90), true);
  for (const tiltMax of [90, 360]) {
    assert.throws(() => solveHorizonTilt(calibration, {
      pan: 0, referenceTilt: 0, tiltMin: 0, tiltMax,
    }), (error) => error.statusCode === 400 && /不可达/.test(error.message));
  }
});

test('完整 T 范围内选择参考俯仰分支的最近切线', () => {
  const forward = solveHorizonTilt(fixtureCamera, { pan: 70, referenceTilt: 1, tiltMin: 0, tiltMax: 360 });
  const reversed = solveHorizonTilt(fixtureCamera, { pan: 70, referenceTilt: 179, tiltMin: 0, tiltMax: 360 });
  assert.ok(forward > 0 && forward < 1);
  assert.ok(reversed > 179 && reversed < 180);
  assert.equal(hitsSea(fixtureCamera, 70, reversed - 0.0001), true);
  assert.equal(hitsSea(fixtureCamera, 70, reversed + 0.0001), false);
});

test('深俯视参考 T 周围存在两条可见切线时选择最近值', () => {
  for (const [referenceTilt, sky, sea] of [[89.95, 0, 10], [90.05, 180, 170]]) {
    const expected = rayHorizonTilt(fixtureCamera, 70, sky, sea);
    const tilt = solveHorizonTilt(fixtureCamera, { pan: 70, referenceTilt, tiltMin: 0, tiltMax: 360 });
    assert.ok(Math.abs(tilt - expected) < 1e-7, `${referenceTilt}: ${tilt} / ${expected}`);
  }
});

test('同俯仰分支按光轴方向保持，不能借另一分支绕过原始 T 边界', () => {
  assert.throws(() => solveHorizonTilt(fixtureCamera, {
    pan: 70, referenceTilt: 89.95, tiltMin: 89, tiltMax: 360,
  }), (error) => error.statusCode === 400 && /不可达/.test(error.message));
  const calibration = { ...fixtureCamera, height: 100000, tiltOffset: 89 };
  const expected = rayHorizonTilt(calibration, 70, 0, 120);
  const tilt = solveHorizonTilt(calibration, { pan: 70, referenceTilt: 0, tiltMin: 0, tiltMax: 120 });
  assert.ok(tilt > 90 && Math.abs(tilt - expected) < 1e-7);
});

test('中心角差在海天分界为零、朝天为正，背向相切直线不作为可见海天线', () => {
  const calibration = { ...fixtureCamera, longitude: 0, latitude: 0, height: 100, panOffset: 0 };
  const tangent = rayHorizonTilt(calibration, 90, 0, 10);
  for (const shift of [-2, 0, 2]) {
    const offset = horizonOffsetDegrees(calibration, { Pan: 90, Tilt: tangent + shift });
    assert.ok(Math.abs(offset + shift) < 1e-7, `${shift}: ${offset}`);
  }
  assert.ok(horizonOffsetDegrees(calibration, { Pan: 90, Tilt: -tangent }) > tangent);
  for (const height of [6.6, 1000]) {
    const tilted = { ...fixtureCamera, height, latitude: 65, pAxisPitch: 1.25, pAxisRoll: -2.1,
      tiltOffset: 4, imageRoll: -15 };
    for (const pan of [0, 70, 170, 290]) {
      const tilt = rayHorizonTilt(tilted, pan, 0, 15);
      assert.ok(Math.abs(horizonOffsetDegrees(tilted, { Pan: pan, Tilt: tilt })) < 1e-7);
      const solved = solveHorizonTilt(tilted, { pan, referenceTilt: 4, tiltMin: 0, tiltMax: 90 });
      assert.ok(Math.abs(solved - tilt) < 1e-7);
    }
  }
});

test('几何控制公开边界拒绝缺失标定、非有限角度及无效原始 T 区间', () => {
  const target = { pan: 70, referenceTilt: 1, tiltMin: 0, tiltMax: 90 };
  for (const patch of [{ longitude: null }, { latitude: 91 }, { height: -1 }, { height: Infinity },
    { pAxisPitch: NaN }, { pAxisRoll: null }, { panOffset: undefined }, { tiltOffset: 181 }, { imageRoll: NaN }]) {
    assert.throws(() => solveHorizonTilt({ ...fixtureCamera, ...patch }, target),
      (error) => error.statusCode === 400 && /标定/.test(error.message));
  }
  for (const patch of [{ pan: NaN }, { pan: 361 }, { referenceTilt: null }, { referenceTilt: 100 },
    { tiltMin: -1 }, { tiltMax: 361 }, { tiltMin: 90 }, { tiltMax: NaN }]) {
    assert.throws(() => solveHorizonTilt(fixtureCamera, { ...target, ...patch }),
      (error) => error.statusCode === 400 && /T|P/.test(error.message));
  }
  assert.throws(() => horizonOffsetDegrees(fixtureCamera, { Pan: 70, Tilt: NaN }),
    (error) => error.statusCode === 400 && /P\/T/.test(error.message));
});
