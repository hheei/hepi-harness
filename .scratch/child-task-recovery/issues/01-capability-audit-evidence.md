# Child task recovery — capability audit

Status: complete; audit only, no product behavior changed.
Tested source revision: `95f9257` (`integration/client-app`), branched as `impl/child-recovery-01` in worktree
`.dev/worktrees/child-recovery-01`. The audit artifact and its assertion test are the only commits on top of that
revision, so every product-facing claim below was measured against `95f9257` itself.
Runtime: `@earendil-works/pi-durable` 1.3.0 with `patches/pi-durable-1.3.0-input-control.patch`, Node v26.5.1.
Related: [spec](../spec.md), [ticket 01](../issues/01-capability-audit.md), [pi-durable design](https://earendil.com/posts/pi-durable/).

This is the ticket's required evidence table. It states what the code and its tests already do, in the spec's recovery
vocabulary, and separates verified facts from gaps. It adds no runtime behavior: the only new file is a read-only
assertion test (`apps/server/test/recovery-capability-audit.test.ts`) pinning the three claims a later edit could
silently falsify.

## 1. Method and limits

Read at `95f9257`: `apps/server/src/subagents/{anchor,reporter,delegate,extension,host,status}.ts`,
`apps/server/src/server.ts` (submission lookup, fork route, catalogue status, delegation route),
`apps/server/src/conversation-items.ts`, `packages/gateway/src/{environment,execution,index,process,host-client}.ts`,
the installed `pi-durable` 1.3.0 `dist/harness/tool.js`, and the tests cited per row. Navigation used one narrow
`graphify query` per symbol (`anchor admission`, `checkpoint`, `outcome_unknown`) confirmed in source; the graph has
no node for `submissionByRequest`, so that seam was found by focused search.

Verified by execution at this revision (commands, exit codes and logs in §6): the subagent, reporter and
preparation suites (36 tests), the acceptance family (10 tests, all real `SIGKILL`), the gateway identity family
(106 tests) and the submission/fork family. **Every "verified" row below is a claim those logs actually contain**, not
an expectation; the row names the test that states it.

Limits, stated so they are not read into the evidence:

- All `SIGKILL` evidence is **process-kill** evidence over one SQLite file. Nothing here measures power loss, disk
  corruption or a torn WAL. `pi-durable`'s own durability under those conditions is the storage adapter's business.
- No test kills the **gateway** process while a child's command runs. Gateway outcome-unknown evidence is
  transport-level (a lost response), not a killed gateway host.
- No test exercises `task_too_old` or `migration_failed` through a real old definition; only `missing_task` is
  measured end to end. The other two reasons are the runtime's own vocabulary surfaced by the projection.
- No test measures a child's `outcome_unknown` bash result being rendered to a user; the gateway family measures the
  result code, the backend family measures the interrupted (unsafe) path. See gap G3.

## 2. Capability matrix

Recovery is per durable object, as the spec requires. "Owner" is the durable record that decides; "action" is what a
restart actually does, not what a surface says.

| # | Object / state | Bucket | Owning durable identity | Action on restart | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Child conversation + dispatch record created, anchor's `admit` not yet run | checkpoint-resumable | child record; `hepi.subagent.dispatch` doc keyed `(delegating, requestId)`; anchor task `hepi.subagent-anchor` | Anchor resumes `admit`, submits the task text under the dispatch's own request id | `subagents.test.ts` "a real SIGKILL in the commit window…" (`facts.admissionDurable === false`) |
| 2 | Child admission committed, `agent_spawn` receipt not returned | checkpoint-resumable + safely replayable | `pi.tool` task of the call (checkpoint `execute`, `replay: "safe"`); native submission by `requestId` | Tool reruns; `delegate` finds `existingDispatch` and answers the same child; anchor's `admit` re-submits the same `requestId` and is answered with the existing submission | `subagents.test.ts` "receipt window…" (asserts one child, one `pi.user` entry, result text `already created by this call`); `extension.ts:158` |
| 3 | Second dispatch (`agent_send`) admitted, dispatch record not yet written | checkpoint-resumable | native submission under the caller's `requestId`; `pi.tool` task `replay: "safe"` | Rerun re-admits the same id; native admission answers the first submission, then the record + reporter are written once | `subagents.test.ts` "a real SIGKILL between a second dispatch's admission and its record keeps one task and one report"; `extension.ts:265` |
| 4 | Model request interrupted mid-generation | checkpoint-resumable (new request from checkpoint) | `pi.generation` task checkpoint; committed partial stays as an aborted entry | Runtime re-issues the request from the checkpoint; the partial answer is retained and marked aborted | `pi-durable` README §tools/generation; not re-measured here (see G4) |
| 5 | Unsafe tool executing at kill (`write`/`edit`/`bash`) | interrupted/unknown — no replay | `pi.tool` checkpoint `{phase:"execute", replay:"unsafe"}`; current tool definition also has no `replay` | Task settles `failed` with an `interrupted` result; the body never runs again; external effect count unchanged | `acceptance-failure.test.ts` "a tool call the store says was executing is interrupted after a real SIGKILL and its side effect is never repeated" (side-effect log stays `["published"]`, result matches `interrupted and may have partially run`); `recovery-capability-audit.test.ts` asserts no coding tool declares `replay` |
| 6 | Replay-safe tool interrupted (`agent_spawn`/`agent_send`) | safely replayable | tool's own `replay: "safe"` + stored checkpoint `replay: "safe"` (both required) | Reruns once; resolves to existing identities as in rows 2–3 | `pi-durable` `dist/harness/tool.js` (`if (replay === "safe" && tool?.replay === "safe")`); rows 2–3 |
| 7 | Gateway **definitive refusal** of a command | terminal failure (not unknown) | gateway answer `{ok:false, code}`; ledger row `completed` | Reported as that code; nothing retried | `gateway/test/execution.test.ts`; `packages/gateway/src/index.ts` `#answer` |
| 8 | Gateway **lost mutation response** (command dispatched, answer lost) | outcome_unknown — no blind resend | gateway ledger row under `gateway:workspace:callId` (SQLite `calls.sqlite`), fingerprint of the request | Same call id answers `outcome-unknown` from the ledger; nothing is re-executed | `gateway/test/execution.test.ts` "answers a call left running at restart as unknown instead of running it again", "reports a lost response as unknown and sends nothing again"; `host-client.ts:286` for host mutations |
| 9 | Submission outcome unknown to a **client** (browser lost the answer) | outcome_unknown — looked up, never resent | native submission by `requestId`; `GET /api/conversations/:id/submissions?requestId=` | Read-only lookup answers the durable record, or `null`; no second submit | `durable-submissions.test.ts` "the recovery lookup answers the durable record, and never invents one"; `server.ts:2362` |
| 10 | Child settled, reporter's `wait` interrupted | checkpoint-resumable | reporter task `hepi.subagent-reporter` (phase `wait`), child submission by dispatch request id | Reporter reacquires the same submission (native admission by id) and waits it out; one report record | `subagent-reports.test.ts` "a real SIGKILL between the child's settlement and the delivery keeps one report identity across the reopen" |
| 11 | Report admitted into recipient, reporter's ack not committed | checkpoint-resumable | reporter phase `deliver`; recipient admission under `<dispatchId>:report` | Delivery is re-attempted under the same report id; native admission answers the existing queued/terminal item, no duplicate | `subagent-reports.test.ts` "a real SIGKILL between the report's admission and its acknowledgement keeps one queued item and one submission"; `reporter.ts:55`; `recovery-capability-audit.test.ts` pins the derived id |
| 12 | Report cancelled/edited by the user, reporter reruns | terminal for that item | recipient Inbox item's own settled state | Rerun does not revive or overwrite the cancelled item | `subagent-reports.test.ts` "a report a user cancelled is never revived or overwritten when the reporter runs again" |
| 13 | Recipient removed before delivery | terminal (own reason) | `ReportDoc` `delivery: "recipient_deleted"`; reporter outcome `completed` | Recorded once; no retry, source result preserved | `subagent-reports.test.ts` "a removed recipient terminates the delivery as recipient_deleted…" |
| 14 | Delegation predating the reporter (v1 store) | checkpoint-resumable (recovery branch) | dispatch record without `reporterTaskId`; anchor's permanent `idle` phase | `recoverReporter` creates exactly one reporter in a re-read-guarded commit; nothing re-admitted | `subagent-reports.test.ts` "a delegation an older installation left admitted but unreported gets exactly one reporter…"; `anchor.ts` `recoverReporter` |
| 15 | Context preparation (compaction) interrupted | checkpoint-resumable | anchor phase `prepare` + `checkpoint.compaction` task id; child-owned `pi.compaction` task | Resume reads the compaction task's own outcome instead of compacting again | `context-preparation.test.ts` "a SIGKILL between the preparation commit and the admission resumes one child and admits it once"; "a store reopened paused while a preparation is live has no child submission and no child model request" |
| 16 | Preparation failed, caller has not retried | blocked-on-caller (parked, stated) | `DispatchDoc.preparationFailedTaskId` + `preparationError` + `preparationOutcome` | Anchor parks and watches its own record; nothing retries by itself; state survives SIGKILL | `context-preparation.test.ts` "a stated preparation failure survives a SIGKILL, and the same dispatch identity retries it after the kill"; `subagents.test.ts` "parked" window |
| 17 | Explicit preparation retry | explicitly retried preparation | `preparationRetriedTaskId` naming the failed attempt's task id | Same child, same dispatch, same admission; exactly one new attempt; asking twice is asking once | `context-preparation.test.ts` "a failed preparation is retryable under the same dispatch identity, without a second child or admission"; `anchor.ts` `parkFailed`/`waitForRetry` |
| 18 | Task definition missing in this build | blocked | `TaskInspection.state = {kind:"blocked", reason}` | Stated with the runtime's own reason; child history and owner edge stay readable; nothing faked | `acceptance-failure.test.ts` "a store whose task definition this build does not have states missing_task and keeps the child readable"; `recovery-capability-audit.test.ts` pins all three reasons |
| 19 | Task abandoned by restart | interrupted | `task.record.abortReason === "restart"` | Projected as `interrupted · restart`; not replayed | `recovery-capability-audit.test.ts` (projection); `status.ts` |
| 20 | Child finished, its report still queued in the recipient | waiting-report | recipient Inbox queued item with `source.kind === "report"` | Projected as `waiting-report`; the item is consumed at the recipient's own boundary | `status.ts`, `server.ts` `catalogueFacts`; `subagent-reports.test.ts` "a report queues at the running recipient's own boundary…" |
| 21 | User stop committed, ordinary scope not drained | checkpoint-resumable (stopping) | native control record `held` + `abortRequested`; control receipt | `stopping` until the scope drains, then `held`; a late report stays queued | `acceptance-recovery.test.ts` "a real SIGKILL in the stop's undrained window…"; `native-input-control-crash.test.ts` |
| 22 | Continue committed, HTTP answer lost | checkpoint-resumable | control receipt by `requestId`; expected control revision | Retry answers the original receipt; the kept item is consumed once | `acceptance-recovery.test.ts` "a real SIGKILL inside the continue's own answer…"; `conversation-stop-continue.test.ts` "a lost stop answer is recovered from the durable receipt after a real process restart" |
| 23 | Explicit user fork of a history position | explicit user fork | native fork record `(parent conversation, at entryId)`; the branch's own background anchor | Branch is created once by its `requestId`; original untouched; no live run/queue/control copied | `conversation-fork-source.test.ts` (fork source, as-of config, replay, foreign position refusal); `session-fork.test.ts` (branch `busy:false`, `control.state:"allowed"`, empty queue while the source's run is in flight) |
| 24 | Parent stop while a child runs | not a recovery state | background placement of anchor + reporter | Neither anchor nor child is marked by the parent's stop | `subagents.test.ts` "a user stop of the delegating conversation leaves the child and its anchor running"; `conversation-stop-continue.test.ts` "a stop leaves a background task of the same conversation running" |

