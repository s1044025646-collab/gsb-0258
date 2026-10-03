import { createHash } from 'node:crypto';
import { fail } from './errors.js';

export type HashFn = (input: Uint8Array) => Uint8Array;

/**
 * 生产路径哈希：SHA-256，返回固定 32 字节摘要。
 */
export const sha256: HashFn = (input) => {
  const d = createHash('sha256');
  d.update(input);
  return d.digest();
};

export const POSITION_BYTES = 8;
export const RING_SPAN = 1n << BigInt(POSITION_BYTES * 8); // 2^64

/**
 * 输入编码（固定、无歧义）：
 *   节点虚拟点： tag=0x01 | idUtf8 字节数(2B, LE) | idUtf8 | vindex(4B, LE)
 *   样本键：     tag=0x02 | keyUtf8 字节数(4B, LE) | keyUtf8
 * 长度前缀杜绝 "a"+"bc" 与 "ab"+"c" 之类拼接碰撞；
 * 节点域与键域使用不同 tag 隔离；vindex 固定 4 字节小端。
 */

function encodeString(tag: number, lenBytes: number, text: string, maxLen: number): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length > maxLen) {
    fail('INVALID_ARGUMENT', `输入 UTF-8 字节长度 ${body.length} 超过上限 ${maxLen}`);
  }
  const buf = Buffer.alloc(1 + lenBytes + body.length);
  buf.writeUInt8(tag, 0);
  if (lenBytes === 2) {
    buf.writeUInt16LE(body.length, 1);
  } else if (lenBytes === 4) {
    buf.writeUInt32LE(body.length, 1);
  } else {
    throw new Error('unsupported length width');
  }
  body.copy(buf, 1 + lenBytes);
  return buf;
}

export function encodeVNode(nodeId: string, vindex: number): Uint8Array {
  const head = encodeString(0x01, 2, nodeId, 65535);
  const buf = Buffer.alloc(head.length + 4);
  head.copy(buf, 0);
  buf.writeUInt32LE(vindex, head.length);
  return buf;
}

export function encodeKey(key: string): Uint8Array {
  return encodeString(0x02, 4, key, 1_048_576);
}

/**
 * 取摘要前 8 字节按大端解释为 0..2^64-1 的无符号位置。
 * 固定宽度、固定字节序，BigInt 保证精确。
 */
export function positionFromDigest(digest: Uint8Array): bigint {
  if (digest.length < POSITION_BYTES) {
    throw new Error('digest too short');
  }
  return Buffer.from(digest.subarray(0, POSITION_BYTES)).readBigUInt64BE(0);
}

export function vnodePosition(hash: HashFn, nodeId: string, vindex: number): bigint {
  return positionFromDigest(hash(encodeVNode(nodeId, vindex)));
}

export function keyPosition(hash: HashFn, key: string): bigint {
  return positionFromDigest(hash(encodeKey(key)));
}
