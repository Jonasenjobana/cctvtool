import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { CameraStore } from '../server/store.mjs';
import { fixtureCamera, fixtureRange, syntheticSnapshots } from './calibration-fixtures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');

test('stdio MCP 互通：选摄像头和时段、读取原图、拟合输出，且不改数据库', { timeout: 25000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-mcp-test-'));
  const store = new CameraStore(dataDir);
  const camera = store.saveCamera({ ...fixtureCamera, tiltOffset: 1.64, imageRoll: 0.73 });
  const data = syntheticSnapshots({ camera });
  for (const snapshot of data.snapshots) store.addSnapshot({ ...snapshot,
    fileName: `${snapshot.id}.png`, imageUrl: `/api/snapshots/${snapshot.id}/image`,
  });
  const image = { ...data.snapshots[0], id: 'visible-image', width: 1, height: 1,
    fileName: 'pixel.png', contentType: 'image/png', bytes: png.length,
    createdAt: '2026-11-09T00:30:00.000Z', imageUrl: '/api/snapshots/visible-image/image',
  };
  store.addSnapshot(image);
  await writeFile(join(dataDir, 'snapshots', 'pixel.png'), png);
  const before = store.getCamera(camera.id);
  store.close();
  const client = new Client({ name: 'cctv-calibration-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server/mcp.mjs', import.meta.url))],
    cwd: tmpdir(),
    env: { ...getDefaultEnvironment(), DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    await client.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-mcp-test-')) {
      throw new Error('MCP 测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['estimate_p_axis_tilt', 'get_snapshot', 'list_cameras', 'query_snapshots']);
  assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const cameras = await call('list_cameras');
  assert.equal(cameras.structuredContent.cameras[0].snapshotCount, 7);
  assert.equal(cameras.structuredContent.cameras[0].id, camera.id);
  const selection = { cameraId: camera.id, ...fixtureRange };
  const page = await call('query_snapshots', { ...selection, limit: 2 });
  assert.equal(page.structuredContent.total, 7);
  assert.equal(page.structuredContent.nextOffset, 2);
  assert.deepEqual(page.structuredContent.pageSampling, { stableSnapshotCount: 2, distinctPanCount: 2, panCoverageDegrees: 60 });
  const firstMinute = await call('query_snapshots', {
    cameraId: camera.id, startTime: '2026-11-09T08:00:00+08:00', endTime: '2026-11-09T08:01:00+08:00',
  });
  assert.equal(firstMinute.structuredContent.total, 1);
  assert.equal(firstMinute.structuredContent.snapshots[0].id, 'synthetic-0');
  const picture = await call('get_snapshot', { snapshotId: 'visible-image' });
  assert.equal(picture.isError, undefined, JSON.stringify(picture));
  assert.equal(picture.structuredContent.width, 1);
  assert.equal(picture.content.find((block) => block.type === 'image').data, png.toString('base64'));
  const fit = await call('estimate_p_axis_tilt', { ...selection, observations: data.observations });
  assert.equal(fit.structuredContent.status, 'estimated', JSON.stringify(fit));
  assert.ok(Math.abs(fit.structuredContent.installation.pAxisPitch - 1.25) < 0.00001);
  assert.ok(Math.abs(fit.structuredContent.installation.pAxisRoll + 2.1) < 0.00001);
  assert.equal(fit.structuredContent.applied, false);
  assert.equal(fit.structuredContent.fixedCalibration.tiltOffset, 1.64);
  assert.equal(fit.structuredContent.fixedCalibration.imageRoll, 0.73);
  const single = await call('estimate_p_axis_tilt', { ...selection, observations: data.observations.slice(0, 1) });
  assert.equal(single.structuredContent.status, 'estimated', JSON.stringify(single));
  assert.ok(Math.abs(single.structuredContent.installation.pAxisPitch - 1.25) < 1e-5);
  assert.ok(Math.abs(single.structuredContent.installation.pAxisRoll + 2.1) < 1e-5);
  const insufficient = await call('estimate_p_axis_tilt', { ...selection, observations: [
    { snapshotId: 'synthetic-0', points: [{ x: 0.1, y: 0.5 }, { x: 0.15, y: 0.5 }] },
  ] });
  assert.equal(insufficient.structuredContent.status, 'insufficient_data');
  assert.equal(insufficient.structuredContent.installation, null);
  const badTime = await call('query_snapshots', {
    cameraId: camera.id, startTime: '2026-11-09T00:00:00', endTime: '2026-11-09T01:00:00',
  });
  assert.equal(badTime.isError, true);
  const invalid = await call('get_snapshot', { snapshotId: '../../.env' });
  assert.equal(invalid.isError, true);
  const wrongPoint = await call('estimate_p_axis_tilt', { ...selection, observations: [
    { snapshotId: 'synthetic-0', points: [{ x: 100, y: 200 }, { x: 500, y: 200 }] },
  ] });
  assert.equal(wrongPoint.isError, true);
  const readOnly = new CameraStore(dataDir, { readOnly: true });
  assert.deepEqual(readOnly.getCamera(camera.id), before);
  assert.throws(() => readOnly.saveCamera({ ...before, name: '不能写入' }, camera.id), /readonly/i);
  readOnly.close();
  assert.ok(!stderr.includes('SyntaxError'), stderr);
});
