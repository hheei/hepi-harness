# 03 - pi-ai interactive login flows

Type: implementation ticket
Status: done — delivered on `impl/provider-connection-03`, integrated into `integration/client-app` by this merge
Blocked by: 01, 02 (both delivered)

Bridge existing pi-ai OAuth/device/manual-code auth flows through Gateway-owned flow IDs and Web UI events. Implement bounded flow lifetime, prompt/input submission, cancellation, expiry, sanitized terminal states and reconnect/poll behavior. Do not implement OAuth protocol logic locally.

Acceptance: representative device-code and manual/copy-code flows reach success; prompt/select input works; cancellation/expiry/disconnect are explicit; repeated operations do not create duplicate credentials; no token appears in browser persistence, backend, logs or ordinary responses.

## Delivered

The flows are pi-ai's and the credential file stays the host's; nothing here is a second OAuth implementation.
`packages/gateway/src/provider-login.ts` drives `@earendil-works/pi-ai`'s `Models.login` for a provider in
`builtinProviders()`, persisting through a `CredentialStore` adapter
(`packages/gateway/src/provider-credential-store.ts`) that writes via the **same** `ProviderCredentialFile` lock ticket 01
introduced — so the pi CLI, an API-key write and a sign-in are all serialized on one `~/.pi/agent/auth.json`, in pi's own
`{ type, ... }` record shape. No authorization endpoint, token exchange, device-code polling loop or PKCE is reimplemented
here; this repository holds none of that vocabulary. Where a provider's flow needs a device id (OpenAI ChatGPT builds
`ext_agent_host_id` as `urn:uuid:`), it is read from `~/.pi/agent/settings.json` and otherwise taken from
`~/.pi/agent/installation-id` created at mode `0600` — this surface never writes `settings.json`, which the durable backend
also reads.

A flow is the **host's** state, named by a `randomUUID` the host issues, and bounded by the host: 15 minutes open
(`PROVIDER_LOGIN_TTL_MS`), a terminal step kept readable for 60 s (`PROVIDER_LOGIN_KEEP_MS`), 32 flows per host
(`PROVIDER_LOGIN_MAX_FLOWS` → `too_many_flows`, a refusal that clears by itself), an answer capped at 8 192 characters and
refused if it holds control characters. `login-start` waits up to 1.5 s for the provider's first step so a fast flow is
settled in the reply that started it, and otherwise answers `running` to be read again. Operations are `login-start`,
`login-poll`, `login-submit`, `login-cancel` and `login-forget` on `POST /v1/providers/login`
(`packages/protocol/src/gateway.ts`), served only where the local gateway is composed; an SSH gateway serves neither it nor
the listing, and answers `unsupported_operation`. A gateway `close()` ends every flow it holds with its own abort.

The browser half is **poll, not stream**. `GET /api/auth/login/:id` reads the flow this caller has open for that provider
(resume after a reload), `?flow=` names one step of it, `POST` to the same path starts it or answers it, and `DELETE` ends
it; `POST /api/auth/logout/:id` is the removal the listing already owned, so sign-out is served even by a host that runs no
flows. A person finishes a device or copy-code flow in another browser, so the tab that opened it reloads and closes by
design — an `EventSource` would read that as a cancellation and hand a flow's lifetime to a socket. `OAuthDetail`
(`packages/ui/src/components/OAuthDetail.tsx`, extracted from `ModelsConfig`, whose inline streamer is deleted) polls at
1.5 s over `packages/ui/src/lib/provider-login.ts`, and `provider-flow-view.ts` turns a host step into what a person can
act on: a code to read aloud, an address to open, a question to answer, a set of options to choose, or an end.

**One caller's sign-in is not another's.** An ingress shares one host bearer across every client it admits, so the flow id
alone would be a bearer: the host keys each flow by the caller this ingress admitted — `device:<credential id>`, or
`web:<sha-256 of the session cookie>` — a value stated from the admission and never read from a body. A stranger's read,
answer or cancel is answered with the same `flow_unknown` 404 it would get for an id that never existed, and no other
caller's flow is touched. A repeated start by the same caller rejoins its open flow rather than racing a second
authorization address for one file entry.

