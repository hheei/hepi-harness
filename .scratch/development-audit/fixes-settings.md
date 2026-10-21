# Audit follow-up: Web logout and visible Settings capabilities (2026-10-14)

Baseline: [2026-10-14.md](2026-10-14.md), master `1758c1f`. Scope: audit priorities 1 and 2 for the Web
production files this worker owns (logout at the auth/session owner; Settings controls and pages that lead into
501). Provider OAuth/discover/test, Agents profiles and Push are *not* implemented here — they are hidden or
named as unavailable, per the parent's split.

## Web logout (audit gap "Web logout")

The durable session is this Web origin's own cookie (`hepi-web-token`), set by `POST /api/durable-login`, read by
`app/page.tsx` and enforced for every other API route. The Settings panel's logout asked for a *different*
surface: `GET /api/web-auth` fell through to the adapter's 501, so `webAuthEnabled` stayed false, the Logout
section never rendered, and `DELETE` would have been refused too. The panel also redirected to `/login`, a route
this app does not ship.

Fix at the owning seam, `apps/web/app/api/[...path]/route.ts`:

- `GET /api/web-auth` → `{ enabled: Boolean(process.env.HEPI_AUTH_TOKEN) }` — truthful for the gate that is
  actually installed, not for a capability that is not.
- `DELETE /api/web-auth` → clears `hepi-web-token` with the attributes the login set (`path: "/"`,
  `httpOnly`, `sameSite: "strict"`, `secure` when https) plus `maxAge: 0`, and answers `{ ok: true }`.
- Any other method on that path is named (405) rather than answered as an unimplemented capability.
- Both are answered **before** the session check (the gate that asks whether a login exists cannot require one, and
  clearing a cookie the caller already holds is no privilege) and **after** the origin check, which still covers the
  `DELETE`. Every other route still requires the cookie; a session read that reached the backend would leave the
  process, which the new test pins by pointing `HEPI_SERVER_URL` at a dead port.

The panel then reloads the page (`window.location.replace("/")`), where the server component re-reads the cleared
cookie and renders the login form. The upstream password/redirect flow (`app/login`, `lib/web-auth.ts`,
`lib/login-destination.ts`) belongs to the copied pi-web surface this app does not ship; the durable flow is
untouched and no second session mechanism was added.

## Settings surfaces that led into 501

One seam, `apps/web/lib/capability-availability.ts`:

- `capabilityServed(path)` asks the route the control itself calls and reads only the adapter's own answer for a
  capability it does not serve — HTTP 501 with `code: "unsupported"`. Any other answer (401/403/405/5xx) is still
  "served", so the check never grows into a second capability registry and a deployment that gains a route enables
  the control with no panel change. `useCapabilityServed` is the same answer as state (`null` until known).
- `unsupportedCapability(response, body)` is the same limit read off an answer a panel already asked for, for a
  surface (Sub-agents) that has no route of its own to probe.

Applied:

- `SettingsPanel.tsx` — the push section offers its control only once `GET /api/push/config` answers, and names
  `settings.capabilityUnavailable` otherwise. General settings otherwise unchanged.
- `ModelsConfig.tsx` — the models.json editor, model/thinking selection and the `enabledModels` switches are
  untouched. The unserved sub-surfaces are probed before they are offered and each names its own limit in place:
  provider sign-in/API keys (picker), model import (provider detail), connection test and catalog fill (model
  detail). Nothing is claimed to be implemented: they are hidden or named.
- `AgentsConfig.tsx` — profiles and their settings are one capability; a 501 from either read renders the panel's
  own `agents.unavailable` notice instead of an editor, a New action or a switch. The notice is a translated
  sentence, never the route's error text.
