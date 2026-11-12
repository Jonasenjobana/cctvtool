import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpApp, mcpHostnames } from './mcp-http-app.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.MCP_HOST || '0.0.0.0';
const port = Number(process.env.MCP_PORT || 3001);
const split = (value) => value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
let app;
try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT 必须为 1～65535 的整数');
  app = await createMcpHttpApp({
    dataDir: resolve(projectDir, process.env.DATA_DIR || 'data'), apiKey: process.env.MCP_API_KEY,
    allowedHosts: [...mcpHostnames(), ...split(process.env.MCP_ALLOWED_HOSTS)],
    allowedOrigins: split(process.env.MCP_ALLOWED_ORIGINS),
  });
  const address = await app.listen({ host, port });
  console.log(`截图标定 MCP 已监听 ${host}:${port}（Streamable HTTP）`);
  console.log(`本机检查：${address}/mcp；局域网客户端使用本机实际 IP。`);
  console.log('访问需携带 Authorization: Bearer <MCP_API_KEY>');
} catch (error) {
  console.error('MCP HTTP 启动失败：', error.message);
  if (app) await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (app) await app.close(); });
