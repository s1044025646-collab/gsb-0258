import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getReport, listSampleKeys, openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import {
  addKeys,
  compareVersions,
  createEmptyRing,
  createRing,
  evolveRing,
  getVNodes,
  resolveRing,
  routeKey,
  saveReport,
} from '../src/service.js';

function makeSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE rings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, ring_id INTEGER NOT NULL,
      version INTEGER NOT NULL, nodes_json TEXT NOT NULL, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (ring_id, version));
    CREATE TABLE sample_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, ring_id INTEGER NOT NULL,
      key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ring_id, key));
    CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, ring_id INTEGER NOT NULL,
      old_version INTEGER NOT NULL, new_version INTEGER NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  return db;
}

const KEYS = Array.from({ length: 300 }, (_, i) => `k:${i}`);

test('空环建环与定位：v1 为空，路由报 EMPTY_RING，新增节点后可路由', () => {
  const db = makeSchema();
  const { ringId } = createEmptyRing(db, 'empty', null);
  assert.equal(getVNodes(db, ringId, null).vnodes.length, 0);
  assert.throws(
    () => routeKey(db, ringId, 'x', null),
    (e: unknown) => e instanceof AppError && e.code === 'EMPTY_RING',
  );
  evolveRing(db, ringId, { action: 'add', node: 'a', weight: 1 });
  assert.equal(routeKey(db, ringId, 'x', null).node, 'a');
});

test('新增节点：迁移键全部指向新节点，归属总数守恒', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
  ], null);
  addKeys(db, ringId, KEYS);
  evolveRing(db, ringId, { action: 'add', node: 'd', weight: 1 });
  const report = compareVersions(db, ringId, 1, 2, null);

  assert.ok(report.migratedKeys > 0);
  assert.ok(
    report.migrationRatio < 0.6,
    `新增单节点迁移比例应接近 1/4，实际 ${report.migrationRatio}`,
  );
  for (const row of report.keys) {
    if (row.migrated) assert.equal(row.newNode, 'd');
    else assert.equal(row.oldNode, row.newNode);
  }
  const sumOld = Object.values(report.oldDistribution).reduce((a, b) => a + b, 0);
  const sumNew = Object.values(report.newDistribution).reduce((a, b) => a + b, 0);
  assert.equal(sumOld, KEYS.length);
  assert.equal(sumNew, KEYS.length);
  assert.equal(
    report.perNode.reduce((s, n) => s + n.movedOut, 0),
    report.migratedKeys,
  );
  assert.equal(
    report.perNode.reduce((s, n) => s + n.movedIn, 0),
    report.migratedKeys,
  );
  for (const stat of report.perNode) {
    assert.equal(stat.oldCount, stat.stayed + stat.movedOut);
    assert.equal(stat.newCount, stat.stayed + stat.movedIn);
  }
});

test('删除节点：仅被删节点的键迁移，其余完全不动', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
  ], null);
  addKeys(db, ringId, KEYS);
  evolveRing(db, ringId, { action: 'remove', node: 'b' });
  const report = compareVersions(db, ringId, 1, 2, null);
  for (const row of report.keys) {
    if (row.migrated) assert.equal(row.oldNode, 'b');
  }
  assert.ok(report.perNode.find((n) => n.node === 'b')!.movedIn === 0);
  assert.ok(report.perNode.find((n) => n.node === 'a')!.movedOut === 0);
});

test('重复键：请求内重复与库内重复都被拒绝，带 DUPLICATE_KEY', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [{ name: 'a', weight: 1 }], null);
  assert.throws(
    () => addKeys(db, ringId, ['x', 'x']),
    (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_KEY',
  );
  addKeys(db, ringId, ['x']);
  assert.throws(
    () => addKeys(db, ringId, ['x']),
    (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_KEY',
  );
  assert.deepEqual(listSampleKeys(db, ringId), ['x']);
});

test('权重变化作为新版本：仅受影响区间的键迁移且守恒', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
  ], null);
  addKeys(db, ringId, KEYS);
  evolveRing(db, ringId, {
    action: 'set',
    nodes: [
      { name: 'a', weight: 3 },
      { name: 'b', weight: 1 },
    ],
  });
  const report = compareVersions(db, ringId, 1, 2, null);
  const sum = Object.values(report.newDistribution).reduce((a, b) => a + b, 0);
  assert.equal(sum, KEYS.length);
  assert.equal(
    report.keys.filter((k) => k.migrated).length,
    report.migratedKeys,
  );
});

test('旧报告不可变：继续演进配置后，保存的报告内容不变', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
  ], null);
  addKeys(db, ringId, KEYS);
  evolveRing(db, ringId, { action: 'add', node: 'd', weight: 1 });
  const report12 = compareVersions(db, ringId, 1, 2, null);
  const id = saveReport(db, ringId, report12);

  evolveRing(db, ringId, { action: 'remove', node: 'a' });
  compareVersions(db, ringId, 2, 3, null);

  const stored = getReport(db, ringId, id)!;
  const parsed = JSON.parse(stored.payload_json) as typeof report12;
  assert.deepEqual(parsed.keys, report12.keys);
  assert.equal(parsed.migratedKeys, report12.migratedKeys);
  assert.equal(parsed.oldVersion, 1);
  assert.equal(parsed.newVersion, 2);
});

test('重启持久化：关闭并以同一文件重新打开，旧版本路由结果完全一致', () => {
  const dir = join(tmpdir(), `chlab-${process.pid}-${Date.now()}`);
  const dbPath = join(dir, 'test.sqlite');
  const db1 = openDatabase(dbPath);
  const created = createRing(db1, 'persist', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 2 },
  ], null);
  addKeys(db1, created.ringId, ['one', 'two', '三']);
  evolveRing(db1, created.ringId, { action: 'add', node: 'c', weight: 1 });
  const before = ['one', 'two', '三'].map((k) => routeKey(db1, created.ringId, k, 1));
  const reportBefore = compareVersions(db1, created.ringId, 1, 2, null);
  db1.close();

  const db2 = openDatabase(dbPath);
  const { ringId } = resolveRing(db2, 'persist');
  const after = ['one', 'two', '三'].map((k) => routeKey(db2, ringId, k, 1));
  assert.deepEqual(after, before);
  const reportAfter = compareVersions(db2, ringId, 1, 2, null);
  assert.equal(reportAfter.migratedKeys, reportBefore.migratedKeys);
  assert.deepEqual(reportAfter.keys, reportBefore.keys);
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('对照可直接传入临时键集合，不依赖已保存样本', () => {
  const db = makeSchema();
  const { ringId } = createRing(db, 'r', [
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
  ], null);
  evolveRing(db, ringId, { action: 'add', node: 'c', weight: 1 });
  const report = compareVersions(db, ringId, 1, 2, ['only-key']);
  assert.equal(report.totalKeys, 1);
  assert.equal(report.keys.length, 1);
});
