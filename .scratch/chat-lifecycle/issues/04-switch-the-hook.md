# 04: Switch the conversation surface to the projection

**What to build:** The open conversation reads its lifecycle from the projection and nothing else. The hook keeps
transport, cache, remount and rendering; the chat surface renders the view and reacts to notices. The locally invented
authorities are deleted rather than layered: the became-idle completion path and its prompt-run identity refs, the
finish-without-stream and wait-for-settlement helpers with their idle polling, the independent loading gate on session
load, the duplicated stream hydration, the SDK-active and RPC-pending refs used as durable authorities, and the
pending-by-key / key-alias / last-published fallback maps. The completion tone has exactly one owner, driven by an
answered notice.

**Blocked by:** 03: Transport facts and the acquisition fence

**Status:** resolved — implemented on `impl/chat-lifecycle-04` at `66bc00c`, merged into `integration/chat-lifecycle` as `e196ae0` after the review round that fixed four defects at `6233476`. Verification below.

**Stories:** 1–6, 40

**Seam:** the browser, through the existing Web adapter and a real backend, with the real completion callback
recorded — the pattern the reproduction fixture already uses, including a held HTTP endpoint and its negative
controls.

- [x] Sending a first message plays no completion tone before the provider is entered; the recorded callback fires
      only after the answer exists.
- [x] A held HTTP read cannot keep the surface on Loading when a complete stream projection has arrived.
- [x] The transcript, the pending overlay, the answer interest and the running indicator all come from the projection,
      and the running indicator still comes from the catalogue the shell already polls.
- [x] A steer group sounds once, a queued follow-up sounds later once, and an abort or failure shows its reason with no
      success tone.
- [x] The replaced authorities are deleted, not left beside the projection; the two proven reds have regression
      coverage at this seam; the existing browser suite for the conversation surface still passes.
- [x] No test asserts source text and no test sleeps.

**Context:** [Spec](../spec.md) decisions 1, 5, 6 and 8, and the proven reds recorded in
[diagnosis.md](../diagnosis.md) and [red-loop.md](../red-loop.md). Background delivery is ticket 05; the removal of the
old background tone happens only after ticket 05's coverage acceptance.

## Implementation report

Branch `impl/chat-lifecycle-04` in worktree `.dev/worktrees/chat-lifecycle-04`, based on
`integration/chat-lifecycle` at `7226473` (ticket 03) with the spec/ticket import `bb1eb09` merged before this
report. The work is in the commits at the tip of that branch; the source revision every check below ran against is the
branch tip named in the report to the parent, and each log path is under the git-ignored `.dev/verify/`.

**What the open conversation reads now.** `apps/web/hooks/useAgentSession.ts` holds one projection value
(`apps/web/lib/lifecycle-projection.ts`, created through `createProjection` and advanced through `advance`) and
reads the transcript, the staged overlay, the answer interest and the running indicator from its view. The hook keeps
transport, cache, remount and rendering: it performs the fold's requested I/O (the request-id recovery lookup, the
reattach) and it acts on the fold's notices. `apps/web/lib/lifecycle-store.ts` keeps one value per composer or
conversation across the promotion remount, and `apps/web/lib/lifecycle-acquisition.ts` stamps each read or stream
with the client acquisition it began under.

**Deleted, not layered.** `becameIdle` and `notifyPromptStage` with `promptRunIdRef`/`notifiedPromptRunIdRef`;
`finishPromptWithoutStream`, `waitForPromptSettlement` and `checkServerIdle` with their idle polling;
`sdkAgentActiveRef` and `rpcPromptPendingRef` as durable authorities; the independent `loading` gate on the
conversation read; the second transcript the stream hydration wrote; and `apps/web/lib/submission-reconciliation.ts`
with its `pendingByKey`/`keyAliases`/`lastPublished` fallback maps and its test file, replaced by the projection,
the store and `pendingMessage`. `ChatWindow`'s unqualified `onAgentEnd` sound is no longer reached from a transport
event: the tone is driven by the `answered` notice alone. The sidebar's absence-based background boolean and
`AppShell`'s `onBackgroundTaskDone` are untouched — ticket 05 owns that coverage gate and ticket 06 its removal.

**Checks.** All on the branch tip, all in the isolated worktree; the web unit suite is never claimed green.

