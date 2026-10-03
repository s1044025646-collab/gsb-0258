import { DatabaseSync } from 'node:sqlite';
import {
  addKeys,
  compareVersions,
  createRing,
  evolveRing,
  saveReport,
  SEED_KEYS,
  type MigrationReport,
  type NodeStat,
} from './service.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE rings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    nodes_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ring_id, version)
  );
  CREATE TABLE sample_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ring_id, key)
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_id INTEGER NOT NULL,
    old_version INTEGER NOT NULL,
    new_version INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const line = '─'.repeat(72);

function heading(title: string): void {
  console.log(`\n${line}\n${title}\n${line}`);
}

function printStats(report: MigrationReport): void {
  console.log(`样本键总数: ${report.totalKeys}`);
  console.log(`迁移键数量: ${report.migratedKeys}`);
  console.log(`迁移比例  : ${(report.migrationRatio * 100).toFixed(2)}%`);
  console.log('');
  console.log('节点       旧归属  新归属  迁入  迁出  保持');
  for (const stat of report.perNode as NodeStat[]) {
    console.log(
      `${stat.node.padEnd(10)} ${String(stat.oldCount).padStart(4)}   ${String(
        stat.newCount,
      ).padStart(4)}   ${String(stat.movedIn).padStart(4)}  ${String(stat.movedOut).padStart(4)}  ${String(
        stat.stayed,
      ).padStart(4)}`,
    );
  }
}

function printSampleMigrations(report: MigrationReport, limit = 6): void {
  const moved = report.keys.filter((k) => k.migrated).slice(0, limit);
  if (moved.length === 0) {
    console.log('（无迁移键）');
    return;
  }
  console.log('键'.padEnd(28) + '旧节点'.padEnd(10) + '新节点');
  for (const item of moved) {
    console.log(
      `${item.key.slice(0, 26).padEnd(28)} ${(item.oldNode ?? '∅').padEnd(10)} ${item.newNode ?? '∅'}`,
    );
  }
  if (report.migratedKeys > moved.length) {
    console.log(`……其余 ${report.migratedKeys - moved.length} 个迁移键见完整报告`);
  }
}

heading('步骤 1/4：建立三节点环（等权重，基础虚拟节点 160/节点）');
const { ringId } = createRing(
  db,
  'demo-ring',
  [
    { name: 'node-a', weight: 1 },
    { name: 'node-b', weight: 1 },
    { name: 'node-c', weight: 1 },
  ],
  '初始三节点',
);
addKeys(db, ringId, SEED_KEYS);
console.log(`已写入固定种子样本键 ${SEED_KEYS.length} 个。`);

heading('步骤 2/4：新增第四节点 node-d（v2）');
evolveRing(db, ringId, { action: 'add', node: 'node-d', weight: 1, note: '新增 node-d' });
const addReport = compareVersions(db, ringId, 1, 2, null);
const addReportId = saveReport(db, ringId, addReport);
console.log(`已生成不可变报告 #${addReportId}（v1 -> v2）。\n`);
console.log('少量迁移明细：');
printSampleMigrations(addReport);
console.log('\n完整统计：');
printStats(addReport);
const onlyToD = addReport.keys.every(
  (k) => !k.migrated || k.newNode === 'node-d',
);
console.log(`\n校验：所有迁移键的新归属均为 node-d -> ${onlyToD ? '通过' : '失败'}`);

heading('步骤 3/4：从 v2 移除 node-b（v3）');
evolveRing(db, ringId, { action: 'remove', node: 'node-b', note: '移除 node-b' });
const removeReport = compareVersions(db, ringId, 2, 3, null);
const removeReportId = saveReport(db, ringId, removeReport);
console.log(`已生成不可变报告 #${removeReportId}（v2 -> v3）。\n`);
console.log('少量迁移明细：');
printSampleMigrations(removeReport);
console.log('\n完整统计：');
printStats(removeReport);
const onlyFromB = removeReport.keys.every(
  (k) => !k.migrated || k.oldNode === 'node-b',
);
const othersStay = removeReport.keys
  .filter((k) => k.oldNode !== 'node-b')
  .every((k) => !k.migrated);
console.log(
  `\n校验：迁移键旧归属全部是 node-b -> ${onlyFromB ? '通过' : '失败'}；`,
);
console.log(`      node-a/node-c/node-d 原有键未被打散 -> ${othersStay ? '通过' : '失败'}`);

heading('步骤 4/4：守恒校验与旧报告稳定性');
const sumOld = Object.values(addReport.oldDistribution).reduce((a, b) => a + b, 0);
const sumNew = Object.values(addReport.newDistribution).reduce((a, b) => a + b, 0);
console.log(`v1 归属总数 ${sumOld} == v2 归属总数 ${sumNew} == 样本数 ${addReport.totalKeys}`);
console.log(
  `迁移明细数 ${addReport.migratedKeys} 与统计迁出/迁入合计一致 -> ` +
    `${
      addReport.perNode.reduce((s, n) => s + n.movedOut, 0) === addReport.migratedKeys &&
      addReport.perNode.reduce((s, n) => s + n.movedIn, 0) === addReport.migratedKeys
        ? '通过'
        : '失败'
    }`,
);
console.log('报告在生成时固化（数据库 reports 表），后续配置修改不会改变其内容。');
console.log('\n演示完成。可用 CLI/HTTP 对持久化数据库重复以上操作，详见 README.md。');
