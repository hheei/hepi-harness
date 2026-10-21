# Design memo — bounded history, incremental state frames, and history paging

Status: **design, not a spec**. No code changed. Coherent and ready to fold into the unified spec. No user-facing
question is left: the head-marker question (§11) is resolved native-first — the preserved upstream framework's rule
wins.

Scope items covered: **2 (incremental state frames)** and **3 (initial and reconnect large-history loading)** of
[`decisions.md`](decisions.md) §2. Items 1 (SSE connection budget) and 4 (SSH reuse) are out of this memo.

Grounding revision: `integration/chat-lifecycle` `b9b28dd`; deployed `cb4494b`. The two differ only in documentation
(`decisions.md` §1), so every code citation below holds for both. Native citations are the installed
`@earendil-works/pi-durable` **1.1.0**; 1.2.0 was checked and adds no `seq` to `AgentEventStream`, so the pin does not
change any decision here.

Decision hierarchy applied: durable path first, pi-web / preserved upstream second, user-only question last
(`decisions.md` §3).

---

## 1. Decisions taken here

These are engineering decisions with a primary-source basis. Each is reversible only by re-deciding it, so they are
stated as choices, not as options.

| # | Decision | Basis |
| --- | --- | --- |
| D1 | The baseline read is **bounded**: the newest window, not the transcript. One object serves `GET /state`, the SSE `snapshot` frame, and every normal consumer. | lane B finding 1 (4.7 MB at 197 turns) |
| D2 | The window is counted in **visible messages** with upstream's rule (user, assistant, compaction), with a **raw-entry cap** as the guard. | `session-reader.ts:679-760` |
| D3 | One frame has a **512 KiB soft target** after deferral; the window shrinks from the oldest end, whole entries only. The **newest entry** and the **live partial** are the only exceptions, and the transport guard is never crossed: deferral first, then a named error (`frame_too_large`) or `partialDeferred` — never truncation, never a destroyed socket. | §2.3, §7 |
| D4 | Older history is served by **entry-id pages** on a native scan, not by a larger baseline. | `Conversation.entries` (`harness/types.d.ts:488`), `EntryQuery` (`dist/types.d.ts:558-566`) |
| D5 | The history token is **derived from native immutable facts** (conversation, head marker, tail) through the **public** view/`Tx` surface only. No stored epoch, no hash of the transcript, no new durable record, no private import. | §3.2 |
| D6 | The per-attachment `projectionId`/`revision` pair keeps its meaning; the history token is **separate from both**. | ADR 0007; `server.ts:447-453` |
| D7 | Entry deltas are **append-only within one attachment**, base = the previous revision. A head-marker change is a **re-baseline**, never a delta. | `view.js:128,134-137`; `protocol/src/index.ts:120-182` |
| D8 | A gap is answered by **a fresh bounded snapshot**, never by replay; outstanding turns settle **by request id**. | `README.md:299-302`; `durable-api.ts:457-458` |
| D9 | Paged-prefix validity depends on **history facts only** — never on the attachment identity — and a moved head marker **drops** it (upstream's rule; Q1 resolved, §11). | §5.1 |
| D10 | The browser's paging contract is **unchanged**; the adapter translates it onto the native paged read. | `durable-api.ts:427`; `useAgentSession.ts:854-895` |
| D11 | The frame target is **soft with two named exceptions** (newest entry, live partial). Deferral is the first resort and is unconditional in history, including **dropping `thinkingSignature`** — the one field that makes a real deployed entry exceed the guard on its own. Nothing asserts a hard byte ceiling; the benchmark asserts **flatness** and the exception paths. | §2.3, §7, §10 |

---

## 2. The window contract

### 2.1 Count rule

Reuse the copied app's rule verbatim, because it exists for a measured reason: "counting raw entries starves user
messages out of the window in agent-heavy sessions" (`apps/web/lib/session-reader.ts:679-760`).

- A window of **50 visible messages** (`VISIBLE_PAGE_SIZE = 50`, `apps/web/lib/chat-lazy-load.ts:1`) — the same number
  the render window already uses, so a first load renders in one page with no second fetch.
- **Visible** = user, assistant, and compaction entries (`countsTowardTail`). Tool results, bookkeeping and metadata
  entries do not consume the window.
- **Raw cap** = `max(200, 6 * visible)` = **300 raw entries** (`MIN_RAW_WINDOW_ENTRIES = 200`,
  `rawWindowCap = max(200, tail * 6)`). The cap is what keeps a 300-tool-call turn from pulling an unbounded number of
  raw entries into one frame while still counting as few visible messages.

Both numbers are server-side constants, not wire fields. The client never names them; it reads `hasMore`.

### 2.2 What `hasMore` and `oldestEntryId` mean

- `oldestEntryId` = the window's oldest **projected** entry id. The client already derives this from
  `entries[0].id` (`durable-api.ts:69`), so the wire needs no new field.
- `hasMore` = there is at least one active entry older than the window. Computed as "the window's oldest projected
  entry id is not the active range's oldest non-head entry" — one comparison against the view the server already holds,
  not a scan.
- The client already consumes both (`context().hasMore`, `context().oldestEntryId`, `durable-api.ts:68-70`); today
  `hasMore` is hardcoded `false`.

### 2.3 Byte budget

One frame target: **512 KiB, soft, with two named exceptions** — the same order as the browser stream's existing
high-water mark (`STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024`, `apps/web/lib/agent-event-stream.ts`, vendored pi-web code
and not on this path, so the constant is new here and mirrors it). The **only hard bound is the existing transport
guard**: `send()` destroys a connection above 1 MiB writable length (`server.ts:337`) and this design does not move it.
It is also why "destroy the socket" must never be the answer to a large frame: the client reconnects, gets the same
frame, and loops.

The target is a **target**, and the exceptions are named rather than implied: the **newest entry** (an entry is never
split) and the **live partial** (`liveMessage`/`partial`). Everything else is bounded by construction. Measured on the
three largest deployed conversations (existing lane B artifacts, `perf-b-state-{197,249,655}.json`, read-only):

| conversation | active entries | 50-visible window, raw | after deferral | 300-raw window, raw | after deferral |
| --- | --- | --- | --- | --- | --- |
| 197 | 609 | 207 KiB | **190 KiB** | 1,587 KiB | 723 KiB |
| 249 | 552 | 189 KiB | **157 KiB** | 1,901 KiB | 1,161 KiB |
| 655 | 298 | 336 KiB | **211 KiB** | 2,070 KiB | 893 KiB |

The per-entry distribution matters more than the totals: p50 2.9 KiB, p90 24 KiB, p99 62 KiB, and the single largest
entry in all three is **1.08 MiB** — larger than the transport guard on its own. It is an assistant entry whose thinking
block is 427 KiB and whose `thinkingSignature` is 501 KiB. Deferring thinking without the signature leaves that entry at
**1.0 KiB**; the signature is an opaque provider-continuity payload that the client never renders and never sends back
(provider context is built from the native view, never from a projected entry), so it is not carried in a history frame
and the read block returns the thinking text. This is the case that makes the ordering below load-bearing rather than
defensive.

The order of application, which is the decision:

1. **Defer** heavy content inside every history entry (§7): tool-result images to a URL read block, thinking to a
   preview, the signature dropped. Unconditional in history, lossless, and the first resort — after it, the largest
   in-window entry of the three conversations is 13.8 KiB and a 300-raw window is 723 KiB-1.16 MiB.
2. **Shrink** the window from the **oldest** end, whole entries only, until the frame is at or below the target. The
   window may shrink below 50 visible messages.
3. **Never** split an entry, never drop the newest entry, never shorten the live partial.

What is left over is stated rather than hidden. A **text** tool result has no read block (upstream included, §7.2 item
4), so a newest entry carrying a multi-megabyte text output ships whole. The frame is still bounded in practice: the
window shrinks until only that entry remains, and one such entry fits the guard. If even that frame cannot be carried,
the outcome is **actionable, never a loop and never a lie**:

- an **HTTP read** (`/state`, `/entries`) answers a named error — status, `reason: "frame_too_large"`, the `entryId` and
  its byte count — and the entry stays retrievable through `/entries/:entryId`;
- an **SSE baseline** emits `state_oversize` with the same payload instead of a frame that would destroy the socket, so
  the stream stays open and the next commit can publish normally. Size never triggers `resync_required`: that event
  means a revision mismatch and nothing else, so a large conversation cannot produce an endless resync.

The live partial is the one payload that can grow without a commit. If a frame carrying the full partial would cross
the guard, that frame carries `partialDeferred: true` with an empty `partial`/`liveMessage` and the byte count. The
client keeps the text it built from `message_update` deltas and receives the finished message as an entry on the next
frame; nothing the user typed is shortened or lost. This is the only place a frame is smaller than the state, and it
says so on the wire.

### 2.4 What the window never does

- It never re-derives the transcript. The window is a suffix of the view the server already holds, so building it is
  O(window), not O(transcript).
- It never redacts twice: `safeEntry` runs once per entry, at projection (§6.1).
- It never changes what the live partial is: deferral applies to **history** entries only, and the streaming message
  stays exact unless it alone cannot be carried, in which case the frame marks `partialDeferred` and omits it whole
  (§2.3) rather than shortening it.

---

## 3. The wire

### 3.1 One baseline object

`GET /api/conversations/:id/state` and the SSE `snapshot` event return the **same** `ServerSnapshot`
(`server.ts:1405`, `:1531-1537`; today both `item.snapshot()`). That property is kept: the HTTP read and the first
stream frame cannot state two different lifecycles. The only change is that `entries` is the bounded window.

Added fields on the payload:

| field | meaning | cost |
| --- | --- | --- |
| `historyRevision` | opaque token over the native facts (D5) | two O(1) reads |
| `historyHead` | the newest head marker id at or before the tail, or `null` | included in those reads |
| `hasMore` | an active entry exists below the window | one comparison |

On the **baseline** the client derives `oldestEntryId` from `entries[0].id` (`durable-api.ts:69`), so it is not
duplicated there. On a **delta frame** it must be on the wire: a frame that appends carries no `entries`, so the client
cannot derive the window's new oldest id from the payload, and it needs that id to evict (§3.3, §5.2). The field is
therefore part of the delta vocabulary, and the two surfaces agree on its meaning: the oldest entry of the window the
server just published.

### 3.2 The history token is native, not minted, and uses no private import

`captureContextBounds` (`pi-durable/dist/harness/context.js:10-27`) is the helper that computes exactly the two facts
this needs. It is **not exported** (`dist/index.d.ts` exports no context helper, and the package has no
`@earendil-works/pi-durable/harness/context` subpath — `package.json` `exports` lists only `"."`, `"./env"`,
`"./env/node"`, `"./tools"`, `"./storage/*"`, `"./testing"`). This design therefore does **not** import it: the two reads
are made through the **public** surface, which exposes both of them directly —

- the newest visible entry id: `harness.commit(tx => tx.scanEntries({ conversationId }, 1, undefined))` (`Tx.scanEntries`,
  `dist/types.d.ts:693`) — the same call `apps/server/src/server.ts:309` already makes for generation tasks;
- the head marker: `harness.commit(tx => tx.latestHeadMarker(conversationId))` (`Tx.latestHeadMarker`,
  `dist/types.d.ts:695`: "newest visible entry of the conversation that carries a `head`"), or the
  `atOrBeforeEntryId`-parameterised `Storage.findLatestHeadMarker` (`dist/types.d.ts:835`) for a page bound.

Both run **on the session line** inside one commit, which is the invariant `context.js:5-9` states: "entries at or below
the tail are immutable", and `README.md:82` states the same for an entry. The token is thus a function of two committed,
immutable facts read through documented public calls, with **no private import and no new durable record**.

So:

```
historyRevision = conversationId + "|" + (historyHead ?? "-") + "|" + (tail ?? "-")
```

- It is **O(1)**, not a hash of the transcript.
- It needs **no new stored epoch** and no new durable record: it is a function of committed, immutable entry ids.
- It **survives a backend restart**, because the facts it names are durable. This is the property the current
  `snapshotRevision` (absent) cannot have, and the reason the browser's view cache never fills today
  (`session-view-cache.ts:91-93`).
- It is **not** `revision` and **not** `projectionId`: `revision` is this attachment's publication counter and
  `projectionId` is an attachment identity, both deliberately non-persistent (`server.ts:447-453`). Two attachments
  reading the same store report the same `historyRevision` and different `projectionId`; that is the point of
  separating them (D6).
- It is **conversation-scoped because entries are inherited**. A scan is over one conversation's **fork-aware** history: `EntryQuery` is documented as "inclusive ID bounds for a scan of one conversation's fork-aware history" (`dist/types.d.ts:558-566`), `Conversation.entries` as "fork-aware history of this conversation" (`harness/types.d.ts:488`), and `forkConversation` gives a child the parent's entries up to `at` (`dist/types.d.ts:706-708`). A forked conversation therefore holds **the same entry ids** as its parent, so entry ids alone do not identify a history: `conversationId` is part of the token, a fork has its own token from its first frame, and the parent's token never changes because a fork was taken from it.

`historyHead` travels as its own field because it is what the re-baseline decision needs (§3.4, §5.2), and because the
wire should not force a policy: the client's resolved rule — upstream's "a different head marker rebuilds the range"
(`context.js:34-36`) — is implemented against this field, and a later presentation that kept the pre-compaction prefix
would need no wire change.

### 3.3 Delta frames

A `state` frame after the baseline carries:

- `projectionId`, `revision`, `historyRevision`, `historyHead` — identity and clock, as today plus the token;
- `baseRevision` = `revision - 1`, `appended: ServerEntry[]` — the entries this advance produced;
- `oldestEntryId` and `hasMore` — the **authoritative trim** of the window this frame publishes, so a client that
  followed the stream holds exactly the server's window **in its tail store**, while older pages it loaded live in the
  prefix store (§5.2) and are not touched by the trim;
- every scalar field **full**: `busy`, `partial`, `liveMessage`, `liveTools`, `queuedMessages`, `settings`,
  `resources`, `failure`, `run`, `submissions`.

Full scalars are the continuity rule. `onAdvance` increments the one counter **once per callback** and both streams call
it (`server.ts:499-505`), so **every advance publishes exactly one frame and `revision` increases by exactly one per
frame**. `publish` is also the **single owner of the revision** and its reads are awaited in order, so a frame is
emitted only from a serialized publication: `baseRevision` is exactly the client's current revision and two frames are
never emitted for one base.

That is what the client relies on, and it relies on it **exactly**:

- **Apply a frame only when `baseRevision` equals the client's current revision**, and apply it exactly once.
- **Reject a stale or out-of-order frame without applying it** — `revision <= current`, or `baseRevision` that is not
  the current revision, is not "close enough": the client takes a **fresh bounded snapshot** (§3.6) instead of inferring
  a base.
- Complete scalars make the **content** of an accepted frame order-independent (a scalar-only frame applies on its own,
  and frames N and N+1 carry complete scalars each). They are **not** a licence to apply a frame whose base does not
  match, and nothing is ever applied out of order.

**The window trim rides every advancing frame, and it prunes the window — not the loaded history.** A frame that
appends also carries the new `oldestEntryId` and `hasMore`, and the client prunes its **tail store** to exactly that
window. The **prefix store** — the older pages the user loaded — is a separate store with its own rule (§5.2) and window
eviction never prunes it; the rendered transcript is the union of the two by entry id. Append-only deltas without the
trim would let the tail store grow past the window the server keeps, and past the raw cap the delta-folded state and
the equivalent snapshot state would stop being equal — so eviction is part of the delta vocabulary (§3.3, §5.2), not a
client convenience, and "deltas fold to the same state as snapshots" is asserted **past the raw cap**, over the **tail
window plus the scalars**.

**Migration, not deletion, when the eviction is visible.** If the frame's new `oldestEntryId` is above tail entries that
are already rendered and the prefix's newest id is contiguous with the first of them, those entries **move into the
prefix** — the known contiguous range is extended — instead of leaving the screen. Fetched history is never deleted by a
later turn arriving; only the prefix rule removes it (`!hasMore`, or a head-marker change, §11). Nothing here bounds the
total history a client holds: the budget bounds a **fetch** and the **live projection**, not the user's loaded
transcript.

The double-advance per commit is therefore not a hazard and is not changed. It is also why the delta needs no
per-client server state: the server keeps no buffer, no cursor, and no ack (D8).

```
event: state
data: { protocol, conversationId, projectionId, revision, baseRevision,
        historyRevision, historyHead, hasMore, oldestEntryId,
        appended: [ServerEntry, ...],
        busy, partial, liveMessage, liveTools, queuedMessages, settings,
        resources, failure, run, submissions }
```

### 3.4 Re-baseline instead of delta

One rule removes a whole class of ordering bugs: **a frame whose head marker changed carries `entries` (the whole
window) instead of `baseRevision`/`appended`.** Truncation plus append in one commit is exactly a new window
(`view.js:134-137` replaces `entries` with `[head, ...suffix]`), so sending it as a delta would make the client reason
about a truncation and an append atomically. It does not have to.

The same applies to the first frame after a client connects or reconnects, which is the `snapshot` event.

Client rule, five lines, in one place (the fold that already exists at `lifecycle-projection.ts:381-405` and its
adapter):

1. `projectionId` differs → replace everything (existing rule).
2. `revision <= current revision` → ignore (existing rule).
3. frame has `entries` → replace the window, then revalidate the paged prefix (§5.2).
4. frame has `appended` and `baseRevision === current revision` → extend the tail store, then **evict**: prune it
   below the frame's `oldestEntryId`, **migrating the already-visible evicted entries into the prefix** when the
   prefix's newest id is contiguous with them (and take the frame's `hasMore`).
