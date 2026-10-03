import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/storage/db.js';
import { createApp } from '../src/server.js';
import type { Server } from 'node:http';

const dir = resolve(tmpdir(), `chashlab-api-${process.pid}-${Date.now()}`);
let base: string;
let server: Server;
let store: Store;

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  store = new Store(resolve(dir, 'api.db'));
  server = createApp(store);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

test('健康检查与建环全流程', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);

  const created = await call('POST', '/api/rings', {
    name: 'web',
    nodes: [
      { id: 'n1', weight: 1 },
      { id: 'n2', weight: 2 },
      { id: 'n3', weight: 1 },
    ],
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.data.version, 1);

  const dup = await call('POST', '/api/rings', {
    name: 'web',
    nodes: [{ id: 'x', weight: 1 }],
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'DUPLICATE_RING');
});

test('定位、虚拟点、演进与对照', async () => {
  const loc = await call('POST', '/api/rings/web/locate', { key: 'user:1001' });
  assert.equal(loc.status, 200);
  assert.ok(['n1', 'n2', 'n3'].includes(loc.json.data.nodeId));

  const vp = await call('GET', '/api/rings/web/vnodes?limit=3');
  assert.equal(vp.status, 200);
  assert.equal(vp.json.data.points.length, 3);

  await call('POST', '/api/rings/web/evolve', { action: 'add', node: { id: 'n4', weight: 1 } });
  const report = await call('POST', '/api/rings/web/compare', { oldVersion: 1, newVersion: 2 });
  assert.equal(report.status, 200);
  assert.ok(report.json.data.report.summary.totalKeys > 0);

  const list = await call('GET', '/api/rings/web/reports');
  assert.equal(list.json.data.length, 1);

  const exported = await call('GET', '/api/rings/web/export');
  assert.equal(exported.json.data.versions.length, 2);
});

test('错误码：非法 JSON、空环、未知环、坏参数', async () => {
  const badJson = await fetch(base + '/api/rings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  const bj = (await badJson.json()) as { error: { code: string } };
  assert.equal(bj.error.code, 'INVALID_JSON');

  const missing = await call('GET', '/api/rings/nope/versions');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'RING_NOT_FOUND');

  const badWeight = await call('POST', '/api/rings', {
    name: 'badw',
    nodes: [{ id: 'x', weight: -3 }],
  });
  assert.equal(badWeight.status, 422);
  assert.equal(badWeight.json.error.code, 'INVALID_WEIGHT');

  const unknownRoute = await call('GET', '/nope');
  assert.equal(unknownRoute.status, 404);
});
