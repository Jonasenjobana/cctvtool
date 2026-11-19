import { Cartesian3, Ellipsoid, Matrix3, Matrix4, Transforms } from 'cesium';
import { createLocalRigRotation } from '#camera-rotation';
import { createZeroPoseRigRotation, resolveZeroPose } from '#zero-pose';
import { httpError } from './errors.mjs';

const rad = Math.PI / 180;
const maximumRmsPixels = 5;
const installationModel = 'wgs84-horizon-installation-v1';
export const ZERO_POSE_MODEL = 'wgs84-horizon-zero-pose-v1';

export function calibrationRange(startTime, endTime) {
  const withZone = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!withZone.test(startTime) || !withZone.test(endTime)) {
    throw httpError(400, '起止时间必须是带时区的 ISO 时间');
  }
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end) {
    throw httpError(400, '时间段无效，结束时间必须晚于开始时间');
  }
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

export function panCoverage(values) {
  const angles = [...new Set(values.map((value) => Math.round((((value % 360) + 360) % 360) * 100) / 100))].sort((a, b) => a - b);
  if (angles.length < 2) return { distinctPanCount: angles.length, panCoverageDegrees: 0 };
  const gaps = angles.map((angle, index) => (angles[index + 1] ?? angles[0] + 360) - angle);
  return { distinctPanCount: angles.length, panCoverageDegrees: 360 - Math.max(...gaps) };
}

function cameraGeometry(camera) {
  if (![camera.longitude, camera.latitude, camera.height, camera.panOffset, camera.tiltOffset, camera.imageRoll].every(Number.isFinite)
    || Math.abs(camera.longitude) > 180 || Math.abs(camera.latitude) > 90 || camera.height < 0
    || Math.abs(camera.tiltOffset) > 180 || Math.abs(camera.imageRoll) > 180) {
    throw httpError(400, '请先为该摄像头保存有效的经纬度、高度、P/T 偏移和画面 Roll 修正');
  }
  const position = Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height);
  const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
  const inverseRadii = Ellipsoid.WGS84.oneOverRadii;
  const scaled = Cartesian3.multiplyComponents(position, inverseRadii, new Cartesian3());
  const length = Cartesian3.magnitude(scaled);
  return {
    enu, inverseRadii,
    normal: Cartesian3.divideByScalar(scaled, length, new Cartesian3()),
    dip: Math.acos(Math.min(1, 1 / length)),
  };
}

function prepareSamples(camera, snapshots, observations, range) {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const seen = new Set();
  const samples = [];
  const excluded = [];
  for (const observation of observations) {
    if (seen.has(observation.snapshotId)) throw httpError(400, '同一张截图不能重复提交');
    seen.add(observation.snapshotId);
    const snapshot = byId.get(observation.snapshotId);
    if (!snapshot || snapshot.cameraId !== camera.id || snapshot.createdAt < range.startTime || snapshot.createdAt >= range.endTime) {
      throw httpError(400, '截图不属于指定摄像头或时间段');
    }
    const ptz = snapshot.ptz?.raw;
    let reason;
    if (snapshot.serial !== camera.serial || snapshot.code !== camera.code) reason = '截图对应的设备通道与当前配置不同';
    else if (snapshot.poseChanged) reason = '截图前后 PTZ 或视场角发生变化';
    else if (!ptz || ![ptz.Pan, ptz.Tilt, ptz.Zoom, ptz.HorizontalFieldAngle, ptz.VerticalFieldAngle].every(Number.isFinite)
      || ptz.Zoom <= 0 || ptz.HorizontalFieldAngle <= 0 || ptz.HorizontalFieldAngle >= 180
      || ptz.VerticalFieldAngle <= 0 || ptz.VerticalFieldAngle >= 180) reason = '采样 PTZ 或视场角无效';
    else if (![snapshot.width, snapshot.height].every((value) => Number.isInteger(value) && value > 0)) reason = '图片尺寸无效';
    if (reason) { excluded.push({ snapshotId: snapshot.id, reason }); continue; }
    const points = observation.points;
    if (!Array.isArray(points) || points.length < 2 || points.some((point) => ![point.x, point.y].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ))) throw httpError(400, '每张图至少提供两个位于 0～1 范围内的归一化海天线点');
    const spread = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    if (spread < 0.1) {
      excluded.push({ snapshotId: snapshot.id, reason: '海天线标注横向跨度不足图片宽度的 10%' });
      continue;
    }
    const tanH = Math.tan(ptz.HorizontalFieldAngle * rad / 2);
    const tanV = Math.tan(ptz.VerticalFieldAngle * rad / 2);
    samples.push({
      snapshot, ptz, annotation: points,
      fx: snapshot.width / (2 * tanH), fy: snapshot.height / (2 * tanV),
      points: points.map((point) => ({ nx: (2 * point.x - 1) * tanH, nz: (1 - 2 * point.y) * tanV })),
    });
  }
  return { samples, excluded };
}

