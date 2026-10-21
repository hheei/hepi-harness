# Integration consolidation report

Completed 2026-10-15 in `/home/developer/Documents/dev/hepi-harness`, HEAD `1758c1fb4479e9d4637a957857246c5998619d73`, dirty shared working tree. This report covers the 108 original paths in `integration-files.json`, including the earlier worker's persisted edits. It is not a clean-revision baseline comparison or evidence for the entire Web suite.

## Result and verification

- Original inventory: **108 files, 625 source-call estimates, 11,539 lines**. The 625 value is the manifest's static estimate, not an original Node runner count.
- Final owned inventory: **107 files, 155 actual Node tests, 155 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**, exit **0**; 8,909 lines, **net −2,630 lines** against `.dev/verify/web-test-consolidation/before/`.
- The 155 result meets the continuation's ceiling of 155. The preferred 145 target was not reached: separate focus, trust, lifecycle, stream and routing contracts remain independently registered.
- Executed from `apps/web`: `node --test --test-reporter=tap <every existing integration-files.json path, in manifest order>`. The **exact expanded argument array**, cwd, date, SHA, dirty flag and exit code are recorded in `.dev/verify/web-test-consolidation/integration-result.json`. Raw output: `.dev/verify/web-test-consolidation/integration-tests.log`. Both artifacts refer to the final tested source on 2026-10-15 at 02:13:07 UTC.
- Per-file final counts below come from matching each direct test title to the successful `# Subtest:` records in that raw log; each title appeared exactly once. The total agrees with Node's `# tests 155` counter.
- `git diff --check -- <all 108 owned original paths>`: exit 0 against this dirty tree after the final test edits; raw output `.dev/verify/web-test-consolidation/integration-diff-check.log` (empty on success). Report validation confirmed all 108 rows against the manifest, saved originals, current line counts and actual Node subtest names, and confirmed no owned source changed after the final run. No product, discovery, package script, vendor or e2e edits were made by this continuation.
- An intermediate run exposed a fixture error introduced while constructing the tool-preset matrix: the `none` row accidentally enabled custom tools. It was corrected to preserve the original fixture. The final log supersedes that failed run.

The final coordinator owns recursive `pnpm test:web:unit`, the global **<500** acceptance check, guide updates and graph refresh. This owned run does not establish their results. No commit, deployment, service restart or graph rebuild was performed.

## Review decisions

Applied `ponytail-review` to consolidate contracts and `writing-for-agents` to make this inventory usable by the coordinator. Related scenarios use labelled assertion matrices or explicit scoped blocks. There is no generic collector, registration wrapper, nested `t.test`, hidden test or discovery change. Existing platform-specific conditions remain; the final Linux run skipped nothing.

Material seams retained include origin/Host and proxy checks; path and symlink confinement; upload byte bounds and conflict invalidation; host identity and refusal handling; lifecycle acquisition, revisions, races, settlement and resync; terminal cursor/reconnect behavior; queues and deferred entry reads; and process Stop/Timeout release with a surviving writer.

Cuts and replacements requiring particular attention:

