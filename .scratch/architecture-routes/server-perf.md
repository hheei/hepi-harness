# 服务端性能路线报告：增量窗口、分页、搜索与网关传输

范围：架构/实现/设计/性能路线。源 = master `1758c1fb4479e9d4637a957857246c5998619d73` + 未提交审计/设计修复工作区（未部署）。
只读产品代码；本报告与 `.dev/architecture-routes/server-perf/` 内的探测脚本/日志为唯一产物。未做任何产品编辑、未部署、未跑全量测试。

## 0. 导航证据（graphify）

| 问题 | 查询 | 图 | 起点 | 结果（已回源码确认） |
| --- | --- | --- | --- | --- |
| 窗口/目录统计所有者 | `query 'advanceCatalogueStats' --budget 1000` | 默认 AST 10,991 节点 | `advanceCatalogueStats()` | `apps/server/src/history-window.ts:L450`（community=history-window.ts）；52 节点被截断 29/52，属预算截断，非缺失 |
| 窗口投影器 | `query 'shrinkToBudget'`（默认 + `--graph graphify-deep/graphify-out/graph.json`） | 默认 + 深图 9,855 节点 | `shrinkToBudget()` | `history-window.ts:L70`；深图 community 名 "History window and deferral"（semantic 社区名，非契约） |
| 资源快照 | `query 'resourceSnapshot' --budget 1000` | 默认 | `resourceSnapshot` | `packages/gateway/src/filesystem.ts:L558`、`GatewayRpcServer` `index.ts:L479`、`SshFilesystem` `ssh-filesystem.ts:L357` |
| 会话搜索 | `query 'sessionSearch'` → 无匹配；改用 `query 'SessionSearch()'`、`query 'session-search.ts'` | 默认 | 命中前端 `SessionSearch.tsx`、`lib/session-search.ts` | 后端真身在 `apps/server/src/session-search.ts`（靠 grep 定位：图未索引该文件符号，`sessionSearch` 查询 0 匹配 ≠ 不存在，是图覆盖限制） |
| 网关调用链 | `query 'GatewayRpcServer' --context call` | 默认 | `GatewayRpcServer` | `index.ts:L479`；86 节点中 56 被预算截断 |
| 背压 | `query 'backpressure'` | 默认 | `logBackpressure()`（Web 侧） | 网关侧无同名符号；`send()` 在 `server.ts:L487` 靠 grep 确认 |
| 反向影响 | `affected 'historyToken' --depth 2` | 默认 | — | **0 命中**：图不含动态派发/间接引用，不能据此断言无调用者 |

局限：默认图为 AST 层，含自身 `INFERRED` 启发式边；`path`/BFS 路径只是导航，**不等于运行时派发**。`session-search.ts` 未被索引是覆盖缺口。行号均已在工作区源码复核。

## 1. 架构路线与 Interface 契约

- **窗口模块** `apps/server/src/history-window.ts` 是深模块：小接口（`windowStart` / `rawWindowCap` / `WindowProjector.advance` / `historyFacts` / `tokenFromFacts` / `oversizeFrame`），背后承载计数规则、字节预算、延迟投影（thinking 预览、文本预览 + 读块、图片 URL）、hasMore/边界与 token。
- **不变量**：窗口永远是活动范围的**后缀**；永不丢最新条目（单条超大整条带出）；字节预算是目标而非硬界，只允许丢"不投影为消息"的条目，以免分页游标回退成死循环；硬界只有传输层 `FRAME_LIMIT_BYTES = 960 KiB`（`history-window.ts:L32`），超界以 `state_oversize`/413 **具名拒绝**而非断连。
- **增量的接缝**：`appendedEntries(ops, previousLength)`（`:90`）把 Chord 提交词汇翻译成"仅追加"这一结构事实；`server.ts:L726` 用它驱动 `WindowProjector.advance(entries, appended)`（`:717`）、`advanceHistoryFacts`、`advanceCatalogueStats`。
- **搜索模块** `apps/server/src/session-search.ts`：无索引顺序扫描，契约照搬上游 pi-web（500 会话 / 30 结果 / 3 s / 每会话 16 MiB / 单条 1 MiB / 查询 200 字符），`truncated` 如实上报不完整。
- **网关传输**：`GatewayRpcServer`（`packages/gateway/src/index.ts:L479`）聚合执行/文件/终端/worktree/MCP；SSH 侧 `SshFilesystem` 每个 (profile, root) 一条 Python3 会话，请求串行化（`#queue`，`ssh-filesystem.ts:L114-120, L173-176`）。

