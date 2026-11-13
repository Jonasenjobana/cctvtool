import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';

const cameraInput = {
  name: '标绘摄像头', serial: 'plot-device', code: 'plot-channel',
  longitude: 113.9, latitude: 22.1, height: 12,
  pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0,
};
const pointText = '{"type":"Point","coordinates":[113.9,22.1]}';
const importInput = (geojsonText = pointText, cameraIds = []) => ({
  name: '海域标绘', sourceFileName: 'sea.geojson', geojsonText, cameraIds,
});

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-plot-http-'));
  const options = { dataDir, webDir: join(dataDir, 'missing-web'), livegbs: { configured: false } };
  const f = { options, app: await createApp(options) };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-plot-http-')) {
      throw new Error('测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  f.camera = async (code) => {
    const response = await f.app.inject({ method: 'POST', url: '/api/cameras', payload: { ...cameraInput, code } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  f.import = async (input = importInput()) => f.app.inject({ method: 'POST', url: '/api/plot-layers', payload: input });
  return f;
}

test('标绘原文、独立名称和摄像头关联在重启后原样恢复，列表只返回摘要', async (t) => {
  const f = await fixture(t);
  const camera = await f.camera('first');
  const geojsonText = '\uFEFF{\n  "type": "Feature", "properties": {"name":"原始名", "marker-color":"#ff0000", "扩展": {"值":1}},\n  "geometry": {"type":"Point","coordinates":[113.9,22.1,8.5]}, "custom":true\n}\n';
  const response = await f.import({ ...importInput(geojsonText, [camera.id, camera.id]), name: '  管理名称  ' });
  assert.equal(response.statusCode, 201, response.body);
  const layer = response.json();
  assert.equal(layer.name, '管理名称');
  assert.equal(layer.geojsonText, geojsonText);
  assert.equal(layer.sourceFileName, 'sea.geojson');
  assert.equal(layer.byteLength, Buffer.byteLength(geojsonText, 'utf8'));
  assert.equal(layer.featureCount, 1);
  assert.deepEqual(layer.geometryTypes, ['Point']);
  assert.deepEqual(layer.associations, [{ cameraId: camera.id, visible: true }]);
  assert.ok(layer.id && layer.createdAt && layer.updatedAt);
  await f.app.close();
  f.app = await createApp(f.options);
  const detail = await f.app.inject(`/api/plot-layers/${layer.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json(), layer);
  const list = await f.app.inject('/api/plot-layers');
  assert.equal(list.statusCode, 200, list.body);
  const { geojsonText: omitted, ...summary } = layer;
  assert.deepEqual(list.json(), [summary]);
});

test('同一标绘在不同摄像头下独立保存显隐，重启后仍保持隔离', async (t) => {
  const f = await fixture(t);
  const first = await f.camera('first');
  const second = await f.camera('second');
  const imported = await f.import(importInput(pointText, [first.id, second.id]));
  assert.equal(imported.statusCode, 201, imported.body);
  const layer = imported.json();
  const response = await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}/cameras/${first.id}`, payload: { visible: false } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { cameraId: first.id, visible: false });
  await f.app.close();
  f.app = await createApp(f.options);
  const detail = (await f.app.inject(`/api/plot-layers/${layer.id}`)).json();
  assert.deepEqual(detail.associations.find((item) => item.cameraId === first.id), { cameraId: first.id, visible: false });
  assert.deepEqual(detail.associations.find((item) => item.cameraId === second.id), { cameraId: second.id, visible: true });
  assert.equal(detail.geojsonText, pointText);
});

test('关联编辑保留交集显隐、新增默认显示，解除全部关联仍保留原文和共享名称', async (t) => {
  const f = await fixture(t);
  const first = await f.camera('first');
  const second = await f.camera('second');
  const third = await f.camera('third');
  const layer = (await f.import(importInput(pointText, [first.id, second.id]))).json();
  await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}/cameras/${first.id}`, payload: { visible: false } });
  const edited = await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}`,
    payload: { name: '  共享新名称  ', cameraIds: [first.id, third.id, third.id] } });
  assert.equal(edited.statusCode, 200, edited.body);
  const summary = edited.json();
  assert.equal(summary.name, '共享新名称');
  assert.equal('geojsonText' in summary, false);
  assert.equal(summary.associations.length, 2);
  assert.deepEqual(summary.associations.find((item) => item.cameraId === first.id), { cameraId: first.id, visible: false });
  assert.deepEqual(summary.associations.find((item) => item.cameraId === third.id), { cameraId: third.id, visible: true });
  const detached = await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}`,
    payload: { name: '未关联标绘', cameraIds: [] } });
  assert.equal(detached.statusCode, 200, detached.body);
  assert.deepEqual(detached.json().associations, []);
  const detail = (await f.app.inject(`/api/plot-layers/${layer.id}`)).json();
  assert.equal(detail.name, '未关联标绘');
  assert.equal(detail.geojsonText, pointText);
});

test('重复导入形成独立图层，整份删除只移除目标图层及其全部摄像头关联', async (t) => {
  const f = await fixture(t);
  const first = await f.camera('first');
  const second = await f.camera('second');
  const payload = importInput(pointText, [first.id, second.id]);
  const layer = (await f.import(payload)).json();
  const duplicate = (await f.import(payload)).json();
  assert.notEqual(layer.id, duplicate.id);
  const removed = await f.app.inject({ method: 'DELETE', url: `/api/plot-layers/${layer.id}` });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(removed.body, '');
  assert.equal((await f.app.inject(`/api/plot-layers/${layer.id}`)).statusCode, 404);
  assert.deepEqual((await f.app.inject(`/api/plot-layers/${duplicate.id}`)).json(), duplicate);
  const remaining = (await f.app.inject('/api/plot-layers')).json();
  assert.deepEqual(remaining.map((item) => item.id), [duplicate.id]);
  assert.deepEqual((await f.app.inject('/api/cameras')).json(), [first, second]);
});

test('管理输入格式、名称和来源扩展名无效时返回中文 400 且不改写记录', async (t) => {
  const f = await fixture(t);
  const camera = await f.camera('first');
  for (const input of [
    {}, { ...importInput(), name: '   ' }, { ...importInput(), name: '名'.repeat(201) },
    { ...importInput(), sourceFileName: '' }, { ...importInput(), sourceFileName: 'x'.repeat(251) + '.json' },
    { ...importInput(), sourceFileName: 'sea.kml' }, { ...importInput(), cameraIds: 'first' },
    { ...importInput(), cameraIds: [''] }, { ...importInput(), geojsonText: {} },
    { ...importInput(), extra: true },
  ]) {
    const response = await f.import(input);
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().message, /[\u4e00-\u9fff]/);
  }
  assert.deepEqual((await f.app.inject('/api/plot-layers')).json(), []);
  const imported = await f.import({ ...importInput(pointText, [camera.id]), name: `  ${'名'.repeat(200)}  `, sourceFileName: 'SEA.JSON' });
  assert.equal(imported.statusCode, 201, imported.body);
  const layer = imported.json();
  for (const payload of [{ name: ' ', cameraIds: [] }, { name: '有效', cameraIds: [], geojsonText: pointText }]) {
    const response = await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}`, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  for (const payload of [{ visible: 'false' }, {}, { visible: true, extra: true }]) {
    const response = await f.app.inject({ method: 'PUT', url: `/api/plot-layers/${layer.id}/cameras/${camera.id}`, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual((await f.app.inject(`/api/plot-layers/${layer.id}`)).json(), layer);
});

test('非法 JSON 和 GeoJSON 结构整份拒绝，错误响应不回传原文', async (t) => {
  const f = await fixture(t);
  const invalid = [
    'private-source-not-json', 'null', '[]', '12', '{}',
    '{"type":"Circle","coordinates":[]}',
    '{"type":"Feature","properties":null}',
    '{"type":"Feature","geometry":null}',
    '{"type":"Feature","properties":[],"geometry":null}',
    '{"type":"FeatureCollection","features":{}}',
    '{"type":"FeatureCollection","features":[{"type":"Point","coordinates":[0,0]}]}',
    '{"type":"GeometryCollection","geometries":[null]}',
    '{"type":"GeometryCollection","geometries":[{"type":"Feature","properties":null,"geometry":null}]}',
  ];
  for (const geojsonText of invalid) {
    const response = await f.import(importInput(geojsonText));
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().message, /[\u4e00-\u9fff]/);
    assert.equal(response.body.includes(geojsonText), false);
  }
  assert.deepEqual((await f.app.inject('/api/plot-layers')).json(), []);
});