function legacyRotation(camera, parameters, ptz) {
  return createLocalRigRotation({ pAxisPitch: parameters[0], pAxisRoll: parameters[1],
    panOffset: camera.panOffset, tiltOffset: parameters[2] ?? camera.tiltOffset,
    imageRoll: parameters[3] ?? camera.imageRoll }, ptz).camera;
}

function rayColumns(rotation, geometry) {
  const world = Matrix3.multiply(geometry.enu, rotation, new Matrix3());
  return [0, 1, 2].map((index) => Cartesian3.multiplyComponents(
    Matrix3.getColumn(world, index, new Cartesian3()), geometry.inverseRadii, new Cartesian3(),
  ));
}

function residuals(parameters, camera, geometry, samples, rotation = (values, ptz) => legacyRotation(camera, values, ptz)) {
  const result = [];
  for (const sample of samples) {
    const columns = rayColumns(rotation(parameters, sample.ptz), geometry);
    for (const point of sample.points) {
      const ray = Cartesian3.add(columns[1], Cartesian3.add(
        Cartesian3.multiplyByScalar(columns[0], point.nx, new Cartesian3()),
        Cartesian3.multiplyByScalar(columns[2], point.nz, new Cartesian3()), new Cartesian3(),
      ), new Cartesian3());
      const length = Cartesian3.magnitude(ray);
      const direction = Cartesian3.divideByScalar(ray, length, new Cartesian3());
      const dot = Math.max(-1 + 1e-14, Math.min(1 - 1e-14, Cartesian3.dot(geometry.normal, direction)));
      // 在椭球缩放空间，切线方向与相机位置的夹角由相机高度唯一确定。
      const angle = Math.asin(dot) + geometry.dip;
      const gradient = Cartesian3.divideByScalar(Cartesian3.subtract(geometry.normal,
        Cartesian3.multiplyByScalar(direction, dot, new Cartesian3()), new Cartesian3()), length * Math.sqrt(1 - dot * dot), new Cartesian3());
      const dx = Cartesian3.dot(gradient, columns[0]) / sample.fx;
      const dy = -Cartesian3.dot(gradient, columns[2]) / sample.fy;
      const pixels = angle / Math.max(1e-12, Math.hypot(dx, dy));
      result.push({ pixels, angle, snapshotId: sample.snapshot.id, weight: (sample.weight ?? 1) / sample.points.length });
    }
  }
  return result;
}

function loss(values) {
  return values.reduce((sum, value) => {
    const magnitude = Math.abs(value.pixels);
    return sum + value.weight * (magnitude <= 4 ? magnitude * magnitude / 2 : 4 * (magnitude - 2));
  }, 0);
}

function linearize(parameters, camera, geometry, samples) {
  const values = residuals(parameters, camera, geometry, samples);
  const derivatives = [0, 1].map((axis) => {
    const above = [...parameters];
    const below = [...parameters];
    above[axis] += 0.0001;
    below[axis] -= 0.0001;
    const plus = residuals(above, camera, geometry, samples);
    const minus = residuals(below, camera, geometry, samples);
    return plus.map((value, index) => (value.pixels - minus[index].pixels) / 0.0002);
  });
  let a = 0, b = 0, c = 0, gx = 0, gy = 0;
  values.forEach((value, index) => {
    const weight = value.weight * Math.min(1, 4 / Math.max(1e-12, Math.abs(value.pixels)));
    const x = derivatives[0][index], y = derivatives[1][index];
    a += weight * x * x;
    b += weight * x * y;
    c += weight * y * y;
    gx += weight * x * value.pixels;
    gy += weight * y * value.pixels;
  });
  return { values, a, b, c, gx, gy };
}

function optimize(initial, camera, geometry, samples) {
  let parameters = [...initial];
  let damping = 0.001;
  let cost = loss(residuals(parameters, camera, geometry, samples));
  let converged = false;
  let iterations = 0;
  for (; iterations < 80; iterations++) {
    const normal = linearize(parameters, camera, geometry, samples);
    const a = normal.a + damping * Math.max(normal.a, 1e-6);
    const c = normal.c + damping * Math.max(normal.c, 1e-6);
    const determinant = a * c - normal.b * normal.b;
    if (determinant <= 1e-20) break;
    const step = [(-c * normal.gx + normal.b * normal.gy) / determinant,
      (normal.b * normal.gx - a * normal.gy) / determinant];
    const scale = Math.min(1, 15 / Math.max(Math.abs(step[0]), Math.abs(step[1]), 1e-12));
    const next = parameters.map((value, index) => value + step[index] * scale);
    if (next.some((value) => Math.abs(value) >= 89)) { damping *= 10; continue; }
    const nextCost = loss(residuals(next, camera, geometry, samples));
    if (nextCost <= cost) {
      const change = cost - nextCost;
      parameters = next;
      cost = nextCost;
      damping = Math.max(1e-12, damping / 3);
      if (Math.hypot(...step) * scale < 1e-7 || change < 1e-12 * (1 + cost)) { converged = true; break; }
    } else {
      damping *= 10;
      if (damping > 1e12) break;
    }
  }
  return { parameters, cost, converged, iterations: iterations + 1 };
}

