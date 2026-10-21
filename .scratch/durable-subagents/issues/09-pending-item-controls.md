# 09: 编辑取消待处理结果并在 Web 明确继续

**What to build:** 用户停止主会话后，Web 显示迟到报告；用户逐项编辑/取消，再明确 Continue，模型只处理最终保留的正文。

**Blocked by:** [07 — 可靠自动回传最终结果并唤醒接收者](07-automatic-result-delivery.md)

**Status:** accepted — merged `9672a36` on integration/durable-subagents. Spec and standards reviews: no material finding. Product evidence is verify at clean `f203438` (tip `b1c1d87` is ticket docs only).

**Labels:** ready-for-agent

**Spec:** [D07](../spec.md#d07)、[D08](../spec.md#d08)、[D09](../spec.md#d09)、[D15](../spec.md#d15)；[验收 A07、A08、A10、A11、A18、A20](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] snapshot/SSE透出真实queued项submissionId、mode、正文、自动来源/源引用、控制状态和编辑条件token，用户输入与报告共用队列呈现。
- [x] 逐项编辑事务校验仍queued及旧content token；旧标签页编辑返回当前内容冲突，不能覆盖新决定；placed项明确冲突。
- [x] 取消复用abortSubmission；已取消重试成功，placed冲突；编辑/取消都不解除held、不发模型请求。
- [x] 用户编辑的是父队列副本，child原始记录可打开；reporter重试不覆盖修改或复活取消项，原有普通输入整队recall不回归。
- [x] Web有明确held/stopping/Continue展示；旧范围未退出时保留composer与待处理正文，获准后从原Inbox消费；空continue无虚构用户消息。
- [x] 用户stop提交点既有排队输入撤回、之后报告保留，重复stop或旧控制HTTP答复不抹掉较新队列/状态；立即用户输入与queue-only输入的恢复差别可见。
- [x] 真实SIGKILL/重开与浏览器重连后保留编辑/取消/暂停决定；缺少终态的提交按既有requestId lookup处理，不自动重发。

## Verification seam

- 生产浏览器主stop→child晚回报→编辑一项取消一项→Continue；核对实际父模型请求正文与未执行取消内容。
- 两个标签页冲突、placed竞态、编辑/取消后reporter重试及SIGKILL；检查原child内容不变。

## Scope and handoff

不为报告单建队列或draft store，不把整队recall变成报告编辑，不重复实现生命周期折叠。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

07验收后开始本票时，先读[只读准备](../pending-controls-preparation.md)，核对07实际报告schema，再使用原生Inbox/Submission和既有draft/lifecycle接缝。准备没有产品测试证据，不解除07阻塞。

## Implementation record

Branch `impl/durable-subagents-09`, worktree `.dev/worktrees/durable-subagents-09`, based on integration `b94e132`
(07, 10, 11 accepted). Tip `f203438`; the whole diff against `b94e132` is 24 files, +2311/−36.

### Commits

| SHA | Subject |
| --- | --- |
| `4073a8d` | feat(protocol): state the pending queue item by item |
| `558113b` | feat(server): edit and cancel one queued item |
| `abf0bf3` | feat(server): mount the per-item queue routes |
| `7a2e265` | feat(web): carry the queue, the control and the per-item commands |
| `4a3861c` | feat(web): show the hold and let the user decide each item |
| `0a02383` | test(web): prove the stop, the late report and the decision in a browser |
| `f203438` | docs(chat): state the per-item pending queue contract |

### What was built

**One queue, projected — no second one.** `packages/protocol` gains `QueuedItemProjection` (`submissionId`,
`requestId`, `mode`, `content`, `source`, `contentToken`, `editable`, `cancelable`) and `queuedItems` on
`ServerSnapshot`. `contentToken` is one pure function (`pendingContentToken`) over the item's own content, so both
sides compute the same token and no receipt store is needed for optimistic concurrency. `queuedMessages` is kept
unchanged beside it: it is what the composer's own plain rows and the whole-queue recall still read.

**The operations own no queue.** `apps/server/src/conversation-items.ts` projects the runtime's own `pi.inbox` items
and writes exactly one field of one item in one commit. It reads the item's request id from the runtime's own
`inspect` read, so the identity a caller resolves a submission by travels with the item.

- An **edit** validates the token **inside** the commit that writes, so two tabs cannot both pass the check. A stale
  token answers `409 content_conflict` **carrying the current item**; a placed or settled item answers
  `409 not_queued`; a replayed identical edit is an idempotent success. The item's own entry is preserved, so editing
  a report changes what the model reads without rewriting where the report came from, and a queued item's image blocks
  survive a text edit.
- A **cancel** goes through the runtime's own `abortSubmission`. `aborted` is `cancelled`, an earlier cancel is
  `already_cancelled` (the same outcome asked for twice), and `already_placed` or any other settlement is
  `placed` — a conflict, not a failure to retry.
- Neither clears `held` and neither starts a run: only the trusted user `continue` does. That rule is the point of
  the feature, and it is asserted directly rather than inferred from the model request count.

**server.ts is touched additively.** The 11 worker had released it, but the surface still has no reason to own a
second queue: the change is one `projectQueuedItems` call in the snapshot projection and one dispatch line per route.
The routes are `GET /api/conversations/:id/items`, `PATCH` and `DELETE /api/conversations/:id/items/:submissionId`.

**The Web acts on the refusal the backend named.** `durable-api.ts` forwards the three routes and the `stop`,
`continue`, `edit_item` and `cancel_item` commands; `agent-client.ts` keeps the backend's response body on the
error, because a conflict's current item is what a stale tab has to show; `ChatInput` renders one `QueuedItemRow` per
item — mode, text, the child a report came from with a control that opens it, Edit and Cancel — above a held banner
offering Continue. The row's notices read the backend's own **code**, not its message text: a placed item says it is
placed instead of showing a generic failure that invites a retry no cancel can land.

### Verification (this revision, 2026-10-16)

`pnpm verify:changed --base=b94e132` at clean `f203438`: changed-typecheck exit 0, changed-test exit 0
(**422/422 server tests**), web-unit exit 0 (**136/136**, 61 files), check-docs exit 1 with exactly the 12 known
pre-existing `.scratch/` broken links and no new one. Raw logs:
`.dev/verify/2026-10-16T21-30-04-618-verify-changed/`.

Focused backend suites, over a real backend, real SQLite and a controlled model:

- `node --test test/pending-item-controls.test.ts` — **8/8**. The late report projects with identity, mode, text and
  the child's own source reference; an edit with the token read changes only that item's copy, leaves the child's
  history untouched and makes **zero** model requests; a stale tab is refused with the current item and the newer
  decision stands; a cancel is idempotent and never lifts the hold; the user's Continue consumes the kept item and
  excludes the cancelled one **from the model request itself**; an empty Continue consumes nothing and invents no user
  message; a reporter replay after an edit and a cancel neither overwrites the edit nor revives the cancelled item;
  and a real **SIGKILL** after both decisions keeps them across the reopen.
- `node --test test/pending-item-routes.test.ts` — **5/5**. The same contract over HTTP, including the status codes,
  the conflict body and a removed conversation.
- The whole `@hepi/server` suite is **422/422**, so the ordinary whole-queue recall and the stop/continue suites are
  unchanged.

Browser journey `node apps/web/e2e/ux-pending-item-controls.mjs` — **all 25 checks pass**. The real production Next
build, the real backend process over real SQLite, a real local execution host, the real subagent extension with its
real anchor and reporter tasks, and one controlled OpenAI-completions endpoint that records every request:

1. the user delegates two tasks in one turn, so the parent is genuinely running while two children work;
2. the user presses **Stop** — the trusted user stop — and neither child nor its reporter is cancelled;
3. both children finish and both reports arrive **late**, so both queue under the hold, and **no model is asked at
   all** since the stop (asserted on the recorded requests, and on the backend's own control record still reading
   `held`);
4. the user edits one item and cancels the other; the hold and the control revision are unchanged;
5. a **browser reload** reads the edited item, the cancelled item's absence and the hold back from the backend;
6. the user presses **Continue**, and the parent model's next request carries the edited text and **not** the
   cancelled text — checked in the request the provider recorded and in the committed transcript.

### Limits recorded, not repaired

- `queuedMessages` stays on the wire beside `queuedItems` rather than being replaced. It is still what the composer's
  plain rows and the recall path read, and removing it would be a protocol break for a surface that only counts the
  queue. The two are projected from the same inbox read, so they cannot disagree.
- The row's conflict notice names the fact (`chat.itemConflict`) and the current text is adopted from the answer; it
  does not render a side-by-side diff of the two revisions. Nothing in the ticket asks for one, and the newer decision
  is what stands either way.
- A queued item's **images** are preserved through an edit but not editable: the edit's own body is text only, which
  matches what the composer can express. A non-text item is edited as text beside its kept images.
