# Diagnosis: the snapshot acceptance seam protects half the view (design-web-review §2)

Revision: `1758c1fb4479e9d4637a957857246c5998619d73` (HEAD) **plus** the current authorized audit dirty changes.
Dirty state at diagnosis time (own files only, `git status --porcelain`): `M apps/web/hooks/useAgentSession.ts`,
`M apps/web/lib/lifecycle-projection.ts`, `M apps/web/hooks/useAgentSession.lifecycle.test.mjs`. The audit's other dirty
files were left untouched. Node v26.5.1. No commit, stash, reset, deploy, remote build or paid inference.

## Symptom (user's exact words, reproduced)

Opening a conversation, an HTTP read that began before a stream frame and answered after it rewound the facts the
fresher frame had stated. The transcript itself stayed fresh — the projection refused the older window — but the
revision, the head marker, the active leaf and the run's failure went backwards, so the failure the user needed to read
was cleared off the composer.

## Phase 1 — feedback loop (red-capable, already run)

Command (raw log `.dev/verify/design-fixes/snapshot/red-loop-baseline.log`):

```
cd apps/web && node --input-type=module < ../../.dev/verify/design-fixes/snapshot/red-loop-baseline.mjs
```

It drives the **real hook** (`useAgentSession`) through the existing lifecycle harness — real bundle, real projection,
real transport stand-ins — with a controlled read whose answer the test releases by hand.

Raw stdout (dirty revision above):

```text
before old HTTP: {"messages":["fresh"],"dataRevision":2,"historyHead":"head2","hasEarlierMessages":false,"runFailure":{"reason":"no_model","message":"fresh failure"},"leafId":"e2"}
after old HTTP: {"messages":["fresh"],"dataRevision":1,"historyHead":"head1","hasEarlierMessages":false,"runFailure":null,"leafId":"e1"}
```

Red-capable: it asserts the user's exact symptom (the beside-view facts move backwards) and it goes green once fixed.
Deterministic (deferred read, no timing), fast (~0.1 s), agent-runnable. Same shape as the review's own R1 probe, reused
here as the basis rather than re-invented.

## Phase 2 — reproduce + minimise

Minimal scenario, every element load-bearing: one session, one stream frame with `revision:2` and a failure, one read
with `revision:1` whose answer lands afterwards. Removing the stream frame goes green (nothing to rewind); replacing the
older read with a newer one goes green (the ordering is what fails).

**Source inference, not tested as a run:** the scenario also carries a head marker, a leaf and a revision, and each of
those is asserted separately. Dropping the *failure* or the *head* from either side therefore does **not** by itself
make the loop green — the revision and leaf assertions still rewind and still fail. What dropping a compared fact does
is remove *that* assertion from the set; only removing all the compared facts (failure **and** head **and** the
revision/leaf the assertions read) leaves nothing to lose. The "load-bearing" claim above is about the scenario being
minimal for the loop as a whole, not a claim that any single field flips the loop green.

## Phase 3 — ranked hypotheses (published by the parent; ranked here)

1. **The hook applies snapshot metadata outside the fold's acceptance decision.** Projection refuses the window; the
   hook then writes `setData`/`setActiveLeafId`/`setRunFailure`/`historyHeadRef` unconditionally.
2. **The stream frame is sorted/merged wrongly against the read** (wrong ordering rule inside the fold).
3. **A stale event listener delivers the old frame** (transport-side duplication).

## Phase 4 — one-variable probes and their predictions

Probe A — the fold's own decision, in isolation
(`.dev/verify/design-fixes/snapshot/probe-fold-acceptance.log`, exit 0):

```text
P1a accepted rev2 -> view.messages ["fresh"] state.revision 2 identity P
P1b rejected rev1 -> view.messages ["fresh"] state.revision 2 notices [] effects []
P1b step keys ["state","view","notices","effects"] accepted marker? false
P1c generation-only begin(9) -> generation 9 view.messages ["fresh"] revision 2
P1d same-revision snapshot -> view.messages ["fresh"] effects []
P1e cross-identity http -> view.messages ["fresh"] effects [{"kind":"reattach","acquisition":1}]
P1f cross-identity sse -> view.messages ["other-sse"] identity Q
P1g lifecycle-only step -> view.messages ["fresh"] revision 2 notices [{"kind":"answered","answerId":"a1","inputs":["s1"]}]
P1h unavailable step -> view.messages ["fresh"] ready ready issue {"kind":"transport","message":"boom"}
P1i stale lifecycle -> notices []
```

