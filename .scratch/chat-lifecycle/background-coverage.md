# Background completion coverage — where it stands, and the smallest honest migration

Design only. Baseline `83cc7c8`; companion to `facts.md` (design B). Source-read, not run: no product patch, no build,
no live host write. Numbers are line references at this revision, not measurements.

## What exists today, exactly

A **boolean diff over a polled busy set**. Nothing more.

1. **Source of the boolean.** `catalogueEntry` (`apps/server/src/server.ts:753`) reports `busy: current.busy`, which
   `project` sets from `live?.run !== undefined` (`server.ts:243`) — the same `busy` field whose pre-run idle value
   causes H1. The catalogue route (`server.ts:1277`) returns one such row per conversation.
2. **Transport.** `durableApi` passes `runningSessionIds` straight from `catalog.conversations.filter(item => item.busy === true)`
   on both `/api/sessions` (`durable-api.ts:335`) and `/api/agent/running` (`durable-api.ts:362`). One catalogue read, no
   per-conversation request — the adapter's own tests assert zero `/state` reads per poll.
3. **Poll.** `SessionSidebar` every `RUNNING_SESSIONS_POLL_MS = 2500` (`SessionSidebar.tsx:273`), and **only while
   `document.visibilityState === "visible"`** (`SessionSidebar.tsx:723,727`); `visibilitychange` polls immediately on return.
   `/api/sessions` seeds the set once and is then ignored (`runningPollAuthoritativeRef`, `SessionSidebar.tsx:470,620`).
4. **Decision.** An effect diffs the previous set against the current one (`SessionSidebar.tsx:802`):
   `completedInBackground = previous \ runningSessionIds`, minus the selected session. Two filters are then applied —
   `previousSuppressedCompletionSessionIdsRef` and `knownSubagentIds` — to get `completedWithNotifications`
   (`SessionSidebar.tsx:808`). Markers are written (`SessionSidebar.tsx:816-817`) and `onBackgroundTaskDone?.()` fires
   (`SessionSidebar.tsx:826`).
5. **Effect.** `handleBackgroundTaskDone` → `if (soundEnabledRef.current) playDoneSound()` (`AppShell.tsx:137-139`). It
   plays a **tone only**. The browser notification comes from the other path, `handleAgentEnd` (`AppShell.tsx:1012`),
   which is reached from the *selected* conversation's own hook.

So background coverage is: *an id I previously observed busy is now not busy, and a visible-tab poll caught the
transition*. That is absence-based inference at conversation granularity — the shape ADR 0006 forbids at turn
granularity. It reports **that something stopped**, never **how it ended**; no reason, entry or answer id is on this path.

## Why the boolean is wrong, in its own terms

- **The poll's blind window is the feature's whole use case.** The tab must be visible for the poll to run, so a user in
  another tab — the person the sound is for — gets nothing. The 2500 ms cadence also drops a run that starts and ends
  between two polls: never observed busy, so never observed finishing.
- **It inherits H1.** The same `busy` flicker that plays a spurious in-conversation sound can, if the poll lands in the
  gap, read as *completed* for a conversation the user is not looking at.
- **Two of its three filters are dead code today.** `completionNotificationSuppressedSessionIds` is emitted only by the
  vendored upstream routes (`apps/web/vendor/pi-web/lib/rpc-manager.ts:2251`) and **never by this project's adapter** —
  `grep` finds no occurrence in `apps/web/adapters/*.ts`, so that set is always empty. And `knownSubagentIds` filters
  `allSessions` on `relation?.kind === "subagent"`, but `catalogueRow` only ever emits `kind: "fork"`
  (`durable-api.ts:118`) and the backend reports no other relation (`server.ts:753`), so that set is empty too — while
  `AgentSessionPanel.tsx:84` still reads `relation?.kind === "subagent"`, so the port dropped the source, not the
  consumer. Net: a task-owned (subagent) conversation that stops running is not suppressed and can ring the completion
  tone. That is a live wrong-bool path, not a hypothetical; review 73 saw the same filter and recorded it as not
  implicated by its ChatWindow-only reproduction.

