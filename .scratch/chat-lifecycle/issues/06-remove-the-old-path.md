# 06: Remove the old background tone and finish the migration

**What to build:** With ticket 05's coverage accepted, the absence-based background completion path is removed
together with the two suppression filters that are provably always empty today — fixed at their source rather than left
in place, so either the backend reports the subagent or background flag on the catalogue row and the adapter forwards
it, or the client filter is deleted, with the source first so nothing rings for a subagent. The unread marker is the
documented fallback for a run that finished entirely unobserved — and it therefore has to come from a fact that exists
for such a run, which the poll's `busy` absence is not: the catalogue states the run's own end. The owning behaviour and verification guides are
updated in the same change, and the proposed ADR is written only if the user accepts it.

**Blocked by:** 05: Background completion from live facts

**Status:** resolved — implemented on `impl/chat-lifecycle-06` at `cb8ae3b`, merged into `integration/chat-lifecycle` as `e7c7555`. Verification below.

**Stories:** 29, 31–36, 41–44

**Seam:** the browser, through the existing Web adapter and a real backend, for the removal; the guides and the ADR
are the documentation half of the same change.

- [x] The absence-based background tone and its sidebar boolean are gone; a completion notice comes only from a live
      terminal fact, and the completion tone still has exactly one owner.
- [x] The subagent and background suppression is reported by the backend and forwarded by the adapter, or the always
      empty client filter is deleted; a subagent's completion is silent either way, and no provably empty filter
      remains.
- [x] A run that finished entirely unobserved leaves the unread marker and produces no sound, and the limit is stated
      in the owning guide rather than patched.
- [x] The behaviour guide and the verification guide describe the delivered lifecycle, the notice rules, the ordering
      contract and the stated limit; the documentation checks pass.
- [x] The proposed ADR is recorded only if the user accepts it, and the ticket reports which way that went.
- [x] No deployment, configuration or release change is made by this ticket.

## What was built

**The tone is deleted, not gated.** `SessionSidebar` loses `onBackgroundTaskDone` and every line that served it;
`AppShell` loses `handleBackgroundTaskDone` and the wiring to it; `CompletionDelivery` loses the whole decision it
existed for (`owns`, `uncovered`, the watched set, and the `unanswered` settlement it recorded only so the old tone
could defer). `CompletionDelivery` keeps one public decision — `settle`, one notice per conversation and answer — so
the tone still has exactly one owner: the surface on screen when it claimed the answer, or the background watch that
folded it otherwise.

**The marker is the run's own end, not the poll's absence (review84 P2).** The review found the gap the first pass left:
the marker was derived from `busy` disappearing between two polls, so a run that started and finished between
them was never named as running and left *nothing* behind — neither a sound nor a marker, while the accepted contract
requires the silent run to leave the marker. That is a real contract gap and it is fixed at the seam that owns the fact,
not in the guide:

- the backend reads each conversation's newest generation run's own terminal receipt (`endedAt` on the committed
  `pi.generation` task record, the same read `readRunFailure` already makes) once at attach and keeps it current
  from the commit stream, exactly as it already keeps the title and the removal, and reports it as `lastRunEndedAt` on
  the catalogue row. A run in flight has no receipt, so the field is absent and no marker is due.
- the adapter forwards it on the session row (`apps/web/adapters/durable-api.ts`).
- the sidebar diffs it through the new pure rule `apps/web/lib/run-marks.ts`: a window's first non-empty listing
  is its baseline, a later end is a marker, the open conversation and a subagent's are never marked, and the input map is
  never mutated.

No scheduler, no per-poll state read, no stream per idle conversation and no universal catch-up: the fact was already
committed durably, and the catalogue read the sidebar already makes now states it. A marker still says only that a run
ended — never how — so an abort or a failure marks and does not ring, which is unchanged.

**Both always-empty filters, fixed where they were empty.** `completionNotificationSuppressedSessionIds` was never
emitted by this deployment — `/api/sessions` and `/api/agent/running` are the durable adapter's, and the field existed
only in the vendored upstream route — so its refs, both reads and the filter clause are deleted rather than kept as a
set nothing fills. The subagent filter was empty for a different reason: the catalogue reported a fork's parent and
never the creator edge, so `relation?.kind === "subagent"` was false for every row. That is fixed at its source:

