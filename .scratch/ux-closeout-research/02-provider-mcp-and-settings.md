# Provider, MCP, and settings closeout

Date 2026-10-19. Source baseline: integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`. Static source and existing ticket evidence, not a new authenticated browser acceptance run. Parent checked scout report against current source and branch references; corrected recommendations below govern. Source paths refer to integration worktree. Current planning evidence also exists in integration worktree `.scratch`; primary scratch is older.

## P1 — Provider sign-in/out: finish existing branch and integrate (high priority, branch-only)

Journey: connect provider using supported OAuth/device/manual flow in Settings. Current `packages/gateway/src/ingress/index.ts:129-140` answers 501 for auth/login and auth/logout. `ProviderAuthService.execute` in `provider-auth.ts:221-233` supports list/set-key/remove only. API-key UI works through `ingress/providers.ts:181-213`: exact client routes are GET `/api/auth/providers`, POST/DELETE `/api/auth/api-key/:providerId`; host RPC is POST `/v1/providers/auth`.

Existing OAuth implementation is not merely a spec: `impl/provider-connection-03` tip `b20d814` contains provider-login.ts/provider-credential-store.ts and UI changes (feature commit `067f8b4`, subsequent sign-in cancellation/re-login fixes). Branch existence is not proof of integration or final acceptance.

Closeout: reuse ticket 03 branch, reconcile with current UI/ingress and inspect its fixes, then finish provider ticket 05 acceptance. Preserve Gateway-owned auth.json and upstream pi-ai flows; Backend receives no raw credentials. Avoid choosing a fresh OAuth wire design during research; review branch contract first.

Acceptance: fresh home first sign-in, device/manual prompt, cancel, expiry, reconnect to pending flow, re-login after terminal flow, removal; stored and runtime-usable state must be distinguished; connection change cannot adopt old host result. No real provider credentials changed in this research.

## P2 — Credential change to usable model selection (high priority, partial and branch status to reconcile)

Journey: save valid provider key and immediately select newly available model. Current key save/remove refreshes provider panel (`ModelsConfig.tsx:1655-1708`); that is not proof that composer catalog refreshes. `models-cache.ts:17-18` defines 60-second cache TTL; ingress `/api/models/refresh` is unserved. However absence of that route alone does not prove runtime needs restart.

Current integration ticket `.scratch/provider-connection/issues/04-model-refresh.md` is open, but implementation already exists outside this baseline: parent verified commit `2ac94bcd72aadff2e9743ba34023f75dbb74274b`, whose history includes feature `32d2a25` (credential change drops held catalog) and merge `faae18a` into the provider lane. Diff against baseline includes catalog invalidation and ModelsConfig changes. Recover and review this delivered work before implementing anything new; the current named branch tip alone does not contain the full delivery history. Configuration mode matters: environment credential runtime differs from Pi file-backed mode; `apps/server/src/model-config.ts:229-236` explicitly uses in-memory environment credentials. A generic cache invalidation cannot make a different machine/account read Gateway auth.json.

Closeout: trace authoritative runtime credential consumer for supported deployment mode, verify account/path topology, integrate existing non-secret invalidation work where available, invalidate correct connection catalog and refresh actual composer options. Show auth-storage success separately from catalog/apply failure. Keep environment-mode capability truthful.

Acceptance: successful add/remove changes composer availability without reload in supported mode; selected unavailable model retains identity with explicit replacement action; failed refresh does not claim credential save failed; other connection caches remain isolated. Remaining decision: supported behavior when provider-management host differs from model-runtime credential account.

## M1 — MCP configured → discovered → explicitly selected → invoked (high priority, partial implementation)

Integrated foundations: Gateway host configuration/trust/test/sign-in via `ingress/mcp.ts`; tool listing in `mcp/listing.ts`; invocation in `mcp/invocation.ts`. Durable adapter already exists at `apps/server/src/mcp-conversation-tools.ts:1-34,250-288`. `server.ts:1221-1247` installs bridge from deployment declarations and dispatches via `clientOf(connection).control.invoke`. Selected `hepi.mcp` extension and declared tools can already execute; do not create a parallel packages/session tool runtime.

Actual gap: current adapter explicitly does not consume live listing (`mcp-conversation-tools.ts:23-28`). User configuration alone does not populate deployment declaration `HEPI_MCP_TOOLS` or grant conversation individual tools. Existing integration ticket 03 has 03a listing delivered; 03b/03c and ticket 04 child/fork lifecycle remain. See integration `.scratch/mcp-conversation-tools/issues/03-trust-selection.md` and `research/03-discovery-and-selection-contract.md`.

Closeout: complete existing discovery/selection contract through host listing, Backend authoritative durable grants and shared UI. Keep configured/enabled/exposed/trusted/granted states distinct. Show discover progress and explicit reasons for no tools or refusal. Descriptor changes and child/fork selection must resolve through existing durable ownership, not silent auto-grants on discovery.

Acceptance: add/test server → list tools → explicit selection → real model invocation with visible result; disabled/untrusted/offline/changed schema yields named state; child/fork inherit according to approved contract; restart/cancel preserve unsafe replay and outcome_unknown semantics. MCP over SSH remains a separate capability limit; SSH file support does not imply MCP server execution on remote host.

## S1 — Model configuration actions with 501 capability limits (medium: decide scope before implementation)

`ingress/index.ts:129-140` intentionally excludes deployment default, enabled scope, catalog refresh, model discover/test/catalog. Capability probing in `packages/ui/src/lib/capability-availability.ts:46-60` and ModelsConfig gates suppress unsupported actions. Missing API is not necessarily a clickable dead control.

Provider connection spec explicitly excludes model discovery and benchmarking. Research candidate: explicit Test connection after setup, plus discovery when user configures a provider without manual model IDs; ownership differs from OAuth. Decide whether these become a follow-up capability or remain clearly unavailable. Do not recreate deployment-wide model default merely because copied UI once exposed it. Per-conversation model choice already exists.

Acceptance if selected: explain what Test validates and which host/account/provider configuration it uses; expose success/failure without mutation or secret echo; discovery selection explicitly persists desired model configuration.

## S2 — Skills removal (medium/optional capability, not a broken install flow)

Install/update/toggle and local-modification/conflict feedback already exist (`packages/gateway/src/install.ts`, `packages/ui/src/components/SkillsConfig.tsx`). There is no uninstall operation or UI. Disable is available; absence of uninstall is documented at `docs/migration-status.md:926`.

Closeout if selected: define managed installation removal with target host/scope/source visible, confirmation and local-edit disposition; distinguish managed skill directory from manual/repository content before removal. Retained update backups and provenance require explicit handling. A generic recursive delete plus lock cleanup is insufficient design.

Acceptance: remove selected managed install only; metadata and Reload outcome truthful; manual or edited installation handled according to explicit user choice; stale inventory re-read. Decision: managed-only removal initially versus broader manual directory deletion.

## Corrections from manual review

- Scout claim that MCP durable adapter is absent was false; parent confirmed adapter and runtime installation.
- Scout called model refresh globally missing/restart-required from 501 route alone. Evidence supports missing integrated connection-to-catalog closeout, not universal restart requirement.
- OAuth is branch-only implemented work, not only specification stage.
- Source has a graph under integration/graphify-out; graph absence claim was not relied on. Exact-file review used earlier parent/scout locations and current source.

No runtime source, credentials or deployment changed.
