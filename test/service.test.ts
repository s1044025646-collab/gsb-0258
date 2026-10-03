import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/storage/db.js';
import { RingService } from '../src/service.js';
import { AppError } from '../src/core/errors.js';

const dir = resolve(tmpdir(), `chashlab-test-${process.pid}-${Date.now()}`);
let store: Store;
let svc: RingService;

before(() => {
  rmSync(dir, { recursive: true, force: true });
  store = new Store(resolve(dir, 'test.db'));
  svc = new RingService(store);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('建环并写入固定种子，重复键被去重', () => {
  const r = svc.createRing({ name: 'lab', nodes: [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
    { id: 'c', weight: 1 },
  ] });
  assert.equal(r.version, 1);
  const keys = svc.listSampleKeys('lab');
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.length < 30);
});

test('重复环名被拒绝', () => {
  assert.throws(
    () => svc.createRing({ name: 'lab', nodes: [{ id: 'x', weight: 1 }], seedKeys: false }),
    (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_RING',
  );
});

test('复制配置新增节点生成 v2，旧版本快照保持不变', () => {
  const beforeV1 = JSON.stringify(svc.listVersions('lab')[0]);
  const v2 = svc.evolve('lab', 'add', { id: 'd', weight: 1 });
  assert.equal(v2.version, 2);
  assert.equal(v2.nodes.length, 4);
  const afterV1 = JSON.stringify(svc.listVersions('lab')[0]);
  assert.equal(beforeV1, afterV1);
});

test('迁移报告持久化为快照，后续版本演进不改变旧报告', () => {
  const { reportId, report } = svc.compare('lab', 1, 2);
  const snapshot = JSON.stringify(report);
  svc.evolve('lab', 'remove', 'b', 2);
  svc.compare('lab', 2, 3);
  const reloaded = JSON.stringify(svc.getReport('lab', reportId));
  assert.equal(reloaded, snapshot);
});

test('重启后（新 Store 实例）旧版本与报告结果一致', () => {
  store.close();
  store = new Store(resolve(dir, 'test.db'));
  svc = new RingService(store);

  const v1 = svc.listVersions('lab').find((v) => v.version === 1)!;
  assert.equal(v1.nodes.length, 3);
  const reports = svc.listReports('lab');
  assert.equal(reports.length, 2);
  const first = svc.getReport('lab', reports[0]!.id);
  assert.equal(first.oldVersion, 1);
  assert.equal(first.newVersion, 2);
  const loc1 = svc.locate('lab', 1, 'user:1001');
  const loc2 = svc.locate('lab', 1, 'user:1001');
  assert.deepEqual(loc1, loc2);
});

test('移除不存在节点、空移除、非法批量被拒绝', () => {
  assert.throws(
    () => svc.evolve('lab', 'remove', 'ghost', 1),
    (e: unknown) => e instanceof AppError && e.code === 'NODE_NOT_FOUND',
  );
  assert.throws(
    () => svc.locateBatch('lab', 1, []),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => svc.locate('lab', 1, ''),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_ARGUMENT',
  );
});

test('导出包含全部版本、样本与报告快照', () => {
  const ex = svc.exportRing('lab');
  assert.equal(ex.versions.length, 3);
  assert.ok(ex.sampleKeys.length > 0);
  assert.equal(ex.reports.length, 2);
});