5. frame has `appended` and `baseRevision !== current revision` → **reject the frame without applying it**, then request
   a fresh bounded snapshot (§3.6). A stale or out-of-order frame is never applied and never partially applied.

### 3.5 Older pages

New backend route: `GET /api/conversations/:id/entries?before=<entryId>&tail=<n>`.

- `before` is **exclusive** and is the oldest id the client already holds, matching the copied app's meaning
  (`session-reader.ts:674, 746-756`, `excludeLeaf`), so the client code is unchanged.
- The page is bounded below by the newest head marker at or before `before`
  (`Storage.findLatestHeadMarker(conversationId, before)`), so a page can never hand back entries the active context has
  left behind.
- The scan is `conversation.entries({ minEntryId, maxEntryId: before, order: "descending" }, limit, cursor, BACKGROUND_CONTEXT)`
  — the primitive `apps/server/src/session-search.ts:118` already uses with a cursor loop and `ENTRY_PAGE = 200`.
- The page applies the same §2 count rule and the same §2.3 budget, and returns `entries`, `oldestEntryId`, `hasMore`.
- Every entry goes through the **same** `projectEntry` helper the stream uses, so a paged entry and a streamed entry
  cannot differ — including `safeEntry` (§6.1).

No `after`/`Last-Event-ID` cursor is added to this route: a page is addressed by entry id, which is the identity the
client already holds.

