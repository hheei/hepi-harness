# B：以 durable-first 浏览器集成替换 legacy Web session/agent 契约（第三稿）

基线 `caf6a319177554f3fcc53e6a4efc6683a1a3e433`。研究阶段：本报告未改任何源码/测试/配置/依赖。本稿落实协调者最后 8 条 bounded 更正；**无新增广泛调研**，结论收敛为一套自洽目标。

---

## 0. 基线与来源（实测行数）

| 事实 | 来源 |
| --- | --- |
| BFF 唯一入口 | `apps/web/app/api/[...path]/route.ts`（50 行）：L12 origin 检查、L13 `durable-login`、L25 `web-auth`、L33 cookie 校验 |
| 适配器 | `apps/web/adapters/durable-api.ts`（906 行）：`uiMessage` L73、`context` L82、`sessionData` L91、`state` L96、`foldFrame` L130、HTTP 读 L589/L590/L624/L658、`context` 路由 L563-574、命令 switch L629-669、`events()` L832-906 |
| 浏览器 hook | `apps/web/hooks/useAgentSession.ts`（3021 行）：`SessionData` L85、`receive` L705、`loadSession` L890（读 L901、`/state` L1009）、`loadContext` L1053（`/context` L1057）、`openEvents` L1281、`handleAgentEvent` L1607、`handleLeafChange` L2127 |
| **共享 fold（C 拥有，将被修改）** | `packages/session/src/index.ts`（206 行）：`SessionState` L8（`entries: readonly ProtocolEntry[]`）、`reduceSseFrame` L53；私有 `windowStart` L118、`prefixOf` L144、`mergeWindow` L166、`advanceWindow` L186、`extendWindow` L198（全部只做 filter/slice/spread） |
| **prefix 规则（C 拥有，将被迁走或删除）** | `apps/web/lib/history-prefix.ts`（81 行）：`decidePrefix` L61、`LoadedPrefix` L35、`WindowFacts` L41 |
| 生命周期 fold | `apps/web/lib/lifecycle-projection.ts`（611 行）`applySnapshot` L391；`apps/web/lib/lifecycle-acquisition.ts`（287 行）`httpStatement` L212、`sseStatement` L222、`receiveAccepted` L284 |
| 连接（三份物理副本） | `apps/web/lib/agent-event-connection.ts`（231 行，每会话多路复用）；`packages/session/src/pi-web/agent-event-connection.ts`（205 行，仅被 `browser.ts:1` 使用）；`apps/web/vendor/pi-web/lib/agent-event-connection.ts`（202 行，vendor 快照） |
| 预算 | `apps/web/lib/completion-delivery.ts`（404 行）：`POOL_BUDGET=6`、`SELECTED_STREAM=1`、`HEADROOM=2` L93-95 |
| 生产者（后端，不变） | `apps/server/src/server.ts`（1925 行）：`send` L460、`authorized` L496、`frameFor` L649、`publish` L655、state 路由 L1614、`/entries` L1631、events 路由 L1826（`?after`）、L1837 `resync_required` |
| 生产者窗口规则 | `apps/server/src/history-window.ts`（525 行）：`VISIBLE_WINDOW=50` L16、`MIN_RAW_WINDOW_ENTRIES=200` L18、`rawWindowCap=max(200,visible*6)` L20、`FRAME_TARGET_BYTES=512 KiB` L25、`FRAME_LIMIT_BYTES=1 MiB−64 KiB` L32、`oversizeFrame` L418、`continuationIndex` L483 |
| wire 声明 | `packages/protocol/src/index.ts`（397 行）：`ProtocolEntry` L119（id/role/text）、`ServerEntry<TMessage = unknown>` L177（含 `message: TMessage`）、`ServerSnapshot` L201、`ServerDelta` L233、`ServerFrame` L234、`SubmissionProjection` L250 |
| 依赖事实 | `apps/web/package.json` L83 只有 `@hepi/protocol`；`packages/session/package.json` exports `".": "./src/index.ts"`、`"./browser": "./src/browser.ts"`、deps 仅 `@hepi/protocol` |
| 上游运行时 | `@earendil-works/pi-durable@1.1.0`（MIT）：`AgentEvent` union 无任何 `extension_ui*` 成员 |

---

## 1. 结论

**问题属实：一层把增量展开成整窗、并把 legacy 事件名映射到无生产者分支的 BFF，加上与共享 fold 重复的窗口规则和 transport 的三份物理副本。**

真实调用者（已确认）：

- 浏览器 `EventSource("/api/agent/<id>/events")`（`AppShell.tsx:161`）→ `durableApi.events()` L832 → 后端 SSE。`foldFrame`（L130）**只被 L885 调用一次**：把 `ServerDelta` 展开为完整 `ServerSnapshot`，再经 `sessionData`（L91）投影成 UI 形状发 `durable_state`。
- HTTP 读：`sessionData` 被 L590 调用；`state` 被 L589/L624/L658 调用；`context` 被 L563-574 调用。消费者：`useAgentSession.ts:901`、`:1009`、`:1057`、`:877`，`ExtensionsConfig.tsx:219`。