test('坐标层级、有限经纬度、单几何维度及线面约束无效时整份拒绝', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { type: 'Point' }, { type: 'Point', coordinates: null },
    { type: 'Point', coordinates: [181, 0] }, { type: 'Point', coordinates: [0, -91] },
    { type: 'Point', coordinates: ['1', 0] }, { type: 'Point', coordinates: [0] },
    { type: 'Point', coordinates: [0, 0, 0, 0] },
    { type: 'MultiPoint', coordinates: [[], [0, 0]] },
    { type: 'MultiPoint', coordinates: [[0, 0], [1, 1, 2]] },
    { type: 'LineString', coordinates: [[0, 0]] },
    { type: 'LineString', coordinates: [0, 0] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[0, 0, 2], [1, 1, 2]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 2]]] },
    { type: 'Polygon', coordinates: [[], [[0, 0], [1, 0], [1, 1], [0, 0]]] },
    { type: 'MultiPolygon', coordinates: [[[], [[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]]] },
  ];
  for (const geometry of invalid) {
    const response = await f.import(importInput(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: {}, geometry },
    ] })));
    assert.equal(response.statusCode, 400, response.body);
  }
  const overflow = await f.import(importInput('{"type":"Point","coordinates":[0,0,1e309]}'));
  assert.equal(overflow.statusCode, 400, overflow.body);
  assert.deepEqual((await f.app.inject('/api/plot-layers')).json(), []);
  const geometries = [
    { type: 'Point', coordinates: [-180, 90, -50] },
    { type: 'MultiPoint', coordinates: [[0, 0], [180, -90]] },
    { type: 'LineString', coordinates: [[0, 0, 3], [1, 1, 4]] },
    { type: 'MultiLineString', coordinates: [[], [[0, 0], [1, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], []] },
    { type: 'MultiPolygon', coordinates: [[], [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]]] },
    { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [] }, { type: 'LineString', coordinates: [] }] },
  ];
  const accepted = await f.import(importInput(JSON.stringify({ type: 'GeometryCollection', geometries })));
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().featureCount, 1);
  assert.deepEqual(new Set(accepted.json().geometryTypes), new Set(['GeometryCollection', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']));
});

test('仅接受未声明或明确声明 WGS84、CRS84 的数据，嵌套非 WGS84 声明也拒绝', async (t) => {
  const f = await fixture(t);
  const named = (name) => ({ type: 'name', properties: { name } });
  for (const crs of [named('EPSG:3857'), named('GCJ-02'), {}, null, { type: 'link', properties: { href: 'https://example.invalid/crs' } }]) {
    const response = await f.import(importInput(JSON.stringify({ type: 'Point', coordinates: [0, 0], crs })));
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().message, /WGS84|CRS84/);
  }
  const nested = await f.import(importInput(JSON.stringify({ type: 'Feature', properties: null,
    geometry: { type: 'Point', coordinates: [0, 0], crs: named('EPSG:3857') }, crs: named('EPSG:4326') })));
  assert.equal(nested.statusCode, 400, nested.body);
  assert.deepEqual((await f.app.inject('/api/plot-layers')).json(), []);
  for (const name of ['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'CRS84', 'WGS84',
    'https://www.opengis.net/def/crs/EPSG/0/4326', 'http://www.opengis.net/def/crs/OGC/1.3/CRS84']) {
    const response = await f.import(importInput(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: null, geometry: null },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [] } },
    ], crs: named(name) })));
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().featureCount, 2);
  }
  const empty = await f.import(importInput('{"type":"FeatureCollection","features":[]}'));
  assert.equal(empty.statusCode, 201, empty.body);
  assert.equal(empty.json().featureCount, 0);
  assert.deepEqual(empty.json().geometryTypes, []);
});

