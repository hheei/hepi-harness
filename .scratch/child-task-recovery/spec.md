# Child Task Recovery Semantics

Status: approved principles; capability audit complete ([ticket 01 evidence](issues/01-capability-audit-evidence.md)) and its one material projection gap closed ([ticket 02 result](issues/02-projection-gaps.md): a lost Gateway command answer stays `outcome_unknown` at the tool seam) — remaining scope at the time was tickets 03-04, all since resolved. G2 (per-object preparation/delivery visibility) and
G6 (a retry of a failed preparation under the existing identity) were recorded as product decisions here, **approved by
the user afterwards**, and are now **delivered** — see
[approved work](issues/02-projection-gaps.md#approved-pending-work-2026-10-20). That approval narrowed the
out-of-scope line below for preparation retry only: the retry is the existing dispatch identity replayed, never a new
attempt identity, a fork or an automatic retry.
Labels: subagents, durability, recovery
Date: 2026-10-17

## Purpose

Specify how a delegated child and its tasks behave across process failure, cancellation and lost responses, using pi-durable's task/checkpoint model. First audit and verify existing behavior. Add code only for demonstrated semantic gaps. This is not a generic retry system and does not authorize automatic child forks.

## Design basis

This spec follows [Pi Durable's design](https://earendil.com/posts/pi-durable/): tasks checkpoint durable progress; recovery resumes from those checkpoints; a model request interrupted mid-flight may be sent again while its partial answer remains marked aborted; a tool replays only when its declared policy makes replay safe; otherwise it is reported interrupted. Stable request IDs make an admission retry resolve to the same submission, not to a second turn. These mechanisms do not promise exactly-once external side effects.

Use native pi-durable task, submission, conversation, fork and execution-environment seams. Do not add a second runtime, journal, scheduler or inference of task state from transcript text, UI polling, missing events or parent status.

## Existing behavior to preserve

- Backend is the only durable runtime and SQLite writer.
- Child anchor/admission and reporter are durable tasks with stable identities and checkpointed handoffs.
- A retried admission with the same requestId resolves to the existing submission.
- Restart-abandoned unsafe tools remain interrupted; they are not silently replayed.
- A lost Gateway mutation response remains outcome_unknown and is not resent under a fresh execution identity.
- Explicit context-preparation retry is a narrow existing exception: a caller requests retry of the failed preparation task by identity; same child and dispatch remain, and initial admission is not duplicated.
- Parent stop/background-task ownership follows current documented hepi semantics. Do not transplant pi-durable examples' different ownership arrangements blindly.
- Compaction does not erase source history. A native fork is a separate conversation and does not inherit live tasks, inbox decisions or control state.

## Recovery vocabulary

Recovery is reported per durable object; there is no single child-level `failed` flag that collapses independent work:

| Fact | Meaning | Permitted next step |
| --- | --- | --- |
| checkpointed task pending/running | Native task has resumable checkpoint | Runtime resumes that task from its checkpoint |
| submission queued/placed | Durable input admission exists; answer not yet settled | Look up/wait on same submission identity |
| model request interrupted | Request was cut off; partial output may exist as aborted | Runtime policy may issue a new request from checkpoint |
| unsafe tool interrupted | Tool intent may have had external effect; outcome not established | Surface interruption; no automatic replay |
| outcome_unknown | Mutation may have happened but response/receipt was lost | Resolve through owning durable identity/ledger when available; never blind resend |
| blocked | Task definition/version cannot run safely in this process | Report precise reason; require compatible runtime/migration |
| failed terminal task | Owning task recorded failure | Preserve task/outcome; any new attempt needs an explicit owning contract |
| explicitly retried preparation | Caller named a specific failed preparation attempt | Reuse dispatch and child; create one new preparation attempt |
| explicit user fork | User chooses a history position for a new conversation | Native fork; preserve original and do not clone execution/control state |

`interrupted`, `failed`, `blocked` and `outcome_unknown` are not synonyms. A child may have a completed submission while a reporter is pending, or an interrupted tool inside an otherwise live child. Projections must retain the owning task/submission/reporter identity and reason.

## Invariants

1. **Resume checkpoint, not intent guessed from prose.** Durable task checkpoint and native submission records are authoritative. Never infer unfinished work from absence of an answer or a UI disconnect.
2. **Replay policy belongs to the operation.** Re-execution is allowed only where the durable tool definition/runtime explicitly says it is safe, or where an idempotency identity is honored by the actual effect owner. Textually identical args do not prove idempotency.
3. **No implicit retry of unsafe effects.** Restart, timeout, cancellation or transport loss cannot be converted to a fresh tool call. Preserve partial output and report what is known and unknown.
4. **Identity before retry.** Admission, preparation retry and lookup use their existing stable identities. No new identity is minted to make an uncertain operation appear successful.
5. **Terminal means terminal.** A failed/aborted/unknown task is not resurrected in place unless its owning native contract explicitly supports that transition. A new attempt is separately identifiable and linked to its cause.
6. **Fork is a user branch, not recovery replay.** Fork only after user action and from an explicit source position valid under native fork-aware history. Original conversation/transcript/tasks remain. New fork receives native as-of history/config semantics, but not old live tasks, pending queue, reporter, user stop or control state.
7. **No inferred clean boundary.** Do not invent `lastCleanEntryId` from message order or tool result appearance. Any safe continuation point must be a runtime-committed durable fact with a defined relationship to effects and transcript entries.
8. **No exactly-once claim.** Stable IDs deduplicate only at the component that owns and durably checks them. External systems without idempotency/receipt lookup can remain genuinely unknown.
9. **Keep source and recipient distinct.** Child task outcome, dispatch status, reporter delivery and parent inbox admission each have their own durable owner and may settle at different times.

## Scope

First phase: map and test all existing child recovery paths; identify actual user-visible gaps; align status projection/docs only where facts are currently lost or mislabeled. No automatic fork, retry button, new recovery record or task-state migration unless the audit proves it necessary and a separate ticket specifies semantics.

Later optional phase: explicit user-initiated fork from an established native history position when the original task cannot safely resume. It must preserve the original and must not automatically submit the same task text or claim the external effect is absent.

Out of scope: automatic retry of failed child work; automatic fork-on-failure; external side-effect rollback; deciding that a tool is safe by tool-name heuristics; general task supervision; process-level exactly-once guarantees; changing all child task ownership/stop semantics to match upstream examples.

## Required evidence

- Controlled SIGKILL at child creation, admission, model request, tool dispatch/response, child settlement, reporter delivery and acknowledgement boundaries where the runtime exposes those seams.
- For each case record persisted task/checkpoint, submission/request ID, dispatch ID, tool execution identity, reporter receipt and external effect count before/after restart.
- Cover replay-safe read, unsafe mutation, Gateway definitive refusal, Gateway lost response/outcome_unknown, missing/old task definition, caller abort, held child, completed child with pending report, and explicit preparation retry.
- Verify recovery lookup reads existing receipt/state and does not submit a replacement operation.
- Verify user fork is independent: original history/state retained; child execution, queues and stop decisions not cloned.
- Distinguish process SIGKILL evidence from power-loss/disk-corruption durability claims.

## Acceptance

- Every inspected task state maps to exactly one of checkpoint-resumable, safely replayable, interrupted/unknown, blocked, or terminal, with owning identity and reason.
- Recovery resumes native checkpointed work and same-ID admissions without duplicate conversations/submissions.
- Unsafe tools and uncertain Gateway mutations are never silently resent.
- Explicit preparation retry remains same dispatch/child and cannot duplicate initial admission.
- UI/API never converts missing data, stream loss or idle parent into child success/failure.
- Any explicit continuation fork is user initiated, preserves source and does not clone active execution/control data.
- Only material capability gaps become implementation tickets; verified existing behavior is cited rather than reimplemented.
- Acceptance records exact revision, commands, exit codes and logs; no deployment is implied.

## Evidence and related decisions

- Product recovery matrix: [durable recovery research](../webui-next-exploration/durable-recovery.md).
- Current task/status semantics: [architecture](../../docs/architecture.md), [subagent run status](../../apps/server/src/subagents/status.ts), [anchor](../../apps/server/src/subagents/anchor.ts), [dispatch records](../../apps/server/src/subagents/host.ts).
- Submission unknown-outcome rule: [ADR 0006](../../docs/adr/0006-durable-submission-lifecycle.md).
- One runtime ownership: [ADR 0001](../../docs/adr/0001-single-authoritative-durable-runtime.md).
- Subtree control is separate: [subtree lifecycle spec](../subagent-subtree-control/spec.md).


## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.

