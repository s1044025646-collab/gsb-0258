import { Store } from './storage/db.js';
import {
  BASE_VNODES,
  HashRing,
  normalizeNodes,
  type NodeInput,
} from './core/ring.js';
import { sha256 } from './core/hash.js';
import { buildMigrationReport, type MigrationReport } from './core/migration.js';
import { fail } from './core/errors.js';

export const MAX_BATCH_KEYS = 10_000;

/** 内置固定种子样本键（确定性，便于可重复演示）。 */
export const SEED_KEYS: string[] = [
  'user:1001', 'user:1002', 'user:1003', 'user:1004', 'user:1005',
  'order:2001', 'order:2002', 'order:2003', 'order:2004', 'order:2005',
  'product:3001', 'product:3002', 'product:3003', 'product:3004', 'product:3005',
  'session:4001', 'session:4002', 'session:4003', 'session:4004', 'session:4005',
  'cache:5001', 'cache:5002', 'cache:5003', 'cache:5004', 'cache:5005',
  'metric:6001', 'metric:6002', 'metric:6003', 'metric:6004', 'metric:6004',
];

export interface CreateRingBody {
  name: string;
  nodes: unknown;
  label?: unknown;
  seedKeys?: unknown;
}

export class RingService {
  constructor(private readonly store: Store) {}

  createRing(body: CreateRingBody): {
    name: string;
    version: number;
    nodes: NodeInput[];
    keyCount: number;
  } {
    const name = validateRingName(body.name);
    const nodes = normalizeNodes(body.nodes);
    const label = body.label === undefined ? 'initial' : validateLabel(body.label);
    const now = new Date().toISOString();

    const ringId = this.store.createRing(name, now);
    this.store.addVersion(ringId, 1, nodes, label, now);

    let keys: string[] = [];
    if (body.seedKeys !== false) {
      keys = SEED_KEYS;
    }
    if (Array.isArray(body.seedKeys)) {
      keys = validateKeys(body.seedKeys);
    }
    const keyCount = this.store.addKeys(ringId, keys, now);

    return { name, version: 1, nodes, keyCount };
  }

  listRings() {
    return this.store.listRings();
  }

  listVersions(name: string) {
    const ring = this.store.getRingByName(name);
    return this.store.listVersions(ring.id).map((v) => ({
      version: v.version,
      label: v.label,
      nodes: this.store.parseNodes(v),
      createdAt: v.created_at,
    }));
  }

  /**
   * 复制某版本配置，新增或移除一个节点，生成不可变新版本。
   */
  evolve(
    name: string,
    action: 'add' | 'remove',
    node: unknown,
    fromVersion?: number,
    label?: unknown,
  ): { version: number; nodes: NodeInput[] } {
    const ring = this.store.getRingByName(name);
    const base =
      fromVersion === undefined
        ? this.store.latestVersion(ring.id)
        : this.store.getVersion(ring.id, fromVersion);
    if (!base) fail('VERSION_NOT_FOUND', '该环尚无任何版本');

    const baseNodes = this.store.parseNodes(base);
    let nextNodes: NodeInput[];
    if (action === 'add') {
      if (node === null || typeof node !== 'object') {
        fail('INVALID_ARGUMENT', 'node 必须为 {id, weight} 对象');
      }
      const rec = node as Record<string, unknown>;
      const id = (() => {
        // normalizeNodes 内部会统一校验，这里先取名字判重
        if (typeof rec.id !== 'string') {
          fail('INVALID_NODE_NAME', '节点名必须为字符串', 'id');
        }
        return rec.id;
      })();
      if (baseNodes.some((n) => n.id === id)) {
        fail('DUPLICATE_NODE', `节点已存在: ${id}`);
      }
      nextNodes = normalizeNodes([...baseNodes, { id: rec.id, weight: rec.weight }]);
    } else {
      if (typeof node !== 'string') {
        fail('INVALID_ARGUMENT', 'remove 操作的 node 必须为节点名字符串');
      }
      if (!baseNodes.some((n) => n.id === node)) {
        fail('NODE_NOT_FOUND', `节点不存在于该版本: ${node}`);
      }
      const filtered = baseNodes.filter((n) => n.id !== node);
      if (filtered.length === 0) {
        fail('EMPTY_RING', '移除后配置将为空环（至少保留一个节点）');
      }
      nextNodes = filtered;
    }

    const nextVersionNumber = base.version + 1;
    const now = new Date().toISOString();
    this.store.addVersion(
      ring.id,
      nextVersionNumber,
      nextNodes,
      label === undefined ? `${action}:${typeof node === 'string' ? node : (node as { id?: unknown }).id}` : validateLabel(label),
      now,
    );
    return { version: nextVersionNumber, nodes: nextNodes };
  }

  locate(name: string, version: number | undefined, key: string) {
    const { ringId, ver } = this.resolveVersion(name, version);
    const nodes = this.store.parseNodes(this.store.getVersion(ringId, ver));
    const ring = new HashRing(nodes, sha256);
    return { version: ver, ...formatLocate(ring.locateKey(key)) };
  }

