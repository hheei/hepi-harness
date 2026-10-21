# Gateway / CLI 执行路由：架构与实现分析

范围：工作树 = master `1758c1fb4479e9d4637a957857246c5998619d73` + 未提交的 audit/design 修复；未部署。只读产品代码，本报告与 `.dev/architecture-routes/gateway/` 证据为本次唯一产出。

## 1. 路由（实际装配路径）

```
[两个入口，互不复用]
  A) packages/gateway/src/main.ts        (环境变量直读, pnpm --filter @hepi/gateway start)
  B) packages/client/src/cli.ts → startGateway()  packages/client/src/gateway.ts:L18 (打包分发 @hepi/client)
        │  (B 不 import A: 一个进程一个 gateway，注释 L10-16)
        ▼
  WorkspaceRegistry (L133 workspaces.ts)  ── 单一注册表，所有 surface 共享
  GatewayExecutionJournal (execution.ts:L229) / MemoryLedger
  LocalGateway:L347  |  SshGateway:L411   ← 共用抽象 Gateway (index.ts:L146)
  LocalFilesystem | SshFilesystem(L357)   LocalInstallServer:L326 | SshInstallServer:L906
  WorkspaceServer:L150 | SshWorkspaceServer(L66)   GatewayWorktrees:L350 | SshWorktreeServer:L425
  TerminalSessions (terminal.ts:L513) + localTerminalLauncher:L447 / sshTerminalLauncher:L460
  McpHostService (mcp/host.ts:L302，仅本地)   GatewayWorkbench (仅本地)
        ▼
  GatewayRpcServer (index.ts:L479) — 一个 http.Server，按 url 精确串分派
  路由：/v1/execute /v1/abort /v1/workspaces /v1/worktrees /v1/mcp /v1/files /v1/installs /v1/workbench
        + /v1/files/{upload,upload-check,bytes} + /v1/terminal[/events,/:id,/events,/input,/resize]
        ▼
  close() (L938)：terminals.closeAll → mcp.close → files.close → closeAllConnections → gateway.close → server.close
        (CLI 之后才 master.close()，gateway.ts:L83)
```

graphify 查询（默认图 `graphify-out/graph.json`；均为 AST 层，含 INFERRED 启发边。**关于新鲜度：`built_at_commit` 只是 commit ref，不是工作树 pin，故 SHA 一致不构成新鲜度证据**——两个图实际都按当前工作树生成，详见 §8）：
`query "startGateway"`（只命中 `apps/server/scripts/split-resources-smoke.ts` 的同名函数——**同符号不同实现**，说明 BFS 命中≠运行时分派，已回源确认）、`query "SshGateway"`、`query "TerminalSessions"`、`explain "GatewayRpcServer"`(degree 77)、`explain "LocalGateway"`(degree 57)、`query "ExecutionHost"`、`query "managedControlMaster"`、`query "GatewayExecutionJournal"`、`query "sshTerminalLauncher"`、`query "workspaceOwner"`、`query "GatewayWorktrees"`。`--context call` 的 `dispatch()` 只命中 web 测试同名函数，无价值，故改用 `explain`。所有位置均已回源核对（行号以工作树为准；图的新鲜度不能由 SHA 断言，见 §8）。

## 2. Interface 契约与不变量

