# Subagent Subtree Lifecycle Control

Status: approved; tickets 01 (backend operation), 02 (outcome projection), 03 (Web selective control) and 04 (system
acceptance) all delivered and integrated (`integration/client-app` `2cc7d0d` and `20fcd17`, and `23cef1a` for 04).
04 carries its acceptance matrix in [its ticket](issues/04-system-acceptance.md) and the evidence in
[verification](../../docs/verification.md#subtree-control-system-acceptance-2026-10-20).
Labels: subagents, lifecycle, control
Date: 2026-10-17

## Goal

Add explicit stop/interrupt and selective lifecycle control for durable child-conversation subtrees. Parent stop remains local by default. This feature must preserve user stop precedence, durable task ownership and existing Gateway interruption semantics.

## Scope

In scope: authoritative descendant enumeration, captured-set subtree stop/interrupt, selected descendants, per-child outcomes, idempotent request IDs, crash/restart reconciliation, confirmation/progress UI, and hidden/tombstoned parent handling.

Out of scope: pause/resume redesign, automatic fork/retry recovery, unrelated main conversations, new scheduler, polling loop, or forceful host-kill policy.

## Decisions

1. Parent stop does not stop children. Subtree stop is an explicit action with confirmation.
2. Backend computes the descendant set from durable relation data; Web never trusts a stale catalog for scope.
3. First request captures descendant IDs. Children created later are not implicitly included.
4. Each child returns its own accepted, already-settled, stopping, refused, not-found or conflict outcome. Partial failure is visible.
5. Stop changes task/control state only. It never truncates history, deletes relations, cascades tombstones or claims external side effects were rolled back.
6. Authorization follows existing cross-session control rules. Relation alone does not grant unrelated host access.
7. User-held/stopped decisions remain authoritative; subtree control cannot silently resume them.
8. Child recovery/fork-on-failure consumes resulting terminal states but is a separate capability.

## Provisional seam

POST /api/conversations/:id/subtree-control with action stop or interrupt, requestId and optional selected session IDs. Return durable request status and per-session outcomes with current state. Exact route may reuse existing control APIs only if it preserves scope validation and per-item outcomes.

## UI

AgentSessionPanel offers Stop subtree and selective descendant control. Confirmation shows root, count and names/status. Progress shows stopping and partial failure. Navigation remains available. Global active dock remains navigation-only.

## Races and recovery

Capture IDs and control revisions atomically or reject stale selection. Races with completion, new dispatch, user continue, Gateway interruption and backend restart settle through durable transitions. Replaying requestId must not duplicate control tasks or create a scheduler.

## Acceptance

- Nested children, including children under hidden/tombstoned display parents, are controlled.
- Selective requests cannot affect IDs outside the authorized subtree.
- Mixed running, held, stopping, blocked and settled states produce exact per-child results.
- Parent stop alone remains non-cascading.
- Concurrent completion/new child/user control and restart replay are deterministic and idempotent.
- UI shows confirmation, partial failures and final states without losing navigation.
- History, relations and queued reports remain intact.
- Focused tests, typechecks, verify:changed, browser checks and docs logs record revision/commands/exit codes.

## Open details

- Graceful stop versus interrupt escalation; recommendation: separate actions first, no hidden escalation.
- Cross-project/execution-host selection when authorized; recommendation: explicit confirmation and existing bindings only.
- Completed/failed acknowledgement belongs to global activity semantics, not subtree stop.


## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.

