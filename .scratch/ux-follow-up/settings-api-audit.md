# Settings API audit

Read-only inventory of every HTTP interface the Settings dialog reaches, by method, with call-site evidence.
Dated snapshot: main repo `hepi-harness` HEAD `23c5eaa`. No application, configuration or deployment change accompanies
this record. Every "unimplemented" row is a review candidate (TODO), not an approved implementation order.
**Superseded in part:** the UX follow-up landed PATCH `/api/skills`, the skill-market check/update/toggle routes, the
project routes and the models-config save afterwards, so a row reading `unimplemented` here may now be wired. Verify
against the live route table (`apps/web/adapters/durable-api.ts` plus `apps/server/src/server.ts`) and
[docs/verification.md](../../docs/verification.md); this audit's own statuses are the state on its baseline date.

Status vocabulary:

| Status | Meaning |
| --- | --- |
| wired | The request is served end to end today (Web route → adapter → backend/gateway). |
| unimplemented | Nothing serves the path: `apps/web/app/api/[...path]/route.ts` → `apps/web/adapters/durable-api.ts:115` (or `adapters/workbench.ts`) answers 501 `unsupported`. The panel shows its generic error text. |
| local-preference | No HTTP. The value lives in browser storage and is owned by the Web host's browser only. |
| no-API | Pure presentation helper; issues no request. |

Ownership labels: **backend** = `apps/server/src/server.ts` (or `skill-repository.ts`); **web-adapter** =
`apps/web/adapters/*`; **legacy-frontend** = copied pi-web panel code in `apps/web/lib|components` that expects a
pi-web server this repository never mounts; **browser** = `localStorage`.

## Source closure

Scope was closed by enumerating, then reading:

- Every `/api/` literal in `apps/web/{components,hooks,lib,adapters,app}` excluding `vendor/` and `*.test.*`.
- The single Web route `apps/web/app/api/[...path]/route.ts` (only GET/POST/PATCH/DELETE are exported; there is no
  PUT export, so every PUT below is answered 405 by Next before any handler runs — see note).
- The adapter dispatch: `adapters/durable-api.ts` (`isWorkbenchPath` → `adapters/workbench.ts`; `skill-market`
  → `adapters/skill-market.ts`; final catch-all `unsupported`), and the backend surface
  `apps/server/src/server.ts:268-420` plus `packages/gateway/src/index.ts:443`.
- The gateway exposes only `/v1/execute`, `/v1/workbench`, `/v1/files`, `/v1/installs`, `/v1/abort`. **These legacy management endpoints are not mounted**: no `/api/models-config`, `/api/auth/*`, `/api/mcp*`, `/api/tools/settings`,
  `/api/skills*`, `/api/subagents*`, `/api/plugins*`, `/api/provider-usage*`, `/api/project-trust`, `/api/push*`,
  `/api/web-auth`, `/api/app-update` or `/api/models/enabled|refresh|default` appears in `apps/server/src` or
  `packages/gateway/src`.

Counts: **38 distinct settings-scope paths, 55 distinct method/path pairs** (a path reached with several verbs is
counted once per verb; `POST /api/plugins` and `PATCH /api/skills` are each one pair however many actions they carry).
> Updated by tickets 11 and 14: the previously unimplemented `PATCH /api/skills` is now **wired** through the
> execution-side market routes, and the `POST /api/skills/{search,install,check,update}` rows are retired with their
> callers. `GET /api/skills?cwd=` (chat dormancy) stays unimplemented. The totals above are the original measurement.

**13 browser-local preference/state values** (including the provider-usage cache) carry settings state without HTTP.

> PUT note: `apps/web/app/api/[...path]/route.ts` now also exports PUT, and `PUT /api/models-config` is wired through
> the durable adapter to the backend (ticket 12). `PUT /api/tools/settings`, `PUT /api/models/enabled`,
> `PUT /api/models/default` and `PUT /api/subagents/*` still reach the adapter without a handler and answer 501.

