# Red feedback loop

Driver `apps/web/e2e/chat-lifecycle-repro.mjs`, worktree `.dev/worktrees/chat-lifecycle-repro`, branch
`impl/chat-lifecycle-repro`, base `83cc7c8` (its own persistent worktree; `integration/p1` is untouched).

## Command

```
pnpm install --frozen-lockfile
pnpm --filter @hepi/web build
HEPI_CL_WEB_PORT=43160 HEPI_CL_BACKEND_PORT=44160 HEPI_CL_OUT=$PWD/.scratch/chat-lifecycle/run \
  node apps/web/e2e/chat-lifecycle-repro.mjs; echo "exit=$?"
```

## Result at 83cc7c8

**exit 1 (red), 4 failing checks**, identical set on eight consecutive runs:

| check | measured |
| --- | --- |
| scene0: the completion sound did not precede the run starting | sound 1552 ms, first `busy:true` 1587 ms — 35 ms early |
| scene1: no completion sound before the answer | sound at ~1367 ms, answer at ~10 400 ms (run held) |
| scene1: no completion sound while the answer is still streaming | same sound, run still held |
| scene4: no completion sound while the provider is held before the first token | sound 1361 ms, provider entered at 30 418 ms (full AppShell, no gate) |

Twenty-nine other checks pass, including the answer reaching the screen, no page error, and the whole of scenes 2–4.

## Scene 4: full AppShell, provider held, no artificial gate

The run that answers the review's open question. Nothing is held but the model, so every promotion, restore and adapter
request runs at its own pace.

| fact | value (5 runs) |
| --- | --- |
| pending key transfer | `new:…:/workspace/local` → `67`, store keys `["67"]`, adopted `sending`, 3 ms, nothing lost |
| `GET /api/sessions/67?…&force=1` | 5 ms server, 0–1 ms queued (Resource Timing) |
| loading placeholder | 17–18 ms, bound to that read |
| turn back on screen | 66–83 ms after the click |
| wait indicator missing after paint | **0 frames** |
| what restored the wait | reopened SSE `connected` → `durable_state{busy:true, submissions:["placed"]}` |
| requests in flight during promotion | peak 6–9; max queueing 6–9 ms |
| requests blocked behind the provider | none |

Verdict: no adapter lock, no serialization, no HTTP request waiting on the provider. The `HTTP only clears loading`
gate is real in code but needs an artificially held response to show, and the sustained disappearance does **not**
reproduce on this topology.

## Run-by-run

| run | port | sound | first `busy:true` | early by | answer |
| --- | --- | --- | --- | --- | --- |
| 9 | 43167 | 1539 | 1575 | 36 ms | 1599 |
| 10 | 43165 | 1545 | 1582 | 37 ms | 1605 |
| 11 | 43166 | 1539 | 1575 | 36 ms | 1599 |
| 13 | 43191 | 1554 | 1596 | 42 ms | 1613 |
| 132 | 43192 | 1554 | 1596 | 42 ms | 1621 |
| 133 | 43193 | 1552 | 1587 | 35 ms | 1613 |

The sound lands one animation frame after the SSE `durable_state` frame carrying `busy:false` and
`submissions:[]`, and its tagged root chain is
`durable_state` → `durable_state.becameIdle` → `notifyPromptStage->onAgentEnd` →
`ChatWindow.wrappedOnAgentEnd`.

## The two falsified symptoms, measured

| symptom | measurement | bound to |
| --- | --- | --- |
| switch away and back "cannot load" | placeholder windows 17, 18, 18 ms | `loadSession.start showLoading:true` → `setLoading(false)`, 15–16 ms — the conversation read, not the run |
| the turn "vanishes" | pending marker dropped at admission (~15 ms); the transcript entry stays | the turn's own committed entry, per ADR 0006 |

## Control

`apps/web/e2e/ux-nav-new-session.mjs` **passes** in this worktree against the same built app and fixture backend.

## Artifacts

- `run/timeline.jsonl` — ordered records: barrier arrivals/releases, model requests, HTTP requests and responses,
  console messages, checks.
- `run/scene0.json` … `scene3.json` — DOM/SSE/audio/notification snapshots, the per-frame trace, and the tagged
  call-site roots for that scene.
- `run/summary.txt` — the failing checks of the last run.
- `/tmp/hepi-chatlife-*/` (printed by the run) — backend and Next child-process logs.