Prediction for hypothesis 2 (wrong ordering rule): a rejected older revision would still move something in the fold's
own state or view. **Refuted** — P1b shows the fold's view and revision unchanged and no notices. Hypothesis 2 is not
the cause. Prediction for hypothesis 3 (stale listener): the fold would receive a frame it did not receive, i.e. a
non-refused input; P1b/P1i show every refused input is already fenced, and the harness's `sources` are per-mount, so
in this reproduction there is no second listener to deliver one. **Refuted for this reproduction / local case only.**
The minimal harness runs one listener per mount, so it demonstrates that a stale-listener bug is *not needed* to
produce the symptom and that the reproduced cause is sufficient on its own. It is not a global proof that no
stale-listener path can exist anywhere in the product; a duplication of that kind would show up as a second delivery
the fold accepts, which this probe never observed but also never exhaustively excluded.

Prediction for hypothesis 1: a step that reports *what the fold decided* would be absent (`accepted marker? false`),
while a caller-visible symptom exists in the hook — the read's facts move even though the fold refused them. **Confirmed**
(P1b: no decision is exposed, yet the hook publishes the facts regardless).

## Classification (evidence, not size)

- **Interface obligations.** `advance` documents that it "validates, orders and folds observations … into a view", and
  that "only the fold orders". The obligation a caller must know is: *a snapshot the fold refused is not the
  conversation's current statement, so nothing that travelled with it may be published.* The Interface did not state
  that obligation in a form a caller could obey — the returned `Step` carried only `state/view/notices/effects`, and
  the fold's refusal was indistinguishable from a no-op.
- **Owner.** The ordering decision already has one owner: `applySnapshot` in `lifecycle-projection.ts:380`-ish
  (`identity`/revision comparison). The hook is a *second* place deciding what to do with a snapshot's metadata, and it
  decides nothing — it applies unconditionally. The failure is the caller's, at the existing owner's seam.
- **Deletion test.** Delete the projection and the ordering knowledge (attachment identity, revision, acquisition
  fencing, restatement) reappears in both transports; delete the hook's unconditional writes and the symptom disappears
  with no complexity moving elsewhere. So the projection is not the thing to delete; the *missing decision* at its
  Interface is.
- **Dependency category.** Projection/prefix/acquisition identity: **In-process** (pure). React state, timers,
  page-memory stores: **Local-substitutable** (existing harness). HTTP/SSE: **Remote but owned** (existing adapters and
  fetch/EventSource stand-ins). No new port, registry or adapter is justified — two adapters already exist.

**Classification: mixed, with a missing Interface outcome as the primary defect.** The Interface's ordering rule is
sound and already refuses the stale window (ordinary logic is *not* broken — hypothesis 2 refuted); what is missing is
that the fold does not report *which* snapshot it took as the current statement, so a caller that has facts beside the
window has to invent its own ordering — which the hook does not do at all. The hook-side write is the logic defect that
follows from the missing outcome. Proof of "missing ownership", not of a wrong rule:

1. P1b: the fold refuses the older read and reports nothing about it.
2. Red loop: the hook publishes the refused read's revision/head/leaf/failure anyway.
3. The hook cannot distinguish "refused older revision" from "restatement of the accepted revision" without comparing
   revisions a second time — a second clock the ADR 0007 decision explicitly rejects.

## Phase 5 — fix at the existing owner (smallest coherent change)

1. `lifecycle-projection.ts`: `Step` gains `snapshotAccepted: boolean`, set by `applySnapshot` — `true` when the
   snapshot was taken as the current statement (advanced **or** restated the accepted revision), `false` for an older
   revision, a contradiction, a fenced-out acquisition, a cross-identity HTTP read, and for every non-snapshot input.
   One decision, at the one place that already owns it; no second comparison in the hook.
2. `useAgentSession.ts`: `fold` returns the `Step`; **every** fact a frame carries is applied inside
   `if (accepted)`, because they all come from that one snapshot. On the read path that is the window, the head
   marker, the leaf, the run's failure, the pagination state, the prefix migration, the tool loadout and
   `sessionToolsPinnedRef`, the model and thinking overrides, the freshness checkpoint
   (`setSessionViewSnapshot`), `wrapperRebuilt`/`reconnectEvents`, and the thinking level. On the stream path it is
   the window, head, leaf, failure, model, thinking level, queue, plus the transport-local rendering (live tool
   results, `dispatch end`/live message, the streaming phase, the compaction flag, the oversize-refusal clear).
   The comment "independent of the view cache" was true and irrelevant: a fact can be independent of the *cache* and
   still be derived from the *snapshot*. No per-setter fences and no second revision comparison — one branch per
   transport, at the acceptance seam, deciding once per frame.
   The read's **separate** `/state` query is another read with its own guards; it is deliberately left outside this
   decision, and no claim is made that the snapshot decision covers it.
   Diffstat of the two source files: `lifecycle-projection.ts` +22 −4; `useAgentSession.ts` +86 −53.

