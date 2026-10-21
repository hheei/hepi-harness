# 08: Retire legacy resource namespace and prove integrated regression

**What to build:**
Remove the custom `pi-resource://` URI scheme, the dedicated `read_pi_resource` tool, and legacy harness-local resource loading now that ordinary ExecutionEnv file access is proven. Run full regression suite across local, SSH, repository, and UI flows.

**Copy / Borrow from:**
- Baseline tests across `apps/server/test/`, `packages/gateway/test/`, and `apps/web/test/`.
- Upstream provenance documentation in `docs/upstream-sources.md`.

**Blocked by:**
- 03: Atomic Reload, durable recovery, and isolated notifications
- 04: SSH resources resolve target identity and real host paths
- 07: Update conflicts, confirmed overwrite, and retained backups

**Status:** complete (feature regression verified; unrelated baseline Web failures and live-SSH limits recorded). The
21-failure whole-web baseline quoted in this file was measured on `integration/execution-resources`; the later UX work
carries 23 of 2084 there, still all pre-existing — see [docs/verification.md](../../../docs/verification.md) for the
current list and how to reproduce it.

- [x] Deletes `read_pi_resource` tool and `pi-resource://` URI formatting from server and gateway.
- [x] Removes harness `agentDir` fallback from backend resource loading.
- [x] Verifies feature test suites for local and SSH execution, reload, repository, and update workflows.
      Merged-tip evidence and final review are recorded. Local execution, reload,
      repository and install/update run through real HTTP/SSE and real files; SSH runs through the controlled
      transport fixture only (no live host authorized). Counts in the merged-tip section below.
- [x] Verifies UI chat, settings, and file browsing with ordinary file paths through targeted tests.
      Merged-tip evidence and final review are recorded. No headless-browser suite
      exists; covered by the 172/172 targeted web subset, the chat 87/87 subset and the authenticated server HTTP/SSE
      cases. Whole-web run still carries 21 pre-existing baseline failures.
- [x] Preserves upstream source pins, license notices, and documentation in `docs/`.

## Comments

**2026-10-09 — removal delivered.** `apps/server/src/pi-resources.ts` (603 lines) and its 14-case test file are
deleted; `substituteArgs` and `parseCommandArgs` moved byte-for-byte, with their upstream provenance comment, into
`apps/server/src/prompt-templates.ts`, which `workspace-resources.ts` now imports. `server.ts` loses the
`resources?: PiResources` option, the merged-extension fallback, the legacy `render`+`expand` branch and the
commands de-dup filter. Pi's `enableSkillCommands` setting is preserved through
`createWorkspaceResources({ enableSkillCommands })`, so a configured `false` still hides `/skill:` commands from the
command list without making a skill unreadable — one narrow option on the unified loader, not a resurrected fallback.
The typed read-only `LegacyWorkspaceSkillsDoc` / `migrateLegacySkillsState` migration state is untouched.

`apps/server/test/gateway.test.ts`'s second case is rewritten from the `read_pi_resource` call to "a gateway
conversation adopts workspace `.agents` skills, expands the skill command and reads its files at ordinary host paths":
project `.agents/skills/deploy` with a referenced `scripts/run.sh`, the real absolute `<location>` and
`References are relative to` in the submitted text, an explicit `assert.doesNotMatch(/pi-resource:\/\//)`, and two
ordinary `read` calls outside the workspace. No harness-local agent directory exists in that fixture.

**Evidence at 152db2f + this change.** `pnpm -r typecheck` clean; `pnpm -r test` protocol 10, session 3, gateway 55,
server 67, 0 fail; `pnpm -r build` compiles. Web subsets: `components/TurnWrittenFiles.test.mjs`,
`FileExplorer.linked-directory`, `FileViewer`, `FileViewer.state`, `AppShell.file-viewer-state`, `SettingsUi`,
`AgentSessionPanel` 49/49; `lib/slash-display`, `lib/turn-written-files`, `lib/file-links`,
`components/MessageView`, `components/SessionTree` 99/99; `components/SkillMarketPanel`,
`lib/skill-market`, `lib/skill-lock`, `lib/i18n/registry` 24/24.

