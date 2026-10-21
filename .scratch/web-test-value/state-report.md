# State test value reduction

Coordinator review follow-up: restored run:{inputs:["s1"]} on the stale busy frame so the test exercises an actual running payload. Preparing-state assertion remains. This adds one source line (final2014) and no registration (still50). Exact hook rerun8/8 passed in `.dev/verify/web-test-value/state-review-fix.log`; reviewer50 closed the sole material finding. Metrics and worker evidence below precede that one-line correction; final recursive acceptance is in [results.md](results.md).

Completed against the supplied `.dev/verify/web-test-value/before/` backups in the shared dirty workspace. Only the 46 owned existing test paths, this report and `.dev` evidence were changed. No product, scripts, discovery, vendor, e2e, agent configuration or graph changes.

| Measure | Supplied baseline | Final |
| --- | ---: | ---: |
| Owned files | 46 | 20 |
| Source lines | 10,706 | 2,013 |
| Nonblank lines | 9,953 | 1,856 |
| Nonblank, non-comment lines | 9,364 | 1,803 |
| Source bytes | 526,541 | 106,886 |

Deleted 26 files. Removed **8,693 lines (81.2%)**, **7,561 nonblank, non-comment lines (80.7%)**, and **419,655 bytes (79.7%)**. Line counts use `splitlines()`; the code-line approximation excludes blank lines and lines beginning with comment markers, without pretending to be an AST measure. Original bytes were read from the supplied backups, not HEAD. Per-file measurements: `.dev/verify/web-test-value/state-source-metrics.json`.

## Executed verification

Revision: `1758c1fb4479e9d4637a957857246c5998619d73`, dirty shared tree; timestamps and exact dirty paths are in the metadata. The supplied global baseline reports 461 pass across 239 files in `before-web-unit.json`; it was not rerun and is not an owned-partition baseline execution.

- Initial focused command: `node --test` with the explicit 20 retained owned paths, from `apps/web`. Actual Node summary: **50 tests, 48 pass, 2 fail, 0 cancelled/skipped/todo**, exit **1**. Exact argv and tested source hashes: `.dev/verify/web-test-value/state-verification.json`; raw log: `.dev/verify/web-test-value/state-tests.log`.
- Repaired only two mistaken rewritten fixtures: the interest-cap test now stages local interests before placing them; the oversize/stale-stream test correctly expects the unanswered local input to remain preparing. Neither required a product change.
- Affected-file rerun: `node --test hooks/useAgentSession.lifecycle.test.mjs lib/lifecycle-projection.test.mjs`, from `apps/web`. Actual Node summary: **14 tests, 14 pass, 0 fail/cancelled/skipped/todo**, exit **0**. Metadata/hashes: `.dev/verify/web-test-value/state-repair-verification.json`; raw log: `.dev/verify/web-test-value/state-repair-tests.log`.
- The other **36 passing tests** remain unchanged since their first run. Thus the final 20-file partition contains **50 actual Node tests**, within the hard budget of 55, with passing evidence for every final source hash. This is combined unchanged-source evidence, not a claimed single final 50-pass invocation. The full focused list was run once; only the two affected files were rerun.
- Owned-path `git diff --check`: exit **0**; `.dev/verify/web-test-value/state-diff-check.log`. No broad workspace, browser, build or deployment checks ran. The parent owns the unchanged recursive suite and integration review.

## Every original owned path

Paths are relative to `apps/web`. “Keep” means unchanged from the supplied backup. “Merge” means rewritten around a smaller sample of real behaviors, with explicit contract cuts; it does not mean every old assertion survives. Replacements name a retained owner only when that owner actually tests the behavior.