三条缺陷：

1. **delta 优化在 BFF 终止。** 生产者按 `continuationIndex`（`history-window.ts:483`）发增量帧，`foldFrame` 展开回整窗，`context`（L82）再整窗重序列化。每帧 Next 进程成本 O(window)。
2. **窗口/prefix 规则与共享实现在两份地方重复，且归属与 C 的最终方案不一致。** `foldFrame`（L130）重述了 `reduceSseFrame` 的边界规则；prefix 规则今天在 `apps/web/lib/history-prefix.ts`（`decidePrefix`），而 C 的最终归属是共享纯根——**C 会修改 `packages/session/src/index.ts` 的根与其测试，并把 `decidePrefix` 迁入共享纯根（或被 `prefixOf` 覆盖后删除）**；「根与测试字节不变」不是前提。
3. **legacy 契约大面积已死。** 命令 switch（L629-669）只实现 11 个动作，其余一律 501；而 hook 仍调用 `bash`(L2050)、`abort_bash`(L2073)、`navigate_tree`(L2114/L2137)、`compact`(L2199/L2348)、`set_auto_compaction`(L2363)、`set_session_name`(L2402)、`get_session_stats`(L2409)、`get_last_assistant_text`(L2433)、`clone`(L2446)、`set_tools`(L2622)、`extension_ui_response`(L1392)、`extension_ui_input`(L1406)。`events()` 只发 `connected`/`durable_state`/`durable_submission`/`durable_resync`/`durable_state_oversize`，因此 `handleAgentEvent` 中 21 个非 durable case（L1683–L1904）无生产者。

**synthesized 字段的真实消费者**（逐一确认）：

| 字段 | 合成值 | 消费者 | 实际效果 |
| --- | --- | --- | --- |
| `filePath` | `""` | hook L861 → `AppShell.tsx:2367`；`ChatWindow.tsx:784` | 永远显示 `session.inMemory` |
| `totalActiveMs` | `0` | hook L853/L865 → `AppShell.tsx:2369` 的 `> 0` 门 | 「Active Time」行永不渲染 |
| `tree` | `[]` | hook L2871 → `AppShell.tsx:370/374` | `BranchNavigator` 永不出现 |
| `leafId` | `snapshot.entries.at(-1)?.id ?? null` | hook L716/L928；`/context` 路由忽略该参数 | **不受支持的合成标识**，见下 |
| `snapshotRevision`/`treeFormat` | `historyRevision`；`treeFormat` **从不设置** | hook L973 `treeFormat === "summary"` 门 | 读路径 `setSessionViewSnapshot` 永不执行；缓存只在卸载路径（L2824）写入 |
| `wrapperRebuilt` | 从不设置 | hook L998 | 分支不可达 |

**`leafId`**：**不受支持的合成标识**。`ServerSnapshot` 无任何分支/leaf 字段，wire 上没有 active-leaf 语义；合成值是「窗口末条 id」这一近似。处置是改为显式 `null`（§8-5）。

**legacy 死分支**：`dispatch({type:"delta"})`（L1763）不可达 → `streaming-message.ts` 的 `delta` 分支整条死掉（`start`/`resume`/`snapshot`/`end` 仍用）；`extensionDialogs`/`extensionCustomUis`/`respondToExtensionUi`/`sendExtensionCustomInput` inert。`lib/agent-event-stream.ts`（315 行）除自身测试外无调用者，其专属依赖 `lib/session-liveness.ts`（199 行）、`lib/exact-system-prompt.ts`（32 行）随之 dormant；`lib/agent-event-wire.ts` 的 `toClientAgentEvent`/`isEventIncludedInSnapshot` 也只被它使用（其余导出仍被 `useAgentSession.ts:61`、`AppShell.tsx:82`、`streaming-message.ts:1`、`completion-delivery.ts:2`、`agent-event-connection.ts:1` 使用）。

---

## 2. 当前归属与数据流

```
浏览器(React)                        Next BFF (Node)                  后端 (remote-host)
────────────────────────────────────────────────────────────────────────────────────
EventSource /api/agent/:id/events ─► route.ts:33 cookie ─► durableApi.events() L832
                                    foldFrame L130 (delta→整窗)      Bearer HEPI_AUTH_TOKEN
                                    sessionData L91 (UI 投影)   ◄──► /api/conversations/:id/events
  ◄─ connected / durable_state / durable_submission / durable_resync / durable_state_oversize
       └► handleAgentEvent L1607 ─► receive L705 ─► advance (lifecycle-projection)
                                   ├─ 已接受 → setData / setActiveLeafId / setQueuedMessages
                                   └─ prefix 迁移 → decidePrefix
fetch /api/sessions/:id        ─► sessionData L91  ─► httpStatement L212
fetch /api/sessions/:id/state  ─► state L96       ─► applyAgentState L643（独立 fence）
fetch /api/sessions/:id/context─► 后端 /entries?before&tail ─► setHistory(prefix)
POST /api/agent/:id            ─► 命令 switch L629-669（其余 501）
```

