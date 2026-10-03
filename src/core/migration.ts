import { HashRing, type LocateResult, type NodeInput } from './ring.js';
import type { HashFn } from './hash.js';

export interface ConfigSnapshot {
  nodes: NodeInput[];
  createdAt: string;
}

export interface KeyMigration {
  key: string;
  oldNode: string;
  newNode: string;
  migrated: boolean;
  oldKeyPosition: string;
  newKeyPosition: string;
  oldVnodePosition: string;
  newVnodePosition: string;
}

export interface NodeStat {
  node: string;
  oldCount: number;
  newCount: number;
  migratedIn: number;
  migratedOut: number;
}

export interface MigrationSummary {
  totalKeys: number;
  migratedKeys: number;
  migrationRatio: number;
  nodeStats: NodeStat[];
}

export interface MigrationReport {
  oldVersion: number;
  newVersion: number;
  keyCount: number;
  items: KeyMigration[];
  summary: MigrationSummary;
  note: string;
}

function asText(loc: LocateResult) {
  return {
    kp: loc.keyPosition.toString(),
    vp: loc.vnodePosition.toString(),
  };
}

/**
 * 对照同一批样本键在两个配置版本上的归属。
 * 统计仅代表当前样本，不宣称分布均匀。
 */
export function buildMigrationReport(
  oldNodes: NodeInput[],
  newNodes: NodeInput[],
  keys: string[],
  oldVersion: number,
  newVersion: number,
  hash: HashFn,
): MigrationReport {
  const oldRing = new HashRing(oldNodes, hash);
  const newRing = new HashRing(newNodes, hash);

  const items: KeyMigration[] = [];
  const nodeNames = new Set<string>();
  oldNodes.forEach((n) => nodeNames.add(n.id));
  newNodes.forEach((n) => nodeNames.add(n.id));

  const stats = new Map<string, NodeStat>();
  for (const name of nodeNames) {
    stats.set(name, {
      node: name,
      oldCount: 0,
      newCount: 0,
      migratedIn: 0,
      migratedOut: 0,
    });
  }

  for (const key of keys) {
    const before = oldRing.locateKey(key);
    const after = newRing.locateKey(key);
    const migrated = before.nodeId !== after.nodeId;
    const bp = asText(before);
    const ap = asText(after);
    items.push({
      key,
      oldNode: before.nodeId,
      newNode: after.nodeId,
      migrated,
      oldKeyPosition: bp.kp,
      newKeyPosition: ap.kp,
      oldVnodePosition: bp.vp,
      newVnodePosition: ap.vp,
    });

    const os = stats.get(before.nodeId)!;
    os.oldCount += 1;
    if (migrated) os.migratedOut += 1;
    const ns = stats.get(after.nodeId)!;
    ns.newCount += 1;
    if (migrated) ns.migratedIn += 1;
  }

  const migratedKeys = items.filter((i) => i.migrated).length;
  const totalKeys = items.length;

  assertConservation(items, stats, totalKeys, migratedKeys);

  return {
    oldVersion,
    newVersion,
    keyCount: totalKeys,
    items,
    summary: {
      totalKeys,
      migratedKeys,
      migrationRatio: totalKeys === 0 ? 0 : migratedKeys / totalKeys,
      nodeStats: [...stats.values()].sort((a, b) => a.node.localeCompare(b.node)),
    },
    note: '分布统计仅代表当前样本键集合，不代表理论均匀分布；单副本环，不复制数据。',
  };
}

/**
 * 守恒自检：归属总数前后一致；明细迁移数与统计计数一致。
 */
function assertConservation(
  items: KeyMigration[],
  stats: Map<string, NodeStat>,
  totalKeys: number,
  migratedKeys: number,
): void {
  const sumOld = [...stats.values()].reduce((s, x) => s + x.oldCount, 0);
  const sumNew = [...stats.values()].reduce((s, x) => s + x.newCount, 0);
  if (sumOld !== totalKeys || sumNew !== totalKeys) {
    throw new Error('守恒校验失败：归属总数与样本数不一致');
  }
  const inOut = [...stats.values()].reduce(
    (acc, x) => ({ in: acc.in + x.migratedIn, out: acc.out + x.migratedOut }),
    { in: 0, out: 0 },
  );
  if (inOut.in !== migratedKeys || inOut.out !== migratedKeys) {
    throw new Error('守恒校验失败：迁移明细与统计不一致');
  }
  let detailMigrated = 0;
  for (const it of items) if (it.migrated) detailMigrated += 1;
  if (detailMigrated !== migratedKeys) {
    throw new Error('守恒校验失败：明细迁移数不匹配');
  }
}
