import type { DatabaseSync } from 'node:sqlite';
import {
  addSampleKey,
  getRingByName,
  getVersion,
  insertReport,
  insertRing,
  insertVersion,
  latestVersionNumber,
  listSampleKeys,
  listVersions,
} from './db.js';
import { AppError } from './errors.js';
import type { HashFn } from './hash.js';
import { realHash } from './hash.js';
import {
  buildRing,
  locateKey,
  validateNodes,
  type NodeSpec,
  type VNode,
} from './ring.js';

export interface KeyMigration {
  key: string;
  oldNode: string | null;
  newNode: string | null;
  migrated: boolean;
}

export interface NodeStat {
  node: string;
  oldCount: number;
  newCount: number;
  movedIn: number;
  movedOut: number;
  stayed: number;
}

export interface MigrationReport {
  ringName: string;
  oldVersion: number;
  newVersion: number;
  totalKeys: number;
  migratedKeys: number;
  migrationRatio: number;
  oldDistribution: Record<string, number>;
  newDistribution: Record<string, number>;
  perNode: NodeStat[];
  keys: KeyMigration[];
  generatedAt: string;
}

export function createRing(
  db: DatabaseSync,
  name: string,
  nodes: NodeSpec[],
  note: string | null,
  hash: HashFn = realHash,
): { ringId: number; version: number; vnodeCount: number } {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppError('INVALID_BODY', '环名必须是非空字符串');
  }
  if (getRingByName(db, name)) {
    throw new AppError('DUPLICATE_NODE', `环名已存在: ${name}`, 409, { name });
  }
  const validated = validateNodes(nodes);
  const ringId = insertRing(db, name);
  const { vnodes } = buildRing(validated, hash);
  insertVersion(db, ringId, 1, JSON.stringify(validated), note ?? '初始版本');
  return { ringId, version: 1, vnodeCount: vnodes.length };
}

/** 显式创建空环（无节点版本 v1）。对其路由将返回 EMPTY_RING 错误。 */
export function createEmptyRing(
  db: DatabaseSync,
  name: string,
  note: string | null,
): { ringId: number; version: number; vnodeCount: number } {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppError('INVALID_BODY', '环名必须是非空字符串');
  }
  if (getRingByName(db, name)) {
    throw new AppError('DUPLICATE_NODE', `环名已存在: ${name}`, 409, { name });
  }
  const ringId = insertRing(db, name);
  insertVersion(db, ringId, 1, JSON.stringify([]), note ?? '空环版本');
  return { ringId, version: 1, vnodeCount: 0 };
}

export function resolveRing(db: DatabaseSync, nameOrId: string): { ringId: number; name: string } {
  const byName = getRingByName(db, nameOrId);
  if (byName) return { ringId: byName.id, name: byName.name };
  if (/^\d+$/.test(nameOrId)) {
    const row = db.prepare('SELECT * FROM rings WHERE id = ?').get(Number(nameOrId));
    if (row) {
      const ring = row as { id: number; name: string };
      return { ringId: ring.id, name: ring.name };
    }
  }
  throw new AppError('RING_NOT_FOUND', `环不存在: ${nameOrId}`, 404);
}

export function loadVersionNodes(db: DatabaseSync, ringId: number, version: number): NodeSpec[] {
  const row = getVersion(db, ringId, version);
  if (!row) {
    throw new AppError('VERSION_NOT_FOUND', `版本不存在: v${version}`, 404, { version });
  }
  return JSON.parse(row.nodes_json) as NodeSpec[];
}

export function currentVersion(db: DatabaseSync, ringId: number): number {
  const v = latestVersionNumber(db, ringId);
  if (v === 0) throw new AppError('VERSION_NOT_FOUND', '该环没有任何版本', 404);
  return v;
}

export interface EvolveInput {
  action: 'add' | 'remove' | 'set';
  node?: string;
  weight?: number;
  nodes?: NodeSpec[];
  note?: string;
}

