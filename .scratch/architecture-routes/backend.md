# 后端路线报告：request → durable submission → conversation execution → events/history/catalogue → recovery/restart/fork/delete

范围：master `1758c1f` + 现有未提交 audit/design 修复（工作树，非部署运行态）。只读产品代码，未做任何修改。
本报告为导航+源码确认结果，不是功能缺口清单。

## 1. 图导航证据与实际符号

CLI（`~/.local/bin/graphify query SYMBOL --budget 600..1000`，默认 AST 图 `graphify-out/graph.json`，10,991 节点 / 21,710 边 / 478 社区，`built_at_commit` 与 HEAD 一致但工作树 dirty，行号以源码为准）：
`WindowProjector`、`startGateway`、`McpHostService`、`conversation`、`session-reducer`、`tombstone`、
`conversation.submit`、`whenBusy steer followUp`、`TombstoneDoc`、`catalogueEntry`、
`continuationIndex`、`oversizeFrame`、`advanceCatalogueStats`、`tombstoneConversation`。
MCP 侧：`createHarnessServer` **0 命中**。

正确入口名（源码确认）：`createBackendServer` `apps/server/src/server.ts:L780`、`openServerHarness` `apps/server/src/harness.ts:L39`、
`attachConversation` `server.ts:L584`、`WindowProjector` `apps/server/src/history-window.ts:L131`。
`DurableSessionStore`、`submitPrompt` 无节点——这些 token 在本仓库符号集中不存在（`DurableSession` 在 `packages/session/src/index.ts:L86`，`submit` 是方法名，CLI 命中的是测试 helper）。

图限制（如实记录）：默认图为 AST 层，**没有 HTTP 路由→handler 边**，因此 "createBackendServer 到 GatewayRpcServer 无有向路径" 是图能力限制，不是"没有实现"；
路由分发只能靠源码确认（`server.ts:L1138 handle`，逐条 `url.pathname` 比较）。BFS 路径同样不等于运行时分发。
未并发重建图，未跑 deep 图（父级已提供 deep 构建 9,855 节点 / 20,443 边 / 416 社区）。

## 2. 运行时原生归属（native ownership）与源码契约

**原生（`@earendil-works/pi-durable` 1.1.0）拥有的事实，后端只是 Adapter：**

| 事实 | 原生 owner | 后端 Adapter 位置 |
| --- | --- | --- |
| 提交准入/去重/排队/落位/结算 | `Conversation.submit` + `SubmissionRecord` 状态机（`dist/types.d.ts:L320-383`：queued→placed→done/unanswered） | `server.ts:L1895` 一次 `conversation.submit({type:"input",content,requestId,whenBusy})`；**去重完全原生**（`submissionByRequest` `types.d.ts:L849`），后端不实现第二份幂等表 |
| 提交恢复查询 | `tx.submissionByRequest` | `GET /api/conversations/:id/submissions?requestId=` `server.ts:L1732-1736`；未准入返回 null，不是错误 |
| 未结算提交枚举 | `Harness.inspect()`（`dist/harness/harness.js:L152-158`，扫 queued+placed） | `readPendingSubmissions` `server.ts:L447`，再按 conversationId 过滤 |
| 结构视图（entries+内置文档） | `conversation.watch()`（`dist/harness/view.js:L65`，序列化精确帧 watch） | `attachConversation` `server.ts:L585` |
| 提交生命周期流 | `watchEvents(harness, conversationId)` | `server.ts:L586`；settlement 单独走 `submission` 帧（`server.ts:L741-750`） |
| fork / 文档 fork 语义 / 任务表 | `conversation.fork`、`defineDoc` 的 `fork: "current"/"initial"`、`scanTasks` | `server.ts:L1815-1841`；`TombstoneDoc` `fork:"initial"`，`TitleDoc`/`WorkspaceDoc` `fork:"current"` |
| 事务写入 | `Session.commit(tx => …)` | 只经 `tx.doc` / `tx.settleSubmission` / `tx.createTask`；无直接存储编辑（`session-delete.test.ts:L212-218` 断言无 `DELETE FROM/DROP TABLE`） |

