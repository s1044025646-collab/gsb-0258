#!/usr/bin/env node
import { type DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { listRings, openDatabase, getReport, listReports } from './db.js';
import { AppError } from './errors.js';
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
const db: DatabaseSync = openDatabase(join(DATA_DIR, 'chlab.sqlite'));

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseNodesArg(raw: string): Array<{ name: string; weight: number }> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) throw new Error();
    return value as Array<{ name: string; weight: number }>;
  } catch {
    throw new AppError('INVALID_BODY', '--nodes 必须是 JSON 数组，例如 [{"name":"a","weight":1}]');
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function usage(): never {
  console.error(`用法: npm run cli -- <命令> [参数]

命令:
  list                                          列出所有环
  create --name <名> --nodes '<JSON>' [--note]  建环（带节点）
  create-empty --name <名>                      显式建空环
  show <环名或ID>                                查看环与版本
  vnodes <环> [--version N]                     查看虚拟节点位置
  route <环> --key <键> [--version N]           单键定位
  add-keys <环> --keys a,b,c                    添加样本键
  seed <环>                                     写入固定种子键集合
  evolve <环> --add <节点> [--weight N]         新版本：新增节点
  evolve <环> --remove <节点>                   新版本：移除节点
  compare <环> [--old N] [--new N] [--save]     版本对照（默认最新两版）
  reports <环>                                  列出已保存报告
  report <环> --id N [--format json|csv]        查看/导出报告

环境变量:
  CHLAB_DATA_DIR   数据目录（默认 ./data）`);
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];

try {
  switch (command) {
    case 'list': {
      print({
        rings: listRings(db).map((r) => ({
          id: r.id,
          name: r.name,
          latestVersion: currentVersionOrZero(r.id),
        })),
      });
      break;
    }
    case 'create': {
      const name = flag(args, '--name');
      const nodesRaw = flag(args, '--nodes');
      if (!name || !nodesRaw) usage();
      print(createRing(db, name, parseNodesArg(nodesRaw), flag(args, '--note') ?? null));
      break;
    }
    case 'create-empty': {
      const name = flag(args, '--name');
      if (!name) usage();
      print(createEmptyRing(db, name, null));
      break;
    }
    case 'show': {
      const ref = args[1];
      if (!ref) usage();
      const { ringId, name } = resolveRing(db, ref);
      print({ ringId, name, versions: listVersionSummaries(db, ringId) });
      break;
    }
    case 'vnodes': {
      const ref = args[1];
      if (!ref) usage();
      const { ringId } = resolveRing(db, ref);
      const versionRaw = flag(args, '--version');
      const result = getVNodes(db, ringId, versionRaw ? Number(versionRaw) : null);
      print({ version: result.version, count: result.vnodes.length, vnodes: result.vnodes });
      break;
    }
    case 'route': {
      const ref = args[1];
      const key = flag(args, '--key');
      if (!ref || !key) usage();
      const { ringId } = resolveRing(db, ref);
      print(routeKey(db, ringId, key, versionFlag(args)));
      break;
    }
    case 'add-keys': {
      const ref = args[1];
      const keysRaw = flag(args, '--keys');
      if (!ref || !keysRaw) usage();
      print(addKeys(db, resolveRing(db, ref).ringId, keysRaw.split(',')));
      break;
    }
    case 'seed': {
      const ref = args[1];
      if (!ref) usage();
      print(addKeys(db, resolveRing(db, ref).ringId, SEED_KEYS));
      break;
    }
    case 'evolve': {
      const ref = args[1];
      if (!ref) usage();
      const { ringId } = resolveRing(db, ref);
      const addNode = flag(args, '--add');
      const removeNode = flag(args, '--remove');
      if (addNode) {
        const weightRaw = flag(args, '--weight');
        print(
          evolveRing(db, ringId, {
            action: 'add',
            node: addNode,
            weight: weightRaw ? Number(weightRaw) : 1,
            note: flag(args, '--note'),
          }),
        );
      } else if (removeNode) {
        print(evolveRing(db, ringId, { action: 'remove', node: removeNode }));
      } else {
        usage();
      }
      break;
    }
    case 'compare': {
      const ref = args[1];
      if (!ref) usage();
      const { ringId } = resolveRing(db, ref);
      const latest = currentVersion(db, ringId);
      const oldVersion = Number(flag(args, '--old') ?? Math.max(1, latest - 1));
      const newVersion = Number(flag(args, '--new') ?? latest);
      const report = compareVersions(db, ringId, oldVersion, newVersion, null);
      if (hasFlag(args, '--save')) {
        const id = saveReport(db, ringId, report);
        print({ reportId: id, report });
      } else {
        print({ report });
      }
      break;
    }
    case 'reports': {
      const ref = args[1];
      if (!ref) usage();
      print({ reports: listReports(db, resolveRing(db, ref).ringId) });
      break;
    }
    case 'report': {
      const ref = args[1];
      const idRaw = flag(args, '--id');
      if (!ref || !idRaw) usage();
      const { ringId } = resolveRing(db, ref);
      const row = getReport(db, ringId, Number(idRaw));
      if (!row) throw new AppError('REPORT_NOT_FOUND', `报告不存在: #${idRaw}`, 404);
      const format = flag(args, '--format') ?? 'json';
      if (format === 'csv') {
        const report = JSON.parse(row.payload_json) as {
          keys: Array<{ key: string; oldNode: string | null; newNode: string | null; migrated: boolean }>;
        };
        console.log('key,oldNode,newNode,migrated');
        for (const item of report.keys) {
          console.log(`${item.key},${item.oldNode ?? ''},${item.newNode ?? ''},${item.migrated ? 1 : 0}`);
        }
      } else {
        print(JSON.parse(row.payload_json));
      }
      break;
    }
    default:
      usage();
  }
} catch (error) {
  if (error instanceof AppError) {
    console.error(`错误 [${error.code}] ${error.message}`);
    process.exit(2);
  }
  throw error;
}

function versionFlag(argv: string[]): number | null {
  const raw = flag(argv, '--version');
  return raw ? Number(raw) : null;
}

function currentVersionOrZero(ringId: number): number {
  try {
    return currentVersion(db, ringId);
  } catch {
    return 0;
  }
}
