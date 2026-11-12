import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVideoFrameLoop } from '../src/app/video-frame-loop.ts';

test('新解码帧触发重绘，停止后取消回调，回调中释放也不会再次调度', () => {
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  let renders = 0;
  const video = {
    requestVideoFrameCallback(callback: () => void) { callbacks.set(++sequence, callback); return sequence; },
    cancelVideoFrameCallback(id: number) { callbacks.delete(id); },
  } as unknown as HTMLVideoElement;
  const step = () => {
    const [id, callback] = callbacks.entries().next().value!;
    callbacks.delete(id);
    callback();
  };
  const stop = startVideoFrameLoop(video, () => { renders++; });
  step();
  assert.equal(renders, 1);
  assert.equal(callbacks.size, 1);
  stop();
  assert.equal(callbacks.size, 0);
  const stopInside = startVideoFrameLoop(video, () => stopInside());
  step();
  assert.equal(callbacks.size, 0);
});

test('旧浏览器按视频时间变化重绘，暂停或无数据时不重复刷新', () => {
  const oldRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const oldCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  let renders = 0;
  Object.assign(globalThis, {
    requestAnimationFrame(callback: () => void) { callbacks.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); },
  });
  try {
    const video = { readyState: 0, currentTime: 0 };
    const stop = startVideoFrameLoop(video as HTMLVideoElement, () => { renders++; });
    const step = () => {
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback();
    };
    step();
    assert.equal(renders, 0);
    video.readyState = 2;
    step();
    step();
    assert.equal(renders, 1);
    video.currentTime = 1;
    step();
    assert.equal(renders, 2);
    stop();
    assert.equal(callbacks.size, 0);
  } finally {
    if (oldRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', oldRequest);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (oldCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', oldCancel);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});
