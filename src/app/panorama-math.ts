import { Cartesian3, Matrix3 } from 'cesium';
import { createLocalRigRotation } from '#camera-rotation';
import type { Snapshot } from './models';

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

export function createPanoramaPlan(snapshots: Snapshot[]): PanoramaPlan {
  if (snapshots.length < 2) throw new Error('至少需要两张截图才能生成全景图');
  const ordered = [...snapshots].sort((a, b) => (a.scanIndex ?? a.ptz.raw.Pan) - (b.scanIndex ?? b.ptz.raw.Pan));
  const first = ordered[0];
  const frames = ordered.map((snapshot): PanoramaFrame => {
    const raw = snapshot.ptz.raw;
    if (snapshot.cameraId !== first.cameraId || snapshot.serial !== first.serial || snapshot.code !== first.code) {
      throw new Error('全景图只能使用同一摄像头通道的截图');
    }
    const calibration = snapshot.calibration;
    if (![raw.Pan, raw.Tilt, snapshot.width, snapshot.height, calibration.pAxisPitch, calibration.pAxisRoll,
      calibration.panOffset, calibration.tiltOffset, calibration.imageRoll]
      .every(Number.isFinite) || snapshot.width <= 0 || snapshot.height <= 0
      || raw.HorizontalFieldAngle === null || raw.VerticalFieldAngle === null
      || !(raw.HorizontalFieldAngle > 0 && raw.HorizontalFieldAngle < 180 && raw.VerticalFieldAngle > 0 && raw.VerticalFieldAngle < 180)) {
      throw new Error('截图的 PTZ、视场角或图片尺寸无效，无法生成全景图');
    }
    const rotation = createLocalRigRotation(snapshot.calibration, raw).camera;
    const right = Matrix3.getColumn(rotation, 0, new Cartesian3());
    const direction = Matrix3.getColumn(rotation, 1, new Cartesian3());
    const up = Matrix3.getColumn(rotation, 2, new Cartesian3());
    const tanH = Math.tan(radians(raw.HorizontalFieldAngle / 2));
    const tanV = Math.tan(radians(raw.VerticalFieldAngle / 2));
    const verticalForward = Math.abs(direction.z);
    if (verticalForward > 0 && Math.abs(right.z / verticalForward) <= tanH && Math.abs(up.z / verticalForward) <= tanV) {
      throw new Error('画面包含竖直方向，无法生成水平全景图');
    }
    // 用任务的目标 P 展开跨越正北的方位，避免 359° 和 1° 被排到全景两端。
    const reference = radians(snapshot.calibration.panOffset + (snapshot.scanTarget?.pan ?? raw.Pan));
    const heading = unwrap(Math.atan2(direction.x, direction.y), reference);
    const frame = { snapshot, right, direction, up, tanH, tanV, heading,
      minHeading: Infinity, maxHeading: -Infinity, minY: Infinity, maxY: -Infinity,
      density: Math.min(snapshot.width / (2 * tanH), snapshot.height / (2 * tanV)) };
    // 圆柱投影的上下极值可能出现在边线中间，沿边采样以包含完整画面。
    for (let index = 0; index <= 32; index++) {
      const value = index / 16 - 1;
      for (const [x, y] of [[value, -1], [value, 1], [-1, value], [1, value]]) {
        const rx = direction.x + right.x * x * tanH + up.x * y * tanV;
        const ry = direction.y + right.y * x * tanH + up.y * y * tanV;
        const rz = direction.z + right.z * x * tanH + up.z * y * tanV;
        const horizontal = Math.hypot(rx, ry);
        if (horizontal < 1e-6 || Math.abs(rz / horizontal) > 20) throw new Error('画面接近竖直方向，无法生成水平全景图');
        const angle = unwrap(Math.atan2(rx, ry), heading);
        frame.minHeading = Math.min(frame.minHeading, angle);
        frame.maxHeading = Math.max(frame.maxHeading, angle);
        frame.minY = Math.min(frame.minY, rz / horizontal);
        frame.maxY = Math.max(frame.maxY, rz / horizontal);
      }
    }
    return frame;
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
      const forward = rx * frame.direction.x + ry * frame.direction.y + elevation * frame.direction.z;
      if (forward <= 0) continue;
      const u = ((rx * frame.right.x + ry * frame.right.y + elevation * frame.right.z) / forward / frame.tanH + 1) / 2;
      const v = (1 - (rx * frame.up.x + ry * frame.up.y + elevation * frame.up.z) / forward / frame.tanV) / 2;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
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