export function estimatePAxisTilt(camera, snapshots, observations, requestedRange) {
  const range = calibrationRange(requestedRange.startTime, requestedRange.endTime);
  const geometry = cameraGeometry(camera);
  const { samples, excluded } = prepareSamples(camera, snapshots, observations, range);
  const coverage = panCoverage(samples.map((sample) => sample.ptz.Pan));
  const base = {
    model: 'wgs84-horizon-p-axis-v3', generatedAt: new Date().toISOString(),
    cameraId: camera.id, cameraName: camera.name, serial: camera.serial, code: camera.code,
    ...range, applied: false,
    fixedCalibration: { longitude: camera.longitude, latitude: camera.latitude, height: camera.height,
      panOffset: camera.panOffset, tiltOffset: camera.tiltOffset, imageRoll: camera.imageRoll, cameraUpdatedAt: camera.updatedAt },
    sourceSnapshotIds: samples.map((sample) => sample.snapshot.id),
    observations: observations.map(({ snapshotId, points }) => ({ snapshotId, points })), excluded, ...coverage,
  };
  if (!samples.length) {
    return { ...base, status: 'insufficient_data', installation: null,
      message: '没有有效的停稳截图和海天线标注，无法进行拟合' };
  }
  const starts = [[0, 0]];
  if ([camera.pAxisPitch, camera.pAxisRoll].every((value) => Number.isFinite(value) && Math.abs(value) < 89)) {
    starts.push([camera.pAxisPitch, camera.pAxisRoll]);
  }
  const solutions = starts.map((initial) => optimize(initial, camera, geometry, samples)).sort((a, b) => a.cost - b.cost);
  const solution = solutions[0];
  const normal = linearize(solution.parameters, camera, geometry, samples);
  const trace = normal.a + normal.c;
  const difference = Math.hypot(normal.a - normal.c, 2 * normal.b);
  const smallest = Math.max(0, (trace - difference) / 2);
  const conditionNumber = smallest > 1e-12 ? (trace + difference) / (2 * smallest) : null;
  const rms = (values, key) => Math.sqrt(values.reduce((sum, value) => sum + value[key] ** 2, 0) / values.length);
  const perSnapshot = samples.map((sample) => {
    const values = normal.values.filter((value) => value.snapshotId === sample.snapshot.id);
    return { snapshotId: sample.snapshot.id, createdAt: sample.snapshot.createdAt,
      pan: sample.ptz.Pan, tilt: sample.ptz.Tilt, zoom: sample.ptz.Zoom,
      rmsResidualPixels: rms(values, 'pixels'), rmsAngularDegrees: rms(values, 'angle') / rad };
  });
  const rmsResidualPixels = Math.sqrt(perSnapshot.reduce((sum, item) => sum + item.rmsResidualPixels ** 2, 0) / samples.length);
  const stable = conditionNumber !== null && conditionNumber < 1e8 && solution.converged;
  const accepted = stable && Number.isFinite(rmsResidualPixels) && rmsResidualPixels <= maximumRmsPixels;
  const [pAxisPitch, pAxisRoll] = solution.parameters;
  const mount = createLocalRigRotation({ pAxisPitch, pAxisRoll, panOffset: camera.panOffset,
    tiltOffset: camera.tiltOffset, imageRoll: camera.imageRoll }, { Pan: 0, Tilt: 0 }).mount;
  const axis = Matrix3.getColumn(mount, 2, new Cartesian3());
  const tiltDegrees = Math.acos(Math.max(-1, Math.min(1, axis.z))) / rad;
  return {
    ...base, status: accepted ? 'estimated' : 'unreliable',
    installation: accepted ? { pAxisPitch, pAxisRoll, tiltDegrees,
      axisDirectionEnu: { east: axis.x, north: axis.y, up: axis.z },
      tiltBearingDegrees: tiltDegrees < 1e-6 ? null : ((Math.atan2(axis.x, axis.y) / rad) + 360) % 360 } : null,
    diagnostics: { converged: solution.converged, iterations: solution.iterations, conditionNumber,
      rmsResidualPixels, maximumAcceptedRmsPixels: maximumRmsPixels, perSnapshot },
    assumptions: ['固定安装且 P 轴朝上，前后倾和左右倾均在 -89°～89°内',
      '默认朝向先旋转整个安装坐标系，再按该坐标系定义前后倾和左右倾',
      '使用当前数据库中的经纬度、高度、P/T 偏移和画面 Roll 修正作为固定参考',
      '图像主点取中心，采用采样时接口视场角',
      '海面近似为 WGS84 零高程椭球，未建模潮汐、折射、畸变和稳像裁剪'],
    warnings: ['海天线点由调用方 AI 提供，拟合结果是待人工复核的估计值',
      'T 偏移与画面 Roll 修正作为固定输入，本次不估计这两项；设置不准会影响 P 轴倾斜结果',
      '截图与 PTZ 未确认严格同步；海天线不能验证安装高度或绝对朝向',
      '倾向方位基于当前保存的 P 偏移，不代表独立测得的绝对朝向',
      '样本较少或采样方向集中时，结果对标注和固定参数误差更敏感'],
    message: accepted ? '已生成 P 轴倾斜估计，未修改摄像头配置'
      : '拟合未通过收敛、可辨识性或残差检查；请复核海天线、同步情况及已保存的 T 偏移和画面 Roll 修正',
  };
}