- `adapters/text-read-block.test.mjs` was deleted after moving its large text/status cases into `adapters/durable-api.test.mjs`. No package script directly names the deleted path. The copied skills, upstream and project-routing script target paths owned by this manifest remain present.
- `adapters/durable-api.test.mjs` now calls `durableApi` for reload success/refusal, models-config GET/PUT, submission recovery record/null, skill toggle translation/refusal, paged history parameters and all three deferred entry read blocks. Image bytes/media type and large text/status pass-through are asserted. This replaces source-expression snapshots with the owned adapter seam. The two newly required unsupported POST routes (`models-config/discover`, `auth/api-key/anthropic`) explicitly assert 501 and `code: unsupported` without a backend request.
- Durable API source checks for import/export syntax, helper choice, absence of `catch`, exact type declarations and Skills panel source strings were removed. Missing-model and stream/window facts are exercised in `durable-lifecycle`; catalog/folder identity is exercised in session/project adapter tests and project helpers; toggle path parsing remains in `skill-inventory`. No claim is made here about browser click coverage for the removed Skills panel source checks.
- `lib/pi-sdk-internals.test.mjs` retains required callable exports, the package actually used by Web, process/module-copy cache identity, package-resolution refusals and project MCP trust behavior. Exact function arity/class spelling, exhaustive private prototype lists, transport option snapshots and detailed SDK config/value-helper CRUD tests were removed: those specify SDK-owned implementations. Owned MCP transport/config integration tests belong to the settings group; this report does not claim to have rerun that group's suite.
- Audit of the earlier process consolidation found that it omitted the real escaped-writer timeout case. It is restored alongside Stop in a named mode matrix, with isolated temporary directories and cleanup, without increasing the registered test count.
- Terminal fixture cleanup is registered with the Node test context, so an assertion failure also closes the stream and restores EventSource. Preference rewrites restore browser globals and subscriber cleanup in `finally` blocks.

## Every original file

Paths are relative to `apps/web`. “Matrix/merge” means scenarios remain in that same file at the imported helper or adapter seam; “keep” means the original focused contract remains. Only the deleted text-read file changes destination. Before counts are **source estimates**; after counts are **actual successful Node test records**. Line counts use saved original bytes, not `git HEAD`, so earlier dirty changes are not misrepresented as a clean baseline.

