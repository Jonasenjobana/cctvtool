import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRigRotation } from '#camera-rotation';
import { blendPanoramaFrame, createPanoramaFrame, createPanoramaPlan, extendHorizonLine, imagePointToPanoramaPoint,
  movePanoramaEndpoint, panoramaGuideHeadingOffset, panoramaPixelToPoint, panoramaPointToImagePoint, panoramaPointToPixel,
  projectImageLine, projectPanoramaGuide, projectPanoramaLine,
  samplePanoramaGuide, addPanoramaGuideNode, removePanoramaGuideNode } from '../src/app/panorama-math.ts';
import type { PanoramaImage, PanoramaPlan } from '../src/app/panorama-math.ts';
import type { Snapshot } from '../src/app/models.ts';
import type { PanoramaGuide } from '../shared/panorama-guide.ts';

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

test('单张截图无需全景即可按已知方位往返投影，跨正北保留展开方向', () => {
  const shot = snapshot(0, 350);
  shot.ptz.raw.HorizontalFieldAngle = 90;
  shot.ptz.raw.VerticalFieldAngle = 90;
  const frame = createPanoramaFrame(shot);
  const known = [
    { image: { x: 0.5, y: 0.5 }, panorama: { heading: radians(350), elevation: 0 } },
    { image: { x: 1, y: 0.5 }, panorama: { heading: radians(395), elevation: 0 } },
    { image: { x: 0.5, y: 0 }, panorama: { heading: radians(350), elevation: 1 } },
  ];
  for (const { image, panorama } of known) {
    const projected = imagePointToPanoramaPoint(frame, image);
    assert.ok(projected);
    assert.ok(Math.abs(projected.heading - panorama.heading) < 1e-12);
    assert.ok(Math.abs(projected.elevation - panorama.elevation) < 1e-12);
    const restored = panoramaPointToImagePoint(frame, panorama);
    assert.ok(restored);
    assert.ok(Math.abs(restored.x - image.x) < 1e-12);
    assert.ok(Math.abs(restored.y - image.y) < 1e-12);
  }
  assert.equal(panoramaPointToImagePoint(frame, { heading: radians(170), elevation: 0 }), null);
  assert.equal(panoramaPointToImagePoint(frame, { heading: radians(410), elevation: 0 }), null);
});

test('持久参考点在跨正北全景改变分辨率后重建，恢复同一方向和相对位置', () => {
  const shots = [snapshot(0, 350), snapshot(1, 10)];
  const first = createPanoramaPlan(shots);
  const persisted = { heading: radians(360), elevation: 0.1 };
  const firstPixel = panoramaPointToPixel(first, persisted);
  assert.ok(Math.abs(firstPixel.x - first.width / 2) < 1);
  const stored = JSON.parse(JSON.stringify(panoramaPixelToPoint(first, firstPixel)));
  shots.forEach((shot) => { shot.width *= 5; shot.height *= 5; });
  const rebuilt = createPanoramaPlan(shots);
  const rebuiltPixel = panoramaPointToPixel(rebuilt, stored);
  assert.ok(Math.abs(rebuiltPixel.x - 5 * firstPixel.x) < 1e-10);
  assert.ok(Math.abs(rebuiltPixel.y - 5 * firstPixel.y) < 1e-10);
  assert.ok(Math.abs(stored.heading - persisted.heading) < 1e-12);
  assert.ok(Math.abs(stored.elevation - persisted.elevation) < 1e-12);
});

test('整周全景从画布左边缘画到右边缘，持久参考点的方位跨度不超过一周', () => {
  for (const startPan of [0, 90, 1.72 * 180 / Math.PI + 20, 350]) {
    const shots = Array.from({ length: 12 }, (_, index) => {
      const shot = snapshot(index, (startPan + index * 30) % 360);
      shot.ptz.raw.HorizontalFieldAngle = 40;
      return shot;
    });
    const plan = createPanoramaPlan(shots);
    assert.ok(plan.width / plan.scale > 2 * Math.PI, '画布包含不足一个像素的取整余量');
    const left = panoramaPixelToPoint(plan, { x: 0, y: plan.height / 2 });
    const right = panoramaPixelToPoint(plan, { x: plan.width, y: plan.height / 2 });
    const span = right.heading - left.heading;
    assert.ok(span <= 2 * Math.PI, `${startPan}° 起始的参考线不能超出一周`);
    assert.ok(Math.abs(span - 2 * Math.PI) < 1e-12, '左右边界仍对应同一实际方向');
  }
});

