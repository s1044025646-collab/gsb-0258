import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  HashRing,
  linearLocate,
  BASE_VNODES,
  normalizeNodes,
} from '../src/core/ring.js';
import { encodeKey, encodeVNode, keyPosition, positionFromDigest, sha256, vnodePosition } from '../src/core/hash.js';
import { buildMigrationReport } from '../src/core/migration.js';
import type { HashFn } from '../src/core/hash.js';
import { AppError } from '../src/core/errors.js';

const N3 = [
  { id: 'node-a', weight: 1 },
  { id: 'node-b', weight: 1 },
  { id: 'node-c', weight: 1 },
];

test('编码无歧义：不同拼接不会碰撞，节点域与键域隔离', () => {
  assert.deepEqual(
    Buffer.from(encodeVNode('ab', 1)),
    Buffer.concat([Buffer.from([1]), Buffer.from([2, 0]), Buffer.from('ab'), Buffer.from([1, 0, 0, 0])]),
  );
  assert.notDeepEqual(Buffer.from(encodeVNode('a', 1)), Buffer.from(encodeVNode('a', 2)));
  assert.notDeepEqual(Buffer.from(encodeKey('x')), Buffer.from(encodeVNode('x', 0)));
  assert.equal(positionFromDigest(Buffer.alloc(8, 0xff)), 2n ** 64n - 1n);
  assert.equal(positionFromDigest(Buffer.alloc(8, 0x00)), 0n);
  assert.equal(positionFromDigest(Buffer.from([0x01, 0x00, ...Buffer.alloc(6, 0)])), 2n ** 56n);
});

test('单节点环：所有键都路由到该节点', () => {
  const ring = new HashRing([{ id: 'only', weight: 1 }]);
  for (const k of ['a', 'b', 'c', 'z']) {
    assert.equal(ring.locateKey(k).nodeId, 'only');
  }
});

