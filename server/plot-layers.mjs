import { httpError } from './errors.mjs';

const managementProperties = {
  name: { type: 'string' },
  cameraIds: { type: 'array', items: { type: 'string', minLength: 1 } },
};
const updateSchema = { type: 'object', additionalProperties: false, required: ['name', 'cameraIds'], properties: managementProperties };
const importSchema = { type: 'object', additionalProperties: false,
  required: ['name', 'sourceFileName', 'geojsonText', 'cameraIds'], properties: {
    ...managementProperties,
    sourceFileName: { type: 'string', minLength: 1, maxLength: 255 },
    geojsonText: { type: 'string' },
  } };
const geometryNames = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxGeojsonBytes = 10 * 1024 * 1024;
// JSON 字符串封装可能将原文字符展开为转义序列，原文容量仍单独按 UTF-8 校验。
const importBodyLimit = maxGeojsonBytes * 6 + 65536;
const wgs84Names = new Set(['WGS84', 'WGS 84', 'EPSG:4326', 'CRS84', 'OGC:CRS84',
  'HTTP://WWW.OPENGIS.NET/DEF/CRS/EPSG/0/4326', 'HTTP://WWW.OPENGIS.NET/DEF/CRS/OGC/1.3/CRS84',
  'HTTP://WWW.OPENGIS.NET/GML/SRS/EPSG.XML#4326']);

function validateCrs(value) {
  if (!Object.hasOwn(value, 'crs')) return;
  const crs = value.crs;
  const name = isObject(crs) && crs.type === 'name' && isObject(crs.properties) && crs.properties.name;
  if (typeof name === 'string') {
    const normalized = name.trim().toUpperCase().replace(/^HTTPS:/, 'HTTP:');
    if (wgs84Names.has(normalized) || /^URN:OGC:DEF:CRS:(?:EPSG:[^:]*:4326|OGC:[^:]*:CRS84)$/.test(normalized)) return;
  }
  throw httpError(400, 'GeoJSON 仅支持未声明 CRS 或明确声明 WGS84/CRS84 的数据');
}

function managementName(value) {
  const name = value.trim();
  if (!name || [...name].length > 200) throw httpError(400, '标绘名称去除首尾空白后应为 1～200 个字符');
  return name;
}

function validateCoordinates(value, countPosition) {
  let dimension;
  const array = (coordinates) => {
    if (!Array.isArray(coordinates)) throw httpError(400, 'GeoJSON 坐标数组层级无效');
    return coordinates;
  };
  const position = (coordinates) => {
    array(coordinates);
    if (![2, 3].includes(coordinates.length) || !coordinates.every(Number.isFinite)
      || coordinates[0] < -180 || coordinates[0] > 180 || coordinates[1] < -90 || coordinates[1] > 90) {
      throw httpError(400, 'GeoJSON 位置须为有限的二维或三维 WGS84 经纬度坐标');
    }
    if (dimension !== undefined && dimension !== coordinates.length) throw httpError(400, '单个几何内的坐标维度必须一致');
    dimension = coordinates.length;
    countPosition();
  };
  const line = (coordinates, ring = false) => {
    array(coordinates);
    if (!coordinates.length) return;
    if (coordinates.length < (ring ? 4 : 2)) throw httpError(400, ring ? '非空面环至少需要四个位置' : '非空线至少需要两个位置');
    coordinates.forEach(position);
    if (ring && !coordinates[0].every((number, index) => number === coordinates.at(-1)[index])) {
      throw httpError(400, 'GeoJSON 面环首尾必须闭合');
    }
  };
  const polygon = (coordinates) => {
    array(coordinates).forEach((ring) => line(ring, true));
    if (coordinates.length && !coordinates[0].length && coordinates.some((ring) => ring.length)) {
      throw httpError(400, 'GeoJSON 面存在非空内环时必须提供非空外环');
    }
  };
  const coordinates = array(value.coordinates);
  switch (value.type) {
    case 'Point': if (coordinates.length) position(coordinates); break;
    case 'MultiPoint': coordinates.forEach(position); break;
    case 'LineString': line(coordinates); break;
    case 'MultiLineString': coordinates.forEach((part) => line(part)); break;
    case 'Polygon': polygon(coordinates); break;
    case 'MultiPolygon': coordinates.forEach(polygon); break;
  }
}

