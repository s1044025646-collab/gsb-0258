import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RingRow {
  id: number;
  name: string;
  created_at: string;
}

export interface VersionRow {
  id: number;
  ring_id: number;
  version: number;
  nodes_json: string;
  created_at: string;
  note: string | null;
}

export interface KeyRow {
  id: number;
  ring_id: number;
  key: string;
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

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      nodes_json TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ring_id, version)
    );
    CREATE TABLE IF NOT EXISTS sample_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ring_id, key)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ring_id INTEGER NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
      old_version INTEGER NOT NULL,
      new_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function insertRing(db: DatabaseSync, name: string): number {
  const result = db.prepare('INSERT INTO rings (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

export function getRingByName(db: DatabaseSync, name: string): RingRow | undefined {
  return db.prepare('SELECT * FROM rings WHERE name = ?').get(name) as RingRow | undefined;
}

export function getRingById(db: DatabaseSync, id: number): RingRow | undefined {
  return db.prepare('SELECT * FROM rings WHERE id = ?').get(id) as RingRow | undefined;
}

export function listRings(db: DatabaseSync): RingRow[] {
  return db.prepare('SELECT * FROM rings ORDER BY id').all() as unknown as RingRow[];
}

export function latestVersionNumber(db: DatabaseSync, ringId: number): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM versions WHERE ring_id = ?')
    .get(ringId) as { v: number | null };
  return row.v ?? 0;
}

export function insertVersion(
  db: DatabaseSync,
  ringId: number,
  version: number,
  nodesJson: string,
  note: string | null,
): number {
  const result = db
    .prepare('INSERT INTO versions (ring_id, version, nodes_json, note) VALUES (?, ?, ?, ?)')
    .run(ringId, version, nodesJson, note);
  return Number(result.lastInsertRowid);
}

export function getVersion(db: DatabaseSync, ringId: number, version: number): VersionRow | undefined {
  return db
    .prepare('SELECT * FROM versions WHERE ring_id = ? AND version = ?')
    .get(ringId, version) as VersionRow | undefined;
}

export function listVersions(db: DatabaseSync, ringId: number): VersionRow[] {
  return db
    .prepare('SELECT * FROM versions WHERE ring_id = ? ORDER BY version')
    .all(ringId) as unknown as VersionRow[];
}

export function addSampleKey(db: DatabaseSync, ringId: number, key: string): void {
  db.prepare('INSERT INTO sample_keys (ring_id, key) VALUES (?, ?)').run(ringId, key);
}

export function listSampleKeys(db: DatabaseSync, ringId: number): string[] {
  const rows = db
    .prepare('SELECT key FROM sample_keys WHERE ring_id = ? ORDER BY id')
    .all(ringId) as unknown as KeyRow[];
  return rows.map((r) => r.key);
}

export function insertReport(
  db: DatabaseSync,
  ringId: number,
  oldVersion: number,
  newVersion: number,
  payloadJson: string,
): number {
  const result = db
    .prepare(
      'INSERT INTO reports (ring_id, old_version, new_version, payload_json) VALUES (?, ?, ?, ?)',
    )
    .run(ringId, oldVersion, newVersion, payloadJson);
  return Number(result.lastInsertRowid);
}

export function getReport(db: DatabaseSync, ringId: number, reportId: number): ReportRow | undefined {
  return db
    .prepare('SELECT * FROM reports WHERE ring_id = ? AND id = ?')
    .get(ringId, reportId) as ReportRow | undefined;
}

export function listReports(db: DatabaseSync, ringId: number): ReportRow[] {
  return db
    .prepare('SELECT id, ring_id, old_version, new_version, created_at FROM reports WHERE ring_id = ? ORDER BY id')
    .all(ringId) as unknown as ReportRow[];
}
