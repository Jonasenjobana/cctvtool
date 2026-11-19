import { isDeepStrictEqual } from 'node:util';
import { httpError } from './errors.mjs';
import { ZERO_POSE_MODEL } from './tilt-calibration.mjs';

export function matchesZeroPoseCamera(camera, candidate) {
  const { generatedCamera, applied, appliedCameraUpdatedAt, zeroPose } = candidate;
  return isDeepStrictEqual(camera, applied ? { ...generatedCamera, zeroPose, calibrationModel: ZERO_POSE_MODEL,
    activeZeroPose: zeroPose, updatedAt: appliedCameraUpdatedAt ?? camera.updatedAt } : generatedCamera);
}

export function zeroPoseCandidateStaleReasons(store, task) {
  const candidate = task.zeroPoseCandidate;
  if (!candidate) return [];
  const reasons = [];
  if (candidate.model !== ZERO_POSE_MODEL) reasons.push('零位模型版本已变化');
  if (candidate.revision !== task.revision || ['queued', 'running'].includes(task.status)) {
    reasons.push('正式标注版本已变化或识别未结束');
  }
  if (!matchesZeroPoseCamera(store.getCamera(task.cameraId), candidate)) {
    reasons.push('相机配置版本已变化');
  }
  if (candidate.sourceSnapshotIds.length) {
    const items = store.recognitionItems(task.id, { snapshotIds: candidate.sourceSnapshotIds });
    if (items.length !== candidate.sourceSnapshotIds.length || items.some((item) => item.missing || !store.hasSnapshotImage(item.snapshot))) {
      reasons.push('拟合参与原图已删除或缺失');
    }
  }
  return reasons;
}

export function requireZeroPoseCandidate(store, task, resultId, revision = task.revision) {
  const candidate = task.zeroPoseCandidate;
  if (!candidate || candidate.resultId !== resultId || candidate.revision !== revision) {
    throw httpError(409, '零位候选编号或标注版本已变化，请刷新后重试');
  }
  const reasons = zeroPoseCandidateStaleReasons(store, task);
  if (reasons.length) throw httpError(409, reasons.join('，'));
  if (candidate.status !== 'estimated' || !candidate.zeroPose) {
    throw httpError(409, '当前零位候选未通过拟合质量检查');
  }
  return candidate;
}