function solveLinear(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < vector.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= vector.length; index++) rows[column][index] /= divisor;
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= vector.length; index++) rows[row][index] -= factor * rows[column][index];
    }
  }
  const solution = rows.map((row) => row.at(-1));
  return solution.every(Number.isFinite) ? solution : null;
}

function installationConditionNumber(matrix) {
  const inverseColumns = matrix.map((_, index) => solveLinear(matrix, matrix.map((_, column) => Number(column === index))));
  if (!inverseColumns.every(Boolean)) return null;
  const norm = Math.max(...matrix.map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  const inverseNorm = Math.max(...matrix.map((_, row) => inverseColumns.reduce((sum, column) => sum + Math.abs(column[row]), 0)));
  return Number.isFinite(norm * inverseNorm) ? norm * inverseNorm : null;
}

function linearizeInstallation(parameters, calculateResiduals) {
  const values = calculateResiduals(parameters);
  const derivatives = parameters.map((_, axis) => {
    const above = [...parameters], below = [...parameters];
    above[axis] += 0.0001;
    below[axis] -= 0.0001;
    const plus = calculateResiduals(above);
    const minus = calculateResiduals(below);
    return plus.map((value, index) => (value.pixels - minus[index].pixels) / 0.0002);
  });
  const matrix = parameters.map(() => parameters.map(() => 0));
  const gradient = parameters.map(() => 0);
  values.forEach((value, index) => {
    const weight = value.weight * Math.min(1, 4 / Math.max(1e-12, Math.abs(value.pixels)));
    parameters.forEach((_, row) => {
      gradient[row] += weight * derivatives[row][index] * value.pixels;
      parameters.forEach((_, column) => { matrix[row][column] += weight * derivatives[row][index] * derivatives[column][index]; });
    });
  });
  return { values, matrix, gradient };
}

const legacyLimits = [89, 89, 180, 180];

function installationFitModel(camera, geometry, samples, model = installationModel) {
  const zeroPose = model === ZERO_POSE_MODEL ? resolveZeroPose(camera) : null;
  const initial = zeroPose ? [zeroPose.roll, zeroPose.pitch] : [camera.pAxisPitch, camera.pAxisRoll, camera.tiltOffset, camera.imageRoll];
  // Roll 的周期为 360°，优化沿连续角度进行，在生成参数时归一化。
  const limits = zeroPose ? [Infinity, 90] : legacyLimits;
  const calibrationOf = zeroPose ? ([roll, pitch]) => ({ zeroPose: {
    ...zeroPose, pitch, roll: ((roll % 360 + 540) % 360) - 180,
  } }) : ([pAxisPitch, pAxisRoll, tiltOffset, imageRoll]) => ({ installation: { pAxisPitch, pAxisRoll, tiltOffset, imageRoll } });
  const rotation = zeroPose ? (parameters, ptz) => createZeroPoseRigRotation(calibrationOf(parameters).zeroPose, ptz).camera
    : (parameters, ptz) => legacyRotation(camera, parameters, ptz);
  return { initial, limits, calibrationOf, rotation,
    residuals: (parameters) => residuals(parameters, camera, geometry, samples, rotation) };
}

function optimizeInstallation(initial, calculateResiduals, limits) {
  let parameters = [...initial], damping = 0.001;
  let cost = loss(calculateResiduals(parameters));
  let converged = false, iterations = 0;
  for (; iterations < 100; iterations++) {
    const normal = linearizeInstallation(parameters, calculateResiduals);
    const matrix = normal.matrix.map((row, index) => row.map((value, column) => value
      + (index === column ? damping * Math.max(value, 1e-6) : 0)));
    const step = solveLinear(matrix, normal.gradient.map((value) => -value));
    if (!step) break;
    const scale = Math.min(1, 15 / Math.max(...step.map(Math.abs), 1e-12));
    const next = parameters.map((value, index) => value + step[index] * scale);
    if (next.some((value, index) => Math.abs(value) >= limits[index])) { damping *= 10; continue; }
    const nextCost = loss(calculateResiduals(next));
    if (nextCost <= cost) {
      const change = cost - nextCost;
      parameters = next;
      cost = nextCost;
      damping = Math.max(1e-12, damping / 3);
      if (Math.hypot(...step) * scale < 1e-7 || change < 1e-12 * (1 + cost)) { converged = true; break; }
    } else {
      damping *= 10;
      if (damping > 1e12) break;
    }
  }
  return { parameters, cost, converged, iterations: iterations + 1 };
}

function horizonMeasurements(rotation, geometry, sample) {
  const { width, height } = sample.snapshot;
  const tanH = width / (2 * sample.fx), tanV = height / (2 * sample.fy);
  const columns = rayColumns(rotation, geometry);
  const theoreticalY = (x) => {
    const horizontal = Cartesian3.add(columns[1], Cartesian3.multiplyByScalar(columns[0], (2 * x - 1) * tanH, new Cartesian3()), new Cartesian3());
    const angleAt = (y) => {
      const ray = Cartesian3.add(horizontal, Cartesian3.multiplyByScalar(columns[2], (1 - 2 * y) * tanV, new Cartesian3()), new Cartesian3());
      return Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(geometry.normal, Cartesian3.normalize(ray, ray))))) + geometry.dip;
    };
    let top = 0, bottom = 1, topAngle = angleAt(top);
    const bottomAngle = angleAt(bottom);
    if (topAngle * bottomAngle > 0) return null;
    if (topAngle === 0) return 0;
    if (bottomAngle === 0) return 1;
    for (let iteration = 0; iteration < 40; iteration++) {
      const middle = (top + bottom) / 2, angle = angleAt(middle);
      if (angle * topAngle > 0) { top = middle; topAngle = angle; } else bottom = middle;
    }
    return (top + bottom) / 2;
  };
  const points = [...sample.annotation].sort((a, b) => a.x - b.x);
  const left = points[0], right = points.at(-1);
  const verticalResiduals = ['left', 'center', 'right'].map((position, index) => {
    const x = index === 0 ? left.x : index === 2 ? right.x : (left.x + right.x) / 2;
    const end = points.findIndex((point) => point.x >= x);
    const a = points[Math.max(0, end - 1)], b = points[end];
    const observedY = a.x === b.x ? b.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    const y = theoreticalY(x);
    return { position, x, observedY, theoreticalY: y, offsetPixels: y === null ? null : (observedY - y) * height,
      unavailableReason: y === null ? '理论海天线未经过该图像竖线' : null };
  });
  const theoreticalHorizon = [];
  let segment = [];
  for (let column = 0; column <= 128; column++) {
    const x = column / 128, y = theoreticalY(x);
    if (y !== null) segment.push({ x, y });
    else if (segment.length) { theoreticalHorizon.push(segment); segment = []; }
  }
  if (segment.length) theoreticalHorizon.push(segment);
  const [start, , end] = verticalResiduals;
  const directionDifferenceDegrees = start.theoreticalY === null || end.theoreticalY === null ? null
    : Math.atan2((right.y - left.y) * height, (right.x - left.x) * width) / rad
      - Math.atan2((end.theoreticalY - start.theoreticalY) * height, (right.x - left.x) * width) / rad;
  // 偏差只比较正式标注范围内相同横坐标，原图向下为正；不把不可见位置补成零。
  return { theoreticalHorizon, verticalResiduals, directionDifferenceDegrees,
    verticalOffsetPixels: verticalResiduals[1].offsetPixels };
}

