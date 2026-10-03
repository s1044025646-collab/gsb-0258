import { createHash } from 'node:crypto';

export const HASH_SPACE_BITS = 256;
export const HASH_SPACE_MODULUS = 1n << BigInt(HASH_SPACE_BITS);

export type HashFn = (input: Buffer) => bigint;

/**
 * 将若干段字节按 TLV（类型-长度-值）方式编码：
 * 每段写入 1 字节标签 + 4 字节大端长度 + 原始字节，段之间不依赖分隔符，
 * 因此 ["ab","c"] 与 ["a","bc"] 不会产生相同输入，杜绝含糊拼接碰撞。
 */
export function encodeParts(parts: ReadonlyArray<readonly [tag: number, bytes: Buffer]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [tag, bytes] of parts) {
    if (tag < 0 || tag > 255) throw new Error('tag 必须在 0..255');
    const header = Buffer.alloc(5);
    header.writeUInt8(tag, 0);
    header.writeUInt32BE(bytes.length, 1);
    chunks.push(header, bytes);
  }
  return Buffer.concat(chunks);
}

const encoder = new TextEncoder();

/** SHA-256 摘要 -> 大端无符号 BigInt 位置（256 位环空间）。 */
export function sha256Position(input: Buffer): bigint {
  const digest = createHash('sha256').update(input).digest();
  return bufferToBigIntBE(digest);
}

export function bufferToBigIntBE(buf: Buffer): bigint {
  let value = 0n;
  for (const byte of buf) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function utf8(s: string): Buffer {
  return Buffer.from(encoder.encode(s));
}

/** 虚拟节点输入：tag=1 节点名 + tag=2 虚拟序号（8 字节大端）。 */
export function vnodeInput(nodeName: string, vnodeIndex: number): Buffer {
  if (!Number.isInteger(vnodeIndex) || vnodeIndex < 0) {
    throw new Error('虚拟序号必须是非负整数');
  }
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64BE(BigInt(vnodeIndex));
  return encodeParts([
    [1, utf8(nodeName)],
    [2, indexBuf],
  ]);
}

/** 键输入：tag=3，与虚拟节点命名空间天然隔离。 */
export function keyInput(key: string): Buffer {
  return encodeParts([[3, utf8(key)]]);
}

export const realHash: HashFn = sha256Position;
