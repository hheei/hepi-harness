# Architecture

## Ownership

`apps/server` is the single authoritative `pi-durable` runtime and SQLite writer: conversations, tasks, model configuration and durable model execution semantics.
`packages/ui` is the one React workbench, mounted by the Web host (`apps/web`) and the desktop App (`apps/app`); neither
host runs an agent loop. The **client ingress** (`packages/gateway/src/ingress/`) is the one listener a client reaches: it
admits a Web session cookie or a device bearer, checks that identity on every request, and calls the Backend with its own
service credential. The execution gateway (same process as the ingress when a deployment composes them) owns what belongs
to its host — execution, filesystem roots, terminal, SSH credentials and instances, MCP servers, provider credentials and
network reachability. Read [ADR 0001](adr/0001-single-authoritative-durable-runtime.md) for the runtime decision and
[client ingress](client-ingress.md) for the four materials.

## Conversation relations and references

A conversation's identity has four separate edges, and no surface may collapse them. The native conversation record
already states two immutably: the **fork source** a conversation inherited its history from (`record.parent`) and the
**task owner** that created it (`record.owner`). Neither is the **creator** — an ordinary conversation can ask for
another without owning it — and neither is where a conversation is **displayed**. So the hepi-owned edges live in
conversation-scoped durable documents, declared by the same creation seam that writes them:
`apps/server/src/conversation-operations.ts` keeps `hepi.conversation.relations` (`createdBy`,
`displayParentId`, `provenance`) and `hepi.conversation.references` (structured pointers to other conversations,
optionally to one entry). The native fork source and owner are projected from the immutable record and never copied
into a hepi document, so a mutable authority is never duplicated (spec D03).

`ConversationOperations` is the **one creation seam**: `spawn` takes an already-parsed agent configuration, an explicit
creator and display parent, the native ownership and the execution workspace, and writes all of them — the `pi.agent`
configuration, the `hepi.workspace` binding, the relations and a session-scoped request index — in one commit under a
stable `requestId`. A replay of that id answers the conversation the first call created instead of creating a second
one, and inside one transaction every table read precedes the first write. Nothing in the seam parses an Agent
Definition or interprets a context strategy. `POST /api/conversations` is the HTTP adapter over it and answers the new
conversation's catalogue row; ticket 06's model tool will use the same entry rather than a second creation path.

One optional field of that request, `source`, is a **host-resolved fork position**: the conversation to inherit
history from and the entry to start at, both already decided by the caller. The seam confirms the entry is visible from
that conversation through the same fork-aware bounded read every other by-id lookup uses, then takes the native fork
instead of an empty creation, so the branch's history, its `asOf` agent configuration and its inherited documents
follow the runtime's own fork semantics and the owner, relations, workspace and request identity are written in that
same commit. A fork and a creation are therefore one contract, and a caller that names a position interprets nothing:
what a branch point means — a user picking an entry, a configuration strategy naming one — stays outside the seam.

The catalogue row states the edges so a list read needs no per-conversation document read: `createdBy`,
`displayParentId` (with `displayParentDeleted` when the parent is tombstoned), and the projected `parentConversationId`
and `subagentParentConversationId`. A tombstoned display parent leaves the list but the child keeps its edge and is
never promoted to a conversation of its own, and its inherited history stays readable.

A conversation a **user branches from a child** is where those edges stop being interchangeable, so the row reports
them apart. The branch is task-owned like the child it came from — by its **own** background anchor in that child's
scope, which is what gives it an independent owner, inbox and control state without reusing the child's task — but
nobody delegated it, so its owner is not a delegation edge and `subagentParentConversationId` is not reported for it.
A surface that read the ownership edge as the subagent relation would fold the user's own branch into the source's
family and treat its answer as a silent completion. The branch states its origin as the native fork source
(`parentConversationId`, read from the record) and its place as `displayParentId`; its owner stays readable through
the by-id read, where it is a fact rather than a classification (spec D14). `GET
/api/conversations/:id` answers the same row plus the relations, the projected native edges, the references and a
**credential-free** effective configuration (model reference, thinking level, extension and tool names, instructions,
cwd). `GET /api/conversations` filters and pages that same projection by `createdBy`, `displayParentId`,
`forkSource`, `ownerConversationId` and `workspaceId` — there is no second graph service. A reference is written as
the referencing conversation's own state: it copies no content, changes no parent, grants no control and migrates no
host, and a target that is not one's own child is still readable rather than refused by a display relation.

## Durable child execution (optional subagents extension)

Delegation is an **optional extension**, not a second runtime: `apps/server/src/subagents/` installs one extension
(`hepi-subagents`) whose tools are exactly `agent_spawn`, `agent_send`, `agent_stop`, `agent_get` and `agent_read` —
`conversation_*` stays the underlying API and is never a model tool — and whose two task definitions are the child's
anchor and its result reporter. It is installed by `server.ts` through the harness's own failure-tolerant installer, after the creation
seam exists and **before** scheduling resumes, so the anchor definition resolves by name for every task — including one
recovered from a previous process — while the tools are still a per-conversation capability. The extension never selects
itself into a child, so a child does not delegate in turn, and the host states the depth and concurrency limits the seam
checks before anything is created.

The core learns nothing about anchors or dispatch records. `ConversationOperations.spawn` accepts one extra ownership
form, `created-task`: the caller supplies a callback that creates the owning task **inside the creating commit**, so the
anchor task, the child conversation record and the extension's own `hepi.subagent.dispatch` record are one atomic
commit under the call's own request identity. A crash before it commits leaves nothing; a crash after it leaves a child
whose owner, task text and stable submission request id are already durable, so recovery resumes the anchor's `admit`
phase and admits that submission once instead of losing the delegation or making a second one. A replay of the same
request answers the child the first call created.

`agent_send` gives a conversation that already exists another task, and `agent_stop` holds one. Neither creates a
conversation: the target keeps its id, its history, its creator, its display parent, its native owner and its
configuration, so a second task is a second **dispatch** of the same worker rather than a second worker. Each dispatch is
admitted on the target under the caller's own stable request id — the delegating conversation and the call id, both the
host's statement and never the model's — which is what makes the two crash windows recoverable: a replay after the
admission but before the dispatch record is written re-admits the same id and is answered with the submission the first
attempt made, and a replay after the record exists is answered from the record and re-validates nothing. The dispatch
record names the child submission and the reporter task in one commit, so an admitted dispatch always has something that
will report it. Any conversation may dispatch a child, and the report goes to the conversation that asked for it; the
child's own identity is not rewritten by a borrowed dispatch.

