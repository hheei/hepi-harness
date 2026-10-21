# Provider Connection Management

Status: implemented (tickets 01-05 delivered; ticket 05's system acceptance ran green and its one material finding — the composer's catalog shape — is fixed at its owning seam)
Labels: ready-for-agent, provider-auth, gateway
Date: 2026-10-17

## Goal

Let users inspect provider connection state, set/remove API keys, and authenticate providers through existing `pi-ai` flows. Gateway on the execution host owns credential storage and OAuth flows. The backend remains credential-blind.

## Decisions

1. **Gateway owns credentials.** Provider API keys and OAuth credentials are stored only by Gateway in the execution host's `auth.json` under the pi agent directory.
2. **Reuse upstream auth.** Use `@earendil-works/pi-ai` credential storage, provider definitions, OAuth, device-code and manual/copy-code flows. Do not implement OAuth protocol engines in this repository.
3. **Backend is not a broker.** Raw keys and tokens never transit backend APIs or backend persistence. Provider auth management is a Web-to-Gateway control path.
4. **Browser handling is transient.** A user-entered API key necessarily passes through the browser UI and the authenticated client ingress to Gateway. It must not be written to browser storage, returned after mutation, or included in normal logs, diagnostics, analytics, or errors.
5. **Write-only secrets.** Listing exposes provider ID, credential type/presence, and optional masked hint only. Mutations never echo raw credential values.
6. **Phased delivery.** First provider listing and API-key CRUD; next upstream device/manual/copy-code OAuth; finally optional local loopback callback convenience and runtime refresh integration.
7. **Gateway authorization.** The client ingress authenticates the caller and calls Gateway using its configured host-service token. Gateway validates the request and applies its existing auth/secret-redaction conventions.

## Scope

In scope:

- List known provider auth options and currently stored credential status.
- Set and remove API keys using pi-ai-supported provider IDs and storage formats.
- Run supported pi-ai OAuth login flows through a Gateway-owned flow with bounded lifetime, status events, input submission and cancellation.
- Relay provider-auth operations from Web to Gateway without routing secrets through the durable backend.
- Refresh or invalidate model availability after auth changes through an explicit non-secret signal or request.

Out of scope:

- Rewriting OAuth, token exchange, token refresh or provider-specific auth protocols.
- Storing provider credentials in Web config, browser storage, or durable backend state.
- Multi-tenant credential namespaces inside one execution-host account.
- Provider/model discovery, remote catalog search and model connectivity benchmarking; these remain separate capability specs.
- Automatic credential migration from unrelated stores.

## Architecture

```text
Models Settings UI
  -> authenticated client ingress /api/auth/* (the App path; the retired Next BFF is not its owner)
  -> Gateway RPC /v1/providers/auth
  -> pi-ai credential/auth implementation
  -> execution-host ~/.pi/agent/auth.json

Durable backend does not receive credential values.
```

The Gateway service owns the file lock, atomic persistence, permissions, flow map, timeout/cancellation and error redaction. Web relays UI input and events. Existing model configuration/runtime paths consume credentials according to pi-ai's supported interfaces; this feature must not make the backend an auth broker.

## Wire Contract

Initial Gateway route: `POST /v1/providers/auth`, with typed request/result unions in `packages/protocol`.

Operations:

- `list`: known provider IDs and credential status (`stored`, type, masked hint).
- `set-key`: provider ID and write-only key.
- `remove`: provider ID and optional expected credential type.
- `login-start`: provider ID; returns opaque flow ID and initial phase/event metadata.
- `login-submit`: flow ID plus a pi-ai prompt answer, selected option, or manual/copy code.
- `login-poll` or event stream: bounded flow status/progress and terminal result.
- `login-cancel`: cancel an active flow and release its resources.

Exact operation names and SSE framing may follow existing Gateway/MCP conventions. The Web API maintains its existing `/api/auth/*` UI contract where practical. Secret-bearing Gateway responses are forbidden.

## Flow and Failure Semantics

- OAuth flow IDs are unguessable, scoped to the authenticated Gateway client, expire after a bounded TTL, and are removed on completion/cancel/expiry.
- Repeated submit/cancel operations are idempotent or return a named terminal-state error.
- Disconnecting a Web stream does not silently claim success. The UI can reconnect/poll while the Gateway flow remains live, or explicitly cancel it.
- Unsupported provider/flow, expiry, invalid input, lock conflict, Gateway offline and authorization failure use stable error codes with sanitized messages.
- Gateway errors pass through the shared secret redactor before logging or returning to Web. No raw token/key fragments in traces or test snapshots.
- File updates use pi-ai's credential store/locking behavior and restrictive directory/file permissions (directory `0700`, file `0600` where supported).

## Acceptance

- API-key set/remove changes only execution-host Gateway `auth.json`; permission and atomicity tests pass; list returns only presence/masked hint.
- Tests prove raw key is absent from backend requests/state, browser storage, normal responses, logs and sanitized errors.
- Provider listing reflects the supported pi-ai provider set and handles unknown IDs without mutating storage.
- OAuth phase reuses pi-ai handlers; tests cover prompt/device/manual-code events, completion, cancel, expiry, disconnect/reconnect behavior, and no secret leakage.
- Ingress admission and Gateway bearer rejection are tested; Web never bypasses the Gateway auth boundary.
- Auth changes lead to a defined model availability refresh without sending credentials through the backend.
- Focused Gateway/Web tests, package typechecks, `pnpm verify:changed`, and docs checks are recorded with exact revision, exit code and logs.

## Open implementation decisions

