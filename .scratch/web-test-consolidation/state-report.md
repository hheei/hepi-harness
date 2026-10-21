# State partition consolidation report

State partition is complete in `/home/developer/Documents/dev/hepi-harness`. The exact owned remainder passes with **105 reported tests, 105 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo**, across **46 files**. No product, vendor, e2e, discovery, default-script, agent-default, service or deployment changes were made by this continuation. No commit or graph rebuild was performed.

This report includes the inherited worker changes listed in the handoff. Original bytes are the supplied backups in `.dev/verify/web-test-consolidation/before/`, not a clean checkout of HEAD. Other workers' changes are outside this report.

## Counts and evidence

| Measure | Original supplied inventory | Final state |
| --- | ---: | ---: |
| Owned test files | 50 | 46 |
| Source-call estimate / reported tests | 574 static inventory calls | 105 actual Node reported tests |
| Lines in owned test files | 12,566 | 10,706 |

The owned files decrease by1,860 lines. No executed before/after case-count reduction is claimed for this partition. The original574 is a source-text estimate, not an executed Node test count; the worker found572 syntactic `test()` sites in the backups. Input loops and non-code matches make static counts differ from reported tests. The original suite was not rerun. The final count comes from Node's real runner, not a static estimate. Line totals include blank and comment lines, exclude reports and generated verification metadata, and count deleted files as zero after.

Final verification ran on **1758c1fb4479e9d4637a957857246c5998619d73**, with a dirty shared working tree. The runner host recorded **2026-10-15T01:57:54.004335+00:00** in `state-verification.json`. The owned files' SHA-256 values and exact argv are recorded there so the result remains tied to the tested source despite other workers continuing.

- Command: `node --test` followed by the explicit 46-file list below, from `apps/web`.
- Exit: **0**.
- Raw output: `.dev/verify/web-test-consolidation/state-tests.log`.
- Verification metadata: `.dev/verify/web-test-consolidation/state-verification.json`.
- Owned-path `git diff --check`: **exit 0**.
- Detailed original-scenario to final-contract mapping for the previously untouched complex files: `.dev/verify/web-test-consolidation/state-merges.json`. The final files preserve case labels; the mapping also describes cases subsequently converted into direct data matrices.

```sh
cd /home/developer/Documents/dev/hepi-harness/apps/web
node --test \
  hooks/context-usage.test.mjs \
  hooks/mcp-slash-command.test.mjs \
  hooks/model-loading.test.mjs \
  hooks/useAgentSession.lifecycle.test.mjs \
  hooks/useFontPreferences.test.mjs \
  hooks/useGroupDrag.test.mjs \
  hooks/useKeyboardShortcuts.test.mjs \
  hooks/useSessionUiState.test.mjs \
  hooks/useViewportHeight.test.mjs \
  lib/agent-client.test.mjs \
  lib/agent-event-connection.test.mjs \
  lib/agent-event-stream.test.mjs \
  lib/agent-event-wire.test.mjs \
  lib/chat-lazy-load.test.mjs \
  lib/chat-only.test.mjs \
  lib/chat-phase-label.test.mjs \
  lib/chat-scroll-position.test.mjs \
  lib/chat-turn-identity.test.mjs \
  lib/chat-turn-model.test.mjs \
  lib/completion-delivery.test.mjs \
  lib/deferred-text.test.mjs \
  lib/history-prefix.test.mjs \
  lib/initial-navigation.test.mjs \
  lib/lifecycle-acquisition.test.mjs \
  lib/lifecycle-projection.test.mjs \
  lib/run-marks.test.mjs \
  lib/scroll-settlement.test.mjs \
  lib/session-family.test.mjs \
  lib/session-file-references.test.mjs \
  lib/session-fork.test.mjs \
  lib/session-list-scanner.test.mjs \
  lib/session-liveness.test.mjs \
  lib/session-path.test.mjs \
  lib/session-reader-latest-entry.test.mjs \
  lib/session-reader.pagination.test.mjs \
  lib/session-reader.test.mjs \
  lib/session-row-context-menu.test.mjs \
  lib/session-stats.test.mjs \
  lib/session-timing.test.mjs \
  lib/session-title.test.mjs \
  lib/session-tool-selection.test.mjs \
  lib/session-tree.test.mjs \
  lib/session-view-cache.test.mjs \
  lib/streaming-message.test.mjs \
  lib/transcript-window.test.mjs \
  lib/turn-written-files.test.mjs
```