- the backend reads the conversation record's creator edge once at attach (`record.owner`) and reports
  `subagentParentConversationId` on the catalogue row, the same way it already reports the fork source;
- the adapter turns that edge into the `parentSessionId` and subagent relation the surfaces already read;
- the subagent relation's `profile`, `description` and `status` are optional, because the catalogue states the creator
  edge and not the run's own metadata; the surfaces that display them already fall back.

Nothing was left as a fallback: with the tone gone, a subagent's completion is silent through
`CompletionDelivery.isSuppressed`, which now reads a real set.

## ADR 0007

**Written.** The spec gated it on the user's acceptance, and the decisions it records are the ones the product owner
accepted with the specification (contract A, 2026-10-13) and that tickets 01–06 have now delivered: one pure projection
owns lifecycle decisions, a completion is a native terminal fact that carries its answer, ordering is backend identity
plus a client acquisition fence, background delivery is a shell-owned interest map over one stream per conversation with
the poll nominating and never deciding, and the unobserved run is a stated limit with the unread marker as its fallback.
It is hard to reverse — the removed authorities are deleted — and surprising enough to be worth recording: the poll that
used to ring is now neither a sound nor the marker, and the product guarantee is deliberately narrower than universal
notice catch-up. If the
user would rather not have it, deleting `docs/adr/0007-lifecycle-facts-one-projection.md` and its index entry is the
whole change.

## Verification at the merged tip `e7c7555`

Merged into `integration/chat-lifecycle` as `e7c7555bb6411d64b5b4a72c02ba1d5398326710` (parents `284638e` and
`cb8ae3b`) by an isolated compare-and-swap in `.dev/worktrees/chat-lifecycle-merge`, whose tree is identical to
`cb8ae3b` (`git diff --stat cb8ae3b HEAD` empty). Every check below ran in that worktree against the merge commit,
with `git status --porcelain` empty before and after, and the browser drivers were given `HEPI_CLB_OUT`/`HEPI_CLF_OUT`
outside the repository, so the scene artifacts committed at `70a4b87` were not rewritten.

- **Focused run, twelve suites** — `node --test` over `lib/completion-delivery.test.mjs`,
  `lib/lifecycle-projection.test.mjs`, `lib/run-marks.test.mjs`, `lib/agent-event-connection.test.mjs`,
  `lib/session-family.test.mjs`, `lib/session-tree.test.mjs`, `hooks/useAgentSession.lifecycle.test.mjs`,
  `hooks/useAgentSession.test.mjs`, `components/SessionSidebar.test.mjs`,
  `components/SessionSidebar.marker-effect.test.mjs`, `adapters/recall-and-session-list.test.mjs` and
  `adapters/session-fork.test.mjs`: exit 0, 237 pass, 0 fail —
  `.dev/verify/focused-ticket06/focused-unit-e7c7555.log`.
- **Background driver** — `node apps/web/e2e/chat-lifecycle-background.mjs` against the production Next build, the real
  backend over a real SQLite store and a real local execution host, with no paid model call and no sleep: exit 0, 57
  checks, 0 failures, PASSED — `.dev/verify/focused-ticket06/chat-lifecycle-background-e7c7555.log` (scene artifacts
  under `/tmp/ticket06-browser-out/background`).
- **Foreground driver** — `node apps/web/e2e/chat-lifecycle-foreground.mjs`, same stack: exit 0, 28 checks, 0
  failures, PASSED — `.dev/verify/focused-ticket06/chat-lifecycle-foreground-e7c7555.log`.
- **`pnpm verify --profile=fast`** — exit 0, PASS/PASS (workspace typecheck, workspace tests), `dirty=false`,
  `sha=e7c7555bb6411d64b5b4a72c02ba1d5398326710` —
  `.dev/verify/2026-10-13T05-35-25-940-verify-fast/verify.json`.
- **`pnpm --filter @hepi/server test`** — exit 0, 232 pass, 0 fail —
  `.dev/verify/focused-ticket06/server-e7c7555.log`.
- **`pnpm test:web:unit`** — exit 1, 2224 tests, 2202 pass, 22 fail; the 23 `not ok` names (the 22 failing tests plus
  the file rollup that carries them) are identical to the pre-ticket baseline at `7ae9aa3`
  (`.dev/verify/2026-10-13T00-13-07-558-web-unit/web-unit.tap`, 2208 tests, 2186 pass, 22 fail; 0 new, 0 gone). This
  suite is never claimed green — `.dev/verify/2026-10-13T05-37-13-792-web-unit/web-unit.json`.
