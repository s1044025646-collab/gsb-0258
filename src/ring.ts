import { AppError } from './errors.js';
import {
  HASH_SPACE_MODULUS,
  type HashFn,
  keyInput,
  realHash,
  vnodeInput,
} from './hash.js';

export const BASE_VNODES = 160;
export const MAX_WEIGHT = 1000;
export const MAX_TOTAL_VNODES = 200_000;
export const MAX_NODE_NAME_LENGTH = 128;

export interface RingNodeInput {
  name: string;
  weight: number;
}

export interface VNode {
  position: bigint;
  node: string;
  vnodeIndex: number;
}

export interface NodeSpec {
  name: string;
  weight: number;
}

export interface BuildResult {
  vnodes: VNode[];
  nodes: NodeSpec[];
}

export function validateNodes(input: unknown): NodeSpec[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError('INVALID_BODY', 'nodes 必须是非空数组（空环请显式调用 empty 建环）', 400);
  }
  const seen = new Set<string>();
  const result: NodeSpec[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) {
      throw new AppError('INVALID_NODE', '每个节点必须是对象 {name, weight}');
    }
    const { name, weight } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new AppError('INVALID_NODE', '节点名必须是非空字符串');
    }
    if (name.length > MAX_NODE_NAME_LENGTH) {
      throw new AppError('INVALID_NODE', `节点名长度不能超过 ${MAX_NODE_NAME_LENGTH}`);
    }
    if (seen.has(name)) {
      throw new AppError('DUPLICATE_NODE', `节点名重复: ${name}`, 409, { name });
    }
    if (
      typeof weight !== 'number' ||
      !Number.isInteger(weight) ||
      weight < 1 ||
      weight > MAX_WEIGHT
    ) {
      throw new AppError(
        'INVALID_WEIGHT',
        `节点 ${name} 的权重必须是 1..${MAX_WEIGHT} 的整数`,
        400,
        { name, weight },
      );
    }
    seen.add(name);
    result.push({ name, weight });
  }
  const total = result.reduce((sum, n) => sum + n.weight * BASE_VNODES, 0);
  if (total > MAX_TOTAL_VNODES) {
    throw new AppError(
      'TOO_MANY_VNODES',
      `虚拟节点总数 ${total} 超过上限 ${MAX_TOTAL_VNODES}（基础 ${BASE_VNODES} × 权重之和）`,
      400,
      { total, limit: MAX_TOTAL_VNODES },
    );
  }
  return result;
}

/**
 * 构建有序虚拟节点环。
 * 排序键：(position, node, vnodeIndex) 全序；
 * 因此即使两个虚拟节点哈希位置相同，归属也确定且稳定，
 * 且与输入列表顺序无关。
 */
export function buildRing(nodes: readonly NodeSpec[], hash: HashFn = realHash): BuildResult {
  const vnodes: VNode[] = [];
  for (const { name, weight } of nodes) {
    const count = weight * BASE_VNODES;
    for (let index = 0; index < count; index++) {
      const position = hash(vnodeInput(name, index)) % HASH_SPACE_MODULUS;
      vnodes.push({ position, node: name, vnodeIndex: index });
    }
  }
  vnodes.sort(compareVNode);
  return { vnodes, nodes: nodes.map((n) => ({ ...n })) };
}

export function compareVNode(a: VNode, b: VNode): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.node < b.node) return -1;
  if (a.node > b.node) return 1;
  return a.vnodeIndex - b.vnodeIndex;
}

/**
 * 正式查询：二分查找“不小于键位置”的第一个虚拟节点；
 * 若键位置超过末尾则回绕到第 0 个。
 * 位置相等时按环的全序取排序最靠前者，保证相同位置稳定选择。
 */
export function locateKey(vnodes: readonly VNode[], key: string, hash: HashFn = realHash): VNode {
  if (vnodes.length === 0) {
    throw new AppError('EMPTY_RING', '环为空，无法路由任何键', 409);
  }
  const target = hash(keyInput(key)) % HASH_SPACE_MODULUS;
  let lo = 0;
  let hi = vnodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midNode = vnodes[mid]!;
    if (midNode.position < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const chosen = vnodes[lo === vnodes.length ? 0 : lo]!;
  return chosen;
}

/**
 * 独立基准：朴素线性扫描环。
 * 从所有 position >= target 的虚拟节点中取全序最小者；
 * 一个都没有时回绕到全序最小者（即环首）。
 * 仅用于测试交叉核对，不用于生产路径。
 */
export function locateKeyLinear(
  vnodes: readonly VNode[],
  key: string,
  hash: HashFn = realHash,
): VNode {
  if (vnodes.length === 0) {
    throw new AppError('EMPTY_RING', '环为空，无法路由任何键', 409);
  }
  const target = hash(keyInput(key)) % HASH_SPACE_MODULUS;
  let best: VNode | null = null;
  for (const vn of vnodes) {
    if (vn.position >= target && (best === null || compareVNode(vn, best) < 0)) {
      best = vn;
    }
  }
  if (best === null) {
    let first = vnodes[0]!;
    for (const vn of vnodes) {
      if (compareVNode(vn, first) < 0) first = vn;
    }
    return first;
  }
  return best;
}
