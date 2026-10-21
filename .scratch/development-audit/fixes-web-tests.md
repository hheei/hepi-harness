# Web unit test drift repair — apps/web test files

Revision measured: `1758c1fb4479e9d4637a957857246c5998619d73`. Baseline log:
`.dev/verify/2026-10-14T07-21-41-481-web-unit/web-unit.json` (271 files, 2267 tests, 2244 pass, 23 fail).
Per-file runs: `.dev/verify/audit-web-drift/logs/` (before) and `.../after/` (after the fixes here).

Command for every per-file run (from `apps/web`):

```
node --test --test-reporter=tap --test-timeout=60000 <file>
```

This work only edits existing `apps/web/**/*.test.mjs` files. No production source was changed, and the
baseline failure set is not deleted or skipped to make the suite green.

## Fixed: expectations retargeted to the delivered owner (7 files)

| File | Baseline failure | Cause | Fix |
| --- | --- | --- | --- |
| `components/SessionSidebar.file-search.test.mjs` | `ENOENT app/api/files/[...path]/route.ts` | The per-surface routes were replaced by the one catch-all `app/api/[...path]/route.ts` | Read the catch-all route; the pinned behavior (the file surface answers no search of its own) is unchanged |
| `components/SessionSidebar.project-identity.test.mjs` | `recordedProjects` regex mismatch | The registry record now also carries `defaultCwd` (default-directory routing) | Regex matches `{ name, root, defaultCwd }` |
| `components/SessionTree.test.mjs` | rendered keys missing `footer-new-project` | `buildSessionTree` now emits a "New Project" footer row (`lib/session-tree.ts:519`, already covered by `lib/session-tree.test.mjs`) | Expected key list includes `footer-new-project` |
| `hooks/useGroupDrag.test.mjs` | ghost top `109px` vs expected `46px` | `ghostTopFor` now anchors the ghost on the pointer and moves it only to keep clear of the drop line (`lib/session-tree.ts:736`, pinned by `lib/session-tree.test.mjs`) | Expects the pointer-anchored top and asserts the ghost still clears the line |
| `components/SettingsPanel.test.mjs` | `ENOENT app/login/page.tsx` | The pi-web password login page is gone; the shipped login surface is `components/DurableLogin.tsx` (server token, `app/page.tsx` gates AppShell on it) | Reads `DurableLogin.tsx`; keeps "one password field, no text/email field" and the Settings logout action. Dropped the assertions pinned to the deleted page's markup (`safeLoginDestination` call site, `.web-login-composer`); destination handling keeps its own coverage in `lib/login-destination.test.mjs`. Also repaired two never-executed assertions in this file that interpolated the section name wrongly (`\`"\${section}",\`` searched for the literal text `\${section}`) and aligned two source-shape pins to current `SettingsPanel.tsx`/`SkillsConfig.tsx` |
| `lib/gfm-autolink-email-loader.test.mjs` | `Cannot find package 'mdast-util-gfm-autolink-literal'` | The package is a dependency of `remark-gfm` and is not linked into `apps/web/node_modules` | Resolves it through `remark-gfm` (the package `lib/markdown.ts` depends on), so the loader is still checked against the installed literal |
| `lib/codemode-settings.test.mjs` (1 of 16) | `Cannot find package '@earendil-works/pi-codemode' imported from .../pi-coding-agent/dist/extensions/codemode/tool.js` | pnpm links the SDK's own dependencies beside it in the store; the symlinked path this app resolves cannot see them | Imports the tool module through its real path. The assertion (Web's default budget equals the SDK's) is unchanged and now runs |

After-fix results, all exit 0 (logs in `.dev/verify/audit-web-drift/logs/after/`):

```
components/SessionSidebar.file-search.test.mjs   # pass 4  # fail 0
components/SessionSidebar.project-identity.test.mjs  # pass 5  # fail 0
components/SessionTree.test.mjs                  # pass 30 # fail 0
components/SettingsPanel.test.mjs                # pass 18 # fail 0
hooks/useGroupDrag.test.mjs                      # pass 15 # fail 0
lib/gfm-autolink-email-loader.test.mjs           # pass 4  # fail 0
lib/codemode-settings.test.mjs                   # pass 16 # fail 0
```

## Recorded: no supported workflow to retarget to (16 files)

These stay failing. Each is either a retained upstream module that is not in the delivered Web module
graph, or a test for a route/page this app does not ship. None is skipped or deleted.

