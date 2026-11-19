import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from './errors.mjs';

export const calibrationKeys = ['longitude', 'latitude', 'height', 'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'];
const cameraKeys = ['name', 'serial', 'code', 'maxZoom', ...calibrationKeys];
const zeroCorrections = { tiltOffset: 0, imageRoll: 0 };
const plotLayerColumns = 'id, name, sourceFileName, byteLength, featureCount, geometryTypes, createdAt, updatedAt';

const defaultMaxZoom = (name) => name === '天津船闸' ? 32 : 73;
function cameraRecord({ zeroPose, activeCalibration, ...row }) {
  const { calibrationModel, activeZeroPose } = activeCalibration ? JSON.parse(activeCalibration) : {};
  return { ...zeroCorrections, maxZoom: defaultMaxZoom(row.name), ...row,
    ...(zeroPose ? { zeroPose: JSON.parse(zeroPose) } : {}),
    ...(calibrationModel ? { calibrationModel, activeZeroPose } : {}) };
}

function snapshotRecord(row) {
  const snapshot = JSON.parse(row.metadata);
  // 历史样本按当时的零修正模型恢复，不套用当前设备后来保存的补偿。
  return { ...snapshot, calibration: { ...zeroCorrections, ...snapshot.calibration } };
}

export function legacyCalibrationOf(camera) {
  return Object.fromEntries(calibrationKeys.map((key) => [key, camera[key]]));
}

export function calibrationOf(camera) {
  const { calibrationModel, activeZeroPose } = camera;
  return { ...legacyCalibrationOf(camera), ...(calibrationModel ? { calibrationModel, activeZeroPose } : {}) };
}