- **`pnpm check:docs`** — exit 0, 153 Markdown files, 0 broken relative links, 0 guides missing.
- **`pnpm check:entrypoints`** — exit 0, 61 entry files present, 2 known-missing (pre-existing, recorded), 0 newly
  missing.
- **`node .scratch/chat-lifecycle/check-tickets.mjs`** — exit 0, 44 stories covered, 0 blocker problems, breakdown
  links ok.

**The review evidence, at the tip.** All four findings the two review rounds raised are fixed in this source and kept as
tests: review84's unobserved-run marker (`938f3de`, regression
`components/SessionSidebar.marker-effect.test.mjs`), review85's queued-follow-up handover (`f772a59`, browser scene
4c plus three `lib/completion-delivery.test.mjs` cases), review84's marker while a follow-up runs (`f772a59`, the same
marker-effect suite), and review85's retained settled conversations (`bbee619`, "a settled projection the owner hands
over releases the stream, so a finished conversation holds nothing" — `retained after empty nominations: 7/7` at
`c54d23b`, `0/7` at the tip). The twelve-suite focused run above is where all four are asserted together.

**Superseded revisions.** `079f3fb` (first pass) → `938f3de`, recorded at `e966011` (second pass) → `f772a59`,
reviewed as `4a39361` (third pass) → `bbee619`, recorded at `cb8ae3b` (fourth pass). Each earlier revision's runs are
kept in the sections below rather than deleted, so the review trail shows what was claimed when.

No product source changed at this merge beyond ticket 06's own commits; no deployment, live host or paid provider was
contacted.

## Verification at `bbee619` (branch `impl/chat-lifecycle-06`, branch run)

This is the fourth pass. It fixes review85's new P2 at `completion-delivery.ts`: a run that started and ended while its
conversation was on screen, then a leave, then nominations that never name the conversation — seven of seven such
conversations kept an idle stream, none of which any later poll released. The two earlier findings (85's queued
follow-up handover, 84's marker while a follow-up runs) remain fixed and their cases remain asserted.

**The cause was the guard, not the frames.** While a conversation is on screen its watch folds nothing — the surface
owns those frames — so the surface's handover is the watch's only knowledge of that conversation. The guard refused any
handover reporting nothing in flight whenever the watch still reported work, to protect a remount's not-yet-loaded
projection; that also refused the *owner's own settled projection*, so the watch stayed on a run its owner had already
watched end. The distinction the guard needs is not "has no work" but "has accepted no fact": a projection that has
not loaded says it does not know, not that the work is done. The guard now reads that off the projection's own accepted
identity, so a settled projection the owner hands over releases the stream, while an unloaded one — and a staged turn
inside one — still never takes an interest away.

Proven red, kept as a test: `apps/web/lib/completion-delivery.test.mjs`, "a settled projection the owner hands over
releases the stream, so a finished conversation holds nothing". Seven conversations, each shown, run, settled and left,
then `nominate([])`. Against `c54d23b` it reports `retained after empty nominations: 7/7`; at `bbee619` it reports
`0/7` and the retained set is empty. The review's own public ownership repro was run against this source and prints
`retained after empty nominations: 0/7 []`; the queued-follow-up repro still prints both answers (`a1`, `a2`) on one
stream that the first settlement does not close.

Browser, against the production Next build, the real backend over a real SQLite store and a real local execution host,
with no paid model call and no sleep, at `bbee619`:

- `apps/web/e2e/chat-lifecycle-background.mjs` — 57 checks, PASSED (scene 4c included: the queued follow-up keeps the
  stream and sounds its own distinct answer, with the running poll held so "before any nomination" is proven).
- `apps/web/e2e/chat-lifecycle-foreground.mjs` — 28 checks, PASSED.
- `ux-sidebar-shared-state` and `ux-submission-recovery` — PASSED (the sidebar's marker rule and the composer's
  recovery are the surfaces this change touches).

Unit and backend, at `bbee619` with `dirty=false`:

- `pnpm verify --profile=fast` — exit 0, PASS/PASS (workspace typecheck, workspace tests).
- Focused suites — 237/237, including `lib/completion-delivery.test.mjs` (17 cases, one more than the third pass),
  `hooks/useAgentSession.lifecycle.test.mjs`, `hooks/useAgentSession.test.mjs`, `lib/lifecycle-projection.test.mjs`,
  `lib/run-marks.test.mjs`, `components/SessionSidebar.test.mjs`,
  `components/SessionSidebar.marker-effect.test.mjs` (review84's marker regression, still 4/4),
  `lib/agent-event-connection.test.mjs`, `adapters/recall-and-session-list.test.mjs`,
  `adapters/session-fork.test.mjs`, `lib/session-family.test.mjs`, `lib/session-tree.test.mjs`.
- `pnpm --filter @hepi/server test` — 232/232.
- `pnpm test:web:unit` — 2224 tests, 2202 pass, 22 fail; the failing-name set is identical to the pre-ticket baseline
  (0 new, 0 gone).
- `pnpm check:docs` — 153 files, 0 broken relative links, 0 guides missing. `pnpm check:entrypoints` — 61 entry files,
  2 known-missing (pre-existing), 0 newly missing. The ticket checker — 0 blocker problems, breakdown links ok.

`docs/chat.md` and `docs/verification.md` were corrected to state the rule this pass established: what the owner last
handed over is authoritative, a settled projection included, while a projection that has accepted no fact at all is not.
## Verification at `f772a59` (branch `impl/chat-lifecycle-06`, `integration/chat-lifecycle` at `284638e` already an ancestor)

This is the third pass, and it fixes the two findings of the full integration review at `4a39361`: 85's P2 (a queued
follow-up placed after the first answer lost its notice when the user left before any poll nominated the conversation)
and 84's P2 (the unread marker of an answer that ended while its follow-up was running was cleared by the next
catalogue read and could never be re-derived). Every claim below is from this revision; the earlier passes' evidence is
kept at the end for the review trail.

