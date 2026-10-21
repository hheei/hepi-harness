# 05 - System acceptance and guide sync

Status: **delivered and accepted on this line** (2026-10-20). The source was delivered on
`impl/history-navigation-04` at `a8b1f8f` and **integrated** by cherry-picking exactly its seven commits
(`5eea65d`/`5b01ec6`/`33f8389`/`a0958a2`/`ed0e4a1` plus the two records `96e7ae0` and `a8b1f8f`) onto the then-tip
`c1299df`, where ticket 04 had already arrived at `0d66ff1` — so no ticket-04 commit was re-picked. Its record reached
this line at `a0caf5d`. Blocked-by 04 is satisfied at `7116eaf`, and the acceptance gate below is closed by the
82 browser checks re-measured on the integrated tree, not by the ticket's own branch run. See the record below and, for
the pick itself, [verification](../../../docs/verification.md#how-history-navigation-ticket-05-arrived-on-this-line-2026-10-20).
Blocked by: [02](./02-bounded-target-window.md) (resolved), [03](./03-navigation-jump-coordinator.md) (delivered — its client evidence is unit and real-HTTP only, which is exactly the browser seam this ticket owns), [04](./04-full-history-rail.md)

The target read and its named outcomes arrive here already asserted at all three seams (contract, route, relay) — see
[ticket 02](./02-bounded-target-window.md). The `stale` and `missing` journeys run without changing them, and the
client-held outcomes (`cancelled`, `deferred-busy`, read `error`) are observed here through 03's coordinator, which is
integrated. N1's byte rule is closed by 02 and recorded there; the journeys assert it end to end rather than
re-opening it.

Run focused server/Web tests and browser journeys for long history, compaction, fork inheritance, append during navigation, stale coordinates, smooth target placement, bounded DOM/request counts, and deep exact-block search. Each unresolved lookup outcome must be observed separately: stale target, missing entry, cancelled by conversation switch, deferred while busy, and read error. Record that no journey ends with a silently handled failure.

Search acceptance in this ticket is the same bounded coordinator as the rail: one target read per deep result, exact block placement, no sequential page walk, and a named outcome for every failure. This ticket is an integration gate over tickets 02-04; it adds no second implementation. Review protocol/runtime coupling, update the owning current guide and migration status, record revision/dirty state/commands/exit codes/logs, and close the spec only when the complete acceptance matrix passes.

No deployment or restart is implied. Build only on approved build hosts; record remaining limitations rather than overstating exact pixel positioning or external side-effect guarantees.

## Answer

Delivered on `impl/history-navigation-04`, branched at the integration tip `2c28d1c`. This ticket adds no second
implementation: it drives tickets 02-04's seams and found two defects, each fixed at the abstraction that owned it.

**The system.** `apps/server/scripts/history-navigation-acceptance-fixture.ts` seeds one conversation of 130 committed
user messages, a compaction head marker over turn 20 and a fork at turn 40, all through the runtime's public transaction
and creation seams before the Backend opens the store, then serves `apps/web/dist` through the real client ingress
beside `/api` and reaches this run's own controlled model endpoint.
`apps/web/e2e/ux-history-navigation-acceptance.mjs` drives it as a person would and reads every claim off the DOM or off
counted requests: **82 checks, exit 0**, on `ed0e4a1` with a clean tree.

The recovered draft seeded 60 anchors, which fits inside the contract's default page limit of 100 — so the rail's own
continuation could never run. `5eea65d` raises the seed to 130 and the second page is now in the fixture's own path
(100 + 30 anchors, no repeated cursor).

**Two defects found, both fixed at the owning seam.**

1. **A rail click was the silent no-op spec decision 9 forbids.** A node is *loaded* when the transcript **measured** the
   turn, and a windowed transcript keeps measuring turns it unmounts. The click scrolled to the `scrollTop` that
   measurement stored — a snapshot of a scroll coordinate the window rewrites afterwards, when an estimated spacer
   becomes a real measurement and everything below moves. The jump landed 500-3500 px from the turn and named nothing.
   Fixed in `ChatMinimap`: the anchor element is kept beside the measurement, an unmounted turn is treated as an
   unmeasured one, both the click and the reveal alignment read the element's offset in the DOM now (as the sibling
   assistant/heading jumps already did), and the reveal alignment stays pending across the measurements that replace
   the estimates, bounded to 12 re-aims.
