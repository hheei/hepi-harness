# 03: Bounded history window, older pages, and the per-entry read blocks

**What to build:** opening a long conversation loads the newest messages only, scrolling up loads older pages on demand, and thinking text / tool-result images load when expanded instead of riding the initial payload.

**Blocked by:** None (can start immediately).

**Status:** complete — merged into `integration/perf-follow-up` as `385abbdbe5b9fa92e12e79c07b0973db1f965520`
(fast-forward onto `0b527de`, no conflicts). Implemented on `impl/perf-history-03`; reviewer100 approved at Standards 0
/ Spec 0 after the six public-seam defects below were fixed at `97fea73`.

Context pointers: [SPEC](../spec.md) (approved), [DESIGNHISTORY](../design-history.md),
[DESIGNSSH](../design-ssh.md), [DECISIONS](../decisions.md), [TICKETPROPOSAL](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `0b527de` when this landed (`52b0131` was the branch point the
first draft was written against).

- [x] A long conversation's baseline read, its first stream frame and `GET /state` carry at most the window (50 visible
      messages, raw-entry cap) with a real `hasMore` and a real oldest id; a short conversation carries everything with
      `hasMore` false. `apps/server/test/history-window.test.ts` "a long conversation's baseline read carries the window".
- [x] The window's oldest id and `hasMore` are published on every surface that returns a window, so a consumer can trim
      to the server's window instead of growing its own transcript. The baseline derives `oldestEntryId` from `entries[0].id` and the
      page states it explicitly; the adapter forwards both and no longer hardcodes `hasMore` false
      (`apps/web/adapters/durable-api.test.mjs` "the window the backend publishes is forwarded, not synthesized").
- [x] No unbounded mode is added to the state route: a consumer that needs everything pages. The state route answers the window
      and the only other read is the entry-id page route.
- [x] Paging backwards from the tail reproduces exactly the entry-id set an unbounded read would return, never repeats
      the boundary entry, and never crosses a head marker. `apps/server/test/history-window.test.ts` "paging backwards reproduces exactly" and "a page
      never crosses a head marker".
- [x] A paged entry and a streamed entry are identical, redaction included. One `projectEntry` expression serves the
      window, the page and the single-entry read; `apps/server/test/history-window.test.ts` "redaction holds identically on the window, a page and a
      single-entry read".
- [x] One entry can be read by id: a projected, redacted entry; unknown id 404; out-of-range block index 400; an image
      outside the mime/size policy refused with an actionable message. `apps/server/test/history-window.test.ts` "one entry is readable by id" and
      "a tool-result image inside the policy".
- [x] A frame that would still exceed the transport's own limit yields an **actionable error** for that read, never an
      endless resync loop and never a silently truncated transcript that claims completeness. `apps/server/test/frame-size.test.ts`: HTTP 413
      with REASON `frame_too_large`, the `entryId` and its `bytes`; the stream emits `state_oversize` and stays open, and a later
      commit publishes normally on the same connection.
- [x] An entry whose content cannot be deferred ships whole and is recorded as a limit; when the newest entry cannot be
      brought inside the transport limit at all, that read answers with an **actionable error** and the entry stays
      retrievable through its full-entry read. `apps/server/test/frame-size.test.ts` asserts the whole 1.76 MB tool-result text is still served
      by `/entries``entryId` after the 413; the limit is recorded in `docs/chat.md` and `docs/migration-status.md`.
- [x] A benchmark at 10/60/120/240 turns asserts flat bytes-per-turn and a bounded first load against lane B's recorded
      numbers, with the soft-target exceptions asserted as behaviour rather than a hard byte ceiling.
      `apps/server/scripts/perf-history-scaling.mjs` passes: bytes per turn 22,521 -> 22,669 (flat), largest frame 22,496 -> 22,645 (flat), first load
      22,644 -> 22,795 bytes against lane B's 152,175 bytes/turn and 4.7 MB at 197 turns, paging reaches all 722
      entries with no repeat.

## Comments

**What changed, and where.**

- `apps/server/src/history-window.ts`: the window rule (`VISIBLE_WINDOW` 50, `rawWindowCap` 300), the soft `FRAME_TARGET_`bytes`` with the
  transport's own `FRAME_LIMIT_`bytes`` margin, the budget shrink, the lossless history deferral (thinking preview plus
  dropped provider signature, tool-result image to a read-block URL), the catalogue counters, and the native
  `historyToken`/`headMarkerId` over committed immutable facts.
