import { Math as CesiumMath, Matrix3, Quaternion } from 'cesium';
import { createLocalRigRotation } from '#camera-rotation';

export interface ZeroPose {
  roll: number;
  pitch: number;
  yaw: number;
  tiltOffset: number;
}

export function createZeroPoseRotation(pose: ZeroPose): Matrix3 {
  const rotation = Matrix3.multiply(
    Matrix3.fromRotationZ(CesiumMath.toRadians(-pose.yaw)),
    Matrix3.fromRotationX(CesiumMath.toRadians(pose.pitch)), new Matrix3(),
  );
  return Matrix3.multiply(rotation, Matrix3.fromRotationY(CesiumMath.toRadians(pose.roll)), rotation);
}

export function createZeroPoseRigRotation(pose: ZeroPose, ptz: { Pan: number; Tilt: number }) {
  // 先抵消设备零位的机械俯仰，再应用实际 P/T，确保设备回零时光轴取表单姿态。
  const mount = Matrix3.multiply(createZeroPoseRotation(pose),
    Matrix3.fromRotationX(CesiumMath.toRadians(-pose.tiltOffset)), new Matrix3());
  const camera = Matrix3.multiply(mount, Matrix3.fromRotationZ(CesiumMath.toRadians(-ptz.Pan)), new Matrix3());
  Matrix3.multiply(camera, Matrix3.fromRotationX(CesiumMath.toRadians(pose.tiltOffset - ptz.Tilt)), camera);
  return { mount, camera };
}

export function createZeroPoseQuaternion(pose: ZeroPose): Quaternion {
  return Quaternion.fromRotationMatrix(createZeroPoseRotation(pose));
}

function zeroPoseAngles(rotation: Matrix3, yawBasis?: number) {
  const east = rotation[Matrix3.COLUMN1ROW0], north = rotation[Matrix3.COLUMN1ROW1];
  const up = rotation[Matrix3.COLUMN1ROW2];
  const horizontal = Math.hypot(east, north);
  const vertical = horizontal < CesiumMath.EPSILON12;
  const canonicalYaw = CesiumMath.toDegrees(vertical
    ? Math.atan2(-rotation[Matrix3.COLUMN0ROW1], rotation[Matrix3.COLUMN0ROW0]) : Math.atan2(east, north));
  const yaw = yawBasis ?? canonicalYaw;
  // 光轴垂直时由 Roll 承接固定 Yaw 与分解结果之间的差值。
  const coupledRoll = CesiumMath.toRadians((yaw - canonicalYaw) * Math.sign(up));
  return {
    yaw: ((yaw % 360) + 360) % 360,
    pitch: CesiumMath.toDegrees(Math.atan2(up, horizontal)),
    roll: CesiumMath.toDegrees(vertical ? Math.atan2(Math.sin(coupledRoll), Math.cos(coupledRoll))
      : Math.atan2(-rotation[Matrix3.COLUMN0ROW2], rotation[Matrix3.COLUMN2ROW2])),
  };
}

export function resolveZeroPose(installation: Parameters<typeof createLocalRigRotation>[0] & { zeroPose?: ZeroPose }): ZeroPose {
  if (installation.zeroPose) return installation.zeroPose;
  const { camera } = createLocalRigRotation(installation, { Pan: 0, Tilt: 0 });
  return { ...zeroPoseAngles(camera, installation.panOffset), tiltOffset: installation.tiltOffset };
}

export function updateZeroPoseTiltOffset(pose: ZeroPose, tiltOffset: number): ZeroPose {
  if (pose.tiltOffset === tiltOffset) return pose;
  const rotation = Matrix3.multiply(createZeroPoseRotation(pose),
    Matrix3.fromRotationX(CesiumMath.toRadians(tiltOffset - pose.tiltOffset)), new Matrix3());
  return { ...zeroPoseAngles(rotation), tiltOffset };
}