### 3.6 Gaps: fresh snapshot, no replay, by-request settlement

When the server cannot answer a delta (the client's `baseRevision` is not the server's previous revision, or an
`?after=` on connect does not match), it does what it does today (`server.ts:1531-1537`): send a **fresh bounded
snapshot** and then `resync_required`. Nothing is replayed and no missed frame is reconstructed — "a client that joins
late or reconnects starts from the current view; nothing is replayed" (`README.md:299-302`).

The client answers a resync the way it already answers `durable_resync`: it does not infer from what a later frame fails
to mention; it asks about the one submission it made, by the request id it generated, through
`GET /api/conversations/:id/submissions?requestId=` (`server.ts:1410-1415`, forwarded at `durable-api.ts:457-458`,
consumed by `recoverPendingTurns`). A settled submission is absent from the outstanding set, so this is the only way
its outcome can be learned after a gap — which is why the by-request read is part of this design and not an optional
extra.

---

## 4. Consumers and migration

### 4.1 Server routes

| route | change |
| --- | --- |
| `GET /api/conversations/:id/state` | bounded window + `historyRevision`/`historyHead`/`hasMore` |
| `GET /api/conversations/:id/events` | baseline frame bounded; `state` frames become deltas (§3.3) |
| `GET /api/conversations/:id/entries` | **new**: older pages by entry id |
| `GET /api/conversations/:id/entries/:entryId` | **new**: one entry, projected — the read block for deferred content (§7) |
| all other routes | unchanged; `settings`, `commands`, `submissions`, `fork`, `messages`, `reload`, `abort`, `recall-queue` read scalars or one record |

