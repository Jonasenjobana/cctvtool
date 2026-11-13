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

export interface HorizonScanOptions { preScanZoom: number; tiltMin: number; tiltMax: number }

export function snapshotTaskName(group: SnapshotGroup): string {
  return group.horizon ? group.horizon.phase === 'coarse' ? '海天线预扫描' : '高倍率正式扫描'
    : group.kind === 'scan' ? '自动截图' : '单张截图';
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
  status: 'estimated' | 'insufficient_data' | 'unreliable';
  installation: Pick<Calibration, 'pAxisPitch' | 'pAxisRoll' | 'tiltOffset' | 'imageRoll'> | null;
  sourceSnapshotIds: string[];
  excluded: { snapshotId: string; reason: string }[];
  panCoverageDegrees: number;
  diagnostics?: { rmsResidualPixels: number; rmsAngularResidualDegrees?: number; converged: boolean; conditionNumber: number | null;
    perSnapshot: { snapshotId: string; rmsResidualPixels: number }[] };
  message: string;
  warnings?: string[];
  applied: boolean;
}
export interface RecognitionTask {
  id: string; sourceTaskId: string; cameraId: string; cameraName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; sampleCount: number; completedCount: number; revision: number;
  result: InstallationEstimate | null; error: string | null; appliedAt: string | null; appliedRevision: number | null;
  resultId: string | null;
  fitCamera?: Calibration;
}
export interface RecognitionItem {
  snapshotId: string; snapshot: Snapshot; points: HorizonPoint[]; detectedPoints: HorizonPoint[];
  source: 'model' | 'manual'; ignored: boolean; ignoreReason: string; missing: boolean;
  detection: { error: string | null; warnings: string[]; refinementStatus: string; elapsedMs: number } | null;
}
export interface RecognitionTaskPage { tasks: RecognitionTask[]; total: number; offset: number; nextOffset: number | null }
export interface RecognitionItemPage { task: RecognitionTask; items: RecognitionItem[]; total: number; offset: number; nextOffset: number | null }
