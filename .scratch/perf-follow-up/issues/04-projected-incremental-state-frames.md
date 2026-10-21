# 04: Projected incremental state frames

**What to build:** each turn's stream frame carries only what changed, so turn 200 costs roughly what turn 10 costs, while redaction and the lifecycle contract stay exactly as they are.

**Blocked by:** 3 (the bounded window is what a delta continues; without it a delta frame would still carry an unbounded baseline).

**Status:** complete — merged into `integration/perf-follow-up` as `96c10b75efb08ba4d79a8cbfa849dc19e639a0fe`
(fast-forward onto `b5542ce`, no conflicts). Reviewer100 approved this pin (Standards 0, Spec 0); each check below
states the revision it was taken at. Implemented on `impl/perf-04-incremental`; branch point `98e0448` (ticket 03
closed and merged).

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `96c10b7`.

- [x] After the baseline, a turn's frames carry `baseRevision` = previous revision and only the appended entries plus every scalar and the window bookkeeping (`oldestEntryId`, `hasMore`), and `revision` advances by exactly one per frame. — `apps/server/test/delta-frames.test.ts` "after the baseline, an advancing frame carries only what it appended and the window bookkeeping": every advancing frame is asserted against its predecessor, the frame's key set is asserted to be the snapshot's own scalars plus the two continuity fields, a frame that appended nothing is present, and the appended entry is byte-identical to `GET /entries/:id`.
- [x] **Eviction rides the frame and prunes the window, not the loaded history** — the frame carries the new `oldestEntryId`/`hasMore`, and the client prunes its **tail** to it. `packages/session` `applyDelta` prunes the held tail to the frame's own boundary before extending it and keeps everything below it, so the transcript the SDK holds is exactly the transcript a snapshot fold would hold; `apps/web/adapters/durable-api.ts` `foldFrame` applies the same rule at the one place that owns a frame boundary, so the surface downstream still receives one complete projection. The prefix store the user paged in is a separate store the window never prunes (ticket 05 owns migration into it), and nothing asserts that the total a user loaded is bounded.
- [x] **Equality after eviction** — `packages/session/test/delta.test.ts` "folding a random commit sequence past the raw cap equals folding snapshots only, over the window and the scalars": 40 seeded random advances (including scalar-only frames) compared **entry for entry over the whole held transcript** and over every scalar. The whole transcript is the assertion, not a tail filtered out of it: an append without the trim keeps entries the snapshot fold has already dropped, and that is the difference this has to see. `apps/server/test/session-reducer.test.ts` repeats the equality against a **running backend's** own bytes.
- [x] **Exact-base gate** — the same suite's "a delta whose base is not the current revision is rejected and asks for a fresh read" (stale and out-of-order), and the adapter's own behavioural case "a frame the stream cannot continue is answered with a fresh bounded read and the backend's own resync marker" (`apps/web/adapters/durable-lifecycle.test.mjs`), which asserts the published bytes: `durable_resync` plus a re-read, and the stale revision never applied.
- [x] A head-marker change arrives as a whole-window frame, never as a delta. — `continuationIndex` in `apps/server/src/history-window.ts` is the rule, asserted at its own seam (`apps/server/test/history-window.test.ts` "the advancing-frame rule continues a window, and restates it when the head marker moved or it was cut away"), behaviourally for a window that already starts at a marker (`delta-frames.test.ts` "a window that starts at a head marker is continued by the advancing frames, not restated"), and end to end against the runtime's **real** compaction policy (`delta-frames.test.ts` "a compaction that moves the head marker re-baselines the window instead of continuing it": the frames before the marker are appends, the frame that carries it states the whole window and continues no revision, and the frames after it continue again).
- [x] A frame the client cannot continue produces a **fresh bounded snapshot** and `resync_required` with nothing replayed, and an outstanding turn is then settled **by request id**. — the adapter case above; the by-request settlement path is the delivered `recoverPendingTurns` (ticket 03), reached from the same `durable_resync` the adapter emits.
- [x] Redaction holds identically on the baseline, a page and a delta append, through the one shared projection expression. — `delta-frames.test.ts` "redaction holds on an appended entry exactly as it does on the baseline" asserts the credential value on no frame and the same redacted message on the append, the window and `GET /entries/:id`.
- [x] Chord operation passthrough is not used as a wire format; no raw entry record or raw live document reaches the wire. — the advancing frame's key set is asserted to be the snapshot's own scalars plus `baseRevision`/`appended`, every entry goes through `projectEntry`, and `appendedEntries` **reads** the runtime's ops for one structural fact and never re-encodes, stores or forwards them (`history-window.test.ts` "the native ops say what an advance appended, and anything else says the window must be recomputed").
- [x] The server keeps no per-client cursor, buffer, ack or epoch. — the continuity test is on two windows (`continuationIndex(previous, next)`), and `publish` keeps one `written` window for the attachment rather than per client.