**No unbounded mode is added to `/state`.** Not a `?tail=all`, not a `?full=1`. A consumer that genuinely needs the
whole transcript pages through `/entries`, which is what upstream does and what `session-search.ts` already does on the
server line. This is the explicit answer to "do not let the old route reintroduce full history".

### 4.2 The browser adapter: paging contract unchanged

`durable-api.ts` keeps its surface and translates:

- `snapshot(id)` (`:90`) → the bounded `/state`;
- `context(snapshot)` (`:68-70`) → the window, with `hasMore` from the frame instead of the hardcoded `false`;
- `GET /api/sessions/:id/context` (`:427`) → the new `/entries` route, forwarding `before` and `tail` from
  `searchParams` (today it reads neither) and mapping the answer to the same `{ context }` shape;
- `GET /api/sessions/:id` (`:427`) → the bounded `sessionData`, now with a real `hasMore`;
- `get_state`, `get_tools`, `state()` (`:495-499`) → unchanged code, and they read only scalars from the snapshot, so
  bounding `entries` changes nothing for them. They must **not** be "fixed" by fetching history.

`loadContext` (`useAgentSession.ts:854-895`) and the sentinel (`ChatWindow.tsx:652-696`) then work as written: the
paging scaffolding that is inert today becomes live. The `tail: 200` search path (`ChatWindow.tsx:614-628`) works too.

### 4.3 The session SDK

`packages/session`'s `DurableSession.stateSnapshot()` (`packages/session/src/index.ts:44-50`) reads `/state` and feeds
it to `reduceSseFrame` as a `snapshot` frame, whose current behavior is **replace** `entries`
(`packages/session/src/index.ts:10-27`). With a bounded baseline, a naive replace would silently drop the earlier
entries a long-lived session had accumulated.

Decision: `reduceSseFrame` merges instead of replacing when the snapshot is a **tail window** — keep the state's earlier
entries that strictly precede the snapshot's oldest entry id, and drop the rest. That is the same §5.2 rule the browser
uses, expressed once in the shared reducer, so the SDK and the web app cannot disagree. `SessionState` gains `hasMore`
so a caller can page.

`packages/protocol`'s `ProtocolSnapshot` (`packages/protocol/src/index.ts:105-110`) keeps its shape; the window fields
are additions, not a change to `applyEvent`'s contiguity rule (`:125-131`), which is unchanged.

### 4.4 Tests and smokes that read the whole transcript from `/state`

`/state` is read by ~20 server tests, four smoke scripts, and `packages/session`. Most assert on the **last** turns,
which stay inside the window and need no edit. The ones that assert on early entries or on a total count need one of two
edits, both mechanical: assert on the window plus `hasMore`, or page. `apps/server/test/server.test.ts` and
`session-fork.test.ts` are the only two that index `entries[`; the smoke scripts read the newest state.

