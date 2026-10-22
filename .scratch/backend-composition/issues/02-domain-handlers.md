# Concrete HTTP domain handlers

Type: implementation
Status: resolved — `301c52f4` (implementation `17188993`); review by agent-290: no material findings
Blocked by: [01 Conversation attachment owner](01-attachment-owner.md), [02 Project operations](../../workspace-registry/issues/02-project-routes.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `apps/server/src/server.ts` dispatch and concrete handler modules. This ticket starts only after workspace-registry 02; do not migrate project/worktree branches, reserved for ticket 03.

## Goal

Move conversation read/stream, command/item, settings/resource and diagnostics handling into concrete domain modules. Keep direct fixed dispatch and shared admission/error boundary; retain status/body/method matching, size limits, cancellation and stream backpressure. Each handler receives only dependencies it uses.

## Acceptance

- [x] **BC1, BC2, BC3, BC5**: reviewer found no material change to route matching, body limits, response/error contracts, stream cleanup, command/item admission, recovery or shutdown ordering.
- [x] **Interface ownership**: No handler registry, generic router framework or broad context bag; moved branches removed from original closure.
- [x] **Verification**: `pnpm verify:changed --base=e6a0ffd2 --quiet` passed on clean revision `301c52f499414abb3f0a5f9406b5d7818e378289` (exit 0): server typecheck, full server tests, docs check. Report/logs: `../../../.dev/worktrees/architecture-consolidation/.dev/verify/2026-10-22T01-28-44-867-verify-changed/verify.json`; focused journey evidence (73/73) at `../../../.dev/worktrees/backend-domain-handlers/.dev/verify/2026-10-22-baseline-mcp/tip-focused-journeys.log`.
- [x] Updated current [developer guide](../../../docs/developer-guide.md) and [architecture guide](../../../docs/architecture.md); removed moved branches from `server.ts` without aliases or fallback paths.

Review evidence: agent-290 read-only standards/spec review of `17188993` against `e6a0ffd2`, no material findings. Reviewer reused clean-revision verification (server typecheck; 372/372 server tests). Supplemental focused journeys reported 73/73 but their log lacks revision/exit metadata. MCP logs contain the same 14 named failures on baseline and tip; successful MCP execution remains unverified. This does not change the passing recorded full server test command.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
