import { Cartesian3, Cartographic, Ellipsoid, EllipsoidalOccluder, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import type { VesselGeometryOptions, VesselTarget } from './ais.models';
import type { CameraPose } from './camera-math';

export function vesselGeometry(target: VesselTarget, options: VesselGeometryOptions) {
  const { length, width, heading } = target;
  if (length === null || width === null || heading === null || length <= 0 || width <= 0
    || ![length, width, heading].every(Number.isFinite) || heading < 0 || heading >= 360) return null;
  if (!Number.isFinite(options.heightMeters) || options.heightMeters <= 0
    || ![options.antennaFromSternRatio, options.antennaFromPortRatio].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const a = length * (1 - options.antennaFromSternRatio), b = length * options.antennaFromSternRatio;
  const c = width * options.antennaFromPortRatio, d = width * (1 - options.antennaFromPortRatio);
  const forward = (a - b) / 2, right = (d - c) / 2;
  const angle = CesiumMath.toRadians(heading);
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(target.longitude, target.latitude));
  const center = Matrix4.multiplyByPoint(frame, new Cartesian3(
    forward * Math.sin(angle) + right * Math.cos(angle), forward * Math.cos(angle) - right * Math.sin(angle), 0,
  ), new Cartesian3());
  const cartographic = Cartographic.fromCartesian(center);
  const point = { longitude: CesiumMath.toDegrees(cartographic.longitude), latitude: CesiumMath.toDegrees(cartographic.latitude) };
  const position = Cartesian3.fromDegrees(point.longitude, point.latitude, options.heightMeters / 2);
  return { point, position, abcd: { a, b, c, d }, dimensions: new Cartesian3(width, length, options.heightMeters),
    orientation: Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(angle, 0, 0)),
    vessel: { length, width, heading, height: options.heightMeters } };
}

export function isInCameraView(pose: CameraPose, position: Cartesian3, maxDistance: number, radius = 0): boolean {
  const ray = Cartesian3.subtract(position, pose.position, new Cartesian3());
  if (Cartesian3.magnitude(ray) - radius > maxDistance) return false;
  const depth = Cartesian3.dot(ray, pose.direction);
  if (depth + radius <= 0) return false;
  const tanH = Math.tan(CesiumMath.toRadians(pose.horizontalFov / 2));
  const tanV = Math.tan(CesiumMath.toRadians(pose.verticalFov / 2));
  if (Math.abs(Cartesian3.dot(ray, pose.right)) > depth * tanH + radius * Math.hypot(1, tanH)
    || Math.abs(Cartesian3.dot(ray, pose.up)) > depth * tanV + radius * Math.hypot(1, tanV)) return false;
  const top = Cartesian3.add(position, Cartesian3.multiplyByScalar(
    Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3()), radius, new Cartesian3()), new Cartesian3());
  return new EllipsoidalOccluder(Ellipsoid.WGS84, pose.position).isPointVisible(top);
}
