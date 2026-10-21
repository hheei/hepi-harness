# 02 - Web auth relay and UI integration

Status: done, reviewed APPROVED and **integrated** into `integration/client-app` as `bbd0d59`
Blocked by: 01

Connect existing Models Settings auth UI to Gateway provider-auth operations through authenticated client-ingress routes. Preserve existing UI contract where practical. API key input is transient; never persist to browser storage or echo after submission. Add graceful unavailable/offline/error states.

Acceptance: adapter tests cover Gateway auth, upstream failures and validation; browser/API responses contain no raw key; backend routes are not used for credential transport; existing API-key UI completes a set/list/remove cycle.

## Delivered

The relay is the **client ingress**, not the retired Next BFF and not the durable Backend: the ingress answers
`GET /api/auth/providers`, `POST /api/auth/api-key/:id` and `DELETE /api/auth/api-key/:id` itself, from this origin's own
host service at its authenticated `POST /v1/providers/auth` (`packages/gateway/src/ingress/providers.ts`, dispatched from
the existing host-scoped branch in `packages/gateway/src/ingress/index.ts`). One host, two surfaces, one pair of variables
(`HEPI_INGRESS_MCP_GATEWAY_URL`/`_TOKEN`): the same local account owns `mcp.json` and `auth.json`, so a second pair could only
drift or claim a different machine held the credentials. A raw key therefore travels caller → ingress → that one host and
stops; the Backend receives no credential and still serves no route for one.

The panel's half lives in `packages/ui/src/lib/provider-auth.ts` — the routes, the row shape, the write-only request body
and the notice each refusal earns — because `packages/gateway` does not import `@hepi/ui`; the same contract is what
`ModelsConfig` reads. The existing UI contract is preserved where it was honest: `displayName`/`configured`/`loggedIn` keep
their names, so both picker sections list what they listed before. What was **dropped** is `modelCount` and
`usesCallbackServer`, which no host reports: the panel counts nothing and the callback-server convenience is out of this
spec's scope. The host's own words replace them (masked hint, ambient credential, stored-OAuth-record notes).

Refusal semantics, deliberately three apart — a panel that reads a lost request or an unconfigured deployment as "this
deployment serves none" hides a control the deployment has, which is the mistake the capability rule exists to prevent:

| Situation | Answer | Panel |
| --- | --- | --- |
| Host serves no provider capability (SSH gateway, or composed without the service) | 501 `code: "unsupported"` | named limit, control withheld |
| This deployment configures no host service | 503 `provider_auth_unavailable`, message names the variables | unconfigured, not unserved |
| Host unreachable / refused this origin's token | 503 `provider_auth_unreachable` / `provider_auth_unauthorized` | fault, retry offered, listing kept on screen |
| Bad request, unknown provider, credential replaced by another method | 400 / 403 / 409 (`credential_mismatch`) | shown against the field just used, no state claimed changed |

A `DELETE` carries `expectedType` from the listing the panel read, so a stale panel cannot delete a credential that was
replaced by another method in the meantime; the host refuses and leaves the record alone. A successful mutation answers the
listing **after** the write, never the value sent, and the panel re-reads rather than assuming.

Provider **sign-in** stays ticket 03: `/api/auth/login/:id` and `/api/auth/logout/:id` remain the deployment's named limit,
so `OAuthDetail` asks that route through the capability gate, withholds Login/Disconnect with its sentence, and starts no
`EventSource` against a route that can only refuse — while the key path beside it keeps working.

API-key input is transient: one React state, dropped the moment the body has been sent (success **or** failure), written to
no browser storage, and never rendered back. `apps/web` needed no change — its provider routes already travelled the
connection, and the durable adapter answers nothing for credentials.

## Verification

Command, revision, exit code and raw log per [verification practice](../../../docs/agents/verification.md). Revision
under test: `558c9fc` (`impl/provider-connection-02` = `6b51881` merged with `integration/client-app` `1873d24`), `dirty:
false`. Logs: `.dev/verify/provider02-merged/`. The source delivered is `558c9fc`; the gates were re-run at `3fb29af`, whose `packages`/`apps/web` trees are identical
to it and whose later commits edit only this record and [the verification guide](../../../docs/verification.md).
`3fb29af` ran the same selected gates
(`.dev/verify/provider02-head/verify.json`, `dirty: false`): `changed-typecheck`, `changed-test` (gateway 417, server
468, ui 198, app 9) and `web-unit` 52/52 all exit 0, `check-docs` fails on the identical 12-link baseline, and
`test:panel-ingress` still PASSes. The table above is the code record; that run binds it to the revision the branch
carries.