## 2. 优点

- 增量发布是真增量：普通一轮只投影本轮追加的条目，token 只推进两个事实，不再全量重投影或重扫活动范围；附件状态由窗口自身界定（长会话不比短会话多占）。
- 所有返回窗口的表面（基线 / SSE 首帧 / `/entries` 分页 / 单条读块）共用同一投影表达式与同一预算问题，无法互相漂移。
- 字节预算只丢非消息条目、并保留可投影边界（`#widenToProjectable`），消除了"空页 + hasMore"死循环。
- 网关侧 `#execute` 与 `#streamFile` 有真实背压（1 MiB 守卫 + `drain` 等待）；搜索有具名截断而非静默空洞。

## 3. 发现（触发 / 影响 / 可能性 / 证据 / 处置）

### F1（设计）`advanceCatalogueStats` 每次提交做 O(N) 身份全等扫描
- 位置：`history-window.ts:L450-456`；调用点 `server.ts:L725`。
- 触发：每次视图提交（每个 turn 多次）。
- 证据（实测，本次探测）：n=2,000 → 0.008 ms；20,000 → 0.081 ms；200,000 → 0.849 ms（`.dev/architecture-routes/server-perf/probe-advance-costs.log`）。纯线性、无分配。
- 影响：20 万条目会话每帧约 0.85 ms 且随长度增长；相对每帧已有 0.05–0.07 ms 的帧序列化仍小，实际用户影响**低**。
- 缝合点：该函数接收 `(before, after)` 两个数组因而被迫全等比较，而同一处调用者**已经**算出 `appended`（`server.ts:L726`）。把 `appended` 传入即可复用，删除该 O(N) 项。
- 处置：**record**（重访条件：真实出现十万级条目会话且发布延迟可测）。

### F2（设计）回翻页每页 O(N)：`findIndex` + `slice` + 全新投影器
- 位置：`server.ts:L385-391`（`pageEntries`）。
- 证据（实测）：n=200,000 → `findIndex` 1.94 ms、`slice` 0.031 ms、整页 0.146 ms；n=20,000 → 0.119/0.003/0.123 ms（`probe-backpage-costs.log`）。线性项来自 `String(entry.id)` 比较，不是投影。
- 触发：用户反复上翻旧历史。影响：20 万条目下单页 ~2 ms，可忽略。处置：**record**。候选改进（若重访）：以条目位置/索引而非 id 字符串比较定位边界。

### F3（设计）每次发布重读资源摘要：每帧 2–3 次持久化文档读
- 位置：`server.ts:L683` `publish()` 内 `await readResources()`；绑定于 `server.ts:L1053` → `resourceSummary`（`workspace-resources.ts:L535-543`，读 `WorkspaceResourcesDoc` + `LiveDoc`，未命中再读 legacy）。
- 触发：生产环境 `options.workspaceResources` 始终存在，因此**每个** state 帧（含 `onAdvance([])` 的 submission 事件帧）都付这几次存储读。
- 影响：帧成本从"条目增量"变成"增量 + 常数次存储往返"，随提交频率而非会话长度增长。
- 证据等级：**仅源码（inferred，未实测）**；本机 SQLite 热缓存下预计亚毫秒。处置：**record**，重访条件为真实主机上出现发布延迟或存储负载证据；候选缝合点：让资源摘要随文档 watch 事件保持（`events.start` 已在该文件内消费文档变更）。

