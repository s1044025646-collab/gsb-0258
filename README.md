# 一致性哈希分片路由与迁移对照实验后端

离线运行的一致性哈希实验服务：维护命名节点与整数权重，把字符串键路由到节点，并比较节点增删前后的归属变化。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需 C++ 编译），仅 HTTP API 与 CLI
- 纯本地、单进程，不连接真实集群，不复制数据，不做故障探测或负载均衡代理
- 单副本、带虚拟节点的哈希环；虚拟节点数 = 固定基础数（160）× 节点权重
- SQLite 保存环、配置版本、样本键与不可变迁移报告

## 明确边界

- **单副本**：一个键只归属一个节点，没有副本、多读写或数据搬运。
- **权重含义**：权重仅线性决定虚拟节点数量，用于调节环上弧长占比；不代表实时容量或负载。
- **样本统计**：分布数字只统计当前提供的样本键，不保证在任意键空间上均匀；虚拟节点可降低离散偏差但不做均匀性承诺。
- **迁移含义**：只表示"键的归属节点在两个版本之间发生变化"，不移动真实数据。
- **报告不可变**：报告生成时把逐键结果与统计整体存入数据库，之后修改配置不会改变旧报告。
- **空环**：显式创建空环是允许的，但对其路由会返回 `409 EMPTY_RING`。

## 哈希环约定（无歧义）

- 位置空间：SHA-256 的 256 位空间，位置以大端字节解释为 `BigInt`（`0 .. 2^256-1`），精确无浮点误差。
- 输入编码采用 TLV（标签 + 4 字节大端长度 + 字节内容），**不依赖分隔符拼接**：
  - 虚拟节点：`tag=1 节点名(UTF-8)` + `tag=2 虚拟序号(8 字节大端)`，因此 `["ab","c"]` 与 `["a","bc"]` 不会碰撞；
  - 键：`tag=3 键(UTF-8)`，与虚拟节点处于不同标签命名空间。
- 环上排序为全序 `(position, nodeName, vnodeIndex)`：即使两个虚拟节点位置相等，选择也确定、稳定，且与节点输入顺序无关。
- 定位：二分查找"不小于键位置"的第一个虚拟节点；超过环尾则回绕到环首。
- 生产路径只使用真实 SHA-256；测试可注入受控哈希以构造位置相等与回绕。

## 环境要求

- Windows 本地，Node.js **>= 22.5**（开发与验证使用 Node v25；使用内置 `node:sqlite`，会打印 ExperimentalWarning，属正常现象）
- 不需要 Docker、WSL、付费服务或任何外部在线 API

## 安装与命令

```powershell
npm install
npm run build      # tsc 编译到 dist/
npm test           # node:test，20 个用例（环语义/注入哈希/迁移守恒/持久化）
npm start          # 运行编译后的 HTTP 服务（默认自动选择空闲端口）
npm run dev        # 用 tsx 直接运行源码服务
npm run cli -- ... # CLI（见下）
npm run demo       # 固定种子、可重复的端到端演示（内存数据库）
```

数据目录默认为项目内 `./data`（数据库文件 `data/chlab.sqlite`），可用环境变量 `CHLAB_DATA_DIR` 覆盖。
端口用环境变量 `PORT` 指定；不设或设为 `0` 时自动选择空闲端口，启动日志打印实际地址。

## 一分钟演示（可重复）

```powershell
npm run demo
```

演示流程（全部确定性、固定种子 24 个样本键）：

1. 建立三节点等权环（node-a/b/c，每节点 160 个虚拟节点）；
2. 新增 node-d（v2），生成报告：迁移键的新归属**全部**为 node-d，示例结果约 25% 迁移；
3. 从 v2 移除 node-b（v3），生成报告：**只有**原属 node-b 的键迁移，其余节点的键保持不变；
4. 守恒校验：新旧版本归属总数都等于样本数，逐键明细与迁入/迁出统计一致。

## HTTP API

