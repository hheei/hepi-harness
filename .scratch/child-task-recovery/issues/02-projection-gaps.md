# 02 - Recovery projection gaps

Status: resolved for its own scope (G1 fixed at the execution seam). G2/G6 were recorded here as product decisions and
**approved afterwards**; both are now **delivered** — see [approved work, delivered](#approved-pending-work-2026-10-20).
This ticket's "no implementation justified" reading applies to the recovery defect question only and is superseded for
G2/G6 by that approval.
Blocked by: 01 (resolved; [evidence](01-capability-audit-evidence.md))

Implement only material user-facing/API misclassification or missing lookup found by ticket 01. Preserve native
task/submission identities; do not add a generic retry queue, duplicate journal or status derived from transcript absence.

Acceptance: focused regression test for each confirmed gap; unrelated/hypothetical issues recorded without expanding scope.

## Result

Tested source revision: the fix `41ccc78` on `impl/child-recovery-02`, branched from `integration/client-app`
`b51926b` — `git merge-base --is-ancestor 01901bc HEAD` exit 0, so ticket 01's merged audit is an ancestor of the fixed
tree; the integration tip was still `b51926b` when this branch was cut and again at reporting, so the merge-base step was
a no-op. Every row below checks only that fix, its two test files and the guides; commits after `41ccc78` on this branch
change this ticket's wording and the docs only.

### G1 — fixed: a lost gateway command answer was mislabeled at the tool seam

The audit's claim held. Trace of the actual conversion owner:

- `packages/gateway/src/process.ts` `lost()` already distinguishes the three outcomes and answers `outcome-unknown` for a
  broken stream, a response without a result frame, an unanswerable frame, a gateway that died mid-call and a transport
  error that is not the caller's abort or a named timeout (`gateway_offline` and `unauthorized` included).
- `packages/gateway/src/index.ts` `Gateway#execute`/`#answer` produce the same code from the ledger for a call left
  admitted/dispatched, and `mapSshError` maps an SSH runner's `outcome_unknown` to it.
- `packages/gateway/src/environment.ts` `exec()` was the one place that flattened it:
  `new ExecutionError(code === "timeout" || code === "aborted" ? code : "unknown", result.message ?? result.code)`. A
  lost answer with a gateway message reached the model as that sentence alone; a lost answer with no message (the ledger
  cases: a call left admitted/dispatched, a call dispatched then lost) reached it as the bare string `outcome-unknown` —
  the code's spelling in a message field, with no may-have-run statement and no call ID — under upstream's generic
  `unknown` code, indistinguishable from `execution_failed`, a denied command or a reused call ID.
- Downstream there is no richer seam: the installed `bash` tool
  (`@earendil-works/pi-durable` 1.3.0 `dist/tools/bash.js`) throws any `ExecutionError` that is not `aborted`/`timeout`,
  the Harness turns a throw into `{isError: true, diagnostics: [{code: "tool_error", message: error.message}]}`
  (`dist/harness/tool.js`) and `appendToolResult` puts those diagnostics in the text the model reads. Upstream's
  `ExecutionErrorCode` is a closed set (`aborted | timeout | shell_unavailable | spawn_error | callback_error | unknown`)
  with no unknown-outcome member, so no code value can carry the distinction.

Smallest coherent fix at the existing seam (`packages/gateway/src/environment.ts`, 9 lines): `timeout` and `aborted`
stay themselves, a definitive refusal keeps the gateway's own answer as the message, and only `outcome-unknown` is
restated under the code `"unknown"` with a message that starts `outcome_unknown:` and says the command may have run,
that its outcome is not established, that the call is never replayed, and keeps the gateway's own detail and the spent
call ID in parentheses. That message is the only channel the tool result and the model read, so the distinction survives
to the caller instead of being flattened, and the native call ID is named rather than a new identity minted, so a lookup
resolves under the identity the ledger already holds.

Not added, per the ticket's own limit and spec invariants 2/3/5/9: no task-state field, no whole-child outcome flag, no
`status.ts` change, no retry/journal/replay-policy change, no new record, no new identity, no wrapper extension or
monkey patch, no change to the workbench SSH adapter or the MCP invocation surface.

### Regression tests (both fail without the fix)

- `packages/gateway/test/execution.test.ts` — "a lost command answer says so at the execution seam, and a refusal stays
  the gateway's own answer": drives `gatewayEnvironment().forCall().exec()` against a server that streams one output
  frame then destroys the connection, asserts the `unknown` code plus the `outcome_unknown:`/`may have run`/`never
  replayed` statement and the spent scope identity `conversation-1:task-1:lost-1#1`, then asserts a named `timeout`
  answer and a `command_denied` refusal keep their own messages, and that the three executions produced exactly three
  requests (no resend under any identity).
- `apps/server/test/execution-scope.test.ts` — "a lost gateway answer reaches the model as an outcome-unknown tool
  result and is never resent": the installed `coding-tools` `bash` through `openServerHarness` with a faux model, so the
  claim is read off the committed `pi.tool-result` the model sees: `isError`, the streamed `partial-output` retained, the
  unknown-outcome statement and its own call identity present, one HTTP request total.
- Red/green: with the conversion reverted to the previous flattening, both files fail (gateway 12/13, server 1/2) and the
  server log shows the model-visible text as `partial-output` plus `[error] the gateway response ended before the call
  settled` — no may-have-run statement. With the fix, gateway 13/13 and server 2/2 pass (exit 0).

### Evidence gaps this ticket closes and does not close

Closes the assertion-only half of G3: the gateway-code seam and the model-visible tool result are now one checked
boundary. What stays G3's and ticket 04's: how a `outcome_unknown` bash result is rendered to a human user, and the
real SIGKILL/reopen matrices (G4 model-request interruption, G5 `task_too_old`/`migration_failed`).

### G2, G6 — no mislabeling, so no change in this ticket; approval arrived afterwards

The audit found no mislabeling in either, and this ticket changes nothing for them. G2 (the child's per-object recovery
vocabulary was not exposed per object to a client) and G6 (a retried preparation was reachable only by replaying the
delegation request identity) were **capability** limits, which is why no recovery *fix* belonged to ticket 02.

That is not the same as "not wanted": the user explicitly approved a **minimal** G2 surface and a **G6 retry control**
after this ticket closed. Both were then built as client surface over the facts the runtime already recorded, stated in
[approved work](#approved-pending-work-2026-10-20) and in [migration status](../../../docs/migration-status.md).

## Approved pending work (2026-10-20)

Status: **delivered 2026-10-20** — the heading keeps its original anchor so existing links resolve; "pending" below
records what the approval was, not the current state. Both halves are built. Before them: `projectRunStatus` published **one** state per conversation
(`apps/server/src/subagents/status.ts`), and a preparation retry happened only when a caller replayed the delegation
request identity through `POST /api/conversations/:id/delegate` (`apps/server/src/subagents/delegate.ts`, which calls
`host.retryPreparation` at its line 122). There was no read that projected the anchor's, reporter's and dispatch's own
phases per object, and no way for a person to ask for the retry.

Delivered, on the same runtime facts and the same identities:

- `GET /api/conversations/:id/recovery` — one child's recovery facts, per durable object, projected by
  `apps/server/src/subagents/recovery.ts` from the child's owner anchor task (its `dispatchId`), the `DispatchDoc` and
  `ReportDoc` snapshots, and the live task inspection: preparation state (`unretried-failure` / `retried`) with the failed
  attempt's own task id and the runtime's reason, the anchor's own phase, and where this dispatch's report stands
  (`waiting-child`, `delivering`, `awaiting-delivery`, `delivered`, and the record's own blocked/deleted/missing/
  interrupted words). `null` for a conversation that is no delegation's child. No second store, no new durable kind, and
  no whole-child bucket: the child's `runStatus` is left to `projectRunStatus` and is not restated here.
- `POST /api/conversations/:id/recovery` — the retry, validated against the record before anything is written:
  `identity_stale` when the named attempt is not the one the record states, `already_retried` when it already names it,
  `not_failed` / `not_a_delegation` otherwise. On success it writes `preparationRetriedTaskId = failedTaskId` through
  the existing `host.retryPreparation`, so the parked anchor of the **same** child prepares again and admits once. No
  fresh identity, no second child, nothing aborted.
- `packages/session/src/control.ts` gains `recovery()` and `retryPreparation()`; `packages/ui/src/lib/child-recovery.ts`
  reads them over the page's existing connection; `packages/ui/src/components/ChildRecoveryPanel.tsx` states the three
  facts as three words on the child itself (mounted once, in `ChatWindow`, not per catalogue row) and offers the retry
  only from the identities that read returned. One read per conversation, no stream, no polling, no automatic retry.

**G2 — preparation and delivery visibility (minimal UI).** Read the recovery facts the runtime already holds per durable
object and show them beside the child, so "reporter pending" is not flattened into `waiting-report` and a failed
preparation is visible as its own fact. Constraints the approval keeps: reuse the existing run-status and dispatch
readers as the owner; no second status store, no new durable kind, and **no `RecoveryBucket`-style whole-child projection
duplicating the vocabulary** the audit already mapped per object; no state derived from transcript absence or parent
busyness.

**G6 — retry of a failed preparation (existing identity).** Offer the retry the seam already supports: the control sends
the *existing* dispatch/request identity and names the failed attempt, which is exactly what `retryPreparation` writes
(`record.preparationRetriedTaskId = failedTaskId`). Constraints: same child, same dispatch, no second admission, no fresh
identity, and cancel is a no-op rather than an abort of anything running.

Neither half implies a fork, an automatic retry or a deployment, and neither is claimed by tickets 03 or 04.

### Evidence (2026-10-20, base `0a3d065`)

| # | Command (cwd) | Exit | Result |
| --- | --- | --- | --- |
| 1 | `node --test test/child-recovery.test.ts` (apps/server) | 0 | 3/3 — a normal failed preparation and a normal reporter waiting on a live child, each read as its own object's fact, plus the retry under the read's own identities and the two refusals |
| 2 | `node --test src/lib/child-recovery.test.mjs` (packages/ui) | 0 | the read/retry seam, the retry predicate, and the ordering fence as a pure rule |
| 3 | `pnpm --filter @hepi/server typecheck`, `... @hepi/ui typecheck`, `... @hepi/session typecheck`, `... @hepi/protocol typecheck` | 0 | no diagnostics |
| 4 | `pnpm --filter @hepi/server test` | 0 | 357/357 ordinary (includes the projection cases); `real 4.73s` |
| 5 | `pnpm --filter @hepi/ui test`, `pnpm --filter @hepi/session test` | 0 | 367/367, 57/57 |
| 6 | `node --test test/child-recovery.test.ts` (apps/server, re-run at the rebased tip) | 0 | 3/3, `real 0.59s` — acceptance only, not counted as deterministic |
| 7 | `pnpm verify:changed --base=70d9a6d` | 0 | changed-typecheck, changed-test, web-unit, check-docs all PASS at `37b7ac6` |

Case 1 of row 1 also checks the negative: a request naming an attempt the record does not state is refused as
`identity_stale` and prepares nothing (`attempts` stays 1), and the same retry asked twice answers `already_retried`. The
one child is then prepared once more and admits its task once, with no second child in the parent's listing.

### Ordinary vs acceptance selection, and the surface's own ordering (follow-up)

Row 1 above is **acceptance** evidence, not ordinary-suite coverage: it opens its own SQLite file and temporary
workspace, listens on loopback, and waits for real task progress against a wall-clock deadline. It was removed from
`apps/server`'s `test` script for that reason and stays reachable through `test:acceptance` (`node --test test/*.test.ts`).
The ordinary profile covers the same projection where it is pure — `apps/server/test/child-recovery-projection.test.ts`
over `childRecoveryFacts` and `preparationRetryOf`: one word per object from a dispatch/report record, and the retry
rule over the record alone. Same behaviour, no store, no clock, no temporary directory, and no duplicated HTTP case.

The surface gained the two corrections review found:

- A read that never answered states the failure **and** offers its own `read-again` action, so the facts and the retry
  are reachable again from the child itself once the connection is back, without navigating away and back.
- The panel's reads and retries are ordered by `createReadFence` (`packages/ui/src/lib/child-recovery.ts`): each
  attempt takes a token, and an answer is published only while its token is still newest. A refresh over an in-flight
  read, a retry over a refresh, a conversation change, a replaced connection and an unmount each move the fence on, so a
  superseded or disposed answer lands nowhere instead of over newer facts. The fence holds no data and stores nothing.

### The surface as a mounted page, not as source text (final iteration)

The surface's own test used to read the component's source and count occurrences of its implementation — a mirror of
the code that could only fail when the code was edited — and it mounted the panel through server rendering, where every
effect is skipped and the only reachable state is idle. It was deleted rather than extended. What replaces it is one
browser journey over the real component: `apps/web/e2e/ux-child-recovery.mjs` (`pnpm --filter @hepi/web
test:child-recovery`), with `ux-child-recovery.fixture.tsx` mounting `ChildRecoveryPanel` in StrictMode under a
workbench connection, exactly as `ChatWindow` does, beside an ordinary conversation that must state nothing.

The fixture replaces only the transport: every recovery request is held until the driver answers it, so the order of
arrival is decided by the test rather than hoped for. There is no backend, no store and no clock — answers are read after
two frame boundaries, and no wait is a sleep. Three journeys:

1. A read that never answered states the failure, offers `Refresh` on the child itself, and the retry that the next
   read offers sends exactly `{requestId, failedTaskId}` to the same child — then the answer's own facts replace them and
   the offer is gone.
2. A retry left in flight while the reader asks again: the read's answer is the one on screen, and the retry's late
   answer is dropped instead of restating facts over it.
3. The child is replaced while a read of the previous one is in flight — once by another conversation, once by a
   replaced connection (a new client, the previous one deliberately left undisposed). Neither late answer lands under
   the new child.

Removing the panel's `fence.settled` check from the read fails journey 3 (4 checks); removing it from the retry fails
journey 2 (3 checks). The pure fence rule keeps its own unit cases in `child-recovery.test.mjs`, where ordering is the
whole subject.

## Merge into `integration/client-app`

Merged as `2ff97b0` (`--no-ff`, `ort`, parents `b7c49b3` + `3e69260`), no conflict, no hand resolution. The merge-base was
`926341c`: row 13's own merge `a0bff56` already carried the provider tip, so this branch needed nothing against it — but
the MCP merge `b7c49b3` landed after row 13 ran, and the branch does **not** contain it
(`git merge-base --is-ancestor b7c49b3 3e69260` exits 1).

The branch's own work is 10 files, and it overlaps the merged tree in five docs/test paths and no code path the MCP
merge owns: `packages/gateway/src/environment.ts` (the conversion owner, untouched by any other branch),
`packages/gateway/test/execution.test.ts`, `apps/server/test/execution-scope.test.ts`, plus `docs/migration-status.md`
(new paragraph at ~202, against MCP's ~421 and provider's ~502) and `docs/architecture.md` (~327, against the surface
list provider ticket 01 edited at ~237). `git merge-tree --write-tree` previewed clean as `a9e3115` before the real merge.

Row 13's evidence (gateway 397, server 468, `check-docs` 12) is reused for the recovery source and that reuse is sound:
`git diff --exit-code 3e69260 -- packages/gateway/src/environment.ts packages/gateway/test/execution.test.ts
apps/server/test/execution-scope.test.ts` exits **0** at the merged tip, so the tested files are byte-identical. What
row 13 could not see is this source sitting under the gateway package's new MCP half, so the boundary runs below were
made — not a broader retest.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Combined seam (execution 13, invocation 10, control 32, provider-auth 15, startup 6) | `node --test packages/gateway/test/execution.test.ts packages/gateway/test/mcp-invocation.test.ts packages/gateway/test/control.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts` | `2ff97b0` | 0 (76/76) | `.dev/verify/merge-client-app-11/combined-gateway-seam.log` |
| Model seam of the same fix | `node --test apps/server/test/execution-scope.test.ts` | `2ff97b0` | 0 (2/2) | `.dev/verify/merge-client-app-11/server-execution-scope.log` |
| Gateway typecheck | `pnpm --filter @hepi/gateway typecheck` | `2ff97b0` | 0 | `.dev/verify/merge-client-app-11/gateway-typecheck.log` |
| Whole changed tree | `pnpm verify:changed --base=b7c49b3` | `2ff97b0` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T12-27-48-115-verify-changed/verify.json` |

`verify:changed` scoped to `@hepi/server, gateway, web` (a source-only change, so no full-workspace escalation):
`changed-typecheck` 0, `changed-test` 0 with **gateway 411** (the merged tip's 410 plus this ticket's 1 new execution
case) and **server 468** (row 13's count exactly, its new model-seam case already inside it), `web-unit` 0 (52).
`check-docs` exits 1 on the same 12 baseline links over 376 files;
`.dev/verify/merge-client-app-11/broken-tip-recovery.txt` diffs empty against the `80608d6` baseline. Provider and MCP
source survived verbatim — `git diff --name-only b7c49b3 -- packages apps` is exactly those three recovery paths.

No integration-side code change, no graph rebuild, no deploy, no push; delivered into the integration line on top of
`3e69260`.

## Commands, exit codes, logs

Run at `41ccc78` (and, for rows 1–2, at the same tree with only the conversion reverted) in
`.dev/worktrees/child-recovery-02`, Node v26.5.1, pnpm 12.4.1, after `pnpm install --frozen-lockfile` (exit 0, 783
packages reused, 0 downloaded).

| # | Command (cwd) | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| 1 | `node --test test/execution.test.ts` (packages/gateway, conversion muted) | 1 | 13 tests, 12 pass, 1 fail (the new seam test) | `.dev/verify/child-recovery-02/red-muted-gateway.log` |
| 2 | `node --test test/execution-scope.test.ts` (apps/server, conversion muted) | 1 | 2 tests, 1 pass, 1 fail (the new model-seam test) | `.dev/verify/child-recovery-02/red-muted-server.log` |
| 3 | `node --test test/execution.test.ts` (packages/gateway) | 0 | 13 tests, 13 pass | `.dev/verify/child-recovery-02/green-gateway.log` |
| 4 | `node --test test/execution-scope.test.ts` (apps/server) | 0 | 2 tests, 2 pass | `.dev/verify/child-recovery-02/green-server.log` |
| 5 | `node --test test/execution.test.ts test/process.test.ts test/host-client.test.ts` (packages/gateway) | 0 | 39 tests, 39 pass (execution/transport identity family) | `.dev/verify/child-recovery-02/gateway-family.log` |
| 6 | `node --test test/execution-scope.test.ts test/gateway.test.ts` (apps/server) | 0 | 4 tests, 4 pass (call-scope and durable-tool gateway path) | `.dev/verify/child-recovery-02/server-gateway-family.log` |
| 7 | `pnpm --filter @hepi/gateway --filter @hepi/server -r typecheck` (repo root) | 0 | two `tsc --noEmit` runs, no diagnostics | `.dev/verify/child-recovery-02/typecheck.log` |
| 8 | `node scripts/check-docs.mjs` (repo root) | 1 | 359 Markdown files, **12** broken relative links (all pre-existing, under `.scratch/`), 0 uncovered guides; the baseline tip `b51926b` reports the same 12 in 368 files | `.dev/verify/2026-10-18T11-25-00-433-verify-changed/check-docs.log` |
| 9 | `pnpm verify:changed --base=b51926b` (repo root, first run at `04ed312`) | 1 | `changed-typecheck` 0 (gateway+server+web), `changed-test` **1**, `web-unit` 0, `check-docs` 1 | `.dev/verify/2026-10-18T11-29-55-308-verify-changed/verify.json` (`dirty: false`, sha `04ed312`) |
| 10 | `node --test test/*.test.ts` (apps/server, step 9's failing package re-run whole) | 0 | 468 tests, 468 pass, 0 fail | `.dev/verify/child-recovery-02/server-family-rerun.log` |
| 11 | `node --test test/provider-config.test.ts` x3 (apps/server) | 0, 0, 0 | 5 tests, 5 pass every run | `/tmp/pc.1.log`, `/tmp/pc.2.log`, `/tmp/pc.3.log` |
| 12 | `pnpm verify:changed --base=b51926b` (repo root, re-run at the branch tip) | 1 — `check-docs` only | `changed-typecheck` 0, `changed-test` **0** (gateway 382/382, server 468/468, 0 fail), `web-unit` 0, `check-docs` 1 | `.dev/verify/2026-10-18T11-33-24-560-verify-changed/verify.json` (`dirty: false`, sha `b984478`) |

Step 9's `changed-test` failed on one case unrelated to this change: `apps/server/test/provider-config.test.ts` "a text
turn still uses the configured provider, endpoint and key" threw `SyntaxError: Unexpected end of JSON input` inside the
fixture's own `JSON.parse` of an empty stub request body — the pre-existing flake already recorded at
[verification](../../../docs/verification.md) ("an earlier run of this same revision had one `apps/server` provider-config
case fail on an empty stub response body, and the package alone re-ran 286/286 green"). Steps 10-12 are the evidence that
it is not this change: the whole server family passes, that file passes three times alone, and the identical step passed
on the tip re-run. Nothing in this ticket touches that seam.

`check-docs` exits 1 on **12** broken relative links, all under `.scratch/` and all pre-existing at that revision (they
pointed at git-ignored local `.dev/` evidence; the current documentation revision reports 0): the same 12 lines a
`diff` against `node scripts/check-docs.mjs --root=<detached b51926b worktree>` reports empty, and the base tip reports
them too (exit 1, 368 files). This ticket adds no broken link: the new `docs/migration-status.md` section links
`local-integration.md`, `architecture.md#durable-child-execution-optional-subagents-extension` and
`../.scratch/child-task-recovery/issues/01-capability-audit-evidence.md`, all of which resolve.

### Latest integration tip merged before reporting

`integration/client-app` had moved to `926341c` (provider-connection ticket 01) since the branch was cut, so it was
merged into this branch as `a0bff56` before reporting: `git merge-tree --write-tree --name-only HEAD integration/client-app`
reported no conflicted paths, the merge needed no hand resolution, and
`git diff 58aac95..a0bff56 -- packages/gateway/src/environment.ts packages/gateway/test/execution.test.ts
apps/server/test/execution-scope.test.ts docs/local-integration.md` is empty — the fix and its tests are the ones measured
above. Dependent work landed at the boundary only: `packages/gateway/src/index.ts` gained the provider-auth routes and
`docs/architecture.md`/`docs/migration-status.md` gained provider sections, none of which touch the conversion owner.
`pnpm install --frozen-lockfile` after the merge: exit 0, 1 package added, 0 downloaded.

| # | Command (cwd) | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| 13 | `pnpm verify:changed --base=integration/client-app` (repo root, at the merge `a0bff56`) | 1 — `check-docs` only | `changed-typecheck` 0, `changed-test` 0 (gateway 397/397 incl. this ticket's seam test, server 468/468 incl. its model-seam test), `web-unit` 0, `check-docs` 1 on the same pre-existing 12 `.scratch/` links (`diff` against the base list empty) | `.dev/verify/2026-10-18T11-36-32-130-verify-changed/verify.json` (`dirty: false`, sha `a0bff56`), `changed-test.log`, `check-docs.log` |

No integration merge, graph rebuild, deployment or service restart was run; the branch is delivered as `impl/child-recovery-02`.

The branch tip moves once more when this note is committed; rows 3-12 are the evidence for the product tree, and
`git diff b984478..HEAD -- packages apps` is empty for every commit after it, so nothing re-runs.

No product behavior outside the conversion owner changed; no deployment, restart, integration merge or graph rebuild was
run. `graphify-out/graph.json` is stale for the new code (its node for `gatewayEnvironment` predates this edit), so the
conversion trace above was confirmed in source and in the installed `pi-durable` 1.3.0 dist, one narrow query per symbol.
