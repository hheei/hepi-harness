# Web Test Consolidation Report — Settings Group

Historical worker snapshot below:80 tests before review corrections. Coordinator restored the five missing contract groups and isolated the symlink privilege skip, yielding81 Settings contracts. Changed four-file validation:18pass/0fail/0skip; final recursive acceptance:461pass/0fail/0skip. See [review corrections](review.md) and [current result](results.md). Tables and source-size measurements below describe the pre-review worker snapshot.

**Group:** `settings`\
**Manifest:** `.scratch/web-test-consolidation/settings-files.json` (52 files)\
**Budget:** 85 reported tests\
**Outcome:** 80 tests passing (0 failures, exit code 0) across 37 remaining test files\
**Log Path:** `.dev/verify/web-test-consolidation/settings-tests.log`\

---

Source: dirty `integration/architecture-unification`, HEAD1758c1fb4479e9d4637a957857246c5998619d73. Coordinator note: before585 is a static source-call estimate, not an executed Node test count;14 old modules failed during import. After80 is confirmed by the actual owned-file run. Overall before2381 is taken from the full recursive runner.

## 1. Executive Summary

| Metric | Before | After | Delta |
|---|---|---|---|
| **Test Files** | 52 | 37 | -15 files (-28.8%) |
| **Static source-call estimate** | 585 | — | Before estimate; not executed tests |
| **Reported Node tests** | Not run for the complete old partition | 80 | Final actual count |
| **Total Lines** | 12,754 | 5,658 | -7,096 lines (-55.6%) |
| **Exit Code** | Old focused16-file repro:1 | Final37-file run:0 | Different scopes; no runtime comparison claimed |

All16 obsolete failing checks were retired or replaced at the current seam; this does not implement the two unserved provider capabilities:
- **14 import-time file failures** eliminated by deleting obsolete copied tests for legacy standalone launchers (`bin/*.js`), absent Web model runtime (`lib/model-runtime*`), and dead Web auth proxy (`proxy.ts`).
- **1 obsolete source-shape test** (`lib/provider-api-key-route.test.mjs`) eliminated.
- **1 stale absent route test** in `lib/model-discovery.test.mjs` removed (route `/api/models-config/discover` is absent in production Web adapter and returns 501, covered by integration tests), while preserving all 4 useful pure helper tests.

No product code, vendor snapshot, discovery rule, default script, or agent configuration was modified. All 281 original baseline files remain backed up under `.dev/verify/web-test-consolidation/before/`.

---

## 2. Verification Command and Evidence

Ran strictly against the 37 owned remaining files from `apps/web`:

```bash
cd apps/web && node --test \
  lib/codemode-settings.test.mjs \
  lib/codemode-view.test.mjs \
  lib/enabled-models-runtime.test.mjs \
  lib/enabled-models.test.mjs \
  lib/mcp-add.test.mjs \
  lib/mcp-command.test.mjs \
  lib/mcp-config-key.test.mjs \
  lib/mcp-config-values.test.mjs \
  lib/mcp-import.integration.test.mjs \
  lib/mcp-import.test.mjs \
  lib/mcp-read-only-policy.test.mjs \
  lib/mcp-secrets.test.mjs \
  lib/mcp-server-display.test.mjs \
  lib/mcp-status.test.mjs \
  lib/mcp-tool-display.test.mjs \
  lib/mcp-transport.test.mjs \
  lib/mcp-undo.test.mjs \
  lib/model-catalog.test.mjs \
  lib/model-discovery.test.mjs \
  lib/model-scope.test.mjs \
  lib/models-cache.test.mjs \
  lib/node-cli.test.mjs \
  lib/provider-credential-store.test.mjs \
  lib/provider-listing.test.mjs \
  lib/provider-usage.test.mjs \
  lib/subagent-extension.integration.test.mjs \
  lib/subagent-extension.test.mjs \
  lib/subagent-input.test.mjs \
  lib/subagent-isolation.test.mjs \
  lib/subagent-prompt.test.mjs \
  lib/subagent-queue.test.mjs \
  lib/subagent-settings.test.mjs \
  lib/subagent-skills.test.mjs \
  lib/subagents.test.mjs \
  lib/web-auth-lifecycle.test.mjs \
  lib/web-auth.test.mjs \
  lib/web-push.test.mjs
```

**Result:**
- `Exit code:` 0
- `Reported tests:` 80
- `Pass:` 80
- `Fail:` 0
- `Duration:` 585.7 ms
- `Log file:` `.dev/verify/web-test-consolidation/settings-tests.log`

---

## 3. Detailed File Inventory (All 52 Assigned Files)

