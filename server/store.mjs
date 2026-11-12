import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from './errors.mjs';

export const calibrationKeys = ['longitude', 'latitude', 'height', 'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'];
const cameraKeys = ['name', 'serial', 'code', ...calibrationKeys];
const zeroCorrections = { tiltOffset: 0, imageRoll: 0 };

function cameraRecord(row) { return { ...zeroCorrections, ...row }; }

function snapshotRecord(row) {
  const snapshot = JSON.parse(row.metadata);
  // 历史样本按当时的零修正模型恢复，不套用当前设备后来保存的补偿。
  return { ...snapshot, calibration: { ...zeroCorrections, ...snapshot.calibration } };
}

export function calibrationOf(camera) {
  return Object.fromEntries(calibrationKeys.map((key) => [key, camera[key]]));
}

export class CameraStore {
  constructor(dataDir, { readOnly = false } = {}) {
    if (!readOnly) mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'cctv.sqlite'), { readOnly });
    if (!readOnly) {
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cameras (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, serial TEXT NOT NULL, code TEXT NOT NULL,
        longitude REAL, latitude REAL, height REAL,
        pAxisPitch REAL NOT NULL, pAxisRoll REAL NOT NULL, panOffset REAL NOT NULL,
        tiltOffset REAL NOT NULL DEFAULT 0, imageRoll REAL NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(serial, code)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, cameraId TEXT NOT NULL REFERENCES cameras(id),
        fileName TEXT NOT NULL, createdAt TEXT NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_camera_time ON snapshots(cameraId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS snapshot_groups (
        id TEXT PRIMARY KEY, cameraId TEXT NOT NULL REFERENCES cameras(id),
        createdAt TEXT NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshot_groups_camera_time ON snapshot_groups(cameraId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS recognition_tasks (
        id TEXT PRIMARY KEY, cameraId TEXT NOT NULL REFERENCES cameras(id),
        createdAt TEXT NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recognition_tasks_time ON recognition_tasks(createdAt DESC);
      CREATE TABLE IF NOT EXISTS recognition_items (
        taskId TEXT NOT NULL REFERENCES recognition_tasks(id), snapshotId TEXT NOT NULL,
        position INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(taskId, snapshotId)
      );
    `);
      const columns = new Set(this.db.prepare('PRAGMA table_info(cameras)').all().map((column) => column.name));
      const missing = Object.keys(zeroCorrections).filter((key) => !columns.has(key));
      if (missing.length) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const key of missing) this.db.exec(`ALTER TABLE cameras ADD COLUMN ${key} REAL NOT NULL DEFAULT 0`);
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          this.db.close();
          throw error;
        }
      }
      const snapshotColumns = this.db.prepare('PRAGMA table_info(snapshots)').all();
      if (!snapshotColumns.some((column) => column.name === 'groupId')) {
        this.db.exec('ALTER TABLE snapshots ADD COLUMN groupId TEXT REFERENCES snapshot_groups(id)');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS snapshots_group_time ON snapshots(groupId, createdAt, id)');
    }
    this.groupedSnapshots = this.db.prepare('PRAGMA table_info(snapshots)').all().some((column) => column.name === 'groupId');
  }

  listCameras() {
    return this.db.prepare('SELECT * FROM cameras ORDER BY createdAt').all().map(cameraRecord);
  }

  listCameraSummaries() {
    return this.db.prepare(`SELECT c.*, COUNT(s.id) AS snapshotCount,
      MIN(s.createdAt) AS firstSnapshotAt, MAX(s.createdAt) AS lastSnapshotAt
      FROM cameras c LEFT JOIN snapshots s ON s.cameraId = c.id
      GROUP BY c.id ORDER BY c.createdAt`).all().map(cameraRecord);
  }

  querySnapshots(cameraId, { startTime, endTime, limit = 50, offset = 0, groupId }) {
    this.getCamera(cameraId);
    const groupFilter = !groupId ? '' : this.groupedSnapshots
      ? ' AND (groupId = ? OR (groupId IS NULL AND id = ?))' : ' AND id = ?';
    const values = [cameraId, startTime, endTime];
    if (groupId) values.push(...(this.groupedSnapshots ? [groupId, groupId] : [groupId]));
    const where = `cameraId = ? AND createdAt >= ? AND createdAt < ?${groupFilter}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM snapshots WHERE ${where}`).get(...values).total;
    const snapshots = this.db.prepare(`SELECT metadata FROM snapshots
      WHERE ${where}
      ORDER BY createdAt, id LIMIT ? OFFSET ?`)
      .all(...values, limit, offset).map(snapshotRecord);
    return { total, snapshots };
  }

  getCamera(id) {
    const camera = this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!camera) throw httpError(404, '摄像头不存在');
    return cameraRecord(camera);
  }

  saveCamera(input, id) {
    const values = cameraKeys.map((key) => input[key]);
    const now = new Date().toISOString();
    try {
      if (id) {
        this.getCamera(id);
        this.db.prepare(`UPDATE cameras SET ${cameraKeys.map((key) => `${key} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`)
          .run(...values, now, id);
      } else {
        id = randomUUID();
        this.db.prepare(`INSERT INTO cameras (id, ${cameraKeys.join(', ')}, createdAt, updatedAt)
          VALUES (${Array(cameraKeys.length + 3).fill('?').join(', ')})`).run(id, ...values, now, now);
      }
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) throw httpError(409, '该设备通道已注册');
      throw error;
    }
    return this.getCamera(id);
  }

  addSnapshot(snapshot) {
    this.db.exec('SAVEPOINT save_snapshot');
    try {
      this.db.prepare('INSERT INTO snapshots (id, cameraId, fileName, createdAt, metadata, groupId) VALUES (?, ?, ?, ?, ?, ?)')
        .run(snapshot.id, snapshot.cameraId, snapshot.fileName, snapshot.createdAt, JSON.stringify(snapshot), snapshot.groupId ?? null);
      if (snapshot.groupId) {
        this.db.prepare("UPDATE snapshot_groups SET metadata = json_set(metadata, '$.completedCount', ?) WHERE id = ?")
          .run(snapshot.scanIndex + 1, snapshot.groupId);
      }
      this.db.exec('RELEASE save_snapshot');
    } catch (error) {
      this.db.exec('ROLLBACK TO save_snapshot; RELEASE save_snapshot');
      throw error;
    }
  }

  listSnapshots(cameraId) {
    this.getCamera(cameraId);
    return this.db.prepare('SELECT metadata FROM snapshots WHERE cameraId = ? ORDER BY createdAt DESC')
      .all(cameraId).map(snapshotRecord);
  }

  getSnapshot(id) {
    const row = this.db.prepare('SELECT metadata FROM snapshots WHERE id = ?').get(id);
    if (!row) throw httpError(404, '截图不存在');
    return snapshotRecord(row);
  }

  deleteSnapshot(id) {
    this.getSnapshot(id);
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  addSnapshotGroup(group) {
    this.db.prepare('INSERT INTO snapshot_groups (id, cameraId, createdAt, metadata) VALUES (?, ?, ?, ?)')
      .run(group.id, group.cameraId, group.createdAt, JSON.stringify(group));
  }

  updateSnapshotGroup(id, changes) {
    const row = this.db.prepare('SELECT metadata FROM snapshot_groups WHERE id = ?').get(id);
    if (!row) throw httpError(404, '截图分组不存在');
    this.db.prepare('UPDATE snapshot_groups SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.metadata), ...changes }), id);
  }

  interruptSnapshotGroups() {
    this.db.prepare(`UPDATE snapshot_groups SET metadata = json_set(metadata,
      '$.status', 'interrupted', '$.finishedAt', ?, '$.error', '服务已重启，自动截图中断；已保存截图保留')
      WHERE json_extract(metadata, '$.status') IN ('running', 'pausing', 'cancelling')`).run(new Date().toISOString());
  }

  listSnapshotTasks({ cameraId, limit = 30, offset = 0 } = {}) {
    if (cameraId) this.getCamera(cameraId);
    const where = cameraId ? ' WHERE g.cameraId = ?' : '';
    const values = cameraId ? [cameraId] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM snapshot_groups g${where}`).get(...values).total;
    const rows = this.db.prepare(`SELECT g.metadata, 'scan' AS kind,
      (SELECT COUNT(*) FROM snapshots WHERE groupId = g.id) AS snapshotCount,
      (SELECT id FROM snapshots WHERE groupId = g.id ORDER BY createdAt, id LIMIT 1) AS coverId
      FROM snapshot_groups g${where} ORDER BY g.createdAt DESC, g.id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset);
    return { total, groups: rows.map((row) => this.snapshotGroupRecord(row)), offset,
      nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  snapshotGroupRecord(row) {
    if (row.kind === 'scan') return { ...JSON.parse(row.metadata), snapshotCount: row.snapshotCount, coverId: row.coverId };
    const snapshot = snapshotRecord(row);
    return { id: snapshot.id, cameraId: snapshot.cameraId, cameraName: snapshot.cameraName, kind: 'single',
      createdAt: snapshot.createdAt, finishedAt: snapshot.createdAt, status: 'completed',
      sampleCount: 1, completedCount: 1, snapshotCount: 1, coverId: snapshot.id, error: null };
  }

  listSnapshotGroups(cameraId, { limit = 30, offset = 0 } = {}) {
    this.getCamera(cameraId);
    const total = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM snapshot_groups WHERE cameraId = ?) +
      (SELECT COUNT(*) FROM snapshots WHERE cameraId = ? AND groupId IS NULL) AS total`).get(cameraId, cameraId).total;
    const rows = this.db.prepare(`SELECT g.id, g.createdAt, g.metadata, 'scan' AS kind,
      (SELECT COUNT(*) FROM snapshots WHERE groupId = g.id) AS snapshotCount,
      (SELECT id FROM snapshots WHERE groupId = g.id ORDER BY createdAt, id LIMIT 1) AS coverId
      FROM snapshot_groups g WHERE g.cameraId = ?
      UNION ALL
      SELECT id, createdAt, metadata, 'single', 1, id FROM snapshots WHERE cameraId = ? AND groupId IS NULL
      ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`).all(cameraId, cameraId, limit, offset);
    return { total, groups: rows.map((row) => this.snapshotGroupRecord(row)), offset,
      nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  getSnapshotGroup(id) {
    const row = this.db.prepare(`SELECT g.metadata, 'scan' AS kind,
      (SELECT COUNT(*) FROM snapshots WHERE groupId = g.id) AS snapshotCount,
      (SELECT id FROM snapshots WHERE groupId = g.id ORDER BY createdAt, id LIMIT 1) AS coverId
      FROM snapshot_groups g WHERE g.id = ?`).get(id);
    if (row) return this.snapshotGroupRecord(row);
    const snapshot = this.getSnapshot(id);
    if (snapshot.groupId) throw httpError(404, '截图分组不存在');
    return this.snapshotGroupRecord({ kind: 'single', metadata: JSON.stringify(snapshot) });
  }

  listGroupSnapshots(id, { limit = 50, offset = 0 } = {}) {
    const group = this.getSnapshotGroup(id);
    const rows = group.kind === 'single' ? (offset ? [] : [this.getSnapshot(id)])
      : this.db.prepare('SELECT metadata FROM snapshots WHERE groupId = ? ORDER BY createdAt, id LIMIT ? OFFSET ?')
        .all(id, limit, offset).map(snapshotRecord);
    return { group, total: group.snapshotCount, snapshots: rows, offset,
      nextOffset: offset + rows.length < group.snapshotCount ? offset + rows.length : null };
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addRecognitionTask(task, items, associateSource = false) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO recognition_tasks VALUES (?, ?, ?, ?)')
        .run(task.id, task.cameraId, task.createdAt, JSON.stringify(task));
      const insert = this.db.prepare('INSERT INTO recognition_items VALUES (?, ?, ?, ?)');
      items.forEach((item, index) => insert.run(task.id, item.snapshotId, index, JSON.stringify(item)));
      if (associateSource) this.updateSnapshotGroup(task.sourceTaskId, { recognitionTaskId: task.id, recognitionError: null });
    });
  }

  getRecognitionTask(id) {
    const row = this.db.prepare('SELECT metadata FROM recognition_tasks WHERE id = ?').get(id);
    if (!row) throw httpError(404, '识别任务不存在');
    return JSON.parse(row.metadata);
  }

  updateRecognitionTask(id, changes) {
    const task = { ...this.getRecognitionTask(id), ...changes, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE recognition_tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(task), id);
    return task;
  }

  listRecognitionTasks({ limit = 30, offset = 0 } = {}) {
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM recognition_tasks').get().total;
    const tasks = this.db.prepare('SELECT metadata FROM recognition_tasks ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset).map((row) => JSON.parse(row.metadata));
    return { total, tasks, offset, nextOffset: offset + tasks.length < total ? offset + tasks.length : null };
  }

  recognitionItems(id, { limit = -1, offset = 0 } = {}) {
    return this.db.prepare(`SELECT r.metadata, s.id AS sourceId FROM recognition_items r
      LEFT JOIN snapshots s ON s.id = r.snapshotId WHERE r.taskId = ? ORDER BY r.position LIMIT ? OFFSET ?`)
      .all(id, limit, offset).map((row) => ({ ...JSON.parse(row.metadata), missing: !row.sourceId }));
  }

  getRecognitionItem(taskId, snapshotId) {
    const row = this.db.prepare('SELECT metadata FROM recognition_items WHERE taskId = ? AND snapshotId = ?').get(taskId, snapshotId);
    if (!row) throw httpError(404, '该截图不属于识别任务');
    return JSON.parse(row.metadata);
  }

  updateRecognitionItem(taskId, snapshotId, changes) {
    const { missing, ...previous } = this.getRecognitionItem(taskId, snapshotId);
    const item = { ...previous, ...changes };
    this.db.prepare('UPDATE recognition_items SET metadata = ? WHERE taskId = ? AND snapshotId = ?')
      .run(JSON.stringify(item), taskId, snapshotId);
    return item;
  }

  interruptRecognitionTasks() {
    this.db.prepare(`UPDATE recognition_tasks SET metadata = json_set(metadata,
      '$.status', 'interrupted', '$.error', '服务重启，识别已中断，可重新识别', '$.finishedAt', ?)
      WHERE json_extract(metadata, '$.status') IN ('queued', 'running')`).run(new Date().toISOString());
  }

  close() { this.db.close(); }
}
