import type { ZeroPose } from '#zero-pose';

export interface Calibration {
  longitude: number | null;
  latitude: number | null;
  height: number | null;
  pAxisPitch: number;
  pAxisRoll: number;
  panOffset: number;
  tiltOffset: number;
  imageRoll: number;
}

export interface CameraInput extends Calibration {
  name: string;
  serial: string;
  code: string;
  maxZoom?: number;
  zeroPose?: ZeroPose;
}

export interface Camera extends CameraInput {
  id: string;
  maxZoom: number;
  createdAt: string;
  updatedAt: string;
}

export type CameraDraft = Omit<CameraInput, 'maxZoom' | 'pAxisPitch' | 'pAxisRoll' | 'panOffset' | 'tiltOffset' | 'imageRoll'> & {
  maxZoom?: number | null;
  pAxisPitch: number | null;
  pAxisRoll: number | null;
  panOffset: number | null;
  tiltOffset: number | null;
  imageRoll: number | null;
};

export interface RawPtz {
  DeviceID?: string;
  Pan: number;
  Tilt: number;
  Zoom: number;
  HorizontalFieldAngle: number | null;
  VerticalFieldAngle: number | null;
  MaxViewDistance?: number;
}

export interface PtzReading {
  raw: RawPtz;
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
}

export interface Snapshot {
  id: string;
  cameraId: string;
  cameraName: string;
  serial: string;
  code: string;
  imageUrl: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  createdAt: string;
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
  snapshotTime: string | null;
  ptz: PtzReading;
  ptzAfter: PtzReading;
  calibration: Calibration;
  usesDraft: boolean;
  poseChanged: boolean;
  timeAlignment: 'unverified';
  groupId?: string;
  scanIndex?: number;
  scanTarget?: PreciseTarget;
}

export interface SnapshotGroup {
  id: string;
  cameraId: string;
  cameraName: string;
  kind: 'single' | 'scan';
  status: 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt: string | null;
  sampleCount: number;
  completedCount: number;
  snapshotCount: number;
  coverId: string | null;
  error: string | null;
  controlPoints?: PreciseTarget[];
  maxPanStep?: number;
  basePtz?: PreciseTarget;
  panMin?: number;
  panMax?: number;
  horizontalFieldAngle?: number;
  panStep?: number;
  horizon?: {
    phase: 'coarse' | 'fine';
    targetZoom: number;
    tiltMin: number;
    tiltMax: number;
    targetHorizontalFov: number;
    targetVerticalFov: number;
    sourceRecognitionTaskId?: string;
    sourceRevision?: number;
    sourceResultId?: string;
  };
  recognitionTaskId?: string | null;
  recognitionError?: string | null;
}

export function snapshotTaskName(group: SnapshotGroup): string {
  return group.horizon ? group.horizon.phase === 'coarse' ? '历史海天线预扫描' : '历史高倍率正式扫描'
    : group.controlPoints ? '多点 PTZ 截图' : group.kind === 'scan' ? '自动截图' : '单张截图';
}

