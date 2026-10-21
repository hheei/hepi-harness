sation and answer key whichever owner held it.
The existing visible-tab poll keeps its cadence and single catalogue read and now only nominates; each nomination opens
one stream whose first snapshot frame is an atomic baseline. Interest is registered and the stream acquired before the
local submit is dispatched, so a run that settles immediately is still observed. Baselines, history, reconnects,
resyncs and recovery lookups are silent, and a run that finished entirely unobserved leaves the unread marker.

**Blocked by:** 04: Switch the conversation surface to the projection

**Status:** resolved — implemented on `impl/chat-lifecycle-05` at `93bc802`, merged into `integration/chat-lifecycle` as `7ae9aa3`. Verification below.

**Stories:** 17, 18, 22–30, 34, 36

**Seam:** the browser, through the existing Web adapter and a real backend, with the poll nomination, a background
conversation and the recorded completion callback — the same pattern the reproduction uses, plus the poll.

- [x] Leaving a conversation with unfinished work keeps its stream open, and the completion notice for that run still
      fires.
- [x] A conversation the user is not looking at is acquired only after the poll nominates it; no stream is opened for a
      conversation with nothing outstanding, and no catalogue-wide or per-idle-conversation stream exists.
- [x] One connection serves a conversation even when the sidebar and the open conversation both watch it, and the
      handover on selection duplicates no notice and loses none.
- [x] A run that settles immediately after admission is observed, because the interest and the stream exist before the
      submit is dispatched.
- [x] An acquired baseline that is already terminal, a baseline acquired after the run ended, a reconnect, a resync and
      a recovery lookup are all silent.
- [x] The acceptance matrix passes: selected-then-background completion; a foreign or previously unmounted run; a
      grouped steer producing one notice; a queued follow-up producing its own later notice; abort and failure with no
      success tone; a backend restart; duplicate delivery; no notice for history, recovery or a baseline; and
      preserved unread and subagent suppression.
- [x] The old absence-based background tone is still present when this ticket ends, and its removal is the acceptance
      gate for ticket 06. It now defers to the live path per conversation, and "the live path has it" means the whole
      thing rather than only a settlement: a completion it reported, an unanswered run it deliberately kept quiet, a
      conversation the poll nominated, and a conversation whose surface reported its own work or is showing it. A run
      whose baseline arrived after it ended is therefore silent — the unread marker is its signal — and a run the user
      watched end cannot be sounded by a later poll. Only a conversation the live path never took in hand at all falls
      back, which in normal use is none: an absence edge is a conversation the poll reported running.
- [x] No new scheduler, generic harness, global controller, persistent epoch or endpoint is added, and no test sleeps.

**Context:** [Spec](../spec.md) decisions 4, 5, 7 and 9, and [background-delivery.md](../background-delivery.md) with
[background-coverage.md](../background-coverage.md). The user accepted the silent fallback for a run that finishes
entirely unobserved on 2026-10-13.

## What was built

- `apps/web/lib/agent-event-connection.ts` now owns one source per conversation with a subscriber list, instead of one
  source for the page. A subscription survives a reconnect and a failed handshake; `release()` closes the source when
  its last reader leaves, and `reconnect()` re-opens it deliberately. The selected hook and a background watch join the
  same source, which is what makes a handover a transfer of ownership rather than a reconnection.
- `apps/web/lib/completion-delivery.ts` is the shell's interest map and the page's one notice registry. It nominates
  from the poll, holds a conversation a surface left with unfinished work, keeps the selected conversation's watch
  dormant so one conversation is never folded twice, folds every other watch's live frames through the same pure
  projection, claims each answer once however many owners saw it, and records which conversations a live fact settled so
  the older absence-based tone defers to it. No scheduler, no epoch, no second store, no new endpoint.