test('跨零任务删除首张图后重建，整条参考线使用共同圈数偏移并保留持久坐标', () => {
  const shots = [snapshot(0, 350), snapshot(1, 0), snapshot(2, 10)];
  const guide: PanoramaGuide = { kind: 'quadratic', points: [
    { heading: radians(350), elevation: 0 }, { heading: radians(360), elevation: 0.1 },
    { heading: radians(375), elevation: 0 },
  ] };
  const before = JSON.stringify(guide);
  assert.equal(panoramaGuideHeadingOffset(createPanoramaPlan(shots), guide), 0);
  const rebuilt = createPanoramaPlan(shots.slice(1));
  const offset = panoramaGuideHeadingOffset(rebuilt, guide);
  assert.equal(offset, -2 * Math.PI);
  for (const point of guide.points) {
    const displayed = { ...point, heading: point.heading + offset };
    const pixel = panoramaPointToPixel(rebuilt, displayed);
    assert.ok(pixel.x >= 0 && pixel.x <= rebuilt.width);
    const restored = panoramaPixelToPoint(rebuilt, pixel);
    assert.ok(Math.abs(restored.heading - offset - point.heading) < 1e-12);
    assert.ok(Math.abs(restored.elevation - point.elevation) < 1e-12);
  }
  assert.equal(JSON.stringify(guide), before);
});

test('直线与二次弧线按展开方位采样，控制点决定实际弯曲而不是折线', () => {
  const start = { heading: radians(350), elevation: 0 };
  const control = { heading: radians(360), elevation: 0.4 };
  const end = { heading: radians(370), elevation: 0 };
  const line = samplePanoramaGuide({ kind: 'line', points: [start, end] }, 2);
  const curve = samplePanoramaGuide({ kind: 'quadratic', points: [start, control, end] }, 2);
  assert.deepEqual(line, [start, { heading: radians(360), elevation: 0 }, end]);
  assert.deepEqual(curve, [start, { heading: radians(360), elevation: 0.2 }, end]);
});

test('弧线增加节点时保持原形状，每段有独立控制点，删除新增节点可恢复原弧线', () => {
  const original: PanoramaGuide = { kind: 'quadratic', points: [
    { heading: 0, elevation: 0 }, { heading: 2, elevation: 2 }, { heading: 4, elevation: 0 },
  ] };
  const before = JSON.stringify(original);
  const expanded = addPanoramaGuideNode(original, 0);
  assert.deepEqual(expanded, { kind: 'bezier', points: [
    { heading: 0, elevation: 0 }, { heading: 1, elevation: 1 }, { heading: 2, elevation: 1 },
    { heading: 3, elevation: 1 }, { heading: 4, elevation: 0 },
  ] });
  assert.deepEqual(samplePanoramaGuide(expanded, 4), samplePanoramaGuide(original, 8));
  const edited = structuredClone(expanded);
  edited.points[1].elevation = 3;
  assert.deepEqual(samplePanoramaGuide(edited, 4).slice(4), samplePanoramaGuide(expanded, 4).slice(4));
  assert.deepEqual(removePanoramaGuideNode(expanded, 2), original);
  assert.equal(JSON.stringify(original), before);
});

