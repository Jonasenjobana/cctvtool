import {
  Cartesian2, Cartesian3, Ellipsoid, EllipsoidalOccluder, IntersectionTests, Math as CesiumMath, Matrix3, Matrix4, Ray, Transforms,
} from 'cesium';
import type { CameraDraft, PreciseTarget, RawPtz } from './models';
import { createLocalRigRotation } from '#camera-rotation';

export interface CameraPose {
  position: Cartesian3;
  direction: Cartesian3;
  right: Cartesian3;
  up: Cartesian3;
  panAxis: Cartesian3;
  horizontalFov: number;
  verticalFov: number;
}

export interface VesselDimensions {
  length: number;
  width: number;
  heading: number;
  height?: number;
}

function finite(value: number | null, label: string): number {
  if (value === null || !Number.isFinite(value)) throw new Error(`请填写有效的${label}`);
  return value;
}

export function createCameraPose(camera: CameraDraft, ptz: RawPtz): CameraPose {
  const longitude = finite(camera.longitude, '经度');
  const latitude = finite(camera.latitude, '纬度');
  const height = finite(camera.height, '高度');
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90 || height < 0) throw new Error('安装位置超出有效范围');
  const horizontalFov = finite(ptz.HorizontalFieldAngle, '接口水平视场角');
  const verticalFov = finite(ptz.VerticalFieldAngle, '接口垂直视场角');
  if (horizontalFov <= 0 || horizontalFov >= 180 || verticalFov <= 0 || verticalFov >= 180) {
    throw new Error('接口返回的视场角无效');
  }
  const pan = finite(ptz.Pan, '云台 P');
  const tilt = finite(ptz.Tilt, '云台 T');
  const offset = finite(camera.panOffset, '默认朝向');
  const pitch = finite(camera.pAxisPitch, 'P 轴前后倾');
  const roll = finite(camera.pAxisRoll, 'P 轴左右倾');
  const tiltOffset = finite(camera.tiltOffset, 'T 偏移');
  const imageRoll = finite(camera.imageRoll, '画面 Roll 修正');
  const position = Cartesian3.fromDegrees(longitude, latitude, height);
  const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
  const rig = createLocalRigRotation({ pAxisPitch: pitch, pAxisRoll: roll, panOffset: offset, tiltOffset, imageRoll }, { Pan: pan, Tilt: tilt });
  const world = Matrix3.multiply(enu, rig.camera, new Matrix3());
  return {
    position,
    right: Matrix3.getColumn(world, 0, new Cartesian3()),
    direction: Matrix3.getColumn(world, 1, new Cartesian3()),
    up: Matrix3.getColumn(world, 2, new Cartesian3()),
    panAxis: Matrix3.multiplyByVector(Matrix3.multiply(enu, rig.mount, new Matrix3()), Cartesian3.UNIT_Z, new Cartesian3()),
    horizontalFov, verticalFov,
  };
}