| Original file | Functional purpose and disposition/destination | Before estimate → after actual | Lines before → after |
| --- | --- | ---: | ---: |
| adapters/durable-api.test.mjs | Matrix/merge at durableApi: unavailable capabilities, deferred reads, recovery, config, reload, skill routes, paging and real oversize SSE. Source snapshots retired as described above. | 18 → 3 | 231 → 168 |
| adapters/durable-lifecycle.test.mjs | Matrix/merge HTTP/SSE payload parity, acquisition/revision races and projection folding/window resync; remains here. | 20 → 3 | 416 → 367 |
| adapters/extensions.test.mjs | Merge backend listing, global/conversation selection and refusal forwarding. | 4 → 1 | 91 → 81 |
| adapters/files-transfer.test.mjs | Merge upload bounds/preflight/conflicts/cache and binary preview/download/refusal contracts in separate tests. | 10 → 2 | 266 → 247 |
| adapters/host-cwd-ownership.test.mjs | Merge cross-host routing refusals, execution identity, retained bindings and remote worktrees. | 8 → 2 | 257 → 201 |
| adapters/mcp-surface.test.mjs | Merge host-backed config/sign-in operations and separate project trust/checkout routing; retain request/response seam. | 9 → 2 | 512 → 344 |
| adapters/project-removal.test.mjs | Merge DELETE/unlink/refusals and separately retained binding/catalog behavior. | 8 → 2 | 174 → 139 |
| adapters/recall-and-session-list.test.mjs | Merge catalog/poll versions, subagent/run metadata and no fan-out; queue recall/sidebar persistence remains separate. | 10 → 2 | 192 → 120 |
| adapters/remote-project-removal.test.mjs | Keep remote gateway project remove/unlink integration. | 1 → 1 | 202 → 202 |
| adapters/session-auto-name.test.mjs | Merge naming route and backend refusal forwarding. | 2 → 1 | 66 → 58 |
| adapters/session-delete.test.mjs | Merge deletion, refusal and catalog-version advancement. | 3 → 1 | 98 → 79 |
| adapters/session-fork.test.mjs | Merge sidebar fork/catalog relation/version and separate transcript fork command/refusal. | 6 → 2 | 156 → 123 |
| adapters/session-rename.test.mjs | Merge hepi title, rename route, refusal and missing-session behavior. | 4 → 1 | 93 → 81 |
| adapters/session-search.test.mjs | Merge bounded catalog search, refusal and no per-session fan-out. | 3 → 1 | 93 → 73 |
| adapters/stream-heartbeat.test.mjs | Matrix origin comments and no injected heartbeat for conversation/terminal streams. | 3 → 1 | 99 → 78 |
| adapters/terminal.test.mjs | Matrix header/query reconnect cursors and first attach routing. | 3 → 1 | 67 → 49 |
| adapters/text-read-block.test.mjs | Delete file; large deferred text and status forwarding moved to durable-api.test.mjs's route contract. | 1 → 0 | 34 → 0 |
| adapters/worktree-picker.test.mjs | Merge workspace lookup/no-target list behavior; create/delete/dirty refusals remain a separate operation contract. | 6 → 2 | 156 → 136 |
| lib/ansi.test.mjs | Merge escape stripping, box normalization and custom cursor-marker removal. | 3 → 1 | 34 → 24 |
| lib/app-update.test.mjs | Labelled stable-version comparison/release URL matrix. | 3 → 1 | 27 → 10 |
| lib/apply-patch.test.mjs | Merge patch input/path parsing, streamed partials, preview mapping and landed/failure results. | 8 → 1 | 137 → 113 |
| lib/atomic-file.test.mjs | Merge private atomic replacement and failed-replacement cleanup. | 2 → 1 | 37 → 34 |
| lib/auth-throttle.test.mjs | Merge backoff progression, cap/reset/expiry/success and global sharing; Retry-After matrix. | 7 → 1 | 76 → 69 |
| lib/bash-output.test.mjs | Merge temp-path acceptance, size bound and symlink refusal. | 3 → 1 | 63 → 54 |
| lib/bounded-form-data.test.mjs | Merge declared/chunked byte bounds, ordered files, early refusal and empty body. | 6 → 1 | 116 → 94 |
| lib/browser-notifications.test.mjs | Merge service-worker/page/unavailable delivery; separate visibility and request-attention deduplication. | 7 → 2 | 168 → 167 |
| lib/compaction-summary.test.mjs | Matrix summary metadata extraction versus genuine body tags. | 3 → 1 | 44 → 33 |
| lib/custom-ui-terminal.test.mjs | Merge default/explicit headless dimensions and plugin render callback. | 2 → 1 | 32 → 33 |
| lib/default-cwd.test.mjs | Merge local-calendar date and dated ~/pi-cwd path. | 2 → 1 | 24 → 22 |
| lib/default-preferences.test.mjs | Merge model/thinking defaults, unrelated keys, invalid settings and shadowing. | 5 → 1 | 95 → 86 |
| lib/deferred-provider-models.test.mjs | Merge remembered provider catalog, signed-out provider refusal and deferred lookup. | 3 → 1 | 51 → 47 |
| lib/directory-browser.test.mjs | Merge directory/symlink listing, path variants, child creation and name confinement. | 6 → 1 | 85 → 84 |
| lib/display-path.test.mjs | Matrix home abbreviation, routing display roots, relative/unknown/sibling paths. | 5 → 1 | 37 → 28 |
| lib/exact-system-prompt.test.mjs | Merge per-run updated exact prompt and unconfigured no-op. | 2 → 1 | 42 → 39 |
| lib/extension-dialog-fit.test.mjs | Labelled overflow/rounding/step matrix and stable remeasurement. | 4 → 1 | 36 → 12 |
| lib/extension-ui-queue.test.mjs | Merge ordered dialog arrival/replay/close/reconnect; separate custom render replacement. | 8 → 2 | 96 → 35 |
| lib/extension-widgets.test.mjs | Merge ordered replacement, append and removal lifecycle. | 2 → 1 | 36 → 34 |
| lib/file-access.test.mjs | Merge real symlink and parent-traversal root confinement with direct helper behavior. | 2 → 1 | 53 → 56 |
| lib/file-dirent.test.mjs | Matrix direct Dirent, stat fallback, directory and dangling symlinks. | 3 → 1 | 56 → 45 |
| lib/file-fuzzy.test.mjs | Merge quoted/spaced and line-scoped mentions; preserve direct upstream script path. | 2 → 1 | 29 → 29 |
| lib/file-links.test.mjs | Click policy and labelled href/PDF matrices; preserve traversal, URL decoding, drive/UNC behavior. | 13 → 2 | 160 → 75 |
| lib/file-paths.test.mjs | Matrix API encoding, filename/directory/join/relative behavior across drive, POSIX and UNC paths. | 5 → 1 | 52 → 33 |
| lib/file-tree-visibility.test.mjs | Merge Git tracked/ignored/untracked/nested visibility; separate literal-path, hook suppression and fallback contracts. | 13 → 2 | 195 → 165 |
| lib/file-types.test.mjs | Matrix media/document preview types and extension extraction. | 3 → 1 | 47 → 46 |
| lib/file-upload-client.test.mjs | Merge drop classification, image attachment and ordered uploaded-file mentions. | 2 → 1 | 32 → 32 |
| lib/file-upload.test.mjs | Merge name/path/duplicate validation, directory/symlink conflicts and conflict strategy parsing. | 4 → 1 | 70 → 58 |
| lib/file-viewer-state.test.mjs | Merge saved mode precedence and first-open hint fallback. | 2 → 1 | 20 → 16 |
| lib/font-preferences.test.mjs | Matrix storage bounds, weights, font list quoting and safe CSS-data behavior. | 5 → 1 | 44 → 41 |
| lib/frontmatter.test.mjs | Matrix fences, malformed/unfenced body, aliases and scalar titles. | 5 → 1 | 55 → 49 |
| lib/gfm-autolink-email-loader.test.mjs | Merge executable loader output, supported/fallback regex and changed-upstream refusal; drop redundant installed-source lookbehind scan. | 5 → 1 | 57 → 45 |
| lib/git-changes.test.mjs | Merge status parsing/renames and explorer badge classification; preserve direct script path. | 2 → 1 | 52 → 38 |
| lib/http-dispatcher.test.mjs | Keep proxy/NO_PROXY global fetch integration. | 1 → 1 | 83 → 83 |
| lib/i18n/format.test.mjs | Merge translation interpolation/fallback; separate localized relative/clock/compact boundary and invalid-input matrices. | 6 → 2 | 76 → 73 |
| lib/i18n/registry.test.mjs | Merge locale negotiation, supported package lookup and complete key/placeholder contract; preserve direct skills script path. | 3 → 1 | 55 → 51 |
| lib/image-attachments.test.mjs | Merge decoded lengths, file selection refusals and agent image type/size/count limits. | 3 → 1 | 46 → 46 |
| lib/json-response.test.mjs | Matrix gzip-disabled/invalid quality and small-response behavior. | 3 → 1 | 40 → 38 |
| lib/jsonc.test.mjs | Merge comments/commas/strings, broken JSON/BOM and compatibility with upstream stripping. | 6 → 1 | 69 → 64 |
| lib/key-serializer.test.mjs | Merge per-key ordering/rejection recovery, parallel keys and shared module-copy chains. | 2 → 1 | 43 → 42 |
| lib/linked-directory.test.mjs | Labelled real-filesystem target/annotation/approval matrices, including changed target, nested links and traversal refusal. | 9 → 1 | 188 → 98 |
| lib/login-destination.test.mjs | Matrix safe local return paths and URL-parser external-host rejection. | 3 → 1 | 32 → 27 |
| lib/markdown-list-continuation.test.mjs | Matrix list types, caret/indent/tail, empty termination, fences and selections. | 10 → 1 | 93 → 82 |
| lib/markdown.test.mjs | Merge math/code normalization matrix and separate CJK autolink AST rewriting matrix. | 29 → 2 | 302 → 180 |
| lib/message-display.test.mjs | Merge process/final/thinking/deferred display; separate provider failures and turn anchors/truncation. | 12 → 2 | 183 → 111 |
| lib/new-session-context.test.mjs | Merge composer cwd, project choices/display identity, retained exclusions, worktree fallback and context key. | 9 → 1 | 164 → 126 |
| lib/next-config-esm.test.mjs | Keep executable ESM config path resolution smoke contract. | 1 → 1 | 14 → 14 |
| lib/next-config.test.mjs | Merge workspace tracing/Turbopack roots and upload proxy buffer configuration. | 2 → 1 | 34 → 31 |
| lib/normalize.test.mjs | Merge in-flight scratch retention versus completed raw-buffer removal; preserve upstream script path. | 2 → 1 | 54 → 52 |
| lib/open-in-file-manager.test.mjs | Matrix platform commands, local/remote host detection and unsupported launch refusal. | 5 → 1 | 59 → 50 |
| lib/panel-layout.test.mjs | Labelled finite clamp, responsive default and split/overlay sizing matrices. | 4 → 1 | 56 → 11 |
| lib/patch.test.mjs | Matrix split rows, one-sided/header-like hunks, multi-file parsing and non-diff rejection. | 5 → 1 | 110 → 79 |
| lib/paths.test.mjs | Matrix native/slash equality, drive/UNC detection and API segment decoding. | 6 → 1 | 81 → 58 |
| lib/pi-sdk-internals.test.mjs | Keep adapter export/load/cache identity, project trust and wrong/missing package refusal matrices; retire SDK internals assertions detailed above. | 9 → 3 | 197 → 53 |
| lib/powershell-settings.test.mjs | Labelled platform/modifier and isolated-file rewrite matrix; preserve unrelated settings and invalid-file refusal. | 6 → 1 | 97 → 35 |
| lib/project-command-env.test.mjs | Merge environment/shell reload/tool priority; separate bounded Stop/Timeout release including real escaped writers. | 13 → 2 | 496 → 317 |
| lib/project-groups.test.mjs | Merge platform identity, display/routing roots, retained exclusion and running/unread aggregation. | 4 → 1 | 79 → 69 |
| lib/project-identity.test.mjs | Labelled Windows drive/UNC equivalence and case-sensitive inequivalence matrix. | 3 → 1 | 37 → 13 |
| lib/project-removal.test.mjs | Merge folder consequences/routes; separate backend adoption/list preservation/refusal behavior. | 7 → 2 | 91 → 90 |
| lib/project-routing.test.mjs | Merge project/default/display/retained group identity; separate declared workspace and unbound routing behavior. Preserve direct script path. | 9 → 2 | 136 → 133 |
| lib/project-tree.summary.test.mjs | Keep distinct payload-free navigation summary and deep iterative serialization budget contracts. | 2 → 2 | 79 → 79 |
| lib/project-tree.test.mjs | Merge branch representative previews, payload exclusion and deep/linear/system-message compression into three contracts. | 8 → 3 | 127 → 128 |
| lib/prompt-recovery.test.mjs | Merge stable text and image-sensitive optimistic message identity. | 2 → 1 | 33 → 31 |
| lib/quoted-selection.test.mjs | Keep selected-message Markdown quote contract. | 1 → 1 | 12 → 12 |
| lib/regular-file.test.mjs | Keep whole regular-file read, missing-file result and non-regular refusal. | 1 → 1 | 51 → 51 |
| lib/request-security.test.mjs | Merge allowed requests/content types and separate hostile Host/origin/proxy/navigation rejection matrices. | 13 → 2 | 270 → 144 |
| lib/response-usage-visibility.test.mjs | Merge default, persistence, subscriber changes/unsubscribe, blocked storage and SSR with cleanup. | 4 → 1 | 73 → 32 |
| lib/search-tree.test.mjs | Matrix nesting/sort/deduplication, empty and root-file behavior. | 6 → 1 | 91 → 59 |
| lib/settings-navigation.test.mjs | Merge section requirements and global/project/no-project selection isolation plus malformed/blocked storage. | 6 → 1 | 121 → 118 |
| lib/shell-words.test.mjs | Matrix shell-compatible quoting/continuations, refusals, literal operators/variables, Windows paths and round-trip formatting. | 9 → 1 | 128 → 117 |
| lib/sidebar-actions.test.mjs | Merge idle/pinned/running/archive/transient menu actions, shortcut uniqueness and localized fork refusals. | 6 → 1 | 60 → 57 |
| lib/sidebar-prefs.test.mjs | Merge default/tab/pins/bounded group choices; separate retired-key migration and inaccessible storage. | 8 → 2 | 139 → 137 |
| lib/skill-inventory.test.mjs | Merge into six contracts: targets, catalog states, installed identity/provenance, publication/adoption, revision checks, directory toggles. | 17 → 6 | 225 → 226 |
| lib/slash-display.test.mjs | Matrix complete/incomplete skill expansion, multiline/nested closing tags and auto-name text. | 7 → 1 | 65 → 40 |
| lib/stacked-dialog.test.mjs | Merge into seven Escape ownership/IME/busy, dialog focus/cleanup, lost-focus recovery, modal focus and composer interaction contracts. | 19 → 7 | 399 → 399 |
| lib/tab-session.test.mjs | Merge session/composer/legacy/clear transitions; separate sessionStorage defaults and blocked methods/getter matrix. | 13 → 2 | 141 → 51 |
| lib/terminal-fan-in.test.mjs | Merge into shared connection, reconnect cursors, release/widget ownership and refusal/close contracts; cleanup attached to test context. | 7 → 4 | 184 → 188 |
| lib/terminal-input.test.mjs | Labelled key/modifier matrix plus bracketed multiline paste. | 3 → 1 | 46 → 14 |
| lib/text-preview.test.mjs | Merge contiguous large UTF-8 chunks and invalid-UTF-8 pagination progress. | 2 → 1 | 40 → 37 |
| lib/theme.test.mjs | Keep first-paint palette restoration and system fallback for invalid or blocked storage. | 1 → 1 | 20 → 20 |
| lib/thinking-expansion-preference.test.mjs | Merge collapsed default, preference changes/events and SSR with global cleanup. | 3 → 1 | 57 → 26 |
| lib/thinking-level-mid-run.integration.test.mjs | Keep mid-run thinking-level integration behavior. | 1 → 1 | 61 → 61 |
| lib/tool-call-expansion.test.mjs | Merge per-call remembered expansion and absent-id no-op; clear shared state after test. | 2 → 1 | 26 → 24 |
| lib/tool-execution-progress.test.mjs | Labelled latest-text/absent/image/blank matrix and bounded tail preview. | 3 → 1 | 32 → 15 |
| lib/tool-preset-preference.test.mjs | Matrix configured fallback and all supported choices, plus blocked/null storage and getter cleanup. | 4 → 1 | 78 → 32 |
| lib/tool-presets.test.mjs | Matrix preset mapping, custom-tool filtering, PowerShell, fresh arrays and configured-without-override semantics. | 6 → 1 | 97 → 29 |
| lib/tps.test.mjs | Labelled head-start/rate-change/unsupported-reading and normal/fast bounded sampling matrices. | 7 → 1 | 83 → 36 |
| lib/workspace-memory.test.mjs | Merge workspace isolation/clear/malformed recovery/key priority; separate blocked methods/getter behavior. | 12 → 2 | 129 → 52 |
| lib/worktree.test.mjs | Merge project-root resolution, force requirements and removal results. | 4 → 1 | 105 → 83 |
| public/sw.test.mjs | Merge valid/malformed push and notification click routing; separate stalled fetch, background cache write and live-body timeout contracts. | 10 → 5 | 291 → 293 |

## Limits for the coordinator

The source estimates include regex literals and generated scenarios; they must not be subtracted from the final actual count to claim an observed runtime reduction. Line savings are measured against the provided pre-consolidation bytes. The group result covers only the explicit 107 paths. Existing package scripts outside this manifest may still name files another owner consolidated; their reconciliation and the recursive full-suite result belong to final coordination.