- `apps/web/hooks/useAgentSession.ts` no longer owns a connection or an idle-grace timer: it joins the shell's stream
  per conversation, reports `hasUnfinishedWork(view)` to the shell as the projection states it, asks about its waiting
  turns when it joins a conversation that still has work, and reports every live settlement — a completion or an
  unanswered run — through `onLiveSettlement`, whose answer is whether it is the owner that reports it.
  `scheduleEventStreamClose`, `cancelEventStreamGrace`, `EVENT_STREAM_IDLE_GRACE_MS` and the hook's own
  `AgentEventConnection` are gone.
- `apps/web/components/AppShell.tsx` owns the delivery: it builds the connection, nominates from
  `onRunningSessionIdsChange`, holds what a leaving conversation reports, takes every live settlement through
  `settle`, sounds a background completion the registry says it owns — suppressed for a subagent conversation from the
  catalogue's own relation — and asks `uncovered` before the older absence-based tone sounds anything.
- `apps/web/components/SessionSidebar.tsx` reports which sessions its absence diff believes finished, so the shell can
  defer to the live path instead of sounding one completion twice.

## Review round (82) — five reproduced findings, all fixed

The first revision claimed the checks above while five defects were live. They were reproduced against the real hook and
the real `CompletionDelivery` (`/tmp/chat05-review/five-findings.repro.mjs`, 0 pass / 5 fail at `36e4dac`), and each
was an ownership defect rather than a missing guard:

| finding | what was wrong | the fix |
| --- | --- | --- |
| F1 (7 idle sources retained) | `hold(id, false)` created a watch, and a watch whose view was never folded — it was the selected conversation, so it folded nothing — could never satisfy `reconsider`, so every conversation ever shown kept a live source. | `hold` only *keeps* a watch: a report of nothing in flight opens nothing. The conversation on screen is not a watch reason at all — its surface owns those frames, and its stream is that surface's own subscription. |
| F2 (joined 1, released 0) | The held subscription was cleared by a *render* whose session prop no longer matched, so the stream a fresh composer acquired while its prop was still null lost its only handle. | The reference is dropped only by an explicit leave — a join for another conversation, or the surface going away. |
| F3 (pending overlay after the background answer) | Handover was only the socket: a retained stream delivers no fresh `connected` event, so the turns a surface left staged were never asked about and their overlay never settled. | Joining a conversation with unfinished work asks about each waiting turn by id, under the joining mount's own acquisition — a read that began after it would fence the answers. |
| F4 (two tones for one answer) | Only background watches recorded a settlement, so an answer the *selected* surface reported left `wasSettledLive` false and the next poll sounded it again. | The registry takes every live settlement from every owner (`settle`), and its answer is whether that caller reports the completion. |
| F5 (post-finish baseline rang) | `wasSettledLive` was set only by a *settled* fact, so an acquisition whose baseline already said the run was over authorised the absence path to sound it. | The record is "the live path has this conversation" — a nomination, a surface report, or a watch's own baseline — and the absence path is silent for all of them. |

New behavioural coverage, all red before the fix: `hooks/useAgentSession.lifecycle.test.mjs` (fresh-composer release,
retained-stream join recovery, one tone per answer through the registry, silent post-finish baseline) and
`lib/completion-delivery.test.mjs` (registry ownership, in-hand without a stream, seven idle visits released, silent
post-finish baseline).

## Verification at `2b14716` + this change (branch run)

- `pnpm verify --profile=fast` — PASS/PASS (workspace typecheck, workspace tests).
- `pnpm test:web:unit` — 2208 tests, 2186 pass, 22 fail; the failing name set is identical to the pre-ticket baseline
  (0 new, 0 gone).
- `node --test` on `lib/agent-event-connection.test.mjs`, `lib/completion-delivery.test.mjs`,
  `lib/lifecycle-projection.test.mjs`, `adapters/durable-lifecycle.test.mjs`, `hooks/useAgentSession.test.mjs`,
  `hooks/useAgentSession.lifecycle.test.mjs`, `hooks/context-usage.test.mjs`, `hooks/model-switching.test.mjs` —
  133/133.
