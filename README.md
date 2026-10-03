# 一致性哈希分片路由与迁移对照实验后端

离线的**单副本**一致性哈希（Consistent Hashing）实验服务：维护命名节点与整数权重，把字符串键路由到节点，并比较增加/移除节点前后键归属的变化。只提供 API 与 CLI。

- 不连接真实集群、不复制数据、不做故障探测、不做负载均衡代理。
- 数据保存在项目内 SQLite 数据目录，配置版本、样本键、迁移报告都是**不可变快照**：修改配置不会改变旧报告，重启后旧版本结果保持一致。
- 仅依赖 TypeScript（开发期）；运行期使用 Node.js 内置能力（`node:sqlite`、`node:crypto`、`node:test`、`fetch`），无需 Docker、WSL、付费服务或外部在线 API。

## 环境要求

- Windows 本地 PowerShell（跨平台亦可）
- Node.js **>= 22.5**（开发与验证使用 v25；需要内置 `node:sqlite`）

## 安装与构建

```powershell
npm install
npm run build
```

编译产物输出到 `dist/`。

## 一键可重复演示

```powershell
npm run demo
```

演示使用独立目录 `data-demo/`（每次运行先清空重建），流程固定：

1. 用内置固定种子样本键（30 个输入，其中 `metric:6004` 故意重复，演示重复输入去重）创建三节点环 `demo` v1（`node-a/b/c`，权重均为 1）。
2. 展示单键定位（键位置、命中虚拟点位置、vindex）。
3. 新增 `node-d` 生成 v2，输出 v1→v2 的少量迁移明细与完整统计。
4. 移除 `node-b` 生成 v3，输出 v2→v3 明细与统计。
5. 验证旧报告为快照、展示前 5 个虚拟点、导出汇总。

## 启动 HTTP 服务

```powershell
npm start
# 或指定端口与数据目录
$env:PORT="3000"; $env:CHL_DATA_DIR=".\data"; npm start
```

- 默认**不固定端口**：监听 127.0.0.1 的一个空闲端口，启动日志以 JSON 打印实际 `baseUrl`。
- 设置 `PORT` 时若端口被占用，会自动回退到空闲端口。

## 测试

```powershell
npm test
```

使用内置 `node:test`，覆盖：单节点环、空环、回绕、相同位置的稳定选择（注入受控哈希）、权重变化、重复键、节点重排无关性、新增/删除节点的局部影响、正式二分查询与独立线性扫描基准交叉核对、归属守恒、明细与统计一致、旧报告不可变、重启后结果一致、HTTP 错误码。

## 哈希环设计（确定性约定）

- 每个节点的虚拟节点数 = 固定基础数量 **128 × 权重**（权重为 1..8192 的整数）。
- 哈希：Node `SHA-256`，取摘要**前 8 字节按大端**解释为 `[0, 2^64)` 的无符号位置，全程使用 BigInt 精确定位。
- 输入编码固定、无拼接歧义：
  - 虚拟点：`tag=0x01 | id 的 UTF-8 字节数(2B 小端) | id | vindex(4B 小端)`
  - 样本键：`tag=0x02 | key 的 UTF-8 字节数(4B 小端) | key`
  - 长度前缀杜绝 `("a", v=...)` 与 `("ab", ...)` 类碰撞；节点域与键域用 tag 隔离。
- 环上虚拟点按 `(position ASC, nodeId ASC, vindex ASC)` 排序，因此即使多个输入落在相同 64 位位置，选择也完全确定（测试中用受控哈希覆盖）。
- 查询：二分找不小于键位置的第一个虚拟点，超过末尾则回绕到首点。核心定位自行实现，未使用任何现成一致性哈希路由库。

### 边界与约束

