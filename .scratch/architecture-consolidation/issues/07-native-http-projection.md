# 07: 迁移原生会话读取与浏览器 UI 投影

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** Web 的会话、状态、上下文及扩展设置读取消费原生 Backend 载荷，由浏览器的一份投影生成现有可用 UI。

**Blocked by:** 05

**Status:** resolved (implementation complete; 08's byte-passthrough reruns covered the held-read checks)

## Acceptance criteria

- [x] 五类既有读取及全部已知 hook/扩展设置/get_state 消费者同步迁移，HTTP 不再依赖旧服务端 UI 合成字段。
- [x] Web 显式投影保留原生 payload 与 lifecycle metadata，并与当前 SSE 的已接受语义一致；支持的模型/thinking/扩展/分页操作保持可用。
- [x] HTTP 结果经现有 acquisition/lifecycle 接受后才发布窗口、prefix、beside state 和 cache；旧响应与跨 identity 竞争不回退已接受态。
- [x] HTTP 投影只有一份浏览器所有者；SSE 暂用的旧 BFF 投影保留至 08，删除责任清楚，不伪称本票已删所有服务端映射。
- [x] 验证和聊天说明更新，覆盖原生读取与生产 Backend 的同义性，而非只修改静态源码断言。

## Verification seam

复用实际路由读取、hook lifecycle、旧帧竞争、模型/扩展设置与历史分页检查；增加必要的原生 HTTP 投影断言。

## Integration notes

Blocked by 05：读取方使用其原生保真状态与统一 prefix。06 的连接抽取不阻塞 HTTP 切片；本票向 08 提供共享 UI 投影。

## Comments

### 2026-10-15 — implementation (work/architecture-consolidation-07)

**新所有者**：`apps/web/lib/durable-projection.ts` —— 浏览器唯一的 UI 投影。`projectSession`（原生
`ServerSnapshot` → 复制应用的 `SessionData`）、`projectAgentState`（composer/Running 读的 state 字段）、
`projectContext`（`/entries` 页）、`projectMessages`。原 `durable-api.ts` 的 `sessionData`/`state`/`context`/
`uiMessage` 删除。

**五类读取全部改为原生转发**（`apps/web/adapters/durable-api.ts`）：

| 路由 | 之前 | 现在 |
| --- | --- | --- |
| `GET /api/sessions/:id` | `sessionData()` 合成 | 原生 `ServerSnapshot`，整体转发 |
| `GET /api/sessions/:id/state` | `state()` 合成 | 原生 `ServerSnapshot` |
| `GET /api/agent/:id` | `state()` 合成 | 原生 `ServerSnapshot` |
| `get_state` 命令 | `state().state` | 原生 `ServerSnapshot` |
| `GET /api/sessions/:id/context` | `{context:{…}}` 重建 + 额外 `/state` 读 | 后端 `/entries` 原生页（去掉多余 settings 读） |

适配器不再导入 `normalize`、不再合成 `leafId`/`filePath`/`totalActiveMs`/`tree`/`snapshotRevision`。消费方迁移：
`useAgentSession.ts`（`loadSession`/`loadContext`/`applyAgentState`/`waitForBashSettlement`/`refreshContextUsage`/
`loadSystemInfo`/`auto-compact`/`set_tools` 后的 get_state）经 `projectSession`/`projectAgentState`/`projectContext`；
`ExtensionsConfig.tsx` 读原生 `snapshot.extensions`，无需改动即正确。

**接受边界不变**：HTTP 读仍走 `receive(httpStatement(...))`，只有 `accepted` 才发布窗口、prefix、leaf、failure、
queue 与会话视图缓存；跨 identity/旧 revision 的竞争由既有 fold 处理，本票未新增第二道比较。composer 的 model/
thinking/queue 继续由被 fence 的 agent-state 单一写入器发布。

**SSE 中间态**：`/api/agent/:id/events` 仍输出旧 `durable_state` 形状（含 `foldFrame`），但已改为**复用浏览器的
`projectSession`**，不再有第二份映射。**08 删除责任**：`durable-api.ts` 的 `foldFrame`、`events()` 的 fold 段与
`durable_state`/`durable_submission`/`durable_resync`/`durable_state_oversize` 事件名，以及 `events()` 里
`normalizeStreamingToolCalls` 的调用；浏览器改为折原生帧后，本票的 `projectSession` 继续为唯一 UI 投影所有者。

**08 需要的 API**：
```ts
// apps/web/lib/durable-projection.ts
type NativeSnapshot = ServerSnapshot<AgentMessage>;
projectSession(snapshot: NativeSnapshot): SessionData          // 完整 lifecycle payload
projectAgentState(snapshot: NativeSnapshot): AgentStateView    // composer 字段 + extensions
projectContext(page: NativeEntryPage): ContextPage             // 原生 /entries 页
projectMessages(entries: readonly ServerEntry<AgentMessage>[]): AgentMessage[]
// SessionData 原从 useAgentSession 导出，现在归 durable-projection 并 re-export
// useAgentSession: agentStateOf(snapshot) 为内部投影；`/api/sessions/:id` 不再带 query
```

**多 exec/图片等无关基线**：`ux-image-submit` 的失败不在本票路径上（该 driver 只驱动 composer→provider，不读会话
投影）；由 70 在固定 revision 上另行比较。本票未运行也未声称其通过。

### 验证（命令、退出码、原始日志）

均在主工作区 `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-07/`。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `pnpm install --offline --frozen-lockfile` | 0 | `pnpm-install-postmerge.log` |
| `node scripts/verify.mjs --profile=full --log-dir=…/final` @ `3f56be6`（clean，含最新 integration tip） | 0（3/3 PASS：workspace-typecheck、workspace-tests、web-unit **63 files/117 tests/117 pass/0 fail**） | `final/{verify.json,web-unit.log,workspace-tests.log}` |
| `node scripts/verify.mjs --profile=full --log-dir=…/verify-full-merged` @ `855b5a5`（clean） | 0（3/3 PASS；web-unit 63 files/116 tests） | `verify-full-merged/` |
| `pnpm --filter @hepi/web build` | 0 | `web-build-postmerge.log` |
| `node apps/web/e2e/ux-history-prefix.mjs`（真实 Next 生产构建 + 真实后端 + SQLite + 真实 gateway） | 0（11/11 ok） | `e2e-history-prefix-final.log`、`e2e-history-prefix-postmerge.log` |
| `node --test apps/web/hooks/useAgentSession.lifecycle.test.mjs`（合入后补丁，page-acquisition 竞态） | 0（9/9 pass） | `history-page-race/{red-final.log,green.log}` |
| `pnpm --filter @hepi/web typecheck`；`node scripts/test-web-unit.mjs`（补丁后） | 0；0（63 files/118 tests/118 pass/0 fail） | `history-page-race/{typecheck.log,web-unit.stdout}` |
| `node apps/web/e2e/ux-extensions-selection.mjs`（真实后端 + 重启 + 会话级 override） | 0（17 ok，PASS） | `e2e-extensions-selection-postmerge.log` |
| `node apps/web/e2e/ux-deferred-text.mjs` | 0（17 ok） | `e2e-ux-deferred-text.log` |
| `node apps/web/e2e/ux-missing-model-recovery.mjs` | 0 | `e2e-ux-missing-model-recovery.log` |
| `node apps/web/e2e/ux-truthfulness.mjs` | 0（PASS） | `e2e-ux-truthfulness.log` |
| `node --test apps/web/lib/durable-projection.test.mjs` | 0（4 pass） | 见 web-unit 日志 |

### 2026-10-15 — 追加缺陷（page acquisition 缺 accepted context）

**分类：接口缺陷，不是调用方缺陷。** `loadContext` 是分页的**所有者**，但它的完成只带了 mount/session/abort 守卫，
没有它自身发起时所在的 **accepted context**。`historyHead` 在 hook 里已是接受的 head（`receive` 里唯一发布点），
所以分页回答落地时没有任何东西能区分"同 head 推进"与"compaction/reset 重基线"，于是把旧上下文的一页前置到新窗口，
并用旧页的 `hasMore` 覆盖已接受窗口的分页事实，再把**当前** head 记到那些旧 entry 上（`decidePrefix` 之后再也
认不出这次重基线）。规范 #10（只在接受通过后发布窗口/prefix/beside/cache）与 #11（head 改变或完整替换使 prefix
失效）被违反。`ChatWindow` 的 scroll sentinel 没有取消信号，所以它不是调用方能自行规避的竞态。

**最小一致修复（分页所有者处，无调用方改动、无第二时钟、无全局注册表）**：
`loadContext` 在发起时捕获接受的 `historyHeadRef.current`，回答落地时若该值已改变则**不发布任何东西**并返回
`undefined`（调用方据"未建立页"停止分页）；写入 prefix 时用**捕获的** head 而不是当时的当前 head。同 head 追加、
等 revision 重述与正常回翻行为不变（`decidePrefix` 仍是唯一规则）。

**复现与证据**：`apps/web/hooks/useAgentSession.lifecycle.test.mjs` 新用例"a page loaded under an older head
states nothing once the accepted context re-baselines"——真实 hook：发起旧页 → 流接受 h2 的新窗口（重基线）→ 释放旧页；
断言旧 entries/分页/缓存不被发布。**修复前红**（`red-final.log`：`["e1","e2","c9","e4","e5"]` 与
`hasEarlierMessages=false`），**修复后绿**（`green.log` 9/9）。head 变更用的是真实后端在 compaction 时发布的
wire 事实（`apps/server/test/history-window.test.ts` "a page never crosses a head marker"），**不声称**跑过真实
live compaction。

**待 08 的检查——已于 08 的字节透传切换后复跑并全部通过（本票据此收尾）**：
`chat-lifecycle-foreground` scene2（held conversation read）在 `.dev/verify/consolidation-08/e2e-chat-lifecycle-foreground.log`
（28/28，含 "the held conversation read does not hold the surface on Loading" 与 "the transcript arrived from the
stream's projection while the read was held"）；`ux-submission-recovery` 的 held-read 场景在该目录的
`e2e-submission-recovery.log`（47/47，含 recall/admitted 两组 "the run is in flight and the model answer is held"）。
两者的读 holding pattern 正是本票改为无 query 的 `/api/sessions/<id>`。`chat-lifecycle-background`（57/57）、
`submit-stall`（55/55）、`stream-heartbeat-idle`（23/23）同属该载荷切换回归集，也已通过。

**与 08 的 P1 缺陷无关**：本票收尾不依赖 08 的共享 source handover 连续性；P1 是 08 自己的 join/交接缺陷（见 08 票
与 review notes R7），本票的 HTTP 读取与 UI 投影所有者不受其影响。