**后端自己拥有的派生状态**（全部可重建，不是第二份持久化所有者）：
`ConversationRuntime`（`server.ts:L254-303`）= per-attachment 的 `revision` 计数、`projectionId`（`randomUUID()`，故意不持久化）、
`WindowProjector` 窗口、`HistoryFacts`、`CatalogueStats`、`pending` 提交投影 Map、title/deletedAt/lastRunEndedAt 缓存、clients 集合。

## 3. Interface 契约与不变量

1. **准入**：`validateCommand`（`packages/protocol/src/index.ts:L86-118`）是共享的最小命令契约（protocol 版本、requestId/conversationId 非空、text 或 images、workspace 不可变）。服务端追加：`readBody(request, MAX_SUBMISSION_BODY_BYTES)`（`server.ts:L1875`，协议导出 L53）；图片模态拒绝（`server.ts:L1889`）；`whenBusy ∈ {steer,followUp,reject}` 校验（L1881）。`whenBusy` 默认 `followUp`（L1895）——即默认排队而非拒绝。
2. **顺序与续接**：`revision` 是 **per-attachment 计数器**（`server.ts:L621`），`projectionId` 是 attachment 身份（L452-458）；delta 帧要求 `baseRevision === 客户端 revision`，续接判据是 `continuationIndex`（`history-window.ts:L483-490`）：head marker 相同 **且** 前一窗口最新 entry 仍在。head marker 变动 = 整窗重述，这是唯一结束已加载 prefix 的事件。
3. **窗口预算**：`VISIBLE_WINDOW=50`、raw cap `max(200, visible*6)`、`FRAME_TARGET_BYTES=512 KiB`（软目标）、`FRAME_LIMIT_BYTES = 1 MiB - 64 KiB`（硬），对应 `send()` 在 `writableLength > 1 MiB` 时 destroy 连接（`server.ts:L490`）。不变量：字节预算只丢"不投影成消息"的 entry，最后一个可投影 entry 永不丢；窗口过空时 `#widenToProjectable` 回退到最近可投影锚点；边界按**位置**而非 id（head marker 的 id 比它所带的 entry 更新）。
4. **唯一投影表达式**：`projectEntry`（`server.ts:L326-342`）——baseline、分页、delta append、单 entry 读块四条路径共用，`safeEntry` 脱敏与 `deferHistoryMessage` 延迟形状因此不可能漂移；`projectedItem`（L344）把字节数在投影点测一次，字节预算不再重复序列化。
5. **目录不变量**：`messageCount/firstMessage` 增量维护（`advanceCatalogueStats`），title/tombstone/lastRunEndedAt 在 attach 时读一次、之后由 `subscribeCommits` 保持（`server.ts:L596-617`）；框架 root conversation 永不 attach（L1074-1078）；已删除会话从 list/search 过滤，新 turn 以 409 `session_deleted` 拒绝。
6. **删除=墓碑文档**，不删数据：`tombstoneConversation`（`session-tombstone.ts:L38-46`）一个 commit 内写 `TombstoneDoc` 并清 sidebar 三标记；条目、记录、conversation-scoped 文档重启后仍可读（`session-delete.test.ts:L135-152`）。

## 4. 优点（保留的 deep Module）

- `attachConversation` + 原生 durable：删除它会把恢复、顺序、settlement 知识散到四个 HTTP/SSE 入口。Adapter 深，Interface 小（一个 `ConversationRuntime`）。
- `WindowProjector` / `appendedEntries`：`advance(entries, appended?)` 一个小接口隐藏三种预算、增量投影与 reset 语义；native ops 翻译是内部 seam，不跨外部 Interface。
- `projectEntry` 单一投影表达式 + 三个 read block（thinking/text/tool-result-image）：延迟是**无损**的，且按位置而非 id 分页，使 compaction summary 可达。
- `packages/session` 的 `reduceSseFrame`：delta fold 与 snapshot fold 是同一个 fold（`test/delta.test.ts` 断言相等而非相似）。
- fork 先答所有拒绝（not_found/unsaved/empty/subagent），再一个原子 commit，拒绝不产生任何东西（`session-fork.test.ts:L198-207`）。

## 5. 发现（design / logic / mixed）