- `apps/server/src/server.ts`: `projectEntry` is the one projection expression (window, page, single entry), `projectWindow` selects the
  suffix before projecting, `publish` states an uncarryable frame instead of writing it, and the routes are
  `/entries` (page), `/entries``entryId` (read block), `/entries``entryId`THINKING and `/entries``entryId`TOOLRESULTIMAGE. The catalogue
  row's count and first message now advance incrementally instead of re-reading a transcript that is no longer held in
  one piece.
- `packages/protocol`: the tool-result image policy and the two read-block URL builders moved here from two Web copies.
- `apps/web/adapters/durable-api.ts`: forwards `before`/`tail` onto the page route, forwards `hasMore` and `oldestEntryId`, proxies the two read blocks
  (bytes for the image), and carries the history token as `snapshotRevision` so the view cache can be keyed on it.
- `packages/session`: `reduceSseFrame` merges a bounded snapshot into what it holds instead of replacing it, and
  SESSIONSTATE gains OLDEST`entryId`/`hasMore`.

**Deferred and not done here.** The delta frames, the exact-base gate and the tail-store eviction are ticket 04's; the
loaded-prefix policy across reconnect and the search/fork/minimap surfaces are ticket 05's. The window facts this
ticket publishes are the ones a delta continues, so 04 can start from them unchanged.

**Evidence.** Branch `impl/perf-history-03`, worktree `.dev/worktrees/perf-history-03`.

- `node scripts/verify.mjs --profile=fast` **PASS**, exit 0, at `7b778aa` (dirty tree: the
  ticket text below was still being written). workspace-typecheck exit 0, workspace-tests exit 0.
  Raw log: `.dev/verify/2026-10-13T17-11-45-016-verify-fast/`.
- `node --test apps/server/test/history-window.test.ts apps/server/test/frame-size.test.ts
  apps/server/test/conversation-heartbeat.test.ts packages/session/test/window.test.ts
  apps/web/adapters/durable-api.test.mjs apps/web/adapters/stream-heartbeat.test.mjs` — **41 tests, 41 pass, 0 fail**.
  This is the pinned seam check: ticket 03's own suites plus ticket 01's two heartbeat suites, run together after the
  merge that put both on one `send()`.
- Whole-web suite: `node scripts/test-web-unit.mjs --quiet` — **2,236 tests, 2,214 pass, 22 fail**; the 23
  failing names are exactly the recorded pre-existing baseline (module-load failures plus the leaf assertions listed in
  `docs/verification.md`), with no new name.
- Benchmark: `node apps/server/scripts/perf-history-scaling.mjs` exits 0, `failures: []`.
  bytes/turn 9,467 (10) / 22,521 (60) / 22,642 (120) / 22,670 (240); largest frame 9,737 / 22,496 / 22,617 / 22,645;
  first load 9,080 / 22,644 / 22,764 / 22,795 bytes; paging reaches 32 / 182 / 362 / 722 entries with no repeat.
  Against lane B's recorded 5,524 -> 152,175 bytes/turn and 4.7 MB first loads at 197 turns.
