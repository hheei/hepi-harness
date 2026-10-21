# Chat lifecycle: what happens between Send and the answer

Read-only diagnosis of the reported live bug, reproduced deterministically in a real browser against the real
production stack. No product code is changed: the only additions are the driver, a tagged trace module, and the
artifacts here.

## The report

Submitting a plain `test` in a **new conversation**: the completion sound plays immediately, the turn is visible for
about two seconds and then disappears, and switching away and back shows a conversation that will not load until the
real answer arrives.

## Method

Worktree `.dev/worktrees/chat-lifecycle-repro`, branch `impl/chat-lifecycle-repro`, base `83cc7c8` (isolated from
`integration/p1`).

Driver `apps/web/e2e/chat-lifecycle-repro.mjs`: production Next build, real backend and gateway
(`apps/server/scripts/image-submit-fixture.ts`), real composer and real `/api/agent` routes. The model is the
driver's own OpenAI-completions endpoint held at five named barriers — **modelreqseen, admission, beforefirsttoken,
firsttoken, finalanswer** — each released by the driver, so a held state is a real in-flight request and never a sleep.

Three layers of observation, all tagged `CHAT-LIFECYCLE-REPRO INSTRUMENTATION`:

1. **Browser, observation only** (`addInitScript` in the driver): per-frame DOM trace, every `EventSource` frame,
   `AudioContext` oscillator starts, `Notification` constructions. No handler replaced, no value changed.
2. **Call-site trace** (`apps/web/lib/chat-lifecycle-trace.ts`, called from `useAgentSession.ts` and
   `ChatWindow.tsx`): records which root reached each lifecycle decision — `durable_state`, `durable_state.becameIdle`,
   `notifyPromptStage->onAgentEnd`, `ChatWindow.wrappedOnAgentEnd`, `agent_settled`, `prompt_done`,
   `promoteNewSession.rekeyPending`, `loadSession.start`/`setLoading`.
3. **Wire facts**: the submission projection (`status`, `entryId`), the native task list, the partial length — recorded
   per frame, so a decision can be compared against what the runtime actually said.

## Red feedback loop

```
pnpm install --frozen-lockfile
pnpm --filter @hepi/web build
HEPI_CL_WEB_PORT=43160 HEPI_CL_BACKEND_PORT=44160 HEPI_CL_OUT=$PWD/.scratch/chat-lifecycle/run \
  node apps/web/e2e/chat-lifecycle-repro.mjs; echo "exit=$?"
```

**exit 1**, three failing checks, identical set over five consecutive runs (ports 43190/43191/43192/43193 and the
earlier set). Control: the pre-existing `apps/web/e2e/ux-nav-new-session.mjs` **passes** in the same worktree against
the same built app and the same fixture backend.

## The callsite chain, tagged (scene 1, held before the first token, one send of `test`)

| t | record |
| --- | --- |
| 1366 | `durable_state` — **`busy:false`, `submissions:[]`, `entryCount:0`, `liveTools:[]`**, `agentRunningBefore:true` |
| 1366 | `durable_state.becameIdle` — `submissionFacts:[]`, `nativeTasks:0` |
| 1366 | `notifyPromptStage->onAgentEnd` — `runId:1`, `agentRunning:false` |
| 1366 | `ChatWindow.wrappedOnAgentEnd` — **`playsSound:true`** |
| 1372 | `promoteNewSession.rekeyPending` — `from:"new:…:/workspace/local"`, `to:"28"`, `equal:false`, `keys:["28"]`, `pendingAfterRekey:["ff092db4…"]` |
| 1379 | `durable_submission` `placed` (`entryId:"36"`), then `durable_state busy:true` |

The sound is reached from the **first state frame of the new session's stream**, which is a snapshot taken before the
run started: it carries `busy:false`, an empty outstanding set and no tasks. The run is still held at
`beforefirsttoken`; the answer does not arrive until ~10 400 ms.