### F1 · mixed · record — `/busy` 路由缺少 `deletedAt()` 守卫
触发：客户端向一个已被墓碑的会话 POST `/api/conversations/:id/busy`（`server.ts:L1939-1947`）。该分支**不检查** `item.deletedAt()`，而同文件的 `messages`（L1876）与 `auto-name`（L1764）都检查。
影响：在已删除会话上准入一条输入；它可能被落位并把条目追加进保留记录，而任何表面都不列出它（catalogue 过滤、search 过滤）。
可能性：低——当前 Web adapter 的命令分支（`durable-api.ts:L637-677`）只转发 prompt/abort/fork/settings/get_state/clear_queue/get_tools/get_commands/reload，未接 `/busy`；命中它的是上游 `pi-web` 形状的客户端与 `server.test.ts:L222`。这是上游兼容路由。
证据级别：源码对照 + `session-delete.test.ts:L176-181` 只覆盖 messages。`/busy` 与 `messages` 的实际差别在于前者直接调 `conversation.submit` 而绕过 `validateCommand`。
处置：record。若该端点保留，最小 coherent 修复是把守卫放在会话路由分发点（`server.ts:L1636-1640`）而不是逐路由重复，这与"修在 owner 处"一致。

### F2 · design · record（需实测才升 investigate）— attachment 生命周期无回收
`attach()`（`server.ts:L1049-1056`）从不驱逐：`conversations` Map 在进程生命周期内保留每个会话，每个都持有一条 `conversation.watch()` + `watchEvents()` 观察者、一个最多 300 raw entry 及其投影的 `WindowProjector`、catalogue 计数与三个缓存值；原生 mount 只有在 observer 数为 0 时才释放（`dist/harness/view.js:L84-96`）。
触发：正常使用下会话数增长——启动时**所有**已存会话都被 attach（`server.ts:L1076-1088`，每页 100）。
影响：内存与原生订阅随 catalogue 规模而非屏幕规模增长；长寿命进程 RSS 上升。
证据级别：**推断**，本次未做内存探针（scope 限制）。可能性中，实际影响未量化。
处置：record；只有出现真实 RSS/延迟证据才升级为 investigate。这是设计限制（owner 是 `attach` 的会话生命周期），不是逻辑缺陷。

### F3 · design · record — 目录增量计数重复判定 append
`advanceCatalogueStats`（`history-window.ts:L450-464`）用 `before.every((entry,i)=>entry===after[i])` 逐项比较整个旧数组，而同一调用方下一行已经用 `appendedEntries(ops, previousLength)` 从 native ops 得到同一事实（`server.ts:L727-733`）。
触发：长 active range 上的每一次 view 更新。复杂度 O(active range)/publication，而窗口与 history facts 是 O(appended)。
证据级别：推断（未测 CPU）；上一轮审查已记录为 P3 advisory（`.scratch/development-audit/design-backend-review.md` §2），本工作树未改变。
处置：record。最小 cut 是让目录复用既有 `appendedEntries` 结果，`undefined` 时才全量重算；无需新 Module。重访条件：真实长会话 CPU 证据。

### F4 · design · record — 快照/增量 wire 形状被手写三份
`packages/protocol` 真正共享的是命令与常量半部（`PROTOCOL_VERSION`、`HEARTBEAT_*`、`validateCommand`、`validateSubmitImages`、`projectSubmission`、`MAX_*`、read-block URL 构造），这部分没有重复。
但**读路径**的帧形状有三份手写声明：`server.ts:L62 ServerSnapshot`、`apps/web/adapters/durable-api.ts:L34`、以及 `packages/session/src/index.ts:L8-16`（更窄且 delta-aware）。
触发：某字段在服务端改名而两份副本未同步——读路径没有运行时 schema 校验，`isSnapshot/isDelta` 只检查它读取的字段存在、不拒绝多余字段，`foldFrame` 用自己那份。
影响：整类静默漂移风险（字段被丢而无人报错），不是当前故障；当前三份对各自读取的字段一致（entries/partial/busy/oldestEntryId/hasMore/revision/conversationId/protocol 已核对）。
可能性：每次 wire 变更时中；影响为静默。
处置：record（接口卫生建议）。没有真实漂移事故前不引入新 wire 包；若要收敛，让 `packages/session` 从单一处 re-export 形状是成本最低的一步。

