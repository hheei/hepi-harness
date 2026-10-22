# Backend composition and HTTP modules

Status: Backend01 integrated at `899cb45`, Backend02 at `301c52f4`, and Backend03 delivered at `4197c3e6` on `impl/backend-composition-final` (base `d857e291`); the composition root and every domain owner named below are the delivered shape. Baseline: `5ec7ffe6`, 2026-10-21. [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

`createBackendServer` in [server.ts](../../apps/server/src/server.ts) starts at 897; `handle` starts at 1885. Initialization, workspace resolution, conversation attachment, extension wiring, HTTP decoding and stream output share one closure. Existing `createConversationOperations` already owns durable commands; `attachConversation` at 687 owns a useful portion of the live view. `BackendServer` at 66 is already small: `{ server: Server; close(): Promise<void> }`.

Representative change: adding an existing conversation operation to HTTP should require editing its owning HTTP module and composition wiring, without learning project registry mutations or resource initialization. No latency or correctness failure is claimed.

## Chosen design

Preserve the existing external `createBackendServer(options)` interface. Make `server.ts` a composition root: initialize configuration and registry; open the Harness paused; install extensions; restore attachments; resume scheduling; bind HTTP; expose close. Preserve the source’s exact startup order rather than inventing a new boot framework.

Group HTTP implementation by actual domain ownership: project/workspace/worktree operations; conversation reads/streams; conversation commands/items; settings/resources; diagnostics. Each concrete module receives only the existing operations it uses. Modules may use Node request/response directly; no generic HTTP abstraction, route registration protocol or injectable global context. Direct fixed dispatch calls are sufficient. Matching, body limits, route precedence, response status/body and cancellation belong beside that domain’s handler. Shared transport helpers remain small concrete functions where genuinely reused.

A handler’s internal interface is `handle(request, response, url): Promise<boolean>`: false means no response was started; true means this module owns the response, including a named method refusal. The entry retains common admission, outer safe error handling and final unknown-route fallback. Tests continue through the real admitted HTTP entry. The illustrative handler type is not a new public package contract.

Place the existing live view creation, attachment map, subscription release and close logic in one internal conversation-attachments module. It borrows the Harness; it does not write a second durable conversation model. Its operations are lookup, ensure attachment, enumerate attached views and close. Ensure returns the existing attachment for one durable identity, keeping its current bootstrap/recovery behavior. The existing durable operations interface remains the writer. Do not introduce a new ConversationEngine that combines durable commands, HTTP objects and provider execution.

## Interface facts and dependencies

- Caller still obtains `server`, listens using Node HTTP, then awaits `close()`. No new public dispatch or listen facade.
- Conversation operation errors retain current domain refusal mapping; already-sent streaming responses are not rewritten as JSON. Preserve current body-size distinctions and streaming backpressure.
- Attachment and stream listeners are process-owned and released on disconnect/server close; the Harness closes after views, following current ordering. Audit startup failure ownership for any newly acquired resources.
- In-process: operation/projection modules. Local-substitutable: real temporary SQLite and loopback HTTP fixtures. Remote-owned: existing Gateway host clients. True-external: provider/OS dependencies remain behind existing owners. Reuse those adapters.

## Alternatives and deletion test

| Alternative | Depth / locality assessment |
| --- | --- |
| Expose dispatch/listen/close facade | Existing external interface already hides HTTP startup; adds caller concepts and encourages direct-handler tests past admission. Reject. |
| RouteRegistry plus mount plugins | Adds registration/order protocol for a fixed route set. Reject. |
| Whole ConversationEngine vertical slice | Could hide more, but replaces sound durable authority and mixes transport with execution; disproportionate scope. Reject. |
| Concrete domain handlers plus attachment owner | Moves rules and lifetime management to their owners while retaining existing entry. Select. |

Remove moved branches from the original closure in the same slice, route-level registry mutation glue covered by the registry spec, and duplicate attachment cleanup loops. Deleting the chosen modules would force stream lifetime, refusal mapping and operation composition back into unrelated callers; their implementation earns its interface. Do not claim moved lines are net deletion.

## Acceptance and verification

| ID | Observable completion | Existing evidence seam / planned check |
| --- | --- | --- |
| BC1 | All shipped paths retain method matching, body limits, statuses and safe error bodies. | Existing `apps/server/test` route tests through normal credentials; inventory route families before migration. |
| BC2 | Selected streams reconnect, receive committed updates, and release listeners on close. | `conversation-navigation.test.ts`, existing delta/stream tests. |
| BC3 | Create/fork/send/control/items and subagent operations retain dedupe and durable ownership. | `subagents.test.ts`, `mcp-conversation-tools.test.ts`, pending-item and subtree tests. |
| BC4 | Boot recovery precedes scheduling; closing leaves no owned attachment or listener. | Existing recovery/acceptance fixtures; test public close where extraction changes lifecycle. |
| BC5 | Representative new route touches its concrete handler and wiring only. | Diff review; no broad context bag or second route table. |

Keep integration coverage that proves composition. New colocated tests may exercise actual domain computation; replace source-extraction/private-handler tests only after equivalent interface coverage. Run selected verification and focused stream/recovery checks; record actual results during implementation.

## Slices, dependencies and guides

1. Inventory existing route observations and acquisition/release ordering.
2. Integrate [project/workspace registry](../workspace-registry/spec.md), then move its routes with narrow dependencies.
3. Move settings/diagnostics routes; move conversation handlers and attachment implementation in separate reviewable slices.
4. Remove obsolete closure state and redundant tests; verify composition and update [architecture](../../docs/architecture.md) and [developer guide](../../docs/developer-guide.md).

Registry implementation is the only integration prerequisite for project routes; other route-family preparation can proceed independently. Coordinate `server.ts` edits with ingress endpoint work; ownership of shared files is a merge concern, not a serial dependency on every subsystem.