The control a model's stop uses is the same atomic one a user's does, and the stop **source** is the safety property:
`ConversationOperations.send` passes the request's trusted caller straight to the native rule, so a trusted user's send
clears a user stop, while an agent's send clears only a stop an agent recorded and is refused with `source_locked` — the
refusal is the answer and creates no dispatch record at all. An agent stop can never downgrade a user's, and a model may
not stop the conversation it is running in, nor name a caller in the arguments: the trusted caller is the host's
statement and an unknown argument is refused rather than ignored.

Two handover points are pinned by real `SIGKILL` tests rather than argued: the creating commit — killed
**synchronously inside the commit publication** that carries the child, so the child exists while its initial admission
and the calling call's result entry provably do not — and the admission — killed inside the `agent_spawn` call itself
through the extension's own `wraps` seam, after the anchor's commit records the admitted submission and before the
wrapper returns, so the calling `pi.tool` task is still running. The recovery test reopens the same store paused, reads
the recovered child, dispatch record, admission, anchor and interrupted call before scheduling resumes, then asserts the
same identities, one admission and one replay answer. Holding a model response open is not part of either window: it
only keeps a child answer out of the way.

Three further boundaries are pinned by the same kind of real-`SIGKILL` acceptance (`apps/server/test/recovery-acceptance.test.ts`,
measured at `1873d24` and re-measured at the current integration tip), each with its own process stage under a temporary
SQLite store:

- **A child's command whose gateway dies mid-execution.** The child's `bash` runs against a gateway in its own process, the
  gateway is killed after the command's side effect lands, and the child records **one** `isError` result naming
  `outcome_unknown` and its own spent call ID, then settles normally. The restarted gateway, over the same journal, answers
  the identical request with the same call ID and never runs it again: the side effect appears once in the file and the
  child's result appears once in the transcript. This is the execution seam's claim checked end to end — no exactly-once
  claim across the two processes.
- **An answer interrupted while the model is still writing.** The backend is killed with a partial committed
  (`live.generation.message`) and no answer yet, and reopen converts that partial into **one** assistant entry whose response
  ended (`stopReason: "aborted"`), holding the prefix the dead process had committed, grown and never replaced. The reopened
  run takes its interrupted turn up **by itself** — nobody re-submits it — with exactly **one** model request, and what that
  request is handed is the user's own turn: the retained partial is a fact for readers, not model context, so the turn is
  **restated** rather than continued. No second copy of the dead answer appears.
- **A task version the running build cannot name.** A recovered anchor whose **stored** version is ahead of the installed
  definition is blocked `task_too_old`; one where the installed definition is ahead and carries no `migrate` is blocked
  `migration_failed`, naming the runtime's own `has no migration from` error. In both cases the child conversation, its
  entries and the dispatch record stay readable, nothing is silently migrated or guessed, and the catalogue states the
  runtime's reason instead of a state this product invents.

The anchor is a **conversation-owned background task** of the delegating conversation, which is what makes a user stop
of that conversation leave the child running: ordinary traversal never enters a background task, so neither the anchor
nor the child beneath it is marked. It stays in an idle phase for the child's lifetime — it is a permanent identity, not
one dispatch's bookkeeping — and a child's result never settles it.

### Automatic result delivery

A delegation reports itself. The anchor's `admit` phase creates, **after** the admission it just made and in the same
commit that records the submission, one **reporter** task: a second conversation-owned background task of the delegating
conversation (`hepi.subagent-reporter`), created by its registered name from the runtime's own registry. Creating it
after the admission — and gating on the dispatch record's own `reporterTaskId` — is what makes it exactly one per
dispatch: a phase that re-runs after a crash sees the reporter it already created and creates none, and a phase that died
before that commit created none at all. A **fork anchor** (the idle shape below) admits nothing and therefore reports
nothing: a user's own branch has no delegation to answer.

The reporter has two phases and holds no in-memory handover. Its `wait` phase reacquires the child's submission through
the native admission under the dispatch's own stable request id — a duplicate request id is answered with the submission
the anchor already admitted, so this is a reacquisition and never a second turn — and waits on that submission's durable
settlement. That wait is the **whole** submission: a tool round hands the run over and leaves the input placed, so only
the run's own answer, abort, reset or failure settles it, and a mid-run contact message settles nothing. Its `deliver`
phase admits the result into the recipient through the one core delivery seam and then commits its own acknowledgement.
Both phases are checkpointed, so a process that died anywhere between the child's settlement and the acknowledgement
resumes from the same identities and re-does the same two steps.

Delivery is one native admission and nothing else. `ConversationOperations.deliver` applies the recipient's own
committed state through the runtime's own rule — an allowed idle conversation places the report and starts a run, a
running one queues it at the next boundary without interrupting a tool, and a held one queues it and starts nothing — so
no control rule is restated and an automatic report never clears a user's stop. The report is a `hepi.agent-report`
input entry carrying the dispatch, child conversation, settled submission, answer entry and terminal status, so it cannot
impersonate a user message; it is admitted under `<dispatchId>:report`, a stable identity derived from the dispatch. A
known request id is answered with the submission the first attempt admitted and writes nothing, which is exactly what
preserves a user's decision: an item the user edited or cancelled through the native operations is reported back by its
own record and never overwritten or revived. A removed recipient is terminal — `recipient_deleted` — with the child's
own result retained in the reporter's record and outcome, and no retry.

**A removal is the conversation's last word on admission**, and it is written where the removal is: the tombstone commit
also commits the native `held` control the runtime's own admission already consults. A caller that checks the removal and
then admits in a later commit is therefore still safe — the two facts are one commit, so an admission that commits after
the removal reads `held`, queues, places nothing and starts no run. That is the whole linearization: no admission is
repeated, no caller re-checks anything, the native queue and control revision are untouched, and the removal stays
answerable without waiting for a live run. A deleted conversation is never continued, so a queue it holds is never
consumed.

Only the final answer travels, or the terminal reason when there is none. The text is read through the core bounded read
(`agent_read` calls the same entry) restricted to the answer entry's own **text** blocks, cut by a fixed 8 KiB / 400-line
preview rule, and the report states its own truncation together with the child conversation and answer entry that hold
the full source. No model summarization, no tool trace and no thinking block is carried into the recipient.

