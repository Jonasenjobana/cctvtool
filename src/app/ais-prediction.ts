import { Cartographic, Ellipsoid, EllipsoidRhumbLine, Math as CesiumMath } from 'cesium';
import type { VesselPrediction, VesselTarget } from './ais.models';

export function predictVesselPosition(target: VesselTarget, seconds: number, now = Date.now()): VesselPrediction {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('预判秒数须为大于或等于 0 的数字');
  const sourceTime = Date.parse(target.time), predictedTime = now + seconds * 1000;
  if (!Number.isFinite(sourceTime) || !Number.isFinite(now) || !Number.isFinite(new Date(predictedTime).getTime())) {
    throw new Error('AIS 或预判时间超出可计算范围');
  }
  const elapsedSeconds = (predictedTime - sourceTime) / 1000;
  if (elapsedSeconds < 0) throw new Error('AIS 时间晚于预判时刻，请检查数据源时间');
  if (![target.longitude, target.latitude].every(Number.isFinite)
    || Math.abs(target.longitude) > 180 || Math.abs(target.latitude) > 90) throw new Error('AIS 经纬度超出有效范围');
  if (target.speed === null || !Number.isFinite(target.speed) || target.speed < 0) throw new Error('缺少有效航速，无法预判');
  const distanceMeters = target.speed * 1852 / 3600 * elapsedSeconds;
  if (!Number.isFinite(distanceMeters)) throw new Error('预判距离超出可计算范围');
  const prediction = { longitude: target.longitude, latitude: target.latitude,
    predictedAt: new Date(predictedTime).toISOString(), elapsedSeconds, distanceMeters };
  if (distanceMeters === 0) return prediction;
  const heading = [target.cog, target.heading].find((value): value is number =>
    value !== null && Number.isFinite(value) && value >= 0 && value < 360);
  if (heading === undefined) throw new Error('缺少有效对地航向或船艏向，无法预判');
  // 每次都从原始报告时刻沿恒定航向外推，避免逐帧累加误差或遗漏 AIS 的历史时间差。
  const destination = EllipsoidRhumbLine.fromStartHeadingDistance(
    Cartographic.fromDegrees(target.longitude, target.latitude), CesiumMath.toRadians(heading), distanceMeters, Ellipsoid.WGS84,
  ).end;
  const longitude = CesiumMath.toDegrees(destination.longitude), latitude = CesiumMath.toDegrees(destination.latitude);
  if (![longitude, latitude].every(Number.isFinite) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Error('预判位置超出可计算范围');
  }
  return { ...prediction, longitude, latitude };
}