### F4（设计）`oversizeFrame` 每帧全量 `JSON.stringify`
- 位置：`history-window.ts:L418`；调用点 `server.ts:L696, L1643, L1664, L1861`。
- 证据（实测）：约 500 KiB / 243 条目帧 → 0.059–0.069 ms（`probe-frame-measure-costs.log`）；即 O(帧字节) 且每帧一次。
- 影响：受窗口上限（≤960 KiB）约束，量级 0.1 ms 以下。处置：**record**。

### F5（逻辑/文档一致性）搜索截止时间的真实粒度是"单次分页读（≤200 条）"，不是整会话
- 位置：`session-search.ts:L117`（分页前）、`:120`（**每条条目**循环内）、`:163`（会话之间）。
- 与复用证据的差异：`.scratch/development-audit/performance-research.md` §3 称"预算约束的是页，不是页内"，并据此推测"一个超大历史可能在一次分页读内就超过 3 s"。源码显示页内**每条**条目都检查截止时间，因此不可打断的单位是单次 `conversation.entries(...)`（≤200 条）而非整个会话。结论方向不变（仍可能超出预算），但该文档的机制描述需修正；建议在 owning 指南中更正。
- 处置：**record（文档更正）**。

### F6（设计）SSH 每个命名路径的请求都额外付一次 `discover` RPC
- 位置：`ssh-filesystem.ts:L475-477`（`#readAuthorization` → `#host`）→ `:464-468` 每次发 `["discover"]`；对比 `#snapshot`（`:454-457`）只发一次 `["snapshot"]`。
- 触发：任意 SSH 文件读/写/变更。影响：每次操作 2 次往返，且请求在该 (profile, root) 上**串行**排队，N 次并发文件操作线性排队。`packages/gateway/src/ssh-filesystem.ts:L43` 的 1 MiB 请求上限与 60 s 截止时间是唯一界。
- 证据等级：源码确认 + 仓库内既有计数诊断脚本 `apps/server/scripts/diag-ssh-rpc-count.ts`（本次未重跑，遵守"不改产品、不跑全量"约束）。
- 处置：**record**（设计取舍：授权必须来自主机自身答案，不接受网关提供的路径；重访条件：真实 SSH 主机上出现可感的文件操作延迟）。

### F7（逻辑）终端 SSE 两条流没有背压界
- 位置：`packages/gateway/src/index.ts:L848` 与 `#writeTerminalFrame`（无 `writableLength` 守卫、无 `drain` 等待）；对照 `#execute`（`:693` 1 MiB 守卫 + `drain`）与 `#streamFile`（`:675`）。
- 触发：终端产生输出的速度快于浏览器消费（挂起标签页、休眠、慢链路）。影响：Node 写缓冲随发出量增长 → 进程内存增长，最坏 OOM（**未观察到**）；会话 backlog 本身有 `TERMINAL_REPLAY_CHARS = 128 KiB` 界，但**在途**字节没有。
- 证据等级：**源码 + 本次有界实测**（见下方"F7 实测"与 §7 产物表）。影响方向已实测确认；"OOM"仍是**未观察到**的推断，实测未尝试、也不应尝试触发 OOM。
- 处置：**investigate → 证据已足**；修复边界见 §5.2 第 2 条（"等待 + 界" 与 "主动断开慢接收者" 是产品取舍，本次不选定实现）。这是本路线中唯一有正常使用路径且后果非平凡的问题。

#### F7 实测（本机、有界、仅本地）

