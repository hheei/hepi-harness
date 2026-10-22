# Ingress consumes locality result

Type: implementation
Status: resolved — implementation `ff55ebe5`, tested `125a69f1`, integrated `17fe24d4` (identical tree); independent review: no material findings
Blocked by: [01 Backend locality verdict](01-backend-locality-verdict.md), [01 Workspace resolution](../../workspace-registry/issues/01-resolution-and-registration.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `packages/gateway/src/ingress/index.ts` and ingress fixtures/tests. Backend wire contract is merged; this ticket owns the ingress migration.

## Delivered

- `servesFolder(workspaceId)` in `packages/gateway/src/ingress/index.ts` now makes one admitted read:
  `GET /api/workspaces/<id>/locality?gatewayId=<HEPI_INGRESS_MCP_GATEWAY_ID>`, under the ingress's own service credential, and returns `verdict?.local === true`. A non-2xx (body cancelled), a body that is not JSON, a body without a boolean-true `local`, a transport failure and an unconfigured gateway are all `false`. Nothing is cached, nothing is retried and no earlier answer is reused.
- Deleted: the `/api/workspaces` and `/api/hosts` reads, the two `as { … }[]` list casts, the cross-list join, and `backendJson` (it had no other caller). The ingress no longer knows any list, profile, root or account shape.
- Unchanged: the `servesFolder(workspaceId): Promise<boolean>` seam into `createMcpIngressSurface`, provider-auth routing, ordinary Backend proxying, and `/api/workspaces`/`/api/hosts` for their catalogue callers.
- New test `only an explicit local verdict admits a folder, and a failure is never remembered as one` in `packages/gateway/test/ingress-mcp.test.ts`: six stated answers (evaluated negative, 503 refusal, `{}`, `{local:"true"}`, non-JSON body, dropped connection) each answer 403 `cwd-denied`; the admitted case asserts the exact one request (`/api/workspaces/local/locality?gatewayId=workstation`) and the `Bearer` service credential, and that a verdict changing to false is read on the next request. The stand-in states only the locality answer — the login, the device credential and every other request still reach the real Backend, so the caller is admitted by the ordinary workflow and nothing bypasses admission.

## Acceptance

- [x] **IB1**: local folder MCP workflow resolves against its configured Backend owner — `ingress-mcp.test.ts` through Web cookie and device bearer.
- [x] **IB2**: SSH workspace journeys unchanged — `ingress-ssh-workbench.test.ts`; the SSH host's own bound folder still answers 403 `cwd-denied`.
- [x] **IB3**: failure never reuses a positive answer; the product outcome is the same `cwd-denied` refusal as before.
- [x] **IB4**: host/profile semantics are evaluated by the Backend; the ingress reads one boolean. Source review plus the paired Backend/ingress fixture.
- [x] **IB5**: other catalogue/host consumers and provider-auth workflows intact — `ingress-catalogue.test.ts`, `ingress-providers.test.ts`.
- [x] **Interface ownership**: no locator class, router rewrite or wrapper; obsolete callers and `backendJson` removed without aliases or fallbacks.
- [x] **Verification**: `node scripts/verify.mjs --profile=fast` on clean revision `125a69f152e79024d068ad72221bf260e91a30ad` (exit 0): `pnpm typecheck`, `pnpm -r test` (server 378/378, gateway 183/183, protocol 72/72, ui 474/474). Report `.dev/verify/manual/ingress02/fast-final/verify.json`.
  Required ingress fixtures, same revision, `node --test packages/gateway/test/ingress-mcp.test.ts packages/gateway/test/ingress-ssh-workbench.test.ts packages/gateway/test/ingress-catalogue.test.ts packages/gateway/test/ingress-providers.test.ts packages/gateway/test/ingress-conversation.test.ts` → 40/41, exit 1; the one failure is the pre-existing catalogue fixture below. Log `.dev/verify/manual/ingress02/required-125a69f1.log`.
  `pnpm check:docs` exit 0 (463 files, 0 broken); `pnpm check:entrypoints` exit 0 (156 present, 0 newly missing).
- [x] Updated [MCP on Web host](../../../docs/mcp-on-the-web-host.md), [client ingress](../../../docs/client-ingress.md), [architecture](../../../docs/architecture.md), [developer guide](../../../docs/developer-guide.md) and [migration status](../../../docs/migration-status.md).

## Evidence and limits

- Agent-292 independently reviewed standards and spec: no material findings. Confirmed one typed locality query under the configured gateway and service credential, boolean-true admission, no cached positive or fallback, unchanged provider routes/proxy/admission. Source review reused clean `125a69f1` evidence (tree identical to `17fe24d4`), passing workspace checks and 40/41 required ingress fixtures with the same baseline catalogue assertion. No additional tests run; live deployment remains unverified.

- Pre-existing, unchanged by this ticket: `packages/gateway/test/ingress-catalogue.test.ts` "a device bearer reads the catalogue, binds Projects on both hosts and re-binds a folder through the ingress" fails `projectsRevision 6 !== 3` at its Project-removal assertion. Reproduced identically on the untouched integration commit `8f19a31b` in its own worktree (`.dev/verify/manual/ingress02/baseline-8f19a31b-catalogue.log`). Judged not material here: the failing assertion is a Project revision count, the test's own locality-independent Project lifecycle expectation; the locality route and this ticket's ingress path are not involved, and the fixture's other 40 assertions in the required set pass. No product guard is added for it.
- Not verified: a live deployment. The verdict is exercised through the real Backend, real gateways and the real ingress in process. No latency improvement is claimed — the structural gain is one inquiry and one authoritative implementation.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