**A revoked caller cannot leave a credential behind.** This entrance re-checks a device bearer while that caller's request
is attached (an interval, not a queue) and, on revocation, aborts the request and asks the host to forget that caller's
flows — the wait the provider is sitting in is cut short rather than run out, and the dropped flow writes no credential
file. Because the exchange with the authorization server may already have completed, this is reported as an outcome this
host does not claim to have undone; an idle caller's flows still go by the TTL.

**Nothing a flow says is a credential.** The answer a person typed, and any credential-shaped value a provider puts in
its own messages, are masked out of every step, event, error and listing this surface writes, in both directions
(`looksLikeSecretValue`, extended with the shapes Google refresh tokens take: `1//0…`, `ya29.…`). Two things stay whole
because masking them would break the sign-in rather than protect it: the authorization URL (its PKCE challenge belongs to
the provider, not to this host) and the RFC 8628 user code, which is not a bearer token.

Refusal semantics, each with the notice the panel already reads (`providerAuthNotice` is shared — a flow's end and a
listing's failure say the same thing):

| Situation | Host code | HTTP | Panel |
| --- | --- | --- | --- |
| Host serves no sign-in service (SSH gateway, keys-only deployment) | `unsupported_operation` | 501 `unsupported` | Login/Disconnect withheld; key path unaffected |
| No provider host service configured for this origin | — | 503 `provider_auth_unavailable` | Names the variables to set; not read as a limit |
| Host unreachable or refused this origin's token | — | 503 `provider_auth_unreachable` | Retry offered |
| Flow ended, was never this caller's, or vanished with a restarted host | `flow_unknown` | 404 | Back to idle, start again |
| An answer arrived while the flow was elsewhere | `flow_not_waiting` | 409 | Step moved; re-read it |
| Answer was empty, oversized or carried control characters | `answer_invalid` / `invalid_request` | 400 | Against the field just used |
| Provider id this host does not serve | `unknown_provider` | 403 | Not offered |
| Host at its flow limit | `too_many_flows` | 429 | Retry later |

A stored subscription now reports `configured: true`, `source: "OAuth"` and `storedType: "oauth"` from the catalog entry
the file already names — the listing asks the network for nothing to say that, and still carries no token. The
`providerSignInUnavailable` notice was rewritten to state the fact that is now true — a deployment whose host runs no
sign-in flows — and 11 keys were added beside it (the flow's refusals, its waiting states and its instructions), in all
three locales.

## Verification

Command, revision, exit code and log per
[verification practice](../../../docs/agents/verification.md). Revision under test: `4245fcf`
(`impl/provider-connection-03` = source `067f8b4` + docs `7a5382e`, merged with `integration/client-app` `c2d9089`),
`dirty: false`. Logs: `.dev/verify/provider03-merged/` (selected gates) and `.dev/verify/provider03/` (focused files and
browser drivers, re-run at `4245fcf` for the last two rows).

| Check | Command | Exit | Raw log |
| --- | --- | --- | --- |
| Selected gates at the merged tip | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | 1 — `check-docs` only | `.dev/verify/provider03-merged/verify.json` |
| — `changed-typecheck` (app, server, web, gateway, protocol, session, ui) | | 0 | `…/changed-typecheck.log` |
| — `changed-test`: gateway 458, server 473, ui 203, protocol 52, session 52, app 9 — 0 failures | | 0 | `…/changed-test.log` |
| — `web-unit` 52/52 | | 0 | `…/web-unit.log` |
| Focused gateway seam re-run after the fixture fix below, 4 files, 45 tests | `node --test packages/gateway/test/ingress-providers.test.ts packages/gateway/test/provider-login.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/settings.test.ts` | 0 | `.dev/verify/provider03/gateway-login-focused.log` |
| Host seam, 12 tests: manual/copy-code flow to success, device-code flow shown, cancel reaches the provider's wait, TTL expiry stores nothing, caller isolation, a provider that withdraws its question, a provider that writes a token into its own messages, an answer never published back, `login-forget` per caller, flow limit, unknown/unsupported provider, no-capability host, `stop()` ends each flow with its own abort | `node --test packages/gateway/test/provider-login.test.ts` | 0 | `.dev/verify/provider03/provider-login.log` |
| Client ingress seam, 13 tests (7 new): start→question→answer→stored credential over one path, masked listing after, resume-by-provider, stranger 404 ×3, revoked caller's own flows dropped and another caller's untouched, refusal shapes (400/404/409/429/405), host-without-sign-in 501 while key+sign-out keep working, unconfigured 503 for every login shape, unreachable 503, Backend sees no provider route and no credential | `node --test packages/gateway/test/ingress-providers.test.ts` | 0 | `.dev/verify/provider03/ingress-providers.log` |
| Listing seam unchanged beside the new surface, 16 tests | `node --test packages/gateway/test/provider-auth.test.ts` | 0 | `.dev/verify/provider03/provider-auth.log` |
| Admission boundary: the four provider paths are host-scoped routes (401 anonymous, 503 unconfigured) | `node --test packages/gateway/test/settings.test.ts` | 0 | `.dev/verify/provider03/settings.log` |
| Masking rule extended to Google-shaped refresh tokens without over-masking paths (3) | `node --test packages/protocol/test/mcp-secrets.test.ts` | 0 | `.dev/verify/provider03/mcp-secrets.log` |
| Panel contract, 5 tests: route formatting, a flow is read only when it is one, prompt vs statement, over-when-nothing-is-open, each refusal's next action | `node --test packages/ui/src/lib/provider-login.test.mjs` | 0 | `.dev/verify/provider03/ui-provider-login.log` |
| Listing contract beside it, 5 tests | `node --test packages/ui/src/lib/provider-auth.test.mjs` | 0 | `.dev/verify/provider03/ui-provider-auth.log` |
| Browser seam, 54 checks: sign-in withheld at a 501 route with no control offered and no request started; served flow's device code and authorization URL rendered whole; one click → one flow; answer in exactly one request body and in nothing rendered; listing re-read and subscription offered after storage; cancel names its flow and leaves the host with none; disconnect drops the stored credential; no browser storage holds an answer or a key; every call on the connection's origin with the connection's bearer | `pnpm --filter @hepi/web test:panel-ingress` | 0 (PASS) | `.dev/verify/provider03/browser-panel-ingress-tip.log` |
| Capability three-state unchanged with the sign-in gate now serving flows | `pnpm --filter @hepi/web test:capability-trust` | 0 (PASS) | `.dev/verify/provider03/browser-capability-trust-tip.log` |

`check-docs` exits 1 on the **unchanged** 12-link baseline, now across 385 files: the sorted `BROKEN` set at `4245fcf`
(`.dev/verify/provider03-merged/check-docs.log`) diffs empty against ticket 02's retained set
(`.dev/verify/provider02-merged/broken-tip.txt`), which is the `integration/client-app` tip's own. Recorded, not repaired
here; the anchor links this ticket's docs added resolve.

**One contradiction the record caught.** The browser fixture refused an empty answer with `invalid_request` while
the host and this entrance both refuse it with `answer_invalid` — two sides of one seam disagreeing, so the fixture was
corrected to the code the implementation states and both browser drivers re-passed against it.

**Two flakes, neither this change.** Before the merge, `changed-test` failed once on
`apps/server`'s `an upload larger than the JSON body limit reaches the host as the same bytes` (a second host call recorded)
and once on `packages/ui`'s `a device bearer lists, creates, reads, sends, recovers and follows a conversation on the
Backend's own routes` (a page-read entry outside `/api/conversations`). Both pass isolated three times each, both pass as
whole-package suites (`pnpm --filter @hepi/server test` 468/468, `pnpm --filter @hepi/ui test` 203/203), and both passed in
the merged run above, which touches neither package's source. Load timing in the parallel recursive run, like the MCP
cancellation case ticket 02 recorded. Recorded, not chased.

## Review iteration (2026-10-19): four findings at their owning seams

Review of this ticket's surfaces and ticket 04's client half returned three requests-for-change, each of which was a real
defect in the code rather than in its documentation, and a fourth fell out of the third's fixture work. All four are fixed at
the seam that owns them, in `b20d814`. These two records are a separate commit so that every revision named below names a tree
that existed while its check ran: the suite rows ran on that source with only these records unwritten, the selected gates ran on
it with them present as drafts (`verify.json` lists them under `dirtyFiles`), and a mutation row states the line it restored,
because a check cannot mutate a commit that cites it.

Review of this ticket's surfaces and ticket 04's client half returned three requests-for-change, each of which was a real
defect in the code rather than in its documentation, and a fourth fell out of the third's fixture work. All four are fixed at
the seam that owns them. The fix and these two records land as one commit, `21d024d`, so a revision column names
the tree a check actually saw: **source, records dirty** is the fix's code and tests with this section still being written;
**dirty: false** is that commit read back; **one line restored** is a mutation — a check cannot mutate a commit it is
citing, so a mutation row names the line it took out. No count from an earlier revision is claimed for this tree.

**1. A flow this host ended could still store its credential.** `ProviderFileCredentialStore.modify` took upstream's
`AuthOperationOptions` and ignored the `signal` in it, while `Models.login` passes the login's signal to that write and calls
it *after* its exchange settled. So a cancel, an expiry, or a revoked bearer that arrived during the lock wait — a wait this
host grants up to `PROVIDER_AUTH_LOCK_TIMEOUT_MS` — was discarded, and the credential landed anyway. The store now checks the
signal at the two moments it owns: inside the lock before asking the provider's decision, and again after that decision
returns and before the commit, since it is allowed to await. An abort throws the reason it carries, asks the decision zero
times, and never replays it; the serialized read-decide-write is unchanged, which the "legitimate wait still commits exactly
once" check holds. `docs/architecture.md` and `docs/client-ingress.md` said a dropped flow writes no credential: that claim
was the intent, and it is now true of the code.

**2. A Login button that did nothing for 60 seconds.** `OAuthDetail.start()` read the caller's flow first and adopted whatever
came back. But an ended flow stays readable (`PROVIDER_LOGIN_KEEP_MS`) and `login-status` answers it, so the read after a
cancel returned the *cancelled* flow, the panel adopted it as the sign-in it had just started, and no start was ever sent —
for the length of that window. The panel now rejoins only a flow that is still open and falls through to the start otherwise,
which is safe because the host's start is the idempotent one. The fixture models the host's readable window rather than
dropping the flow at its end, so the browser suite drives the sequence a person performs: sign in, cancel, sign in again, see
the new flow's own device step, cancel that.

**3. `login-status` preferred whichever record Map insertion happened to give.** It took the first flow matching the caller
and provider, which after finding #2's fix would report an older *ended* flow and hide the live one. An open flow now wins;
where none is open the record that ended most recently answers, since that is the outcome a caller coming back late asked for.

**4. A fresh account's first sign-in failed before it produced anything.** `#deviceId()` wrote
`~/.pi/agent/installation-id` with a plain `writeFileSync`, but a provider asks for the id while it builds the authorization —
before the credential file's own step, which is what creates the agent directory (inside its lock). On a host that has never
signed in that is `ENOENT`, surfaced as `operation_failed`. The directory is now created the way the credential file creates
it — recursive, 0700 — before the id is written, and both modes are asserted. This is the OpenAI-shaped flow the ticket's
limits already said was unexercised; the fixture asks for the id, so the path is covered without reaching a real upstream.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Store's abort contract and the serialized write it must not break, 6 tests | `node --test packages/gateway/test/provider-credential-store.test.ts` | `b20d814` (`dirty: these two records only`) | 0 - 6/6 | `.dev/verify/provider03-review-fix-final/store-abort.log` |
| Whole Gateway suite, incl. the 3 new sign-in checks | `pnpm --filter @hepi/gateway test` | `b20d814` (`dirty: these two records only`) | 0 - 477/477 | `.dev/verify/provider03-review-fix-final/gateway-test.log` |
| Whole UI suite | `pnpm --filter @hepi/ui test` | `b20d814` (`dirty: these two records only`) | 0 - 235/235 | `.dev/verify/provider03-review-fix-final/ui-test.log` |
| Browser seam, incl. a second sign-in started after an ended one | `pnpm --filter @hepi/web test:panel-ingress` | `b20d814` (`dirty: these two records only`) | 0 - PASS, 65 checks | `.dev/verify/provider03-review-fix-final/panel-ingress.log` |
| Capability three-state intact with the fixture's readable ended flow | `pnpm --filter @hepi/web test:capability-trust` | `b20d814` (`dirty: these two records only`) | 0 - PASS, 17 checks | `.dev/verify/provider03-review-fix-final/capability-trust.log` |
| `@hepi/web` typecheck after the fixture change | `pnpm --filter @hepi/web typecheck` | `b20d814` (`dirty: these two records only`) | 0 | `.dev/verify/provider03-review-fix-final/web-typecheck.log` |
| Selected gates over the changed packages and their dependents | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `b20d814` (`dirty: true` - `verify.json` names exactly these two records) | 1 - `check-docs` only, the unchanged 12-link baseline | `.dev/verify/provider03-review-fix-gates/verify.json` and its logs |
| Mutation: both signal checks removed from `modify` | `node --test packages/gateway/test/provider-credential-store.test.ts` | `b20d814` (`dirty: one line restored`) | 1 - 3 failures, incl. the queued-abort case | `.dev/verify/provider03-review-fix/store-mutation.log` |
| Mutation: `login-status` back to first-match-wins | `node --test packages/gateway/test/provider-login.test.ts --test-name-pattern "provider read answers"` | `b20d814` (`dirty: one line restored`) | 1 - "the open flow was hidden by the older ended record" | `.dev/verify/provider03-review-fix/status-mutation.log` |
| Mutation: the agent-directory creation removed | `node --test packages/gateway/test/provider-login.test.ts --test-name-pattern "installation id"` | `b20d814` (`dirty: one line restored`) | 1 - 2 failures, both the fresh-host sign-in | `.dev/verify/provider03-review-fix/deviceid-mutation.log` |
| Mutation: the panel adopts any flow it reads again | `pnpm --filter @hepi/web test:panel-ingress` | `b20d814` (`dirty: one line restored`) | 1 - after Re-login, no Cancel control arrives (`ux-panel-ingress.mjs:264`): the panel re-adopted the ended flow and sent no start | `.dev/verify/provider03-review-fix/panel-ingress-without-terminal-guard.log` |

The selected gates' counts, from that report: app 10, server 497, gateway 477, protocol 52, session 57, ui 235 — 0 failures;
`web-unit` 52/52; every typecheck exit 0; `check-docs` alone exits 1, on the unchanged 12-link baseline list. Because that run
sat on the fix's own commit with only these two records unwritten, it describes the tree this iteration ships, and `dirtyFiles`
is the evidence rather than a footnote.

No new limit is claimed here: what these checks prove is the bridge's bookkeeping, and the real-upstream OAuth half stays
outside them exactly as stated below. No security-boundary probe was run, no live credential was touched, no service was
restarted, and the environment-mode note stands unchanged — the review confirmed it is a documented limit rather than a bug,
so no UI text moved and no deployment mode was proposed.

## Limits

- **No loopback callback relay.** A provider whose flow opens a `localhost` callback server completes only where that
  listener runs — on the host, for a caller that is on it. This surface is portable by design: it relays the device code,
  the address to open and the paste-back question, and adds no ingress callback route and no URL rewriting, because a
  browser on another machine redirecting to a loopback port on the host would arrive nowhere. Ticket 05 should treat a
  redirect-based flow as unproven over a remote ingress rather than a defect.
- **A revoked caller's flows are noticed on its next request.** The bearer re-check runs while a request of that caller is
  attached, which is what a polling client supplies; a caller that goes silent after its credential is revoked is forgotten
  by its own TTL, not immediately. Fixing that would mean the ingress keeping client bearers past the request, which this
  design refuses.
- **Host-scoped flow budget, no per-caller quota.** `too_many_flows` is one limit for all callers: 32 open sign-ins is a
  deployment-level ceiling, so one person's many providers can fill it before another's one does.
- **Terminal steps age out in 60 s.** A panel that was closed during a flow reads `flow_unknown` after that window and
  starts again; the credential it earned is already the host's and is listed.
- **No post-auth model refresh.** A sign-in answers the host's listing, not a new model inventory; that is ticket 04.
- **Source only.** Nothing was built for or deployed to `remote-host`, and no service was restarted. The flows go live when a
  client ingress and a local gateway carrying this revision are deployed together — an ingress that names no host service
  answers 503, by design.
- **The legacy Next entry stays unserved for sign-in, deliberately.** On `apps/web`'s own route handler these paths still
  fall to the durable adapter's named 501, so the panel hides the control there instead of routing a credential through a
  conversation-scoped Backend path. The current surface is the client ingress serving the Vite build.
- **Device isolation is asserted against a scripted provider.** The flows exercised here are the shapes pi-ai reports
  (auth URL + manual paste, device code, select, secret prompt), not real accounts at Anthropic or OpenAI: no live
  provider sign-in was attempted, so provider-specific quirks (a real PKCE verifier's length, an expired device grant's
  error text) remain outside what this repository can prove.

Recovered and integrated: this ticket's branch work is now in `integration/client-app` at this merge, so the recovery instruction below is satisfied rather than pending. Its closeout acceptance items beyond the original list are the parts ticket 05's composed journey observes.

## Recover the existing branch first (UX closeout P1, 2026-10-19)

This is **not** only a specification stage. Branch `impl/provider-connection-03` at tip `b20d814` already contains
`provider-login.ts`, `provider-credential-store.ts` and UI changes (feature commit `067f8b4`, plus subsequent
sign-in cancellation and re-login fixes). The first act of this ticket is to read that branch, reconcile its wire
contract with the current ingress/UI, and review its fixes — **before designing or reimplementing an OAuth wire
contract**. The 501 answers at `packages/gateway/src/ingress/index.ts:129-140` and the list/set-key/remove-only
`ProviderAuthService.execute` describe the current baseline, not the branch.

Record explicitly: **branch existence is not integration and is not acceptance.** A merged tip, a green unit test or
a documented flow proves nothing about a first sign-in in a fresh home.

Closeout acceptance beyond the list above, observed in the real Web/App path:

- Fresh home first sign-in; device/manual prompt answered; cancel; expiry; reconnect to a still-pending flow; re-login after a terminal flow; credential removal.
- **Stored state and runtime-usable state are reported separately** — "credential saved" and "this runtime can now use it" are different claims and must not be collapsed.
- A connection change cannot adopt a stale host result (a flow or listing answered by a previous host/account).
- Gateway keeps owning `auth.json` and upstream pi-ai flows; the Backend still receives no raw credentials.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (P1). Evidence: [`../../ux-closeout-research/02-provider-mcp-and-settings.md`](../../ux-closeout-research/02-provider-mcp-and-settings.md).