test('导入容纳 10 MiB 原文的转义请求体，按 UTF-8 原文字节限制且其他接口保持 64 KiB', async (t) => {
  const f = await fixture(t);
  const limit = 10 * 1024 * 1024;
  const geojsonText = pointText + '\n'.repeat(limit - Buffer.byteLength(pointText, 'utf8'));
  const accepted = await f.import(importInput(geojsonText));
  assert.equal(accepted.statusCode, 201, accepted.json().message);
  assert.equal(accepted.json().byteLength, 10485760);
  const overflow = await f.import(importInput(geojsonText + '\n'));
  assert.equal(overflow.statusCode, 413, overflow.json().message);
  assert.match(overflow.json().message, /10 MiB/);
  const multibyte = await f.import(importInput(JSON.stringify({ type: 'Point', coordinates: [0, 0], padding: '海'.repeat(Math.ceil(limit / 3)) })));
  assert.equal(multibyte.statusCode, 413, multibyte.json().message);
  assert.equal((await f.app.inject('/api/plot-layers')).json().length, 1);
  for (const request of [
    { method: 'POST', url: '/api/cameras', payload: { ...cameraInput, name: 'x'.repeat(65537) } },
    { method: 'PUT', url: `/api/plot-layers/${accepted.json().id}`, payload: { name: 'x'.repeat(65537), cameraIds: [] } },
  ]) {
    const response = await f.app.inject(request);
    assert.equal(response.statusCode, 413, response.body);
    assert.deepEqual(Object.keys(response.json()), ['message']);
  }
});