**Known limits (pre-existing, not introduced here).** `apps/web/components/SettingsPanel.test.mjs` fails at module top
level on `readFile("../app/login/page.tsx")`; that path was never tracked and the test predates baseline `9379754`.
The `apps/web` e2e scripts (`test:e2e`, `test:terminal`) reference a non-existent `apps/web/e2e` directory and
`apps/web` has no `test` script, so `pnpm -r test` never runs web. Running every web test file directly reproduces the
same 21 pre-existing failures at `d15364c` and at this change (lib+components 1945/1924/21 at the baseline vs
1947/1926/21 here — the two extra tests are the new resources ones); no resources-related web test fails. There is no headless-browser e2e suite; UI chat/settings/file browsing with ordinary paths is covered by the
server HTTP/SSE tests, those web subsets and the manual smoke in `apps/web/README.md`.

**Merged tip 7985dbb (2026-10-09).** The three authorized fixes merged sequentially: 818b053 (07 install defects),
5462724 (.pi roots / parity), ae460a9 (08 retirement). `requiresTrust` roots and `enableSkillCommands` survive the
workspace-resources merges. Final counts: `pnpm -r typecheck` pass; `pnpm -r test` protocol 10, session 3, gateway 57,
server 70, **0 fail**; `pnpm -r build` compiles; `packages/gateway/test/install.test.ts` 25/25 isolated reruns (the
pre-merge simultaneous-replacement flake is fixed). Web subsets run directly: resources/market/reload/lock/i18n 24/24,
file-browsing/turn-written/chat-targeted **172/172**, chat window/input/minimap 87/87. Whole web remains **not green**:
2055 tests, 2034 pass, 21 fail — the identical 21 pre-existing failures reproduce on d15364c, 152db2f and ae460a9, so
they are baseline, not a regression. Exact command, per-file failure list, controlled-SSH limitation and the in-process
local publish lock are recorded in [docs/execution-resources-validation.md](../../../docs/execution-resources-validation.md).

**Final review and completion.** `d8f3633` is merged. Typecheck passes; protocol 10, session 3, gateway 59, server 70
tests pass; the final targeted Web run passes 74/74. Spec review verified upstream project-prompt precedence and
global classification of account skills. Standards review verified source pins, licenses and legacy removal.
The user confirmed the trusted-agent model: named resource path handling is integration discipline, not a sandbox.
Workspace-internal symlink writes are accepted behavior; additional per-tool canonical write guards are outside
this effort. Future isolation belongs at the Execution Environment abstraction. Existing installation placement
and workspace confinement checks remain. Baseline Web failures and controlled-SSH-only coverage remain explicit
validation limits; completion does not claim the entire Web suite or live SSH is green.

**2026-10-10 — authorized real-model + real-browser smoke (step 1) on `6a81863`.** With the coordinator's
prompt-precedence doc fix merged, the user authorized one real DeepSeek run against the local UI. Evidence is recorded
in [docs/execution-resources-real-model-smoke.md](../../../docs/execution-resources-real-model-smoke.md) and reproduced
by `pnpm --filter @hepi/server smoke:resources` (or `node apps/server/scripts/real-model-smoke.ts`): **100/100 checks,
0 failures** with model `magpie/deepseek-v4.1-flash`, 10 real model turns, a temporary execution host (own account
home, workspace, SQLite) and headless Chromium driving the real Next UI. Every turn is settled on the conversation's
durable SSE stream (idle, higher revision, more entries, this turn's text as the last user entry) rather than a bare
idle poll, and each turn asserts its own new entries: the final assistant message stopped normally rather than
erroring or aborting, and the tool output that turn was asked for is present and successful. Covered: adoption and
command discovery, an ordinary read whose result equals the file's exact bytes with its trailing newline, the
fixture's own script run through the gateway bash tool, `/skill:` expansion with the real host location and no legacy
URI, prompt and skill edits where **before** the Reload the committed `/ship` template still expands to its adopted
text (with `$@` substituted) and **after** the Reload it expands to the edited v2, a backend restart that retained the
adopted catalog and replayed the committed **v2** prompt template while a skill body (host-live by design) already read
the disk's v3, then an explicit Reload that adopted the new skill and committed template v3, and the UI publishing a
bundle version, installing it at the workspace scope, then confirming a backup-preserving update of a locally modified
installation with exact on-disk bytes checked. The output is sanitized: every value from the operator env file is
redacted, no stack trace is printed, and a deliberately broken env file was used to confirm neither the marker secret
nor the endpoint host reached the output. Merged-tip counts at `6a81863`: `pnpm -r typecheck` clean; `pnpm -r test`
protocol 10, session 3, gateway 59, server 70, 0 fail. Not claimed: live SSH, oracle deployment, the whole Web suite,
any UI surface outside the controls that run exercised, or the model's own choice to run extra tool calls (a failing
extra call is noted, not asserted).