## Native lifecycle facts already reachable on current routes

No new endpoint, table, epoch, channel or scheduler is needed for any of these.

| fact | how it is already obtained | what it gives |
| --- | --- | --- |
| terminal run, with reason | `scanTasks({conversationId, kind: "pi.generation", order: "descending"}, 1, cursor)` — already called at `server.ts:272` | `state.status`, `state.outcome {status: completed\|failed\|faulted, result, error, reason}` |
| run start and end wall-clock | `TaskRecord.startedAt` / `endedAt` (`pi-durable dist/types.d.ts`) | a monotonic `endedAt` to diff on, and a duration, with no client timer |
| the transition itself, pushed | `harness.subscribeCommits` (`server.ts:357`), whose `CommitPublication.changes` includes `type: "task"` | the terminal transition delivered, not polled for |
| per-turn outcome | `GET /api/conversations/:id/submissions?requestId=` (`server.ts:1330`), `scanSubmissions`, `submissionByRequest` | the turn-level fact design A/B already rely on |

The catalogue row already carries `busy`, `revision`, `messageCount`, `firstMessage`, `title`,
`parentConversationId`. The pattern for keeping a per-conversation value current from the commit stream **without a
second stream** already exists in this file: `title` and `deletedAt` are read once at attach and updated from
`stopTitleWatch` (`server.ts:357-376`).

## Minimum migration support

**Do not** give each catalogued conversation its own event stream. N conversations would mean N permanent SSE
connections and N server-side attach records, to answer a yes/no that one catalogue read already answers.

1. **Replace the absence edge with a terminal record.** Report on the existing catalogue row, per conversation, the
   newest generation task's terminal `endedAt` and `outcome.reason` (plus `startedAt` while non-terminal). Both come
   from the one `scanTasks` call shape already used at `server.ts:272`, or from a `task` commit kept current in the
   attach's own map — the `title`/`deletedAt` pattern. The row grows two fields; the poll keeps its cost.
2. **Diff on `endedAt`, not on set membership.** The sidebar replaces
   `!runningSessionIds.has(id)` with `lastRunEndedAt(id) > previousLastRunEndedAt(id)`. That is the same change A and B
   make at turn granularity, applied at conversation granularity: a completion is a committed terminal fact, never an
   absence.
3. **Fix the suppression sources rather than keeping them.** Either the backend reports the subagent/background flag on
   the row (it has `record.owner !== undefined` for a subagent conversation, `server.ts:1419`, and `TaskRecord.background`
   exists natively) and the adapter forwards it, or the client filter is deleted. Leaving a filter that is provably
   always-empty is the "silently keeping the wrong bool path" case; deleting it without replacing the source would ring
   for subagents, so the source has to come first.
4. **Keep the poll.** It is the right transport for a tab that is only sometimes visible, it is already one read for the
   whole catalogue, and it does not need to become a subscription to carry two more fields.
5. **Leave `busy` in place for what it legitimately drives** — the sidebar's running dot, `sessionRunning` for the
   event-stream lease (`AppShell.tsx:2519` → `useAgentSession.ts:188`), and the archive guard. Only the *completion*
   decision moves off it.

## Open, unresolved

- **The user's second symptom is still not reproduced.** No model-dependent stall is claimed by this note or by
  `facts.md`. Scene 4 held the provider with ungated HTTP and the wait indicator dropped for 16-17 ms at the premature
  sound, then returned; the loading placeholder lasted 17-18 ms. The sustained disappearance the user reports has no
  reproduction at this revision.
- **Which granularity rings?** The current path rings once per conversation that stopped. Under the native facts a
  conversation can have several runs; the row's "newest terminal run" rings once per run, which matches today's
  behaviour only if one run per conversation is assumed. Grouping belongs with the answer-group rule in `facts.md`.
- **Does the sound belong to this path at all?** `playDoneSound` is reached from two places today (`AppShell.tsx:137`
  and `ChatWindow.tsx:272`). Consolidating them is part of design A/B, not of this note.
