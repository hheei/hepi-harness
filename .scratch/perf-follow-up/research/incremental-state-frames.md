# Incremental state frames for the conversation SSE (perf route 2)

Grounded on `integration/chat-lifecycle` `b9b28dd` — the intended base — and its deployed revision `cb4494b`.
`git diff --stat cb4494b b9b28dd` touches five files under `docs/` only, so every code fact below is the deployed one.
The root worktree is `impl/capability-11` `fa495b4`, an unrelated line that predates the chat-lifecycle rework: it has
no `projectionId` and no `lifecycle-projection.ts`, so it appears only where a sentence says "at fa495b4". Research
only: no code change, no production write, no restart, no paid call.

The route is perf lane B finding 2 (read-only, revision `cb4494b`,
`.dev/worktrees/perf-lane-b/.scratch/perf-b/REPORT.md`): "Every SSE state frame re-serializes the full snapshot, so
broadcast bandwidth scales linearly with transcript." Measured in-process, 60 turns: state bytes per turn
5,524 → 26,372 → 76,575 → 152,175, largest single frame 1,198 → 5,310 → 15,352 → 30,5xx, frames per turn flat at 5-6.
Its own fix-candidate line is "incremental/trimmed state frame instead of a full snapshot per SSE advance (needs a scope
decision — it changes the client contract)." Lane B finding 1 is the same payload over HTTP:
`GET /api/conversations/:id/state` measured at 197 → 4,778,866 B and an SSE initial snapshot of 4,711,896 B.

## 1. The current wire at b9b28dd

### 1.1 Server: two durable streams, one attachment identity, one full frame per advance

- `apps/server/src/server.ts:409-411` — `attachConversation` takes both native streams:
  `const view = await conversation.watch(BACKGROUND_CONTEXT)` and
  `const events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT)`. The doc comment at
  `server.ts:380-407` states the design: the view carries the committed structural state, `watchEvents()` carries the
  submission lifecycle, "The two streams publish through one snapshot".
- `apps/server/src/server.ts:29` — `ServerSnapshot` is `{ protocol, revision, conversationId, projectionId, run, busy,
  entries, partial, workspaceId?, toolNames, extensions, liveMessage?, liveTools, settings, queuedMessages, resources?,
  failure, submissions }`. `entries` is `readonly ServerEntry[]` and each `ServerEntry` carries the whole
  `message` (`server.ts:24`).
- `apps/server/src/server.ts:270` — `project(view, revision, projectionId, submissions, select)` rebuilds that whole
  object, including every committed entry's full `message`, on **every** publication.
- `apps/server/src/server.ts:447,453` — `let revision = 0` is this process's publication order, and
  `const projectionId = randomUUID()` is this attachment's opaque identity. The comment at `server.ts:449-452` is the
  contract: "Two attachments are two clocks even when they read the same store … deliberately not persisted, because a
  restarted backend is a new attachment whose revision means nothing against the old one's."
- `apps/server/src/server.ts:483-489` `publish()` sends `state` with the whole `current` to every client;
  `server.ts:500-503` `onAdvance()` bumps the revision and republishes; `server.ts:504` is
  `view.start(async (value) => { latestView = value; onAdvance(); })` — the watch listener's `(value, ops, context)`
  second argument, the per-commit Chord operations, is **discarded**. `server.ts:495-497` `announce()` sends the small
  live `submission` frame.
- `apps/server/src/server.ts:1405` — `GET /api/conversations/:id/state` answers `item.snapshot()`, the same complete
  object.
- `apps/server/src/server.ts:1531-1537` — `GET /api/conversations/:id/events` writes `event: snapshot` with the current
  snapshot, registers the response in `item.clients`, and emits `event: resync_required` only when an `?after=`
  revision is present and not exactly the current one. There is no replay buffer and no catch-up: `current` is the only
  retained state.
- `apps/server/src/server.ts:335-339` — `send()` destroys the response when `writableLength > 1024 * 1024`.

### 1.2 Web adapter: the frame is carried whole

- `apps/web/adapters/durable-api.ts:27` mirrors `ServerSnapshot` (with `projectionId`, `revision`, `run`), and
  `durable-api.ts:77-80` `sessionData()` forwards `projectionId`, `revision`, `run` and the submissions.
- `apps/web/adapters/durable-api.ts:670-703` `events()` proxies the backend stream: `submission` → `durable_submission`
  (`:693`), `resync_required` → `durable_resync` (`:697`), and `snapshot|state` → one
  `durable_state` carrying the whole frame (`:698,702`). It calls the backend with no `after`.
- `apps/web/components/AppShell.tsx:151` — the one source per conversation is
  `new EventSource("/api/agent/<id>/events")`, with no `after` and no `Last-Event-ID`. Only the terminal panel
  (`apps/web/components/TerminalPanel.tsx:125`) uses `after`.
- `apps/web/hooks/useAgentSession.ts:1418-1445` — `durable_state` folds the frame whole through
  `snapshotObservation(...)` and then replaces `data`, `messages`, `queuedMessages`, `liveTools`, `activeLeafId`;
  `useAgentSession.ts:1400-1405` answers `durable_resync` by asking about every unfinished turn.

### 1.3 The browser's ordering contract already names the baseline identity

- `apps/web/lib/lifecycle-projection.ts:50-58` — `Snapshot = { projectionId, revision, data, run, submissions }`;
  `State` keeps `identity: ProjectionId | null` and `revision` (`:153-158`).