export function pointTargetPtz(
  camera: CameraDraft, ptz: Pick<RawPtz, 'Pan' | 'Tilt' | 'Zoom'>,
  target: { longitude: number; latitude: number },
): PreciseTarget {
  const longitude = finite(camera.longitude, '经度'), latitude = finite(camera.latitude, '纬度');
  const height = finite(camera.height, '高度');
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90 || height < 0) throw new Error('安装位置超出有效范围');
  if (![target.longitude, target.latitude].every(Number.isFinite)
    || Math.abs(target.longitude) > 180 || Math.abs(target.latitude) > 90) throw new Error('临时点经纬度超出有效范围');
  const pan = finite(ptz.Pan, '云台 P'), tilt = finite(ptz.Tilt, '云台 T'), zoom = finite(ptz.Zoom, '当前倍率');
  if (zoom < 1) throw new Error('当前倍率必须大于或等于 1');
  if (tilt < -90 || tilt > 90) throw new Error('当前 T 必须位于 -90～90°');
  const installation = {
    pAxisPitch: finite(camera.pAxisPitch, 'P 轴前后倾'), pAxisRoll: finite(camera.pAxisRoll, 'P 轴左右倾'),
    panOffset: finite(camera.panOffset, '默认朝向'), tiltOffset: finite(camera.tiltOffset, 'T 偏移'),
    imageRoll: finite(camera.imageRoll, '画面 Roll 修正'),
  };
  const position = Cartesian3.fromDegrees(longitude, latitude, height);
  const destination = Cartesian3.fromDegrees(target.longitude, target.latitude, 0);
  const direction = Cartesian3.subtract(destination, position, new Cartesian3());
  if (Cartesian3.magnitudeSquared(direction) < 1e-12) throw new Error('临时点与摄像头位置重合，无法计算方向');
  if (!new EllipsoidalOccluder(Ellipsoid.WGS84, position).isPointVisible(destination)) {
    throw new Error('临时点超出椭球海面可视范围');
  }
  Cartesian3.normalize(direction, direction);
  const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
  const mount = createLocalRigRotation(installation, { Pan: 0, Tilt: 0 }).mount;
  const world = Matrix3.multiply(enu, mount, new Matrix3());
  const local = Matrix3.multiplyByVector(Matrix3.transpose(world, new Matrix3()), direction, new Cartesian3());
  const horizontal = Math.hypot(local.x, local.y);
  const targetPan = horizontal > 1e-12 ? CesiumMath.toDegrees(Math.atan2(local.x, local.y)) : pan;
  const elevation = CesiumMath.toDegrees(Math.atan2(local.z, horizontal));
  // P 是环形角，T 是有机械边界的有符号俯仰；只在合法解中选择较近的 P/T。
  // 画面 Roll 绕光轴旋转，不改变中心指向，也不参与目标 T 的修正。
  const candidates = [{ pan: targetPan, elevation }, { pan: targetPan + 180, elevation: 180 - elevation }]
    .map((candidate) => {
      const angle = CesiumMath.toRadians(installation.tiltOffset - candidate.elevation);
      return { pan: ((candidate.pan % 360) + 360) % 360,
        tilt: CesiumMath.toDegrees(Math.atan2(Math.sin(angle), Math.cos(angle))), zoom };
    })
    .filter((candidate) => candidate.tilt >= -90 && candidate.tilt <= 90);
  const travel = (candidate: PreciseTarget) => ((candidate.pan - pan + 540) % 360 - 180) ** 2 + (candidate.tilt - tilt) ** 2;
  const result = candidates.sort((left, right) => travel(left) - travel(right))[0];
  if (!result) throw new Error('目标方向在 T -90～90° 范围内不可达');
  return result;
}

export function vesselCorners(point: { longitude: number; latitude: number }, vessel: VesselDimensions): Cartesian3[] {
  const longitude = finite(point.longitude, '经度'), latitude = finite(point.latitude, '纬度');
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error('临时点经纬度超出有效范围');
  const length = finite(vessel.length, '船长'), width = finite(vessel.width, '船宽');
  const heading = finite(vessel.heading, '船艏朝向'), height = finite(vessel.height ?? 0, '船高');
  if (length <= 0 || width <= 0) throw new Error('船长和船宽必须大于 0');
  if (heading < 0 || heading > 360) throw new Error('船艏朝向必须位于 0～360°');
  if (height < 0) throw new Error('船高不能小于 0');
  const angle = CesiumMath.toRadians(heading), sin = Math.sin(angle), cos = Math.cos(angle);
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(longitude, latitude, 0));
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return (height > 0 ? [0, height] : [0]).flatMap((up) => signs.map(([along, across]) => {
    const forward = along * length / 2, right = across * width / 2;
    return Matrix4.multiplyByPoint(frame,
      new Cartesian3(forward * sin + right * cos, forward * cos - right * sin, up), new Cartesian3());
  }));
}