| Original path | Action | Concrete protected failure / retired value and replacement owner |
| --- | --- | --- |
| `hooks/context-usage.test.mjs` | delete | Source-extracted callbacks and event-case wiring duplicate acceptance mechanics; usage-specific read ordering, recovery and refresh triggers are retired. No equivalent usage hook test claimed. |
| `hooks/mcp-slash-command.test.mjs` | delete | Settings shortcut ownership and command-cache variants are lower priority than composer dispatch. No replacement for built-in `/mcp` routing or list races. |
| `hooks/model-loading.test.mjs` | delete | Retry/pin/cancellation callback internals retired. Selected-model stale-read protection remains in the actual lifecycle hook suite; retry policy does not. |
| `hooks/useAgentSession.lifecycle.test.mjs` | merge | Actual bundled hook protects request-ID recovery/no resend, text/image restoration once, paged history across moving heads/remount, stale HTTP/model/queue reads, replacement attachment identity, refused stream rendering, named oversize recovery, one live completion owner and fresh-composer release. Same path; 8 focused tests with cleanup on failure. |
| `hooks/useFontPreferences.test.mjs` | delete | Font defaults, storage events and editing/reset inventories are low-risk preference coverage. No replacement. |
| `hooks/useGroupDrag.test.mjs` | delete | Pointer thresholds, ghost/drag lifecycle, edge scrolling and cleanup matrix retired as layout coverage. No replacement. |
| `hooks/useKeyboardShortcuts.test.mjs` | delete | Tiny Escape dispatch/handled/idle matrix retired. No replacement. |
| `hooks/useSessionUiState.test.mjs` | delete | Initial GET/sync bookkeeping retired as UI preference plumbing. No replacement. |
| `hooks/useViewportHeight.test.mjs` | delete | Keyboard/zoom/toolbar geometry matrix retired as layout coverage. No replacement. |
| `lib/agent-client.test.mjs` | keep | HTTP refusal versus uncertain transport failure prevents incorrect draft restoration/resubmission; explicit negative acknowledgement and insecure-context request IDs remain. |
| `lib/agent-event-connection.test.mjs` | keep | Shared readers avoid duplicate streams; reconnect, release, timeout and nonretryable refusal preserve delivery ownership. |
| `lib/agent-event-stream.test.mjs` | merge | Small SSE compatibility smoke protects opening before startup, cancellation/refusal, replay identity and terminal-before-progress ordering. Same path; removes detailed backlog, block-dropping, liveness and coalescing inventories. |
| `lib/agent-event-wire.test.mjs` | merge | Tool-call identity survives slim deltas; traffic stays linear, result pairing survives progress and system messages remain private. Same path; removes codemode snapshot limits, nested-tool representation inventories, malformed/future shapes and snapshot identity helper assertions. |
| `lib/chat-lazy-load.test.mjs` | delete | Tail-button and prompt-spacer helper geometry is lower value. Transcript viewport/anchor behavior remains in `transcript-window` and `scroll-settlement`; exact spacer formulas are retired. |
| `lib/chat-only.test.mjs` | delete | Optional resource flags and ordered SDK context-discovery assertions retired. No replacement. |
| `lib/chat-phase-label.test.mjs` | delete | Pure phase/tool label inventory retired. Hook stale-state cases still prevent old reads from restarting visible work; exact labels/compaction wording are not covered. |
| `lib/chat-scroll-position.test.mjs` | keep | Restoring scroll uses the actual winning element and entry identity, including empty/fallback viewport placement. |
| `lib/chat-turn-identity.test.mjs` | keep | Mid-turn pages resolve by message identity, preventing navigation into the wrong turn after pagination. |
| `lib/chat-turn-model.test.mjs` | keep | Transcript grouping preserves live/settled structure, stable refs, search reveal and per-turn written files. |
| `lib/completion-delivery.test.mjs` | merge | Shared answers sound once; history/aborts/subagents stay silent. Handover preserves queued follow-up answers, idle work releases sources and terminal fan-in reserves capacity without evicting the foreground. Same path; 4 concise behavioral tests. |
| `lib/deferred-text.test.mjs` | keep | Expand/copy receives full originals in order, coalesces reads, retries failure, bounds cached bytes/count and refuses partial restoration. |
| `lib/history-prefix.test.mjs` | keep | Loaded pages migrate without duplication, false prefix invention or survival across an invalidating head change. |
| `lib/initial-navigation.test.mjs` | keep | URL cwd/session selection, remembered composer fallback and SSR startup choose the correct initial conversation. |
| `lib/lifecycle-acquisition.test.mjs` | keep | The shared receiver publishes HTTP/SSE facts only after fold acceptance and refuses unattached reads. |
| `lib/lifecycle-projection.test.mjs` | merge | Hydration, last-good-view preservation, queue/answer ownership, duplicate admission/facts/equal snapshots, bounded interests, silent by-ID recovery, cancelled/foreign attachment rejection and draft ownership remain. Same path; 6 concise behavioral tests. |
| `lib/run-marks.test.mjs` | delete | Sidebar unread-marker deduplication/malformed timestamp matrix retired. Completion-delivery still tests live sound ownership, which is a different contract. |
| `lib/scroll-settlement.test.mjs` | keep | Navigation settles visible targets, stops for reader gestures/cancel/missing targets and bounds frames so it cannot scroll forever. |
| `lib/session-family.test.mjs` | delete | Nested family ordering, orphan/cycle and fork-family grouping retired. No replacement. |
| `lib/session-file-references.test.mjs` | keep | Exact-path authorization excludes sibling-prefix/hidden/system/untrusted tool provenance and validates session identifiers. |
| `lib/session-fork.test.mjs` | delete | SDK/file-copy branch and title suffix inventories retired. Source-file immutability, fork copy identity and refusal codes have no replacement in this partition. |
| `lib/session-list-scanner.test.mjs` | delete | SDK metadata parity, persisted index repair and deferred scan policy are legacy scanner internals. No replacement. |
| `lib/session-liveness.test.mjs` | delete | Legacy registry/extension compatibility and lease lifecycle internals retired. Connection release smoke remains; registry leases/provider failures do not. |
| `lib/session-path.test.mjs` | delete | Tiny separator/case helper matrix retired. No equivalent case-normalization assertions claimed. |
| `lib/session-reader-latest-entry.test.mjs` | delete | SDK/file-tail parsing, torn-line/CRLF and bounded-tail helper matrix retired. No replacement. |
| `lib/session-reader.pagination.test.mjs` | delete | SDK active-branch, compaction reconstruction, settings/stats and raw/visible message budgets retired. Active hook history and `history-prefix` protect loaded browser pages, not SDK file traversal. |
| `lib/session-reader.test.mjs` | delete | Legacy SDK manager/header/catalogue/cache matrix retired, including historical image/thinking conversion, targeted storage confinement, symlink/duplicate-ID fallbacks and catalogue races. Hook/cache tests protect active browser state only; no equivalent filesystem-reader coverage claimed. |
| `lib/session-row-context-menu.test.mjs` | delete | Tiny native/extension menu event plumbing matrix retired. No replacement. |
| `lib/session-stats.test.mjs` | delete | SDK compacted/full-file/cache-warm usage accounting inventory retired. No replacement. |
| `lib/session-timing.test.mjs` | delete | SDK timestamp/gap/branch metadata aggregation inventory retired. No replacement. |
| `lib/session-title.test.mjs` | delete | SDK title wrapper parsing, transcript bounding and generation-policy matrix retired. No replacement. |
| `lib/session-tool-selection.test.mjs` | delete | SDK versioned custom-entry serialization and legacy selection helper inventory retired. No replacement for persisted tool pins. |
| `lib/session-tree.test.mjs` | delete | Large family/pin/archive/order/virtual-row/drag helper inventory retired, including displayed host-folder formatting and project ordering. No replacement in this partition; this does not claim execution-host refusal coverage. |
| `lib/session-view-cache.test.mjs` | merge | Restore window/paged-prefix references and head marker; touch LRU, release on delete/logout, bound prefix bytes, release replacement/expired bytes and reject oversize writes without losing existing history. Same path; 2 tests. Serialization-count, malformed/circular payload and exhaustive accounting permutations retired. |
| `lib/streaming-message.test.mjs` | keep | Reconnect and deltas preserve immutable text/thinking, raw tool input/identity and authoritative end replacement without duplicate chunks. |
| `lib/transcript-window.test.mjs` | keep | Viewport/reveal ranges stay bounded; prepends and height changes keep the reader's position in the same turn. |
| `lib/turn-written-files.test.mjs` | keep | Only successful paired writing calls expose written paths; partial apply_patch results exclude failed/deleted files. |