## Settings › General — `apps/web/components/SettingsPanel.tsx` (GeneralSettings)

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/web-auth | Is password auth on (shows the Log out block) | legacy-frontend | unimplemented | [SettingsPanel.tsx:96](../../packages/ui/src/components/SettingsPanel.tsx#L96) |
| DELETE | /api/web-auth | Log out, then `/login` | legacy-frontend | unimplemented | [SettingsPanel.tsx:106](../../packages/ui/src/components/SettingsPanel.tsx#L106) |
| GET | /api/tools/settings | Read the PowerShell tool switch | legacy-frontend | unimplemented | [SettingsPanel.tsx:118](../../packages/ui/src/components/SettingsPanel.tsx#L118) |
| PUT | /api/tools/settings | Toggle PowerShell, then session reload | legacy-frontend | unimplemented | [SettingsPanel.tsx:134](../../packages/ui/src/components/SettingsPanel.tsx#L134) |
| GET | /api/push/config | VAPID public key for web push | legacy-frontend | retired with the prototype (ticket 14) | `lib/push-client.ts` (deleted) |
| POST | /api/push/subscribe | Register the push subscription | legacy-frontend | retired with the prototype (ticket 14) | `lib/push-client.ts` (deleted) |
| POST | /api/agent/{id} `{type:"reload"}` | Reload conversation resources after the PowerShell switch | web-adapter → backend | **wired** | [SettingsPanel.tsx:143](../../packages/ui/src/components/SettingsPanel.tsx#L143), adapters/durable-api.ts:94 (`../../apps/web/adapters/durable-api.ts#L94`) |

Browser-local preferences in this section (no HTTP, browser-owned):

| Setting | Key | Evidence |
| --- | --- | --- |
| Theme | `pi-theme` | [hooks/useTheme.ts:33,66](../../packages/ui/src/hooks/useTheme.ts#L33) |
| Chat content width | `pi-chat-content-width` | [hooks/useChatAppearance.ts:12](../../packages/ui/src/hooks/useChatAppearance.ts#L12) |
| Chat content font size | `pi-chat-content-font-size` | [hooks/useChatAppearance.ts:8](../../packages/ui/src/hooks/useChatAppearance.ts#L8) |
| UI / mono font family and weight | `pi-ui-font-*`, `pi-mono-font-*` | [lib/font-preferences.ts](../../packages/ui/src/lib/font-preferences.ts), [hooks/useFontPreferences.ts:88-89](../../packages/ui/src/hooks/useFontPreferences.ts#L88) |
| Thinking expanded by default | `pi-thinking-expanded` | [lib/thinking-expansion-preference.ts:9,13](../../packages/ui/src/lib/thinking-expansion-preference.ts#L9) |
| Enter-to-send mode | `pi-enter-send-mode` | [hooks/useEnterSendMode.ts:5](../../packages/ui/src/hooks/useEnterSendMode.ts#L5) |
| Quote selection | `pi-quote-selection-enabled` | [AppShell.tsx:119,127](../../packages/ui/src/components/AppShell.tsx#L119) |
| Language | `pi-locale` | [hooks/useI18n.tsx:29,63](../../packages/ui/src/hooks/useI18n.tsx#L29) |
| Last settings section / selection | `pi-web:settings-navigation` | [lib/settings-navigation.ts:16](../../packages/ui/src/lib/settings-navigation.ts#L16) |

`FontSettings.tsx` is **no-API** (renders the font rows only). No endpoint is missing for these local appearance preferences. General settings network actions above remain TODO.

## Settings › Models — `ModelsConfig.tsx` + `EnabledModelsSection.tsx` + `ProviderUsageSummary.tsx` + `OAuthPastePanel.tsx` + `ModelSelector.tsx` + `lib/models-cache.ts`

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/auth/providers | List OAuth / API-key providers | legacy-frontend | unimplemented | [ModelsConfig.tsx:1872](../../packages/ui/src/components/ModelsConfig.tsx#L1872) |
| GET | /api/models-config | Read the backend's `models.json` (panel load) | legacy-frontend | implemented (ticket 12) | [ModelsConfig.tsx:1882](../../packages/ui/src/components/ModelsConfig.tsx#L1882) |
| PUT | /api/models-config | Validate, write and apply the backend's `models.json` | legacy-frontend | implemented (ticket 12) | [ModelsConfig.tsx:2035](../../packages/ui/src/components/ModelsConfig.tsx#L2035) |
| POST | /api/models-config/discover | Discover a provider's models | legacy-frontend | unimplemented | [ModelsConfig.tsx:337](../../packages/ui/src/components/ModelsConfig.tsx#L337) |
| POST | /api/models-config/test | Test a provider/model | legacy-frontend | unimplemented | [ModelsConfig.tsx:899](../../packages/ui/src/components/ModelsConfig.tsx#L899) |
| GET | /api/models-config/catalog | Look up a model in the catalog | legacy-frontend | unimplemented | [ModelsConfig.tsx:939](../../packages/ui/src/components/ModelsConfig.tsx#L939) |
| GET (SSE) | /api/auth/login/{provider} | OAuth/API-key sign-in event stream | legacy-frontend | unimplemented | [ModelsConfig.tsx:1336](../../packages/ui/src/components/ModelsConfig.tsx#L1336) |
| POST | /api/auth/login/{provider} | Submit code / selection mid-login | legacy-frontend | unimplemented | [ModelsConfig.tsx:1392](../../packages/ui/src/components/ModelsConfig.tsx#L1392), [:1412](../../packages/ui/src/components/ModelsConfig.tsx#L1412) |
| POST | /api/auth/logout/{provider} | Sign out of a provider | legacy-frontend | unimplemented | [ModelsConfig.tsx:1383](../../packages/ui/src/components/ModelsConfig.tsx#L1383) |
| POST | /api/auth/api-key/{provider} | Store an API key | legacy-frontend | unimplemented | [ModelsConfig.tsx:1584](../../packages/ui/src/components/ModelsConfig.tsx#L1584) |
| DELETE | /api/auth/api-key/{provider} | Remove an API key | legacy-frontend | unimplemented | [ModelsConfig.tsx:1609](../../packages/ui/src/components/ModelsConfig.tsx#L1609) |
| POST | /api/provider-usage/query | Query provider usage/quota | legacy-frontend | unimplemented | [ProviderUsageSummary.tsx:66](../../packages/ui/src/components/ProviderUsageSummary.tsx#L66) |
| GET | /api/models/enabled?cwd= | Read the enabled-models scope | legacy-frontend | unimplemented | [EnabledModelsSection.tsx:91](../../packages/ui/src/components/EnabledModelsSection.tsx#L91) |
| PUT | /api/models/enabled | Toggle a model/provider on | legacy-frontend | unimplemented | [EnabledModelsSection.tsx:120](../../packages/ui/src/components/EnabledModelsSection.tsx#L120) |
| POST | /api/models/refresh | Refresh the model catalog | legacy-frontend | unimplemented | [EnabledModelsSection.tsx:337](../../packages/ui/src/components/EnabledModelsSection.tsx#L337) |
| GET | /api/models?cwd= | Model list (panel + chat) | backend | **wired, `cwd` ignored** | [AgentsConfig.tsx:271](../../packages/ui/src/components/AgentsConfig.tsx#L271), [useAgentSession.ts:2006](../../packages/ui/src/hooks/useAgentSession.ts#L2006), [server.ts:323](../../apps/server/src/server.ts#L323) |
| PUT | /api/models/default | Save the default model / thinking level | legacy-frontend | unimplemented (not reachable from SettingsPanel) | [useAgentSession.ts:2079](../../packages/ui/src/hooks/useAgentSession.ts#L2079) |

Notes:

- `GET /api/models` is the only wired models endpoint, and it **ignores the `cwd` query** — the trust-scoped list
  `AgentsConfig.tsx:259` expects is not honoured; the backend returns the full registry.
- `lib/models-cache.ts` issues no request itself; it caches the `GET /api/models` payload (models-cache.ts (`../../apps/web/lib/models-cache.ts`)).
- `PUT /api/models/default` is called from the chat toolbar's default-star flow, not from any Settings panel; listed here because it belongs to model management.
- `ProviderUsageSummary` also caches its last report in `localStorage` under `pi-web:provider-usage:<id>` (browser-local, best-effort).
- `OAuthPastePanel.tsx` and `ModelSelector.tsx` are **no-API**; they render and raise callbacks only.

## Settings › Skills — `SkillsConfig.tsx`

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/skills?cwd= | Chat slash-palette dormancy map | legacy-frontend | unimplemented | [ChatInput.tsx:1576](../../packages/ui/src/components/ChatInput.tsx#L1576) — the last caller; the panel reads `/api/skill-market/inventory`. Failures degrade to "all active". Still a TODO. |
| GET | /api/skill-market/search?q= | Search skills.sh and the harness library | web-adapter → backend | **wired** | [SkillsConfig.tsx:363](../../packages/ui/src/components/SkillsConfig.tsx#L363); the retired `POST /api/skills/search` row is gone with its caller (ticket 14). |
| POST | /api/skill-market/install | Install a bundle into an execution scope | web-adapter → backend | **wired** | [SkillsConfig.tsx:407](../../packages/ui/src/components/SkillsConfig.tsx#L407). |
| GET | /api/skill-market/check?… | Ask whether a GitHub-sourced skill moved | web-adapter → backend | **wired** | [SkillsConfig.tsx:871](../../packages/ui/src/components/SkillsConfig.tsx#L871) — user-pressed only. |
| POST | /api/skill-market/update | Replace an installed skill (backup, 409) | web-adapter → backend | **wired** | [SkillsConfig.tsx:766](../../packages/ui/src/components/SkillsConfig.tsx#L766). |
| PATCH | /api/skills | Toggle `disable-model-invocation`, single or bulk | web-adapter → `PATCH /api/skill-market/skills` | **wired** | durable-api.ts:239 (`../../apps/web/adapters/durable-api.ts#L239`) reduces each `SKILL.md` path to its directory and forwards; written on the execution host. |
| POST | /api/agent/{id} `{type:"reload"}` | Reload after a skill change | web-adapter → backend | **wired** | [useAgentSession.ts:2174](../../packages/ui/src/hooks/useAgentSession.ts#L2174) |
| GET | /api/skill-market/inventory?workspaceId= | One execution host's installed skills | web-adapter → backend | **wired** | [SkillsConfig.tsx:683](../../packages/ui/src/components/SkillsConfig.tsx#L683). The dormant external lookup retired with `lib/skill-updates.ts` (ticket 14); the skills.sh catalog is queried server-side through `/api/skill-market/search`. |

## Settings › Market — retired (ticket 14)

The standalone Market section and `SkillMarketPanel.tsx` are gone; nothing in the shell, the navigation or the
Settings dialog refers to them. The routes they used are **kept and still served** — the built-in Skills panel is now
their caller, which is why this is a map of the current surface rather than a deletion list.

| Method | Path | Purpose | Status | Calling surface today |
| --- | --- | --- | --- | --- |
| GET | /api/skill-market/skills | List curated sources and stored bundles | **wired** | built-in Skills › Add pane (harness library source) |
| GET | /api/skill-market/search?q= | Search skills.sh, pinned to a commit | **wired** | built-in Skills › Add pane (skills.sh source) |
| GET | /api/skill-market/preview?id= | Preview a skill document and its files | **wired** | built-in Skills › Add pane preview |
| GET | /api/skill-market/inventory?workspaceId= | One execution host's installed skills | **wired** | built-in Skills › sidebar + detail |
| GET | /api/skill-market/check?… | Ask whether a GitHub-sourced skill moved | **wired** | built-in Skills › "Check for updates" |
| PATCH | /api/skill-market/skills | Toggle `disable-model-invocation` | **wired** | built-in Skills › switch (single and group) |
| POST | /api/skill-market/install | Install a bundle into a scope | **wired** | built-in Skills › Add/Install |
| POST | /api/skill-market/update | Replace an installed skill (backup, 409) | **wired** | built-in Skills › detail |
| GET | /api/skill-market/installed | Installed status for one skill/scope | **wired** | API/tests (`split-resources-smoke.ts`); no UI caller |
| GET | /api/skill-market/bundles | List names / versions / retrieve one | **wired** | API only — the publish/version UI retired with the panel |
| POST | /api/skill-market/bundles | Publish a bundle version | **wired** | API only — see the ticket 14 note below |

> Ticket 14 note: after retirement the publish/version route has no UI caller. It, its stored bundles and the
> installer are kept as instructed; a publishing surface would be new work.

## Settings › Agents — `AgentsConfig.tsx`

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/subagents/profiles?cwd= | List subagent profiles | legacy-frontend | unimplemented | [AgentsConfig.tsx:201](../../packages/ui/src/components/AgentsConfig.tsx#L201) |
| GET | /api/subagents/settings | Read built-in toggle + max concurrency | legacy-frontend | unimplemented | [AgentsConfig.tsx:235](../../packages/ui/src/components/AgentsConfig.tsx#L235) |
| PUT | /api/subagents/profiles | Create a profile | legacy-frontend | unimplemented | [AgentsConfig.tsx:324](../../packages/ui/src/components/AgentsConfig.tsx#L324) |
| DELETE | /api/subagents/profiles | Delete a profile | legacy-frontend | unimplemented | [AgentsConfig.tsx:347](../../packages/ui/src/components/AgentsConfig.tsx#L347) |
| PATCH | /api/subagents/profiles | Edit a profile | legacy-frontend | unimplemented | [AgentsConfig.tsx:399](../../packages/ui/src/components/AgentsConfig.tsx#L399) |
| PUT | /api/subagents/settings | Toggle built-in subagents | legacy-frontend | unimplemented | [AgentsConfig.tsx:420](../../packages/ui/src/components/AgentsConfig.tsx#L420) |
| PUT | /api/subagents/settings | Set max concurrency | legacy-frontend | unimplemented | [AgentsConfig.tsx:442](../../packages/ui/src/components/AgentsConfig.tsx#L442) |
| GET | /api/models?cwd= | Model list for the profile editor | backend | **wired, `cwd` ignored** | [AgentsConfig.tsx:271](../../packages/ui/src/components/AgentsConfig.tsx#L271) |
| POST | /api/agent/{id} `{type:"reload"}` | Reload after a subagent change | web-adapter → backend | **wired** | [AgentsConfig.tsx:460](../../packages/ui/src/components/AgentsConfig.tsx#L460) |

## Settings › Plugins — `PluginsConfig.tsx` (retired)

The Pi package-manager panel and its `/api/plugins` routes were the copied Pi package surface, not durable
extensions. The capability-integration work removed the panel and its update-check helper
(`apps/web/lib/plugin-updates.ts`) with the package manager they drove; the durable-extension surface that replaced
them is Settings › Extensions. The rows below are the historical audit, with the panel they named now absent.

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/plugins?cwd= | List packages + standalone extensions | legacy-frontend | removed with the panel | `PluginsConfig.tsx` (deleted) |
| POST | /api/plugins/check | Check for plugin updates | legacy-frontend | removed with the panel | `PluginsConfig.tsx` (deleted) |
| POST | /api/plugins `{action:"update"}` | Update all packages | legacy-frontend | removed with the panel | `PluginsConfig.tsx` (deleted) |
| POST | /api/plugins `{action}` | Install / enable / disable / remove one | legacy-frontend | removed with the panel | `PluginsConfig.tsx` (deleted) |
| POST | /api/plugins (bulk) | Enable/disable many in a scope | legacy-frontend | removed with the panel | `PluginsConfig.tsx` (deleted) |
| POST | /api/agent/{id} `{type:"reload"}` | Reload after a plugin change | web-adapter → backend | removed with the panel; the route itself is connected and used elsewhere | `PluginsConfig.tsx` (deleted) |

## Settings › MCP — `McpConfig.tsx` + `mcp-config-helpers.ts` + `mcp-sign-in-helpers.ts` + `McpAddServer.tsx` + `McpSignIn.tsx` + `ProjectTrustDialog.tsx`

| Method | Path | Purpose | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GET | /api/mcp?cwd= | Read `.pi/mcp.json` files + status overview | legacy-frontend | unimplemented | [mcp-config-helpers.ts:832](../../packages/ui/src/components/mcp-config-helpers.ts#L832) |
| POST | /api/mcp | Add / switch / remove / undo / sign out | legacy-frontend | unimplemented | [mcp-config-helpers.ts:1165](../../packages/ui/src/components/mcp-config-helpers.ts#L1165) |
| POST | /api/mcp/test | Connect one server and report tools | legacy-frontend | unimplemented | [mcp-config-helpers.ts:1437](../../packages/ui/src/components/mcp-config-helpers.ts#L1437) |
| POST | /api/mcp/sign-in | Start / join an OAuth sign-in | legacy-frontend | unimplemented | [mcp-sign-in-helpers.ts:349](../../packages/ui/src/components/mcp-sign-in-helpers.ts#L349) |
| GET | /api/mcp/sign-in/{flowId} | Poll a sign-in flow | legacy-frontend | unimplemented | [mcp-sign-in-helpers.ts:363](../../packages/ui/src/components/mcp-sign-in-helpers.ts#L363) |
| POST | /api/mcp/sign-in/{flowId} | Paste the redirected URL/code | legacy-frontend | unimplemented | [mcp-sign-in-helpers.ts:375](../../packages/ui/src/components/mcp-sign-in-helpers.ts#L375) |
| DELETE | /api/mcp/sign-in/{flowId} | Cancel a sign-in flow | legacy-frontend | unimplemented | [mcp-sign-in-helpers.ts:388](../../packages/ui/src/components/mcp-sign-in-helpers.ts#L388) |
| PUT | /api/tools/settings | Save Code-mode preference / mode / inline budget | legacy-frontend | unimplemented | [mcp-config-helpers.ts:933](../../packages/ui/src/components/mcp-config-helpers.ts#L933) |
| GET | /api/project-trust?cwd= | Read trust status + declared MCP servers | legacy-frontend | unimplemented | [AppShell.tsx:1264](../../packages/ui/src/components/AppShell.tsx#L1264), [ProjectTrustDialog.tsx:140](../../packages/ui/src/components/ProjectTrustDialog.tsx#L140) |
| POST | /api/project-trust | Trust the project folder | legacy-frontend | unimplemented | [AppShell.tsx:1284](../../packages/ui/src/components/AppShell.tsx#L1284) |

`McpAddServer.tsx` and `McpSignIn.tsx` issue no request of their own; they call the helpers above. `ProjectTrustDialog`
is opened by `AppShell`, not by `SettingsPanel`, but Settings › MCP raises it via `onOpenTrustDialog`.

## TODO grouping (review candidates)

Canonical IDs supplied by the parent; this table is the mapping from audit rows to those IDs. Nothing here is approved.

| ID | Group | Rows |
| --- | --- | --- |
| T09 | Model management | `/api/models-config` GET/PUT, `/api/models-config/{discover,test,catalog}`, `/api/models/enabled` GET/PUT, `/api/models/refresh`, `/api/models/default` PUT, `cwd` scope on `/api/models` |
| T10 | Provider credentials | `/api/auth/providers`, `/api/auth/login/{p}` GET(SSE)/POST, `/api/auth/logout/{p}`, `/api/auth/api-key/{p}` POST/DELETE |
| T11 | Usage | `/api/provider-usage/query` |
| T12 | Tools | `/api/tools/settings` GET/PUT |
| T13 | Web auth | `/api/web-auth` GET/DELETE |
| T14 | Push | `/api/push/config`, `/api/push/subscribe` |
| T15 | Agents | `/api/subagents/profiles` GET/PUT/PATCH/DELETE, `/api/subagents/settings` GET/PUT |
| T16 | Plugins | `/api/plugins` GET/POST, `/api/plugins/check` |
| T17 | MCP | `/api/mcp` GET/POST, `/api/mcp/test`, `/api/mcp/sign-in` POST, `/api/mcp/sign-in/{flowId}` GET/POST/DELETE |
| T18 | Trust | `/api/project-trust` GET/POST |
| T19 | App update (neighbor) | `/api/app-update` GET — see appendix; not reachable from SettingsPanel |

No T20 placeholder is kept: the table above is the complete inventory, and additional IDs are added only if the
inventory grows.

## Appendix — adjacent UI outside SettingsPanel (not this audit's scope)

Recorded so the boundary is explicit; these are reached from the chat shell, not the Settings dialog.

| Method | Path | Caller | Status |
| --- | --- | --- | --- |
| GET | /api/app-update | [ChatWindow.tsx:95](../../packages/ui/src/components/ChatWindow.tsx#L95) (new-session header link) | unimplemented (T19) |
| GET / POST | /api/sessions/ui-state | [useSessionUiState.ts:14](../../packages/ui/src/hooks/useSessionUiState.ts#L14) (sidebar pin/archive) | GET returns a static empty state; POST falls through to 501 |
| GET | /api/agent/running | [SessionSidebar.tsx:674](../../packages/ui/src/components/SessionSidebar.tsx#L674) | wired |
| GET | /api/agent/{id}/bash-output | [MessageView.tsx:1979](../../packages/ui/src/components/MessageView.tsx#L1979) | unimplemented |
| POST | /api/agent/{id}/lease | [useAgentSession.ts:1038](../../packages/ui/src/hooks/useAgentSession.ts#L1038) | unimplemented |
| GET | /api/sessions/search | [SessionSearch.tsx:34](../../packages/ui/src/components/SessionSearch.tsx#L34) | unimplemented (404 from snapshot) |
| POST | /api/sessions/{id}/fork | [SessionSidebar.tsx:1592](../../packages/ui/src/components/SessionSidebar.tsx#L1592) | unimplemented |
| POST | /api/sessions/{id}/auto-name | [AppShell.tsx:1028](../../packages/ui/src/components/AppShell.tsx#L1028) | unimplemented |
| GET | /api/sessions/{id}/entries/{entryId}/thinking | [MessageView.tsx:168](../../packages/ui/src/components/MessageView.tsx#L168) | unimplemented |
| GET | /api/sessions/{id}/entries/{entryId}/tool-result-image | session-reader.ts:823 (`../../apps/web/vendor/pi-web/lib/session-reader.ts#L823`) | unimplemented |
| GET/POST | /api/cwd/browse | [DirectoryPicker.tsx:69,76](../../packages/ui/src/components/DirectoryPicker.tsx#L69) | unimplemented |
| POST | /api/files/...?type=upload | [file-upload-client.ts:42](../../packages/ui/src/lib/file-upload-client.ts#L42) | 501 by design (workbench read-only subset) |
| GET/POST/DELETE | /api/terminal[...] | [TerminalPanel.tsx:118,158,210](../../packages/ui/src/components/TerminalPanel.tsx#L118) | unimplemented |
| GET | /api/home, /api/worktrees, /api/open-in-explorer | chat shell | placeholder home, empty worktrees, explorer unavailable |
| POST | /api/default-cwd, /api/cwd/validate | chat shell | placeholder cwd; validation accepts configured workspace IDs only |

Browser-local shell preferences outside SettingsPanel (for completeness): `pi-sound-enabled`, `pi-sidebar-width`,
`pi-right-panel-width` ([AppShell.tsx:264,276](../../packages/ui/src/components/AppShell.tsx#L264)).

### Not part of this audit

`apps/web/lib/agent-client.ts:35` calls `crypto.randomUUID()` unguarded for a prompt `requestId`, while
`useAgentSession.ts:232` guards the same call for insecure contexts. Source-only observation; no request, browser or
model turn was performed. Tracked separately from the Settings inventory.
