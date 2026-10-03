import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { Store } from './storage/db.js';
import { RingService } from './service.js';
import { AppError } from './core/errors.js';

interface JsonHandler {
  method: string;
  pattern: RegExp;
  handle: (svc: RingService, params: RegExpExecArray, body: unknown, url: URL) => unknown;
}

const routes: JsonHandler[] = [
  {
    method: 'POST',
    pattern: /^\/api\/rings$/,
    handle: (s, _p, body) => s.createRing(body as never),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings$/,
    handle: (s) => s.listRings(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/versions$/,
    handle: (s, p) => s.listVersions(p[1]!),
  },
  {
    method: 'POST',
    pattern: /^\/api\/rings\/([^/]+)\/evolve$/,
    handle: (s, p, body) => {
      const b = body as Record<string, unknown>;
      if (b.action !== 'add' && b.action !== 'remove') {
        throw new AppError('INVALID_ARGUMENT', "action 必须为 'add' 或 'remove'", 'action');
      }
      return s.evolve(
        p[1]!,
        b.action,
        b.node,
        optInt(b.fromVersion),
        b.label,
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/vnodes$/,
    handle: (s, p, _b, url) =>
      s.vnodes(
        p[1]!,
        queryInt(url, 'version'),
        num(url, 'limit', 128),
        url.searchParams.get('node') ?? undefined,
      ),
  },
  {
    method: 'POST',
    pattern: /^\/api\/rings\/([^/]+)\/locate$/,
    handle: (s, p, body) => {
      const b = body as Record<string, unknown>;
      if (typeof b.key !== 'string') {
        throw new AppError('INVALID_ARGUMENT', 'key 必须为字符串', 'key');
      }
      return s.locate(p[1]!, optInt(b.version), b.key);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rings\/([^/]+)\/locate-batch$/,
    handle: (s, p, body) => {
      const b = body as Record<string, unknown>;
      return s.locateBatch(p[1]!, optInt(b.version), b.keys as string[]);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rings\/([^/]+)\/keys$/,
    handle: (s, p, body) => s.addSampleKeys(p[1]!, (body as Record<string, unknown>).keys),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/keys$/,
    handle: (s, p) => s.listSampleKeys(p[1]!),
  },
  {
    method: 'POST',
    pattern: /^\/api\/rings\/([^/]+)\/compare$/,
    handle: (s, p, body) => {
      const b = body as Record<string, unknown>;
      const oldV = optInt(b.oldVersion);
      const newV = optInt(b.newVersion);
      if (oldV === undefined || newV === undefined) {
        throw new AppError('INVALID_ARGUMENT', 'oldVersion 与 newVersion 必须为整数版本号');
      }
      return s.compare(p[1]!, oldV, newV);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/reports$/,
    handle: (s, p) => s.listReports(p[1]!),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/reports\/(\d+)$/,
    handle: (s, p) => s.getReport(p[1]!, Number(p[2])),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rings\/([^/]+)\/export$/,
    handle: (s, p) => s.exportRing(p[1]!),
  },
];

function optInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new AppError('INVALID_ARGUMENT', '版本号必须为整数');
  }
  return v;
}

function num(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AppError('INVALID_ARGUMENT', `${key} 必须为数字`);
  return n;
}

function queryInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AppError('INVALID_ARGUMENT', `${key} 必须为整数`);
  return n;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > 4_000_000) throw new AppError('INVALID_ARGUMENT', '请求体过大（上限 4MB）');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, bigIntReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function createApp(store: Store): Server {
  const svc = new RingService(store);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true });
        return;
      }
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? null : await readJson(req);
        send(res, 200, { data: route.handle(svc, m, body, url) });
        return;
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: '未知路由' } });
    } catch (e) {
      if (e instanceof AppError) {
        send(res, e.status, { error: { code: e.code, message: e.message, field: e.field ?? null } });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        send(res, 500, { error: { code: 'INTERNAL', message } });
      }
    }
  });
}

function listenOnFreePort(server: Server, preferred: number | undefined): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryListen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          tryListen(0);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolvePort(addr.port);
        else reject(new Error('无法获取监听端口'));
      });
    };
    tryListen(preferred ?? 0);
  });
}

async function main(): Promise<void> {
  const dataDir = process.env.CHL_DATA_DIR
    ? resolve(process.env.CHL_DATA_DIR)
    : resolve(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(resolve(dataDir, 'chashlab.db'));
  const app = createApp(store);
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = await listenOnFreePort(app, preferred);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: '一致性哈希实验服务已启动',
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
  }));
}

// ESM 直接运行时才启动（被测试 import 时不启动）。
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
