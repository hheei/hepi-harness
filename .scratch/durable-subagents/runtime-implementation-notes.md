# Native runtime implementation notes

Use for tickets06/07 when implementing atomic child creation, replay receipts, environment binding or automatic reporting. Authoritative behavior remains [spec](spec.md); these notes audit scout98 against installed pi-durable1.3.0 declarations and current source. No runtime behavior has been verified by this audit.

## Confirmed public seams

- `ToolExecutionApi.commit(change, context)` receives public `Tx`; `memo(name,candidate,context)` is first-writer-wins; `conversation(id,context)` returns an invocation-bound existing handle. Source: installed `dist/harness/types.d.ts:188`.
- `Tx.createConversation({ownership})`, `forkConversation(parent,at,{ownership})`, `createTask`, `createSubmission`, `doc` are public. Source: installed `dist/types.d.ts:710`. High-level submit/configure are separate operations, not methods on Tx. Atomic creation therefore needs transaction-based document configuration and native queue admission, or a recoverable persisted state machine.
- `Extension.tasks` resolve globally regardless of a conversation selecting the extension. Source: installed `dist/harness/types.d.ts:322`. Keep task definitions installed when tool visibility changes.
- Conversation-owned `background:true` tasks are excluded from ordinary abort/idle cascades. Task-owned child conversations may hang beneath such an anchor. Explicit all/background abort crosses this boundary. Source: installed `dist/types.d.ts:486`.
- `HarnessOptions.env` gets child `conversationId`, cwd and committed DocumentReader. Existing resolver reads WorkspaceDoc by that ID, then resolves its binding. Source: `apps/server/src/server.ts:956`. Persist child WorkspaceDoc before execution; parent identity or UI relation does not supply it implicitly.
- Conversation initialization/fork callbacks prohibit table reads after writes. Source: installed `dist/harness/types.d.ts:527`; fetch parent/source/config facts before creating tasks/conversation records.

## Creation and replay

Scout98 recommends conversation-owned background anchor, task-owned child, and background delivery/reporter tasks. These are architecture candidates, not a tested atomic implementation. Preserve spec distinction between permanent child identity and finite dispatch identity; terminal tasks remain terminal.

`memo()` alone cannot close create→memo crash windows. Persist and recover child/dispatch/submission/recipient identities with the commit that creates them, using a stable caller request/checkpoint. Existing submitConversationInput opens its own commit; extract/reuse a transaction seam if atomic initial admission needs it. Fetch dedup records before first table mutation. Validate with real model calls and SIGKILL at actual boundaries.

## Reporting

Capture child final answer from native Submission settlement; intermediate contact messages do not settle dispatches. Inputs merged by native runtime may share one answer EntryId. Reporter must retain that reference and stable report request ID. Avoid guessing task completion by absence of busy or parsing transcript text.

`whenBusy:followUp` by itself neither suppresses idle wake nor implements user-stop priority. Delivery must use ticket01 native control and ticket02 trusted caller seam: normal idle parent wakes, user-held parent queues report without running. Reporter retry must not undo pending edits/cancellation or duplicate reports.

## Remaining checks

- Real child local/SSH/retained-worktree environment after creation and reopen, through current resolver.
- Correct durable reporter dependencies on native submission settlement and crash replay; public APIs confirmed above do not prove liveness or exactly-once effects.
- agent_read large images and per-block continuation remain ticket04 contracts; reuse core bounded read instead of a separate transcript serializer.

Scout98 returned findings in its completion message; its read-only tooling could not create the advertised /tmp file. This file is the durable handoff.

## Submission waiting and permanent anchors (follow-up source audit)

- Native durable `waiting.on` accepts TaskId only (`dist/types.d.ts`, NextTaskState/TaskState). A reporter phase can instead reacquire child with `runtime.conversation(childId,ctx)`, call `handle.submit` using stable dispatch requestId, then `Submission.wait(ctx)`. On restart running tasks return to their persisted phase; reacquisition/dedup repeats safely. Model input and report request identities must already be persisted. A deduplicated submit is not a new dispatch.
- Settled input submission `done` carries native `answer:EntryId`; `unanswered` carries reason/detail. Use that terminal receipt, no busy edge, timer or transcript guessing. Native `TaskRuntime` offers signal, commit, conversation and waitForTask (`dist/types.d.ts:145`); invocation ConversationHandle has only submit/abort/waitForIdle (`dist/harness/types.d.ts:82`). Native01 control methods live on full Conversation, so trusted host operations inject access rather than casting an invocation handle.
- Important scout correction: `runtime.entry(answerId)` reads entries visible from the reporter task's own conversation, not any child. Read child result through child-scoped membership-checked read seam, retaining answer reference even before compaction. Do not substitute active-context read for raw history. Only final assistant text/terminal status is auto-delivered; thinking/tool trace stays at source (D05).
- Permanent anchor can stay in a running idle phase awaiting invocation abort; parent conversation owns it with background:true, child is task-owned below it. Tool completion must not settle anchor. Agent stop targets child via trusted ConversationOperations/native02 control, keeping anchor and reusable child identity; scout suggestion to abort anchor for normal agent_stop is not adopted. Anchor teardown belongs explicit lifecycle policy, outside ordinary dispatch stop.

