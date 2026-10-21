# Durable chat pathway

The main presentation is the shared React workbench in `packages/ui`, mounted by the Web page (`apps/web/src`) and
by the desktop App. The Web page is admitted by the client ingress: it holds an HttpOnly `hepi-web-session` cookie, its
`/api` reads and its event stream are same-origin, and a missing or invalid cookie is a 401 the page answers with the
ingress's own sign-in form. Reload retains login. See [apps/web/README.md](../apps/web/README.md),
[client ingress](client-ingress.md) and [local integration](local-integration.md) for startup. The backend owns the only
agent loop and SQLite writer; the browser folds the native wire through the shared client and projects it once
(`packages/ui/src/lib/durable-projection.ts`) — never through rpc-manager or a copied upstream local runtime helper.

GET /api/conversations/:id/events sends a snapshot followed by state frames. Each includes hepi.v1, conversationId, revision, projectionId, committed structured messages, assistant partial/liveMessage, liveTools, busy state, the native run's inputs (`run`, null when there is no run), model/thinking settings, queued steering/follow-up inputs and the outstanding submission projections, plus the three facts that state what the transcript window is: `historyRevision`, `historyHead` and `hasMore` (see [Bounded history](#bounded-history-older-pages-and-the-read-blocks)). Revisions are process-local delivery sequences counted per attachment instance; `projectionId` names that instance opaquely, so two identities are two clocks and a fresh connection snapshot can reset the revision after a restart. `GET /api/conversations/:id/state` answers the same complete payload as the stream's snapshot, so a client reads one lifecycle state from either transport instead of joining unrelated reads. Every surface that returns entries returns the **bounded window** rather than the whole transcript, so a frame's size does not grow with the conversation.

**After the baseline, a state frame carries what the advance produced instead of the window it already sent.** The snapshot states the window once; every later `state` frame carries `baseRevision` — exactly the revision of the frame the clients hold — and `appended`, the entries this advance produced, with **every scalar full** and the window's own `oldestEntryId`/`hasMore` so a client prunes its window to exactly the server's. A frame that appends nothing (a submission transition) is not a special case: it is a frame with `appended: []`. The rule that decides this is one function beside the window rule (`continuationIndex` in `apps/server/src/history-window.ts`): an unchanged head marker plus the previous window's newest entry still being present is the whole test for "this advance continues what the clients hold", and it is a test on two windows — never on a client — so the server keeps **no** per-client cursor, buffer, ack or epoch. A **head-marker move** (a compaction or a reset) is the one event that ends a loaded window: the frame restates the whole window instead of continuing it, so a client never has to reason about a truncation and an append atomically. The client applies a frame **only** when `baseRevision` is exactly its own revision — a stale or out-of-order frame is rejected without being applied and answered by a fresh bounded read plus `resync_required`, and the turns it was waiting on are then settled by request id (see [Submission recovery](#submission-recovery)), never inferred. The Next adapter folds those frames into the complete projection the browser consumes, at the one place that owns a frame boundary, so the surface downstream reads the same shape it always did. That fold is built from the frame's own scalars, so a scalar a frame does not carry is **absent** rather than inherited from the frame before it — a live message the backend has finished with is not resurrected — with one exception: `submissions` is the set the backend states on every frame, so a frame that did not mention it is not read as a settlement. A frame that cannot be carried is stated rather than written: an HTTP read answers `413` with `reason: "frame_too_large"`, the offending `entryId` and its `bytes`, and the stream emits `state_oversize` with the same payload instead of a frame that would trip the 1 MiB transport guard — so size never produces an endless resync, and the named entry stays readable through its own route.

The adapter carries that payload whole — `projectionId`, `revision`, `run` and the submissions, `answerId` included — on both routes, because the browser's lifecycle projection consumes all four and a field dropped in mapping is a rule the client cannot apply. Ordering across two attachments is the client's half of the contract (`packages/ui/src/lib/lifecycle-acquisition.ts`): a read or a stream takes a **client acquisition generation** when it begins, never when its answer arrives, and every frame of that acquisition carries the number it was stamped with. A first complete read may hydrate; a stream acquisition then selects the authoritative `projectionId` for its generation, so a snapshot from another attachment rebases onto it even at a smaller revision, while within one identity a newer revision wins and an older or equal one is ignored. An HTTP answer carrying another `projectionId` after stream acquisition cannot rebase: the accepted view stays and the fold requests a fresh acquisition. A read whose answer lands after a newer acquisition began is fenced out rather than applied, which is what cancellation alone cannot achieve — a response may already be queued when the read is abandoned. A lifecycle `submission` frame is fenced the same way but is never ordered against a snapshot's revision, so a settlement is not lost to a state frame that happens to carry a higher counter.

**The conversation reads answer the native payload, and the browser makes the projection.** `GET /api/conversations/:id`,
`GET /api/conversations/:id/state`, `…/read`, `…/context` and `…/navigation[/around]` are the backend's own
`ServerSnapshot` and entries page, and the ingress forwards them unchanged under the page's cookie or an App's device
bearer: no route maps a field, so a field the backend did not state cannot appear in a read, and no entry holds a second
copy of the UI shape. The shared workbench's
`SessionData` is produced in the browser by `packages/ui/src/lib/durable-projection.ts`, its one owner: the committed
`entries[].message` (deferred-block metadata included) is carried unchanged, and every scalar the backend states —
`projectionId`, `revision`, `historyRevision`, `historyHead`, `run`, `submissions`, `settings`, `extensions`,
`toolNames`, `failure` — travels into the surface as it arrived. The fields that are not on the wire at all
(`filePath`, `totalActiveMs`, `tree`, `wrapperRebuilt`) are the copied UI's own placeholders, which is why the branch
navigator stays hidden and the session panel reports no file. The browser also projects the composer's own state
(`projectAgentState`) from the same snapshot, so the running flag, the model, the reasoning level, the queue and the
conversation's extension selection have one reader. The HTTP read is folded through the same lifecycle projection as the
stream's frame (`httpStatement`), so an older read cannot rewind the accepted window, the prefix, the active leaf or the
session-view cache. The accepted window and the pages in front of it are published as **one readout** — the window, its
prefix and its pagination claim — by `packages/ui/src/lib/conversation-readout.ts`, in the same step that accepts the
statement above; the pages behind the window stay the reader's own and are decided by the shared `decidePrefix` rule.

The stream is the backend's own: `GET /api/conversations/:id/events` authenticates the request and forwards the
response **as bytes** — the backend's frame names (`snapshot`, `state`, `submission`, `resync_required`,
`state_oversize`), its payloads, its keepalive comment frames and its close — and nothing on the Web host parses a frame,
folds a delta into a window or projects an entry. The browser holds one **stream-local** `SessionState` per attachment,
folded with the shared `reduceSseFrame` (so a delta is assembled from what that stream already received, and a
`baseRevision` this reader does not hold is answered with a fresh bounded read rather than a fabricated window), and
projects it through the same two functions a read uses. What is folded is deliberately **not** what is published: the
window, its paged prefix, its active leaf, its run outcome and its cache are published only through the lifecycle
projection's acceptance, so a frame the fold refuses may advance the stream's own continuity but changes no global fact.
A reconnect states the revision this reader holds (`?after=`), which the backend answers with `resync_required` when it
does not match. The connection is still one physical source per conversation for every reader, assembled with either the
Web page's own cookie source or the diagnostic page's bearer source; the six-connection budget and the lease are
unchanged.

The session list is one `GET /api/conversations` answer, not a per-conversation fan-out: the backend catalogue states each conversation's workspace, run state, revision, entry count, first user message and, for a fork, the conversation it was forked from, and the sidebar's running poll is that same read asked compactly — `GET /api/conversations?running=compact` answers the busy ids and the revisions and none of the rows, and `catalogueRunning` in `packages/ui/src/lib/conversation-catalogue.ts` takes that answer as stated (`CompactRunningCatalogue`): the ids are the Backend's and nothing is re-derived from rows, so the compact read and the list read cannot disagree about what is running. The poll's answer is that same `busy` flag, read from the rows the one catalogue projection already built; `limit` and `cursor` are refused beside `running=compact` by name, because a compact read answers the whole filtered list and a caller that asked for a window must not be handed ids the window excludes. There is no separate `/api/agent/running` route any more. The runtime's own **root conversation** — the framework record that owns the work belonging to no conversation — is not part of that catalogue: it is never attached, so it is in no list, no search result and no conversation route, and no surface can present it as a project of its own. Its record stays in the store; nothing removes it. `POST /api/conversations/:id/fork` (body `{ at?, requestId? }`) creates a branch through the one creation seam, which takes pi-durable's own native fork, answering the new identity plus that catalogue row; the source is only read, so a live run in it is untouched, and a missing, unsaved or empty source is refused with a code and a readable reason. Branching a conversation a task owns — a subagent's child — is allowed and is what makes it a **branch of that child**: it keeps the child as its display parent and its native fork source, and its owner is a **new** background anchor task of the child's own scope, so it dispatches, queues and stops on its own without reusing the child's task or falling back to an ownerless conversation. `requestId` is the caller's stable identity for the branch: a retry after a lost answer — a dropped response, a reload — is answered with the branch the first attempt created instead of making a second one, and a caller that sends none still gets one generated for it. The session-list version counts the conversations as well as their revisions, so a fork — whose own revision starts at zero — still makes another window's poll re-read the list. It is the backend's own number on the catalogue answer (`sessionListVersion`), computed once by `catalogueListVersion()` in `apps/server/src/catalogue-binding.ts`; a client compares the number one route gave it with the number the other gave it, so a second derivation of the same fact is one too many. The same answer carries the project registry's own revision, so a Project created, changed or removed in another window is heard on the poll a window already runs rather than never (see [Projects](projects.md)). A queued input is withdrawn by `POST /api/conversations/:id/recall-queue`, which the composer's queue-recall action calls; an abort discards the same items instead of returning them. Images attached in the composer travel as native image content blocks in `conversation.submit`, and a submission whose selected model declares no image input is refused with a readable reason rather than downgraded. A session is named only when the user asks: the toolbar's Generate title posts to the Backend's
`POST /api/conversations/:id/auto-name`. The backend reads that conversation's committed model context, builds the transcript with pi-web's reused budget and prompt shape, asks the model the conversation already selected through the harness's own `Models`, and writes the answer as the same conversation-scoped `hepi.title` document the rename writes, so the one catalogue read that lists the session carries the name. Creating and running a conversation names nothing, no implicit pass replaces a name the user typed, and a failed generation writes nothing and reports the reason (`no_model`, `no_transcript`, `session_deleted`, or the provider's own error).

The **Diagnostic Page** under apps/server remains an authenticated fallback using @hepi/session/browser; it is served at `/diagnostics`, and its script is `apps/server/src/browser-diagnostics.ts`, which `pnpm build:ui` bundles to `apps/server/public/diagnostics.js` and serves at `/diagnostics.js`. It joins its conversation through the **same** connection lifecycle the Web page uses — `packages/session/src/agent-event-connection.ts`, all subscribers of one conversation sharing one source — assembled with its own bearer source factory (`bearerSource`). Its history is the Web page's transport moved from pi-web's agent-event-connection.ts, copied at revision 76bdc57027172eb381a216d647225a6d24f23360 (MIT); the pinned upstream bytes stay under `packages/session/vendor/pi-web/` as provenance. It is not a second runtime.

Verification: critical backend admission/restart/SSE tests, and two independent production Web pages against one backend with close/reload/continued control. Real DeepSeek text/SSE, isolated diagnose/edit/compile, and Oracle-backend-to-local-gateway coding tools have been verified; see docs/verification.md and docs/real-model-coding-verification.md. Branching and advanced upstream controls remain unimplemented: the runtime's wire states no history tree, so the branch navigator and its synthetic `tree`/`session-file`/`active-time` fields were retired rather than rendered as placeholders (ticket 09), the composer's built-in palette lists only the commands the durable runtime answers, editing a past message in place, a `!` shell draft and the tool-set picker are withheld before anything is sent (the picker is gone rather than ignored: the create request carries no tool selection and nothing serves one afterwards; the shell refusal is one shared preflight that an idle send, a steer and a follow-up all pass through, so a queued draft cannot reach the wire by another key, and the composer keeps the refused draft instead of clearing it), the extension dialog/custom-panel/attention surface is gone with the event stream that used to feed it (the native wire states no such event; extension selection in Settings is unaffected), and the surfaces named in [apps/web/README.md](../apps/web/README.md) answer 501. Copy-first layout reuse is not full upstream feature parity.

## Native input admission

The backend uses `@earendil-works/pi-durable` 1.3.0. Input admission in
`apps/server/src/conversation-input.ts` is one small adapter: `submitConversationInput(conversation, input, context)`
returns the native submission id. Ordinary HTTP message and busy-input routes use its default behavior, which delegates
to native `Conversation.submit`; their request bodies and wake behavior are unchanged.

Internal callers can pass `triggerTurn: false` to enqueue an input without starting a model run. One conversation
transaction creates the native Submission and appends its item to `InboxDoc`; there is no separate queue. Request-id
retries return the original submission without overwriting queued edits, and native cancellation, queue projection and
recall continue to own those items. The adapter preserves 1.3.0 custom input-entry kind/data for later placement.

