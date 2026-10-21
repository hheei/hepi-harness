# 05 - System acceptance

Type: acceptance ticket
Status: implemented (2026-10-20). The driver exists, ran green at the integrated tree, and its record is in
docs/verification.md ("provider connection ticket 05, system acceptance"). One material finding came out of it and was
fixed at its owning seam: the composer read the retired Next BFF's catalog shape, so the Backend's own `models` list
reached a selector as model objects and the composer failed to render on any non-empty catalog through the ingress. The
read now goes through `packages/ui/src/lib/catalog-answer.ts`. The plan below is kept as written; the limits section is
what the run reports, and the two limits the plan named as blockers (interactive OAuth against real upstream endpoints,
and the deployed stack's mode) are recorded there rather than worked around.
Blocked by: 02, 03, 04 (all delivered; 03/04 integrated into `integration/client-app` by this merge)
Depends on: nothing further on the lane side — the tickets 03/04 review resolved its findings, so the plan below now runs against the integrated revision.

Verify full API-key and interactive auth journeys, Gateway placement (including SSH Gateway decision), auth-file permissions, no backend secret exposure, flow cancellation/expiry, runtime refresh, docs and focused checks. Record exact revision, commands, exit codes and log paths. Resolve material findings before marking the spec complete.

## What is already held, so this ticket must not re-claim it

Each row was proven on the provider lane's own revisions (docs/verification.md, tickets 01-04). Restating one of them as
"accepted" here proves nothing new.

| Claim | Held by |
| --- | --- |
| An API-key write lands only in the executing host's `auth.json`, dir 0700 / file 0600, and is never echoed | `packages/gateway/test/provider-auth.test.ts` |
| No Backend request or stored state carries a credential | `packages/gateway/test/ingress-providers.test.ts` (recording relay in front of a real Backend) |
| Interactive sign-in lifecycle: start, poll, prompt and device-code answer, completion, cancel, expiry, per-caller isolation, bearer-revocation abort, unserved-where-refused | `packages/gateway/test/provider-login.test.ts`, `…/ingress-providers.test.ts` |
| Browser seam: request origins, transient key, masked hint, withheld sign-in control where refused, withheld catalog-refresh control, catalog cache dropped on a credential change | `apps/web/e2e/ux-panel-ingress.mjs` (fixture-served host) |
| The Backend re-reads the account it is configured for on demand — both modes — and a failed read states itself and rolls nothing back | `apps/server/test/provider-availability.test.ts` |

## The gap this ticket closes

No check drives a **real browser through one composed real system** where the credential the browser stores is the
credential the Backend reads. Today those are separate worlds: the browser suites front a fixture host, and the
availability seam composes both services in one process with no browser and no conversation. The sentence still recorded
as "named and not held" in the ticket 04 report is exactly this claim:

> a credential stored in Settings through a real browser becomes usable in a real conversation's model list, on a
> deployment whose Backend reads the same account its Gateway writes.

## Harness plan

Reuse `apps/web/e2e/acceptance-stack.mjs` unchanged in its ownership: free ports it picks, one allowlisted child
environment (`childEnv(home, extra)` — PATH, HOME, TMPDIR and a named set, so no ambient `HEPI_`/`PI_`/`*_API_KEY` of the
developer's shell reaches a child), per-run SQLite files, the controlled OpenAI-completions endpoint that records every
request, the production `apps/web/dist` served by the ingress, and teardown that deletes the whole run unless `--keep`.
Add one driver, `apps/web/e2e/ux-provider-acceptance.mjs`. No new service, no new process role, no change to how a real
deployment is composed.

### 1. One shared account, by construction — not by mounting anything

The stack starts Backend, execution Gateway and ingress as children of one user under one temp `artifacts` dir, each with
a `HOME` the run created. The Gateway's credential file is therefore `<artifacts>/gateway-home/.pi/agent/auth.json`:
`startup.ts` composes `ProviderAuthService`/`ProviderLoginService` over `agentDirOf(localExecutionHostIdentity().home)`
and `filesystem.ts` defines that directory as `join(home, ".pi", "agent")`, deliberately ignoring `PI_CODING_AGENT_DIR`
("a `PI_CODING_AGENT_DIR` override is not consulted, so the backend's own configuration can never stand in for the host's
resources"). So the shared account is arranged by giving both services the **same path**, with the Backend pointed at the
Gateway's directory rather than the reverse:

```
Backend env:   HEPI_CONFIG_SOURCE=pi
               PI_CODING_AGENT_DIR=<artifacts>/gateway-home/.pi/agent
               (no HEPI_PROVIDER / HEPI_MODEL pair, no HEPI_PROVIDER_BASE_URL / HEPI_PROVIDER_API_KEY)
Gateway env:   unchanged from acceptance-stack.mjs (its own HOME gives it that agent directory)
Ingress env:   unchanged, incl. HEPI_INGRESS_MCP_GATEWAY_URL / _TOKEN / _ID → the run's gateway
```

`resolveAgentDir()` takes the absolute path as written, so the Backend's registry *is* that directory. Pi mode rejects
`HEPI_PROVIDER_BASE_URL`/`HEPI_PROVIDER_API_KEY` and replaces the environment-owned base layer (docs/pi-config.md), which
is what makes the credential question well-posed: nothing but `auth.json` can authenticate anything here. This is the
same-account host the claim needs, and it is **not** the shape docs/deployment.md forbids: that warning is about
mounting a workstation's real agent directory into a container, exposing a person's OAuth refresh tokens. Here the
directory belongs to the run, holds one synthetic key, and is deleted with the run.

The absence of a `HEPI_PROVIDER`/`HEPI_MODEL` pair is chosen, not incidental: with nothing authenticated the Backend
starts, warns, and stays reachable, and the default settles as the first authenticated catalog entry once the browser
stores a key — the same fallback Pi itself uses. That transition (no default → a default the browser caused) is part of
what the journey observes.

### 2. The catalog the browser is offered

Write `<artifacts>/gateway-home/.pi/agent/models.json` before the Backend starts, defining **one SDK-built-in provider id
whose base URL this run overrides** to the stack's controlled endpoint:

```
{ "providers": { "groq": { "baseUrl": "<model.origin>/v1", "api": "openai-completions",
                            "models": [{ "id": "provider-acceptance-1", "reasoning": false }] } } }
```

Both halves of the seam need this shape and neither needs anything new, and both were read in source rather than assumed:

- the Gateway lists providers from `builtinProviderCatalog()`, so `groq` appears in Settings › Models with
  `hasApiKey: true` and no stored credential;
- `groq`'s SDK record is `auth: { apiKey: envApiKeyAuth(…) }` (`providers/groq.js`), and `envApiKeyAuth`'s `resolve`
  returns `{ auth: { apiKey: credential.key }, source: "stored credential" }` straight from the stored credential with
  **no outbound call** (`auth/helpers.js`), so availability and use depend on nothing but `auth.json`. `openrouter` is
  excluded on purpose: its record reads a key through `https://openrouter.ai/api/v1/auth/keys`
  (`auth/oauth/openrouter.js`), which is a network call and would make the run reach a real upstream;
- the Backend overlays `models.json` on the built-in id — the shape `apps/server/test/pi-config.test.ts` already uses
  (`baseUrl`, `api: "openai-completions"`, `models`), so the model it offers for `groq` is served by this run's recorded
  endpoint, and its credential comes from the Gateway's `auth.json` under the same id. No `apiKey` is written into
  `models.json`, which is what keeps the credential question well-posed.

`startControlledModel()` answers OpenAI-completions, which is `groq`'s API, on `POST /v1/chat/completions` — the path a
`<origin>/v1` base URL produces. So no second responder and no new wire.

**One harness change is needed, and only that one:** the endpoint records `{ at, text, body }` and drops the request
headers, so step 4's "the credential reached the model" is not observable today. Extend the recorded entry with the
`authorization` header. Nothing else in `acceptance-stack.mjs` changes; if a step needs more from it, that is a signal the
plan is wrong, not the stack.

The key the browser stores is a per-run literal in the redactor's own shape, `{{API_KEY_xxxxxxxx}}` — so an accidental
echo fails a check instead of passing quietly. No real credential, no upstream reachability.

### 3. The journey, in the order a person performs it

Chromium against `stack.webOrigin` (ingress-served `apps/web/dist`, `WEB_LOGIN` at the login form, as
`ux-client-acceptance.mjs` does):

1. Settings › Models: the `groq` row reports no credential; the composer's model list does not name
   `provider-acceptance-1`; the conversation has no model.
2. Store the key through the row, then assert the visible masked hint and that the raw literal is gone from the input.
3. **The Backend catalog offers `groq/provider-acceptance-1` and the composer can select it** — with no Backend restart,
   no Backend refresh call, no cache wait. This is ticket 04's client invalidation observed in a browser, which no
   current suite sees.
4. Submit one real turn. The controlled endpoint records exactly one completion request carrying that literal as its
   credential, and the transcript renders the reply. This is the claim availability tests cannot make: the stored
   credential authenticated a conversation, not just a listing.
5. Remove the key (`?expectedType=api_key`). The next catalog read stops offering the model, the composer withdraws it,
   and `auth.json` holds no `groq` entry — while the file's mode is still 0600 and the directory's still 0700.
6. Disconnect path for an OAuth-shaped credential: the same removal through `POST /api/auth/logout/:id` over a credential
   the driver placed in the run's `auth.json` before start (an OAuth-shaped record is **file-state setup**, exactly as
   `provider-auth.test.ts:160` already writes one, so the run asserts listing, sign-out and withdrawal — not a live
   provider sign-in).
7. A second client — an App context issued with `issueDevice(stack, …)` — starts an interactive sign-in against the
   ingress and cancels it mid-flight (`DELETE /api/auth/login/:id?flow=…`), asserting no credential appears in the file
   afterwards, and that the other caller's flow is untouched. Against the SDK provider set this run serves, the honest
   expected answer is `unsupported_operation` for `groq` (an api-key-only record) and a live browser half for one that
   declares `auth.oauth` only where a scripted provider is composed in — see the limit below.

### 4. Absence asserted on artifacts, not on intent

After each mutation, scan the run's own outputs:

- the per-run literal appears in exactly one recorded request body — the ingress's `/api/auth/api-key/groq` — and in no
  Backend request, no Backend SQLite file (`conversations`, `projects`, `device-credentials`, `skill-repository`), no
  ingress or Backend log, no children log;
- the browser's `localStorage`, `sessionStorage` and cookies are read back and named nowhere in them the literal;
- the model endpoint receiving the key is **expected** and is where the run proves the credential was used;
- the transcript/records the Backend persists after step 4 contain no credential value.

### 5. Record

Per docs/agents/verification.md: command, exact revision (short SHA plus dirty state), exit code, and raw log paths under
`.dev/verify/provider05/`. Include the mutation run that proves the harness would notice: with
`invalidateModelCatalog()` removed, the browser check at step 3 fails rather than passing quietly — the ticket 04 lane
proved that at the fixture seam already, and this must show it at the composed seam.

## Named limits of this plan (recorded, not smoothed over)

- **Interactive OAuth sign-in in the composed browser journey is not achievable offline against real upstream flows.**
  `ProviderLoginService` accepts `extraProviders` for scripted flows and its tests use that seam, but `startup.ts` composes
  it without any, and the SDK's OAuth endpoints are compile-time constants — `PI_OAUTH_CALLBACK_HOST` changes only the
  callback host, not the authorize/token URLs. So a real `Models.login` browser journey needs either a live upstream
  credential (not authorized) or a host-side provider-registration seam (a composition/config change this ticket must not
  make unasked). Plan: run the interactive journey's cancellation and caller-isolation half at the ingress seam where it
  is already scripted, record the composed-browser half as a limit with this reason, and raise the provider-registration
  seam as a decision for the parent if it wants that claim held.
- **The deployed stack stays environment mode with a container-private agent directory.** This harness proves the
  same-account composition; it does not and must not change what `remote-host`/`workstation` run, and the credential-isolation
  warning in docs/deployment.md still governs real deployments.
- **Security-boundary probes are out of this lane.** The original ticket text named them; nothing here attempts cross-caller
  flow theft, hostile `models.json` / `!command` credential expressions, forged caller identity, path traversal in provider
  ids, concurrent-writer loss, or OAuth state/PKCE replay. Those need their own security-review assignment, and several are
  already answered at their own seam (bearer/origin admission and per-caller flow scoping in the ingress tests). Do not
  treat this ticket as covering them.

## Closeout checklist (the rest of the original ticket text)

- Gateway placement: **decided** at ticket 01 Decision 1 — credentials belong to the account whose `auth.json` this host
  owns; an SSH gateway composes neither provider service and answers `unsupported_operation`. Held at
  `packages/gateway/test/provider-login.test.ts` and the startup composition tests. This ticket records it against
  docs/migration-status.md; it does not re-open it.
- Docs: read-through for statements that are now **stale** rather than missing — above all any sentence that still implies
  the Backend needs a refresh signal, and the environment-mode capability note the review may judge unclear. No
  speculative expansion: where the existing note states the mode's rule and the operator's choice, leave it.
- Focused checks: the new driver plus `node scripts/verify.mjs --profile=changed --base=integration/client-app` at the
  pinned tree, with the `check-docs` baseline failure stated per docs/agents/verification.md.
- Loopback-callback OAuth remains the spec's open decision (spec.md), unchanged by this ticket.

## Order of work

1. Pin: the integrated `integration/client-app` tip this merge produces (lane source `32d2a25` + `15c2b19` review
   records, carried in by the merge). The lane's own pin at the time of writing was `2ac94bc` (`faae18a` merge of
   integration `66a56f3`); that tree is an ancestor of this one, so the re-pin is a widening, not a change of source.
   Branch existence was never claimed as integration — this merge is what makes it integrated, and the run still happens at the
   pinned integrated tree.
2. ~~Wait for the tickets 03/04 review to resolve material findings.~~ Done: the review iteration (`b20d814`, recorded at
   `15c2b19`) resolved its findings and named the composed journey as what remains.
3. Then implement the harness in the order above, run it, and record. If a check contradicts a documented claim, that is a
   finding to resolve at the owning seam, not a sentence to soften.

## Acceptance is the real path, not the branch (UX closeout P1/P2, 2026-10-19)

Run these through the actual **Web/App** ingress path, in a **named configuration mode**, on a recorded revision. Static source review, a branch tip, a merged commit or a passing unit test is **not** acceptance — record branch existence as evidence of work, never as proof of the journey.

Required observations:

1. API-key set/remove/list in Settings › Models through `/api/auth/providers` and `/api/auth/api-key/:providerId` → Gateway `POST /v1/providers/auth`.
2. Interactive sign-in journey end to end (ticket 03): fresh home first sign-in, device/manual prompt, cancel, expiry, reconnect to a pending flow, re-login after a terminal flow, removal.
3. **Stored vs runtime-usable**, reported separately: `auth.json` accepted the credential, and the composer's model catalog actually reflects it without a reload (ticket 04) — or a named, honest limitation for the mode under test.
4. Configuration mode stated explicitly (Pi file-backed vs environment credential runtime), including which topology was exercised and which remains unsupported.
5. No secret in backend requests/state, browser storage, ordinary responses, logs or sanitized errors; `auth.json` permissions and atomicity as specified.
6. Normal admitted Web/App request reaches the existing Gateway credential-management boundary; reuse existing admission evidence and add no bypass/security-control probes.

Record per observation: revision, commands, exit codes, log paths, and the mode/topology. Material findings are resolved or explicitly recorded before the spec is marked complete.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (P1, P2). Evidence: [`../../ux-closeout-research/02-provider-mcp-and-settings.md`](../../ux-closeout-research/02-provider-mcp-and-settings.md).