- 权重 1..8192；单节点虚拟点上限 1,048,576；单环虚拟点总数上限 4,000,000，超限拒绝（错误码 `TOO_MANY_VNODES`）。
- 空环无法路由：建环必须至少一个节点；演进时禁止把节点删空（`EMPTY_RING`）。
- 节点名 1-64 字符（字母、数字、`_`、`.`、`-`）；同一配置内重名拒绝（`DUPLICATE_NODE`）。
- 批量定位最多 10,000 个键；键为 1..1024 字符非空字符串。样本键按 `(ring, key)` 去重，重复插入被忽略。
- 单副本：每个键只归属一个节点；新增节点时**只有迁往新节点的键允许改变归属**，删除节点时其他节点原有的键不会被重新打散。
- 权重只改变虚拟点密度从而影响期望分布；**报告里的分布统计仅代表当前样本键集合，不宣称一定均匀**。

## HTTP API

响应统一为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "field" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/rings` | 建环（默认写入固定种子样本键；`seedKeys:false` 关闭，或传自定义数组） |
| GET | `/api/rings` | 列出环 |
| GET | `/api/rings/:name/versions` | 列出不可变配置版本 |
| POST | `/api/rings/:name/evolve` | 复制版本新增/移除节点，生成新版本 |
| GET | `/api/rings/:name/vnodes?version=&node=&limit=` | 查看有序虚拟位置 |
| POST | `/api/rings/:name/locate` | 单键定位 `{key, version?}` |
| POST | `/api/rings/:name/locate-batch` | 批量定位 `{keys, version?}` |
| GET/POST | `/api/rings/:name/keys` | 查看 / 追加样本键 |
| POST | `/api/rings/:name/compare` | `{oldVersion,newVersion}` 生成并保存迁移报告 |
| GET | `/api/rings/:name/reports` | 报告列表 |
| GET | `/api/rings/:name/reports/:id` | 查看报告快照 |
| GET | `/api/rings/:name/export` | 导出整个环（版本/样本/报告） |

### 错误码与 HTTP 状态

| code | status | 含义 |
| --- | --- | --- |
| `INVALID_ARGUMENT` / `INVALID_JSON` | 400 | 参数或请求体非法 |
| `RING_NOT_FOUND` / `VERSION_NOT_FOUND` / `REPORT_NOT_FOUND` | 404 | 资源不存在 |
| `DUPLICATE_RING` / `DUPLICATE_NODE` / `EMPTY_RING` / `TOO_MANY_VNODES` | 409 | 状态冲突 |
| `INVALID_NODE_NAME` / `INVALID_WEIGHT` / `NODE_NOT_FOUND` | 422 | 语义校验失败 |

### curl / PowerShell 示例

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/rings -Method Post -ContentType 'application/json' `
  -Body '{"name":"demo-api","nodes":[{"id":"a","weight":1},{"id":"b","weight":1},{"id":"c","weight":1}]}'
Invoke-RestMethod http://127.0.0.1:<port>/api/rings/demo-api/locate -Method Post -ContentType 'application/json' `
  -Body '{"key":"user:1001"}'
```

## CLI

```powershell
npm run cli -- create lab --nodes node-a:1,node-b:1,node-c:1
npm run cli -- list
npm run cli -- versions lab
npm run cli -- vnodes lab --limit 5
npm run cli -- locate lab user:1001
npm run cli -- locate-batch lab --keys a,b,c
npm run cli -- add-node lab node-d --weight 1
npm run cli -- remove-node lab node-b
npm run cli -- compare lab --old 1 --new 2
npm run cli -- reports lab
npm run cli -- report lab 1
npm run cli -- add-key lab my:key
npm run cli -- keys lab
npm run cli -- export lab
```

CLI 默认使用 `./data/chashlab.db`，可用 `CHL_DATA_DIR` 修改；输出为 JSON，错误以 JSON 写到 stderr 并返回非零退出码。

## 数据与可复现性

- 数据库文件：`<CHL_DATA_DIR>/chashlab.db`（默认 `./data/`），SQLite WAL 模式。
- 配置版本与报告只增不改；报告载荷内联保存生成时的完整逐键明细与统计。
- 所有位置由固定编码 + SHA-256 决定，样本键为内置固定集合，因此演示与测试在任意机器上结果一致。
