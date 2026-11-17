import { vesselProject } from './project.mjs';
import { decodeSeaoilAis } from './seaoil-ais.mjs';
import { httpError } from './errors.mjs';

class VesselSource {
  constructor(config, { connect, now }) {
    if (config.adapter !== 'seaoil-ais') throw new Error(`未知船舶数据适配器：${config.adapter}`);
    this.config = config;
    this.connect = connect;
    this.now = now;
    this.targets = new Map();
    this.status = 'idle';
    this.error = null;
    this.receivedAt = null;
    this.socket = null;
    this.closed = false;
    this.retryDelay = config.reconnectDelayMs ?? 2000;
    this.retryTimer = null;
    this.connectTimer = null;
    this.idleTimer = null;
    this.notifyTimer = null;
    this.maintenance = null;
    this.listeners = new Set();
  }

  start() {
    if (this.socket || this.closed || this.retryTimer) return;
    this.status = 'connecting';
    if (!this.maintenance) {
      this.maintenance = setInterval(() => { if (this.prune()) this.notify(); }, 5000);
      this.maintenance.unref();
    }
    let socket;
    try { socket = this.connect(this.config.url); }
    catch { this.disconnect(null, 'AIS 来源连接失败，正在重连'); return; }
    this.socket = socket;
    this.connectTimer = setTimeout(() => this.disconnect(socket, 'AIS 来源连接超时，正在重连'), this.config.connectTimeoutMs ?? 10000);
    this.connectTimer.unref();
    socket.addEventListener('open', () => {
      if (this.closed || this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.status = 'connected';
      this.error = null;
      this.retryDelay = this.config.reconnectDelayMs ?? 2000;
      this.watchIdle(socket);
      this.notify();
    });
    socket.addEventListener('close', () => this.disconnect(socket, 'AIS 来源已断开，正在重连'));
    socket.addEventListener('error', () => this.disconnect(socket, 'AIS 来源连接异常，正在重连'));
    socket.addEventListener('message', event => {
      if (this.closed || this.socket !== socket) return;
      this.watchIdle(socket);
      this.receivedAt = new Date(this.now()).toISOString();
      try {
        const batch = decodeSeaoilAis(JSON.parse(event.data), this.config);
        if (!batch) { this.notify(); return; }
        this.prune();
        for (const target of batch.targets) {
          const age = this.now() - Date.parse(target.time);
          if (age < -60000) { batch.invalidCount++; continue; }
          if (age >= this.config.expireAfterMs) continue;
          const previous = this.targets.get(target.mmsi);
          if (!previous || target.time >= previous.time) {
            // 此来源会将缺失船艏误报为 0，仅沿用同船尚未过期的船艏。
            if (target.heading === 0) target.heading = previous?.heading ?? null;
            this.targets.set(target.mmsi, target);
          }
        }
        this.error = batch.invalidCount ? `跳过 ${batch.invalidCount} 条无效 AIS 记录` : null;
      } catch (error) { this.error = error instanceof SyntaxError ? 'AIS 来源返回了无效 JSON' : error.message; }
      this.notify();
    });
  }

  watchIdle(socket) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(socket, 'AIS 来源长时间无消息，正在重连'), this.config.idleTimeoutMs ?? 90000);
    this.idleTimer.unref();
  }

  disconnect(socket, message) {
    if (this.closed || this.socket !== socket) return;
    this.socket = null;
    clearTimeout(this.connectTimer);
    clearTimeout(this.idleTimer);
    this.targets.clear();
    this.status = 'reconnecting';
    this.error = message;
    if (socket && socket.readyState < 2) socket.close();
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start(); }, this.retryDelay);
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    this.notify();
  }

  prune() {
    let changed = false;
    for (const [mmsi, target] of this.targets) {
      if (this.now() - Date.parse(target.time) >= this.config.expireAfterMs) { this.targets.delete(mmsi); changed = true; }
    }
    return changed;
  }

  notify() {
    if (this.closed || !this.listeners.size || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    }, 250);
    this.notifyTimer.unref();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    this.start();
    this.prune();
    return { sourceId: this.config.id, status: this.status, error: this.error,
      receivedAt: this.receivedAt, targets: [...this.targets.values()] };
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.notifyTimer);
    clearInterval(this.maintenance);
    this.listeners.clear();
    this.socket?.close();
    this.targets.clear();
  }
}

export function registerVesselSourceRoutes(app, {
  project = vesselProject, connect = url => new WebSocket(url), now = Date.now,
} = {}) {
  const sources = new Map(project.sources.map(config => [config.id, new VesselSource(config, { connect, now })]));
  const clients = new Set();
  app.addHook('preClose', async () => { for (const close of clients) close(); });
  app.addHook('onClose', async () => { for (const source of sources.values()) source.close(); });
  app.get('/api/data-sources', async () => ({
    project: { id: project.id, name: project.name },
    sources: project.sources.map(({ id, name, geometry, maxDistanceMeters, expireAfterMs }) => ({
      id, name, type: 'ais', geometry, maxDistanceMeters, expireAfterMs,
    })),
  }));
  app.get('/api/data-sources/:id/snapshot', async request => {
    const source = sources.get(request.params.id);
    if (!source) throw httpError(404, '数据源不存在');
    return source.snapshot();
  });
  app.get('/api/data-sources/:id/events', (request, reply) => {
    const source = sources.get(request.params.id);
    if (!source) throw httpError(404, '数据源不存在');
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let pending = null;
    let ended = false;
    // 完整快照允许替换待发消息；慢客户端最多额外保留一份最新状态。
    const send = snapshot => {
      if (ended || response.destroyed || response.writableEnded) return;
      const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
      if (response.writableNeedDrain) pending = frame;
      else { pending = null; response.write(frame); }
    };
    const drain = () => { if (!ended && pending) { const frame = pending; pending = null; response.write(frame); } };
    response.on('drain', drain);
    const unsubscribe = source.subscribe(send);
    const heartbeat = setInterval(() => { if (!response.writableNeedDrain && !ended) response.write(': keepalive\n\n'); }, 15000);
    heartbeat.unref();
    const close = () => {
      if (ended) return;
      ended = true;
      pending = null;
      unsubscribe();
      clearInterval(heartbeat);
      response.off('drain', drain);
      clients.delete(close);
      if (!response.destroyed && !response.writableEnded) response.end();
    };
    clients.add(close);
    response.on('close', close);
    response.on('error', close);
    return reply;
  });
}