- **HTTP seam**：Bearer token 全路由统一校验（含 terminal 与 file payload 两条早退分支）；仅接受精确 url 字符串 + POST（L539）；JSON body ≤1 MiB（readJson）；execute 响应为 NDJSON 帧（output…result），帧累计 >1 MiB 直接 `response.destroy()`（L693）。
- **Ledger**：key = `gatewayId\0workspaceId\0callId`；fingerprint（cwd/command/env/timeout/spill/window 的 JSON）钉住请求，同 ID 异请求 → `invalid_request`；admission 是单程门；重启把 admitted/dispatched 改写成 outcome-unknown tombstone；`refuse` 提前记住 abort（TTL 60s）。
- **Workspace 解析**：id 是**不透明键**，永不解析拼写；`workspaceOwner`(workspaces.ts:L120) 一次解析 (profile, root)；未注册 id → unknown，不回落第一个 profile。
- **SSH runner 双契约**：`execute`（可挂 ControlMaster，255/超时/abort 一律 outcome_unknown，绝不重试）与 `open`（长会话，**永不走 master**，runner.ts:L203-215）。root 约束由远端脚本自己 `realpath`+前缀比对（exit 126）。
- **Terminal**：reconnect lease 120s（TERMINAL_RECONNECT_MS）、replay 上界 128 KiB（TERMINAL_REPLAY_CHARS）、keepalive 30s（TERMINAL_HEARTBEAT_MS）、close grace 5s；PTY 归 helper 所有（pty.fork，helper 为进程组长），helper stdin EOF → SIGHUP 进程组 → grace → SIGKILL，即 gateway 崩溃时 shell 不残留。

## 3. 优点（设计深度）

1. `Gateway` 抽象把「账本准入 + 输出汇聚 + 结果记录」放在一个地方，Local/Ssh 只实现 `validate/run/workspaceIds`，删除任一侧 adapter 复杂度会回到调用方 → 深模块。
2. `WorkspaceRegistry` 单一实例被 execution/files/install/workspaces/worktrees/terminal 共享，运行时注册一次即全 surface 生效（对比注释所述「每 surface 一份构造期快照」的旧状态）→ 高 leverage、高 locality。
3. 能力缺失以**具名限制**表达：`not_supported` / `mcp_unavailable` / `unknown_terminal`，而不是通用失败；调用方能区分「这台主机不会」与「请求错了」。
4. SSH 复用策略有明确边界与理由（仅 installs+execute 走 master；文件面自己持有长会话；terminal 一会话一连接），并在 runner.ts 注释中说明 `%C` 不足与 `-S` 而非 `-o ControlPath` 的原因。

## 4. Findings（trigger / impact / likelihood / evidence / disposition）

**G1（design，mixed）入口装配重复且配置面不等价。**
`startGateway`(client/src/gateway.ts:L18-85) 是 main.ts 的组合复刻（68 行 vs 85 行，逐块同构：registry → journal → master → gateway → files → installs → admin → worktrees → terminals → mcp → rpc → listen）。差异**回源确认**：
- `HEPI_TERMINAL_HEARTBEAT_MS` 只在 main.ts:L64-65 出现（全仓唯一读取点），main.ts:L70 才把它交给 `TerminalSessions`；`CONFIG_FILE_KEYS`(config.ts:L48-62) 共 14 个键**不含它**，`config.ts`/`gateway.ts` 也从不引用它 → CLI 启动的 gateway 恒为默认 30s 心跳，且该变量在 CLI 下连警告都没有（既非问题也非 warning，属静默忽略）。
- SSH 模式下 `HEPI_WORKSPACE_ID`：CLI 把它与 `remoteWorkspaceId(profile)` 比对并**显式拒绝**（config.ts:L173-176，注释说明理由：否则 gateway 会广告一个自己 RPC 会拒的 id）；main.ts:L36 用 `sshWorkspaceSeed(profiles)` 建注册表，**从不读该变量**，静默改服 `remote-<profile>`。
Trigger：运维用打包 CLI 部署（docs/distribution-smoke.md:19 记录的正式路径）且上游有更严 idle bound；或按 main.ts 习惯设置 `HEPI_WORKSPACE_ID`。Impact：前者无法声明心跳（reconnect/reset 抖动），后者 backend 报 `unknown_workspace`。Likelihood：前者取决于部署 hop；后者有 docs/local-integration.md:37 明示约束，属配置错误。Evidence：源码对照（行号如上）。Owning seam：组合点（两个入口），建议把「设置→组合」抽成一个由 main.ts 与 CLI 共用的纯函数，env 与 settings 各自只做读取。Disposition：**record**（revisit：实际部署用 CLI 且 hop idle bound <30s，或出现 unknown_workspace 工单）。

