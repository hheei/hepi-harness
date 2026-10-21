# Conversation core API: children, references, control

Latest user direction: design relationship records together with the conversation history tree; the extension interprets configured context preparation. The consolidated proposal follows that direction rather than requiring independent children/parent/references services.

Status: alternative design input; the consolidated minimum is in `conversation-api-proposal.md`. Route choices, mutable display-parent relationships and anchor defaults below are proposals, not approved requirements. Source-confirmed against `apps/server/src/server.ts`, `apps/server/src/harness.ts` and
`packages/protocol/src/index.ts`. No implementation, tests, builds, deploys or graph updates.

## What the backend already serves (source-confirmed)

Catalogue and creation: `GET /api/conversations` (one row per conversation: `busy`, `revision`,
`messageCount`, `title`, `lastRunEndedAt`, `subagentParentConversationId`), `POST /api/conversations`
(`{workspaceId?}`, created ownerless with the extension selection materialized into `pi.agent`), `GET /api/search`.
Per conversation (`server.ts` `handle()`): `GET /:id/state`, `GET /:id/entries?before&tail`,
`GET /:id/entries/:entryId` and its `/thinking`, `/text`, `/tool-result-image` read blocks,
`GET /:id/submissions?requestId`, `GET /:id/commands`, `GET /:id/settings`, `PATCH /:id` (name),
`POST /:id/auto-name`, `PATCH /:id/settings`, `PATCH /:id/extensions`, `POST /:id/fork`, `GET /:id/events`
(SSE: snapshot/delta/submission/resync/state_oversize), `POST /:id/messages` (202 + submissionId, 409
conversation_busy, `whenBusy` steer|followUp|reject), `POST /:id/busy`, `POST /:id/abort`,
`POST /:id/recall-queue`, `POST /:id/reload`, `DELETE /:id` (tombstone).
In-process: `createBackendServer` -> `attachConversation(conversation, harness, …, ancestry {forkSource, subagentParent})`
-> `ConversationRuntime {conversation, snapshot(), title(), deletedAt(), lastRunEndedAt(), catalogueStats(), view(),
extensions(), clients, parentConversationId?, subagentParentConversationId?, close()}`. Outstanding work is read
through `harness.inspect` (submissions) and `tx.scanTasks({conversationId, kind:"pi.generation"})`.

The fork route is the one place ownership is already enforced: `record.owner !== undefined` answers 409 `subagent`
(`server.ts` `POST /:id/fork`). There is no explicit child-creation/listing interface or model-facing cross-conversation read adapter. Existing target-ID reads and conversation abort already work for any accessible main/child conversation; a single-submission abort route is not currently exposed. Completion watch is available through each target conversation's stream.

**Cost and ordering.** The catalogue is built from this process's attached map, so listing children costs one read of a
display-parent doc plus rows this process already holds — no per-child request. A conversation created by another
backend is attached by the startup scan, which reads every conversation and carries `record.owner` into
`subagentParentConversationId`; a child created while this process is down therefore appears in the list only after
that scan, which is the same latency every other catalogue row has.

## Four relations that must not collapse

| Relation | Lives in | Lifetime | Means |
|---|---|---|---|
| Display parent | core hepi doc, conversation-scoped | mutable, user-facing | "show this child under that conversation" |
| Reference | core hepi doc, conversation-scoped | mutable, user-created | "this conversation names that one"; intent, not authority |
| Fork ancestry | attach-time `ancestry.forkSource` -> `parentConversationId` | fixed at fork | where the copy came from |
| Task ownership | `ConversationRecord.owner` | **immutable** | who may abort or wait for it; drives `subagentParentConversationId` |

Child creation sets native ownership once; later reference/control calls never rewrite `record.owner` or implicitly reparent the target. A new controlling conversation may add a reference; it never adopts ownership, so subtree abort, idle waits and the 409 `subagent` fork refusal keep
their native meaning.

## Minimum in-process API (core, generic)

- `createChild(parentId, { anchor, agent?, init? }) -> ConversationId` — one commit: `harness.createConversation`
  (`{ownership, agent, init}`) plus the display-parent doc. `anchor: "task"` creates a core-owned anchor task and
  passes `{kind:"task", taskId}` as the child's ownership; `anchor: "display"` passes `{kind:"ownerless"}`.
- `listChildren(conversationId) -> CatalogueEntry[]` — read the display-parent doc (an index of ids), project each row
  through the catalogue builder the list route already uses.
- `readConversation(id, {before?, tail})` — reuse `pageEntries`/`visibleEntry`: bounded history and entry refs, no new
  read primitive.
- `submitTo(id, {text, requestId, whenBusy})` (`Conversation.submit`), `abortConversation(id)`
  (`Conversation.abort`), `abortChild(taskId)` (`harness.abortTask`).
- `watchCompletions(ids)` — `harness.inspect` plus the commit stream already used for `lastRunEndedAt`. Completion
  stays a native terminal fact (ADR 0007), never a diff of `busy`.

## HTTP delta (minimum)

| Need | Delta |
|---|---|
| create child | `POST /api/conversations/:id/children` `{anchor, agent?, requestId}` -> `201 {conversationId, conversation}` |
| parent list / discovery | `GET /api/conversations/:id/children` -> `{children}`; reverse `GET /api/conversations/:id/parent` |
| reference | `GET/POST/DELETE /api/conversations/:id/references` `{targetId, mode}` |
| cross-conversation read | none: `GET /:targetId/state` and `/:targetId/entries` already answer bounded history and entry ids for any conversation the user may read |
| steer / follow-up | none: `POST /:targetId/messages` (or `/:targetId/busy`) with `whenBusy` and `requestId` |
| targeted abort | none for a conversation (`POST /:targetId/abort`); a task-level route only if one is wanted |
| completion + idempotency | none: `GET /:targetId/submissions?requestId`, the catalogue's `lastRunEndedAt`, and the per-conversation SSE `submission` frames |

The real delta is three routes: children create/list, parent lookup, references.

## Lifetime: anchor task vs display parent

**A. Display-parent doc only** (child ownerless): cheapest, survives an optional plugin's uninstall, but the parent's
abort and idle wait never reach the child, and "the parent finished" says nothing about children.
**B. Core anchor task**: the child is owned by a task kind registered by core (`apps/server`), not by the optional
plugin. Native subtree abort, `completing` and `waitForIdle` work unchanged, and uninstalling the delegation plugin
cannot block or orphan the child, because the anchor's definition lives in core.
Recommendation: **B for children that are part of the parent's work, A for children that are only displayed**, selected
per creation by `anchor`, both written as core documents. The optional plugin then owns delegation policy alone —
which profile a child starts with, when to delegate, how results are reported — never the child's existence or lifetime.

## Reference is not control

A reference is a user-authored edge and grants no model authority. Control (submit, abort) is the authenticated user's
own action through the backend, under the deployment's trusted-user policy: no per-reference approval, no capability
tokens, no sandbox layer. Any main conversation may reference and read any main conversation or child; a model turn
never acquires control of another conversation merely because a reference exists.
