import Fastify from 'fastify';
import { createMcpHandler, validateHostHeader } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createHash, timingSafeEqual } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createCalibrationMcp } from './calibration-mcp.mjs';

export function mcpHostnames() {
  const addresses = Object.values(networkInterfaces()).flat().filter(Boolean)
    .map((address) => address.family === 'IPv6' ? `[${address.address}]` : address.address);
  return [...new Set(['localhost', '127.0.0.1', '[::1]', hostname().toLowerCase(), ...addresses])];
}

export async function createMcpHttpApp({ dataDir, apiKey, allowedHosts = mcpHostnames(), allowedOrigins = [] }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('请在 .env 中配置 MCP_API_KEY');
  accessSync(join(dataDir, 'cctv.sqlite'), constants.R_OK);
  const keyHash = createHash('sha256').update(apiKey.trim()).digest();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const handler = createMcpHandler(() => createCalibrationMcp(dataDir), {
    legacy: 'stateless',
    onerror: (error) => console.error('MCP 协议处理失败', error.message),
  });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => console.error('MCP HTTP 适配失败', error.message) });
  app.addHook('preClose', async () => { await handler.close(); });

  app.addHook('onRequest', async (request, reply) => {
    if (!validateHostHeader(request.headers.host, allowedHosts).ok) {
      return reply.code(403).send({ message: 'MCP Host 不在允许列表中' });
    }
    const origin = request.headers.origin;
    if (origin) {
      let validOrigin = false;
      try {
        const parsed = new URL(origin);
        validOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && allowedOrigins.includes(origin);
      } catch { /* 无法解析的来源不能访问 MCP。 */ }
      if (!validOrigin) return reply.code(403).send({ message: 'MCP Origin 不在允许列表中' });
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name, Last-Event-ID')
        .header('Access-Control-Expose-Headers', 'MCP-Protocol-Version, MCP-Session-Id, WWW-Authenticate');
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
    if (request.url.split('?')[0] === '/mcp') {
      const supplied = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization || '')?.[1] || '';
      const suppliedHash = createHash('sha256').update(supplied).digest();
      if (!timingSafeEqual(keyHash, suppliedHash)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer realm="cctv-mcp"')
          .send({ message: '请提供有效的 Authorization: Bearer 访问密钥' });
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok', service: 'cctv-tilt-calibration', transport: 'streamable-http', readOnly: true }));
  app.options('/mcp', async (_request, reply) => reply.code(204).send());
  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp',
    handler: async (request, reply) => {
      // Fastify 已解析 JSON；由官方 Node 适配器管理协议响应和流。
      reply.hijack();
      try { await nodeHandler(request.raw, reply.raw, request.body); } catch (error) {
        console.error('MCP HTTP 请求失败', error);
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          reply.raw.end(JSON.stringify({ message: 'MCP 请求处理失败，请检查服务日志' }));
        } else reply.raw.destroy();
      }
    },
  });
  return app;
}