function zeroPoseGeometry(camera, pose) {
  if (!pose || ![pose.roll, pose.pitch, pose.yaw, pose.tiltOffset].every(Number.isFinite)
    || Math.abs(pose.roll) > 180 || Math.abs(pose.pitch) > 90 || pose.yaw < 0 || pose.yaw >= 360) {
    throw httpError(400, '请先为该摄像头保存有效的零位姿态');
  }
  return cameraGeometry({ ...camera, panOffset: pose.yaw, tiltOffset: pose.tiltOffset, imageRoll: 0 });
}

function summarizeResiduals(samples, residualValues) {
  const byId = new Map();
  for (const value of residualValues) {
    const values = byId.get(value.snapshotId) || [];
    values.push(value);
    byId.set(value.snapshotId, values);
  }
  return samples.map((sample) => {
    const values = byId.get(sample.snapshot.id);
    return { snapshotId: sample.snapshot.id, pan: sample.ptz.Pan, tilt: sample.ptz.Tilt, zoom: sample.ptz.Zoom,
      width: sample.snapshot.width, height: sample.snapshot.height,
      horizontalFieldAngle: sample.ptz.HorizontalFieldAngle, verticalFieldAngle: sample.ptz.VerticalFieldAngle,
      timeAlignment: sample.snapshot.timeAlignment || 'unverified',
      rmsResidualPixels: Math.sqrt(values.reduce((sum, value) => sum + value.pixels ** 2, 0) / values.length),
      rmsAngularResidualDegrees: Math.sqrt(values.reduce((sum, value) => sum + value.angle ** 2, 0) / values.length) / rad };
  });
}