export function evolveRing(
  db: DatabaseSync,
  ringId: number,
  input: EvolveInput,
  hash: HashFn = realHash,
): { version: number; nodes: NodeSpec[]; vnodeCount: number } {
  const baseVersion = currentVersion(db, ringId);
  const baseNodes = loadVersionNodes(db, ringId, baseVersion);
  let nextNodes: NodeSpec[];

  if (input.action === 'add') {
    if (typeof input.node !== 'string' || input.node.trim() === '') {
      throw new AppError('INVALID_NODE', 'add 操作需要 node 名称');
    }
    if (baseNodes.some((n) => n.name === input.node)) {
      throw new AppError('DUPLICATE_NODE', `节点已存在: ${input.node}`, 409, {
        node: input.node,
      });
    }
    const weight = input.weight ?? 1;
    nextNodes = [...baseNodes, { name: input.node, weight }];
  } else if (input.action === 'remove') {
    if (typeof input.node !== 'string') {
      throw new AppError('INVALID_NODE', 'remove 操作需要 node 名称');
    }
    if (!baseNodes.some((n) => n.name === input.node)) {
      throw new AppError('NODE_NOT_FOUND', `节点不存在: ${input.node}`, 404, {
        node: input.node,
      });
    }
    nextNodes = baseNodes.filter((n) => n.name !== input.node);
    if (nextNodes.length === 0) {
      throw new AppError('INVALID_NODE', '不允许移除最后一个节点而产生空版本（如需空环请新建）', 400);
    }
  } else if (input.action === 'set') {
    if (!Array.isArray(input.nodes)) {
      throw new AppError('INVALID_BODY', 'set 操作需要 nodes 数组');
    }
    nextNodes = input.nodes;
  } else {
    throw new AppError('INVALID_BODY', `未知操作: ${String((input as { action?: string }).action)}`);
  }

  const validated = validateNodes(nextNodes);
  const { vnodes } = buildRing(validated, hash);
  const newVersion = baseVersion + 1;
  insertVersion(db, ringId, newVersion, JSON.stringify(validated), input.note ?? null);
  return { version: newVersion, nodes: validated, vnodeCount: vnodes.length };
}

export function getVNodes(
  db: DatabaseSync,
  ringId: number,
  version: number | null,
  hash: HashFn = realHash,
): { version: number; vnodes: VNode[] } {
  const v = version ?? currentVersion(db, ringId);
  const nodes = loadVersionNodes(db, ringId, v);
  return { version: v, vnodes: buildRing(nodes, hash).vnodes };
}

export function routeKey(
  db: DatabaseSync,
  ringId: number,
  key: string,
  version: number | null,
  hash: HashFn = realHash,
): { version: number; key: string; node: string; position: string; vnodeIndex: number } {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError('INVALID_BODY', 'key 必须是非空字符串');
  }
  const { version: v, vnodes } = getVNodes(db, ringId, version, hash);
  const hit = locateKey(vnodes, key, hash);
  return {
    version: v,
    key,
    node: hit.node,
    position: hit.position.toString(),
    vnodeIndex: hit.vnodeIndex,
  };
}

export function addKeys(db: DatabaseSync, ringId: number, keys: string[]): { added: number } {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new AppError('INVALID_BODY', 'keys 必须是非空字符串数组');
  }
  const dedup = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string' || key === '') {
      throw new AppError('INVALID_BODY', '样本键必须是非空字符串');
    }
    if (dedup.has(key)) {
      throw new AppError('DUPLICATE_KEY', `请求内键重复: ${key}`, 409, { key });
    }
    dedup.add(key);
  }
  const existing = new Set(listSampleKeys(db, ringId));
  let added = 0;
  for (const key of dedup) {
    if (existing.has(key)) {
      throw new AppError('DUPLICATE_KEY', `样本键已存在: ${key}`, 409, { key });
    }
    addSampleKey(db, ringId, key);
    added++;
  }
  return { added };
}

function emptyCounts(nodes: readonly NodeSpec[]): Record<string, number> {
  return Object.fromEntries(nodes.map((n) => [n.name, 0]));
}

