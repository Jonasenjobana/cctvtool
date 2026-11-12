import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { LiveGbsClient } from '../server/livegbs.mjs';
import { readImageInfo } from '../server/image.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const input = {
  name: '海域摄像头', serial: '000088', code: '000001',
  longitude: 113.9, latitude: 22.1, height: 12.5,
  pAxisPitch: 1.2, pAxisRoll: -2.3, panOffset: 93.2, tiltOffset: 1.64, imageRoll: 0.73,
};

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-test-'));
  const state = {
    loginCount: 0, validToken: '', controls: [], ptzCommands: [], ptzCount: 0, snapshotCount: 0,
    ptz: { DeviceID: input.code, Pan: 232.2, Tilt: 2.8, Zoom: 15, HorizontalFieldAngle: 4.32, VerticalFieldAngle: 2.43, MaxViewDistance: 0 },
    ptzStatus: 200, failLogin: false, invalidPtz: false,
    changeDuringSnapshot: false, snapshotWait: null, onSnapshot: null, badImage: false,
    motionWait: null, onMotion: null, failMotion: false, stopStatus: 200,
  };
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/login') {
      state.loginCount++;
      if (state.failLogin) return json(401, 'Unauthorized');
      assert.equal(request.method, 'POST');
      assert.equal(url.searchParams.get('username'), 'test-user');
      assert.equal(url.searchParams.get('password'), 'test-password');
      state.validToken = `test-session-${state.loginCount}`;
      return json(200, { URLToken: state.validToken, TokenTimeout: 604800 });
    }
    if (url.searchParams.get('token') !== state.validToken) return json(401, 'Unauthorized');
    assert.equal(url.searchParams.get('serial'), input.serial);
    assert.equal(url.searchParams.get('code'), input.code);
    if (url.pathname === '/api/v1/device/fetchptzposition') {
      state.ptzCount++;
      return json(state.ptzStatus, state.invalidPtz ? { ...state.ptz, Pan: '232.2' } : state.ptz);
    }
    if (url.pathname === '/api/v1/control/ptz') {
      assert.equal(request.method, 'POST');
      const command = url.searchParams.get('command');
      const speed = Number(url.searchParams.get('speed'));
      assert.equal(url.searchParams.has('pan'), false);
      state.ptzCommands.push({ command, speed });
      if (command === 'stop') return json(state.stopStatus, { success: state.stopStatus === 200 });
      state.onMotion?.();
      if (state.motionWait) await state.motionWait;
      return json(state.failMotion ? 500 : 200, { success: !state.failMotion });
    }
    if (url.pathname === '/api/v1/control/ptzprecise') {
      assert.equal(request.method, 'POST');
      const target = Object.fromEntries(['pan', 'tilt', 'zoom'].map((key) => [key, Number(url.searchParams.get(key))]));
      state.controls.push(target);
      state.ptz = { ...state.ptz, Pan: target.pan, Tilt: target.tilt, Zoom: target.zoom };
      return json(200, { success: true });
    }
    if (url.pathname === '/api/v1/device/channelsnap') {
      state.snapshotCount++;
      assert.equal(url.searchParams.get('stime'), 'now');
      state.onSnapshot?.();
      if (state.snapshotWait) await state.snapshotWait;
      if (state.changeDuringSnapshot) state.ptz = { ...state.ptz, Pan: state.ptz.Pan + 1 };
      response.writeHead(200, { 'Content-Type': 'image/png', 'Channel-Snap-Time': '2026-11-09 10:24:02' });
      return response.end(state.badImage ? Buffer.from('not an image') : png);
    }
    return json(404, 'Not Found');
  });
  await new Promise((accept) => upstream.listen(0, '127.0.0.1', accept));
  const client = new LiveGbsClient({
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    username: 'test-user', password: 'test-password', timeoutMs: 2000,
  });
  const options = { dataDir, livegbs: client, webDir: join(dataDir, 'missing-web') };
  const result = { state, client, dataDir, options, app: await createApp(options) };
  t.after(async () => {
    await result.app.close();
    await new Promise((accept) => upstream.close(accept));
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-test-')) {
      throw new Error('测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  const response = await result.app.inject({ method: 'POST', url: '/api/cameras', payload: input });
  assert.equal(response.statusCode, 201, response.body);
  result.camera = response.json();
  return result;
}

test('设备参数与截图在重启后恢复，图片地址可读取且原始 PTZ 不受标定影响', async (t) => {
  const f = await fixture(t);
  assert.equal(f.camera.serial, '000088');
  const updated = { ...input, longitude: 0, latitude: 0, height: 0, pAxisPitch: 2, panOffset: -95.1 };
  const save = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: updated });
  assert.equal(save.statusCode, 200);
  const shot = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} });
  assert.equal(shot.statusCode, 201, shot.body);
  const snapshot = shot.json();
  assert.equal(snapshot.ptz.raw.Pan, 232.2);
  assert.equal(snapshot.calibration.panOffset, -95.1);
  assert.equal(snapshot.calibration.longitude, 0);
  assert.equal(snapshot.width, 1);
  assert.equal(snapshot.height, 1);
  assert.equal(snapshot.poseChanged, false);
  assert.equal(snapshot.timeAlignment, 'unverified');
  assert.equal(snapshot.snapshotTime, '2026-11-09 10:24:02');
  assert.equal(snapshot.usesDraft, false);
  assert.ok(snapshot.ptz.requestedAt <= snapshot.requestedAt);
  assert.ok(snapshot.requestedAt <= snapshot.receivedAt);
  assert.ok(snapshot.receivedAt <= snapshot.ptzAfter.receivedAt);
  assert.ok(!shot.body.includes(f.state.validToken));
  const image = await f.app.inject(snapshot.imageUrl);
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.deepEqual(image.rawPayload, png);
  await f.app.close();
  f.app = await createApp(f.options);
  const cameras = (await f.app.inject('/api/cameras')).json();
  assert.equal(cameras[0].pAxisPitch, 2);
  assert.equal(cameras[0].longitude, 0);
  assert.equal(cameras[0].height, 0);
  assert.equal(cameras[0].panOffset, -95.1);
  assert.equal(cameras[0].tiltOffset, input.tiltOffset);
  assert.equal(cameras[0].imageRoll, input.imageRoll);
  const history = (await f.app.inject(`/api/cameras/${f.camera.id}/snapshots`)).json();
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], snapshot);
  assert.equal((await f.app.inject(snapshot.imageUrl)).statusCode, 200);
});

