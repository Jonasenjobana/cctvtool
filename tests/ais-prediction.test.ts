import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartographic, EllipsoidGeodesic } from 'cesium';
import { predictVesselPosition } from '../src/app/ais-prediction.ts';
import type { VesselTarget } from '../src/app/ais.models.ts';

const epoch = Date.parse('2026-11-17T08:00:00Z');
const vessel: VesselTarget = { mmsi: '123456789', time: new Date(epoch).toISOString(), longitude: 0, latitude: 0,
  heading: 0, cog: 90, length: 100, width: 20, speed: 36 };
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${actual} / ${expected}`);

test('预判将 AIS 历史时间差与提前秒数相加，按节换算米且优先沿 COG 位移', () => {
  const original = { ...vessel };
  const prediction = predictVesselPosition(vessel, 5, epoch + 20000);
  near(prediction.elapsedSeconds, 25);
  near(prediction.distanceMeters, 463);
  assert.equal(prediction.predictedAt, '2026-11-17T08:00:25.000Z');
  assert.ok(prediction.longitude > 0);
  near(prediction.latitude, 0);
  near(new EllipsoidGeodesic(Cartographic.fromDegrees(0, 0),
    Cartographic.fromDegrees(prediction.longitude, prediction.latitude)).surfaceDistance, 463, 0.001);
  assert.deepEqual(vessel, original);
});

test('同一条 AIS 在时间前进后继续外推，新记录到达后按新时间和位置校正', () => {
  const first = predictVesselPosition(vessel, 3, epoch + 1000);
  const next = predictVesselPosition(vessel, 3, epoch + 2000);
  assert.ok(next.longitude > first.longitude);
  near(next.distanceMeters - first.distanceMeters, 18.52);
  const updated = { ...vessel, time: new Date(epoch + 2000).toISOString(), longitude: 1, cog: 270 };
  const corrected = predictVesselPosition(updated, 3, epoch + 2000);
  assert.ok(corrected.longitude < 1 && corrected.longitude > 0.99);
  near(corrected.elapsedSeconds, 3);
});

test('预判允许 0、小数及较大秒数，跨经度 180 度时保持合法坐标', () => {
  near(predictVesselPosition(vessel, 0, epoch).distanceMeters, 0);
  near(predictVesselPosition(vessel, 1.5, epoch).distanceMeters, 27.78);
  near(predictVesselPosition(vessel, 100000, epoch).elapsedSeconds, 100000);
  const crossed = predictVesselPosition({ ...vessel, longitude: 179.9999, latitude: 60 }, 100, epoch);
  assert.ok(crossed.longitude < -179 && crossed.longitude >= -180);
  near(crossed.latitude, 60);
});

test('没有 COG 时沿有效船艏外推，0 航速可在没有方向时保持原位置', () => {
  const north = predictVesselPosition({ ...vessel, cog: null }, 10, epoch);
  assert.ok(north.latitude > 0);
  near(north.longitude, 0);
  const stationary = predictVesselPosition({ ...vessel, speed: 0, cog: null, heading: null }, 10, epoch);
  near(stationary.longitude, vessel.longitude);
  near(stationary.latitude, vessel.latitude);
  near(stationary.distanceMeters, 0);
});

test('预判拒绝缺失运动数据、非法秒数、时间和坐标，不伪造可用位置', () => {
  for (const seconds of [-1, NaN, Infinity]) assert.throws(() => predictVesselPosition(vessel, seconds, epoch), /预判秒数/);
  for (const speed of [null, -1, NaN, Infinity]) {
    assert.throws(() => predictVesselPosition({ ...vessel, speed }, 3, epoch), /航速/);
  }
  assert.throws(() => predictVesselPosition({ ...vessel, heading: null, cog: null }, 3, epoch), /航向|船艏/);
  assert.throws(() => predictVesselPosition({ ...vessel, time: 'bad' }, 3, epoch), /时间/);
  assert.throws(() => predictVesselPosition(vessel, 3, epoch - 10000), /时间/);
  assert.throws(() => predictVesselPosition(vessel, Number.MAX_VALUE, epoch), /时间|范围/);
  assert.throws(() => predictVesselPosition({ ...vessel, latitude: 91 }, 3, epoch), /经纬度/);
});
