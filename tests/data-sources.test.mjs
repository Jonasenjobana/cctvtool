import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';
import { httpError } from '../server/errors.mjs';

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

async function fixture(t, overrides = {}, livegbs = { configured: false }, additionalSources = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-ais-http-'));
  const sockets = [];
  const f = { sockets, now: Date.parse('2026-11-13T08:00:00Z') };
  f.app = await createApp({ dataDir, webDir: join(dataDir, 'missing-web'), livegbs,
    ais: { project: { id: 'test-harbour', name: '测试海域', sources: [{ ...source, ...overrides }, ...additionalSources] }, now: () => f.now,
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

async function trackingFixture(t) {
  const commands = [];
  const stops = [];
  const control = { readWait: null, commandWait: null, fail: false, reads: 0 };
  const f = await fixture(t, {}, { configured: true,
    async readPtz() {
      control.reads++;
      await control.readWait;
      return { raw: { Pan: 90, Tilt: 3, Zoom: 8, HorizontalFieldAngle: 20, VerticalFieldAngle: 12 },
        requestedAt: '2026-11-13T08:00:00Z', receivedAt: '2026-11-13T08:00:00Z', durationMs: 1 };
    },
    async preciseControl(_camera, target) {
      commands.push(target);
      await control.commandWait;
      if (control.fail) throw httpError(502, '模拟定位失败');
    },
  });
  const saved = await f.app.inject({ method: 'POST', url: '/api/cameras', payload: {
    name: '追踪测试', serial: 'tracking-device', code: 'tracking-channel', maxZoom: 32,
    longitude: 117, latitude: 39, height: 100, pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0,
  } });
  assert.equal(saved.statusCode, 201, saved.body);
  const camera = saved.json();
  await f.snapshot();
  f.sockets[0].open();
  let latest = { ...row, heading: 90 };
  f.sockets[0].message({ api: 1, datas: [latest] });
  let target = (await f.snapshot()).targets[0];
  const options = {
    target: () => target,
    ready: () => true,
    async track(current, changed) {
      const reading = await f.app.inject(`/api/cameras/${camera.id}/ptz`);
      assert.equal(reading.statusCode, 200, reading.body);
      if (!current()) return null;
      const ship = (await f.snapshot()).targets.find(ship => ship.mmsi === row.mmsi);
      if (!current() || !ship) return null;
      if (changed(ship)) {
        const response = await f.app.inject({ method: 'POST', url: `/api/cameras/${camera.id}/precise`,
          payload: { pan: ship.heading ?? 0, tilt: 3, zoom: 8 } });
        assert.equal(response.statusCode, 200, response.body);
      }
      return ship;
    },
    stopped(error) { stops.push(error ?? null); },
  };
  return { ...f, commands, stops, control, options,
    async update(values) {
      latest = { ...latest, ...values };
      f.sockets[0].message({ api: 1, datas: [latest] });
      target = (await f.snapshot()).targets[0] ?? null;
    },
  };
}

const settleTracking = async () => { for (let i = 0; i < 10; i++) await new Promise(accept => setImmediate(accept)); };

test('AIS 定时追踪仅在位置或船艏变化后通过 HTTP 再次定位，0 船艏过滤后不重复调用', async (t) => {
  const f = await trackingFixture(t);
  const { startAisTracking } = await import('../src/app/ais-tracking.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = startAisTracking(f.options);
  t.after(stop);
  await settleTracking();
  assert.equal(f.commands.length, 1);
  await f.update({ speed: 5, date: '2026-11-13 15:59:59' });
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 1);
  await f.update({ lng: 117.001 });
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 2);
  await f.update({ heading: 120 });
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 3);
  await f.update({ heading: 0 });
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 3);
  stop();
  await f.update({ heading: 150 });
  t.mock.timers.tick(5000);
  await settleTracking();
  assert.equal(f.commands.length, 3);
});

test('AIS 定时追踪在定位未回包时不重叠或排队，随后只定位最新状态', async (t) => {
  const f = await trackingFixture(t);
  const { startAisTracking } = await import('../src/app/ais-tracking.ts');
  let release;
  f.control.commandWait = new Promise(accept => { release = accept; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = startAisTracking(f.options);
  try {
    await settleTracking();
    assert.equal(f.commands.length, 1);
    await f.update({ heading: 120 });
    t.mock.timers.tick(3000);
    await settleTracking();
    await f.update({ heading: 150 });
    t.mock.timers.tick(3000);
    await settleTracking();
    assert.equal(f.commands.length, 1);
    release();
    await settleTracking();
    t.mock.timers.tick(1000);
    await settleTracking();
    assert.deepEqual(f.commands.map(command => command.pan), [90, 150]);
    t.mock.timers.tick(5000);
    await settleTracking();
    assert.equal(f.commands.length, 2);
  } finally { release(); stop(); }
});

test('AIS 停止追踪会使迟到的回读失效，定位失败后不自动重发', async (t) => {
  const f = await trackingFixture(t);
  const { startAisTracking } = await import('../src/app/ais-tracking.ts');
  let release;
  f.control.readWait = new Promise(accept => { release = accept; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = startAisTracking(f.options);
  try {
    await settleTracking();
    assert.equal(f.control.reads, 1);
    stop();
    release();
    await settleTracking();
    t.mock.timers.tick(5000);
    await settleTracking();
    assert.equal(f.commands.length, 0);
    f.control.fail = true;
    const stopFailed = startAisTracking(f.options);
    try {
      await settleTracking();
      assert.equal(f.commands.length, 1);
      assert.equal(f.stops.length, 1);
      assert.ok(f.stops[0] instanceof Error);
      await f.update({ heading: 150 });
      t.mock.timers.tick(5000);
      await settleTracking();
      assert.equal(f.commands.length, 1);
    } finally { stopFailed(); }
  } finally { release(); stop(); }
});

test('AIS 定时追踪等待控制空闲，来源失效后终止后续定位', async (t) => {
  const f = await trackingFixture(t);
  const { startAisTracking } = await import('../src/app/ais-tracking.ts');
  let ready = false;
  f.options.ready = () => ready;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = startAisTracking(f.options);
  t.after(stop);
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 0);
  ready = true;
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.equal(f.commands.length, 1);
  f.sockets[0].close();
  await f.update({ heading: 150 });
  t.mock.timers.tick(1000);
  await settleTracking();
  assert.deepEqual(f.stops, [null]);
  assert.equal(f.commands.length, 1);
});

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
    longitude: 117, latitude: 39, heading: null, length: 100, width: 20, speed: 0 }]);
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

test('船艏为 0 的更新保留同船旧船艏，其他字段照常更新且后续有效船艏仍可替换', async (t) => {
  const f = await fixture(t);
  await f.snapshot();
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [{ ...row, heading: 135, speed: 5 }] });
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 15:59:59', lng: 118, heading: 0 }] });
  assert.deepEqual((await f.snapshot()).targets[0], { mmsi: row.mmsi, time: '2026-11-13T07:59:59.000Z',
    longitude: 118, latitude: 39, heading: 135, length: 100, width: 20, speed: 0 });
  f.sockets[0].message({ api: 1, datas: [{ ...row, heading: 45 }] });
  assert.equal((await f.snapshot()).targets[0].heading, 135);
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 15:59:59', heading: 200 }] });
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 15:59:59', heading: 0 }] });
  assert.equal((await f.snapshot()).targets[0].heading, 200);
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 16:00:00', heading: 0.1 }] });
  assert.equal((await f.snapshot()).targets[0].heading, 0.1);
});

