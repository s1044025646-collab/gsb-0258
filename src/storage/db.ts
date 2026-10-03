import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NodeInput } from '../core/ring.js';
import { fail } from '../core/errors.js';

export interface VersionRow {
  id: number;
  ring_id: number;
  version: number;
  label: string | null;
  nodes_json: string;
  created_at: string;
}

export interface ReportRow {
  id: number;
  ring_id: number;
  old_version: number;
  new_version: number;
  payload_json: string;
  created_at: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS rings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  label TEXT,
  nodes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ring_id, version)
);
CREATE TABLE IF NOT EXISTS sample_keys (
  ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ring_id, key)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
  old_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_ring ON versions(ring_id, version);
CREATE INDEX IF NOT EXISTS idx_reports_ring ON reports(ring_id, created_at);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

 // ---- rings ----

  createRing(name: string, createdAt: string): number {
    try {
      const r = this.db
        .prepare('INSERT INTO rings (name, created_at) VALUES (?, ?)')
        .run(name, createdAt);
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (isUniqueError(e)) fail('DUPLICATE_RING', `环名称已存在: ${name}`, 'name');
      throw e;
    }
  }

  getRingByName(name: string): { id: number; name: string; created_at: string } {
    const row = this.db.prepare('SELECT id, name, created_at FROM rings WHERE name = ?').get(name) as
      | { id: number; name: string; created_at: string }
      | undefined;
    if (!row) fail('RING_NOT_FOUND', `环不存在: ${name}`);
    return row;
  }

  listRings() {
    return this.db.prepare('SELECT id, name, created_at FROM rings ORDER BY id').all() as Array<{
      id: number;
      name: string;
      created_at: string;
    }>;
  }

  // ---- versions (immutable snapshots) ----

  addVersion(
    ringId: number,
    version: number,
    nodes: NodeInput[],
    label: string | null,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO versions (ring_id, version, label, nodes_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ringId, version, label, JSON.stringify(nodes), createdAt);
  }

  latestVersion(ringId: number): VersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM versions WHERE ring_id = ? ORDER BY version DESC LIMIT 1')
      .get(ringId) as VersionRow | undefined;
  }

  getVersion(ringId: number, version: number): VersionRow {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE ring_id = ? AND version = ?')
      .get(ringId, version) as VersionRow | undefined;
    if (!row) fail('VERSION_NOT_FOUND', `版本不存在: v${version}`);
    return row;
  }

  listVersions(ringId: number): VersionRow[] {
    return this.db
      .prepare('SELECT * FROM versions WHERE ring_id = ? ORDER BY version')
      .all(ringId) as unknown as VersionRow[];
  }

  parseNodes(row: VersionRow): NodeInput[] {
    return JSON.parse(row.nodes_json) as NodeInput[];
  }

  // ---- sample keys ----

  addKeys(ringId: number, keys: string[], createdAt: string): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO sample_keys (ring_id, key, created_at) VALUES (?, ?, ?)',
    );
    let added = 0;
    for (const key of keys) {
      const r = stmt.run(ringId, key, createdAt);
      added += Number(r.changes);
    }
    return added;
  }

  listKeys(ringId: number): string[] {
    const rows = this.db
      .prepare('SELECT key FROM sample_keys WHERE ring_id = ? ORDER BY key')
      .all(ringId) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  // ---- reports (immutable snapshots) ----

  saveReport(
    ringId: number,
    oldVersion: number,
    newVersion: number,
    payload: unknown,
    createdAt: string,
  ): number {
    const r = this.db
      .prepare(
        'INSERT INTO reports (ring_id, old_version, new_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ringId, oldVersion, newVersion, JSON.stringify(payload), createdAt);
    return Number(r.lastInsertRowid);
  }

  listReports(ringId: number): Array<{
    id: number;
    old_version: number;
    new_version: number;
    created_at: string;
  }> {
    return this.db
      .prepare(
        'SELECT id, old_version, new_version, created_at FROM reports WHERE ring_id = ? ORDER BY id',
      )
      .all(ringId) as Array<{
      id: number;
      old_version: number;
      new_version: number;
      created_at: string;
    }>;
  }

  getReport(reportId: number): ReportRow {
    const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as
      | ReportRow
      | undefined;
    if (!row) fail('REPORT_NOT_FOUND', `报告不存在: #${reportId}`);
    return row;
  }

  // ---- export ----

  exportRing(name: string) {
    const ring = this.getRingByName(name);
    const versions = this.listVersions(ring.id);
    return {
      ring,
      versions: versions.map((v) => ({
        version: v.version,
        label: v.label,
        nodes: this.parseNodes(v),
        createdAt: v.created_at,
      })),
      sampleKeys: this.listKeys(ring.id),
      reports: this.listReports(ring.id).map((r) => ({
        id: r.id,
        oldVersion: r.old_version,
        newVersion: r.new_version,
        createdAt: r.created_at,
        payload: JSON.parse(this.getReport(r.id).payload_json),
      })),
      exportedAt: new Date().toISOString(),
    };
  }
}

function isUniqueError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: string; message?: string };
  return (
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed'))
  );
}
