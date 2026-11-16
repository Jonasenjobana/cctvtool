import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CameraStore, calibrationKeys } from '../server/store.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(projectDir, process.env.DATA_DIR || 'data');
const cameras = JSON.parse(readFileSync(new URL('./initial-cameras.json', import.meta.url), 'utf8'));
const columns = ['id', 'name', 'serial', 'code', 'maxZoom', ...calibrationKeys, 'createdAt', 'updatedAt'];
const store = new CameraStore(dataDir);

try {
  let inserted = 0;
  store.transaction(() => {
    // 已注册的通道保留现有标定，避免重复初始化覆盖后续调整。
    const insert = store.db.prepare(`INSERT INTO cameras (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(serial, code) DO NOTHING`);
    for (const camera of cameras) {
      inserted += insert.run(...columns.map((column) => camera[column])).changes;
    }
  });
  console.log(`数据库初始化完成：新增 ${inserted} 台摄像头，跳过 ${cameras.length - inserted} 台已有通道。`);
  console.log(`数据库：${join(dataDir, 'cctv.sqlite')}`);
} finally {
  store.close();
}
