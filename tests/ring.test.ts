import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.js';
import { keyInput, vnodeInput, sha256Position, encodeParts } from '../src/hash.js';
import {
  BASE_VNODES,
  buildRing,
  compareVNode,
  locateKey,
  locateKeyLinear,
  validateNodes,
} from '../src/ring.js';
import type { HashFn } from '../src/hash.js';
import type { VNode } from '../src/ring.js';

/** 受控哈希：对输入做简单确定性映射，便于构造相等位置与回绕。 */
function controlledHash(table: Map<string, bigint>): HashFn {
  return (input: Buffer) => {
    const hit = table.get(input.toString('hex'));
    return hit ?? 0n;
  };
}

function hex(buffer: Buffer): string {
  return buffer.toString('hex');
}

test('单节点环：所有键都路由到该节点', () => {
  const { vnodes } = buildRing([{ name: 'only', weight: 1 }]);
  for (const key of ['a', 'b', 'c', '中文键', '']) {
    assert.equal(locateKey(vnodes, key).node, 'only');
  }
});

test('空环：locateKey 抛出 EMPTY_RING', () => {
  assert.throws(
    () => locateKey([], 'k'),
    (error: unknown) => error instanceof AppError && error.code === 'EMPTY_RING',
  );
});

test('回绕：键位置超过末尾虚拟节点时回到环首', () => {
  const table = new Map<string, bigint>([
    [hex(vnodeInput('a', 0)), 10n],
    [hex(vnodeInput('b', 0)), 20n],
    [hex(keyInput('high')), 999n],
  ]);
  const hash = controlledHash(table);
  const { vnodes } = buildRing(
    [
      { name: 'a', weight: 1 },
      { name: 'b', weight: 1 },
    ],
    hash,
  );
  assert.equal(locateKey(vnodes, 'high', hash).node, 'a');
  assert.equal(locateKeyLinear(vnodes, 'high', hash).node, 'a');
});

test('相同位置：按 (position, node, vnodeIndex) 稳定选择', () => {
  const table = new Map<string, bigint>([
    [hex(vnodeInput('a', 0)), 50n],
    [hex(vnodeInput('b', 0)), 50n],
    [hex(keyInput('tie')), 50n],
    [hex(keyInput('before-tie')), 49n],
  ]);
  const hash = controlledHash(table);
  const { vnodes } = buildRing(
    [
      { name: 'b', weight: 1 },
      { name: 'a', weight: 1 },
    ],
    hash,
  );
  assert.equal(locateKey(vnodes, 'tie', hash).node, 'a');
  assert.equal(locateKey(vnodes, 'before-tie', hash).node, 'a');
  assert.equal(locateKeyLinear(vnodes, 'tie', hash).node, 'a');

  const rebuilt = buildRing(
    [
      { name: 'a', weight: 1 },
      { name: 'b', weight: 1 },
    ],
    hash,
  );
  assert.deepEqual(rebuilt.vnodes.map((v) => `${v.node}:${v.vnodeIndex}`),
    vnodes.map((v) => `${v.node}:${v.vnodeIndex}`));
});

test('节点列表顺序不改变路由结果', () => {
  const nodesA = [
    { name: 'n1', weight: 1 },
    { name: 'n2', weight: 2 },
    { name: 'n3', weight: 1 },
  ];
  const nodesB = [...nodesA].reverse();
  const ringA = buildRing(nodesA);
  const ringB = buildRing(nodesB);
  assert.equal(ringA.vnodes.length, ringB.vnodes.length);
  for (let i = 0; i < ringA.vnodes.length; i++) {
    assert.equal(compareVNode(ringA.vnodes[i]!, ringB.vnodes[i]!), 0);
  }
  for (let i = 0; i < 200; i++) {
    const key = `key-${i}`;
    assert.equal(locateKey(ringA.vnodes, key).node, locateKey(ringB.vnodes, key).node);
  }
});