  locateBatch(name: string, version: number | undefined, keys: string[]) {
    const { ringId, ver } = this.resolveVersion(name, version);
    const nodes = this.store.parseNodes(this.store.getVersion(ringId, ver));
    const ring = new HashRing(nodes, sha256);
    return { version: ver, results: validateKeys(keys).map((k) => formatLocate(ring.locateKey(k))) };
  }

  vnodes(name: string, version: number | undefined, limit: number, nodeId?: unknown) {
    const { ringId, ver } = this.resolveVersion(name, version);
    const nodes = this.store.parseNodes(this.store.getVersion(ringId, ver));
    const ring = new HashRing(nodes, sha256);
    let points = ring.points;
    if (nodeId !== undefined) {
      if (typeof nodeId !== 'string') fail('INVALID_ARGUMENT', 'node 必须为字符串');
      if (!ring.nodes.has(nodeId)) fail('NODE_NOT_FOUND', `节点不存在: ${nodeId}`);
      points = points.filter((p) => p.nodeId === nodeId);
    }
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || BASE_VNODES), 100_000);
    return {
      version: ver,
      baseVnodes: BASE_VNODES,
      totalVnodes: ring.points.length,
      limit: safeLimit,
      points: points.slice(0, safeLimit).map((p) => ({
        position: p.position.toString(),
        nodeId: p.nodeId,
        vindex: p.vindex,
      })),
    };
  }

  addSampleKeys(name: string, keys: unknown): { added: number; total: number } {
    const ring = this.store.getRingByName(name);
    const valid = validateKeys(keys);
    const added = this.store.addKeys(ring.id, valid, new Date().toISOString());
    return { added, total: this.store.listKeys(ring.id).length };
  }

  listSampleKeys(name: string): string[] {
    return this.store.listKeys(this.store.getRingByName(name).id);
  }

  /**
   * 基于环当前样本键生成两版本迁移报告；报告是快照，之后任何改动不影响它。
   */
  compare(
    name: string,
    oldVersion: number,
    newVersion: number,
  ): { reportId: number; report: MigrationReport } {
    const ring = this.store.getRingByName(name);
    if (oldVersion === newVersion) {
      fail('INVALID_ARGUMENT', '对照需要两个不同的版本号');
    }
    const oldNodes = this.store.parseNodes(this.store.getVersion(ring.id, oldVersion));
    const newNodes = this.store.parseNodes(this.store.getVersion(ring.id, newVersion));
    const keys = this.store.listKeys(ring.id);
    if (keys.length === 0) {
      fail('INVALID_ARGUMENT', '该环没有样本键，无法生成迁移报告');
    }
    const report = buildMigrationReport(oldNodes, newNodes, keys, oldVersion, newVersion, sha256);
    const reportId = this.store.saveReport(
      ring.id,
      oldVersion,
      newVersion,
      report,
      new Date().toISOString(),
    );
    return { reportId, report };
  }

  listReports(name: string) {
    return this.store.listReports(this.store.getRingByName(name).id);
  }

  getReport(name: string, reportId: number): MigrationReport {
    const ring = this.store.getRingByName(name);
    const row = this.store.getReport(reportId);
    if (row.ring_id !== ring.id) fail('REPORT_NOT_FOUND', `报告不属于环 ${name}`);
    return JSON.parse(row.payload_json) as MigrationReport;
  }

  exportRing(name: string) {
    return this.store.exportRing(name);
  }

  private resolveVersion(name: string, version: number | undefined) {
    const ring = this.store.getRingByName(name);
    const row =
      version === undefined
        ? this.store.latestVersion(ring.id)
        : this.store.getVersion(ring.id, version);
    if (!row) fail('VERSION_NOT_FOUND', '该环尚无任何版本');
    return { ringId: ring.id, ver: row.version };
  }
}

function formatLocate(l: ReturnType<HashRing['locateKey']>) {
  return {
    key: l.key,
    keyPosition: l.keyPosition.toString(),
    nodeId: l.nodeId,
    vnodePosition: l.vnodePosition.toString(),
    vindex: l.vindex,
  };
}

function validateRingName(name: unknown): string {
  if (typeof name !== 'string' || !/^[\w.\-]{1,64}$/.test(name)) {
    fail('INVALID_ARGUMENT', 'name 必须为 1-64 个字符（字母数字下划线点短横线）', 'name');
  }
  return name;
}

function validateLabel(label: unknown): string | null {
  if (label === null) return null;
  if (typeof label !== 'string' || label.length > 128) {
    fail('INVALID_ARGUMENT', 'label 必须为长度 <= 128 的字符串或 null', 'label');
  }
  return label;
}

function validateKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    fail('INVALID_ARGUMENT', 'keys 必须为非空数组');
  }
  if (keys.length > MAX_BATCH_KEYS) {
    fail('INVALID_ARGUMENT', `单次最多 ${MAX_BATCH_KEYS} 个键`);
  }
  return keys.map((k, i) => {
    if (typeof k !== 'string' || k.length === 0 || k.length > 1024) {
      fail('INVALID_ARGUMENT', `keys[${i}] 必须为 1..1024 字符的非空字符串`);
    }
    return k;
  });
}
