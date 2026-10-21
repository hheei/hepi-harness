# Subagent runtime: ownership, reuse, plugin seam, two candidate interfaces

Status: historical exploration against 1.1.0. Current scope, ownership rules and implementation prerequisites are in [the final proposal](conversation-api-proposal.md). Read-only research: no code, build, test, deploy, graph update or paid-model call.

## Method

`graphify query "subagentParentConversationId" --budget 1000` answered **"No matching nodes found"**; `query
"subagent"` resolves to the **legacy pi-web copy** (`apps/web/lib/subagents.ts`), never to the durable runtime. Every
pi-durable fact is from the installed
`@earendil-works/pi-durable@1.1.0` (`{dist,README.md}`) or source. Three "subagents" stay apart:
**pi-durable application subagents** (task-owned conversations in `apps/server`, this report's subject); **pi
coding-harness workers** (`.pi/agents/*.md` via `@hheei/pi-subagents`, separate Pi processes); and **Codex**, researched by
worker 80.

## Confirmed current state

No subagent extension is installed and no backend route creates a task-owned conversation (`harness.ts`,
`server.ts:1602, 1813`). The catalogue reports `subagentParentConversationId` from `record.owner` and fork refuses a
task-owned conversation with `code:"subagent"` 409 (`server.ts:245-248, 742, 1043, 1059, 1795`); the Web Sub-agents
Settings panel's `/api/subagents/{profiles,settings}` is unserved, so the Web fallback answers `501` (`AgentsConfig.tsx:211,249`, `adapters/durable-api.ts:798`).

## Ownership: run-owned delegation vs conversation-owned background task

| | Foreground (synchronous tool call) | Background |
|---|---|---|
| Child owned by | the call's `ToolTask` (`{kind:"task", taskId: api.taskId}`) | a task the caller creates: `{kind:"conversation"}, background: true` (`dist/types.d.ts:229-239`) |
| `Conversation.abort()` reaches it? | yes — the run task is marked, then every non-background task below a cancelled owner (`scheduler.js:281, 395, 410`) | no; only `Conversation.abort(ctx, {background:true})` crosses in (`tasks.abortConversation(id, options?.background === true, context)`, `harness.js:67, 276`) |
| Can the parent run finish first? | no — a task finishing while its owned work is live is `completing` (`README.md:450`) | yes — "the parent's Esc and idle waits never reach it" (`README.md:459`) |

Background is a **task-creation** property, not an agent setting: `TaskRecord.background` is stored per task
(`dist/types.d.ts:470`, `task-graph.js:140`), while `AgentState`/`AgentChange` carry no such field, so the legacy
`runInBackground` has no native *field* though compaction tasks use the behaviour (`compaction.js:180-185`).

**Abort is scope-wide, not run-wide:** `Conversation.abort()` marks "every live non-background task of the ordinary
ownership scope" — "this conversation and the conversations owned, transitively, by its non-background tasks"
(`dist/harness/types.d.ts:494, 498-500`) — so one Esc also stops every foreground delegation under it.

**Exactly-once wake.** A reporter posts the answer to the parent as a follow-up input; `Conversation.submit` with a known
`requestId` "returns its existing submission without writing" (`dist/harness/submissions.js:112-122`), and a busy parent
queues in `pi.inbox` until a boundary places it. The wake is an ordinary new run whose "user" message is the report —
**no native child-result entry kind** exists.

## Reuse, lifetime, and the lifecycle verbs

**The child conversation is reusable; only the delegating task is single-lifetime.** Conversations are never deleted by
1.1.0 (no deletion primitive; `docs/verification.md:697`), and the owner edge is written once at `createConversation` and
never rewritten (`dist/session/transaction.js:111-120`), so `subagentParentConversationId` stays true after the owner
task is terminal; a later task in that conversation is a **top-level** graph node while `ConversationRecord.owner`
still links it to the parent (`README.md:502`). Continuing the child is an ordinary submission on the same conversation —
same transcript and `pi.agent` (reconfigurable anytime, applying from the next request). Children are listable through
`ConversationQuery.ownerConversationId` (`dist/types.d.ts:552`), so no new store; per tool call the owner index yields
exactly one child (`scanConversations({ownerTaskId: api.taskId}, 1)`, `README.md:418-433`), reused on **replay of the
same call**, while a **new** call creates a new child — so reuse across delegations needs the caller to name the child.

**Verbs.** *Send:* `Conversation.submit(draft, ctx)`, `whenBusy: "steer" | "followUp" | "reject"`; busy queues in
`pi.inbox`, `reject` throws `ConversationBusy` (`types.d.ts:15-27`). *Step:* none. *Resume:* `Harness.resume()`
(`server.ts:1065`) and recovery — a task `running` at shutdown is `pending` after reopen
and reruns (`README.md:502`), the tool's `replay` policy deciding whether `execute()` reruns (`types.d.ts:156-157`); a
terminal task never resumes, and `Harness` has no retry or reset-task method. *Cancel:* `Submission.abort()`;
`Harness.abortSubmission`; `Conversation.abort(ctx, {background?})`; `Harness.abortTask(id)` -> `marked | terminal`,
settling `orphaned` when no definition can take the abort; the backend serves only the third (`server.ts:1889`). A rerun
keeps the same `TaskId` and checkpoint; a follow-up is a new submission and `TaskId`.

**Missing contracts:** the wire does not separate a delegation run from later human work in the child; no ownerless
graduation (`Tx.forkConversation(parent, at, {ownership})` would allow it, but the 409 is permanent); no per-child cancel
route.

## Optional plugin: generic core vs feature extension

**Generic core primitives (not subagent-specific).** The app-owned `Registry`, the built-in tasks every registry holds — "not an extension and cannot be removed
or replaced" (`registry.js:6-8`) — and the `Extension` shape (`name`, `tools`, `sections`, `hooks`, `wraps`, `tasks`;
`dist/harness/types.d.ts:206-216`). The app already has one optional-extension slot,
`HarnessConfiguration.resourceExtension` (`harness.ts`); pi-durable has **no** plugin manifest or discovery (no `pi.extensions` field as in
`../hepi-mono/packages/pi-subagents/package.json`), so "optional plugin" means a module the host installs only when
configured.

