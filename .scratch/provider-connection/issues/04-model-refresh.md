# 04 - Model availability refresh

Type: implementation ticket
Status: done — delivered on `impl/provider-connection-03`, integrated into `integration/client-app` by this merge
Blocked by: 01, 02 (both delivered)

Define and implement a non-secret refresh/invalidation signal after Gateway auth mutations so model availability reflects changed credentials without backend receiving credentials. Reuse existing model runtime/config ownership; avoid process restart unless current runtime requires it and document that constraint.

Acceptance: successful credential change causes model availability to refresh; failed refresh is surfaced without rolling back valid auth storage; no key/token is present in refresh messages or logs.

## Answer

The ticket asks for a refresh/invalidation signal so that model availability reflects changed credentials. The two halves
of that sentence have different owners, and only one of them is stale.

**The Backend is not stale, so it gets no signal.** Each catalog read re-resolves credentials from the account that
process was configured with; nothing about a credential is carried across a request. In `HEPI_CONFIG_SOURCE=pi` that
account *is* this host's `auth.json`, the file the Gateway owns, and the runtime re-reads it rather than trusting a
cached copy — so a credential the Gateway stores becomes available on the Backend's next read with no restart, no route
and no message, and a removed one withdraws. In environment mode the account is this deployment's own `HEPI_*` variables
and an in-memory store, and a Web-host credential is not its concern: a property of the mode (docs/providers.md), not of
a missing feature. An invalidation message would therefore state something the receiver re-resolves anyway, carry a
provider id nothing needs, and become the first wire between these two processes to name a credential's owner. It is not
added, and no credential reaches the Backend on any path — the mutation and its listing stay between the browser, the
ingress and this host's gateway (tickets 02/03).

**The page's cached catalog is stale, and that is client-owned.** `packages/ui/src/lib/models-cache.ts` holds the one
instance; `invalidateModelCatalog()` drops it, and Settings › Models calls it on every confirmed credential change — API
key saved, API key removed, OAuth sign-in completed, sign-out — the way a `models.json` save already bumped the
generation. A composer that is open keeps what it shows and its next read asks the deployment again, so this is an
invalidation and not a reload: nothing fetches, notifies or retries, and no failure of it can roll back a stored
credential, because those are unrelated facts on different hosts.

**A catalog *pass* is a separate capability and stays a named limit.** `POST /api/models/refresh` asks which models exist
at a provider: a network read of a third party, owned by no process behind either origin in this product (model network
fetch is disabled and the store is in-memory). What was wrong was the client, not the route: it POSTed to that route and
reported the deployment's `501 unsupported` as "could not reach the catalog", blaming a provider endpoint for a route this
deployment never had and offering a retry that reaches the same limit. `EnabledModelsSection` now asks the route as its
control's own capability and withholds **Refresh catalog** on that answer, keeping it on anything else including no
answer.

**The deployed split cannot see host-stored credentials, and must not.** docs/deployment.md now states why sharing an
agent directory is not the fix: a backend container authenticating from a workstation user's `auth.json` would have that
user's OAuth refresh tokens in reach, which is the isolation a separate `PI_CODING_AGENT_DIR` exists to keep.

## Acceptance, checked

| Ticket acceptance | Result |
| --- | --- |
| A successful credential change causes model availability to refresh | Held. Pi mode: the next Backend catalog read offers the model the Gateway's own service stored, with no restart and no refresh call (`apps/server/test/provider-availability.test.ts`). Environment mode: availability is this deployment's own account, asserted not to be reached by a host-stored credential. Client: the page's cached catalog is dropped and the next read asks the deployment again (`packages/ui/src/lib/models-cache.test.mjs`, `apps/web/e2e/ux-panel-ingress.mjs`). |
| A failed refresh is surfaced without rolling back valid auth storage | Held. A Backend that cannot load its credential file answers its own error, naming neither a path nor a value, and the key the host stored is still there and still listed afterwards. Nothing on either side treats a catalog failure as a credential failure, and the withheld catalog-refresh control cannot fail at all where the deployment refuses the route. |
| No key/token in refresh messages or logs | Held by construction: there is no refresh message. The availability test asserts no Backend answer carries the stored value in either mode. |

## Verification (2026-10-19, this worktree)

The change landed at `32d2a25`; `integration/client-app` `66a56f3` (carrying MCP conversation tools 03a at `d95d6d4`)
merged in as `faae18a`, and every check was re-run on the merged tree. A count from one revision is not claimed for the
other.

