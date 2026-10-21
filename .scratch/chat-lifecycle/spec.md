# Chat lifecycle — specification

Status: **complete.** The product owner approved the background delivery contract (contract A: an explicit
native terminal fact observed on a live stream, scoped to unfinished interest, with a silent fallback for a run that
finishes entirely unobserved) on 2026-10-13 and authorized this specification and its ticket breakdown. On the same
day the product owner invoked `implement-spec`, which authorized implementing tickets 01-06 and merging them into
`integration/chat-lifecycle`; deployment, configuration, host and release changes stay unauthorized and none was made.
All six tickets are resolved and merged, ticket 06 as `e7c7555`; the two-axis final review over
`0cf5a32` (product tree identical to `cb8ae3b`) reports no material finding on either axis, and its record is
[review-notes.md](review-notes.md).

This specification was authored as documentation against baseline `83cc7c8` on branch `docs/chat-lifecycle-spec`;
that change touched no application source, protocol build, deployment configuration or live host. Implementation
status lives per ticket under [issues/](issues/) and in [ticket-breakdown.md](ticket-breakdown.md), and the delivered
behaviour is owned by [docs/chat.md](../../docs/chat.md) and [docs/verification.md](../../docs/verification.md).

Sources, in this directory: [design.md](design.md) (consolidated design, commit `c4d7154`),
[design-validation.md](design-validation.md) (critical validation 73, commit `28e18d9`),
[background-delivery.md](background-delivery.md) and [background-coverage.md](background-coverage.md) (commit
`6bf4cdf`), [diagnosis.md](diagnosis.md) and [red-loop.md](red-loop.md) (reproduction evidence, commit `e16b1b1`).
Vocabulary follows [the glossary](../../GLOSSARY.md) — **Pending Submission**, **Committed Message**, **Submission
Outcome Unknown** — and the rules this specification must not weaken are
[ADR 0001](../../docs/adr/0001-single-authoritative-durable-runtime.md) (one authoritative runtime) and
[ADR 0006](../../docs/adr/0006-durable-submission-lifecycle.md) (a submission's outcome is looked up, never resent).

## Problem Statement

A user sends a message and hears the completion tone before the model has answered; in another reported case the
conversation sits on Loading while the answer is already there. Both come from the same area: the browser invents its
own lifecycle state beside the runtime's, and then treats its own inventions — a locally set running flag, a `busy`
disappearance, a boolean polled set, an HTTP read that has not returned — as facts about a turn. A conversation has
exactly one authoritative runtime (ADR 0001), so a second, locally invented lifecycle can only be wrong.

Three consequences the user sees today:

- A completion notice can arrive before the provider is entered, because the first idle snapshot of a new conversation
  is compared against a running flag the client set itself.
- A fully delivered stream can be ignored while the UI stays on Loading, because an HTTP read holds an independent
  readiness gate.
- The only completion signal for a conversation the user is not looking at is "an id I saw busy is no longer busy" —
  absence, not an outcome — so aborts, failures and subagent runs can all ring the completion tone.

Two limits of the evidence, stated plainly: the premature sound and the HTTP loading gate are **proven** by a recorded
reproduction; the sustained multi-second stall the user reported is **not** reproduced at this revision, and this
specification does not claim to fix it.

## Solution

Give a conversation's lifecycle facts one pure projection, fed by the runtime's own committed facts, and let every
consumer read that projection instead of deriving state locally.

- **Wire the facts that are missing.** A terminal submission fact carries the answer it produced; a snapshot carries
  the native run's inputs; the backend's own projection identity and revision travel end-to-end on both transports;
  the HTTP conversation read carries the same lifecycle payload as the stream.
- **Fold them in one pure module.** A conversation-scoped projection with two entry points — create and advance —
  validates, orders and folds observations into one view plus notices and requested effects. It owns no socket, timer,
  store, registry, scheduler or retry queue, so the existing transport and hook stay the only I/O owners.
- **Keep three concepts apart.** The pending overlay ends when the submission's own entry is committed; the answer
  interest ends at a terminal fact for that input; native activity is the run's presence. Readiness comes from the
  first complete projection on either transport, and a failure is an unread state, not an endless spinner.
- **Notify from a native terminal fact, keyed by answer.** One notice per answer group, so a steer group sounds once
  and a queued follow-up has its own later notice. Abort, failure and a withdrawn queue never ring the success tone.
- **Deliver background notices from live facts, scoped to unfinished interest.** The conversation's existing stream is
  retained while it still has unfinished work; the existing visible-tab poll nominates candidates for conversations
  the user is not looking at, each nomination getting one connection whose first snapshot is an atomic baseline.
- **Be honest about the one limit.** A run that starts and finishes entirely between observation and acquisition is
  never observed live; it leaves an unread marker, not a sound. Universal catch-up is not bought, and the old
  absence-based tone is removed only once the new coverage is demonstrated.

## User Stories

### Notice truthfulness

1. As a user, I want the completion sound to play only after the model has actually answered, so a sound never precedes the answer.
2. As a user, I want sending a message never to look or sound finished before the run starts, so I am not told a turn is done when it is not.
3. As a user, I want a completion notice to come from the conversation's own recorded answer, so a notice is never invented locally.

### Readiness

4. As a user, I want the conversation to leave Loading as soon as a complete projection arrives on either transport, so a slow HTTP read cannot hold the screen on Loading.
5. As a user, I want a reconnect or reattachment to keep the transcript I already have instead of reverting to Loading, so a dropped stream does not erase the screen.
6. As a user, I want a failed read with no prior data to show an unread state rather than an endless spinner, so I know something went wrong.

### Ordering across a restart

7. As a user, I want a restarted backend never to overwrite fresher data with a delayed older read, so the transcript and running state stay correct across a restart.
8. As a user, I want a delayed HTTP answer that belongs to an older backend to be refused rather than applied, so cross-restart races cannot regress the view.
9. As a user, I want a terminal fact never discarded because a state snapshot has a higher counter, so a completion is not lost.
10. As a user, I want equal snapshots to be idempotent, so nothing flickers when the same state arrives twice.

### Pending overlay and answer interest

11. As a user, I want my sent message to stay visible until its own entry is committed, so it never disappears while the run is being set up.
12. As a user, I want my message to stop being pending once it is committed, so the overlay ends at commitment, not at the answer.
13. As a user, I want the answer interest to survive the commitment of my message, so completion is still expected after my message appears in history.
14. As a user, I want a queued follow-up to remain outstanding while an earlier answer arrives, so two turns never merge.

### One notice per answer

15. As a user, I want one completion notice per answer, so a steer group does not ring several times.
16. As a user, I want a steer group that shares one answer to produce one notice, so grouped inputs are one event.
17. As a user, I want separate submission frames for the same answer to be deduplicated, so a stream that splits records does not multiply sounds.
18. As a user, I want a queued follow-up to have its own later notice, so each turn reports once.

### Abort, failure and recall

19. As a user, I want an aborted or failed run to show its reason and never play the success tone, so failure is not dressed as success.
20. As a user, I want a withdrawn queued message to be shown as not answered, so recall is honest even though it is not distinguished from failure.
21. As a user, I want a refused submission to restore my draft, so a rejection loses no typing.

### Background delivery

22. As a user, I want a completion notice while I am looking at another conversation, so I learn my run finished without switching back.
23. As a user, I want the notice to come from a live terminal fact of that run, so a background notice is as trustworthy as a foreground one.
24. As a user, I want the selected conversation's stream to stay open while it still has unfinished work, so the run is not missed by leaving the page.
25. As a user, I want a conversation I am not looking at to be acquired by the existing poll's nomination, so no stream is opened for conversations with nothing outstanding.
26. As a user, I want only one connection per conversation even when the sidebar and the open conversation both watch it, so the deployment is not flooded.
27. As a user, I want my interest registered before my submit is dispatched, so a run that settles immediately is still observed.
28. As a user, I want switching into a conversation to take over the connection already watching it, so no notice is duplicated or lost in the handover.
29. As a user, I want a run that finished while nobody was watching to leave an unread marker instead of a sound, so I still see that something happened.
30. As a user, I want history, recovery lookups and reacquired baselines to be silent, so old facts never ring.

### Coverage and limits

31. As a user, I want the old background tone removed only once the new coverage is demonstrated, so notification coverage is never lost in the changeover.
32. As a user, I want the product's background guarantee to be the honest one it can keep, so I am not promised universal catch-up.
33. As a user, I want a run that finishes entirely unobserved to be reported as a known limit rather than silently patched, so I can decide whether to buy more coverage.
34. As a user, I want unread and subagent suppression to keep working, so a subagent's completion is silent.

### Scope discipline

35. As an operator, I want no new scheduler, generic harness or durable epoch added, so the runtime keeps one authority.
36. As an operator, I want no stream per catalogued conversation, so the backend's attach cost stays proportional to real work.

### Wire facts

37. As a user, I want the answer identity to travel with the terminal submission fact, so notices can be keyed by answer.
38. As a user, I want the native run's inputs and the backend's projection identity to travel with snapshots, so activity and ordering are facts rather than guesses.
39. As a user, I want the HTTP conversation read to carry the same lifecycle payload as the stream, so the two transports cannot disagree.

### Migration

40. As a maintainer, I want the replaced authorities deleted rather than layered, so one lifecycle decision remains.
41. As a maintainer, I want the provably empty suppression filters fixed at their source, so no wrong-bool path is kept.

### Tests and documentation

42. As a maintainer, I want lifecycle tests that are deterministic and need no sleeps or paid model calls, so they pass anywhere.
43. As a maintainer, I want the ordering counterexamples covered as tests, so a future refactor cannot reintroduce them.
44. As a maintainer, I want the owning guides updated in the same change, so the delivered behaviour is documented.

## Implementation Decisions

### 1. One pure projection is the only place lifecycle is decided

The existing submission-reconciliation module is deepened into a conversation-scoped, pure projection with two entry
points. It validates, orders and folds observations; it owns no socket, timer, store, registry, scheduler, React or
retry queue. The transport, the hook and the shell stay thin callers that perform the requested I/O.

The shape below came from the design prototype ([design.md](design.md), commit `c4d7154`); it is inlined because it
encodes the decisions more precisely than prose, not as a working example.

~~~ts
type View = {
  ready: "loading" | "ready" | "unread";          // "unread": no complete projection, readable failure
  data?: SessionData;
  messages: readonly AgentMessage[];              // committed history only
  pending: readonly PendingTurn[];                // overlay: this input's own user entry not yet committed
  outstanding: readonly AnswerInterest[];         // user entry committed; answer not terminal yet
  activity: null | { inputs: readonly string[] }; // the native run only
  issue?: { kind: "transport" | "protocol" | "outcome-unknown"; message: string };
};
type Notice =
  | { kind: "answered"; answerId: string; inputs: readonly string[] }
  | { kind: "unanswered"; submissionId: string; reason: string }
  | { kind: "refused"; requestId: string; restore: StagedContent };
type Effect =                                     // requested I/O the caller performs; the fold does none
  | { kind: "lookup"; acquisition: Acquisition; subject: Subject }
  | { kind: "reattach"; acquisition: Acquisition };

function createProjection(scope: Scope): Step;
function advance(state: State, input: Input): Step;
~~~

Invariants the projection must hold, each of which is an acceptance criterion somewhere below:

1. Only the fold orders. Terminal beats placed beats queued; a receipt or an older projection cannot regress a fact.
2. The overlay ends at the user entry; the answer interest survives it. No committed entry, no busy edge and no
   absence can end a turn.
3. Completion is a native terminal fact carrying its answer identity — never `run_end`, idle, a write's entry, or a
   busy edge.
4. One answer, many inputs: a steer group is one answer group and one notice, keyed by conversation and answer.
5. Readiness comes from the first complete projection on either transport; a lifecycle-only frame never hydrates.
6. Failure is a state: no prior projection plus a failed read is unread, not indefinite loading.
7. Absence is not a fact: a null lookup leaves the interest outstanding, unknown, never rejected and never resent.
8. Admission is idempotent; duplicate facts are no-ops; nothing opens a connection or runs a timer.
9. A protocol contradiction keeps the last good view, reports a protocol issue and emits no notice.
10. State is bounded: the transcript's identities, unresolved interests and per-acquisition bookkeeping only, with the
    unfinished-interest registry capped and settled entries evicted.

### 2. Ordering: backend projection identity plus a client acquisition fence

The backend's revision counter is per attachment instance, not a native commit sequence, and HTTP state and the SSE
stream read the same cached runtime object; two instances are two clocks, so an attachment id alone cannot order them.

- The backend mints an opaque projection identity once inside attachment creation and carries it with the revision on
  every complete snapshot, HTTP and SSE. A random instance token is enough; no durable epoch or table is added.
- The caller assigns an acquisition generation when acquisition begins; every HTTP request and stream callback captures
  it then, and the fold rejects older generations. Cancellation alone is insufficient because a response may already be
  queued; an adapter-local generation is not backend identity.
- A first complete HTTP projection may hydrate immediately. Stream acquisition selects the authoritative projection
  identity for that generation: rebase across different identities even at a smaller revision, keep the newer revision
  within one identity, and never wait for a pending HTTP response.
- After stream acquisition, HTTP from another projection identity cannot rebase: keep the accepted view and request a
  fresh acquisition. Opaque identities have no numerical order.
- A new acquisition fences old callbacks. Within the selected identity, accept newer revisions, ignore older, treat
  equal as idempotent. Preserve the good view while reattaching; readiness never reverts to loading on reconnect.
- Lifecycle frames are not snapshots. Fence their connection, validate the conversation and a monotone submission
  transition, and never discard a terminal record because a state snapshot has an equal or higher revision.

### 3. Required wire facts

| fact | why |
| --- | --- |
| the answer identity on an input's terminal `done` | the notice key; the protocol projection drops it today |
| the native run's inputs on a snapshot, null when there is no run | activity is a fact, not an inference from busy |
| projection identity and revision end-to-end on HTTP and SSE | the ordering contract above |
| a complete HTTP lifecycle payload | the two transports must be able to agree, so unrelated reads are not combined into a supposed snapshot |
| a native batch envelope | optional; bounded answer-key dedup covers separately delivered records |
| a scoped submission lookup | conditional: needed only for interests the browser cannot name by its own request id, and never a background feed |
| a lifecycle wire revision or ordinal | conditional: needed only if lifecycle joins one ordered-envelope protocol |

Recovery keeps using the existing request-id lookup first. A lookup that returns nothing is unknown, never a resend
and never a success signal.

### 4. Background delivery is an interest map owned by the shell

- One interest map is owned by the application shell, using state it already holds, and is keyed by conversation. An
  entry is a conversation with an unfinished answer interest, or an observed run not yet settled, and holds that
  conversation's outstanding keys and its connection. It is not a module-global singleton, a scheduler or a second
  store.
- No second observer for one conversation. The existing agent event connection already owns the stream, the handshake
  and the passive reconnect; it gains a subscriber list keyed by conversation so the selected hook and the background
  interest join one stream instead of opening a parallel one.
- Transfer happens once: selecting a conversation that has a background observer hands the existing subscription to
  the hook and marks the notice already owned; leaving hands it back. The connection survives and ownership moves. A
  notice is emitted once per conversation and answer key whichever owner held it.
- Acquisition: the existing visible-tab poll keeps its cadence and single catalogue read and now only nominates (busy,
  or an interest exists). Each nomination opens one stream if none exists, whose first snapshot frame is an atomic
  baseline read and registered in one synchronous block; everything after it is a live fact. Interest is registered
  and the stream acquired **before** the local submit is dispatched, so a run that settles immediately is observed.
- No interest means no stream. No catalogue-wide streams, no stream per catalogued conversation, no new endpoint, no
  new scheduler, no generic harness, no durable epoch.

### 5. Notice rules

A notice requires a live terminal fact received after acquisition: an input submission that is done carrying its
native answer, or the answer entry joined by its answer identity. The key is the answer, falling back to the
submission only when no answer identity exists, with a bounded dedup set, so a steer group is one notice and split
frames are not several. A queued follow-up is its own later run, its own answer and its own notice, and the stream is
kept while any interest remains rather than closed after the first settlement. `unanswered` never notifies as
success; its reason is shown. A user-initiated recall is not distinguished from a failure without reading the reason
string: no `recalled` primitive is invented, and neither case notifies.

### 6. Silent by construction

An acquired baseline whose submission is already terminal, a baseline acquired after the run ended, a gap, a
reconnect, a resync or a recovery lookup, a backend restart with a fresh acquisition, and opening a conversation with
prior history are all silent. A recovery lookup repairs state; it is not a success signal.

### 7. The one limit, and the user's decision

A run that starts and finishes entirely between the poll and the acquisition — or while the tab is hidden — is never
observed live. The native stream's snapshot carries the outstanding set only, so it holds no historical terminal
record, and the recovery lookup is deliberately silent. Under this contract such a run produces no audio notice and
leaves the unread marker instead. Universal catch-up is not reachable without either a stream on every catalogued
conversation (rejected) or a bounded terminal summary on the catalogue row that by construction collapses everything
settled within one poll interval into one notice and so cannot preserve one notice per answer group. The product
guarantee is therefore the narrower, honest one: **one notice per answer group for every run observed while an
interest exists**, and the unread marker as the fallback otherwise. The user accepted this on 2026-10-13.

### 8. Replace, do not layer

The replaced authorities are deleted, not kept beside the projection: the became-idle completion path and its
prompt-run identity refs, the finish-without-stream and wait-for-settlement helpers with their idle polling, the
independent loading gate on session load, the duplicated stream hydration, the SDK-active and RPC-pending refs used as
durable authorities, the pending-by-key / key-alias / last-published fallback maps, the unqualified completion sound in
the chat window, and the sidebar's background-completion boolean as a sound source. The hook keeps transport, cache,
remount and rendering. The completion tone has exactly one owner.

The two suppression filters that are provably always empty today are fixed at their source rather than left in place:
either the backend reports the subagent or background flag on the catalogue row and the adapter forwards it, or the
client filter is deleted — the source first, so nothing rings for a subagent.

### 9. Removal of the old background sound is gated on coverage

The absence-based background tone is removed only after the coverage acceptance in ticket 05 passes. Until then it
stays, so the changeover cannot lose notifications.

### 10. No new infrastructure

No generic harness, scheduler, global controller, catalogue-wide subscription, per-conversation stream for idle
conversations, persistent epoch, durable table or second authoritative runtime is introduced. The durable backend
remains the single authority (ADR 0001) and unknown submission outcomes continue to be looked up by request id rather
than resent (ADR 0006).

## Testing Decisions

### What makes a good test here

A test asserts externally observable behaviour at a public seam: a request a real client makes and the answer it gets,
a real host effect inspected afterwards, or a notice a real callback receives. A test that mirrors internals, reaches
into a private step or asserts a mechanism rather than an outcome does not belong here. Determinism is required: no
sleeps to wait for a state, no paid model calls, no dependence on a live external service, and no test that only
passes on the machine that wrote it. Failures are asserted as the exact outcome and reason the caller can see, never
as "some error". Verification claims follow [verification practice](../../docs/agents/verification.md) — a check names
its command, revision, exit code and log — and findings are triaged by
[review policy](../../docs/agents/review-policy.md).

### Proposed seams

Three seams, in preference order, and no fourth.

**Seam 1 — the pure projection, tested directly.** Create and advance are pure functions over a conversation's
observations, so the ordering, overlay, interest, readiness, notice and error rules are asserted as behaviour with no
browser, no stream and no timer. This is the highest seam that can carry most of the lifecycle rules, and it is where
every ordering counterexample from the validation belongs.

**Seam 2 — the backend and protocol public contracts, against the real backend.** The wire additions (answer identity,
run inputs, projection identity and revision on both transports, the complete HTTP lifecycle payload) are asserted as
a real client's request and response against a real backend and store, following the existing backend server and
submission suites. No new endpoint is introduced by this specification, so no new contract surface is created.

**Seam 3 — the browser, through the existing Web adapter and a real backend, with a recorded sound callback.** The
end-to-end path is asserted the way the reproduction already asserts it: a real composer, a real stream, a held HTTP
endpoint where the race matters, and the actual completion callback recorded, so a notice is a fact the test observed
rather than a state it inferred. Background delivery is asserted the same way, with the tab's poll nomination and a
conversation the user is not looking at.

Prior art for each: the existing pure-rule suites for seam 1, the backend server, submission and provider suites for
seam 2, and the browser-driven end-to-end scripts — including the lifecycle reproduction fixture, which already holds
an HTTP read, records the sound callback and keeps negative controls — for seam 3.

### Coverage obligations

- Every ordering counterexample from the validation (delayed old HTTP over fresh stream after a restart, late old HTTP
  rebasing backwards, a token mismatch still rolling back, a cancelled acquisition fence defeated by a late response,
  a lifecycle terminal surviving an equal-revision snapshot) is a named seam-1 case.
- Seam 2 proves each wire addition against the real backend, including that an older same-identity revision is ignored
  and that the two transports carry the same payload.
- Seam 3 proves the two proven reds cannot recur: no notice before the provider is entered, and a held HTTP read
  cannot hide a complete stream projection. Negative controls are kept.
- Seam 3 proves the background acceptance matrix: selected-then-background completion; a foreign or previously
  unmounted run; a grouped steer; a follow-up; abort and failure; a backend restart; duplicate delivery; no notice for
  history, recovery or an acquired baseline; and preserved unread and subagent suppression.
- No test asserts source text, and no test sleeps.

## Out of Scope

- The reported sustained multi-second stall. It is not reproduced at this revision and no cause is claimed here.
- Universal background catch-up, a stream per catalogued conversation, a bounded terminal summary on the catalogue
  row, a new submission-by-id endpoint, a native recalled primitive, and any replay framework.
- A generic harness, scheduler, global controller, persistent epoch or second authoritative runtime.
- Deployment, configuration, container, host or release changes; those are deferred to implementation tickets and the
  owning deployment guides, and none is written here.

## Further Notes

- **Proven versus unknown.** Proven by the recorded reproduction: a locally invented running state plus the initial
  native idle snapshot plays the completion sound before the provider is entered; and a held HTTP read keeps the UI on
  Loading although a complete stream projection already arrived. Unknown: the reported sustained stall.
- **ADR pending acceptance.** The design proposes an ADR recording that a conversation's lifecycle facts have one pure
  projection and that completion is a native terminal fact. It is not written to the ADR directory in this change; the
  closing ticket writes the owning guides and records the ADR only if the user accepts it.
- **Ticket order and edges.** See [the breakdown](ticket-breakdown.md). Tickets are numbered blockers-first and each is
  one complete, verifiable path.
- **One documentation index entry.** The local issues index lists each effort and its current reference; this effort is
  added there, with the deployment and behaviour guides left to the implementation tickets.