export function estimateVesselZoom(
  camera: CameraDraft, reading: RawPtz, point: { longitude: number; latitude: number },
  vessel: VesselDimensions, aim: PreciseTarget, maxZoom: number,
) {
  const referenceZoom = finite(reading.Zoom, '当前倍率');
  if (referenceZoom < 1 || !Number.isFinite(maxZoom) || maxZoom < 1) throw new Error('倍率及上限必须大于或等于 1');
  const pose = createCameraPose(camera, { ...reading, Pan: aim.pan, Tilt: aim.tilt });
  const tanH = Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2));
  const tanV = Math.tan(CesiumMath.toRadians(pose.verticalFov / 2));
  const projected = vesselCorners(point, vessel).map((corner) => {
    const ray = Cartesian3.subtract(corner, pose.position, new Cartesian3());
    const depth = Cartesian3.dot(ray, pose.direction);
    if (!(depth > 0)) throw new Error('船体范围未完全位于镜头前方，无法估算倍率');
    return { x: Cartesian3.dot(ray, pose.right) / (2 * depth * tanH),
      y: Cartesian3.dot(ray, pose.up) / (2 * depth * tanV) };
  });
  const width = Math.max(...projected.map((point) => point.x)) - Math.min(...projected.map((point) => point.x));
  const height = Math.max(...projected.map((point) => point.y)) - Math.min(...projected.map((point) => point.y));
  const occupied = Math.max(width, height);
  if (!Number.isFinite(occupied) || occupied <= 0) throw new Error('船体投影范围无效，无法估算倍率');
  if (occupied / referenceZoom > 0.5) throw new Error('按当前视场估算，1 倍时船体占比仍超过 50%');
  // 用同次 Z/FOV 按焦距与倍率成比例估算；向下取 0.1 档，避免舍入后超过占比上限。
  const desired = referenceZoom * 0.5 / occupied;
  const zoom = Math.max(1, Math.floor(Math.min(maxZoom, desired) * 10) / 10);
  return { zoom, widthFraction: width * zoom / referenceZoom, heightFraction: height * zoom / referenceZoom,
    distanceMeters: Cartesian3.distance(pose.position, Cartesian3.fromDegrees(point.longitude, point.latitude, 0)) };
}

function rayDirection(pose: CameraPose, x: number, y: number): Cartesian3 {
  const direction = Cartesian3.clone(pose.direction);
  Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.right,
    x * Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2)), new Cartesian3()), direction);
  Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.up,
    y * Math.tan(CesiumMath.toRadians(pose.verticalFov / 2)), new Cartesian3()), direction);
  return direction;
}

export function frustumCorners(pose: CameraPose, distance: number): Cartesian3[] {
  return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => Cartesian3.add(
    pose.position, Cartesian3.multiplyByScalar(rayDirection(pose, x, y), distance, new Cartesian3()), new Cartesian3(),
  ));
}

/** 视频截面固定在摄像头视场内，不随地图观察相机转动。 */
export function videoFovPlane(pose: CameraPose, distance: number): { matrix: Matrix4; uvScale: Cartesian2 } {
  const width = 2 * distance * Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2));
  const height = 2 * distance * Math.tan(CesiumMath.toRadians(pose.verticalFov / 2));
  const center = Cartesian3.add(pose.position,
    Cartesian3.multiplyByScalar(pose.direction, distance, new Cartesian3()), new Cartesian3());
  const axes = new Matrix3();
  Matrix3.setColumn(axes, 0, pose.right, axes);
  Matrix3.setColumn(axes, 1, pose.up, axes);
  Matrix3.setColumn(axes, 2, Cartesian3.negate(pose.direction, new Cartesian3()), axes);
  const matrix = Matrix4.fromRotationTranslation(axes, center);
  Matrix4.multiplyByScale(matrix, new Cartesian3(width, height, 1), matrix);
  // 完整画面的横纵坐标分别对应接口 HFOV/VFOV，额外按媒体比例缩放会偏离同一空间点的投影。
  return { matrix, uvScale: new Cartesian2(1, 1) };
}

export function footprintSegments(pose: CameraPose, maxDistance = 10000): Cartesian3[][] {
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1], [-1, 1]];
  const segments: Cartesian3[][] = [];
  let current: Cartesian3[] = [];
  for (let index = 0; index <= 64; index++) {
    const edge = Math.min(3, Math.floor(index / 16));
    const progress = (index - edge * 16) / 16;
    const x = corners[edge][0] + (corners[edge + 1][0] - corners[edge][0]) * progress;
    const y = corners[edge][1] + (corners[edge + 1][1] - corners[edge][1]) * progress;
    const ray = new Ray(pose.position, Cartesian3.normalize(rayDirection(pose, x, y), new Cartesian3()));
    const hit = IntersectionTests.rayEllipsoid(ray, Ellipsoid.WGS84);
    if (hit && hit.start > 0.0001 && hit.start <= maxDistance) {
      current.push(Ray.getPoint(ray, hit.start));
    } else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export function observationFov(pose: CameraPose, aspect: number): number {
  const tanVertical = Math.max(
    Math.tan(CesiumMath.toRadians(pose.verticalFov / 2)),
    Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2)) / aspect,
  ) / 0.65;
  return 2 * Math.atan(tanVertical * Math.max(1, aspect));
}
