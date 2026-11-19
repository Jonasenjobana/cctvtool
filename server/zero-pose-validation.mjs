import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { httpError } from './errors.mjs';
import { activeZeroPoseOf } from '#zero-pose';
import { calibrationOf } from './store.mjs';
import { evaluateInstallation, invalidHorizonAnnotation, panCoverage, validHorizonAnnotation, ZERO_POSE_MODEL } from './tilt-calibration.mjs';

const activeStatuses = ['queued', 'running'];
const evidenceVersion = 2;

export const zeroPoseValidationCriteriaSchema = {
  type: 'object', additionalProperties: false,
  required: ['minimumHighZoom', 'maximumVerticalOffsetPixels', 'maximumDirectionDifferenceDegrees', 'maximumRmsPixels'],
  properties: {
    minimumHighZoom: { type: 'number', minimum: 1 },
    maximumVerticalOffsetPixels: { type: 'number', exclusiveMinimum: 0 },
    maximumDirectionDifferenceDegrees: { type: 'number', exclusiveMinimum: 0, maximum: 180 },
    maximumRmsPixels: { type: 'number', exclusiveMinimum: 0 },
  },
};

function compareImage(baseline, candidate, criteria) {
  const offsets = candidate.verticalResiduals.map(({ offsetPixels }) => offsetPixels);
  const labels = ['左端垂直偏差', '中点垂直偏差', '右端垂直偏差', '海天线方向差', '像素 RMS'];
  const measurements = [...offsets, candidate.directionDifferenceDegrees, candidate.rmsResidualPixels];
  const oldMeasurements = [...baseline.verticalResiduals.map(({ offsetPixels }) => offsetPixels),
    baseline.directionDifferenceDegrees, baseline.rmsResidualPixels];
  const limits = [...offsets.map(() => criteria.maximumVerticalOffsetPixels), criteria.maximumDirectionDifferenceDegrees, criteria.maximumRmsPixels];
  const overLimit = (value, index) => Number.isFinite(value) && Math.abs(value) > limits[index];
  return {
    baseline, candidate, snapshotId: candidate.snapshotId, pan: candidate.pan, tilt: candidate.tilt, zoom: candidate.zoom,
    zoomGroup: candidate.zoom >= criteria.minimumHighZoom ? 'high' : 'low',
    baselineComparable: oldMeasurements.every(Number.isFinite), candidateComparable: measurements.every(Number.isFinite),
    failures: labels.filter((_, index) => overLimit(measurements[index], index)),
    regressions: labels.filter((_, index) => overLimit(measurements[index], index) && Number.isFinite(oldMeasurements[index])
      && Math.abs(measurements[index]) > Math.abs(oldMeasurements[index])),
  };
}

