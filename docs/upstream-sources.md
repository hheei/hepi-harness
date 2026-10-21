# Upstream Sources and Baselines

Date: 2026-10-09

This document records provenance for the durable harness effort. The source trees referenced below were inspected as clean clones under /tmp/hepi-upstream-research/; they are not application code copied into this repository. Repeating the inspection requires cloning the recorded URL, checking out the exact revision, and installing that repository's own lockfile dependencies.

## Environment

- Node: v26.5.1
- npm: 11.17.0
- pnpm: 12.4.1 on PATH (shell shim; see pi-gui note below)
- pi-gui package manager: pnpm@10.25.0 from its own packageManager field, invoked as `npx -y pnpm@10.25.0`
- Repository baseline: master, with existing workflow setup and demo changes left intact.

## Source Pins

| Project | URL | Revision | License | Version / package | Relevant entrypoints |
| --- | --- | --- | --- | --- | --- |
| pi (runtime, upgraded 2026-10-16) | https://github.com/earendil-works/pi | 4954d760504c11df9b2cbdc040346107b6a8153d | MIT, repository LICENSE | @earendil-works/pi-durable@1.3.0, chord@1.3.0, pi-ai@1.3.0 | packages/durable/src/index.ts, Harness, Conversation, storage adapters, ExecutionEnv |
| pi (initial research / coding-agent) | https://github.com/earendil-works/pi | 6fb2e7815167e6b19006fc526d1a5d0f5f998787 | MIT, repository LICENSE | @earendil-works/pi-durable@1.1.0 research baseline; @earendil-works/pi-coding-agent@1.1.0 | packages/coding-agent, original durable research |
| pi-web | https://github.com/agegr/pi-web | 76bdc57027172eb381a216d647225a6d24f23360 | MIT, repository LICENSE | @agegr/pi-web@0.10.0 | app/, components/, hooks/, lib/streaming-message.ts, components/SessionTree.tsx |
| pi-gui | https://github.com/minghinmatthewlam/pi-gui | 572c0c6de8ffd3a245c224b912bb8752ca200780 | MIT, repository LICENSE | pi-gui@1.0.1 | packages/pi-sdk-driver/src/session-supervisor.ts, workbench contracts, workspace/worktree packages |

### Coding-agent package pins

The pi repository above is also the source of the coding-agent package this project consumes. Its coding-agent
pin remains at the initial revision `6fb2e7815167e6b19006fc526d1a5d0f5f998787`; the runtime upgrade does not change it:

| Package | Version | License | Source | Used by |
| --- | --- | --- | --- | --- |
| @earendil-works/pi-coding-agent | 1.1.0 | MIT | pi repository at the pinned revision above, packages/coding-agent | apps/server uses the public `ModelRuntime` and `SettingsManager` APIs for the opt-in configuration adapter; no coding-agent session runtime. |
| @earendil-works/pi-coding-agent | 1.0.0 | MIT | same upstream, published package | apps/web (copied pi-web UI) |

License and version were read from each installed package's own package.json; the repository LICENSE covers the source tree. This project consumes the published packages and copies no coding-agent source into executable paths. It does not claim CLI, TUI, extension, package, or MCP parity: the backend uses the package for provider and runtime interfaces only (docs/pi-config.md).

One upstream file is preserved as a verbatim source snapshot, not as an imported module: `apps/server/vendor/pi-coding-agent/prompt-templates.ts` is byte-identical (md5 `4f3857e169fe5c85329b50bc2cf6ec53`) to `packages/coding-agent/src/core/prompt-templates.ts` at revision 6fb2e7815167e6b19006fc526d1a5d0f5f998787, with the pi repository `LICENSE` (MIT, Copyright (c) 2025 Mario Zechner) alongside it. The package root re-exports neither `substituteArgs` nor `parseCommandArgs`, and the `core/prompt-templates` subpath is not an export, so `apps/server/src/prompt-templates.ts` carries behavior-equivalent implementations of those two functions for `/skill:` and prompt-template expansion; the snapshot exists so the adapted behavior can be compared against upstream source. Nothing imports the snapshot at runtime and it is outside the TypeScript include list.

The initial revisions and license findings agree with the research record at docs/research/durable-harness-upstream-research.md. The runtime pin was subsequently upgraded on 2026-10-16. The upstream repositories remain authoritative for source and licenses; this project consumes published pi-durable packages rather than vendoring runtime source.

