import { Cartesian3, Matrix3 } from 'cesium';
import { activeZeroPoseOf, calibratedZeroPose, createZeroPoseRigRotation } from '#zero-pose';
import type { HorizonPoint, Snapshot } from './models';
import type { PanoramaGuide, PanoramaGuidePoint } from '../../shared/panorama-guide';

export interface PanoramaFrame {
  snapshot: Snapshot;
  right: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  tanH: number;
  tanV: number;
  heading: number;
  minHeading: number;
  maxHeading: number;
  minY: number;
  maxY: number;
  density: number;
}

export interface PanoramaPlan {
  frames: PanoramaFrame[];
  minHeading: number;
  maxY: number;
  scale: number;
  width: number;
  height: number;
}

export interface PanoramaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const radians = (degrees: number) => degrees * Math.PI / 180;
const unwrap = (angle: number, near: number) => angle + Math.round((near - angle) / (2 * Math.PI)) * 2 * Math.PI;

export function createPanoramaFrame(snapshot: Snapshot, referenceHeading?: number): PanoramaFrame {
  const raw = snapshot.ptz.raw;
  const calibration = snapshot.calibration;
  if (![raw.Pan, raw.Tilt, snapshot.width, snapshot.height, calibration.pAxisPitch, calibration.pAxisRoll,
    calibration.panOffset, calibration.tiltOffset, calibration.imageRoll]
    .every(Number.isFinite) || snapshot.width <= 0 || snapshot.height <= 0
    || raw.HorizontalFieldAngle === null || raw.VerticalFieldAngle === null
    || !(raw.HorizontalFieldAngle > 0 && raw.HorizontalFieldAngle < 180 && raw.VerticalFieldAngle > 0 && raw.VerticalFieldAngle < 180)) {
    throw new Error('截图的 PTZ、视场角或图片尺寸无效，无法生成全景图');
  }
  const rotation = createZeroPoseRigRotation(calibratedZeroPose(calibration), raw).camera;
  const right = Matrix3.getColumn(rotation, 0, new Cartesian3());
  const direction = Matrix3.getColumn(rotation, 1, new Cartesian3());
  const up = Matrix3.getColumn(rotation, 2, new Cartesian3());
  const tanH = Math.tan(radians(raw.HorizontalFieldAngle / 2));
  const tanV = Math.tan(radians(raw.VerticalFieldAngle / 2));
  const verticalForward = Math.abs(direction.z);
  if (verticalForward > 0 && Math.abs(right.z / verticalForward) <= tanH && Math.abs(up.z / verticalForward) <= tanV) {
    throw new Error('画面包含竖直方向，无法生成水平全景图');
  }
  const heading = unwrap(Math.atan2(direction.x, direction.y), referenceHeading
    ?? radians((activeZeroPoseOf(calibration)?.yaw ?? calibration.panOffset) + (snapshot.scanTarget?.pan ?? raw.Pan)));
  const frame = { snapshot, right, direction, up, tanH, tanV, heading,
    minHeading: Infinity, maxHeading: -Infinity, minY: Infinity, maxY: -Infinity,
    density: Math.min(snapshot.width / (2 * tanH), snapshot.height / (2 * tanV)) };
  // 圆柱投影的上下极值可能出现在边线中间，沿边采样以包含完整画面。
  for (let index = 0; index <= 32; index++) {
    const value = index / 16 - 1;
    for (const [x, y] of [[value, -1], [value, 1], [-1, value], [1, value]]) {
      const point = imagePointToPanoramaPoint(frame, { x: (x + 1) / 2, y: (1 - y) / 2 });
      if (!point || Math.abs(point.elevation) > 20) throw new Error('画面接近竖直方向，无法生成水平全景图');
      frame.minHeading = Math.min(frame.minHeading, point.heading);
      frame.maxHeading = Math.max(frame.maxHeading, point.heading);
      frame.minY = Math.min(frame.minY, point.elevation);
      frame.maxY = Math.max(frame.maxY, point.elevation);
    }
  }
  return frame;
}

