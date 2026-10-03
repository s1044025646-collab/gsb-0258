import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { openDatabase, listRings, getReport, listReports } from './db.js';
import { AppError, errorStatusCode } from './errors.js';
import {
  addKeys,
  compareVersions,
  createEmptyRing,
  createRing,
  currentVersion,
  evolveRing,
  getVNodes,
  listVersionSummaries,
  resolveRing,
  routeKey,
  saveReport,
  SEED_KEYS,
} from './service.js';

const DATA_DIR = process.env.CHLAB_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'chlab.sqlite');

const db = openDatabase(DB_PATH);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, bigIntReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError('INVALID_BODY', '请求体不是合法 JSON');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_BODY', '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function parseRingRef(url: URL): string {
  return decodeURIComponent(url.pathname.split('/')[3] ?? '');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, service: 'consistent-hash-lab' });
    return;
  }

  if (method === 'GET' && path === '/api/rings') {
    sendJson(res, 200, {
      rings: listRings(db).map((r) => ({
        id: r.id,
        name: r.name,
        latestVersion: currentVersionOrZero(r.id),
        createdAt: r.created_at,
      })),
    });
    return;
  }

  if (method === 'POST' && path === '/api/rings') {
    const body = asObject(await readJson(req));
    const name = String(body.name ?? '');
    const note = body.note === undefined ? null : String(body.note);
    if (body.empty === true) {
      const result = createEmptyRing(db, name, note);
      sendJson(res, 201, result);
      return;
    }
    const result = createRing(db, name, body.nodes as never, note);
    sendJson(res, 201, result);
    return;
  }

  const ringMatch = path.match(/^\/api\/rings\/([^/]+)(?:\/(.*))?$/);
  if (ringMatch) {
    const ref = decodeURIComponent(ringMatch[1]!);
    const sub = ringMatch[2] ?? '';
    const { ringId, name } = resolveRing(db, ref);

    if (sub === '' && method === 'GET') {
      sendJson(res, 200, {
        ringId,
        name,
        latestVersion: currentVersion(db, ringId),
        versions: listVersionSummaries(db, ringId),
      });
      return;
    }

    if (sub === 'evolve' && method === 'POST') {
      const body = asObject(await readJson(req));
      const result = evolveRing(db, ringId, body as never);
      sendJson(res, 201, result);
      return;
    }

    if (sub === 'vnodes' && method === 'GET') {
      const versionParam = url.searchParams.get('version');
      const version = versionParam === null ? null : parseVersion(versionParam);
      const { version: v, vnodes } = getVNodes(db, ringId, version);
      sendJson(res, 200, { ring: name, version: v, count: vnodes.length, vnodes });
      return;
    }

    if (sub === 'route' && method === 'GET') {
      const key = url.searchParams.get('key');
      if (key === null) throw new AppError('INVALID_QUERY', '缺少 query 参数 key');
      const versionParam = url.searchParams.get('version');
      const version = versionParam === null ? null : parseVersion(versionParam);
      sendJson(res, 200, routeKey(db, ringId, key, version));
      return;
    }

    if (sub === 'route-batch' && method === 'POST') {
      const body = asObject(await readJson(req));
      const keys = body.keys;
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
        throw new AppError('INVALID_BODY', 'keys 必须是字符串数组');
      }
      const versionParam =
        typeof body.version === 'number' ? body.version : null;
      const results = keys.map((key) => routeKey(db, ringId, String(key), versionParam));
      sendJson(res, 200, { results });
      return;
    }

    if (sub === 'keys' && method === 'GET') {
      const { listSampleKeys } = await import('./db.js');
      sendJson(res, 200, { keys: listSampleKeys(db, ringId) });
      return;
    }

    if (sub === 'keys' && method === 'POST') {
      const body = asObject(await readJson(req));
      let keys = body.keys;
      if (body.seed === true) keys = SEED_KEYS;
      if (!Array.isArray(keys)) throw new AppError('INVALID_BODY', 'keys 必须是数组');
      sendJson(res, 201, addKeys(db, ringId, keys as string[]));
      return;
    }

    if (sub === 'compare' && method === 'POST') {
      const body = asObject(await readJson(req));
      const latest = currentVersion(db, ringId);
      const oldVersion = parseOptVersion(body.oldVersion, 1);
      const newVersion = parseOptVersion(body.newVersion, latest);
      const report = compareVersions(db, ringId, oldVersion, newVersion, null);
      const persist = body.persist === true;
      const response: Record<string, unknown> = { report };
      if (persist) {
        const id = saveReport(db, ringId, report);
        response.reportId = id;
      }
      sendJson(res, 200, response);
      return;
    }

    const reportMatch = sub.match(/^reports(?:\/(\d+))?$/);
    if (reportMatch && method === 'GET') {
      const id = reportMatch[1];
      if (id === undefined) {
        sendJson(res, 200, { reports: listReports(db, ringId) });
      } else {
        const row = getReport(db, ringId, Number(id));
        if (!row) throw new AppError('REPORT_NOT_FOUND', `报告不存在: #${id}`, 404);
        sendJson(res, 200, {
          id: row.id,
          oldVersion: row.old_version,
          newVersion: row.new_version,
          createdAt: row.created_at,
          report: JSON.parse(row.payload_json),
        });
      }
      return;
    }

    if (reportMatch && method === 'GET' && url.searchParams.get('format') === 'csv') {
      throw new AppError('INVALID_QUERY', 'CSV 导出请使用 /reports/:id/export.csv');
    }

    const exportMatch = sub.match(/^reports\/(\d+)\/export\.(json|csv)$/);
    if (exportMatch && method === 'GET') {
      const row = getReport(db, ringId, Number(exportMatch[1]));
      if (!row) {
        throw new AppError('REPORT_NOT_FOUND', `报告不存在: #${exportMatch[1]}`, 404);
      }
      const report = JSON.parse(row.payload_json);
      if (exportMatch[2] === 'json') {
        sendJson(res, 200, report);
      } else {
        const csv = reportToCsv(report);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="report-${exportMatch[1]}.csv"`,
        });
        res.end(csv);
      }
      return;
    }
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${method} ${path}` } });
}