**G2（logic，证据等级 = 孤立算法复现，非端到端）`Gateway#append` 的每 chunk 全串度量 + 拼接构成二次工作量。**
`#append`(index.ts:L279-292) 每 chunk 做三件事：`Buffer.byteLength(current, "utf8")`（对**已累积**串全量重扫）、`Buffer.from(text, "utf8")`、以及 `current + text`。
**证据性质（务必按此读）**：`probe-ledger-append.ts` 的 `chunkBytes` 段是**孤立算法复现**——它把 `#append` 的函数体（同样的 `Buffer.byteLength` 预算判断 + 同样的截断分支）抄成脚本内局部函数后循环调用；它**没有**调用真实的 `Gateway#execute`，也**没有**调用私有的 `#append`（外部不可达）。因此这些数字**不是** HTTP 端到端计时，**不能**据此声称「真实 gateway 冻结数秒」或「live SSE 停摆」。原始 stdout 保存在 `.dev/architecture-routes/gateway/probe-ledger-append.log`（含命令、exit、node 版本、警告与完整 JSON，未重跑）。同一脚本的 `rows`/`seedMs` 段**是**真实公开 seam（真实 `GatewayExecutionJournal` + `begin`/`complete`）。
复现结果（填满默认 4 MiB capture，DEFAULT_CAPTURE_BYTES，index.ts:L95）：4 KiB×1024 chunk = 335.9 ms；1 KiB×4096 = 1174.2 ms；256 B×16384 = 5220.6 ms。
**归因必须谨慎**：二次工作量来自**每 chunk 对已累积串的 `Buffer.byteLength` 重扫**（该部分是确定性的 O(已捕获字节)）；**不可**把全部代价归给字符串拼接本身——V8 的字符串连接可能走 rope/cons-string 表示，使 `current + text` 本身接近 O(1)。本探针**没有**分离这两个因素（未做「只算长度不拼接」或「只拼接不算长度」的对照）。
**实用性未知**：256 B/chunk 是刻意构造的上界；真实命令的 chunk 分布未测，因此「常见命令会付多少代价」**无法从本探针推断**。SSH 侧 `runner.ts` 的 `collect`(L254-256) 为 `stdout += chunk.toString("utf8")`，同一模式且**无任何上限**（`captureBytes` 只作用于 `Gateway#append`），但同样**未测**。
Trigger（推断）：本地 gateway 上一条输出接近 4 MiB 且 chunk 很小的命令。Impact（推断，未观测）：该调用自身耗时上升；是否影响其它 surface 未测。Likelihood：低–中，取决于真实 chunk 分布（未知）。Owning seam：`Gateway#append`（改为「累计字节计数 + chunk 数组，返回时 join」可同时消除重扫与重复拼接）。Disposition：**record**（revisit：拿到真实 chunk 分布，或出现可复现的 gateway 卡顿）。

**G3（design/perf）账本是同步 SQLite，单次调用延迟中位数在毫秒量级。**
`GatewayExecutionJournal` 用 `DatabaseSync`（execution.ts:L229-296）。**证据性质：真实公开 seam**——探针构造真实 journal 并调用真实的 `begin`/`complete`/`lookup`；它**不是**吞吐测试。原始 stdout 保存在 `.dev/architecture-routes/gateway/probe-ledger-prune.log`（命令、exit、完整 JSON，未重跑）。
结果（各 40 次采样取中位，`maxCalls=1000`）：`begin` 5.434 ms、`complete` 10.921 ms、`lookup` 0.036 ms；`maxCalls=100000`：`begin` 4.526 ms、`complete` 6.222 ms、`lookup` 0.021 ms。
可支持的结论只有两条：(a) 同步写盘使单次 `begin`/`complete` 付出毫秒级事件循环阻塞；(b) `#prune` 的 O(已完成行数) 扫描**未被证明是瓶颈**——`maxCalls` 1000 → 100000 的差异落在噪声内。
**不能支持的结论**：任何「calls/s 上限」。该数字未测量，且 `complete` 已含 `#prune`，两者未分离；从单次延迟反推吞吐还依赖并发度、WAL 批量行为与调用方节奏，均未测。Trigger：每次执行调用。Impact：每次调用一次毫秒级同步阻塞；对单用户 harness 有限，与慢读者叠加时放大（未测）。Likelihood：常态存在，量级取决于并发（未测）。Owning seam：`execution.ts`（可选：`DatabaseSync` 移出事件循环，或批量写）。Disposition：**record**。