export function imagePointToPanoramaPoint(frame: PanoramaFrame, point: HorizonPoint): PanoramaGuidePoint | null {
  if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const ray = imageRay(frame, point);
  const horizontal = Math.hypot(ray.x, ray.y);
  return horizontal < 1e-6 ? null : { heading: unwrap(Math.atan2(ray.x, ray.y), frame.heading), elevation: ray.z / horizontal };
}

function imageRay(frame: PanoramaFrame, point: HorizonPoint): Cartesian3 {
  const u = (2 * point.x - 1) * frame.tanH;
  const v = (1 - 2 * point.y) * frame.tanV;
  return new Cartesian3(frame.direction.x + frame.right.x * u + frame.up.x * v,
    frame.direction.y + frame.right.y * u + frame.up.y * v,
    frame.direction.z + frame.right.z * u + frame.up.z * v);
}

export function panoramaPointToImagePoint(frame: PanoramaFrame, point: PanoramaGuidePoint): HorizonPoint | null {
  if (![point.heading, point.elevation].every(Number.isFinite)) return null;
  return rayToImagePoint(frame, Math.sin(point.heading), Math.cos(point.heading), point.elevation);
}

function rayToImagePoint(frame: PanoramaFrame, rx: number, ry: number, rz: number): HorizonPoint | null {
  const forward = rx * frame.direction.x + ry * frame.direction.y + rz * frame.direction.z;
  if (forward <= 0) return null;
  const x = ((rx * frame.right.x + ry * frame.right.y + rz * frame.right.z) / forward / frame.tanH + 1) / 2;
  const y = (1 - (rx * frame.up.x + ry * frame.up.y + rz * frame.up.z) / forward / frame.tanV) / 2;
  if (x < -1e-12 || x > 1 + 1e-12 || y < -1e-12 || y > 1 + 1e-12) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function panoramaPixelToPoint(plan: PanoramaPlan, pixel: HorizonPoint): PanoramaGuidePoint {
  // 画布向上取整的尾部不代表额外方位；为展开方位的浮点加减保留数值余量。
  const turn = 2 * Math.PI;
  const maxSpan = turn - 4 * Number.EPSILON * Math.max(turn, Math.abs(plan.minHeading));
  return { heading: plan.minHeading + Math.min(pixel.x / plan.scale, maxSpan),
    elevation: plan.maxY - pixel.y / plan.scale };
}

export function panoramaPointToPixel(plan: PanoramaPlan, point: PanoramaGuidePoint): HorizonPoint {
  return { x: (point.heading - plan.minHeading) * plan.scale, y: (plan.maxY - point.elevation) * plan.scale };
}

export function panoramaGuideHeadingOffset(plan: PanoramaPlan, guide: PanoramaGuide): number {
  const headings = guide.points.map((point) => point.heading);
  const guideCenter = (Math.min(...headings) + Math.max(...headings)) / 2;
  const planCenter = plan.minHeading + plan.width / (2 * plan.scale);
  // 删除跨零前的截图后，展开圈数可能整体变化；所有点共用偏移才能保留弧线形状。
  return (Math.round((planCenter - guideCenter) / (2 * Math.PI)) || 0) * 2 * Math.PI;
}

// 每段独立采样，最多 32 段，避免拖动时产生过多投影片段。
export const panoramaGuidePointLimit = 65;
type PanoramaGuideSegment = Exclude<PanoramaGuide, { kind: 'bezier' }>;

export function addPanoramaGuideNode(guide: PanoramaGuide, segment: number): PanoramaGuide {
  if (guide.kind === 'line') throw new Error('请先绘制弧线');
  if (guide.points.length >= panoramaGuidePointLimit) throw new Error('弧线最多支持 32 段');
  if (!Number.isInteger(segment) || segment < 0 || segment >= (guide.points.length - 1) / 2) throw new Error('请选择有效的弧线段');
  const points = guide.points.map((point) => ({ ...point }));
  const index = segment * 2, start = points[index], control = points[index + 1], end = points[index + 2];
  const middle = (left: PanoramaGuidePoint, right: PanoramaGuidePoint) => ({
    heading: (left.heading + right.heading) / 2, elevation: (left.elevation + right.elevation) / 2,
  });
  const left = middle(start, control), right = middle(control, end);
  // de Casteljau 对半拆分保留原曲线，新增节点只增加局部编辑自由度。
  points.splice(index, 3, start, left, middle(left, right), right, end);
  return { kind: 'bezier', points };
}

export function removePanoramaGuideNode(guide: PanoramaGuide, index: number): PanoramaGuide {
  if (guide.kind !== 'bezier' || !Number.isInteger(index) || index % 2 !== 0 || index <= 0 || index >= guide.points.length - 1) {
    throw new Error('请选择弧线内部的连接节点');
  }
  const points = guide.points.map((point) => ({ ...point }));
  const start = points[index - 2], left = points[index - 1], right = points[index + 1], end = points[index + 2];
  const control = { heading: left.heading + right.heading - (start.heading + end.heading) / 2,
    elevation: left.elevation + right.elevation - (start.elevation + end.elevation) / 2 };
  points.splice(index - 1, 3, control);
  const remaining = points.filter((_, position) => position !== index - 1).map((point) => point.heading);
  const turn = 2 * Math.PI, margin = 4 * Number.EPSILON * Math.max(turn, ...remaining.map(Math.abs));
  // 合并已调整的两段可能把控制点推到一周之外，只约束新增控制点，保留其余点位。
  control.heading = Math.max(Math.max(...remaining) - turn + margin, Math.min(Math.min(...remaining) + turn - margin, control.heading));
  return points.length === 3 ? { kind: 'quadratic', points: [points[0], points[1], points[2]] } : { kind: 'bezier', points };
}

function panoramaGuideSegments(guide: PanoramaGuide): PanoramaGuideSegment[] {
  if (guide.kind !== 'bezier') return [guide];
  const result: PanoramaGuideSegment[] = [];
  for (let index = 0; index < guide.points.length - 2; index += 2) {
    result.push({ kind: 'quadratic', points: [guide.points[index], guide.points[index + 1], guide.points[index + 2]] });
  }
  return result;
}

export function samplePanoramaGuide(guide: PanoramaGuide, segments = 128): PanoramaGuidePoint[] {
  return panoramaGuideSegments(guide).flatMap((part, partIndex) =>
    Array.from({ length: segments + 1 }, (_, index) => guidePointAt(part, index / segments)).slice(partIndex ? 1 : 0));
}

function guidePointAt(guide: PanoramaGuideSegment, t: number): PanoramaGuidePoint {
  const remaining = 1 - t;
  const start = guide.points[0], end = guide.points[guide.points.length - 1];
  if (guide.kind === 'line') return { heading: remaining * start.heading + t * end.heading,
    elevation: remaining * start.elevation + t * end.elevation };
  const control = guide.points[1];
  return { heading: remaining * remaining * start.heading + 2 * remaining * t * control.heading + t * t * end.heading,
    elevation: remaining * remaining * start.elevation + 2 * remaining * t * control.elevation + t * t * end.elevation };
}

export function projectPanoramaGuide(frame: PanoramaFrame, guide: PanoramaGuide): HorizonPoint[][] {
  return panoramaGuideSegments(guide).flatMap((part) => projectPanoramaGuideSegment(frame, part));
}

function projectPanoramaGuideSegment(frame: PanoramaFrame, guide: PanoramaGuideSegment): HorizonPoint[][] {
  const first = guide.points[0].heading, last = guide.points[guide.points.length - 1].heading;
  const control = guide.kind === 'quadratic' ? guide.points[1].heading : (first + last) / 2;
  const a = (last - control) - (control - first), b = 2 * (control - first);
  const rootsAt = (heading: number) => {
    const c = first - heading;
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return [];
    const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
    return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
  };
  const cutPoints = [0, 1];
  const min = Math.min(first, control, last), max = Math.max(first, control, last), turn = 2 * Math.PI;
  for (let shift = Math.ceil((min - frame.maxHeading) / turn); shift <= Math.floor((max - frame.minHeading) / turn); shift++) {
    for (const heading of [frame.minHeading + shift * turn, frame.maxHeading + shift * turn]) {
      cutPoints.push(...rootsAt(heading).filter((t) => t > 0 && t < 1));
    }
  }
  cutPoints.sort((left, right) => left - right);
  const fragments: HorizonPoint[][] = [];
  for (let index = 1; index < cutPoints.length; index++) {
    const from = cutPoints[index - 1], to = cutPoints[index];
    if (to - from < 1e-14) continue;
    const heading = unwrap(guidePointAt(guide, (from + to) / 2).heading, frame.heading);
    if (heading < frame.minHeading - 1e-12 || heading > frame.maxHeading + 1e-12) continue;
    // 只对当前截图方位覆盖内的参数区间采样，长全景中的高倍窄视场也保留曲线。
    const rays = Array.from({ length: 129 }, (_, index) => {
      const point = guidePointAt(guide, from + (to - from) * index / 128);
      return new Cartesian3(Math.sin(point.heading), Math.cos(point.heading), point.elevation);
    });
    fragments.push(...projectVisibleRays(frame, rays));
  }
  return fragments;
}

export function projectImageLine(source: PanoramaFrame, target: PanoramaFrame, points: HorizonPoint[]): HorizonPoint[][] {
  if (points.length !== 2 || points.some((point) => ![point.x, point.y].every(Number.isFinite)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return [];
  return projectVisibleRays(target, points.map((point) => imageRay(source, point)));
}

function projectVisibleRays(frame: PanoramaFrame, rays: Cartesian3[]): HorizonPoint[][] {
  const cameraRays = rays.map((ray) => new Cartesian3(Cartesian3.dot(ray, frame.right) / frame.tanH,
    Cartesian3.dot(ray, frame.up) / frame.tanV, Cartesian3.dot(ray, frame.direction)));
  const fragments: HorizonPoint[][] = [];
  let current: HorizonPoint[] | null = null;
  for (let index = 1; index < cameraRays.length; index++) {
    const start = cameraRays[index - 1], end = cameraRays[index];
    let from = 0, to = 1;
    // 先在齐次视锥中裁切，避免背面投影倒置、无穷坐标以及跨缺口连线。
    for (const [a, b] of [[start.z - 1e-9, end.z - 1e-9], [start.z + start.x, end.z + end.x],
      [start.z - start.x, end.z - end.x], [start.z + start.y, end.z + end.y], [start.z - start.y, end.z - end.y]]) {
      if (a < 0 && b < 0) { to = -1; break; }
      if (a < 0) from = Math.max(from, a / (a - b));
      if (b < 0) to = Math.min(to, a / (a - b));
    }
    if (from >= to) { current = null; continue; }
    const clipped = [from, to].map((t) => {
      const ray = Cartesian3.lerp(start, end, t, new Cartesian3());
      return { x: Math.max(0, Math.min(1, (ray.x / ray.z + 1) / 2)),
        y: Math.max(0, Math.min(1, (1 - ray.y / ray.z) / 2)) };
    });
    const previous = current?.[current.length - 1];
    if (!previous || Math.hypot(previous.x - clipped[0].x, previous.y - clipped[0].y) > 1e-9) {
      current = [clipped[0]];
      fragments.push(current);
    }
    current!.push(clipped[1]);
  }
  return fragments;
}

export function createPanoramaPlan(snapshots: Snapshot[]): PanoramaPlan {
  if (snapshots.length < 2) throw new Error('至少需要两张截图才能生成全景图');
  const ordered = [...snapshots].sort((a, b) => (a.scanIndex ?? a.ptz.raw.Pan) - (b.scanIndex ?? b.ptz.raw.Pan));
  const first = ordered[0];
  const firstPan = first.scanTarget?.pan ?? first.ptz.raw.Pan;
  const frames = ordered.map((snapshot): PanoramaFrame => {
    if (snapshot.cameraId !== first.cameraId || snapshot.serial !== first.serial || snapshot.code !== first.code) {
      throw new Error('全景图只能使用同一摄像头通道的截图');
    }
    // 用任务的目标 P 展开跨越正北的方位，避免 359° 和 1° 被排到全景两端。
    const targetPan = snapshot.scanTarget?.pan ?? snapshot.ptz.raw.Pan;
    const yaw = activeZeroPoseOf(snapshot.calibration)?.yaw ?? snapshot.calibration.panOffset;
    const reference = radians(yaw + targetPan + (targetPan < firstPan ? 360 : 0));
    return createPanoramaFrame(snapshot, reference);
  });
  let minHeading = Infinity;
  let maxHeading = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let density = Infinity;
  for (const frame of frames) {
    minHeading = Math.min(minHeading, frame.minHeading);
    maxHeading = Math.max(maxHeading, frame.maxHeading);
    minY = Math.min(minY, frame.minY);
    maxY = Math.max(maxY, frame.maxY);
    density = Math.min(density, frame.density);
  }
  const span = Math.min(2 * Math.PI, maxHeading - minHeading);
  const vertical = maxY - minY;
  if (!(span > 0 && vertical > 0 && Number.isFinite(density))) throw new Error('截图的有效覆盖范围不足，无法生成全景图');
  // 控制浏览器 Canvas 尺寸和像素缓冲，避免高倍率长任务耗尽内存。
  const scale = Math.min(density, 16383 / span, 4095 / vertical, Math.sqrt(15000000 / (span * vertical)));
  return { frames, minHeading, maxY, scale, width: Math.ceil(span * scale), height: Math.ceil(vertical * scale) };
}

export function blendPanoramaFrame(plan: PanoramaPlan, frame: PanoramaFrame, source: PanoramaImage,
  output: Uint8ClampedArray, weights: Float32Array): void {
  const left = Math.max(0, Math.floor((frame.minHeading - plan.minHeading) * plan.scale));
  const right = Math.min(plan.width, Math.ceil((frame.maxHeading - plan.minHeading) * plan.scale));
  const top = Math.max(0, Math.floor((plan.maxY - frame.maxY) * plan.scale));
  const bottom = Math.min(plan.height, Math.ceil((plan.maxY - frame.minY) * plan.scale));
  if (right <= left || bottom <= top) return;
  const sin = new Float64Array(right - left);
  const cos = new Float64Array(right - left);
  for (let x = left; x < right; x++) {
    const angle = plan.minHeading + (x + 0.5) / plan.scale;
    sin[x - left] = Math.sin(angle);
    cos[x - left] = Math.cos(angle);
  }
  for (let y = top; y < bottom; y++) {
    const elevation = plan.maxY - (y + 0.5) / plan.scale;
    for (let x = left; x < right; x++) {
      const rx = sin[x - left];
      const ry = cos[x - left];
      const point = rayToImagePoint(frame, rx, ry, elevation);
      if (!point) continue;
      const u = point.x, v = point.y;
      const sx = Math.max(0, Math.min(source.width - 1, u * source.width - 0.5));
      const sy = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const y1 = Math.min(source.height - 1, y0 + 1);
      const ax = sx - x0;
      const ay = sy - y0;
      const i00 = (y0 * source.width + x0) * 4;
      const i10 = (y0 * source.width + x1) * 4;
      const i01 = (y1 * source.width + x0) * 4;
      const i11 = (y1 * source.width + x1) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      const alpha = source.data[i00 + 3] * w00 + source.data[i10 + 3] * w10
        + source.data[i01 + 3] * w01 + source.data[i11 + 3] * w11;
      if (alpha <= 0) continue;
      const feather = Math.max(0.001, Math.min(1, Math.min(u, 1 - u, v, 1 - v) / 0.08));
      const weight = feather * alpha / 255;
      const pixel = y * plan.width + x;
      const previous = weights[pixel];
      for (let channel = 0; channel < 3; channel++) {
        const value = source.data[i00 + channel] * w00 + source.data[i10 + channel] * w10
          + source.data[i01 + channel] * w01 + source.data[i11 + channel] * w11;
        output[pixel * 4 + channel] = (output[pixel * 4 + channel] * previous + value * weight) / (previous + weight);
      }
      output[pixel * 4 + 3] = Math.max(output[pixel * 4 + 3], alpha);
      weights[pixel] = previous + weight;
    }
  }
}

export function projectPanoramaLine(plan: PanoramaPlan, frame: PanoramaFrame, points: HorizonPoint[]): { x: number; y: number }[] {
  if (points.length !== 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return [];
  // 原图直线投到圆柱面后可能弯曲，逐段投影，保留各图标注之间的真实错位与缺口。
  return Array.from({ length: 65 }, (_, index) => {
    const fraction = index / 64;
    const point = imagePointToPanoramaPoint(frame, { x: points[0].x + (points[1].x - points[0].x) * fraction,
      y: points[0].y + (points[1].y - points[0].y) * fraction });
    return panoramaPointToPixel(plan, point!);
  });
}

export function extendHorizonLine(points: HorizonPoint[], inset = 0): HorizonPoint[] {
  if (points.length !== 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || Math.abs(points[1].x - points[0].x) < 1e-6) return [];
  const slope = (points[1].y - points[0].y) / (points[1].x - points[0].x);
  const heightAt = (x: number) => points[0].y + (x - points[0].x) * slope;
  let left = inset, right = 1 - inset;
  // 倾斜线可能先穿出上下边界，只延长画面内可见的部分。
  if (slope !== 0) {
    const top = points[0].x - points[0].y / slope;
    const bottom = points[0].x + (1 - points[0].y) / slope;
    left = Math.max(left, Math.min(top, bottom));
    right = Math.min(right, Math.max(top, bottom));
  }
  if (left >= right || heightAt(left) < -1e-9 || heightAt(left) > 1 + 1e-9) return [];
  return [left, right].map((x) => ({ x, y: Math.max(0, Math.min(1, heightAt(x))) }));
}

export function movePanoramaEndpoint(plan: PanoramaPlan, frame: PanoramaFrame, point: HorizonPoint, deltaY: number): HorizonPoint | null {
  if (![point.x, point.y, deltaY].every(Number.isFinite) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const u = (2 * point.x - 1) * frame.tanH;
  const project = (y: number) => {
    const v = (1 - 2 * y) * frame.tanV;
    const rx = frame.direction.x + frame.right.x * u + frame.up.x * v;
    const ry = frame.direction.y + frame.right.y * u + frame.up.y * v;
    const rz = frame.direction.z + frame.right.z * u + frame.up.z * v;
    const horizontal = Math.hypot(rx, ry);
    return { pixel: (plan.maxY - rz / horizontal) * plan.scale,
      derivative: 2 * frame.tanV * plan.scale * (frame.up.z * horizontal * horizontal
        - rz * (rx * frame.up.x + ry * frame.up.y)) / (horizontal ** 3) };
  };
  const target = project(point.y).pixel + deltaY;
  let y = point.y;
  // 固定原图横坐标反求纵坐标，避免 Roll 下忽略横向分量造成拖动偏移。
  for (let iteration = 0; iteration < 12; iteration++) {
    const current = project(y);
    if (Math.abs(current.derivative) < 1e-9) return null;
    const next = Math.max(0, Math.min(1, y + (target - current.pixel) / current.derivative));
    if (Math.abs(next - y) < 1e-12) return { x: point.x, y: next };
    y = next;
  }
  return Math.abs(project(y).pixel - target) < 1e-6 ? { x: point.x, y } : null;
}