依赖分类：

| 组件 | 类别 |
| --- | --- |
| `lifecycle-projection` / `lifecycle-acquisition` / `decidePrefix` / `reduceSseFrame` | **in-process 纯函数** |
| `foldFrame` / `sessionData` / `state` / `context` / `uiMessage` | **in-process 纯映射** |
| `@earendil-works/chord/delta` 的 `Op`（`history-window.ts:2` 唯一 import，同进程读一个结构事实） | **in-process 库**（不是 remote-owned，也不转发） |
| `AgentEventConnection` / `CompletionDelivery` | **local-substitutable**（有假源与测试） |
| 后端 SSE + `ServerFrame` + `oversizeFrame` 拒绝 | **remote-owned**（运行时拥有顺序、初始快照、拒绝语义） |
| `HEPI_AUTH_TOKEN` / `hepi-web-token` cookie | 部署边界 |

**两处 `windowStart` 不是同一件事**：`apps/server/src/history-window.ts:53` = **窗口选择**（visible/raw 预算、字节 target、`shrinkToBudget`）；`packages/session/src/index.ts:118` = **边界定位**（在已持有条目里找 boundary 的**位置**，因为 compaction summary 排最前却带更新的 id）。后者是 fold 的一部分，不是预算逻辑。

**窗口边界的真实上界**：`VISIBLE_WINDOW=50` 是可见消息上限，`MIN_RAW_WINDOW_ENTRIES=200` 是原始条目**下限**，实际 raw 上限为 `max(200, visible*6)`；`FRAME_TARGET_BYTES=512 KiB` 是**软目标**，且 `WindowProjector` 只允许丢弃「不投影出消息」的条目，因此仍超 target 的窗口会被**整窗携带**，由硬界 `FRAME_LIMIT_BYTES`（`oversizeFrame` L418）给出具名拒绝。**不存在「raw 300」常量，raw 上界未被证明。**

---

## 3. 方案比较

### 方案 1：把 `BrowserDurableSession` 作为浏览器侧 drop-in —— 否决

理由与「该类本身是否安全」是两件事：

- `browser.ts` 的 `DurableEventSource` 用 `authorization: Bearer <token>` 发请求。这是直连后端的正常设计，**不是类本身不安全**；它只是**与 Web 准入方式不符**——Web 侧 token 必须留在服务端（BFF cookie 准入），浏览器只有 httpOnly `hepi-web-token`，而 `EventSource` **无法设置任意请求头**（`Authorization`）。注意：`EventSource` **可以**在构造 URL 里带查询参数（见 §8-2）。
- `reduceSseFrame` **没有 `submission` 分支**，而 ADR 0006 规定结算只能靠该帧，故该路径丢结算；它也不处理 `state_oversize` 具名拒绝。
- 它没有 UI 投影、lease 续约、prefix store。

| 义务 | 现成 `BrowserDurableSession` | 采用它需新增 |
| --- | --- | --- |
| 认证 | `Authorization: Bearer` | cookie 准入（同源 URL + BFF 校验），token 不下发 |
| 结算 | 无 `submission` | `SubmissionProjection` 分支 + ADR 0006 lookup |
| 尺寸拒绝 | 无 | `state_oversize` → 具名 reason、不结算 |
| UI 形状 | 无 | `projectSession`（`SessionData`/`context`） |
| prefix/缓存 | 无 | prefix 规则 + `session-view-cache` |
| 连接预算 | 单连接 | 6 连接预算下的多路复用 |

结论：改造义务量 ≥ 保留现有实现。但**它作为一个消费者要被改接**到新的物理归属（§7），因此它本身会随重构修改。

### 方案 2：保留薄显式 UI 投影、只补字段（现状不动）—— 否决

保留 O(window)/帧、两份窗口规则、12 条 501 入口、三份 transport 副本。

### 方案 3（推荐）：共享 transport + 共享 fold + 显式浏览器 UI 投影；BFF 退化为认证 + 字节转发