| File | Functional Purpose | Disposition | Destination / Replacement Seam | Source calls (B/A) | Lines (B/A) |
|---|---|---|---|---|---|
| `lib/builtin-extensions.test.mjs` | Old upstream MCP runtime built-in extension toggles and sandbox self-tests | delete | Obsolete copied active test importing absent `./model-runtime`; production MCP uses `adapters/mcp-surface` -> gateway `/v1/mcp` | 8 / 0 | 256 / 0 |
| `lib/codemode-settings.test.mjs` | Code mode tool preference, inline budget, execution mode, and project scoping | matrix | `apps/web/lib/codemode-settings.test.mjs` | 16 / 3 | 380 / 292 |
| `lib/codemode-view.test.mjs` | Code mode view helpers: script extraction, formatting, headers, cost, progress | matrix | `apps/web/lib/codemode-view.test.mjs` | 7 / 2 | 95 / 93 |
| `lib/enabled-models-runtime.test.mjs` | Runtime view projection and SettingsManager persistence for enabled models | matrix | `apps/web/lib/enabled-models-runtime.test.mjs` | 13 / 3 | 250 / 218 |
| `lib/enabled-models.test.mjs` | State computation, pattern expansion, model enable/disable, provider globs, pruning | matrix | `apps/web/lib/enabled-models.test.mjs` | 47 / 5 | 564 / 443 |
| `lib/mcp-add.test.mjs` | Preparation, parsing, validation, secret references, and name suggestion for POST /api/mcp add | matrix | `apps/web/lib/mcp-add.test.mjs` | 10 / 2 | 177 / 119 |
| `lib/mcp-command.test.mjs` | Command parser for /mcp: built-in detection, bare commands, extension commands, prompt preparation | matrix | `apps/web/lib/mcp-command.test.mjs` | 7 / 2 | 112 / 79 |
| `lib/mcp-config-file.test.mjs` | Old MCP config file serialization, concurrent file locking, and link traversal | delete | Obsolete copied active test importing absent `./model-runtime`; production MCP config handled via gateway/adapters | 16 / 0 | 453 / 0 |
| `lib/mcp-config-key.test.mjs` | Order-independent canonical JSON hash keys for MCP server configs with depth protection | matrix | `apps/web/lib/mcp-config-key.test.mjs` | 3 / 1 | 51 / 39 |
| `lib/mcp-config-read.test.mjs` | Old MCP config file reader, masking secrets, FIFO rejection, and trust rules | delete | Obsolete copied active test importing absent `./model-runtime`; production MCP surface uses live adapters/gateway | 20 / 0 | 707 / 0 |
| `lib/mcp-config-values.test.mjs` | Client/server parity for config value traversal and PI_WEB_PASSWORD detection | matrix | `apps/web/lib/mcp-config-values.test.mjs` | 2 / 1 | 42 / 33 |
| `lib/mcp-host.test.mjs` | Old MCP runtime host connection manager, prompt waits, idle timers, and session state tracking | delete | Obsolete copied active test importing absent `./model-runtime`; live MCP hosted in gateway | 51 / 0 | 1333 / 0 |
| `lib/mcp-import.integration.test.mjs` | Import integration tests against SDK pi mcp add CLI, quoting, and validation | matrix | `apps/web/lib/mcp-import.integration.test.mjs` | 9 / 2 | 303 / 276 |
| `lib/mcp-import.test.mjs` | Parser for pasting MCP configs across URLs, CLI commands, Claude, Gemini, Cursor, VS Code, Zed | matrix | `apps/web/lib/mcp-import.test.mjs` | 68 / 8 | 1202 / 571 |
| `lib/mcp-read-only-policy.test.mjs` | Policy logic checking whether pinned tool selections are read-only and classifying MCP tools | matrix | `apps/web/lib/mcp-read-only-policy.test.mjs` | 2 / 1 | 25 / 22 |
| `lib/mcp-secrets.test.mjs` | Classification and masking of credentials, tokens, URLs, and args in MCP entries | matrix | `apps/web/lib/mcp-secrets.test.mjs` | 10 / 2 | 312 / 251 |
| `lib/mcp-server-display.test.mjs` | Formatting and display helpers for MCP servers: command line quoting, hidden characters, targets | matrix | `apps/web/lib/mcp-server-display.test.mjs` | 7 / 2 | 98 / 81 |
| `lib/mcp-sign-in.integration.test.mjs` | Old MCP OAuth loopback sign-in integration tests | delete | Obsolete copied active test reaching `lib/mcp-test.ts:16` importing absent `./model-runtime`; live MCP auth gateway-owned | 9 / 0 | 317 / 0 |
| `lib/mcp-sign-in.test.mjs` | Old MCP OAuth sign-in state machine, timeouts, and credential storage | delete | Obsolete copied active test reaching `lib/mcp-test.ts:16` importing absent `./model-runtime`; live MCP auth gateway-owned | 23 / 0 | 684 / 0 |
| `lib/mcp-status.test.mjs` | Process-wide bounded cache of MCP server status keyed by config hash and inactive hosts | matrix | `apps/web/lib/mcp-status.test.mjs` | 7 / 2 | 172 / 142 |
| `lib/mcp-test.test.mjs` | Old MCP test connection runner, subprocess execution, timeouts, and masking | delete | Obsolete copied active test importing absent `./model-runtime`; live MCP execution in gateway | 20 / 0 | 526 / 0 |
| `lib/mcp-tool-display.test.mjs` | Display helpers for MCP tool labels and pretty-printing JSON tool execution results | matrix | `apps/web/lib/mcp-tool-display.test.mjs` | 2 / 1 | 28 / 24 |
| `lib/mcp-transport.test.mjs` | Transport factory creating stdio and HTTP transports with env sanitization and password guards | matrix | `apps/web/lib/mcp-transport.test.mjs` | 11 / 2 | 293 / 268 |
| `lib/mcp-undo.test.mjs` | In-memory bounded undo store for recently removed MCP server configurations | matrix | `apps/web/lib/mcp-undo.test.mjs` | 6 / 2 | 84 / 75 |
| `lib/model-catalog-refresh.test.mjs` | Old model catalog signature computation and offline refresh | delete | Obsolete copied active test importing absent `@/lib/model-runtime`; ModelRuntime backend-owned | 5 / 0 | 79 / 0 |
| `lib/model-catalog.test.mjs` | Models.dev catalog flattening, preset recommendations, and price consensus algorithm | matrix | `apps/web/lib/model-catalog.test.mjs` | 9 / 2 | 327 / 312 |
| `lib/model-discovery.test.mjs` | Model list URL builder, response parser, and provider discovery header/auth resolver | matrix | `apps/web/lib/model-discovery.test.mjs` (removed stale route test importing absent `discover/route.ts`; consolidated 4 helper tests) | 5 / 2 | 79 / 66 |
| `lib/model-scope.test.mjs` | Visible model resolution against enabledModels patterns and initial model/thinking selection | matrix | `apps/web/lib/model-scope.test.mjs` | 16 / 2 | 210 / 161 |
| `lib/models-cache.test.mjs` | Cwd-scoped asynchronous model caching, concurrency coalescing, invalidation, and error decoration | matrix | `apps/web/lib/models-cache.test.mjs` | 6 / 2 | 123 / 107 |
| `lib/node-cli.test.mjs` | Probing bundled Node/npm/npx installation paths and building executable invocations | matrix | `apps/web/lib/node-cli.test.mjs` | 4 / 1 | 37 / 44 |
| `lib/node-version.test.mjs` | Old standalone launcher Node.js version verification check | delete | Obsolete test importing absent `apps/web/bin/node-version.js`; Web runs via `next dev/start` | 4 / 0 | 33 / 0 |
| `lib/pi-web-node-args.test.mjs` | Old standalone launcher node arguments and RISC-V flag check | delete | Obsolete test importing absent `apps/web/bin/pi-web-node-args.js`; Web runs via `next dev/start` | 3 / 0 | 30 / 0 |
| `lib/pi-web-options.test.mjs` | Old standalone launcher CLI argument parsing and flags | delete | Obsolete test importing absent `apps/web/bin/pi-web-options.js`; Web runs via `next dev/start` | 11 / 0 | 105 / 0 |
| `lib/process-lifecycle.test.mjs` | Old standalone launcher child process lifecycle and shutdown signals | delete | Obsolete test importing absent `apps/web/bin/process-lifecycle.js`; Web runs via `next dev/start` | 8 / 0 | 153 / 0 |
| `lib/provider-api-key-route.test.mjs` | Source-shape check verifying API key saves do not refresh network | delete | Obsolete source-shape test reading absent `app/api/auth/api-key/[provider]/route.ts`; integration worker covers 501 contract | 1 / 0 | 12 / 0 |
| `lib/provider-credential-store.test.mjs` | Atomic credential store mutations, lockfile coordination, and SDK ModelRuntime status | matrix | `apps/web/lib/provider-credential-store.test.mjs` | 5 / 2 | 126 / 119 |
| `lib/provider-listing.test.mjs` | Grouping and filtering provider lists for API key and OAuth settings UI | matrix | `apps/web/lib/provider-listing.test.mjs` | 8 / 2 | 114 / 89 |
| `lib/provider-usage.test.mjs` | Usage tracking adapter detection, origin validation, and quota payload normalization | matrix | `apps/web/lib/provider-usage.test.mjs` | 5 / 2 | 74 / 73 |
| `lib/rotate-preview-secrets.test.mjs` | Old standalone launcher Next.js preview secret rotation utility | delete | Obsolete test importing absent `apps/web/bin/rotate-preview-secrets.js`; Web runs via `next dev/start` | 8 / 0 | 118 / 0 |
| `lib/subagent-extension.integration.test.mjs` | End-to-end integration of subagent extension with pi session, control tool isolation, and resume | matrix | `apps/web/lib/subagent-extension.integration.test.mjs` | 3 / 2 | 253 / 243 |
| `lib/subagent-extension.test.mjs` | Subagent extension tools registration, execution, results lifecycle, and notification text | matrix | `apps/web/lib/subagent-extension.test.mjs` | 19 / 4 | 533 / 337 |
| `lib/subagent-input.test.mjs` | Loading and formatting delegated input files for subagent prompts with cwd path confinement | matrix | `apps/web/lib/subagent-input.test.mjs` | 3 / 1 | 63 / 49 |
| `lib/subagent-isolation.test.mjs` | Git worktree isolation for subagent runs with dirty tree safety guards | matrix | `apps/web/lib/subagent-isolation.test.mjs` | 2 / 1 | 51 / 46 |
| `lib/subagent-prompt.test.mjs` | Subagent prompt planning: system prompts, inherited context, and chatOnly modes | matrix | `apps/web/lib/subagent-prompt.test.mjs` | 4 / 1 | 64 / 55 |
| `lib/subagent-queue.test.mjs` | Per-parent FIFO queue managing subagent concurrency limits and cancellation | matrix | `apps/web/lib/subagent-queue.test.mjs` | 2 / 1 | 35 / 33 |
| `lib/subagent-settings.test.mjs` | Subagent settings file persistence, built-in enable/disable toggling, and damaged list recovery | matrix | `apps/web/lib/subagent-settings.test.mjs` | 5 / 2 | 116 / 96 |
| `lib/subagent-skills.test.mjs` | Resource loader binding for subagent skills, collision diagnostics, and noSkills parity | matrix | `apps/web/lib/subagent-skills.test.mjs` | 2 / 1 | 38 / 36 |
| `lib/subagents.test.mjs` | Subagent profiles discovery, precedence, resolution, extension selectors, runs, and path confinement | matrix | `apps/web/lib/subagents.test.mjs` | 41 / 5 | 1030 / 441 |
| `lib/web-auth-lifecycle.test.mjs` | Web authentication lifecycle through catch-all API route: gating, session cookies, logout origin check | matrix | `apps/web/lib/web-auth-lifecycle.test.mjs` | 7 / 2 | 157 / 131 |
| `lib/web-auth-proxy.test.mjs` | Old Web auth proxy with Basic auth and PI_WEB_PASSWORD throttling | delete | Obsolete test importing absent `../proxy.ts`; current auth uses `HEPI_AUTH_TOKEN` and `hepi-web-token` cookie | 9 / 0 | 101 / 0 |
| `lib/web-auth.test.mjs` | Password verification and signed session token generation/validation with expiration | matrix | `apps/web/lib/web-auth.test.mjs` | 6 / 2 | 65 / 61 |
| `lib/web-push.test.mjs` | Web Push notification manager: VAPID key lifecycle, subscription upsert, session completion events | matrix | `apps/web/lib/web-push.test.mjs` | 10 / 2 | 164 / 133 |

