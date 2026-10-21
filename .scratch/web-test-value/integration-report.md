# Integration test reduction

Completed 2026-10-15 in the shared dirty `/home/developer/Documents/dev/hepi-harness` workspace, HEAD `1758c1fb4479e9d4637a957857246c5998619d73`. Scope: the 107 original paths in this group's unchanged manifest. Applied `ponytail-review` in optimize mode and the repository review policy. Only owned tests, this report and `.dev` evidence were changed.

Reduced **107 → 35 files**, deleting 72 files. Saved baseline bytes in `.dev/verify/web-test-value/before/` measure **8,909 → 3,955 physical lines** (−4,954, 55.6%) and **444,523 → 206,643 bytes** (−237,880, 53.5%). Nonblank lines excluding standalone comment lines fell **7,530 → 3,365** (−4,165, 55.3%); this simple metric includes multiline string contents and is not a language parser. These are real source deletions, not fewer registrations around the same bodies. The baseline is the provided backup, not Git HEAD or the earlier 2,381-test era.

Final owned-file run: **60 actual Node tests, 60 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; exit 0**. Ran once after edits stabilized, starting `2026-10-15T03:16:44.591277+00:00`, from `apps/web`: `node --test --test-reporter=tap` followed by all 35 surviving manifest paths in manifest order. No rerun was needed. This reaches the hard owned budget of 60 and the 4,500-line target. The parent owns the unchanged recursive suite and global 190-test budget; this result alone does not establish either.

Evidence under `.dev/verify/web-test-value/`:

- `integration-result.json`: exact expanded argv, cwd, timestamps, SHA, dirty status, full Git status, SHA-256 for each tested source, exit code and actual Node counters.
- `integration-tests.log`: raw TAP log.
- `integration-metrics.json`: every original path's backup/current byte and line measurements and hashes.
- `integration-diff-check.log`: `git diff --check -- <all 107 original owned paths>`, exit 0. Tested-source hashes were checked again after measurement and remain unchanged.

No broad suite, browser, build or deployment checks ran. No product, package script, discovery, vendor, e2e, configuration or graph changes were made. Fixture symlink privilege failures now fail normally rather than skipping. Independent fixtures await asynchronous work and retain cleanup hooks/finally blocks.

## Contract cuts and script reconciliation

This deliberately retires historical assertions. There is no promise of equivalent historical coverage. Formatting, CSS/prose inventories, low-risk mapping/preferences, SDK-private behavior and dormant upstream runtime helpers were removed. Routine session/configuration CRUD wrappers lose dedicated route/refusal checks; retained routing/catalog/lifecycle tests protect the consequential ownership and stale-state seams but do not replace each retired operation's checks.

`durable-api` retires models-config GET/PUT, reload outcomes and skill-toggle translation checks. It retains current 501 refusals, full deferred text/thinking/image bytes and media type, submission lookup identity/null, bounded history and real stream oversize refusal. Text refusal status samples are reduced to 404 plus success. `skill-inventory` retires catalog-state, version/provenance, confirmation and output-prose inventories while retaining execution host, conversation adoption ownership and retained-target exclusion. `stacked-dialog` replaces the large overlapping synthetic DOM inventory with two focused tests for Escape ownership/IME/listener cleanup and focus restoration/coarse-pointer/other-surface behavior. Rare unfocusable/disconnected opener and busy-dialog variants lose dedicated assertions.

Parent must migrate explicit package script targets; this worker did not edit scripts:

- `test:upstream`: retired `lib/normalize.test.mjs`, `lib/file-fuzzy.test.mjs`, `lib/git-changes.test.mjs`. Other targets belong to their respective groups.
- `test:skills`: retired `lib/i18n/registry.test.mjs`. `lib/skill-inventory.test.mjs` and `adapters/durable-api.test.mjs` remain.

## Every original manifest path

Paths and replacement owners are relative to `apps/web`. “None” explicitly means coverage retired, with no equivalent replacement claimed. “Keep” includes unchanged focused tests; “merge” identifies a shortened retained file.