**What the feature extension can own.** `tasks` carries its `defineTask` definitions; `tools` the delegate tool;
`hooks` and `wraps` (`wrapTool`, `wrapSection`) adapt core tools and sections *wherever the extension is selected*,
without editing them; `sections` renders usage text when selected. The profile loadout is data: the
extension defines its own document and applies it with `configure(tx, childId, change)` in the creating commit, since
`AgentChange` is the only native loadout shape.

**Host integration gap.** The native `Extension` has no HTTP surface
(`types.d.ts:206-216`), and `apps/server` has a single optional-extension slot,
`HarnessConfiguration.resourceExtension` (`harness.ts`). That is a wiring gap, **not** a mandate
to put subagent logic in core: the plugin *package* can export the native `Extension` **plus** an optional host HTTP
adapter for `/api/subagents/{profiles,settings}` that the composition root mounts only when the plugin is configured,
with a small generic host seam (configured route modules, or an extension-declared route table) if needed. In order of
preference: mount the adapter behind that seam; serve the same data from the generic catch-all if it can be made
data-driven; or retire the panel's profile route (and its `501`) when the plugin ships without settings. Mandatory
subagent logic in core is the one thing to avoid.

**Disabled vs uninstalled, with runs in flight.**

| | Unselected for a conversation | Uninstalled from the registry |
|---|---|---|
| Tools, sections, wraps, hooks | not offered, rendered, applied or run — selection filters `agent.tools` (`README.md:210`) and hooks come "from the extensions its conversation selects" (`TaskRuntime.hooks`); an emitted call settles as `tool_unavailable`, an error result, not a fault (`tool.js:24-28`) | same |
| Task kinds | **still resolvable** — `Extension.tasks` are "resolved by name for every task, whichever conversations select this extension" (`types.d.ts:214`), so selection cannot stop runs | a pending task resolves `blocked`/`missing_task` and the reserve pass `continue`s (`scheduler.js:677-685`), so it stays **live** and `inspect()` shows `{kind:"blocked", reason:"missing_task"}` (`scheduler.js:9, 95, 742, 768-778`); reinstalling runs it (`registry.subscribe` -> `#kick` -> `#reserve`, `scheduler.js:91, 633-639`). A running invocation keeps its snapshot, reporting only a `missing_task` diagnostic (`scheduler.js:862-874`) |
| Explicit abort while missing | — | `Harness.abortTask` -> `scheduler.abort` settles `{status:"orphaned", reason:"missing_task"}` (`harness.js:166-168`, `scheduler.js:138-143`); an abort-marked task in a reserve pass likewise (`scheduler.js:677, 680-683`). Terminal is irreversible: the record leaves `#live` (`scheduler.js:224-227`) and reopen scans only `LIVE_STATUSES = ["pending","running","waiting","completing"]` (`scheduler.js:9, 95`), so reinstall never resumes it and `abort(id)` on it returns `"terminal"` (`scheduler.js:133-134`) |
| Core chat | unaffected | built-ins cannot be removed (`registry.js:6`) and `install()` throws on a duplicate task name or bad section key while the server catches per extension (`harness.ts` -> `failures`). "Unaffected" is not "no impact": a child left `blocked` keeps its parent `completing` (`README.md:450`), and an unavailable tool settles as an error result (`tool.js:24-28, 52-53`; `generation.js:426-449`) — a delegation can lose its answer or stall |