test('并发回读只登录一次，token 被拒绝后合并重新登录且不向前端泄露认证数据', async (t) => {
  const f = await fixture(t);
  const url = `/api/cameras/${f.camera.id}/ptz`;
  const first = await Promise.all([f.app.inject(url), f.app.inject(url), f.app.inject(url)]);
  first.forEach((reply) => assert.equal(reply.statusCode, 200, reply.body));
  assert.equal(f.state.loginCount, 1);
  f.state.validToken = 'expired-on-server';
  const refreshed = await Promise.all([f.app.inject(url), f.app.inject(url)]);
  refreshed.forEach((reply) => {
    assert.equal(reply.statusCode, 200, reply.body);
    assert.ok(!reply.body.includes('test-session'));
    assert.equal(reply.json().raw.HorizontalFieldAngle, 4.32);
  });
  assert.equal(f.state.loginCount, 2);
});

test('未指定 cameraId 时返回默认通道的播放配置，且不触发 API 登录', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject('/api/playback');
  assert.equal(response.statusCode, 200, response.body);
  const source = response.json();
  assert.equal(source.serial, '34020000001320000088');
  assert.equal(source.code, '34020000001320000001');
  assert.match(source.url, /^ws:\/\/127\.0\.0\.1:\d+\/sms\/[^/]+\/ws-flv\/hls\/34020000001320000088_34020000001320000001\.flv$/);
  assert.equal(new URL(source.url).search, '');
  assert.ok(!response.body.includes('test-password'));
  assert.equal(f.state.loginCount, 0);
});

test('切换 CCTV 时按当前摄像头重新取得 WS-FLV 地址，不能复用上一个通道', async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({ method: 'POST', url: '/api/cameras',
    payload: { ...input, name: '另一台摄像头', serial: '000099', code: '000002' } });
  assert.equal(created.statusCode, 201, created.body);
  const second = created.json();
  const sources = [];
  for (const camera of [f.camera, second]) {
    const response = await f.app.inject(`/api/playback?cameraId=${camera.id}`);
    assert.equal(response.statusCode, 200, response.body);
    const source = response.json();
    assert.equal(source.serial, camera.serial, '直播设备必须是当前选择的 CCTV');
    assert.equal(source.code, camera.code, '直播通道必须随摄像头切换');
    assert.ok(new URL(source.url).pathname.endsWith(`/${camera.serial}_${camera.code}.flv`));
    sources.push(source);
  }
  assert.notEqual(sources[0].url, sources[1].url);
  assert.equal(f.state.loginCount, 0);
  assert.equal((await f.app.inject('/api/playback?cameraId=missing')).statusCode, 404);
});

