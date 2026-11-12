import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalibrationMcp } from './calibration-mcp.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(projectDir, process.env.DATA_DIR || 'data');
const handle = serveStdio(() => createCalibrationMcp(dataDir), {
  onerror: (error) => console.error('截图标定 MCP 连接失败', error.message),
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void handle.close(); });
