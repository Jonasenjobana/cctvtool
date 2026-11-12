import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSmsId, playbackCode, playbackSerial, playbackSource } from '../server/playback.mjs';

test('固定设备按 WS-FLV 规则拼接，保留 CMS 主机与端口', () => {
  const source = playbackSource('http://192.168.1.15:10000');
  assert.equal(source.url, 'ws://192.168.1.15:10000/sms/34020000002020000001/ws-flv/hls/34020000001320000088_34020000001320000001.flv');
  assert.equal(source.serial, playbackSerial);
  assert.equal(source.code, playbackCode);
  assert.equal(source.smsId, defaultSmsId);
});

test('HTTPS CMS 使用 WSS，配置中的认证内容不进入播放地址', () => {
  const source = playbackSource('https://operator:password@cms.example:10443/base?token=private#secret', ' node-2 ');
  assert.equal(source.url, 'wss://cms.example:10443/sms/node-2/ws-flv/hls/34020000001320000088_34020000001320000001.flv');
  assert.ok(!JSON.stringify(source).includes('password'));
  assert.ok(!JSON.stringify(source).includes('private'));
  assert.equal(source.smsId, 'node-2');
});

test('指定摄像头时使用该设备的 serial/code，并对地址中的设备与通道标识编码', () => {
  const camera = { serial: 'device/2', code: 'channel?3' };
  const source = playbackSource('https://cms.example:10443', 'node-2', camera);
  assert.equal(source.url, 'wss://cms.example:10443/sms/node-2/ws-flv/hls/device%2F2_channel%3F3.flv');
  assert.equal(source.serial, camera.serial);
  assert.equal(source.code, camera.code);
});

test('无效的 CMS 与 sms_id 明确报错', () => {
  for (const address of [undefined, 'not-a-url', 'ftp://cms.example']) {
    assert.throws(() => playbackSource(address), (error) => error.statusCode === 503);
  }
  assert.throws(() => playbackSource('http://cms.example', '  '), (error) => error.statusCode === 503);
});