| Command | Revision | Result |
| --- | --- | --- |
| `node --test apps/server/test/provider-availability.test.ts` | `faae18a` | exit 0 - 4/4 |
| `pnpm --filter @hepi/server test` | `faae18a` | exit 0 - 497/497 |
| `pnpm --filter @hepi/ui test` | `faae18a` | exit 0 - 235/235 |
| `pnpm --filter @hepi/web test:panel-ingress` | `faae18a` | exit 0 - 61 checks |
| `pnpm --filter @hepi/web test:capability-trust` | `faae18a` | exit 0 - 17 checks |
| `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `faae18a`, `dirty: false` | typecheck / test / web-unit exit 0 (server 497, gateway 468, ui 235, protocol 52, session 57, app 10); `check-docs` exit 1 on the unchanged 12-link baseline |
| mutation: the `invalidateModelCatalog()` call removed | `32d2a25` | exit 1 - the browser suite fails the held-catalog check rather than passing quietly |
| per-package typecheck (`ui`, `session`, `server`, `web`, `gateway`, `protocol`) | `32d2a25` | exit 0 |

Raw logs: `.dev/verify/provider04-merged/` (merged tree) and `.dev/verify/provider04/` (the mutation check). Docs updated
against this revision: docs/providers.md, docs/client-ingress.md, docs/architecture.md, docs/deployment.md,
docs/migration-status.md, docs/verification.md, apps/web/README.md.

## Not held

A live host-local check that a credential stored through a real browser becomes selectable in a real conversation's model
list on one shared-account host: the deployed Backend runs environment mode with a container-private agent directory, and
changing that is a deployment decision about credential isolation, not a code gap in this ticket.

Integration review of the P2 acceptance additions, run at this merge (no source change was needed):

- **Composer availability without a reload - held.** Two signals, not one: a credential change calls `invalidateModelCatalog()` (`ModelsConfig.tsx:1768`), and closing Settings bumps the page's `modelsRefreshKey` (`AppShell.tsx:2836`), which the composer's own effect reads (`useAgentSession.ts:2316-2319,2341`) and re-reads the catalog into `setModelNames`/`setModelList`. A person cannot reach the composer while the Settings panel is open, so the window in which a composer "keeps what it shows" is never observable, and the next composer read is the fresh one.
- **Selected-but-unavailable model keeps its identity with an explicit replacement action - held, and pre-existing.** `ChatInput.tsx:1792-1793` keeps the selection and labels it through `chat.modelUnavailable`; the selector itself is the explicit replacement action. That behaviour is ticket 13's, driven by `apps/web/e2e/ux-missing-model-recovery.mjs`.
- **Save success vs apply success - held.** Different hosts, never one shared message: `apps/server/test/provider-availability.test.ts` asserts a Backend that cannot read its credential file states its own error while the key the host stored is still listed.
- **Invalidate the correct connection's catalog - held as one page, one account; recorded, not fixed.** The drop is page-wide, so another connection's scope goes with it. Nothing is served wrong (scope is part of every key and a superseded in-flight read cannot repopulate), so the cost is at most one extra read for a scope the page is not showing. Deliberate, and asserted that way in `packages/ui/src/lib/models-cache.test.mjs` ("a stored key is one account’s fact").

The remaining P2 claim is the composed real-browser journey in a named mode: ticket 05.

## Recover the existing work first (UX closeout P2, 2026-10-19)

Implementation already exists outside the older baseline. Commit `2ac94bc` (`2ac94bcd72aadff2e9743ba34023f75dbb74274b`) carries it; its history includes feature `32d2a25` ("credential change drops held catalog") and merge `faae18a` into the provider lane. The named branch tip alone does not contain the full delivery history — recover `32d2a25`/`2ac94bc` and review that work before implementing anything new.

Current baseline facts that bound the ticket: key save/remove refreshes only the provider panel (`ModelsConfig.tsx:1655-1708`), which is not proof the composer catalog refreshes; `models-cache.ts:17-18` sets a 60 s cache TTL; ingress `/api/models/refresh` is unserved. The missing route alone does not prove a restart is required.

**Verify separately, and report separately:**

1. **Runtime credential consumer.** Trace the authoritative consumer for the supported deployment mode. `apps/server/src/model-config.ts:229-236` uses in-memory environment credentials, so Pi file-backed mode and environment mode differ. A generic cache invalidation cannot make a different machine or account read Gateway `auth.json`.
2. **Configuration mode.** State which mode the acceptance run used and what the other mode truthfully supports. Keep environment-mode capability honest rather than implying parity.
3. **Save success vs apply success.** Credential-storage success must be shown independently of catalog refresh or apply failure. A failed refresh must never be reported as a failed credential save.
4. **Scope of invalidation.** Invalidate the correct connection's catalog; other connection caches stay isolated.

Acceptance additions: a successful add/remove changes composer availability without a reload in the supported mode; a selected-but-unavailable model keeps its identity and offers an explicit replacement action; refresh messages carry no key/token.

Remaining decision (not resolved by this ticket alone): supported behavior when the provider-management host differs from the model-runtime credential account.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (P2). Evidence: [`../../ux-closeout-research/02-provider-mcp-and-settings.md`](../../ux-closeout-research/02-provider-mcp-and-settings.md).