**G4（logic，证据已足，与 server-perf F7 同一实测）terminal SSE 写者无背压，且生产者不可被节流。**
`#writeTerminalFrame`(index.ts:L934-936) 是同步 `void` 写：既无 `writableLength` 上限（对比 `#execute` L693 的 1 MiB destroy + drain），也无 `drain` 等待（对比 `#streamFile` L675）。两个调用点都不看返回值：fan-in `:848`（心跳另有 `:840` 裸 `response.write`）与 per-session `:897`。
**数值一律以 server-perf 的原始日志为准**（`.dev/architecture-routes/server-perf/probe-terminal-backpressure*.log`，其 F7 正在修订）。本报告**不复制任何字节/RSS 数字**，以免与 raw log 不同步；本报告只提供**所有权与因果**这三项源码事实：
1. **回调链全程是 `void`，没有反向压力通道。** `FramedTerminal` 的 `onOutput` 类型即 `(text: string) => void`(terminal.ts:L312)；`#consume` 同步调用它(L388)；`TerminalSessions.#record`(L678-689) 与 `#emit`(L690-692) 均返回 `void`。因此**在 writer 里 `await drain` 并不能节流生产者**——helper 的 `os.read(master, 65536)` 会继续推，积压只是从「响应缓冲」转移到「`queue` 数组」与 backlog，总量不减。
2. **对照：execute 面确实有生产者节流。** SSH 侧 `StreamPump.feed`(runner.ts:L167-181) 在 sink settle 前 `pause()` 流，所以 `await sink` 真的压住了远端命令；`#execute` 的 `write`(L690-698) 也检查 `writableLength` 并 `await drain`。**终端面没有这两样中的任何一样。** 本地路径是例外：`NodeExecutionEnv` 不等待回调（源码注释 index.ts:L387-388），故本地 execute 也无法被 sink 节流。
3. **两条流、两个积压点。** `queue`(fan-in `:794 push` / `:844 shift`；per-session `:869` / `:914`) 与 Node 的响应缓冲是**两个**需要各自设界的量；`TerminalSessions` 的 128 KiB 界只覆盖**重放**（`TERMINAL_REPLAY_CHARS`），不覆盖在途，也不覆盖 queue。
Trigger：一个暂停/被节流的 tab 订阅持续输出（`yes`、日志 tail）且累计超过内核 socket 缓冲。Impact：网关进程内积压随发出量增长；未观察到 OOM。Likelihood：中——需要「慢读者 + 大量输出」同时成立。
**修复指引（非朴素 drain-only；实现不在本报告范围）**：只加 `await drain` 会**把无界增长从响应缓冲搬到 `queue` 数组**，且一个永不读的客户端会让该流永久停在 drain 上（reconnect/reset 契约下这等于把会话钉死）。真正需要的是三者之一或组合：(a) 对 **queue 与 writableLength 同时设界**（任一越界即按同一处断流）；(b) 断开放弃慢接收方，让客户端按既有的 reconnect + `reset` + 128 KiB replay 契约重连；(c) 丢弃策略（明确丢哪些帧、如何让 offset 游标仍连续）。选哪一种（等待 / 丢弃 / 断开）是产品取舍，本报告不决定。
Owning seam：`#writeTerminalFrame`（帧边界归它，故背压与断流策略也归它），但**必须与 `TerminalSessions` 的订阅/回调签名一起改**，否则无法把压力回传给生产者。Disposition：**investigate → 证据已足，列为 fix 候选**。

