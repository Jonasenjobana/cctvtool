import type { HorizonPoint } from './models';

export interface HorizonView { left: number; top: number; zoom: number }
export type HorizonAdjustment = 0 | 1 | 'line';

export const fullHorizonView: HorizonView = { left: 0, top: 0, zoom: 1 };

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function horizonView(zoom: number, left: number, top: number): HorizonView {
  const limit = 1 - 1 / zoom;
  return { left: clamp(left, 0, limit), top: clamp(top, 0, limit), zoom };
}

export function zoomHorizonView(view: HorizonView, zoom: number, anchor: HorizonPoint): HorizonView {
  const point = horizonPointInView(view, anchor);
  return horizonView(zoom, point.x - anchor.x / zoom, point.y - anchor.y / zoom);
}

export function horizonPointInView(view: HorizonView, relative: HorizonPoint): HorizonPoint {
  return {
    x: clamp(view.left + relative.x / view.zoom, 0, 1),
    y: clamp(view.top + relative.y / view.zoom, 0, 1),
  };
}

export function horizonPixelStep(zoom: number, source: { width: number; height: number }, viewport: { width: number; height: number }): number | null {
  // SVG 按完整比例显示裁剪区。屏幕上的一个像素映射到原图的多少，由真实显示比例决定。
  const scale = zoom * Math.min(viewport.width / source.width, viewport.height / source.height);
  return scale > 0 && Number.isFinite(scale) ? 1 / scale : null;
}

export function shiftHorizonPixels(points: HorizonPoint[], adjustment: HorizonAdjustment, pixels: number, height: number): HorizonPoint[] {
  if (points.length !== 2) return points;
  const delta = pixels / height;
  if (adjustment === 'line') {
    // 整线贴近图像边界时同时停住两个端点，保留原来的倾角。
    const applied = clamp(delta, -Math.min(points[0].y, points[1].y), 1 - Math.max(points[0].y, points[1].y));
    return points.map(point => ({ ...point, y: point.y + applied }));
  }
  return points.map((point, index) => index === adjustment ? { ...point, y: clamp(point.y + delta, 0, 1) } : point);
}

export function horizonUpperClip(points: HorizonPoint[], width: number, height: number): string {
  if (points.length !== 2) return '';
  const [start, end] = points;
  const x1 = start.x * width, x2 = end.x * width;
  // 只保留描边的上半侧，因此红线下沿始终经过正式标注坐标。
  return `${x1},${start.y * height} ${x2},${end.y * height} ${x2},${-height} ${x1},${-height}`;
}
