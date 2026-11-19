import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullHorizonView, horizonPixelStep, horizonPointInView, horizonUpperClip, horizonView,
  shiftHorizonPixels, zoomHorizonView } from '../src/app/horizon-precision.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);

test('以光标为锚点连续放大时，同一位置仍对应原图的同一个点', () => {
  const anchor = { x: 0.37, y: 0.64 };
  const first = zoomHorizonView(fullHorizonView, 16, anchor);
  const second = zoomHorizonView(first, 2048, anchor);
  const point = horizonPointInView(second, anchor);
  near(point.x, anchor.x);
  near(point.y, anchor.y);
  assert.deepEqual(zoomHorizonView(second, 1, anchor), fullHorizonView);
  assert.deepEqual(horizonView(32, -1, 2), { left: 0, top: 31 / 32, zoom: 32 });
});

test('步长把一个屏幕像素换成当前视口下的原图像素', () => {
  const source = { width: 960, height: 540 };
  const viewport = { width: 480, height: 270 };
  assert.equal(horizonPixelStep(1, source, viewport), 2);
  assert.equal(horizonPixelStep(16, source, viewport), 0.125);
  assert.equal(horizonPixelStep(2048, source, viewport), 1 / 1024);
  assert.equal(horizonPixelStep(16, source, { width: 960, height: 540 }), 0.0625);
  assert.equal(horizonPixelStep(16, source, { width: 960, height: 0 }), null);
});

test('端点微调按原图像素换算归一化标注坐标', () => {
  const points = [{ x: 0.1, y: 0.4 }, { x: 0.8, y: 0.6 }];
  for (const height of [540, 1080]) {
    const moved = shiftHorizonPixels(points, 1, 0.001, height);
    assert.deepEqual(moved[0], points[0]);
    assert.equal(moved[1].x, points[1].x);
    near((moved[1].y - points[1].y) * height, 0.001);
    const shifted = shiftHorizonPixels(moved, 'line', -0.001, height);
    near((shifted[0].y - moved[0].y) * height, -0.001);
    near((shifted[1].y - moved[1].y) * height, -0.001);
  }
});

test('整线在原图边缘停止时保持端点的高度差', () => {
  const moved = shiftHorizonPixels([{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.999999 }], 'line', 0.001, 540);
  assert.equal(moved[1].y, 1);
  near(moved[0].y, 0.100001);
});

test('标注遮罩的下边界经过两个原图端点，红色描边只覆盖边界上方', () => {
  const points = [{ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.25 }];
  assert.equal(horizonUpperClip(points, 960, 540), '720,270 240,135 240,-540 720,-540');
});