- `apps/web/lib/lifecycle-projection.ts:380-405` `applySnapshot`: a different `projectionId` is "a different clock";
  only an SSE acquisition may rebase onto it, an HTTP read from another identity keeps the accepted view and asks for a
  fresh acquisition; within one identity `snapshot.revision <= state.revision` is ignored.
- `apps/web/lib/lifecycle-acquisition.ts:28,50-57,81` — the client stamps an acquisition generation when a read or a
  stream *begins*, and `LifecycleFrame` is `{ sessionId, projectionId, revision, run, submissions, context }`, the shape
  both transports carry.
- `apps/web/lib/completion-delivery.ts:99,186,212,219,269` — one source per conversation, poll nominations, reconnect.
- `apps/web/lib/agent-event-connection.ts:76,127,208,217` — `subscribe()` multiplexes readers onto one source per
  conversation, `openIfNeeded()` opens it, `discard()`/`scheduleRetry()` own the transport lifecycle.

## 2. Native pi-durable primitives that already carry deltas

### 2.1 `conversation.watch()` ships exact Chord operations per commit

- `pi-durable/README.md:291-302` (installed 1.1.0; `:393-404` in 1.2.0): "`watch()` delivers the same view with the
  exact Chord operations of each commit, one callback at a time", with the example `watch.start(async (value, ops) => {
  await send(ops); // for example to a remote client that applies them })`. Same section: "A slow watch keeps at most
  100 undelivered frames. After that, the pending frames are replaced by one frame holding the whole newest view. A
  client that joins late or reconnects starts from the current view; nothing is replayed."
- `pi-durable/dist/session/observation.js:3` `MAX_PENDING_WATCH_FRAMES = 100`, and `:209-213` — the replacement frame
  is `{ value: replacement, ops: [["r", replacement]] }`, a root replace.
- Op vocabulary: `@earendil-works/chord/dist/delta/index.d.ts` — `["r", value]` replaces the whole value,
  `["s", path, value]` set, `["d", path]` delete, `["a", path, string]` append, `["t", path, n]` front trim,
  `["p", path, start, deleteCount, items]` splice, `["m", path, permutation]` reorder. `WireOp` adds path interning
  (`["#", id, path]`), numeric path refs and omitted-path short forms; `encoder()/decoder()` convert.
- `WatchHandle.value` is "Acquisition revision before start; latest delivered immutable revision afterward"
  (`pi-durable/dist/types.d.ts`, `WatchHandle`), but that revision is the *value*: the watch exposes no sequence id.

### 2.2 `watchEvents()` ships message and tool deltas

- `pi-durable/dist/harness/events.d.ts:35-151` — `SnapshotEvent` (the fallback) and the `AgentEvent` union:
  `message_update { usage, changes: readonly MessageChange[] }` where `MessageChange` is `text_start`/`thinking_start`/
  `toolcall_start`/`text_delta`/`thinking_delta`/`toolcall_delta`/`block`/`message`; `tool_execution_update
  { output?: { trimStart?, append? } | { set } }`; `entry_appended` (`:127`), `inbox_update`, `agent_changed`,
  `usage_changed`, `submission`, run/turn/compaction events.
- The translation already exists in the library: `pi-durable/dist/harness/events.js:80` `translate()`, `:242`
  `messageChanges()`, `:287` `toolUpdate()`.
- `pi-durable/README.md:382`: "Events are derived from commits, one batch per commit, and apply on top of the snapshot.
  Message and tool updates carry deltas… When a consumer falls more than 100 batches behind, it receives a fresh
  `snapshot` event instead."
- `AgentEventStream` exposes `snapshot`, `start(listener)`, `stop()`, `closed` only
  (`events.d.ts:173-179`): **no seq/revision on the stream or the batch**. Unchanged in 1.2.0
  (CHANGELOG `## [1.2.0] - 2026-10-12`), which only adds event kinds.

### 2.3 The only durable sequence is `CommitPublication.seq`

- `pi-durable/dist/types.d.ts:678-681` — `CommitPublication = { readonly seq: Seq; readonly changes: … }` from
  `Session.subscribeCommits` (`:784`). `Seq` at `:25`: "Strictly increasing sequence assigned to one atomic storage
  commit; gaps are permitted." The server already uses this hook for the title and extension-selection documents
  (`server.ts:424`, and the `storedDefault` watch at `server.ts:768`).
- `Storage.commit()` returns the same `Seq` (`:814`); `Storage.entry()` returns `{ entry, commitSeq }` (`:824,829`).
  It is session-global, not per-conversation, and no `Seq` reaches the conversation wire today.

## 3. pi-web and the copied app: deltas it already applies

- `apps/web/lib/agent-event-wire.ts:151-176` projects pi-coding-agent's `message_update`/`assistantMessageEvent`
  (dropping the shared `partial` helper), and `apps/web/lib/streaming-message.ts:46-128` `applyDelta` applies
  `text_delta`/`thinking_delta`/`toolcall_delta`/`*_end` to a streaming message. That vocabulary is
  `@earendil-works/pi-coding-agent`'s `JsonAgentSessionEvent` (`dist/modes/json-event.d.ts:22`), not Chord.
- `apps/web/lib/agent-event-stream.ts` is the preserved pi-web SSE stream with coalescing and droppable-delta
  backpressure (`STREAM_HIGH_WATER_MARK_BYTES`, `DEFAULT_BACKLOG_LIMIT_BYTES`, `isDroppableEvent`), but it is **not**
  wired to the durable path: only `apps/web/vendor/pi-web` copies reference it, and nothing outside vendor imports it.
  The live hepi path is `adapters/durable-api.ts` `events()`.