test('Feature 上限允许 50000 个，超过时整份拒绝而不产生新图层', async (t) => {
  const f = await fixture(t);
  const feature = '{"type":"Feature","properties":null,"geometry":null}';
  const collection = (count) => `{"type":"FeatureCollection","features":[${Array(count).fill(feature).join(',')}]}`;
  const accepted = await f.import(importInput(collection(50000)));
  assert.equal(accepted.statusCode, 201, accepted.json().message);
  assert.equal(accepted.json().featureCount, 50000);
  const rejected = await f.import(importInput(collection(50001)));
  assert.equal(rejected.statusCode, 400, rejected.json().message);
  assert.match(rejected.json().message, /50,?000|50000/);
  assert.equal((await f.app.inject('/api/plot-layers')).json().length, 1);
});

test('位置总数按整份图层累计，允许 500000 个并拒绝跨几何超限', async (t) => {
  const f = await fixture(t);
  const points = (count) => `{"type":"MultiPoint","coordinates":[${Array(count).fill('[0,0]').join(',')}]}`;
  const collection = (lastCount) => `{"type":"GeometryCollection","geometries":[${points(250000)},${points(lastCount)}]}`;
  const accepted = await f.import(importInput(collection(250000)));
  assert.equal(accepted.statusCode, 201, accepted.json().message);
  const rejected = await f.import(importInput(collection(250001)));
  assert.equal(rejected.statusCode, 400, rejected.json().message);
  assert.match(rejected.json().message, /500,?000|500000/);
  assert.equal((await f.app.inject('/api/plot-layers')).json().length, 1);
});

test('几何集合可嵌套 32 层，超过边界时明确拒绝', async (t) => {
  const f = await fixture(t);
  const nested = (depth) => {
    let value = { type: 'Point', coordinates: [0, 0] };
    for (let index = 0; index < depth; index++) value = { type: 'GeometryCollection', geometries: [value] };
    return JSON.stringify(value);
  };
  const accepted = await f.import(importInput(nested(32)));
  assert.equal(accepted.statusCode, 201, accepted.body);
  const rejected = await f.import(importInput(nested(33)));
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().message, /32/);
  assert.equal((await f.app.inject('/api/plot-layers')).json().length, 1);
});

test('未知图层、摄像头及未建立的关联返回 404，失败的关联编辑保持整份记录', async (t) => {
  const f = await fixture(t);
  const first = await f.camera('first');
  const second = await f.camera('second');
  const rejectedImport = await f.import(importInput(pointText, [first.id, 'missing-camera']));
  assert.equal(rejectedImport.statusCode, 404, rejectedImport.body);
  assert.deepEqual((await f.app.inject('/api/plot-layers')).json(), []);
  const layer = (await f.import(importInput(pointText, [first.id]))).json();
  const requests = [
    { method: 'GET', url: '/api/plot-layers/missing-layer' },
    { method: 'DELETE', url: '/api/plot-layers/missing-layer' },
    { method: 'PUT', url: '/api/plot-layers/missing-layer', payload: { name: '不存在', cameraIds: [] } },
    { method: 'PUT', url: `/api/plot-layers/${layer.id}`, payload: { name: '不得保存', cameraIds: [second.id, 'missing-camera'] } },
    { method: 'PUT', url: `/api/plot-layers/${layer.id}/cameras/${second.id}`, payload: { visible: false } },
    { method: 'PUT', url: `/api/plot-layers/${layer.id}/cameras/missing-camera`, payload: { visible: false } },
    { method: 'PUT', url: `/api/plot-layers/missing-layer/cameras/${first.id}`, payload: { visible: false } },
  ];
  for (const request of requests) {
    const response = await f.app.inject(request);
    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual(Object.keys(response.json()), ['message']);
  }
  assert.deepEqual((await f.app.inject(`/api/plot-layers/${layer.id}`)).json(), layer);
});