## Functional disposition of every original file

Counts before use the supplied manifest's registrations; after counts are actual final registrations. Every retained file's destination is the same path under `apps/web`. “Merge” means explicit scenario blocks under a named functional contract, with fresh setup and cleanup per scenario; “matrix” means labelled inputs asserted directly in a loop. Neither introduces a test registration wrapper or nested subtests.

| Original file | Functional purpose and disposition / destination | Tests before → after | Lines before → after |
| --- | --- | ---: | ---: |
| `hooks/context-usage.test.mjs` | Merge/matrix usage read acceptance, request ordering, attachment/revision fences, failure recovery and assistant-only refresh triggers. Same file. | 7 → 2 | 123 → 127 |
| `hooks/mcp-slash-command.test.mjs` | Merge/matrix built-in versus extension command ownership, subcommands, pending/cached command lists and stale-request races. Same file; retire source-only Settings/writer spelling checks in favor of executed routing callbacks. | 12 → 2 | 241 → 216 |
| `hooks/model-loading.test.mjs` | Merge/matrix executed loading callbacks: bounded retries, visible errors, cancellation, explicit picks and reasoning pins. Same file. | 3 → 1 | 157 → 136 |
| `hooks/model-scope-startup.test.mjs` | Delete source regex snapshots of startup overrides and model-list refresh. Executed model-loading cases retain live-session and explicit-pick refresh behavior; real hook lifecycle tests exercise new-session creation and accepted model ownership. No one-for-one assertion of source layout remains. | 3 → 0 | 53 → 0 |
| `hooks/model-switching.test.mjs` | Delete source regex snapshots of optimistic-switch implementation. Real model changes, canonical reloads, acquisition sequencing and stale model rejection remain in `hooks/useAgentSession.lifecycle.test.mjs`; source-statement ordering itself is retired. | 3 → 0 | 38 → 0 |
| `hooks/useAgentSession.lifecycle.test.mjs` | Merge real bundled hook scenarios: acquisition/remount, history, send/steer/read refusals, real backend oversize refusal, completion ownership, stale/equal snapshots and independent model/queue state reads. Same file, isolated hook sandboxes. | 25 → 6 | 1208 → 1231 |
| `hooks/useAgentSession.test.mjs` | Delete 47 source-regex wiring/implementation tests. Functional seams and limits are detailed below; destination is the real hook lifecycle suite plus pure projection/acquisition/connection/completion/history/streaming/scroll/turn/tool-selection suites. Browser wiring remains the coordinator's accepted browser coverage. | 47 → 0 | 972 → 0 |
| `hooks/useFontPreferences.test.mjs` | Merge independent store fixtures for SSR/storage restoration/failures and editing/subscriptions/reset/cross-tab sync. Same file. | 6 → 2 | 166 → 166 |
| `hooks/useGroupDrag.test.mjs` | Merge pointer lifecycle scenarios for mouse, touch/pen, cancellation, changing rows, scrolling and listener/timer/frame cleanup. Delete platform source-spelling check; executed fake-platform fixtures remain. | 15 → 3 | 516 → 501 |
| `hooks/useKeyboardShortcuts.test.mjs` | Matrix Escape handling: active run, already-handled event, idle. Same file. | 3 → 1 | 48 → 45 |
| `hooks/useResizablePanel.test.mjs` | Delete regex-only pointer-axis/cursor/key/separator/storage/reset wiring snapshots. No execution test was removed; browser/UI resizing coverage belongs to the coordinator. This partition adds no new panel fixture. | 2 → 0 | 20 → 0 |
| `hooks/useSessionUiState.test.mjs` | Merge failed/successful initial GET and subsequent synchronization, with fresh hook fixtures. Same file. | 2 → 1 | 100 → 103 |
| `hooks/useViewportHeight.test.mjs` | Matrix keyboard, focus, zoom, toolbar and missing-scale geometry. Same file. | 8 → 1 | 80 → 22 |
| `lib/agent-client.test.mjs` | Merge HTTP refusal versus transport error, insecure-context submission IDs, explicit negative acknowledgement. Same file. | 3 → 1 | 78 → 70 |
| `lib/agent-event-connection.test.mjs` | Merge shared/independent readers, automatic/explicit reconnect, release, readiness timeout and nonretryable startup failure. Same file. | 6 → 3 | 163 → 172 |
| `lib/agent-event-stream.test.mjs` | Merge startup/cancel/shutdown/replay ordering, bounded backlog/block-boundary preservation, tool-update coalescing and terminal ordering. Same file; per-scenario stream/environment cleanup. | 15 → 3 | 522 → 552 |
| `lib/agent-event-wire.test.mjs` | Merge assistant identity/delta shapes, omission/nested/system event rules, bounded codemode snapshots and linear serialized traffic. Same file; exact projected payload assertions retained. | 19 → 3 | 483 → 493 |
| `lib/chat-lazy-load.test.mjs` | Merge tail attachment/button boundaries and prompt-spacer geometry/stream absorption. Same file. | 7 → 2 | 125 → 97 |
| `lib/chat-only.test.mjs` | Merge optional-resource settings and ordered context-file prompt output, including CLAUDE files. Same file. | 2 → 1 | 27 → 27 |
| `lib/chat-phase-label.test.mjs` | Matrix preparation, actual stream phase, running tool progress and compaction precedence. Same file. | 5 → 1 | 54 → 30 |
| `lib/chat-scroll-position.test.mjs` | Matrix winning anchor identity, viewport placement, fallback and empty candidates. Same file. | 5 → 1 | 61 → 59 |
| `lib/chat-turn-identity.test.mjs` | Merge leading split-turn identities, entry/anchor lookup and missing anchors. Same file. | 4 → 1 | 61 → 51 |
| `lib/chat-turn-model.test.mjs` | Merge settled/live/leading turn layout, process groups, written files/timestamps, stable refs and search targets. Same file. | 9 → 2 | 184 → 167 |
| `lib/completion-delivery.test.mjs` | Merge live answer ownership/silence, handover/queued interests, idle-source release and foreground/terminal/background budgets. Same file, fresh delivery harness per scenario. | 20 → 4 | 549 → 562 |
| `lib/deferred-text.test.mjs` | Merge recognition, exact full-text fetch, retry/cache/coalescing/count/byte eviction and ordered original-block restoration including whole-answer refusal. Same file. | 8 → 2 | 142 → 126 |
| `lib/history-prefix.test.mjs` | Matrix migration/truncation/drop/rebaseline/idempotency, including no invented prefix. Same file. | 8 → 1 | 71 → 41 |
| `lib/initial-navigation.test.mjs` | Matrix URL cwd/session/sidebar precedence plus tab-memory fallback and SSR initial navigation. Same file. | 14 → 2 | 196 → 105 |
| `lib/lifecycle-acquisition.test.mjs` | Matrix shared HTTP/SSE facts, fold-before-publish and unattached read refusal. Same file. | 3 → 1 | 70 → 53 |
| `lib/lifecycle-projection.test.mjs` | Merge hydration, placement/terminal/queue ordering, protocol/refusal ownership, silent by-ID recovery, idempotency/bounds, acquisition fences and activity/purity. Same file; exact notices/effects/views retained. | 42 → 7 | 496 → 518 |
| `lib/run-marks.test.mjs` | Matrix unread end markers, duplicate/old/malformed ends, suppression and immutable maps. Same file. | 7 → 1 | 68 → 55 |
| `lib/scroll-settlement.test.mjs` | Matrix arrival geometry and merge settlement termination reasons, user/programmatic scroll distinction, missing targets and bounded frames. Same file. | 12 → 2 | 164 → 150 |
| `lib/session-family.test.mjs` | Merge nested family activity/order, orphan/cycle exclusion and independent fork roots. Same file. | 3 → 1 | 63 → 62 |
| `lib/session-file-references.test.mjs` | Direct matrices for exact path authorization, rendered/hidden entry provenance, trusted/untrusted tools, nested calls/errors, explicit spill paths, bash output and session-ID validation. Same file. | 14 → 3 | 267 → 63 |
| `lib/session-fork.test.mjs` | Merge branch/file-copy/refusal and title/suffix scenarios, preserving source immutability and independent copy identity. Same file, temporary filesystem fixtures. | 14 → 2 | 347 → 364 |
| `lib/session-list-scanner.test.mjs` | Merge SDK-equivalent incremental/persisted scans, malformed-index repair, partial lines, deferred detail policy and project symlinks. Same file; fixtures dispose before the next scenario. | 7 → 3 | 227 → 279 |
| `lib/session-liveness.test.mjs` | Merge/matrix registry compatibility, exact identity matching, idempotent disposal, malformed registrations, failed providers and lease expiry/renew/release. Same file. | 7 → 1 | 135 → 122 |
| `lib/session-path.test.mjs` | Matrix Windows normalization/case-insensitive identity versus case-sensitive path preservation. Same file. | 2 → 1 | 24 → 24 |
| `lib/session-reader-latest-entry.test.mjs` | Matrix newest IDs, header-only/missing/torn/CRLF files and bounded tail reads. Same file. | 6 → 1 | 91 → 77 |
| `lib/session-reader.pagination.test.mjs` | Merge ancestor/cursor/deep-chain windows, full compaction traversal/settings, string assistant content/full-file stats and visible-message/tool-traffic budgets. Same file. | 18 → 4 | 300 → 312 |
| `lib/session-reader.test.mjs` | Merge manager cache byte/count/invalidation, persisted active history/model ownership, deferred originals, bounded headers/relation reads, confined path/catalogue fallback, stale/fresh/in-flight catalogue races. Same file; environment, mocks and limits restored between fixtures. | 32 → 6 | 1083 → 1187 |
| `lib/session-row-context-menu.test.mjs` | Matrix native menu fallback, stable detail delivery and extension cancellation ownership. Same file. | 3 → 1 | 46 → 43 |
| `lib/session-stats.test.mjs` | Merge full-file/compacted/tool/summary/cache-warm/system usage and live-message reconciliation without double counting. Same file. | 8 → 2 | 227 → 233 |
| `lib/session-timing.test.mjs` | Matrix active gaps, human idle, compactions/branches/bash boundaries/metadata and invalid timestamps. Same file. | 9 → 1 | 107 → 117 |
| `lib/session-title.test.mjs` | Merge title parsing, live/compacted standalone generation, own-model cheapest reasoning and bounded goal/outcome/image transcript. Same file. | 11 → 3 | 304 → 313 |
| `lib/session-tool-selection.test.mjs` | Matrix absent/empty/valid/invalid/cleared selections and exact versioned append records. Same file. | 8 → 1 | 97 → 78 |
| `lib/session-tree.test.mjs` | Merge host-folder/routing/user expansion ownership, families/pins/archive, pagination attention exceptions, row/reveal geometry, stable incremental order, band-confined moves and drag geometry. Same file; complete ordering/drop assertions retained. | 48 → 8 | 1131 → 1156 |
| `lib/session-view-cache.test.mjs` | Merge validity/reference/LRU, one-time byte measurement/release and expiry/invalid-write budget contracts. Same file. | 13 → 3 | 211 → 220 |
| `lib/streaming-message.test.mjs` | Direct block-start and reconnect tool matrices, plus coherent text/thinking and authoritative tool-end sequences. Preserve immutable prior state, tool IDs/raw input and end clearing. Same file. | 11 → 3 | 231 → 84 |
| `lib/transcript-window.test.mjs` | Direct matrices for viewport/overscan/reveal/estimate/tail ranges and prepend/growth/removal/upward anchor adjustment. Same file; exact ranges, heights, offsets and scroll positions retained. | 17 → 2 | 240 → 49 |
| `lib/turn-written-files.test.mjs` | Direct matrices for successful paired calls, error/missing results, aliases, paths/deduplication/prose exclusion and apply_patch applied/moved/deleted/failed/legacy-preview files. Same file. | 18 → 2 | 199 → 48 |