`triggerTurn: false` controls admission only, and by itself it is not a persistent stopped state. The persistent
contract is the runtime's own input control, added by the version-pinned
[patch](upstream-sources.md#patched-runtime-dependency) (ticket 01):

- `Conversation.stop({ requestId, stopSource, expectedControlRevision? })` commits `held`, the trusted stop source and
  a new control revision in one transaction with the abort marks of the conversation's ordinary live tasks and the
  withdrawal of the inputs queued at that commit point. It never waits: `drain` answers `idle` or `stopping`.
- While `held`, every admission path queues and starts no run — an idle empty inbox, an idle inbox that already holds
  items, a model-visible write, a reset, and the compaction summary write. A display-only write still lands at once,
  because it changes nothing the model sees.
- `Conversation.continue({ requestId, caller, expectedControlRevision?, input? })` answers `stopping` while the old
  stop's ordinary scope still drains, keeping `held` and every queued input; once the native scope is idle it clears
  `held`, admits the optional input and consumes the same `pi.inbox` in one commit. An empty continue starts no run and
  invents no message, and the configured steering/follow-up mode is preserved.
- `Conversation.control()` reads the committed state, revision and stop source. Receipts are durable and idempotent per
  `requestId`; each newly recorded stop intent advances the control revision, so a pending continue that a later stop
  overtook is rejected as `superseded` instead of overriding it. A user stop only accepts a user caller
  (`source_locked`), and an agent stop never downgrades it. `Harness.resume()` only enables scheduling and never clears
  a conversation's `held` state.
- A request ID is not authorization. Replaying a request the conversation already settled returns its receipt verbatim
  and changes nothing, and the decision that settles a still-pending continue runs before that settlement: a pending
  user stop refuses an agent caller (`source_locked`) and a pending request recorded by one caller is refused for
  another (`caller_mismatch`). Such a refusal writes nothing, so the request keeps the receipt its own caller recorded
  and that caller can still settle it. A stop decides before it marks too: one refused for a stale
  `expectedControlRevision` or answered from an older receipt commits its answer without abort-marking or withdrawing
  anything, so a run it did not stop keeps running.
- `stop` and `continue` are the runtime's own control; a hold never survives as a client-side flag. Two limits are worth
  knowing: a `continue` whose request ID already names a submission is asked for the held queue and not for a second
  copy of that input, because the native admission answers a known request ID with the existing submission and runs no
  boundary, which would otherwise clear the hold and leave the queue where it was; and receipt retention is bounded per
  conversation, so an evicted request ID is re-evaluated as a fresh request.
- The record is `pi.inbox` definition version 2. A version 1 record — what unpatched 1.3.0 wrote — migrates to
  `allowed` with its queued items intact; a runtime that only knows version 1 refuses a version 2 record instead of
  reading it as `allowed`.

## Trusted stop and continue over HTTP

The product surface is the same conversation API every other write goes through; there is no second scheduler and no
separate queue. `apps/server/src/conversation-operations.ts` is the business-rule entry — `stop`, `continue`, `send`
and `control` sit beside `spawn`, `get` and `read` on the one `ConversationOperations` seam — and the HTTP routes and
any model tool that later calls them share it.

- **The caller is the host's.** The HTTP surface is the user and a model tool is the agent; neither a request body nor a
  model's own claim selects it. A user stop is refused to an agent resume (`source_locked`), an agent stop never
  downgrades a stored user source, and a removed conversation refuses stop, continue and both input routes with
  `session_deleted`. The model's own surface is exactly the five `agent_*` tools: `agent_send` gives an existing
  conversation another task through this same `send` — a user's stop refuses it before any dispatch record exists, and a
  stop the model itself recorded is one the model may explicitly resume — and `agent_stop` holds a conversation through
  the same atomic `stop` under the `agent` source. A model cannot stop the conversation it is running in, and neither
  tool accepts a caller argument: an unknown argument is refused, not ignored. The removal itself commits the native `held` state its own admission consults, so the refusal is
  not a re-check a racing writer could slip past: an admission that commits after the removal places nothing and runs no
  model, and the control read of a removed conversation reports `held`.
- **`POST /api/conversations/:id/stop`** body `{ requestId, expectedControlRevision? }`. One native commit persists
  `held`, the trusted user source and a new control revision, withdraws the inputs queued at that commit point and marks
  the conversation's ordinary live tasks for abort; background work is untouched. It never waits, so the answer states
  `drain: "idle" | "stopping"` and carries the durable receipt. A stale `expectedControlRevision` answers 409
  `revision_mismatch` and changes nothing; a retry of the same `requestId` reads its own receipt, so a repeated stop
  never sweeps the items that arrived since.
- **`POST /api/conversations/:id/continue`** body `{ requestId, expectedControlRevision?, text?, images?, whenBusy? }`.
  While the old stop's ordinary scope still drains the answer is `stopping` and every queued input stays; once the
  native scope is idle the same commit clears `held`, admits the optional input and consumes the held period's queue
  under the conversation's configured steering/follow-up mode. An empty continue starts no run and appends no user
  message. The optional input is admitted under the **resume's own request ID** — one identity end to end — so the
  retry that lost the answer reads back the same receipt *and* the same submission, and the submission's request ID is
  the one the client's own pending-turn correlation already holds. If that ID already names a submission the resume
  consumes the held queue without admitting a second copy.
- **A user's immediate send is a resume.** `POST /api/conversations/:id/messages` goes through the same seam: idle
  admits as it always did, busy queues, and a **held** conversation is resumed by that same dispatch in one commit. A
  model caller cannot do this, and a queue-only admission — the composer's steer/follow-up, or a framework report —
  never resumes: it is admitted as a queued item under the hold, which is what keeps a staged draft from silently
  clearing the user's stop. The message keeps the caller's **own** request ID whatever path admits it, so
  `GET /api/conversations/:id/submissions?requestId=` — the surface's own recovery read for a send whose answer was
  lost — resolves it in every case. While the stop still drains the answer is `stopping` with no submission ID: nothing
  is admitted yet, and the same request ID finishes the intent. A dispatch whose request ID already names a submission
  is answered with that submission (and with its resume receipt, when it recorded one) instead of being admitted twice.
- **`GET /api/conversations/:id/control`** answers the **latest** committed control plus, with `?requestId=`, that one
  request's durable receipt — so an older operation's answer is never read as the current state, and a client whose stop
  or continue response was lost reads back what really happened instead of re-sending the intent.
- **The wire states it.** Every snapshot, delta and stream baseline carries `control` beside the `queuedMessages` it
  governs, and the browser's `projectAgentState` reads both from that one frame. The queue is also stated **item by
  item** — see below.

## Subtree stop and interrupt

A conversation's own stop is local: it holds that conversation and never reaches a child. Reaching children is an
explicit, separate decision, and it is one operation with one seam — `createSubtreeControl` in
`apps/server/src/subtree-control.ts`, mounted as `subtreeControl`/`subtreeControlRequest` on the same
`ConversationOperations` seam every other control write uses.

- **`POST /api/conversations/:id/subtree-control`** body `{ requestId, action: "stop" | "interrupt", selected? }`.
  The caller is the host's own statement — this surface is the user — and nothing in the body selects it.
- **The scope is captured, not read live.** The first request under a `requestId` walks the durable
  `displayParentId` relation transitively from the addressed conversation and stores that id set on the addressed
  conversation, in the same commit that validates the selection. A child created afterwards is **not** implicitly
  included, and a replay is answered from the stored set rather than from a fresh walk. The walk crosses a tombstoned
  conversation instead of stopping at it, so a child under a hidden parent is still in scope; it never reads the
  catalogue, because a control decision must not depend on what one client happens to have loaded.
- **A selection cannot leave the capture.** `selected` names a subset of the captured set; an id outside it refuses
  the whole request `409 outside_subtree` before anything is written, and an empty array is `400`. The capture,
  the selection check and the record write are one commit.
- **Each child answers for itself.** Every target gets its own durable outcome — `accepted`, `stopping`,
  `held`, `already-settled`, `refused`, `not-found` or `conflict` — and its current `control` state. A removed
  child is `conflict` with the runtime's `session_deleted` reason because its removal already holds it; one child's
  refusal never turns into a blanket status for the others, and `partial` states whether any child did not end up
  simply stopped. The answer is `202` with that body whether or not it is partial.
- **Beside the outcome, the child's own session row.** Each outcome also carries `session`: the same
  `CatalogueEntry` — `runStatus`, `busy`, `revision`, `title`, relations — that `GET /api/conversations` lists
  for that conversation, read from the one facts pass the running poll already makes (`catalogueFacts`). It is the
  projection the session status APIs already own, not a status this operation invented, and it is read **beside** the
  recorded outcome rather than replacing it: a child the request stopped and that has since drained reads
  `status: "stopping"` with `session.runStatus.state: "held"`, one the user resumed on its own reads
  `"accepted"` with `"running"`, and a settled child whose report is waiting in its creator's queue reads
  `"waiting-report"`. A child the catalogue does not list — a removed one, or an id this process holds no attachment
  for — states no `session` at all instead of a row a surface could never show. No second scheduler and no per-child
  request: the row is projected from the same facts the list read uses.
- **`stop` uses the runtime's own control.** Each child is held through `Conversation.stop` under the user's own
  source and under this request's id, so a child that was already held only advances its revision and a replay cannot
  hold it twice. `accepted`/\`stopping\` reports the child's own drain fact, `held` reports that it was already held.
- **`interrupt` uses the native abort.** Each child is aborted, which withdraws its queued input and waits its ordinary
  scope out, and sets **no** hold — an interrupt is not a stop and is never escalated into one.
- **Nothing else changes.** This operation reaches task and control state only: it appends no entry, rewrites no
  relation, cascades no tombstone and claims no external side effect was rolled back. The addressed conversation's own
  control is untouched, so a parent stop and a subtree stop stay two different decisions.
- **It is resumable, and a child that settles is durable at once.** Each child's outcome is committed **when that child
  settles**, not collected and written after the last one answered: the record is all a reader of a request in flight
  has, so a child that is already done is readable while its slower sibling still drains. A request with one idle child
  and one child interrupted mid-run therefore reads `already-settled` beside `pending`, and only the children with no
  recorded outcome are continued by the same `requestId`. Committing late would instead leave **every** child
  `pending` until the slowest one returned, and the replay or restarted process resuming from that record would reach a
  child the request had already controlled — aborting work the user had since started on it. The children are still
  controlled concurrently, so one slow child never holds up a sibling's own runtime call.
- **A `stop` is idempotent by the runtime's own receipt.** `Conversation.stop` records the request's receipt in the
  same commit as the abort marks, so a replay of `stop` under that id is answered from the receipt and reaches nothing.
  `interrupt` has no such receipt: the native `abort()` commits abort marks and no per-request record, so a process
  killed **between** a child's abort landing and that child's outcome commit can still be retried into aborting work
  that arrived on it afterwards. Closing that last window needs an abort receipt committed with the abort marks at the
  runtime's own seam, which this operation does not have; see the ticket's remaining-limit note.
- **`GET /api/conversations/:id/subtree-control?requestId=`** answers the same captured scope, per-child outcomes,
  current control states and current session rows, so a caller whose response was lost reads back what really happened
  instead of re-sending the intent (`404 unknown_request` when that id captured nothing). That recovery read is also how
  a caller refreshes a race it lost: the durable half of the answer does not move, and the projected half states what
  the child is doing now — a drain that settled, a child the user continued, a report that arrived after the request, or
  a request a killed process left `pending` with every child's real row still readable. A read never controls anything
  and never rewrites the record to match the present.

### The Web surface: selective subtree control

The toolbar's **Agents** panel carries the decision under the child tree it already shows
(`packages/ui/src/components/SubtreeControlPanel.tsx`, over `packages/ui/src/lib/subtree-control.ts` and the shared
`subtreeControl`/`subtreeRequest` operations of `packages/session/src/control.ts`). It is a separate surface from the
composer's Stop precisely because it is a separate decision, and the **global sidebar stays navigation-only**: nothing
there reaches the subtree routes, and the child tree keeps listing and selecting conversations while a request is in
flight.

- **Nothing is written before a confirmation.** The panel offers `Stop subtree` and `Interrupt subtree` as two actions
  with no hidden escalation between them, and the confirmation names the addressed root, how many it is about to reach,
  and every descendant with its **own** status — because one confirmation can reach work the user is not looking at. A
  descendant whose catalogue row names an execution host other than the addressed conversation's own is shown with that
  host, so a stop on another computer is seen before it is pressed and not discovered after.
- **The default is the whole subtree, and exclusion is a decision.** Every listed descendant starts chosen; deselecting
  one sends it in `selected`, and the exclusion stays chosen across the next decision rather than silently widening
  again. What the user offers is only a proposal: the Backend computes and captures the governing set from durable
  relations, so a stale listing cannot reach outside the subtree and names a child that appeared after the capture never
  swept in. A selection the Backend does not recognise refuses the whole request with its own `outside_subtree`.
- **Requested and Now are two columns, never one.** Each child shows the outcome the request recorded (the Backend's own
  word, passed through when this build has none) beside the status of its current row — the same `catalogueRow` the list
  and the running poll publish. A stop that has drained reads `stopping` over `held`; a child the user resumed on its own
  reads `accepted` over `running`; a settled one whose report is queued reads `waiting-report`. A child the Backend stated
  no row for — a removed one — keeps its conflict and says `no current row`, because no surface shows a row for it.
- **A lost answer is read back, never re-sent.** The attempt holds one request id per (conversation, action, selection)
  exactly as a fork or a delegation does, so a retry repeats the identity the Backend already captured under. When no
  answer arrives the panel states that the request may have committed and offers two things: read it back (a GET on that
  id, which controls nothing) or resume it (the same id again, continuing the children with no outcome). No scheduler,
  no per-child connection, no automatic retry.
- **A retry repeats the decision, not the screen.** What is frozen at confirmation is the whole decision — addressed
  conversation, action, id **and the confirmed subset** — because a descendant listing does not stay still: a child
  finishes and leaves it while an answer is lost. A resume that re-read the listing would send a subset the Backend never
  captured (refused whole as `outside_subtree`), and one that sent no subset at all would tell the Backend to capture the
  **whole** subtree, the children the user deliberately excluded included. Both widen a decision that was narrowed on
  purpose, so a send and a read-back both take the attempt as their only input.
- **Completion is released on both paths.** A request ends when its answer says `completed` **or** when a read-back says
  so — and the read-back is where a lost race actually settles, with no write of ours ever answering. An identity held
  past completion is answered from the capture it already made, so the next identical decision would display children as
  controlled while nothing was reached; releasing it means that decision is a fresh capture, which is what the user meant.
- **Partial failure is shown, not summarised.** A refused child, a removed one and a child the request never reached each
  state themselves beside a set labelled partial; the panel never flattens them into one status.

The seam is `apps/web/e2e/chat/ux-subtree-control.ts` (production `AgentSessionPanel` plus `SubtreeControlPanel` behind one
real `createClient`, in Chromium): 78 checks covering the confirmation that writes nothing, the one POST with its own
identity and credential, the two columns, the exclusion, a partial result with a removed child stating no row, the
refresh that settles a drain while leaving the record untouched, a lost answer read back and resumed under the same id
**with the subset confirmed for it after the listing moved underneath**, an unfinished read that keeps that attempt and a
completed one that releases it, the refusal with the Backend's own code, navigation that stays available and costs no
request, and the **mixed matrix**: one request in which every child records the same outcome word while each child's own
current row states a different fact (`blocked`, `interrupted`, `waiting-report`), with the child tree and the answer
asserted to state the same row per child.

The verification is `apps/server/test/subtree-control.test.ts`: nested and tombstoned scope, a selection outside the
capture, mixed running/held/idle children, an interrupt beside a non-cascading parent stop, a replay after a later child
appears, and a fresh process over the same SQLite file. The projection is
`apps/server/test/subtree-control-projection.test.ts`: each child's projected row identical to the catalogue's, a stop's
drain refreshing it while its outcome stays, a user's own continue of one child reconciled rather than rewritten, a
removed child keeping its conflict and stating no row, a real delegated child's queued report surviving an interrupt and
still reading `waiting-report`, and a SIGKILL'd request reading back pending with its children's live rows before it
resumes.

The system acceptance is `apps/server/test/subtree-control-acceptance.test.ts`, which adds the matrix no single seam
could state: a four-level tree beside a second subtree with a hidden middle conversation (whole capture, the outside
child never named, chat/queue/relations/catalogue compared before and after); concurrent duplicate requests under one
identity and a child created while a second capture lands; a live child completing and a user's own continue during the
request (the record does not move, the projection does); a real **SIGKILL** between the first child's committed outcome
and the rest, resumed by the same request id with each child controlled exactly once across the kill; a **delegated**
child whose execution host (the gateway entrypoint, in its own process, over its own journal) is killed mid-command with
its own turn then in flight, so the subtree request meets live work while the child's queued report and the held parent's
transcript are compared before and after; and a store reopened by a build that installs no task definitions, where the
addressed conversation's own anchor is `blocked` with the runtime's reason and its subtree is still captured and
controlled. Every one of those reads through the product's routes or the runtime's own public seams; none of them is a
second implementation, a scheduler or a poller.

## The pending queue, item by item

A held conversation's queue is not a count of messages: it is the runtime's own `pi.inbox` items, and the user acts on
one of them. Every snapshot, delta and stream baseline carries `queuedItems` beside `queuedMessages` — the same items,
projected with what a surface needs to show one and to act on it:

- `submissionId` and `requestId` — the native identities. A report's request ID is `dispatchId:report`, which is the
  one [automatic delivery](architecture.md#automatic-result-delivery) recorded, so the item and the report it came from are
  the same fact.
- `mode` (`steer` | `followUp`), `content` (the text as the model will read it) and `source`.
- `source` is `{ kind: "user" }` for anything the user typed, and `{ kind: "report", dispatchId,
  childConversationId, childName, submissionStatus, answerEntryId, preview }` for a delegated child's result. The
  source is read from the item's own entry kind and data, never guessed from the text, which is what lets a surface
  name the child and open it.
- `contentToken` — the edit condition. It is a deterministic hash of the item's identity, mode and content, computed
  by one pure function in `packages/protocol` that both the server and the browser call, so an optimistic-concurrency
  token needs no round trip and no second source of truth.
- `editable` and `cancelable`, so a surface does not offer an action the runtime would refuse.

The rules live on the same `ConversationOperations` seam (`items`, `edit`, `cancel` in
`apps/server/src/conversation-items.ts`, mounted by `server.ts`) and the HTTP routes are thin adapters over it:

- **`GET /api/conversations/:id/items`** answers the projection above. It is the same queue the snapshot states, read
  on its own for a client that only wants the queue.
- **`PATCH /api/conversations/:id/items/:submissionId`** body `{ contentToken, content }` edits **that item's own
  copy**. One commit reads the item from `InboxDoc`, checks it is still queued and that the caller's token still
  matches, and replaces the text. The item's entry — a report's kind and data, a user input's own entry — is preserved,
  so editing a report changes what the model will read without rewriting where the report came from. An edit is not a
  decision to continue: it neither clears `held` nor starts a run, and it does not touch the child's own history.
  A stale tab's edit is refused `409 content_conflict` **carrying the current item**, so the older decision is
  replaced by the newer one visibly rather than overwritten; an item that has already been placed is refused as
  `not_queued`; an unknown id is `not_found`. Replaying the identical edit is an idempotent success, which is what
  makes a retry after a lost answer safe without a separate receipt store.
- **`DELETE /api/conversations/:id/items/:submissionId`** cancels one item through the runtime's own
  `abortSubmission`, which settles it `unanswered` with reason `aborted` and removes its inbox item. A retry of an
  already-cancelled item is an idempotent success, and a placed item is `409` rather than a silent no-op. A cancel
  never lifts the hold and never starts a run.
- **Neither operation resumes anything.** Only the trusted user `continue` — or a user's immediate send, which is a
  resume — clears `held` and consumes the queue. An empty continue consumes the held queue and appends no user
  message, and a queue-only admission stays queued. This is the rule the whole feature exists for: a late report, or a
  staged draft, cannot silently clear the user's own stop.
- **The reporter does not overwrite the user.** Delivery is idempotent per `dispatchId:report`, so a replayed report
  task after an edit keeps the edit, and a replay after a cancel does not revive the item: the item it would place is
  no longer in the inbox.
- **The decisions are durable.** They are the native inbox record's, not a client's, so a browser reconnect, a reload
  and a real `SIGKILL` of the backend all read back the edited text, the cancelled item's absence and the hold.
- **The whole-queue recall is unchanged.** `POST /api/conversations/:id/recall-queue` still withdraws the entire
  queue as the composer's recall action always did; per-item cancel is a second, narrower verb beside it, not a
  replacement.

In the browser, `ChatInput` renders one `QueuedItemRow` per item — the mode, the text, the child a report came from
with a control that opens that child's conversation, and its own Edit and Cancel — and a held banner above the composer
that states the hold and offers Continue. A `stopping` answer to Continue is shown as such and leaves the queue in
place; the composer's draft is kept. The `409` conflict's own body is carried into the view, so the stale tab is shown
the text that replaced its edit.

If upstream adds an equivalent native contract, only the patch and this adapter should change; callers keep the same
options. The native primitives are verified by `apps/server/test/native-input-control.test.ts`,
`native-input-control-migration.test.ts` and `native-input-control-crash.test.ts`, and the product surface by
`apps/server/test/conversation-stop-continue.test.ts` (see the
[ticket evidence](../.scratch/durable-subagents/issues/01-native-input-control.md) and
[ticket 02](../.scratch/durable-subagents/issues/02-conversation-stop-continue.md)).

## Quick delegation and the child tree

A user delegates from the conversation they are already in, without writing a prompt. The toolbar's **Delegate…**
entry opens a panel that lists the agent definitions the Settings › Agents panel edits — through the same
`GET /api/agent-definitions?cwd=` document and validation interface, so what the quick create offers is what Settings
saved and a definition this build cannot run is offered as unusable rather than hidden — asks for a task, and posts
`/api/sessions/:id/delegate`. It has no field for a context strategy, a tool set or a model: the definition owns those,
so the quick create cannot override the policy the definition or the user's configuration set. The entry is shown only
while the conversation selects the `hepi-subagents` capability, read from the catalogue row's own `extensions`, and
turning it off removes the entry while the child tree, every child's history and relations, and the generic stop and
continue of every existing child stay exactly as they are.

The attempt identity belongs to the attempt, not to the click: `lib/delegate-attempt.ts` holds one `requestId` per
(delegating conversation, definition, target) until the backend answers it, so a retry after a lost answer is answered
with the child the first attempt created instead of making a second one, and the next click after an answer is a
genuinely new child. The panel's target control is one select: "a new child", or one of the children the catalogue
already lists — the second is what "delegate again" means, and it is a decision the user makes rather than something
inferred from the layout. A child's own view offers itself first, because giving that same child another task is what
a user in the child usually means. **Sending a message in the child's own composer is not a delegation**: it is an
ordinary turn of that conversation and registers no report at all.

A successful answer opens the child in the same ChatWindow and its own native stream, from the catalogue row the
delegation answered with. The toolbar's **Agents** entry opens the child tree, built from the catalogue's own
relations — display parent, then creator, then the subagent edge — as a stable depth-first walk, so a child is always
shown under its own parent and the list does not reshuffle when a run ends. Each row states that conversation's own
`runStatus` (see [architecture](architecture.md#the-webs-own-delegation-and-the-childs-real-status)) and the
execution host the catalogue states (`gatewayId`) — the host the work really runs on, which for a remote Project
is not the gateway this Web origin is served from — with the
runtime's own reason beside it where the state has one; a row the catalogue stated no status for says so instead of
defaulting to a state nobody read, and a child whose display parent is hidden stays where it is and is marked rather
than being promoted. Opening a row selects it in the same window, so the tree is navigation and not a second
transcript.

### A child's recovery facts, and the one retry that belongs to them

A child's row states that conversation's `runStatus`, which is one word about one conversation. It cannot say what a
*delegation* is waiting on, so the child's own view carries a second, per-object statement above its transcript
(`packages/ui/src/components/ChildRecoveryPanel.tsx`, over `packages/ui/src/lib/child-recovery.ts`): the dispatch
record's preparation state — `context preparation failed` with the failed attempt's own task id and the runtime's
sentence, or that a retry was already asked for — the anchor's own phase, and where this dispatch's report stands. A
reporter waiting on a child that is still running and a preparation parked on its own failure are therefore two
statements, never one verdict, and neither is derived from the transcript's absence or from a parent being busy.

- **One read per conversation, no stream.** The panel asks `GET /api/conversations/:id/recovery` once for the child on
  screen and again only when the reader presses Refresh. It is not mounted per catalogue row, so the tree's promise —
  no permanent per-item connection — is untouched, and a conversation that is no delegation's child (an ordinary one, or
  a branch a user took from a child) renders nothing at all.
- **The retry is the existing dispatch identity, replayed.** When the facts state an unretried failure, the panel offers
  `Retry preparation`, which posts the **two identities that read returned** — the dispatch's `requestId` and the failed
  attempt's own task id — to the same route. The Backend validates them against the record before writing, so the parked
  anchor of the **same** child prepares again and admits its task once: no second child, no fresh identity, no second
  admission, and nothing running is aborted. A request naming an attempt the record does not state is refused by name
  (`identity_stale`), and asking about an attempt already retried answers `already_retried` — asking twice is asking once.
- **A lost answer is stated, not repeated.** A retry whose answer never arrived leaves the facts on screen with that
  state named and the same offer standing; nothing re-sends on the reader's behalf, and nothing retries by itself. A
  **read** that never answered is different: it says so and offers `Refresh` beside the failure, because a connection that
  came back is exactly the case a second read succeeds at, and the child's facts are otherwise unreachable from that view.
- **The newest answer is the one on screen.** Reads and retries are ordered by one fence, so a refresh asked over a read
  still in flight, a retry asked over a refresh, another conversation, a replaced connection or leaving the view each
  invalidate the older answer: it is dropped rather than written over newer facts, and a disposed connection's late
  answer has nowhere to land.

The three statements and the ordering are checked as a **page**: `apps/web/e2e/chat/ux-child-recovery.ts`
(`pnpm --filter @hepi/web test:child-recovery`) mounts the panel the way `ChatWindow` mounts it, in a browser, with
only the recovery requests held back, so the arrival order is the test's to decide rather than the network's.

**Two inputs that one run consumes share one answer.** When the configured queue mode puts several admitted inputs into
the same run, every one of their submissions settles on the **same** committed answer entry: `answerId` is that entry
for each of them, and no surface invents a per-input answer split. Each input still answers its own `requestId`, and the
transcript holds each input once, in the order it queued. That is the raw shared-answer reference the delegation design
chose instead of claiming per-dispatch result isolation (see
[the risk review](../.scratch/webui-next-exploration/design-risk-review.md)); a task that needs its own answer is its own
conversation, which is what a child or a branch is.

What the whole feature looks like in one session — Settings saving a definition, a quick create from the composer, the
child tree, a late report edited under a hold and then continued, the child's raw history with its inherited image and a
fork from a chosen entry — was driven end to end by `apps/web/e2e/ux-system-acceptance.mjs` against the production
Vite build served by the client ingress. That browser driver depended on the retired Next build and has since been
deleted; the backend-side acceptance (`apps/server/test/acceptance-*`) and the live `chat/` drivers hold the same
seams today. What the journey and the drivers beside it do **not** claim is in
[verification](verification.md#durable-subagents-the-combined-acceptance-gate-2026-10-17).

## Control, queue, fork and relations through the shared client

The Web page and the App reach the routes above through **one** client seam, not through their own copies of them:
`packages/session/src/control.ts` (`createConversationControl`) exposes the conversation's named operations —
`stop`, `continueRun`, `control`, `send` (including the queue-only steer and follow-up), `recallQueue`,
`items`/`editItem`/`cancelItem`, `fork`, `delegate`, `recovery`, `retryPreparation`, `addReference` and
`info`/`rename`/`remove`. Each is one
request to the Backend's own route, over the fetch the caller supplies, which carries its cookie or device bearer. The
control revision, the receipt a request id names, the queued item, the branch point, the reference and the tombstone
therefore stay the Backend's alone: this module keeps no second copy of them, infers no `busy`, and schedules no
retry. Two clients of one conversation read one authoritative control and queue, because both come from the state frame
the stream already publishes.

Every operation answers one of exactly three things:

- **a value** — the Backend's own answer;
- **a refusal** — a 4xx, carrying the Backend's status, its code (or the `reason` its receipt recorded) and its
  message. It will never be admitted, so showing it is safe;
- **an unknown outcome** — no answer arrived: a dropped connection, a 5xx from the hop in front of the Backend, or a body
  this build cannot read. It carries the **request id the attempt was made under** and is never retried, because a lost
  write may have committed. Resolution is to ask the conversation about that id — `control(id)` for a stop or a resume,
  `GET /api/conversations/:id/submissions?requestId=` for a message, the same attempt id for a fork or a delegation,
  which the Backend answers with the child or branch the first attempt made.

That is [ADR 0006](adr/0006-durable-submission-lifecycle.md)'s rule for a pending submission applied to the rest of the
surface, so one conversation has one vocabulary for a lost write. A request id belongs to the **attempt**, not to the
HTTP request: a retried fork or delegation reuses the identity it repeats, and only an answered attempt releases it.

A queue-only admission never resumes a held conversation — staging a steer or a follow-up is not the user's decision to
continue, and only `continueRun` or an immediate `send` is. Provenance is unchanged by this seam: a fork keeps its
native branch point and catalogue parent, a delegation's child keeps the definition (host, scope, name), its creator,
its display parent and its own native owner, a failed create is a refusal with a code that creates nothing, and a
retried attempt is answered with the conversation it already made. A removed conversation leaves the catalogue, stays
readable by id, and refuses every control write with `session_deleted`.

The seam is tested at the client listener over real HTTP against a real Backend, with one Web cookie session and one
device bearer acting on the same conversation; routes and the ownership split are in
[client ingress](client-ingress.md#conversation-control-queue-fork-and-relations) and the evidence in
[verification](verification.md#conversation-control-queue-fork-and-relations-ticket-10). The React surfaces that call
these operations belong to the shared-UI ticket, and the old `/api/agent/:id` and `/api/sessions/:id` consumers are
retired with the rest of the replaced Web paths; this seam adds no second control path beside them.

## Read failures and their recovery

A conversation read has four honest outcomes, and the shared workbench states each of them instead of a spinner, a raw
error string or a console line. The classification is one pure module, `packages/ui/src/lib/read-recovery.ts`:

| Kind | What the wire stated | What the surface offers |
| --- | --- | --- |
| `unreachable` | no answer at all, or a 5xx | **Retry**, which re-reads the conversation |
| `missing` | `not_found` (the Backend's own "this row is gone") | the way back to a working conversation |
| `refused` | any other 4xx, or a named refusal | the way back, plus the authored sentence the refusal carries |
| `cancelled` | the caller aborted the read | nothing: it is the surface's own intent, not a state |

The raw reason travels in `detail` for the log and is **never rendered**: a thrown read can carry the Backend's own
diagnostics (an entry id, a byte count, an upstream message), and what the page shows is a sentence this build owns
(`chat.readUnreachable`, `chat.readMissing`, `chat.readRefused`). The panel is
`packages/ui/src/components/ReadFailurePanel.tsx`; its Retry is a real `<button>`, so it is focusable and Enter
activates it, and a retry in flight states `aria-busy` and is disabled rather than inviting a second click.

**Where it appears.** The conversation hook classifies a failed `loadSession` read and keeps the failure in
`readFailure`. A read that failed with nothing on screen takes the transcript's place; a read that failed a **refresh**
keeps the accepted window — the projection already holds it and a transient error is not a reason to throw away what the
reader had — so the panel is a dismissible banner above it. The failure is cleared by the read that succeeds, and by a
window the conversation's own stream states: the stream is the same statement by another transport, and leaving the panel
over a transcript that has arrived would report a failure the conversation has already answered.

**The recovery is a read.** `retryRead` re-runs the conversation read and nothing else. A staged turn, a stop, a fork
or an upload whose outcome was never established keeps its request id and goes back through the submission lookup that
owns it (ADR 0006); a Retry that resent a mutation would be a second mutation. The read is forced, so the single-flight
does not hand back the answer that failed, and it begins under a fresh acquisition, so an answer that lands after the
reader moved on is fenced like any older one.

**Opening a conversation the catalogue does not carry** is its own read (the by-id answer a deep link or a reference
resolves), and it used to fail into a console line. It now states the same classified failure over the chat area, with
Retry for a read that never answered and a way back for one that cannot. A selection that lands clears it.

**A page that could not be read is not "there is no older history".** `loadContext` reports a failed page through
`onReadFailure` rather than answering `undefined` twice, because the two facts are different: a conversation that
re-baselined under the page has left that history (say nothing), while a page that failed has proved nothing about what
lies older yet. No surface needs that distinction today: the older-history sentinel reports its own failure and the
conversation read already carries this one, and a **search** hit no longer pages history at all — since history-navigation
ticket 03 it is one bounded target read whose failures are that coordinator's own named outcomes (see
[the full-history navigation outline](#the-full-history-navigation-outline)). The channel stays on the page read because
it is the read's own statement; it is not a second reader.


## The workbench's one selection

Which workspace the workbench is showing, which conversation or fresh composer sits in it, and which restore or open the
reader is waiting on are owned in one place: `packages/ui/src/lib/workbench-selection.ts` (`createWorkbenchSelection`,
read through `useSelectionState` and acted on through `useWorkbenchSelection`). The shell and the sidebar read the same
readout and send intents to the same store; no surface reports a selection back to another, so the shape this build
replaced — the sidebar owning a cwd, telling it to the shell, the shell answering with suppression flags so a report did
not read as a switch, and the sidebar then moving its own local cwd to match a prop — cannot come back.

The precedence on a first frame is the store's own: a `?cwd=`/`?session=` URL beats the tab's memory, and a `cwd` in
that URL beats the session beside it (the cwd is a fresh composer's target, so nothing is read); with nothing explicit the
tab's own memory is adopted — the composer it was showing, then the conversation it had. The workspace-wide memory
(`pi-web:last-open-by-workspace`) is what a bare route restores a conversation from once the catalogue answers, and the
accepted selection is what is written back.

The rules with user-visible consequences all live here:

- **Identity hydration is not a switch.** When the sidebar resolves the project a row's cwd belongs to, the conversation
  stays open, no transcript remounts and no URL is rewritten. A move to another **checkout of the same project** keeps the
  conversation too; a move to another **project** replaces the workspace and starts a fresh composer there.
- **A read the reader already left changes nothing.** An open that answers after the reader picked somewhere else —
  including another checkout of the same project — selects nothing, rewrites no URL and states no failure. The fence is
  the target the reader is on, not the request, and retiring a read is not a new attachment.
- **A returning reader gets the workspace they left.** An explicit choice of another project — from a conversation or
  from a composer — is decided by what the *destination* holds, answered before anything is adopted: the conversation its
  memory names if the catalogue the sidebar delivered still lists it, otherwise that folder's composer with the draft it
  parked there. Adopting a composer first and discarding a moment later would consume the destination's parked text into a
  key nothing shows, leaving it neither on screen nor reachable again; leaving a composer parks its own text in its own
  folder. A catalogue that has not arrived is not an answer, so the memory stands and the reader keeps the working
  composer rather than a pending restore. A bare route invents nothing.
- **Four draft operations stay four different things.** A carried composer takes its live draft to the new folder and
  leaves that folder's parked draft parked rather than merging into what the user is writing; New in a folder parks what
  was on screen and starts a separate identity; a promotion adopts the conversation the composer became and touches no
  draft — and only when it names the composer still on screen, so a submission the reader has left behind cannot replace
  what they are writing now; deleting a conversation leaves only when it is the one on screen and keeps every draft.
- **A failed open states its kind.** `missing` offers the way back, `unreachable` and `refused` offer a Retry that repeats
  the read and nothing else, and staying put is a complete answer: the failure belongs to the request, not the selection.
- **A navigation target is applied once.** A plain re-selection resets no reading position and re-picks the conversation
  already open without remounting it; an explicit entry is carried to the window, and an entry the window may not hold
  gives the raw-history surface its own position and opens it.

Three things stay outside it deliberately: a view's own imperatives (focus, an open menu, a measured panel) belong to the
surface that shows them; the catalogue's listing and polling belong to the sidebar, which hands its rows to the store
(`setCatalogue`) as the only thing a restore reads — the store asks no listing of its own, so a restore cannot race the
sidebar's; and a *transition* of presentation is the shell's policy, read from the accepted `projectTransition` counter
that only a change across project boundaries moves. That policy is one decision over the committed selection: the same
acceptance both clears the previous project's file tabs and puts on screen the raw-history position it asked for, because
following a reference into another project's entry does both at once and must not show a panel closing as it opens. A
position already standing reopens nothing the reader dismissed.

The conversation's unsent draft is not part of a read failure: the draft store and the session-switch cache are keyed by
the composer and the conversation, and nothing in this path clears either, so the way back opens the composer of the
conversation's own folder with its text still stored under the key it was written under.

These rules are tested at that seam (`packages/ui/src/lib/workbench-selection.test.ts`), over a real scoped draft store and
the two memories' own stores: URL / tab / workspace precedence, a stale open, identity hydration against a same-project
worktree and a different project, carry / park / New / promotion, delete, the failure kinds and their retry, and a target
applied once. The browser half is `apps/web/e2e/history/ux-workbench-selection.ts`: the shell mounted whole in Chromium
over a real `createClient`, asserting what only a browser holds — a `?session=` deep link, a real reload returning to the
composer with its text, a new tab inventing no restore, New parking what was on screen, a deletion landing in a composer
while the removed conversation's own draft is still stored, unsent text surviving a connection replacement, the raw-history
panel opening for an entry the transcript does not hold and staying closed once dismissed, and a reference into another
project's entry keeping its surface open. Its conversation answers are a fixture; the loading and restore are the shipped
ones.

## Bounded history, older pages, and the read blocks

A conversation's history is **bounded** on every surface that returns it. GET /api/conversations/:id/state, the
stream's first frame, and the client's own transcript all carry the newest **50 visible messages** (user, assistant and
compaction entries; tool results and bookkeeping do not consume the budget) capped at **300 raw entries**, because
counting raw entries starves user messages out of the window in agent-heavy sessions. Both numbers are server-side
constants, never wire fields: a client reads `hasMore` and the window's `oldestEntryId` instead of naming a size. A short
conversation is carried whole with `hasMore` false. **No unbounded mode exists on the state route** — not `?tail=all`, not
`?full=1` — so a consumer that needs the whole transcript pages, which is what the copied app's own reader and the
backend's search scan already do.

GET /api/conversations/:id/entries?before=<id>&tail=<n> serves older history by entry id. `before` is **exclusive** and
is the oldest id the client already holds, matching the meaning the copied app's paging already gives it, so prepending
a page never duplicates the boundary entry. The page is a slice of the **native active range** — the same array the
window is cut from — so it follows the runtime's own active order rather than entry-id order, and that is not a detail:
a head marker is kept first by the native view and carries a *newer* id than the entries it keeps, so a page ordered by
id can never reach it and the summary of everything the context dropped becomes unreachable. Slicing by position
reaches it, hands it out exactly once, and cannot cross it, because the marker is the first element of the range. The
page applies the same count rule, the same byte budget and the same projection expression as the stream, so a paged
entry and a streamed entry cannot differ — redaction included.

Three facts travel with every window, and they answer a different question from `projectionId`/`revision`:

- **`historyRevision`** is an opaque token over two committed, immutable facts of the conversation — its newest head
  marker and its newest visible entry. Two reads with no commit agree, an append moves it, a head marker moves it, two
  attachments of one conversation agree, and it is **equal after a backend restart on the same store** because the facts
  it names are durable. It is deliberately not `revision` (this attachment's publication counter) and not `projectionId`
  (an attachment identity); those are per-attachment clocks, and this answers whether the history a client already
  paged in may be kept. The conversation id is part of it because entry ids are inherited: a fork holds its parent's
  entry ids, so entry ids alone do not identify a history.
- **`historyHead`** is the newest head marker's id, or null. It moves when a compaction or a reset starts a new context,
  which is the one event that ends a loaded prefix: the transcript then matches what the model can see.
- **`oldestEntryId`** is the boundary the window **actually** has: the first entry it carries, read off the entries it
  is publishing rather than inferred by a reader, and `null` when the window is the whole active range. It is what lets
  a client keep a prefix it already loaded and still replace everything the window covers, and it is why a complete
  window states no boundary at all — nothing precedes it.
- **`hasMore`** says an active entry exists older than the window. It is computed from the window's own start index, not
  from a scan.
- **The boundary is a position, not an id.** The native view keeps a head marker **first** while giving it a *newer* id
  than the entries it heads, so a client trims at the boundary's position in the native order; comparing ids would keep
  the summary the window has already moved past and leave that client holding one entry more than a fresh read. A
  boundary this client does not hold anywhere is not trimmed by guesswork either: it is answered like a revision gap,
  with a fresh bounded read.

**A window that moves keeps the history the client had already loaded.** An advance pushes the window's start forward,
so entries leave its oldest end. An entry the client **already loaded** — sitting directly below the window and
contiguous with the pages it paged — was history on screen rather than window content, so it is **migrated into the
loaded prefix** instead of being dropped: a reader who scrolled back keeps the message they are reading when the next
turn arrives. The decision is one function over the two windows and the facts above, never over an attachment: nothing
is keyed on `projectionId`, so a reconnect — a new lifecycle clock for the same history — decides the same way and keeps
the prefix, and applying the rule again to the window it already produced states the same prefix, so a read and a stream
advance cannot disagree. The rule is `decidePrefix` in `packages/session/src/index.ts` — the shared session pure root —
and it is implemented there **only**: the accepted readout
(`packages/ui/src/lib/conversation-readout.ts`, which the hook publishes through) and the SDK's own window fold
(`reduceSseFrame`, which splits the state at its boundary and calls the same function) both call it, so two copies of the
rule cannot drift apart. The readout is where a window and the prefix it keeps become one decision: a statement the
fold accepted is handed to `acceptSession`, which decides the prefix against the window this readout already holds, so
no render, effect or ref compares this window with the previous one afterwards. Paged older history
(`prependOlderPage`), a landed jump window (`landHistory`) and the window's own pagination claim are published through the
same value, and `transcriptOf` derives what is drawn — the prefix only while it still precedes the window. Comparison is by identity and at the boundary's position, never by comparing id values, for the
reason above. A client that never paged holds no prefix, so evicted entries have nothing to be contiguous with and are
dropped: a prefix cannot grow past the server's window, and a fresh client's transcript is exactly the window. A
`historyHead` move — a compaction or a reset — is the one event that ends a prefix, and `hasMore` false means the
window is the whole range and nothing is behind it to keep.

**An exhausted page stays exhausted across live frames.** A page read that reaches the start of history states
`hasMore` false, and that claim is about the history in front of the reader, not about what lies behind the window's own
oldest entry: while the prefix it produced is still decided (same conversation, same head marker), an advancing window
does not put its own `hasMore: true` back, or every live frame would re-open the scroll sentinel over history the reader
already paged to its end and the oldest page would be re-read for as long as they stayed at the start. Dropping the
prefix — a new conversation, a moved head marker, or a window that became the whole active range — is what restores the
window's own claim, because that is when the claim is all that is left.

**Known limitation: entries neither side ever observed are not recovered.** A fold decides from what it holds plus what
the frame declares. If two reads land with a whole window in between — a disconnect long enough for the backend to
publish entries that then roll out of the window — the intermediate entries are in neither input, and neither the
prefix rule nor a re-read of the newest state can state them. Nothing re-reads `/state` repeatedly to paper over this:
a re-read states the same window, so a loop would report continuity it does not have. Recovering it needs its own
contract (a bounded page read behind the new boundary with head and acquisition checks, or an explicit incomplete
flag); it is out of this consolidation's scope and is recorded as [R1](../.scratch/architecture-consolidation/review-notes.md).

**The transcript is described before it is drawn.** The surface's own window is built in two steps, not one.
`packages/ui/src/lib/chat/chat-turn-model.ts` turns the committed messages the surface holds into complete **turn descriptions** —
a stable identity per turn, the message range it owns, its anchor, its process group (message count, tool-call count,
whether it starts expanded), its final answer with the files the turn wrote, and which messages carry a navigation ref.
Only then does `ChatWindow` turn those descriptions into elements. A turn is the segment between two group anchors (a
user message, a compaction summary or a subagent notification), and the segment before the first anchor is a turn too,
because the first history page can begin mid-turn. Keeping the decision out of JSX is what lets a window select whole
turns from the same list instead of re-slicing elements it already built, and it is what a test can assert without
rendering React. What the description carries is unchanged from the renderer's own rules: leading and trailing history,
tool-call/tool-result pairing, the process group's expansion and reveal, timestamps, written files and the live tail.

**Only the turns near the viewport are mounted.** The window is `packages/ui/src/lib/transcript-window.ts`, and it owns
exactly one question: which turns are mounted. It takes the turn descriptions from `chat-turn-model`, the scrolling
element the surface gives it, and the measured heights of what is on screen, and it returns the ranges to mount plus
the spacers that stand in for everything it omits. It does not read a page of history, decide what a turn is, or own
the scroll position; the loaded history and its cursors stay the hook's, search and the minimap keep their own owners,
and `ChatWindow` still owns what a turn looks like. There is one renderer: `TranscriptWindowSurface` maps a range to
elements through the same `renderTurn` the surface used before, so nothing draws a transcript twice.

**Where the reader is, is the presentation's.** `packages/ui/src/hooks/useTranscriptPresentation.ts` owns the viewport:
whether the reader is following the live tail, the tolerance a return to the tail re-attaches at, the "jump to the
latest" offer, the scroll a placement performs, and the prompt anchor — the spacer that keeps the reader's own latest
prompt at the top of the viewport while its answer streams in. It is a separate owner because the conversation had been
reaching into the DOM to do it: `useAgentSession` now holds no scrolling element, no scroll-position refs and no layout
effect, and what it states to the presentation is one fact — how many turns this surface itself staged
(`ownSends`) — because a send of the reader's own is the one thing a viewport owes that it cannot observe for itself.
A live turn does not pull a reader who has scrolled back (acceptance C6); a reader who returns to the tail is followed
again; and every placement states itself to the window through `adoptScrollPosition` first, so the window treats a
scroll the surface decided as its baseline rather than correcting it a second time.

**A notice is a fact; its clock belongs to the shelf.** The conversation states notices — an unanswered turn's reason, a
refused draft, an upload that skipped a file — as `{ id, message, type }` facts (`lib/notice-shelf.ts`) and drops one
when a surface says it is done with it. How long a notice is drawn, how many are on screen, which one is playing its
leave animation, and the pause a hover or a focus buys are `packages/ui/src/components/NoticeShelf.tsx`'s, because
they are things a surface that is on screen does: a conversation handed to the background holds no countdown for a
toast nobody is drawing (acceptance C7). A pause keeps the remaining time rather than restarting the duration, and an
over-full shelf retires its oldest notice rather than dropping a statement nobody read.

Four properties are what make it work with dynamic content:

- **Heights are measured, not estimated once.** A `ResizeObserver` watches every mounted turn's own element, so an
  image that finishes decoding, a web font that swaps in or a process group the reader expands changes the transcript's
  height and the window learns about it without the transcript re-rendering. A turn is wrapped in a formatting context
  (`display: flow-root`) so the rendered turn's own margins are inside the box that is measured; without that the
  margins collapse out, every measurement is short by that gap, and the error accumulates until the window scrolls
  against a height the document does not have.
- **A measurement and the range it implies are one decision.** Measuring sets the height and recomputes the range in
  the same commit, so the spacers, the offsets and the mounted turns always describe the same geometry.
- **The reader's turn is held while the geometry above them changes.** A page prepended in front of the transcript, or
  a turn above the reader getting taller, moves everything below it; the window corrects the scroll position by that
  turn's own change of offset, keyed on the turn's stable identity rather than its index. The correction is applied
  after the new spacers are committed (setting it earlier would be clamped to the old height), and a reader at the
  transcript's end is left alone because following the live tail is that behaviour's decision. The scroll container
  sets `overflow-anchor: none`: the window is the anchoring authority, and the browser's own anchoring landing on top
  of it would move the reader by the changed height twice.
- **A turn can be asked for by identity.** Search and the minimap name a turn that may not be mounted; the window
  mounts it as its own range rather than spanning the distance to it, because the turns in between are exactly the ones
  a window exists to keep unmounted. The identity is always the **entry a turn is anchored on**, resolved through
  `packages/ui/src/lib/chat/chat-turn-identity.ts` — never a turn's position in a list. The minimap enumerates turns from the anchor
  messages it can measure, while the transcript draws a turn for a leading mid-turn segment as well, which has no anchor
  message; a positional index between the two therefore names a different turn, and a key rebuilt as
  `turn-<entryId>` does not name a turn at all when the entry is a segment's first message rather than an anchor.

**Search navigation has finite settlement.** Bringing a search hit on screen is
`packages/ui/src/lib/scroll-settlement.ts`, and it states its own end rather than scrolling until something stops it. Arrival
is **visible and aligned** — the target's start at the viewport's top — and deliberately not *contained*: an answer
taller than the viewport can never be inside it, so a settlement that required containment would scroll every frame
forever and the reader could not scroll away from the block they searched for. It ends in one of three named ways: it
arrives (the target held its alignment for several frames), the **reader's own gesture** ends it (a wheel, a touch, a
drag, a scroll key — read from the reader's *input*, never from the scroll position changing, because the window
corrects the scroll position itself when the geometry above the reader changes and a settlement that took those
corrections for the reader would abandon itself the moment the page it waited for was measured), or the target left the
window, which only pauses the navigation and leaves the reveal in place. The frame budget bounds the rest, so geometry
that never settles cannot scroll forever. One settlement is active per surface, so two navigations cannot take turns
scrolling against each other.

A restored reading position pairs the containing turn's identity with that turn's viewport offset. The surface waits
for its history and mounted turn before placing it. The same reading snapshot carries process expansion overrides,
so session remount restores the content and geometry the reader left, including when they were at the tail.
An explicit placement supersedes any geometry correction already
queued by the window: `adoptScrollPosition()` cancels that old correction before recording the new baseline. Layout
recomputation compares range and offset values, so unchanged geometry preserves the existing state even when the
calculation allocates fresh arrays.

**A process group's expansion outlives its component.** The window unmounts a turn that scrolls away, so an expansion
kept in the group's own `useState` would be lost the moment the reader scrolled past and came back — they would find the
opposite of what they left. It is held by the surface under the turn's stable key, and the group reads it rather than
owning it.

**A saved reading position names a turn, not a message.** Saving reads the entries the window actually mounts — the
descendants of the content container, since a windowed transcript mounts turn subtrees — and records the **anchor entry**
of the turn at the viewport's top edge, because that is the identity a prepend cannot move. Restoring resolves it to a
turn through the same identity lookup and scrolls the **turn's** box, which is the box the window can mount on its own.

**A search pages until it finds the entry or the transcript ends.** One page is not enough — a hit in a long
conversation is routinely several pages back, and stopping after the first reports the search finished while showing the
reader nothing. Paging goes through the hook's own `loadContext` while `hasMore` holds, so the cursor, the loaded
prefix and the prepend anchoring stay its; a page whose oldest entry does not advance ends the search, which is what
keeps it from asking for the same page forever.

**Loaded history and mounted turns are different questions, and the paging control belongs to the loaded one.** The
sentinel that asks for the previous page appears when either there is history the conversation has not loaded
(`hasEarlierMessages`) **or** the window is not mounting from the transcript's first turn — because loaded turns the
window has left unmounted are still above the reader and must stay reachable. Reading only the server's flag removed the
sentinel while loaded turns stood above the reader, which stranded them in the middle of what they had already paged in.

The DOM plateau this produces, measured on the ticket-09 fixture (2000-message transcript, 1000x800 viewport, overscan
4, production window): 6-7 turns mounted at both 200 and 2000 messages, and about 240 elements inside the mounted
turns at both sizes. The **minimap** is not part of that number: it draws one node per turn by design, so it grows with
the transcript (about 4,000 elements at 2000 turns) and is the transcript's outline rather than its mounted history.
A single very large turn still mounts whole — windowing is turn-granular — and `content-visibility` would reduce its
layout and paint cost without reducing what is mounted.


**Deferred heavy content.** History entries carry the heavy parts of a message as a **read block** rather than inline,
which is what keeps a frame small without losing anything: an image inside the wire policy
(`packages/protocol`, one policy instead of two Web copies) becomes the URL of
GET /api/conversations/:id/entries/:entryId/tool-result-image?blockIndex=N, and an assistant thinking block becomes a
preview with `deferred: true` and its provider `thinkingSignature` dropped, restorable from
GET /api/conversations/:id/entries/:entryId/thinking?blockIndex=N. The copied app's browser half already fetched both
URLs on expand; what was missing was the server side, and it is now implemented — a deferred block is never emitted
without a route that serves it. Historical text above 64 KiB of UTF-8 content becomes a 2,000-character preview with
`deferred: true` and `textUrl`, restored through
GET /api/conversations/:id/entries/:entryId/text?blockIndex=N. The policy covers plain-string user prompts and text
blocks in user, assistant and tool-result messages. Ordinary answers, code blocks and the framework's own ~50 KiB tool
outputs stay inline. The browser offers explicit full-text loading; copying or editing a deferred message restores
the original content instead of using its preview. Opening, reconnecting and scrolling do not fetch full text.
The image policy belongs to the **message that carries the image, whatever its role**:
a tool result's screenshot and a user's own accepted prompt attachment are the same wire value, so both go behind that
one read block, and a mixed prompt (text and an image in one user message) keeps its text and defers its image. A frame
that carried a sender's own attachment inline would refuse the very read the sender makes next. Deferral applies to
**history only**. Thinking and media retain their existing deferral policy; text uses its explicit size threshold.
These policies apply during projection, before a frame is measured, rather than changing shape only after a refusal. The live partial is never
deferred: a streaming message stays exact.

GET /api/conversations/:id/read is the **raw history**: the entry table's own fork-aware record of a
conversation, read as bounded text lines or one image, with a cursor that continues exactly where a page stopped. What
the stream, `state` and `entries` carry is the **active window** — the entries since the newest head marker, projected
and redacted — so a compaction's dropped prefix and a fork's inherited prefix are both invisible there and both readable
here. The body is only the content: `output` is `[{type: "text", text}]` or `[{type: "image", data, mimeType}]`, and
everything about the read rides beside it in `details` and `diagnostics`. The query parameters are `offset` (1-based
**actual text line**, default 1), `limit` (maximum lines, default 2000), `entryId` and `blockIndex` (read one entry, or
one block of it — the native block index, which is how an image is fetched), `tail` (pin the snapshot's end) and
`cursor` (a JSON-encoded continuation). `details` states the scope, the pinned `tail`, the first line's number, the
limits in force, `outputLines`/`outputBytes`, `truncatedBy` (`"lines"` or `"bytes"`), `hasMore`, the entries and blocks
the page covered — each block with the line range it contributed, or its image metadata — and `next`, a continuation
naming the entry, block, block line, character offset, absolute line and snapshot it resumes at.

The budget is the native Read's: **2000 lines or 50 KiB per page**, whichever is reached first, and a page never splits a
line except in the one case the format allows — a **single** line longer than the whole byte budget is returned as a
UTF-8-safe prefix of itself with a cursor whose `charOffset` continues inside that same line, so the pieces rejoin byte
for byte and a multi-byte character is never cut. The first page pins the snapshot's newest entry as `tail` and every
page states it, so an entry appended while a caller pages does not move a line the caller has already read; a
continuation also starts **at its cursor entry** through the native bounded scan rather than re-walking the history from
its oldest entry. A cursor carries the presentation version that produced it and a mismatch is 409 `version_mismatch`.
Refusals are named: 404 `not_found` for an unknown conversation, an unknown entry, a `tail`, an entry id from a
conversation that did not inherit it, or a block that carries no text; 400 `invalid_request` for a non-integer bound, a
`blockIndex` with no entry and no content to address; 415 `image_not_served` for an image outside the one wire policy
the deferred history blocks already use.

Two limits are deliberate and named here rather than implied. A first read with a large absolute `offset` finds its
start by counting lines from the oldest entry — no line index is built, persisted or scanned, so a page is bounded but a
random access into the middle of a long history is not constant; a continuation is the cheap way to move. And one entry
is decoded whole before it is split into lines, so 50 KiB bounds the **output**, not the memory one entry costs.
`apps/server/src/conversation-read.ts` is the one implementation; the HTTP route and the `agent_read` tool call the
same operation, so a model and a client cannot be served two different histories.

The Web surface for this read is the toolbar's **Full history** panel, which is the same read and nothing else: it
lists the entries and each entry's block inventory, shows the page's own text, fetches one block on demand (an image as
its bytes, a text or thinking block as its lines), carries the conversation's reference surface (the links it makes and
the one action that creates them — see [References, and following one](#references-and-following-one)), and forks the
conversation at any entry it lists. The fork it makes is the ordinary `POST
/api/conversations/:id/fork` — the same one the sidebar's row menu and a message's "new session from here" use — so a
branch of a child keeps the child as its display parent and gets its own native owner there, and the panel holds no
second history, no second membership rule and no second fork path.

**A conversation's references, and whether they can be followed.** `POST /api/conversations/:id/references` stores one
reference as the referencing conversation's own state — the target's relations, workspace and owner are untouched, and
the payload copies no target content — idempotently by **target plus entry**. `GET /api/conversations/:id` lists them
with the outcome each one has now.

Validation happens at creation, in the reference owner, and covers three facts of the target rather than an existence
check: its conversation record (`target-missing` when there is none), its tombstone (`target-unavailable` when it was
removed — a removed conversation keeps its records, so an existence check alone would let a link be made to a target no
surface shows), and its **visible committed fork-aware history** for the optional `entryId`. That entry is the stable
entry identity the history owner already issues — not a coordinate, an ordinal or a copy — and membership is the
runtime's own membership-checked scan, the same fence a read block, a raw page and a navigation window use. So an
inherited fork entry validates in the fork, an entry behind a compaction still validates (the entry stays committed),
and another conversation's or a sibling branch's entry is `entry-out-of-scope` rather than accepted by an id lookup
(`entry-missing` when no conversation holds the id at all). A refused creation stores nothing.

A stored reference is never rewritten, dropped or repointed: a removal does not cascade into another conversation's
state, so the record stays and the read reports the outcome beside it (`target-unavailable` here; `stale` is the
follow-time answer when a reference resolved and no longer does, and `error` is the read itself failing, which is the
one outcome a retry can change). References remain the referencing conversation's own state, so a fork starts with
none and existing fork and tombstone behaviour is unchanged. There is no model tool for this and no reference store,
index or copied history beside `hepi.conversation.references`.

### References, and following one

The reference surface is part of the Full history panel: it lists this conversation's links and carries the one action
that makes them. Creation is a deliberate user action — nothing is created by a dispatch, a fork, a subagent spawn or
model output — and the picker defaults to the **conversation**, with an entry optional. The entry options are the
chosen target's own paged navigation outline (`GET /api/conversations/:id/navigation`), so an entry is one the history
owner already issued: it is chosen, never typed, guessed or derived from an ordinal. An optional label uses the record's
existing `label` field, and the write is the ordinary `POST /api/conversations/:id/references` through the client
ingress, so nothing is stored by this surface that the owner did not store. A refused creation shows the Backend's own
outcome name and says nothing was stored.

Following is a navigation, not this surface's own walk. A conversation reference opens the target conversation through
the shell's existing open-session seam. An entry reference hands that conversation **and the entry it named** to the
same seam, which resolves it through the transcript's bounded target coordinator (`useHistoryNavigation`): at most one
target window is read, the exact entry is placed, and the scroll is presentation-only. There is no locate loop, no
sequential page walk, no history reconstruction and no copied content. A follow that cannot land never reports success
and never substitutes the nearest surviving entry.

Every unresolvable reference renders its own named state, with the offers that match it:

| outcome | what the reader is told | offers |
| --- | --- | --- |
| `target-missing` | the referenced conversation does not exist | none — nothing is behind it |
| `target-unavailable` | the target was removed, so the link cannot be followed | none — nothing is behind it |
| `entry-missing` | the entry named is gone from that conversation's history | open the conversation, open its raw history |
| `entry-out-of-scope` | the entry named is not in that conversation's history | open the conversation, open its raw history |
| `stale` | the link resolved once and no longer does | open the conversation, open its raw history |
| `error` | the reference could not be resolved | retry — the one outcome a retry can change |

The offers are derived from the outcome (`referenceOffers` in `packages/ui/src/lib/references.ts`) rather than chosen
where the state is painted, so a control that cannot work does not appear: the raw-history offer is made only for a link
that names an entry, because the raw read is addressed by one, and a retry is offered only for `error`. Following a
reference the Backend reports as unresolvable opens nothing at all. The list itself is the Backend's answer
(`GET /api/conversations/:id`), read again on each conversation switch and after each creation; this side keeps no
reference cache.

One seam detail is worth naming because an entry follow depends on it: the coordinator mints its coordinate from the
conversation **and its history scope**, so a target handed over before the conversation's accepted snapshot states that
scope is not yet addressable. `ChatWindow` therefore waits for the snapshot revision before issuing a locate, which is
what lets a reference followed into a conversation the page already remembers land instead of being refused as
`malformed`.

The journeys above are measured over the **deployed shape**, not at the client seam alone:
`apps/web/e2e/chat/ux-references-acceptance.ts` drives the production page through the client ingress against a real
Backend over SQLite, with nothing intercepted. It creates a conversation-only link and an entry link through the picker,
reads both back after a full page reload, follows the conversation one with no target read, follows the entry one with
exactly one bounded `/navigation/around` and no outline page, and follows a link into a **fork** pinned to an entry the
fork inherited — addressed in the fork's own coordinate (`"c":"<fork>"`), with the entry landing outside the fork's own
window. A creation the owner refuses (the target was removed while the picker was open) stores nothing, a stored link to a
target the user then removes is reported as `target-unavailable` with no offers, and a **real Backend outage** on the
reference route is named rather than shown as an empty list, with its retry landing once the Backend answers again. Two
rows are not reachable from the surface by construction — an entry the picker never offers cannot be named by it — so
`entry-missing` and `entry-out-of-scope` are proven at the owner/route seam and at the client's own rendering seam
instead, and the driver says so rather than manufacturing them.

GET /api/conversations/:id/entries/:entryId reads one entry, projected and redacted exactly as the stream projects it.
It is the read block a deferred entry names, and it is what keeps the newest entry reachable when a frame that would
have carried it could not be: an unknown id is 404, a block index outside the entry's content is 400, and an image
outside the policy is refused rather than served anyway. The entry is resolved through the conversation's own
**fork-aware** history, not by entry id alone: ids are inherited, so a fork's entries and its parent's are the same
records — an id belonging to another conversation is 404 here, while an ancestor entry a fork inherited is served.

**The client half of a read block.** Those three addresses are wire facts the protocol builds
(`textUrl`, `thinkingUrl`, `toolResultImageUrl`), so a client reaches them through one reader per connection scope:
`packages/session/src/resources.ts`. It resolves an address against the Gateway the connection was admitted to and
refuses any other origin before a request is made — a native shell's own origin is the app bundle, so a relative path
would otherwise ask the shell for conversation history — and it never puts a credential in a URL: the cookie branch lets
the browser attach its own HttpOnly cookie, the bearer branch sets one explicit header. A connection that states no
origin is the Web host, where the document *is* the Gateway: its addresses stay relative (a continuation included), so
the browser decides the origin and attaches its own cookie, and only a path is served. `text()` follows
`nextOffset` and returns the whole block, which is what a caller asking for a deferred block means; `image()` returns a
**lease** rather than a string. Every reader of one address shares one blob, the blob is revoked when its last lease is
released, and a scope keeps at most 24 blobs / 32 MiB and 32 texts / 16 MiB, reclaiming the least recently used (a repeat
read counts as a use). An image body is read through its own stream and cancelled the moment it passes that same
retained budget — a stated `content-length` over it is refused without reading at all — so a body the scope could never
keep is `oversize` rather than a buffer the tab had to hold first. `dispose()` revokes everything and refuses later reads, and an answer that arrives after it is
dropped rather than retained, so switching connection or conversation cannot leave one scope's image in the next one's
view. Refusals are named for the surface to say out loud: `unauthorized`, `forbidden`, `not_found`, `oversize`
(413/415, including a block index the image policy refused in the frame), `unavailable` (5xx or a transport failure) and
`disposed`. Both read blocks are bounded by default — 256 KiB of UTF-8 per text or thinking answer with
`offset`/`totalBytes`/`truncated`/`nextOffset`, and a byte `Range` for an image (`206`, `416`, `accept-ranges`) decoded
from only the base64 groups the range touches — so the bound is on the answer and never on what is reachable. The
client ingress serves that address under the same cookie or device bearer, translating `/api/sessions/:id/entries/...`
to the Backend's own `/api/conversations/:id/entries/...` once at the entrance; that is its only route translation and it
interprets nothing about the block, so the one history projection stays the Backend's.

**Remaining content limits.** Text read blocks cover large historical prompts, answers and textual tool outputs.
Structured content such as a tool call with multi-megabyte JSON arguments still has no deferred reader, and live
partials remain exact. The window may shrink from its oldest end to meet its soft target, but it retains its last
projectable message even when newer bookkeeping entries contribute no message. If the remaining frame exceeds the
hard limit, the read answers the named `frame_too_large` reason; the by-id projection remains available. A count-bounded
window with only bookkeeping is extended back to the nearest projectable anchor, which may exceed the usual raw-entry
cap, so a caller gets either a usable paging boundary or an explicit refusal rather than an empty page with no cursor. **Every** surface that returns a window asks the same question, pages
included: a page that cannot be brought inside the transport's limit answers the same named refusal with the entry it
could not carry, rather than a multi-megabyte body that claims to be a page. No claim is made that a first load is
bounded for arbitrary content; the claim is bounded for content whose heavy parts can be deferred, which is what
`apps/server/scripts/perf-history-scaling.ts` asserts. The same script folds the stream through the **shared reducer a
real client uses** (`packages/session`) and asserts the advancing frames' contract as behaviour: a frame carries
`baseRevision` equal to the previous frame's `revision`, appends rather than re-serializing the window, carries the
window bookkeeping, and the entries it appends are byte-identical to the same entries read one at a time. Measured
bytes per turn are flat from 10 to 240 turns (~721 to ~726 bytes/turn) and the largest frame is flat (~1.04 KB), against
lane B's recorded 5,524 to 152,175 bytes/turn.

**What a publication costs.** The window and the history token are kept **incrementally** per attachment: an advance
that appended entries projects only those entries, extends the window by them, and advances the token's two facts (the
newest head marker and the newest entry) from what it appended; a head marker, a truncation, a replacement or an
overflow's root replace recomputes both from the view. Nothing re-derives the window or rescans the active range for a
token on an ordinary turn, and the projection of an entry — redaction and deferral included — happens once per entry
rather than once per publication. The attachment's state is bounded by the window itself, so a long conversation costs
no more of it than a short one. The rule that reads an append out of the runtime's own ops (`appendedEntries` in
`apps/server/src/history-window.ts`) translates one structural fact and is never a wire format: no Chord operation, raw
entry record or live document crosses the stream.

## The full-history navigation outline

The right-side rail is the conversation's **committed user messages**, not the turns a reader happens to have loaded.
Two reads serve it, one for the index and one for the landing: the outline page below, and the bounded target window a
page's own coordinate addresses (further down this section). Both read the same record and state the same identities.
`GET /api/conversations/:id/navigation?limit=&cursor=&scope` answers one bounded page of that outline: one anchor per
user message, a short preview of its committed text, an opaque coordinate a later jump is addressed by, the ordering
cursor that continues the page, and the identity the page was read against. It reads the same record the raw history
read does — the runtime's membership-checked, fork-aware `Conversation.entries()` scan over the entry table — and not
the active window, so the three things a window cannot state all hold: a compaction's head marker bounds the **model's**
context and not this scan, a fork enumerates the prefix it inherited as its own history, and a turn a sibling branch
added afterwards is not in it. There is no unbounded answer here: `limit` defaults to 100, is capped at 200, and the
built page is measured against a 64 KiB budget it states as its own `bytes`. A page the budget shortened says `hasMore`
and hands back the cursor that reaches what it dropped; a page that reached the end states no continuation at all, so a
caller never mistakes a finished outline for a cursor it may reuse. Nothing is counted against a stored index and no
message body travels: an anchor is an id, a cursor, a coordinate, and at most 240 UTF-8 bytes of preview.

**An anchor is a committed entry whose first model message is a user message and which carries no head marker.** Both
halves are structural facts the runtime already states, so there is no entry-kind registry to keep in step. The first
makes a user message the node and an assistant answer, a tool result or a system prompt not; the second keeps a context
marker out of the rail, because a compaction summary and a reset handoff are each stored as a user message and neither
is something the user wrote. An input an application placed under its own entry kind — a subagent's report reaches its
parent that way — keeps the user-role message the transcript shows, so it keeps its node. The range that precedes the
first anchor is stated as `prefix`: `none` when no committed entry precedes it, and `non-user` with the entries it
holds when the history opens with content the user never wrote. A leading segment therefore never becomes a fabricated
anchor or a positional id, and a continuation states no prefix it did not scan.

**Two identities travel with a page, because they answer two questions.** `snapshot` is the window's own
`historyRevision` token (newest head marker **and** newest committed entry), so a rail can compare a page with the
transcript window it holds and see that a turn arrived. `scope` is that token's head-marker part alone
(`scopeFromFacts` in `apps/server/src/history-window.ts`, declared beside the token's own builder rather than re-spelled
by a consumer) and is the identity every anchor's coordinate is stamped with. The split is what the required behaviour
asks for: an **append** moves `snapshot` and leaves `scope` alone, so a turn extends the outline without changing one
existing anchor's identity; a **compaction or a reset** moves the head marker and therefore the scope, which is already
the event that ends a loaded window, so the coordinates a caller holds are refused by name rather than landed somewhere
nearby. A page asked with a scope this conversation no longer has answers `stale-snapshot`; a scope that belongs to
another conversation answers `wrong-scope`. The two are named apart because a caller renders them apart — one is a
refresh, the other is bad addressing. Entry ids are inherited, so an id alone never says whose history it was read
from: that is why the coordinate carries the conversation and the scope inside it, and why the fence stays the Backend's
own membership check rather than anything the caller states.

**The ordering cursor orders and nothing else.** `cursor` is the entry's own id as a number, exclusive, and a
continuation is a scan from the first committed entry after it — the rule the raw read already applies, and the reason
an ordinal never has to become a jump identity for paging to keep working. A malformed `limit` or `cursor` is refused
as `malformed` rather than coerced, because a client must not be handed a page it believes it bounded itself.

**One projection, one owner.** The contract — the bounds, the coordinate's encoding, the preview rule, the page and
window assemblers, the shared size rule and the named refusals — is declared once in `@hepi/protocol/navigation`
(`packages/protocol/src/navigation.ts`, also re-exported from the protocol index), and each route is a thin adapter over
the scan (`apps/server/src/conversation-navigation.ts`). The client ingress **forwards both as written**: it re-pages
nothing, renames no field and re-truncates no preview, and `packages/gateway/test/ingress-navigation.test.ts` compares
the caller's bytes with the Backend's for the same query, for a page and for a window. There is no second runtime, no
BFF derivation and no unbounded wire index.

**The bounded target window is `GET /api/conversations/:id/navigation/around`.** One coordinate answers a window of the
same fork-aware committed history around the entry it names: `?anchor=&before=&after=&snapshot=&entry=&block=`, where
`before`/`after` count **messages the transcript would mount** (default 10 each, capped at 50) and each entry is the
Backend's existing projected shape — `ServerEntry`, the one expression the stream, the state read and an older page are
projected by (`projectEntry` in `apps/server/src/server.ts`, handed into the read rather than re-run by it). That is the
choice the spec left to ticket 01 and it is what makes a landed window mountable by the history owner that already
exists: the same deferred text, thinking and image blocks with the same read-block URLs, the same credential-failure
redaction, and no fourth surface that projects an entry its own way. A raw `conversation-read` text page would have
said none of that, and a new projection would have had to be kept in step with the old one forever.

The window is bounded three times over and says which bound cut it. `hasOlder`/`hasNewer` answer **whether committed history
lies that way in the history the window was read against** — not whether this read carried any of it — so a window asked
for zero context on a side still tells the truth about that side, and a target at the snapshot's own end states
`hasNewer: false` however much the conversation has grown since. `olderCursor`/`newerCursor` are the entries a
continuation pages from, in the same exclusive vocabulary the outline uses, and are stated exactly when `hasOlder`/
`hasNewer` is true; `trimmed` says a bound left committed history out; `capped` keeps its page meaning — the default,
not the caller, decided a count. Behind the counts sits the loaded window's own raw-entry cap (`NAVIGATION_TARGET_MAX_RAW_ENTRIES`,
`rawWindowCap(VISIBLE_WINDOW)`, asserted equal in `apps/server/test/conversation-navigation.test.ts`), so a span of
bookkeeping traffic cannot turn "50 messages" into a read of the whole history — the walk stops, says more exists, and
names the boundary it reached. On top of all of it the window is measured against the same 64 KiB budget an outline page
is, and the measurement is the shared one: `bytes` is the size of the response as it ships, its own `bytes` field
included, so a caller that measures what it received and compares it with what the response stated gets one number
either way (review note N1, closed by this ticket rather than repeated).

Two cases the bounds cannot resolve are answered by name instead of by a smaller lie. A window whose entries still
exceed the budget after every outer end was dropped is carrying exactly one entry — the target's own message — and the
read answers `frame_too_large` (413) with that `entryId` and the `bytes` it could not carry, which is the pair the
stream (`state_oversize`) and `GET …/state` and `GET …/entries` already state; the entry is not lost, and stays whole
through `GET …/entries/:entryId` and the read blocks its deferred previews name. And an entry the caller's history does
not hold is `missing` (404) — including an entry that exists in the store and belongs to a sibling branch, which is
exactly the case a lookup by id alone would have silently answered, because entry ids are inherited. `wrong-scope`,
`stale-snapshot` and `malformed` keep their outline meanings: a coordinate minted for another conversation, a head
marker that moved, a value the contract never issued. A caller therefore never lands on a nearby message and never has
to report a failed locate as handled.

Placement is stated **by identity**. `target.entryId` names the entry the read resolved, `target.anchor` re-issues the
coordinate over the identity the read actually holds, `target.blocks` lists the native text-block indices the entry
carries, and `target.blockIndex` echoes the block a deep search hit named — after the read checked it against that
entry, so a hit lands inside a block that exists. No offset, no ordinal, no pixel, and no requirement that the caller
already hold the entry: a window around an anchor three hundred turns back costs one jump, not three hundred pages.
`snapshot` pins the read **and is stated back**: a window asked against the snapshot the page stated is not moved by a
turn committed while the caller was reading, and the `snapshot` it answers with is that pinned identity — the history
the bytes were read from — not the conversation's current one, so the identity a caller holds names the entries it
received. That is the same rule the raw history read applies to its own `tail`, and a snapshot older than the anchor it
is asked to be around is the stale answer rather than a window that silently ends short of it.

**The client half is ticket 03, and it is delivered.** One owner — `packages/ui/src/hooks/useHistoryNavigation.ts`, on
the rules in `packages/ui/src/lib/history-navigation.ts` — holds the paged outline **state** and the **one** target
window a surface asks for, and both hosts mount it through `ConversationApi.navigationOutline` /
`.navigationTarget`, which forward these two routes as written. Its whole contract is *one request, at most one read,
exactly one settlement*: a jump or a deep search hit whose entry the transcript already carries is answered with no read
at all, and one it does not carry costs one bounded window read — never a page walk toward it. A rail jump is addressed
by the coordinate the page issued; a search hit mints its coordinate over the scope the conversation states and the
Backend re-checks it, so the two arrive through the same owner and cannot drift apart.

The window a read answers does **not** become a second transcript. Its entries go to the session hook's existing
paged-prefix owner (`landWindow`), merged by the ids the Backend issued, never twice, and cut against the entries the
projection's window is authoritative for — an overlapping prefix would fail the prefix rule and drop every page the
reader had loaded, turning a jump into a loss. `decidePrefix` remains the one rule that says what that prefix becomes
when the window moves, so a jump made before a re-baseline retires with the head marker it was read under. Acquisition,
projection and the lifecycle fold are untouched.

**Seven outcomes, each rendered as itself.** A landing is `held`. Everything else names why it was not: `missing`,
`stale-snapshot`, `wrong-scope` and `malformed` are this contract's own reasons (the last two also answered by the
client's coordinate fence *before* a read is spent), `cancelled` is a jump the conversation switch left behind,
`deferred-busy` is a run in flight the reader has not yet asked to land after, and `error` is a read that could not
answer — including a code the surface has no sentence for, `frame_too_large`, which keeps the Backend's own detail
beside it rather than a second vocabulary. `NavigationOutcomeBanner` renders each with its own words, a retry, the
raw-history offer and a dismissal. **No failure path ends as a silent handled**: a locate that did not land retires the
shell's target without reporting it as landed.

**A navigation owns the viewport, and an animation asks for nothing.** The older-history sentinel stays silent for
exactly the span a navigation holds a target (`navigationHoldsViewport`), so a window moving toward an entry three
hundred turns back loads nothing on the way — the sequential hydration this ticket replaces, arriving through a scroll
event rather than a loop. The presentation scroll still belongs to the surface that owns the viewport and begins only
once the target's DOM exists; the coordinator reads no scroll position and can settle nothing.

**The rail is the conversation's history, not the window's (ticket 04).** `ChatMinimap` reads the paged outline as
its index and the measured transcript as its geometry, joined by one rule — `buildRailNodes` in
`packages/ui/src/lib/history-rail.ts`. A node the transcript carries is **loaded** and behaves exactly as it always
has: a local measured jump to its user message, its assistant answers and their headings, its tool count. A node the
transcript does not carry is **unloaded**: it has the entry's identity, the server's cursor for its order, and the
page's own bounded preview, and no pixel position at all. Its dot is drawn hollow, it never claims to be "visible", and
nothing in the rail infers a height for it — a rail that guessed where an unloaded message sits would be stating
geometry it never measured. The list is ordered by the server's cursor and nothing else, so a page arriving in front of
it renumbers nodes without reordering history, and the reader's focus is held by entry id rather than by position, so a
page arriving cannot move the highlight to a different message.

Two ordering rules the naive merge gets wrong. A loaded turn the outline does not enumerate — an assistant-only prefix,
a compaction marker, a subagent report — is **not** a node once a page exists: ticket 01's anchor rule already excluded
it, and this surface must not fabricate the identity spec decision 10 forbids. A loaded turn **newer** than the newest
listed anchor **is** a node: the reader's window sits at the tail, so a turn committed after the last page was read is
newer than that page, and dropping it would leave the rail's bottom edge behind the transcript.

**The rail is operable without a pointer.** The list used to open on hover alone: none of its nodes took focus, so a
keyboard reader could not open the index, read a preview, or reach the continuation control at all. One button at the
head of the rail — `[data-minimap-opener]`, labelled "Open the message outline" and `aria-expanded` — now opens it,
takes the focus to the first listed turn, and closes on Escape with the focus returned to itself. Arrow keys walk the
turn rows in the outline's own order; Tab still reaches the assistant answers, the headings and the continuation
control. A list the keyboard opened stays open when the pointer leaves and closes when focus leaves the rail, because
the pointer is not the reader's way in. The dot rail begins below the opener (`RAIL_TOP`), which is the one offset the
node layout, the guide line and the pointer's hit test share, so the pointer's mapping from a pixel to a node is
unchanged. Nothing here navigates: a key moves focus, and only an activation hands over a coordinate.

**A re-baselined history re-reads the outline; an append does not.** The anchors a page issued are addresses over the
scope the conversation stated when it was read, so a compaction or a reset that moves the head marker left the rail
listing anchors the coordinator's own fence refuses — `stale-snapshot`, retry included — until the whole outline was
read again by hand. The hook therefore compares the held list's scope with the conversation's current one: a
different scope retires the list and reads its first page again, while a moved entry fact (an append) re-reads
nothing. A page that answers late, describing the replaced history, is dropped rather than listed; one dropped answer
per snapshot is the refresh, and a second is the backend disagreeing with this client about which history is current,
which is a named `stale-snapshot` rather than a read loop. A `stale-snapshot` failure's own retry mints a fresh
coordinate over the scope the conversation states by then, so the reader's one way out of that failure can succeed.

**One page on open, one page per request, one read per jump.** A conversation reads its first outline page when it
opens; every further page is read when the reader reaches for it in the rail's own preview list, and one activation is
one page — an automatic load on visibility would walk a long conversation's whole index the moment the rail was opened.
A page that failed is named in the rail and reaching for the end again is its retry, so a lost read is a state rather
than a history that appears to end. A click on an unloaded node hands over exactly one coordinate
(`onJumpAnchor` → `NavigationCoordinator.jump`) and issues **no** outline request: the surface answers it through the
same coordinator a deep search hit uses — one bounded target window, landed through the paged-prefix owner, then the
reveal and `startScrollSettlement` alignment the search path already has. The rail's own landing is held in
`railLanding` beside the shell's `searchTarget`, which is what keeps `navigationHoldsViewport` true from the click
until the alignment finishes, so the sentinel stays silent for exactly that span. A named failure releases the gate with
the banner on screen and leaves the request standing for its own Retry, which is the rule ticket 03 established taken
here for the rail's request; a conversation switch and a dismissal release it too, because a request left standing
would read to `navigationHoldsViewport` as a navigation owing nothing and gate older-history paging for the rest of the
session.

**Not yet delivered.** Ticket 05 owns the system acceptance matrix — a real-Backend conversation longer than its
window, a compacted earlier anchor, fork inheritance, an append during a navigation, stale coordinates and the
deep-search journeys observed together. This line's own scenes are `apps/web/e2e/history/ux-history-rail.ts` (the rail against
the production `ChatMinimap`), `apps/web/e2e/history/ux-rail-keyboard.ts` (that same rail driven by the keyboard alone),
`apps/web/e2e/history/ux-history-scope.ts` (the production `useHistoryNavigation` across a compaction, a late page and a jump)
and `apps/web/e2e/history/ux-navigation-retry.ts` (the production `ChatWindow` under `StrictMode` with only its network
boundary replaced). The presentation owners have their own scene:
`apps/web/e2e/chat/ux-transcript-presentation.ts` drives the production `NoticeShelf` and `useTranscriptPresentation` with
real timers and a real scrolling element — a notice drawn and retired by the shelf's clock, held while the reader is on
it and resumed for the time it had left, a reader scrolled back not being pulled to the tail, and a reader back at the
tail being followed again.

## The session-switch cache

Switching back to a recently visited conversation draws its last settled window immediately — the projection's bounded
window, the pages the reader had paged in front of it, the head marker those pages were loaded under and the head the
window itself was stated under — while the freshness read that replaces it runs. That remembered view is adopted as
the mount's **initial** state and is never written afterwards, so a statement the fold has already accepted — the
window a stream this mount joined handed over, or a read that landed first — is never overwritten by it; the pages are
still governed by `decidePrefix`, so a window that moves the head drops them rather than restoring an older head's
entries in front of the accepted window. The cache is `packages/ui/src/lib/session-view-cache.ts`: **page memory only**, never
localStorage, IndexedDB or a service worker and never sent anywhere, so a reload clears it by design and there is no
persisted shape and no compatibility code. It holds **settled history only** — never streaming state, queued messages,
run state or SSE objects.

Its bounds are **8 conversations**, **32 Mi UTF-16 code units** of serialized snapshot and a **10-minute TTL**, evicting
least-recently-used first; reading a window is the touch that refreshes its recency. The unit is the `length` of the
snapshot's JSON serialization — code units of the payload's own shape, so the budget is a nominal serialized-length
bound and **neither a heap ceiling nor a UTF-8 byte bound**. A multi-byte window is charged fewer units than the bytes
it would take on the wire, and the memory the browser actually holds is higher than the units it was charged.

**One measure per write, one running total.** A write serializes the snapshot it is handed exactly once and stores that
number beside it; the store keeps the sum of the measures it holds, so a write costs the new snapshot plus the entries
it evicts rather than a rescan of every stored payload. Replacement, the TTL, explicit deletion, eviction and
`clearSessionViewCache` release the stored measure through the same removal path, and an LRU touch reinserts the entry
under the measure it already has, so a touch never measures again. A snapshot larger than the whole budget, or one
whose serialization throws, is refused and the store is left exactly as it was. `resetSessionViewCacheForTests()` drops
the module's state and is the only other public entry point.

The snapshot a caller hands over is held **by reference**: it is a settled view the surface no longer writes to, so the
cache neither copies it on the way in nor clones the window on the way back out — restoring a conversation must not
cost a second copy of the history the cache exists to avoid re-fetching. A caller that still mutates its payload must
copy it before the write; the cache's contract is that what it is given is immutable from then on.

## Composer drafts across a refresh

A composer's unsent text and images are the page's scratch, not conversation state, and `packages/ui/src/lib/draft-store.ts`
is their one owner — an **instance per connection**, created with it and read from it (`workbenchConnection.drafts`), never a
module scope a render installs. That store belongs to **this** build: a page still showing an older Web revision holds its draft in
memory only, so before refreshing an open page across a Web-origin switch, copy the unsent text and save any attached
image by hand ([runbook](deployment-runbook.md#existing-open-pages-at-a-web-contract-switch)). Every operation on it stays synchronous — read, write, move (`rekeyDraft`) and clear — and the
browser store is a **mirror** of that memory rather than a second source: the memory answers every read, and a draft is
never fetched to be read.

The mirror is `sessionStorage`, the one per-tab store the browser offers. It survives a reload and an in-app
navigation and is never shared with another tab, so a hard refresh finds **this** tab's own unsent text and images,
while the same conversation open in another tab keeps its own composer. Text and attachments are two entries under one
draft key, because they change at very different rates: the text entry is rewritten per keystroke and stays small, while
the attachment entry is written only when the attachment list actually changes and is the expensive one — one combined
entry would re-serialize every attachment on every keystroke.

The key is the composer's own, and the store's entry name keeps the connection scope beside it. An existing conversation is
keyed by its session id; a fresh composer is keyed by its transient `new:<id>:<cwd>`, whose id distinguishes consecutive
composers in one folder, and a composer the reader left but the folder has not seen again is keyed by `parked-new:<cwd>`.
That draft id cannot be rebuilt from the folder, so the tab's own navigation memory carries it alongside the cwd it already
remembered (`packages/ui/src/lib/tab-session.ts`, `withTabOpen`): a reload returns to the composer the tab was showing and
reads its draft back. A key remembered for another folder is refused rather than applied, and every one of these keys is
owned by the selection — see [the workbench's one selection](#the-workbenchs-one-selection).

A browser that refuses the write — a quota is the real case, since an attachment list can outweigh the storage a tab is
given — is not silently obeyed. The stale entries for that key are dropped, because they no longer describe the
composer, and the refusal is reported (`getDraftStorageIssue`) so the composer says the draft will not survive a
refresh. The draft itself stays in memory: the user has lost nothing they can still send. Both halves go together rather
than keeping the small text entry alone, because a half-written key would restore a draft the composer never held.

An attachment list the store already refused is not offered again while it stands unchanged: a refusal is about those
bytes, and re-serializing them on every keystroke is exactly the cost the separate entries exist to avoid. So holding an
oversized draft stays as cheap as holding a small one, and the retry that can succeed is the one where the attachments
changed — which is what removing or replacing one does. Sending or clearing the draft ends the limit too, and a browser
that is merely temporarily full reports again as soon as the attachments change.

**A browser that denies the storage API itself** (the getter throws, as it does when a profile blocks site storage)
leaves nothing to refuse and nothing to read, so the store stays in memory and no limit is stated. That is the same
silence the other browser preferences in this app already have, and a profile that blocks storage this way does not
usually reach a signed-in page at all.

Two rules the store keeps: sending clears the draft, so a reload cannot put a committed turn's text back as unsent; and
a reload neither resends nor re-notifies, because the submission's own `requestId` lookup is the recovery seam (below)
and a committed answer is never a fresh notice. The `ux-submission-recovery` browser driver drove the real reload for
both a fresh composer and an open conversation, with an attached image; it depended on the retired Next build and was
deleted, so `packages/ui/src/hooks/useAgentSession.lifecycle.test.ts` and `apps/server/test/durable-submissions.test.ts`
are what hold those rules now.

**Limit at the contract switch.** A page still running the **previous** Web build keeps its drafts in memory only, so
nothing this build stores can be written retroactively for it: unsent text and any attached image have to be copied or
saved by the user before that page's first refresh, and every reload after it is covered by this store. The
[deployment runbook](deployment-runbook.md#existing-open-pages-at-a-web-contract-switch) states that step for the
cutover.

## Submission recovery

The open conversation's lifecycle is decided in exactly one place: `packages/ui/src/lib/lifecycle-projection.ts`, a pure
module with two entry points — `createProjection` and `advance` — that validates, orders and folds observations from
either transport into one view, its notices and the I/O it wants performed. Its returned `Step.snapshotAccepted` also
states whether a snapshot is the current statement.

Both transports reach that fold through **one accepted-facts receiver**,
`packages/ui/src/lib/lifecycle-acquisition.ts`: `httpStatement`/`sseStatement` normalize a complete read — the attachment's
identity with its revision, the native run, the outstanding submissions, the committed transcript and the facts that
travel beside the window (the head marker, the active leaf, the queue) — and `receiveAccepted` folds it once and reports
whether it was accepted. The hook's `receive` publishes those **common** facts from that one report: the transcript
payload, the head marker, the leaf, the failure and the queue, on both transports, under the fold's decision. What each
transport does *besides* that stays explicit and separate — the HTTP read's prefix migration, session-view cache
checkpoint, pagination and tool loadout, and the stream's live rendering (tools, live message, phase) — because those
are not facts the other transport states. A statement that is not a window at all (a live `submission` fact, a failed
read) carries no facts to publish.

Older or wrong-attachment reads cannot overwrite these facts, and a same-revision statement remains current so a
remount can hydrate its metadata. The projection owns no socket, timer, store or scheduler: the hook
(`useAgentSession`) keeps cache and rendering, and `packages/ui/src/lib/conversation-session.ts` owns the conversation's
UI I/O — the stream reader it joined through the shell's one source per conversation, its single-flight reads, the one
admission path, the by-id lookup and the explicit reload — and is the caller that performs what the fold requests. That
value is bound to one connection and one conversation identity, so its reader and its reads are released together; the
chat's mount identity is the conversation it shows, which is why a reload of the same conversation re-reads instead of
rebuilding the surface. The reload is one owner's operation, and the `/reload` command asks the same function Settings ›
General does: Settings states the change, awaits the answer and performs nothing itself, and the operation performs the
Backend's route, the read and the notice. The operation's `ReloadOutcome` is what a surface outside the chat reads
when it awaits it — `reloaded` with the sentence the read stated, `failed` with the failure's own sentence, or
`superseded` when another connection or conversation is on screen — so a definitions panel asking for a refresh cannot
read a resolved promise as a success. What the notice claims is what the **read** established, which is a typed
outcome rather than a nullable one: `accepted`, `refused` (an older window the fold rejected), `missing` (the Backend's
`not_found`), `failed` (carrying the read's own `ReadFailure` kind), `cancelled`, and `superseded` (another connection or
conversation is on screen, so there is nothing to claim). A `refused` window ends the read — the agent-state query is
not made for a window the fold rejected, because a caller acting on its answer would resume a run or claim a reload from
the statement the surface just refused. A route that rejects is reported as a `failed` outcome by the operation, so a
caller that awaits it cannot receive an unhandled rejection and no read is asked for a change that never happened — and a
rejection that lands after a connection switch is `superseded` instead, because the route belongs to the client that
sent it. One reload is one notice: `/reload` is a caller of the same operation and does not restate its outcome. A read is fenced by the **connection** it was asked through — not only by the conversation id, because two
connections can hold the same id — so an answer that arrives after a switch is refused whether it is a window, a
`not_found` or a failure. The conversation's own selected model and reasoning level are read from the accepted transcript rather than
from a mirror beside it, so a refused frame cannot move them; the separate `/state` agent-state query is an
independent read with its own ordering and refines that transcript without being gated on a window's acceptance. That
read is stamped, when it begins, with the accepted statement it describes — the attachment's identity **and** its
revision — because a revision is counted per attachment instance: a reconnect or a backend restart mints a new identity
whose counter starts again, so an answer from the replaced attachment refines nothing even when its revision is
numerically larger. Every field such an answer states — the model, the reasoning level, the context usage and the
queue — is published by that one fenced writer, and it reports whether the answer was accepted; a caller whose own
action depends on the answer (resuming a run's phase, filling the prompt panel, settling a shell recovery) reads that
report instead of comparing the stamp a second time, and one the fence refused is never handed back to be acted on. The view keeps four concepts apart — the committed transcript, the staged overlay, the answer
interest and the native run — and `packages/ui/src/lib/lifecycle-store.ts` holds one value per composer or conversation in
memory so the promotion remount finds the turns staged under the key they were sent under.

A send is a **Pending Submission** from the moment it leaves the composer until the conversation commits it as a
**Committed Message**; until then it is not history. Each send is staged under the `requestId` the browser generated,
the prompt response names its `submissionId`, and the projection moves the turn through `queued → placed →
done/unanswered`. The overlay ends when the turn's own entry is committed, and the answer interest survives that
commitment: a run's outcome is stated by the runtime's own terminal fact, never by a committed entry, a busy edge or a
turn's absence from the outstanding set. A `done` input's projection carries
`answerId`, the committed answer entry it was answered by, which is what groups the inputs of one steer group under the
one answer they share; a write, an unanswered input and an input with no answer yet carry none. A turn is settled by the
entry its own submission owns, so a message the user repeated is never mistaken for another one; nothing is inferred from the number
of committed entries or from the message text. The backend also sends a `submission` frame per lifecycle transition,
which is how a turn that ends without an entry — a recall, an abort — ends by name: the outstanding set says only what
is still in flight, so a turn it omits is not a settlement, and reading that absence as one is what took a live turn
off the screen right after Send. A rejection the backend answered with a reason clears the turn and restores the draft,
so a resend is the user's deliberate act, and the same `requestId` makes that resend admit once. A send that never
reached a conversation at all — the session it needed could not be created — is refused the same way and settles the
same turn, so it leaves no ghost overlay and no silent failure. Settings, live output and tools always follow the newest
snapshot — only the pending set is reconciled.

The surface also states what is happening, from that same projection, so a first turn is never silent: the projection's
own phase is `preparation` while a turn this surface sent is in flight and no native run is reported — the window that holds
session creation, the stream handshake and the resource discovery the first admission performs — and `running` from the
moment the projection reports the run. The status line shows the preparation label there and becomes `waiting_model` only
then, so it never claims a model the run has not asked; a turn whose outcome is unknown is neither, because its own
state is what the surface states. The `submit-stall` browser driver held session creation, the stream handshake and
the provider on real in-flight requests to assert the staged turn and the status from the click, that the status never
goes silent and never claims a run while one is held, and that a failed creation states the truth and restores the
draft exactly once. That driver depended on the retired Next build and was deleted; `packages/ui/src/hooks/useAgentSession.lifecycle.test.ts`
and `apps/server/test/durable-submissions.test.ts` hold the stage and status rules today.

When the connection carrying the submission or its events ends before either outcome is known, the state is
**Submission Outcome Unknown**: neither rejection nor commitment. The turn stays on screen and nothing resends it
automatically. The statement is made from the projection's own unresolved subject, never from a turn the surface
invents: a staged turn carries it under its own overlay, and a turn the conversation already committed carries it as its
own line, because that message's entry is in the transcript and the outstanding interest — not a pending turn — is what
says its outcome is unknown. Recovery asks the conversation for that submission by the `requestId` the browser generated —
`GET /api/conversations/:id/submissions?requestId=` answers the durable record, or null when the id was never admitted —
and settles on what it finds. The backend's `resync_required` marker and every reconnect drive the same lookup for each
turn still waiting — the projection enumerates its own unresolved turns and requests one lookup per turn, and the hook
performs that request — so a missed frame is answered by asking rather than by inferring from what a later frame omits. A
turn still staged when a sweep runs has no submission identity to ask about, so the sweep records it and the prompt
response's receipt owes that one lookup: the submission may have settled between the sweep and the receipt while its own
frame was the one the reconnect lost, and without the question the turn would stay on screen as a permanent pending
overlay. The receipt is only the trigger; the lookup is the same by-request-id question every other recovery asks. That
is a recovery seam for a lost response, a refresh or a reconnect; the normal path is the event stream described above,
whose `submission` frames are live and never replayed. The deleted `ux-submission-recovery` driver drove that loss
with a real held read, a held prompt response and a recovery lookup that comes back with nothing; the same statement
rules are asserted today by `apps/server/test/durable-submissions.test.ts` and `packages/ui/src/lib/lifecycle-projection.test.ts`.

The completion tone has exactly one owner: the `answered` notice the fold emits from a live terminal fact that carries
its answer identity. The acquisition generation has one owner too — the projection, which remembers the number it
accepted — so a conversation restored from page memory continues its sequence instead of numbering its own mount's read
and stream below the generation the store already held. The notice is keyed by the answer, so a steer group whose inputs share one answer sounds once, a
queued follow-up sounds once later, and split delivery of the same answer does not multiply the sound. An aborted,
failed or withdrawn turn settles as `unanswered` and shows the reason the runtime gave without ever sounding, and an
acquired baseline, a reconnect, a recovery lookup or a history read is silent by construction. A failed read is a
state, not an endless spinner: with no complete projection the view is `unread` and reports the transport issue, and
after a good projection the last view stays. See [ADR 0006](adr/0006-durable-submission-lifecycle.md), and the
[glossary](../GLOSSARY.md) for the terms.

## Background completion

A conversation the user is not looking at still finishes, and they are told — but only by a fact the runtime stated on a
stream that was open while the run was in flight. The decision behind it, and the limit it accepts, are recorded in
[ADR 0007](adr/0007-lifecycle-facts-one-projection.md). `packages/ui/src/lib/completion-delivery.ts` owns that: the page's one
registry of live settlements, and the watches that feed it. It is not a scheduler and not a second store — it holds
which conversations the live path has in hand, each one's place on the shared stream, and the answers already noticed,
and it folds the same live frames through the same pure projection the open conversation uses
(`packages/ui/src/lib/lifecycle-projection.ts`), so the notice rule is one rule in one place.

The registry is the page's, not a watch's: **every** live settlement goes through it, whichever surface observed the
fact. The open conversation's own surface folds its frames and reports the settlement it found, and the registry's answer
is whether that caller is the one that reports the completion — so a second reader of the same answer, a handover and a
duplicate frame all collapse to one tone, and a run that ended without answering is recorded as settled without ever
being sounded. A settlement recorded either way is what makes the conversation the live path's, and it is the only thing
the older absence-based path is allowed to defer to.

`@hepi/session/browser` serves **one source per conversation however many readers join it**. The
conversation on screen and a background interest in that same conversation are two readers of one stream, never two
streams: the first subscriber opens it, the last to leave closes it, and a subscription survives a reconnect, a failed
handshake and a dropped stream. Selecting a conversation is therefore a handover rather than a reconnection — the
connection object survives, ownership moves, and no notice is duplicated or lost in the transfer. The subscription the
open surface holds is a property of the conversation rather than of a render, so a reconnect is a deliberate act
(`reconnect()`) instead of a side effect of re-rendering.

Acquisition is the existing visible-tab poll's business and nothing else's. The 2500 ms poll keeps its cadence and its
one catalogue read, and it now only **nominates**: a conversation reported busy is one worth watching, and whether it
finished is the stream's own fact rather than the poll's absence. A nomination opens a watch, whose first state frame is
the atomic baseline every acquisition starts from, and it is also what puts the conversation in the live path's hands —
so the older path is silent for it whether the run was still in flight or had already ended when the baseline arrived.
A conversation with nothing outstanding gets no stream, and there is no catalogue-wide stream and no stream per idle
conversation.

**A quiet stream stays attached.** A conversation publishes nothing while it is quiet, and every hop between the
backend and the browser bounds how long a body may stay silent. The backend answers with a **comment frame** — an
event-stream line with no field name, carrying no event — on the cadence in `HEARTBEAT_INTERVAL_MS` (`packages/protocol`,
30 s), written on the connection that is attached and stopped when that connection ends. A deployment behind a hop with a
stricter idle bound states its own cadence in `HEPI_HEARTBEAT_MS`; `0` states no keepalive at all, which is what a
deployment with no idle bound in front of it should say rather than arming a timer for a bound that is not there. The Web proxy forwards the
frame exactly as it arrived, on the boundary it already found while reassembling chunks, and never writes one of its
own: it does not own a frame boundary, so a comment frame appended there could split a payload. The bound being
defended is a hop's **idle** bound; a per-call total-duration timeout is a different bound and is not a substitute.

Interest is work in flight and nothing else. `useAgentSession` **hands its own projection over**
(`onProjectionChange`), and the watch that keeps the conversation's stream continues from it: a live run, a staged
turn or an answer still expected is exactly the interest the stream is kept for, and the watch releases itself as soon
as its own frames say the work is over. The projection travels rather than a summary of it, and that is the whole point:
a watch told only "unfinished" folds its own frames into a projection that never saw the surface's turns, so the first
terminal fact it reads looks like the end of the work — which is how a queued follow-up placed after the first answer
used to lose its notice and its stream. A projection with *nothing* in flight opens nothing and keeps nothing. What the
owner last handed over is authoritative, a settled projection included — while the surface is on screen the watch folds
nothing, so that handover is its only way to learn the work is over — but a projection that has accepted no fact at all
is not: a remount that has not loaded yet says it does not know, not that the work is done, so it never takes an
interest away. A conversation the surface is merely showing is in hand the same way,
and its watch folds nothing — the surface owns those frames — so one conversation is never folded twice and one turn is
never asked about twice.

A notice requires a live terminal fact received after acquisition, and it is keyed by the answer
(`conversationId`, `answerId`), so a steer group is one notice, a queued follow-up is its own later one, and split
frames for the same answer are not several. `unanswered` never notifies as success. Silent by construction: an acquired
baseline whose submission is already terminal, a baseline acquired after the run ended, a gap, a reconnect, a
`resync_required` and a recovery lookup — the recovery repairs state and is not a success signal — and opening a
conversation with prior history.

Joining a conversation that still has work in flight is itself a reason to ask: a stream this page already holds
delivers no fresh `connected` event to a reader that joins it, so the turns a surface left staged are settled by their
own by-id record instead of lingering as an overlay nothing would remove. That recovery runs under the joining mount's
own acquisition, because a read that begins after it would fence its answers as older callbacks.

The absence-based background tone that predated this delivery is **gone**, and nothing else was left in its place: the
completion tone has one owner and one source, a live terminal fact that answered. The sidebar's poll still runs, still
reads one catalogue and still nominates — and it reports nothing to the shell, sounds nothing, and notifies nothing. So
an abort or a failure cannot ring, a completion cannot sound twice, and a run whose baseline arrived after it ended is
silent rather than a success.

The same fact is the only source of the page's system notification. `packages/ui/src/lib/browser-notifications.ts`
delivers one notice, and `AppShell` asks for it only for that answered fact while the page is not in the foreground —
another window has focus or the tab is hidden — because a page the user is watching already reports the turn in its
transcript and its tone. It is delivered through the Web host's service worker registration where one exists and through
the page's own `Notification` where it does not; a refused or unsupported notification is silence, never an error. No
other path raises one: a recovery lookup, a reconnect, an acquired baseline and a `resync_required` fold to no notice at
all, so a read that repairs state cannot manufacture a success the runtime never stated. There is no background push —
the Web Push prototype that asked `/api/push/*` was retired because this deployment serves no push backend, and
universal background delivery stays a non-goal; the App declares no notification capability of its own beyond what its
platform's WebView provides.

The unread marker does not come from that absence. It comes from the run's own end: the catalogue row states
`lastRunEndedAt`, read from the run's durable receipt and kept current from the backend's commit stream,
and the sidebar diffs it against what this window has already been told (`packages/ui/src/lib/run-marks.ts`). The poll's
`busy` edge could only ever report a run the page *saw* running, so a run that started and finished between two
polls left nothing behind at all; the receipt says it happened whether or not anyone watched. A window's first listing
is its baseline, so opening the page cannot turn every old run into news, and the conversation on screen and a
subagent's are never marked. A marker says a run ended — never how it ended, which is the transcript's and the
submission's business.

The limit is stated rather than patched, and it is about the *notice*: a run that starts and finishes entirely between
the poll and the acquisition — or while the tab is hidden, or while the watch was waiting for a connection — is never
observed live, so it produces **no audio notice**. Its marker it still gets, from the run's own end rather than from the
poll's absence. Universal notice catch-up is not bought: it would need a stream on every catalogued conversation
(rejected) or a bounded terminal summary on the catalogue row, which by construction collapses everything settled within
one poll interval into one notice and so cannot preserve one notice per answer group. The product guarantee is therefore
the honest one — **one notice per answer group for every run observed while an interest exists** — with the unread
marker as the fallback otherwise.

## The page's connection budget

The page is served over HTTP/1.1, where a browser allows **six connections per origin**, and every held stream is one of
them. A page that spends all six cannot send a prompt, renew its lease or read anything, so the count is budgeted rather
than left to the poll: one connection for the conversation on screen (the send handshake waits on it, so it is reserved
and never deferred), one for the page's terminal stream while a terminal tab is mounted, two for headroom, and the rest
for background watches — **three with no terminal mounted, two with one**. The arithmetic lives in
`packages/ui/src/lib/completion-delivery.ts` and is asserted by tests rather than assumed.

A watch the budget defers is **deferred, not dropped**: it keeps its projection, its nomination and its place, opens
nothing, and is admitted the moment a slot frees. There is no timer and no scheduler — acquisition is driven by the same
events that already release a watch. The cost is the limit above, reached by budget as well as by timing: a conversation
whose run ends while its watch is still waiting for a connection produces no tone, and its unread marker is what the
sidebar shows.
