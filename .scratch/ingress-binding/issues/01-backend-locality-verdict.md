# Backend-owned workspace locality verdict

Type: implementation
Status: resolved — implementation `1187ec12`, verified branch `705717df`, integrated `d857e291`; independent review: no material findings
Blocked by: [02 Domain handlers](../../backend-composition/issues/02-domain-handlers.md), [01 Workspace resolution](../../workspace-registry/issues/01-resolution-and-registration.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: Backend workspace HTTP handler/protocol result plus paired integration tests. Wait for Backend ticket 02 so only its handler owner edits the route; Gateway ingress is not changed in this ticket.

## Goal

Add one Backend-owned locality decision for a workspace at the existing shared protocol seam if cross-process typing requires it. Preserve workspace-list membership including retained bindings and current profile/host semantics; distinguish unavailable/failure from a positive locality result.

## Delivered

- `GET /api/workspaces/:workspaceId/locality?gatewayId=:gatewayId` in `apps/server/src/workspace-http.ts`. The route is admitted by the existing service-token check in `server.ts` dispatch; no second admission and no new dispatch branch beyond the handler's own `false` answer.
- Answer shape `WorkspaceLocality = { readonly local: boolean }` declared in `@hepi/protocol`, the seam both processes read. No Backend metadata type crosses to the Gateway: the verdict states one boolean and no list, profile, root or account.
- The predicate is the one the ingress assembled, moved to its owner unchanged: membership of `registry.bindings()` (configured workspaces, Project folders and retained bindings), the binding's own `gatewayId` equal to the caller-named gateway, and the configured connection's host-profile answer `ok` with an empty profile list. A named gateway never overrides the stored binding; eligibility for a new target (`isTarget`) is not consulted.
- `local: false` covers every evaluated negative — unbound workspace, owner on another gateway, gateway this deployment does not configure, SSH-profile host. A host query that failed keeps its own non-success: `503 gateway_offline` (or the host's own code and status) with `code`/`error` and no `local` field, so a caller can never read "could not ask" as "asked, and it is not this machine". `gatewayId` absent is `400 invalid_request`.
- `/api/workspaces` and `/api/hosts` keep their shapes and their catalogue/UI callers; `hostProfiles` now also returns the status its refusal already carried.
- No caching, no filesystem probe, no path resolution, no retry.

## Acceptance

- [x] **IB3, IB4**: one Backend verdict over ordinary admitted routes. Failure stays non-success: the unreachable-host case asserts `503 gateway_offline` with no `local`; a later query after the host is gone is re-asked rather than answered from a remembered positive. Profile semantics are evaluated by the Backend: an SSH gateway's own bound folder answers `local: false` while `/api/hosts` still states its `prod` profile and the local gateway's empty list.
- [x] **Interface ownership**: one authoritative verdict (`WorkspaceLocality`), no Backend metadata type exported to the Gateway, ingress untouched (ticket 02 owns that migration).
- [x] **Verification**: `node scripts/verify.mjs --profile=fast` on clean revision `705717dffac325b79b77a3f0b8bf1ece1201d5ce` (exit 0): `pnpm typecheck` and `pnpm -r test` (server 375/375, gateway 183/183, protocol 72/72, ui 464/465 — the one ui failure is pre-existing, see below). Report `.dev/verify/manual/fast3/verify.json`, logs `.dev/verify/manual/fast3/{workspace-typecheck,workspace-tests}.log`.
  Paired ordinary admitted fixture, same revision, exit 0 (28/28): `node --test packages/gateway/test/ingress-mcp.test.ts packages/gateway/test/ingress-ssh-workbench.test.ts packages/gateway/test/ingress-conversation.test.ts apps/server/test/workspace-locality.test.ts` — log `.dev/verify/manual/final/paired-admitted-705717df.log`. It includes the new admitted route case (`/api/workspaces/local/locality?gatewayId=workstation` as Web cookie and App bearer, `401` unauthenticated).
  `pnpm check:docs` exit 0 (463 files, 0 broken); `pnpm check:entrypoints` exit 0 (155 present, 0 newly missing). Logs in `.dev/verify/manual/final/`.
- [x] Updated [migration status](../../../docs/migration-status.md), [architecture](../../../docs/architecture.md) and [developer guide](../../../docs/developer-guide.md); no superseded caller or test was added.

## Evidence and limits

- Agent-292 independently reviewed standards and spec for `8a1ef5bc..705717df` (implementation `1187ec12`): no material findings; `git diff --check` passed. Source review confirmed binding ownership, retained membership, successful empty-profile semantics and non-success propagation. Reviewer reused supplied test evidence. Combined verification on clean integration `d857e2917acef1d260c0dc72d1eb97550094d151`: `pnpm verify:changed --base=e6a0ffd2 --quiet`, exit 0; report `../../../.dev/worktrees/architecture-consolidation/.dev/verify/2026-10-22T02-16-55-256-verify-changed/verify.json`.

- Pre-existing failure, unchanged by this ticket: `packages/gateway/test/ingress-catalogue.test.ts` "a device bearer reads the catalogue, binds Projects on both hosts and re-binds a folder through the ingress" fails `projectsRevision 6 !== 3`. Reproduced identically on the untouched integration commit `8a1ef5bc` in its own worktree (`.dev/verify/manual/final/baseline-8a1ef5bc-catalogue.log`), so it is a baseline defect of that fixture, not this change.
- The ingress still composes the two listings; ticket 02 replaces that caller and deletes the list casts, cross-list join and `backendJson` when it has no remaining caller. Until then this route has no product caller, and no network-latency improvement is claimed.
- Not verified here: a live deployment. The verdict is exercised only through the real Backend, real gateways and the real ingress in-process.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