The migration is part of the change, not a follow-up: a test that keeps passing because it happens to have fewer than 50
messages would hide a regression in the window rule.

---

## 5. Prefix, reconnect, identity

### 5.1 Prefix validity is a history question, not an attachment question

Today a fresh read unconditionally discards the paged prefix (`useAgentSession.ts:766-780`, `setHistory(null)`), and the
guard that was meant to prevent that depends on a `snapshotRevision` the durable path never sends
(`durable-api.ts` `sessionData`, `session-view-cache.ts:91-93`). The prefix is therefore dropped on every read, every
reconnect, and every session switch.

The rule that replaces it:

- A paged prefix is a range of **entries**, identified by ids. Whether it is still meaningful depends on the
  conversation's history facts (`historyRevision`, `historyHead`, and the window's oldest id) — **never** on
  `projectionId` or `revision`. A new attachment is a new lifecycle clock for the same history, so it must not discard
  loaded history. This is D9 and it is the correction to today's behavior.
- The prefix's freshness is decided by id comparison, which the hook already does: `prefixApplies`
  (`useAgentSession.ts:668-672`) compares the two id lists. It is kept as the core test and extended with the three
  outcomes below.

### 5.2 The algorithm (one pure function)

Inputs: `prefix` (ids + messages, may be `null`), the fresh window's ids, `historyRevision`, `historyHead`, `hasMore`.

```
if prefix === null                                  -> nothing loaded
if historyRevision unchanged                        -> keep prefix as-is
if historyHead changed                              -> re-baseline: drop prefix (§11, resolved native-first)
if !hasMore                                         -> window covers the whole active range; drop prefix
if prefix.lastId  <  window.firstId                 -> keep prefix + window (contiguous)
if prefix.firstId >  window.lastId                  -> prefix is newer than the window: impossible for a
                                                       prepend-only client; drop and re-page
otherwise (overlap)                                 -> truncate prefix to the ids strictly below
                                                       window.firstId, keep the rest, keep the window

then, always: prune the TAIL store to ids >= oldestEntryId, adopt the frame's hasMore, and MIGRATE
             evicted ids that were already loaded into the PREFIX when the prefix's newest id is
             contiguous with the first of them (extend the known contiguous range; never delete
             fetched history because the window moved)
```

The overlap branch is the one today's code cannot express (it only tests for *no* overlap) and is the reason a reconnect
that returns a fresh tail currently throws the loaded history away. Comparing **ids**, not lengths, is what makes the
truncation exact: a duplicate entry id is removed by identity, and an entry the window gained is not mistaken for an
overlap.

The last line is the **authoritative trim** and it is not optional: the server publishes a bounded window, so the **tail
store** holds exactly that window, whether the entries arrived in a baseline or in an appended delta. Without it, a
client that only ever appends would grow its tail store past the window, and past the raw cap the delta-folded state
and the equivalent snapshot state would stop being equal (§3.3) — that equality is asserted over the **tail window plus
the scalars**. But the trim is a statement about the **window**, not about the user's loaded history: an entry that
leaves the window is not automatically deleted from the screen, and the prefix store is where it goes when it was
already rendered. Trim is by **id**, so it is exact: an entry the window still contains is never dropped, and an entry
the window left behind is never kept *in the tail store*. A paged prefix is history that lives **below** the window; it
is never merged back above it, and nothing here bounds the total a client holds — the budget bounds a fetch and the
live projection. Only the prefix rule removes loaded history: `!hasMore`, or a head-marker change (§11).

This is a pure function over plain data — no DOM, no timers, no fetch — which is what makes it a public test seam
(§9).

It also mirrors the native rule, deliberately: `readContextFrom` (`context.js:30-60`) reuses a previous range when the
head marker is the same, truncates when `bounds.tail < previous.bounds.tail`, and scans only `tail + 1 .. new tail` when
the tail grew. Same three cases, same keys. Copying the rule (rather than importing it) is required because the range
utilities are not exported (`dist/index.d.ts` has no `readContextFrom`/`captureContextBounds`/`activeEntries`).

### 5.3 Reconnect

A reconnect gets, in order: a fresh bounded `snapshot` (the current view, no replay) and, if it named a stale `after`,
`resync_required`. Then §5.2 runs once. Three cases, all correct:

- the window did not move → prefix kept, nothing re-fetched;
- entries were appended → window moved; prefix kept if it still precedes it, truncated if it overlaps;
- a head marker moved → §11's policy.

Nothing in this path needs a server-side cursor, a per-client buffer, or a stored epoch.

### 5.4 Identity reset

A `projectionId` change is an attachment change and is handled by the lifecycle fold as today: a stream acquisition
rebases onto the new identity, an HTTP read from another identity keeps the accepted view and asks for a fresh
acquisition (`lifecycle-projection.ts:381-405`). The paged prefix is untouched by that machinery, because it is not part
of the lifecycle projection — it is history, and §5.1 says its validity is a history question.

---

## 6. Safety invariants

### 6.1 `safeEntry` is unchanged and runs once per entry

`safeEntry` (`server.ts:207-213`) and `safeFailure` (`:216-220`) keep their exact behavior: a credential failure's
message becomes `SAFE_CREDENTIAL_ERROR`, an unregistered api id becomes `SAFE_API`. What changes is only *when* it runs:
`projectEntry(entry)` is the single expression, called by the baseline, by every page, and by the delta append path.
Three call sites, one function, so a new surface cannot forget the redaction. `project` keeps applying it to the live
partial as it does now (`:275`).

### 6.2 Extras cannot race the entries

The hazard: `publish` reads `resources` and `failure` from storage **after** the view callback that produced the entries
(`server.ts:478-492`), so a frame could carry entries from commit N and extras from N+1. A delta frame would make that
visible, because the client now trusts `baseRevision` as "this is exactly the state at N".

