# Settings: gaps, ownership, next increments

Exploratory report. Owned path: `.scratch/webui-next-exploration/settings.md`. Read-only source work on baseline
`68c2fb2` (detached HEAD); no edits, tests, builds, deploys, graph updates or paid calls. Primary graph:
`graphify-out/graph.json` (narrow queries, then source confirmation).

## 1. Current state

Settings is one dialog with six sections (`apps/web/lib/settings-navigation.ts`: general, models, skills, agents,
extensions, mcp). Owners: **backend** = `apps/server/src` (sole durable runtime and SQLite writer, ADR 0001);
**web-host** = the Next process (`app/api/[...path]/route.ts` + `adapters/*`); **gateway** = execution host;
**browser** = localStorage.

| Surface | Route(s) the UI calls | Serving owner today | Status |
| --- | --- | --- | --- |
| Appearance, fonts, width, chat toggles, language | none | browser | works (localStorage) |
| Log out | `GET`/`DELETE /api/web-auth` | web-host (`app/api/[...path]/route.ts`) | wired |
| Push registration | `GET /api/push/config`, `POST /api/push/subscribe` | web-host would own it | 501; hidden via `capabilityServed`; `web-push` dependency already removed |
| PowerShell tool switch (Windows only) | `GET`/`PUT /api/tools/settings` | gateway/execution host owns shell | 501; on Linux never rendered |
| models.json editor | `GET`/`PUT /api/models-config` | backend (`server.ts:1479`, `model-config.ts`) | wired (validate → 0600 atomic write → refresh) |
| Provider listing / sign-in / API keys | `/api/auth/providers`, `/api/auth/login/{id}` (SSE), `/api/auth/logout/{id}`, `/api/auth/api-key/{id}` | backend owns model access (`docs/providers.md`) | 501; UI present (`ModelsConfig.tsx`) |
| Model import, connection test, catalog fill/refresh | `POST /api/models-config/discover`, `POST /api/models-config/test`, `GET /api/models-config/catalog`, `POST /api/models/refresh` | backend | 501; import UI gated by capability probe |
| Default model/thinking, model visibility | `PUT /api/models/default` (`ModelSelector.tsx`, `useAgentSession.ts:1775`), `GET`/`PUT /api/models/enabled` | backend (new write path); native home is pi `settings.json` `enabledModels` | 501; browser half exists (`lib/enabled-models.ts`, `EnabledModelsSection.tsx`) |
| Provider quota | `POST /api/provider-usage/query` | backend (needs credentials) | 501 |
| Per-response / session usage | none | browser projection (`lib/session-stats.ts`) | works client-side |
| Sub-agent profiles/settings | `/api/subagents/*` | other workers' scope | 501; explicitly out of this report |
| Skills, Extensions, MCP | `/api/skill-market/*`, `/api/extensions`, `/api/mcp` | backend / web-host service | wired |

The adapter's catch-all answers 501 `{code:"unsupported"}` (`durable-api.ts`) and `lib/capability-availability.ts`
turns that into "hide the control, name the limit" (`null`, never `false`, when no answer arrived), so the
unserved rows above are honest, not broken.

## 2. Native capabilities that already exist

Installed: `pi-coding-agent@1.1.0`, `pi-ai@1.1.0`, `pi-durable@1.1.0`. `ModelRuntime`
(`pi-coding-agent/dist/core/model-runtime.d.ts`) exposes `login(providerId, type, interaction, options)`, `logout`,
`listCredentials`, `getProviderAuthStatus`, `getAuth`, `refresh({providers, force, allowNetwork})` →
`ModelsRefreshResult{errors}`, plus `getAvailable`/`getModels`. Prompts are typed (`AuthInteraction`,
`AuthPrompt`; `pi-ai/dist/auth/types.d.ts`), and pi-ai ships OAuth for anthropic, openai-chatgpt, github-copilot,
openrouter, xai, kimi, plus `device-code`/`callback-server`. Credential persistence is app-owned
(`CredentialStore.modify` is the only write path).

The backend already holds that instance (`main.ts:55` builds `modelConfig = { path, runtime: models }`, used at
`server.ts:1480`): routing, not construction.

Vendored implementations of these surfaces exist under `apps/web/vendor/pi-web/lib/`: `provider-listing.ts` (provider
lists from declared auth methods, not an id list), `provider-credential-store.ts`, `model-discovery.ts` (+
`model-discovery-auth.ts`), `model-catalog.ts`, `model-catalog-refresh.ts`, `provider-usage.ts` (billing endpoints
with an official-origin allow-list), `deferred-provider-models.ts`. `provider-usage.ts` creates its own runtime;
adaptation means handing it the backend's.

## 3. Ownership, and what is genuinely new

- **Backend**: provider auth, discovery, test, quota, defaults — keys and base URLs never reach the browser
  (`docs/providers.md`); it is the single durable writer.
- **Web host**: push (subscription, VAPID, delivery); MCP is the precedent for a host-owned service
  (`adapters/mcp-surface.ts`).
- **Gateway**: tool permissions and shell — `docs/pi-config.md` records no per-call approval mode.
- **Browser**: appearance/chat preferences, correctly; no endpoint is missing.

Genuinely new, unlike the table's adapts rows: a durable credential story for env mode, a `settings.json` (or
hepi) write path for defaults and visibility, a connection-test route, and push end to end (VAPID + subscription store
+ a run-ended producer; the Web host has no durable event subscription today).

## 4. Ranked increments

