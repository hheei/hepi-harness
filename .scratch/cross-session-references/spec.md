# Cross-conversation references

Status: **closed** — all three tickets delivered. 01 delivered on `impl/xref-01-target-validation` (`5a963cd`) and its
contract now lands on this line as `9aacab4` from a differently cut branch — the tree it delivers is byte-identical, so
the validation is on the line even though that one branch was never merged; 02 delivered and **integrated on
`client-app-integration`** (`impl/xref-02-03` cherry-picked at `6191f82`/`42dcbc3`); 03 **accepted at `0a3d065`** and **re-run on this line at `0acf499`** (integrated as `55f6f55`/`0acf499`), where
`apps/web/e2e/ux-references-acceptance.mjs` runs the create/reload/follow journeys, the inherited-fork-entry follow and a
real transient read failure with its retry over the real client ingress and a real Backend. Its history-05 edge was met at
`a0caf5d`. Two named outcomes (`entry-missing`, `entry-out-of-scope`) are proven at the owner/route and client-rendering
seams rather than through the picker, which cannot produce them by construction — see
[03's record](issues/03-acceptance.md#the-two-rows-a-browser-cannot-reach).
Date: 2026-10-19
Labels: references, navigation, ux-followup

## Goal

A user can deliberately link another conversation — or one entry inside it — from the conversation they are in, see the link in the existing references surface, and follow it later with an honest result when the target is gone or unreadable.

This is a minimal UX followup over capability that already exists. It does not introduce a new reference store, a second history implementation, or a model-facing tool.

## Decisions

1. **Reuse the existing owner.** `ConversationReference`, `ReferencesDoc`, the `references` action in `packages/session/src/control.ts`, and the Backend reference routes remain the single owner of link storage and creation. Web/App reach them through the client ingress; no BFF or client store keeps a parallel copy.
2. **Explicit user creation.** Creation is a deliberate user action in the current conversation, plus a picker. Automatic references on dispatch, fork, subagent spawn or model output are out of scope; existing fork policy is unchanged and forks still start with no inherited references.
3. **Conversation-only default.** The default target is the conversation. An optional entry may be chosen from a stable, known entry identity supplied by the existing reference/history surface — not typed, guessed, or derived from an ordinal.
4. **Entry navigation shares the bounded history owner.** Following an entry reference navigates through the same bounded target coordinator as a history jump or deep search result. It requests at most one target window and never walks intervening history.
5. **Validate at the owning seam.** Creation and follow both resolve the target through the Backend reference owner: the entry must belong to the target conversation's visible, committed, fork-aware history. Validation reports named outcomes instead of copying target content into the reference.
6. **Named unavailable outcomes.** A deleted or tombstoned target, an entry absent from the visible committed history, a wrong-scope reference and a temporary read failure are distinct results with distinct UI states. Following never silently lands on the nearest surviving entry or an empty view.
7. **No model tool.** The reference surface stays a user capability. No `agent_reference` tool is added.
8. **No schema expansion.** No new store, table, index or copied history is added unless the entry-validation contract cannot be met otherwise; that is a material-necessity decision for ticket 01, not an assumed step.

## Required behavior

- From a conversation, the user can create a reference to another conversation, optionally pinned to one entry chosen from that conversation's known entries, with an optional label.
- The reference appears in the existing references/history surface and survives reload.
- Following a conversation reference opens the target conversation; a target that cannot be read shows an actionable named message with retry where retry can help.
- Following an entry reference lands on that entry via one bounded target read, or shows `missing`/`stale`/`cancelled`/`error`.
- Reference creation against an entry outside the target's visible committed history is refused at creation with a named reason, not stored and discovered later.
- Fork and tombstone behaviour of existing references is preserved: tombstoning does not cascade, and fork references stay branch-local.

## Non-goals

- Automatic references for dispatch, fork, or agent-authored links.
- A model tool or any reference capability exposed to the agent loop.
- Copying target conversation content into the reference or a client-side cache.
- A new reference schema, durable store, or second history reader.
- Composer autocomplete as a required entry point.
- Changing existing fork, tombstone, or compaction semantics.

## Existing seams

| Concern | Owner |
| --- | --- |
| Reference record and label | `ConversationReference` in `packages/protocol/src/index.ts` |
| Storage and creation checks | `ReferencesDoc` and the `references` action in `apps/server/src/conversation-operations.ts` / `packages/session/src/control.ts` |
| Wire routes | Backend reference routes, relayed by the client ingress |
| Creation and follow UI | Existing references/history surface action plus picker |
| Entry navigation | Bounded target coordinator from `../history-navigation-research/spec.md` |

## Acceptance

- A reference created through the user action persists, reloads, and follows to the exact chosen target.
- A deleted target, a missing entry, and a transient read failure each produce a distinct named outcome.
- Entry references validate against the target's visible committed fork-aware history and refuse invalid entries at creation.
- Following an entry reference uses one bounded target request, with no sequential history walk.
- No reference content is copied, and no new store or model tool is introduced.
- Relevant checks run and are recorded with revision, exit code and logs.

## Dependencies

Tickets: [ticket proposal](ticket-proposal.md). This effort starts after `../client-app/issues/17-retire-next-and-transition-paths.md`; ticket 01 depends on it. Entry navigation depends on history navigation ticket 03 and acceptance depends on history ticket 05.

Research evidence: [research.md](research.md) (historical, pre-spec investigation).
Cross-effort map: `../ux-closeout-research/spec.md`.


Implementation tickets update the owning current chat/reference guide and docs/migration-status.md in the same change;03 verifies alignment. Tests use ordinary visible conversation/entry lifecycles, not bypass probes against authorization or system boundaries.