test('同批船艏更新按船保留，首次为 0 或旧船艏不可用时保持缺失', async (t) => {
  const f = await fixture(t);
  await f.snapshot();
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [row] });
  assert.equal((await f.snapshot()).targets[0].heading, null);
  f.sockets[0].message({ api: 1, datas: [{ ...row, heading: 90 }, row,
    { ...row, mmsi: '987654321', heading: 0 }] });
  assert.deepEqual((await f.snapshot()).targets.map(target => [target.mmsi, target.heading]),
    [[row.mmsi, 90], ['987654321', null]]);
  f.sockets[0].message({ api: 1, datas: [{ ...row, heading: 511 }, row] });
  assert.equal((await f.snapshot()).targets[0].heading, null);
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

test('过期目标在收到新位置前尚未清理时，0 船艏不继承过期值', async (t) => {
  const f = await fixture(t);
  await f.snapshot();
  f.sockets[0].open();
  f.sockets[0].message({ api: 1, datas: [{ ...row, heading: 90 }] });
  f.now += 600001;
  f.sockets[0].message({ api: 1, datas: [{ ...row, date: '2026-11-13 16:09:59', heading: 0 }] });
  assert.equal((await f.snapshot()).targets[0].heading, null);
});

test('断线清除目标并重连，迟到的旧连接消息不能混入新状态，关闭服务释放连接', async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 5 });
  await f.snapshot();
  const first = f.sockets[0];
  first.open();
  first.message({ api: 1, datas: [{ ...row, heading: 90 }] });
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
  f.sockets[1].message({ api: 1, datas: [row] });
  assert.equal((await f.snapshot()).targets.find(target => target.mmsi === row.mmsi).heading, null);
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

for (const initializationFailure of [false, true]) {
  test(initializationFailure ? '页面订阅初始化失败时显示真实异常并允许重新连接' : '页面在 EventSource 被代理时仍可通过 HTTP/SSE 连接并取得目标', { timeout: 20000 }, async (t) => {
    const f = await fixture(t, {}, { configured: false }, [{ ...source, id: 'other-ais', name: '另一 AIS' }]);
    await f.snapshot();
    f.sockets[0].open();
    f.sockets[0].message({ api: 1, datas: [row] });
    assert.equal((await f.app.inject('/api/data-sources/other-ais/snapshot')).statusCode, 200);
    f.sockets[1].open();
    f.sockets[1].message({ api: 1, datas: [{ ...row, heading: 90, shipLength: 150 }] });
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    const cache = resolve('node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const folder = await mkdtemp(join(cache, 'ais-http-client-'));
    t.after(async () => {
      if (dirname(resolve(folder)) !== cache || !basename(folder).startsWith('ais-http-client-')) throw new Error('客户端测试清理路径超出缓存目录');
      await rm(folder, { recursive: true, force: true });
    });
    const file = join(folder, 'client.mjs');
    await build({ entryPoints: ['tests/fixtures/ais-http-client.ts'], outfile: file, bundle: true, platform: 'node',
      format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', logLevel: 'silent' });
    const result = await promisify(execFile)(process.execPath, ['--experimental-eventsource', file], {
      cwd: process.cwd(), timeout: 12000, windowsHide: true,
      env: { ...process.env, AIS_TEST_ORIGIN: `http://127.0.0.1:${f.app.server.address().port}`, AIS_TEST_INIT_FAILURE: initializationFailure ? '1' : '0' },
    });
    assert.match(result.stdout, /AIS HTTP consumer PASS/);
  });
}
