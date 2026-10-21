# 05: Loaded-history integration: prefix across reconnect, search, fork, minimap, SDK

**What to build:** history the user already loaded survives a reconnect and a session switch; search hits, fork points and the minimap work for messages that are not loaded; the session SDK does not lose earlier entries when a bounded snapshot arrives.

**Blocked by:** 3 and 4.

**Status:** complete — merged into `integration/perf-follow-up` as `d9775bbbcd6722f6782344d89bead8c844921c5e`
(fast-forward onto `5fdf145`, no conflicts). Reviewer102 approved this pin (48/48 focused tests, the three P2 Spec
findings below closed); product revision `5fb2bdb`. One criterion stays `[~]` — see the closure section.

**Constraint — no compatibility code.** This ticket adds **no** fallback for an older persisted or wire shape: no dual
read, no format sniffing, no optional-field guess. The app reads the new canonical format only. Prefix retention, tail
migration, reconnect and compaction below are **functional contract**, not compatibility. An unknown boundary is a
resync, never a guess. If a persisted record the new format cannot read turns out to exist, the answer is a one-time
conversion script (dry run, backup, transaction) run on the remote host against the native API — reported first with
its old/new owning source and the affected records, and never run against production data as part of this ticket.
Audit of this ticket's planned code and of the durable history path it extends found no existing legacy fallback to
preserve or extend.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `5fdf145` when this landed (`b9b28dd` was the branch point the
first draft was written against).

- [x] The prefix decision is one pure function over ids and the two history facts: kept when the window still follows it, truncated on overlap **by id**, dropped when there is nothing older or when the head marker moved, and kept across an attachment identity change (a new attachment must not discard loaded history). It also **receives** the entries an advancing window evicted while they were already on screen when the prefix is contiguous with them (migration, not deletion), so window movement and loaded history never share a store.
  - `apps/web/lib/history-prefix.ts` (`decidePrefix`) is that function; `packages/session` `prefixOf` is the same rule for the reducer. It decides from the ids, `historyHead` and `hasMore`, and deliberately **not** from `historyRevision`: the stream's own frame type does not carry that token, so a rule keyed on it could not run on an advance, and a read and an advance would disagree about one prefix.
- [x] The history token is unchanged across two reads with no commit, changes on an append, changes on a head marker, is equal for two different attachments of the same conversation, and is **equal after a backend restart on the same store**. — delivered and tested by ticket 04 (`apps/server/src/history-window.ts`); unchanged here.
- [x] A reconnect that returns a fresh tail keeps the loaded prefix instead of discarding it; today's discard behaviour is gone.
  - `apps/web/hooks/useAgentSession.ts` no longer resets the paged prefix on a moved snapshot revision, and the rule runs on every move of the window rather than only on reads. Verified in the browser: `.dev/verify/ticket05-ready/02-e2e-history-prefix.log`, red on the base and green on the pin.
- [~] A search hit outside the loaded window opens at the right message; a fork by id works for an entry that was never loaded; the minimap can request the next page instead of only growing its visible count.
  - Search and fork verified against this pin (`09-ux-session-search.log`, `10-ux-session-fork.log`, both pass). **The minimap half is not implemented**: `revealHistoryForMinimap` still only grows `visibleCount`, and it cannot be made to page without a decision, because the minimap draws its nodes from `messages` alone — it has no way to name a turn that is not loaded, so "request the next page" needs to say *what the minimap shows for the unloaded range* before there is anything to request. Left open rather than guessed.
- [x] The shared session reducer merges a bounded snapshot into what it already holds and exposes `hasMore`, so the SDK and the web app cannot disagree.
  - `packages/session` `mergeWindow`/`advanceWindow`/`prefixOf`; `packages/session/test/loaded-prefix.test.ts` is new and the ticket-04 delta/window tests that asserted eviction for a **paged** client now assert migration. The unpaged case is unchanged and still asserted.
- [x] The token is derived from **public** native primitives only; no private native import is introduced. — no new import was added by this ticket at all; `decidePrefix` takes ids and facts as arguments.

## Review notes

**Reviewer 102 round 1 — 3 P2 Spec findings on `6c8781e`, all fixed.** Verification pack
`.dev/verify/ticket05-fixes/` (`RESULTS.txt`), each with a red-first test:

