# Backend-owned ingress locality decision

Status: ticket 01 in progress on `impl/nonui-ingress-01`; baseline: `5ec7ffe6`, 2026-10-21. [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

[ingress/index.ts](../../packages/gateway/src/ingress/index.ts) `servesFolder` at 316 reads `/api/workspaces` and `/api/hosts`, finds the workspace owner, then interprets owner.error and profiles.length. It passes its boolean into the existing createMcpIngressSurface. This makes ingress understand Backend topology-list shapes to decide one folder-scoped host-local capability.

Current predicate is exact: configured ingress MCP gateway id is nonempty; workspace is in the Backend workspace listing and belongs to that gateway; host listing contains that gateway without error and with a valid empty profiles array. It is not merely `workspace.gatewayId === gatewayId`, and it is not a new per-workspace profile inference. Preserve this conservative predicate.

## Chosen interface and implementation

Replace the two broad Backend reads with one narrow, Backend-owned query: proposed `GET /api/workspaces/:workspaceId/locality?gatewayId=:gatewayId`. The route is admitted by existing Backend service-token checks. Its internal decision implementation uses the same workspace-list membership (including Retained Bindings) and host-profile resolution as today; no filesystem probing or path resolution. Eligibility for a new target is a different decision and must not replace listing membership here.

Proposed result on a successfully evaluated query is `{ local: boolean }`. Missing workspace/gateway, owner mismatch, an SSH-profile host or unusable host result yields local:false under the existing predicate. Unexpected Backend failures retain a safe non-success HTTP response; ingress treats any non-success, malformed body or transport failure as false. Require the positive response’s `local` field to be boolean true. Never cache a previous positive answer, retry a mutation or fall back to the old listing composition.

Ingress keeps the existing `servesFolder(workspaceId): Promise<boolean>` callback supplied to createMcpIngressSurface. It sends its own configured gateway id and existing service credential, reads one small result and knows no host/profile/list structures. Provider-auth routing and ordinary backend proxying remain unchanged. The callback is an existing real seam; do not add a locator class, router rewrite or standalone WorkspaceHostAuthority wrapper.

This is an explicit internal wire addition/replacement: all current ingress callers move in the same change. Keep `/api/workspaces` and `/api/hosts` because their UI/catalogue callers still use them, not as compatibility fallback for ingress. A pinned release still deploys its paired Backend and ingress artifacts. Coordinate with [Backend composition](../backend-composition/spec.md) to place the route under the owning workspace HTTP module.

## Ownership and dependencies

Backend owns binding and host-profile meaning; ingress owns its configured local capability and caller admission. A caller-named gateway never overrides stored binding. Do not expand local MCP eligibility for SSH hosts in this refactor. Current execution preparation/retained rules stay with the registry; reuse its metadata interface if integrated, otherwise move the current predicate into the Backend owner directly. Registry extraction is not a prerequisite for designing or validating this wire.

In-process: Backend predicate and ingress result decoding. Local-substitutable: real loopback Backend/Gateway fixture. Remote-owned: Backend HTTP query via existing fetch and service credential; host profiles via existing owned Gateway clients. True-external: host transport failures remain behind those clients. A fake successful HTTP shape can test decoder behavior, but cannot replace the real ownership journey.

## Alternatives, depth and deletion

| Alternative | Assessment |
| --- | --- |
| Move current two-fetch code into new locator object | Hides syntax, leaves topology authority in ingress. Reject. |
| Add locality to all broad catalogue rows | Makes unrelated readers learn ingress-specific facts and may add host I/O to catalogue reads. Reject. |
| General ingress router or reverse proxy rewrite | Different problem, much wider interface and lifetime scope. Reject. |
| One purpose-specific Backend verdict | Removes list-shape knowledge and one cross-process read while preserving the predicate. Select. |

Delete ingress workspace/host list casts, cross-list joins and backendJson helper only if it has no remaining caller. Deleting the chosen decision module would force affinity/profile rules back into each client. Do not claim network latency improvement until measured; the structural gain is one inquiry and one authoritative implementation.

## Acceptance and verification

| ID | Observable completion | Existing evidence seam |
| --- | --- | --- |
| IB1 | Normal local folder MCP workflow still resolves against its configured Backend owner. | `packages/gateway/test/ingress-mcp.test.ts` through standard device/Web admission. |
| IB2 | Ordinary SSH workspace journeys keep their current host-local capability behavior. | `ingress-ssh-workbench.test.ts`, current MCP locality cases; no new bypass probes. |
| IB3 | Backend unavailable/failed query never reuses a positive answer; ingress returns the same product-level outcome as today. | Existing normal dependency-failure fixture; decoder unit test for unsuccessful result only, not admission circumvention. |
| IB4 | Current host/profile configuration semantics are evaluated by Backend; workspace/host listing shapes disappear from ingress. | Source review and paired Backend/ingress integration fixture. |
| IB5 | Other catalogue/host consumers and provider-auth workflows remain intact. | `ingress-catalogue.test.ts`, existing provider integration cases. |

Tests use ordinary configured callers and authorized hosts, not probes intended to defeat locality/admission. Keep existing meaningful authority integration checks; replace duplicated list-shape fixtures with narrow result fixtures where they only exercise decoding.

## Slices and guides

1. Pin current predicate and callers with existing observations.
2. Add Backend decision and typed result at the current shared protocol seam if both processes need it. Avoid exporting Backend private metadata types.
3. Migrate ingress directly; delete old composition and update existing fixtures.
4. Verify paired artifacts and update [MCP on Web host](../../docs/mcp-on-the-web-host.md), [architecture](../../docs/architecture.md) and [developer guide](../../docs/developer-guide.md).

Independent of filesystem and native work. Shared server edits with registry/routes require coordination; a new general topology capability is outside scope.
