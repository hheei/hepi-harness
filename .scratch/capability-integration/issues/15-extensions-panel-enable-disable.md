# 15: Extensions panel: enable and disable installed extensions

**What to build:** The existing settings panel is wired to ticket 14: it lists exactly the installed durable
extensions, enables and disables them globally or for one conversation, bulk-toggles a selection, and offers nothing
it cannot do — no install, no update, no check, no generic editor.

**Blocked by:** 14: Durable extension inventory and selection state

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** In the browser, open the extensions panel, disable an installed extension, see it stop being offered in
a new conversation, and toggle several at once.

**Stories:** 91, 92, 95, 96, 100, 101, 102

**Seam:** browser → existing Web adapter → durable backend.

- [x] The panel lists exactly the installed extensions with their state, and no install, remove, update or check
      action is present or reachable in it.
- [x] Disabling an extension globally changes the default for new conversations and leaves existing conversations
      unchanged.
- [x] A per-conversation override is settable from the conversation's own surface and survives a reload.
- [x] Toggling several extensions at once is one action and one request.
- [x] No generic per-extension settings editor is shown; an extension that owns a settings surface links to it.
- [x] The panel's copy names durable extensions, and no Pi package or bundle wording appears anywhere in it.

**Context:** [Spec](../spec.md) decisions 43–46, 50, 51; stories 91–102. The backend half is ticket 14.

## Comments

**Implemented.** The Settings section is now Settings › Extensions, and the copied Pi package-manager panel is gone
with the package manager it drove.

- `apps/web/components/ExtensionsConfig.tsx` is the panel. It reads the installed set and the resolved global default
  from `GET /api/extensions` (ticket 14's own route, already carried by the Web adapter), and the open conversation's
  own selection from `GET /api/sessions/<id>/state`, which already carries it. Each extension's row is a status dot
  and its name; the detail pane states its status, its tools and its prompt sections, and offers one switch.
- One selection at a time, chosen by a scope switch: **New conversations** writes the backend's default with
  `POST /api/extensions`, **This conversation** writes that conversation's own selection with
  `PATCH /api/sessions/<id>/extensions`. Both send the *whole* selection, which is what the backend stores, so a
  single row and several rows at once are the same one request; the answer the backend returns is what the panel
  shows, so a refused write keeps the state it had and reports the backend's own reason. `switchedSelection()` drops a
  stored name that is no longer installed rather than sending it back to be refused.
- The group switch in the sidebar heading switches the whole installed set with the same one write, and the footer
  reports how many of how many are enabled. A startup install failure is listed in the footer as its own name and
  reason, so a broken extension is visible rather than silently absent.
- The panel offers nothing else: no install, remove, update, check, no package list and no per-extension editor — the
  framework gives an extension no configuration surface to drive one. An extension whose own surface is another
  Settings section links to it through `EXTENSION_SETTINGS_SECTION` (`workspace-resources` → Settings › Skills) and
  opens it in place; an extension the map does not name shows no link at all.
- The conversation scope is refused in visible words when no conversation is open (and while that conversation's
  selection is unread), never only as a tooltip, and the default stays usable.
- `apps/web/components/PluginsConfig.tsx`, `apps/web/lib/plugin-updates.ts` and their two unit suites are deleted,
  and the `plugins.*`, `i18n.*Plugin*` and package-manager locale keys are removed from all three locales, so no Pi
  package, plugin or bundle wording is reachable anywhere in the UI. The settings section is `extensions`, its word
  comes from `SETTINGS_SECTION_LABEL_KEYS` beside the section list, and `settingsSectionRequiresProject` now gates
  only `agents`: the installed set belongs to the backend, so the panel needs no project.

The work is merged with ticket 17's MCP surface: `impl/capability-15` is `8783901`, a merge of
`integration/ux-follow-up` (`155a002`) into this change (`0f9c367`), with one conflict in
`docs/migration-status.md` resolved by stating both tickets' browser halves in one paragraph. Everything after that
revision is documentation for this ticket; `git diff 8783901 HEAD -- apps packages scripts` is empty, so the evidence
below is the merged revision's own.

| Command | Revision | Result | Log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` | `8783901` | exit 0: `workspace-typecheck` PASS, `workspace-tests` PASS (`@hepi/server` 186/186) | `.dev/verify/2026-10-11T18-25-47-045-verify-fast/` |
| `pnpm test:web:unit` | `8783901` (clean) | exit 1: 2107 tests, 2084 pass, 23 fail — the recorded whole-Web baseline's own failure set, **0 new names, 0 names only on the baseline** | `.dev/verify/2026-10-11T18-26-39-441-web-unit/web-unit.json` |
| `node --test components/ExtensionsConfig.test.mjs components/SettingsUi.test.mjs lib/settings-navigation.test.mjs lib/i18n/registry.test.mjs` | `8783901` | exit 0, 35/35 pass | `.dev/verify/2026-10-11T18-27-20-ux15-focused/panel-units.tap` |
| `node e2e/ux-extensions-panel.mjs` (`pnpm --filter @hepi/web test:extensions-panel`) | `8783901` | exit 0, 25 checks pass | `.dev/verify/2026-10-11T18-27-20-ux15-focused/e2e.log` |
| `npx tsc --noEmit` in `apps/web` | `8783901` | exit 0 | — |

`components/SettingsPanel.test.mjs` is one of the recorded baseline failures and stays one: it reads
`app/login/page.tsx`, a file this checkout has never contained, so it fails before running any assertion at
`78678f9`, at `155a002` and here. The two extension-panel unit suites that replaced the deleted ones are green, and
the whole-Web failure name set is byte-identical to the recorded baseline.

The browser driver mounts the production panel with only its network boundary replaced and reads the requests it
actually sent: exactly the installed extensions listed, one write per change carrying the whole selection, the
conversation scope reaching that conversation's own route and not the default, a bulk toggle as one request in each
direction, the extension's own section opened, and no install/remove/update/check control or editor rendered.

## Review notes

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | `EXTENSION_SETTINGS_SECTION` in `apps/web/components/ExtensionsConfig.tsx` is a hand-written map from an extension name to the Settings section that owns its surface. | A new first-party extension that owns a settings surface elsewhere shows no link until this map names it; the panel then under-offers rather than offering something that cannot work. | `record` | A second extension gains its own settings section, or pi-durable exposes a surface an extension can declare. |
| 2 | The conversation scope is read from `GET /api/sessions/<id>/state` and written with `PATCH /api/sessions/<id>/extensions`; the panel is a Settings section, so it is opened from the conversation rather than rendered inside the transcript. | The override is settable from the conversation's own Settings surface, not from the chat header. A user who expects the toggle on the conversation row itself does not find one there. | `record` | The product asks for the per-conversation selection outside Settings. |
| 3 | A refused selection is reported in the panel's notice area and the panel keeps the state the backend last reported, so the switch returns to its previous position. | A refusal is visible with the backend's reason; the switch does not stay where the user put it, which is the honest state after a write that did not happen. | `record` | Users report the switch as "jumping back" without reading the reason. |