1. **A complete-range reset kept the prefix.** `prefixOf` migrated evictions unconditionally, so a window stating
   `oldestEntryId: null, hasMore: false` — the whole active range — merged with what was held instead of replacing it.
   A `null` boundary is the one boundary that is not a position: nothing precedes it, so there is nothing for a prefix
   to be behind, and the pages are history the reset dropped. Fixed in `packages/session/src/index.ts`
   (`if (incoming === null) return []`), with a reset-from-paged test. Red: expected `["9"]`, actual `["1","2","9"]` —
   the reviewer's own numbers.
2. **A page could be stamped with a stale head marker.** `historyHeadRef` was written only by an HTTP read, but the
   native head moves on the **stream** too. A reader who paged back after a stream-stated head change recorded the pages
   under the older head the last read had left behind, so the next same-head advance looked like a compaction and deleted
   them. The accepted stream frame now states the head it carries (`useAgentSession.ts`, the `durable_state` fold).
3. **The page-memory cache kept only the bounded window.** `setSessionViewSnapshot` stored the projection's window and
   nothing behind it, so switching away and back lost the pages the reader had loaded. The prefix and the head marker it
   was loaded under are now stored beside the window and restored into the prefix store on mount
   (`session-view-cache.ts`, both cache-write sites, the mount hydration). In-memory runtime cache only — no persisted
   disk format, and no compatibility field.

Verification pack for the base ticket: `.dev/verify/ticket05-ready/`. The browser regression is the load-bearing one:
`apps/web/e2e/ux-history-prefix.mjs` opens a 60-entry conversation, pages back to its first turn, sends a new turn,
and then reconnects the stream — and it **fails on the base** with the evicted turn `"turn 5 of the long
conversation"` missing, which is the defect this ticket exists to remove.

## Closure — approved at `d9775bb`, 2026-10-14

**Reviewer102 approved this pin** — **48/48 focused tests pass**, and all three round-1 P2 Spec findings above are
closed. The product revision is `5fb2bdb`; `d9775bb` is the docs-only tracker commit that follows it.

**Merged.** Fast-forwarded `d9775bbbcd6722f6782344d89bead8c844921c5e` onto `5fdf145` (no conflicts). Product trees at
the merged pin: `apps abfab3ae`, `packages 9d46deb6`.

**The contract is in-memory, and that is the point.** Nothing this ticket adds is a persisted shape, so there is no
older format for it to read and no compatibility code in it:

- the loaded prefix and the window it was loaded under live in the **runtime page-memory cache**
  (`apps/web/lib/session-view-cache.ts`) and in the session state a caller holds — never on disk;
- `decidePrefix` (`apps/web/lib/history-prefix.ts`) and `prefixOf` (`packages/session`) are pure functions of ids and
  the two history facts, keyed on **nothing** about an attachment (`projectionId` is never consulted), which is exactly
  why a reconnect — a new lifecycle clock for the same history — decides the same way;
- an unknown boundary stays a **resync**, never a guess, and a `null` boundary (a complete range) replaces the prefix
  rather than merging with it.

So the no-compatibility constraint recorded at the top of this ticket holds after the fixes: there is still no dual
read, no format sniffing and no optional-field guess, and the one-off conversion-script path has no persisted record to
target.

**Verification.** Reviewer fixes: `.dev/verify/ticket05-fixes/RESULTS.txt` (red-first per finding — reset-from-paged
expected `["9"]` and got `["1","2","9"]`; the stale-head page deletion; the cache that kept only the window), plus the
browser regression `apps/web/e2e/ux-history-prefix.mjs` 11/11, session 20/20, `history-prefix` unit 8/8. Base ticket:
`.dev/verify/ticket05-ready/`, whose load-bearing check is the browser one that fails on the base with the evicted turn
`"turn 5 of the long conversation"` missing.

**Open, not claimed.** The minimap half of the fourth criterion is **not implemented** and stays `[~]` above:
`revealHistoryForMinimap` still only grows `visibleCount`, and it cannot page without a decision about what the minimap
shows for a turn that is not loaded. Recorded rather than guessed; nothing else in this ticket is partial.

