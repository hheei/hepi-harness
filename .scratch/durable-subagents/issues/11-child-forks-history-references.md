# 11: 打开原始历史、引用并创建独立子分支

**What to build:** 用户在 Web 查看 compact 前原始历史和会话引用，从 child 指定 entry fork 新分支；原父已隐藏时，新分支仍保持正确身份和可读继承内容。

**Blocked by:** [06 — 创建可恢复的独立子执行](06-durable-child-execution.md)

**Status:** accepted — merged `649bce4` on integration/durable-subagents. Web units 96/96; ux-child-raw-history-fork 40/40 after production build. Server 409/409 was on the pre-merge 11 tip that already contained accepted 07 and 10.

**Labels:** ready-for-agent

**Spec:** [D03](../spec.md#d03)、[D13](../spec.md#d13)、[D14](../spec.md#d14)、[D15](../spec.md#d15)；[验收 A02、A16、A17、A18、A22](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 原始历史/compact-reset标记和会话fork来源作为同一查询模型的视图，使用04raw-history/readblocks；不伪装任意entry-parent编辑树。
- [x] 用户从child历史entry fork时创建独立background anchor、显式nativeowner、新provenance和稳定请求身份，保留展示parent/forksource，不使用ownerless默认。
- [x] 新分支独立dispatch、Inbox/control initial；不复制源任务、队列或stop状态，不复用源anchor。用户fork按来源位置配置快照和明确用户覆盖。
- [x] anchor归于正确源child conversation-owned background范围，展示父tombstone不阻止合法分支；父隐藏不级联、不把child提升主会话。
- [x] compact前正文/图片/tool-result附件、fork共享前缀通过目标conversation+entry正确读取；membership拒绝无关entry。
- [x] Web支持来源树/fork-at导航、结构化会话或entry引用的选择与打开；引用不自动注入全文、不改展示parent或执行绑定。
- [x] fork创建答复丢失/真实SIGKILL后同request重取同一分支；既有界面有界历史/滚动定位和延迟图片行为不回归。

Parent acceptance: integration `649bce4`. Two Web P2s closed in `e2bf7c0` (one requestId per fork attempt; compacted reference opens raw read on that entry). Browser driver 40/40 after `pnpm --filter @hepi/web build`; web units 96/96.

## Verification seam

- 生产浏览器child多轮→compact→打开前记录/附件→fork→父隐藏→打开原child与分支/引用；检查native关系及原始内容。
- 真实SQLite fork提交至receipt间SIGKILL；断言独立任务/初始队列/控制，而非仅检查树形DOM。

## Scope and handoff

需要06的真实child与anchor，不能仅凭03关系metadata交付；不依赖10的配置驱动spawn fork，二者场景不同。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Read-only preparation (agent-97, source5574a49)

Navigation only;06 still owns the child/anchor implementation. Scout reported clean integration, no edits/install/build/graph update; queried integration AST graph10219nodes/19602edges and confirmed source/native1.3.0 public declarations. These findings do not establish product behavior or restart correctness.

- Backend fork seam: `apps/server/src/server.ts` POSTfork currently refuses task-owned sources, then uses ownerless Conversation.fork + attach. Route entry membership currently uses context(at). Reuse the06 creation/anchor port once delivered; preserve existing ordinary fork behavior while adding stable child-fork request identity. `conversation-operations.ts` owns relations/references and creation; collect table reads before task/fork writes.
- Native Tx.forkConversation(parent,at,{ownership}) and Conversation.fork(at,{ownership,agent?,init?},ctx) are public. Native agent doc forks asOf; WorkspaceDoc forks current; relations/references fork initial. Child user fork takes source-position configuration plus explicit user overrides. Verify independent initial live/inbox/control and fresh anchor; creation must remain valid when display parent is tombstoned.
- Web `adapters/durable-api.ts` currently forwards fork and deferred entry blocks but lacks raw read/references/ConversationInfo forwarding. Catalogue mapping omits explicit displayParentId/displayParentDeleted/createdBy/references/config.11 adds needed projections without conflating native fork source and display parent. Parent-hidden catalogue currently drops parentConversationId but retains display parent facts.
- Discover old entries/blocks through04 raw read and details.entries inventory. Coordinator correction to scout: raw read is not the only pre-compaction retrieval surface. `server.ts` visibleEntry uses fork-aware conversation.entries exact-id membership; existing entries/:id and thinking/text/tool-result-image routes already use it, serving known old/inherited records. Reuse existing deferred image/text behavior after raw discovery.04 read owner stays unchanged absent a demonstrated gap.
- UI entrypoints: ChatWindow→useAgentSession.handleFork→MessageView.onFork; AppShell.handleSelectSession(entryId,blockIndex) and searchTarget provide navigation; sidebar family helpers and catalogue projection must preserve hidden-parent identity. Confirm current06 projection before choosing new components.

Verification after06: realSQLite childfork atentry with distinctanchor+initialcontrol/emptyqueue, stable request replay and SIGKILL after commit; membership including inherited precompact text/image/tool-result; tombstoned display parent retains child placement and legal fork; references idempotent without target changes. Production browser child→compact→rawhistory/attachment→fork→hideparent→openchild/branch/reference; targeted existing transcript/deferred/historyprefix/fork journeys cover regressions. Tests must establish native ownership and bytes, not only tree DOM.

Parallel ownership proposal after06:11 owns user-fork route/core fork primitive and Web raw-history/reference/family seams;10 owns configured spawn context preparation;07 owns reporter delivery. Coordinate shared conversation-operations.ts edits against06 before implementation.


## Delivered (agent-97, branch `impl/durable-subagents-11`, base `b74f379`)

Every acceptance criterion is met at a public seam over real SQLite, and the two verification-seam journeys are real processes
rather than DOM-only checks. Commits, oldest first:

| Commit | What it delivers |
| --- | --- |
| `7504f53` | `ConversationSpawnRequest.source` — the one creation seam's host-resolved fork position. Confirms the entry through the same fork-aware bounded read every by-id lookup uses (a `tx.scanEntries` exact-id range **before** any write), then takes the native fork, so history, the `asOf` agent snapshot and the inherited documents follow the runtime's own semantics and the owner, relations, workspace and request identity are written in the same commit. |
| `fa6d766` | The foundation's public test at the core seam, with a real subagent child (created through the existing `created-task` ownership) whose display parent is then tombstoned: the child keeps its edge and reads its inherited history, and a branch from an entry it **inherited** is legal. |
| `1e10e8c` | `SubagentAnchorInput` becomes a backward-compatible union — the existing delegation arm, and an idle arm `{initialPhase: "idle"; dispatchId?: never}` — so one task kind owns both a delegation (recoverable `admit`) and a user's branch (permanent idle, nothing to admit). `initial` reads the input; `admit` opens with a `dispatchId === undefined` guard. No version bump; a stored v1 record still reads as a delegation. `createForkAnchor(tx, conversationId)` is the one helper that writes the branch's anchor. |
| `782b807` | The fork route: a task-owned source is no longer refused. The branch is created through the one creation seam with a `created-task` anchor of the source's own conversation and background scope, its display parent and `createdBy` set, its own provenance, and the caller's `requestId`; an ordinary conversation still forks ownerless. **`activeChildren` is fixed to the native ordinary scope**: "live work" is a live **non-background** task, because a child's permanent idle anchor (and every branch's) is a live background task of that child — counting it read every finished child as work forever and refused the next delegation. Red first: the public test below failed with `this conversation already has 4 children at work; the limit is 4` before the one-line change. |
| `760ef51` | The catalogue stops reporting a **user branch** as a delegated child. Its owner is its own anchor, but nobody delegated it, so `subagentParentConversationId` is omitted when the provenance is the user's; otherwise a surface would fold the user's own branch into the source's family and treat its answer as a silent completion. |
| `1ed605a` | Web: the raw-history panel and its adapter routes. `GET /api/sessions/:id/read` forwards the backend's own bounded read untouched (offset, limit, entry/block scope, tail, cursor); `GET /api/sessions/:id/info` forwards the conversation identity (relations, native edges, references, credential-free config); `POST /api/sessions/:id/references` forwards the idempotent add; fork and `fork_branch` carry a request identity. The catalogue row now carries `createdBy`, `displayParentSessionId` and `displayParentDeleted`. The toolbar's Full history control opens the panel — which lists entries with each block's inventory, shows the page's text, fetches one block on demand (an image as its bytes), lists references and forks at any entry — replacing a control that opened `/api/sessions/:id/export`, a route this deployment never served. |
| `812f844` | The two verification seams: a production-browser journey (`apps/web/e2e/ux-child-raw-history-fork.mjs`, seeded by `apps/server/scripts/child-fork-fixture.ts` through the product's own creation seam) and a real SIGKILL matrix (`apps/server/test/child-fork-crash.test.ts` + its stage child) over the branch's creating commit. |
| `2be82e1`, `9a4e164`, `7d91968` | `docs/architecture.md` (a branch's owner is not a delegation edge), `docs/chat.md` (the fork body, the branch semantics and the panel), `docs/migration-status.md`, and the adapter contract test that asserts the fork's request identity. |
| `44cbeba` | **Found while polishing**: a subagent whose parent was tombstoned vanished from the sidebar entirely, and a hidden middle conversation dropped its descendant — the cascade A22 forbids. `listSessionFamilies` now follows the relation only while the parent is **present** in the listing, and keeps a session whose ancestry left the listing as a family of its own. Red first at the pure seam (`apps/web/lib/session-family.test.mjs`) and asserted again on the real screen. |

### Acceptance criteria

- **Raw history / compact-reset markers and fork source as one query model, using 04's read, no fake entry-parent edit tree.** The panel reads `GET /api/conversations/:id/read` — ticket 04's own operation, the same one `agent_read` calls — and the fork source is the native record's `parent`, projected as `parentConversationId`. No entry-parent tree is invented: the history is the entry table's fork-aware order.
- **User fork from a child entry creates an independent background anchor, an explicit native owner, new provenance and a stable request identity, keeping display parent and fork source, with no ownerless default.** Asserted in `apps/server/test/session-fork.test.ts` (a real holder-task child; the branch's owner is a **different** task on the child, its `createdBy`/`displayParentId` are the child, its provenance is the user's) and in the browser journey.
- **Independent dispatch, inbox and control initial state; no copying of the source's task, queue or stop; the source anchor is not reused; a user fork takes the source position's configuration plus an explicit user override.** The branch's own anchor starts in the permanent idle phase; `busy` is false, `control.state` is `allowed` and the queue is empty. `session-fork.test.ts` asserts the branch keeps the level in force at its entry while a later source change does not leak, and that an explicit `thinkingLevel`/`model` replaces that field — validated before the fork, so an unknown model or level is refused and creates nothing.
- **The anchor belongs to the correct source child conversation-owned background scope; a tombstoned display parent does not prevent a legal branch; a hidden parent neither cascades nor promotes the child.** The anchor is created with `ownership: {kind: "conversation"}, conversationId: source, background: true`. The core test forks a child whose display parent was tombstoned; the browser journey hides the parent and then re-reads the child, the branch and their inherited content, and reads the sidebar to confirm both rows are still listed.
- **Pre-compaction text/image/tool-result attachments and the fork's shared prefix read correctly through the target conversation+entry; membership refuses unrelated entries.** The read reaches the entry a compaction hid (asserted against the active window, which does not carry it), the image block is listed with its mime and byte length and fetched as bytes, and a source entry the source never inherited is refused `unknown_source_entry` 404.
- **Web supports the source tree / fork-at navigation and opening structured conversation or entry references; a reference injects no full text and changes no display parent or execution binding.** The panel lists references with their labels and opens the target conversation (asserted by the URL's `session` parameter); the reference write is the backend's own idempotent add and touches the target not at all.
- **A lost fork answer or a real SIGKILL still answers the same branch for the same request; existing bounded history, scroll positioning and deferred image behaviour do not regress.** `child-fork-crash.test.ts` kills a stage **inside** the commit that carries the branch, reopens the same SQLite file, replays the identity and asserts one branch, the same identity, the child's task not reused, the branch's history stopping at its point and the child untouched; the browser journey replays a fork from the panel. The existing `ux-session-fork`, `ux-history-prefix`, `ux-deferred-text` and `ux-windowed-transcript` journeys are unchanged and pass.

### Commands and results

Run at `44cbeba` (clean tree; node v26.5.1, pnpm 12.4.1):

| Command | Result |
| --- | --- |
| `pnpm --filter @hepi/server --filter @hepi/web -r typecheck` | exit 0 |
| `cd apps/server && node --test test/*.test.ts` | exit 0, **391/391** (three consecutive runs) |
| `node --test apps/web/adapters/*.test.mjs apps/web/lib/*.test.mjs` | exit 0 (the one failure, `mcp-import.integration.test.mjs`, is pre-existing: the root package declares no `@earendil-works/pi-coding-agent`, and it fails identically in the primary worktree) |
| `pnpm --filter @hepi/web build` | exit 0 |
| `node apps/web/e2e/ux-child-raw-history-fork.mjs` | exit 0, **36/36** browser checks |
| `pnpm verify:changed --base=5b2469d` | `changed-typecheck` exit 0, `changed-test` exit 0 (server 391/391), `web-unit` exit 0; `check-docs` exit 1 with the same **12 pre-existing `.scratch/**` links** — none in a file this ticket touched. Report: `.dev/verify/2026-10-16T18-37-17-504-verify-changed/verify.json` |

Red checks, so the fixes are shown to matter: the capacity test failed with `this conversation already has 4 children at work; the limit is 4` before the `activeChildren` change; the family tests failed with the child missing from the listing before the `session-family` change.

### Not delivered, and why

No `entry-parent` editing tree, no search or full-text index, no conversation virtual filesystem — out of scope by the ticket. The branch's own configuration override covers `model` and `thinkingLevel`, the two fields the settings route already validates; a branch takes the rest from the position's native `asOf` snapshot. 07's reporter delivery and 10's configured context preparation are other tickets' seams; this ticket neither implements nor depends on them, and its anchor arm creates no dispatch record, admits nothing and reports nothing.



### Post-merge (ticket 07 into ticket 11)

`integration/durable-subagents` (`565c634`, ticket 07's result delivery) merged into this branch at **`a6b49b3`** with no conflict. The anchor signature was not changed by that merge: the idle arm is still `{initialPhase: "idle", dispatchId?: never}`, `createForkAnchor` still names no dispatch, and `admit` still opens with its `dispatchId === undefined` guard. What 07 added is the reporter, created by an **admitting** anchor; the idle arm's own `recoverReporter` returns immediately when `dispatchId` is undefined, so a user's branch still creates no reporter and admits nothing.

Combined anchor tests: `test/subagents.test.ts` 12/12, `test/subagent-reports.test.ts` 10/10, `test/child-fork-crash.test.ts` 1/1, `test/session-fork.test.ts` 7/7, `test/conversation-fork-source.test.ts` 4/4, and the whole server suite **401/401** twice.

One integration defect found and fixed at the test seam (`7b7ab16`): 07 makes a finished child report itself into its delegating conversation, which wakes a turn of that conversation. My branch test's model script read that report as the next task and delegated a spurious child, so the catalogue held two children where the test expected one. The fix is 07's own guard — a report-woken turn is answered and delegates nothing — and it is stated as such in the test rather than worked around.

The merge also let the two tickets be asserted together where they meet, in `test/child-fork-crash.test.ts` after the real SIGKILL: the recovered store holds **no reporter at all** (`scanTasks({kind: "hepi.subagent-reporter"})` is empty) and exactly one anchor on the child, and every anchor is background. A reporter there would wake the child with a delivery for a delegation nobody made.

Web build and the browser journey re-run against the merged tree: `pnpm --filter @hepi/web build` exit 0, `ux-child-raw-history-fork.mjs` 36/36.


Ticket 07's **accepted** integration tip `1f4131a` was merged into this branch at **`0eef159`**. Its delta over the already-merged `565c634` is documentation only (`.scratch/durable-subagents/README.md`, `issues/07-automatic-result-delivery.md`), so no code changed and the anchor signature is still the one committed at `1e10e8c`: the idle arm `{initialPhase: "idle", dispatchId?: never}`, `initial` mapping it to the permanent `idle` phase, `createForkAnchor` naming no dispatch, `recoverReporter` returning immediately when `dispatchId` is undefined, and `admit` keeping its `dispatchId === undefined` guard.

Re-verified at `0eef159`: typecheck (server + web) exit 0; `subagents.test.ts` 12/12, `subagent-reports.test.ts` 10/10, `child-fork-crash.test.ts` 1/1, `session-fork.test.ts` 7/7, `conversation-fork-source.test.ts` 4/4; whole server suite **401/401** twice; `pnpm --filter @hepi/web build` exit 0; `ux-child-raw-history-fork.mjs` 36/36. Ticket 10's `19c6a5a` is still deliberately not merged.


Ticket 10's integration merge (`72d5ce9`, the parent's merge of `bc4f60a`) was merged into this branch at **`9a8cd26`**. **No conflict.** `server.ts` auto-merged although both tickets insert into the same `createBackendServer` subagent composition: this ticket's changes are the fork route body (`POST /api/conversations/:id/fork` → `operations.spawn` with `createForkAnchor`), the `catalogueEntry` display-parent projection, and `activeChildren`'s non-background filter — all in different hunks from ticket 10's two new host deps (`sourceEntry`, `retryPreparation`). The merged file keeps both sides: `sourceEntry` at 1045, `activeChildren` at 1052, `readDispatch` at 1095, `retryPreparation` at 1098, the fork route's `createForkAnchor` call at 2155.

**The three contracts in one record.** After the merge the anchor input union carries all three tickets: the delegation arm gained `preparation?: "compact"`, the idle arm states `preparation?: never`, `initial` maps a delegation to `prepare` only when its definition asked for compact and otherwise to `admit`, `createForkAnchor` still writes `{initialPhase: "idle", delegatingConversationId}` with no dispatch, `recoverReporter` still returns immediately on `dispatchId === undefined`, and `admit` keeps its guard.

That meeting is now asserted in `test/child-fork-crash.test.ts` on the **recovered** store after the real SIGKILL, not only in code: the branch's anchor input is exactly `{initialPhase: "idle", delegatingConversationId: <child>}`, its committed checkpoint phase is `idle` (not `prepare` or `admit`), it is still live rather than settled, every anchor is background, and there is **no reporter at all**.

Re-verified at the merge, then again after that test edit: typecheck (server + web) exit 0; `context-preparation.test.ts` 8/8, `subagents.test.ts` 12/12, `subagent-reports.test.ts` 10/10, `child-fork-crash.test.ts` 1/1, `session-fork.test.ts` 7/7, `conversation-fork-source.test.ts` 4/4; whole server suite **409/409** twice (up from 401 — ticket 10's eight preparation tests); `pnpm --filter @hepi/web build` exit 0; `ux-child-raw-history-fork.mjs` 36/36.


Ticket 10's acceptance tip `f707aa1` was merged into this branch at **`675eee3`**. Its delta over the already-merged `72d5ce9` is documentation only (`.scratch/durable-subagents/README.md`, `issues/10-configured-context-preparation.md`) — `git diff 72d5ce9 f707aa1 -- apps/server/src/server.ts` is empty — so no code changed. The merged file still holds ticket 10's two host deps (`sourceEntry` at 1045, `retryPreparation` at 1098) beside this ticket's fork route (`createForkAnchor` at 2155), and the anchor union still carries `preparation?: "compact"` on the delegation arm and `preparation?: never` on the idle arm.

Re-verified at `675eee3`: typecheck (server + web) exit 0; `context-preparation.test.ts` 8/8, `subagents.test.ts` 12/12, `subagent-reports.test.ts` 10/10, `child-fork-crash.test.ts` 1/1, `session-fork.test.ts` 7/7, `conversation-fork-source.test.ts` 4/4; whole server suite **409/409** twice; `ux-child-raw-history-fork.mjs` 36/36.

This branch is ready for the parent's acceptance review. It is not self-accepted.



## Correction (review round 1) — two Web P2s

Two material failures were found in the Web surface and are fixed in **`e2bf7c0`**.

**1. A fork retry duplicated the branch.** `RawHistoryPanel.forkAt` sent no `requestId`, and `durable-api.ts` minted a fresh one per HTTP request, so a retry after a lost answer was a *different* request to the backend: the first attempt had already committed a branch, and the retry made a second one. The identity now belongs to the **attempt**, not the request — `apps/web/lib/fork-attempt.ts` holds one identity per `<conversationId>:<entryId>` while that attempt is unanswered and releases it the moment the answer arrives, so a retry reuses it and a genuinely new fork of the same entry gets its own. The panel mints through `createRequestId` and keeps the identity on failure, because that failure is exactly what the user retries.

**2. A reference to a compacted entry did not land.** The panel and `ChatWindow` navigated only the active transcript, whose search target is cleared the moment the entry is not in the window — correctly, since the window cannot show it — so opening a reference to a compacted or inherited entry ended with nothing shown. `SelectSessionOptions.rawHistoryFocus` now carries that intent: the shell opens the raw-history surface and hands it the entry, and the panel walks the read's own continuation until the entry is listed, marks it `data-raw-focus`, and scrolls it into view. The walk is bounded by the read's `next` and by progress, and one walk runs at a time.

Red evidence, against the pre-fix components with the new tests in place (`pnpm --filter @hepi/web build` then the driver):

- `FAIL the retry after a lost answer reuses the attempt's identity instead of making a second branch: {"before":2,"afterRetry":4,"branchId":"55"}` — the retry created a **second** branch.
- `FAIL a reference to a compacted entry opens the raw read positioned on that entry` — the focus never landed.

Green at `e2bf7c0`:

| Command | Result |
| --- | --- |
| `node --test lib/fork-attempt.test.mjs` | exit 0, 1/1 — the identity is reused across retries, a different branch point mints its own, and a settled attempt releases its identity |
| `node --test lib/fork-attempt.test.mjs adapters/session-fork.test.mjs adapters/durable-api.test.mjs` | exit 0, 8/8 |
| `node --test adapters/*.test.mjs lib/*.test.mjs` | exit 0, **96/96** |
| `node apps/web/e2e/ux-child-raw-history-fork.mjs` | exit 0, **40/40** browser checks, including the two new ones |
| `cd apps/server && node --test test/*.test.ts` | exit 0, **409/409** |
| `pnpm verify:changed --base=675eee3` | exit 0 — `changed-typecheck` PASS, `changed-test` PASS, `web-unit` PASS (135/135) |

The driver's two new checks are the regression tests: the lost-answer fork really commits upstream (the route is allowed through and its response is then dropped by the browser), the retry is clicked, and the **backend's own catalogue** is read to assert the branch count went up by exactly one rather than two; and the compacted-entry reference is clicked, after which the positioned entry must appear and carry the compacted line the window never had.