**证据冻结**：以下数字**只**取自当前磁盘上两个日志文件的原始 stdout，逐字对应，未做任何换算以外的加工；**本步骤未重跑探测**（只读日志 + 改本报告，含后续对 §5.2 生产者契约的三次文字更正——均为阅读源码所得，未产生新的测量）。冻结校验和（sha256）：`probe-terminal-backpressure-normal.log` = `ba61e4996f82b7646a770f1effb44cadedce7c1eb1f67e8edf453c9d6f9052b9`；`probe-terminal-backpressure-volume.log` = `51e37ffdb334ebcf6fa7436e45c668a4912cb60dbbe140f62dadbb381781c5e9`；探针 `probe-terminal-backpressure.ts` = `1e2a4a2b59adad1944d58e23c9b772bcc833be894443aa9c2c2bbaf1733e5ab5`。

此前一次运行的 stdout（曾含单会话 8 MiB 量级峰值 4,532,610 B、RSS 10.5 MB、`128/129` false）已被同名日志覆盖且**无法恢复**（全仓与 `/tmp` 检索无命中），因此**不作为证据**，其数字在本报告中只出现在本句的这段说明里，不进入任何表格或结论。

**证明范围（scope of proof）**：执行宿主是**夹具替身（fixture double）**，不是生产用的真实 PTY/shell helper 进程；它只调用会话的 `onOutput` 回调。因此本次证明的是**网关 SSE 写入路径**（`#writeTerminalFrame` 的写、背压返回值和 ServerResponse 队列）在真实 HTTP/套接字上的行为，**不证明**真实 PTY 的生产吞吐、真实 shell 的缓冲层或真实 SSH 终端的行为。客户端是**从不读取的原始 socket**（接收窗口不开，故填充的是网关自身队列），不是浏览器。

复现方式：真实 `GatewayRpcServer` + 真实 HTTP 服务器/套接字/`ServerResponse`；总发出上限 8 MiB、10 s 期限；无产品文件改动。

来源：`probe-terminal-backpressure-normal.log`（`node --import ./.scratch/development-audit/perf-probes/lib/register.mjs .dev/architecture-routes/server-perf/probe-terminal-backpressure.ts`，exit 0，`deadlineExceeded: false`，`emittedTotalBytes: 6815744`）

| 相 | 发出字节 | 写入次数 | `write` 返回 false | 等待 `drain` 次数 | `writableLength` 峰值 | 结束时 `writableLength` | 峰值 RSS 增量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fanIn` `/v1/terminal/events` | 3,145,728 (3.00 MiB) | 49 | **48** | **0** | 65,690 B | 65,690 B | 4,718,592 B (4.50 MiB) |
| `sessionEvents` `/v1/terminal/<id>/events` | 3,145,728 (3.00 MiB) | 49 | **48** | **0** | 65,609 B | 65,609 B | 2,621,440 B (2.50 MiB) |
| `replayBound`（attach `after=0`） | 附上前已发 6,815,744 | 2 帧 | — | — | — | — | — |

来源：`probe-terminal-backpressure-volume.log`（`PROBE_VOLUME=1` + 同命令，exit 0，`deadlineExceeded: false`，`emittedTotalBytes: 8388608`；该模式**只跑 `fanIn`**）

| 相 | 发出字节 | 写入次数 | `write` 返回 false | 等待 `drain` 次数 | `writableLength` 峰值 | 结束时 `writableLength` | 峰值 RSS 增量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fanIn` `/v1/terminal/events` | 7,864,320 (7.50 MiB) | 121 | **120** | **0** | **4,007,090 B (3.82 MiB)** | 3,941,400 B | 13,107,200 B (12.50 MiB) |
| `replayBound`（attach `after=0`） | 附上前已发 8,388,608 | 2 帧 | — | — | — | — | — |

队列随发出量（vol，原始采样）：

| 累计已发字节 | `writableLength` |
| --- | --- |
| 459,897 | 65,688 B |
| 2,036,225 | 65,690 B |
| 3,612,569 | 65,690 B |
| 5,188,913 | 1,313,800 B |
| 6,765,257 | 2,890,360 B |

重放侧（两个日志一致）：`replayWireBytes: 131,145`、`replayPayloadChars: 131,072`、`replayBoundChars: 131,072`、`payloadWithinReplayBound: true`、`replayReset: true`、`replayCursor: 524,288`。

