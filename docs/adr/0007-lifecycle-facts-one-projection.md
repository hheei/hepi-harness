# A conversation's lifecycle facts have one pure projection, and a completion is a native terminal fact

Scope: how a conversation's lifecycle is decided — what a surface may treat as a completion, how two transports are
ordered against each other, and what a run the page never observed is allowed to say. The runtime and the wire are
unchanged by this decision; the browser stops deriving lifecycle state of its own.

Status: accepted; implemented by tickets 01–06 of the chat-lifecycle effort and merged into
`integration/chat-lifecycle`. The pure projection, the wire facts, the acquisition fence, the shared per-conversation
stream, the shell-owned interest map and the removal of the absence-based tone are all in the code. Terms follow the
[glossary](../../GLOSSARY.md), and this decision extends [ADR 0001](0001-single-authoritative-durable-runtime.md) and
[ADR 0006](0006-durable-submission-lifecycle.md) rather than replacing them.

## Context

A conversation has exactly one authoritative runtime ([ADR 0001](0001-single-authoritative-durable-runtime.md)), so a
second, locally invented lifecycle in the browser can only be wrong — and it was. The user heard the completion tone
before the model had answered, because the client compared the first idle snapshot of a new conversation against a
running flag it had set itself; and a conversation sat on Loading while the answer was already on screen, because an
HTTP read held a readiness gate of its own. The only background completion signal was "an id I saw busy is no longer
busy": absence, not an outcome, so aborts, failures and subagent runs could all ring.

The runtime already states the facts that would settle all three: a submission's terminal record carries the answer it
produced, a snapshot carries the native run's inputs, and the submission lifecycle is durable
([ADR 0006](0006-durable-submission-lifecycle.md)). What was missing was one place to fold them, and an honest answer
for the case where nothing observed the run.

## Considered options

- **Keep the absence boolean and add guards.** Rejected: the same `busy` edge that rings before the provider is
  entered is what the background path diffs on, so a guard is a filter over a wrong signal — and two of its three
  filters were provably always empty, which is how a subagent's completion could ring. The signal, not the filter, is
  the defect.
- **A stream per catalogued conversation.** Rejected: N conversations would mean N permanent SSE connections and N
  server-side attach records to answer a question the stream of the conversation actually running already answers.
- **A bounded terminal summary on the catalogue row, diffed on the newest run's end time.** Rejected: it collapses
  everything settled within one poll interval into one notice, so it cannot preserve one notice per answer group, and
  it makes the poll a second authority over a fact the stream already states.
- **A durable epoch or sequence for ordering.** Rejected: the backend's revision is per attachment instance, and two
  instances are two clocks; an opaque per-attachment identity plus a client-assigned acquisition generation detects the
  same races without a stored counter or a migration.
- **Catch up a missed run from the transcript or a recovery lookup.** Rejected: a lookup repairs state and is silent by
  design, and the transcript cannot say how a run ended. Presenting either as a completion would invent a notice.
- **A generic harness, scheduler or global controller in the browser.** Rejected: the transport, the hook and the shell
  are already the I/O owners, and a scheduler would put a timer where a fact belongs.

## Decision

- **One pure projection decides lifecycle.** A conversation-scoped module with two entry points — create and advance —
  validates, orders and folds observations into one view, notices and requested effects. It owns no socket, timer,
  store, registry, scheduler or retry queue; the transport, the hook and the shell perform the I/O it asks for. Only the
  fold orders: terminal beats placed beats queued, and a receipt or an older projection cannot regress a fact.
- **A completion is a native terminal fact that carries its answer.** Never a `busy` edge, a turn's absence, a run's
  end, a write's entry or a locally set running flag. It is keyed by the conversation and the answer, so a steer group is
  one notice, split frames for one answer are one notice, and a queued follow-up has its own later one. An aborted,
  failed or withdrawn run never notifies as success; its reason is shown.
- **Three concepts stay apart.** The pending overlay ends when the submission's own entry is committed; the answer
  interest ends at a terminal fact for that input; native activity is the run's presence. Readiness comes from the first
  complete projection on either transport, and a failure with no prior projection is an unread state rather than an
  endless spinner.
- **Ordering is backend identity plus a client acquisition fence.** The backend mints an opaque projection identity per
  attachment and carries it with the revision on every complete snapshot, HTTP and SSE. The caller assigns an acquisition
  generation when a read begins; the fold rejects older generations. A first complete HTTP projection may hydrate
  immediately; stream acquisition selects the authoritative identity, newer revisions are accepted within one identity
  and older ones ignored, and a cross-identity HTTP read cannot rebase over the stream — it prompts a fresh acquisition
  instead.
- **Background delivery is an interest map owned by the shell, on one stream per conversation.** The existing agent
  event connection gains a subscriber list keyed by conversation, so the conversation on screen and a background
  interest in it are two readers of one source; selecting a conversation hands the subscription over and leaving hands
  it back, and the connection survives. The existing visible-tab poll keeps its cadence and its single catalogue read and
  **nominates** only: a conversation it reported busy is one worth watching, and whether the run finished is the
  stream's own terminal fact.
- **The one limit is stated, not patched, and it is about the notice.** A run that starts and finishes entirely between
  the poll and the acquisition, or while the tab is hidden, is never observed live. It produces no audio notice, and it
  leaves the unread marker — which does not come from the poll's absence, because absence can only report a run the page
  *saw* running. The catalogue row states when each conversation's newest run ended, from the run's own durable receipt,
  and the sidebar diffs it against its own baseline. Universal notice catch-up would need a stream on every catalogued
  conversation or a catalogue-row summary that cannot keep one notice per answer group, so it is not bought. The product
  guarantee is one notice per answer group for every run observed while an interest exists, with the marker otherwise.
- **Replace, do not layer.** The replaced authorities are deleted rather than kept beside the projection: the
  became-idle completion path and its prompt-run identity refs, the finish-without-stream and wait-for-settlement
  helpers, the independent loading gate, the duplicated stream hydration, the pending-by-key fallback maps, and the
  absence-based background tone with its sidebar boolean. A suppression filter that is provably always empty is fixed at
  its source or deleted, never kept: the catalogue reports a task-created conversation's creator edge, and the adapter
  forwards it as the subagent relation the surfaces already read.

## Consequences

- The completion tone has exactly one owner per answer, and one source: a live terminal fact. The page's registry is
  asked first, so a handover, a reconnect and a second reader collapse to one tone.
- The sidebar's poll is a nomination source and nothing else: it is neither a completion signal nor the marker
  source. A run the poll alone observed cannot ring — that is the accepted limit, not an oversight — and it still marks,
  because the marker is the run's own end rather than the poll's absence.
- Background coverage depends on an interest existing while the run is in flight, so interest is registered before a
  submit is dispatched and a conversation left with unfinished work keeps its stream. That interest is carried as the
  projection itself rather than a flag, because a watch that knows only *that* work is outstanding reads the first
  terminal fact of a queued group as the end of it and loses the rest — including a follow-up placed after the first
  answer, before any poll could nominate the conversation.
- Subagent suppression is a fact the backend reports rather than a client-side guess, so a subagent's completion is
  silent from the catalogue row to the tone.
- The projection is testable without a browser, a stream or a timer, which is where the ordering counterexamples and the
  notice rules are asserted; the browser drivers keep the end-to-end scenes and their negative controls.
- No scheduler, global controller, durable epoch, catalogue-wide subscription or second authoritative runtime is
  introduced by any of it.