test('多段贝塞尔跨正北映射时保留每段曲率，只裁切当前截图内的片段', () => {
  const shot = snapshot(0, 0);
  shot.ptz.raw.HorizontalFieldAngle = shot.ptz.raw.VerticalFieldAngle = 90;
  const guide: PanoramaGuide = { kind: 'bezier', points: [
    { heading: -Math.PI / 2, elevation: 0 }, { heading: -Math.PI / 4, elevation: 0.4 },
    { heading: 0, elevation: 0 }, { heading: Math.PI / 4, elevation: -0.4 },
    { heading: Math.PI / 2, elevation: 0 },
  ] };
  const fragments = projectPanoramaGuide(createPanoramaFrame(shot), guide);
  assert.equal(fragments.length, 2);
  assert.ok(Math.abs(fragments[0][0].x) < 1e-12);
  assert.ok(Math.abs(fragments[0].at(-1)!.x - 0.5) < 1e-12);
  assert.ok(Math.abs(fragments[1][0].x - 0.5) < 1e-12);
  assert.ok(Math.abs(fragments[1].at(-1)!.x - 1) < 1e-12);
  assert.ok(fragments[0].some((point) => point.y < 0.49));
  assert.ok(fragments[1].some((point) => point.y > 0.51));
  assert.ok(fragments.flat().every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
});

test('增删弧线节点保留端点，限制复杂度且拒绝无效节点选择', () => {
  const guide: PanoramaGuide = { kind: 'bezier', points: Array.from({ length: 65 }, (_, index) => ({ heading: index / 16, elevation: 0 })) };
  assert.throws(() => addPanoramaGuideNode(guide, 0), /最多/);
  assert.throws(() => removePanoramaGuideNode(guide, 0), /连接节点/);
  assert.throws(() => removePanoramaGuideNode(guide, 64), /连接节点/);
  assert.throws(() => removePanoramaGuideNode(guide, 1), /连接节点/);
  const reduced = removePanoramaGuideNode(guide, 2);
  assert.equal(reduced.points.length, 63);
  assert.deepEqual(reduced.points[0], guide.points[0]);
  assert.deepEqual(reduced.points.at(-1), guide.points.at(-1));
});

test('邻图参照按各自 T、FOV 和 Roll 映射，原始端点在画面外仍保留裁切参考线', () => {
  const source = snapshot(0, 0), target = snapshot(1, 0);
  source.ptz.raw.HorizontalFieldAngle = source.ptz.raw.VerticalFieldAngle = 90;
  target.ptz.raw.Tilt = 30;
  target.ptz.raw.HorizontalFieldAngle = 90;
  target.ptz.raw.VerticalFieldAngle = 60;
  target.calibration.imageRoll = 90;
  const sourceFrame = createPanoramaFrame(source), targetFrame = createPanoramaFrame(target);
  const points = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
  const before = JSON.stringify(points);
  const segments = projectImageLine(sourceFrame, targetFrame, points);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 2);
  for (const point of segments[0]) assert.ok(Math.abs(point.x - 0.21132486540518713) < 1e-12);
  assert.ok(Math.abs(segments[0][0].y - 1) < 1e-12);
  assert.ok(Math.abs(segments[0][1].y) < 1e-12);
  for (const point of points) {
    const direction = imagePointToPanoramaPoint(sourceFrame, point);
    assert.ok(direction);
    assert.equal(panoramaPointToImagePoint(targetFrame, direction), null);
  }
  target.ptz.raw.Pan = 180;
  target.scanTarget!.pan = 180;
  assert.deepEqual(projectImageLine(sourceFrame, createPanoramaFrame(target), points), []);
  assert.equal(JSON.stringify(points), before);
});

test('跨正北的原图直线映射相邻截图，只保留两张截图的实际重叠方向', () => {
  const source = snapshot(0, 350), target = snapshot(1, 10);
  for (const shot of [source, target]) shot.ptz.raw.HorizontalFieldAngle = 90;
  const fragments = projectImageLine(createPanoramaFrame(source), createPanoramaFrame(target),
    [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]);
  assert.equal(fragments.length, 1);
  assert.ok(Math.abs(fragments[0][0].x) < 1e-12);
  assert.ok(Math.abs(fragments[0][1].x - 0.7331538290774993) < 1e-12);
  for (const point of fragments[0]) assert.ok(Math.abs(point.y - 0.5) < 1e-12);
});