test('连续方向和变倍直接转发 ptz，无须回读，速度默认 129，stop 结束后才解锁保存与截图', async (t) => {
  const f = await fixture(t);
  const url = `/api/cameras/${f.camera.id}/control`;
  f.state.ptzStatus = 500;
  let response = await f.app.inject({ method: 'POST', url, payload: { command: 'right' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(f.state.ptzCommands, [{ command: 'right', speed: 129 }]);
  assert.equal(f.state.ptzCount, 0);
  assert.equal(f.state.controls.length, 0);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/precise`, payload: { pan: 1, tilt: 2, zoom: 3 } })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'stop' } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input })).statusCode, 200);
  for (const command of ['left', 'up', 'down', 'upleft', 'upright', 'downleft', 'downright', 'zoomin', 'zoomout']) {
    const speed = command === 'zoomin' ? 0 : 255;
    assert.equal((await f.app.inject({ method: 'POST', url, payload: { command, speed } })).statusCode, 200);
    assert.deepEqual(f.state.ptzCommands.at(-1), { command, speed });
    assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'stop' } })).statusCode, 200);
  }
  for (const payload of [{ command: 'other' }, { command: 'up', speed: -1 }, { command: 'up', speed: 256 }, { command: 'up', speed: 1.5 }]) {
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 400);
  }
  assert.equal(f.state.ptzCount, 0);
  assert.equal(f.state.controls.length, 0);
});

test('精确定位仅由独立请求提交完整 P/T/Z，安装修正不进入目标值', async (t) => {
  const f = await fixture(t);
  const url = `/api/cameras/${f.camera.id}/precise`;
  const target = { pan: 233.25, tilt: 3.75, zoom: 37 };
  const response = await f.app.inject({ method: 'POST', url, payload: target });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(f.state.controls, [target]);
  assert.deepEqual(response.json().target, target);
  assert.equal(f.state.ptzCount, 0);
  assert.equal(f.state.ptzCommands.length, 0);
  for (const payload of [{ pan: 1 }, { ...target, pan: 361 }, { ...target, tilt: -1 }, { ...target, zoom: 0 }]) {
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 400);
  }
  assert.equal(f.state.controls.length, 1);
});

test('启动请求尚未结束时 stop 排在它之后，冲突请求不破坏停止顺序，停止失败可重试', async (t) => {
  const f = await fixture(t);
  const url = `/api/cameras/${f.camera.id}/control`;
  let release;
  let reached;
  const arrived = new Promise((accept) => { reached = accept; });
  f.state.motionWait = new Promise((accept) => { release = accept; });
  f.state.onMotion = () => reached();
  const start = f.app.inject({ method: 'POST', url, payload: { command: 'left', speed: 70 } });
  await arrived;
  const conflict = await f.app.inject({ method: 'POST', url, payload: { command: 'right' } });
  assert.equal(conflict.statusCode, 409);
  const stop = f.app.inject({ method: 'POST', url, payload: { command: 'stop' } });
  try {
    await new Promise((accept) => setImmediate(accept));
    assert.deepEqual(f.state.ptzCommands, [{ command: 'left', speed: 70 }]);
    f.state.stopStatus = 500;
  } finally { release(); }
  assert.equal((await start).statusCode, 200);
  assert.equal((await stop).statusCode, 502);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input })).statusCode, 409);
  f.state.stopStatus = 200;
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'stop' } })).statusCode, 200);
  assert.deepEqual(f.state.ptzCommands.map(item => item.command), ['left', 'stop', 'stop']);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input })).statusCode, 200);
});

test('启动响应失败后仍可停止，服务正常关闭会停止尚未结束的连续控制', async (t) => {
  const f = await fixture(t);
  const url = `/api/cameras/${f.camera.id}/control`;
  f.state.failMotion = true;
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'up' } })).statusCode, 502);
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'stop' } })).statusCode, 200);
  f.state.failMotion = false;
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { command: 'zoomin' } })).statusCode, 200);
  await f.app.close();
  assert.deepEqual(f.state.ptzCommands.map(item => item.command), ['up', 'stop', 'zoomin', 'stop']);
});

test('截图保留草稿副本与前后状态，姿态变化可见，已保存配置不被覆盖', async (t) => {
  const f = await fixture(t);
  f.state.changeDuringSnapshot = true;
  const calibration = { longitude: 110, latitude: 20, height: 8, pAxisPitch: 3, pAxisRoll: 1, panOffset: 88, tiltOffset: -2, imageRoll: 1.5 };
  const response = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: { calibration } });
  assert.equal(response.statusCode, 201, response.body);
  const snapshot = response.json();
  assert.deepEqual(snapshot.calibration, calibration);
  assert.equal(snapshot.usesDraft, true);
  assert.equal(snapshot.poseChanged, true);
  assert.equal(snapshot.ptzAfter.raw.Pan - snapshot.ptz.raw.Pan, 1);
  const camera = (await f.app.inject('/api/cameras')).json()[0];
  assert.equal(camera.panOffset, input.panOffset);
  assert.equal(camera.tiltOffset, input.tiltOffset);
  assert.equal(camera.imageRoll, input.imageRoll);
});

test('截图期间拒绝控制和配置改写，释放后可继续工作', async (t) => {
  const f = await fixture(t);
  let release;
  let reached;
  const arrived = new Promise((accept) => { reached = accept; });
  f.state.snapshotWait = new Promise((accept) => { release = accept; });
  f.state.onSnapshot = () => reached();
  const pending = f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} });
  await arrived;
  try {
    const control = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/control`, payload: { command: 'left' } });
    assert.equal(control.statusCode, 409);
    assert.equal(f.state.controls.length, 0);
    const save = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input });
    assert.equal(save.statusCode, 409);
  } finally { release(); }
  assert.equal((await pending).statusCode, 201);
  assert.equal((await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: input })).statusCode, 200);
});