### F5 · logic · record — `harness.inspect()` 是会话无关的全表扫描
`readPendingSubmissions`（`server.ts:L447-450`）调用 `harness.inspect()`，后者扫描**全部** queued 与 placed 提交（`harness.js:L152-158`，`scanAll` 分页累积），再在服务端按 conversationId 过滤。
触发：每次 attach（`server.ts:L646`）与每次 events 流 overflow（`server.ts:L750-753`）。
影响：成本 O(所有未结算提交)；通常极小（未结算工作本身有界），但随并发会话/排队量线性增长。
证据级别：推断，未测。
处置：record。

## 6. 性能：复杂度、预算与实测/推断边界

**实测（复用既有证据，未重跑）**
- 每轮字节与最大帧：`docs/chat.md:L118-124` 引 `apps/server/scripts/perf-history-scaling.mjs`——10→240 轮每轮 **~721→~726 字节**（近似平坦），最大帧 **~1.04 KiB**；lane B 基线 5,524→152,175 字节/轮。
  fixture 限制（必须随数字一起引用）：合成同构 turn、faux provider、单会话、进程内（无网络/代理）、无图片、无真实工具流量；脚本同时断言 delta 契约（`baseRevision` 衔接、appended 与逐条读入字节一致）为**行为**而非字节上限。
- 前端：Web 单元 2307 通过 / 16 既有失败（名称集合无新增）；浏览器 deferred-text 17、history 11、Settings 23 通过（`.scratch/design-fixes/results.md`）。
- 上一轮 server/protocol 285/47 通过（同一工作树）。

**推断（未测，明确标注）**
- F3：目录计数 O(active range)/publication。
- F5：attach/overflow 时 O(全部未结算提交)。
- F2：attachment 内存与原生订阅随 catalogue 规模增长。

**硬预算（源码常量，非实测）**：软目标 512 KiB，硬限 1 MiB − 64 KiB，传输层 destroy 阈值 1 MiB；超出时以 `state_oversize` 具名拒绝而非静默截断（`server.ts:L699-702`、L1861-1864；`frame-size.test.ts` 4 个测试覆盖 state/stream/page 三条路径）。

## 7. owning seam 与实践建议

- 原生 durable（submit/watch/watchEvents/fork/文档 fork/墓碑）保持不动：它是深度来源，任何自建队列都会重建生命周期与顺序知识。
- 需要加深的只有两个既有 seam：
  1. `history-window.ts`（窗口 + 预算 + facts + 计数）——目录计数应复用 `appendedEntries`，不新增 Module。
  2. 会话路由的 `deletedAt` 判定应集中在 `server.ts:L1636-1640` 的分发点，而不是 `messages`/`auto-name` 各写一遍、`busy` 漏写。
- 不建议现在动 wire 类型（F4）或 attachment 回收（F2）——都缺真实触发证据。

## 8. 支撑测试（已存在，未重跑）

`apps/server/test/`：`durable-submissions.test.ts`(14)、`history-window.test.ts`(17)、`delta-frames.test.ts`(6)、
`session-delete.test.ts`(6)、`session-fork.test.ts`(6)、`session-reducer.test.ts`(4)、`recall-queue.test.ts`(4)、
`history-text.test.ts`(4)、`frame-size.test.ts`(4)、`server.test.ts`(15)，共 39 个测试文件；
`packages/protocol/test/`（命令校验、stream、submission 投影、sidebar 状态）、`packages/session/test/`（delta 相等性、window、loaded-prefix）。
测试接缝深度：全部经 `createBackendServer` 的真实 HTTP/SSE 公共接缝 + 临时 SQLite + 真实 Harness，未 mock durable 层——这是正确的测试面（调用方与测试跨同一 seam）。

## 9. 不确定性与诚实边界

- 未做任何新测量；F2/F3/F5 均为源码推断，数字缺失处已标注。
- 图未能表达 HTTP 分发；所有路由结论来自 `server.ts` 源码逐行确认。
- 工作树 dirty，行号可能与图快照不完全一致；已逐处回读源码确认。
- 未部署、未重启、未在 remote-host 构建、未跑全量套件。