Browser, against the production Next build, the real backend over a real SQLite store and a real local execution host,
with no paid model call and no sleep:

- `apps/web/e2e/chat-lifecycle-background.mjs` — 57 checks, PASSED
  (`.dev/verify/focused-ticket06/chat-lifecycle-background-f772a59.log`, scenes in
  `.scratch/chat-lifecycle/background/`). Scene 4c is the one this pass added: the conversation is submitted and the
  queued follow-up admitted while the running poll is held, so "before any nomination" is a proven condition (a poll
  really was attempted and could not answer), the user leaves, the first answer sounds, and the follow-up placed behind
  it sounds its own distinct answer on the one stream the leave never closed. It fails against the pre-fix source with
  one tone and one answer key, which is the finding.
- `apps/web/e2e/chat-lifecycle-foreground.mjs` — 28 checks, PASSED
  (`.dev/verify/focused-ticket06/chat-lifecycle-foreground-f772a59.log`, scenes in
  `.scratch/chat-lifecycle/foreground/`).
- The sidebar and composer surfaces this change touches, re-run because the session row, the marker rule and the
  sidebar's effect all changed: `ux-sidebar-shared-state`, `ux-nav-new-session`, `ux-visible-turns` and
  `ux-submission-recovery` — all PASSED at `f772a59` (`.dev/verify/focused-ticket06/ux-*-f772a59.log`).

Both drivers now group a tone where it is played rather than by the millisecond it rounds to (a microtask flush marks
the turn boundary), which removed an intermittent failure in foreground scene 1 that was about tone counting, not about
this change. Three consecutive foreground runs and two background runs are clean at this revision.

Unit and backend, at `f772a59` with `dirty=false`:

- `pnpm verify --profile=fast` — exit 0, PASS/PASS (workspace typecheck, workspace tests);
  `.dev/verify/2026-10-13T04-54-59-476-verify-fast/verify.json`.
- `pnpm test:web:unit` — exit 1, 2223 tests, 2201 pass, 22 fail; the failing-name set is identical to the pre-ticket
  baseline (0 new, 0 gone). `.dev/verify/2026-10-13T04-56-53-973-web-unit/web-unit.json`. The baseline is
  `.dev/verify/2026-10-13T00-13-07-558-web-unit/web-unit.json` in the integration worktree, run at `7ae9aa3`, which
  differs from `284638e` by documentation only (`git diff --stat 7ae9aa3 284638e`: 3 files, all under `.scratch/` and
  `docs/`). One earlier run of this suite reported two extra failures in `apps/web/adapters/mcp-surface.test.mjs`; that
  file passes 9/9 in isolation three times and the extra failures did not recur, so they are load-related flakiness
  rather than this change.