test('全景弧线保留可见曲率并分开背面缺口，禁止把两侧画面跨背面连接', () => {
  const shot = snapshot(0, 0);
  shot.ptz.raw.HorizontalFieldAngle = shot.ptz.raw.VerticalFieldAngle = 90;
  const frame = createPanoramaFrame(shot);
  const fragments = projectPanoramaGuide(frame, { kind: 'quadratic', points: [
    { heading: 0, elevation: 0 }, { heading: Math.PI, elevation: 0.8 }, { heading: 2 * Math.PI, elevation: 0 },
  ] });
  assert.equal(fragments.length, 2);
  assert.ok(fragments.every((fragment) => fragment.length > 3));
  const first = fragments[0], last = fragments[1];
  assert.ok(Math.abs(first[0].x - 0.5) < 1e-12 && Math.abs(first[0].y - 0.5) < 1e-12);
  assert.ok(Math.abs(first[first.length - 1].x - 1) < 1e-12);
  assert.ok(Math.abs(first[first.length - 1].y - 0.3762563132923542) < 1e-10);
  assert.ok(Math.abs(last[0].x) < 1e-12);
  assert.ok(Math.abs(last[last.length - 1].x - 0.5) < 1e-12);
  for (const point of fragments.flat()) assert.ok(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
});

test('整周弧线映射到未对准全局采样点的窄视场，局部仍保留足够曲线与左右边界', () => {
  const shot = snapshot(0, 180.2);
  shot.ptz.raw.Tilt = -5.710593137499643;
  shot.ptz.raw.HorizontalFieldAngle = shot.ptz.raw.VerticalFieldAngle = 0.1;
  const frame = createPanoramaFrame(shot);
  const fragments = projectPanoramaGuide(frame, { kind: 'quadratic', points: [
    { heading: 0, elevation: 0 }, { heading: Math.PI, elevation: 0.2 }, { heading: 2 * Math.PI, elevation: 0 },
  ] });
  assert.equal(fragments.length, 1);
  const curve = fragments[0];
  assert.ok(curve.length > 64);
  assert.ok(Math.abs(curve[0].x) < 1e-8);
  assert.ok(Math.abs(curve[curve.length - 1].x - 1) < 1e-8);
  for (const point of curve) assert.ok(point.y > 0.499 && point.y < 0.501);
});

test('弧线控制点超出两端方位后折返，画面外的中间范围形成独立可见片段', () => {
  const fragments = projectPanoramaGuide(createPanoramaFrame(snapshot(0, 0)), { kind: 'quadratic', points: [
    { heading: radians(-30), elevation: 0 }, { heading: radians(150), elevation: 0.2 },
    { heading: radians(-20), elevation: 0 },
  ] });
  assert.equal(fragments.length, 2);
  const first = fragments[0], second = fragments[1];
  assert.ok(Math.abs(first[0].x) < 1e-12 && Math.abs(first[first.length - 1].x - 1) < 1e-12);
  assert.ok(Math.abs(second[0].x - 1) < 1e-12 && Math.abs(second[second.length - 1].x) < 1e-12);
});

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

test('P 目标跨 0° 的截图按采样顺序拼成短扇区，原始姿态保持不变', () => {
  const shots = [snapshot(0, 350.666667), snapshot(1, 358), snapshot(2, 5.333333)];
  const before = JSON.stringify(shots);
  const { plan, data } = render([shots[2], shots[0], shots[1]]);
  assert.deepEqual(plan.frames.map(frame => frame.snapshot.id), shots.map(shot => shot.id));
  assert.ok(plan.frames[1].heading > plan.frames[0].heading);
  assert.ok(plan.frames[2].heading > plan.frames[1].heading);
  assert.ok(plan.width / plan.scale < radians(46));
  for (const angle of [350, 358, 360, 365]) {
    const sample = pixel(plan, data, angle);
    const expected = colorField(sample.heading, sample.slope);
    assert.equal(sample.rgba[3], 255);
    sample.rgba.slice(0, 3).forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 3));
  }
  assert.equal(JSON.stringify(shots), before);
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

test('置顶当前帧使用原全景计划，重叠中心与边缘均保持当前图不透明颜色', () => {
  const shots = [snapshot(0, 350), snapshot(1, 0), snapshot(2, 10)];
  const overview = render(shots, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
  const frame = overview.plan.frames[1];
  const output = new Uint8ClampedArray(overview.data.length);
  blendPanoramaFrame(overview.plan, frame, syntheticImage(frame.snapshot, [0, 255, 0]), output,
    new Float32Array(overview.plan.width * overview.plan.height));
  for (const angle of [346, 350, 360, 370, 374]) {
    assert.deepEqual(pixel(overview.plan, output, angle).rgba, [0, 255, 0, 255]);
  }
  assert.equal(pixel(overview.plan, output, 340).rgba[3], 0);
  assert.deepEqual(pixel(overview.plan, overview.data, 340).rgba, [255, 0, 0, 255]);
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

test('全景标注与倾斜、T 偏移和 Roll 下的原图像素一一对应', () => {
  const shots = [snapshot(0, 350), snapshot(1, 10)];
  for (const shot of shots) {
    Object.assign(shot.calibration, { pAxisPitch: 3, pAxisRoll: -2, panOffset: 15, tiltOffset: 2, imageRoll: 4 });
    shot.ptz.raw.Tilt = 5;
  }
  const before = JSON.stringify(shots);
  const plan = createPanoramaPlan(shots);
  const endpoints = [{ x: 0.1, y: 0.3 }, { x: 0.9, y: 0.65 }];
  for (const frame of plan.frames) {
    const rotation = createLocalRigRotation(frame.snapshot.calibration, frame.snapshot.ptz.raw).camera;
    const projected = projectPanoramaLine(plan, frame, endpoints);
    assert.ok(projected.length > 2);
    for (const [index, point] of projected.entries()) {
      const angle = plan.minHeading + point.x / plan.scale;
      const slope = plan.maxY - point.y / plan.scale;
      const ray = [Math.sin(angle), Math.cos(angle), slope];
      const forward = ray.reduce((sum, value, axis) => sum + value * rotation[3 + axis], 0);
      const right = ray.reduce((sum, value, axis) => sum + value * rotation[axis], 0);
      const up = ray.reduce((sum, value, axis) => sum + value * rotation[6 + axis], 0);
      const fraction = index / (projected.length - 1);
      assert.ok(Math.abs((right / forward / frame.tanH + 1) / 2 - (0.1 + 0.8 * fraction)) < 1e-12);
      assert.ok(Math.abs((1 - up / forward / frame.tanV) / 2 - (0.3 + 0.35 * fraction)) < 1e-12);
      assert.ok(point.x >= 0 && point.x <= plan.width && point.y >= 0 && point.y <= plan.height);
    }
  }
  assert.equal(JSON.stringify(shots), before);
});

test('原图直线在全景中保留圆柱弯曲，跨正北的相邻标注对齐且不掩盖错误', () => {
  const shots = [snapshot(0, 350), snapshot(1, 10)];
  for (const shot of shots) {
    shot.width = 600;
    shot.height = 400;
    shot.ptz.raw.HorizontalFieldAngle = 90;
    shot.ptz.raw.VerticalFieldAngle = 60;
  }
  const plan = createPanoramaPlan(shots);
  const endpoints = [{ x: 0.1, y: 0.3 }, { x: 0.9, y: 0.3 }];
  const curve = projectPanoramaLine(plan, plan.frames[0], endpoints);
  assert.ok(Math.abs(curve[Math.floor(curve.length / 2)].y - (curve[0].y + curve[curve.length - 1].y) / 2) > 1);
  const shared = plan.frames.map((frame, index) => {
    const x = (Math.tan(radians(index ? -10 : 10)) / frame.tanH + 1) / 2;
    return projectPanoramaLine(plan, frame, [{ x, y: 0.5 }, { x: 0.9, y: 0.5 }])[0];
  });
  assert.ok(Math.abs(shared[0].x - shared[1].x) < 1e-10);
  assert.ok(Math.abs(shared[0].y - shared[1].y) < 1e-10);
  const wrong = projectPanoramaLine(plan, plan.frames[1], [{ x: 0.1, y: 0.7 }, { x: 0.9, y: 0.7 }]);
  assert.ok(Math.abs(wrong[0].y - shared[1].y) > 10);
  assert.deepEqual(projectPanoramaLine(plan, plan.frames[0], []), []);
  assert.deepEqual(projectPanoramaLine(plan, plan.frames[0], [{ x: -0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]), []);
});

test('全景海天线自动延长到左右边缘，聚焦留缝不改写原始标注', () => {
  const points = [{ x: 0.8, y: 0.55 }, { x: 0.2, y: 0.4 }];
  const before = JSON.stringify(points);
  const extended = extendHorizonLine(points);
  assert.deepEqual(extended.map((point) => point.x), [0, 1]);
  assert.ok(Math.abs(extended[0].y - 0.35) < 1e-12);
  assert.ok(Math.abs(extended[1].y - 0.6) < 1e-12);
  const focused = extendHorizonLine(points, 0.03);
  assert.deepEqual(focused.map((point) => point.x), [0.03, 0.97]);
  for (const point of focused) assert.ok(Math.abs(point.y - (0.35 + point.x * 0.25)) < 1e-12);
  assert.equal(JSON.stringify(points), before);
});

test('延长线在上下边界裁切，不显示画面外线段或无效直线', () => {
  const points = [{ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.8 }];
  const extended = extendHorizonLine(points);
  assert.ok(Math.abs(extended[0].x - 1 / 3) < 1e-12);
  assert.ok(Math.abs(extended[1].x - 2 / 3) < 1e-12);
  assert.ok(Math.abs(extended[0].y) < 1e-12);
  assert.ok(Math.abs(extended[1].y - 1) < 1e-12);
  assert.deepEqual(extendHorizonLine([]), []);
  assert.deepEqual(extendHorizonLine([{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }]), []);
  assert.deepEqual(extendHorizonLine([{ x: 0, y: 1.2 }, { x: 1, y: 1.2 }]), []);
  assert.deepEqual(extendHorizonLine([{ x: NaN, y: 0.5 }, { x: 1, y: 0.5 }]), []);
});

test('全景端点上下拖动保留留缝横坐标，跨正北、倾斜和 Roll 下均跟随目标高度', () => {
  const shots = [snapshot(0, 350), snapshot(1, 10), snapshot(2, 90)];
  for (const shot of shots) {
    Object.assign(shot.calibration, { pAxisPitch: 4, pAxisRoll: -3, panOffset: 12, tiltOffset: 2, imageRoll: -12 });
    shot.ptz.raw.Tilt = 8;
    shot.ptz.raw.HorizontalFieldAngle = 80;
    shot.ptz.raw.VerticalFieldAngle = 50;
  }
  const plan = createPanoramaPlan(shots);
  for (const frame of plan.frames) {
    for (const x of [0.03, 0.97]) {
      const endpoints = [{ x, y: 0.2 }, { x, y: 0.8 }];
      const projected = projectPanoramaLine(plan, frame, endpoints);
      projected.forEach((point, index) => {
        const restored = movePanoramaEndpoint(plan, frame, endpoints[0], point.y - projected[0].y);
        assert.ok(restored);
        const fraction = index / (projected.length - 1);
        assert.equal(restored.x, x);
        assert.ok(Math.abs(restored.y - (0.2 + fraction * 0.6)) < 1e-10);
      });
    }
    assert.equal(movePanoramaEndpoint(plan, frame, { x: NaN, y: 0.5 }, 0), null);
  }
});

test('大幅拖动在原图上下边缘停止，Roll 下仍使用全景中的实际位移', () => {
  for (const roll of [-35, 30, 65, 150]) {
    const shots = [snapshot(0, 0), snapshot(1, 20)];
    shots.forEach((shot) => { shot.calibration.imageRoll = roll; });
    const plan = createPanoramaPlan(shots), frame = plan.frames[0];
    const start = { x: 0.03, y: 0.4 }, end = { x: 0.03, y: 0.7 };
    const curve = projectPanoramaLine(plan, frame, [start, end]);
    const moved = movePanoramaEndpoint(plan, frame, start, curve[curve.length - 1].y - curve[0].y);
    assert.ok(moved && Math.abs(moved.y - end.y) < 1e-10);
    const upper = movePanoramaEndpoint(plan, frame, start, -100000);
    const lower = movePanoramaEndpoint(plan, frame, start, 100000);
    assert.ok(upper && lower);
    assert.deepEqual([upper.y, lower.y].sort(), [0, 1]);
  }
});
