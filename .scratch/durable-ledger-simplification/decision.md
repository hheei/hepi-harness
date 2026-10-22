# Durable Ledger Simplification

Status: agreed direction; research only. No implementation is authorized by this note.

## Direction

Use `pi-durable` as a source of design principles, not as a mandate to place all state in one store or force every workflow into one generic state machine. Durable ledgers may exist at distinct authority owners, including the frontend and Gateway, when each owns facts that must survive its own restart. Backend conversation state remains under the Backend runtime. Each fact has one authoritative owner; other layers consume its result or maintain distinct local facts, not duplicate copies of the same lifecycle.

Separate transition logic from persistence. Keep domain-specific rules explicit, while sharing only durable primitives that recur: stable operation identity, atomic state update, idempotent lookup, and resumable per-item progress where required. Any shared primitive must compose inside its owner's existing transaction; moving related writes into standalone helper commits can break crash consistency. A shared helper is justified only when it removes real duplicated maintenance code without obscuring domain transitions. Avoid a universal state-machine engine, global status enum, or event-sourcing layer by default.

## Ownership Rules

- Persist facts only when restart recovery, cross-process coordination, or user-visible continuation requires them. Ordinary component state and request ordering are not ledger entries.
- Keep submission admission and outcomes in `pi-durable`; do not wrap its lifecycle with a second app-owned ledger.
- Let Gateway own the outcome of Gateway-side operations. A Backend record cannot make a remote side effect atomic; uncertain outcomes must remain explicit and must not be replayed automatically.
- Keep frontend persistence for frontend-owned intent only when that intent must survive refresh or process exit. A local read fence is not a durable lifecycle.
- Keep stale-response handling at the consumer that owns the view/request lifetime. Keep cross-client idempotency and crash recovery at the durable owner.

## Reachability Before Simplification

For every state and branch proposed for deletion, trace supported entry points, events, failure/restart recovery, and compatibility callers. Retain states reachable through ordinary admitted use or documented recovery. Remove a branch only after confirming no supported trigger or persisted-data migration requires it; branch count and apparent rarity are not evidence of dead code. Do not add speculative failure branches without a concrete trigger and user impact.

The candidate matrix must name representative counterexamples, not only state labels: user-fork anchors without dispatch and legacy reporter recovery in [anchor.ts](../../apps/server/src/subagents/anchor.ts#L283); explicit preparation retry in [delegate.ts](../../apps/server/src/subagents/delegate.ts#L116); subtree request lookup and unfinished-child resumption in [subtree-control.ts](../../apps/server/src/subtree-control.ts#L279); and UI handover, reconnect, or deferred watches in [completion-delivery.ts](../../packages/ui/src/lib/completion-delivery.ts). These are required reachability checks before pruning the corresponding paths.

Verify replacements against the same public workflows and recovery outcomes before deleting legacy handling. Do not test or probe bypasses of authentication, authorization, preflight, or other security boundaries.

## First Review Targets

1. Compare the app-owned durable operation records in [subtree-control.ts](../../apps/server/src/subtree-control.ts) and [subagents](../../apps/server/src/subagents/) for duplicated persistence mechanics versus distinct transition rules. Determine whether a small typed ledger primitive would yield net deletion.
2. Treat [pi-durable submissions](../../docs/adr/0006-durable-submission-lifecycle.md) as an existing native ledger, not a rewrite target.
3. Inspect [lifecycle-projection.ts](../../packages/ui/src/lib/lifecycle-projection.ts), [completion-delivery.ts](../../packages/ui/src/lib/completion-delivery.ts), and consumer read fences separately. Identify duplicate ownership or reachable branches before proposing cuts; do not make them durable merely to unify terminology.
4. For each frontend or Gateway durable candidate, identify its authoritative facts, restart boundary, lookup/replay contract, and consumers before proposing schema or API changes.

## Review Gate

Return a candidate matrix with owner, durable fact, normal/recovery triggers, current copies, reachable states, proposed deletion/replacement, expected net code reduction, and invariant risk. Prefer findings that remove multiple maintained copies. No implementation begins until the matrix distinguishes real duplication from independently owned state and a reviewer confirms the reachable-path evidence.