| Check | Exit | Result |
| --- | --- | --- |
| `pnpm verify --profile=fast` | 0 | PASS/PASS (workspace typecheck, workspace tests) |
| `pnpm test:web:unit` | 1 | 23 failing names, the recorded baseline; 0 new against the ticket-03 tip's set, 9 pre-existing failures in the files this ticket rewrote were repaired |
| `node --test apps/web/lib/lifecycle-projection.test.mjs` | 0 | 34 pass, 0 fail |
| `node --test apps/web/adapters/durable-lifecycle.test.mjs` | 0 | 11 pass, 0 fail |
| `node --test apps/web/hooks/useAgentSession.test.mjs` | 0 | 47 pass, 0 fail |
| `node --test apps/web/hooks/context-usage.test.mjs` | 0 | 5 pass, 0 fail |
| `pnpm --filter @hepi/web build` | 0 | production build |
| `node apps/web/e2e/chat-lifecycle-foreground.mjs` | 0 | PASSED, 27 checks (both proven reds green with their negative controls) |
| `ux-nav-new-session`, `ux-visible-turns`, `ux-submission-recovery`, `ux-truthfulness`, `ux-nav-flicker`, `ux-missing-model-recovery`, `ux-image-submit` | 0 | each PASSED |
| `pnpm check:docs` | 0 | 0 broken links, 0 guides missing |
| `pnpm check:entrypoints` | 0 | 0 newly missing |

**The two proven reds.** `apps/web/e2e/chat-lifecycle-foreground.mjs` holds the driver's own model endpoint at named
barriers (a real in-flight request, not a sleep) and records the application's own completion callback. Scene 1
asserts no tone while the provider is held before its first token, with the run genuinely busy on the wire as its
control, and exactly one tone after the terminal answer fact. Scene 2 holds the conversation read and asserts the
surface leaves Loading on the stream's complete projection, with a second control that holds both transports and
observes the placeholder and the absent transcript — so the first check is not vacuous.

## Review round: four defects, fixed at their owning seam

The first review of this ticket reproduced four defects at `74cda04`. Each is fixed where the defect actually lives, and
each has a behavioural test that fails at `74cda04` and passes now (the harness bundles the real hook with esbuild and
runs it against this file's own React, `EventSource`, `fetch` and timers, so the assertions are about what the hook
does, not about the text of its source).

1. **The acquisition sequence had two owners** (`apps/web/hooks/useAgentSession.ts`). The hook kept a counter beside the
   projection, starting at zero on every mount, while `lib/lifecycle-store.ts` restored a projection whose generation was
   already past it — so the new mount's own read and stream were stamped *below* the accepted generation and fenced out
   forever. Switching away during a run and back froze the surface on the state the switch left behind. The projection is
   now the single owner of the number: `lib/lifecycle-acquisition.ts` exports `nextAcquisition(accepted)` instead of a
   caller-side counter, `beginRead` stamps from `state.generation`, and the stream's callbacks read the same value.
2. **A reconnect fabricated a lookup result instead of making the request** (same file). `recoverPendingTurns` folded
   `{ kind: "lookup", record: null }` for each waiting turn — a statement that the lookup answered null when no lookup had
   been made, so no request went out and the turn stayed unknown for good. The unresolved registry is the projection's, so
   the fold now owns a `recover` intent that enumerates it and requests one `lookup` effect per unresolved turn, and the
   hook's effect performs the real by-id request. Still no resend, and a lookup that finds nothing is still unknown.
3. **A first send whose session could not be created left a ghost turn** (same file). The refusal was only folded when a
   session id existed, so a failed create left the staged turn on screen with no error, no draft restored and no way out.
   A refusal is this surface's own answer about one staged turn and may name no conversation; `Refusal.conversationId`
   is optional, the fold settles the turn and emits the `refused` notice either way, and a refusal that names a
   *different* conversation than the bound one is still a contradiction.
4. **A refused steer restored its text and images twice** (same file). `sendStreamingPrompt` called `restore()` beside
   folding the refusal, while the `refused` notice already restores the staged content — so the text and images were
   duplicated in the composer. The notice is the single owner of that restore.

