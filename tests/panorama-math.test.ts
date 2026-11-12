import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRigRotation } from '#camera-rotation';
import { blendPanoramaFrame, createPanoramaPlan } from '../src/app/panorama-math.ts';
import type { PanoramaImage, PanoramaPlan } from '../src/app/panorama-math.ts';
import type { Snapshot } from '../src/app/models.ts';

function snapshot(index: number, pan: number): Snapshot {
  const now = '2026-11-09T08:00:00.000Z';
  const ptz = { raw: { Pan: pan, Tilt: 0, Zoom: 10, HorizontalFieldAngle: 30, VerticalFieldAngle: 20 },
    requestedAt: now, receivedAt: now, durationMs: 1 };
  return { id: `image-${index}`, cameraId: 'camera-1', cameraName: '海域摄像头', serial: 'device', code: 'channel',
    groupId: 'scan-1', scanIndex: index, scanTarget: { pan, tilt: 0, zoom: 10 }, imageUrl: `/api/snapshots/image-${index}/image`,
    width: 120, height: 80, bytes: 1, contentType: 'image/jpeg', createdAt: now, requestedAt: now, receivedAt: now,
    durationMs: 1, snapshotTime: null, ptz, ptzAfter: ptz,
    calibration: { longitude: null, latitude: null, height: null, pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0 },
    usesDraft: false, poseChanged: false, timeAlignment: 'unverified' };
}

const radians = (degrees: number) => degrees * Math.PI / 180;
const colorField = (angle: number, slope: number) => [128 + 70 * Math.sin(angle * 2), 120 + slope * 200, 120 + 60 * Math.cos(angle)];

function syntheticImage(shot: Snapshot, fixedColor?: number[]): PanoramaImage {
  const { width, height } = shot;
  const data = new Uint8ClampedArray(width * height * 4);
  const rotation = createLocalRigRotation(shot.calibration, shot.ptz.raw).camera;
  const tanH = Math.tan(radians(shot.ptz.raw.HorizontalFieldAngle! / 2));
  const tanV = Math.tan(radians(shot.ptz.raw.VerticalFieldAngle! / 2));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (2 * (x + 0.5) / width - 1) * tanH;
    const v = (1 - 2 * (y + 0.5) / height) * tanV;
    const rx = rotation[3] + rotation[0] * u + rotation[6] * v;
    const ry = rotation[4] + rotation[1] * u + rotation[7] * v;
    const rz = rotation[5] + rotation[2] * u + rotation[8] * v;
    const color = fixedColor || colorField(Math.atan2(rx, ry), rz / Math.hypot(rx, ry));
    data.set([...color, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

function render(snapshots: Snapshot[], colors?: number[][]) {
  const plan = createPanoramaPlan(snapshots);
  const data = new Uint8ClampedArray(plan.width * plan.height * 4);
  const weights = new Float32Array(plan.width * plan.height);
  for (const [index, frame] of plan.frames.entries()) {
    blendPanoramaFrame(plan, frame, syntheticImage(frame.snapshot, colors?.[index]), data, weights);
  }
  return { plan, data };
}

function pixel(plan: PanoramaPlan, data: Uint8ClampedArray, angle: number, slope = 0) {
  const x = Math.floor((radians(angle) - plan.minHeading) * plan.scale);
  const y = Math.floor((plan.maxY - slope) * plan.scale);
  assert.ok(x >= 0 && x < plan.width && y >= 0 && y < plan.height);
  return { rgba: Array.from(data.subarray((y * plan.width + x) * 4, (y * plan.width + x) * 4 + 4)),
    heading: plan.minHeading + (x + 0.5) / plan.scale, slope: plan.maxY - (y + 0.5) / plan.scale };
}

test('按任务采样顺序拼接完整截图，不依赖页面顺序或已知经纬度', () => {
  const first = snapshot(0, 10);
  const second = snapshot(1, 35);
  const { plan, data } = render([second, first]);
  assert.deepEqual(plan.frames.map(frame => frame.snapshot.id), [first.id, second.id]);
  for (const angle of [0, 10, 20, 25, 35, 45]) {
    const sample = pixel(plan, data, angle);
    const expected = colorField(sample.heading, sample.slope);
    sample.rgba.slice(0, 3).forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 3));
    assert.equal(sample.rgba[3], 255);
  }
});

test('投影复用安装倾斜、P/T 偏移与 Roll，世界中的同一海天线不会随截图整体错位', () => {
  const shots = [snapshot(0, 10), snapshot(1, 30), snapshot(2, 50)];
  for (const shot of shots) {
    Object.assign(shot.calibration, { pAxisPitch: 3, pAxisRoll: -2, panOffset: 15, tiltOffset: 2, imageRoll: 4 });
    shot.ptz.raw.Tilt = 2;
  }
  const { plan, data } = render(shots);
  let checked = 0;
  for (let angle = 20; angle <= 70; angle += 5) {
    const sample = pixel(plan, data, angle);
    if (!sample.rgba[3]) continue;
    const expected = colorField(sample.heading, sample.slope);
    sample.rgba.slice(0, 3).forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 3));
    checked++;
  }
  assert.ok(checked >= 8);
});