export function evaluateInstallation(camera, snapshots, observations, requestedRange, model = installationModel) {
  const range = calibrationRange(requestedRange.startTime, requestedRange.endTime);
  if (model !== installationModel && model !== ZERO_POSE_MODEL) throw httpError(400, '不支持该海天线标定模型');
  const zeroPose = model === ZERO_POSE_MODEL;
  const geometry = zeroPose ? zeroPoseGeometry(camera, camera.zeroPose) : cameraGeometry(camera);
  const { samples, excluded } = prepareSamples(camera, snapshots, observations, range);
  const fit = installationFitModel(camera, geometry, samples, model);
  if (!zeroPose && !fit.initial.every((value, index) => Number.isFinite(value) && Math.abs(value) < fit.limits[index])) {
    throw httpError(400, '独立复核需要完整有效的固定安装参数');
  }
  const base = { model, generatedAt: new Date().toISOString(), ...range,
    ...(zeroPose ? { zeroPose: camera.zeroPose } : fit.calibrationOf(fit.initial)),
    sourceSnapshotIds: samples.map((sample) => sample.snapshot.id), excluded,
    ...panCoverage(samples.map((sample) => sample.ptz.Pan)), maximumAcceptedRmsPixels: maximumRmsPixels };
  if (!samples.length) return { ...base, status: 'insufficient_data', perSnapshot: [], failedSnapshotIds: [],
    rmsResidualPixels: null, rmsAngularResidualDegrees: null, maximumResidualPixels: null,
    message: '没有有效的停稳截图和海天线标注，无法独立复核' };
  // 复核只计算固定参数的残差，不调用优化器，也不按复核结果修改参数。
  const perSnapshot = summarizeResiduals(samples, fit.residuals(fit.initial)).map((row, index) => ({
    ...row, ...horizonMeasurements(fit.rotation(fit.initial, samples[index].ptz), geometry, samples[index]),
  }));
  const rms = (key) => Math.sqrt(perSnapshot.reduce((sum, item) => sum + item[key] ** 2, 0) / perSnapshot.length);
  const failedSnapshotIds = perSnapshot.filter((item) => !Number.isFinite(item.rmsResidualPixels)
    || item.rmsResidualPixels > maximumRmsPixels).map((item) => item.snapshotId);
  return { ...base, status: failedSnapshotIds.length ? 'failed' : 'passed', perSnapshot, failedSnapshotIds,
    rmsResidualPixels: rms('rmsResidualPixels'), rmsAngularResidualDegrees: rms('rmsAngularResidualDegrees'),
    maximumResidualPixels: Math.max(...perSnapshot.map((item) => item.rmsResidualPixels)),
    message: failedSnapshotIds.length ? `${failedSnapshotIds.length}/${samples.length} 张截图的残差超过 ${maximumRmsPixels} 像素，独立复核未通过`
      : `当前 ${samples.length} 张独立截图的逐图残差均不超过 ${maximumRmsPixels} 像素` };
}

export function estimateInstallation(camera, snapshots, observations, requestedRange) {
  const range = calibrationRange(requestedRange.startTime, requestedRange.endTime);
  const geometry = cameraGeometry(camera);
  const { samples, excluded } = prepareSamples(camera, snapshots, observations, range);
  const coverage = panCoverage(samples.map((sample) => sample.ptz.Pan));
  const base = {
    model: installationModel, generatedAt: new Date().toISOString(),
    cameraId: camera.id, cameraName: camera.name, ...range, applied: false,
    sourceSnapshotIds: samples.map((sample) => sample.snapshot.id), excluded, ...coverage,
    fixedCalibration: { longitude: camera.longitude, latitude: camera.latitude, height: camera.height,
      panOffset: camera.panOffset, cameraUpdatedAt: camera.updatedAt },
  };
  if (!samples.length) {
    return { ...base, status: 'insufficient_data', installation: null,
      message: '没有有效的停稳截图和海天线标注，无法进行拟合' };
  }
  const fit = installationFitModel(camera, geometry, samples);
  const starts = [[0, 0, 0, 0]];
  if (fit.initial.every((value, index) => Number.isFinite(value) && Math.abs(value) < fit.limits[index])) starts.push(fit.initial);
  const solution = starts.map((initial) => optimizeInstallation(initial, fit.residuals, fit.limits)).sort((a, b) => a.cost - b.cost)[0];
  const normal = linearizeInstallation(solution.parameters, fit.residuals);
  // 用未加阻尼的矩阵检查可辨识性；阻尼本身不能证明样本提供了足够约束。
  const conditionNumber = installationConditionNumber(normal.matrix);
  const perSnapshot = samples.map((sample) => {
    const values = normal.values.filter((value) => value.snapshotId === sample.snapshot.id);
    return { snapshotId: sample.snapshot.id, pan: sample.ptz.Pan, tilt: sample.ptz.Tilt, zoom: sample.ptz.Zoom,
      rmsResidualPixels: Math.sqrt(values.reduce((sum, value) => sum + value.pixels ** 2, 0) / values.length) };
  });
  const rmsResidualPixels = Math.sqrt(perSnapshot.reduce((sum, item) => sum + item.rmsResidualPixels ** 2, 0) / samples.length);
  const rmsAngularResidualDegrees = Math.sqrt(normal.values.reduce((sum, value) => sum + value.weight * value.angle ** 2, 0) / samples.length) / rad;
  const accepted = solution.converged && conditionNumber !== null && conditionNumber < 1e8
    && Number.isFinite(rmsResidualPixels) && rmsResidualPixels <= maximumRmsPixels;
  const [pAxisPitch, pAxisRoll, tiltOffset, imageRoll] = solution.parameters;
  const failures = [];
  if (conditionNumber === null || conditionNumber >= 1e8) failures.push('四参数不可可靠辨识');
  if (!Number.isFinite(rmsResidualPixels) || rmsResidualPixels > maximumRmsPixels) {
    failures.push(`均方根残差 ${rmsResidualPixels.toFixed(2)} 像素超过 ${maximumRmsPixels} 像素门槛`);
  }
  return { ...base, status: accepted ? 'estimated' : 'unreliable',
    installation: accepted ? { pAxisPitch, pAxisRoll, tiltOffset, imageRoll } : null,
    diagnostics: { converged: solution.converged, iterations: solution.iterations, conditionNumber,
      rmsResidualPixels, rmsAngularResidualDegrees, maximumAcceptedRmsPixels: maximumRmsPixels, perSnapshot },
    warnings: ['必须复核真实海天线；稳定的岸线误识别也可能得到较小残差',
      '经纬度、高度与默认朝向采用当前配置，海天线不能独立标定安装高度或绝对朝向',
      '截图与 PTZ 尚未确认严格同步；未建模潮汐、折射、畸变或稳像裁剪',
      '样本较少或采样方向集中时，结果对标注和固定参数误差更敏感'],
    message: accepted ? '已生成四项安装参数，请复核后点击应用'
      : [solution.converged ? '拟合已收敛' : '拟合未收敛', ...failures].join('；'),
  };
}

