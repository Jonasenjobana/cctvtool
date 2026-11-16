import { setTimeout as delay } from 'node:timers/promises';
import { httpError } from './errors.mjs';
import { horizonOffsetDegrees } from './horizon-control.mjs';

const angularDistance = (left, right) => Math.abs(((left - right + 540) % 360) - 180);

export function ptzMatches(raw, target, panTolerance = 0.15, tiltTolerance = 0.15) {
  return angularDistance(raw.Pan, target.pan) <= panTolerance
    && Math.abs(raw.Tilt - target.tilt) <= tiltTolerance
    && Math.abs(raw.Zoom - target.zoom) <= Math.max(0.01, target.zoom * 0.001);
}

export function scanTarget(plan, index) {
  if (plan.targets) return { ...plan.targets[index] };
  // 旧普通任务仍按原扇区中心点恢复，不能套用新的端点规划规则。
  const pan = (plan.panMin + (index + 0.5) * plan.panStep) % 360;
  return { pan: Number(pan.toFixed(6)) % 360,
    tilt: plan.basePtz.tilt, zoom: plan.basePtz.zoom };
}

export function scanPanTolerance(plan, index) {
  return Math.min(0.15, (plan.targetPanSteps?.[index] ?? plan.panStep) / 4);
}

export function scanTiltTolerance(plan, raw) {
  if (plan?.horizon?.phase !== 'fine') return 0.15;
  if (![raw.HorizontalFieldAngle, raw.VerticalFieldAngle].every((value) => Number.isFinite(value) && value > 0 && value < 180)) {
    throw httpError(502, '正式扫描的实际视场角无效，自动截图已终止');
  }
  return Math.min(0.15, 0.05 * raw.VerticalFieldAngle);
}

export function checkHorizonReading(plan, raw) {
  if (plan?.horizon?.phase !== 'fine') return;
  const tolerance = scanTiltTolerance(plan, raw);
  const offset = horizonOffsetDegrees(plan.calibration, raw);
  if (!(Math.abs(offset) + plan.horizon.angularMarginDegrees + tolerance < 0.35 * raw.VerticalFieldAngle)) {
    throw httpError(502, '正式扫描的海天线预测可见余量不足，自动截图已终止');
  }
}

export async function waitForScanTarget(livegbs, camera, target, plan, signal, panTolerance) {
  const { settleMs, moveTimeoutMs } = plan;
  const deadline = Date.now() + moveTimeoutMs;
  let stableSince = 0;
  let stableRaw;
  let stableSamples = 0;
  while (true) {
    signal.throwIfAborted();
    const reading = await livegbs.readPtz(camera);
    signal.throwIfAborted();
    const raw = reading.raw;
    if (ptzMatches(raw, target, panTolerance, scanTiltTolerance(plan, raw))) {
      checkHorizonReading(plan, raw);
      // 对比整个稳定窗口的起点，避免把缓慢移动误判为停稳。
      if (!stableRaw || angularDistance(raw.Pan, stableRaw.Pan) > 0.02
        || Math.abs(raw.Tilt - stableRaw.Tilt) > 0.02 || Math.abs(raw.Zoom - stableRaw.Zoom) > 0.01) {
        stableSince = Date.now();
        stableRaw = raw;
        stableSamples = 1;
      } else stableSamples++;
      if (stableSamples >= 2 && Date.now() - stableSince >= settleMs) return reading;
    } else {
      stableRaw = undefined;
      stableSamples = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw httpError(504, `云台未在时限内到达并稳定于 P ${target.pan}°`);
    await delay(Math.min(250, remaining), undefined, { signal });
  }
}