结论（有界、单机、夹具宿主，**不外推**）：
1. `response.write()` 返回 false 时**没有任何一帧等待 `drain`**（`serverAwaitedDrain = 0`，两条流都一样：48/49 与 120/121 次 false 对应 0 次等待），而服务端写者 `#execute`/`#streamFile` 在同样条件下确实等待——源码结论在运行时被确认。但那是**写者层**的界（只界一个响应），与产出方是否可压无关；终端订阅回调是同步 `void`，故**不能照搬**（三层区分见 §5.2 第 2 条）。
2. 在 3.00 MiB 量级下两条流的队列都**稳定在约 64 KiB**（65,690 / 65,609 B，结束值与峰值相同）：这些字节被内核 socket 缓冲吸收，此处**不是无界增长**。
3. 在 7.50 MiB 量级下，`fanIn` 的网关自身队列**随发出量单调增长**：65,688 → 65,690 → 65,690 → 1,313,800 → 2,890,360 B，峰值 **4,007,090 B (3.82 MiB)**，峰值 RSS 增量 **13,107,200 B (12.50 MiB)**。**增长未出现平台期**，但本次在 8 MiB 发出上限处停止，**未观察到 OOM**。
4. 重放侧仍在界内：一次 attach 只重放 **131,072 字符**（`TERMINAL_REPLAY_CHARS`）的负载，帧线上 131,145 B（含 `id:` 行、`data: ` 前缀与空行），并带 `reset`——即**重放受 128 KiB 界约束，而流式在途字节不受任何界约束**，这正是 F7 的要点。
5. 未测/不能断言：内存耗尽、真实浏览器慢消费者的恢复行为、真实 PTY/shell 与真实 SSH 终端的额外缓冲；单会话路径在 8 MiB 量级下的队列未在本次运行中测量（vol 模式只跑 `fanIn`）。本次未尝试、也不应尝试触发 OOM。

### F8（设计）SSE 帧测量与套接字积压不是同一件事
- 位置：`server.ts:L489` `send()` 在**写之前**检查 `writableLength > 1 MiB` 才销毁；`publish()`（`:696`）只把帧本身量到 960 KiB，不含套接字现有积压。
- 影响：960 KiB 帧写进已有 ~100 KiB 积压的套接字后，队列越过 1 MiB，**下一帧**才会销毁连接；客户端重连后重新请求同一窗口。设计注释承认这是"余量"取舍（`history-window.ts:L26-32`）。处置：**record**。

## 4. 复杂度与预算（实测 vs 推断）

| 项 | 复杂度 | 实测 | 推断部分 |
| --- | --- | --- | --- |
| 普通发布（追加 3 条） | O(追加) 投影 + O(1) token | 0.004 ms（n=2k→200k 持平，`probe-advance-costs.log`） | — |
| 目录统计推进 | O(N) | 0.008/0.081/0.849 ms @2k/20k/200k | — |
| 回翻一页 | O(N) 定位 + O(页) 投影 | 0.146 ms @200k | — |
| 帧测量 | O(帧字节) | 0.06 ms / ~500 KiB | — |
| 资源快照遍历 | O(列出条目) 含每项 lstat+realpath+stat、逐项 `JSON.stringify` + 末尾整响应再序列化（`filesystem.ts:L663-697`） | 复用证据：1,421 ms / 19,600 entries / 14.6 MiB（`.scratch/development-audit/performance-research.md` §2，源码此后未变） | "近似线性"为该 4 点拟合 |
| 搜索 | O(会话×条目文本) | 复用证据：28.7 ms / 500 会话 / 7.8 MiB；硬界 500 会话、30 结果、3 s | 预算在超大单会话下的行为未实测 |
| 网关传输 | O(帧) + 背压 | 无本次实测；复用证据未覆盖 SSH RPC 计数 | SSH 每操作 2 次往返为源码推断 |