| Original path | Decision | Concrete failure protected or reason to retire; replacement owner |
| --- | --- | --- |
| adapters/durable-api.test.mjs | merge | Full deferred content/bytes, recovery identity, paging and explicit 501/stream oversize refusal; remains here. Config/reload/toggle checks retired. |
| adapters/durable-lifecycle.test.mjs | keep | Stale reads replacing accepted state, acquisition identity/revision races, settlement, window folding and resync; remains here. |
| adapters/extensions.test.mjs | delete | Routine extension-selection route forwarding; dedicated operation assertions retired. None. |
| adapters/files-transfer.test.mjs | keep | Upload conflict/partial-failure cache invalidation, unsafe names, byte limits and binary range/download/refusal; remains here. |
| adapters/host-cwd-ownership.test.mjs | keep | Another host's folder reaching the local host, ambiguous path identity, missing-host refusal and retained bindings; remains here. |
| adapters/mcp-surface.test.mjs | delete | Broad MCP config/sign-in forwarding inventory overlaps host/server ownership; host routing/refusal remains in adapters/host-cwd-ownership.test.mjs, CRUD/sign-in specifics retired. |
| adapters/project-removal.test.mjs | keep | Retained folders incorrectly offered as defaults and lost backend removal/unlink refusals; remains here. |
| adapters/recall-and-session-list.test.mjs | keep | Sidebar polling fan-out/version disagreement and queue recall silently claiming success on refusal; remains here. |
| adapters/remote-project-removal.test.mjs | keep | Removing/unlinking another gateway's project accidentally requires a local binding; remains here. |
| adapters/session-auto-name.test.mjs | delete | Low-risk name route/refusal wrapper; dedicated naming contract retired. None. |
| adapters/session-delete.test.mjs | delete | Routine conversation DELETE forwarding/version wrapper; dedicated delete checks retired. None. |
| adapters/session-fork.test.mjs | keep | Fork identity/catalog relation and transcript command/refusal diverge; remains here. |
| adapters/session-rename.test.mjs | delete | Title and rename/refusal mapping inventory; dedicated rename checks retired. None. |
| adapters/session-search.test.mjs | keep | Search refusal appears as empty results or catalog search fans out per conversation; remains here. |
| adapters/stream-heartbeat.test.mjs | delete | Comment-byte passthrough representation inventory; terminal reconnect and durable stream behavior remain in terminal-fan-in and durable-lifecycle, exact comments retired. |
| adapters/terminal.test.mjs | keep | Reconnecting terminal loses header/query cursor or routing cwd; remains here. |
| adapters/worktree-picker.test.mjs | keep | Worktree operations address the wrong workspace or swallow dirty-removal refusal; remains here. |
| lib/ansi.test.mjs | delete | Escape/box/cursor-marker formatting helper inventory. None. |
| lib/app-update.test.mjs | delete | Version comparison and release-link scaffolding. None. |
| lib/apply-patch.test.mjs | delete | Upstream patch syntax/preview mapping inventory; exhaustive parser coverage retired. None. |
| lib/atomic-file.test.mjs | delete | Tiny low-level replacement helper, below active host persistence integration seam. None. |
| lib/auth-throttle.test.mjs | keep | Login brute-force backoff fails to block, expire or reset consistently across module copies; remains here. |
| lib/bash-output.test.mjs | keep | Bash output reads escape temp scope through names/symlinks or buffer oversize files; remains here. |
| lib/bounded-form-data.test.mjs | keep | Multipart buffering exceeds limits or continues after refused file; remains here. |
| lib/browser-notifications.test.mjs | delete | Delivery/visibility fallback inventory; public/sw.test.mjs retains push/navigation, page notification fallback details retired. |
| lib/compaction-summary.test.mjs | delete | Metadata-tag display formatting. None. |
| lib/custom-ui-terminal.test.mjs | delete | Dormant headless upstream panel dimensions/render scaffolding. None. |
| lib/default-cwd.test.mjs | delete | Default-directory date/path formatting. None. |
| lib/default-preferences.test.mjs | delete | Dormant local settings defaults and thinking-level inventories. None. |
| lib/deferred-provider-models.test.mjs | delete | Upstream runtime provider catalog internals. None. |
| lib/directory-browser.test.mjs | delete | Local directory listing/platform candidates; real confinement remains in file-access/linked-directory, listing and child-creation details retired. |
| lib/display-path.test.mjs | delete | Display-root abbreviation and path formatting inventory; execution routing remains in project-routing. |
| lib/exact-system-prompt.test.mjs | delete | Upstream runtime prompt hook scaffolding. None. |
| lib/extension-dialog-fit.test.mjs | delete | Pixel overflow and rounding inventory. None. |
| lib/extension-ui-queue.test.mjs | keep | Concurrent/replayed dialogs overwrite or reorder one another; remains here. |
| lib/extension-widgets.test.mjs | delete | Low-risk ordered widget mapping helper. None. |
| lib/file-access.test.mjs | keep | Symlink and parent traversal expose files outside approved roots; remains here. |
| lib/file-dirent.test.mjs | delete | Filesystem type mapping inventory, below retained real-file boundary tests. None. |
| lib/file-fuzzy.test.mjs | delete | Mention string/quoting helper; dedicated formatting assertions retired. None; explicit test:upstream target. |
| lib/file-links.test.mjs | keep | File links escape cwd, double-decode paths or hijack external/browser clicks; remains here. |
| lib/file-paths.test.mjs | delete | Filename/join/API encoding representational inventory; routing owner project-routing remains, UNC specifics retired. |
| lib/file-tree-visibility.test.mjs | delete | Git/name-list visibility inventory; local explorer selection mechanics no longer independently specified. None. |
| lib/file-types.test.mjs | delete | Extension/media classification inventory. None. |
| lib/file-upload-client.test.mjs | keep | Chat drop loses image attachments or mentions files not uploaded in original order; remains here. |
| lib/file-upload.test.mjs | keep | Upload names escape paths, collide, replace directories or symlinks; remains here. |
| lib/file-viewer-state.test.mjs | delete | Tiny saved-mode/open-hint preference precedence. None. |
| lib/font-preferences.test.mjs | delete | Font storage/CSS data and weight inventory. None. |
| lib/frontmatter.test.mjs | delete | Copied Markdown/YAML fence/title syntax inventory. None. |
| lib/gfm-autolink-email-loader.test.mjs | delete | Upstream regex/build-source scaffolding. None. |
| lib/git-changes.test.mjs | delete | Status parser/badge mapping inventory. None; explicit test:upstream target. |
| lib/http-dispatcher.test.mjs | delete | Global proxy dispatcher setup outside active durable routing ownership. None. |
| lib/i18n/format.test.mjs | delete | Translation/time/locale representation inventory. None. |
| lib/i18n/registry.test.mjs | delete | Locale registry/key/placeholder inventory. None; explicit test:skills target. |
| lib/image-attachments.test.mjs | keep | Invalid, oversized or excessive images silently accepted or lost; remains here. |
| lib/json-response.test.mjs | delete | Low-risk gzip quality/small-response representation choices. None. |
| lib/jsonc.test.mjs | delete | Copied syntax stripper compatibility inventory. None. |
| lib/key-serializer.test.mjs | keep | Failed per-key task wedges later work or unrelated keys serialize together; remains here. |
| lib/linked-directory.test.mjs | merge | Outside-link approval targets change or nested unapproved links bypass consent; remains here; privilege failures no longer skip. |
| lib/login-destination.test.mjs | keep | Login return destination redirects to another origin; remains here. |
| lib/markdown-list-continuation.test.mjs | delete | Low-risk list/caret/fence syntax inventory. None. |
| lib/markdown.test.mjs | delete | Math fence/code/CJK autolink formatting inventory. None. |
| lib/message-display.test.mjs | delete | Thinking/process/answer/anchor presentation inventory; independent helper coverage retired. None. |
| lib/new-session-context.test.mjs | keep | Composer cwd lags sidebar and new work targets retained/wrong project; remains here. |
| lib/next-config-esm.test.mjs | delete | Configuration source/runtime scaffolding. None. |
| lib/next-config.test.mjs | delete | Build tracing/proxy configuration inventory; bounded upload behavior remains in files-transfer. |
| lib/normalize.test.mjs | delete | SDK scratch/raw message buffer internals. None; explicit test:upstream target. |
| lib/open-in-file-manager.test.mjs | delete | Platform command/loopback helper inventory; current unsupported capability remains in durable-api. |
| lib/panel-layout.test.mjs | delete | Width clamp/responsive style inventory. None. |
| lib/patch.test.mjs | delete | Diff row/header syntax presentation inventory. None. |
| lib/paths.test.mjs | delete | Separator/case/drive/UNC mapping inventory; active project routing remains in project-routing. |
| lib/pi-sdk-internals.test.mjs | delete | SDK-private export, resolution/cache and config internals. No equivalent replacement; host routing remains in host-cwd-ownership. |
| lib/powershell-settings.test.mjs | delete | Dormant upstream Windows settings/preset scaffolding. None. |
| lib/project-command-env.test.mjs | keep | Web password/host variables leak to commands; Stop/Timeout hang on escaped writers; remains here with process cleanup. |
| lib/project-groups.test.mjs | delete | Group display/count/identity mapping inventory; project-routing/new-session-context retain target identity, count formatting retired. |
| lib/project-identity.test.mjs | delete | Tiny case/separator identity helper already below retained project-routing seam. |
| lib/project-removal.test.mjs | delete | Browser helper duplicates retained adapters/project-removal operation and retained-folder seam; exact helper strings retired. |
| lib/project-routing.test.mjs | keep | Routing sentinel or undeclared root treated as a workspace, projects merge or retained target becomes selectable; remains here. |
| lib/project-tree.summary.test.mjs | delete | Compressed upstream tree payload/serialization inventories. None. |
| lib/project-tree.test.mjs | delete | Upstream branch preview/compression mapping inventory. None. |
| lib/prompt-recovery.test.mjs | delete | Tiny optimistic key helper; durable-api retains actual submission identity lookup, image-key specifics retired. |
| lib/quoted-selection.test.mjs | delete | Trivial Markdown quote formatting. None. |
| lib/regular-file.test.mjs | delete | Tiny regular-file helper below retained bash-output/path boundary integration. Dedicated FIFO/missing-read details retired. |
| lib/request-security.test.mjs | keep | Cross-origin requests, DNS rebinding, bad Host or untrusted proxy evidence bypass API boundary; remains here. |
| lib/response-usage-visibility.test.mjs | delete | Low-risk local preference/subscriber scaffolding. None. |
| lib/search-tree.test.mjs | delete | Search directory nesting/sort/dedupe mapping inventory. None. |
| lib/settings-navigation.test.mjs | delete | Per-section preference inventory; tab-session/workspace-memory retain principal session/workspace navigation state, settings-specific selection retired. |
| lib/shell-words.test.mjs | delete | Copied shell token/quote syntax parser inventory. None. |
| lib/sidebar-actions.test.mjs | delete | Menu action/shortcut/prose inventory; real fork operation remains in adapters/session-fork, menu details retired. |
| lib/sidebar-prefs.test.mjs | delete | Tab/pin/group persistence and old-key migration inventories. None. |
| lib/skill-inventory.test.mjs | merge | Wrong execution host/account or unrelated conversation adopts installation; retained targets excluded. Version/prose/catalog inventories retired. |
| lib/slash-display.test.mjs | delete | SDK skill-XML expansion/display formatting. None. |
| lib/stacked-dialog.test.mjs | merge | Escape stops an agent under Settings/dialog, IME closes surfaces, focus raises mobile keyboard or steals another surface; two tests remain here. |
| lib/tab-session.test.mjs | keep | Window restores the wrong session/composer or clears an unrelated remembered session; remains here. |
| lib/terminal-fan-in.test.mjs | keep | Duplicate streams, stale frames, lost reconnect cursor or retry after close/refusal; remains here with cleanup. |
| lib/terminal-input.test.mjs | keep | Terminal navigation/control sequences and pasted input stop working; one smoke remains here. |
| lib/text-preview.test.mjs | keep | Large UTF-8 text pagination loses bytes or stalls on invalid encoding; remains here. |
| lib/theme.test.mjs | delete | First-paint palette/storage style inventory. None. |
| lib/thinking-expansion-preference.test.mjs | delete | Local expansion preference/event inventory. None. |
| lib/thinking-level-mid-run.integration.test.mjs | delete | Upstream agent runtime setting-change scaffolding outside Web durable ownership. None. |
| lib/tool-call-expansion.test.mjs | delete | Tiny per-call expansion preference helper. None. |
| lib/tool-execution-progress.test.mjs | delete | Bounded text preview formatting inventory. None. |
| lib/tool-preset-preference.test.mjs | delete | Tool preset preference/storage inventory. None. |
| lib/tool-presets.test.mjs | delete | Upstream preset/name/default mapping scaffolding. None. |
| lib/tps.test.mjs | delete | Rate sampling/display formatting inventory. None. |
| lib/workspace-memory.test.mjs | keep | Switching workspace restores another workspace's conversation or corrupt storage breaks navigation; remains here. |
| lib/worktree.test.mjs | delete | Local upstream worktree helper duplicates active adapters/worktree-picker operation seam; native helper particulars retired. |
| public/sw.test.mjs | keep | Push loses subscription, notification opens foreign origin, hung network blocks offline fallback or cache write delays response; remains here. |

net: −4,954 physical lines applied; −4,165 nonblank noncomment lines applied.