Free-running (scene 0, the reported path): sound at 1552 ms, first `busy:true` at 1587–1596 ms — **35–42 ms early**
across five runs. The `runId` guard suppresses the *second* `becameIdle` at the real settle, so exactly **one spurious
sound** is played per run.

## What the wire says versus what the surface decides

The protocol carries real facts: `durable_submission` frames with `status: placed → done` and the `entryId` each
submission owns, and `durable_state.submissions` with the same. In every recorded run `liveTools` was empty and
`partial` was empty — there are no native task facts to contradict. The surface's idle decision, however, reads only
the `busy` boolean: at 1366 that boolean says "not busy" while the submission is not merely unfinished but **not yet
named at all** (`submissions:[]`, `entryCount:0`). The bool is the frame's opinion about the run; the submission
projection is the durable fact, and the two disagree in this frame.

## Hypotheses: status after the traces

| # | Hypothesis | Status | Evidence |
| --- | --- | --- | --- |
| H1 | The sound fires on an early idle transition, not at the answer | **Confirmed** | tagged chain above; 35–42 ms before `busy:true`; one spurious sound per run |
| H2 | The pending turn is lost because the promotion rekey mismatches keys | **Falsified** | `promoteNewSession.rekeyPending`: `equal:false` but `keys:["28"]` and `pendingAfterRekey` holds the staged `requestId`; the store is keyed by the session and the turn is readable under it |
| H3 | Switching back cannot load until the answer arrives | **Falsified** | the `Loading session…` placeholder is bound to the conversation read, not the run: windows of 17–18 ms across runs, against `loadSession.start showLoading:true` → `setLoading(false)` of 15–16 ms. The read is independent of the answer |
| H4 | The pending set is ended by a turn's absence from the outstanding set | **Falsified** | `pendingAfterOutstanding` keeps the staged turn as `sending` even when the frame's `submissions` is `[]` — absence is not read as a fact, exactly as [ADR 0006](../../docs/adr/0006-durable-submission-lifecycle.md) requires. The turn ends later by its own committed entry (`pendingAfterCommitted` empties once `entryId` 36 is in `entryIds`), which is the designed path |

## What is left standing

One reproducible defect: **the completion sound is played for a run that has not started**, because the first
`durable_state` frame of a new session's stream is a pre-run snapshot and `becameIdle`
(`apps/web/hooks/useAgentSession.ts:1505`) reads its `busy:false` as "the run finished". The root reaches
`notifyPromptStage` (`:1231`), whose only guard is a run-id equality check, and then `onAgentEnd` →
`ChatWindow.wrappedOnAgentEnd` (`apps/web/components/ChatWindow.tsx:272`) → `playDoneSound`.

Two reported symptoms are **not** reproduced as defects here and are reported as such:

- **The ~2 s vanish.** The pending marker is dropped at admission (~15 ms) and the placeholder is a 17–18 ms read. The
  turn's text never leaves the transcript. No screen state matching "visible for two seconds then gone" was observed.
- **Cannot load until the answer.** The placeholder is bound to the conversation read, which is independent of the run
  and the answer.

## Reproduce

```
git -C .dev/worktrees/chat-lifecycle-repro log --oneline -1
pnpm install --frozen-lockfile
pnpm --filter @hepi/web build
HEPI_CL_WEB_PORT=43160 HEPI_CL_BACKEND_PORT=44160 HEPI_CL_OUT=$PWD/.scratch/chat-lifecycle/run \
  node apps/web/e2e/chat-lifecycle-repro.mjs
```

Red loop detail and the run-by-run table: [`red-loop.md`](red-loop.md). Raw evidence:
`run/timeline.jsonl`, `run/scene0.json` … `scene3.json`, `run/summary.txt`.

## Cleanup

Delete `apps/web/e2e/chat-lifecycle-repro.mjs`, `apps/web/lib/chat-lifecycle-trace.ts`, and every line tagged
`CHAT-LIFECYCLE-REPRO INSTRUMENTATION` (10 sites in `useAgentSession.ts`, 2 in `ChatWindow.tsx`, 1 export in
`submission-reconciliation.ts`, 1 import each).