export interface SnapshotGroupPage {
  groups: SnapshotGroup[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export interface SnapshotPage {
  group: SnapshotGroup;
  snapshots: Snapshot[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export const snapshotTaskStatus = {
  running: '执行中', pausing: '正在暂停', paused: '已暂停', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
};

export type MotionCommand = 'left' | 'right' | 'up' | 'down' | 'upleft' | 'upright' | 'downleft' | 'downright' | 'zoomin' | 'zoomout';
export type PtzCommand = MotionCommand | 'stop';
export interface PreciseTarget { pan: number; tilt: number; zoom: number }

export interface PlaybackSource {
  url: string;
  serial: string;
  code: string;
  smsId: string;
}

export function emptyCamera(): CameraDraft {
  return {
    name: '', serial: '', code: '', maxZoom: 73, longitude: null, latitude: null, height: null,
    pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0,
  };
}

export interface HorizonPoint { x: number; y: number }
export interface InstallationEstimate {
  model?: string;
  status: 'estimated' | 'insufficient_data' | 'unreliable';
  installation: Pick<Calibration, 'pAxisPitch' | 'pAxisRoll' | 'tiltOffset' | 'imageRoll'> | null;
  sourceSnapshotIds: string[];
  excluded: { snapshotId: string; reason: string }[];
  panCoverageDegrees: number;
  diagnostics?: { rmsResidualPixels: number; rmsAngularResidualDegrees?: number; converged: boolean; conditionNumber: number | null;
    perSnapshot: { snapshotId: string; rmsResidualPixels: number; zoom?: number }[] };
  message: string;
  warnings?: string[];
  applied: boolean;
}
export interface InstallationValidation {
  taskId: string; revision: number; generatedAt: string;
  reference: { kind: 'ordinary' | 'refinement'; taskId: string; resultId: string; revision: number; createdAt: string;
    selectionRevision?: number; sources?: InstallationRefinement['sources'] };
  status: 'passed' | 'failed' | 'insufficient_data'; message: string;
  installation: Pick<Calibration, 'pAxisPitch' | 'pAxisRoll' | 'tiltOffset' | 'imageRoll'>;
  sourceSnapshotIds: string[]; excluded: { snapshotId: string; reason: string }[];
  rmsResidualPixels: number | null; rmsAngularResidualDegrees: number | null; maximumResidualPixels: number | null;
  maximumAcceptedRmsPixels: number; failedSnapshotIds: string[];
  perSnapshot: HorizonMeasurement[];
}
export interface HorizonMeasurement {
  snapshotId: string; pan: number; tilt: number; zoom: number; width: number; height: number;
  horizontalFieldAngle: number; verticalFieldAngle: number; timeAlignment: string;
  theoreticalHorizon: HorizonPoint[][];
  verticalResiduals: { position: 'left' | 'center' | 'right'; x: number; observedY: number;
    theoreticalY: number | null; offsetPixels: number | null; unavailableReason: string | null }[];
  directionDifferenceDegrees: number | null;
  rmsResidualPixels: number; rmsAngularResidualDegrees: number; verticalOffsetPixels: number | null;
}
export interface ZeroPoseCandidate {
  model: 'wgs84-horizon-zero-pose-v1';
  resultId: string; revision: number; generatedAt: string; startTime: string; endTime: string;
  status: InstallationEstimate['status']; zeroPose: ZeroPose | null;
  generatedCamera: Camera;
  fixedCalibration: Pick<Calibration, 'longitude' | 'latitude' | 'height'> & Pick<ZeroPose, 'yaw' | 'tiltOffset'>
    & { imageRoll: 0; cameraUpdatedAt: string };
  sourceSnapshotIds: string[]; excluded: InstallationEstimate['excluded'];
  distinctPanCount: number; panCoverageDegrees: number;
  diagnostics?: { converged: boolean; iterations: number; conditionNumber: number | null;
    rmsResidualPixels: number; rmsAngularResidualDegrees: number; maximumAcceptedRmsPixels: number;
    perSnapshot: Omit<HorizonMeasurement, 'theoreticalHorizon' | 'verticalResiduals' | 'directionDifferenceDegrees' | 'verticalOffsetPixels'>[] };
  message: string; stale: boolean; staleReasons: string[];
  applied: boolean; appliedAt: string | null;
}
export interface ZeroPoseMeasurement {
  taskId: string; revision: number; resultId: string;
  model: ZeroPoseCandidate['model']; zeroPose: ZeroPose;
  perSnapshot: HorizonMeasurement[]; excluded: InstallationEstimate['excluded'];
}
type RefinementBaseModel = 'wgs84-horizon-installation-v1' | ZeroPoseCandidate['model'];
export interface RefinementSelection {
  revision: number;
  base: { taskId: string; revision: number; resultId: string; model?: RefinementBaseModel } | null;
  supplemental: { taskId: string; revision: number }[];
}
export interface RefinementSummary {
  sampleCount: number; zoomRange: { min: number; max: number } | null;
  distinctPanCount: number; panCoverageDegrees: number;
  rmsResidualPixels: number | null; rmsAngularResidualDegrees: number | null;
}
export interface RefinementComparison {
  overall: RefinementSummary; base: RefinementSummary; high: RefinementSummary; objective: number;
  perSnapshot: (HorizonMeasurement & { taskId: string; group: 'base' | 'high' })[];
}
interface RefinementState {
  resultId: string; generatedAt: string; selectionRevision: number;
  status: 'estimated' | 'no_change' | 'insufficient_data' | 'unreliable';
  generatedCamera: Camera;
  sources: { role: 'base' | 'high'; taskId: string; revision: number; resultId?: string; model?: RefinementBaseModel;
    inputSnapshotIds: string[]; sourceSnapshotIds: string[] }[];
  sourceSnapshotIds: string[]; excluded: { taskId?: string; snapshotId: string; reason: string }[];
  diagnostics: { converged: boolean; conditionNumber: number | null; failures: string[] };
  maximumAcceptedRmsPixels: number; message: string; stale: boolean; staleReasons: string[];
  applied: boolean; appliedAt: string | null;
}
type LegacyRefinementComparison = RefinementComparison & { installation: NonNullable<InstallationEstimate['installation']> };
type ZeroPoseRefinementComparison = RefinementComparison & { zeroPose: ZeroPose };
export type InstallationRefinement = RefinementState & ({
  model: 'wgs84-horizon-refinement-v1'; installation: InstallationEstimate['installation'];
  before: LegacyRefinementComparison; after: LegacyRefinementComparison;
  baseCamera: Calibration & Pick<Camera, 'serial' | 'code' | 'updatedAt'>;
} | {
  model: ZeroPoseCandidate['model']; zeroPose: ZeroPose | null;
  before: ZeroPoseRefinementComparison; after: ZeroPoseRefinementComparison;
  baseCamera: Camera & { zeroPose: ZeroPose };
});
export interface RefinementMeasurement {
  taskId: string; revision: number; selectionRevision: number; mode: 'before' | 'after'; resultId: string | null;
  model: RefinementBaseModel;
  perSnapshot: RefinementComparison['perSnapshot']; excluded: { snapshotId: string; reason: string }[];
}
export interface RecognitionTask {
  id: string; sourceTaskId: string; cameraId: string; cameraName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; sampleCount: number; completedCount: number; revision: number;
  result: InstallationEstimate | null; error: string | null; appliedAt: string | null; appliedRevision: number | null;
  resultId: string | null;
  resultRevision?: number;
  fitCamera?: Calibration;
  zeroPoseCandidate?: ZeroPoseCandidate;
  refinementSelection?: RefinementSelection;
  refinement?: InstallationRefinement;
}
export interface RecognitionItem {
  snapshotId: string; snapshot: Snapshot; points: HorizonPoint[]; detectedPoints: HorizonPoint[];
  source: 'model' | 'manual'; ignored: boolean; ignoreReason: string; missing: boolean;
  detection: { error: string | null; warnings: string[]; refinementStatus: string; elapsedMs: number } | null;
}
export interface RecognitionTaskPage { tasks: RecognitionTask[]; total: number; offset: number; nextOffset: number | null }
export interface RecognitionItemPage { task: RecognitionTask; items: RecognitionItem[]; total: number; offset: number; nextOffset: number | null }
