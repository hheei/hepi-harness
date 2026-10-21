# 01: 交付持久原生输入控制

**What to build:** 通过公开 runtime API 停止一个会话后，所有输入保持排队，直到获准继续；同一 SQLite 重开仍保持该意图。此票是明确的原生前置交付，可由受控 harness 演示，不包含 Web 或产品 HTTP 编排。

**Blocked by:** None (can start immediately)

**Status:** resolved

**Labels:** ready-for-agent

**Spec:** [D06](../spec.md#d06)、[D07](../spec.md#d07)、[D08](../spec.md#d08)、[D16](../spec.md#d16)；[验收 A08、A09、A10、A20、A21](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 以固定版本、保留来源/许可证的 pnpm 补丁提供原生 allowed/held、可信停止来源、控制版本和持久操作收据；缺省聊天与原生 abort 默认契约不变。
- [x] 逐一驱动空 Inbox 直接 admission、final、postTools、reset/handover、可见 write/compaction 等路径；held 下 input queued，不消费、不启动回合；display-only write 不解除。
- [x] stop 在同一提交持久 held、撤回提交点既有输入、标记普通范围取消；之后输入保留，background 范围不误取消；同一 stop 重试不二次清退。
- [x] 原生控制事务允许宿主 caller/停止来源校验、expectedControlRevision、receipt 与状态/队列修改原子组合；不以多个 await 或内存锁代替。
- [x] continue 在旧取消范围未 idle 时返回 stopping 且不解除 held；idle 后从同一 Inbox 原子恢复和消费，空 continue 无虚假消息，保留队列模式。
- [x] 同请求可重取收据；较早 continue 的迟到重试不覆盖新 stop；用户停止来源不能被模型或 agent-stop 降级。
- [x] 真实 SIGKILL 后恢复最新 held/abortRequested/receipt；全局 resume 不解除会话 held。旧 SQLite 迁移与旧 runtime 对不兼容数据的明确拒绝得到实证；不能成立则记录阻塞，不发布忽略 held 的回退。
- [x] 审阅修正：被拒绝/重放的 stop 不写入 abort 标记，活动 run 正常完成；pending continue 的 settle 先做 caller/来源校验，requestId 不构成授权，替换 caller 不改状态、不投放输入。

## Delivered

**Patch.** `patches/pi-durable-1.3.0-input-control.patch`, declared in `pnpm-workspace.yaml` (`patchedDependencies`) and
hashed in `pnpm-lock.yaml`; pnpm materializes it as
`node_modules/.pnpm/@earendil-works+pi-durable@1.3.0_patch_hash=...`, so the content-addressable store and every other
checkout keep the unpatched bytes. Package, version and MIT license are unchanged
(`@earendil-works/pi-durable@1.3.0` from `https://github.com/earendil-works/pi` at `4954d760504c11df9b2cbdc040346107b6a8153d`);
provenance is recorded in [upstream sources](../../../docs/upstream-sources.md#patched-runtime-dependency). The patch
changes only `dist/harness/{inbox,submissions,generation,scheduler,harness,types}.{js,d.ts}` and adds
`dist/harness/control.{js,d.ts}`.

**Native state.** The control record is part of the conversation's own `pi.inbox` document, now definition **version 2**:

```ts
type InboxControl = {
  state: "allowed" | "held";
  revision: number;
  stopSource?: "user" | "agent";
  stoppedAt?: number;
  receipts: InboxControlReceipt[]; // newest first, bounded to 64 per conversation
};
type InboxControlReceipt = {
  requestId: string;
  operation: "stop" | "continue";
  status: "accepted" | "held" | "rejected" | "stopping" | "resumed" | "allowed";
  reason?: "revision_mismatch" | "source_locked" | "superseded";
  revision: number;
  stopSource?: "user" | "agent";
  caller?: "user" | "agent";
  at: number;
};
```

**Public native API (for ticket 02).**

```ts
Conversation.control(context): Promise<{ state; revision; stopSource?; stoppedAt? }>;

Conversation.stop(request: {
  requestId: string;                     // stable identity; a retry returns the stored receipt
  stopSource: "user" | "agent";          // trusted host caller, never the model's own claim
  expectedControlRevision?: number;      // optional optimistic-concurrency guard
}, context): Promise<{
  status: "accepted" | "held" | "rejected";
  reason?: "revision_mismatch";
  drain: "idle" | "stopping";            // whether the ordinary scope is already idle after the commit
  control: { state; revision; stopSource?; stoppedAt? };
  receipt: InboxControlReceipt;
}>;

Conversation.continue(request: {
  requestId: string;
  caller: "user" | "agent";
  expectedControlRevision?: number;
  input?: { content: UserInput; entry?: InputEntry; requestId?: string; whenBusy?: "steer" | "followUp" };
}, context): Promise<{
  status: "resumed" | "stopping" | "allowed" | "rejected";
  reason?: "revision_mismatch" | "source_locked" | "superseded" | "caller_mismatch";
  control: { state; revision; stopSource?; stoppedAt? };
  receipt: InboxControlReceipt;   // on a refused replay: the pending receipt its own caller recorded, unchanged
}>;
```

Contract, in the order ticket 02 needs it:

- **Source trust.** `stopSource`/`caller` come from the host caller. A user stop can only be cleared by `caller: "user"`
  (`rejected`/`source_locked`); an agent stop also accepts an explicit `caller: "agent"`. A later agent stop never
  downgrades a stored user source, and a rejected request changes no state and creates no dispatch.
- **A request ID is not authorization.** Replaying a request the conversation already settled returns its receipt
  verbatim and changes nothing. The validation that decides a still-pending `continue` runs before the settlement it
  would perform: a pending user stop refuses an agent caller (`rejected`/`source_locked`) and a pending request
  recorded by one caller is refused for another (`rejected`/`caller_mismatch`). Such a refusal writes nothing, so the
  request keeps the receipt its own caller recorded and that caller can still settle it once the drain has ended.
- **stop decides before it marks.** The decision is taken first in the same commit: a stop refused for a stale
  `expectedControlRevision` or answered from an older receipt commits its answer without abort-marking a live task or
  withdrawing an input, so a run it did not stop keeps running to its answer.
- **Receipts.** One durable receipt per (`operation`, `requestId`), returned verbatim on a retry, including its original
  `at`, status and reason. A first `continue` while the drain runs records `stopping`; retries read that same receipt.
- **Revision.** `revision` starts at 0 and advances on every recorded state change: the first stop, every newly recorded
  stop intent while held (including an upgrade from agent to user), and a resume. A rejected request does not advance it.
  A pending continue stores the revision it observed; if the revision moved (a later stop), the retry is
  `rejected`/`superseded` and `held` stands.
- **`drain`** is the native fact `TaskScheduler.isIdle(conversationId)` after the stop commit; `continue` re-reads it in
  the same commit that clears `held`, so no fixed delay is involved.
- **Empty continue.** Clears `held` and consumes the same inbox; with nothing queued it starts no run and appends no
  message. `input` is admitted in that same commit through the runtime's own admission, so it places/queues exactly as
  an ordinary idle submit would.

**Tests.** `apps/server/test/native-input-control.test.ts` (15 tests: admission paths, stop withdrawal and idempotence,
drain guard, supersession, source trust, empty continue and queue modes, revision conflict, background isolation, native
abort unchanged, held projection, and the four review regressions below), `native-input-control-migration.test.ts` (2),
`native-input-control-crash.test.ts` (3 SIGKILL windows) plus `native-input-control-fixtures.ts` and
`native-input-control-crash-child.ts`. The fixture holds a chosen model request by number (`holdRequests`) so a test
can observe a real live run's `abortRequested` instead of racing it.

## Evidence

All commands ran on `impl/durable-subagents-01`, merged with the `integration/durable-subagents` tip
(`85c2c84`, after `8edd46a` and `e784b45`) before the final run; local only, no deployment and no remote-host build. Model requests are the faux
provider's own counter; every assertion reads native state (control record, submission status, `Harness.inspect`,
committed entries, the SQLite file).

| Command | Result |
| --- | --- |
| `node --test test/native-input-control.test.ts` (apps/server) | exit 0, 15 pass, 0 fail |
| `node --test test/native-input-control-migration.test.ts` | exit 0, 2 pass, 0 fail |
| `node --test test/native-input-control-crash.test.ts` | exit 0, 3 pass, 0 fail; each kill stage really dies with SIGKILL (`status: null`, `signal: "SIGKILL"`) |
| the three files together | exit 0, 20 pass, 0 fail |
| `pnpm typecheck:server` | exit 0 |
| `pnpm verify:changed --base=integration/durable-subagents` | exit 1 **only** on `check-docs`: workspace-typecheck 0, workspace-tests 0 (apps/server 327 pass, 0 fail), web-unit 0, script-tests 0, check-entrypoints 0. Raw log and per-step exit codes: `.dev/verify/2026-10-16T08-46-50-419-verify-changed/` (sha `32a26e7`, dirty false; the only later commit touches this ticket file, which the selector lists under `ignoredFiles`). |

`check-docs` reports **12 broken relative links, all pre-existing**: the same command run in a detached worktree of the
untouched integration tip (`git worktree add --detach .dev/baseline-checkdocs e784b45`, removed again) also reports those 12,
and none of them is in a file this ticket touched. The first run of this change briefly had 14 because the two links to
`docs/upstream-sources.md#patched-runtime-dependency` did not resolve; the heading was renamed without its date and both
links resolve again.

SIGKILL windows: stop commit → drain (held, stop source, the withdrawal of the input queued before the stop and the
report queued after it all survive the kill; restart scheduling serves no model request); continue commit → receipt
(`allowed`, the same `resumed` receipt and one answered report, no duplicate); inbox migration commit (the record is
version 2 afterwards and a version 1 reader refuses it).

Migration and incompatibility: a version 1 `pi.inbox` record (rewritten by the fixture exactly as unpatched 1.3.0
wrote it: one base revision, `version = 1`, value `{ items }`) reads as `allowed` with its queued items, and the first
commit that acquires the document stores the version 2 base. The unpatched runtime's refusal is exercised through the
runtime's own version check by defining the pre-patch document (`defineDoc` with `version: 1`) and reading a version 2
record with it: it throws `Document N (pi.inbox) has newer version 2 than 1` instead of reading `held` as `allowed`. That
is the same `checkRecordVersion` path an installed unpatched 1.3.0 takes; no unpatched install is needed in the test.

## Review fixes (2026-10-16)

The integration review of this ticket found two material defects in the narrowed control invariants. The ticket was
reopened, both were fixed in the patch, and each fix has a regression that fails without it.

**P1 — a refused or replayed stop still aborted the run.** `TaskScheduler.stopConversation()` wrote the abort marks of
the conversation's ordinary live tasks *before* the caller's decision was known, so a stop rejected for a stale
`expectedControlRevision`, and a retry answered from an older receipt, aborted a run they had not stopped. The
decision now runs first and the marks and the withdrawal happen only when it says the stop takes effect now; the
storage scan still precedes every write.

- Red: with the decision moved back after the marks (the pre-fix body restored in the installed patched package),
  `a rejected stop leaves the live run it did not stop alone` fails with `notStrictEqual(abortRequested, true)` →
  actual `true`, and `replaying an accepted stop does not abort the run that started after continue` fails the same way.
- Green: both pass against the patch, each asserting `abortRequested` is not `true` before and after the run settles,
  that the run's answer entry lands, and that the provider served exactly one request.

**P1 — a pending continue could be settled by another caller.** `decideContinue()` returned `{ kind: "pending" }` for a
pending receipt without re-checking who was asking, and the settlement path then cleared `held`, resumed and admitted
that caller's input. A user's pending request replayed by `caller: "agent"` therefore bypassed `source_locked`. The
validation now runs before the settlement: `source_locked` when the recorded user stop does not accept this caller,
`caller_mismatch` when the request was recorded by a different caller. A refusal writes nothing — the request keeps the
receipt its own caller recorded, so the caller that recorded it can still settle it — which is asserted directly.

- Red: with the pre-fix `decideContinue()` restored, `a pending continue is settled only under the stop source it
  recorded` fails with `status` actual `'resumed'`, expected `'rejected'`, and `a pending continue is settled only by
  the caller that recorded it` fails the same way.
- Green: both pass, asserting the substituted call changes neither the control state nor the transcript, admits no
  input, and that the recording caller's retry still resumes.

Both red runs used the real patched package with only the reviewed code restored, so the regressions exercise the
native seam rather than a double. The whole suite was then re-run over a fresh `pnpm install --frozen-lockfile` of the
committed patch (two patched virtual-store instances, both carrying the fix) to rule out a stale installed copy.

**Recorded, not repaired.** `continue`'s optional `input` is admitted through native admission, which answers a
`requestId` that already identifies a submission with that submission's id and then runs no boundary
(`submissions.js` early return). A continue whose input reuses the request ID of an item still queued therefore
answers `resumed` while the queue stays where it was. Ticket 02 admits its own inputs with fresh request IDs; revisit
if a caller needs to settle a held queue by replaying a queued input's identity.

## Limits and notes

- **final/postTools boundaries are unreachable while held.** A stop marks the conversation's ordinary live tasks for
  abort in the same commit, so a running generation never reaches its final or post-tools handover afterwards. Those
  guards are defense in depth over the same `applyBoundary` predicate the admission-path tests exercise
  (empty inbox direct admission, idle inbox with queued items, visible write, reset, compaction's write admission).
  Revisit if a background-owned generation of the same conversation ever exists.
- **Receipt retention is bounded** (64 per conversation, newest first). An older `requestId` whose receipt was dropped
  is re-evaluated as a fresh request rather than answered from history.
- **Product orchestration is not in this ticket.** No HTTP route, Web control or model tool calls `stop`/`continue`
  yet; ticket 02 wires the trusted caller and ticket 09 the per-item Web queue.
- **A queued input's identity is not a continue payload.** See "Recorded, not repaired" above: `continue({ input: {
  requestId: <an id already queued> } })` deduplicates in native admission and leaves the queue in place.
- **Cross-owner cancellation is unchanged.** A queued input below an abort-marked owning task is still withdrawn by the
  runtime's own cascade; this ticket only guarantees that a stop does not withdraw input arriving after its commit point
  for the conversation it stopped.
