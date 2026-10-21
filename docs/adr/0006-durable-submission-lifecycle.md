# A submission has a durable lifecycle, and an unknown outcome is looked up rather than resent

Scope: one conversation's submitted user input — from the browser pressing Send to the transcript holding the answer.
The protocol's existing per-conversation data is enough; no second delivery architecture is introduced.

Status: accepted; every part is implemented. The durable submission records, `requestId` admission deduplication,
the pending/committed presentation, `watchEvents` as the submission event source, the terminal lifecycle frame, the
Web reconciliation module and the by-id lookup that resolves an unknown outcome are all in the code. The lookup is a
recovery seam, not the normal path. Terms follow the [glossary](../../GLOSSARY.md).

## Context

Three terms name the states the send path kept describing without: a **Pending Submission** is sent but not yet in
history, a **Committed Message** is in history and authoritative about itself, and **Submission Outcome Unknown** is
the state between them when the connection carrying the submission or its events ended before either outcome was known.
The runtime already records submissions durably (`SubmissionRecord` with a `requestId`) and reports a terminal reason
when one fails; the question is what a surface may do with a submission whose outcome it never learned.

The tempting answer — send it again — is wrong in the direction that costs data: a duplicate turn is worse than a
missing answer, and "no answer arrived" cannot distinguish a lost request from a lost response, a slow run, or a
backend that admitted the turn and is still working.

## Considered options

- **Resend a submission whose outcome is unknown.** Rejected: admission happens before the answer, so the same turn can
  land twice and history shows the user saying one thing twice. It also turns a transport failure into a content error.
- **Let the UI hold the submission and decide from what it received.** Rejected: the transcript it receives is a
  projection that may predate the send, so "no committed entry for it" is not evidence the submission failed. This is
  the defect the pending marker already fixes: a snapshot is authoritative only about what it already holds.
- **Treat a transport failure as a rejection and restore the draft.** Rejected as the general rule: it is correct when
  the backend answered a refusal and wrong when the link died mid-request, so it would present an unknown outcome as a
  failure. Restoring the draft is kept for a *readable rejection* only.
- **A client-side retry queue with backoff.** Rejected: it re-sends, which is the option above, and hides the decision
  inside a timer.
- **A new event channel for submissions.** Rejected: the runtime already publishes per-conversation agent events, and
  the snapshot plus registration for later commits is taken atomically on the session line, so the channel exists.
- **Resolve an unknown outcome from the transcript alone.** Rejected: whether the submission is pending, placed or
  terminal is the submission record's answer, not something a message list can be read back into.

## Decision

- **Admission is the durable fact.** The browser generates the `requestId` and sends it with the submission; the
  runtime scopes that id to the conversation, so a retry of the same request is admitted **once** and duplicates are
  impossible by construction rather than by comparing text. The submission record then moves admitted → placed →
  terminal (answered, or failed with a reason), and the answer is a committed message.
- **A pending submission is shown from Send until it is committed.** The browser keeps its own pending turns in a pure
  reconciliation module and settles each one from the durable projection: a send is staged under the `requestId` the
  browser generated, the prompt response names its `submissionId`, and the outstanding set moves it through
  `queued → placed → done/unanswered`. A turn leaves the pending set when the entry its own submission owns is
  committed, so a message the user repeated is never mistaken for the pending one. Neither the committed entry count nor
  the message text decides anything: the projection does. The pending set is per conversation and in memory only, so a
  genuine conversation switch cannot inherit a wait, and a refresh re-reads the conversation rather than a stored guess.
- **A settlement is delivered as a frame, because absence is not a fact.** The outstanding set answers only what is
  still in flight: a turn it omits may not be admitted yet, may have settled while the client was disconnected, or may
  be the very turn a frame predates. Reading that absence as a settlement is what took a live turn off the screen right
  after Send. The backend therefore sends a `submission` frame per lifecycle transition, carrying the same stable
  projection — status, the entry the submission owns, and the durable reason — to the clients following that
  conversation, and a terminal status in that frame is the only thing besides the turn's own committed entry that ends
  it. The frame is live and never buffered or replayed: a client that was not there when the turn settled opens with
  the snapshot, which states the outstanding set truthfully, and asks the by-id lookup about the turn it is waiting on.
  So a settlement's memory does not grow with the number of finished turns, and a client that missed one always has a
  path to the answer instead of a guess. The Web side answers the backend's `resync_required` marker and every
  reconnect by looking up each turn still waiting, by the `requestId` it was sent under.
- **`watchEvents` is the submission event source.** `pi-durable` 1.1.0 exposes
  `watchEvents(harness, conversationId, context)`: one atomic snapshot followed by committed event batches, with
  overflow collapsing to a fresh snapshot instead of an unbounded buffer. Its `submission` records are projected into
  the stable `SubmissionProjection` and published with the state. The committed view still arrives as a full-replacement
  snapshot, now taken from `conversation.watch()` rather than a mount the backend advances itself, so the runtime owns
  the initial frame, order and overflow. No delta path is introduced: replacing the snapshot wholesale already meets
  those boundaries. Because a snapshot cannot report a settlement that happened while batches were dropped, the
  subscription re-reads the committed submissions after an overflow.
- **An unknown outcome is looked up, never resent.** Recovery asks the conversation about that submission by its id
  (`GET /api/conversations/:id/submissions?requestId=`) and settles on the record it finds: committed (hydrate it),
  still queued or placed (keep waiting), or absent (report an unknown outcome truthfully and leave the choice to the
  user). No automatic resend, no timer, no heuristic. The runtime's reacquire-by-id contract is what makes the lookup a
  read rather than a second write.
- **Only a readable rejection restores the draft.** A refusal the backend answered with a reason restores the text so
  a resend is the user's deliberate act, and the same `requestId` or a new one then remains idempotent. A link that
  died mid-request is not a rejection.

## Consequences

- Ordering is the conversation's, not the browser's: two clients may submit concurrently and admission deduplicates
  only what names the same `requestId`, so the runtime's ordering stays the single authority.
- A pending submission must survive a reconnect, which means the pending marker is presentation state and stays with
  the surface; the durable record is what a later lookup reads.
- The lookup makes the submission record an addressable read surface. It reports an unknown outcome as unknown rather
  than as a failure, and the user decides.
- Adopting `watchEvents` is an additive delivery change, not a runtime change: the same commits are projected, and a
  gap or overflow is answered by the snapshot it carries, so a client never applies a delta to a state it never had.
- The ADR is deliberately independent of the UI that draws it: any surface that sends a turn inherits admission
  deduplication, the pending/committed distinction and the lookup rule.