Rule: one `publish` invocation captures **one** view, reads the extras **for that frame**, and stamps **one** revision;
the existing "skip if the snapshot revision is older than the last published" check (`server.ts:483-492`) stays and
becomes the guard that a late extras read cannot be published under an older revision. Extras are never derived from
`entries` and never mutate them, so no extras path can change an entry the client already holds.

The same rule covers the metadata extras that are read outside `project` (research §7.6): `resources`, `failure`,
`settings`, `toolNames`/`extensions`, `workspaceId`. Every one of them changes through a commit, and a commit publishes
a view advance, so every extras change has its own frame. No extras update can arrive without a frame that carries it.

### 6.3 Scalar continuity

Stated once, in §3.3: every advance is one frame, `revision` increases by one, scalars are complete in every frame. A
delta frame that carries no entries is therefore not a special case; it is a frame with `appended: []`.

### 6.4 No new server state

No per-client cursor, no delta buffer, no ack, no epoch, no hash. The server keeps what it keeps today: the view, the
pending submission map, the attached responses, and the published revision. A client that cannot be served from those
gets a snapshot.

---

## 7. Deferred heavy content

### 7.1 What upstream already has (reuse, do not invent)

Both capabilities exist in the copied app and both already have a **read block** — a URL the browser fetches only when
the user expands the content:

- **Tool-result images**: base64 image blocks in a tool result are replaced by
  `{ type: "image", source: { type: "url", media_type, url: "/api/sessions/:id/entries/:entryId/tool-result-image?blockIndex=N" } }`
  when the mime is in `TOOL_RESULT_IMAGE_MIMES` and the size is within `MAX_TOOL_RESULT_IMAGE_BYTES = 10 MiB`
  (`apps/web/lib/session-reader.ts:797-840`, `apps/web/lib/tool-result-images.ts`). Out of policy, the block is dropped
  and an explicit notice is appended: `[N tool result image(s) omitted from initial history payload: <mimes>, ~<bytes> bytes]`.
- **Thinking**: an assistant thinking block becomes `{ ...block, thinking: getThinkingPreview(thinking), deferred: true }`
  when the caller passes `deferThinking` (`session-reader.ts:866-878`), and `MessageView` loads the full text on expand
  from `/api/sessions/:id/entries/:entryId/thinking?blockIndex=N`
  (`apps/web/components/MessageView.tsx:161-171, 1025-1045`), memoizing in-flight loads and dropping failures.

The client half of both read blocks is already written and already handles loading, failure and retry. That is why
deferral is the first resort in §2.3 rather than a window shrink.

### 7.2 What is factually missing on the durable path

1. **Neither read block exists.** `durable-api` has no `entries` path at all (its only mentions of `entries` are the
   local `ServerSnapshot` type and the projection), so `/api/sessions/:id/entries/:entryId/thinking` and
   `.../tool-result-image` fall through to `unsupported(...)` — a 501. The durable server has no single-entry route
   either (its routes are `state`, `submissions`, `commands`, `settings`, `extensions`, `fork`, `events`, `messages`,
   `reload`, `abort`, `recall-queue`, `busy`, `auto-name`, `DELETE`).
2. **`deferThinking` has no durable equivalent today**, because thinking is inside the entry's message content and the
   durable path never defers. The capability is not missing upstream; the *route* is missing here.
3. **`deferMedia`/`tree=summary` are pi-web payload shaping with no durable producer.** `tree` is `[]` on this path
   (`durable-api.ts:80`), so `treeFormat` never applies and the branch navigator has no data.
4. **Oversized non-deferrable content has no capability at all, upstream included.** There is no read block for a large
   tool-result **text** output (a 5 MB build log). `MAX_TOOL_RESULT_IMAGE_BYTES`/`TOOL_RESULT_IMAGE_MIMES` cover images
   only, and there is no output-truncation-and-hydrate helper anywhere in the copied app. This is the one case where a
   single entry can exceed the frame target after deferral. It ships whole when it fits the transport (§2.3, step 3) and
   is recorded as a limit; when even that does not fit, the read answers with the **actionable error** of §2.3 step 4.
   **The newest entry is never dropped and is never unreachable**: the full entry stays readable by id through
   `/entries/:entryId`, and the client is told the first load could not be bounded — it is not told a bounded load
   succeeded. **No claim is made that the first load is bounded for arbitrary content**; the claim is bounded for
   content whose heavy parts can be deferred, which is what the benchmark asserts (§10, check 3).
