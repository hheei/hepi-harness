# 08: 原生 SSE 端到端接入并移除 BFF 整窗折叠

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** Backend 的原生 delta 通过认证 BFF 到达浏览器，前后台会话继续正确呈现与结算，BFF 不再每帧展开和序列化整窗。

**Blocked by:** 06, 07

**Status:** resolved (R7 fixed at `5887484` and R8 fixed at `ee2ee20`, both confirmed on **both** review axes — 72 standards and 73 spec follow-up, zero remaining material findings; R8 closed the ticket on 2026-10-15. R7 merged with the 09 core at `e1ba256`: the shared join transfers the stream's continuity, both directions are covered by public regressions and by a real-browser scene. The 09 core merge is in; 09's own remaining producerless branches and 501 entries stay with 09)

## Acceptance criteria

- [x] 会话 SSE 转发原生事件、载荷和心跳；取消/断开正确释放上游，BFF 不解析 delta 成整窗或逐 entry UI 投影。
- [x] 浏览器在共享连接上折帧并复用 07 的 UI 投影；流内 held 与全局已接受态隔离，被拒帧不改窗口、prefix、beside state 或 cache。
- [x] submission 结算、一次通知、无成功的失败/中止、state_oversize、requestId 查询恢复均按既有 ADR；没有自动重发。
- [x] 前后台订阅仍共享每会话 source，连接预算、兴趣 handover 与诊断页保持；原生 HTTP/SSE 在同一 projection/revision 给出同义结果。
- [x] 实际浏览器链路中 delta 保持增量形状，原 foldFrame 及已无消费者的服务端 UI 映射删除；Web 载荷切换和已有页面刷新说明明确。

## Verification seam

复用真实前台/后台生命周期、提交停滞、空闲心跳、历史 prefix、窗口滚动驱动；观察 BFF 输出的真实帧并验证拒帧缓存不变。

## Integration notes

Blocked by 06 的共享连接和 07 的原生读取/投影；05 经 07 传递依赖。Backend hepi.v1 和生产者 frameFor 不改；未知中间历史恢复不在本票。最终旧合同清理由 09 承接。

### 2026-10-15 — native SSE cutover (work/architecture-consolidation-08)

**Owners.** The conversation stream has one physical reader, `packages/session/src/browser.ts`'s `StreamSource`,
shared by the Web page's `cookieBffSource` (same-origin URL, the httpOnly cookie is the credential, no header stated)
and the diagnostic page's `bearerSource`. It speaks the backend's own names through a typed
`ConversationStreamEvent`: `connected` (the handshake, stated when the baseline arrives), `frame` (`snapshot`/`state`
with the native `ServerFrame`), `submission`, `resync`, `oversize`. `fetch` rather than `EventSource` because the
backend names its frames — `onmessage` fires only for unnamed ones — and because the diagnostic page must set
`Authorization`. Keepalive comment frames are dropped by the reader; the connection above owns reconnection.

**BFF.** `apps/web/adapters/durable-api.ts`'s `events()` now authenticates and forwards bytes: it passes the caller's
`?after=` cursor, opens upstream with `signal: request.signal`, and returns the upstream body with the event-stream
headers. `foldFrame`, the per-frame `normalizeStreamingToolCalls` call and the `durable_*` event names are deleted.
A cancelled browser request aborts the upstream request.

**Browser fold.** The hook keeps one stream-local `SessionState` per attachment, folded with the shared
`reduceSseFrame` (a `baseRevision` it does not hold, or a boundary it cannot trim by, sets `resyncRequired` and is
answered by asking about the outstanding turns — never by inventing a window). That state is projected by the **one**
owner, `apps/web/lib/durable-projection.ts`: `projectSession` (transcript) and the new `projectLive` (busy, partial,
live message, live tools, queue, resources, extensions). Global window/prefix/leaf/failure/cache are published **only**
through `receive()` → `receiveAccepted`; a frame the fold refuses may advance the stream-local state but changes no
global fact. `CompletionDelivery`'s background watches fold the same frames the same way. The Web host no longer maps
the wire anywhere.