test('空环、重复节点、非法权重被拒绝并带错误码', () => {
  assert.throws(() => new HashRing([]), (e: unknown) => e instanceof AppError && e.code === 'EMPTY_RING');
  assert.throws(
    () => new HashRing(normalizeNodes([{ id: 'a', weight: 1 }, { id: 'a', weight: 1 }])),
    (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_NODE',
  );
  assert.throws(
    () => normalizeNodes([{ id: 'a', weight: 0 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_WEIGHT',
  );
  assert.throws(
    () => normalizeNodes([{ id: 'a', weight: 8193 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_WEIGHT',
  );
  assert.throws(
    () => normalizeNodes([{ id: 'bad id', weight: 1 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_NODE_NAME',
  );
});

function digestBE8(value: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(value);
  return buf;
}

/** 受控哈希：0x01 虚拟节点 -> 固定位置 100；0x02 键位置由外部 map 决定。 */
function controlledHash(keyPos: bigint): HashFn {
  return (input) => (input[0] === 0x01 ? digestBE8(100n) : digestBE8(keyPos));
}

test('相同位置的稳定选择：tiebreak 固定为 (nodeId, vindex)', () => {
  const ring = new HashRing(
    [
      { id: 'node-c', weight: 1 },
      { id: 'node-a', weight: 1 },
      { id: 'node-b', weight: 1 },
    ],
    controlledHash(100n),
  );
  const r = ring.locateKey('k');
  assert.equal(r.vnodePosition, 100n);
  assert.equal(r.nodeId, 'node-a');
  assert.equal(r.vindex, 0);
});

test('回绕：键位置超过末尾时选中全环最小点', () => {
  const ring = new HashRing(
    [
      { id: 'node-c', weight: 1 },
      { id: 'node-a', weight: 1 },
    ],
    controlledHash(200n),
  );
  const r = ring.locateKey('k');
  assert.equal(r.nodeId, 'node-a');
  assert.equal(r.vnodePosition, 100n);
});

test('节点列表顺序不改变路由', () => {
  const r1 = new HashRing(N3);
  const r2 = new HashRing([...N3].reverse());
  for (let i = 0; i < 200; i++) {
    const key = `sample-key-${i}`;
    assert.deepEqual(
      { n: r1.locateKey(key).nodeId, p: r1.locateKey(key).vnodePosition },
      { n: r2.locateKey(key).nodeId, p: r2.locateKey(key).vnodePosition },
    );
  }
});

test('权重改变虚拟点数量且路由仍确定', () => {
  const light = new HashRing([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]);
  const heavy = new HashRing([{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }]);
  assert.equal(light.points.length, BASE_VNODES * 2);
  assert.equal(heavy.points.length, BASE_VNODES * 4);
  assert.equal(heavy.nodes.get('a')!.vnodes, BASE_VNODES * 3);
  for (let i = 0; i < 50; i++) {
    const k = `w-${i}`;
    assert.equal(heavy.locateKey(k).nodeId, heavy.locateKey(k).nodeId);
  }
});

test('正式二分查询与独立线性扫描基准一致（含随机回绕场景）', () => {
  const nodes = [
    { id: 'alpha', weight: 2 },
    { id: 'beta', weight: 1 },
    { id: 'gamma', weight: 3 },
  ];
  const ring = new HashRing(nodes);
  const keys = Array.from({ length: 300 }, (_, i) => `crosscheck:${i}:${(i * 2654435761) >>> 0}`);
  for (const k of keys) {
    const fast = ring.locateKey(k);
    const slow = linearLocate(nodes, k);
    assert.equal(fast.nodeId, slow.nodeId, `节点不一致: ${k}`);
    assert.equal(fast.vnodePosition, slow.vnodePosition, `虚拟点不一致: ${k}`);
    assert.equal(fast.vindex, slow.vindex);
  }
});

test('新增节点：只有迁往新节点的键改变；删除节点：其他节点的键不被打散', () => {
  const keys = Array.from({ length: 400 }, (_, i) => `m-${i}`);
  const r1 = new HashRing(N3);
  const r2 = new HashRing([...N3, { id: 'node-d', weight: 1 }]);

  for (const k of keys) {
    const before = r1.locateKey(k).nodeId;
    const after = r2.locateKey(k).nodeId;
    if (before !== after) assert.equal(after, 'node-d', `新增节点时出现非目标迁移: ${k}`);
  }

  // v3 = 从 v2（a,b,c,d）移除 b，保留 d
  const r3 = new HashRing(
    [...N3, { id: 'node-d', weight: 1 }].filter((n) => n.id !== 'node-b'),
  );
  for (const k of keys) {
    const onV2 = r2.locateKey(k).nodeId;
    const onV3 = r3.locateKey(k).nodeId;
    if (onV2 !== 'node-b') {
      assert.equal(onV3, onV2, `删除节点后存留节点的键被重新打散: ${k}`);
    } else {
      assert.notEqual(onV3, 'node-b');
    }
  }
});

test('迁移报告：总数守恒、明细与统计一致、比例正确', () => {
  const keys = Array.from({ length: 250 }, (_, i) => `rep-${i}`);
  const report = buildMigrationReport(
    N3,
    [...N3, { id: 'node-d', weight: 2 }],
    keys,
    1,
    2,
    sha256,
  );
  assert.equal(report.items.length, keys.length);
  const sumOld = report.summary.nodeStats.reduce((s, x) => s + x.oldCount, 0);
  const sumNew = report.summary.nodeStats.reduce((s, x) => s + x.newCount, 0);
  assert.equal(sumOld, keys.length);
  assert.equal(sumNew, keys.length);
  const migrated = report.items.filter((i) => i.migrated).length;
  assert.equal(migrated, report.summary.migratedKeys);
  assert.ok(report.summary.migrationRatio >= 0 && report.summary.migrationRatio <= 1);
  for (const item of report.items) {
    assert.equal(item.migrated, item.oldNode !== item.newNode);
    assert.equal(item.oldKeyPosition, keyPosition(sha256, item.key).toString());
  }
  assert.ok(report.note.includes('不代表理论均匀分布'));
});

test('真实 SHA-256 位置与虚拟点位置在环上单调有序', () => {
  const ring = new HashRing(N3);
  for (let i = 1; i < ring.points.length; i++) {
    assert.ok(ring.points[i - 1]!.position <= ring.points[i]!.position);
  }
  const kp = keyPosition(sha256, 'ordering-check');
  const loc = ring.locateKey('ordering-check');
  const min = ring.points[0]!.position;
  const max = ring.points[ring.points.length - 1]!.position;
  if (kp <= max) {
    assert.ok(loc.vnodePosition >= kp);
  } else {
    assert.equal(loc.vnodePosition, min);
  }
  const expectedVp = vnodePosition(sha256, loc.nodeId, loc.vindex);
  assert.equal(loc.vnodePosition, expectedVp);
});
