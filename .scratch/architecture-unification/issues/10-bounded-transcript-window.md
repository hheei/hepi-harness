# 10: 生产聊天按视口窗口挂载并保留导航

**What to build:** 用户加载数千条历史后仍能稳定滚动、搜索、用 minimap 定位和切回会话；已加载原文不因卸载丢失。

**Blocked by:** 06, 09

**Status:** done (2026-10-15 UTC; final production navigation verified)

**Spec:** [统一设计](../spec.md) · [审查与分类](../review.md)

## Implementation and corrections

`transcript-window.ts` owns measured heights, corrected scroll position and mounted ranges as one decision. `transcript-window-surface.tsx` uses the sole production turn renderer. Loaded messages, entry IDs and paging cursors remain hook-owned; the window never acquires history itself. Old visibleCount growth and visibility fallback were removed.

Five ordinary-use defects were reproduced through production browser checks before correction:

| Defect | Class | Owning correction |
| --- | --- | --- |
| Reading save queried direct children; restore guessed turn key from entry ID | integration logic error | chat-turn-identity resolves containing turn; ChatWindow captures/restores descendant entries |
| Manual process expansion vanished on window unmount | state ownership defect | ChatWindow owns keyed expansion; ProcessDetailsGroup reads it |
| Tall search target could never satisfy containment; repeated scroll fought reader | navigation completion error | scroll-settlement owns finite visible/aligned arrival and reader-input cancellation |
| Leading history segment made minimap and renderer indexes differ | Interface identity defect | minimap passes anchor entry ID; transcript resolves stable turn identity |
| Unloaded search acquired only one200-entry page | incomplete acquisition | existing ChatWindow navigation loops cancellable hook paging until target/exhaustion |

Settlement distinguishes reader takeover, target unmount and timeout because callers complete or retain reveal differently. Programmatic prepend/measurement corrections do not count as reader input. Existing history-prefix test also caught a window rewrite regression: paging sentinel must remain when either unloaded history or earlier loaded turns exist.

`ux-history-prefix.mjs` now checks loaded entries remain reachable by scrolling back, rather than requiring every loaded entry to remain mounted. This changes its assertion to the approved window contract; data retention and reconnect guarantees remain checked.

## Acceptance

- [x] One measured-height window and one renderer; loaded/paged facts separated from mounted range.
- [x] Prepend anchoring, asynchronous height changes, tail intent and live surfaces verified in browser.
- [x] Search and minimap reach unmounted entries by identity; unloaded deep search acquires multiple pages.
- [x] Manual process expansion survives unmount/remount; session switch reading restoration and reconnect covered in production.
- [x] Deferred original copy/edit/retry and tool-result order remain covered; window does not automatically fetch originals.
- [x] Mounted-turn DOM plateau demonstrated; timings/heap remain observations with limits below.
- [x] Production browser scenes and owning guide `docs/chat.md` updated.

## Final navigation verification — 2026-10-15 UTC

Final production run: `node apps/web/e2e/ux-windowed-transcript.mjs`, exit0,48 checks in `.dev/verify/2026-10-14-ticket10/real-app-reading-view.log`. Prefix/reconnect: `node apps/web/e2e/ux-history-prefix.mjs`, exit0,11 checks in `history-prefix-reading-view.log` beside it. Build: `pnpm --filter @hepi/web build`, exit0, `build-reading-view.log`. These supersede earlier production logs for navigation acceptance.

Three follow-up defects were resolved after the original five review findings:

- Layout value equality prevents allocation-driven React185 loops on return. Ordinary logic error in the window owner.
- An explicit adopted position synchronously cancels a previously queued geometry correction. DOM setter trace proved the stale correction overwrote1006 with6937; final turn offset stays−194px. Ordinary logic error in the existing adoption contract.
- Process expansion travels in the existing reading snapshot, restoring content before placement on session remount. State ownership gap; no separate registry. Final message offset−79→−80px.

Matched-block search, tall-target settlement, abandonment restart, minimap identity, multi-page search and bounded mounting pass in the48-check run. All temporary scroll instrumentation removed; page errors are emitted immediately by the permanent driver. Final Web suite:2381 tests,2365pass/16 historical failures, exact names unchanged; see [11](11-integrate-verify.md).

## Earlier verification (historical source)

Source: HEAD1758c1fb4479e9d4637a957857246c5998619d73, dirty integration/architecture-unification. Commands below run from apps/web unless specified. Original logs under root `.dev/verify/2026-10-14-ticket10/`. These are working-tree observations, not a clean revision comparison.

| Check / command | Exit | Raw log |
| --- | --- | --- |
| Production36 checks, `node e2e/ux-windowed-transcript.mjs` | 0, repeated0 | real-app-fixes13.log, real-app-fixes15.log |
| Fixture68 checks, `node e2e/window-experiment.mjs --keep` | 0 | experiment-fix.log |
| Existing minimap, `node e2e/ux-visible-turns.mjs` | 0 | ux02-final2.log |
| Existing search, `node e2e/ux-session-search.mjs` | 0 | search.log |
| Existing deferred originals, `node e2e/ux-deferred-text.mjs` | 0 | deferred.log |
| Existing prefix/reconnect, `node e2e/ux-history-prefix.mjs` | 0 | history-prefix4.log |
| Production build, root `pnpm --filter @hepi/web build` | 0 | build-fix4.log |
| Final root `pnpm verify:changed` | 1, only16 known Web failures | ../2026-10-14T19-50-53-352-verify-changed/verify.json |

Final recursive Web runner reports2379 tests:2363pass/16fail, exactly16 historical failure names; root typecheck, workspace tests, script tests, docs and entrypoints exit0. Earlier non-recursive Web counts are historical and are not final verification. Exact failure comparison is `.dev/verify/architecture-unification/final-known-set.json`.

## Limits

Single huge turns mount whole. Minimap still draws one node per turn (~4000 elements at2000 turns). Loaded prefix data remains retained: DOM bounds do not establish heap bounds. Timings and heap from the fixture were observational, without enforced latency thresholds or normalized post-GC candidate comparison; they are not performance acceptance proof. Functional browser checks and mounted-turn DOM plateau are the acceptance evidence. See [09](09-dynamic-window-proof.md) and [recorded limits](../review-notes.md).

**Blockers:** none; final cross-ticket acceptance belongs to [11](11-integrate-verify.md).