export function estimateZeroPose(camera, snapshots, observations, requestedRange) {
  const range = calibrationRange(requestedRange.startTime, requestedRange.endTime);
  const zeroPose = resolveZeroPose(camera);
  const geometry = zeroPoseGeometry(camera, zeroPose);
  const { samples, excluded } = prepareSamples(camera, snapshots, observations, range);
  const fit = installationFitModel({ ...camera, zeroPose }, geometry, samples, ZERO_POSE_MODEL);
  const base = {
    model: ZERO_POSE_MODEL, generatedAt: new Date().toISOString(), ...range,
    fixedCalibration: { longitude: camera.longitude, latitude: camera.latitude, height: camera.height,
      yaw: zeroPose.yaw, tiltOffset: zeroPose.tiltOffset, imageRoll: 0, cameraUpdatedAt: camera.updatedAt },
    sourceSnapshotIds: samples.map((sample) => sample.snapshot.id), excluded,
    ...panCoverage(samples.map((sample) => sample.ptz.Pan)),
  };
  if (!samples.length) return { ...base, status: 'insufficient_data', zeroPose: null,
    message: '没有有效的停稳截图和正式海天线标注，无法拟合零位 Roll 和 Pitch' };
  const starts = [fit.initial];
  if (fit.initial.some((value) => value !== 0)) starts.push([0, 0]);
  const solution = starts.map((initial) => optimizeInstallation(initial, fit.residuals, fit.limits)).sort((a, b) => a.cost - b.cost)[0];
  const normal = linearizeInstallation(solution.parameters, fit.residuals);
  const conditionNumber = installationConditionNumber(normal.matrix);
  const perSnapshot = summarizeResiduals(samples, normal.values);
  const rms = (key) => Math.sqrt(perSnapshot.reduce((sum, row) => sum + row[key] ** 2, 0) / perSnapshot.length);
  const rmsResidualPixels = rms('rmsResidualPixels');
  const failures = [];
  if (!solution.converged) failures.push('拟合未收敛');
  if (conditionNumber === null || conditionNumber >= 1e8) failures.push('零位 Roll 和 Pitch 不可可靠辨识');
  if (!Number.isFinite(rmsResidualPixels) || rmsResidualPixels > maximumRmsPixels) {
    failures.push(`均方根残差 ${rmsResidualPixels.toFixed(2)} 像素超过 ${maximumRmsPixels} 像素门槛`);
  }
  return { ...base, status: failures.length ? 'unreliable' : 'estimated',
    zeroPose: failures.length ? null : fit.calibrationOf(solution.parameters).zeroPose,
    diagnostics: { converged: solution.converged, iterations: solution.iterations, conditionNumber,
      rmsResidualPixels, rmsAngularResidualDegrees: rms('rmsAngularResidualDegrees'),
      maximumAcceptedRmsPixels: maximumRmsPixels, perSnapshot },
    message: failures.join('，') || '已生成零位姿态候选，请对照原图核查',
  };
}