5. **A real deployed entry is already over the transport guard, and the cause is a field nothing renders.** The largest
   entry in the three measured conversations is an assistant entry of **1.08 MiB**, of which 427 KiB is the thinking text
   and **501 KiB is `thinkingSignature`** — an opaque provider-continuity payload (`pi-ai/dist/types.d.ts:269-273`:
   "the opaque encrypted payload is stored in `thinkingSignature` so it can be passed back to the API for multi-turn
   continuity"). No client code reads it (only the streaming reducer's fixtures mention the field), and provider
   context is built natively from the view, so it is never sent back from a projected entry. Dropping it during history
   deferral is lossless for the UI and is what turns that entry from over-guard into **1.0 KiB** (§2.3). The read block
   returns the thinking text; the signature stays native.

6. **The mime/byte policy is already duplicated in two web copies** (`apps/web/lib/tool-result-images.ts` and
   `apps/web/vendor/pi-web/lib/tool-result-images.ts`, both 229 B). The server needs the same policy, so it moves to
   `packages/protocol` as the wire policy ("which images a frame may defer to a read block") with the two web files
   re-exporting it. One policy, three importers, instead of three copies.

### 7.3 Decisions

- The **server** produces the deferred shape, because the server owns the frame budget and must not emit a URL it does
  not serve. The URL shape and the notice text stay exactly as the copied app has them, so the existing client code and
  its tests keep working.
- Deferral applies to **history frames and pages**, never to the live partial.
- Deferral is applied **unconditionally** for images and thinking in history, not only when over budget: the UI already
  collapses both by default, and a conditional rule would make the frame shape depend on a size the client cannot
  predict. The target then only ever has to shrink the window for oversized **text**.
- History deferral also **drops `thinkingSignature`** (§7.2 item 5). It is the largest single field in a real deployed
  entry, it is provider-continuity data the browser never renders and never sends back, and the read block restores the
  thinking text it belongs to. Without this the "defer thinking" step would not bring a real entry inside the target.
- The read blocks are **new routes on this path**, not new capabilities: `durable-api` answers
  `/api/sessions/:id/entries/:entryId/thinking` and `.../tool-result-image` with a 501 today (§7.2 item 1), and this
  design implements them against `/entries/:entryId`. Support for that path is a prerequisite of the deferral step, and
  the spec must carry it, not the implementation ticket alone.

---

## 8. Search, fork, minimap by id

All three already work by entry id, and none of them needs a loaded page:

- **Fork**: `POST /api/conversations/:id/fork { at }` (`server.ts:1493`) resolves visibility itself, and
  `Conversation.context({ at })` (`harness/types.d.ts:484-487`) is defined as "the same view `fork(at)` would start
  with". An entry the browser has not loaded can be forked from by id. The client's `fork_branch` already sends
  `command.entryId` (`durable-api.ts:489-494`).
- **Search**: hits already carry `entryId` and `blockIndex` (`apps/server/src/session-search.ts:97-103`), and the client
  already loads one extra page of 200 when the hit is not in memory (`ChatWindow.tsx:614-628`). With real paging that
  path works; a deeper hit keeps today's behavior of opening the session at the id.
- **Minimap**: needs the loaded window plus a total count. `onRevealHistory` should request the next page instead of
  only growing `visibleCount` (`ChatWindow.tsx:805-807, 1338-1343`), which turns the minimap into a paging driver at no
  extra cost.

---

## 9. Public test seams

Behavior is tested at the boundary that owns it. Each seam is a plain function or an HTTP route, not a rendered
component.

**Server (HTTP, `pnpm test:server`)**

- `apps/server/test/history-window.test.ts` — the §2 contract: a 200-turn conversation's `/state` carries ≤ 50 visible
  messages, ≤ 300 raw entries, `hasMore` true, and an `oldestEntryId` that is in `entries`; a 10-turn conversation
  carries all of them with `hasMore` false. A single 2 MiB tool result still yields a frame within budget after
  deferral.
- `apps/server/test/history-paging.test.ts` — `/entries?before=` never repeats `before`, pages strictly older, is
  bounded by the head marker (after a compaction the pre-compaction entries are not paged back), and paging the whole
  transcript reproduces exactly the entry-id set of an unbounded read.
- `apps/server/test/state-delta.test.ts` — the §3.3/§3.4 rules: a turn's `state` frames have `baseRevision = revision - 1`
  and contiguous revisions; a scalar-only frame has `appended: []`; a compaction produces a frame with `entries` and no
  `appended`; a stale `after=` produces `snapshot` then `resync_required` with no replay (extends `server.test.ts:92`).
- `apps/server/test/history-token.test.ts` — `historyRevision` is unchanged across two reads with no commit, changes when
  an entry is appended, changes when a head marker is added, is equal for two different attachments of the same
  conversation, and is equal **after a server restart** on the same store.
- Redaction is asserted on **all three** surfaces in one test: the baseline, a page, and a delta append each redact a
  credential failure and an unregistered api id identically (`SAFE_CREDENTIAL_ERROR`, `SAFE_API`).
- `apps/server/test/entry-read.test.ts` — the §7 read blocks: one entry by id is projected and redacted; an unknown id is
  404; a `blockIndex` outside the entry's content is 400; an image outside the mime/size policy is refused.

**Session and protocol (`pnpm test:session`, `pnpm test:protocol`)**

- `reduceSseFrame` merge-not-replace for a tail window, and `hasMore` propagation (§4.3).
- A property test: for a random commit sequence, folding deltas onto a state produces the same `SessionState` as folding
  snapshots only. This is the seam that catches a delta-vocabulary bug without a browser.

**Web (`pnpm test:web:unit`)**

- The §5.2 prefix function as a pure unit: kept, truncated-on-overlap, dropped-on-`!hasMore`, dropped-on-head-change,
  kept-across-`projectionId`-change. `apps/web/lib/chat-lazy-load.test.mjs` is the neighbouring home for it.
- `apps/web/lib/lifecycle-projection.test.mjs` — the five §3.4 rules, in particular "a delta and the equivalent snapshot
  fold to the same core" (extends `:106`).
- `apps/web/adapters/durable-api.test.mjs` — the adapter translates `before`/`tail` onto `/entries`, fills `hasMore`,
  and `get_state`/`get_tools` still issue exactly one bounded read (the existing "no `/state` call" assertions in
  `session-*.test.mjs` stay as they are).

**Smoke (`apps/server/scripts/*.ts`)**: read the newest window, so they keep working; the scripts that print a total
entry count page instead.

---

## 10. Benchmark

One script, `apps/server/scripts/perf-history-scaling.mjs`, modelled on the lane B harness
(`.dev/worktrees/perf-lane-b/apps/server/scripts/perf-lane-b2.mjs`: in-process backend, faux provider, SSE frames as
barriers, **no sleeps, no model calls, read-only**). Run on the **build host or CI**, never on the **runtime host**
(AGENTS.md build-host rule). Output JSON next to the lane records; the before-numbers are lane B's (`REPORT.md` findings 1 and 2).

The script runs the same synthetic turns at 10 / 60 / 120 / 240 turns, each turn with **identical** content, and records
state bytes and frames per turn, the largest single frame, first-load bytes and milliseconds, and per-page bytes. It
then asserts, with exit status:

1. **Bytes per turn are independent of transcript size** — `bytesPerTurn(240) <= 1.25 * bytesPerTurn(60)` and both under
   a fixed ceiling. Lane B measured 5,524 → 152,175 bytes/turn from 10 to 60 turns; the delta path must make that flat.
   (A commit's own output still costs what it costs; the claim is only that the *transcript* term is gone.)
2. **The largest frame is independent of transcript size** — `maxFrameBytes(240) <= 1.25 * maxFrameBytes(60)`, measured
   over turns whose entries are individually small enough to be deferrable (lane B: 1,198 → 30,5xx). The exception is
   checked separately in check 3; this check makes no claim about a single unbounded entry.
3. **First load is bounded for deferrable content** — `firstLoadBytes` at 10, 60, 120 and 240 turns all within the
   512 KiB target, and `firstLoadBytes(240) <= 1.25 * firstLoadBytes(10)`. Same assertion for the SSE `snapshot` frame.
   Lane B: 4.7 MB at 197 turns. This is a **soft target with two named exceptions** (§2.3): the check is stated over the
   synthetic turns, which carry deferrable heavy content, and it makes **no claim about arbitrary content**. The
   exceptions are asserted as behaviour instead — a newest entry that cannot be brought inside the target yields the
   named `frame_too_large` error with the entry still retrievable by id, and an oversized live partial yields
   `partialDeferred` with the stream intact. Those two paths are asserted rather than a byte ceiling the design cannot
   meet.
4. **First load does not scale linearly in time** — `firstLoadMs(240) <= 4 * firstLoadMs(10)` (loose, to allow fixed
   overhead; a linear read cannot pass).
5. **Paging loses nothing** — the union of pages read backwards from the tail equals the entry-id set an unbounded read
   would return, each page is within budget, and total bytes stay within a small factor of the unbounded read.
6. **Deferral holds the budget** — a conversation whose turns each carry a 2 MiB tool-result image produces first-load
   frames within budget, and the deferred entry reports a resolvable `url`.
7. **The token is stable** — `historyRevision` is identical across a restart of the backend on the same store (this is
   the assertion that would fail if the token were an in-memory epoch).

Checks 1-4 are the two claims to prove; 5-7 are the ones that catch a design that meets them by dropping data.

---

## 11. Head-marker change: resolved native-first (was Q1)

A compaction or reset moves the head marker. The question was whether history the user already loaded stays on
screen. It is **resolved, native-first**: the prefix is **dropped** and the window is replaced from the marker — which is
what upstream's own rule does (`context.js:34-36`: a different head marker rebuilds the range), what the current
projection already implies (it is head-bounded), and what keeps the transcript on screen equal to what the model can
see, so a message the user can scroll to is always one the model can be asked about. It needs no user question: the
native behaviour and the existing projection agree, and this is a re-baseline (§3.4), not a delta.

The wire still carries `historyHead` on every frame, so a later presentation that keeps showing the pre-compaction
prefix would need **no wire change** — it would be a client policy over a field that is already there. Nothing in this
design depends on that choice.

---

## 12. Not decided here

- The **SSE connection budget** (scope item 1) and the **terminal fan-in** shape — `decisions.md` §4 and §6. This memo
  does not add a stream, a connection, or a subscription, so it does not move that arithmetic.
- The **SSH reuse tracks** (scope item 4).
- Whether upstream should **export the context range** utilities. The rule is copied, not imported
  (`dist/index.d.ts` exports neither), and a second consumer would be the trigger to ask.
- Whether `tree=summary` and the branch navigator get a durable producer. `tree` stays `[]` here; the minimap and the
  branch features remain unpopulated on this path, unchanged by this design.
- The oversized non-deferrable **text** output case (§7.2 item 4): recorded as a limit.

---

## 13. Evidence index

Native pi-durable 1.1.0: `dist/harness/context.js` 2, 5-9, 10-27, 30-60, 72-95, 155-175; `dist/harness/view.js` 14-20,
99-116, 118-176 (`:128`, `:134`, `:137`); `dist/harness/types.d.ts` 484-488; `dist/types.d.ts` 558-566, 686-700,
810-845; `dist/index.d.ts` (no context exports); `README.md` 82, 276-302, 325-345, 405-412.

Server: `apps/server/src/server.ts` 207-220, 270-286, 311-327, 447-453, 478-492, 499-505, 1405, 1410-1415, 1493,
1531-1537; `apps/server/src/session-search.ts` 97-103, 118; `apps/server/src/workspace-resources.ts`;
`apps/server/src/extension-selection.ts`.

Web: `apps/web/adapters/durable-api.ts` 65-90, 427, 457-458, 489-499, 670-712; `apps/web/hooks/useAgentSession.ts`
668-680, 740-800, 854-895; `apps/web/lib/lifecycle-projection.ts` 381-405; `apps/web/lib/lifecycle-acquisition.ts` 28;
`apps/web/lib/session-view-cache.ts` 91-93; `apps/web/lib/chat-lazy-load.ts` 1-13; `apps/web/lib/session-reader.ts`
674, 679-760, 797-840, 866-878; `apps/web/lib/tool-result-images.ts`; `apps/web/components/MessageView.tsx` 161-171,
1025-1045; `apps/web/components/ChatWindow.tsx` 614-628, 652-696, 805-807, 1338-1343;
`apps/web/lib/agent-event-stream.ts` (512 KiB high-water mark).

Protocol and session: `packages/protocol/src/index.ts` 104-110, 125-131, 137-190; `packages/session/src/index.ts`
3, 10-27, 44-50.

Docs and records: `docs/adr/0007-lifecycle-facts-one-projection.md`; `docs/architecture.md` 9, 24-26; `docs/chat.md` 5, 7;
`.dev/worktrees/perf-lane-b/.scratch/perf-b/REPORT.md` findings 1-2;
`.dev/worktrees/perf-lane-b/apps/server/scripts/perf-lane-b2.mjs`;

[Showing lines 1-709 of 711 (50.0KB limit). Use offset=710 to continue.]