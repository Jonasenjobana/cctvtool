import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CameraStore } from '../server/store.mjs';
import { fixtureCamera } from './calibration-fixtures.mjs';

test('旧库只读不迁移，应用启动补齐默认参数；保存和重启不污染历史参数副本', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctv-tool-store-test-'));
  t.after(async () => {
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('cctv-tool-store-test-')) {
      throw new Error('数据库测试清理路径超出临时目录');
    }
    await rm(target, { recursive: true, force: true });
  });
  const file = join(dataDir, 'cctv.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE cameras (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, serial TEXT NOT NULL, code TEXT NOT NULL,
    longitude REAL, latitude REAL, height REAL, pAxisPitch REAL NOT NULL, pAxisRoll REAL NOT NULL,
    panOffset REAL NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(serial, code)
  ); CREATE TABLE snapshots (
    id TEXT PRIMARY KEY, cameraId TEXT NOT NULL REFERENCES cameras(id), fileName TEXT NOT NULL,
    createdAt TEXT NOT NULL, metadata TEXT NOT NULL
  );`);
  const { tiltOffset, imageRoll, ...legacyCamera } = fixtureCamera;
  const keys = Object.keys(legacyCamera);
  const insert = db.prepare(`INSERT INTO cameras (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  insert.run(...Object.values(legacyCamera));
  const lockCamera = { ...legacyCamera, id: 'ship-lock', name: '天津船闸', code: 'another-channel' };
  insert.run(...keys.map((key) => lockCamera[key]));
  const original = { id: 'old-snapshot', cameraId: legacyCamera.id, createdAt: '2026-11-09T00:30:00.000Z',
    calibration: { longitude: 113.9, latitude: 22.1, height: 6.6, pAxisPitch: 1, pAxisRoll: 2, panOffset: 93 } };
  const metadata = JSON.stringify(original);
  db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?)').run(original.id, original.cameraId, 'old.jpg', original.createdAt, metadata);
  db.close();
  const readOnly = new CameraStore(dataDir, { readOnly: true });
  try {
    assert.equal(readOnly.getCamera(legacyCamera.id).tiltOffset, 0);
    assert.equal(readOnly.getCamera(legacyCamera.id).maxZoom, 73);
    assert.equal(readOnly.getCamera(lockCamera.id).maxZoom, 32);
    assert.equal(readOnly.listCameraSummaries()[0].imageRoll, 0);
    assert.equal(readOnly.getSnapshot(original.id).calibration.tiltOffset, 0);
    assert.ok(!readOnly.db.prepare('PRAGMA table_info(cameras)').all().some(column => column.name === 'tiltOffset'));
    assert.ok(!readOnly.db.prepare('PRAGMA table_info(cameras)').all().some(column => column.name === 'maxZoom'));
  } finally { readOnly.close(); }
  let store = new CameraStore(dataDir);
  try {
    const camera = store.getCamera(legacyCamera.id);
    assert.deepEqual(camera, { tiltOffset: 0, imageRoll: 0, maxZoom: 73, ...legacyCamera });
    assert.equal(store.getCamera(lockCamera.id).maxZoom, 32);
    store.saveCamera({ ...camera, tiltOffset: 1.64, imageRoll: 0.73, maxZoom: 45.5 }, camera.id);
    store.saveCamera({ ...store.getCamera(lockCamera.id), maxZoom: 28 }, lockCamera.id);
  } finally { store.close(); }
  store = new CameraStore(dataDir);
  try {
    assert.equal(store.getCamera(legacyCamera.id).tiltOffset, 1.64);
    assert.equal(store.listCameras()[0].imageRoll, 0.73);
    assert.equal(store.getCamera(legacyCamera.id).maxZoom, 45.5);
    assert.equal(store.getCamera(lockCamera.id).maxZoom, 28);
    const history = store.getSnapshot(original.id);
    assert.deepEqual(history.calibration, { tiltOffset: 0, imageRoll: 0, ...original.calibration });
    assert.equal(store.listSnapshots(legacyCamera.id)[0].calibration.imageRoll, 0);
    assert.equal(store.querySnapshots(legacyCamera.id, { startTime: '2026-11-09T00:00:00Z', endTime: '2026-11-09T01:00:00Z' }).snapshots[0].calibration.tiltOffset, 0);
    assert.equal(store.db.prepare('SELECT metadata FROM snapshots WHERE id = ?').get(original.id).metadata, metadata);
  } finally { store.close(); }
});