test('跨正北的安装方位连续展开，输出范围包含两张图而不是绕地球一周', () => {
  const shots = [snapshot(0, 5), snapshot(1, 30)];
  for (const shot of shots) shot.calibration.panOffset = 350;
  const plan = createPanoramaPlan(shots);
  assert.ok(plan.frames[1].heading > plan.frames[0].heading);
  assert.ok(plan.width / plan.scale < radians(60));
});

test('重叠区域按边缘权重融合，缺失视野保持透明，不拉伸邻图填洞', () => {
  const overlap = render([snapshot(0, 0), snapshot(1, 10)], [[255, 0, 0], [0, 0, 255]]);
  const mixed = pixel(overlap.plan, overlap.data, 5).rgba;
  assert.ok(Math.abs(mixed[0] - 128) <= 1 && Math.abs(mixed[2] - 128) <= 1);
  assert.equal(mixed[3], 255);
  const gap = render([snapshot(0, 0), snapshot(1, 80)], [[255, 0, 0], [0, 0, 255]]);
  assert.equal(pixel(gap.plan, gap.data, 40).rgba[3], 0);
  assert.deepEqual(pixel(gap.plan, gap.data, 0).rgba, [255, 0, 0, 255]);
  assert.deepEqual(pixel(gap.plan, gap.data, 80).rgba, [0, 0, 255, 255]);
});

test('高分辨率长任务的全景画布受尺寸与像素预算约束，原始记录不被改写', () => {
  const shots = Array.from({ length: 200 }, (_, index) => {
    const shot = snapshot(index, index * 1.8);
    shot.width = 8192;
    shot.height = 4608;
    shot.ptz.raw.HorizontalFieldAngle = 2;
    shot.ptz.raw.VerticalFieldAngle = 1.125;
    return shot;
  });
  const before = JSON.stringify(shots);
  const plan = createPanoramaPlan(shots);
  assert.equal(plan.frames.length, 200);
  assert.ok(plan.width <= 16384 && plan.height <= 4096);
  assert.ok(plan.width * plan.height <= 16000000);
  assert.equal(JSON.stringify(shots), before);
});

test('不足两图、串设备、无效 FOV 和包含竖直方向的画面明确失败', () => {
  assert.throws(() => createPanoramaPlan([snapshot(0, 0)]), /至少需要两张/);
  const other = snapshot(1, 20);
  other.cameraId = 'other';
  assert.throws(() => createPanoramaPlan([snapshot(0, 0), other]), /同一摄像头/);
  const invalid = snapshot(1, 20);
  invalid.ptz.raw.HorizontalFieldAngle = null;
  assert.throws(() => createPanoramaPlan([snapshot(0, 0), invalid]), /视场角/);
  const vertical = snapshot(1, 20);
  vertical.ptz.raw.Tilt = 90;
  assert.throws(() => createPanoramaPlan([snapshot(0, 0), vertical]), /竖直方向/);
});