- **fold 归属 = C 的最终方案**：`packages/session/src/index.ts` 的 `reduceSseFrame` 是**唯一**窗口 fold；C **会修改该文件与 `packages/session/test/*`**（放宽 `SessionState` 类型以保留原生条目与 metadata），保留的是**模块与公开用途**，不是字节。prefix 规则（今天 `apps/web/lib/history-prefix.ts` 的 `decidePrefix`）**由 C 迁入共享纯根或删除**；B **不再**把它当作留在 `apps/web` 的 owner 保留。**不新增 `foldWindow`/`LoadedHistory`/`WindowFrame`/`FoldOutcome`，不在 `@hepi/protocol` 放 fold。**
- **transport 的规范物理归属**：把 `apps/web/lib/agent-event-connection.ts`（已证实的实现，多路复用 + `ready/reconnect/release`）**移入 `packages/session` 的 browser-only 模块，经 `"./browser"` 导出**。纯根 `"./"` 保持**不含任何浏览器/EventSource 依赖**；`packages/*` **不得依赖 `apps/web`**。两处消费点（`apps/web`、`packages/session/src/browser.ts`）改接同一模块，随后删除两份被适配过的运行时副本（`packages/session/src/pi-web/agent-event-connection.ts`、`apps/web/lib/agent-event-connection.ts`）。
- **两种 source factory（同一 transport 的两种装配）**：
  - **默认（Web）**：cookie BFF factory —— source URL 为同源 `/api/agent/:id/events`（可带 `?after=`），**不设任何认证头**，认证由 BFF 的 httpOnly cookie 完成；
  - **诊断**：bearer factory —— 保留今天 `browser.ts` 里的 `DurableEventSource`（`Authorization: Bearer`），只服务 `apps/server/src/chat.ts` 诊断页。
- **BFF 停止 fold**：`/api/agent/:id/events` 变为后端 SSE 的字节透传（保留 `event:` 名、keepalive comment frame、`request.signal`、调用方 headers）。
- **UI 投影移到浏览器**：`sessionData`/`state`/`context`/`uiMessage` 四个纯映射变为浏览器侧一份 `projectSession`。
- **原生 metadata 完整保留**：`projectionId`/`revision`/`historyRevision`/`historyHead`/`run`/`submissions`/`settings`/`queuedMessages`/`failure`/`liveMessage`/`liveTools`/`resources`/`extensions`/`toolNames` 必须原样出现——它们是 `lifecycle-projection` acceptance 的输入。
- **原生 lifecycle 角色不动**：`lifecycle-projection`、`lifecycle-acquisition`、`lifecycle-store`、`completion-delivery`、`session-view-cache` 保留，只换输入来源。

---

## 4. 目标 Interface

### 4.1 transport seam

```ts
/** 一条会话流上的事件，替代 handleAgentEvent 里的 string switch。 */
export type ConversationStreamEvent =
  | { readonly type: "frame"; readonly frame: ServerFrame }
  | { readonly type: "submission"; readonly submission: SubmissionProjection }
  | { readonly type: "resync" }
  | { readonly type: "state_oversize"; readonly reason: string; readonly entryId: string | null; readonly bytes: number | null }
  | { readonly type: "open" };
```

**泛型（协调者已确认）**：`ServerSnapshot`/`ServerDelta`/`ServerFrame` 的类型参数流向 `ServerEntry<TMessage>.message`，**不是** frame 的 entry 类型。适配器与 reducer 都不校验该 payload，所以**保持默认泛型 `ServerFrame`（entries 为 `ServerEntry<unknown>`）是恰当的**；不写 `ServerFrame<AgentMessage>`。

`AgentEventConnection` 接口不变（`subscribe(conversationId, listener)`、`ready()`、`reconnect()`、`release()`、每会话一条 source），只把 `Listener` 参数类型从 `AgentEventLike` 换成 `ConversationStreamEvent`；物理位置见 §7。

### 4.2 fold + 投影 seam（C 拥有 fold，B 拥有投影）

```ts
// C 拥有（已在 packages/session 纯根；C 会修改其类型与测试，不是字节不变）：
//   reduceSseFrame(state: SessionState, event: string, data: unknown): SessionState   // 唯一窗口 fold
//   decidePrefix(...)   // 今天的 apps/web/lib/history-prefix.ts，由 C 迁入共享纯根或删除
// B 拥有：把已接受的窗口 + 原生 metadata 投影成 UI 形状
export function projectSession(window: ServerSnapshot): SessionData;
```

**为什么不需要第二条 id→payload 缓存**：`reduceSseFrame` 及其私有助手（`windowStart`/`prefixOf`/`mergeWindow`/`advanceWindow`/`extendWindow`）只对数组做 `filter`/`slice`/`spread`，**从不剥离 entry 对象**——运行时它保留的就是**原始 `ServerEntry` 对象**（含 `message`）；delta 的 scalar 也经 `const { baseRevision: _base, appended, ...scalars } = data` **全量保留**。所以真实缺口是**类型**（`SessionState.entries` 声明为 `ProtocolEntry` = id/role/text），不是数据。修法由 C 在根里把该类型放宽到原生形状（原生 `ServerEntry<TMessage>`，并让状态类型反映原生 snapshot 的 scalar 字段，例如 `run`/`submissions`/`settings` 等）。**这正是本次 consolidation 要处理的「公共原生类型适配」问题。引入第二个 `Map<entryId, ServerEntry>` 会把同一事实做成两份状态，正是要消除的重复，因此不做。**