- `apps/web` has no `@earendil-works/chord` dependency (only `apps/server`, `packages/client`, `packages/gateway` do),
  so applying Chord ops in the browser would be a new dependency, not a reuse.
- The copied pi-web surfaces already treat a `state` frame as authoritative and replace history
  (`useAgentSession.ts:1418-1445`), and the `submission` frame is the precedent for a small typed non-snapshot frame on
  the same SSE.

## 4. Findings

### 4.1 Does the upstream native event stream already provide deltas?

Yes, twice, and the hepi server discards both. `conversation.watch()` already computes exact Chord ops per commit and
its README explicitly suggests forwarding them to a remote client; `watchEvents()` already computes
`message_update.changes` and `tool_execution_update { trimStart, append }`. What is missing is a wire frame, a
baseline identity a client can name, and a client-side applier for the chosen vocabulary.

### 4.2 Safe delta baseline

- **Already on the wire:** the pair `(projectionId, revision)`. `revision` is a per-attachment counter that restarts
  with the process; `projectionId` names the attachment, so the pair is comparable only while it stays the same
  (`server.ts:447-453`, `docs/chat.md:5`). It is enough to say "this delta continues the frame I last applied from this
  attachment" and to reject anything from another attachment, which is exactly what
  `lifecycle-projection.ts:386-390` already enforces for snapshots.
- **Durable across restart:** `CommitPublication.seq`. It is strictly increasing and permits gaps, but it is
  session-global and reaches no conversation wire today; adopting it means plumbing `subscribeCommits` into
  `attachConversation` and deciding that a session-global counter is a per-conversation baseline.
- **Per-watch cursor:** internal to `CommittedWatch`; not exposed.
- **Entry id:** a natural append baseline for the transcript (ids are session-global and monotonic; the catalogue
  already reports `messageCount`), but it says nothing about the live partial, tool output, inbox, agent or usage.
- ADR 0007 already rejected one version of this: "A durable epoch or sequence for ordering. Rejected: the backend's
  revision is per attachment instance, and two instances are two clocks; an opaque per-attachment identity plus a
  client-assigned acquisition generation detects the same races without a stored counter or a migration"
  (`docs/adr/0007-lifecycle-facts-one-projection.md`). A delta *continuity* token is a different need from *ordering*,
  but the parent should decide explicitly whether reusing a durable seq reopens that decision.

### 4.3 Attachment identity

- Identity is `projectionId`; the client's own `Acquisition` generation is the fence
  (`lifecycle-acquisition.ts:28`). A delta frame would be a third observation kind beside `snapshot` and `lifecycle`
  (`lifecycle-projection.ts:117-126`) and would have to be fenced the same way, and a delta whose identity or revision
  the fold cannot continue must force a snapshot rather than be applied.
- The backend has no per-client identity: `item.clients` is a set of live responses
  (`server.ts:1537`). Per-client delta state would be new server state.

### 4.4 Snapshot fallback

Already three-layered and reusable:

1. `CommittedWatch` overflow replaces pending frames with a whole-view frame (`observation.js:209-213`).
2. `watchEvents` overflow replaces undelivered batches with a fresh `snapshot` event (`pi-durable/README.md:382`);
   the server detects that and re-reads the committed submission table (`server.ts:505-529`).
3. The SSE opens with `snapshot` and answers a mismatched `after` with `resync_required` (`server.ts:1534-1536`).

A delta frame must therefore never be the only thing a fresh connection gets, and any gap must still produce an
authoritative full frame. `packages/protocol/src/index.ts:125-130` already states the client rule for the small chat's
`events` frame (revision must be `+1` or `resync_required`), and `packages/session/src/index.ts:14-27` implements it
with a `stateSnapshot()` fallback.

### 4.5 Reconnect and lost-frame behaviour

- The backend retains no per-conversation history: `current` is the only snapshot and `item.clients` only holds live
  responses. A reconnect gets the current snapshot and nothing else; there is no replay.
- Lost frames are detectable only if the client asks. Neither `AppShell.tsx:151` nor
  `adapters/durable-api.ts:670` sends `after`, so `resync_required` cannot fire in production today; the browser relies
  on `durable_resync`, `connected`/`reconnect()` (`completion-delivery.ts:254-269`) and per-turn lookups
  (`useAgentSession.ts:1383-1405`). At fa495b4 the equivalent safety net was a periodic
  `AGENT_STATE_RECONCILE_MS` poll plus `submission-reconciliation.ts`; both are gone at b9b28dd, so a delta path has
  less slack than it looks.
- A slow SSE client is destroyed at 1 MiB queued (`server.ts:335-339`) and reconnects. A delta design must state what
  that reconnect gets: the only safe answer with no retention is a full snapshot, which means the delta path is a
  bandwidth optimization for a continuously-connected client, not a durability mechanism.

### 4.6 Payload compatibility

- What a delta must replace, per frame: `entries` (append-only, the dominant cost), `liveMessage`/`partial` (the whole
  partial message each time), `liveTools` (the whole slot list, output included), and the small scalars and lists
  (`settings`, `queuedMessages`, `run`, `busy`, `submissions`, `resources`, `failure`).
- Two producers already exist for the two expensive parts: Chord ops on the view (which cover `entries`, `pi.live`,
  `pi.agent`, `pi.inbox`, `pi.usage` in one stream) or `watchEvents`' agent events (message/tool deltas plus
  `entry_appended`). The server currently consumes both streams but publishes neither's deltas.