## Material invariant review

- **Accepted state:** pure projection and real hook tests retain stale HTTP and stream rejection, equal-revision hydration/idempotency, same-revision terminal preservation, cross-attachment identity fences, cancelled acquisitions and reconnect adoption. Hook assertions inspect transcript, revision, leaf, history head, failure, model/reasoning, outstanding turns, queue and streamed tools separately.
- **Completion and queues:** exact answered/unanswered/refused notices, shared-answer deduplication, independently answered queued follow-ups, by-ID silent recovery/no resend, handover interests and stream retention/release remain. Terminal/foreground budget tests remain. The hook's real backend oversize refusal still proves that a refused read settles no submission and restores no draft.
- **History:** prefix matrices preserve no-invention, migration, overlap, head rebaseline and idempotency. Reader pagination still reconstructs every entry over compactions for tail sizes 1/3/5/50, checks nonduplicated cursor boundaries, visible-message budgets and raw traffic bounds. Cache and remount tests retain prefix arrays and head markers.
- **Originals and pairing:** deferred reads return full originals, preserve block order and fail the whole restoration when one block is unavailable. Writing-file matrices require matching successful tool-result IDs. Streaming tool calls preserve IDs, partial raw input and authoritative completion; nested tool execution and terminal ordering remain exact.
- **Routing and path boundaries:** project routing keys remain distinct from displayed host folders; forks remain separate families. File reference matrices retain negative sibling-prefix, system/context-edit/store, untrusted tool text/nested MCP/error cases, plus explicit coding calls, spill paths, bash output and valid session IDs. Reader tests retain outside-storage refusal and catalogue symlink behavior.
- **Geometry:** transcript matrices assert exact ranges for distant/inside/adjacent reveal, tall turns, short/empty transcripts and overshot tails. Anchor adjustments retain prepends, growth above/below, missing anchors and distance within a moved turn. Scroll settlement retains distinct completion/cancel/user-input/missing/budget reasons and programmatic-scroll handling.

