import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian2, Cartesian3, Cartographic, Rectangle, WebMercatorTilingScheme } from 'cesium';
import {
  AmapProjection, AmapTilingScheme, createAmapImagery, gcj02ToWgs84, wgs84ToGcj02,
} from '../src/app/amap-imagery.ts';

const near = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} ≠ ${b}`);

test('GCJ-02 转换符合参考基准，可在目标海域往返且范围外保持原坐标', () => {
  const beijing = wgs84ToGcj02(116.404, 39.915);
  near(beijing[0], 116.41024449916938);
  near(beijing[1], 39.91640428150164);
  for (const [longitude, latitude] of [[113.91319, 22.04331], [116.404, 39.915], [121.4737, 31.2304]]) {
    const gcj = wgs84ToGcj02(longitude, latitude);
    assert.ok(Math.hypot(gcj[0] - longitude, gcj[1] - latitude) > 0.001);
    const restored = gcj02ToWgs84(...gcj);
    near(restored[0], longitude);
    near(restored[1], latitude);
  }
  assert.deepEqual(wgs84ToGcj02(-74, 40), [-74, 40]);
  assert.deepEqual(gcj02ToWgs84(-74, 40), [-74, 40]);
});

test('影像投影保持输入 WGS84 与高度不变，并支持 Cesium 的 result 复用', () => {
  const projection = new AmapProjection();
  const position = Cartographic.fromDegrees(113.91319, 22.04331, 6.6);
  const original = Cartographic.clone(position);
  const projected = new Cartesian3();
  assert.equal(projection.project(position, projected), projected);
  assert.ok(Cartographic.equals(position, original));
  const restored = new Cartographic();
  assert.equal(projection.unproject(projected, restored), restored);
  near(restored.longitude, original.longitude);
  near(restored.latitude, original.latitude);
  near(restored.height, 6.6);
});

test('使用 GCJ-02 选取高德瓦片，将瓦片边界还原到 WGS84', () => {
  const scheme = new AmapTilingScheme();
  const grid = new WebMercatorTilingScheme();
  const position = Cartographic.fromDegrees(113.91319, 22.04331, 6.6);
  const [longitude, latitude] = wgs84ToGcj02(113.91319, 22.04331);
  const gcj = Cartographic.fromDegrees(longitude, latitude, 6.6);
  for (const level of [10, 14, 18]) {
    const tile = new Cartesian2();
    assert.equal(scheme.positionToTileXY(position, level, tile), tile);
    assert.ok(Cartesian2.equals(tile, grid.positionToTileXY(gcj, level)));
    const bounds = new Rectangle();
    assert.equal(scheme.tileXYToRectangle(tile.x, tile.y, level, bounds), bounds);
    assert.ok(Rectangle.contains(bounds, position));
    const native = grid.tileXYToNativeRectangle(tile.x, tile.y, level);
    assert.ok(Rectangle.equals(scheme.tileXYToNativeRectangle(tile.x, tile.y, level), native));
    const nativeResult = new Rectangle();
    assert.equal(scheme.rectangleToNativeRectangle(bounds, nativeResult), nativeResult);
    for (const key of ['west', 'south', 'east', 'north'] as const) near(nativeResult[key], native[key], 0.001);
  }
  assert.ok(!Cartesian2.equals(scheme.positionToTileXY(position, 18), grid.positionToTileXY(position, 18)));
});

test('高德卫星 provider 使用独立偏移方案，不影响标准 WebMercator', () => {
  const provider = createAmapImagery();
  assert.match(provider.url, /^https:\/\/webst0\{s\}\.is\.autonavi\.com\/appmaptile\?style=6&/);
  assert.ok(provider.tilingScheme instanceof AmapTilingScheme);
  assert.equal(provider.maximumLevel, 18);
  const standard = new WebMercatorTilingScheme();
  assert.ok(!(standard.projection instanceof AmapProjection));
  const outside = Cartographic.fromDegrees(-74, 40);
  assert.ok(Cartesian2.equals(provider.tilingScheme.positionToTileXY(outside, 12), standard.positionToTileXY(outside, 12)));
});
