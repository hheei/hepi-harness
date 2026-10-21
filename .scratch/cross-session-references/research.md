# Cross-Session References Research

Status: historical evidence. Read-only investigation at an earlier baseline; its "no specification authorized yet" status is superseded — scope is now approved as a minimal UX followup in [spec.md](spec.md), with tickets in [ticket-proposal.md](ticket-proposal.md). Paths and file references below describe that earlier baseline; treat [spec.md](spec.md) as the current contract and this file as supporting evidence.

Investigation date: before 2026-10-19. Baseline: pre-retirement Web BFF client (Next routes and `apps/web/adapters/durable-api.ts`). Current architecture is Web/App → client ingress → Backend; the adapter/BFF paths named below are historical and are retired by `../client-app/issues/17-retire-next-and-transition-paths.md`.

## Existing implementation

- `ConversationReference` in `packages/protocol/src/index.ts` is a structured pointer: target `conversationId`, optional `entryId`, optional `label`. It grants no control and copies no target content.
- `ReferencesDoc` in `apps/server/src/conversation-operations.ts` stores links on the referencing conversation (`history: latest`, `fork: initial`). Forks begin with no inherited references.
- `POST /api/conversations/:id/references` adds links idempotently by target conversation and entry. `GET /api/conversations/:id` includes them. The Web adapter exposes these as `POST /api/sessions/:id/references` and `GET /api/sessions/:id/info`.
- Creation checks that target conversation record exists within transaction. It does not visibly check tombstone status: tombstoned records are retained, so a target hidden from catalogue may still pass this existence check. `entryId` is type-checked as string at route, but target-entry membership is not validated there.
- `RawHistoryPanel` is sole inspected presentation: references render in full-history panel. Clicking opens target session and, when entryId exists, requests raw-history focus; AppShell selects target and RawHistoryPanel scrolls/highlights matching entry.
- Archive state is separate from references. Tombstoning retains records and does not cascade into references.
- No model `agent_reference` tool exists; model tool surface remains `agent_spawn/send/stop/get/read`.

## User-facing gaps

- No production Web UI creation action was found. Adapter route appears covered by unit tests, but not called by a user workflow.
- Links are only visible in Raw History, not transcript messages or sidebar.
- Target deletion / tombstoning and stale entry IDs have no explicit unavailable-target or unavailable-entry treatment in the inspected UI. Navigation can therefore land on an empty or unhelpful view.

## Open product decisions

1. Creation intent: explicit user-created links (message/session action), automatic links for dispatch/fork, agent-authored links, or a staged combination.
2. Presentation: history metadata versus contextual citations visible in chat.
3. Scope: link to conversation, specific entry, or both, and whether entry references require membership validation and stable handling across compaction/fork.
4. Lifecycle: behavior for tombstoned targets, archived targets, missing entries, and references from forked conversations.
5. Whether this remains a Web/user capability or gains a constrained agent tool.

## Recommendation for next discussion

Treat storage and basic navigation as existing capability; focus future scope on a deliberate creation workflow and honest handling of unavailable targets/entries. Do not expand schema or add an agent tool until creation intent and presentation are decided.

Outcome: this recommendation was adopted. See [spec.md](spec.md) — explicit user creation with conversation-only default, optional entry chosen from a stable known identity, validation at the existing owner, named unavailable outcomes, no model tool, no schema expansion.

## Evidence

- `packages/protocol/src/index.ts` (ConversationReference)
- `apps/server/src/conversation-operations.ts` (ReferencesDoc, addReference)
- `apps/server/src/server.ts` (conversation info and references routes)
- `apps/web/adapters/durable-api.ts` (session reference routes)
- `apps/web/components/RawHistoryPanel.tsx` (render and entry focus)
- `apps/web/components/AppShell.tsx` (open target and focus routing)
- `apps/server/src/session-tombstone.ts` (non-cascading tombstone)
- `apps/server/test/conversation-relations.test.ts` (ownership, idempotency, missing-target coverage)
- Scout investigation: agent-193, read-only.


## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.

