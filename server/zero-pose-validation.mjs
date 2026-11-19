import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { httpError } from './errors.mjs';
import { calibrationKeys, calibrationOf } from './store.mjs';
import { evaluateInstallation, panCoverage, ZERO_POSE_MODEL } from './tilt-calibration.mjs';

const legacyModel = 'wgs84-horizon-installation-v1';
const activeStatuses = ['queued', 'running'];
const baselineKeys = [...calibrationKeys, 'serial', 'code'];

export const validPoints = (points) => Array.isArray(points) && points.length === 2
  && points.every((point) => [point?.x, point?.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
  && Math.abs(points[0].x - points[1].x) >= 0.1;

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

function baselineSources(store, camera) {
  const sources = [];
  for (const task of store.listAppliedRecognitionTasks(camera.id)) {
    for (const { kind, model, result, fitCamera, resultId, revision } of [
      { kind: 'ordinary', model: legacyModel, result: task.result, fitCamera: task.fitCamera,
        resultId: task.resultId, revision: task.resultRevision },
      { kind: 'refinement', model: 'wgs84-horizon-refinement-v1', result: task.refinement,
        fitCamera: task.refinement?.baseCamera, resultId: task.refinement?.resultId,
        revision: task.refinement?.sources.find((entry) => entry.taskId === task.id)?.revision ?? task.revision },
    ]) {
      if (result?.applied && result.model === model && fitCamera && resultId) {
        const applied = { ...fitCamera, ...result.installation };
        if (baselineKeys.every((key) => camera[key] === applied[key])) {
          sources.push({ kind, model, taskId: task.id, resultId, revision, sourceSnapshotIds: result.sourceSnapshotIds,
            ...(kind === 'refinement' ? { selectionRevision: result.selectionRevision } : {}) });
        }
      }
    }
  }
  return sources;
}

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
  const sources = baselineSources(store, camera);
  const fittedIds = new Set([...candidate.sourceSnapshotIds, ...sources.flatMap((source) => source.sourceSnapshotIds)]);
  const selected = [], excluded = [];
  for (const item of store.recognitionItems(task.id)) {
    let reason;
    if (item.missing) reason = '源截图已删除';
    else if (item.ignored) reason = item.ignoreReason || '已忽略';
    else if (item.snapshot.cameraId !== task.cameraId) reason = '截图不属于该摄像头';
    else if (!validPoints(item.points)) reason = '海天线正式标注无效或横向跨度不足图片宽度的 10%';
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

  const { perSnapshot: baselineRows, excluded: geometryExclusions, model: baselineModel, installation,
    rmsResidualPixels: baselineRms } = evaluateInstallation(camera, snapshots, observations, range);
  const { perSnapshot: candidateRows, sourceSnapshotIds, model, rmsResidualPixels: candidateRms } =
    evaluateInstallation({ ...candidate.generatedCamera, zeroPose: candidate.zeroPose }, snapshots, observations, range, ZERO_POSE_MODEL);
  const baselineById = new Map(baselineRows.map((row) => [row.snapshotId, row]));
  const perSnapshot = candidateRows.map((row) => compareImage(baselineById.get(row.snapshotId), row, criteria));
  const high = perSnapshot.filter((row) => row.zoomGroup === 'high');
  const comparableHigh = high.filter((row) => row.baselineComparable && row.candidateComparable);
  // 采用同一角度精度统计重复姿态，避免设备回读末位抖动被计作新的覆盖方向。
  const highPoseCount = new Set(comparableHigh.map(({ pan, tilt }) =>
    `${Math.round((((pan % 360) + 360) % 360) * 100) % 36000}/${Math.round(tilt * 100)}`)).size;
  const coverage = {
    lowSnapshotCount: perSnapshot.length - high.length,
    highSnapshotCount: high.length, comparableHighSnapshotCount: comparableHigh.length, highPoseCount,
    ...panCoverage(comparableHigh.map((row) => row.pan)),
    reasons: [
      ...(highPoseCount < 2 ? ['新旧模型均可比较的高倍图至少需要覆盖两组实际 P/T'] : []),
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
  const evidence = {
    version: 1, id: randomUUID(), status, generatedAt,
    source: { kind, model, taskId: reference.id, revision: reference.revision, resultId: candidate.resultId,
      sourceSnapshotIds: candidate.sourceSnapshotIds },
    validation: { taskId: task.id, revision: task.revision, sourceSnapshotIds },
    camera: { id: camera.id, updatedAt: camera.updatedAt },
    baseline: { model: baselineModel, calibration: calibrationOf(camera), sources },
    criteria,
  };
  return { taskId: task.id, revision: task.revision, generatedAt, status, message, evidence, coverage, perSnapshot,
    reference: { kind, model, taskId: reference.id, resultId: candidate.resultId, revision: reference.revision, createdAt: reference.createdAt },
    sourceSnapshotIds, failedSnapshotIds, excluded: [...excluded, ...geometryExclusions],
    baseline: { model: baselineModel, installation, rmsResidualPixels: baselineRms },
    candidate: { model, zeroPose: candidate.zeroPose, rmsResidualPixels: candidateRms } };
}

// 应用事务内传入已核对身份及全部来源的候选，复用复核口径重新计算保存过的证据。
export function requireZeroPoseValidation(store, reference, candidate, validationId) {
  const evidence = candidate.validation;
  if (evidence?.version !== 1 || evidence.id !== validationId || evidence.status !== 'passed') {
    throw httpError(409, '未找到当前候选通过的独立复核证据');
  }
  let task;
  try { task = store.getRecognitionTask(evidence.validation.taskId); }
  catch (error) {
    if (error.statusCode !== 404) throw error;
    throw httpError(409, '独立复核任务已删除');
  }
  if (task.revision !== evidence.validation.revision || activeStatuses.includes(task.status)) {
    throw httpError(409, '独立复核任务的正式标注版本已变化或识别未结束');
  }
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