| Check | Command | Exit | Raw log |
| --- | --- | --- | --- |
| Public seam: list / set / read back / remove, refusal codes, unconfigured host, host without the capability, unreachable host, Backend receives no credential (6 tests) | `node --test packages/gateway/test/ingress-providers.test.ts` | 0 | `.dev/verify/provider02-merged/ingress-providers.log` |
| Panel contract: route formatting, row narrowing from a host body, notice/retry mapping, connection state (5 tests) | `node --test packages/ui/src/lib/provider-auth.test.mjs` | 0 | `.dev/verify/provider02-merged/provider-auth-ui.log` |
| Browser seam: real set → re-read → masked hint → guarded remove cycle, sign-in withheld at its own route, raw key in exactly one request body and in no rendered response, no browser storage, every provider call on the connection's origin with the connection's bearer | `pnpm --filter @hepi/web test:panel-ingress` | 0 (PASS, 17 recorded requests) | `.dev/verify/provider02-merged/browser-panel-ingress.log` |
| Unchanged capability three-state beside the new gate | `pnpm --filter @hepi/web test:capability-trust` | 0 (PASS) | `.dev/verify/provider02-merged/browser-capability-trust.log` |
| Selected gates, re-run at the delivered tip | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | 1 — `check-docs` only | `.dev/verify/provider02-head/verify.json` |
| — `changed-typecheck` (app, server, web, gateway, ui) | | 0 | `…/changed-typecheck.log` |
| — `changed-test`: gateway 417, server 468, ui 198, app 9, 0 failures | | 0 | `…/changed-test.log` |
| — `web-unit` (52) | | 0 | `…/web-unit.log` |

`check-docs` fails on the **same 12 pre-existing** broken relative links across 376 files: the sorted `BROKEN` set at
`558c9fc` (`…/broken-tip.txt`) diffs empty against the `integration/client-app` tip's own set. Recorded, not repaired here;
the anchor links this ticket added to `docs/client-ingress.md` resolve.

The MCP cancellation work merged from `integration/client-app` touched `packages/gateway/src/ingress/index.ts`, so the
combined seam is what ran above: `ingress-mcp.test.ts` passes (9/9) inside `changed-test` on the merged tree. One run of
the gateway suite before that merge reported `a revoked device credential ends an MCP operation that is in flight` failing
on an extra `/` host call; it passes in the isolated file, in six repeats, in three whole-suite runs and on the merged tree,
so it is load timing in the parallel suite, not this ticket's change. Recorded, not chased.

## Merge into `integration/client-app`

Status: done on `impl/provider-connection-02` (source `558c9fc` = `6b51881` + the integration tip, gates re-run at the
docs tips `3fb29af`/`1b34c6e`), reviewed **APPROVED (source-only)** and merged into `integration/client-app` as `bbd0d59`
(`--no-ff`, `ort`, parents `94e62b1` + `1b34c6e`) — the tip that closes this serial batch. No conflict and no hand
resolution; `git merge-tree --write-tree` previewed clean as `46714bb` before the merge.