## Two coherent interfaces

**A. Minimal profile/delegate extension.** One session-scoped profile document plus one tool,
`subagent({profile, task, continueAs?})`, returning the child's answer or an `isError` carrying its outcome status. The
child is created inside `api.commit()` with `{kind:"task", taskId: api.taskId}`; a rerun reuses it through the owner
index; its agent is the owner's copy plus the profile `change`; the request id derives from `api.taskId`. Ordering:
create -> configure -> details -> submit -> wait; an unknown profile fails before any commit; a child settling `failed`/
`aborted`/`orphaned`/`faulted` is the outcome status.

**B. Task-control interface.** A derived `SubagentNode {conversationId, parentConversationId?, taskId, kind, status,
phase?, background, abortRequested, outcome?}` on `ServerSnapshot` (`packages/protocol/src/index.ts:201`), plus `GET /api/conversations/:id/subagents` and `POST .../:childId/{abort,steer}`, folded from `harness.watchTaskGraph`
over the `ownerConversationId` child set. Invariant: derived, never stored; `terminal` beats any placed or running fact.

## Recommended smallest useful first delivery

**A as an optional extension, foreground-only**: one `defineExtension` (task definitions, delegate tool, section,
profile document) installed only when configured; deterministic request id, child configured in the creating commit, the
extension removed from the child to stop recursion. The plugin package carries the HTTP adapter above.

## Unresolved decisions, ranked

1. **Foreground or background by default?** Sets whether Esc kills children.
2. **Reuse semantics and profile home**: may a delegation continue an earlier child, and do profiles live in the
   extension's document or each conversation's `pi.agent`?
3. **Plugin opt-in shape and host seam**: a `main.ts` configuration like `resourceExtension`, or discovery the repo
   lacks; and whether the HTTP adapter needs a route seam.
4. **Wake shape and visibility**: the report arrives as an ordinary user message, and no runtime concurrency cap or
   per-child abort exists without interface B.

## Verification seams

- `apps/server/test/session-fork.test.ts:216-251` already builds a task-owned child through
  `openServerHarness(..., { resourceExtension: defineExtension({ tasks: [Holder] }) })`, `tx.createTask` and
  `child.submit(...)`; a delegation
  test is that fixture plus one tool call (`startPaused: true`, faux provider). Two independent lifecycle cases, not one
  sequence: (1) with a pending task, `registry.uninstall(extension)` -> `inspect()` shows `blocked`/`missing_task` and the
  task is still live -> reinstall -> it runs; (2) with the definition still missing, an explicit `harness.abortTask(id)` ->
  terminal `orphaned` -> reinstalling does not revive it (`abort(id)` returns `"terminal"`).
- No second `pi` process (`vendor/pi-web/lib/subagent-runtime.ts`, ADR 0001) and no parallel scheduler or conversation
  owner; child history is **not** inherited, so "continue the child" means submitting to it.
