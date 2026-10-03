import { fail } from './errors.js';
import {
  keyPosition,
  sha256,
  vnodePosition,
  type HashFn,
} from './hash.js';

export interface NodeInput {
  id: string;
  weight: number;
}

export interface RingNode {
  id: string;
  weight: number;
  vnodes: number;
}

export interface VNodePoint {
  position: bigint;
  nodeId: string;
  vindex: number;
}

export interface LocateResult {
  key: string;
  keyPosition: bigint;
  nodeId: string;
  vnodePosition: bigint;
  vindex: number;
}

/** 固定基础虚拟节点数（每权重 1 份）。 */
export const BASE_VNODES = 128;
/** 单节点允许的最大虚拟节点数（weight <= 8192）。 */
export const MAX_VNODES_PER_NODE = 1_048_576;
/** 单个环允许的最大虚拟节点总数，防止内存失控。 */
export const MAX_TOTAL_VNODES = 4_000_000;

const NAME_RE = /^[\w.\-]{1,64}$/;

export function validateNodeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !NAME_RE.test(id)) {
    fail(
      'INVALID_NODE_NAME',
      '节点名必须为 1-64 个字符，允许字母、数字、下划线、点、短横线',
      'id',
    );
  }
}

export function validateWeight(w: unknown): number {
  if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 8192) {
    fail('INVALID_WEIGHT', '权重必须为 1..8192 的整数', 'weight');
  }
  return w;
}

export function normalizeNodes(nodes: unknown): NodeInput[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail('INVALID_ARGUMENT', 'nodes 必须为非空数组');
  }
  const seen = new Set<string>();
  return nodes.map((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      fail('INVALID_ARGUMENT', `nodes[${i}] 必须为对象`);
    }
    const n = raw as Record<string, unknown>;
    validateNodeId(n.id);
    const id = n.id as string;
    if (seen.has(id)) {
      fail('DUPLICATE_NODE', `节点名重复: ${id}`, 'nodes');
    }
    seen.add(id);
    return { id, weight: validateWeight(n.weight) };
  });
}

/**
 * 带虚拟节点的单副本一致性哈希环。
 *
 * 点排序键固定为 (position ASC, nodeId ASC, vindex ASC)，
 * 因此多个输入落在相同 64 位位置时，选中的虚拟点完全确定。
 */
export class HashRing {
  readonly points: readonly VNodePoint[];
  readonly nodes: ReadonlyMap<string, RingNode>;

  constructor(nodes: NodeInput[], private readonly hash: HashFn = sha256) {
    if (nodes.length === 0) {
      fail('EMPTY_RING', '空环无法路由：至少需要一个节点');
    }
    const map = new Map<string, RingNode>();
    const points: VNodePoint[] = [];
    let total = 0;
    for (const n of nodes) {
      const vnodes = BASE_VNODES * n.weight;
      if (vnodes > MAX_VNODES_PER_NODE) {
        fail('TOO_MANY_VNODES', `节点 ${n.id} 虚拟节点数 ${vnodes} 超过上限 ${MAX_VNODES_PER_NODE}`);
      }
      total += vnodes;
      if (total > MAX_TOTAL_VNODES) {
        fail('TOO_MANY_VNODES', `虚拟节点总数超过上限 ${MAX_TOTAL_VNODES}`);
      }
      map.set(n.id, { id: n.id, weight: n.weight, vnodes });
      for (let v = 0; v < vnodes; v++) {
        points.push({ position: vnodePosition(hash, n.id, v), nodeId: n.id, vindex: v });
      }
    }
    points.sort(comparePoints);
    this.points = points;
    this.nodes = map;
  }

  /**
   * 查找环上不小于 keyPosition 的第一个虚拟点；若不存在则回绕到首点。
   */
  locateKey(key: string): LocateResult {
    if (typeof key !== 'string' || key.length === 0) {
      fail('INVALID_ARGUMENT', 'key 必须为非空字符串', 'key');
    }
    const kp = keyPosition(this.hash, key);
    const idx = this.lowerBound(kp);
    const point = this.points[idx] ?? this.points[0]!;
    return {
      key,
      keyPosition: kp,
      nodeId: point.nodeId,
      vnodePosition: point.position,
      vindex: point.vindex,
    };
  }

  /** 二分：第一个 position >= target 的下标；相等时取排序最靠前的点。 */
  private lowerBound(target: bigint): number {
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.points[mid]!;
      if (p.position < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo === this.points.length ? 0 : lo;
  }
}

export function comparePoints(a: VNodePoint, b: VNodePoint): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return a.vindex - b.vindex;
}

/**
 * 独立的小规模基准实现：对全部虚拟点做线性扫描，
 * 选 position >= keyPos 中最小者（含相同位置的稳定 tiebreak），
 * 否则回绕到全环最小点。用于测试中核对正式二分查询。
 */
export function linearLocate(
  nodes: NodeInput[],
  key: string,
  hash: HashFn = sha256,
): LocateResult {
  if (nodes.length === 0) {
    fail('EMPTY_RING', '空环无法路由');
  }
  const kp = keyPosition(hash, key);
  let best: VNodePoint | null = null;
  let wrap: VNodePoint | null = null;
  for (const n of nodes) {
    const count = BASE_VNODES * n.weight;
    for (let v = 0; v < count; v++) {
      const point: VNodePoint = {
        position: vnodePosition(hash, n.id, v),
        nodeId: n.id,
        vindex: v,
      };
      if (point.position >= kp) {
        if (best === null || comparePoints(point, best) < 0) best = point;
      }
      if (wrap === null || comparePoints(point, wrap) < 0) wrap = point;
    }
  }
  const chosen = best ?? wrap!;
  return {
    key,
    keyPosition: kp,
    nodeId: chosen.nodeId,
    vnodePosition: chosen.position,
    vindex: chosen.vindex,
  };
}
