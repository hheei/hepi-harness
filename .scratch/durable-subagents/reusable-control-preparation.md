# 08 preparation — read-only

Agent101 inspected clean8054b95; coordinator advanced only docs to2466328 during inspection. Only source reads/searches and graph queries ran. No tests or product edits;08 remains blocked07. Use [ticket08](issues/08-reusable-agent-control.md) and [approved spec](spec.md) as behavior authority, then obtain accepted07 actual contracts before implementing.

## Owners and reusable identity

`subagents/extension.ts` adds send/stop to existing spawn/get/read adapters. `subagents/host.ts` owns dispatch storage; `composition.ts` exposes host ports. Extend these through07 registration/reporting. `conversation-operations.ts` remains the one send/stop/continue owner.

Each explicit send needs its own dispatch, submission and recipient while C keeps its conversation ID/history/creator/display parent/native owner/configuration/execution binding. A createsC; BsendsC routes that dispatch report toB. Keep the permanent idle anchor; never revive a terminal anchor. Multiple steered inputs can share one native answer entry but retain their separate submission/dispatch receipts. Report actual reset/unanswered reasons without adjacent-message heuristics.

## Controls and trust

Current core send refuses every agent caller resuming a held target and invokes native continue as user. This is a planned08 integration gap:06 offers no agent_send yet. Patched1.3 native controls already permit agent resume of agent-held state, refuse user-held with source_locked and return stopping until old ordinary work drains. Extend that existing seam, retaining request receipts, revision/superseded checks and atomic input/resume. A new user-held resume:true request must return user_stopped before creating a dispatch/admission; replay an existing stable dispatch before revalidating mutable controls.

Derive caller/request identity from ToolExecutionApi; trusted source is host-supplied. Reject self-stop and model-supplied caller/source/policy overrides. Stop through existing core ordinary-scope control and preserve background exclusions/user priority. SpecD02/D03 permits authorized cross-conversation operations; references do not grant permissions. Do not invent a child-only or reference-as-permission ACL.

## Read/status and disabled tools

Retain core list paging and raw-read membership/line/byte/cursor contracts. Current get returns identity/config; listing adds busy, not full lifecycle. Native Harness.inspect task state supplies genuine blocked reasons (missing_task/task_too_old/migration_failed); readRunFailure currently handles no_model only. Surface actual native state, no success placeholders or secondary status map.

Offered tools finish as exactly agent_spawn/agent_send/agent_stop/agent_get/agent_read. No conversation_* model tools or polling/wait replacement. Disabling offered tools retains compatible installed anchor/reporter definitions, history and recovery.

## Obtain07 contracts first

Actual registration API and stored target/recipient/submission request/receipt/answer/report request/ack fields and scopes; reporter ownership/version rules; recovery coupling registration to admission. New held-refused send must create nothing, while admitted send cannot lose reporting after a crash. If registration precedes admission, derive later user-stop behavior from native revision gates rather than resurrecting an older ordinary request. These are integration questions, not a prescribed extra queue.

## Execute when08 starts

Controlled model + real SQLite: completedC→send twice with distinct reports; A/C thenB/C recipient isolation; owner/host/history unchanged. Gate model/tool rounds to prove merged submissions share native answer IDs. User stop→resume refusal/no dispatch→agent stop retains user source→trusted user continue permits send. Agent-only stop/draining→same request resumes once; later user stop supersedes pending resume. Test spoof/self-stop/schema/tool-set guards, disabled-tools recovery and actual blocked states. Reuse accepted07 pinned crash handoffs at new-send admission/report registration.

Existing fixtures: subagents.test.ts, conversation-stop-continue.test.ts, native-input-control.test.ts, relations/read/extensions suites. Future focused command from apps/server: `node --test test/subagents*.test.ts test/conversation-stop-continue.test.ts test/native-input-control*.test.ts`; then applicable verify:changed against accepted07 and owning-guide update. This command is a plan, not an executed result.
