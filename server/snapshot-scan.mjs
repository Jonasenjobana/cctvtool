import { setTimeout as delay } from 'node:timers/promises';
import { httpError } from './errors.mjs';
import { horizonOffsetDegrees, solveHorizonTilt } from './horizon-control.mjs';

const angularDistance = (left, right) => Math.abs(((left - right + 540) % 360) - 180);

export function ptzMatches(raw, target, panTolerance = 0.15, tiltTolerance = 0.15) {
  return angularDistance(raw.Pan, target.pan) <= panTolerance
    && Math.abs(raw.Tilt - target.tilt) <= tiltTolerance
    && Math.abs(raw.Zoom - target.zoom) <= Math.max(0.01, target.zoom * 0.001);
}

export function createScanPlan({ basePtz, panMin, panMax, horizon, settleMs = 1000, moveTimeoutMs = 30000 }, horizontalFieldAngle, verticalFieldAngle) {
  if (!Number.isFinite(basePtz?.tilt) || basePtz.tilt < -90 || basePtz.tilt > 90) {
    throw httpError(400, '基础 T 必须位于 -90～90°');
  }
  if (horizon && !(panMax > panMin)) throw httpError(400, '海天线扫描的最大 P 必须大于最小 P，范围不能跨越 0°');
  const panSpan = panMax - panMin + (panMax < panMin ? 360 : 0);
  if (!(panSpan > 0)) throw httpError(400, 'P 范围跨度必须大于 0°');
  if (!Number.isFinite(horizontalFieldAngle) || horizontalFieldAngle <= 0 || horizontalFieldAngle >= 180) {
    throw httpError(502, '当前水平视场角无效，无法计算自动截图位置');
  }
  if (horizon) {
    if (!(horizon.preScanZoom >= 1 && horizon.preScanZoom < basePtz.zoom)) {
      throw httpError(400, '预扫倍率必须至少为 1 且小于当前目标倍率');
    }
    if (!(horizon.tiltMin >= -90 && horizon.tiltMax <= 90 && horizon.tiltMin < horizon.tiltMax
      && basePtz.tilt >= horizon.tiltMin && basePtz.tilt <= horizon.tiltMax)) {
      throw httpError(400, '当前 T 必须位于有效的允许 T 区间内');
    }
    if (panSpan < 30) throw httpError(400, '海天线预扫的 P 范围至少为 30°，建议覆盖 90°以上');
    if (!Number.isFinite(verticalFieldAngle) || verticalFieldAngle <= 0 || verticalFieldAngle >= 180) {
      throw httpError(502, '当前垂直视场角无效，无法保存正式扫描目标');
    }
  }
  const sampleCount = horizon ? Math.max(3, Math.ceil(panSpan / 15) + 1)
    : Math.ceil(panSpan / horizontalFieldAngle);
  if (sampleCount > 10000) throw httpError(400, '本次截图超过 10000 张，请缩小 P 范围或降低倍率');
  const panStep = panSpan / (horizon ? sampleCount - 1 : sampleCount);
  return { basePtz, panMin, panMax, horizontalFieldAngle, sampleCount, panStep, settleMs, moveTimeoutMs,
    ...(horizon ? {
      horizon: { phase: 'coarse', targetZoom: basePtz.zoom, tiltMin: horizon.tiltMin, tiltMax: horizon.tiltMax,
        targetHorizontalFov: horizontalFieldAngle, targetVerticalFov: verticalFieldAngle },
      targets: Array.from({ length: sampleCount }, (_, index) => ({
        pan: Number((panMin + index * panStep).toFixed(6)), tilt: basePtz.tilt, zoom: horizon.preScanZoom,
      })),
    } : {}),
  };
}

export function scanTarget(plan, index) {
  if (plan.targets) return { ...plan.targets[index] };
  const pan = (plan.panMin + (index + 0.5) * plan.panStep) % 360;
  return { pan: Number(pan.toFixed(6)) % 360,
    tilt: plan.basePtz.tilt, zoom: plan.basePtz.zoom };
}

export function createHorizonScanPlan(source, task, calibration) {
  const angularResidual = task.result.diagnostics?.rmsAngularResidualDegrees;
  if (!Number.isFinite(angularResidual) || angularResidual < 0) {
    throw httpError(409, '粗标定缺少有效角度残差，请重新生成并复核');
  }
  const plan = createScanPlan({ basePtz: source.basePtz, panMin: source.panMin, panMax: source.panMax,
    settleMs: source.settleMs, moveTimeoutMs: source.moveTimeoutMs }, source.horizon.targetHorizontalFov);
  const targets = Array.from({ length: plan.sampleCount }, (_, index) => {
    const target = scanTarget(plan, index);
    return { ...target, tilt: solveHorizonTilt(calibration, { pan: target.pan, referenceTilt: source.basePtz.tilt,
      tiltMin: source.horizon.tiltMin, tiltMax: source.horizon.tiltMax }) };
  });
  const frozen = { ...plan, targets, horizon: { ...source.horizon, phase: 'fine',
    sourceRecognitionTaskId: task.id, sourceRevision: task.revision, sourceResultId: task.resultId,
    angularMarginDegrees: Math.max(0.02, 3 * angularResidual) } };
  for (const target of targets) {
    checkHorizonReading({ ...frozen, calibration }, { Pan: target.pan, Tilt: target.tilt, Zoom: target.zoom,
      HorizontalFieldAngle: source.horizon.targetHorizontalFov, VerticalFieldAngle: source.horizon.targetVerticalFov });
  }
  return frozen;
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

export async function waitForScanTarget(livegbs, camera, target, plan, signal) {
  const { settleMs, moveTimeoutMs, panStep } = plan;
  const deadline = Date.now() + moveTimeoutMs;
  let stableSince = 0;
  let stableRaw;
  let stableSamples = 0;
  while (true) {
    signal.throwIfAborted();
    const reading = await livegbs.readPtz(camera);
    signal.throwIfAborted();
    const raw = reading.raw;
    if (ptzMatches(raw, target, Math.min(0.15, panStep / 4), scanTiltTolerance(plan, raw))) {
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
