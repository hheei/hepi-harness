# 13: 删除已选模型后的错误与显式恢复

**What to build:** 从模型设置删除仍被会话选择的模型后，后续请求显示原生 no_model/不可用状态，用户可显式选择有效模型并继续。

**Blocked by:** 12: 后台 Pi 模型配置读写与原生刷新

**Status:** implemented, verified and merged — merged atop 09 as 3c8b478; combined verification at that tip (core 217, server 125, missing-model driver 19 PASS). See evidence below

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 25

- [ ] 配置删除可以完成，已有会话的选择仍可识别，不静默改选其他模型。
- [ ] 浏览器经真实 Web 提交和 HTTP/SSE 观察框架 failure；错误不伪装为 assistant 回复，也不重写运行时状态机。
- [ ] 缺失模型不阻塞其他使用有效模型的会话；错误后的运行状态允许用户重新选择与再次提交。
- [ ] 显式重新选择后受控 provider 收到新选择，后端重启/浏览器重连不丢弃原选择与恢复状态。
- [ ] 复用当前 model selector、configure、generation failure 与事件/投影机制；以可见用户结果证明后端 no_model 已真正接线。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Implementation

The framework already carries everything needed, so nothing new was registered.

- `apps/server/src/server.ts`: `readRunFailure` reads the newest `pi.generation` task of the conversation from the
  committed task table and projects its terminal `failed` outcome as `{ reason, message }` — for `no_model` only,
  which is the one generation failure the framework settles without appending anything, so a provider rejection is not
  told twice — with the existing credential sanitization applied. `ServerSnapshot.failure` carries it on every
  `state` snapshot and SSE frame. A busy conversation reports none, because the run in flight supersedes the previous
  turn's outcome.
- `apps/web/adapters/durable-api.ts`: `sessionData` forwards `failure` on the snapshot it already reads.
- `apps/web/hooks/useAgentSession.ts`: `runFailure` follows both the live stream and a session read.
- `apps/web/components/ChatInput.tsx`: `RunFailureBanner` reuses the existing `ModelNoticeBanner`; the model selector
  names an unavailable selection as such instead of showing a model the deployment does not serve.
- i18n `en`/`zh-CN`/`zh-TW`: `chat.runFailureTitle`, `chat.runFailureNoModel`, `chat.modelUnavailable`.

## Evidence

`pnpm -r typecheck` passes on the merged tree; `pnpm -r test` passes (server 120, gateway 62, protocol 15,
client 9, session 3); the Web unit files covering the touched seams pass (74 tests, `lib/models-cache`,
`lib/session-reader`, `lib/i18n/registry`, `components/ModelsConfig`, `adapters/durable-api`,
`lib/project-routing`). The whole-Web source-test run keeps its 21 pre-existing failures, which are unrelated to this
ticket and unchanged by it.

`apps/server/test/missing-model.test.ts` drives the real HTTP surface with a controlled endpoint: a file-owned model
with a distinct provider id from the environment alias is selected, then deleted through `PUT /api/models-config`;
the selection is preserved; the next real submission is admitted, calls nothing, settles not-busy with only the user
entry, and reports `failure.reason === "no_model"` naming the model; a second conversation on a valid model is
served; a provider rejection is left to its assistant entry and is not projected a second time; an explicit settings
reselection plus a new submission reaches the provider and clears the failure; and after a backend restart the same
selection and the same native failure are observed again.

`apps/web/e2e/ux-missing-model-recovery.mjs` runs the real production Web UI on ports 43113/44113 against a real
backend and a real workbench gateway, with two controlled endpoints (19 assertions, all passing): the editor creates
the file-owned provider and model, the model serves a turn, the editor removes the model, the next prompt shows the
backend's own no_model failure above the composer with no assistant reply for that turn, the composer stays usable,
another session on a valid model is unaffected, a backend restart plus a browser reload keeps the selection, the
failure and the unavailable label, and the composer's own selector recovers the conversation onto the environment
model, which then reaches the controlled provider.

Limits: no live deployment or paid provider. `/api/models/enabled|refresh` and the remaining Settings TODOs are
untouched.

## Plan (source-verified, before code)

Base: `bc572e4` (merged main) → branch `impl/ux-follow-up-13` in `/tmp/hepi-ux-follow-up-12`.

### Native shapes actually available (installed pi-durable 1.1.0 dist)