- The consumer is the browser, and the vocabulary matters: Chord ops need a new browser dependency, while
  `watchEvents`' `message_update.changes` is close to the `assistantMessageEvent` shape the copied app already applies
  (`streaming-message.ts:46-128`) but is still a different shape. A hepi-specific delta frame (the
  `packages/protocol` `events` precedent) avoids both.
- Lane C constrains the shape: one source per conversation with a subscriber list
  (`agent-event-connection.ts:76`), and the browser's HTTP/1.1 per-origin budget of six connections
  (`.dev/worktrees/perf-lane-c/.scratch/perf-c/FINDINGS.md`, `DESIGN-lane-c-sse-cap.md`). A delta frame must ride the
  existing stream, not add one.

## 5. Unresolved decisions

1. **Baseline token.** `(projectionId, revision)` as-is (no new state, resets with the attachment), a durable
   `CommitPublication.seq` plumbed onto the wire (survives restart, session-global, and touches ADR 0007's rejected
   option), or entry ids for the transcript plus full frames for the rest.
2. **Who names the baseline.** `?after=`/`Last-Event-ID` on connect (today no client sends either, so the
   `resync_required` path is unexercised in production), or a per-frame continuation token in the SSE payload.
3. **Delta vocabulary.** Chord `WireOp` passthrough (producer exists, browser needs Chord or an applier), a
   `watchEvents`-shaped frame, or a hepi frame modelled on `packages/protocol`'s `events` frame.
4. **What becomes incremental.** Entries plus partial plus tool output are the measured cost; the small fields can stay
   full. Whether `GET /api/conversations/:id/state` also gets a trimmed/incremental form is a separate scope question
   (lane B finding 1).
5. **Gap policy.** Whether a client behind the server's delta window gets `resync_required` or a whole snapshot, and
   whether the server keeps any per-client delta state at all (it keeps none today).
6. **ADR 0007 and docs.** ADR 0007's ordering decision, `docs/architecture.md:9,24-26` ("Production conversation SSE
   currently sends full replacement projections, not deltas"; "neither introduces a delta path over the wire"),
   `docs/chat.md:5,7` ("Full replacements tolerate missed publications without delta replay"), and ADR 0006's "No delta
   path is introduced" all assert the current contract.
7. **Tests that encode it.** `apps/server/test/server.test.ts:92` (resync on a stale `after`),
   `apps/server/test/browser-session.test.ts:27-37` (monotonic revisions, reconnect sees the same entries),
   `apps/web/lib/lifecycle-projection.test.mjs:106` (an older revision never regresses),
   `apps/web/adapters/durable-lifecycle.test.mjs:32,111` (projectionId across both transports).
8. **Upstream pin.** `apps/server/package.json:25` pins `@earendil-works/pi-durable` `1.1.0`; `1.2.0` exists and does
   not add a seq to `AgentEventStream`, so upgrading alone supplies no durable baseline.

## 6. Evidence index

Server: `apps/server/src/server.ts` 24, 29, 270, 335-339, 380-411, 424, 447-453, 483-489, 495-503, 504-505, 505-529, 768,
837, 1405, 1531-1537; `apps/server/package.json:25`.
Web: `apps/web/adapters/durable-api.ts` 22, 27, 77-80, 94, 142, 670-703; `apps/web/hooks/useAgentSession.ts`
1383-1405, 1418-1445; `apps/web/components/AppShell.tsx` 151, 226-228; `apps/web/components/TerminalPanel.tsx:125`;
`apps/web/lib/lifecycle-projection.ts` 50-58, 117-126, 153-158, 364-405, 411; `apps/web/lib/lifecycle-acquisition.ts`
28, 50-57, 81; `apps/web/lib/completion-delivery.ts` 99, 186, 212, 219, 269; `apps/web/lib/agent-event-connection.ts`
76, 127, 208, 217; `apps/web/lib/agent-event-wire.ts` 151-176; `apps/web/lib/streaming-message.ts` 46-128;
`apps/web/lib/agent-event-stream.ts`; `apps/web/lib/run-marks.ts` 25, 60.
Protocol/session: `packages/protocol/src/index.ts` 105-130, 144-182; `packages/session/src/index.ts` 14-27.
Native pi-durable (installed 1.1.0): `pi-durable/README.md` 291-304, 370-383; `pi-durable/dist/types.d.ts` 25,
678-681, 748-763, 784, 814, 824-829; `pi-durable/dist/harness/events.d.ts` 35-151, 173-179;
`pi-durable/dist/harness/events.js` 80, 242, 287; `pi-durable/dist/session/observation.js` 3, 209-213;
`@earendil-works/chord/dist/delta/index.d.ts`; `@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts` 22.
Upstream 1.2.0 (read-only `npm pack`): CHANGELOG `## [1.2.0] - 2026-10-12`; `dist/harness/events.d.ts` 173-179.
Docs and lane records: `docs/architecture.md` 9, 24-26; `docs/chat.md` 5, 7;
`docs/adr/0007-lifecycle-facts-one-projection.md`; `docs/adr/0006-durable-submission-lifecycle.md`;
`.dev/worktrees/perf-lane-b/.scratch/perf-b/REPORT.md` (findings 1 and 2);
`.dev/worktrees/perf-lane-c/.scratch/perf-c/FINDINGS.md` and `DESIGN-lane-c-sse-cap.md`;
`.dev/worktrees/perf-lane-c/.scratch/perf-c-sse-budget/spec.md`;
`.dev/worktrees/chat-lifecycle-integration/.scratch/perf-a/evidence.md` (deployed-revision check).
Tests: `apps/server/test/server.test.ts:92`; `apps/server/test/browser-session.test.ts:27-37`;
`apps/web/lib/lifecycle-projection.test.mjs:106`; `apps/web/adapters/durable-lifecycle.test.mjs:32,111`.

