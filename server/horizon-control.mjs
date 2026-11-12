import { Cartesian3, Ellipsoid, Matrix3, Matrix4, Transforms } from 'cesium';
import { createLocalRigRotation } from '#camera-rotation';
import { httpError } from './errors.mjs';

const rad = Math.PI / 180;

function horizonGeometry(calibration) {
  if (!calibration || ![calibration.longitude, calibration.latitude, calibration.height,
    calibration.pAxisPitch, calibration.pAxisRoll, calibration.panOffset,
    calibration.tiltOffset, calibration.imageRoll].every(Number.isFinite)
    || Math.abs(calibration.longitude) > 180 || Math.abs(calibration.latitude) > 90 || calibration.height < 0
    || Math.abs(calibration.pAxisPitch) > 180 || Math.abs(calibration.pAxisRoll) > 180
    || Math.abs(calibration.panOffset) > 360 || Math.abs(calibration.tiltOffset) > 180 || Math.abs(calibration.imageRoll) > 180) {
    throw httpError(400, '海天线控制需要有效的安装位置与完整标定参数');
  }
  const position = Cartesian3.fromDegrees(calibration.longitude, calibration.latitude, calibration.height);
  const scaled = Cartesian3.multiplyComponents(position, Ellipsoid.WGS84.oneOverRadii, new Cartesian3());
  const length = Cartesian3.magnitude(scaled);
  return {
    enu: Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3()),
    normal: Cartesian3.divideByScalar(scaled, length, new Cartesian3()),
    dip: Math.acos(Math.min(1, 1 / length)),
  };
}

function centerOffset(calibration, geometry, rawPtz) {
  const rotation = createLocalRigRotation(calibration, rawPtz).camera;
  const world = Matrix3.multiply(geometry.enu, rotation, new Matrix3());
  const direction = Cartesian3.multiplyComponents(
    Matrix3.getColumn(world, 1, new Cartesian3()), Ellipsoid.WGS84.oneOverRadii, new Cartesian3(),
  );
  Cartesian3.normalize(direction, direction);
  return (Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(geometry.normal, direction)))) + geometry.dip) / rad;
}

export function horizonOffsetDegrees(calibration, rawPtz) {
  if (!rawPtz || ![rawPtz.Pan, rawPtz.Tilt].every(Number.isFinite)) {
    throw httpError(400, '海天线中心角差需要有效的原始 P/T');
  }
  return centerOffset(calibration, horizonGeometry(calibration), rawPtz);
}

export function solveHorizonTilt(calibration, options) {
  const { pan, referenceTilt, tiltMin, tiltMax } = options ?? {};
  if (![pan, referenceTilt, tiltMin, tiltMax].every(Number.isFinite) || pan < 0 || pan > 360
    || tiltMin < 0 || tiltMax > 360 || tiltMax <= tiltMin || referenceTilt < tiltMin || referenceTilt > tiltMax) {
    throw httpError(400, 'P 必须位于 0～360°，参考 T 必须位于有效的允许 T 区间内');
  }
  const geometry = horizonGeometry(calibration);
  if (Math.abs(centerOffset(calibration, geometry, { Pan: pan, Tilt: referenceTilt })) < 1e-9) return referenceTilt;
  const rotation = createLocalRigRotation({ ...calibration, imageRoll: 0 }, { Pan: pan, Tilt: 0 }).camera;
  const world = Matrix3.multiply(geometry.enu, rotation, new Matrix3());
  const forward = Matrix3.getColumn(world, 1, new Cartesian3());
  const down = Cartesian3.negate(Matrix3.getColumn(world, 2, new Cartesian3()), new Cartesian3());
  const up = Matrix3.getColumn(geometry.enu, 2, new Cartesian3());
  const forwardUp = Cartesian3.dot(up, forward), downUp = Cartesian3.dot(up, down);
  const sideAt = (tilt) => -downUp * Math.cos(tilt * rad) + forwardUp * Math.sin(tilt * rad);
  const referenceSide = sideAt(referenceTilt);
  const first = Cartesian3.normalize(Cartesian3.multiplyComponents(
    forward, Ellipsoid.WGS84.oneOverRadii, new Cartesian3(),
  ), new Cartesian3());
  const second = Cartesian3.multiplyComponents(down, Ellipsoid.WGS84.oneOverRadii, new Cartesian3());
  Cartesian3.subtract(second, Cartesian3.multiplyByScalar(first, Cartesian3.dot(first, second), new Cartesian3()), second);
  Cartesian3.normalize(second, second);
  const x = Cartesian3.dot(geometry.normal, first), y = Cartesian3.dot(geometry.normal, second);
  const projection = Math.hypot(x, y), dip = Math.sin(geometry.dip);
  // 显式检查边界本身是否相切，避免将真正越界的 T 硬截到边界。
  const candidates = [tiltMin, tiltMax].filter((tilt) =>
    Math.abs(centerOffset(calibration, geometry, { Pan: pan, Tilt: tilt })) < 1e-9);
  if (projection > 1e-14 && projection >= dip) {
    const radial = Cartesian3.add(Cartesian3.multiplyByScalar(first, x / projection, new Cartesian3()),
      Cartesian3.multiplyByScalar(second, y / projection, new Cartesian3()), new Cartesian3());
    const sideways = Cartesian3.add(Cartesian3.multiplyByScalar(first, -y / projection, new Cartesian3()),
      Cartesian3.multiplyByScalar(second, x / projection, new Cartesian3()), new Cartesian3());
    const along = -dip / projection, across = Math.sqrt(Math.max(0, 1 - along * along));
    // 缩放空间直接选择朝向椭球的两条切线，排除切点在射线后方的直线解。
    for (const sign of [-1, 1]) {
      const direction = Cartesian3.add(Cartesian3.multiplyByScalar(radial, along, new Cartesian3()),
        Cartesian3.multiplyByScalar(sideways, sign * across, new Cartesian3()), new Cartesian3());
      Cartesian3.multiplyComponents(direction, Ellipsoid.WGS84.radii, direction);
      const tilt = Math.atan2(Cartesian3.dot(direction, down), Cartesian3.dot(direction, forward)) / rad;
      candidates.push(tilt, tilt + 360);
    }
  }
  // 以真实 ENU 上方向划分俯仰分支；参考光轴恰在竖直极值时不能决定应翻向哪边。
  // 同一分支还必须在原始 T 中连续，跨 0°包装不能使越界目标成为可达目标。
  const reachable = candidates.filter((tilt) => tilt >= tiltMin && tilt <= tiltMax
    && Math.abs(tilt - referenceTilt) < 180 && Math.abs(referenceSide) > 1e-12 && sideAt(tilt) * referenceSide > 0)
    .sort((left, right) => Math.abs(left - referenceTilt) - Math.abs(right - referenceTilt));
  if (!reachable.length) throw httpError(400, '允许 T 范围内的同分支海天线不可达');
  return reachable[0];
}