Two documentation paths overlapped with the rest of the batch and both auto-merged: `docs/client-ingress.md` (this
ticket's host-local provider section at ~291, its env-comment line at ~28 and the re-written not-served rows at ~449
against the cutover branch's deployed-status sentence at ~5 and ~22 — both sides survived, `grep` confirms the "this
listener **is** the deployed Web entry" sentence and `### Host-local provider credentials` in one file, and the stale
`/api/auth/api-key/:id` "not stored by this client API" row is gone) and `docs/migration-status.md` (~487/~504 here
against the cutover's ~42/~574/~640/~701, subtree's ~179 and SSH's ~51).

**The ingress dispatch is the one real public seam this batch shared.** Provider ticket 02 extended
`packages/gateway/src/ingress/index.ts` to route `handlesProviderAuthRoute(route)` alongside the MCP branch, and the
MCP cancellation work of the previous batch owns that file too. Both survive in the merged file: line 7 imports
`handlesMcpRoute`, line 8 imports `handlesProviderAuthRoute`/`createProviderAuthIngressSurface`, line 439 tests
`handlesMcpRoute(route) || handlesProviderAuthRoute(route)` and line 471 dispatches `providers.handle` for one and
`mcp.handle` for the other, over the same host-scoped configuration. That is the assertion this merge specifically needed
— no other branch of the batch touched the ingress — so it was run narrow rather than as another whole-suite pass:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Ingress seam: MCP relay + cancellation, files, terminal, provider relay, settings (explicit selection) | `node scripts/verify.mjs --profile=changed --base=1873d24 --test-file=packages/gateway/test/ingress-mcp.test.ts --test-file=packages/gateway/test/ingress-files.test.ts --test-file=packages/gateway/test/settings.test.ts --test-file=packages/gateway/test/ingress-providers.test.ts --test-file=packages/gateway/test/ingress-terminal.test.ts` | `bbd0d59` | 0 (`changed-typecheck` 0, `changed-test-packages-gateway` 32/32, `check-docs` 1 baseline) | `.dev/verify/2026-10-18T17-25-22-427-verify-changed/changed-test-packages-gateway.log`, `narrow-ingress.console.log` |
| Panel contract (5) and gateway relay (6) on the merged tree | `node --test packages/ui/src/lib/provider-auth.test.mjs` and `… packages/gateway/test/…` (10-file combined run) | `bbd0d59` | 0 (5/5) and 0 (124/124) | `.dev/verify/merge-client-app-12/seam-ui.log`, `seam-gateway.log` |
| Browser credential-transit cycle re-run on the integrated tree | `pnpm --filter @hepi/web test:panel-ingress` | `bbd0d59` | 0 (PASS, 17 asserted requests) | `.dev/verify/merge-client-app-12/browser-panel-ingress.log` |
| Unchanged capability three-state beside the new gate | `pnpm --filter @hepi/web test:capability-trust` | `bbd0d59` | 0 (PASS) | `.dev/verify/merge-client-app-12/browser-capability-trust.log` |
| Whole gateway suite | `pnpm verify:changed --base=1873d24` | `bbd0d59` (`dirty: false`) | 0 | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/changed-test.log` |

The browser seams are the only gates re-run at the integrated tip rather than reused: they are the sole checks of this
ticket's public claims (raw key in exactly one body, no browser storage, every provider call on the connection's origin
with the connection's bearer) and they exercise `packages/gateway/src/ingress/index.ts`'s new dispatch, which is the file
the merge combined. Both PASS. Everything else reuses the branch's own runs, which is legitimate: `git diff --exit-code
1b34c6e HEAD -- packages/gateway/src/ingress packages/ui apps/web` — the only files that differ from that branch are the
two docs paths above. Gateway count reconciles: 411 before this batch, 426 after (+9 SSH parity, +6 provider relay).

`check-docs` exits 1 at the merged tip on the same 12 pre-existing links over 385 files
(`.dev/verify/merge-client-app-12/broken-merged.txt` diffs empty against the `80608d6` baseline), and the anchor links this
ticket's record and `docs/client-ingress.md` add resolve.

No build on `remote-host`, no deployment of this revision, no push, no graph rebuild by this ticket. **Tickets 03
(pi-ai login flows) and 04 (model refresh) are unblocked** — both `Blocked by: 01, 02` are now integrated — and agent32
can start ticket 03 from `bbd0d59`. The surface goes live only when a deployment names its host service; without those
variables it is the documented unconfigured 503.

## Limits

- **No sign-in.** `/api/auth/login/:id` and `/api/auth/logout/:id` are still the deployment's named limit; this surface
  creates no OAuth credential, it lists, replaces and removes what the host's file already holds. Ticket 03.
- **No availability refresh.** A set or removed key does not retrigger a model/catalog read; the panel re-reads the host's
  listing, which is not the same claim. Ticket 04.
- **`configured` is host-dependent.** For an ambient-only provider it is the host's own `apiKey.resolve()`, so two hosts can
  report differently for one empty `auth.json` — ticket 01's recorded advisory, unchanged here and the reason the panel says
  "authenticated from this host's environment" instead of offering a field.
- **Source only.** Nothing was built for or deployed to `remote-host`; no service was restarted. The relay goes live when the
  client ingress bundle carrying this revision is deployed and a deployment names its host service — without those
  variables the surface is an unconfigured 503, by design.
- **The legacy Next entry is not wired, deliberately.** On `apps/web`'s own route handler these paths still fall through to
  the durable adapter's named 501, so the panel hides the control there rather than relaying a credential through a
  conversation-scoped Backend path. The current Web/App surface is the client ingress serving the Vite build, and that is
  what this ticket answers; retiring the old entry is client-app ticket 17.
- **Panel browser coverage reuses ticket 11's fixture** (`ux-panel-ingress`) rather than starting a second ingress stack:
  the credential-transit and transience claims are asserted there against the production panel and the connection's
  transport, and the host's own answers against a fixture that keeps host state instead of replaying canned bodies.