## 7. Public projection seam: what a delta frame may carry

### 7.1 The redaction boundary is exactly `safeEntry`

- `apps/server/src/server.ts:207-213` `safeEntry(message)` is the only value-level redaction in the whole wire path: for an
  assistant message it replaces `errorMessage` with `SAFE_CREDENTIAL_ERROR` when `isCredentialFailure` holds and an
  unregistered `api` with `SAFE_API` (`"unknown"`, `server.ts:200-204`). Everything else passes through unchanged.
- `server.ts:216-220` `safeFailure` is the same rule for `failure.message`; `SAFE_CREDENTIAL_ERROR` is shared.
- `server.ts:270-286` `project` is the only place a public `ServerEntry` is built: it keeps entries whose `model[0]` role is
  `user`/`assistant`/`toolResult` (dropping display/bookkeeping entries), and for each emits
  `{ id: String(entry.id), role, text: contentText(message.content), message: safeEntry(message) }`. Every other snapshot
  field is read from `view.docs["pi.live"|"pi.agent"|"pi.inbox"]` scalars, `select(agent.extensions)`, and the submissions list.
- So `ServerEntry` is a pure function of one `EntryRecord` plus two module constants. `project`'s O(transcript) cost is
  *entirely* the `for (const entry of view.entries)` loop; the remaining fields are O(1)/O(tools)/O(inbox). "Publish deltas"
  therefore means exactly "stop re-running that loop", not "diff two projected arrays".

### 7.2 Exact native view ops (`view.js`)

`advance()` at `pi-durable/dist/harness/view.js:118-176` derives one frame's ops from one publication:

- appended entry: `["p", ["entries"], entries.length, 0, [entryRecord]]` (`:128`)
- head marker (reset/handoff or compaction): `["p", ["entries"], 0, kept, [entryRecord]]` (`:137`), where `kept` is the
  index of the first non-head entry with `id >= target` (`:134`) — a **front truncation**, not an append
- documents: `["s", ["docs", kind], value]` when the incarnation id or version changed, otherwise the commit's own ops
  rewritten under the prefix by `prefixed()` (`:177-193`, `r`→`s`, plus `a`/`t`/`p`/`m`/`s`/`d`)
- mounted kinds only: `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage` (`view.js:14-20`); `pi.workspace` and
  `pi.title` are hepi documents read through `snapshot()` elsewhere
- values are raw: an `EntryRecord` (with `edits`, `byTaskId`, `data`) and raw `pi.live`/`pi.agent` documents, which hold
  the unredacted partial message and the configured api id

Forwarding these ops to a browser is therefore not a small step: it would carry the raw record shape, the raw partial,
and the very values `safeEntry` exists to remove. **Chord passthrough is rejected as a wire format**; it remains usable
*inside* the server as a change signal.

### 7.3 The native delta producer that is already close

`watchEvents` (`dist/harness/events.js`) already emits, per commit, `entry_appended{entry}`, `message_start{message}`,
`message_end{entry}`, `message_update{usage, changes}` where `changes` are `text_delta`/`thinking_delta`/`toolcall_delta`/
`block`/`message` (`messageChanges`, `:242`), `tool_execution_start/update/end` with `output {trimStart, append} | {set}`
(`toolUpdate`, `:287`), `inbox_update{items}`, `agent_changed{agent}`, `usage_changed`, `submission{record}`, and the
run/turn/compaction/task events.

Its cost is O(commit), not O(transcript): `translate` (`:80-235`) reads `publication.changes` filtered to this
conversation, uses `viewOps` for the message and tool deltas, and scans only this batch's entries for tool ends. It never
re-derives history.

Two caveats. `snapshotOf(view)` (`:14-30`) embeds the whole `entries` array and the full `pi.live`, so both the initial
snapshot and the overflow fallback are raw and unbounded — the adapter must project them, which is today's `project`. And
the stream carries no sequence or revision (`AgentEventStream` exposes `snapshot`/`start`/`stop`/`closed` only), so it
cannot name a baseline by itself.

### 7.4 Smallest adapter: keep `project`, change when it runs

Recommended shape — one projection function, invoked once per entry:

1. **At attachment** run `project(view, revision, projectionId, submissions, select)` once, exactly as today, and keep the
   result as the full frame for the initial `snapshot` event and for every `resync_required` answer.
2. **Per advance** build the next `ServerSnapshot` from the previous one rather than from `view.entries`:
   - appended entries: for each new `EntryRecord` in the view's `entries` tail, insert
     `{ id, role, text, message: safeEntry(message) }` — the same expression `project` uses at `server.ts:275`, factored into
     a `projectEntry(entry)` helper so the two call sites cannot drift;
   - head marker: drop cached projected entries with `id < marker.head`, mirroring `view.js:134-137`;
   - scalars: re-read `pi.live`/`pi.agent`/`pi.inbox` exactly as `project` does — O(1);
   - `partial`/`liveMessage`: `safeEntry(live.generation.message)` then `contentText` — O(partial), not O(transcript);
   - `liveTools`: `live.tools ?? []` — O(tools).
3. **Cache identity** is the projected entry keyed by `entry.id` in a map that only grows; the redaction runs once, at
   insert, and is never recomputed. A head marker invalidates a prefix, in O(removed).