2. **A conversation switch during a read threw a page error.** `useHistoryNavigation`'s host read its abort signal
   through `lifetime.current!.signal` while the lifetime effect cleared that ref in its cleanup, so a read in the gap a
   `StrictMode` replay opens threw `Cannot read properties of null (reading 'signal')`. The aborted controller is now
   left in the ref.

**The matrix, item by item.**

| ticket requirement | how it is observed | result |
| --- | --- | --- |
| long history displays nodes beyond the loaded window | 100 first-page anchors + the 30 measured turns newer than the page's newest anchor, against a transcript mounting 42 of 262 entries | pass |
| nodes ordered by server cursor; previews bounded | ascending ids, no repeat; the compacted opening question previews its committed text at 78 chars | pass |
| unloaded anchor costs one bounded target read | one `/navigation/around` by `anchor=nav1.…`, **zero** outline-page reads, landing at `top: 52` | pass |
| loaded anchor's local jump is free | zero navigation reads | pass |
| one page on open, one per activation | one read on open; the continuation reads the Backend's own `cursor=213` once, adds 30 anchors, renumbers nothing, then disappears | pass |
| append extends without moving an anchor | 130 to 131 nodes, every prior identity and position intact, no outcome named | pass |
| deep search hit outside the window uses the same coordinator | one `/around` with `entry=93&block=0`, zero outline pages, matched turn at `top: 52` | pass |
| fork inheritance | the fork's own 40 anchors under `scope=277`, inherited prefix landed | pass |
| stale / missing / wrong-scope | `409 stale-snapshot`, `404 missing` with **no window in the body**, `409 wrong-scope`, over the ingress | pass |
| deferred-busy | a run genuinely held open; named `deferred-busy`, zero reads behind it, nothing mounted, Retry lands once released | pass |
| read error | an aborted `/around` named `error`, no neighbour mounted, Retry lands | pass |
| cancelled | the coordinator seam (ticket 03's own case) plus its mounted consequence: a real sidebar switch mid-read lands the abandoned target nowhere and leaves no stale banner | pass (see limit) |
| no silent handled path | every journey ends on screen at the entry or on a named banner with its own sentence; no two names share a sentence; no page error | pass |

**Accepted on this line.** The gates this ticket owns are closed: the thirteen matrix rows above pass, the two
defects it found were fixed at the seams that owned them, and the journey's 82 checks were re-measured on the integrated
tree rather than inherited from the delivery branch ([how ticket 05 arrived](../../../docs/verification.md#how-history-navigation-ticket-05-arrived-on-this-line-2026-10-20)).
The spec and its ticket graph therefore read delivered rather than open. Nothing was re-run for this status change,
because no source changed after those runs.

**Limits recorded rather than overstated.**

- **`cancelled` is not provoked as a rendered banner here.** The mounted surface clears the outcome in the same commit
  that retires the request, so the name belongs to the coordinator and is asserted at that seam. The journey asserts the
  consequence a reader can be wronged by instead.
- **No exact-pixel claim.** A landing is asserted to be on screen and at the head of the viewport, which is what the
  settlement promises; the alignment is a computed scroll against live geometry, not a persisted position.
- **Vite built the page on this workstation**; nothing was built on `remote-host`. No deployment, restart, push or merge.
  No bypass or security-control probe was designed or run.
- The twelve pre-existing `check-docs` broken links are unchanged by this ticket; the two cross-references this change
  invalidated were repointed.
