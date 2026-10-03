import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from './storage/db.js';
import { RingService, SEED_KEYS } from './service.js';
import type { MigrationReport } from './core/migration.js';

function line(title: string): void {
  process.stdout.write(`\n================ ${title} ================\n`);
}

function printReport(report: MigrationReport, detailLimit: number): void {
  process.stdout.write(
    `对照 v${report.oldVersion} -> v${report.newVersion}，样本键 ${report.keyCount} 个，` +
      `迁移 ${report.summary.migratedKeys} 个，迁移比例 ${(report.summary.migrationRatio * 100).toFixed(2)}%\n`,
  );
  line('迁移明细（前 ' + detailLimit + ' 条，含迁移与未迁移示例）');
  const migrated = report.items.filter((i) => i.migrated).slice(0, detailLimit);
  const stable = report.items.filter((i) => !i.migrated).slice(0, 3);
  for (const it of migrated) {
    process.stdout.write(`  MOVE   ${it.key.padEnd(16)} ${it.oldNode} -> ${it.newNode}\n`);
  }
  for (const it of stable) {
    process.stdout.write(`  STAY   ${it.key.padEnd(16)} ${it.oldNode} == ${it.newNode}\n`);
  }

  line('完整统计');
  process.stdout.write(
    '  ' +
      ['节点'.padEnd(8), '旧数量', '新数量', '迁入', '迁出'].join(' | ') +
      '\n',
  );
  for (const s of report.summary.nodeStats) {
    process.stdout.write(
      '  ' +
        [
          s.node.padEnd(8),
          String(s.oldCount).padStart(4),
          String(s.newCount).padStart(4),
          String(s.migratedIn).padStart(4),
          String(s.migratedOut).padStart(4),
        ].join(' | ') +
        '\n',
    );
  }
  process.stdout.write(`\n说明: ${report.note}\n`);
}

function main(): void {
  const dataDir = resolve(process.cwd(), 'data-demo');
  rmSync(dataDir, { recursive: true, force: true });
  const store = new Store(resolve(dataDir, 'chashlab.db'));
  const svc = new RingService(store);

  line('内置固定种子样本键（含一个重复键，演示重复输入不产生重复样本）');
  process.stdout.write(`  输入 ${SEED_KEYS.length} 个，去重后 ${new Set(SEED_KEYS).size} 个\n`);

  const ringName = 'demo';
  const created = svc.createRing({
    name: ringName,
    nodes: [
      { id: 'node-a', weight: 1 },
      { id: 'node-b', weight: 1 },
      { id: 'node-c', weight: 1 },
    ],
    label: 'three-nodes',
    seedKeys: SEED_KEYS,
  });
  process.stdout.write(`\n创建环 ${created.name} v1：${created.nodes.map((n) => n.id).join(', ')}；样本键 ${created.keyCount} 个\n`);

  line('v1 单键定位示例');
  const loc = svc.locate(ringName, 1, 'user:1001');
  process.stdout.write(
    `  user:1001 -> ${loc.nodeId}（键位置 ${loc.keyPosition}，虚拟点位置 ${loc.vnodePosition}，vindex ${loc.vindex}）\n`,
  );

  const v2 = svc.evolve(ringName, 'add', { id: 'node-d', weight: 1 }, 1, 'add-node-d');
  process.stdout.write(`\n新增节点，生成 v2：${v2.nodes.map((n) => n.id).join(', ')}\n`);
  const r1 = svc.compare(ringName, 1, 2).report;
  printReport(r1, 8);

  const v3 = svc.evolve(ringName, 'remove', 'node-b', 2, 'remove-node-b');
  process.stdout.write(`\n移除 node-b，生成 v3：${v3.nodes.map((n) => n.id).join(', ')}\n`);
  const r2 = svc.compare(ringName, 2, 3).report;
  printReport(r2, 8);

  line('旧报告不可变验证');
  const oldReports = svc.listReports(ringName);
  process.stdout.write(`  当前保存报告数: ${oldReports.length}（v1->v2 报告仍是生成时的快照）\n`);
  const snap = svc.getReport(ringName, oldReports[0]!.id);
  process.stdout.write(
    `  报告 #${oldReports[0]!.id} 的迁移数量仍为 ${snap.summary.migratedKeys}/${snap.summary.totalKeys}\n`,
  );

  line('虚拟点查看（v1 前 5 个，按位置升序）');
  const vp = svc.vnodes(ringName, 1, 5);
  for (const p of vp.points) {
    process.stdout.write(`  ${p.position.padStart(20)}  ${p.nodeId}#${p.vindex}\n`);
  }

  line('导出');
  const exported = svc.exportRing(ringName);
  process.stdout.write(
    `  版本数 ${exported.versions.length}，报告数 ${exported.reports.length}，样本键 ${exported.sampleKeys.length} 个\n`,
  );

  store.close();
  process.stdout.write(`\n演示数据目录: ${dataDir}（可直接删除）\n`);
}

main();