## Comments

**Where each rule lives.**

- `continuationIndex` and `appendedEntries` sit beside the window rule in `apps/server/src/history-window.ts` because
  all three are pure functions of entries; `frameFor` in `apps/server/src/server.ts` is `continuationIndex`'s only
  caller. `written` is the window the clients really hold — a frame refused for size is not written and therefore not
  remembered, so `baseRevision` stays exact across a refusal.
- `WindowProjector` is the window **kept** rather than rebuilt: an append-only advance projects only what it appended
  and advances the window's count, bytes and first index; the history token's two facts advance from the same entries
  (`advanceHistoryFacts`); a head marker, a truncation, a replacement or an overflow's root replace recomputes both
  from the view. Its seam is asserted by counting projections (`history-window.test.ts` "an append-only advance
  projects only what it appended, and a recompute projects the window"), and the state it keeps is bounded by the window
  itself, so a long conversation costs no more of it than a short one.
- The frame is measured **as it will be written** (`oversizeFrame(frame, ...)`), not as the snapshot it came from: an
  advance whose appended entry fits still publishes, and an advance that does not is stated by name with the entry still
  readable by id. `delta-frames.test.ts` "an advance whose appended entry cannot be carried states the refusal, keeps
  the stream, and leaves the entry readable" is the case.

**The tests that read a transcript off the stream.** The stream states its window once, so the server tests that read
entries out of `state` frames fold them the way a client does, through `apps/server/test/stream-window.ts` — which
folds with the **shared reducer a real client uses** (`@hepi/session`) rather than a second copy of the rule.
`apps/server/scripts/perf-history-scaling.mjs` folds the same way and asserts the advancing-frame contract as
behaviour.

**Measured.** `node apps/server/scripts/perf-history-scaling.mjs` at `ab9bd8d`: bytes per turn 720.7 / 724.8 / 725.7 /
725.8, largest frame 1,039 / 1,045 / 1,046 / 1,047 bytes, first load 9,101 / 22,666 / 22,786 / 22,817 bytes at 10 / 60 /
120 / 240 turns. Bytes per turn, the largest frame and the first load are all flat from 60 to 240 turns, against lane B's
recorded 5,524 → 152,175 bytes/turn. `contiguous` and `reSerialized: false` hold at every size, the appended entry
matches the single-entry read at every size, and the reconnect check (a fresh bounded baseline naming the same history,
continued by the frames after it with no gap) holds at every size. `failures: []`.

## Evidence

### Slice close — `ab9bd8d` (clean tree), 2026-10-14

Tied to the revision and date it tested: **`ab9bd8d` (clean tree), 2026-10-14**, worktree
`.dev/worktrees/perf-04-incremental`. This is the block the slice was closed on; the block below it is the
review round that followed.

| Check | Command | Exit | Raw log |
| --- | --- | --- | --- |
| workspace typecheck + tests | `node scripts/verify.mjs --profile=fast --log-dir=/tmp/t04i-v2` | 0 | `/tmp/t04i-v2/workspace-typecheck.log`, `/tmp/t04i-v2/workspace-tests.log` |
| server suite | (inside the above) `apps/server` 280 tests, 280 pass, 0 fail | 0 | same |
| session suite | (inside the above) 13 tests, 13 pass, 0 fail | 0 | same |
| gateway suite | (inside the above) 167 tests, 167 pass, 0 fail | 0 | same |
| history-scaling benchmark | `node apps/server/scripts/perf-history-scaling.mjs --json=/tmp/t04i-perf3.json` | 0 | `/tmp/t04i-perf3.log` |
| whole-web suite, compared to the branch point | `pnpm compare:tests --base=98e0448` | 0 — base 2,238/2,216/22, tip 2,250/2,228/22, **identical failure set, 0 new, 0 gone** | `/tmp/t04i-compare2.log` |
| docs links | `node scripts/check-docs.mjs` | 0 — 178 files, 0 broken | — |

The whole-web run is **not** green and is not claimed to be: 22 tests fail on the branch point and on this tip alike,
with the same names (`docs/verification.md` records that baseline). What the comparison establishes is that this slice
adds 12 passing tests and no new failure.

The frame-budget exception is asserted as behaviour, not as a byte ceiling: `delta-frames.test.ts` "an advance whose
appended entry cannot be carried…" is the case where a multi-megabyte **text** output has no read block to defer to, and
what is asserted is the named refusal, the stream staying open, and the entry remaining readable whole by id.

### Review round 1 — `dcedf07` (clean tree), 2026-10-14

| Check | Command | Exit | Raw log |
| --- | --- | --- | --- |
| workspace typecheck | `pnpm -r typecheck` | 0 | `/tmp/worker04-tsc-final.log` |
| server suite | `apps/server` `node --test` — 283 tests, 283 pass, 0 fail | 0 | `/tmp/worker04-server.log` |
| session suite | `packages/session` `node --test` — 16 tests, 16 pass, 0 fail | 0 | — |
| adapter + hook suites | `apps/web` `node --test adapters/*.test.mjs hooks/*.test.mjs` — 227 tests, 226 pass, 1 fail (baseline `near an edge the list scrolls…`) | 1 | — |
| history-scaling benchmark | `node apps/server/scripts/perf-history-scaling.mjs` — `failures: []`, bytes/turn 720.7 / 724.8 / 725.7 / 725.8, largest frame 1,039 / 1,045 / 1,046 / 1,047 B | 0 | `/tmp/worker04-perf-final2.log` |
| whole-web suite, compared to the branch point | `node scripts/compare-tests.mjs --base=98e0448` — base 2,238/2,216/22, tip 2,256/2,234/22, **identical failure set, 0 new, 0 gone** | 0 | `/tmp/worker04-compare-final.log` |
| docs links | `node scripts/check-docs.mjs` | 0 — 178 files, 0 broken | — |
| reviewer wire repro | `REVIEW_ROOT=<worktree> node /tmp/review04-wire-repro.mjs` (copy placed in `apps/server`) — both cases `exactSdk`/`exactWeb` true, counts 50/50 | 0 | `/tmp/worker04-wire-after.log` |
| reviewer live repro | `REVIEW_ROOT=<worktree> node /tmp/review04-live-repro.mjs` — `webLiveAfterIdle: null` | 0 | `/tmp/worker04-live-after.log` |

Red-to-green was checked per seam by running the new tests against the **old** sources: the three adapter/hook cases
fail on the committed `durable-api.ts` (3 of 17), the reducer cases fail on the committed `packages/session`
(6 of 16), and the real-backend marker case fails on the committed reducer (1 of 4). The old oracles were then
replaced, not kept beside the new ones.

The whole-web run is still **not** green, and is not claimed to be: the 22 failures are the branch point's own, by
name. What the comparison establishes is that this round adds 18 passing tests and no new failure.

## Review notes

### Review round 1 — the fold, re-pinned at `dcedf07` (clean tree), 2026-10-14

Three findings, each a fold that guessed where it should have read. None of them was a wrong assertion in the
product; two of them were **wrong oracles in this ticket's own tests**, which is why the fix replaces the assertions
instead of adding to them.

1. **The adapter resurrected a transient the frame had dropped.** `foldFrame` spread the projection it held and then
   the frame's scalars over it, so a live message the backend had already finished with stayed in the published
   projection and the surface stayed "streaming" forever. The fold is now built from the frame's own scalars, with
   absence authoritative; `submissions` — the set the backend states on **every** frame — is the one value kept from
   the held projection when a frame does not mention it. Asserted at the seam that publishes it
   (`adapters/durable-lifecycle.test.mjs` "an advancing frame's own scalars replace the held ones…", and "an absent
   outstanding set is not read as a settlement…" which is red without that one fallback) and at the surface that reads
   it (`hooks/useAgentSession.lifecycle.test.mjs` "the frame that states no live message is what ends the streaming
   surface"). The reviewer's own `/tmp/review04-live-repro.mjs` reproduces the leak against the old adapter
   (`webLiveAfterIdle.stopReason === "pending"` while a fresh read states none) and reports `null` against this one.
2. **The window was trimmed by id, and a head marker carries the newest id while sitting first.** Both folds
   (`packages/session`'s reducer and the adapter's) kept the summary after the window had moved past it, so a client
   held 51 entries where a fresh read held 50. Both now trim at the boundary's **position** in the native order, and a
   boundary this client does not hold anywhere is answered like a revision gap — a fresh bounded read — rather than by
   guesswork. Asserted against the real backend's own bytes (`apps/server/test/session-reducer.test.ts` "a window that
   moves past a compaction summary drops it, exactly as a fresh read does" — the marker fixture reaches the boundary in
   about three turns because the entries are sized to the frame budget), and at the adapter seam
   (`adapters/durable-lifecycle.test.mjs` "the window boundary is a position in the native order…", "a boundary this
   stream does not hold asks for a fresh read…").
3. **The reducer unioned a tail the stream itself had accumulated.** `mergeWindow` treated entries below the new
   boundary as a prefix the caller had paged in, so an unpaged client grew past its window (52 held against 50 fresh).
   `advanceWindow` now splits at the boundary position and takes the prefix only up to the entry it already held;
   `windowStart`, `prefixOf` and `extendWindow` replace `mergeWindow`/`applyDelta`. The wrong oracle — a random
   union — is replaced by fresh-baseline equivalence (`packages/session/test/delta.test.ts`,
   `test/window.test.ts`).

**One change beyond the three.** The adapter's HTTP read of a window the backend refuses threw a bare
`DurableBackendError`, so a caller that read rather than streamed saw a failure for an outcome the backend had already
explained by name. `readRefusal` forwards the backend's own status and body on the conversation read paths, which is
what makes the frame-size limit assertable end to end (`hooks/useAgentSession.lifecycle.test.mjs` "a real backend's
refusal to carry a window reaches this surface by name, and settles nothing"): a real backend, a real adapter, this
surface — `413` with `reason`/`entryId`/`bytes` on the read, `durable_state_oversize` on the stream, no baseline,
the turn left outstanding, and nothing restored.

**The reviewer's own repros.** Run against this revision, with the originals preserved at `/tmp/review04-*`:
`/tmp/review04-wire-repro.mjs` reports `exactSdk: true`, `exactWeb: true`, `sdkCount: 50`, `webCount: 50`,
`sdkHasMarker: false`, `webHasMarker: false` and `gaps: []` for both cases (was `52/51` and `51/51` with
`exactSdk: false`, `exactWeb: false`). `/tmp/review04-live-repro.mjs` reports `webLiveAfterIdle: null` matching a
fresh read. `/tmp/review04-live-fold.mjs` was a probe of the reducer dispatch, not of the surface: its assertion that
`webLiveAfterIdle` is a message cannot hold once the adapter stops publishing a message the frame did not carry, so
its subject is now asserted at the surface itself (the test named above) rather than through a probe.

**Tree state at handoff, and its resolution.** Two files were dirty in this worktree and were **not** this
ticket's: `apps/server/test/conversation-heartbeat.test.ts` and `packages/gateway/test/terminal-heartbeat.test.ts` —
agent95's own superseded ticket-01 test hunks, which also made `packages/gateway`'s suite hang with them in place.
Worker97 backed both diffs up and restored the two paths from `HEAD` at 11:10:17+0800; agent95's guard re-checked at
11:10:27 and found the tree already clean, so it wrote nothing. The measurements in this section were taken with them
present; the clean fast run in the closure section below is the one taken without them.

## Closure — approved at `96c10b7`, 2026-10-14

**Reviewer100: Standards 0, Spec 0.** The three findings above are the whole of it — the adapter's held-projection
spread, the id-based trim that kept a compaction summary sitting first, and `mergeWindow`'s union of an unpaged tail.
One adjacent change rode along: the adapter's HTTP read of a window the backend refuses now forwards the backend's own
status and body (`readRefusal`), which is what makes the frame-size limit assertable end to end. An oversize **text**
hook stays preserved upstream, pending.

**The reviewer's own repros against this revision** (originals kept at `/tmp/review04-*`): `exactSdk: true`,
`exactWeb: true`, `sdkCount: 50`, `webCount: 50`, `sdkHasMarker: false`, `webHasMarker: false`, `gaps: []`, and
`webLiveAfterIdle: null` matching a fresh read — the live-surface behaviour asserted at the surface itself
(`hooks/useAgentSession.lifecycle.test.mjs`) rather than through a probe. Its focused runs are the independent logs
`/tmp/review04-correction-{session,server,web}.log`, **52/52** across the three.

**Clean fast validation, 2026-10-14 UTC.** `.dev/verify/2026-10-14T03-10-54-910-verify-fast/verify.json` (raw log
`/tmp/worker04-verify-fast-clean96.log`): `sha 96c10b75efb08ba4d79a8cbfa849dc19e639a0fe`, `dirty: false`,
`ok: true`, both steps exit 0 — `workspace-typecheck` with no errors, and `protocol 47 / client 9 / session 16 /
gateway 167 / server 281`, every one `fail 0`. **Scope, stated exactly:** the fast profile covers those packages only;
the Web app has no test script in it, so the Web side rests on the reviewer's focused 52 above plus the unchanged
whole-web baseline (22 named failures, the same set at `98e0448` and at this tip). Fast numbers taken earlier with
the stray files present are **not** claimed here.

**Merged.** Fast-forwarded `96c10b75efb08ba4d79a8cbfa849dc19e639a0fe` onto `b5542ce` (no conflicts) — the
integration tip now carries this pin, whose product trees are `apps e1422f00`, `packages 474a4cb8`, unchanged from
the reviewed `dcedf07`.

**The stray files, resolved.** They were agent95's own superseded ticket-01 test hunks (stash commit
`288487f0534bcf53090c7dbcf93d1be628712f9c`). Worker97 backed both diffs up and restored the two paths from `HEAD` at
11:10:17+0800; agent95's pre-write guard — which had preserved the exact patch first — re-checked at 11:10:27 and
found the tree already clean, so it wrote nothing. No mystery actor was left outstanding. The superseded content is
preserved at `.dev/verify/ticket04-stray01-preserved.patch` with its sha256 and provenance in
`.dev/verify/ticket04-stray01-NOTE.md`; `.dev/verify/t01/uncommitted-owner-agent95.patch` and the dangling commit are
untouched. Nothing was lost, and nothing from it was revived.