function geojsonMetadata(text) {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxGeojsonBytes) throw httpError(413, 'GeoJSON 原文不能超过 10 MiB');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw httpError(400, 'GeoJSON 不是有效的 JSON 文本'); }
  if (!isObject(data)) throw httpError(400, 'GeoJSON 顶层必须为对象');
  validateCrs(data);
  const geometryTypes = new Set();
  let positions = 0;
  const countPosition = () => {
    if (++positions > 500000) throw httpError(400, 'GeoJSON 最多包含 500,000 个位置');
  };
  const geometry = (value, collectionDepth = 0) => {
    if (!isObject(value) || !geometryNames.has(value.type)) throw httpError(400, 'GeoJSON 包含无效的几何类型或结构');
    validateCrs(value);
    geometryTypes.add(value.type);
    if (value.type === 'GeometryCollection') {
      const depth = collectionDepth + 1;
      if (depth > 32) throw httpError(400, 'GeoJSON 几何集合最多嵌套 32 层');
      if (!Array.isArray(value.geometries)) throw httpError(400, '几何集合的 geometries 必须为数组');
      value.geometries.forEach((part) => geometry(part, depth));
    } else validateCoordinates(value, countPosition);
  };
  const feature = (value) => {
    if (!isObject(value) || value.type !== 'Feature' || !(value.properties === null || isObject(value.properties))
      || !Object.hasOwn(value, 'geometry')) throw httpError(400, 'GeoJSON Feature 的 properties 或 geometry 结构无效');
    validateCrs(value);
    if (value.geometry !== null) geometry(value.geometry);
  };
  if (data.type === 'FeatureCollection') {
    if (!Array.isArray(data.features)) throw httpError(400, '要素集合的 features 必须为数组');
    if (data.features.length > 50000) throw httpError(400, 'GeoJSON 最多包含 50,000 个 Feature');
    data.features.forEach(feature);
  } else if (data.type === 'Feature') feature(data);
  else geometry(data);
  return { byteLength,
    featureCount: data.type === 'FeatureCollection' ? data.features.length : 1,
    geometryTypes: [...geometryTypes] };
}

export function registerPlotLayerRoutes(app, store) {
  app.get('/api/plot-layers', async () => store.listPlotLayers());
  app.get('/api/plot-layers/:id', async (request) => store.getPlotLayer(request.params.id));
  app.post('/api/plot-layers', { bodyLimit: importBodyLimit, schema: { body: importSchema } }, async (request, reply) => {
    if (!/\.(?:geojson|json)$/i.test(request.body.sourceFileName)) throw httpError(400, '请选择 .geojson 或 .json 文件');
    const input = { ...request.body, name: managementName(request.body.name), ...geojsonMetadata(request.body.geojsonText) };
    return reply.code(201).send(store.importPlotLayer(input));
  });
  app.put('/api/plot-layers/:id/cameras/:cameraId', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['visible'], properties: { visible: { type: 'boolean' } },
  } } }, async (request) =>
    store.setPlotLayerVisibility(request.params.id, request.params.cameraId, request.body.visible));
  app.put('/api/plot-layers/:id', { schema: { body: updateSchema } }, async (request) =>
    store.savePlotLayer(request.params.id, { ...request.body, name: managementName(request.body.name) }));
  app.delete('/api/plot-layers/:id', async (request, reply) => {
    store.deletePlotLayer(request.params.id);
    return reply.code(204).send();
  });
}