## Retired source assertions and coverage limits

The deleted `useAgentSession.test.mjs` only read source strings and matched implementation details. It did not execute the user flows its names described. Its lifecycle, transport, queue, partial-message, completion, model acceptance, history and geometry concepts now rely on the executed seams above. Its exact hook/JSX callback wiring, local variable names, absence-of-helper patterns, optimistic-switch statement order, fresh-composer propagation, lazy panels, clone/edit controls, extension-attention wiring, compaction/reload controls and resizable-panel markup are intentionally no longer enforced by source regexes. Pure extension queue, routing and related UI tests are outside this worker's ownership. Do not read this report as claiming a new one-for-one browser or hook execution test for every deleted wiring assertion.

The handoff states that 48 browser scenes plus 11 prefix scenes were already accepted on unchanged product source. This worker reused that parent-supplied evidence and did not rerun or independently revalidate it. The coordinator owns the full unchanged recursive gate, browser evidence, final material review, documentation and graph refresh. This focused result alone does not establish the repository-wide below-500 result.

No generic test collector, alternate registration function, hidden/skipped test, nested subtest count reduction, discovery change or blanket repository-wide test was added. Complex fixtures remain explicit scoped scenarios under named contracts; smaller equal-setup behaviors use direct labelled input rows. The few file growths above pay for labels and immediate fixture cleanup while retaining the original behavioral assertions.