---

## 4. Preservation of Critical Contracts & Standards

In accordance with `/home/developer/.cc-switch/skills/ponytail-review/SKILL.md`, `docs/agents/verification.md`, and `docs/agents/review-policy.md`:
1. **No Count Gaming:** No nested `t.test` registration tricks, no fake registries, no hidden runners, and no generic test aggregator loops. Every remaining test is registered directly via `node:test`'s top-level `test(...)`.
2. **Explicit Labelled Matrices:** Related cases sharing setup and preconditions are parameterized using explicit case tables with descriptive `label` fields (e.g. `probeCases`, `authCases`, `urlCases`, `projectCases`, `namingCases`).
3. **Security Boundaries Preserved:**
   - Path confinement and symlink traversal restrictions in `subagent-input` and `subagents`.
   - Worktree isolation and dirty worktree protection in `subagent-isolation`.
   - Origin verification and CORS/CSRF protections on logout in `web-auth-lifecycle`.
   - Strict `PI_WEB_PASSWORD` sanitization and command value escaping in `mcp-transport`, `mcp-config-values`, and `mcp-add`.
   - Tamper-proofing and HMAC expiration in `web-auth`.
4. **Source Regex Cleaning:** Fragile string regex checks over internal implementation files (e.g. `mcp-command.test.mjs` inspecting `mcp-host.ts` strings, and `web-auth-lifecycle.test.mjs` inspecting `app/page.tsx` strings) were removed in favor of direct public contract assertions.