export function refineInstallation(camera, snapshots, observations, requestedRange, baseSnapshotIds) {
  const range = calibrationRange(requestedRange.startTime, requestedRange.endTime);
  const geometry = cameraGeometry(camera);
  const { samples, excluded } = prepareSamples(camera, snapshots, observations, range);
  const baseIds = new Set(baseSnapshotIds);
  const baseSamples = samples.filter((sample) => baseIds.has(sample.snapshot.id));
  const highSamples = samples.filter((sample) => !baseIds.has(sample.snapshot.id));
  const fit = installationFitModel(camera, geometry, samples);
  const initial = fit.initial;
  const installationOf = (parameters) => Object.fromEntries(['pAxisPitch', 'pAxisRoll', 'tiltOffset', 'imageRoll']
    .map((key, index) => [key, parameters[index]]));
  // 两组先按实际有效图片平均，任务拆分和图数不改变基础组与高倍组的总权重。
  for (const sample of samples) sample.weight = 1 / (2 * (baseIds.has(sample.snapshot.id) ? baseSamples.length : highSamples.length));
  const summarize = (rows) => ({ sampleCount: rows.length,
    zoomRange: rows.length ? { min: Math.min(...rows.map((row) => row.zoom)), max: Math.max(...rows.map((row) => row.zoom)) } : null,
    ...panCoverage(rows.map((row) => row.pan)),
    rmsResidualPixels: rows.length ? Math.sqrt(rows.reduce((sum, row) => sum + row.rmsResidualPixels ** 2, 0) / rows.length) : null,
    rmsAngularResidualDegrees: rows.length ? Math.sqrt(rows.reduce((sum, row) => sum + row.rmsAngularResidualDegrees ** 2, 0) / rows.length) : null,
  });
  const compare = (parameters) => {
    const evaluated = evaluateInstallation({ ...camera, ...installationOf(parameters) }, samples.map((sample) => sample.snapshot),
      samples.map((sample) => ({ snapshotId: sample.snapshot.id, points: sample.annotation })), range);
    const perSnapshot = evaluated.perSnapshot.map((row) => ({ ...row, group: baseIds.has(row.snapshotId) ? 'base' : 'high' }));
    const base = summarize(perSnapshot.filter((row) => row.group === 'base'));
    const high = summarize(perSnapshot.filter((row) => row.group === 'high'));
    const overall = summarize(perSnapshot);
    if (base.sampleCount && high.sampleCount) {
      for (const key of ['rmsResidualPixels', 'rmsAngularResidualDegrees']) overall[key] = Math.hypot(base[key], high[key]) / Math.sqrt(2);
    }
    return { installation: installationOf(parameters), overall, base, high, perSnapshot,
      objective: loss(residuals(parameters, camera, geometry, samples)) };
  };
  const before = compare(initial);
  const common = { model: 'wgs84-horizon-refinement-v1', generatedAt: new Date().toISOString(), ...range,
    sourceSnapshotIds: samples.map((sample) => sample.snapshot.id), excluded, before,
    maximumAcceptedRmsPixels: maximumRmsPixels, applied: false };
  if (!baseSamples.length || !highSamples.length) return { ...common, status: 'insufficient_data', installation: null, after: before,
    diagnostics: { converged: false, conditionNumber: null, failures: [!baseSamples.length ? '基础组没有有效观测' : '高倍组没有有效观测'] },
    message: '基础组与高倍组都需要有效的停稳截图和正式标注' };
  if (Math.max(...highSamples.map((sample) => sample.ptz.Zoom)) <= Math.max(...baseSamples.map((sample) => sample.ptz.Zoom))) {
    return { ...common, status: 'insufficient_data', installation: null, after: before,
      diagnostics: { converged: false, conditionNumber: null, failures: ['高倍组没有倍率高于基础组最大参与倍率的有效截图'] },
      message: '高倍组至少需要一张有效截图的倍率高于基础组最大参与倍率' };
  }
  // 精修只从冻结的基础结果开始；当前相机的四项修正不参与初值选择。
  const solution = optimizeInstallation(initial, fit.residuals, fit.limits);
  const normal = linearizeInstallation(solution.parameters, fit.residuals);
  const conditionNumber = installationConditionNumber(normal.matrix);
  const attempted = compare(solution.parameters);
  const withinRms = (comparison) => ['overall', 'base', 'high'].every((key) => Number.isFinite(comparison[key].rmsResidualPixels)
    && comparison[key].rmsResidualPixels <= maximumRmsPixels);
  const improved = before.objective - attempted.objective > 1e-12 * (1 + before.objective)
    && Math.hypot(...solution.parameters.map((value, index) => value - initial[index])) >= 1e-7;
  const failures = [];
  if (!solution.converged) failures.push('拟合未收敛');
  if (conditionNumber === null || conditionNumber >= 1e8) failures.push('四参数不可可靠辨识');
  for (const [key, label] of [['overall', '总体'], ['base', '基础组'], ['high', '高倍组']]) {
    if (!Number.isFinite(attempted[key].rmsResidualPixels) || attempted[key].rmsResidualPixels > maximumRmsPixels) {
      failures.push(`${label} RMS ${attempted[key].rmsResidualPixels?.toFixed(2)} 像素超过 ${maximumRmsPixels} 像素门槛`);
    }
  }
  const noChange = !improved && !failures.length && withinRms(before);
  if (!improved && !noChange) failures.push('联合稳健目标在现有终止精度内没有改善');
  const accepted = improved && !failures.length;
  return { ...common, status: noChange ? 'no_change' : accepted ? 'estimated' : 'unreliable',
    installation: noChange ? installationOf(initial) : accepted ? installationOf(solution.parameters) : null,
    after: noChange ? before : attempted,
    diagnostics: { converged: solution.converged, conditionNumber, failures },
    message: noChange ? '基准已满足质量要求，无需修正' : accepted ? '已生成联合精修候选，请比较基准与候选误差'
      : failures.join('；'),
  };
}
