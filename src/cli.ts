import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './storage/db.js';
import { RingService } from './service.js';
import { AppError } from './core/errors.js';

function usage(): string {
  return [
 '用法: chashlab <命令> [参数]',
    '',
    '命令:',
    '  create <name> --nodes nodeA:2,nodeB:1,nodeC:1 [--label L] [--no-seed]',
    '  list                         列出所有环',
    '  versions <name>              列出配置版本',
    '  vnodes <name> [--version V] [--node ID] [--limit N]',
    '  locate <name> <key> [--version V]',
    '  locate-batch <name> --keys k1,k2,... [--version V]',
    '  add-key <name> <key>         追加一个样本键',
    '  keys <name>                  查看样本键',
    '  add-node <name> <nodeId> --weight W [--from-version V] [--label L]',
    '  remove-node <name> <nodeId> [--from-version V] [--label L]',
    '  compare <name> --old V --new V     生成迁移报告（快照保存）',
    '  reports <name>               列出报告',
    '  report <name> <reportId>     查看报告',
    '  export <name>                导出整个环（JSON）',
    '',
    '环境变量:',
    '  CHL_DATA_DIR   数据目录（默认 ./data）',
  ].join('\n');
}

function parseNodes(spec: string): Array<{ id: string; weight: number }> {
  return spec.split(',').map((part) => {
    const [id, w] = part.split(':');
    if (!id || w === undefined) {
      throw new AppError('INVALID_ARGUMENT', `节点规格非法: ${part}（应为 id:weight）`);
    }
    return { id, weight: Number(w) };
  });
}

function arg(args: string[], long: string): string | undefined {
  const i = args.indexOf(long);
  return i >= 0 ? args[i + 1] : undefined;
}

function flag(args: string[], long: string): boolean {
  return args.includes(long);
}

function intArg(args: string[], long: string): number | undefined {
  const v = arg(args, long);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError('INVALID_ARGUMENT', `${long} 需要整数`);
  return n;
}

async function run(argv: string[]): Promise<number> {
  const dataDir = process.env.CHL_DATA_DIR
    ? resolve(process.env.CHL_DATA_DIR)
    : resolve(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(resolve(dataDir, 'chashlab.db'));
  const svc = new RingService(store);

  const cmd = argv[0];
  const rest = argv.slice(1);
  let out: unknown = null;

  try {
    switch (cmd) {
      case 'create': {
        const name = rest[0];
        const spec = arg(rest, '--nodes');
        if (!name || !spec) throw new AppError('INVALID_ARGUMENT', 'create 需要 name 与 --nodes');
        out = svc.createRing({
          name,
          nodes: parseNodes(spec),
          label: arg(rest, '--label'),
          seedKeys: flag(rest, '--no-seed') ? false : undefined,
        });
        break;
      }
      case 'list':
        out = svc.listRings();
        break;
      case 'versions':
        if (!rest[0]) throw new AppError('INVALID_ARGUMENT', '需要环名称');
        out = svc.listVersions(rest[0]);
        break;
      case 'vnodes': {
        const name = rest[0]!;
        out = svc.vnodes(
          name,
          intArg(rest, '--version'),
          Number(arg(rest, '--limit') ?? '128'),
          arg(rest, '--node'),
        );
        break;
      }
      case 'locate': {
        const [name, key] = rest;
        if (!name || !key) throw new AppError('INVALID_ARGUMENT', 'locate 需要 name 与 key');
        out = svc.locate(name, intArg(rest, '--version'), key);
        break;
      }
      case 'locate-batch': {
        const name = rest[0]!;
        const keys = arg(rest, '--keys');
        if (!keys) throw new AppError('INVALID_ARGUMENT', '需要 --keys k1,k2,...');
        out = svc.locateBatch(name, intArg(rest, '--version'), keys.split(','));
        break;
      }
      case 'add-key': {
        const [name, key] = rest;
        if (!name || !key) throw new AppError('INVALID_ARGUMENT', 'add-key 需要 name 与 key');
        out = svc.addSampleKeys(name, [key]);
        break;
      }
      case 'keys':
        out = svc.listSampleKeys(rest[0]!);
        break;
      case 'add-node': {
        const [name, nodeId] = rest;
        const weight = Number(arg(rest, '--weight') ?? '1');
        if (!name || !nodeId) throw new AppError('INVALID_ARGUMENT', 'add-node 需要 name 与 nodeId');
        out = svc.evolve(
          name,
          'add',
          { id: nodeId, weight },
          intArg(rest, '--from-version'),
          arg(rest, '--label'),
        );
        break;
      }
      case 'remove-node': {
        const [name, nodeId] = rest;
        if (!name || !nodeId) throw new AppError('INVALID_ARGUMENT', 'remove-node 需要 name 与 nodeId');
        out = svc.evolve(
          name,
          'remove',
          nodeId,
          intArg(rest, '--from-version'),
          arg(rest, '--label'),
        );
        break;
      }
      case 'compare': {
        const name = rest[0];
        const oldV = intArg(rest, '--old');
        const newV = intArg(rest, '--new');
        if (!name || oldV === undefined || newV === undefined) {
          throw new AppError('INVALID_ARGUMENT', 'compare 需要 name --old V --new V');
        }
        out = svc.compare(name, oldV, newV);
        break;
      }
      case 'reports':
        out = svc.listReports(rest[0]!);
        break;
      case 'report': {
        const [name, id] = rest;
        if (!name || id === undefined) throw new AppError('INVALID_ARGUMENT', 'report 需要 name 与 reportId');
        out = svc.getReport(name, Number(id));
        break;
      }
      case 'export':
        out = svc.exportRing(rest[0]!);
        break;
      default:
        process.stdout.write(usage() + '\n');
        return cmd === undefined ? 0 : 2;
    }

    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } finally {
    store.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof AppError) {
      process.stderr.write(
        JSON.stringify({ error: { code: e.code, message: e.message, field: e.field ?? null } }, null, 2) +
          '\n',
      );
      process.exit(1);
    }
    process.stderr.write(String(e instanceof Error ? e.stack ?? e.message : e) + '\n');
    process.exit(1);
  },
);