Restatement (`revision === accepted revision`) counts as current on purpose: a remount restores the projection from
page memory while the hook's beside-view state starts empty, so refusing its read would leave the conversation with no
head marker, no leaf and no failure — the facts the read exists to state. That case is asserted, and it is exactly the
case a naive "strictly newer only" gate breaks (red proof below).

## Phase 6 — verification (all on the dirty revision above, own files only)

- Regression tests added **before** the fix, at the real hook seam, in
  `apps/web/hooks/useAgentSession.lifecycle.test.mjs` (6 new): stale HTTP after fresh SSE; remount restating the
  accepted revision; stale read on a remounted conversation (cache/bootstrap path); cross-attachment HTTP read; a
  stale read's tool loadout and thinking level; a refused stream frame's rendering (live tools, live message, phase).
  The two last ones are the ones the parent's review demanded: they fail only when a frame-derived fact outside the
  transcript is published from a refused frame.
- **Red on pre-fix source** (`git show HEAD:…` restored for both source files, log
  `.dev/verify/design-fixes/snapshot/red-proof-prefix.log`, exit 1): **5 of the 6 fail** with the exact symptom
  (revision 1 vs 2, `e3,e4` vs `e1..e4`, revision 5 vs 2, tool preset `read-only` vs `configured`/thinking
  `medium` vs `high`, refused frame's phase/tools/live message rendered). The sixth (remount restatement) passes
  pre-fix — it is the guard against a naive strictly-newer gate, and it fails under that gate instead (log
  `.dev/verify/design-fixes/snapshot/red-proof-naive-gate.log`, exit 1, facts null/empty).
- **Green after the fix**: `apps/web/hooks/useAgentSession.lifecycle.test.mjs` (20 tests) plus
  `lib/lifecycle-projection.test.mjs` and `hooks/useAgentSession.test.mjs`: **109/109**, exit 0
  (`.dev/verify/design-fixes/snapshot/focused-postfix.log`).
- `tsc --noEmit` in `apps/web`: exit 0, empty log (`.dev/verify/design-fixes/snapshot/typecheck.log`).
- Full Web unit suite, explicit recursive file list
  (`find . -name '*.test.mjs' -not -path './node_modules/*' -not -path './.next/*' -not -path './vendor/*' | sort`):
  2311 tests, 2295 pass, **16 fail** — failure-name set identical to the recorded baseline
  (`.dev/verify/2026-10-14T08-23-27-576-web-unit/web-unit.tap`); `diff` of the sorted `not ok` names is empty. The 16
  existing Web failures are untouched. Logs: `.dev/verify/design-fixes/snapshot/web-unit.log` (exit 1, expected).

## Residual uncertainty

- The prefix-migration branch now also sits behind `accepted`. It was already effectively gated (the fold refused the
  window and `decidePrefix` ran on the stale window's ids); the change removes the last path where a refused read could
  evict pages. Covered by the paging tests above (green) and the new remount-stale test (red pre-fix).
- Not re-run here: browser flows and the other audit lanes; parent owns those. No claim is made about them.
- Instrumentation: the only temporary edits used for red proof were reverted; `rg 'DEBUG-|false &&'` over both source
  files is empty (exit 1).
- Final source hashes (post-fix, the revision this document describes):
  `useAgentSession.ts` `35d07c5e2e47e3039e2c81415a8e080137c861ffe9904466f5601240959a0eec`,
  `lifecycle-projection.ts` `4838645840e24a878b7b5d05ec54a4912054c1db571ad5e297dc338ebf209ce0`.
- Re-confirmed after gating every frame-derived fact (read tail, stream rendering, cache checkpoint, overrides):
  red proof 5 of 6 new tests failing pre-fix; focused suites 109/109 exit 0; `tsc --noEmit` exit 0; full Web suite
  2311 tests / 2295 pass / 16 fail with the identical baseline failure-name set.