**G5（design）终端会话数无上界。** `TerminalSessions.#sessions`(terminal.ts:L513) 不设并发上限，每个会话持有一个 helper 进程与 128 KiB backlog；未附着会话 120s 后被 lease 回收，因此上界由开启速率决定。Trigger：脚本/多 tab 短时间大量 open。Impact：进程与内存压力。Likelihood：低（单用户 UI，且未附着会话 120s 内回收）。Evidence：**仅源码**（未测量；本报告不做新探针）。Disposition：**record**。

**G6（mixed）能力缺失的应答形状不一致。** 同一「本主机不提供该 surface」在四个地方四种形状：terminal 501+`not_supported`(L713)、worktrees 200+`not_supported`(L581)、mcp 200+`mcp_unavailable`(L570)、files 200+`{ok:false}`**无 code**(L598)、installs 200+`installFailure("not_supported",…)`。生产装配下各 surface 恒定存在，只有测试/脚本会构造缺项。Impact：调用方需按路由分别解释；无数据风险。Likelihood：仅构造期缺项。Evidence：源码。Disposition：**record**（revisit：新增调用方按 code 分支时）。

**G7（design）SSH 复用面的不对称代价。** master 只服务 installs+execute；worktrees 与 workspaces 每次调用都走一次性 `execute`，且一次 worktree 操作含多次 git 往返（`gitAnswer` 调用点 worktrees.ts:L154/176/253/290/320 等 6 处）。Trigger：SSH gateway 上 `worktree list`。Impact：每次 git 往返一次完整 SSH 连接/认证（每次约百毫秒级），list 至少 2 次。Likelihood：常态但可接受。Evidence：源码推断（未测量，未在本机做 SSH 计时）。Owning seam：`sshGitRunner`/runner 策略。Disposition：**record**（revisit：出现可观测的 SSH worktree 延迟投诉时再做测量）。

## 5. 性能预算（measured vs inferred）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 4 MiB capture，256 B chunk | 5220.6 ms | measured，**孤立算法复现**（probe-ledger-append.log） |
| 4 MiB capture，1 KiB chunk | 1174.2 ms | measured，同上 |
| 4 MiB capture，4 KiB chunk | 335.9 ms | measured，同上 |
| journal complete() 中位 | 6.2–10.9 ms（1000 与 100000 行差异在噪声内） | measured（真实公开 seam），probe-ledger-prune.log |
| journal begin() 中位 | 4.5–5.4 ms | measured |
| journal lookup() 中位 | 0.021–0.036 ms | measured |
| terminal backlog 上界 | 128 KiB/会话 | source（常量） |
| terminal SSE 在途字节上界 | **无** | measured（数值见 server-perf 原始日志，本报告不复制） |
| terminal 订阅 queue 上界 | **无** | source（`:794`/`:869` 无界数组；writer 一旦 await drain 即成为主要积压点） |
| terminal replay 上界 | 128 KiB（TERMINAL_REPLAY_CHARS） | source（常量） |
| execute 生产者节流 | 有（SSH：StreamPump pause；本地：无） | source，runner.ts:L167-181 / index.ts:L387-388 |
| helper 单次 PTY 读 | 64 KiB | source |
| execute 帧缓冲阈值 | 1 MiB → destroy | source |

**本路线自有探针（命令 / exit / 原始 stdout 全部留档，未重跑）**：