export function compareVersions(
  db: DatabaseSync,
  ringId: number,
  oldVersion: number,
  newVersion: number,
  keys: string[] | null,
  hash: HashFn = realHash,
): MigrationReport {
  const oldNodes = loadVersionNodes(db, ringId, oldVersion);
  const newNodes = loadVersionNodes(db, ringId, newVersion);
  const sample = keys ?? listSampleKeys(db, ringId);

  const uniqueKeys = [...new Set(sample)];
  const oldRing = buildRing(oldNodes, hash);
  const newRing = buildRing(newNodes, hash);

  const oldDist = emptyCounts(oldNodes);
  const newDist = emptyCounts(newNodes);
  const allNames = new Set<string>([
    ...oldNodes.map((n) => n.name),
    ...newNodes.map((n) => n.name),
  ]);
  const perNodeMap = new Map<string, NodeStat>();
  for (const name of allNames) {
    perNodeMap.set(name, {
      node: name,
      oldCount: 0,
      newCount: 0,
      movedIn: 0,
      movedOut: 0,
      stayed: 0,
    });
  }

  const keyRows: KeyMigration[] = [];
  let migratedKeys = 0;

  for (const key of uniqueKeys) {
    const oldNode = oldRing.vnodes.length === 0 ? null : locateKey(oldRing.vnodes, key, hash).node;
    const newNode = newRing.vnodes.length === 0 ? null : locateKey(newRing.vnodes, key, hash).node;
    const migrated = oldNode !== newNode;
    if (migrated) migratedKeys++;
    keyRows.push({ key, oldNode, newNode, migrated });

    if (oldNode) {
      oldDist[oldNode] = (oldDist[oldNode] ?? 0) + 1;
      const stat = perNodeMap.get(oldNode)!;
      stat.oldCount++;
      if (migrated) stat.movedOut++;
      else stat.stayed++;
    }
    if (newNode) {
      newDist[newNode] = (newDist[newNode] ?? 0) + 1;
      const stat = perNodeMap.get(newNode)!;
      stat.newCount++;
      if (migrated) stat.movedIn++;
    }
  }

  const total = uniqueKeys.length;
  const report: MigrationReport = {
    ringName: getRingName(db, ringId),
    oldVersion,
    newVersion,
    totalKeys: total,
    migratedKeys,
    migrationRatio: total === 0 ? 0 : migratedKeys / total,
    oldDistribution: oldDist,
    newDistribution: newDist,
    perNode: [...perNodeMap.values()],
    keys: keyRows,
    generatedAt: new Date().toISOString(),
  };
  return report;
}

function getRingName(db: DatabaseSync, ringId: number): string {
  const row = db.prepare('SELECT name FROM rings WHERE id = ?').get(ringId) as
    | { name: string }
    | undefined;
  if (!row) throw new AppError('RING_NOT_FOUND', '环不存在', 404);
  return row.name;
}

export function saveReport(
  db: DatabaseSync,
  ringId: number,
  report: MigrationReport,
): number {
  return insertReport(
    db,
    ringId,
    report.oldVersion,
    report.newVersion,
    JSON.stringify(report),
  );
}

export function listVersionSummaries(db: DatabaseSync, ringId: number) {
  return listVersions(db, ringId).map((row) => ({
    version: row.version,
    note: row.note,
    createdAt: row.created_at,
    nodes: JSON.parse(row.nodes_json) as NodeSpec[],
  }));
}

/** 固定种子的演示样本键：确定性、可重复。 */
export const SEED_KEYS: string[] = [
  'user:1001',
  'user:1002',
  'order:2024-0001',
  'order:2024-0002',
  'session:alpha',
  'session:beta',
  'session:gamma',
  'cart:node-77',
  'cart:node-88',
  'inventory:sku-42',
  'inventory:sku-99',
  'metric:cpu:host-3',
  'metric:mem:host-3',
  'log:2026-10-03:00',
  'log:2026-10-03:01',
  'cache:avatar:user:1001',
  'cache:avatar:user:1002',
  'job:queue:email',
  'job:queue:resize',
  'job:queue:report',
  'audit:login:admin',
  'audit:login:guest',
  'config:feature:flag-a',
  'config:feature:flag-b',
];
