# 07: 可靠自动回传最终结果并唤醒接收者

**What to build:** child 直接给出最终答复后，框架无需 contact、轮询或额外总结回合，自动将结果交给登记接收者；正常空闲会话继续处理，用户停止的会话仅看到待处理项。

**Blocked by:** [06 — 创建可恢复的独立子执行](06-durable-child-execution.md)

**Status:** accepted — merged `565c634` on integration/durable-subagents. Integration server suite 398/398 at that SHA.

**Labels:** ready-for-agent

**Spec:** [D04](../spec.md#d04)、[D05](../spec.md#d05)、[D06](../spec.md#d06)、[D07](../spec.md#d07)、[D16](../spec.md#d16)；[验收 A04、A06、A07、A19、A22](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 用可恢复 native reporter phase 等待整个 Submission 终态与 answer identity；工具轮 handover、首段generation结束或中途contact不提前完成。
- [x] 最终正常答复/失败/中断均自动回报；child不调用contact也能完成，不追加总结回合，不依赖裸Promise/SSE listener持久交接。
- [x] 报告以稳定派活派生requestId进入recipient原生Inbox/Submission，带hepi.agent-report来源和源会话/dispatch/submission/answer引用，不冒充用户输入。
- [x] 只投送最终答复/终态；大结果使用固定规则截断和agent_read可读源引用，明确截断，不搬运所有日志/thinking或额外模型猜摘要。
- [x] 按投递时recipient状态：allowed idle可启动、running按边界排队不打断工具或另开并发回合、held只queued且零父模型请求；父stop不取消child/reporter。
- [x] 只为显式登记委派回报；直接用户child聊天或报告引发回合不再按展示parent循环回报。
- [x] recipient tombstone终止为recipient_deleted并保留源结果，不admit、不无限重试。
- [x] child终态至投递、投递至确认真实SIGKILL后仍是同一逻辑报告；已有edited/cancelled receipt不覆盖或复活，即使Web编辑票尚未交付也通过原生公开操作验证。

Parent acceptance: integration `565c634`, `pnpm --filter @hepi/server test` 398/398 exit 0. Two review P2s closed in `91f6bc3` (tombstone+held one commit; idle recovers one reporter only when dispatchId set).

## Verification seam

- 主agentspawn后继续独立工作，child完全不调用contact，验证正常idle自动被唤醒、running按边界接纳、held无模型调用。
- 真实SQLite/SIGKILL重放完整等待与投送交接；计数报告身份，不以可能重试的传输请求数宣称外部exactly-once。

## Scope and handoff

此票建立首次完整自动回报链；不实现逐项Web编辑器、定义驱动语义准备或跨会话send复用界面。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Implementation record (agent-94, branch `impl/durable-subagents-07`)

Base: integration tip `8054b95` (06 accepted, 11 foundation `fa6d766`); merged `1e10e8c` (97's idle anchor shape) before
the final run. No product change outside the owned paths; `server.ts`, `packages/protocol`, `apps/web` and `patches/`
are untouched, and the native `pi-durable@1.3.0` patch is unchanged.

### Commits

| SHA | Subject |
| --- | --- |
| `a24698a` | reporter core seam and deliver path (pre-merge, superseded) |
| `c78cc87` | merge `fa6d766` (fork source) |
| `957cc5d` | feat(subagents): automatic result delivery through a recoverable reporter task |
| `8bb27a4` | docs(subagents): state automatic result delivery and its one report identity |

### What was built

- **`reporter.ts` (new)** — `hepi.subagent-reporter`, a conversation-owned `background: true` task with two
  checkpointed phases. `wait` reacquires the child submission through `runtime.conversation` +
  `handle.submit(requestId = dispatch.submissionRequestId)` (native dedupe, so never a second turn) and awaits
  `submission.wait` — the **whole** submission, so a tool-round handover or a mid-run contact does not resolve it — then
  commits the report record and hands over to `deliver`. `deliver` reads the answer text through the core bounded read
  (text blocks only), cuts it by a fixed 8 KiB / 400-line rule with an explicit truncation notice, admits it through the
  host port, and commits its acknowledgement plus its terminal outcome. `abort` commits
  `{status:"terminal", outcome:{status:"aborted", reason:"reporter_stopped"}}`.
- **`anchor.ts`** — keeps 97's union and `createForkAnchor(tx, cid)` unchanged; the admit phase's existing commit gains
  the reporter creation **after** the admission, gated on `DispatchRecord.reporterTaskId`. The reporter definition is
  resolved by name from `runtime.registry`, so no signature change and a recovered anchor resolves it the same way. The
  idle (fork) shape admits nothing and therefore creates no reporter.
- **`host.ts`** — `SUBAGENT_REPORTER_TASK`, `AGENT_REPORT_ENTRY_KIND = "hepi.agent-report"`, `ReportDoc`
  (`hepi.subagent.report`, conversation family, `fork: "initial"`), `DispatchRecord.reporterTaskId`,
  `SubagentDeliverRequest/Answer`.
- **`composition.ts`** — the `deliver` port mapping the core's `session_deleted` to `recipient_deleted` and `not_found`
  to `not_found`; every other error propagates.
- **`conversation-operations.ts`** — **only** the new `deliver` method and its two types. It reuses
  `requireConversation` + the existing `assertNotTombstoned` and then calls `conversation.submit` with
  `whenBusy: "followUp"`, reading the status back. No caller argument, no control logic, no hold clearing.

### The actual wire/metadata contract (answers to 09/95 prep)

- Entry kind: exactly `hepi.agent-report` (an application kind; the native admission refuses a `pi.` prefix).
- Entry `data` (all ids are **strings**): `dispatchId`, `childConversationId`, `submissionId` (the settled child
  submission), `submissionStatus` (`"done" | "unanswered"`), `answerEntryId` (present exactly when `done`),
  `answerReason` (present exactly when `unanswered`, e.g. `"aborted"`), and
  `preview: { bytes, droppedBytes, droppedLines, sourceTruncated, maxBytes: 8192, maxLines: 400 }`.
- Report request id: `<dispatchId> + ":report"`, exported as `reportRequestId(dispatchId)`; stable across every retry.
- Queue mode: `whenBusy: "followUp"` — the item is `mode: "followUp"` in `pi.inbox`.
- Delivery outcome is stored on the extension's own `ReportDoc` (keyed by dispatchId on the **delegating** conversation):
  `delivery: "delivered" | "recipient_deleted" | "recipient_missing"`, plus `deliveredSubmissionId`, `deliveredAt`,
  `settledAt`, `submissionStatus`, `answerEntryId`/`answerReason`, `childConversationId`, `submissionId`. The same
  fields are the reporter task's terminal `result`. A **removed recipient** is `recipient_deleted` on the record; nothing
  is written into the recipient.
- **No** `triggerTurn: false` / `resume: false` anywhere in the report path: delivery is the ordinary native admission,
  so an allowed idle recipient **is** woken, a running one queues at its own boundary, and a held one queues without
  lifting the hold. Idle-wake is never disabled.
- Retry after a user cancel: the reporter calls the same admission under the same request id; the native known-id
  answer returns the existing submission (settled `unanswered`/`aborted`), the reporter records `delivered` with that
  id, and nothing is re-queued, revived or overwritten.

### Verification (this revision)

Deliverable tip `e35aa6d4a1ca0d5d46abee4680acaccdcc4e1f5a`, worktree clean (`git status --short` empty, 0 dirty files).

**Retained evidence (on disk, this worktree)**

```
.dev/verify/2026-10-16T18-01-16-728-verify-changed/verify.json
.dev/verify/2026-10-16T18-01-16-728-verify-changed/changed-typecheck.log
.dev/verify/2026-10-16T18-01-16-728-verify-changed/changed-test.log
.dev/verify/2026-10-16T18-01-16-728-verify-changed/check-docs.log
```

- `verify.json`: `profile: changed`, **`sha: 8bb27a41311e999ce4b65ad9bc005f7e8ec3b1ca`**, `dirty: false`, `dirtyFiles: []`,
  `selection.base: 1e10e8ca1ccf61391b2f3d49f379f25eeca16537`, packages `["@hepi/server"]`, `ok: false` (only because
  `check-docs` fails on the pre-existing links below).
- `changed-typecheck.log` — `pnpm --filter @hepi/server -r typecheck` (`tsc --noEmit`), **exit 0**, 3333 ms; log header
  repeats `sha: 8bb27a4…`, `dirty: false`.
- `changed-test.log` — `pnpm --filter @hepi/server -r test` (`node --test test/*.test.ts`), **exit 0**, 22950 ms;
  `ℹ tests 396 / ℹ pass 396 / ℹ fail 0 / ℹ cancelled 0`. It contains all the focused assertions this ticket claims:
  the 8 reporter cases at **lines 342–349** (idle wake; boundary queue; held recipient; `recipient_deleted`; bounded
  preview; user-cancelled report not revived; the two real `SIGKILL` windows — `settled` and `delivered`), the 11
  `subagents.test.ts` cases at **lines 350–360** (including "a user stop of the delegating conversation leaves the child
  and its anchor running", line 353), and the `conversation-fork-source.test.ts` cases at **lines 255–260**.
- `check-docs.log` — **exit 1**, the **known 12 pre-existing broken relative links** in `.scratch/` (baseline identical
  before this ticket; none in a file this ticket touched).

**Product-equivalence of the tested SHA to the deliverable tip**

The evidence was produced at `8bb27a4`; the tip `e35aa6d` is that SHA plus `caef97a` (this ticket record) and the
`integration/durable-subagents` merge, and both only add Markdown under `.scratch/`:

```
$ git diff --stat 8bb27a4..e35aa6d -- . ':(exclude).scratch'   # empty
$ git diff --stat 8bb27a4..e35aa6d
 .scratch/durable-subagents/implementation.md                | 18 +++++
 .scratch/durable-subagents/issues/07-automatic-result-delivery.md | 84 ++++++
 .scratch/durable-subagents/issues/08-reusable-agent-control.md    |  2 +
 .scratch/durable-subagents/issues/09-pending-item-controls.md     |  2 +
 .scratch/durable-subagents/pending-controls-preparation.md        | 32 ++++
 .scratch/durable-subagents/reusable-control-preparation.md        | 31 +++
```

No `apps/`, `packages/`, `docs/` or `patches/` byte differs, so the 396/396, the typecheck and the 8 reporter cases
apply to `e35aa6d` unchanged.

**Earlier focused invocations without retained logs (stated, not claimed as artifacts)**

`node --test test/subagent-reports.test.ts` → 8/8 at `aca415f` (post-`1e10e8c` merge) and again after the
integration merge; `node --test test/subagents.test.ts test/conversation-fork-source.test.ts` → 15/15 at the same tip.
Those runs were console-only and wrote no log file; their cases are all inside `changed-test.log` above, which is the
retained artifact for every claim in this ticket.

- `docs/architecture.md` gained the "Automatic result delivery" section and the extension now states two task definitions.

### Limits recorded, not repaired

- A report delivered into a conversation that is tombstoned *later* stays queued; the tombstone rule guards new
  deliveries only.
- Per-item Web editing/cancelling and the wire projection of queued `entry.kind`/`data` remain ticket 09's; this ticket
  guarantees the durable kind, the stable request id and the no-overwrite/no-revive behaviour through the native
  dedupe + settle path only.
- 08's agent-only resume, 10's `prepare` phase and 11's user fork/Web surfaces are untouched; the anchor keeps 97's idle
  shape and guard verbatim, so 96 can add its `prepare` phase and `initial` branch on top.

## Review fixes (P2-1, P2-2) — after 101's material findings

Deliverable tip after this change: `8040cd5b54a7ee79b897383a9319ab7ae14ce934` (branch `impl/durable-subagents-07`).
Both defects were classified before patching; neither needed an engine change, a new task kind, a private hook, a poll
window or a caller re-check.

### P2-1 — tombstone / admission linearization (owning boundary: the removal commit)

**Trigger.** Real, and it is an ordering, not a timing window: `ConversationOperations.deliver` reads the tombstone in
one commit and admits natively in a later one, so a removal that commits in between is followed by a report that is
still placed and by the removed recipient's model. Evidence: parent's `/tmp/subagent07-tombstone-model-probe-e35aa6d.log`
(13/30 hidden model requests), reproduced here as the `baseline` variant of
`/tmp/subagent07-p2-1-linearize-probe-fixed.log` (before the fix: `deleteFirst 10 / placedAfterDelete 10 /
modelRanAfterDelete 10`).

**Owner.** The removal commit, `apps/server/src/session-tombstone.ts` — not `deliver`, and not the engine. The native
seam inspected first: `admitSubmission` already consults exactly one durable fact about admission, the conversation's own
`pi.inbox` control record through `isHeld`. The removal now commits `held` in the **same commit** as the tombstone
(only `state` changes; revision and receipts are kept, and an inbox that was never materialized gets the runtime's own
default). A later admission then reads `held` by the runtime's own rule: it queues, places nothing and starts no run.
No admission is duplicated, no caller re-checks, no retry/fallback was added, and the native queue, control revision and
admission rules are untouched. A deleted conversation is never continued, so its queue is never consumed.

**Evidence.** New public regression in `apps/server/test/subagent-reports.test.ts`: "a removal that lands between the
report's check and its admission still admits nothing, so no model runs". It interleaves the real
`tombstoneConversation` at every microtask boundary across the real `deliver`, asserts the invariant at every boundary
where the removal committed first (no `report:placed`, no report entry, zero model requests), and asserts the
interleaving really occurred so the test cannot pass vacuously. RED before the fix
(`["deleted","delete-returned","report:placed","deliver-answered"]`), GREEN after.
After the fix the probe reports `deleteFirst 10 / placedAfterDelete 0 / modelRanAfterDelete 0` for **both** variants,
i.e. the product's own removal is now the linearization. One existing assertion was updated for the new invariant:
`conversation-stop-continue.test.ts` "a removed conversation refuses stop, continue and both input routes" now reads
`held` from the removed conversation's control, which is the point of the fix.

### P2-2 — reporter recovery for a pre-07 explicit dispatch (owning boundary: the anchor's idle phase)

**Trigger.** Real on upgrade: a v1 database can hold a delegation whose anchor already admitted (checkpoint `idle`, the
dispatch record naming the child submission) but which predates the reporter, so nothing would ever wait that submission
out. Evidence: parent's `/tmp/subagent07-pending-legacy-probe-e35aa6d.log` (baseline `queued 25` → `answer 28`, no
reporter).

**Owner.** The anchor's `idle` phase, `apps/server/src/subagents/anchor.ts`. Before parking, an idle anchor whose input
names a dispatch and whose dispatch record names no `reporterTaskId` creates exactly one reporter, in one commit, gated
on that field. Nothing is admitted, resubmitted or created besides that task: the child keeps its conversation, its
identity and the submission its own anchor admitted, and the reporter reacquires it by the dispatch's stable request id.
A **user fork**'s anchor names no dispatch, so it recovers nothing and still admits nothing — no empty input.

**Public-seam delta: none.** `SubagentAnchorInput`, `initial`, the `admit` guard and `createForkAnchor(tx, cid)` are
byte-identical to `1e10e8c`; the change is inside the existing `idle` handler, so **97's merge is unaffected and 96's
`prepare` phase still drops in on top**. No native patch, no new task kind, no private hook.

**Evidence.** New public regression in `apps/server/test/subagent-reports.test.ts`: "a delegation an older installation
left admitted but unreported gets exactly one reporter, with no new admission". The baseline is **real**, not a
hand-written row: `apps/server/test/subagent-legacy-anchor.ts` is the verbatim pre-07 anchor definition, and the
existing SIGKILL fixture gained a `legacy` mode that runs the real `agent_spawn` tool, the real creation seam, the real
child and the real SQLite store against it, killing inside the admit commit. The test asserts the baseline really is the
older shape (idle anchor, no reporter, the child's submission still unfinished), then that recovery yields exactly one
reporter — the one the dispatch record names, terminal, exactly one child submission and one `pi.user` entry, no second
admission — and one delivered report. RED before the fix (0 reporters recovered), GREEN after.

### Verification (this revision)

- `pnpm --filter @hepi/server typecheck` → exit 0.
- `node --test test/subagent-reports.test.ts` → **9/9 pass** (the two SIGKILL windows are unchanged and still pass).
- `node --test test/subagent-reports.test.ts test/session-delete.test.ts test/conversation-fork-source.test.ts` → 20/20.
- `node --test test/*.test.ts` (whole server package) → **398/398 pass**.
- `pnpm verify:changed --base=8054b95` → changed-typecheck PASS; changed-test FAIL once on
  `provider-config.test.ts` "the configured alias advertises the upstream image input of its model id"
  (`SyntaxError: Unexpected end of JSON input`), and a full re-run failed once on a different case of the same file.
  That file imports none of the changed files and fails ~1 run in 3 **in isolation** on an unloaded machine, so it is a
  pre-existing load-sensitive flake in an unrelated HTTP fixture, not a regression from this change; the focused suites
  and the direct `node --test test/*.test.ts` runs are green. check-docs FAIL is the known 12 pre-existing
  `.scratch/` links.
- Retained logs: `/tmp/subagent07-p2-1-linearize-probe-fixed.log` (both variants),
  `/tmp/subagent07-p2-1-delete-probe-after-e35aa6d.log` (the parent's own probe, which now hangs on
  `submission.wait` precisely because the held admission never places a run — further evidence the fix landed).
- Guides updated in the same change: `docs/architecture.md` (removal-as-last-word paragraph, and the reporter recovery
  is covered by the existing anchor paragraph) and `docs/chat.md` (removed conversation refuses control **and** commits
  `held`; a removed conversation's control reads `held`).
