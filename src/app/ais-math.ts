import { Cartesian3, Cartographic, Ellipsoid, EllipsoidalOccluder, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import type { VesselBodyDimensions, VesselGeometryOptions, VesselTarget } from './ais.models';
import type { CameraPose } from './camera-math';

export function vesselBodyDimensions(target: VesselTarget, options: VesselGeometryOptions, override?: VesselBodyDimensions): VesselBodyDimensions | null {
  let body = override;
  if (!body) {
    const { length, width } = target;
    if (length === null || width === null || length <= 0 || width <= 0 || ![length, width].every(Number.isFinite)
      || ![options.antennaFromSternRatio, options.antennaFromPortRatio].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
    body = { a: length * (1 - options.antennaFromSternRatio), b: length * options.antennaFromSternRatio,
      c: width * options.antennaFromPortRatio, d: width * (1 - options.antennaFromPortRatio), height: options.heightMeters };
  }
  const { a, b, c, d, height } = body;
  if (![a, b, c, d].every(value => Number.isFinite(value) && value >= 0)
    || ![a + b, c + d, height].every(value => Number.isFinite(value) && value > 0)) return null;
  return { a, b, c, d, height };
}

export function vesselGeometry(target: VesselTarget, options: VesselGeometryOptions, override?: VesselBodyDimensions) {
  const body = vesselBodyDimensions(target, options, override), { heading } = target;
  if (!body || heading === null || !Number.isFinite(heading) || heading < 0 || heading >= 360) return null;
  const { a, b, c, d, height } = body, length = a + b, width = c + d;
  const forward = (a - b) / 2, right = (d - c) / 2;
  const angle = CesiumMath.toRadians(heading);
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(target.longitude, target.latitude));
  const center = Matrix4.multiplyByPoint(frame, new Cartesian3(
    forward * Math.sin(angle) + right * Math.cos(angle), forward * Math.cos(angle) - right * Math.sin(angle), 0,
  ), new Cartesian3());
  const cartographic = Cartographic.fromCartesian(center);
  const point = { longitude: CesiumMath.toDegrees(cartographic.longitude), latitude: CesiumMath.toDegrees(cartographic.latitude) };
  const position = Cartesian3.fromDegrees(point.longitude, point.latitude, height / 2);
  return { point, position, abcd: { a, b, c, d }, dimensions: new Cartesian3(width, length, height),
    orientation: Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(angle, 0, 0)),
    vessel: { length, width, heading, height } };
}

export function isInCameraView(pose: CameraPose, position: Cartesian3, radius = 0): boolean {
  const ray = Cartesian3.subtract(position, pose.position, new Cartesian3());
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
