import { Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import type { VesselBodyDimensions, VesselGeometryOptions, VesselTarget } from './ais.models';

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
  const body = vesselBodyDimensions(target, options, override);
  // COG 仅用于缺少船艏时的船体建模，不改写报告的 heading。
  const heading = [target.heading, target.cog].find((value): value is number =>
    value !== null && Number.isFinite(value) && value >= 0 && value < 360);
  if (!body || heading === undefined) return null;
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