| 脚本 | 命令 | exit | 原始日志 |
| --- | --- | --- | --- |
| `probe-ledger-append.ts` | `timeout 240 node .dev/architecture-routes/gateway/probe-ledger-append.ts 2>&1 \| tail -5` | 0 | `probe-ledger-append.log` |
| `probe-ledger-prune.ts` | `timeout 200 node .dev/architecture-routes/gateway/probe-ledger-prune.ts 2>&1 \| tail -3` | 0 | `probe-ledger-prune.log` |

两份 `.log` 是当时工具 stdout 的**原样保存**（含 node 版本 v26.5.1、`MODULE_TYPELESS_PACKAGE_JSON` 警告、完整 JSON 行与 `exit=` 标记），**不是重跑结果**；`.log` 头部另注明了每个脚本的证据性质（`append` 的 chunk 段是孤立算法复现；`rows` 段与 `prune` 用真实公开 seam）。
作废的早期尝试：`probe-ledger-append.ts 20000` 与以 20000 行播种的 prune 版本均超时（`exit=124`），已按 PID 终止，无残余进程（`pgrep -af probe-ledger` 为空），`/tmp/gwprobe-*` 已删除。

### 与其他路线的重叠（去重提示，供汇总）

- **G4 = server-perf F7**：同一 seam（`#writeTerminalFrame`），同一实测产物。汇总时**只应计一次**；本报告只补源码侧所有权与因果（回调链全 `void`、无生产者节流通道、queue 与 writableLength 两个积压点、`StreamPump` 对照），**不复制任何字节/RSS 数字**（以 server-perf 原始日志为准）。
- **G7 与 cross-host 的 SSH 往返主题相邻**，但本报告只谈 worktree/workspace 面，不涉及 MCP/trust。
- **G3 与 server-perf F1/F3 同属「每次操作付一次全量代价」**，但对象不同（网关账本 vs 后端发布），不重复。

## 6. 支撑测试

- `packages/client/test/gateway.test.ts`：真实 git 仓库上通过 CLI 启动的 gateway 走公开 HTTP 路由做 worktree list/create/remove，并用 git 直接回读 → 入口 B 的端到端 seam 证据。
- `packages/client/test/cli.test.ts`：参数/环境/配置优先级、SSH 配置拒绝、doctor 不打印 token。
- `packages/gateway/test/{execution,terminal,terminal-heartbeat,worktrees,ssh-workspaces,controlmaster,file-transfer,file-transfer-sshd,mcp}.test.ts`：账本、终端租约与心跳、master 生命周期、SSH 文件会话。
- `apps/server/test/{ssh-project,terminal-transcript,terminal-browser,worktree-picker}.test.ts`：跨进程的真实装配。
- 未在本报告新增或重跑整套测试；未做部署、未改产品代码。
- G4 的实测归 server-perf 路线（`probe-terminal-backpressure.ts`，本报告不重复其探针）；G2/G3 的探针是本路线自有（`.dev/architecture-routes/gateway/`）。

## 7. 不确定性与诚实边界