test('权重变化：虚拟节点数 = 基础数 × 权重，权重越大命中越多（趋势）', () => {
  const ring = buildRing([
    { name: 'small', weight: 1 },
    { name: 'big', weight: 4 },
  ]);
  assert.equal(ring.vnodes.filter((v) => v.node === 'small').length, BASE_VNODES);
  assert.equal(ring.vnodes.filter((v) => v.node === 'big').length, BASE_VNODES * 4);

  const counts: Record<string, number> = { small: 0, big: 0 };
  for (let i = 0; i < 2000; i++) {
    const node = locateKey(ring.vnodes, `sample:${i}`).node;
    counts[node] = (counts[node] ?? 0) + 1;
  }
  assert.ok(
    (counts.big ?? 0) > (counts.small ?? 0) * 2,
    `期望 big 明显多于 small，实际 ${JSON.stringify(counts)}`,
  );
});

test('线性扫描基准与正式二分查询在随机键上一致', () => {
  const { vnodes } = buildRing([
    { name: 'alpha', weight: 2 },
    { name: 'beta', weight: 1 },
    { name: 'gamma', weight: 3 },
  ]);
  for (let i = 0; i < 500; i++) {
    const key = `cross-check:${i % 37}:${i}`;
    const byBinary = locateKey(vnodes, key);
    const byLinear = locateKeyLinear(vnodes, key);
    assert.equal(byBinary.node, byLinear.node);
    assert.equal(byBinary.position, byLinear.position);
  }
});

test('新增节点：只有落到新节点的键改变归属', () => {
  const oldRing = buildRing([
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
  ]);
  const newRing = buildRing([
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
    { name: 'd', weight: 1 },
  ]);
  for (let i = 0; i < 1000; i++) {
    const key = `k${i}`;
    const oldNode = locateKey(oldRing.vnodes, key).node;
    const newNode = locateKey(newRing.vnodes, key).node;
    if (oldNode !== newNode) assert.equal(newNode, 'd');
  }
});

test('删除节点：其他节点原有键不被重新打散', () => {
  const withB = buildRing([
    { name: 'a', weight: 1 },
    { name: 'b', weight: 1 },
    { name: 'c', weight: 1 },
  ]);
  const withoutB = buildRing([
    { name: 'a', weight: 1 },
    { name: 'c', weight: 1 },
  ]);
  for (let i = 0; i < 1000; i++) {
    const key = `k${i}`;
    const before = locateKey(withB.vnodes, key).node;
    if (before === 'b') continue;
    assert.equal(locateKey(withoutB.vnodes, key).node, before);
  }
});

test('校验：重复节点、非法权重、过多虚拟节点被拒绝', () => {
  assert.throws(
    () => validateNodes([{ name: 'x', weight: 1 }, { name: 'x', weight: 1 }]),
    (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_NODE',
  );
  assert.throws(
    () => validateNodes([{ name: 'x', weight: 0 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_WEIGHT',
  );
  assert.throws(
    () => validateNodes([{ name: 'x', weight: 1.5 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_WEIGHT',
  );
  assert.throws(
    () =>
      validateNodes([
        { name: 'x', weight: 1000 },
        { name: 'y', weight: 1000 },
        { name: 'z', weight: 1000 },
      ]),
    (e: unknown) => e instanceof AppError && e.code === 'TOO_MANY_VNODES',
  );
  assert.throws(
    () => validateNodes([]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_BODY',
  );
});

test('编码：分段长度前缀杜绝拼接碰撞，且虚拟节点与键命名空间隔离', () => {
  const enc1 = encodeParts([[1, Buffer.from('ab')], [1, Buffer.from('c')]]);
  const enc2 = encodeParts([[1, Buffer.from('a')], [1, Buffer.from('bc')]]);
  assert.notEqual(enc1.toString('hex'), enc2.toString('hex'));
  assert.notEqual(vnodeInput('n', 0).toString('hex'), keyInput('n').toString('hex'));
  assert.equal(typeof sha256Position(keyInput('x')), 'bigint');
});

test('真实哈希环：所有位置落在 256 位空间内且环严格有序', () => {
  const { vnodes } = buildRing([{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }]);
  const modulus = 1n << 256n;
  for (const vn of vnodes) {
    assert.ok(vn.position >= 0n && vn.position < modulus);
  }
  for (let i = 1; i < vnodes.length; i++) {
    assert.ok(compareVNode(vnodes[i - 1]!, vnodes[i]!) <= 0);
  }
});
