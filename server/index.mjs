import { createApp } from './app.mjs';

const app = await createApp();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
try {
  const address = await app.listen({ host, port });
  console.log(`云台调试服务：${address}`);
} catch (error) {
  console.error('服务启动失败', error.message);
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await app.close(); });
}