function currentVersionOrZero(ringId: number): number {
  try {
    return currentVersion(db, ringId);
  } catch {
    return 0;
  }
}

function parseVersion(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new AppError('INVALID_QUERY', `version 必须是正整数: ${raw}`);
  }
  return Number(raw);
}

function parseOptVersion(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  throw new AppError('INVALID_BODY', '版本号必须是 >=1 的整数');
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function reportToCsv(report: {
  keys: Array<{ key: string; oldNode: string | null; newNode: string | null; migrated: boolean }>;
}): string {
  const lines = ['key,oldNode,newNode,migrated'];
  for (const row of report.keys) {
    lines.push(
      [
        csvEscape(row.key),
        csvEscape(row.oldNode ?? ''),
        csvEscape(row.newNode ?? ''),
        row.migrated ? '1' : '0',
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

const server: Server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof AppError) {
      sendJson(res, errorStatusCode(error.code), {
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: { code: 'INTERNAL', message } });
    }
  });
});

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const requestedPort = Number(process.env.PORT ?? '0');
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  console.error(`非法端口: ${process.env.PORT ?? ''}`);
  process.exit(1);
}

listen(requestedPort)
  .then((port) => {
    console.log(`[consistent-hash-lab] 数据目录: ${DATA_DIR}`);
    console.log(`[consistent-hash-lab] 服务已启动: http://127.0.0.1:${port}`);
    console.log('[consistent-hash-lab] 健康检查: GET /health');
  })
  .catch((error: Error) => {
    console.error('启动失败:', error.message);
    process.exit(1);
  });

export { server, db };