**Review notes, recorded and not fixed** (no material failure found, per the review policy). `lib/lifecycle-store.ts`
keeps `aliases` and a module-global `lastPublished` fallback for a read that names no key; the only caller is
`useAgentSession`, which always names either the session id or the composer's draft key, so the fallback has no reachable
caller in normal use. The source-text assertions in `hooks/useAgentSession.test.mjs` are recorded rather than extended:
the four regressions above are covered by the behavioural harness instead, and the three source assertions this round
touched were updated only because the code they name changed shape. Both are `record` dispositions, not blocking: each
is revisited only on an actual user incident, new evidence of material impact, or explicit user prioritization, and
neither is a reason to hold this ticket or the ones after it.

**Limitations.** The reported sustained multi-second stall is not reproduced at this revision and this ticket does
not claim to fix it. Background completion is ticket 05: a run finishing while the user looks at another conversation
still relies on the sidebar's absence-based tone, which this ticket deliberately leaves in place, and the two
provably-empty suppression filters are fixed at their source in ticket 06. The acquisition fence is exercised at the
projection and adapter seams and in the browser's foreground path; the cross-restart schedule (a delayed read from a
previous backend arriving over a fresh stream) is covered as a projection and adapter case, not by a browser restart.
A steer group whose inputs share one answer is one notice at the projection seam and one tone per distinct answer in
the browser.

## Verification

Implemented on `impl/chat-lifecycle-04` at `66bc00c5191f3e35fa820a7576fd0c747c466a49` (`09da4b5` the switch,
`74cda04` the recorded run, `6233476` the four review fixes, `66bc00c` the recorded run at the fixed revision),
merged into `integration/chat-lifecycle` as `e196ae01005fe628ac7c14ec08be5c256d66e9fe` (parents `bb1eb09` and
`66bc00c`) by an isolated compare-and-swap.

- **Review.** The first review reproduced four defects at `74cda04` — the acquisition counter owned twice, a fabricated
  lookup instead of the request, a ghost turn after a failed session create, and a refusal restoring its content twice —
  each recorded with its repro output in `.dev/verify/focused-ticket04/defects-74cda04.log`. All four are fixed at
  `6233476` and each has a behavioural test that fails at `74cda04` and passes at the tip.
- **Independent re-review focused run at `66bc00c`** — `node --test` over the hook, projection and adapter suites:
  117 pass, 0 fail, exit 0 — `/tmp/chat04-rereview-66bc00c-focused.log`, copied to
  `.dev/verify/focused-ticket04/rereview-66bc00c.log` in the integration worktree.
- **At the merged tip `e196ae0`,** `node --test` over `hooks/useAgentSession.lifecycle.test.mjs`,
  `hooks/useAgentSession.test.mjs`, `hooks/context-usage.test.mjs`, `lib/lifecycle-projection.test.mjs`,
  `adapters/durable-lifecycle.test.mjs` and `adapters/durable-api.test.mjs` — exit 0, 119 pass, 0 fail. The count is
  119 rather than 117 because the two runs select different files from the same suites.
- **`pnpm verify --profile=fast` at `e196ae0`,** `dirty=false`, exit 0, PASS/PASS (workspace typecheck, workspace
  tests) — `.dev/verify/2026-10-12T20-12-51-943-verify-fast/`.
- **`pnpm test:web:unit` at `e196ae0`** — 2192 tests, 2170 pass, 22 fail, exit 1, `dirty=false`
  (`.dev/verify/2026-10-12T20-15-20-249-web-unit/`). The failing-name set is identical to the `66bc00c` run
  (`.dev/verify/2026-10-12T19-44-29-054-web-unit/`), which is the recorded pre-existing baseline; this suite is never
  claimed green.
- **Browser evidence is recorded, not re-run at the merge tip:** `node apps/web/e2e/chat-lifecycle-foreground.mjs`
  exited 0 at `66bc00c` with all four scenes passing, their negative controls and observed wire frames kept under
  [foreground/](../foreground/). The merge tree is byte-identical to `66bc00c`, so no source changed after that run.
- **`pnpm check:docs`** — 0 broken relative links, 0 guides missing from the index, exit 0.
- **`pnpm check:entrypoints`** — 61 entry files present, 2 known-missing (pre-existing, recorded), 0 newly missing,
  exit 0. `node .scratch/chat-lifecycle/check-tickets.mjs` — 44 stories covered, 0 blocker problems, exit 0.