| # | Increment | Value | Effort | Depends on | Nature |
| --- | --- | --- | --- | --- | --- |
| 1 | Provider credentials: `/api/auth/providers`, login/logout, api-key add/remove over `runtime.login/logout/listCredentials/getProviderAuthStatus` + `provider-listing.ts`/`provider-credential-store.ts` | high (no key, nothing runs) | medium | env-mode decision | adapts native |
| 2 | Model import + catalog fill: `discover` over the runtime's resolved auth (`model-discovery*.ts`), `catalog` over `model-catalog.ts` | high (pairs with 1) | medium | 1 (auth resolution) | adapts vendored |
| 3 | Connection test: one minimal `completeSimple`/models probe per draft provider, key never echoed | medium-high | low | 2 | thin new |
| 4 | Defaults: `PUT /api/models/default` writing the native default + live `runtime.model`/`harness.model` | medium | medium | settings write path | new |
| 5 | Visibility: `GET`/`PUT /api/models/enabled` as a minimal edit of `enabledModels` (`lib/enabled-models.ts` holds the pattern logic) | medium | low-medium | 4 | adapts native setting |
| 6 | Provider quota: `/api/provider-usage/query` reusing `provider-usage.ts` with the backend runtime | medium (subscription users) | low-medium | 1 | adapts vendored |
| 7 | Push: VAPID keys, subscription store, producer for run-ended | medium | high | web-host service design | new |
| 8 | Catalog refresh (`/api/models/refresh`) | low | low | 2 | adapts native `refresh` |
| 9 | Tools preferences (`/api/tools/settings`) | low (per-host, Windows-only, permissions belong to the gateway) | low-medium | none | new, probably a recorded limit |

1–3 are one increment, 4–5 a second, 6 stands alone, 7 is its own project, 8 rides on 2, 9 a recorded limit.

## 5. Risks

- **Env mode cannot persist credentials.** `openEnvModelRuntime` uses `InMemoryCredentialStore` and reads no
  `auth.json`; only `HEPI_CONFIG_SOURCE=pi` has a durable credential file. A sign-in route must refuse in env mode by
  name or introduce a hepi-owned credential file, or a login vanishes on restart.
- **Second writer on `auth.json`** (pi CLI and OAuth refresh already lock and rewrite it): route through
  `CredentialStore.modify` semantics and document the concurrency.
- **Secret hygiene.** `server.ts` already carries `SAFE_CREDENTIAL_ERROR` and sanitizers because upstream errors quote
  `auth.json`/`models.json` bytes; new routes must not forward raw messages or keys, and a read-only listing must not
  execute `!command` references.
- **Outbound fetches** for discovery/quota use operator-supplied base URLs; reuse the vendored allow-lists.
- **No settings hot reload** (`docs/pi-config.md`: settings apply after restart), so a default or visibility change
  that cannot be applied live must answer saved-but-not-applied, as `models-config` does. `capabilityServed` also
  treats only 501+`code:"unsupported"` as "not served", so a new route that 500s reads as available.
- **Scope creep** into `/api/subagents/*` (AgentsConfig) — other workers own it.

## 6. Public verification seams

- Backend route tests driving `createBackendServer` with a real `modelConfig`: `apps/server/test/models-config.test.ts`,
  `pi-config.test.ts`, `provider-config.test.ts`, `missing-model.test.ts`.
- Adapter mapping: `apps/web/adapters/durable-api.test.mjs` (route table incl. the 501 list); browser:
  `apps/web/e2e/ux-models-config-save.mjs`, `ux-capability-trust.mjs` (real `SettingsPanel` in Chromium; asserts
  served / explicitly unsupported / unanswered), `ux-missing-model-recovery.mjs`.
- Operator smokes (`docs/providers.md` Verification): `pnpm --filter @hepi/server smoke:catalog` (unpaid, through the
  real Web origin) and `smoke:provider` (paid, manual).
- Guides to move in the same change: `docs/providers.md`, `docs/pi-config.md`, `docs/migration-status.md`,
  `apps/web/README.md`.

## 7. Decisions needed from the user

1. Env mode: keep credentials env-only (auth routes refuse by name) or add a hepi-owned credential file?
2. Defaults/visibility: write pi `settings.json` where a pi directory exists and hepi state otherwise, or hepi-only
   state in both modes?
3. Push in scope (new web-host service with VAPID and a run-ended producer), or a recorded limit?
4. One provider-setup route group on the backend, or separate routes mirroring upstream's paths?

## 8. Three strongest findings

1. **The native capability is already there.** `ModelRuntime` in `pi-coding-agent@1.1.0` exposes
   `login`/`logout`/`listCredentials`/`getProviderAuthStatus`/`refresh`, and the backend already owns the instance
   (`main.ts:55` → `server.ts:1480`). Provider auth, discovery and catalog refresh are adapter work with vendored
   copy-first helpers, not new subsystems.
2. **Env mode has nowhere durable to put a credential.** `openEnvModelRuntime` is `InMemoryCredentialStore` with no
   `auth.json`; only pi mode persists. This decides the shape of increment 1 and cannot be designed around later.
3. **`enabledModels` and the default provider/model are native settings the backend ignores and never writes.**
   `pi-config.ts` lists `enabledModels` in `unsupportedWarnings`, `SettingsManager` is read-only, and `runtime.model`
   is fixed at boot — while the browser half (`lib/enabled-models.ts`, `EnabledModelsSection.tsx`) already exists. A
   backend settings write path is the largest genuinely new behavior here.

## 9. Unknowns (not resolved in this pass)

- Whether pi's own settings writer would race a backend write of `settings.json` (only the read path was inspected).
- Whether upstream pi-web ships push endpoints worth copying; the vendored `lib/` inspected here has none.
- What `Models.getAuth` returns for a credential-less provider in env mode (not exercised; needs a live call).