### 4.3 接受边界

**域区分**：

- **stream-local 隔离态**（`heldRef`：reducer 状态）：**可以**在 UI 接受之前前进；它是这条流自己的、未发布的中间状态。
- **全局已接受态**（`setData` 的窗口、prefix、`session-view-cache`）：**只能在 `receiveAccepted(...).accepted === true` 时提交**。今天 hook L713-727 已如此，规则不动。
- **cache 不是 held 的镜像**：见 §8-1。

```ts
case "frame": {
  // 1. stream-local：先折，未发布，可自由丢弃。reducer 保留的就是原始 ServerEntry 对象。
  const held = reduceSseFrame(heldRef.current, "state", event.frame);
  if (held.resyncRequired) { emitResync(); break; }   // 什么都不提交（见 §9-2 的 resync 语义）
  heldRef.current = held;

  // 2. 已接受态：只有 acceptance 为 true 才提交全局窗口 / prefix / cache
  const statement = sseStatement(projectSession(snapshotOf(held)), currentAcquisition());
  if (!receive(statement).accepted) break;            // 被 fence：held 前进，全局（含 cache）保持原值
  prefixRef.current = decidePrefix(prefixRef.current, factsOf(held), id => entryOf(held, id));
  /* 今天 L1656-1666 的渲染分支原样保留 */
}
```

### 4.4 BFF seam

保留：`route.ts` cookie 校验、非 GET 的 origin/host 检查、`durable-login`/`web-auth`；catalogue/projects/workspaces/worktree/terminal/workbench/mcp/skills/search 路由。

---

## 5. HTTP 读的处置（定案）

**定案：协调式 HTTP 原生快照 cutover**，与 stream 改动同一步落地。

| HTTP 读 | 今天 | 目标 | 需同步更新的已知调用者 |
| --- | --- | --- | --- |
| `GET /api/sessions/:id`（L590） | `sessionData(snapshot)` | 原生 `ServerSnapshot` | `useAgentSession.ts:901`（改走 `projectSession`） |
| `GET /api/sessions/:id/state`（L589） | `state(snapshot)` | 原生 `ServerSnapshot` | `useAgentSession.ts:1009`、`ExtensionsConfig.tsx:219` |
| `GET /api/agent/:id`（L624） | `state(snapshot)` | 原生 `ServerSnapshot` | `useAgentSession.ts:877` |
| `get_state` 命令（L658） | `state(snapshot).state` | 原生快照 | `useAgentSession.ts:1205/2360/2645` |
| `GET /api/sessions/:id/context`（L563） | `{context: {...}}` | 原生 `/entries` 页 + 浏览器投影 | `useAgentSession.ts:1057` |

替代方案（若不愿一次改 5 处）：**保留 HTTP-only 薄适配器**，并把「删除它」记为一条有明确前置依赖的 bounded 项（依赖上述 5 个调用者完成原生快照迁移）。**必须二选一，不得同时声称删除与保留。**

---

## 6. keep / delete / move