**Verification** (built Next production app, real backend + SQLite, real gateway, isolated ports; logs in
`/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-08/`):

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/test-web-unit.mjs` | 0 | 58 files / 114 tests, all pass |
| `node --test packages/session/test/*.test.ts` | 0 | 31 pass |
| `pnpm --filter @hepi/web build` | 0 | built |
| `tsc --noEmit` (web, session, server) | 0 | no errors |
| `node apps/web/e2e/chat-lifecycle-foreground.mjs` | 0 | 28/28 |
| `node apps/web/e2e/chat-lifecycle-background.mjs` | 0 | 57/57 |
| `node apps/web/e2e/submit-stall.mjs` | 0 | 55/55 |
| `node apps/web/e2e/stream-heartbeat-idle.mjs` | 0 | 23/23 |
| `node apps/web/e2e/ux-history-prefix.mjs` | 0 | 11/11 |
| `node apps/web/e2e/ux-submission-recovery.mjs` | 0 | 47/47 |
| `node apps/web/e2e/ux-deferred-text.mjs` | 0 | 17/17 |
| `node apps/web/e2e/ux-windowed-transcript.mjs` | 0 | passed twice consecutively (its "reaching the top asked for a page" sentinel race is the fixture's own known flake: 5 failures in 60 historical runs) |

**Fixes the drivers found, not inspection:** the stream recorders now pass each response through a reader they own (a
clone gave two independent readers, so the tone/fact ordering measured two clocks); the transcript window renderer no
longer indexes past the transcript it holds (a reload re-baselining onto committed entries can shrink it while the
previous render's range still names a turn of the longer one); `stream-heartbeat-idle` counts a source as the request
that answered `text/event-stream` and reports a torn-down hop to the reader it was torn from.

**Not in this ticket:** the backend producer, `frameFor`, `history-window` and the DB are untouched; no unseen-gap
bridging; the lease POST is still the 501 no-op it was; the remaining legacy Web contract cleanup belongs to 09.

### P1（review 72，复现于 `44ecc99`）— 共享 source 的交接连续性，本票重开

**分类：架构/接口缺陷，不是 driver 或调用方缺陷。** 一个物理 source 在两种方向的交接上都不保留原生连续性：

1. **late join**：共享 source 只转移 `lifecycleStep`，后来者拿不到原生 baseline，于是前台接受一个空窗口的
   `revision 0` 并把**已可见的 transcript 清空**。
2. **反向**：空闲的 terminal delta 让 watch 保持 busy 并占住连接预算。

修复责任与范围（agent 74）：共享 join 保留/重放连续性，或改为原子交接；补公开单测与**两个方向**的浏览器回归。

**已记录的合并属性与此缺陷分开陈述，两者都成立：**

- **一个物理 source**：会话流只有一个物理读者（`packages/session/src/browser.ts` 的 `StreamSource`），Web 页的
  `cookieBffSource` 与诊断页的 `bearerSource` 共用它——这是本票已合入并验证的属性。
- **全局接受门**：窗口/prefix/leaf/failure/cache 只经 `receive()` → `receiveAccepted` 发布，被拒帧只推进
  stream-local 状态——前台/后台/AppShell 的接受门同上。

P1 不推翻这两条；它指出**交接那一刻**的 join 语义没有保住它们（空 rev0 接受既清了可见 transcript，也把一次
非原生基线的空窗口当成了接受态）。因此本票不因既有 driver 全绿而关闭。

**合并与验证范围**：核心切换已合入 `44ecc99`（ff 自 `839715f`，primary tree 与该 revision 逐字节相同），
让 09 的最终阶段可以继续；R7 的修复（`5887484`，ff 合入 `82c481f`）已经两轴确认。

### R8（review 73 spec follow-up，pin `82c481f`）— cache handover 覆盖已接受的交接事实

**分类（协调者在实现前细化）：普通的 hook 初始化顺序逻辑错误**，不是新的共享接口缺陷——R7 的 shared source 接口
已经正确，不需要新的协议/运行时抽象。

新 hook 的同步 `openEvents` 采纳先发生，旧的 mount cache 恢复后发生：`openEvents`（约 `1251`）立即接受转移来的
h2 窗口，随后 cache 恢复（约 `2621`）把缓存的 h1 prefix 与 `historyHeadRef` 回退，初始 prefix 效果不做对账；于是
bootstrap HTTP 被挂起时渲染出 **h1 prefix `[e1,e2]` + h2 窗口 `[e8,e9]` = `[e1,e2,e8,e9]`**（loading false），
HTTP 稍后才修好。普通路径：长会话回翻 → 离开 → 后台 context 重置 → 返回。

违反规范 #10/#11。修复所有者与范围（agent 74）：在权威采纳**之前**一致地恢复/对账 cache，或复用既有
accepted-head/prefix 接缝；保留**同 head 的**有效已加载 prefix 与已接受窗口/beside/cache；不做无差别丢弃 cache，
也不引入平行时钟。

红→绿（review 73 独立验证，实际 hook + 真实 `CompletionDelivery`/`AgentEventConnection` + 合成原生帧、单一物理
source）：`cache-handover-repro.sh` 的 no-mixed-head 断言在 `55ccccc` 基线 **PASS exit 0**，在 `82c481f`
**FAIL exit 1**；证据在 `.dev/verify/consolidation-review-08/`（`r7-spec-followup-r8.md`、
`cache-handover-baseline-55ccccc.log`、`cache-handover-tip-82c481f.log`）。**修复已落地 `ee2ee20`（普通初始化顺序修复：记忆视图改为挂载初始状态、cache 记录窗口自身的 head、`decidePrefix` 不变），并经 72 standards 与 73 spec follow-up 两轴确认（各 0 剩余实质发现，73 另跑 changed-head / same-head 实际 hook 探针两次 exit 0）。本票关闭。**


### 2026-10-15 (later) — review R7: the shared stream hands its continuity to the reader that joins it

**What was wrong.** A conversation has one physical source however many readers join it, and the reader that joined
second was handed nothing but the lifecycle step. Its own stream continuity was an empty state bound to no
conversation, so the shared reducer answered its next delta with an **unchanged** state — indistinguishable from a
frame that said nothing — and the surface projected the state it held and published an empty window over the transcript
it was already showing. In the other direction a background watch inheriting a running conversation could never fold the
terminal frame that would free its slot, so it held the source and the budget. Both were ordinary user paths: selecting
a conversation the poll was already watching, and leaving one mid-run.

**The fix, at the shared subscription — the one place that owns "one source per conversation".**
`AgentEventConnection` folds the window frames it delivers with the same `reduceSseFrame` the readers use, keeps that
as the stream's own continuity, and transfers it at the join through `AgentEventSubscription.continuity()`. A frame the
stream cannot continue leaves the continuity unstated, so a joiner is answered the way a revision gap is rather than
with a window that is not the stream's. `CompletionDelivery.admit` adopts the transferred state into the watch's own
continuity and folds it; `useAgentSession.openEvents` binds its stream-local state to the conversation it shows,
adopts the transfer and publishes it at once through the one projection and the one acceptance gate. `reduceSseFrame`
now fails closed on a native frame addressed to another conversation, or to a state that was never bound to one.
`emptyStreamState` is stated once in `packages/session`. One physical source, one projector, the page head guard and
the draft budget are unchanged; nothing global is decided at the join.

**Verification** (revision `e1ba256`, clean, with the 09 core merge in place; logs
`/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-08/handover/`):

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/test-web-unit.mjs` | 0 | 57 files / 113 tests, all pass |
| `node --test packages/session/test/*.test.ts` | 0 | 34 pass |
| `tsc --noEmit` (web, session, server) | 0 | no errors |
| `pnpm --filter @hepi/web build` | 0 | built |
| `node apps/web/e2e/chat-lifecycle-background.mjs` | 0 | 69/69, twice consecutively |
| `node apps/web/e2e/chat-lifecycle-foreground.mjs` | 0 | 28/28 |
| `node apps/web/e2e/stream-heartbeat-idle.mjs` | 0 | 23/23 |

**Red → green.** The three package cases and the public handover regression were run against the pinned pre-fix
checkout `44ecc99` and fail there (the session cases on their own assertions, the Web file at import because the
transfer does not exist). Scene 7 of the background driver was run twice against the production build that predated the
fix — no rebuild had been made — and failed exactly as reported: the transcript was empty after the run's advance
(`prefix-witness.json`); after rebuilding it passes twice. The earlier ticket 08 browser evidence is therefore **not**
reused for this fix.

**Not in this ticket.** The backend producer, `frameFor`, the DB and the page head guard are untouched; ticket 09's
remaining producerless branches and 501 entries stay with 09.


### 2026-10-15 (later still) — R8: the remembered view is adopted at mount, not written over accepted facts

**What was wrong.** The mount adopted the page's remembered view of the conversation in an effect that runs *after* the
mount's stream subscription. Since R7 the shared stream hands its continuity to the joining reader synchronously, so
the stream's window was accepted first and the remembered view was then published over it: the previous visit's prefix
— paged under the older head `h1` — was restored in front of the accepted `h2` window, so the transcript carried two
heads at once, and `historyHeadRef` was rewound to `h1` so the next page read would be stamped with a head the
conversation had left. The beside facts (leaf, pagination state, model, reasoning level) were overwritten the same way.
The held read repaired it, which is why it was only visible while a read was in flight.

**Classification.** An ordinary hook **initialization-order** logic error at the cache restoration/adoption owner. The
R7 shared-continuity interface is correct and is untouched here.

**The fix.** The remembered view is adopted as the mount's **initial** state — `data`, the `history` prefix,
`historyHeadRef`, `hasEarlierMessages`, `activeLeafId` — instead of being written by an effect after statements may
already have been accepted. Nothing writes it afterwards, so a statement the fold accepted cannot be overwritten by it;
the fold's own ordering is the only thing that decides. The window's own head marker became part of the cache record
(`SessionViewSnapshot.historyHead`) because the adopted payload states the head it was stated under exactly as a read's
payload does. The prefix is still governed by the one `decidePrefix` rule: a window that moves the head drops it, a
window that keeps the head keeps and migrates it. No second clock, no registry, no blanket prefix drop, no new protocol
or transport surface.

**Verification** (logs `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-08/cache-handover/`):

| Command | Exit | Result |
| --- | --- | --- |
| `bash spec73-probe.sh` (reviewer's actual-hook repro) | 0 | `before-http` `["e8","e9"]`, 1 physical source, head `h2`, rev 8; on `82c481f` it reported `["e1","e2","e8","e9"]` and exited 1 |
| `node --test apps/web/hooks/useAgentSession.lifecycle.test.mjs` | 0 | 12/12; on the pre-fix hook 10 pass / 2 fail (`hook-lifecycle-red.log`) |
| `node scripts/test-web-unit.mjs` | 0 | 57 files / 115 tests, all pass |
| `tsc --noEmit` (`apps/web`) | 0 | no errors |
| `pnpm --filter @hepi/web build` | 0 | built |
| `node apps/web/e2e/ux-windowed-transcript.mjs` | 0 | 48/48 (window and paging owner) |
| `node apps/web/e2e/ux-history-prefix.mjs` | 0 | 11/11 (prefix owner) |

The two new regressions are public hook tests over the real `CompletionDelivery` and `AgentEventConnection`: the
changed-head case asserts the accepted window is the transcript with its own beside facts and no restored pages, and the
same-head case asserts the remembered window and its paged prefix come back and are kept — and migrated — when the
window advances. Both fail on the pre-fix hook.

**Not in this ticket.** 09's remaining producerless branches and 501 entries were 09's own delta and are retired there (09 resolved). The projection store (`lib/lifecycle-store.ts`), the fold and the transports are untouched;

