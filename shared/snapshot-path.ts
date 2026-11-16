export interface PtzControlPoint { pan: number; tilt: number; zoom: number }

export function createPtzPath(controlPoints: readonly PtzControlPoint[], maxPanStep: number, maxZoom: number) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) throw new Error('至少需要两个 PTZ 控制点');
  if (controlPoints.length > 10000) throw new Error('本次截图超过 10000 张');
  if (!Number.isFinite(maxPanStep) || maxPanStep <= 0 || maxPanStep > 360) {
    throw new Error('最大 P 间隔必须大于 0°且不超过 360°');
  }
  for (const [index, point] of controlPoints.entries()) {
    if (!point || !Number.isFinite(point.pan) || point.pan < 0 || point.pan > 360
      || !Number.isFinite(point.tilt) || point.tilt < -90 || point.tilt > 90
      || !Number.isFinite(point.zoom) || point.zoom < 1 || point.zoom > maxZoom) {
      throw new Error(`控制点 ${index + 1} 的 P/T/Z 无效，P 须为 0～360°，T 须为 -90～90°，Z 须为 1～${maxZoom}`);
    }
  }
  let sampleCount = 1;
  const segments = controlPoints.slice(1).map((point, index) => {
    const start = controlPoints[index];
    const span = point.pan - start.pan + (point.pan < start.pan ? 360 : 0);
    if (!(span > 0)) throw new Error(`控制点 ${index + 1} 到 ${index + 2} 的 P 跨度必须大于 0°`);
    const count = Math.ceil(span / maxPanStep);
    sampleCount += count;
    if (sampleCount > 10000) throw new Error('本次截图超过 10000 张，请增大最大 P 间隔或缩短路径');
    return { start, end: point, span, count, step: span / count };
  });
  const targets: PtzControlPoint[] = [];
  const targetPanSteps: number[] = [];
  for (const { start, end, span, count, step } of segments) {
    if (!targets.length) {
      targets.push({ pan: start.pan % 360, tilt: start.tilt, zoom: start.zoom });
      targetPanSteps.push(step);
    } else {
      // 连接点只拍一次，到位容差取两侧较小间隔，避免跳过相邻采样位置。
      targetPanSteps[targetPanSteps.length - 1] = Math.min(targetPanSteps.at(-1)!, step);
    }
    for (let index = 1; index <= count; index++) {
      const progress = index / count;
      targets.push(index === count ? { pan: end.pan % 360, tilt: end.tilt, zoom: end.zoom } : {
        pan: (start.pan + progress * span) % 360,
        tilt: start.tilt + progress * (end.tilt - start.tilt),
        zoom: start.zoom + progress * (end.zoom - start.zoom),
      });
      targetPanSteps.push(step);
    }
  }
  return { controlPoints: controlPoints.map(({ pan, tilt, zoom }) => ({ pan, tilt, zoom })),
    maxPanStep, sampleCount, targets, targetPanSteps };
}