export function evaluateZeroPoseValidation(store, task, reference, candidate, kind, criteria) {
  if (task.id === reference.id || task.cameraId !== reference.cameraId) {
    throw httpError(409, '请选择同一摄像头的另一识别任务作为零位复核来源');
  }
  if (!criteria) throw httpError(400, '请填写依据重复拍摄与重复标注测得的复核门槛');
  const camera = store.getCamera(task.cameraId);
  const source = store.getCalibrationSource(camera.id);
  const fittedIds = new Set([...candidate.sourceSnapshotIds, ...(source?.sourceSnapshotIds ?? [])]);
  const selected = [], excluded = [];
  for (const item of store.recognitionItems(task.id)) {
    let reason;
    if (item.missing) reason = '源截图已删除';
    else if (item.ignored) reason = item.ignoreReason || '已忽略';
    else if (item.snapshot.cameraId !== task.cameraId) reason = '截图不属于该摄像头';
    else if (!validHorizonAnnotation(item.points)) reason = invalidHorizonAnnotation;
    else if (!store.hasSnapshotImage(item.snapshot)) reason = '源截图文件缺失';
    if (reason) excluded.push({ snapshotId: item.snapshotId, reason }); else selected.push(item);
  }
  if (selected.some((item) => fittedIds.has(item.snapshotId))) {
    throw httpError(409, '复核图片与新候选或旧基准的拟合图片存在重叠，请使用独立拍摄的原图');
  }
  const dates = selected.length ? selected.map((item) => +new Date(item.snapshot.createdAt)) : [+new Date(task.createdAt)];
  const range = { startTime: new Date(Math.min(...dates)).toISOString(), endTime: new Date(Math.max(...dates) + 1).toISOString() };
  const snapshots = selected.map((item) => item.snapshot);
  const observations = selected.map(({ snapshotId, points }) => ({ snapshotId, points }));

  const active = activeZeroPoseOf(camera);
  const { perSnapshot: baselineRows, excluded: geometryExclusions, model: baselineModel, installation,
    rmsResidualPixels: baselineRms } = evaluateInstallation({ ...camera, zeroPose: active }, snapshots, observations, range,
    active ? ZERO_POSE_MODEL : undefined);
  const { perSnapshot: candidateRows, sourceSnapshotIds, model, rmsResidualPixels: candidateRms } =
    evaluateInstallation({ ...candidate.generatedCamera, zeroPose: candidate.zeroPose }, snapshots, observations, range, ZERO_POSE_MODEL);
  const baselineById = new Map(baselineRows.map((row) => [row.snapshotId, row]));
  const perSnapshot = candidateRows.map((row) => compareImage(baselineById.get(row.snapshotId), row, criteria));
  const high = perSnapshot.filter((row) => row.zoomGroup === 'high');
  const comparableHigh = high.filter((row) => row.baselineComparable && row.candidateComparable);
  // 采用同一角度精度统计重复姿态，避免设备回读末位抖动被计作新的覆盖方向。
  const highPoseCount = new Set(comparableHigh.map(({ pan, tilt }) =>
    `${Math.round((((pan % 360) + 360) % 360) * 100) % 36000}/${Math.round(tilt * 100)}`)).size;
  const highPanCoverage = panCoverage(comparableHigh.map((row) => row.pan));
  const coverage = {
    lowSnapshotCount: perSnapshot.length - high.length,
    highSnapshotCount: high.length, comparableHighSnapshotCount: comparableHigh.length, highPoseCount,
    ...highPanCoverage,
    reasons: [
      ...(highPanCoverage.distinctPanCount < 2 ? ['两种模型均可比较的高倍原图至少需要覆盖两个不同 P 方位'] : []),
      ...(perSnapshot.some((row) => !row.candidateComparable) ? ['新版候选有原图缺少可比较的垂直偏差或方向差'] : []),
    ],
  };
  const failedSnapshotIds = perSnapshot.filter((row) => row.failures.length).map((row) => row.snapshotId);
  const status = !perSnapshot.length ? 'insufficient_data' : failedSnapshotIds.length ? 'failed'
    : coverage.reasons.length ? 'insufficient_coverage' : 'passed';
  const message = {
    passed: '新版候选通过本次独立原图复核',
    failed: `${failedSnapshotIds.length}/${perSnapshot.length} 张截图超出验收门槛`,
    insufficient_data: '没有有效的原图和正式海天线标注',
    insufficient_coverage: '独立原图的可比较观测覆盖不足',
  }[status];
  const generatedAt = new Date().toISOString();
  const referenceVersion = { kind, model, taskId: reference.id, revision: reference.revision, resultId: candidate.resultId,
    ...(kind === 'zero-pose-refinement' ? { selectionRevision: candidate.selectionRevision, sources: candidate.sources } : {}) };
  const evidence = {
    version: evidenceVersion, id: randomUUID(), status, generatedAt,
    source: { ...referenceVersion, sourceSnapshotIds: candidate.sourceSnapshotIds },
    validation: { taskId: task.id, revision: task.revision, sourceSnapshotIds },
    camera: { id: camera.id, updatedAt: camera.updatedAt },
    baseline: { model: baselineModel, calibration: calibrationOf(camera), sources: source ? [source] : [] },
    criteria,
  };
  return { taskId: task.id, revision: task.revision, generatedAt, status, message, evidence, coverage, perSnapshot,
    reference: { ...referenceVersion, createdAt: reference.createdAt },
    sourceSnapshotIds, failedSnapshotIds, excluded: [...excluded, ...geometryExclusions],
    baseline: { model: baselineModel, ...(active ? { zeroPose: active } : { installation }), rmsResidualPixels: baselineRms },
    candidate: { model, zeroPose: candidate.zeroPose, rmsResidualPixels: candidateRms } };
}

function evidenceTask(store, evidence) {
  let task;
  try { task = store.getRecognitionTask(evidence.validation.taskId); }
  catch (error) {
    if (error.statusCode !== 404) throw error;
    throw httpError(409, '独立复核任务已删除');
  }
  if (task.revision !== evidence.validation.revision || activeStatuses.includes(task.status)) {
    throw httpError(409, '独立复核任务的正式标注版本已变化或识别未结束');
  }
  return task;
}

export function zeroPoseValidationStaleReason(store, evidence) {
  if (!evidence) return null;
  if (evidence.version !== evidenceVersion) return '独立复核口径已更新，请重新提交复核';
  let task;
  try { task = evidenceTask(store, evidence); }
  catch (error) {
    if (error.statusCode !== 409) throw error;
    return error.message;
  }
  const { sourceSnapshotIds } = evidence.validation;
  const items = store.recognitionItems(task.id, { snapshotIds: sourceSnapshotIds });
  return items.length !== sourceSnapshotIds.length || items.some((item) => item.missing || !store.hasSnapshotImage(item.snapshot))
    ? '独立复核参与原图已删除或缺失，请重新复核' : null;
}

// 应用事务内传入已核对身份及全部来源的候选，复用复核口径重新计算保存过的证据。
export function requireZeroPoseValidation(store, reference, candidate, validationId) {
  const evidence = candidate.validation;
  if (evidence?.version !== evidenceVersion || evidence.id !== validationId || evidence.status !== 'passed') {
    throw httpError(409, '未找到当前候选通过的独立复核证据');
  }
  const task = evidenceTask(store, evidence);
  const current = evaluateZeroPoseValidation(store, task, reference, candidate, evidence.source.kind, evidence.criteria).evidence;
  if (!isDeepStrictEqual(current.validation, evidence.validation)) {
    throw httpError(409, '独立复核参与原图已删除或缺失，请重新复核');
  }
  if (!isDeepStrictEqual(current.source, evidence.source) || !isDeepStrictEqual(current.camera, evidence.camera)
    || !isDeepStrictEqual(current.baseline, evidence.baseline)) {
    throw httpError(409, '零位候选、相机配置或旧基准版本已变化，请重新复核');
  }
  if (current.status !== 'passed') throw httpError(409, '当前独立原图未通过复核门槛');
  return evidence;
}
