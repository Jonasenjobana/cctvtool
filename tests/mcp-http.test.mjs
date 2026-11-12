import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CameraStore } from '../server/store.mjs';
import { createMcpHttpApp } from '../server/mcp-http-app.mjs';
import { fixtureCamera, fixtureRange, syntheticSnapshots } from './calibration-fixtures.mjs';

const apiKey = 'mcp-http-test-access-key-not-a-real-secret';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-mcp-http-test-'));
  const store = new CameraStore(dataDir);
  const camera = store.saveCamera({ ...fixtureCamera, tiltOffset: 1.64, imageRoll: 0.73 });
  const data = syntheticSnapshots({ camera });
  for (const snapshot of data.snapshots) store.addSnapshot({ ...snapshot,
    fileName: `${snapshot.id}.png`, imageUrl: `/api/snapshots/${snapshot.id}/image`,
  });
  store.addSnapshot({ ...data.snapshots[0], id: 'remote-image', width: 1, height: 1,
    fileName: 'remote-image.png', contentType: 'image/png', bytes: png.length,
    createdAt: '2026-11-09T00:30:00.000Z', imageUrl: '/api/snapshots/remote-image/image',
  });
  await writeFile(join(dataDir, 'snapshots', 'remote-image.png'), png);
  const before = store.getCamera(camera.id);
  store.close();
  const app = await createMcpHttpApp({ dataDir, apiKey, allowedHosts: ['127.0.0.1', 'localhost'], allowedOrigins: ['http://viewer.example:8080'] });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-mcp-http-test-')) throw new Error('HTTP MCP 测试清理路径超出临时目录');
    await rm(target, { recursive: true, force: true });
  });
  const connect = async () => {
    const client = new Client({ name: 'lan-mcp-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }));
    return client;
  };
  return { app, address, connect, dataDir, camera, data, before };
}

test('HTTP MCP 可供多个客户端查询、读原图、拟合，结果与 stdio 共用模型且不改数据库', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.connect(), f.connect()]);
  const tools = await first.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['estimate_p_axis_tilt', 'get_snapshot', 'list_cameras', 'query_snapshots']);
  assert.ok(tools.tools.every(tool => tool.annotations.readOnlyHint));
  const cameras = await first.callTool({ name: 'list_cameras', arguments: {} });
  assert.equal(cameras.structuredContent.cameras[0].snapshotCount, 7);
  const selection = { cameraId: f.camera.id, ...fixtureRange };
  const [page, narrow] = await Promise.all([
    first.callTool({ name: 'query_snapshots', arguments: { ...selection, limit: 2 } }),
    second.callTool({ name: 'query_snapshots', arguments: { cameraId: f.camera.id, startTime: '2026-11-09T08:00:00+08:00', endTime: '2026-11-09T08:01:00+08:00' } }),
  ]);
  assert.equal(page.structuredContent.total, 7);
  assert.equal(page.structuredContent.nextOffset, 2);
  assert.equal(narrow.structuredContent.total, 1);
  const picture = await second.callTool({ name: 'get_snapshot', arguments: { snapshotId: 'remote-image' } });
  assert.equal(picture.content.find(block => block.type === 'image').data, png.toString('base64'));
  assert.equal(picture.structuredContent.width, 1);
  const fit = await first.callTool({ name: 'estimate_p_axis_tilt', arguments: { ...selection, observations: f.data.observations } });
  assert.equal(fit.structuredContent.status, 'estimated', JSON.stringify(fit));
  assert.equal(fit.structuredContent.model, 'wgs84-horizon-p-axis-v3');
  assert.ok(Math.abs(fit.structuredContent.installation.pAxisPitch - 1.25) < 0.00001);
  assert.ok(Math.abs(fit.structuredContent.installation.pAxisRoll + 2.1) < 0.00001);
  assert.equal(fit.structuredContent.applied, false);
  const after = new CameraStore(f.dataDir, { readOnly: true });
  try { assert.deepEqual(after.getCamera(f.camera.id), f.before); } finally { after.close(); }
  assert.equal((await fetch(`${f.address}/api/cameras/${f.camera.id}/control`, { method: 'POST' })).status, 404);
});

test('HTTP MCP 拒绝缺少密钥、错误 Host/Origin，支持显式 CORS 来源和旧版 Streamable HTTP 请求', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const health = await fetch(`${f.address}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).readOnly, true);
  for (const authorization of ['', 'Bearer wrong-key']) {
    const response = await fetch(`${f.address}/mcp`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Bearer/);
    assert.ok(!(await response.text()).includes(apiKey));
  }
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const badHost = await f.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, host: 'untrusted.example' }, payload: {} });
  assert.equal(badHost.statusCode, 403);
  for (const origin of ['null', 'http://viewer.example:8081', 'https://untrusted.example']) {
    assert.equal((await fetch(`${f.address}/mcp`, { method: 'OPTIONS', headers: { Origin: origin } })).status, 403);
  }
  const cors = await fetch(`${f.address}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://viewer.example:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://viewer.example:8080');
  assert.match(cors.headers.get('access-control-allow-headers'), /MCP-Method/);
  assert.match(cors.headers.get('access-control-allow-headers'), /MCP-Name/);
  const legacy = await fetch(`${f.address}/mcp`, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /list_cameras/);
  assert.equal((await fetch(`${f.address}/mcp`, { headers })).status, 405);
  const badJson = await fetch(`${f.address}/mcp`, { method: 'POST', headers, body: '{' });
  assert.equal(badJson.status, 400);
  const tooLarge = await fetch(`${f.address}/mcp`, { method: 'POST', headers, body: JSON.stringify({ padding: 'a'.repeat(1024 * 1024) }) });
  assert.equal(tooLarge.status, 413);
  await assert.rejects(createMcpHttpApp({ dataDir: f.dataDir, apiKey: '' }), /MCP_API_KEY/);
});