1. **G4 已由 server-perf 路线的有界探针定性**（具体数值以其原始日志为准，本报告不复制）。覆盖面仅限于「夹具执行宿主 + 从不读取的原始 socket + 单机 + 探针自设上限」。**未观察 OOM**，也未测真实浏览器慢消费者的恢复行为、真实 SSH 终端的额外缓冲层、以及 `TerminalSessions` backlog 与响应缓冲的交互。探针在上限处停止且积压仍在爬升，因此「有无平台期」**未知**；「会不会 OOM」是推断，不是测量。同 session 同时订阅两条流（fan-in 与 per-session）的情形未单独测。
2. **G2 的 chunk 段是孤立算法复现，不是公开 seam，也不是端到端计时**：探针把 `#append` 的函数体抄成局部函数（它不调用 `Gateway#execute`，也够不到私有 `#append`）。因此**不能**声称「真实 gateway 冻结 5 秒」或「live SSE 停摆」——那是未观测的推断。二次工作量中**可确定**的部分是每 chunk 对已累积串的 `Buffer.byteLength` 重扫；**字符串拼接本身的代价未分离**（V8 可能用 rope/cons-string，使 `current + text` 接近 O(1)），本探针没有做「只度量不拼接」的对照。**真实 chunk 分布未测**，故实用延迟无法从本探针推断。4 MiB 是默认 `captureBytes`；更大的 `captureBytes` 未测。SSH 侧 `collect` 的同一模式**未测**。
3. **G3 只证明了两件事**：单次 `begin`/`complete` 是毫秒级同步阻塞；`#prune` 的 O(已完成行数) 扫描**未被证明是瓶颈**（`maxCalls` 1000 → 100000 的中位差异在噪声内）。**没有测过吞吐**，因此本报告**不给任何 calls/s 上限**：`complete` 已包含 `#prune`（两者未分离），且从单次延迟反推吞吐还依赖并发度、WAL 批量行为与调用方节奏。数值来自本机热缓存单次运行、40 次采样取中位、SQLite 位于 `mkdtemp` 目录，**不可外推为跨机常数**。
4. **G7 完全是源码推断**：未在本机做任何 SSH 计时（会依赖真实远端与网络，超出本路线范围）。「每次 git 往返约百毫秒」是常识性量级，不是本仓库测量值。worktree 操作的往返次数（6 处 `gitAnswer` 调用点）是源码计数，不是运行时计数。
5. **G1 的两处差异是源码级确认**（全仓 grep：`HEPI_TERMINAL_HEARTBEAT_MS` 唯一读取点是 main.ts:L64），但「CLI 部署是否真的需要更小心跳」取决于前端 hop 的 idle bound，本仓库文档未给出该数值 → 影响大小未定。
6. **未做**：任何产品代码修改、部署、重启、整套测试重跑、SSH 连接、remote-host 上的任何操作。G6/G5 只有源码证据。G7 未测量。

## 8. 图证据限制与「新鲜度」的可证明范围

**图的新鲜度（当前唯一结论）**：`built_at_commit` 记录的是**构建时的 commit ref**，它**不是对工作树的 pin**（git 的 HEAD 不随未提交改动移动，也不描述它们）。所以**单凭 SHA 不能证明新鲜度**（cannot prove freshness from SHA alone）：SHA 一致既不能推断「图里没有脏源码」，也不能推断「图与工作树一致」。

- 本项目实际的两个图**都是从当前工作树生成的**：默认 AST 图（10,991 节点 / 21,710 边）在源码冻结后由父会话刷新；deep 图（9,855 节点 / 20,443 边，AST 859 文件 + 语义 delta 12）同样按工作树刷新，并做了 source-drift 检查。也就是说它们包含工作树当前内容——但这只能由生成记录与 source hash 支持，**不能**由 `built_at_commit` 支持。
- 因此本报告的定位是：图只作**导航**用；任何行号与契约都必须回到源码确认（本报告全部如此）。要断言图的新鲜度，需要 `source hash`（或等价的逐文件内容比对），而不是 SHA。

其余限制不变：AST 边含 INFERRED 启发（`indirect_call`、低分 `calls`）；`GatewayRpcServer` 的 url 串分派属动态路由，图无法表达——第 1 节的分派来自源码阅读，非 BFS 路径。`query "startGateway"` 命中另一文件同名函数，是「命中≠实现」的例证。

默认图（10,991 节点 / 21,710 边）与 deep 图（9,855 节点 / 20,443 边 / 416 社区）的 `built_at_commit` 均为 HEAD；如 §8 所述，**该字段不能证明新鲜度**，行号一律以工作树回源为准（本报告全部如此）。AST 边含 INFERRED 启发（`indirect_call`、低分 `calls`），`GatewayRpcServer` 的 url 串分派属动态路由，图无法表达——第 1 节的真实分派来自源码阅读，非 BFS 路径。`query "startGateway"` 命中另一文件同名函数，已作为「命中≠实现」的例证记录。
