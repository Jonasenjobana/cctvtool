import {
  Cartesian2, Cartesian3, Ellipsoid, IntersectionTests, Math as CesiumMath, Matrix3, Matrix4, Ray, Transforms,
} from 'cesium';
import type { CameraDraft, RawPtz } from './models';
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
export function videoFovPlane(pose: CameraPose, distance: number, videoAspect: number): { matrix: Matrix4; uvScale: Cartesian2 } {
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
  // 接口两个 FOV 独立保留；比例不同时留透明边，避免拉伸原视频。
  const aspect = width / height;
  const uvScale = aspect > videoAspect ? new Cartesian2(aspect / videoAspect, 1) : new Cartesian2(1, videoAspect / aspect);
  return { matrix, uvScale };
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
