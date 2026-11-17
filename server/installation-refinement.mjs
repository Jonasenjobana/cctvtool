import { httpError } from './errors.mjs';

const activeStatuses = ['queued', 'running'];
const fixedKeys = ['longitude', 'latitude', 'height', 'panOffset', 'serial', 'code'];
const validPoints = (points) => Array.isArray(points) && points.length === 2
  && points.every((point) => [point.x, point.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
  && Math.abs(points[0].x - points[1].x) >= 0.1;

export function refinementStaleReasons(store, task) {
  if (!task.refinement) return [];
  const result = task.refinement;
  const reasons = result.selectionRevision !== task.refinementSelection?.revision ? ['精修来源选择已变化'] : [];
  const camera = store.getCamera(task.cameraId);
  if (fixedKeys.some((key) => camera[key] !== result.baseCamera[key])) reasons.push('固定安装条件或设备通道已变化');
  for (const source of result.sources) {
    let current;
    try { current = store.getRecognitionTask(source.taskId); }
    catch (error) {
      if (error.statusCode !== 404) throw error;
      reasons.push(`来源任务 ${source.taskId} 已删除`);
      continue;
    }
    if (current.revision !== source.revision || activeStatuses.includes(current.status)) reasons.push(`来源任务 ${source.taskId} 的正式标注版本已变化或识别未结束`);
    if (source.role === 'base' && (current.resultId !== source.resultId || current.resultRevision !== current.revision
      || current.result?.status !== 'estimated' || current.result.model !== 'wgs84-horizon-installation-v1')) {
      reasons.push('基础标定结果已变化或失效');
    }
    const available = new Set(store.recognitionItems(current.id).filter((item) => !item.missing).map((item) => item.snapshotId));
    if (source.sourceSnapshotIds.some((id) => !available.has(id))) reasons.push(`来源任务 ${source.taskId} 的参与截图已删除`);
  }
  return reasons;
}

export function withRefinementState(store, task) {
  if (!task.refinement) return task;
  const staleReasons = refinementStaleReasons(store, task);
  return { ...task, refinement: { ...task.refinement, stale: staleReasons.length > 0, staleReasons } };
}

export function refinementInputs(store, task, selection) {
  if (!selection?.base) throw httpError(409, '请先选择合格的基础标定结果');
  const camera = store.getCamera(task.cameraId);
  const reference = store.getRecognitionTask(selection.base.taskId);
  if (reference.result?.status !== 'estimated' || reference.result.model !== 'wgs84-horizon-installation-v1'
    || reference.resultRevision !== reference.revision || reference.resultId !== selection.base.resultId) {
    throw httpError(409, '基础标定来源没有合格的最新结果，或结果编号已变化');
  }
  if (store.getSnapshotGroup(reference.sourceTaskId).horizon?.phase === 'coarse') throw httpError(409, '历史预扫粗结果仅供查看，请选择正式基础标定结果');
  if (fixedKeys.some((key) => camera[key] !== reference.fitCamera?.[key])) throw httpError(409, '固定安装条件或设备通道已变化，请重新生成基础标定结果');
  const sources = [], selected = [], excluded = [];
  const taskIds = new Set(), snapshotIds = new Set();
  for (const source of [{ ...selection.base, role: 'base' }, { taskId: task.id, revision: task.revision, role: 'high' },
    ...selection.supplemental.map((entry) => ({ ...entry, role: 'high' }))]) {
    const current = store.getRecognitionTask(source.taskId);
    if (current.cameraId !== task.cameraId) throw httpError(409, '精修来源必须属于同一摄像头');
    if (taskIds.has(current.id)) throw httpError(409, '精修来源任务不能重复');
    taskIds.add(current.id);
    if (current.revision !== source.revision || activeStatuses.includes(current.status)) throw httpError(409, '精修来源标注版本已变化或识别未结束');
    const allItems = store.recognitionItems(current.id);
    for (const item of allItems) {
      if (snapshotIds.has(item.snapshotId)) throw httpError(409, '精修来源存在重复截图，请勿跨任务重复使用同一图片');
      snapshotIds.add(item.snapshotId);
    }
    const items = allItems.filter((item) => source.role !== 'base' || reference.result.sourceSnapshotIds.includes(item.snapshotId));
    sources.push({ ...source, inputSnapshotIds: items.map((item) => item.snapshotId) });
    for (const item of items) {
      if (source.role === 'base' && item.missing) throw httpError(409, '基础标定参与截图已删除，请重新生成基础结果');
      if (item.ignored || item.missing || !validPoints(item.points)) excluded.push({ taskId: current.id, snapshotId: item.snapshotId,
        reason: item.missing ? '源截图已删除' : item.ignored ? item.ignoreReason : '海天线正式标注无效' });
      else selected.push({ ...item, taskId: current.id });
    }
  }
  const dates = selected.length ? selected.map((item) => +new Date(item.snapshot.createdAt)) : [+new Date(task.createdAt)];
  return { camera, baseCamera: { ...reference.fitCamera, ...reference.result.installation }, sources, selected, excluded,
    range: { startTime: new Date(Math.min(...dates)).toISOString(), endTime: new Date(Math.max(...dates) + 1).toISOString() },
    baseSnapshotIds: reference.result.sourceSnapshotIds };
}
