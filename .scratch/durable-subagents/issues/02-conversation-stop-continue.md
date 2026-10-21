# 02: 将可信 Stop／Continue 接入会话 API

**What to build:** 用户通过既有会话 HTTP 控制停止、查询并继续同一会话；停止来源、当前状态与操作收据可重取，网络丢答复不会撤销已提交意图。

**Blocked by:** [01 — 交付持久原生输入控制](01-native-input-control.md)

**Status:** resolved

**Labels:** ready-for-agent

**Spec:** [D01](../spec.md#d01)、[D02](../spec.md#d02)、[D07](../spec.md#d07)、[D08](../spec.md#d08)、[D09](../spec.md#d09)；[验收 A08、A09、A10、A20、A22](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] ConversationOperations.stop/send 对接原生控制事务；既有 message/busy/abort 写入口共用规则，新增明确 continue 和控制状态投影，不形成第二套调度 API。
- [x] caller 从认证宿主/工具上下文获取；用户停止后模型输入/resume 被拒绝、无新 dispatch，agent-stop 不降级用户来源；用户明确 Continue/立即输入可恢复，queue-only 输入保持 held。
- [x] stop 响应区分已接纳/stopping/普通范围已 idle，返回稳定请求收据与当前控制状态；重复等待不再次清退后来输入。
- [x] continue 遇旧取消范围返回 stopping/可重试，保留输入；旧操作结果不能覆盖较新当前状态，空 continue 不制造用户消息。
- [x] 普通 stop 不使用穿越 background 的全范围取消；与现有普通用户队列撤回及草稿行为兼容。
- [x] 通用输入/控制统一拒绝 tombstone 目标；错误响应携带可解释的当前状态，不以新 requestId 自动重发未知输入。
- [x] HTTP 断开及真实进程重开后能重取同一操作收据并保持最新暂停来源；既有默认聊天流程继续成立。

## Delivered

**One seam, no second scheduler.** `ConversationOperations` gains `stop`, `continue`, `send` and `control` beside
`spawn`/`get`/`read` in `apps/server/src/conversation-operations.ts`; each one delegates to the patched runtime's own
atomic transaction and holds no state of its own. The HTTP routes and any model tool that later calls them share it, and
the existing `messages`, `busy` and `abort` writes now pass through the same `send` rule instead of a private
admission path. `abort` keeps its native contract unchanged (withdraw the queue, mark the ordinary scope, wait, no
hold).

**Trusted caller.** The HTTP surface is the user and a model tool is the agent; `stopSource`/`caller` is supplied by the
route, never read from a body, and the native control record keeps refusing a mismatched caller. An agent's dispatch on
a held conversation is refused `source_locked` before anything is admitted, an agent resume cannot clear a user stop,
and `send(..., resume: false)` — the composer's steer/follow-up and the framework's report path — is admitted as a
queued item under the hold for either caller.

**Routes.**

| Route | Body / query | Answer |
| --- | --- | --- |
| `POST /api/conversations/:id/stop` | `{ requestId, expectedControlRevision? }` | 202 `{ status: accepted\|held, drain: idle\|stopping, control, receipt }`; 409 `revision_mismatch` with the unchanged control |
| `POST /api/conversations/:id/continue` | `{ requestId, expectedControlRevision?, text?, images?, whenBusy? }` | 202 `{ status: resumed\|stopping\|allowed, submissionId?, control, receipt }`; 409 on a refused resume |
| `POST /api/conversations/:id/messages` | unchanged | 202 `{ requestId, submissionId?, status?, control }`; a held conversation is resumed by this dispatch, and `submissionId` is the submission the caller's own request id names in every path |
| `POST /api/conversations/:id/busy` | unchanged | 202 with the control; queue-only, never resumes |
| `GET /api/conversations/:id/control` | `?requestId=` | 200 `{ control: <latest>, receipt: <that request or null> }` |

A removed conversation answers 409 `session_deleted` on all four writes (including `recall-queue`); its control read
still answers, because the records are retained and the refusal is about acting on it.

**Wire.** `ServerSnapshot`/`ServerDelta` carry `control: { state, revision, stopSource?, stoppedAt? }` beside the
`queuedMessages` it governs, so a client reads "held" and the item it is holding from one frame; the browser's
`projectAgentState` reads both from that same frame. `ControlReceipt` and `ControlStopSource` are declared once in
`packages/protocol`.

**Request identity.** One dispatch is one request id, end to end: a resume's optional input is admitted under the
**resume's own** id, and a message keeps the caller's own id whichever path admits it — ordinary, held resume, or
queue-only. That is what `GET /api/conversations/:id/submissions?requestId=` answers, and what the browser's
pending-turn correlation and the `submissions` projection on the state frame already match a turn by, so a send whose
answer was lost is recoverable by the id the caller generated rather than by a second identity it never chose. A
dispatch whose id already names a submission is answered with that submission (plus its resume receipt when one was
recorded) instead of being admitted twice; a `continue` whose id already names one asks for the held queue and does not
hand that id back to the admission, because a known id is answered early there and would run no boundary, clearing the
hold while leaving the queue where it was. A send that reaches its resume after a concurrent explicit continue has
already ended the hold (`allowed`) admits its message then, so a two-tab continue/send race neither drops the message
nor admits it twice.

### Review correction: recovery identity

An earlier revision admitted the resume's input under `<requestId>:input`. That broke recovery for exactly the case it
was meant to serve: a held `/messages` whose HTTP answer was lost left `GET /:id/submissions?requestId=<original>`
answering `null` after a real admission, and the pending-turn projection carried the derived id instead of the one the
client holds. The suffix is gone; the native admission's own known-id early answer is handled at its owner instead of
worked around. Recorded, not repaired: the concurrent `continue`/`send` interleave is not reproducible in forty
concurrent attempts because the commit that clears the hold is one native transaction, so its `allowed` arm is covered
by the invariant test rather than by a forced window.

## Evidence

All commands ran on `impl/durable-subagents-02` (the ticket-01 worktree, branch renamed), merged with the
`integration/durable-subagents` tip `d0411fc` before the final run; local only, no deployment and no remote-host build.
Model requests are the faux provider's own counter; every assertion reads observable product state — HTTP status, the
committed control record and revision, the durable receipt, the queued text, the committed transcript and the SQLite
file — rather than a helper's internals.

| Command | Result |
| --- | --- |
| `node --test test/conversation-stop-continue.test.ts` (apps/server) | exit 0, 18 pass, 0 fail; 3 of the new tests fail against the pre-correction source (red proof) |
| `pnpm typecheck:server` | exit 0 |
| `pnpm typecheck:protocol` | exit 0 |
| `pnpm --filter @hepi/session typecheck` | exit 0 |
| `pnpm test:server` | exit 0, 369 pass, 0 fail (the 18 tests included) |
| `pnpm test:protocol` | exit 0, 47 pass, 0 fail |
| `pnpm test:web:unit` | exit 0, 123 pass, 0 fail |
| `pnpm verify:changed --base=integration/durable-subagents` | exit 1 **only** on `check-docs`: changed-typecheck 0, changed-test 0 (protocol 47, session 34, gateway 185, server 369 — all 0 fail), web-unit 0. Raw log and per-step exit codes: `.dev/verify/2026-10-16T10-41-23-176-verify-changed/` (sha `7eeb6dc`, dirty false). An earlier run at the same sha failed `changed-test` once on `packages/gateway`'s SSH-daemon fixture, which passes alone and on rerun — a load-sensitive fixture, unrelated to this change. |

`check-docs` reports the same **12 broken relative links, all pre-existing and all in `.scratch/` files this ticket did
not touch**; none names a file this change edited, and the count matches the ticket-01 and ticket-05 baselines.

Test coverage, in the terms the acceptance criteria state them, after the recovery-identity correction: a held send
keeps the caller's own request ID, so the retry answers the submission that ID names, `GET /:id/submissions?requestId=`
resolves it after a real admission, and the `submissions` projection carries no derived identity; a `continue` whose ID
already names a submission consumes the held queue rather than stranding it; a replay of an ordinary send after a later
stop re-admits nothing and does not resume the hold; a `continue` and a send racing on one hold both answer coherently
and admit the message once; held admission queues and only continue consumes it;
an immediate send while the stop drains is a `stopping` intent the same request id finishes; a replayed stop neither
sweeps the input that arrived later nor aborts a run started after the continue; an `expectedControlRevision` conflict
changes nothing; the control read answers the latest state beside one request's own receipt; an empty continue consumes
the held queue and appends no message; a stop withdraws the input queued at its commit point and keeps what arrives
after; a removed conversation refuses all four writes while its control read still answers; an agent cannot resume a
user stop and a queue-only input never does, over the core seam; a stop leaves a background task running; a lost stop
answer is recovered from the durable receipt after a **real backend restart over the same SQLite file**; a continue on
an allowed conversation answers `allowed` and starts no run; a resume with text admits it in the same commit and a
retry does not admit it twice; and the control rides the state frame and the stream baseline beside the queue it
governs.

## Verification seam

- 真实 HTTP → ConversationOperations → patched runtime/SQLite；含可信用户与模型 caller、旧 continue/new stop 交错。
- 受控背景工作仍执行；普通工作实际退出前不能给出已停止成功。

## Scope and handoff

Web Continue 与逐项队列编辑交给09；本票提供其稳定控制契约，不引入 child 执行。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。