| 路径 | 动作 | 调用者 | 依据 |
| --- | --- | --- | --- |
| `packages/session/src/index.ts`（`reduceSseFrame`/`SessionState`/私有助手） | **C 修改**（放宽状态类型以保留原生 entries+metadata）；保留模块与公开用途，**不假定字节不变** | `chat.ts`、`perf-history-scaling.mjs`、`packages/session/test/*`（C 同步更新） | 唯一 fold owner |
| `apps/web/lib/history-prefix.ts`（`decidePrefix`） | **C 迁入共享纯根，或被 `prefixOf` 覆盖后删除**；B **不再**作为 owner 在此保留 | `useAgentSession.ts:839/952`（随之改接最终归属） | C 拥有 prefix 规则 |
| `durable-api.ts` `foldFrame`(L130)、`events()` fold 段(L885-898) | **删除** | 唯一调用者 L885 | 与 `reduceSseFrame` 重复 |
| `durable-api.ts` `sessionData`/`state`/`context`/`uiMessage` | **移动**到浏览器 `apps/web/lib/durable-projection.ts` | §5 表 | 纯映射 |
| `durable-api.ts` 命令 switch L629-669 | **收窄**为后端已实现动作，其余显式 501 保留 | hook 12 处 | 已 501 |
| `useAgentSession.ts` 21 个 legacy event case（L1683–L1904） | **删除** | 无生产者 | `events()` 只发 5 类 |
| `apps/web/lib/streaming-message.ts` `delta` 分支 | **删除** | L1763 不可达 | 唯一调用点已死 |
| `apps/web/lib/agent-event-stream.ts`(315)、`lib/session-liveness.ts`(199)、`lib/exact-system-prompt.ts`(32) | **候选删除**（见 §8-4） | 无 durable 路径调用者 | provenance |
| `lib/agent-event-wire.ts` `toClientAgentEvent`/`isEventIncludedInSnapshot` | **候选删除** | 只被 `agent-event-stream.ts` | 其余导出仍用 |
| **`apps/web/lib/agent-event-connection.ts`(231)** | **移动**到 `packages/session` 的 browser-only 模块（经 `./browser` 导出） | `completion-delivery.ts:1`、`useAgentSession.ts:60`（改包导入） | §7 规范物理归属 |
| **`packages/session/src/pi-web/agent-event-connection.ts`(205)** | **删除**（被适配过的运行时副本） | 唯一调用者 `browser.ts:1`（改接同一模块） | 三份副本归一 |
| `packages/session/src/browser.ts`(77) | **保留并改接**（诊断 bearer factory + `BrowserDurableSession`） | `apps/server/src/chat.ts`、`apps/server/test/browser-session.test.ts` | §3 方案 1 |
| `apps/web/vendor/pi-web/**`（含 202 行副本） | **不动**（vendor 快照 + LICENSE） | provenance | MIT |
| `lifecycle-projection.ts`(611)、`lifecycle-acquisition.ts`(287)、`lifecycle-store.ts`(55)、`completion-delivery.ts`(404)、`session-view-cache.ts`(147) | **保留**，只换输入 | hook/AppShell | ADR 0007 的 owner |
| `apps/server/src/history-window.ts` | **不动** | 生产者 | 客户端没有 active range |
| `packages/protocol/src/index.ts` | **不动** | 全消费方 | 后端产出的 protocol 不变 |
| **BFF 面向浏览器的 payload 形状**（`durable_state`/`durable_submission`/`durable_resync`/`durable_state_oversize`） | **有意变更**为原生帧名 | 前端 + e2e | 见 §9 末 |
| `apps/web/package.json` | **新增** `"@hepi/session": "workspace:*"`（transport 落在 `@hepi/session/browser`） | — | 今天只有 `@hepi/protocol` |

**净行数变化未测量，不给估算。**

---

## 7. transport 的规范物理归属（三副本归一）

**规范归属：`packages/session` 的 browser-only 模块，经 `"./browser"` 导出。** 纯根 `"./"` **不得引入浏览器依赖**（无 `EventSource`/`window`/DOM）；`packages/*` **不得依赖 `apps/web`**（依赖方向只能 apps → packages）。

三份实测不同（`diff` 非空）：231 行（`apps/web/lib`，`Map<string, Connection>` + `subscribe/ready/reconnect/release`，**语义是规范**）、205 行（`src/pi-web`，单 `current` + `maintain`）、202 行（vendor 快照）。**把 Web 那份已证实的实现搬进 `packages/session` browser-only 模块**，然后：

| 调用点 | 今天 | 处置 |
| --- | --- | --- |
| `apps/web/lib/completion-delivery.ts:1`、`useAgentSession.ts:60` | `apps/web/lib/agent-event-connection.ts` | 改为 `@hepi/session/browser` 导入；旧文件**删除**（移动，不是复制） |
| `packages/session/src/browser.ts:1` | `./pi-web/agent-event-connection.ts` | 改为同包 browser-only 模块导入；`src/pi-web/agent-event-connection.ts` **删除** |
| `apps/web/vendor/pi-web/**` | vendor 快照 | **字节与 LICENSE 保持原样**（provenance），不参与归一 |

**两种 source factory 的分工（同一 transport 的装配差异）**：

```ts
// packages/session/browser 导出
export type ConversationSourceFactory = (conversationId: string) => AgentEventSourceLike;
export function cookieBffSource(basePath = "/api/agent"): ConversationSourceFactory;  // 默认：同源 URL，无认证头
export function bearerSource(origin: string, token: string): ConversationSourceFactory; // 诊断：Authorization: Bearer
```

Web 与诊断页各自装配一个 factory，连接与折叠逻辑同一份。

---

## 8. 未决项（bounded，不自行发明）

