import { Math as CesiumMath, Matrix3, Quaternion } from 'cesium';
import { createLocalRigRotation } from '#camera-rotation';

export const ZERO_POSE_MODEL = 'wgs84-horizon-zero-pose-v1';

export interface ZeroPose {
  roll: number;
  pitch: number;
  yaw: number;
  tiltOffset: number;
  imageRoll?: number;
}

type LegacyOrientation = Parameters<typeof createLocalRigRotation>[0];

export interface ActiveCalibration {
  calibrationModel?: typeof ZERO_POSE_MODEL;
  activeZeroPose?: ZeroPose;
}

export function activeZeroPoseOf(calibration: ActiveCalibration): ZeroPose | undefined {
  if (calibration.calibrationModel === undefined) return;
  if (calibration.calibrationModel !== ZERO_POSE_MODEL || !calibration.activeZeroPose) throw new Error('生效零位标定版本或参数无效');
  return calibration.activeZeroPose;
}

export function createZeroPoseRotation(pose: ZeroPose): Matrix3 {
  const rotation = Matrix3.multiply(
    Matrix3.fromRotationZ(CesiumMath.toRadians(-pose.yaw)),
    Matrix3.fromRotationX(CesiumMath.toRadians(pose.pitch)), new Matrix3(),
  );
  return Matrix3.multiply(rotation, Matrix3.fromRotationY(CesiumMath.toRadians(pose.roll)), rotation);
}

export function createZeroPoseRigRotation(pose: ZeroPose, ptz: { Pan: number; Tilt: number }) {
  const mount = createZeroPoseRotation(pose);
  const imageRoll = CesiumMath.toRadians(pose.imageRoll ?? 0);
  // 零位 Pitch 已包含设备回零时的俯仰。先还原机械底座，转动后再按原顺序应用 P/T 和画面 Roll。
  if (imageRoll) Matrix3.multiply(mount, Matrix3.fromRotationY(-imageRoll), mount);
  Matrix3.multiply(mount, Matrix3.fromRotationX(CesiumMath.toRadians(-pose.tiltOffset)), mount);
  const camera = Matrix3.multiply(mount, Matrix3.fromRotationZ(CesiumMath.toRadians(-ptz.Pan)), new Matrix3());
  Matrix3.multiply(camera, Matrix3.fromRotationX(CesiumMath.toRadians(pose.tiltOffset - ptz.Tilt)), camera);
  if (imageRoll) Matrix3.multiply(camera, Matrix3.fromRotationY(imageRoll), camera);
  return { mount, camera };
}

export function createZeroPoseQuaternion(pose: ZeroPose): Quaternion {
  return Quaternion.fromRotationMatrix(createZeroPoseRotation(pose));
}

function zeroPoseAngles(rotation: Matrix3) {
  const east = rotation[Matrix3.COLUMN1ROW0], north = rotation[Matrix3.COLUMN1ROW1];
  const up = rotation[Matrix3.COLUMN1ROW2];
  const horizontal = Math.hypot(east, north);
  const vertical = horizontal < CesiumMath.EPSILON12;
  const yaw = CesiumMath.toDegrees(vertical
    ? Math.atan2(-rotation[Matrix3.COLUMN0ROW1], rotation[Matrix3.COLUMN0ROW0]) : Math.atan2(east, north));
  // 光轴垂直时 Yaw 与 Roll 耦合，取 Roll 为零仍能重建同一旋转。
  return {
    yaw: ((yaw % 360) + 360) % 360,
    pitch: CesiumMath.toDegrees(Math.atan2(up, horizontal)),
    roll: vertical ? 0 : CesiumMath.toDegrees(Math.atan2(-rotation[Matrix3.COLUMN0ROW2], rotation[Matrix3.COLUMN2ROW2])),
  };
}

export function legacyZeroPose(installation: LegacyOrientation): ZeroPose {
  const { camera } = createLocalRigRotation(installation, { Pan: 0, Tilt: 0 });
  return { ...zeroPoseAngles(camera), tiltOffset: installation.tiltOffset,
    ...(installation.imageRoll ? { imageRoll: installation.imageRoll } : {}) };
}

export function calibratedZeroPose(calibration: LegacyOrientation & ActiveCalibration): ZeroPose {
  return activeZeroPoseOf(calibration) ?? legacyZeroPose(calibration);
}