The 1.3.0 input adapter uses public `Conversation.commit`, `Tx.createSubmission` and `InboxDoc` to admit queue-only
input; its validation and item shape follow upstream `packages/durable/src/harness/submissions.ts` and `inbox.ts`
at the runtime pin. See [native input admission](chat.md#native-input-admission). Upstream handles live `pi.tool`
v1-to-v2 task migration on resume; immutable historical entries are unchanged. Native ten-minute document/context
retention defaults are retained. `EnvTarget` still omits call/task identity, so the existing execution wrapper remains
required; `subscribeCommits` remains the supported public observation API.

### Patched runtime dependency

Since 2026-10-16, `@earendil-works/pi-durable@1.3.0` is consumed through a version-pinned pnpm patch,
`patches/pi-durable-1.3.0-input-control.patch`, declared in `pnpm-workspace.yaml` (`patchedDependencies`) and hashed in
`pnpm-lock.yaml`. pnpm materializes the patched copy under `node_modules/.pnpm/@earendil-works+pi-durable@1.3.0_patch_hash=...`,
so the content-addressable store and every other checkout keep the unpatched bytes. Upstream package and license are
unchanged: `@earendil-works/pi-durable@1.3.0`, MIT, from `https://github.com/earendil-works/pi` at revision
`4954d760504c11df9b2cbdc040346107b6a8153d` — the same pin as the rest of the 1.3.0 runtime in the table above. The patch
adds the native input-control contract: `Conversation.stop/continue/control`, the `allowed`/`held` control record inside
the conversation's own `pi.inbox` (definition version 2 with a version 1 migration), the admission and boundary guards
that keep held input queued, and the scheduler seams `isIdle`, `stopConversation` and `commitWhenIdle`. The public
contract is documented in [native input admission](chat.md#native-input-admission) and evidenced in
[the ticket 01 record](../.scratch/durable-subagents/issues/01-native-input-control.md). Replace the patch with the
upstream implementation and re-run those checks as soon as upstream publishes an equivalent public contract; until then
no product code depends on a private runtime method or a monkey patch.

## Execution-side resource snapshots (2026-10-09)

Two PI-Desktop files are preserved as verbatim source snapshots, not imported modules, under
`apps/server/vendor/pi-desktop/` with the repository's LGPL-3.0 `LICENSE`, and are outside the TypeScript include list:

| File | md5 | Source |
| --- | --- | --- |
| `skill-document.ts` | `df5f712b934f0360ab64567dc2cc0861` | `github.com/vastsa/PI-Desktop` revision `ed54ce9774c41cefb5d0cdcdf922de7e6df22621` `apps/desktop/electron/main/skill-document.ts` |
| `agent-skill-scan.ts` | `972ee1068cba6d586c05b2442520189b` | same revision, `apps/desktop/electron/main/importers/agent-skill-scan.ts` |

`apps/server/src/workspace-resources.ts` adapts the first for `/skill:<name>` expansion (real host path plus a
"references are relative to" line) and uses the second only as a reference for `~/.agents/skills` and project
`.agents/skills` shapes. Discovery rules, ignore-file handling, frontmatter parsing, prompt templates, context
precedence and prompt formatting come from the installed `@earendil-works/pi-coding-agent@1.1.0` instead, with
`ignore@7.0.5` (MIT) as the same matcher upstream uses. The mapping and the behaviors deliberately not copied are
recorded in `apps/server/vendor/pi-desktop/README.md`; see docs/execution-side-skills.md for the limits.

### Sidebar UI-state rules (ticket 01, 2026-10-11)

`packages/protocol/src/sidebar-state.ts` is adapted from pi-web's `lib/session-ui-state-shared.ts` at the pin above
(MIT, Copyright (c) 2026 agegr). The pure rules — pin and archive excluding each other, the project order's placement,
chunking, snapshots and the request validation — are carried over; three things are this repository's own, because the
upstream half they belong to is a file on the Web host that ticket 01 replaces with a durable document:

- the unread marker, which upstream keeps in the browser's `localStorage` and which is now a flag of the same
  session entry, written by the same request path;
- the session id rule, which follows the durable conversation ids this runtime writes rather than the UUIDs pi writes
  (`lib/session-reader.ts` upstream);
- the document's own `version` and `revision` handling, which belongs to the backend document
  (`apps/server/src/sidebar-state.ts`) rather than to the shared rules.

### Bounded history and the deferred read blocks (perf ticket 03, 2026-10-13)

Two rules are reused from pi-web at the pin above (MIT, Copyright (c) 2026 agegr), and neither is copied as a file:

- **The window's count rule** is upstream's own (lib/session-reader.ts, sliceActiveBranch): 50 visible messages
  (user, assistant and compaction entries) with a raw-entry cap of max(200, 6 x visible). Its comment states the reason
  it exists — counting raw entries starves user messages out of the window in agent-heavy sessions — so the same numbers
  are carried into apps/server/src/history-window.ts rather than invented. The browser's render window
  (apps/web/lib/chat-lazy-load.ts, VISIBLE_PAGE_SIZE) uses the same 50, so a first load renders in one page.
- **The deferred shape and the read-block URLs** are upstream's: a tool-result image becomes an image whose source is
  the URL /api/sessions/:id/entries/:entryId/tool-result-image?blockIndex=N, an out-of-policy image is dropped with
  upstream's own notice text, and a thinking block becomes a preview with deferred: true restorable from
  .../thinking?blockIndex=N. The server now produces that shape (it owns the frame budget and must not emit a URL it
  does not serve) and the browser half was already written, so both ends speak the shape upstream defined.

The mime/byte policy those read blocks are gated on moved into `packages/protocol` as the wire policy
(MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES, toolResultImageUrl, thinkingUrl). It had been duplicated in two
Web copies — apps/web/lib/tool-result-images.ts and its vendored provenance copy — and the server needed the same
policy, which would have made three. Ticket 04 retired the executable Web copy; the vendored snapshot stays
byte-identical as provenance, imported by nothing, and `packages/protocol` is the only executable copy.

### Session search (ticket 05, 2026-10-11)

Upstream's `lib/session-search.ts` at the pin above (MIT, Copyright (c) 2026 agegr) is reused as a *contract*, not as
code: its matcher (literal, case-insensitive, offsets in the original text), its response shape
(`{ results, truncated }`, one result per session with the entry, block and an 80-character excerpt), and every bound
it carries (500 files, 30 results, a 3 s budget, 16 MiB per file, a 1 MiB line, a 200-character query) are the ones
`apps/server/src/session-search.ts` applies, and the backend suite asserts each number against the vendored file so
they cannot drift. Its own comment — "scan recent files without an index; add indexing if measured latency warrants
it" — is the decision this ticket adopts rather than revisits. What is **not** reused is the reading half: it streams
JSONL files with `createReadStream`/`createInterface`, and a durable conversation is not a file, so entries are read
through pi-durable's public paginated `Conversation.entries()` instead. The browser half
(`packages/ui/src/lib/session-search.ts`) keeps upstream's exported response shape and the file-reading matcher is
removed from it; the upstream Next route's own name and query parameter became the backend's own
`GET /api/search?q=`, which the shared client asks. The pinned upstream file lives at
`packages/gateway/vendor/pi-web/session-search.ts` — client-app ticket 17 moved it there from the retired
`apps/web/vendor/pi-web/lib/` with the same bytes — and `apps/server/test/session-search.test.ts` still reads it, so
the bounds cannot drift. No notice travels in a published artifact for this adaptation: neither the Web app nor the
backend is distributed as a package from this repository.

### Worktree operations (ticket 10, 2026-10-11)

`packages/gateway/src/worktrees.ts` is adapted from pi-web's `lib/worktree.ts` at the same pin (MIT, Copyright (c)
2026 agegr), and from the request/response contract of its `app/api/worktrees/route.ts`. Upstream's semantics are kept
as they are: the project root resolved through the repository's shared git directory, the `<repo>-worktrees/<branch>`
placement, the branch reuse and remote-tip start, the `dirty` detection over git's own message, the refusal to remove
the main worktree, the fallback to the inferred project root for a worktree that is already gone, and the omission of
prunable entries. Three things are this repository's own, because upstream's half of them belongs to a Next route on
the Web host and not to a host capability:

- the transport split, so one implementation serves a local gateway and an SSH gateway through the existing
  `SshRunner` rather than only a local one;
- the named host limit (`not_supported`) for a gateway without a worktree surface or a host without git, which
  upstream has no equivalent of;
- the "is this listed checkout still a directory" question, asked once per listing on the host itself, so the local and
  the remote path apply one rule instead of the local `existsSync` upstream uses.

The request/response contract of upstream's `app/api/worktrees/route.ts` is the wire shape of `POST /v1/worktrees`, so it is declared once in `packages/protocol/src/gateway.ts` (`WorktreeRequest`, `WorktreeListing`, `WorktreeResult`, alongside the workspace, workbench and MCP shapes of the same package) and re-exported by `packages/gateway` under the names this repository has always exported. That is a declaration, not a licence-bearing copy: no upstream source text moved.

`apps/web/lib/worktree.ts` and its vendored copy stayed byte-identical; ticket 04 retired the `lib/` copy, so the
vendored snapshot is now the only remaining Web-side copy and `packages/gateway/src/worktrees.ts` (re-exporting the
protocol declaration above) is the executable half.
No notice travels in a published artifact for this adaptation: the gateway is built from this repository and is not
distributed as a package.

Upstream's file-backed storage half (`lib/session-ui-state.ts`) is not adapted: it is replaced by the durable
document, and the local copies of both files were removed. The pinned upstream copies stayed byte-identical under
`apps/web/vendor/pi-web/lib/` as provenance until ticket 17 retired that snapshot with the rest of the Next tree; the
live rules now live in `packages/protocol/src/sidebar-state.ts`. No notice travels in a published artifact for this
adaptation: the backend images are built from this repository and are not distributed as a package, and
`packages/protocol` is not published.

### Shared browser connection lifecycle (architecture consolidation ticket 06, 2026-10-15)

`packages/session/src/agent-event-connection.ts` is the Web page's multi-subscriber connection lifecycle — one source
per conversation however many readers join it, the readiness handshake, the passive reconnect and the last-reader
release. Its history is pi-web's `lib/agent-event-connection.ts` at the pin above (MIT, Copyright (c) 2026 agegr),
copied with `bash cp` and then adapted for multiple subscribers; the pinned upstream bytes stay byte-identical under
`packages/session/vendor/pi-web/agent-event-connection.ts` beside the upstream `LICENSE`. The Web page and the
diagnostic page under `apps/server` now both consume this one module (`@hepi/session/browser`), assembled with their
own source factories — a same-origin cookie-BFF URL for the Web page, a bearer read for the diagnostic page — so the
repository holds one transport rather than adapted duplicates. No notice travels in a published artifact for this
adaptation: the backend and Web images are built from this repository and are not distributed as a package.

### MCP masking rules (ticket 16, 2026-10-11; moved to `@hepi/protocol`, architecture consolidation ticket 02)

`packages/protocol/src/mcp-secrets.ts` is a byte-identical copy of pi-web's `lib/mcp-secrets.ts` at the pin above
(MIT, Copyright (c) 2026 agegr), verified with `sha256sum` at the move (`982c17fe8ddbef7f228c46db2aabbc40a1a38dfb0dd292af28ca2b6e7cedea4d`);
`packages/gateway/vendor/pi-web/mcp-secrets.ts` is the provenance copy (client-app ticket 17 moved it there from the
retired `apps/web/vendor/pi-web/lib/` with the same bytes). It is exported as the `@hepi/protocol/mcp-secrets`
subpath and its behavior cases run in `packages/protocol/test/mcp-secrets.test.ts`; the earlier Web and gateway copies
(`apps/web/lib/mcp-secrets.ts`, `packages/gateway/src/mcp/mcp-secrets.ts`) were the same bytes and are removed. The
module is pure and imports nothing, so it is consumed by the Web process and the gateway alike: what a URL, a command,
an argument list or a field name hides is decided once, for the panel and for the host service that reports a masked
failure reason alike. `packages/gateway/src/mcp/secrets.ts` is this repository's
own walk over one entry (which values are secrets, and how a resolved value is replaced), and
`packages/gateway/vendor/pi-web/LICENSE` carries the upstream MIT text beside it.

`packages/gateway/test/fixtures/mcp/stdio-server.ts` and `oauth-server.ts` are the current controlled fixtures.
They originated as byte-identical copies (`sha256sum` verified at that move) of the retired
`apps/web/lib/__fixtures__/mcp-env-server.mjs` and `apps/web/lib/__fixtures__/mcp-oauth-server.mjs`. The 2026-10-21
test migration adds TypeScript declarations to both; current files are adaptations, with no byte-identity claim.
The pi-web `LICENSE` remains beside them. They are test fixtures, and nothing distributed depends on them.
Ticket 04 retired the Web-side originals and ticket 17 retired the `apps/web/vendor/pi-web/` snapshot.

The gateway's `stdio-server.ts` also extends upstream behavior: ticket 01 added the opt-in
`PI_WEB_FIXTURE_INVOKE_TOOLS` set and ticket 03a added the opt-in `PI_WEB_FIXTURE_LIST_TOOLS`,
`PI_WEB_FIXTURE_LIST_BULK` and `PI_WEB_FIXTURE_PAGE_CURSOR` behaviour a listing test needs (hostile server-authored
tool fields, an over-bound schema, a tool the server did not name, a server that paginates without end, and a listing
slow enough for a caller to leave mid-read). The upstream MIT `LICENSE` still sits beside it; the untouched upstream
copy it was made from went with the retired `apps/web/vendor/pi-web/` snapshot (ticket 17).

The `@earendil-works/pi-mcp` package the gateway now depends on (1.1.0, MIT, Earendil Works) is consumed as a
published package, not vendored. Its OAuth client adapts the MIT-licensed Model Context Protocol TypeScript SDK
v1.29.0 (Copyright (c) 2024 Anthropic, PBC), whose notice it ships under `LICENSES/`; because the client's code
travels inside the published `@hepi/client` bundle, that copyright line is appended to the bundle's own notice by
`packages/client/scripts/build.mjs` and asserted by `scripts/smoke-pack.mjs`. See
[packages/client/THIRD_PARTY_NOTICES.md](../packages/client/THIRD_PARTY_NOTICES.md).

## Reuse Matrix

| Area | Decision | Boundary and reason |
| --- | --- | --- |
| pi-durable runtime and lifecycle behavior | Consume unchanged first | Use public Harness, Conversation, storage, view/watch, task, and ExecutionEnv seams. Do not fork while the package supplies the needed boundary. |
| pi-durable tests and examples | Reference / adapt as regression evidence | Preserve lifecycle, recovery, submission, view/watch, SQLite, tool, and environment behavior before replacing anything. |
| pi-web chat, streaming, session navigation, tool rendering | Adapt behind a durable-session adapter | Keep presentation behavior while removing browser-owned agent loops and local runtime ownership. |
| pi-gui workbench contracts and selected components | Selectively adapt later | Reuse files, diffs, terminal, Git/worktree behavior only after gateway ownership is defined. |
| Versioned server protocol | Build locally | No upstream repository provides the required cloud multi-client protocol as a complete boundary. |
| Local/SSH gateway | Build an ExecutionEnv adapter | Credentials, reachability, filesystem, shell, and workspace confinement belong to the workstation gateway. |
| Upstream browser/session supervisors | Do not import | A second runtime would violate the single authoritative durable server decision. |
| pi-tui and Electron host applications | Defer / do not import initially | Outside the MVP boundary and not needed for the first server-owned slice. |

## Dependency-Complete Baseline (2026-10-09)

Clean clones at the pins above, installed with their own lockfiles and package managers. No upstream file was edited to make a command pass. Every command below was capped at roughly 3 minutes and completed well inside that budget. Dependency installs and the two upstream builds ran in the background and were joined before reading results.

Install commands (native lockfile / package tool per repository):

| Source | Command | Result |
| --- | --- | --- |
| pi | `cd /tmp/hepi-upstream-research/pi && npm ci --no-audit --no-fund` | exit 0 (warnings only: deprecated transitive packages, npm allow-scripts review notice) |
| pi-web | `cd /tmp/hepi-upstream-research/pi-web && npm ci --no-audit --no-fund` | exit 0 (same warning class) |
| pi-gui | `cd /tmp/hepi-upstream-research/pi-gui && npx -y pnpm@10.25.0 install --frozen-lockfile` | exit 0, 1m 22.7s |

Baseline commands and outcomes:

| Source | Command | Outcome |
| --- | --- | --- |
| pi-durable | `cd packages/chord && npm run build` | Pass, exit 0. |
| pi-durable | `cd packages/durable && npm run build` (tsc -p tsconfig.build.json) | Pass, exit 0; dist/index.js emitted. |
| pi-durable | `cd packages/ai && npm run build` | Fail, exit 2. `generate-models` succeeded (network reachable, 1567 tool-capable models fetched) but `tsc` then reported `src/types.ts(1,39): TS2307 Cannot find module '@earendil-works/pi-telemetry'`. Environment/ordering blocker in a package this baseline does not target; pi-durable resolves pi-ai and chord through vitest `source` conditions, so it does not block the durable tests below. |
| pi-durable | `npx vitest --run test/harness-lifecycle.test.ts test/harness-submissions.test.ts test/harness-view.test.ts test/harness-tools.test.ts test/harness-tools-recovery.test.ts test/env-node.test.ts test/session-forks.test.ts` | Pass, exit 0: 7 files, 147 passed, 1 skipped (148), 2.25s. Covers lifecycle, submission, view/watch, coding tools, tool recovery, node ExecutionEnv, session forks. |
| pi-web | `node --experimental-strip-types --test lib/streaming-message.test.mjs lib/session-ui-state.test.mjs lib/session-ui-state-shared.test.mjs lib/message-display.test.mjs lib/agent-event-stream.test.mjs lib/agent-event-wire.test.mjs lib/agent-event-connection.test.mjs lib/chat-scroll-position.test.mjs` | Pass, exit 0: 106 tests, 106 pass, 0 fail, 3.8s. Reducer/streaming-message and UI-state helpers. |
| pi-web | `node --experimental-strip-types --test hooks/useAgentSession.test.mjs hooks/useSessionUiState.test.mjs hooks/model-loading.test.mjs hooks/context-usage.test.mjs` | Pass, exit 0: 55 tests, 55 pass, 0 fail. |
| pi-web | `npx tsc --noEmit` | Pass, exit 0. |
| pi-web | `npm run build` (next build --webpack) | Pass, exit 0, "Compiled with warnings in 14.0s". |
| pi-gui | `pnpm test:guards` | Fail, exit 1: 114 tests, 112 pass, 2 fail. Both failures are host/environment, not source: (1) "the public Electron helper loads through Playwright and the marketing script loader" — `require("electron")` throws "Electron failed to install correctly" because npm allow-scripts blocked the electron postinstall download; (2) "Core shards cover each discovered test exactly once and default to one worker in CI" — same missing Electron binary plus a Node 26 `DEP0205 module.register()` deprecation warning leaking into the Playwright JSON assertion. |
| pi-gui | `pnpm check:architecture` | Pass, exit 0: renderer boundary (148 first-party runtime source files), contract authority, host boundary, timeline ownership. |
| pi-gui | `pnpm build:shared` | Pass, exit 0: session-driver, catalogs, extension-ui, pi-sdk-driver built. |
| pi-gui | `pnpm --filter @pi-gui/pi-sdk-driver test` | Pass, exit 0: 165 tests, 165 pass, 0 fail, 14.4s. Canonical SessionDriver/session-supervisor driver behavior. |

pi-gui pnpm note: running `pnpm test:guards` with the PATH shim failed every guard that spawns pnpm with `SyntaxError: Invalid or unexpected token`, because those guards re-exec `process.env.npm_execpath` (the shim, an ELF binary) with `node`. Rerunning the same guard file list with `npm_execpath=$PWD/node_modules/pnpm/bin/pnpm.cjs node --test <files>` produced the 112/114 result above; the two remaining failures are the Electron/Node-26 ones. This is a local toolchain quirk, not an upstream defect.

Not run (deliberately, to stay inside the time budget and avoid huge suites): the full pi-web `npm test` (hundreds of files), pi-web eslint, pi-gui `test:baseline`, `typecheck`, lint, prettier and desktop Playwright e2e, and the full pi monorepo `npm test`. The subset above covers the critical durable env/tool/lifecycle behavior, pi-web reducer/UI helpers, and pi-gui architecture/guards/driver contracts.

## Dormant pi-web Runtime Audit (the retired apps/web Next tree) — historical, 2026-10-12

**Scope note first: every path in this section names the retired tree.** Until client-app ticket 17, `apps/web` was a
copy of pi-web@76bdc570 with an added typecheck and `test:upstream` scripts, and the audit below measured that copy.
`apps/web` is now a Vite entry (`src/`, `public/`, `vite.config.ts`) over the shared workbench in `packages/ui`;
`app/`, `components/`, `hooks/`, `lib/`, `adapters/`, `next.config.ts` and `vendor/` are gone, and the pinned snapshots
that still have a live consumer sit in `packages/gateway/vendor/pi-web/` (six source files plus `LICENSE` and a
`README.md` naming each one's consumer) and `packages/session/vendor/pi-web/` (`agent-event-connection.ts` plus
`LICENSE`). Read the findings below as provenance for what was retired, and
[`apps/web/README.md`](../apps/web/README.md) plus [migration status](migration-status.md) for the current tree.

Because that copy's `tsconfig.json` include list was narrowed to `app/**/*.ts(x)`, `components/**/*.tsx`, `hooks/**/*.ts`, `adapters/**/*.ts` (upstream used `**/*.ts`), most of the copied `lib/**` sat outside typechecking and outside the Next.js production import graph.

Method (scratch script /tmp/hepi-web-dormant.mjs, not committed): resolve the static import closure from the Next.js entry roots `app/**/(route|page|layout|default|instrumentation|middleware|proxy)`. That resolves to `app/page.tsx`, `app/layout.tsx`, `app/api/[...path]/route.ts`, which matches the built `.next/server/app-paths-manifest.json` (only `/`, `/api/[...path]`, `/_not-found`, `/_global-error`). Bare package specifiers are treated as leaves.

Result: 185 of 281 non-test source files under app/components/hooks/lib/adapters/public are reachable; 96 are dormant, all but a handful under `lib/`.

**Ticket 04 retired 76 of them (12,756 lines) from executable `lib/` and `hooks/`.** At that point `apps/web/vendor/pi-web/lib/` was the only snapshot of the dormant upstream helpers and nothing under `apps/web/lib/` was dormant; ticket 17 then retired that snapshot with the rest of the Next app, moving the six files a surviving executable path still names into `packages/gateway/vendor/pi-web/`. 72 of the 76 files were byte-identical to their vendored copies, so no upstream information was lost; three (`lib/mcp-config-read.ts`, `lib/project-trust.ts`, `lib/tool-result-images.ts`) were this repository's own rewrites whose capability already lives in `packages/gateway/src/mcp/config.ts` (`readProjectTrust`/`projectTrustRefusal`) and `packages/protocol/src/index.ts` (`MAX_TOOL_RESULT_IMAGE_BYTES`/`TOOL_RESULT_IMAGE_MIMES`); one (`hooks/__fixtures__/react-hook-shim.mjs`) had no vendored copy and no importer anywhere. Eight further dormant files that only local unit tests imported were left for ticket 09 (`lib/pi-sdk-internals.ts`, `lib/request-security.ts`, `lib/agent-event-stream.ts`, `lib/session-liveness.ts`, `lib/auth-throttle.ts`, `lib/session-file-references-core.ts`, `lib/key-serializer.ts`, `lib/login-destination.ts`), so the local Web suite's file and test counts are unchanged by ticket 04.

**Ticket 09's independent slice then retired five of those eight with their local tests** — `lib/request-security.ts`, `lib/auth-throttle.ts`, `lib/login-destination.ts`, `lib/key-serializer.ts` and `lib/session-file-references-core.ts` — after confirming each had no live consumer: the MCP writer, the MCP entry request and the session-file API that imported them went with ticket 04, Web auth is `adapters/auth.ts` against `HEPI_AUTH_TOKEN` with no password-attempt surface, the live login never navigates to a caller-named destination, and live file reads are confined by `adapters/workbench.ts` rather than by a session-reference allowlist. The live mutation-origin check is `app/api/[...path]/route.ts`, covered at the route seam by `lib/web-auth-lifecycle.test.mjs`. Three were **deferred at that point**, and the final phase then retired two of them once ticket 08 had landed: `lib/agent-event-stream.ts` (the old in-process SSE writer) and `lib/session-liveness.ts` (its lease registry, imported only by it) had no caller left once the browser's one physical stream became `packages/session`'s browser StreamSource, so both went with their test, together with the translator half of `lib/agent-event-wire.ts` (`toClientAgentEvent`/`isEventIncludedInSnapshot`, which existed to shape frames for that writer). `lib/pi-sdk-internals.ts` stays, as recorded: it is the only thing that compares the live importer port against the SDK's real `!command`/`$NAME` resolution (the SDK root exports neither). Seven of the eight are therefore gone from executable code. **Ticket 09's final phase then retired the rest of the copied event surface**: the seventeen event branches the native wire never produces, the extension dialog queue and custom panel (`lib/extension-ui-queue.ts`, the inline `ExtensionDialog`/`ExtensionCustomPanel` in `ChatWindow.tsx`), the blocking-request attention notification in `lib/browser-notifications.ts`, the legacy delta assembler in `lib/streaming-message.ts` with `lib/agent-event-wire.ts`'s translation helpers, and `lib/extension-dialog-fit.ts`, `lib/extension-widgets.ts`, `lib/tool-execution-progress.ts` and `lib/ansi.ts`'s custom-panel normaliser, whose only callers were that surface. All eight are byte-identical to their vendored copies, so `apps/web/vendor/pi-web/lib/` remains the complete upstream snapshot. Per-item evidence: `.dev/verify/consolidation-09/dispositions.md`.

The audit below describes the state before that retirement; its per-file importer table is historical.

The three files named by the cleanup ticket are proven dormant by two independent checks:

1. Static closure: none of `lib/rpc-manager.ts`, `lib/model-runtime.ts`, `lib/subagent-runtime.ts` is reachable from the entry roots, and none has a non-test importer anywhere under app/components/hooks/lib/adapters/public.
2. Production traces: the distinctive exported symbols `MCP_WAIT_STOPPED_MESSAGE`, `resolveSessionShutdownDeadlineMs`, `createSubagentController`, `createModelRuntimeWithExtensions`, and `SubagentRuntimeDependencies` appear nowhere in the built `.next` output.

Importer inventory (test-only, plus dormant siblings):

| File | Non-test importers | Test importers |
| --- | --- | --- |
| lib/rpc-manager.ts | none | 15 `lib/*.test.mjs` / `*.integration.test.mjs` |
| lib/subagent-runtime.ts | lib/rpc-manager.ts (dormant) | 4 test files |
| lib/model-runtime.ts | lib/mcp-test.ts, lib/model-catalog-refresh.ts (both dormant) | 1 integration test |

All three files are byte-identical to the upstream pi-web@76bdc570 copies, so no local edits would be lost.

Audit recommendation before cleanup: move the three original files unchanged into a vendor snapshot, for example `apps/web/vendor/pi-web/runtime/` via `cp` of the current bytes plus a README recording the pi-web URL, revision 76bdc57027172eb381a216d647225a6d24f23360, MIT license and copyright, then `rm` the `lib/` originals. Moving them out of `lib/` prevents the dormant runtime from re-entering the import graph during future adapter work while keeping the source available. Their dormant test files should move with them (or be recorded as outside the verified local suite), because the current `test:upstream` glob would otherwise fail to resolve the removed modules. Subsequently parent preserved the full original pinned lib/ with bash cp under apps/web/vendor/pi-web/, verified runtime file bytes, and removed the three dormant runtime entry implementations from executable lib/. Native upstream tests run in the dependency-complete clone; local test:upstream now exercises the copied composer and message/tool rendering behavior. The high-value test pass retired the old helper inventories; archived runtime and SDK implementation tests do not run here.

## Legacy and demo removal status

What these baselines prove: the pinned upstream clones build and pass their own critical targeted suites with dependencies installed, and the three pi-web runtime files above are unimported by the production entry graph.

What they do not prove: parity between the local replacements (durable server, gateway, adapted React UI) and the upstream/demo behavior they would replace. No upstream command exercises this repository's adapters. Consequently upstream baselines alone do not prove local replacement parity. Subsequent parent regression provided live React tool output, dual-UI reconnect, SIGKILL unsafe tool recovery and real SSH filesystem evidence; the standalone faux-only demo was retired, and three proven dormant runtime entrypoints moved out of executable lib while preserving original snapshots. Paid-provider verification is separate (old demo also used faux); retain all upstream source/license snapshots.

## Local Durable Demo Baseline

The retired demo at demo/durable-harness/ was the first executable proof point. Before replacement cleanup, with its own lockfile-installed dependencies:

- npm test: 3 passed, 0 failed.
- npm run typecheck: passed.
- node --check ui/client.js && node --check ui/reducer.js: passed.
- Manual smoke test on port 8797: UI, JSON state, SSE snapshot/events, asynchronous 202 submission, and persisted assistant reply all passed.

The demo is not an upstream baseline. It is a local vertical-slice reference and remains deliberately limited to one conversation, one process, SQLite, SSE, and a deterministic faux provider.

## Reproduction and Future Updates

1. Clone each URL into a temporary directory.
2. Check out the recorded revision and verify the repository license.
3. Install dependencies using that repository's own lockfile and package manager (`npm ci` for pi and pi-web, `npx -y pnpm@10.25.0 install --frozen-lockfile` for pi-gui).
4. Rerun the commands in the baseline table, adding exact tool versions and any new environment blockers to a new dated section.
5. When running pi-gui guards, set `npm_execpath` to `<clone>/node_modules/pnpm/bin/pnpm.cjs` so the pnpm-spawning guards do not exec the shell shim with node.
6. Update the reuse matrix only when an implementation decision changes; record hard-to-reverse changes in an ADR.

## PI-Desktop market snapshots (2026-10-09)

The execution-resources Skill Repository vendors two PI-Desktop files as provenance only, not as imported modules:

| Project | URL | Revision | License | Snapshot |
| --- | --- | --- | --- | --- |
| PI-Desktop | https://github.com/vastsa/PI-Desktop | ed54ce9774c41cefb5d0cdcdf922de7e6df22621 (main) | LGPL-3.0, repository LICENSE | `apps/server/vendor/pi-desktop/skill-market-scan.ts` (md5 7b5f72f35daa23be2d77180e19627968), `apps/server/vendor/pi-desktop/SkillMarketPanel.tsx` (md5 cf0a15ce61b24af605641b1beddb7f39) |

Both snapshots are outside the TypeScript include lists and nothing imports them; each vendor directory carries the LGPL-3.0
LICENSE and a README recording the same revision. `apps/server/src/skill-repository.ts` adapts only the keyword category
table and the five-minute cache idea from the scan module; the Market panel that reimplemented the layout it illustrates
was removed in ticket 14 (the snapshot is kept as provenance; client-app ticket 17 moved it from
`apps/web/vendor/pi-desktop` to `apps/server/vendor/pi-desktop` with the same bytes when it retired the Next app). `packages/gateway/src/skill-frontmatter.ts`
adapts pi-web's `lib/skill-frontmatter.ts` under MIT and is listed in `packages/client/THIRD_PARTY_NOTICES.md`, because the
gateway (and so the published client bundle) contains it. Deliberately not borrowed: the fake-IP/TUN network policy classifier, jsDelivr document
transport, Electron IPC, built-in catalog format, pagination and install path. PI-Desktop has no repository
management equivalent here: publishing, listing, inspecting and retrieving explicit bundle versions, and the
whole-directory bundle storage behind them, are implemented natively in this repository. See
`.scratch/execution-resources/issues/05-cloud-skill-repository.md`.

## cc-switch snapshots (2026-10-09, tickets 06 and 07)

The execution-side installation capability vendors three cc-switch files as provenance only, not as imported modules,
under `apps/server/vendor/cc-switch/` with the repository's MIT `LICENSE`; they are outside the TypeScript include list
and nothing imports them.

| Project | URL | Revision | License | Snapshot (md5) |
| --- | --- | --- | --- | --- |
| cc-switch | https://github.com/farion1231/cc-switch | b4a079430ce85a604e10d97d4b7530774e00e112 (main) | MIT, repository LICENSE | `skill.rs` (9fcb2c3275f128ec1ca372cef6f2605f), `skills.ts` (27e107203cfc597fa71a6585ac3500b4), `SkillsPage.tsx` (d4774614a026db7c0847c596c5ee8b41) |

`apps/server/src/skill-install.ts` adapts the install-time content baseline idea (one sha256 per file plus one over the
directory's sorted entries) from `services/skill.rs` `compute_dir_hash`/`collect_files_for_hash`, `updateState` adapts
its update detection, and `packages/gateway/src/install.ts` adapts the scope-aware destination shape and the
move-aside-before-replace shape of `create_uninstall_backup` / `SkillBackupEntry`. Deliberately not borrowed: Rust
archive extraction and ZIP budgets, the `~/.cc-switch` SSOT directory, symlinked multi-app deployment, the
app matrix and migration tooling, and the backup list / restore / delete API with its metadata and
retention. No cc-switch code executes here. See `apps/server/vendor/cc-switch/README.md` and
docs/execution-side-installation.md.

**Update (ticket 10, UX follow-up):** the exclusion above covered `skills.sh` search, and it read that way when written.
The dual-source skill catalog later did implement a skills.sh query, and it took the response field mapping
(`source` → owner/repo, `skillId` → name) from this snapshot's `SkillsShApiResponse` typing —
`apps/server/src/skill-repository.ts` now owns that query against `https://skills.sh/api/search`. What stays excluded
is cc-switch's `invoke`-based Tauri path: this repository resolves each hit to its repository's own default-branch
commit through the injected fetch, and still executes no cc-switch code. The vendored snapshot's md5 table above is
unchanged.

Selected pi-gui file/Git helpers are now preserved under packages/gateway/vendor/pi-gui/ and adapted under packages/gateway/src/workbench/. The revision, MIT license, source mapping, verification and limits are recorded in docs/workbench.md. No upstream application runtime, Electron host or desktop session supervisor is imported.

## node-ignore matching engine, ported to Python (submit-stall, ignore parity)

`packages/gateway/src/ssh-filesystem-helper.ts` holds the remote filesystem helper, one Python 3 program kept as readable
source and embedded in the bundle at build time; it carries a port of the `node-ignore` **7.0.5** matching engine —
`Ignore`, `IgnoreRule`, `RuleManager`, the `REPLACERS` chain that compiles a pattern into a regular expression, the
trailing-wildcard handling, the rule ordering with negations and the `_t` parent-directory traversal. It is
https://github.com/kaelzhang/node-ignore at the version this repository already depends on (MIT, Copyright (c) 2013
Kael Zhang and contributors); the ported sources are the `index.js` of that release.

Why a port and not the package: the helper runs on the SSH execution host, which has Python 3 and no npm, and no
dependency may be installed there. The alternative shapes were rejected — a whitelist of pattern syntax the host could
read, with pruning switched off for anything outside it, made a common `!keep.md` or `**/generated/**` turn a valid
catalog into a failed snapshot; and the local and remote producers could then disagree about which files exist.
Deliberately not borrowed: `ignore`'s TypeScript types, its `cache`/`test`/`filter` surface, and its option flags
beyond what the walk uses.

License: the verbatim `LICENSE-MIT` of `ignore@7.0.5` is kept beside the port as
`packages/gateway/src/node-ignore.LICENSE` (md5 `df4fe86855c0c73f4a52d5e556826c48`), the port is listed in
`packages/client/THIRD_PARTY_NOTICES.md`, and the copyright line travels inside the published bundle — the build
appends it to `dist/cli.js` and `smoke:pack` requires it there. Parity between the two engines is not asserted by
inspection: `packages/gateway/test/ignore-parity.test.ts` runs both over a generated corpus and requires every
decision to agree.

## Lucide icon paths (ticket 05, response footer)

Four inline SVG glyphs in `apps/web/components/TokenUsageIcons.tsx` are copied verbatim from
[lucide-icons/lucide](https://github.com/lucide-icons/lucide) tag `1.54.0`
(commit `a04f228cd01185e09c188b7227b9600c08c565ec`): `arrow-up-from-line` (input tokens),
`arrow-down-to-line` (output tokens), `hard-drive-upload` (cache read) and `hard-drive-download`
(cache write). They are inlined rather than imported, because the footer needs four glyphs and no icon runtime
dependency was added.

Lucide's complete `LICENSE` at that tag, including its Feather-derived icon list and the Feather MIT notice, is
preserved verbatim beside them as `apps/web/components/lucide-icons.LICENSE`. None of the four is on Lucide's
Feather-derived list, so the Lucide ISC terms and the notice text they carry apply; the full file is kept either
way. Deliberately not used: `hard-drive` alone, which makes cache read and cache write indistinguishable
without a tooltip, and `database`, whose three stacked ellipses merge at the footer's 11px display size (both
rejected on the ticket's candidate comparison); also `refresh`/`database-zap`, which read as Reload or as a
different metric.


## Windowed transcript experiment (ticket 09, 2026-10-14)

`@tanstack/react-virtual` **3.14.19** (MIT) is installed into `apps/web` as a **development** dependency (the experiment is a check, not application code),
pinned exactly in `apps/web/package.json` with its own `@tanstack/virtual-core@3.19.4` (MIT). Both
versions are listed in `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, which the install added because the pinned
release is younger than the workspace's supply-chain age gate. License and version were read from the installed
package's own `package.json`. The experiment itself is `apps/web/e2e/history/window-experiment.mjs` plus
`apps/web/e2e/history/window-experiment.fixture.tsx`; it is not imported by the application, and production adoption (ticket 10)
is a separate decision recorded below.

Selected implementation: the platform's own measured-height windowing (`ResizeObserver` + spacer elements + remembered
per-turn heights), not the library. Both candidates passed every behavioural check on the same fixture, viewport
(1000x800), overscan (4) and machine, and both plateaued mounted turns at 6-7 between 200 and 2000 messages; the
platform implementation was chosen because it needs no dependency for behavior the platform already provides, and the
library's own measurements were not better (see the report). Rejected: `@tanstack/react-virtual` (equal behavior, extra
dependency and a second measurement authority), and CSS `content-visibility` alone (it improves layout and paint while
keeping every node mounted, which is not a mounted-memory solution and is recorded as a stated limitation rather than a
candidate).

## Browser document renderer - `mammoth` 1.13.0 (SSH remote workbench, ticket 05, 2026-10-19)

Not an upstream pi repository: a third-party browser library. The SSH remote workbench spec's premise that a
browser DOCX renderer already existed was false - `mammoth` was declared and imported by nothing - so ticket 05
supplied the renderer, and this record is the version and licence reading taken from the installed package rather
than retyped from prose:

- Package: `mammoth` **1.13.0**. `packages/ui` declares `"mammoth": "^1.12.0"` in **`dependencies`** - it is the package
  that imports the reader (`src/lib/docx-preview.ts`) and so the package whose bundle embeds it into every host that
  builds this workbench; `pnpm-lock.yaml` resolves that specifier to `mammoth@1.13.0`, and the installed package's own
  `package.json` states `"version": "1.13.0"` and `"license": "BSD-2-Clause"`. `apps/web` declared it as well, under
  `devDependencies`, until the App-parity pass moved the declaration to its owner and deleted the host's copy: a host
  that imports nothing has no business declaring it, and two declarations of one dependency are two things that can
  disagree.
- Copyright: **Copyright (c) 2013, Michael Williamson. All rights reserved.** - the first line of the installed
  package's `LICENSE`, which is the BSD 2-Clause ("Simplified") text. `mammoth` declares no `files` or
  `licenses` field, so the text is read from the shipped `LICENSE`, not inferred.
- Source: `https://github.com/mwilliamson/mammoth.js` (the installed package's `repository.url`).
- Consumed unchanged through the package's own `browser` field mappings (`./lib/unzip.js` ->
  `./browser/unzip.js`, `./lib/docx/files.js` -> `./browser/docx/files.js`): no fork, no patch, no bundler shim,
  no polyfill. `browser/unzip.js` accepts only `{ arrayBuffer }` and rejects any other input with "Could not
  find file in options", while `lib/unzip.js` accepts `{ path }` or `{ buffer }`; that is why the preview hands an
  `ArrayBuffer`. Only `extractRawText` is used - `convertToHtml` deliberately is not, because the document is
  untrusted (see [Workbench - the Word document preview](workbench.md#the-word-document-preview)).
- Types: the package ships exactly one declaration file, `lib/index.d.ts`, beside its `main` (`./lib/index.js`),
  and declares no `types` or `exports` field. `lib/index.d.ts` types both input shapes (`NodeJsInput` and
  `BrowserInput`) and states that `embedStyleMap` returns something with `toBuffer`, so that declaration mentions
  `Buffer` and needs `@types/node` under `skipLibCheck: false`. Nothing in this ticket imports a `mammoth` subpath.

### Where the licence travels, and where the type resolves

- **The notice is inside every artifact, and it has one owner.** `packages/ui/THIRD_PARTY_NOTICES.md` sits beside the
  manifest that declares the dependency, and `thirdPartyNoticesPlugin()`
  (`packages/ui/src/lib/third-party-notices.ts`) copies it from Vite's `closeBundle` into each host's `build.outDir`:
  measured 3,313 bytes at both `apps/web/dist/THIRD_PARTY_NOTICES.md` (served by the client ingress at
  `/THIRD_PARTY_NOTICES.md`) and `apps/app/dist/THIRD_PARTY_NOTICES.md` (embedded in the `.deb` through
  `build.frontendDist`). It has to be a file in the artifact rather than a bundle comment: esbuild keeps only
  `@license`/`@preserve` comments and `mammoth`'s browser build has neither, so the shipped chunk states no copyright
  of its own. `packages/ui/src/lib/third-party-notices.test.mjs` (7 tests, `pnpm --filter @hepi/ui test`) reads the
  installed package's own `LICENSE` and version rather than retyping them, asserts the copy lands byte-identical in a
  real output directory, asserts a build that cannot place it fails instead of shipping without it, and asserts no host
  keeps a second copy that could drift. It moved here from `apps/web/public/` with its test: the host that declares and
  bundles the reader is the package that has to licence it, and a page whose notice was a Web-only file was shipping an
  App artifact with none.
- **The declaration is a build input, and pnpm makes that literal.** `packages/gateway`'s `tsc --noEmit` reports
  `error TS2307: Cannot find module 'mammoth' or its corresponding type declarations` for a `mammoth` import, because
  pnpm gives a workspace only what it declares - which is why the gateway's own fixture,
  `packages/gateway/test/docx-fixture.ts`, writes a real zip from `node:zlib` and takes no dependency: the gateway's
  job on this path is the byte route, not the document. The same rule is what makes the owner's declaration the thing
  that matters. While `mammoth` sat in `packages/ui`'s `devDependencies`, `pnpm --filter @hepi/app build` still
  succeeded, but only because a dev install had happened to put the package where the App's bundler could reach it -
  which is no promise `pnpm install --prod` or any consumer outside this workspace keeps. Declared in `dependencies`, a
  missing reader now fails the App's own build loudly
  (`Rolldown failed to resolve import "mammoth" from packages/ui/src/lib/docx-preview.ts`), so the coupling is stated
  by the manifest instead of inherited from an accident of one checkout.
- **Both hosts' builds resolve the browser reader, measured.** `apps/app` needs no declaration of its own: its graph
  reaches the preview through `@hepi/ui/workbench` -> `components/AppShell` -> `components/FileViewer`, and
  `pnpm --filter @hepi/app build` produced `apps/app/dist/assets/lib-4L70xDUm.js` (308,121 bytes), the reader chunk
  `apps/web` produces too. `apps/app/test/docx-preview-bundle.test.mjs` is the check that says **which** mammoth got
  bundled: the App's own tsconfig with `platform: browser`, requiring `mammoth/browser/*` among the metafile inputs and
  requiring that neither `lib/unzip.js` nor `lib/docx/files.js` is, because the Node pair reaches for `Buffer` and a
  webview has none. No Rust and no `.deb` here - that half is ticket 04's desktop artifact measurement, and which file
  the browser field resolves to is entirely a bundler question.
- **Measured weight.** esbuild over `packages/ui` with `--bundle --platform=browser --format=esm`: the root entry
  alone is 694,015 bytes unminified and 322,572 minified; the chunk the shipped page produces for it is 308,121
  bytes in `apps/web/dist/assets`. It is therefore dynamic-imported and stays out of the entry chunk.

Behavioural evidence: `packages/ui/src/lib/docx-preview.test.mjs` (the bound, enforced from the header and while
the body arrives), `apps/web/e2e/workbench-files/ux-docx-preview.mjs` (15 checks in chromium: the real library's text on screen
through a cookie and a bearer connection, each reading the document exactly once, a document's own `<script>`
reaching the page as words and never executing, an over-bound document refused without a request). The refusal and
bound decisions are in [Workbench - the Word document preview](workbench.md#the-word-document-preview); the
verification runs are in
[verification](verification.md#ssh-workbench-ticket-05-the-browser-reads-a-docx-2026-10-19).