**1. Retained upstream modules whose owner file was never copied into `apps/web/lib` (8 files).**
`lib/model-runtime.ts` exists only as `apps/web/vendor/pi-web/lib/model-runtime.ts`; `apps/web/lib/mcp-test.ts:16`
and `lib/model-catalog-refresh.ts:2` import it, and the chain `mcp-config-file|mcp-config-read|builtin-extensions
-> mcp-host -> mcp-test -> model-runtime` fails at import. Reachability from `app/**` (import graph walk, see
`reach.cjs` in this directory) shows none of `lib/model-runtime.ts`, `lib/mcp-host.ts`, `lib/mcp-test.ts`,
`lib/mcp-sign-in.ts`, `lib/mcp-config-read.ts`, `lib/builtin-extensions.ts`, `lib/model-catalog-refresh.ts` is
reachable: the delivered MCP surface is `adapters/mcp-surface.ts -> adapters/mcp-host.ts` (the co-located gateway
service). No user workflow is broken by the dangling import, so no shim was invented.

- `lib/builtin-extensions.test.mjs`, `lib/mcp-config-file.test.mjs`, `lib/mcp-config-read.test.mjs`,
  `lib/mcp-host.test.mjs`, `lib/mcp-sign-in.integration.test.mjs`, `lib/mcp-sign-in.test.mjs`,
  `lib/mcp-test.test.mjs`, `lib/model-catalog-refresh.test.mjs`

**2. Retained upstream launcher tests (5 files).** `apps/web/bin/` does not exist; the tested logic
(`MIN_NODE_VERSION`, `getNextNodeArgs`, `parseLaunchOptions`, `rotatePreviewSecrets`, `wireChildProcessLifecycle`)
exists nowhere else in the repository (searched `apps/` and `packages/`), and distribution is the `packages/client` CLI.
- `lib/node-version.test.mjs`, `lib/pi-web-node-args.test.mjs`, `lib/pi-web-options.test.mjs`,
  `lib/rotate-preview-secrets.test.mjs`, `lib/process-lifecycle.test.mjs`

**3. Retained upstream auth proxy (1 file).** `lib/web-auth-proxy.test.mjs` imports `../proxy.ts`, which does not
exist. `lib/web-auth.ts` and `lib/auth-throttle.ts` are also absent from the delivered graph; Web auth is the
catch-all route's `durable-login` cookie check plus `adapters/auth.ts`.

**4. Routes this app does not ship (2 files).** Both are capability gaps already listed in the audit, not test drift:
- `lib/provider-api-key-route.test.mjs` reads `app/api/auth/api-key/[provider]/route.ts` (absent).
- `lib/model-discovery.test.mjs` (1 of 5 tests) requires `app/api/models-config/discover/route.ts` (absent).

## Production findings to hand to the owning worker (not fixed here)

1. At this worker's inspection, `components/SettingsPanel.tsx` sent the browser to `/login` on logout (`window.location.replace("/login")`)
   while no `/login` page exists, and `.web-login-composer` CSS in `app/globals.css` is now unreferenced. Reachable
   only if `GET /api/web-auth` succeeds, which the audit records as not connected, so it is latent. Owner: Settings
   worker, whose concurrent fix now clears the durable cookie and reloads `/`; the integrated browser check owns
   verification of that correction. This worker only retargeted the test.
2. `apps/web/lib/mcp-test.ts:16` and `lib/model-catalog-refresh.ts:2` import a `lib/model-runtime` that was never
   copied into `apps/web/lib`. Harmless while those modules stay unreachable; it becomes a build/typecheck failure the
   moment anything reachable imports them. Decide whether to copy the vendor file or delete the dormant modules.
3. `apps/web/lib/codemode-settings.ts` is dormant, and the installed SDK's codemode module cannot resolve
   `@earendil-works/pi-codemode` from the symlinked path. If the codemode extension is ever loaded in this process,
   it needs `@earendil-works/pi-codemode` as a declared dependency of `apps/web`.

## Limits

- `components/SettingsPanel.test.mjs` pins source shape in `SettingsPanel.tsx`, `SkillsConfig.tsx` and
  `AgentsConfig.tsx`. It passes against the tree as measured here, but the Settings worker was editing those files
  concurrently; the integrated run should re-check it.
- Counts above are per-file. The baseline `2267 tests / 2244 pass / 23 fail` is revision-scoped; the new total
  differs (for example `SettingsPanel.test.mjs` contributes 18 tests instead of the 1 its import failure counted).
  The integrated runner establishes the new actual count and failure set.
- `reach.cjs` walks static relative/`@/` imports from `app/**`; dynamic imports built from computed specifiers
  would not be seen.