- `apps/web/e2e/chat-lifecycle-background.mjs` — 43 checks, PASSED.
- `apps/web/e2e/chat-lifecycle-foreground.mjs` — 28 checks, PASSED (ticket 04's two proven reds still hold).
- The review's five reproductions — 5/5 pass after the fix (0/5 before).
- Proven red: with the implementation stashed and the new tests kept, `lib/agent-event-connection.test.mjs` and
  `lib/completion-delivery.test.mjs` are 0/16 and the browser driver fails 19 checks, including the poll's nomination
  acquiring nothing and a conversation left with a run in flight losing its stream.

## Verification at the merged tip `7ae9aa3`

Merged into `integration/chat-lifecycle` as `7ae9aa303058f4c740df226315db1a2cb71bd07c` (parents `2b14716` and
`93bc802`) by an isolated compare-and-swap in `.dev/worktrees/chat-lifecycle-merge`. Every check below ran in that
worktree against the merge commit, with `git status --porcelain` empty before and after.

- **Focused run, eight suites** — `node --test` over `lib/agent-event-connection.test.mjs`,
  `lib/completion-delivery.test.mjs`, `lib/lifecycle-projection.test.mjs`, `adapters/durable-lifecycle.test.mjs`,
  `hooks/useAgentSession.test.mjs`, `hooks/useAgentSession.lifecycle.test.mjs`, `hooks/context-usage.test.mjs` and
  `hooks/model-switching.test.mjs`: exit 0, 133 pass, 0 fail —
  `.dev/verify/focused-ticket05/focused-7ae9aa3.log`.
- **Review 82's five reproductions at the merged tip** — `node /tmp/chat05-review/five-findings.repro.mjs` with
  `REVIEW_ROOT` at the worktree: exit 0, 5 pass, 0 fail (F1 idle sources, F2 fresh-composer release, F3 retained-stream
  join, F4 one tone per answer, F5 silent post-finish baseline) — `.dev/verify/focused-ticket05/review-82-repro-7ae9aa3.log`.
  The same driver was 0 pass / 5 fail at `36e4dac` (`/tmp/chat05-review/five-findings.repro.log`).
- **`pnpm verify --profile=fast`** — exit 0, PASS/PASS (workspace typecheck, workspace tests), `dirty=false`,
  `sha=7ae9aa303058f4c740df226315db1a2cb71bd07c` — `.dev/verify/2026-10-13T00-11-55-109-verify-fast/verify.json`.
- **`pnpm test:web:unit`** — exit 1, 2208 tests, 2186 pass, 22 fail, `dirty=false`. The 22 failing names are
  byte-identical to the pre-ticket baseline at `e196ae0`
  (`.dev/verify/2026-10-12T20-15-20-249-web-unit/web-unit.tap`, 22 `not ok`, diff of the name sets empty). This suite is
  never claimed green — `.dev/verify/2026-10-13T00-13-07-558-web-unit/web-unit.json`.
- **`pnpm check:docs`** — exit 0, 152 Markdown files, 0 broken relative links, 0 guides missing.
- **`pnpm check:entrypoints`** — exit 0, 61 entry files present, 2 known-missing (pre-existing, recorded), 0 newly
  missing.
- **`node .scratch/chat-lifecycle/check-tickets.mjs`** — exit 0, 44 stories covered, 0 blocker problems, breakdown
  links ok.

No product source changed in this merge beyond ticket 05's own commits; no deployment, live host or paid provider was
contacted.

## Limits

- The stated limit stands and is asserted: a run that finishes entirely between two polls is never acquired and sounds
  nothing (scene 5 of the background driver), with the unread marker as the fallback. The absence-based tone is silent
  for it too, so the marker really is what the user gets.
- The absence-based background tone is otherwise dead code in normal use: every absence edge names a conversation the
  poll reported running, which is what nominated it. Ticket 06 removes it once this coverage is accepted.
- Nothing is deployed; no paid provider and no live host is contacted. The controlled endpoint is the driver's own
  OpenAI-completions server.