1. **`session-view-cache` 的权威范围（修正旧版说法）**：cache **只保存已接受的投影**——它是已发布的窗口/prefix 的序列化，**不是** stream-local reducer 状态的镜像。若最新一帧被 fence（`accepted === false`），cache 必须**保持旧值**：`heldRef` 可以前进，cache 不可以。`heldRef` 是**每条流自己的、未发布的**状态，**从不是全局权威**。旧版说「held 为权威、cache 为它的序列化快照」是错的：二者不是同一份东西的两种表示，而是「已发布」与「流内未发布」两个域。
2. **重连游标 `?after=`（修正旧版的「EventSource 不能设参数」）**：`EventSource` **可以**在构造 URL 里带查询参数——`new EventSource("/api/agent/<id>/events?after=" + revision)` 完全可行；它**不能**设的是**任意请求头**（`Authorization`）。因此 Web 路径的游标**只受 URL 限制，不受自定义头限制**，与 bearer 方案正好相反（那条路要求自定义头，Web 无法提供）。今天的缺口只是 `durable-api.ts` 的 `events()` 没透传 `after`，而后端已支持（`server.ts:1827`，并在不一致时发 `resync_required` L1837）。语义边界：`after` 只能换来「一致地继续」或「`resync_required`」，**不构成 gap 恢复**（见下）。
3. **连续性限制（旧版最严重的错误，此处纠正）**：`GET /state` 重读**只会再给一次最新窗口**，**不能**恢复落在窗口边界之下、prefix 之上的中间历史；`resync` 时改用最新状态**同样不能**补齐这段。因此：
   - **标注为已知连续性限制**，**保留现有行为**（resync → 采用最新快照），等待**单独方案**，不在本轮 consolidation 内发明；
   - **不得**形成反复 resync 的循环：一次 resync → 采用最新快照 → 之后按新基线继续；若新快照仍不可续，那是**新基线**，不是再一次 resync 请求；
   - 若将来要恢复，唯一正确形状是**有界 bridge**：读 `GET /api/conversations/:id/entries?before=<新 oldestEntryId>`（分页路由已存在，`server.ts:1631`，独占 `before` + `tail`），直到 `hasMore` 为假或触达已持有 prefix 的最新 id；每步校验 (a) `historyHead` 未移动、(b) acquisition generation 仍是当前，任一不满足则**丢弃 prefix 并标记 incomplete**，绝不拼接。
4. **dormant 模块**（`agent-event-stream.ts`/`session-liveness.ts`/`exact-system-prompt.ts`）：删除 vs 作为 provenance 保留，需 license/来源判断（`docs/upstream-sources.md`）。建议删可执行副本、保留 `vendor/pi-web` 字节不变，并在 `docs/chat.md` 记录。
5. **`leafId`**：改为显式 `null`（wire 无分支语义），不在本轮修；与 C 是否把 active leaf 纳入 fold 事实无关，因为该事实在 wire 上不存在。
6. **认证与 CSRF**：不变。`hepi-web-token` httpOnly + SameSite=strict，非 GET 校验 `Origin` host === `Host`（`route.ts:12`）。原始转发必须保留两者，且**不得**把 `HEPI_AUTH_TOKEN` 或后端 URL 暴露给浏览器。

---

## 9. 公开 Seam 验证

关键行为：