- `EnabledModelsSection.tsx` — the `enabledModels` setting is a route this deployment does not serve either
  (`GET/PUT /api/models/enabled`, `POST /api/models/refresh` all answer 501 `code: "unsupported"`). The controller
  now tells that answer apart from a failure of a served route: it reads as `unavailable`, not as `failure`, so the
  provider detail header renders no switch and the one note under it says
  `settings.capabilityUnavailable`; the section renders the same single sentence instead of switches, bulk actions
  and a catalog button that would all write to the route that refused. A served route keeps its switches and its own
  failure text unchanged.
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` — six new keys (one settings, one agents, four models), each in all
  three locales; `lib/i18n/registry.test.mjs` pins key parity. The `enabledModels` note reuses the existing
  `settings.capabilityUnavailable`, which is the neutral sentence for exactly this case.

Preserved: models.json edit/validate/atomic save, model and thinking selection, durable extension toggles,
MCP management (its own host surface, untouched), Skills, Extensions. **Correcting an earlier claim in this note
and in the docs wording handed to the docs worker: the `enabledModels` switches are *not* connected** — that route
is 501 too, and the panel now says so instead of offering switches.

### Exact trigger of the `enabledModels` finding

Normal manual-provider flow, with a provider defined in models.json: its detail header mounts
`EnabledModelsProviderSwitch` + `EnabledModelsProviderSwitchNote`, the controller's `GET /api/models/enabled`
answers 501 `code: "unsupported"`, so `view` stays null. The old code turned that answer into `failure` and
`findProviderView(null, …)` into no provider, and the `!provider` branch runs **before** the error span: what the
user saw was a dead **disabled switch** plus the note *"No models available from this provider yet. Save your
changes, and check that the API key works."* — advice about a save and an API key that were never the problem.
**The raw 501 text was not rendered in this flow** (the section that would render it is mounted only for
OAuth/API-key providers, which this host cannot list).

## Verification

Revision `1758c1f` + this worker's dirty Web paths; commands run from `apps/web` unless stated.

| Check | Command | Exit | Log |
| --- | --- | --- | --- |
| Web typecheck (cold, after `rm tsconfig.tsbuildinfo`) | `tsc --noEmit` | 0 | `.dev/verify/audit-followup/web-typecheck-full.log` |
| New auth lifecycle suite | `node --test lib/web-auth-lifecycle.test.mjs components/settings-capabilities.test.mjs` | 0 (14/14) | see below |
| Focused Settings/Models/Agents/adapters/i18n suites (17 files, 276 tests) | `node --test components/SettingsPanel*.test.mjs … adapters/durable-api.test.mjs adapters/mcp-surface.test.mjs` | 0 (276/276) | `.dev/verify/audit-followup/focused-web-tests.log` |

The two new suites are named as assigned: `apps/web/lib/web-auth-lifecycle.test.mjs` (drives the real catch-all
handler with the framework's `cookies()` stood in for: gated/ungated GET, foreign-origin DELETE refused with no
cookie written, logout clearing the same cookie with the login's attributes on http and https, the cleared value
failing `validWebToken`, an unauthenticated session read still 401, and 405 for another method) and
`apps/web/components/settings-capabilities.test.mjs` (the unavailable contract using real durable adapter responses, plus ordinary failures distinguished from
unserved capabilities; the parent replaced the initial source-shape assertions before the final run).

## Remaining limits

- Provider OAuth/discover/test, Agents profiles, Push and provider usage remain unserved; the UI hides or names
  them. Implementing them is separate scope; [feature research](features-research.md) records the candidate seams.
- `/api/tools/settings` 501 is a real gap but is not user-visible in this deployment: General reads it only to
  decide whether to show the Windows-only PowerShell switch (`shellSettings?.isWindows`), and the Code mode
  controls that write it live in `McpConfig`, which is already gated by its own host surface. Recorded, not patched.
- The browser check (parent's worktree) covers what the source suites cannot: the logout click ending on the login
  form and the unavailable controls being visible before any click.

## Parent integration evidence (final source)

- Production Next build in isolated local worktree: `node node_modules/next/dist/bin/next build --webpack`, exit0, `.dev/verify/audit-followup/browser-build-final.log`.
- Real browser / real backend / real gateway / controlled local completions: `HEPI_KEEP_ARTIFACTS=1 node .dev/worktrees/audit-follow-up-browser/apps/web/e2e/audit-settings-browser.mjs`, exit0, 23 checks passed; `.dev/verify/audit-followup/browser-smoke-final.log`. Saves apply to the next request, survive a backend restart, logout removes the cookie and protected APIs return401, and login still works.
- Model-visibility old build: the same driver with two visibility assertions, exit1; `.dev/verify/audit-followup/browser-smoke-visibility-red.log`. Old UI offers a disabled switch and no neutral notice. Final build: no switch, localized neutral notice; both assertions pass. The earlier raw-error check passed on the old build too and is not red-green evidence.
- Final whole Web: `pnpm test:web:unit --quiet`, revision1758c1f dirty, exit1; 273 files,2297 tests,2281 pass,16 fail; `.dev/verify/2026-10-14T08-23-27-576-web-unit/web-unit.json`. Remaining names match the recorded unsupported-upstream set, no new names in the recorded before/after runs. This is not a detached-revision comparison.