复用测量的源码注意事项：其文本/分页部分测的是**修复前**行为（`performance-research.md` 自述），大文本恢复与分页问题随后已在 `.scratch/design-fixes/results.md` 修复；本次未重跑，只引用未变路径（资源快照、搜索、加载历史）的量级，并已在 F5 修正一处机制描述。

## 5. 缝合点与务实建议

1. **F1 是一行级的深模块改进**：把调用者已算出的 `appended` 传进 `advanceCatalogueStats`，删掉每帧 O(N) 扫描。改动小、无接口破坏（该函数仅一处生产调用 + 单元测试）。
2. **F7 的修复边界（仅分析，不选定实现）**：`#execute`/`#streamFile` 的守卫 + `drain` 模式**不能照搬**到终端两条流，因为**生产者契约不同**：
   - **三层要分清（本次更正）**：先前引用的 `index.ts:1119` `await onOutput?.(chunkOutput)` 是 **`GatewayRpcClient.execute`（`index.ts:1052`）读 NDJSON 响应时等待自己的回调**，属**客户端交付**层，**不是**服务端产出方，也不能反向压住服务端。服务端侧：**`#execute`（`index.ts:687`）是写者（server writer）**，其守卫（`response.writableLength + byteLength > 1 MiB → destroy`；`write()` 返回 false → 等 `drain`/`close`）与产出方是否可压**无关**，无论如何都成立——但**它只界一个响应**，不界订阅回调的入队。产出方分两种：`LocalGateway.run`（`index.ts:387-390`）里 `onOutput` 是 `void sink(...)`，注释与 `OutputSink` 文档（`execution.ts:13`）明说 `NodeExecutionEnv` **不等待**该回调，**本地路径无法被 sink 压住**；`SshGateway.run`（`:465`）把 sink 交给 `StreamPump`（`runner.ts:150-190`），它在 `await this.#sink(...)` 期间 `pause()`、之后 `resume()`，**只有 SSH execute 支持产出方节流**。因此：**不得**声称所有 `#execute` 路径都能 await 产出方；终端的订阅回调仍是同步 `void`（`terminal.ts:492`、`#emit` `:690`），其队列/`drain` 结论不变。
   - 终端不同：订阅回调是**同步 `void`**（`packages/gateway/src/terminal.ts:492` 为 `Set<(event: TerminalEvent) => void>`，`#emit` 在 `:690` 同步调用 `listener(event)`），而产出方 `#record`（`:678`，由 host 的 `onOutput` 在 `:566` 触发）是同步、不返回 Promise、**无人 await**。因此只在 `#terminalFanIn`（`index.ts:788`）/`#terminalEvents`（`:865`）里加 `await once(response, "drain")` 只会**把积累从 `response` 搬到该流自己的本地 `queue`**：写循环停在 `drain` 上，`listener` 仍无界入队，宿主也照旧不被压住。**端到端的界不会因此出现。**
   - 要真正的界，需同时约束三处：(a) `response.writableLength`（复用 `#execute` 同款守卫，`index.ts:693`）；(b) **该流本地队列的字节总量**（fan-in 的 `queue` 与 per-session 的 `queue`，目前只按事件数增长、无字节界）；(c) `drain` 等待必须有**终止条件**（`close`/`destroy`/`error`），否则一个永久不读的客户端会让该流永久挂起。
   - 另一方向是**不等待、主动断开慢接收者**，终端已有现成语义可用：`TERMINAL_RECONNECT_MS = 120_000` 的重连租约（`terminal.ts:29`）、`TERMINAL_REPLAY_CHARS = 128 KiB` 的重放尾部（`:28`）、以及 `subscribe`（`:606`）在落后/超前时给出的 `reset` 回答。断开后客户端按 `Last-Event-ID` 重连，落在重放界内并被 `reset`，状态仍自洽——代价是**需要一个新的在途字节阈值**，取值本次不决定。
   - 上述 (a)+(b)+(c) 与"主动断开"是两种**产品取舍**；本报告只给边界与依据，不选定实现，也**不声称**照搬 `#execute` 的 `drain` 即可解决。
   缝合点（位置事实）：`#writeTerminalFrame`（`packages/gateway/src/index.ts:L934`）是同步 `void` 写，调用方 `#terminalFanIn`（`:848`，心跳 `:840`）与 `#terminalEvents`（`:897`）都不检查返回值。实测证据的适用范围见 F7 实测的"证明范围"：**夹具宿主，非真实 PTY 生产路径**。