test('数据库写入截图失败时清理本次图片，不留下成功记录', async (t) => {
  const f = await fixture(t);
  const errorLog = t.mock.method(console, 'error', () => {});
  const db = new DatabaseSync(join(f.dataDir, 'cctv.sqlite'));
  db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;");
  db.close();
  const response = await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} });
  assert.equal(response.statusCode, 500);
  assert.equal(errorLog.mock.calls.length, 1);
  assert.deepEqual(await readdir(join(f.dataDir, 'snapshots')), []);
  assert.deepEqual((await f.app.inject(`/api/cameras/${f.camera.id}/snapshots`)).json(), []);
});

test('非法配置、重复通道、上游错误与错误图片均明确失败', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/cameras', payload: input })).statusCode, 409);
  for (const extra of [{ longitude: 181 }, { serial: 88 }, { pAxisPitch: null }, { tiltOffset: null }, { imageRoll: 181 }, { primary: {} }, { name: '   ' }]) {
    const response = await f.app.inject({ method: 'PUT', url: `/api/cameras/${f.camera.id}`, payload: { ...input, ...extra } });
    assert.equal(response.statusCode, 400, response.body);
  }
  f.state.invalidPtz = true;
  assert.equal((await f.app.inject(`/api/cameras/${f.camera.id}/ptz`)).statusCode, 502);
  f.state.invalidPtz = false;
  f.state.ptzStatus = 500;
  const failure = await f.app.inject(`/api/cameras/${f.camera.id}/ptz`);
  assert.equal(failure.statusCode, 502);
  assert.ok(!failure.body.includes('test-password'));
  assert.ok(!failure.body.includes('token='));
  f.state.ptzStatus = 200;
  f.state.badImage = true;
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/cameras/${f.camera.id}/snapshots`, payload: {} })).statusCode, 502);
  assert.deepEqual(await readdir(join(f.dataDir, 'snapshots')), []);
  assert.equal((await f.app.inject('/api/cameras/missing/ptz')).statusCode, 404);
});

test('图片尺寸解析支持 JPEG 帧头并拒绝截断内容', () => {
  const jpeg = Buffer.from('ffd8ffc00011080008001003011100021100031100ffd9', 'hex');
  assert.deepEqual(readImageInfo(jpeg), { width: 16, height: 8, contentType: 'image/jpeg', extension: 'jpg' });
  assert.throws(() => readImageInfo(jpeg.subarray(0, 10)), /JPEG/);
  assert.equal(readImageInfo(png).width, 1);
});

test('响应体超时返回 504，失败的登录可以重试', async () => {
  let attempts = 0;
  const client = new LiveGbsClient({
    baseUrl: 'http://example.invalid', username: 'test-user', password: 'test-password',
    fetchImpl: async (url) => {
      if (url.pathname === '/api/v1/login') {
        attempts++;
        if (attempts === 1) return { ok: true, json: async () => { throw new DOMException('body timeout', 'AbortError'); } };
        return new Response(JSON.stringify({ URLToken: 'test-token', TokenTimeout: 3600 }));
      }
      return { ok: true, status: 200, json: async () => { throw new DOMException('body timeout', 'AbortError'); } };
    },
  });
  await assert.rejects(client.readPtz(input), (error) => error.statusCode === 504 && error.message.includes('超时'));
  await assert.rejects(client.readPtz(input), (error) => error.statusCode === 504 && error.message.includes('超时'));
  assert.equal(attempts, 2);
});
