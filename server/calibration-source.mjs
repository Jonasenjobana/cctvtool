import { isDeepStrictEqual } from 'node:util';
import { activeZeroPoseOf, ZERO_POSE_MODEL } from '#zero-pose';
import { legacyCalibrationOf } from './store.mjs';

export function calibrationSourceFor(task, result, kind) {
  const refinement = kind === 'refinement';
  const revision = refinement ? result.sources.find((source) => source.taskId === task.id)?.revision ?? task.revision
    : result.revision ?? task.resultRevision;
  return { kind, model: result.model, taskId: task.id, resultId: result.resultId ?? task.resultId, revision,
    sourceSnapshotIds: result.sourceSnapshotIds,
    ...(refinement ? { selectionRevision: result.selectionRevision,
      sources: result.sources.map(({ inputSnapshotIds, ...source }) => source) } : {}),
  };
}

function historicalSource(store, camera) {
  const applied = store.listAppliedRecognitionTasks(camera.id).flatMap((task) => [
    { task, result: task.result, kind: 'ordinary', fitCamera: task.fitCamera, appliedAt: task.appliedAt },
    { task, result: task.zeroPoseCandidate, kind: 'ordinary', fitCamera: task.zeroPoseCandidate?.generatedCamera,
      appliedAt: task.zeroPoseCandidate?.appliedAt },
    { task, result: task.refinement, kind: 'refinement', fitCamera: task.refinement?.baseCamera,
      appliedAt: task.refinement?.appliedAt },
  ]).filter(({ result, appliedAt }) => result?.applied && Number.isFinite(Date.parse(appliedAt)))
    .sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
  if (!applied.length || applied[0].appliedAt === applied[1]?.appliedAt) return null;
  const { task, result, kind, fitCamera } = applied[0];
  if (result.status !== 'estimated' || !Array.isArray(result.sourceSnapshotIds) || !fitCamera
    || (kind === 'refinement' && !Array.isArray(result.sources))
    || ['serial', 'code', 'longitude', 'latitude', 'height'].some((key) => camera[key] !== fitCamera[key])) return null;
  const active = activeZeroPoseOf(camera);
  if (active ? result.model !== ZERO_POSE_MODEL || !isDeepStrictEqual(active, result.zeroPose)
    : !['wgs84-horizon-installation-v1', 'wgs84-horizon-refinement-v1'].includes(result.model)
      || !isDeepStrictEqual(legacyCalibrationOf(camera), legacyCalibrationOf({ ...fitCamera, ...result.installation }))) return null;
  const source = calibrationSourceFor(task, result, kind);
  return source.resultId && Number.isInteger(source.revision) ? source : null;
}

export function backfillCalibrationSources(store) {
  store.transaction(() => {
    // 先固化能从旧应用记录确认的来源，后续改标或重算可以覆盖原候选。
    for (const camera of store.camerasWithoutCalibrationSource()) {
      store.backfillCalibrationSource(camera.id, historicalSource(store, camera));
    }
  });
}