export class CameraStore {
  constructor(dataDir, { readOnly = false } = {}) {
    this.snapshotDirectory = resolve(dataDir, 'snapshots');
    if (!readOnly) mkdirSync(this.snapshotDirectory, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'cctv.sqlite'), { readOnly });
    if (!readOnly) {
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cameras (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, serial TEXT NOT NULL, code TEXT NOT NULL,
        maxZoom REAL NOT NULL DEFAULT 73,
        longitude REAL, latitude REAL, height REAL,
        pAxisPitch REAL NOT NULL, pAxisRoll REAL NOT NULL, panOffset REAL NOT NULL,
        tiltOffset REAL NOT NULL DEFAULT 0, imageRoll REAL NOT NULL DEFAULT 0,
        zeroPose TEXT, activeCalibration TEXT,
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
      CREATE INDEX IF NOT EXISTS recognition_tasks_page_version ON recognition_tasks(id,
        json_extract(metadata, '$.revision'), json_extract(metadata, '$.updatedAt'),
        json_extract(metadata, '$.status'), json_extract(metadata, '$.sampleCount'));
      CREATE TABLE IF NOT EXISTS recognition_items (
        taskId TEXT NOT NULL REFERENCES recognition_tasks(id), snapshotId TEXT NOT NULL,
        position INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(taskId, snapshotId)
      );
      CREATE INDEX IF NOT EXISTS recognition_items_position ON recognition_items(taskId, position);
      CREATE TABLE IF NOT EXISTS recognition_panorama_guides (
        taskId TEXT PRIMARY KEY REFERENCES recognition_tasks(id), guide TEXT,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plot_layers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, sourceFileName TEXT NOT NULL, geojsonText TEXT NOT NULL,
        byteLength INTEGER NOT NULL, featureCount INTEGER NOT NULL, geometryTypes TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plot_layer_cameras (
        layerId TEXT NOT NULL REFERENCES plot_layers(id) ON DELETE CASCADE,
        cameraId TEXT NOT NULL REFERENCES cameras(id), visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
        PRIMARY KEY(layerId, cameraId)
      );
    `);
      const columns = new Set(this.db.prepare('PRAGMA table_info(cameras)').all().map((column) => column.name));
      const missing = Object.keys(zeroCorrections).filter((key) => !columns.has(key));
      if (missing.length || !columns.has('maxZoom') || !columns.has('zeroPose') || !columns.has('activeCalibration')) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const key of missing) this.db.exec(`ALTER TABLE cameras ADD COLUMN ${key} REAL NOT NULL DEFAULT 0`);
          if (!columns.has('maxZoom')) {
            this.db.exec('ALTER TABLE cameras ADD COLUMN maxZoom REAL NOT NULL DEFAULT 73');
            this.db.prepare('UPDATE cameras SET maxZoom = 32 WHERE name = ?').run('天津船闸');
          }
          if (!columns.has('zeroPose')) this.db.exec('ALTER TABLE cameras ADD COLUMN zeroPose TEXT');
          if (!columns.has('activeCalibration')) this.db.exec('ALTER TABLE cameras ADD COLUMN activeCalibration TEXT');
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

  getCalibrationSource(id) {
    const { source } = this.db.prepare("SELECT json_extract(activeCalibration, '$.source') AS source FROM cameras WHERE id = ?").get(id);
    return source ? JSON.parse(source) : null;
  }

  camerasWithoutCalibrationSource() {
    return this.db.prepare("SELECT * FROM cameras WHERE json_type(activeCalibration, '$.source') IS NULL").all().map(cameraRecord);
  }

  backfillCalibrationSource(id, source) {
    this.db.prepare(`UPDATE cameras SET activeCalibration = json_set(COALESCE(activeCalibration, '{}'), '$.source', json(?))
      WHERE id = ? AND json_type(activeCalibration, '$.source') IS NULL`).run(JSON.stringify(source), id);
  }

  saveCamera(input, id, activeCalibration) {
    const previous = id ? this.getCamera(id) : null;
    if (previous && activeCalibration === undefined && (previous.serial !== input.serial || previous.code !== input.code
      || (!previous.calibrationModel && calibrationKeys.some((key) => previous[key] !== input[key])))) {
      activeCalibration = { source: null };
    }
    const record = { ...input, maxZoom: input.maxZoom ?? previous?.maxZoom ?? defaultMaxZoom(input.name) };
    const values = cameraKeys.map((key) => record[key]);
    const zeroPose = input.zeroPose === undefined ? null : JSON.stringify(input.zeroPose);
    const active = activeCalibration ? JSON.stringify(activeCalibration) : null;
    const now = new Date().toISOString();
    try {
      if (id) {
        this.db.prepare(`UPDATE cameras SET ${cameraKeys.map((key) => `${key} = ?`).join(', ')},
          zeroPose = COALESCE(?, zeroPose), activeCalibration = CASE WHEN ? THEN ? ELSE activeCalibration END,
          updatedAt = ? WHERE id = ?`).run(...values, zeroPose, Number(activeCalibration !== undefined), active, now, id);
      } else {
        id = randomUUID();
        this.db.prepare(`INSERT INTO cameras (id, ${cameraKeys.join(', ')}, zeroPose, activeCalibration, createdAt, updatedAt)
          VALUES (${Array(cameraKeys.length + 5).fill('?').join(', ')})`).run(id, ...values, zeroPose, active, now, now);
      }
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) throw httpError(409, '该设备通道已注册');
      throw error;
    }
    return this.getCamera(id);
  }

  plotLayerRecord(row) {
    return { ...row, geometryTypes: JSON.parse(row.geometryTypes),
      associations: this.db.prepare('SELECT cameraId, visible FROM plot_layer_cameras WHERE layerId = ? ORDER BY cameraId')
        .all(row.id).map((association) => ({ ...association, visible: Boolean(association.visible) })) };
  }

  listPlotLayers() {
    return this.db.prepare(`SELECT ${plotLayerColumns} FROM plot_layers ORDER BY createdAt, id`).all()
      .map((row) => this.plotLayerRecord(row));
  }

  getPlotLayer(id) {
    const row = this.db.prepare('SELECT * FROM plot_layers WHERE id = ?').get(id);
    if (!row) throw httpError(404, '标绘图层不存在');
    return this.plotLayerRecord(row);
  }

  importPlotLayer(input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      const cameraIds = [...new Set(input.cameraIds)];
      for (const cameraId of cameraIds) this.getCamera(cameraId);
      this.db.prepare(`INSERT INTO plot_layers (${plotLayerColumns}, geojsonText) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.sourceFileName, input.byteLength, input.featureCount,
          JSON.stringify(input.geometryTypes), now, now, input.geojsonText);
      const associate = this.db.prepare('INSERT INTO plot_layer_cameras (layerId, cameraId, visible) VALUES (?, ?, 1)');
      for (const cameraId of cameraIds) associate.run(id, cameraId);
    });
    return this.getPlotLayer(id);
  }

  setPlotLayerVisibility(id, cameraId, visible) {
    this.transaction(() => {
      this.getPlotLayer(id);
      this.getCamera(cameraId);
      const changed = this.db.prepare('UPDATE plot_layer_cameras SET visible = ? WHERE layerId = ? AND cameraId = ?')
        .run(Number(visible), id, cameraId).changes;
      if (!changed) throw httpError(404, '该摄像头未关联此标绘图层');
      this.db.prepare('UPDATE plot_layers SET updatedAt = ? WHERE id = ?').run(new Date().toISOString(), id);
    });
    return { cameraId, visible };
  }

  savePlotLayer(id, input) {
    this.transaction(() => {
      const previous = this.getPlotLayer(id);
      const cameraIds = new Set(input.cameraIds);
      for (const cameraId of cameraIds) this.getCamera(cameraId);
      this.db.prepare('UPDATE plot_layers SET name = ?, updatedAt = ? WHERE id = ?')
        .run(input.name, new Date().toISOString(), id);
      const detach = this.db.prepare('DELETE FROM plot_layer_cameras WHERE layerId = ? AND cameraId = ?');
      for (const association of previous.associations) {
        if (!cameraIds.has(association.cameraId)) detach.run(id, association.cameraId);
      }
      const associate = this.db.prepare('INSERT OR IGNORE INTO plot_layer_cameras (layerId, cameraId, visible) VALUES (?, ?, 1)');
      for (const cameraId of cameraIds) associate.run(id, cameraId);
    });
    const { geojsonText, ...summary } = this.getPlotLayer(id);
    return summary;
  }

  deletePlotLayer(id) {
    this.getPlotLayer(id);
    this.db.prepare('DELETE FROM plot_layers WHERE id = ?').run(id);
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

  hasSnapshotImage(snapshot) {
    if (!snapshot.fileName) return false;
    const path = resolve(this.snapshotDirectory, snapshot.fileName);
    return dirname(path) === this.snapshotDirectory && !!statSync(path, { throwIfNoEntry: false })?.isFile();
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

  getRecognitionTaskVersion(id) {
    // 页间比对只读索引里的版本字段，避免每页重新载入候选诊断和参与图名单。
    const row = this.db.prepare(`SELECT id, json_extract(metadata, '$.revision') AS revision,
      json_extract(metadata, '$.updatedAt') AS updatedAt, json_extract(metadata, '$.status') AS status,
      json_extract(metadata, '$.sampleCount') AS sampleCount FROM recognition_tasks INDEXED BY recognition_tasks_page_version
      WHERE id = ?`).get(id);
    if (!row) throw httpError(404, '识别任务不存在');
    return row;
  }

  getRecognitionPanoramaGuide(id) {
    this.getRecognitionTask(id);
    const row = this.db.prepare('SELECT guide, revision FROM recognition_panorama_guides WHERE taskId = ?').get(id);
    return row ? { guide: JSON.parse(row.guide), revision: row.revision } : { guide: null, revision: 0 };
  }

  saveRecognitionPanoramaGuide(id, revision, guide) {
    return this.transaction(() => {
      const previous = this.getRecognitionPanoramaGuide(id);
      if (previous.revision !== revision) throw httpError(409, '全景参考线已被修改，请刷新后重试');
      const state = { guide, revision: revision + 1 };
      // 删除也保留版本，阻止旧草稿在删除后重新覆盖参考线。
      this.db.prepare(`INSERT INTO recognition_panorama_guides (taskId, guide, revision) VALUES (?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET guide = excluded.guide, revision = excluded.revision`)
        .run(id, JSON.stringify(guide), state.revision);
      return state;
    });
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

  listAppliedRecognitionTasks(cameraId) {
    return this.db.prepare(`SELECT metadata FROM recognition_tasks WHERE cameraId = ? AND
      (json_extract(metadata, '$.result.applied') = 1 OR json_extract(metadata, '$.refinement.applied') = 1
        OR json_extract(metadata, '$.zeroPoseCandidate.applied') = 1)
      ORDER BY createdAt DESC, id DESC`).all(cameraId).map(({ metadata }) => JSON.parse(metadata));
  }

  recognitionItems(id, { limit = -1, offset = 0, snapshotIds } = {}) {
    const bySnapshotIds = snapshotIds ? 'AND r.snapshotId IN (SELECT value FROM json_each(?))' : '';
    // 条目位置连续且不可编辑，原图删除也保留条目，可按位置直接定位分页起点。
    return this.db.prepare(`SELECT r.metadata, s.id AS sourceId FROM recognition_items r
      LEFT JOIN snapshots s ON s.id = r.snapshotId WHERE r.taskId = ? AND r.position >= ? ${bySnapshotIds} ORDER BY r.position LIMIT ?`)
      .all(id, offset, ...(snapshotIds ? [JSON.stringify(snapshotIds)] : []), limit)
      .map((row) => ({ ...JSON.parse(row.metadata), missing: !row.sourceId }));
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
