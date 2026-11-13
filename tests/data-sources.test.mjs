import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';

const source = { id: 'test-ais', name: '测试 AIS', adapter: 'seaoil-ais', url: 'ws://upstream.invalid/websocket',
  timeOffsetMinutes: 480, expireAfterMs: 600000, maxDistanceMeters: 10000,
  geometry: { antennaFromSternRatio: 0.1, antennaFromPortRatio: 0.5, heightMeters: 10 } };
const row = { mmsi: '123456789', date: '2026-11-13 15:59:50', lng: 117, lat: 39,
  heading: 0, shipLength: 100, shipWidth: 20, speed: 0, shipName: '合成测试船', cog: 90 };

class UpstreamSocket extends EventTarget {
  readyState = 0;
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-ais-http-'));
  const sockets = [];
  const f = { sockets, now: Date.parse('2026-11-13T08:00:00Z') };
  f.app = await createApp({ dataDir, webDir: join(dataDir, 'missing-web'), livegbs: { configured: false },
    ais: { project: { id: 'test-harbour', name: '测试海域', sources: [{ ...source, ...overrides }] }, now: () => f.now,
      connect: () => { const socket = new UpstreamSocket(); sockets.push(socket); return socket; } } });
  f.snapshot = async () => {
    const response = await f.app.inject('/api/data-sources/test-ais/snapshot');
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  t.after(async () => {
    await f.app.close();
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-ais-http-')) throw new Error('测试清理路径超出临时目录');
    await rm(target, { recursive: true, force: true });
  });
  return f;
}

test('数据源目录给出固定项目与展示参数，不向前端暴露上游地址或供应商适配配置', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject('/api/data-sources');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { project: { id: 'test-harbour', name: '测试海域' }, sources: [
    { id: source.id, name: source.name, type: 'ais', geometry: source.geometry,
      maxDistanceMeters: 10000, expireAfterMs: 600000 },
  ] });
  assert.equal(f.sockets.length, 0);
  assert.equal((await f.app.inject('/api/data-sources/missing/snapshot')).statusCode, 404);
});

test('来源通过统一快照提供精简字段，AIS 分批合并且其他消息类型不进入船舶集合', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.snapshot()).status, 'connecting');
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [row] });
  assert.deepEqual((await f.snapshot()).targets, [{ mmsi: row.mmsi, time: '2026-11-13T07:59:50.000Z',
    longitude: 117, latitude: 39, heading: 0, length: 100, width: 20, speed: 0 }]);
  f.sockets[0].message({ api: 1, datas: [{ ...row, mmsi: '987654321', heading: 90 }] });
  f.sockets[0].message({ api: 0, datas: [{ ...row, mmsi: '111222333' }] });
  f.sockets[0].message({ api: 2, datas: [{ voltage: 24 }] });
  f.sockets[0].message({ api: 1, datas: [] });
  const snapshot = await f.snapshot();
  assert.equal(snapshot.status, 'connected');
  assert.deepEqual(snapshot.targets.map(target => target.mmsi).sort(), ['123456789', '987654321']);
  assert.equal(f.sockets.length, 1);
});

test('同船乱序更新不覆盖较新位置，未知方向和尺寸保持缺失并公开坏记录错误', async (t) => {
  const f = await fixture(t);
  await f.snapshot();
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 15:59:59', lng: 118 }] });
  f.sockets[0].message({ api: 1, datas: [row] });
  assert.equal((await f.snapshot()).targets[0].longitude, 118);
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 15:59:59',
    heading: 511, shipLength: 0, shipWidth: 0, speed: 102.3 }, { ...row, mmsi: 'bad' }] });
  const snapshot = await f.snapshot();
  assert.deepEqual(snapshot.targets[0], { mmsi: row.mmsi, time: '2026-11-13T07:59:59.000Z',
    longitude: 117, latitude: 39, heading: null, length: null, width: null, speed: null });
  assert.match(snapshot.error, /1 条无效/);
  f.sockets[0].message('{bad');
  assert.ok((await f.snapshot()).error);
  assert.equal((await f.snapshot()).targets.length, 1);
});

test('过期初始记录、异常未来时间和非法日期不恢复成实时目标，目标按来源时间失效', async (t) => {
  const f = await fixture(t);
  await f.snapshot();
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [row,
    { ...row, mmsi: '111222333', date: '2026-11-13 15:00:00' },
    { ...row, mmsi: '222333444', date: '2026-11-13 16:02:00' },
    { ...row, mmsi: '333444555', date: '2026-02-30 16:00:00' },
  ] });
  assert.deepEqual((await f.snapshot()).targets.map(target => target.mmsi), [row.mmsi]);
  f.now += 600001;
  assert.deepEqual((await f.snapshot()).targets, []);
});

test('断线清除目标并重连，迟到的旧连接消息不能混入新状态，关闭服务释放连接', async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 5 });
  await f.snapshot();
  const first = f.sockets[0];
  first.open();
  first.message({ api: 1, datas: [row] });
  first.close();
  const offline = await f.snapshot();
  assert.equal(offline.status, 'reconnecting');
  assert.deepEqual(offline.targets, []);
  await new Promise(accept => setTimeout(accept, 20));
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  first.message({ api: 1, datas: [row] });
  assert.deepEqual((await f.snapshot()).targets, []);
  f.sockets[1].message({ api: 1, datas: [{ ...row, mmsi: '987654321' }] });
  assert.deepEqual((await f.snapshot()).targets.map(target => target.mmsi), ['987654321']);
  await f.app.close();
  assert.equal(f.sockets[1].readyState, 3);
});

test('多个页面通过 SSE 获得完整最新快照并共享来源，断线与服务关闭正确结束订阅', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 5000 });
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${f.app.server.address().port}/api/data-sources/test-ais/events`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /text\/event-stream/);
  const events = response => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
  };
  const nextFirst = events(first);
  assert.equal((await nextFirst()).status, 'connecting');
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [row] });
  assert.deepEqual((await nextFirst()).targets.map(target => target.mmsi), [row.mmsi]);
  const second = await fetch(url);
  const nextSecond = events(second);
  assert.deepEqual((await nextSecond()).targets.map(target => target.mmsi), [row.mmsi]);
  assert.equal(f.sockets.length, 1);
  f.sockets[0].close();
  assert.deepEqual((await nextFirst()).targets, []);
  assert.deepEqual((await nextSecond()).targets, []);
  await f.app.close();
  assert.equal(await nextFirst(), null);
  assert.equal(await nextSecond(), null);
});
