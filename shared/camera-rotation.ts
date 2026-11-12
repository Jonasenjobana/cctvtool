import { Math as CesiumMath, Matrix3 } from 'cesium';

/** 前端投影与海天线拟合共用参考项目的安装方位／底座倾斜／局部 P/T 旋转链。 */
export function createLocalRigRotation(
  installation: { pAxisPitch: number; pAxisRoll: number; panOffset: number; tiltOffset: number; imageRoll: number },
  ptz: { Pan: number; Tilt: number },
): { mount: Matrix3; camera: Matrix3 } {
  const mount = Matrix3.multiply(
    Matrix3.fromRotationZ(CesiumMath.toRadians(-installation.panOffset)),
    Matrix3.fromRotationX(CesiumMath.toRadians(installation.pAxisPitch)), new Matrix3(),
  );
  Matrix3.multiply(mount, Matrix3.fromRotationY(CesiumMath.toRadians(installation.pAxisRoll)), mount);
  // 默认朝向是整个安装坐标系的方位，不能合并到倾斜之后的实时 P 中。
  const camera = Matrix3.multiply(mount,
    Matrix3.fromRotationZ(CesiumMath.toRadians(-ptz.Pan)), new Matrix3());
  // 沿用参考模型：T 偏移正值上抬；画面 Roll 在局部 P/T 之后绕光轴作用。
  Matrix3.multiply(camera, Matrix3.fromRotationX(CesiumMath.toRadians(installation.tiltOffset - ptz.Tilt)), camera);
  Matrix3.multiply(camera, Matrix3.fromRotationY(CesiumMath.toRadians(installation.imageRoll)), camera);
  return { mount, camera };
}