## Second pass: full AppShell topology, no artificial gate (scene 4)

The first pass ran the real Next build, backend, gateway and composer, but entered the flow through the shell's own New
affordance and never held anything but the model. This pass adds the missing piece the review named — the full
`AppShell` promotion/remount path, with **nothing held except the provider** — so the restore read, the promotion
remount and every adapter request run at their own pace. That is what separates a causal gate from a live fact.

Provider held at `beforefirsttoken`; at the moment it was entered the DOM said
`{pending: 0, waiting: true, phase: "Waiting for model...", turnOnScreen: true}` — the turn and the wait indicator are
both on screen with the run genuinely in flight.

### Promotion and the pending key transfer (tagged, one run)

| t | record |
| --- | --- |
| 1361 | `promoteNewSession.rekeyPending` — `from:"new:84a22668…:/workspace/local"`, `to:"67"`, `keys:["67"]`, `pendingAfterRekey:["fa4f1280…"]` |
| 1361 | `AppShell.handleSessionCreated` — `sessionId:"67"`, `sourceDraftKey:"new:84a22668…"`, `transient:true`, `previousSessionKey:0` |
| 1364 | `adoptPending` — `composerKey:"67"`, `keys:["67"]`, `adopted:[{requestId:"fa4f1280…", status:"sending"}]` |
| 1361 | `durable_state{busy:false, submissions:[], entryCount:0}` → `becameIdle` → `notifyPromptStage` → **sound** |
| 1368 | `durable_submission placed` (`entryId:"75"`), `durable_state busy:true` |

The transfer is complete in **3 ms** and loses nothing: the store is keyed `67`, the remount adopts under `67`, and the
adopted turn is the same `requestId` that was staged. No orphan key, no dropped turn. The sound still fires at 1361,
one frame after admission and while the provider is held — the same defect, now on the full shell.

### Restore with the provider held and no gate

| fact | value |
| --- | --- |
| conversation read `/api/sessions/67?…&force=1` | **5 ms server, 0 ms queued** (Resource Timing) |
| loading placeholder | 17–18 ms, bound to that read (`loadSession.start showLoading:true` → `setLoading(false)`) |
| turn back on screen | 66–83 ms after the click |
| wait indicator missing after the chat painted | **0 frames** |
| what carried the wait back | the reopened SSE: `connected`, then `durable_state{busy:true, submissions:["placed"]}` |
| requests in flight during promotion | peak **9**; max queueing delay **6–9 ms** |
| longest-lived request | the SSE stream itself (`duration` = still open), nothing blocked behind the provider |

**No HTTP request waits on the provider.** Every read answers in single-digit milliseconds; the only long-lived
request is the event stream, which is supposed to stay open. There is no adapter lock or per-origin serialization:
nine requests were in flight at once with sub-10 ms queueing. The "wait vanished / would not load until the answer"
symptom does not reproduce on the full topology — the returning conversation paints its turn and its wait indicator
together, 66–83 ms after the click, with the provider still held.

### What this does and does not settle

- **Causal gate, not a live fact:** the review's `HTTP only clears loading` finding needs an artificially held
  `GET /api/sessions/:id` response to appear. In the ungated live path that read takes 5 ms, so the placeholder never
  masks a ready view. The gate is real in the code; it is not what the live report hit.
- **Unverified and still open:** the sustained ~2 s disappearance and the "cannot load until the answer" behaviour are
  not reproduced here on either topology. Something in the deployed environment (auth, reverse tunnel, gateway,
  a provider that is slow to *enter*, a colder cache) is still unaccounted for. No further gate is added for it.
- **Confirmed on both topologies:** the premature completion sound. One root, one fix site.

Validation, all five runs (ports 43200, 43201, 43210, 43211, 43212/43213): identical four failing checks —
`scene0: the completion sound did not precede the run starting`, the two `scene1` sound checks, and
`scene4: no completion sound while the provider is held before the first token`. Every other check passes, including
the new scene-4 ones.