Every inspected task state lands in exactly one of: checkpoint-resumable, safely replayable, interrupted/unknown,
blocked, terminal, or explicit fork. `interrupted`, `blocked`, `outcome_unknown` and `failed` are kept distinct in
both the runtime's own vocabulary and the projection (`status.ts`).

## 3. Crash-window table (identities that must not multiply)

| Window | Identity that closes it | What a second attempt resolves to |
| --- | --- | --- |
| Before the creating commit | nothing durable | nothing; the delegation never existed |
| Inside/after the creating commit, before admission | dispatch doc `(delegating, requestId)`, anchor task | same child, anchor resumes `admit` |
| Admission durable, receipt not returned | native submission `requestId` | same submission; `existingDispatch` answers the child |
| Second dispatch admitted, record not written | native submission `requestId` | same submission; record written once |
| Preparation commit, before admission | anchor checkpoint `{phase:"prepare", compaction}` | same compaction outcome read, one admission after |
| Preparation failure stated | `preparationFailedTaskId` | parks; only an explicit retry naming it moves on |
| Child settled, before report record | child submission by dispatch request id | reporter reacquires and waits the same submission |
| Report admitted, before ack | recipient admission `<dispatchId>:report` | same queued/terminal item, one report |
| Stop/continue committed, answer lost | control receipt `requestId` + control revision | original receipt; item consumed once |
| Gateway call dispatched, answer lost | gateway ledger `gateway:workspace:callId` + fingerprint | `outcome-unknown`; never re-executed |
| Client lost the submission answer | submission `requestId` | `GET …/submissions?requestId=` reads the record |

