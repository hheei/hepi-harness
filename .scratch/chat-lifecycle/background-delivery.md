# Background completion delivery — the practical contract

Design only. Baseline **83cc7c8**; branch `design/chat-lifecycle-facts`. Method: static source read against the pinned
tree and pi-durable 1.1.0 `dist/`; **no browser, server, model or test run**. Statements marked *[assumption]* are
inferred from source and not executed. Companions: `background-coverage.md` (what exists today),
`design-validation.md` (ordering/projection identity, review 73). This resolves the last design gate; it does not
approve a patch.

## The contract, in one paragraph

A completion notice is delivered **only** as an explicit native terminal fact observed on a live stream. The
existing selected-conversation SSE is **retained as the background stream** while that conversation still has an
unfinished answer interest, instead of being closed on unmount. Conversations the user is not looking at are
acquired by the **existing 2500 ms visible-tab poll**, which nominates candidates but never decides completion;
each nominated conversation gets one SSE connection whose **first `snapshot` frame is an atomic baseline**. The
sound fires from the terminal frame, keyed by answer, never from a `busy` transition or an absence.

## Ownership — above ChatWindow, not a new controller

- One interest map, owned by **AppShell**, using state it already holds (`runningSessionIds`, `AppShell.tsx:169`;
  `handleRunningSessionIdsChange`, `:170`; `handleBackgroundTaskDone`, `:137`). Not a module-global singleton, not a
  scheduler, not a second store.
- An **interest** is a conversation with an unfinished answer interest, or an observed run that has not been settled.
  The map is keyed by conversationId and holds, per entry, the outstanding submission/answer keys and the connection.
- **No second observer for one conversation.** `AgentEventConnection` (`apps/web/lib/agent-event-connection.ts`) already
  owns the EventSource, handshake and passive reconnect; it is extended with a subscriber list keyed by sessionId so
  the selected hook and the background interest **join one EventSource**, rather than opening a parallel one.
- **Transfer, once.** Selecting a conversation that has a background observer hands the existing subscription to the
  hook and marks the notice already owned; leaving hands it back. The connection object survives; ownership moves.
  A notice is emitted once per (conversationId, answer key) regardless of which owner was holding it.

## Acquisition

1. Poll unchanged: 2500 ms, visible tab only, one catalogue read for the whole set (`SessionSidebar.tsx:273,723`;
   `durable-api.ts:362`). It now **nominates** — busy, or an interest exists — and stops there. The selected
   conversation is polled like any other; it is not special-cased.
2. On nomination, open one SSE for that conversation if none exists (`GET /api/agent/<id>/events` →
   `server.ts:1453`; adapter `durable-api.ts:430`).
3. **Atomic baseline.** The handler reads the cached snapshot (`server.ts:1455`), writes `snapshot` and registers the
   client (`server.ts:1457,1459`) in one synchronous block with no `await` between; publish iterates `clients` in an
   async callback (`server.ts:415`, `:422`), so no commit can interleave. Everything after that frame is a **live**
   fact. *[assumption]*: this relies on `item.snapshot()` and `send()` staying synchronous, which they are today
   (`server.ts:459`, `:280-285`).
4. **Interest is registered and the stream acquired before the local submit is dispatched**, so a run that settles
   immediately after admission is still observed live rather than missed by ordering.
5. No interest ⇒ no stream. No catalogue-wide streams, no stream per catalogued conversation, no new endpoint.

## Notice rule

- A notice requires a **live terminal fact** received after acquisition: an input submission `done` carrying its
  native answer, or the answer entry joined by `answerId`. `unanswered` never notifies as success.
- **Key is the answer, not the input.** `(conversationId, answerId)`, falling back to `(conversationId, submissionId)`
  only when no answer id is available. Native `endRun` settles every `run.inputs` with one answer
  (`pi-durable dist/harness/live.js:24`), so a **steer group is one notice**; separate `submission` frames are
  deduplicated on that key with a bounded set, never one sound per record.
- A **queued follow-up** is its own later run and its own answer, so its own notice; the stream is **kept** while any
  interest remains, rather than closed after the first settlement.
- Never a notice from: a `busy` transition, a disappearance from the polled set, an acquired snapshot, a recovery
  lookup, or a resync.

## Silent by construction

| situation | behaviour |
| --- | --- |
| acquired snapshot shows a submission already terminal | silent — history, not a live fact |
| baseline acquired after the run ended | silent (see the limit below) |
| gap, reconnect or `resync_required` → recovery lookup | silent; the lookup repairs state, it is not a success signal |
| backend restart, fresh acquisition | silent; old callbacks fenced by the acquisition generation |
| opening a conversation with prior history | silent |

## Abort, failure, recall

Native `unanswered` carries a durable `reason` (`harness/submissions.js`); it is shown as failure state and never
plays the success tone. A user-initiated recall is not distinguished from a failed run without reading the reason
string; the design does not invent a `recalled` primitive, and neither case notifies.

## The one real limit, stated plainly

A run that **starts and finishes entirely between the poll and the acquisition** — or while the tab is hidden — is
never observed live. The native SSE snapshot carries the *outstanding* set only, so it holds no historical terminal
record, and the recovery lookup is deliberately silent. Under this contract such a run produces **no audio notice**.

That is the achievable live guarantee: **one notice per answer group for every run observed while an interest
exists.** It is narrower than today's coalesced poll guarantee, which rings on any `busy` disappearance — including
aborts, failures and subagent runs, and including runs that finished for no user-visible reason.

Universal background catch-up is **not** reachable without one of: an interest (and therefore a stream) on every
catalogued conversation — rejected here; or a bounded terminal summary on the existing catalogue row, which by
construction collapses everything that settled within one poll interval into one notice and so **cannot** preserve
one-notice-per-answer-group. Both are materially worse than the limit above; neither is invented here.

## Protocol deltas this contract needs

| delta | verdict |
| --- | --- |
| `answerId` on input `done` | **required** — the notice key; `projectSubmission` drops it today (`protocol/src/index.ts:166`) |
| `projectionId` + `revision` end-to-end | owned by `design-validation.md`; delivery adds nothing to it |
| scoped `submissionId` lookup | **not needed** — the notice path never requires an interest the browser cannot name by its own `requestId`, and recovery is silent |
| native batch envelope | optional; bounded key dedup covers separate frames |

## The one open product question

**Does the user accept a silent fallback for a run that finishes entirely while unobserved?** If yes, this contract
stands as written, with the unread marker (not audio) as the fallback for that case. If no, universal catch-up must be
bought explicitly — and the only honest way to buy it is the coalesced catalogue summary, accepting that several
answer groups inside one poll interval yield one notice. Everything else here is a consequence of that answer.
