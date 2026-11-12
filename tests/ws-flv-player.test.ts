import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WsFlvPlayer } from '../src/app/ws-flv-player.ts';

class FakeVideo extends EventTarget {
  muted = false;
  autoplay = false;
  playsInline = false;
  error: { message: string } | null = null;
  srcRemoved = 0;
  loads = 0;
  removeAttribute(name: string) { assert.equal(name, 'src'); this.srcRemoved++; }
  load() { this.loads++; }
}

function fixture(options: { unsupported?: boolean; loadError?: boolean } = {}) {
  const video = new FakeVideo();
  const changes: { video: HTMLVideoElement | null; error: string }[] = [];
  const calls: { source: unknown; config: unknown }[] = [];
  const players: Array<EventEmitter & {
    destroyed: number; attached?: HTMLVideoElement; rejectPlay?: (error: Error) => void;
    attachMediaElement: (element: HTMLVideoElement) => void; load: () => void; play: () => Promise<void>; destroy: () => void;
  }> = [];
  const library = {
    isSupported: () => !options.unsupported,
    Events: { ERROR: 'flv-error' },
    createPlayer(source: unknown, config: unknown) {
      calls.push({ source, config });
      const player = Object.assign(new EventEmitter(), {
        destroyed: 0,
        attached: undefined as HTMLVideoElement | undefined,
        rejectPlay: undefined as ((error: Error) => void) | undefined,
        attachMediaElement(element: HTMLVideoElement) { this.attached = element; },
        load() { if (options.loadError) throw new Error('load failed'); },
        play() { return new Promise<void>((_resolve, reject) => { this.rejectPlay = reject; }); },
        destroy() { this.destroyed++; },
      });
      players.push(player);
      return player;
    },
  };
  const decoder = new WsFlvPlayer(video as unknown as HTMLVideoElement,
    library as unknown as ConstructorParameters<typeof WsFlvPlayer>[1],
    (frame, error) => changes.push({ video: frame, error }));
  return { video, decoder, changes, calls, players };
}

test('WS-FLV 只有一个媒体连接，重连和切流先释放旧流，销毁后忽略迟到事件', () => {
  const { video, decoder, changes, calls, players } = fixture();
  decoder.setUrl('ws://cms.example/live.flv');
  decoder.setUrl('ws://cms.example/live.flv');
  assert.equal(players.length, 1);
  assert.equal(players[0].attached, video);
  assert.deepEqual(calls[0].source, { type: 'flv', isLive: true, url: 'ws://cms.example/live.flv' });
  assert.equal(video.muted && video.autoplay && video.playsInline, true);
  video.dispatchEvent(new Event('playing'));
  assert.equal(changes.at(-1)?.video, video);
  decoder.retry();
  assert.equal(players[0].destroyed, 1);
  assert.equal(changes.at(-1)?.video, null);
  players[0].emit('flv-error', 'NetworkError', 'late');
  assert.equal(changes.at(-1)?.error, '');
  decoder.setUrl('wss://cms.example/other.flv');
  assert.equal(players[1].destroyed, 1);
  decoder.destroy();
  decoder.destroy();
  assert.equal(players[2].destroyed, 1);
  const count = changes.length;
  video.dispatchEvent(new Event('playing'));
  players[2].emit('flv-error', 'NetworkError', 'late');
  decoder.retry();
  assert.equal(changes.length, count);
  assert.equal(players.length, 3);
});

test('网络、媒体和自动播放错误撤掉视频纹理，旧 play Promise 不影响新连接', async () => {
  const { video, decoder, changes, players } = fixture();
  decoder.setUrl('ws://cms.example/live.flv');
  decoder.retry();
  players[0].rejectPlay!(new Error('old play'));
  await Promise.resolve();
  assert.equal(changes.at(-1)?.error, '');
  players[1].emit('flv-error', 'NetworkError', 'closed');
  assert.equal(players[1].destroyed, 1);
  assert.match(changes.at(-1)!.error, /NetworkError.*closed/);
  decoder.retry();
  players[2].rejectPlay!(new Error('autoplay blocked'));
  await Promise.resolve();
  assert.match(changes.at(-1)!.error, /autoplay blocked/);
  decoder.retry();
  video.error = { message: 'unsupported codec' };
  video.dispatchEvent(new Event('error'));
  assert.match(changes.at(-1)!.error, /unsupported codec/);
  assert.equal(changes.at(-1)?.video, null);
  assert.equal(players[3].destroyed, 1);
  decoder.destroy();
});

test('不支持的浏览器、非 WS 地址及加载失败均明确报错且不遗留连接', () => {
  const unsupported = fixture({ unsupported: true });
  unsupported.decoder.setUrl('ws://cms.example/live.flv');
  assert.equal(unsupported.players.length, 0);
  assert.match(unsupported.changes.at(-1)!.error, /不支持/);
  unsupported.decoder.destroy();
  const invalid = fixture();
  invalid.decoder.setUrl('https://cms.example/live.flv');
  assert.equal(invalid.players.length, 0);
  assert.match(invalid.changes.at(-1)!.error, /WS/);
  invalid.decoder.destroy();
  const failed = fixture({ loadError: true });
  failed.decoder.setUrl('ws://cms.example/live.flv');
  assert.equal(failed.players[0].destroyed, 1);
  assert.match(failed.changes.at(-1)!.error, /load failed/);
  failed.decoder.destroy();
});