## 4. Verified facts vs. gaps

### Verified (cited above, not reimplemented)

- Native checkpoint resume, not prose inference: anchor/reporter/generation all resume from a committed checkpoint.
- Replay policy is per operation and must be declared on **both** the stored intent and the current definition; the
  delegation tools are `safe`, the coding tools are not, so unsafe effects are never silently re-run.
- No implicit retry of unsafe effects: the interrupted tool settles `failed` with an `interrupted` result and its
  side-effect log is unchanged.
- Identity-before-retry holds at every seam in §3; no new identity is minted to make an uncertain operation look
  settled (report id, submission id and control receipt are all derived from the original).
- Terminal means terminal: a cancelled report item is never revived; a removed recipient terminates with its own
  reason; a retried preparation is a **new attempt task** under the same dispatch.
- Fork is a user branch: the original keeps its history, tasks and control; the branch gets an independent anchor and
  no live run, queue or hold.
- The projection never turns missing data, a stream loss or an idle parent into child success/failure: it reads the
  conversation's own run flag, control, live tasks and its own queued report, in that precedence.

### Gaps (recorded, not fixed by this ticket)

- **G1 — `outcome_unknown` from a gateway command is not a distinct child-visible state.** A `bash` call whose
  gateway answer is lost reaches the model as an ordinary tool error (`ExecutionError("unknown", …)` in
  `environment.ts:132`; the code is not `timeout`/`aborted`). The gateway's own distinction (`outcome-unknown` vs
  `execution_failed`) is flattened at that boundary, so a caller cannot tell "may have run" from "failed". The tool
  task itself stays safe: it settles normally and is not replayed. Impact: the model reads a message, not a code.
  Candidate owner: ticket 02 (projection gaps), if a user-facing distinction is wanted.
  **Closed by ticket 02** at `impl/child-recovery-02`: the conversion owner states the lost answer as `outcome_unknown`
  with the spent call ID, and the model-visible result is checked at both seams — see
  [ticket 02's result](02-projection-gaps.md). This row stays the description of the audited revision `95f9257`.
- **G2 — the child's own recovery vocabulary is not exposed per object to a client.** `runStatus` is one state per
  conversation (with the runtime's reason for `blocked`/`interrupted`); the anchor's, reporter's and dispatch's
  individual phases are not projected. This is intentional per the spec ("there is no single child-level failed flag"),
  but it means a client cannot show "reporter pending" separately from "child running" except through
  `waiting-report`. No mislabeling was found; this is a capability limit, not a defect.
- **G3 — no test measures a child's `outcome_unknown` bash result end to end through the product surface.** The
  gateway family measures the code and the backend family measures the interrupted path; the seam between them
  (G1) is therefore asserted only at unit level. Candidate owner: ticket 04 (system acceptance).
- **G4 — model-request interruption is not re-measured at this revision.** Row 4 relies on `pi-durable` 1.3.0's
  documented generation recovery plus the aborted-partial behaviour in `dist/harness/generation.js`; no test in this
  repository kills a process mid-generation and asserts the aborted partial. Candidate owner: ticket 04.
- **G5 — `task_too_old` / `migration_failed` are surfaced but unmeasured.** Only `missing_task` has an end-to-end
  test. The projection handles all three (pinned by the new assertion test), so this is an evidence gap, not a code
  gap.
- **G6 — a retried preparation has no user-facing control.** Retry is reachable only by replaying the delegation
  request identity (model `agent_spawn` replay, or the Web delegation route with the same `requestId`). There is no
  "retry preparation" button. The spec's narrow exception is satisfied; whether a user needs an explicit control is a
  product decision for ticket 02/03, not a recovery defect.

### Not gaps (checked and rejected)

- *A child that produced no answer looks failed.* No: the projection reads the conversation's own run and control, and
  a settled child with a queued report is `waiting-report`, not `idle`/`failed`.
- *A parent stop kills the child.* No: both anchor and reporter are conversation-owned **background** tasks; ordinary
  traversal never enters them.
- *A fork clones live state.* No: `session-fork.test.ts` forks while the source's run is in flight and asserts the
  branch is not busy, is `allowed` and has an empty queue.
- *A gateway restart replays a call.* No: the ledger answers `outcome-unknown` for a row left `admitted`/
  `dispatched`, and a spent id stays a tombstone so eviction cannot authorize replay.
- *The submission lookup is a second write.* No: it is a `submissionByRequest` read inside a commit that writes
  nothing, and an unknown id answers `null`.

## 5. Consequences for the ticket set

- Ticket 02 should start from G1 (and only G1) if a user-facing `outcome_unknown` distinction is wanted; G2/G6 are
  product decisions, not misclassifications.
- Ticket 03's evidence question is answered **no implementation justified by recovery alone**: an explicit fork already
  exists, is user-initiated, preserves the source and copies no live state (row 23). A dedicated "fork because the task
  cannot resume" workflow would be a product feature, not a recovery gap.
- Ticket 04 should close G3/G4/G5 by measurement; none of them is a known behavior defect.

## 6. Commands, exit codes, logs

All run at `95f9257` in `.dev/worktrees/child-recovery-01`, Node v26.5.1, after
`pnpm install --frozen-lockfile` (exit 0, all packages reused from the virtual store).

| # | Command (cwd) | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| 1 | `node --test test/subagents.test.ts test/subagent-reports.test.ts test/context-preparation.test.ts` (apps/server) | 0 | 36 tests, 36 pass, 0 fail | `.dev/verify/child-recovery-01/subagents-family.log` |
| 2 | `node --test test/acceptance-failure.test.ts test/acceptance-chain.test.ts test/acceptance-recovery.test.ts test/native-input-control-crash.test.ts test/child-fork-crash.test.ts` (apps/server) | 0 | 10 tests, 10 pass, 0 fail (all real SIGKILL) | `.dev/verify/child-recovery-01/acceptance-family.log` |
| 3 | `node --test test/execution.test.ts test/host-client.test.ts test/host-files.test.ts test/host-terminal.test.ts test/control.test.ts test/process.test.ts` (packages/gateway) | 0 | 106 tests, 106 pass, 0 fail | `.dev/verify/child-recovery-01/gateway-identity.log` |
| 4 | `node --test test/durable-submissions.test.ts test/conversation-fork-source.test.ts test/session-fork.test.ts test/acceptance-multisession.test.ts` (apps/server) | 0 | 26 tests, 26 pass, 0 fail | `.dev/verify/child-recovery-01/submission-fork.log` |
| 5 | `node --test test/recovery-capability-audit.test.ts` (apps/server, at `15d8b90`) | 0 | 3 tests, 3 pass (the new read-only assertions) | `.dev/verify/child-recovery-01/audit-assertions.log` |
| 6 | `node scripts/check-docs.mjs` (repo root) | 0 | 352 files, 13 pre-existing broken links (all under `.scratch/`), 0 uncovered guides | printed; the 13 are the recorded doc baseline, unchanged by this ticket |
| 7 | `node scripts/verify.mjs --profile=changed --base=integration/client-app` (repo root, at the audit commit `15d8b90`) | 0 | selects `changed-typecheck` (server typecheck, exit 0) and the one changed test file (3 pass) | `.dev/verify/2026-10-18T08-14-12-193-verify-changed/verify.json` |

The `SIGKILL` tests assert `signal === "SIGKILL"` on the killed stage, so a stage that failed for another reason
cannot be read as a recovery result.

## 7. What this ticket did not do

No automatic retry, no automatic fork, no replay of unsafe effects, no new recovery record, no task-state migration,
no status-projection change, no deployment, no restart of any service. No bypass or security probe. The single new
source-adjacent file is a read-only assertion test over installed definitions and pure projection functions.