3. F3/F6 属"已具名设计取舍 + 未实测影响"：按 review-policy 保持 record，等真实主机证据再动，不要现在加分页/索引层。
4. F2/F4/F8 记录即可；F5 只需更正 owning 文档的机制描述。

## 6. 支撑测试（未运行，仅指出覆盖面）

- `apps/server/test/history-window.test.ts`（`WindowProjector`、`appendedEntries`、`continuationIndex`、`tokenFromFacts`）、`apps/server/test/frame-size.test.ts`、`apps/server/test/delta-frames.test.ts`、`apps/server/test/history-text.test.ts`。
- `apps/server/scripts/perf-history-scaling.mjs`（docs/chat.md 引用的每轮字节平坦性断言）。
- `apps/server/scripts/diag-ssh-rpc-count.ts`（SSH 每发现请求计数）——适合作为 F6 的复现入口。

## 7. 本次探测产物（`.dev/architecture-routes/server-perf/`）

| 脚本 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| `probe-window-costs.mjs` | `node --import ./.scratch/development-audit/perf-probes/lib/register.mjs .dev/architecture-routes/server-perf/probe-window-costs.mjs` | 0 | `probe-window-costs.log` |
| `probe-advance-costs.mjs` | 同上（同 import hook） | 0 | `probe-advance-costs.log` |
| `probe-backpage-costs.mjs` | 同上 | 0 | `probe-backpage-costs.log` |
| `probe-frame-measure-costs.mjs` | 同上 | 0 | `probe-frame-measure-costs.log` |
| `probe-terminal-backpressure.ts`（F7） | `node --import ./.scratch/development-audit/perf-probes/lib/register.mjs .dev/architecture-routes/server-perf/probe-terminal-backpressure.ts` | 0 | `probe-terminal-backpressure-normal.log` |
| `probe-terminal-backpressure.ts`（F7，8 MiB 量级） | `PROBE_VOLUME=1` + 同命令 | 0 | `probe-terminal-backpressure-volume.log` |

以上两条日志头部记录：源 revision `1758c1fb4479e9d4637a957857246c5998619d73`、模式、完整命令、运行时脏树状态（`git status` 当时 53 个已修改跟踪文件，均为审计/设计修复产物；本探测未改动任何产品文件）。

全部为进程内、纯函数级、无网络、无真实 provider 流量；Node v26.5.1（`module.register()` 弃用告警属 Node 26 行为，不影响结果）；无遗留进程（已 `pgrep` 确认）。数据均为本机热缓存、单次重复平均（20–2000 次/点），非跨机可外推常数。

## 8. 不确定性（诚实记录）

- F3、F6 只有源码证据，无本次实测；F7 已做有界本地复现（见 F7 实测），但"OOM"未观察到，实测只覆盖夹具宿主与从不读取的原始 socket，**不代表真实 PTY/shell 生产路径**。F7 的表只使用当前两个日志文件中的原始值；一次被覆盖的早先运行的 stdout 已不可恢复，不进入证据。
- 资源快照/搜索数值来自复用证据的夹具与热缓存条件，未在本工作区重跑；不得外推为跨机常数。
- 默认图未索引 `apps/server/src/session-search.ts` 符号；`affected 'historyToken'` 返回 0 命中不构成"无调用者"的证据。
- 未验证：`docs/chat.md` 所述浏览器端帧消费在极端积压下的行为（属浏览器路线）。
