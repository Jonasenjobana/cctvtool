import { setTimeout as delay } from 'node:timers/promises';
import { httpError } from './errors.mjs';

const angularDistance = (left, right) => Math.abs(((left - right + 540) % 360) - 180);

export function ptzMatches(raw, target, panTolerance = 0.15) {
  return angularDistance(raw.Pan, target.pan) <= panTolerance
    && angularDistance(raw.Tilt, target.tilt) <= 0.15
    && Math.abs(raw.Zoom - target.zoom) <= Math.max(0.01, target.zoom * 0.001);
}

export function createScanPlan({ basePtz, panMin, panMax, settleMs = 1000, moveTimeoutMs = 30000 }, horizontalFieldAngle) {
  if (!(panMax > panMin)) throw httpError(400, '最大 P 必须大于最小 P，范围不能跨越 0°');
  if (!Number.isFinite(horizontalFieldAngle) || horizontalFieldAngle <= 0 || horizontalFieldAngle >= 180) {
    throw httpError(502, '当前水平视场角无效，无法计算自动截图位置');
  }
  const sampleCount = Math.ceil((panMax - panMin) / horizontalFieldAngle);
  if (sampleCount > 10000) throw httpError(400, '本次截图超过 10000 张，请缩小 P 范围或降低倍率');
  return { basePtz, panMin, panMax, horizontalFieldAngle, sampleCount,
    panStep: (panMax - panMin) / sampleCount, settleMs, moveTimeoutMs };
}

export function scanTarget(plan, index) {
  return { pan: Number((plan.panMin + (index + 0.5) * plan.panStep).toFixed(6)),
    tilt: plan.basePtz.tilt, zoom: plan.basePtz.zoom };
}

export async function waitForScanTarget(livegbs, camera, target, { settleMs, moveTimeoutMs, panStep }, signal) {
  const deadline = Date.now() + moveTimeoutMs;
  let stableSince = 0;
  let stableRaw;
  let stableSamples = 0;
  while (true) {
    signal.throwIfAborted();
    const reading = await livegbs.readPtz(camera);
    signal.throwIfAborted();
    const raw = reading.raw;
    if (ptzMatches(raw, target, Math.min(0.15, panStep / 4))) {
      // 对比整个稳定窗口的起点，避免把缓慢移动误判为停稳。
      if (!stableRaw || angularDistance(raw.Pan, stableRaw.Pan) > 0.02
        || angularDistance(raw.Tilt, stableRaw.Tilt) > 0.02 || Math.abs(raw.Zoom - stableRaw.Zoom) > 0.01) {
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