- Focused suites — `lib/run-marks.test.mjs`, `lib/completion-delivery.test.mjs`,
  `components/SessionSidebar.marker-effect.test.mjs` (new this pass), `lib/lifecycle-projection.test.mjs`,
  `lib/agent-event-connection.test.mjs`, `hooks/useAgentSession.test.mjs`,
  `hooks/useAgentSession.lifecycle.test.mjs`, `components/SessionSidebar.test.mjs`,
  `adapters/recall-and-session-list.test.mjs`, `adapters/session-fork.test.mjs`, `lib/session-family.test.mjs`,
  `lib/session-tree.test.mjs` — exit 0, 236/236 (`.dev/verify/focused-ticket06/focused-unit-f772a59.log`).
- `pnpm --filter @hepi/server test` — exit 0, 232/232, including the catalogue-receipt test and the fork suite's
  creator edge (`.dev/verify/focused-ticket06/server-f772a59.log`).
- `pnpm check:docs` — 153 files, 0 broken relative links, 0 guides missing. `pnpm check:entrypoints` — 61 entry files
  present, 2 known-missing (pre-existing, recorded), 0 newly missing. The ticket checker — 0 blocker problems, no
  uncovered story. All three exit 0, none writes a log, all three ran at `f772a59`.

Proven reds before each source fix, all kept as tests:

- 85's handover: `apps/web/lib/completion-delivery.test.mjs` fails against `4a39361`'s `completion-delivery.ts` with the
  follow-up's answer missing (`actual ['a1']`, `expected ['a1','a2']`), reproduced through the review's own public call
  sequence; and the browser scene 4c fails against the pre-fix build with one tone and one answer key.
- 84's marker: `apps/web/components/SessionSidebar.marker-effect.test.mjs` fails against the pre-fix
  `SessionSidebar.tsx` on the refresh case and on the write-shape case.
- and from the earlier passes: the backend test failed with no `lastRunEndedAt` and no `subagentParentConversationId`,
  and the adapter test with each absent from the session list row.
## Second-pass runs at `938f3de` (superseded by `e966011`, kept for the review trail)

`chat-lifecycle-background.mjs` 46 checks PASSED, `chat-lifecycle-foreground.mjs` 28 checks PASSED,
`ux-sidebar-shared-state`, `ux-nav-new-session`, `ux-visible-turns` and `ux-submission-recovery` PASSED,
`pnpm verify --profile=fast` exit 0, `pnpm test:web:unit` 2193/2215 with the failing-name set identical to the
baseline, 228/228 focused, `pnpm --filter @hepi/server test` 232/232. Logs at
`.dev/verify/focused-ticket06/*-938f3de.log`. `e966011` changes one rule case on top, so these are history rather than
the claims above.
## First pass at `079f3fb` (superseded, kept for the review trail)

Browser: `chat-lifecycle-background.mjs` 43 checks PASSED, `chat-lifecycle-foreground.mjs` 28 checks PASSED,
`ux-sidebar-shared-state`, `ux-nav-new-session`, `ux-visible-turns` and `ux-submission-recovery` PASSED. Unit and
backend: `pnpm verify --profile=fast` exit 0; `pnpm test:web:unit` 2186/2208 with the failing-name set identical to the
baseline; 221/221 focused; `apps/server/test/session-fork.test.ts` 6/6. Scene 5 there asserted that the unobserved run
sounded nothing and left a marker in the tree — which, as review84 found, was vacuous, because nothing could mark it.
That claim is corrected above and the scene now proves the marker.

## Review notes, first pass (review84's unobserved-run marker)