This is the hepi-side equivalent of the native `readContextFrom`/`ContextRange` reuse
(`dist/harness/context.js:30-60`, "with the same head marker, only entries after its tail are scanned"), whose head-marker
key is the right model but which pi-durable does not export (`dist/index.d.ts` has no `readContext`/`readContextFrom`/
`activeEntries`/`captureContextBounds`). Reimplementing the two-key rule in `project` costs a few lines and needs no
upstream change; asking upstream to export the range type is the alternative if a second consumer appears.

Consuming `watchEvents` instead would add a MessageChange applier in the server (and one more ordering source) while
still needing `project` for the public shape, and its overflow still hands back a raw full snapshot. The view-driven
variant is strictly less code: the view stream is already held (`latestView`), and the live partial can be read from the
document instead of reconstructed from deltas.

### 7.5 Dual-stream ordering, and where the delta is allowed to come from

`server.ts:499-505`: `view.start(...)` and `events.start(...)` both call `onAdvance()`, each advancing the single
`revision` counter once, so one commit that touches both streams publishes two frames (the comment states this is
deliberate: no two states share a revision and no publication is lost). `publish()` (`:483-492`) then re-reads
`resources` and `failure` from storage on every advance.

Consequences for a delta frame:

- entry deltas can only come from the **view** callback, because the view is what holds `entries`; the event stream
  contributes submissions and lifecycle only, and its advances can publish a scalar-only frame with `entries` unchanged.
- `resources`/`failure` are re-read per publication anyway (`readResources`, `settledFailure`, `:478-492`), so carrying
  them whole in every frame adds no read cost; they are the small fields.
- a delta frame is only valid against the frame the client last applied from the same attachment. The browser already
  enforces that rule for snapshots (`lifecycle-projection.ts:380-405`: different `projectionId` is a different clock, an
  equal-or-older `revision` within one identity is ignored), and `lifecycle-acquisition.ts:28` stamps the acquisition
  generation that fences late reads. A delta frame must be folded through the same fence and must fall back to a full
  snapshot on any identity or baseline mismatch — there is no cross-attachment baseline anywhere in the native layer.
- what must not change: `projectionId` stays minted per attachment (`server.ts:453`), `revision` stays the attachment's own
  counter, and every complete frame keeps carrying both.

### 7.6 Extra hepi producers the view does not contain

