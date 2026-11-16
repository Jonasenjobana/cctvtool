import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CameraStore, calibrationOf } from '../server/store.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/init-db.mjs', import.meta.url));
const cameras = JSON.parse(readFileSync(new URL('../scripts/initial-cameras.json', import.meta.url), 'utf8'));

async function temporaryDataDir(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-init-db-test-'));
  t.after(async () => {
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-init-db-test-')) {
      throw new Error('初始化测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  return dataDir;
}

function initialize(dataDir) {
  return spawnSync(process.execPath, ['--env-file-if-exists=.env', script], {
    cwd: projectDir, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true,
  });
}

test('初始化空目录，完整保留摄像头标识、安装参数精度与时间，仅导入设备配置', async (t) => {
  const dataDir = await temporaryDataDir(t);
  const result = initialize(dataDir);
  assert.equal(result.status, 0, result.stderr);
  const store = new CameraStore(dataDir, { readOnly: true });
  try {
    assert.deepEqual(store.listCameras(), cameras);
    for (const table of ['snapshots', 'snapshot_groups', 'recognition_tasks', 'recognition_items', 'plot_layers', 'plot_layer_cameras']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, 0);
    }
  } finally { store.close(); }
});

test('重复初始化按设备通道跳过，保留已有不同 ID 的摄像头、后续标定、额外设备与历史截图', async (t) => {
  const dataDir = await temporaryDataDir(t);
  let store = new CameraStore(dataDir);
  let existing;
  let extra;
  let snapshot;
  try {
    existing = store.saveCamera({ ...cameras[0], name: '已有设备', pAxisPitch: 5.25, tiltOffset: -1.5, imageRoll: 2.75 });
    extra = store.saveCamera({ ...cameras[0], name: '额外设备', serial: 'extra-device', code: 'extra-channel' });
    snapshot = { id: 'existing-snapshot', cameraId: existing.id, fileName: 'existing.jpg',
      createdAt: existing.createdAt, calibration: calibrationOf(existing) };
    store.addSnapshot(snapshot);
  } finally { store.close(); }

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = initialize(dataDir);
    assert.equal(result.status, 0, result.stderr);
  }
  store = new CameraStore(dataDir, { readOnly: true });
  try {
    assert.equal(store.listCameras().length, cameras.length + 1);
    assert.deepEqual(store.getCamera(existing.id), existing);
    assert.deepEqual(store.getCamera(extra.id), extra);
    assert.deepEqual(store.getSnapshot(snapshot.id), snapshot);
    for (const camera of cameras.slice(1)) assert.deepEqual(store.getCamera(camera.id), camera);
  } finally { store.close(); }
});

test('ID 与不同设备冲突时报告失败并回滚本次全部摄像头写入', async (t) => {
  const dataDir = await temporaryDataDir(t);
  let store = new CameraStore(dataDir);
  const conflictingId = cameras.at(-1).id;
  let previous;
  try {
    const existing = store.saveCamera({ ...cameras.at(-1), serial: 'different-device', code: 'different-channel' });
    store.db.prepare('UPDATE cameras SET id = ? WHERE id = ?').run(conflictingId, existing.id);
    previous = store.listCameras();
  } finally { store.close(); }

  const result = initialize(dataDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNIQUE constraint failed: cameras\.id/);
  store = new CameraStore(dataDir, { readOnly: true });
  try {
    assert.deepEqual(store.listCameras(), previous);
  } finally { store.close(); }
});