These are source-confirmed building blocks, not product/restart verification.06/07 still prove real creation/admission/report crash windows. Exact installed public declarations were read from integration apps/server/node_modules/@earendil-works/pi-durable/dist/{types,harness/types}.d.ts at8edd46a (unpatched1.3.0).

## Optional extension boundary (scout95, coordinator disposition)

Use a module under `apps/server/src/subagents/` first, no new workspace package. Public host port + extension factory/name are the composition contract; ordinary ConversationOperations remains independent of anchor/task implementation. Extension may type-import core request/result types. Server composition installs task definitions unconditionally before its existing explicit resume; per-conversation extension selection controls tools. This preserves restart recovery when delegation tools are disabled.

Core can expose a transaction-based spawn primitive reused by its existing harness-commit wrapper and ToolExecutionApi.commit. Extension supplies an owner-creation callback so core does not import its anchor token; core collects receipt/source/limit/workspace reads before that callback first writes. Commit permanent child/anchor identity and per-dispatch identities/recipient with request dedup. Initial native admission may be a second recoverable idempotent phase rather than importing private native admission internals; preserve stable persisted submission requestId and prove create/admit/receipt kill windows.

Keep permanent anchor separate in responsibility from finite dispatch tracking: never settle/revive anchor per result;08 needs reusable child and later/overlapping dispatches. Scout dispatch→awaiting anchor sketch alone is not a complete reuse/reporting implementation.06 determines minimal persisted dispatch task/doc arrangement,07 attaches delivery. Agent stop targets child, not permanent anchor.

Trusted caller/recipient/request identity comes from actual ToolExecutionApi.conversationId/callId/taskId (confirmed installed `dist/harness/types.d.ts:153`), never model parameters. Resolve definitions on caller execution host through05; snapshot full explicit config/provenance before admission, named refusal on host mismatch. Leave optional cross-host selection outside model schema. Do not adopt scout's proposed model-only `callers` restriction without spec need: native default also permits nested tools/codemode, and the approved integration uses ToolExecutionApi.executeTool.

Scout95 queried integration AST graph for createConversationOperations, stop/continue/spawn seam and agent_spawn/anchor, confirmed source; extension symbol query absent then narrow grep. Recon source455b714 predates05; paths/signatures are proposals, confirm current948f183+02 source when implementing. Suggested ownership: subagents/{host,anchor,extension}.ts; ConversationOperations transaction primitive; harness extension installation; server composition/selection; protocol only if public projection requires. No product edits in prep,06 remains blocked by02/05 acceptance.

## Bootstrap ordering (confirmed currentserver, supersedes pre-open install suggestion)

`server.ts` already calls openServerHarness with startPaused:true, constructs ConversationOperations, attaches stored conversations, then calls runtime.harness.resume. Build fully bound SubagentHost from that SAME operations object, construct extension and registry-install it after operations creation and before attach/selection/resume. No HarnessConfiguration subagent field or mutable late-bound holder is needed; harness.ts stays free of subagent knowledge.

Scout95 confirmed native scheduler `#kick`/`#reserve` reject execution while disabled; paused reconcile can mark abort/finalize completing tasks but does not run phases/resolve definitions. Parent confirmed actual server bootstrap and harness.ts source at94fc056. Missing task definitions remain blocked candidates and registry publication re-kicks after installation. This source reasoning still needs06 realrestart evidence.

Reuse named extension-install failure handling for server-side install. Prefer one application-owned installer method closing over current private mutable failures array, preserving readonly failure projection; no need to expose a mutable array or add a subagent-specific configuration field. Decide exact tiny extraction during06. All extension task definitions installed before resume, tool visibility remains per-conversation.