| Contract | Evidence |
| --- | --- |
| `Submission { id; status(ctx); wait(ctx); abort(ctx) }` | `harness/types.d.ts:35-41` |
| `SettledSubmissionRecord = SubmissionRecord & { status: "done" \| "unanswered" }`; an `unanswered` input carries `reason: string`, `detail?: JsonValue` | `types.d.ts:31-33,320-350` |
| `Harness.submission(id, ctx)` reacquires a durable handle (restart-safe) | `harness/types.d.ts:525`, `harness.js:160` |
| `failNoModel` settles the run's inputs `unanswered/no_model` and fails the task; **no assistant entry is appended** | `harness/generation.js:235-245` |
| Task outcome `{ status:"failed", error:{ message:"No model is configured" \| "Model <p>/<m> is not available", detail:{ reason:"no_model" } } }` | `harness/generation.js:236-241` |
| Tasks are a persisted table, readable from the public transaction: `Session.commit(tx => tx.scanTasks({conversationId, kind, status, order}, limit))` | `types.d.ts:833`, `session/transaction.js:92-94`, sqlite `storage.js:315` |
| `taskGraph`/`watchTaskGraph` are live-task views only — **not** a post-terminal failure index | `harness/types.d.ts:539-542` |
| `endRun` deletes `pi.live.run`/`generation`/`tools` but leaves `pi.agent.model` untouched | `harness/live.js:24-32` |

### Correlation decision — no new app-side registry

The native tables already carry everything, so **no app-side admission document is added**:
`pi.generation`'s committed task record is keyed by `conversationId` and retains its terminal
`outcome.error.detail.reason` plus the message after restart, and `pi.agent.model` keeps the missing reference.
`Storage.scanSubmissions`/`submissionByRequest` and `Harness.submission(id)` remain available, but a scan of
*native* submissions cannot tell a superseded `unanswered` record from the newest run, so the task table is the
authoritative latest-outcome source. No submission-id mirror, no status registry, no scheduler.

### Changes

1. `apps/server/src/server.ts`
   - `attachConversation` gains a `readFailure()` committed read alongside `readResources()`: the newest terminal
     `pi.generation` task of the conversation whose `outcome.status === "failed"`, projected as
     `{ reason, message } ` with the existing `safeFailure()` sanitization applied (a credential/config message
     never reaches a client). Null while a run is live — a live run's own outcome replaces it, so a new submission or
     a reselection plus submit can never show a stale historical error.
   - `ServerSnapshot` gains `failure: { reason: string; message: string } | null`; it rides the existing
     `state` snapshot and SSE `state` frames, so a reconnect and a backend restart both observe it.
   - `GET /api/models` and `PATCH settings` are unchanged: the missing reference stays selected (no auto-fallback).
2. `apps/web/adapters/durable-api.ts` — forward `failure` on the snapshot-derived session state (existing seam).
3. `apps/web/hooks/useAgentSession.ts` — carry `runFailure` from `durable_state` snapshots into the existing
   error state and expose it; cleared when the projection clears.
4. `apps/web/components/ChatInput.tsx` / `ChatWindow.tsx` — render it through the existing
   `ModelNoticeBanner` error tone above the composer (no new banner component, no synthetic assistant bubble).
5. i18n `en`/`zh-CN`/`zh-TW`: one title + one body key.

### Tests (written red first)

- `apps/server/test/missing-model.test.ts`: file-owned provider with a **distinct id from the environment alias**,
  so removing the file entry really removes the model; deletion via the real `PUT /api/models-config`; the next
  real submission settles `busy:false` with entries `["user"]` only, `failure.reason === "no_model"` naming the
  model, and a controlled endpoint that received **zero** requests; a second conversation on a valid model still
  serves; explicit `PATCH settings` to a valid ref + resubmit reaches the controlled endpoint and clears the failure;
  a backend restart keeps both the missing selection and the observable native failure.
- `apps/web/e2e/ux-missing-model-recovery.mjs` (own free ports 43113/44113, no `main.next`, no deployment):
  real production Next + backend + gateway. Delete the model through Settings › Models, submit, assert the visible
  error and that no assistant bubble appears; assert a second session is unaffected; reselect and prove the next
  turn is served by the controlled provider; reload the browser and restart the backend to prove the old selection
  and the failure survive, then resume.