## Deliberate cuts within retained lifecycle tests

The old hook fixture repeated stale/equal/remounted reads and model/queue acceptance under many separate histories. The new hook executes representative full-window acceptance/refusal, stale independent state on both the same and replacement attachment, and one combined paged-history/remount advance. Equal-revision hook hydration, forced model-switch tool-preset reads, retained-stream rejoin lookup, newer HTTP-over-stream acceptance, and the real SQLite/backend/adapter oversize integration are retired here. The synthetic named refusal still proves the hook preserves the pending input, restores no draft and recovers when a frame arrives; it does not prove backend generation or HTTP 413 forwarding.

The fold retains idempotency, queue/follow-up identity, stale/cancelled/foreign attachment fences and silent recovery, while dropping exhaustive activity/phase variants, no-timer/no-network monkey-patches, write-completion and promotion variants, and every malformed transition permutation. Completion delivery retains representative answer deduplication, silence, queue handover/release and foreground/terminal budgeting; it drops repeated equivalent baseline, abort, idle-visit and staged/unfinished handover scenarios. No one-shot run closures, registration collectors, nested subtests, skips, exclusions, filters or empty test files were introduced.

The parent can use `.dev/verify/web-test-value/state-deleted.json` to migrate any explicit script targets that name genuinely retired paths. This partition does not establish the global below-200 result or substitute for the parent's recursive integration result.

Applied ponytail cuts: delete the lower-value suites; shrink repeated hook/transport/fold/cache fixtures to representative executed contracts. **net: -8,693 lines.**