- Ticket 07's seam is untouched by this branch and still passes on the merge: `node --test
  packages/gateway/test/controlmaster.test.ts` — 9 tests, 9 pass, 0 fail.

**Merge state.** The branch carries `integration/perf-follow-up` twice: `b05c7f6` (product merge;
only the two imports and the two helpers beside `send()` conflicted, and both sides were kept) and the
integration tracker tip `453152c` (docs only, no product source overlap). Ticket 01's origin writers and
proxies and ticket 07's managed-master seam are unchanged.

## Review notes

reviewer100 reviewed the six public-seam defects and approved the corrections at Standards 0 / Spec 0. The behavioral
proxy and hook pending-refusal tests are accepted scope; the original oversize diagnostic now observes a conversation
that fits, so its refusal forwarding is asserted by the adapter test rather than by that scenario. A public BIGTEXT
frame-size case is in progress with 97 and, if it lands, is verification recorded on the callback — not a new product
loop here.

**Source identity at the merge.** The merged tip `385abbd` is `97fea73` (the fix) with the approved ticket 06 close
`0b527de` merged in. Ticket 03's own product is unchanged by that merge: `git diff 0b527de 385abbd -- apps packages`
shows only the ticket 03 files, and the ticket 06 side is docs/tracker plus the already-approved gateway fix. Product
trees at `385abbd`: `apps` `c3cee1e4`, `packages` `fd8f312f`. No re-run of the 53-test seam or the whole-web suite
was needed, because no source changed between `97fea73`'s measurement and the merge.

## Correction review (reviewer 100, six confirmed public-seam defects)

100's independent review found six defects at `bd7059a`, all confirmed against the running backend by its two public
diagnostics (`/tmp/review03-public-repro.mjs`, `/tmp/review03-page-repro.mjs`; exit 0 means the reproduction ran, not
that anything passed). Each is fixed at the seam that owned it, not at the caller:

1. **A user's own accepted image was not deferred.** `deferHistoryMessage` ran the image policy for a tool result only,
   so a 1.44 MB prompt PNG rode the frame inline, the submit's own `/state` answered 413, and the read block it then
   named answered 404. The policy now belongs to the message that carries the image, whatever its role — including a
   mixed prompt (text and an image in one user message) — and the read block serves any entry's image block.
2. **The stream's oversize refusal was swallowed by the Web adapter.** `durable-api.ts` recognised only `snapshot`/`state`,
   so `state_oversize` reached nobody and the surface waited forever for a baseline. It is now forwarded as the named
   `durable_state_oversize` event, and the hook shows it as a visible error. Nothing is settled, restored or resent:
   the outstanding set stays the projection's own authority, and a window that does arrive clears exactly that message.
3. **Paging missed a head marker.** The page was an id-ordered storage scan, but the native view keeps the marker
   first while its id is *newer* than the entries it keeps, so a compaction summary was unreachable (200 of 201 active
   entries). Paging is now a slice of the native active range in the runtime's own active order: the summary is
   reachable exactly once, nothing is duplicated and nothing the context dropped is paged back.
4. **The baseline did not state its own boundary.** `/state` and the stream's snapshot published `hasMore` but no
   `oldestEntryId`, so the reducer's merge had nothing to merge on and a session holding 100 entries collapsed to 50.
   The window's boundary is now derived from the entries it is publishing (`null` when it is the whole active range), the
   wire type requires it, and a frame that does not state one asks for a fresh read instead of guessing "complete".
   The fabricated wire-only reducer test is replaced: `apps/server/test/session-reducer.test.ts` folds the bytes of a
   **running** backend.
5. **The read blocks resolved an entry by global id.** `tx.entry(id)` serves another conversation's entry with 200.
   They now resolve through the conversation's fork-aware history, so a foreign id is 404 while an ancestor entry a
   fork inherited is served.
6. **A page skipped the hard refusal.** The window answered 413 for an entry it could not carry while `/entries` handed
   back the same 3.5 MB as a 200 page with `hasMore: false`. Every surface that returns a window now asks the one
   `oversizeFrame` question, so the page answers the same named `frame_too_large` reason, and the entry stays readable
   whole through `/entries/:entryId`.

Advisory taken as recorded, not as an optimization: `historyRevision` is a comparison over the attachment's own
active-entry array — no storage read, but CPU proportional to the active range on every publication. The claim is
qualified in `apps/server/src/history-window.ts` and recorded in `docs/chat.md` and `docs/migration-status.md`.

**Corrected outcomes, from 100's own diagnostics.** `COMPACTION` seen 201/201 with the head found and no duplicates;
`SDK` wireOldest a real id, 100 held entries kept through the snapshot; `ENTRY_SCOPE` 404 on the foreign entry, thinking
and image blocks; `USER_IMAGE` submit 202, `/state` 200 with the image behind a URL (no base64 inline) and the
read block 200. `OVERSIZE_PROXY` now observes a conversation that fits, so its first frame is `connected` and there is no
refusal in that scenario to forward; the forwarding itself is asserted by the new behavioral adapter test against a
real upstream that emits `state_oversize`. The page diagnostic now ends in a TypeError because the page it reads is a
413 refusal with no `entries` array — the corrected behavior; the refusal is asserted in
`apps/server/test/frame-size.test.ts`. Logs: `/tmp/review03-public-correction.log`, `/tmp/review03-page-correction.log`.

**Acceptance fixtures added** (red before the fix, green after): four in `apps/server/test/history-window.test.ts` (accepted
user image, stated baseline boundary, native-order paging, fork-aware read blocks), one in
`apps/server/test/frame-size.test.ts` (page refusal), `apps/server/test/session-reducer.test.ts` (real server contract),
one behavioral proxy case in `apps/web/adapters/durable-api.test.mjs` and one in
`apps/web/hooks/useAgentSession.lifecycle.test.mjs`.