1. 一帧 `ServerDelta` 经浏览器侧 `reduceSseFrame` 折出的窗口，与同一 revision 的 `GET /api/conversations/:id/state` 读**逐字段相等**（含 `projectionId`/`revision`/`historyRevision`/`historyHead`/`oldestEntryId`/`hasMore`/`run`/`submissions`/`settings`/`extensions`/`queuedMessages`）。这是删除 `foldFrame` 的判据。
2. **`resyncRequired` 只在线本身的连续性错误上出现**：delta 的 `baseRevision` ≠ held、delta 的 `revision` ≤ held、delta 的 boundary 无法在 held + appended 中定位、legacy events frame 的 revision 跳号。完整 snapshot 不是上述 delta 连续性判据的对象；等 revision snapshot 重述仍按 C 保持。它**不是**通用 gap 恢复机制：**不承诺**补齐窗口之下、prefix 之上的中间历史（那是 §8-3 的已知连续性限制，保留现有行为）；响应是**采用最新快照**并继续，**不得**形成反复 resync 循环。此时流内 `heldRef` 不提交任何已接受态。
3. `submission` 帧仍能结算（ADR 0006）：`done` 带 `answerId` 只响一次；`unanswered` 显示 reason 不响。
4. 重连后 `open` → `recover` 按 requestId 查询，**从不重发**。
5. 每会话**一条** source；预算仍是 3（无终端）/2（有终端）；被延迟的 watch 保留 projection。
6. `state_oversize` 具名拒绝可见、不结算。
7. prefix 迁移（`ux-history-prefix.mjs` 三条断言）与重连不丢页。
8. **接受边界**：一个被 fence 的帧可以让 stream-local `heldRef` 前进，但 `setData`/prefix/**cache** 的值必须与接受前逐字段相同。

复用既有测试：

| 测试 | 层 | 处置 |
| --- | --- | --- |
| `packages/session/test/{delta,loaded-prefix,session,window}.test.ts`（4 文件） | 共享 fold | **C 修改**（类型放宽与用例同步演进；不假定字节不变） |
| `apps/web/adapters/durable-lifecycle.test.mjs`（119 行） | 适配器发布字节 | **重指向**到浏览器侧投影输出 |
| `apps/web/hooks/useAgentSession.lifecycle.test.mjs`（326 行） | hook + 假 fetch/EventSource | 复用；事件名 `durable_state` → `frame` |
| `apps/web/adapters/durable-api.test.mjs`（142）、`lib/completion-delivery.test.mjs`（117）、`lib/agent-event-connection.test.mjs`、`lib/history-prefix.test.mjs` | 路由/预算/连接/prefix | 复用；后两者随归属迁移改导入路径 |
| `apps/server/test/session-reducer.test.ts`（326）、`apps/server/test/browser-session.test.ts` | 真实后端字节 | 复用（`browser-session` 随 transport 改接更新） |
| `apps/web/e2e/{chat-lifecycle-foreground,chat-lifecycle-background,submit-stall,stream-heartbeat-idle,ux-history-prefix}.mjs` | **浏览器 Seam，load-bearing** | 必须重跑；前三者直接断言帧名，切换后需同步 |

Web suite 基线 111 tests / 64 files（`docs/verification.md:9`）；现在不新增测试。

**变更范围与回滚（修正旧版「零 wire 变更」）**：**后端产出的 protocol 不变**——同一 URL、同一 hepi.v1 语义、`packages/protocol` 不动。**变更的是 BFF 面向浏览器的 payload 形状**（`durable_*` → 原生帧名），这是有意的。因此不能说整个 B 是零 wire 变更，准确说法是「后端协议不变，浏览器侧形状有意改变」。回滚：后端镜像不动，前端 Next 构建回滚即可；**但若 transport 落在 `packages/session/browser` 且 `apps/server/src/chat.ts` 诊断页也消费它，则后端镜像需在 workstation/CI 按 `linux/arm64` 重新构建**（**不得在 remote-host 编译**）。

**完成判据**：(a) `foldFrame` 不存在，窗口 fold 只有 `reduceSseFrame`，prefix 规则只有一份且归 C 的最终归属；(b) §9-1 在浏览器侧成立且被断言；(c) 21 个 legacy case 与 12 条 501 命令入口被删除或显式说明；(d) §9-8 成立；(e) `ux-history-prefix.mjs` 与三个 lifecycle 驱动通过；(f) 生产者 `history-window`/`frame-size` 测试未改而通过；(g) transport 物理副本只剩一份（+`vendor` 快照），纯根无浏览器依赖，`packages/*` 不依赖 `apps/web`；(h) 每会话仍是一条连接，预算仍为 3/2。

---

## 10. 顺序与目标（结语）

**顺序**：1) C 在 `packages/session` 纯根放宽 `SessionState` 类型（保留原生 entries/metadata）+ 迁入/删除 prefix 规则，更新其测试。2) 把 `apps/web/lib/agent-event-connection.ts` 移入 `packages/session` browser-only 模块（`./browser` 导出），定义 cookie/bearer 两个 source factory；改接 `apps/web` 与 `browser.ts` 两个消费点，删除两份副本。3) 浏览器侧落地 `projectSession`（移动而非重写）+ `ConversationStreamEvent`；hook 改接 `frame`，接受边界按 §4.3。4) `/api/agent/:id/events` 改字节透传，删除 `foldFrame` 与 `events()` fold 段。5) §5 的 HTTP 原生快照 cutover（同步改 5 处调用者）或明确保留薄适配器。6) 删除 21 个 legacy case、`delta` 分支、501 命令入口（先隐藏/说明 UI）。7) 跑 §9 的浏览器驱动（需先 `pnpm --filter @hepi/web build`）。

**目标（一句话）**：durable runtime 已是唯一权威，但它与浏览器之间隔着一层把增量展开成整窗、把 legacy 事件名映射到无生产者分支的 BFF，并且 transport 有三份物理副本、窗口/prefix 规则有两份归属。目标状态是：**一份纯 fold**（`packages/session` 纯根，C 修改类型与测试后仍是唯一 owner；纯根无浏览器依赖）、**一份物理 transport**（`packages/session` browser-only 模块，经 `./browser` 导出；Web 用 cookie BFF factory、诊断页用 bearer factory；两个消费点同源，`packages/*` 不依赖 `apps/web`）、**一份浏览器侧显式 UI 投影**（`projectSession`，完整保留原生 metadata；不引入第二条 id→payload 缓存）、**BFF 只剩认证 + 字节转发**（后端协议不变，浏览器侧形状有意改变）。`BrowserDurableSession` 仍不作为浏览器的整体替换，但会作为消费者改接到同一 transport；它被拒的理由是缺 cookie 准入、submission 结算与尺寸拒绝这三项义务，而不是「bearer 配置本身不安全」。
