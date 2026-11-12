import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HoldPtzControl } from '../src/app/hold-ptz-control.ts';
import type { HoldControlState } from '../src/app/hold-ptz-control.ts';
import type { PtzCommand } from '../src/app/models.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((accept) => setImmediate(accept));

function fixture(send: (command: PtzCommand) => Promise<unknown> = () => Promise.resolve()) {
  const calls: { id: string; command: PtzCommand; speed: number; keepalive: boolean }[] = [];
  const states: HoldControlState[] = [];
  const controller = new HoldPtzControl((id, command, speed, keepalive = false) => {
    calls.push({ id, command, speed, keepalive });
    return send(command);
  }, (state) => states.push(state), (error) => error instanceof Error ? error.message : String(error));
  return { controller, calls, states };
}

test('按住只发一次运动指令，正常松手发送 stop，保留原设备和速度', async () => {
  const f = fixture();
  f.controller.start('camera-a', 'up', 129);
  f.controller.start('camera-b', 'down', 30);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.states.at(-1)?.command, 'up');
  await f.controller.release();
  assert.deepEqual(f.calls.map(call => [call.id, call.command, call.speed]), [['camera-a', 'up', 129], ['camera-a', 'stop', 129]]);
  assert.equal(f.controller.busy, false);
  assert.equal(f.states.at(-1)?.busy, false);
  assert.match(f.states.at(-1)!.message, /回读/);
  await f.controller.release();
  assert.equal(f.calls.length, 2);
});

test('快速松手立即停止；启动迟到后再补 stop，不恢复按住状态或误控新设备', async () => {
  const start = deferred();
  const f = fixture(command => command === 'left' ? start.promise : Promise.resolve());
  f.controller.start('camera-a', 'left', 80);
  const stop = f.controller.release();
  const releaseIndex = f.states.length - 1;
  assert.deepEqual(f.calls.map(call => call.command), ['left', 'stop']);
  f.controller.start('camera-b', 'right', 255);
  await tick();
  assert.equal(f.controller.busy, true);
  start.resolve();
  await stop;
  assert.deepEqual(f.calls.map(call => call.command), ['left', 'stop', 'stop']);
  assert.ok(f.calls.every(call => call.id === 'camera-a'));
  assert.ok(f.states.slice(releaseIndex).every(state => state.command === null));
  assert.equal(f.controller.busy, false);
});

test('启动失败也发 stop；停止失败保留控制锁，可显式重试，成功前拒绝新运动', async () => {
  const start = deferred();
  let failStop = true;
  const f = fixture(command => command === 'zoomin' ? start.promise
    : failStop ? Promise.reject(new Error('offline')) : Promise.resolve());
  f.controller.start('camera-a', 'zoomin', 129);
  start.reject(new Error('start timeout'));
  await tick();
  assert.deepEqual(f.calls.map(call => call.command), ['zoomin', 'stop']);
  assert.equal(f.controller.busy, true);
  assert.match(f.states.at(-1)!.error, /停止请求失败.*offline/);
  f.controller.start('camera-b', 'down', 12);
  assert.equal(f.calls.length, 2);
  failStop = false;
  await f.controller.release();
  assert.equal(f.controller.busy, false);
  assert.match(f.states.at(-1)!.error, /start timeout/);
  assert.equal(f.calls.at(-1)?.command, 'stop');
});

test('页面离开时即使常规 stop 未回包，也会为原设备追加 keepalive 停止请求', async () => {
  const stop = deferred();
  const f = fixture(command => command === 'stop' ? stop.promise : Promise.resolve());
  f.controller.start('camera-a', 'zoomout', 45);
  await tick();
  const pending = f.controller.release();
  void f.controller.release(true);
  assert.deepEqual(f.calls.map(call => [call.command, call.keepalive]), [['zoomout', false], ['stop', false], ['stop', true]]);
  stop.resolve();
  await pending;
  assert.equal(f.controller.busy, false);
});