- **review84 P2 — the unobserved run left no marker: fixed, not deferred.** The finding was right and it was a real
  contract gap, not a documentation error: the marker was derived from a `busy` id disappearing, and a run that started
  and finished between two polls was never named as running, so it left nothing at all. The fix is at the owning seam
  (the run's own durable receipt on the catalogue row), and the browser scene now proves the case the poll could never
  see, with a negative control. `docs/verification.md` and this ticket's claims were corrected to say what the test
  actually proves; the first pass's scene 5 claim was vacuous and is recorded as such above.
- The subagent chain is proven at each seam and not in the browser: no part of this deployment creates a task-owned
  conversation, so the browser has no subagent producer to observe. The fixture that does create one writes the owned
  record through the durable API itself. Revisit if a deployment ever creates subagent conversations for real — the
  browser matrix should then gain that scene.
- `GET /api/agent/running` still reports ids only. That is unchanged and sufficient: the marker no longer depends on
  the poll at all, and the session list is the catalogue read that carries the run's own end.
- The marker's fact is a run end, not an outcome. Whether a run answered, aborted or failed stays the transcript's and
  the submission's business, so an abort and a provider failure mark and never ring — asserted in scene 4 and 4b.
- A window's first listing is its baseline, so a reload does not turn history into news. That is the one judgement the
  pure rule makes and it is asserted in `apps/web/lib/run-marks.test.mjs`; a window that has read nothing (an empty
  listing) has not consumed its baseline.

## Review notes, second pass (review85's handover, review84's marker while a follow-up runs)

- **review85 P2 — the queued follow-up lost its notice when the user left before any poll: fixed, and the cause was
  the seam rather than the timing.** `hold(conversationId, true)` carried a boolean, and `select()` re-baselined the
  inheriting watch, so the watch knew *that* work was outstanding but not *what* it was: the first terminal fact — the
  first answer — read as the end of the work, the stream closed and the follow-up's answer never arrived. The handover
  now carries the surface's projection (`onProjectionChange` → `CompletionDelivery.handover`), the watch continues from
  it, and taking the frames back is a fresh acquisition rather than a new baseline. The regression is behavioral at the
  public seam (`completion-delivery.test.mjs`, three cases) plus browser scene 4c, which holds the running poll so
  "before any nomination" is proven rather than assumed.
- **review84 P2 — a completed run's marker was cleared while its follow-up ran: fixed at the marker effect.** The
  effect wrote `writeUnread(runningSessionIds, false)` on every catalogue read, so the answer that had just been marked
  was unmarked by the next listing while the conversation still ran — and `seenRunEndsRef` had already consumed the
  receipt, so nothing could mark it again. The effect now writes markers only; a marker leaves when the user reads the
  conversation, marks it read, archives it, or deletes it. The rule is asserted against the shared document's real
  reducer, so the test is about the state a second window reads rather than about the source's shape.
- **A handover that reports nothing never takes an interest away.** A remount whose projection has not loaded says
  nothing about work the watch already knows about; releasing the stream there would be the same loss in another guise.
  Asserted as its own case.
- The subagent chain is still proven at each seam and not in the browser: no part of this deployment creates a
  task-owned conversation, so the browser has no subagent producer to observe. Revisit if a deployment ever creates
  subagent conversations for real.
- `GET /api/agent/running` still reports ids only. That is unchanged and sufficient: the marker no longer depends on
  the poll at all, and the session list is the catalogue read that carries the run's own end.
- The marker's fact is a run end, not an outcome. Whether a run answered, aborted or failed stays the transcript's and
  the submission's business, so an abort and a provider failure mark and never ring.
- A window's first listing is its baseline, so a reload does not turn history into news. A window that has read nothing
  (an empty listing) has not consumed its baseline.

## Review notes, fourth pass (review85's retained settled conversations)

- **The guard was the bug, and the fix is a predicate rather than a delay.** `hasUnfinishedWork` answers "is there
  work in flight", which is the right question for deciding whether to *keep* a watch and the wrong one for deciding
  whether a handover *knows* anything. A watch for the conversation on screen folds nothing, so the handover is its only
  knowledge; refusing the owner's settled projection left it waiting on a run that had already ended. The guard now asks
  whether the projection has accepted a fact at all (`state.identity === null`), which is the property the protection was
  always about, and the interest test stays as it was.
- The three cases the earlier passes established are unchanged and still asserted: the queued-follow-up handover keeps
  both answers on one stream, the staged-turn handover reports its own answer, and an unloaded handover never takes a
  live interest away. The new case is the ownership repro itself, at seven conversations so the result is a count.
- The browser could not have caught this one: it needs seven conversations entered and left with their runs settled and
  no poll nominating them, which is a state the e2e scenes do not build. The assertion is therefore at the public seam,
  where the review found it.