Because the anchor is permanent, the concurrency limit is stated over **work, not identities**: the host answers how
many of a conversation's delegations are still at work — a child whose anchor has not admitted its initial input yet, or
whose own conversation has live work — read from the native conversation-owner edge and the live task table. Counting
non-terminal anchors instead would count every child that ever finished and refuse the next delegation forever. The
listing surfaces share one paging rule (`apps/server/src/conversation-page.ts`): a cursor at or past the last row is an
exhausted listing and answers an empty page, never a restart at the first row.

The child's configuration is the resolved Agent Definition's own snapshot, written field by field (model, thinking,
extensions, tools, instructions, cwd) with `modelTools` cleared, so no part of the delegating conversation's agent
survives into it. The definition is resolved on the **conversation's own Execution Host**; an unreachable host, an
unknown definition, an unknown context strategy, a tool the child's selection does not really provide and a model
override smuggled into the tool arguments are each a named refusal before any conversation is created
(spec D10, D11, D12).

### Context preparation is decided by the definition, never by the model

A definition's `context` is the whole authority on preparation: `fresh` (the default) starts the child empty, `fork`
branches it from a position in the delegating conversation, and `compact` summarizes that position away first. The
model's `agent_spawn` schema carries `name` and `task` and nothing else, so a strategy, a plugin set or a source
position is refused as host configuration rather than accepted from the caller.

The **host resolves where**, once, before anything is created: the delegating conversation's newest visible entry,
read through the conversation's own fork-aware context. That position is recorded in the child's `provenance` and, for
`fork`, is the native fork edge itself — so a message the parent appends afterwards cannot move the branch point, and
what the child inherited is stated rather than implied. `fork` is applied by the one creation seam's optional
`source` field (`ConversationSpawnSource`), which turns the creating commit's `createConversation` into
`forkConversation`; the owner task, relations, workspace, request identity and the definition's full explicit agent
override are written identically either way, so a fork and a creation remain one contract.

`compact` is a second phase of the anchor. The anchor creates a **conversation-owned background compaction task of the
child** — a task a task owns has to live in its owner's conversation, so the child is the only place a preparation of
the child can run — waits for it natively, and only then admits the task text. The preparation is therefore committed
before any child model request exists, and it is recoverable by construction: the compaction task is durable, so a
process killed mid-preparation resumes the anchor, reads that task's own outcome instead of compacting twice, and
admits the dispatch's task text once. A preparation that **failed** is stated, never silently downgraded to a fresh
child: the anchor settles `failed` with the reason and records the same reason on the dispatch record it already owns,
so `agent_get` answers `preparation_failed` with the cause and the child admits nothing. A compaction that found
nothing worth compacting is not a failure — it is a completed preparation of an already-short context.

A user stop that arrives while the child is being prepared survives it. The hold lives in the child's own Inbox, so the
summary and the task text are both queued rather than placed: the child's model is never asked anything until the user's
explicit continue, which then places the summary before the work, in the order a boundary uses. A replay of a request identity that already created a child is answered from that durable
dispatch record **first**, so neither a precondition edited since nor the concurrency limit can refuse work that is
already committed. The global extension default is resolved against every installed extension — the same set a write is
validated against — so a deployment can opt the optional extension in; the fallback when no default was ever stored is
the selectable set, which keeps it off, and a child or an unbound conversation still withholds it. `agent_get` and `agent_read` call the core by-id read and the core bounded raw read, so a model
and a browser cannot be served two different histories, and the by-id projection stays credential-free.

### The Web's own delegation and the child's real status