- **Decided, ticket 01:** provider auth is the **local** Gateway's, settled by the same rule that gives MCP to the Web
  host: the credentials belong to the account whose `auth.json` this host owns, and an SSH gateway's is a remote
  account's. An SSH gateway composed without the service answers `unsupported_operation` rather than writing another
  account's credential file. Reopening this means naming the remote account that would own the credential.
- Whether provider auth is initially restricted to a local Gateway or also supported by SSH Gateway. The control path should allow SSH Gateway when its execution-host auth directory is the intended credential owner.
- **Decided, ticket 04:** the trigger is client-side and non-secret, and no wire signal exists. The Backend re-resolves
  credentials from the account it is configured to read on each catalog read (Pi mode reads the agent directory's `auth.json`
  on demand; environment mode keeps credentials in memory and reads no file by design), so the only stale party was
  this page's cached catalog, which `invalidateModelCatalog()` drops on every confirmed credential change
  ([ticket 04](issues/04-model-refresh.md)). No credential value crosses to the Backend in either direction.
- **Decided, ticket 03:** only what pi-ai declares. The host runs `Models.login` for a provider whose SDK
  record declares `auth.oauth` and refuses any other as `unsupported_operation` - Anthropic, OpenAI, GitHub
  Copilot, xAI, Kimi, Meta and OpenRouter carry such a record; DeepSeek, Groq, HuggingFace, Xiaomi and the Cloudflare
  gateways do not. The per-provider answer is reported on `GET /api/auth/providers` (`hasOAuth`) and the panel
  reads that field, so neither an invented flow nor a second capability route exists.
- Whether loopback callback OAuth is supported outside local Gateway mode. Device/manual/copy-code flows are the portable baseline.

## Delivery Phases

1. Gateway protocol/service plus provider listing and API-key CRUD; client-ingress relay; security and persistence tests.
   Delivered: `POST /v1/providers/auth` with `list`/`set-key`/`remove` reading and writing the execution account's
   `auth.json` ([ticket 01](issues/01-gateway-provider-auth.md)), relayed by the client ingress on
   `/api/auth/providers` and `/api/auth/api-key/:id` and read by Settings › Models through
   `packages/ui/src/lib/provider-auth.ts` ([ticket 02](issues/02-web-auth-relay.md)). The durable Backend receives no
   credential and serves no route for one.
2. pi-ai interactive OAuth/device/manual-code flow and UI event bridge with TTL/cancel/reconnect semantics.
   Delivered: the host runs pi-ai's own flows behind Gateway-owned flow ids, caller-scoped and TTL-bounded, with
   prompt / device-code / manual-code steps, cancellation, expiry and bearer-revocation abort, relayed by the client
   ingress on `/api/auth/login/:id` (start, poll, answer, cancel) and `/api/auth/logout/:id`, and driven by Settings
   through fetch-polling `packages/ui/src/components/OAuthDetail.tsx` rather than the retired EventSource surface
   ([ticket 03](issues/03-pi-ai-login-flows.md)).
3. Runtime/catalog refresh integration and optional loopback callback support where topology permits.
   Refresh delivered ([ticket 04](issues/04-model-refresh.md)): no signal, because nothing on the Backend goes stale;
   the page's cached catalog is dropped on a credential change, and `POST /api/models/refresh` stays a named limit
   whose control the UI withholds. Loopback-callback convenience remains open and belongs to
   [ticket 05](issues/05-system-acceptance.md)'s topology closeout.


## UX closeout addendum (2026-10-19)

The provider/MCP/settings UX closeout ([\`../ux-closeout-research/02-provider-mcp-and-settings.md\`](../ux-closeout-research/02-provider-mcp-and-settings.md)) changes no decision above. It corrects the delivery picture and adds the acceptance the tickets must observe:

- **Ticket 03 is existing branch work.** \`impl/provider-connection-03\` tip \`b20d814\` contains \`provider-login.ts\`, \`provider-credential-store.ts\` and UI changes (feature \`067f8b4\` plus sign-in cancellation/re-login fixes). Recover, reconcile and review that branch before choosing or rebuilding a wire contract. The 501 answers and the list/set-key/remove-only service describe the baseline, not the branch.
- **Ticket 04 is existing delivered work.** Commit \`2ac94bc\` (history: feature \`32d2a25\` "credential change drops held catalog", merge \`faae18a\`) carries catalog invalidation and ModelsConfig changes outside the older baseline. Recover and review before implementing new invalidation.
- **Branch existence is not integration and not acceptance.** Acceptance means the real Web/App path in a named configuration mode, on a recorded revision (ticket 05).
- **Stored vs runtime-usable are separate claims.** Verify the authoritative runtime credential consumer for the supported mode; \`apps/server/src/model-config.ts:229-236\` uses in-memory environment credentials, so a generic cache invalidation cannot make a different machine or account read Gateway \`auth.json\`. Environment-mode capability stays truthful.
- Preserved decisions: Gateway owns \`auth.json\` and upstream pi-ai flows; the Backend receives no raw credential and serves no route for one.

Deferred, and deliberately **not** tickets: provider connection test / model discovery, and managed skill uninstall — see [deferred decision records](deferred-decisions.md).

Cross-effort execution map: [\`../ux-closeout-research/spec.md\`](../ux-closeout-research/spec.md) (created by parent).

## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.



Each implementation slice updates its owning current provider/client-ingress guide and migration-status.md with delivered behavior;05 verifies alignment rather than deferring all documentation. Validation uses normal admitted journeys and isolated credentials; no bypass probes are designed or run.
