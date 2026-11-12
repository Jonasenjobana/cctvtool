import { httpError } from './errors.mjs';

export const playbackSerial = '34020000001320000088';
export const playbackCode = '34020000001320000001';
export const defaultSmsId = '34020000002020000001';

export function playbackSource(baseUrl, smsId = defaultSmsId, camera = { serial: playbackSerial, code: playbackCode }) {
  let cms;
  try { cms = new URL(baseUrl); } catch {
    throw httpError(503, '请先配置 LiveGBS 服务地址');
  }
  const nodeId = smsId?.trim();
  if (!['http:', 'https:'].includes(cms.protocol) || !nodeId) {
    throw httpError(503, 'LiveGBS 视频服务配置无效');
  }
  const { serial, code } = camera;
  const url = new URL(`/sms/${encodeURIComponent(nodeId)}/ws-flv/hls/${encodeURIComponent(serial)}_${encodeURIComponent(code)}.flv`, cms.origin);
  url.protocol = cms.protocol === 'https:' ? 'wss:' : 'ws:';
  return { url: url.href, serial, code, smsId: nodeId };
}