统一错误响应：`{"error":{"code","message","details"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/rings` | 环列表 |
| POST | `/api/rings` | 建环；`{"name","nodes":[{name,weight}]}`；`{"name","empty":true}` 建空环 |
| GET | `/api/rings/:ref` | 环详情与全部版本（`:ref` 为名称或数字 ID） |
| POST | `/api/rings/:ref/evolve` | 复制当前配置生成新版本：`{"action":"add","node","weight"}` 或 `{"action":"remove","node"}` 或 `{"action":"set","nodes":[...]}` |
| GET | `/api/rings/:ref/vnodes?version=N` | 查看虚拟节点位置（省略版本用最新） |
| GET | `/api/rings/:ref/route?key=k&version=N` | 单键定位 |
| POST | `/api/rings/:ref/route-batch` | 批量定位：`{"keys":[...],"version":N}` |
| GET/POST | `/api/rings/:ref/keys` | 查看/添加样本键；POST `{"keys":[...]}`，或 `{"seed":true}` 写入固定种子 |
| POST | `/api/rings/:ref/compare` | 版本对照：`{"oldVersion":1,"newVersion":2,"persist":true}`；省略版本时 old=1、new=最新 |
| GET | `/api/rings/:ref/reports[ /:id]` | 报告列表 / 报告详情 |
| GET | `/api/rings/:ref/reports/:id/export.json` | 导出完整 JSON |
| GET | `/api/rings/:ref/reports/:id/export.csv` | 导出逐键明细 CSV |

快速体验（PowerShell）：

```powershell
npm start                                   # 记下日志打印的端口
$b = "http://127.0.0.1:<端口>"
Invoke-RestMethod -Method Post "$b/api/rings" -ContentType "application/json" -Body '{"name":"r","nodes":[{"name":"a","weight":1},{"name":"b","weight":1}]}'
Invoke-RestMethod "$b/api/rings/r/route?key=hello"
Invoke-RestMethod -Method Post "$b/api/rings/r/evolve" -ContentType "application/json" -Body '{"action":"add","node":"c","weight":1}'
Invoke-RestMethod -Method Post "$b/api/rings/r/keys"    -ContentType "application/json" -Body '{"seed":true}'
Invoke-RestMethod -Method Post "$b/api/rings/r/compare" -ContentType "application/json" -Body '{"persist":true}'
Invoke-RestMethod "$b/api/rings/r/reports/1/export.csv"
```

## CLI

```powershell
npm run cli -- list
npm run cli -- create --name r --nodes '[{"name":"a","weight":1},{"name":"b","weight":2}]'
npm run cli -- create-empty --name hollow
npm run cli -- show r
npm run cli -- vnodes r --version 1
npm run cli -- route r --key hello
npm run cli -- seed r
npm run cli -- evolve r --add c --weight 1
npm run cli -- evolve r --remove b
npm run cli -- compare r --save
npm run cli -- reports r
npm run cli -- report r --id 1 --format csv
```

CLI 与 HTTP 共用同一 SQLite 文件（`CHLAB_DATA_DIR` 可切换），可互相验证。

## 错误码

| Code | HTTP | 触发条件 |
| --- | --- | --- |
| `EMPTY_RING` | 409 | 对无节点环执行路由 |
| `DUPLICATE_NODE` | 409 | 同一配置中节点名重复，或新增已存在节点 |
| `INVALID_NODE` | 400 | 节点名空/过长、操作缺少节点名、移除最后节点 |
| `INVALID_WEIGHT` | 400 | 权重不是 1..1000 的整数 |
| `TOO_MANY_VNODES` | 400 | `160 × 权重和` 超过 200000 |
| `DUPLICATE_KEY` | 409 | 请求内或库内样本键重复 |
| `RING_NOT_FOUND` / `VERSION_NOT_FOUND` / `NODE_NOT_FOUND` / `REPORT_NOT_FOUND` | 404 | 对应资源不存在 |
| `INVALID_BODY` / `INVALID_QUERY` | 400 | 请求体/查询参数非法 |

## 测试覆盖

- 单节点环、空环、回绕、位置相等时的稳定选择、节点重排不影响路由；
- 权重变化改变虚拟节点数量与占比趋势；
- 重复键（请求内/库内）拒绝；重复节点、非法权重、虚拟节点上限拒绝；
- 新增节点只有流向新节点的键改变；删除节点不打散其余节点；
- 用朴素线性扫描环作为独立小规模基准，与正式二分查询逐键核对；
- 归属总数守恒、逐键明细与每节点迁入/迁出统计一致；
- 报告不可变；关闭进程后用同一文件重启，旧版本路由与报告保持原结果。

## 项目结构

```
src/
  hash.ts     TLV 编码、SHA-256 -> BigInt 位置（可注入哈希）
  ring.ts     校验、建环、二分定位、线性扫描基准
  db.ts       node:sqlite 建表与存取
  service.ts  建环/演进/定位/样本键/对照统计/不可变报告/固定种子
  server.ts   HTTP API（默认空闲端口）
  cli.ts      命令行
  demo.ts     可重复演示
tests/        ring.test.ts、service.test.ts
data/         运行后自动创建（SQLite 数据库）
```
