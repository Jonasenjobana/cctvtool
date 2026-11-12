import { performance } from 'node:perf_hooks';
import { httpError } from './errors.mjs';

function responseReadError(error, message) {
  return error.name === 'AbortError' || error.name === 'TimeoutError'
    ? httpError(504, 'LiveGBS 响应超时，设备状态请以回读为准')
    : httpError(502, message);
}

export class LiveGbsClient {
  #token = null;
  #expiresAt = 0;
  #loginPromise = null;

  constructor({ baseUrl, username, password, timeoutMs = 15000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.baseUrl && this.username && this.password);
  }

  async #fetch(path, parameters, method) {
    let url;
    try {
      url = new URL(path, this.baseUrl);
    } catch {
      throw httpError(503, 'LiveGBS 服务地址尚未正确配置');
    }
    url.search = new URLSearchParams(parameters).toString();
    try {
      return await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 错误消息不携带上游 URL，避免查询参数中的口令或 token 泄露。
      throw httpError(
        error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502,
        error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'LiveGBS 请求超时，请重试'
          : '无法连接 LiveGBS 服务',
      );
    }
  }

  async #login() {
    if (!this.configured) throw httpError(503, '请先在后端配置 LiveGBS 登录信息');
    const response = await this.#fetch('/api/v1/login', {
      username: this.username,
      password: this.password,
    }, 'POST');
    if (!response.ok) throw httpError(502, `LiveGBS 登录失败（HTTP ${response.status}）`);
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw responseReadError(error, 'LiveGBS 登录响应不是有效 JSON');
    }
    if (typeof body?.URLToken !== 'string' || !body.URLToken) {
      throw httpError(502, 'LiveGBS 登录响应缺少 URLToken');
    }
    this.#token = body.URLToken;
    this.#expiresAt = Number.isFinite(body.TokenTimeout) && body.TokenTimeout > 0
      ? Date.now() + Math.max(0, body.TokenTimeout - 30) * 1000
      : Infinity;
    return this.#token;
  }

  async #getToken() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    // 多个设备同时请求时共用一次登录，避免覆盖彼此的新会话。
    this.#loginPromise ??= this.#login().finally(() => { this.#loginPromise = null; });
    return this.#loginPromise;
  }

  async #request(path, camera, extra = {}, method = 'GET') {
    const token = await this.#getToken();
    const parameters = { serial: camera.serial, code: camera.code, ...extra };
    let response = await this.#fetch(path, { ...parameters, token }, method);
    if (response.status === 401) {
      await response.arrayBuffer();
      if (this.#token === token) {
        this.#token = null;
        this.#expiresAt = 0;
      }
      response = await this.#fetch(path, {
        ...parameters, token: await this.#getToken(),
      }, method);
    }
    if (!response.ok) {
      throw httpError(502, `LiveGBS 请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  async readPtz(camera) {
    const requestedAt = new Date().toISOString();
    const started = performance.now();
    const response = await this.#request('/api/v1/device/fetchptzposition', camera);
    let raw;
    try {
      raw = await response.json();
    } catch (error) {
      throw responseReadError(error, 'LiveGBS PTZ 响应不是有效 JSON');
    }
    if (!raw || ![raw.Pan, raw.Tilt, raw.Zoom].every(Number.isFinite) || raw.Zoom <= 0) {
      throw httpError(502, 'LiveGBS 返回的 PTZ 数据无效');
    }
    return {
      raw,
      requestedAt,
      receivedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    };
  }

  continuousControl(camera, command, speed = 129) {
    return this.#sendControl('/api/v1/control/ptz', camera, { command, speed });
  }

  preciseControl(camera, target) {
    return this.#sendControl('/api/v1/control/ptzprecise', camera, {
      pan: target.pan, tilt: target.tilt, zoom: target.zoom,
    });
  }

  async #sendControl(path, camera, parameters) {
    const response = await this.#request(path, camera, parameters, 'POST');
    let text;
    try { text = await response.text(); } catch (error) {
      throw responseReadError(error, '无法读取 LiveGBS 控制响应，设备状态请以回读为准');
    }
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (body === false || body?.success === false || body?.error || body?.Error) {
      throw httpError(502, 'LiveGBS 设备返回控制失败');
    }
  }

  async snapshot(camera) {
    const requestedAt = new Date().toISOString();
    const started = performance.now();
    const response = await this.#request('/api/v1/device/channelsnap', camera, { stime: 'now' });
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch (error) {
      throw responseReadError(error, '无法读取 LiveGBS 快照响应');
    }
    return {
      bytes,
      snapshotTime: response.headers.get('channel-snap-time'),
      requestedAt,
      receivedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    };
  }
}
