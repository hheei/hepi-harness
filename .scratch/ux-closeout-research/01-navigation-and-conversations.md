# Navigation and conversation UX closeout

Date: 2026-10-19. Source baseline: clean integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`. Evidence is static source tracing, not a new authenticated browser run. Parent manually checked scout claims; corrections below govern recommendations. Paths below are relative to that integration worktree.

## N1 — Whole-history outline and bounded target jumps (high priority, missing capability)

Journey: find an earlier user message after long work or compaction, using right rail without loading every preceding message.

Evidence: `packages/ui/src/components/ChatWindow.tsx:1075-1079` resolves reveal against loaded `turnModel.turns` only. `ChatMinimap.tsx:23-38,503-589` consumes loaded turns/anchor identities. `packages/ui/src/lib/transcript-window.ts:45-80` reveals within supplied turns. Thus full committed-history anchors are absent from current rail; do not describe ordinary UI as already showing every unloaded marker. A reveal request outside supplied turns also has no target-loading path.

Existing owner: primary `.scratch/history-navigation-research/spec.md`, tickets 01-05. Approved design already requires fork-aware committed user anchors, paged short previews, snapshot-scoped coordinates and bounded around-entry reads, followed by one layout settlement and jump.

Closeout: implement that existing spec through Backend history reads, client transport, hook/navigation owner and rail. Do not implement sequential fetch-until-found as minimap solution: it violates approved no-intermediate-hydration requirement. Route search into same bounded target-window owner while preserving exact block targets.

Acceptance: long conversation, compacted earlier message, inherited fork anchor, append during outline paging; one bounded target read, bounded mounted DOM, no intermediate transcript fetches from animation, explicit stale/unavailable target, outline loading/error/retry state. Existing unresolved technical choice: raw entry blocks versus projected historical target window, to be settled by ticket 01.

## N2 — Search result reachability and truthful failure (high priority, partial implementation)

Journey: click content search result outside loaded history. `ChatWindow.tsx:696-745` currently loops backwards through `loadContext` until entry found or cursor exhausts; this may load many intervening pages. On exhaustion, `onSearchTargetHandled` clears target. `AppShell.tsx:338-341` only clears state, with no visible unavailable outcome.

Closeout: reuse N1 target coordinator and show named loading/failure/cancel/retry states. A failed locate alone does not prove entry belongs to another branch; distinguish unavailable, stale, read failure and paused lookup while session busy rather than claiming a fork mismatch. Offer raw history where appropriate.

Acceptance: deep result lands at exact block within bounded request budget; stale/deleted entry shows explicit result; changing conversation cancels old locate; busy-session deferral does not falsely report success.

## N3 — Cross-conversation reference creation and failed navigation (medium priority, partial implementation)

Journey: explicitly link another conversation/entry, then follow link after target removed. Existing reference protocol/storage/control seam exists (`packages/session/src/control.ts`, references action); `RawHistoryPanel.tsx:254-266` renders stored references, but no ordinary UI creation caller was found. `AppShell.tsx:1082-1097` failed `api.open` only writes console error. This supports missing feedback for uncatalogued target read failures; a catalogued stale target also needs session-load error handling.

Closeout: reference picker/action using existing durable reference owner; explicit conversation-only or entry target and label. Validate target at owner and surface unavailable/deleted versus temporary read error. Do not silently switch to nearest surviving entry. Keep normal reference creation explicit; composer autocomplete is optional design, not assumed requirement.

Acceptance: create reference, reload, follow exact target; deleted target produces actionable message; transient read can retry; inherited/fork entry resolution respects selected conversation scope. Existing research: primary `.scratch/cross-session-references/research.md`. Open choices: entry point for Create reference; conversation-only versus entry default; unavailable label handling.

## N4 — Session load error recovery (high priority for material failures; source-derived)

Journey: selected session fails to load. `ChatWindow.tsx:1313-1319` returns only error text, replacing chat content/composer. `useAgentSession.ts:1023` records a session-load exception; frame refusal can also set error near 1476. Do not generalize every transient SSE disconnect into this state: actual error producers must remain distinct.

Closeout: actionable session-load state with retry/back, preserve appropriate navigation and draft ownership; for errors after previously accepted content, assess keeping valid content visible rather than discarding it. Retry reads through existing hook, not generic resend of pending mutations.

Acceptance: normal session read failure then recovery retains draft and correct identity; oversized/refused projection has named outcome; mutation outcome_unknown retains original request-ID lookup and is never resent by generic Retry.

## Existing capabilities and rejected overclaims

- Subtree selection, confirmation, per-item outcomes and lost-response readback already exist in `SubtreeControlPanel.tsx:20-57`; do not propose a new stop scheduler or one-click emergency cascade that drops confirmation.
- Scout claim that viewing leaf child necessarily hides family control is not established. `AppShell.tsx:263-267` derives family with `getSessionFamily`; `session-family.ts:88-97` resolves root or any child. Agents button is gated by family subagent count at `AppShell.tsx:1776`; subtree panel uses family root at 2350-2368. Parent reviewed these sources. Discoverability can be observed later, but this is not a confirmed missing-control bug.
- Fork at arbitrary transcript entry is already available in Raw History (`RawHistoryPanel.tsx:289-292`). Assistant-row shortcut is optional convenience, not missing recovery capability.
- Child recovery remains native checkpoint/replay semantics. No automatic fork or side-effect retry is part of UX closeout.
- Follow-up scout audit suggested search target reference mismatch; parent rejected as unsupported: `ChatWindow.tsx:739` assigns `setPendingSearchScroll(searchTarget)` without copying, and 1043/1059 pass that same value. AppShell equality guard prevents old settlement clearing a newer target. N2 remains missing unavailable feedback and unbounded sequential locate, not an established object-identity defect.

## Navigation evidence

Parent graph queries: `ChatWindow history minimap navigation` (1000 tokens), `getSessionFamily` (600 tokens). Graph returned owning paths, confirmed in source. Scout supplied targeted source traces across ChatWindow, transcript-window, RawHistoryPanel, AppShell and subtree panel. No runtime code changed.