These are assembled in `attachConversation`/`publish`, outside `project`, and must be preserved by any delta design:
`resources` (`readResources`/`readEffectiveResources`+`resourceSummary`, `workspace-resources.ts`), `failure`
(`readRunFailure`, `server.ts:311-327`, only the framework's `no_model`), `settings` (`pi.agent`),
`toolNames`/`extensions` (`reportedSelection(installed, stored)`, `extension-selection.ts`), `submissions` (the pending map
seeded by `readPendingSubmissions` and updated by `submission` events), `workspaceId` (an attachment option), and the
catalogue-only `title`/`deletedAt`/`lastRunEndedAt` (`server.ts:424`, `:768`). None of them scale with the transcript.

### 7.7 Wire-shape options (for the parent to choose)

1. **Full snapshot per advance** — today; O(transcript) bytes and CPU per tick.
2. **Snapshot + append-only entries delta** — `{ protocol, projectionId, revision, baseRevision, appended: ServerEntry[], …scalars }`,
   with the client requiring `baseRevision` to equal its current revision and otherwise asking for a snapshot. No new
   vocabulary, no browser dependency, and the browser's existing fold already replaces `data`; an appended frame would
   extend `entries` instead. This is the smallest change that removes the O(transcript) term.
3. **Chord `WireOp` passthrough** — rejected (`§7.2`): leaks the redaction seam and the raw record shape, and `apps/web`
   has no `@earendil-works/chord` dependency.
4. **`watchEvents`-shaped frames** — needs a MessageChange applier in the browser and a second ordering source; only worth
   it if the client also wants coding-agent event semantics (which `packages/session`'s small chat already models).

## 8. Initial load and reconnect: bounded history in the same effort

### 8.1 Native history reads that already exist (upstream-first)

- `Conversation.entries(query, limit, cursor, context)` (`pi-durable/dist/harness/types.d.ts:488`): "Fork-aware history of
  this conversation, newest first unless `query.order` is `ascending`". `EntryQuery` is
  `{ minEntryId?, maxEntryId?, order? }` with **inclusive ID bounds** (`pi-durable/dist/types.d.ts:558-566`), and the answer
  is `Page<EntryRecord, Cursor>` with `next`. `apps/server/src/session-search.ts:118` already pages with it
  (`ENTRY_PAGE = 200` plus a cursor loop), so the backend primitive is in use today.
- `Tx.scanEntries` (`pi-durable/dist/types.d.ts:693`) and `Tx.latestHeadMarker(conversationId)` (`:695`) are the
  transaction forms; `Storage.scanEntries` (`:839`) and `Storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId)`
  (`:835`) are the storage forms, and `Storage.entry(conversationId, id)` is a visibility-checked single read.
- `Conversation.context(context, { at })` (`pi-durable/dist/harness/types.d.ts:484-487`): "the context as of that visible
  entry: the same view `fork(at)` would start with, without creating a conversation" — an as-of read exists, so a
  windowed read has a framework-sanctioned definition.
- `ConversationView.entries` is already head-marker-bounded: `#build` (`view.js:99-116`) uses `captureContextBounds` +
  `activeEntries`. A conversation that never compacted or reset therefore still holds its whole history in the view, which
  is what lane B measured.
- The incremental range cache (`captureContextBounds`, `deriveContext`, `readContextFrom`, `activeEntries`, `ContextRange`,
  `SCAN_PAGE_SIZE = 256`) is **not exported** by `pi-durable/dist/index.d.ts`. Its two-key rule (head marker id + tail;
  same head marker ⇒ scan only entries after the previous tail) is the design to copy, not to import.

### 8.2 What the framework already settles, and what the copied app already settles

Framework-settled — do not redesign these:

- `reset()`/`handoff` and compaction start a new context through a head marker, and "older entries stay in storage"
  (`pi-durable/README.md:325-345`). History is retained and addressable; only the *active context* is bounded.
- Fork "sees its parent's entries up to `entryId` and continues independently" (`README.md:405-412`), and
  `Conversation.fork(at)` takes a visible entry id — so a windowed client can fork from an entry it has not loaded.
- Live state is separate from history by construction: `pi.live` (partial, tools, run, retry, deferred, compactions),
  `pi.inbox`, `pi.usage`, `pi.agent`, `pi.provider` (`README.md:276-290`), and `ServerSnapshot` mirrors that split with
  `liveMessage`/`liveTools`/`queuedMessages`/`settings` beside `entries`.
- Entry reads are paginated, ID-ordered and fork-aware; a page's continuation is a `Cursor`, not an offset.
- A watch or event stream never replays: "A client that joins late or reconnects starts from the current view; nothing is
  replayed" (`README.md:299-302`).

Copied-app-settled — reuse rather than reinvent:

- `tail` semantics with a raw-entry ceiling and a definition of what counts: `sliceActiveBranch` and
  `countsTowardTail` count only user/assistant/compaction entries, `MIN_RAW_WINDOW_ENTRIES = 200`,
  `rawWindowCap = max(200, tail * 6)`, with the stated reason "counting raw entries starves user messages out of the
  window in agent-heavy sessions" (`apps/web/vendor/pi-web/lib/session-reader.ts:679-760`).
- `before` = the oldest id already loaded, with `excludeLeaf` so prepending a page cannot duplicate it
  (`session-reader.ts:674, 746-756`); `hasMore = Boolean(tail && sliced[0]?.parentId)` (`:690`).
- Payload shaping: `deferThinking` and `deferMedia`/`deferToolResultImages` (`session-reader.ts:671, 867`), and
  `tree=summary` producing `treeFormat: "summary"` (`apps/web/vendor/pi-web/app/api/sessions/[id]/route.ts:64-68, 142-159`).
- Client paging UI: `VISIBLE_PAGE_SIZE = 50` and the render window (`apps/web/lib/chat-lazy-load.ts:1-13`), the
  IntersectionObserver sentinel on the top sentinel div with prepend + scroll anchoring
  (`apps/web/components/ChatWindow.tsx:652-696`), the search target's "one extra page of 200"
  (`ChatWindow.tsx:614-628`), and the minimap's `onRevealHistory` window growth (`ChatWindow.tsx:805-807, 1338-1343`).
- Transcript grouping: tool results are attached to their calls through `activeToolResults` plus a `toolResultsMap` built
  from the message list (`ChatWindow.tsx:783-792`), so a window boundary can split a call from its result — the window
  should be chosen on message boundaries, not raw entries.

### 8.3 What the durable path actually does today (the gap)

- `apps/web/adapters/durable-api.ts:427`: `GET /api/sessions/:id/context` answers `context(current)`, and `context()`
  (`:68-70`) maps **every** entry and hardcodes `hasMore: false`. `GET /api/sessions/:id` (`parts.length === 2`) answers
  `sessionData(current)` with the same full `entries`.
- The query flags are ignored: `tail`, `before`, `leafId`, `deferThinking`, `deferMedia`, `tree=summary`, `force` are never
  read. `durable-api.ts` touches `searchParams` only for `q`, `requestId`, `defaultFolderId` and `cwd`
  (`:365, 457, 560, 575, 618`).
- Consequence 1 — the paging UI is inert: `loadContext` sends `before`/`tail`, gets the whole history back, and
  `hasMore` is always false, so the sentinel never fires and the search path's extra page cannot reach older history.
- Consequence 2 — the paged prefix is dead: `prefixApplies` (`useAgentSession.ts:669-672`) requires the prefix not to
  overlap the projection window, and the "window" is the whole transcript, so the prefix is always dropped.
- Consequence 3 — the view cache never fills: `setSessionViewSnapshot` requires `snapshotRevision`
  (`apps/web/lib/session-view-cache.ts:91-93`) and `durable-api` never emits `snapshotRevision`, `treeFormat` or
  `wrapperRebuilt`. So `revisionUnchanged` (`useAgentSession.ts:766-771`) is always false, `setHistory(null)` runs on every
  read, and switching back re-downloads the transcript.
- Consequence 4 — the reads themselves are unbounded: `GET /api/conversations/:id/state` (`server.ts:1405`) and the SSE
  `snapshot` frame carry the same full object (lane B finding 1: 4.7 MB at 60 turns).
- Consequence 5 — `tree` is `[]` and `leafId` is the last entry (`durable-api.ts:80`), so the branch navigator and the
  minimap's branch features have no data on this path.

### 8.4 Recommended shape (upstream-first, reusing the existing interfaces)

1. **Bound the initial frame.** Give `project` a tail window (upstream's rule: count user/assistant/compaction, cap raw
   entries at `max(200, tail * 6)`) and return `entries` as that window plus `oldestEntryId` and `hasMore`. Keep the field
   names the client already maps, so `context()` and the existing paging UI need no interface change. The same bound
   applies to the SSE `snapshot` frame and to `GET /state`, which are the same object today.
2. **Serve older pages from the native primitive.** `before` → `conversation.entries({ maxEntryId: before, order: "descending" }, tail, undefined, BACKGROUND_CONTEXT)`
   (inclusive bounds, so exclude `before` itself to match upstream's `excludeLeaf`), projected through the same
   `projectEntry` helper so a paged entry and a streamed entry cannot differ.
3. **Add `snapshotRevision`, independent of the acquisition identity.** It must be a value that says "the server's view of
   this history is unchanged" — for example the newest visible entry id plus the visible count, or the
   `CommitPublication.seq` captured at attach. It must **not** be `revision` (per-attachment counter) and must not be
   `projectionId`. The lifecycle fence stays exactly as it is: `projectionId` + `revision` for ordering and identity,
   `snapshotRevision` only for "may I keep the paged prefix".
4. **Preserve the loaded prefix across a reconnect with overlap.** Today `prefixApplies` only tests for *no* overlap, which
   is safe but discards the prefix as soon as the fresh window overlaps it. The rule to implement is: keep the prefix while
   it strictly precedes the window; on overlap, truncate the prefix at the overlap boundary by comparing ids (not
   lengths); on a `projectionId` change or a `snapshotRevision` change, drop it. The existing
   `history.entryIds`/`entryIds` split (`useAgentSession.ts:668-680`) is already the right structure.
5. **Keep fork, search and minimap working by id, not by loaded window.** Fork already takes `entryId` and the backend
   resolves visibility, so an unloaded entry can be forked from. Search already returns `entryId` + `blockIndex`
   (`apps/server/src/session-search.ts:97-103`) and the client already loads one extra page; with real paging that path
   works, and deeper hits can open the session at the id. The minimap can request the next page instead of only growing
   `visibleCount`.
6. **Do not add a second stream or a per-client window cache.** Lane C's budget is about the browser's six HTTP/1.1
   connections; paging is ordinary `GET`s on the existing routes.

### 8.5 Genuinely unresolved (needs the parent, not the framework)

1. **Window unit.** Upstream counts visible messages (user/assistant/compaction) and deliberately does not let a tool-heavy
   turn starve the window. `project` emits one `ServerEntry` per raw entry carrying a `model`, including tool results, so
   hepi must either replicate `countsTowardTail` or accept a tool-heavy turn filling the window. This changes what the
   user sees on first load.
2. **Whether `GET /state` and the SSE initial frame stay "the whole truth"** (lane B finding 1) or become windowed too.
   Today they are the same object, and `resync_required` answers from it.
3. **Where the paged prefix lives.** Browser-only today; a server-side per-conversation window cache would be new server
   state and a new invalidation problem.
4. **What `snapshotRevision` is made of, and whether it must survive a backend restart** for the view cache to be useful
   across a deploy. A per-attachment value would make the cache useless after every restart.
5. **`deferThinking` / `deferMedia` on the durable path.** Thinking is part of the entry's message here, not a separate
   payload, so upstream's deferral has no direct equivalent; whether to invent one is a UI decision, not a framework one.
6. **What a reconnect with a stale prefix gets:** the new tail plus a truncation, or a full snapshot. Both are correct;
   only one is cheap.
7. **Whether upstream should export the context range.** `readContextFrom`'s two-key reuse is exactly what hepi needs on
   both axes (projected entry cache and history paging), but it is internal. Copying the rule is cheap; asking for an
   export is a compatibility question for the parent.

## 9. Additional evidence (sections 7-8)

Native pi-durable: `dist/harness/view.js` 14-20, 99-116, 118-176 (`:128`, `:134`, `:137`), 177-193;
`dist/harness/events.js` 6-30, 80-235, 242-285, 287-310; `dist/harness/context.js` 2, 10-27, 30-60, 72-95, 155-175;
`dist/harness/context.d.ts` (`ContextBounds`, `ContextRange`, `readContextFrom`, `activeEntries`);
`dist/harness/types.d.ts` 484-488; `dist/types.d.ts` 558-566, 686-700, 810-845; `dist/index.d.ts` (no context exports);
`README.md` 276-302, 325-345, 368-383, 405-412.
Server: `apps/server/src/server.ts` 200-220, 270-286, 311-327, 424, 453, 478-492, 499-505, 768, 1405;
`apps/server/src/session-search.ts` 1-20, 97-103, 118; `apps/server/src/workspace-resources.ts` (`readEffectiveResources`,
`resourceSummary`); `apps/server/src/extension-selection.ts` (`reportedSelection`).
Web adapter and hook: `apps/web/adapters/durable-api.ts` 68-70, 80, 365, 427, 457, 560, 575, 618;
`apps/web/hooks/useAgentSession.ts` 87, 404, 668-680, 740-810, 854-895, 2595-2610;
`apps/web/lib/session-view-cache.ts` 11-40, 77-105.
Copied app: `apps/web/lib/chat-lazy-load.ts` 1-13; `apps/web/components/ChatWindow.tsx` 489, 555-576, 592-628, 652-696,
783-792, 805-807, 1266, 1338-1343; `apps/web/components/ChatMinimap.tsx` 16, 245-279;
`apps/web/vendor/pi-web/lib/session-reader.ts` 674, 679-760, 867;
`apps/web/vendor/pi-web/app/api/sessions/[id]/context/route.ts` 12-40;
`apps/web/vendor/pi-web/app/api/sessions/[id]/route.ts` 64-68, 142-159.