A user delegates without writing a prompt, and does it through the **same** seam the model's tools call. `POST
/api/conversations/:id/delegate` (body `{ name, task, requestId, conversationId? }`) is served by
`createSubagentDelegation` — the module `agent_spawn` and `agent_send` were factored onto — so a browser's quick
create and a model's tool call resolve the definition, check the depth and concurrency bounds, write the anchor, the
child and the dispatch record and register the reporter in the same commits. The body carries no context strategy, no
tool set and no model: the definition owns those, so a caller cannot override the policy the user configured, and a
field that tries is not read at all. `requestId` is the attempt identity the browser holds across retries, so a lost
answer is answered with the child the first attempt created; `conversationId` addresses a conversation that already
exists, which is "delegate again" — the target keeps its id, history, creator, display parent, owner and configuration
and only admits one more task whose report returns to the delegating conversation. Every refusal is the answer and never
a queue entry, named by code: `depth_exceeded` and `children_exceeded` (both 409), `unknown_definition` and
`no_execution_host` (404), `host_unreachable`, `user_stopped`, `tool_unavailable` and the definition's own validation
issues. A successful answer carries the child's catalogue row, so the Web origin can open it in the same ChatWindow
without a second read racing the session list.

The catalogue states each conversation's own **run status** (`runStatus`), projected from facts about that conversation
alone: its published `busy` flag, its committed input control, its live tasks from **one** `harness.inspect` shared by
the whole listing, and whether a report of its result is sitting queued in the delegating conversation. The vocabulary
is the user's — `running`, `held`, `stopping`, `waiting-report`, `blocked`, `interrupted`, `idle` — and the precedence
is the order of the facts that decide what the user is told: a task no definition can take (`blocked`, with the
runtime's own reason) and a task a restart abandoned (`interrupted`) first, then the control facts, then the work, then
the waiting report. A **background** task is never work: the anchor and the reporter live for the child's lifetime, so
counting them would show every finished child as running forever — the same mistake the concurrency bound already had
to avoid. Nothing here reads a parent's busy flag, so a child is never "running because its parent is", and no per-row
stream is opened: the projection rides the catalogue read the sidebar already polls.

One `runStatus` per conversation is not enough to say what a delegation is waiting on, so a child's **recovery facts**
are read per durable object at its own address: `GET /api/conversations/:id/recovery`
(`apps/server/src/subagents/recovery.ts`) resolves the child's owner anchor task, takes the `dispatchId` from its input,
and projects the dispatch's preparation state (`unretried-failure` with the failed attempt's own task id and the
runtime's reason, or `retried`), the anchor's own phase, and where this dispatch's report stands — the reporter's live
phase while it runs, `awaiting-delivery` for a recorded report nobody has admitted, and the report record's own delivery
word thereafter. A conversation that is no delegation's child answers `null`. Nothing is restated from `runStatus` and
no whole-child bucket is introduced, so a reporter waiting on a running child and a parked preparation are two facts
rather than one verdict. `POST` on the same route is the **only** user-facing retry of a preparation: it validates the
named attempt against the record (`identity_stale`, `already_retried`, `not_failed`, `not_a_delegation`) and then writes
`preparationRetriedTaskId = failedTaskId` through `host.retryPreparation`, so the parked anchor of the same child
prepares again and admits once — the existing dispatch identity replayed, with no fresh identity and no second child. A
lost answer is never re-sent by a client on the reader's behalf: the write is idempotent by the record's own rule.

The feature's combined acceptance is a set of drivers rather than an argument: real multi-kill chains that keep one
child, dispatch, submission and report; the three mid-drain control windows (stop while draining, continue whose answer
was never read, a newer stop superseding an older continue); a tool killed inside `execute` that is reported
interrupted and never replayed; a retained workspace binding inherited by a delegated child; and one production
browser journey that runs the whole session. The limits are stated with them: an **external** side effect is never
claimed to happen exactly once, and a task a build cannot take is `blocked` rather than retried into a success. The
recovery results are claims about the isolated stacks the drivers build from this work; no driver of the gate runs
against the live deployment, so its being up to date is a deployment fact and not a crash-safety proof. See
[verification](verification.md#durable-subagents-the-combined-acceptance-gate-2026-10-17).

## Protocol boundary

`packages/protocol` defines hepi.v1 command/event/snapshot contracts, request correlation, logical workspace/gateway identity and explicit operation states. The raw projection frames are declared there once — `ServerSnapshot`, `ServerDelta` and the entries, settings, failure, resource and tool-slot shapes they carry — and every production consumer reads that declaration: the backend (`apps/server/src/server.ts`), the SDK client (`packages/session`, which fills in the entry type it folds) and the shared workbench (`packages/ui/src/lib/durable-projection.ts`, which fills in the browser's own message mirror). A consumer's display shape stays its own adaptation; only the wire is shared. The gateway's own `/v1/*` request and answer shapes are declared the same way, under the `@hepi/protocol/gateway` subpath: the surfaces (`/v1/workspaces`, `/v1/worktrees`, `/v1/workbench`, `/v1/mcp`, `/v1/providers/auth`) are the fact owner, the gateway re-exports the declarations under the names it has always exported, and the backend and the Web adapter read them instead of keeping a copy each — a copy a type erasure would let drift silently. That subpath is a declaration, not a validator: it does not check a remote body, so a reader's own tolerance for a deployment that predates a field stays at the reader. The same rule covers the surfaces a browser reads from the client ingress: the Settings › MCP panel's answer shapes and the paste importer are declared in `@hepi/protocol/mcp-ui` and `@hepi/protocol/mcp-import`, the panel aggregate that composes them is the ingress's own (`packages/gateway/src/ingress/mcp-panel.ts`), and the browser renders both through `packages/ui`. A declaration the browser and a Node process both read cannot be owned by the workbench without making the gateway depend on the UI, so the protocol owns it — and it takes the upstream SDK's entry types as a **type-only** devDependency, which keeps the runtime graph unchanged: no emitted module of the protocol package imports a runtime SDK (`packages/protocol/test/sdk-type-only.test.ts`). `packages/gateway` therefore depends on `@hepi/protocol` and not on `@hepi/ui`, and no subpath forwards a moved declaration: a consumer imports the shape from the protocol and the workbench's own behavior from `@hepi/ui`, so a re-export cannot become a second owner. The browser cwd vocabulary follows the same split — `workspaceRoutingLocation`, `workspaceIdOfRoutingPath`, `isWorkspaceRoutingPath`, `UNBOUND_CWD` and `isUnboundCwd` are `@hepi/protocol/files`', and `packages/ui/src/lib/project-routing.ts` keeps only the project rules built on them. Protocol delta consumers require contiguous revisions and resync on gaps. Conversation SSE sends one full snapshot and then delta frames: each advance carries `baseRevision` — exactly the revision the clients hold — plus `appended`, the entries the advance produced, and the window's own `oldestEntryId`/`hasMore`, with every scalar full, so a frame costs what the turn produced rather than the whole transcript. A client applies a frame only when `baseRevision` matches its own revision and otherwise takes a fresh bounded snapshot. Delivery revisions are process-local and counted per attachment instance, and each snapshot carries an opaque `projectionId` naming that instance, so a client comparing two reads can tell a counter that restarted from one that advanced; reconnect begins with an authoritative snapshot, including after backend restart.

The backend snapshot contains committed structured model messages, live assistant and tool projections, the native run's inputs, settings, queues and the conversation's outstanding submission projections. The same complete payload answers both the stream's snapshot and `GET /api/conversations/:id/state`, and a terminal input's projection carries the `answerId` of the answer entry that settled it. The client ingress forwards that payload and the entries page for every conversation read
(`GET /api/conversations/:id`, `/state`, `get_state`, `/context`) unchanged; the one owner of that UI-shape adaptation
is `packages/ui/src/lib/durable-projection.ts`, so no field the backend did not state can appear in a read. It is assembled from two native durable streams per conversation: `conversation.watch()` for the committed view, acquired atomically with its registration for later commits and recovering from overflow with a fresh frame, and `watchEvents()` for the submission lifecycle, which changes no entry or document and would otherwise be invisible. Slow SSE connections are disconnected once their pending output exceeds 1 MiB; clients reconnect rather than accumulate unbounded snapshot buffers.

## Submission lifecycle and event stream

A submission is durably admitted before it is answered: `conversation.submit` records it with the browser's
`requestId`, and the runtime scopes that id to the conversation, so a retry of the same request is admitted once
instead of appending a second turn. The record then moves from admitted to a terminal state (answered, or failed with a
reason) while the transcript holds the committed message. `requestId` dedup, the durable submission records and the
rejection path are implemented. Submission-outcome recovery — asking the conversation for a submission whose outcome
was never learned, and never resending automatically — is implemented as
`GET /api/conversations/:id/submissions?requestId=` ([ADR 0006](adr/0006-durable-submission-lifecycle.md)). It answers
the durable record or null and resends nothing.

Current conversation delivery is a snapshot plus delta publications: after the baseline each state frame carries
`baseRevision` and `appended` with every scalar full, so a reconnecting client still begins with an authoritative
snapshot and an advance costs the turn rather than the transcript. `pi-durable` 1.1.0's `watchEvents` — an atomic
snapshot plus batched agent events whose overflow collapses to a fresh snapshot — is the submission event source, and
`conversation.watch()` is the committed view's; the delta is assembled in the backend from those native views rather
than being a native wire path of its own.

A settlement is the one lifecycle fact a state frame cannot carry: the settled submission leaves the outstanding set,
so a state-only client would read its absence rather than a fact about the turn. The backend therefore emits a
`submission` frame per lifecycle transition, carrying the stable `SubmissionProjection` — status, owning entry and
durable reason — to the clients following that conversation. It is live and never retained or replayed, so memory does
not grow with finished turns: a client that arrives later reads the outstanding set from the snapshot, which is
truthful, and asks `GET /api/conversations/:id/submissions?requestId=` about the turn it is waiting on. The backend's
existing `resync_required` marker is the signal that a frame was missed, and the Web side answers it and every
reconnect by looking up each turn still waiting rather than inferring anything from a later frame.

The client consumes that projection through `packages/ui/src/lib/lifecycle-projection.ts`, a pure conversation-scoped
module with no React, no socket, no timer and no I/O, entered through `createProjection` and `advance`: it validates,
orders and folds observations from either transport into one view — the committed transcript, the staged overlay, the
answer interest and the native run — plus the notices to show and the effects for the caller to perform.
`packages/ui/src/lib/lifecycle-acquisition.ts` names the wire, stamps each read or stream with the client acquisition it
began under, and is the **one accepted-facts receiver**: `httpStatement`/`sseStatement` normalize a complete read into a
fold input plus the facts that travel beside its window, and `receiveAccepted` folds it once and reports whether it was
accepted. The hook's `receive` publishes those common facts from that one report, so the two transports cannot write
the same fact under two rules. The same step publishes the **accepted readout**
(`packages/ui/src/lib/conversation-readout.ts`): the accepted window, the older pages the reader loaded in front of it
and that window's pagination claim, with the prefix decided synchronously by the shared `decidePrefix` rule against the
window the readout already holds — so a moving window and the prefix it keeps are one decision rather than a render
that catches up with the previous one. The claim follows the same rule: a page that reached the start of history keeps
`hasMore` false while the prefix it produced survives, and only a dropped prefix (new conversation, moved head, or a
window that became the whole active range) puts the window's own claim back. Metadata that is not derivable from the window (session stats, the history token
and head marker, the active leaf, the display model) stays on the accepted payload the readout carries, and the
stream-local `SessionState` stays a transport-continuity value beside it.
`packages/ui/src/lib/lifecycle-store.ts` holds one value per composer or conversation in
memory for the life of the page. A conversation's **UI I/O** is one explicit value,
`packages/ui/src/lib/conversation-session.ts`: the stream reader the surface holds (joined through the shell's one source
per conversation), its reads (single-flight per conversation, with a forced read sharing nothing), the one admission path
for an immediate send, a steer and a follow-up, the by-id lookup that repairs an unknown outcome, the Backend's own
reload, and the release that gives the reader back. It performs no ordering of its own and owns no timer, retry queue or
socket: the pure fold decides what an answer means, and `packages/ui/src/hooks/useAgentSession.ts` renders that decision
and performs what the fold requests. A reload of the conversation on screen is therefore a read and a re-acquire, not a
new attachment — the chat keeps its tree, its stream and the reader's place, and the shell no longer states a mount key
for it. That operation has one owner — the hook's `reloadResources`, which the `/reload` command and the registered
reload Settings › General calls are both that one function, so the two cannot report different outcomes for the same
facts. Settings states that the tools configuration changed, awaits the answer, and does not ask the route itself; a
caller that also did would reload twice. What the notice claims is what the **read** established, and a read is a typed
outcome rather than a nullable one (`ConversationReadOutcome`): `accepted`, `refused` (the fold called the window older),
`missing` (`not_found`), `failed` (with the `ReadFailure` kind the surface offers recovery for), `cancelled` and
`superseded` (another connection or conversation is on screen). A `refused` read ends there: the auxiliary agent-state
query is a read of its own, but a caller acting on its answer would resume a run or claim a reload from the very window
the fold rejected, so no state is asked for on behalf of a window nothing accepted. A route that rejects is answered
inside that operation as a `failed` outcome — it establishes nothing, so no read is asked for a change that never
happened, and the rejection cannot escape into a caller that awaited it — but only when the route's connection is still
the one on screen: a rejection that lands after a switch is one host's failure about a conversation nothing shows, so it
is `superseded` and states nothing. One reload is one notice: the `/reload` command calls that same operation and returns
its outcome without restating it, so the operation is the only surface that reports what happened. Every read is also fenced by the **connection** it was asked through, not
only by the conversation id: a switch replaces the client and its API, so an answer — a window, a `not_found` or a failure — that arrives after
the switch is refused rather than published onto the new connection's surface. The hook does not infer a
submission's fate: the overlay ends at the turn's own committed entry, the answer interest survives that commitment,
and a run's outcome is the runtime's live terminal fact carrying its answer identity. A notice is keyed by that answer,
so a steer group sounds once; an abort, failure or withdrawal shows its reason and never sounds; and an acquired
baseline, a reconnect or a recovery lookup is silent. Nothing is persisted in browser storage, so a refresh re-reads
the conversation and an outcome that could not be established stays unknown until the by-id lookup resolves it.

Background completion is the same rule applied to a conversation the user is not looking at.
`@hepi/session/browser` serves one source per conversation with a subscriber list, so the open
surface and a background interest in the same conversation are two readers of one stream and selecting a conversation
hands the existing stream over instead of reconnecting it, while the surface's own projection travels with it
(`onProjectionChange`) so the watch continues from the turns and interests the surface was still waiting on. `packages/ui/src/lib/completion-delivery.ts` is the shell's
interest map — which conversations the live path has in hand, each one's place on that shared stream, and the answers
already noticed — and the page's one registry of live settlements: every surface reports what it observed there, and the
registry's answer is whether that caller is the one that reports the completion, so one answer is one tone however many
owners saw it. It folds a background conversation's live frames through the same pure projection, so the notice rule
stays in one place, and it folds nothing for the conversation on screen, whose own surface owns those frames. The
existing visible-tab poll nominates candidates and decides nothing: whether a run finished is the stream's own terminal
fact, never a `busy` disappearance. The absence-based background tone that predated this delivery is gone, so the tone
has one owner and one source. The unread marker is not that absence either: the catalogue row states when each
conversation's newest run ended, read from the run's durable receipt, and the sidebar diffs it — so a run that starts and
finishes entirely between two polls still leaves a marker, though it is never observed live and so never sounds. See
[ADR 0007](adr/0007-lifecycle-facts-one-projection.md).

## Execution

Conversation metadata persists only a logical workspace ID. Backend deployment configuration resolves that ID to a gateway endpoint/token; gateway configuration resolves it to physical roots/SSH profiles. Browser paths are virtual /workspace/<id>, never arbitrary workstation roots. A **Project** adds runtime-registered roots: each Web origin names which of the backend's configured gateways serves its own execution host, and the existing folders chosen there are registered on that gateway as more workspaces. A project holds several folders of that one computer with exactly one of them its default, and a new conversation binds the default while every folder stays resolvable for the conversations already bound to it. That host may also be a **configured SSH host**: one gateway plus one SSH profile, whose own directories are browsed and whose chosen root is confirmed and canonicalized by the remote host. A workspace id resolves to a profile and a root through one explicit owner map in the gateway's registry, shared by execution, files, installation and workspace management, so no surface parses an id's spelling. A **recorded Project** then names its own host for its own metadata: changing its default, unlinking a folder and removing it resolve the host the Project records, not the one the calling Web origin serves, so a remote Project is managed from the origin showing it while a caller naming a different host is still refused. The backend's `apps/server/src/project-registry.ts` is the one owner of that resolution: it holds the configured workspaces, the optional ProjectStore, the gateway connections and the live metadata, answers the catalogue's workspace facts, replays registration on boot and before a request, and owns the process-local `projectsRevision` — so a route never edits a project list or a revision itself. It also owns the four project mutations: a creation resolves the host its origin named, validates that host's profile and registers every folder before recording anything, while the default change, folder unlink and project removal resolve the host the **Project records** and act on it; each returns the committed metadata or its own refusal, so a route encodes an answer instead of deciding the workflow. See [docs/projects.md](projects.md), [ADR 0003](adr/0003-projects-bind-runtime-registered-workspaces.md), [ADR 0004](adr/0004-one-project-many-folders-one-default.md) and [ADR 0005](adr/0005-ssh-project-one-profile-explicit-owner.md).

The same Project registry owns checkout list/create/remove workflows. It joins host listings with folder targets, records a created checkout after host registration, and refuses a default-folder removal before host mutation. Successful removal unlinks and retains its folder binding through the existing metadata workflow. Failed metadata writes after host success report `not_recorded` without publishing a revision or retrying host mutation.

A call's output is captured per stream so a repeated call ID can be answered from the ledger without running the command again. Each stream owns its own chunks, retained UTF-8 byte count and clipped state, appends measure only the text they are given, and the retained text is joined once when the call ends — so a command that writes very many small chunks costs what it wrote rather than a rescan of everything already kept. The bound is `captureBytes` per stream, a cut lands on a complete character, and `truncated` reports only what the ledger dropped: the live caller still receives every chunk in full. This is a different unit from the terminal stream's own pending-byte budget and from the snapshot cache's code-unit measure, and it has its own owner.

Published upstream CodingTools are installed as one `coding-tools` extension that carries the tools, their metadata and the wrapper of their own `execute`, so selecting the tools and giving their commands a call scope are one selection and no separate switch can leave the tools unwrapped. Their environment is an HTTP capability adapter.

**Execution identity is scoped to one tool call, one command at a time.** The runtime hands the call's conversation, task and call ID to `ExecutionHostEnv.forCall`, which opens an isolated scope; the n-th `exec` in that scope runs as `<conversation>:<task>:<call>#n`. Two commands in one call are therefore two executions with their own ledger entries, whether or not they are the same command, and a repeated network request for one of those identities is still answered from the gateway ledger without running the command again. A command executed outside a call scope — a caller that builds the environment itself — uses a random ID and makes no dedup claim. An ordinary `ExecutionEnv` has no scope to open and no environment at all stays none, so both pass through untouched. The identity is not promised across attempts: a later attempt of the same intent opens a new scope.

**One client owns the backend's gateway transport.** Every backend call to a gateway goes through
`GatewayHostClient` (`packages/gateway/src/client.ts`), built from the binding the backend already resolved and read
through four namespaces: `process` (execute/abort), `control` (workspaces, worktrees, workbench, MCP, installs),
`files` (the `/v1/files` RPC plus the upload-check, upload and bytes payload routes) and `terminal` (open, input,
resize, close, describe, one session's events and one host's page-wide fan-in). The client owns origin joining, the
bearer header, each route's own bound, caller-abort composition, response validation and the classification of a failed
or lost answer; the route never does. A definitive refusal keeps its status and wire code, a connection that never
opened is offline, and a mutation whose answer was lost is `outcome_unknown` and is never replayed. The server keeps
only its own business: workspace/profile resolution, browser-facing status and DTO mapping, and — in `file-relay.ts`
and `terminal-relay.ts` — Node stream control (half-duplex upload bodies, byte streaming and backpressure, header
pass-through, caller-disconnect cancellation, per-binding SSE fan-in). No backend production source builds a `/v1/*`
request or a gateway bearer header; `apps/server/test/gateway-client-boundary.test.ts` fails if one appears.

**What the identity record covers, and what it does not.** The gateway's ledger is the only duplicate protection, and it protects execution calls: the same ID under one gateway and workspace is never run twice, a different request reusing it is refused, and a call left admitted or dispatched by a restart is answered `outcome-unknown` rather than replayed. File operations carry no call ID and have no journal, so a write whose response is lost reports an unknown outcome that the caller cannot resolve; read operations repeat idempotently. Upstream durable recovery reruns only tools declared safe, and no installed tool declares it, so the default unsafe `write`/`edit`/`bash` intent becomes interrupted after a backend crash instead of being replayed. Gateway dispatch loss remains outcome-unknown unless no dispatch can be proven, and the execution environment keeps that statement at the tool seam: a lost command answer reaches the caller as `outcome_unknown` with the spent call ID named, not as one generic failure, while `timeout`, `aborted` and a definitive refusal stay what they name. This is conservative safety, not an exactly-once distributed execution claim.

Read-only local workbench helpers come from pi-gui via preserved snapshots and explicit import/contract adaptation. API selection/authentication stays server-side. The browser terminal already runs a real PTY on the gateway (`pty.fork`); what stays out of selected ticket scope is the pi-gui desktop `ExecutionEnv` interface and full desktop host migration, not PTY itself.

Worktree list, create and remove are a gateway host capability of their own (`POST /v1/worktrees`), served by a local and an SSH gateway alike and adapted from pi-web's `lib/worktree.ts`; see [workbench](workbench.md#worktrees). The dormant client-side copy of that module was retired, so the gateway is the only executable implementation. The browser picker is wired to it through the workbench's connection: a created checkout is recorded as a folder of the project — because a conversation binds a workspace, not a directory — and a removed one drops that record while its binding is retained, so a conversation already bound there keeps running. A checkout this deployment records no workspace for is listed and is not a target.

## Gateway composition

One Gateway composition is shared by every entry that starts one: `packages/gateway/src/startup.ts` (published as
`@hepi/gateway/startup`) consumes the resolved local or SSH settings and owns the registry every surface shares, the
call journal, the SSH runner and its managed master, the surfaces, the loopback listener and the close order. The
gateway's own environment-configured entrypoint (`packages/gateway/src/main.ts`) and the packaged CLI
(`@hepi/client`) each keep only what belongs to an entry — reading configuration and defaults, their own output and
signal handling — so both apply the same resolved configuration, capability set and shutdown behaviour. A workspace the
backend registers at runtime is served by execution, files, installation, workspace management and worktrees at once
because they read one registry; a startup that fails releases the journal and the SSH master it created before it
reports the failure.

The SSH transport itself is part of those resolved settings (`sshTransport`): absent, the composition reads the
system `ssh` and owns a master socket directory beside its journal; stated, it composes over that transport and, when
it states `controlDirectory: false`, creates no socket directory at all — which is what a gateway reached by a
transport answering the host in its own process states. Only the transport changes; the surfaces, registry, close
order and everything a caller sees stay the same.

`GatewayRpcServer` keeps one listener, one composition owner and the facts that belong to every route: which
routes exist at all, the credential check before a body is read, the outer safe failure and the unknown-route answer.
Each transport family owns its own framing beside it — `src/transport/file-payload.ts` the upload, upload-check and
byte-range routes (query, host failure statuses, atomic staging, chunked download and the reader release), and
`src/transport/terminal.ts` the terminal routes (route recognition, `Last-Event-ID` before `after`, per-tab fan-in
cursors, replay-before-live ordering, keepalive frames and the pending-byte budget). A change to a cursor rule or a
payload status is therefore a change to one family and its contract checks, not to the dispatch that admitted the
request; the families borrow the capability instances and dispose of nothing themselves, because the composition owner
still closes terminals, provider logins, MCP, files, HTTP connections, the gateway and the listener in that order.

Four more families sit beside those two, each owning the framing and lifetime rules nothing else shares.
`src/transport/execution.ts` owns the call stream (one NDJSON output frame per chunk then exactly one result frame, the
1 MiB pending-frame budget, and the rule that a caller who stops listening does *not* stop its call) and the abort route
that is the only thing which does. `src/transport/mcp.ts` owns the MCP operation's own lifetime: a response that closes
before it is written aborts the signal the service was handed, and a host serving no MCP answers `mcp_unavailable`.
`src/transport/providers.ts` owns the opposite rule for the neighbouring route — a sign-in is the host's work, so no
socket's close reaches it, while the credential listing beside it completes within its request. `src/transport/control.ts`
owns the remaining JSON surfaces (workspaces, worktrees, workbench, the file RPC, installations): which absent capability
answers which named limit, the workbench's caller-disconnect abort with its 409 refusal, and the serialization of a
capability's own error as its code and message. The entry keeps route recognition, the one credential check, the unknown
route and the outer safe failure, so an unknown path is a 404 whether or not a caller held the token.

Local and SSH are mutually exclusive modes of that one composition. An SSH gateway seeds its registry from its profile
under the `remote-<profile>` id the protocol already addresses — a configured id that names anything else is refused
by both entries with the same wording rather than silently ignored — and serves no MCP, which belongs to the Web host's
own account. The terminal stream's keepalive cadence is part of the resolved settings, so both entries accept and
refuse the same values and `0` states no keepalive.

## MCP

MCP is the one capability whose owner is neither the backend nor the client: it belongs to the **Web host** — the
account and filesystem of the machine the Web origin runs on — and is served by the gateway process already running
there, as a new operation beside `execute`, `files`, `installs` and `workbench`. The client ingress carries the
browser's requests to that service directly, never through the backend, so no MCP credential reaches the durable
runtime. The backend takes part in MCP exactly one way (ticket 02): it calls the route's `invoke` operation for a tool a
conversation selected, as a native durable tool, with the conversation's own execution binding — it reads no `mcp.json`,
starts no server, holds no OAuth state and receives no credential in either direction. A gateway that serves no MCP (an
SSH gateway, or one constructed
without the capability) answers a named limit and every other setting keeps working. Settings › MCP is wired to
that service: the panel reads the ingress's aggregate of the host's own listing, its test results and the folder's
trust decision, and every write is one operation on the host. See [MCP on the Web host](mcp-on-the-web-host.md).

## Provider connection state

Provider credential I/O has a third owner, and it is the execution host rather than the backend: the account whose
`<home>/.pi/agent/auth.json` holds them. Provider listing, sign-in and API-key set/remove are served on
`POST /v1/providers/auth` by the **local** gateway, beside `/v1/mcp` and for the same reason — that account is the one
this Web host owns, while an SSH gateway's `auth.json` belongs to a remote account.

The two directions stay apart. **Credential management is the host's**: a key written by a person travels from an
authenticated caller to the client ingress and on to that one host, and stops there
(`packages/gateway/src/provider-auth.ts`); the Backend receives no credential over the wire and routes none. **Model
resolution is the Backend's**: it builds its registry from the account it was configured with, so in `HEPI_CONFIG_SOURCE=pi`
mode it reads that host's own `auth.json` because that file *is* its configured account, while in the default environment
mode its account is its process environment and an in-memory store and no file is read. Which files exist is therefore a
consequence of the mode, not a second owner ([providers](providers.md)). The browser half is the ingress answering
`/api/auth/providers` and `/api/auth/api-key/:id` from the same configured host service MCP uses
(`packages/gateway/src/ingress/providers.ts`), and the panel's half being `packages/ui/src/lib/provider/provider-auth.ts` — routes,
row shapes and the notice each refusal earns.

The provider set and every provider's auth semantics come from `@earendil-works/pi-ai`'s own `builtinProviders()`, so
this repository declares no provider list, no auth protocol and no second credential format: storage is pi's one
`{ type, ... }` record per provider id, written under the same `proper-lockfile` lock the pi CLI's
`FileAuthStorageBackend` takes, replaced through a same-directory `rename`, with directory `0700` and file `0600`
re-applied on every write. A missing file is created *inside* that lock, by an exclusive create that tolerates the file
already existing: several processes write one account's credential file (this service, another process of it, the pi CLI
signing in), and one that created the file because it saw none yet would truncate what the writer it was waiting for had
just stored. The same ordering rule reaches past the credential file: a provider that asks this host for its installation id
(OpenAI names an agent host by one) asks *before* any credential exists, so that write is the agent directory's first write
and creates it itself — recursive, `0700` — ahead of the locked step above, which would otherwise arrive too late and turn a
fresh account's first sign-in into a storage error.

A flow's last word to the file is its store write, and that write is handed the flow's own abort signal. The two moments the
store owns — waiting behind another writer, and committing what the provider returned — are each checked against it, so a
sign-in this host ended cannot leave a credential stored merely because its exchange had already succeeded: an abort throws
the reason it carries, asks the credential decision no times, and never replays it on a later attempt. A legitimate wait is
unchanged — one lock still covers read-decide-write, and the decision runs exactly once.

A listing reports `configured` (the provider's own `apiKey.resolve()`, which covers ambient
env/AWS/ADC sources too) separately from what this host stores (`storedType`), plus a display-only `maskedHint` of a
stored key; a mutation answers that listing and never the value written, so a caller cannot read back a secret it sent.
Every failure is one of a fixed code set with this service's own sentence — never the upstream message, which can quote
the value it choked on.

The relay is ticket 02 and is delivered. Ticket 03 adds the flows beside it: `@earendil-works/pi-ai`'s own device,
manual and copy-code logins run on that host against the same locked `auth.json`
(`packages/gateway/src/provider-login.ts`, `packages/gateway/src/provider-credential-store.ts`), served on
`POST /v1/providers/login` and reached by the browser as `/api/auth/login/:id` (start, poll, answer, cancel) and
`POST /api/auth/logout/:id` (the removal). A provider's sign-in capability is read from the catalog entry the SDK itself
declares `auth.oauth`), never inferred from a credential this host happens to store: a provider whose pi record carries
only an API-key authenticator — DeepSeek, Groq, HuggingFace, Xiaomi and the Cloudflare gateways are of that shape — has no
interactive login to run, and the host refuses one as `unsupported_operation` rather than starting a flow that could only
end in failure, while Anthropic, OpenAI, GitHub Copilot, xAI, Kimi, Meta and OpenRouter do have one. The panel asks the same
field the listing already carries (`hasOAuth`, reported per provider on `GET /api/auth/providers`), so no second capability
route exists here to keep in step with the first. No OAuth protocol logic is reimplemented here: this repository holds no
authorization endpoint, no token exchange and no PKCE, and the flow's state is the host's rather than any one caller's
socket. A flow belongs to the caller this ingress admitted, never to the shared host bearer, so one client cannot answer
or cancel another's sign-in; a caller whose device credential is revoked has its open flows forgotten by this entrance
before they can store a credential nobody can reach. What a person typed and what the flow produced are masked out of
every step and error in both directions, and neither is ever a response this surface writes.

Ticket 04 is the availability question ticket 02/03 left, and its answer is that no owner signals to the other. The
Backend re-resolves which models a credential authenticates from the account it was configured with on each catalog read
— in Pi mode that account is the very file the Gateway writes and it is re-read rather than cached, in environment mode no
file is consulted at all (docs/providers.md) — so a credential change needs no route, no invalidation message and no
restart on the server side. What a credential change does make stale is the catalog *this page* cached, and the owning
surface drops it: `packages/ui/src/lib/models-cache.ts` holds the one instance and `invalidateModelCatalog()` is what a
key save or removal, a sign-in and a sign-out each call, the same rule a `models.json` save already followed. A catalog
*pass* (fetching which models exist at a provider) is a separate capability, needs a network read of a third party, stays
a named limit, and its control is withheld on that limit rather than reported as a provider's endpoint being unreachable.
See [.scratch/provider-connection/issues/04-model-refresh.md](../.scratch/provider-connection/issues/04-model-refresh.md),
[ticket 03's record](../.scratch/provider-connection/issues/03-pi-ai-login-flows.md)
and [ticket 02's record](../.scratch/provider-connection/issues/02-web-auth-relay.md).

## Current subset and explicit gaps

The connected presentation subset and the surfaces that still answer 501 are listed per route in
[client ingress](client-ingress.md#the-client-api); the server-side conversation contracts are in [docs/chat.md](chat.md) and
the gateway file/Git subset in [docs/workbench.md](workbench.md). The gateway serves an interactive terminal session
on its own `/v1/terminal` surface ([local integration](local-integration.md)), and the browser panel reaches it through
the client ingress and the backend, which resolves each request's routing cwd to the host that owns it.

The browser holds **one** terminal stream for every mounted tab, not one per tab: `/v1/terminal/events?tabs=` carries each
tab's frames with the session named, so the page spends one connection on terminals however many tabs it has open. The
attachment is what keeps a shell running, and it is held for exactly as long as its tab is mounted — including a tab of a
closed panel — so the existing reconnect lease, replay bound and `reset` semantics are unchanged; a closed tab releases
its attachment and its lease then runs. A cursor is the *widget's* read position, stated by the terminal that read it
and kept for the reconnects that happen underneath: a stream that drops continues from it, so the screen a user is
reading is neither cleared nor replayed at them, while a terminal that is built afresh (a panel whose effect re-ran) has
read nothing and names nothing, so the host answers the retained tail and the terminal refills itself. The backend merges
the hosts' streams because two tabs of one page may belong to two workspaces, and a host stream that ends ends the
page's, which is what re-attaches that host's tabs instead of stranding them. The page's background conversation watches
are budgeted against the same per-origin connection limit ([chat](chat.md)). Session export remains an unimplemented capability with retained upstream controls, not a silent stub; workspace
file upload and binary preview/download are implemented through the gateway's file payload routes (`POST
/v1/files/upload`, `POST /v1/files/upload-check`, `GET /v1/files/bytes`) and the copied explorer and viewer above
them, so no document should describe those as pending. The MCP capability is implemented and
documented above, browser dialogs included.

## Trust boundary

Token auth/private networking or HTTPS protects links. Command allowlisting grants explicit capabilities, not a kernel sandbox: allowing bash authorizes arbitrary scripts as that user. Lexical/realpath confinement protects cooperative filesystem requests but is not race-free protection against hostile concurrent root mutations. See docs/local-integration.md for bounds, cancellation and capability details.

## Package management

Formal workspace uses pnpm, pnpm-workspace.yaml and root pnpm-lock.yaml. Upstream baseline clones use their native recorded lockfiles/toolchains and remain separate from app dependency management. Provenance and retained/removed paths are recorded in docs/upstream-sources.md and docs/migration-status.md.
