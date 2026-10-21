# perf-follow-up — design memo: SSE efficiency, incremental frames, history loading, SSH reuse

Read-only design. **No code change, no production write, no restart, no paid call.** This memo compares options and
recommends one per route; it is the design input to the **approved** [`spec.md`](spec.md) (approved 2026-10-13, tickets
under [`issues/`](issues/)). It is not itself the spec and not the tickets.

Base: `integration/chat-lifecycle` `b9b28dd` (`.dev/worktrees/chat-lifecycle-integration`), which is also the
production branch `deploy/cb4494b0`; `cb4494b` differs from it in `docs/` only, so every code fact here is the
deployed one. Scope decisions and the decision hierarchy are in [`decisions.md`](decisions.md).

---

## 1. Route 1 — browser SSE efficiency

### 1.1 What is true at the base

Live sources on the page's origin, at `readyState === 1`:

| source | route | owner | held when hidden? |
| --- | --- | --- | --- |
| conversation | `/api/agent/<id>/events` | `AgentEventConnection`, one per conversation, many readers | yes — the selected conversation is kept warm while idle |
| terminal | `/api/terminal/<id>/events` | `TerminalPanel`, one per **mounted** tab | **yes** — `AppShell` renders the right panel unconditionally and maps every tab; the panel's stream effect has no visibility guard |
| file watch, auth login | `/api/files/...?type=watch`, `/api/auth/login/...` | — | no: both answer 501, which **fails** an `EventSource` (`readyState` → CLOSED, never retried), so they hold nothing |

Pool: **6** per origin on HTTP/1.1 (Chromium `g_max_sockets_per_group`; Firefox `max-persistent-connections-per-server`);
the deployed host answers HTTP/1.1 and refuses h2 prior knowledge. Measured at `cb4494b`: with **no app code**, 1–5
same-origin `EventSource`s leave an ordinary same-origin `fetch` settling in 4 ms and **6 exhaust the pool** so it never
settles; with the real app, 6 held runs leave the composer unreachable (`composerMs: null`), 9–11 requests pending and a
switch timing out at 40 s. Controls: the same read outside the page's pool answers 200 in 5 ms, a second page never
loads.

So the count that matters is **global and per-origin: chat + terminal**. Measured on the prebuilt app at `cb4494b`
(research §15, raw output in [`evidence/`](evidence/README.md)): 4 conversations (1 selected + 3 running) plus 2
restored terminal tabs = **6 held sources and an ordinary in-page read missing a 3000 ms deadline, with the right panel
open and closed alike**; one terminal tab = 5 held and the same read settling in 46 ms. The count below is therefore
written with the terminal term explicit:
`live = 1 (selected, warm while idle) + 1 (terminal fan-in, once the fan-in exists) + B (background watches)`.

**Idle streams die at ~300 s from the server side, not the browser side.** The Next server process reaches the backend
with the runtime's own `fetch`, whose dispatcher defaults to `headersTimeout = bodyTimeout = 300_000`
(`undici@8.10.2/lib/dispatcher/client.js:316-317`, the defaults the pinned runtime uses). A long-lived SSE body with no
bytes for 300 s is therefore torn down as a body timeout even though the browser would happily keep the `EventSource`
open, and the browser's automatic reconnect then re-attaches and pays a fresh full snapshot.

**Heartbeat support today: none on any live SSE path.**

| seam | heartbeat |
| --- | --- |
| server → backend SSE (`apps/server/src/server.ts:1531`) | none; the only frames are `snapshot`, `state`, `submission`, `resync_required` |
| backend → browser adapter (`apps/web/adapters/durable-api.ts:670`) | none; frames are re-emitted as they arrive |
| gateway terminal SSE (`packages/gateway/src/index.ts:791`) | none |
| backend terminal relay (`apps/server/src/terminal-relay.ts:139`) | none |
| `apps/web/lib/agent-event-stream.ts:302` | `setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS = 30_000)` — **the preserved pi-web stream, and no production importer**; the live path is `adapters/durable-api.ts` `events()` |

**Per-stream transport settings today: none.** `apps/web/lib/http-dispatcher.ts` installs one **process-global**
undici dispatcher (`EnvHttpProxyAgent`, `allowH2: false`, `headersTimeout`/`bodyTimeout` = 300 s by default) through
`undici.setGlobalDispatcher`. It is exported and tested (`http-dispatcher.test.mjs`) and **imported by no production
module** — in this base and in the root checkout alike. Every other production call site that bounds anything uses a
per-call `AbortSignal.timeout(...)` (terminal relay 20 s, worktree host, workbench 20 s, MCP host, catalog refresh), and
the two SSE-shaped fetches deliberately pass the caller's own signal and no timeout.

### 1.2 Options for the chat streams

| option | what it does | keeps the durable contract? | terminal effect | cost |
| --- | --- | --- | --- | --- |
| **A. Deferred background budget** (lane C proposal) | cap background *conversation* watches at `B`; an over-budget watch keeps its projection and opens no source until a slot frees; no timer | yes — every guarantee of ADR 0007 survives (selected never deferred, one claim per answer, reconnect, catalogue marker, silent baselines) | **none** — terminals are not in this registry | `B` cannot be fixed while `T` is uncounted; a deferred run that ends before a slot frees produces no tone (the limit ADR 0007 already accepts) |
| **B. Conversation fan-in** | one multiplexed conversation stream for `{selected} ∪ nominated` | needs per-conversation ordering, per-conversation acquisition fences and the 100-frame collapse generalized from one watch to N on one wire | none | new endpoint + protocol + ADR change; per-client server state where the backend keeps none |
| **C. Terminal fan-in** (route 1, terminal side) | one terminal stream for all mounted tabs, fanning the host's per-session events | touches no conversation contract | **must stay attached to every session whose tab is open**, so hidden shells keep running | new endpoint + framing + a cursor per session; the gateway already owns per-session backlog, offsets and replay, so the fan-in is a routing layer over existing primitives |

**Recommendation: A + C, in that order, with the count fixed by the terminal facts rather than by an equation.**
A is a change inside `CompletionDelivery` (one module, no endpoint, no protocol, no ADR change); C is what makes the
arithmetic true in normal use, because without it `T` is uncounted by construction. B is not needed to keep the page
usable once A+C hold, and B is the only option that reopens ADR 0007's rejected "a stream per catalogued conversation"
in multiplexed form — so B stays a recorded option, not a recommendation.

The count, once C exists, is global and has **no per-tab term**: `1 (selected conversation) + 1 (terminal fan-in — one
stream total, opened only while at least one terminal tab is mounted, never one per tab) + B (background conversation
watches) + 2 (HTTP headroom for the send POST, the lease POST and ordinary reads) ≤ 6` → **`B ≤ 2`** whenever a
terminal tab is mounted, and `B ≤ 3` when none is (the fan-in stream is not opened at all). The provisional 3 in the
lane C proposal is not a wrong constant; it is a constant whose precondition — no terminal stream exists — is not the
normal case, which is why §1.3's fan-in is what makes the arithmetic true. Both numbers come from the pool arithmetic
and the terminal invariants in §1.3, and each is asserted by a test (§1.5) rather than assumed.

### 1.3 The terminal invariants that fix C's shape

These are **researched invariants of the current code**, not new policy — C must preserve them, so they decide what
"defer" may mean for a terminal:

- `TERMINAL_RECONNECT_MS = 120_000` (`packages/gateway/src/terminal.ts:29`): a session with **no attached caller** is
  closed after that window (`#renew` `:668`, `#expire` `:682`); while at least one caller is attached, the window
  does not run. The relay cancels the host request with the caller's own connection
  (`apps/server/src/terminal-relay.ts`, `events` branch), so an abandoned request cannot keep a shell alive.
- `TERMINAL_REPLAY_CHARS = 128 * 1024` (`terminal.ts:28`): a caller naming no cursor, one behind the retained tail, or
  one ahead of the session's offset is answered with the retained tail and `reset: true`
  (`subscribe` `:574`; `terminalCursor`, `packages/gateway/src/index.ts:875`). A reattach outside the tail therefore
  one ahead of the session's offset is answered with the retained tail and `reset: true`
  (`subscribe` `:574`; `terminalCursor`, `packages/gateway/src/index.ts:875`). A reattach outside the tail therefore
  **clears the screen** — the panel's own `onmessage` does `terminal.reset()` when `event.reset` is set
  (`apps/web/components/TerminalPanel.tsx:127-131`).
- The cursor is already per-stream and standard: `id:` on every output frame, `Last-Event-ID` honoured end to end
  (browser → Next adapter → backend relay → gateway), and the gateway prefers the header over `?after=`.

**Therefore: suspending a hidden terminal's stream alone is not free.** Detaching a mounted tab lets its lease run out,
which **kills the shell**, and a later reattach may reset the screen to the retained tail. A design that disconnects
hidden terminals and assumes the process survives indefinitely is rejected — that assumption is false for a detached
session.

**Recommendation: preserve today's behavior — every mounted terminal tab keeps its shell running — and make it explicit
and cheap with the fan-in, rather than implicit and expensive with one stream per tab.** Concretely, C is one terminal
stream per page whose per-session attachment is held for exactly as long as the tab is mounted (mounted == attached),
so the lease never runs out for a tab the user still has; a tab that is closed releases its attachment, and the
existing lease/exit semantics then do exactly what they do today. This needs **no new user decision**: it is the
behavior the product already has, made cheaper and countable.

### 1.4 Route 1b — the idle-stream heartbeat, at the owning seam

**Recommendation: a keepalive comment frame written by the seam that owns each stream's frame boundaries, sized under
the transport idle bound it exists to defeat, forwarded untouched by everything in between — never a global
monkeypatch, never "disable all request timeouts", and never a comment injected into a raw relay chunk.**

- **Where the heartbeat is written: the origin, where frames are framed.** Two writers own the bytes of their own stream
  and already build frames:
  1. `apps/server/src/server.ts` conversation SSE (`:1531`) — the backend's own conversation stream;
  2. `packages/gateway/src/index.ts` `#terminalEvents` (`:791`) — the gateway's own terminal stream.
  A comment line (`:

`) is chosen deliberately: it is valid SSE, carries no `data:`, produces no message event, and
  cannot be mistaken for a state, submission or output frame — so it cannot break the acquisition fence, the answer-key
  claim or a terminal cursor. The shape already exists in `apps/web/lib/agent-event-stream.ts:302`
  (`HEARTBEAT_INTERVAL_MS = 30_000`) and should be reused, not reinvented.
- **Where it is forwarded, not written: the Web adapter.** `apps/web/adapters/durable-api.ts` (conversation proxy) and
  `apps/web/adapters/terminal.ts` (terminal proxy) re-emit the upstream body as it arrives. They must **pass a comment
  frame through unchanged** and must **not** inject one: a proxy that appends bytes to whatever chunk it happens to hold
  can write inside a frame the origin is still producing — between a `data:` line and its terminating blank line, or
  inside a multi-byte UTF-8 sequence — which corrupts the payload the frame carries. Injection is only safe at a writer
  that owns frame boundaries; a forwarder owns none. (These proxies are pass-through by construction, which is why the
  origin is the right and only writer.)
- **Interval.** Strictly below the smallest transport idle bound on the path. The server→backend hop's default is 300 s
  (`undici` `300e3`), so a 30 s heartbeat has 10× margin and matches the preserved pi-web constant.
- **Scoped transport settings, and the bound that must not be confused with them.** Where a streaming fetch needs a
  bound that is not the global default, pass it **per call**, in the shape the code already uses. Two different bounds
  are in play and must not be conflated: undici's `headersTimeout`/`bodyTimeout` is an **idle** bound (no bytes for N
  ms), which is exactly what a heartbeat defeats; a per-call `AbortSignal.timeout(...)` is a **total-duration** bound,
  which would kill a healthy long-lived stream and is therefore not a substitute for the heartbeat. Do not call
  `undici.setGlobalDispatcher` for this: `apps/web/lib/http-dispatcher.ts` is a process-global switch that changes every
  request in the Next server, it is currently imported by nothing, and its 300 s default is exactly the value a
  heartbeat has to stay under. **Recommendation: leave it unwired for this effort** and record that decision rather than
  adding a second global.
- **Why the browser needs no heartbeat written in it, and why continuity still matters there.** A browser `EventSource`
  has no read timeout, so the ~300 s loss is server-side. But the page's stream crosses more than one hop (browser →
  Next adapter → backend → gateway) and any hop may impose its own idle bound, so a heartbeat at the origin is what
  keeps the whole chain — and therefore the browser's stream — alive. A page whose stream is re-established every few
  minutes re-baselines every time, which is the continuity the user actually notices; the heartbeat protects that
  continuity for the browser without being written in the browser.

### 1.5 Seams and tests for route 1

Seams (one each, no new infrastructure):

1. `CompletionDelivery` — the acquisition decision. It already owns "which conversations are watched" and the single
   source per conversation; the budget is a predicate over its own `watches` map plus the selected id, and nothing
   else in the page needs to learn about it. A watch that cannot acquire keeps its projection, its `nominated` flag
   and its place in the map, and acquires on the next `reconsider`.
2. A **terminal fan-in seam** that owns terminal attachment — a peer of `AgentEventConnection` for terminals, keyed by
   tab, holding the per-session cursor the panel holds today. The panel keeps its xterm and its writer and stops owning
   transport, which is the same division `useAgentSession` and `AppShell` already have for chat.
3. **Test instrumentation only — not a production module.** The e2e recorder (the existing
   `perf-lane-c-sse-budget.mjs` pattern) counts `readyState === 1` per route inside the page, so a test asserts the
   observed count rather than a constant. Nothing in `apps/web` gains a diagnostic or counting module for this: a
   production surface that exists only for tests is a liability, and the recorder already measures the real thing.

Tests, each tied to a behavior (none is a test-independent restriction):

- **Unit (deterministic, no browser):** the acquisition rule — at most `B` background sources while the selected
  conversation's source is never given up; a nomination over budget opens nothing and still acquires when a slot frees;
  its answer is claimed exactly once when it does; duplicate-audio and reconnect guarantees unchanged. (The red pair
  built in the `perf-lane-c` worktree is this harness; its arithmetic is replaced by the counts of §1.2.)
- **E2E, terminals in the count:** N real mounted terminal tabs (the backend terminal path is implemented and
  `apps/web/e2e/ux-terminal-session.mjs` already drives it) plus held chat runs; assert the global OPEN count, the
  composer ready deadline, a switch deadline and an in-page fetch settling, and assert the **terminal still works** —
  keystrokes echo, a hidden tab's shell is still the same session after the measurement, and a reattach does not reset
  a screen that is inside the retained tail.
- **E2E, the 4-held control** (no terminals) that must pass today, so a failure is attributable to the count.
- **Idle-stream test:** a held stream with no application frames stays attached past the transport's idle bound and
  receives the heartbeat; assert the connection was not re-established (one source, no reconnect) across that window.
  Run it against a **shortened, controlled idle bound with the clock advanced by event barriers** — never a real
  five-minute wait and never a sleep. The bound under test is the *idle* one; a per-call total-duration
  `AbortSignal.timeout` is a different bound and must not be substituted for it, or the test would prove nothing about
  the idle case while failing a healthy long-lived stream.
- Every hold is a **named barrier**, never a sleep; every read that can stall is deadline-bounded (the existing
  `heldResolvers` / `bounded` pattern in `apps/web/e2e/perf-lane-c-sse-budget.mjs`).

---

## 2. Routes 2 and 3 — incremental frames, and initial/reconnect large-history loading

The concrete design is [`design-history.md`](design-history.md) (D1–D10, the window contract, the wire, the prefix
algorithm, the read blocks, the public seams, the benchmark). This section states only what the spec and the tickets
need, and supersedes the earlier draft of this section. Two corrections from that draft are load-bearing and are
carried into the spec:

- **The frame budget is a soft target, not a hard bound.** The newest entry and the live partial are never dropped, and
  an entry whose own content cannot be deferred (a large tool-result **text** output) ships whole; that case is a
  recorded limit, not a silent truncation. A frame that would exceed the transport's own limit gets an **actionable
  error**, never an endless `resync_required` loop.
- **The history token is derived from public native primitives only** — no private `readContextFrom`/`captureContextBounds`
  import. Where a needed native fact is not exported, the route is to commit/query upstream's documented surface, not to
  reach into its internals.

### 2.1 What is true at the base

- One publication sends the **whole replacement projection** to every attached client
  (`apps/server/src/server.ts:483-489`), rebuilt by `project()` (`:270`) including every committed entry's full
  message. Measured in-process, 60 turns: 5,524 → 26,372 → 76,575 → 152,175 bytes per turn, largest single frame
  30.5 kB; the same payload over HTTP is `GET /api/conversations/:id/state` at up to 4.78 MB and a 4.71 MB initial SSE
  snapshot.
- The producers of deltas **already exist and are discarded**: `conversation.watch()` computes exact Chord operations
  per commit and its README suggests forwarding them to a remote client; `watchEvents()` computes
  `message_update.changes` and `tool_execution_update { trimStart, append }`. The server's own watch listener takes
  `(value, ops, context)` and drops `ops` (`:504`).
- The browser's ordering contract already names a baseline: `(projectionId, revision)`, where `projectionId` is the
  attachment identity and `revision` is per attachment — `lifecycle-projection.ts` already rejects a different
  identity and ignores an older revision within one identity.
- No client sends `?after=` or `Last-Event-ID` on the conversation stream today, so `resync_required` cannot fire in
  production; the safety net is the reconnect plus the per-turn by-id lookup.
- Recovery is already correct and is the thing an incremental path must not weaken: a reconnect gets a fresh complete
  frame, a missed frame is answered by asking, a lookup is silent and never a success signal.

### 2.2 Recommendation — the decisions the spec carries

Taken from [`design-history.md`](design-history.md) §1 (D1–D10); the reasons and the native citations are there.

1. **The baseline read is bounded** — the newest window, one object for `GET /state`, the SSE `snapshot` frame and every
   ordinary consumer. No `?tail=all`/`?full=1` mode is added: a consumer that needs the whole transcript pages, which
   is what the search path already does server-side.
2. **Window rule: 50 visible messages** (user, assistant, compaction — the copied app's `countsTowardTail` rule) with a
   **raw-entry cap of `max(200, 6 × visible)`**. Server-side constants, never wire fields; the client reads `hasMore`.
3. **The byte budget is a soft target with explicit exceptions, not a hard bound.** Order: defer heavy content first
   (lossless, §7 of the design), then shrink the window from the **oldest** end by whole entries, and **never** drop the
   newest entry or the live partial. A single entry that cannot be deferred (a large tool-result **text** output) ships
   whole and is recorded as a limit. If a frame would still exceed the transport's own limit, the server returns an
   **actionable error** for that read — never an endless `resync_required` loop, and never a silently truncated
   transcript that claims to be complete. No benchmark asserts a hard bound it cannot meet.
4. **Older history is entry-id pages** on a native bounded scan (`before` exclusive, bounded below by the newest head
   marker at or before it), with the same count rule, the same budget and the same `projectEntry` projection as the
   stream — so a paged entry and a streamed entry cannot differ, redaction included.
5. **Two tokens, two jobs.** `(projectionId, revision)` keeps its exact meaning (attachment identity and its
   publication counter, ADR 0007). A separate **`historyRevision`** — derived from native immutable facts (conversation,
   head marker, tail) through **public** primitives only — answers "may I keep the paged prefix". It is not a stored
   epoch, not a hash of the transcript, and it survives a backend restart because the facts it names are durable.
   `historyHead` travels with it. **No private native import** (`readContextFrom`/`captureContextBounds` are not
   exported): where a needed fact is not public, the route is upstream's documented surface or a committed request to
   it, never reaching into internals.
6. **Delta frames are append-only within one attachment**, `baseRevision` = the previous revision, with **every scalar
   full in every frame** and the **window bookkeeping carried on the frame** (`oldestEntryId`, `hasMore`). A head-marker
   change is a **re-baseline** (a frame carrying the whole window), never a delta — which is what removes
   truncation-plus-append from the client's reasoning entirely. **Publication is serialized by the single owner of the
   revision**: frames are emitted only from that serialized publication, one frame per advance, so `baseRevision` is
   exactly the client's current revision. The client **applies a frame only on an exact `baseRevision` match** and
   **rejects a stale or out-of-order frame without applying it** (then takes a fresh bounded snapshot); it never infers
   a base and never applies out of order. "Scalars are complete in every frame" is what makes the **content** of a
   frame order-independent once it has been accepted; it is not a licence to apply a frame whose base does not match.
7. **The window trim is authoritative and rides the frame, and it prunes the window — not the user's loaded
   history.** Two stores, never conflated: the **tail window** the server published, and the **prefix** of older pages
   the user loaded. Every advancing frame carries the new `oldestEntryId` and `hasMore` and the tail is pruned to
   exactly that window; entries it evicts that are **already on screen** **migrate into the prefix** when the prefix's
   newest id is contiguous with them (the known contiguous range is extended), so a later turn never deletes a turn the
   user is reading, and the rendered transcript is `prefix ∪ tail` by entry id. An append-only stream without the trim
   would grow the tail store past the window, and after more than 300 entries the delta state and the equivalent
   snapshot state would no longer be equal — so eviction is part of the delta vocabulary, the equality is a test
   property over the **tail window plus the scalars**, and the budget bounds a **fetch and the live projection**, never
   the total a user has loaded. A paged prefix lives **below** the window and is never merged back above it; only the
   prefix rule removes it (`!hasMore`, or a head-marker change).
8. **Gap policy: a fresh bounded snapshot, never replay.** The client settles outstanding turns **by request id**
   (the existing by-request read), which is the only way an outcome can be learned after a gap. The server keeps **no
   per-client delta state**: no cursor, no buffer, no ack, no epoch.
9. **Prefix validity is a history question, not an attachment question** — one pure function over ids and the two
   history facts, with the three outcomes (keep, truncate on overlap by **id**, drop on `!hasMore` or on a head-marker
   change). A new attachment must not discard loaded history; today it does, on every read and reconnect. Truncation is
   by **id against the published window**: an entry that has left the window leaves the **tail store** — and, when the
   user had already loaded it, it **migrates into the prefix** instead of being deleted, so a moving window never
   discards fetched history while the tail store still holds exactly the window.
10. **Deferred heavy content reuses the copied app's read blocks** (tool-result images, thinking), because the client
   half is already written and already handles loading, failure and retry. **Both read blocks are missing on the
   durable path today** (the routes 501), so they are part of this work rather than assumed: the design requires the
   actual per-entry route, and a deferred block must never be emitted without a route that serves it. The mime/size
   policy moves to `packages/protocol` as one wire policy instead of two web copies.
11. **What is not silently excluded.** A window never pretends to be the whole transcript: `hasMore` and
    `oldestEntryId` are real, and the newest entry plus the live partial are always present. When the newest entry
    itself cannot be brought inside the transport's limit even after deferral, the read answers with the **actionable
    error** of item 3 and the entry stays retrievable through its full-entry read — the window never drops it and never
    claims a bounded first load for content that is not bounded. `tree`/`deferMedia`/
    `deferThinking` shaping that has no durable producer stays absent **explicitly** (recorded as a limit) rather than
    being quietly dropped while the surface claims completeness.

### 2.3 Seams and tests for routes 2 and 3

- Seam: **one frame builder beside `project()`**, with one `projectEntry(entry)` expression shared by the baseline,
  every page and every delta append — so redaction (`safeEntry`) runs once per entry and no new surface can forget it.
- Seam: the adapter forwards the new frame kinds as themselves, exactly as it already forwards `submission` and
  `resync_required` rather than folding them, and translates the unchanged browser paging parameters onto the new
  paged read.
- Seam: the prefix function is **pure and public** (plain data in, plain data out) so it is unit-testable without a
  browser; the shared session reducer gains the same merge-not-replace rule so the SDK and the web app cannot disagree.
- Tests: the window contract (a long conversation yields ≤ 50 visible messages and ≤ the raw cap with `hasMore` true);
  paging round-trip (pages read backwards reproduce exactly the entry-id set of an unbounded read, and a page never
  crosses a head marker); delta/snapshot equality (folding deltas equals folding snapshots — a property test over a
  random commit sequence); a stale baseline yields a fresh snapshot and a **by-request** settlement; `historyRevision`
  stable across two reads, changed by an append, changed by a head marker, **equal after a backend restart**; redaction
  asserted identically on baseline, page and delta; the read blocks (unknown id 404, bad `blockIndex` 400, policy-refused
  image); a controlled benchmark asserting flat bytes-per-turn and bounded first load against lane B's recorded
  baseline, with the soft-target exceptions asserted as behaviour rather than as a hard byte ceiling.
- Every hold is a **named barrier**, never a sleep; every read that can stall is deadline-bounded.

---
## 3. Route 4 — SSH redundant call elimination and persistent helper/connection reuse

The concrete design is [`design-ssh.md`](design-ssh.md): §0 lists decisions D1–D12, §2 the filesystem session, §3 the
install/exec ControlMaster, §4 what is rejected, §5 the order, §6 the remaining uncertainty. This section states only
what the spec and the tickets need, and supersedes the earlier draft of this section.

### 3.1 What is true at the base

- Every non-snapshot file RPC pays two extra helper runs (`host`+`discover`) through `#readAuthorization`; a content
  read pays one more (`info`). The helper program is **51,176 bytes of base64 argv on every call**, and the install
  helper 25,388 bytes per call.
- Measured (local real-sshd fixture): ssh setup 146.6 ms, Python start 4.8 ms, helper load 13.2 ms, the request's own
  work 0.6 ms — 167.8 ms plain, 22.3 ms with ControlMaster, **2.3 ms/req** over one persistent stdin session. On the
  real link (~110 ms RTT): 946 ms plain, ~220 ms mux, and **the 51 KB payload alone costs 211 ms that ControlMaster
  does not touch**.
- What must stay per request for trust: the runner's `realpath + cd + pwd -P` root check (or its helper equivalent in a
  session) and the helper's per-operation `realpath` confinement, so a symlink swapped between two operations is still
  caught at the operation.
- The persistent-session shape is **already proven in this codebase**: `runner.open` is optional and documented as a
  named limit when absent, and the terminal helper reads stdin with a framed 1-byte-kind + 4-byte-length protocol over a
  long-lived session.
- **Deployment reality, stated so the two are not conflated.** The three other routes are **production failures measured
  on the deployed split topology**. This route is **latent in production**: the deployed gateway is **local** (no
  `HEPI_SSH*` in its env) and runs no SSH profile, so no live traffic exercises the per-RPC path — it is reachable
  through the SSH-project capability, not through anything the deployment does today. Every number in this section is
  therefore a **controlled measurement on the build host against the repository's real-sshd fixture**, not a production
  observation, and the route is fixed ahead of the deployment that would expose it.

### 3.2 Recommendation

**One mechanism per capability, both tracks in the same effort:**

- **Filesystem → one persistent helper session per `(profile, root)`** over the existing `runner.open`, running the
  same helper program with a request loop instead of a single dispatch ([`design-ssh.md`](design-ssh.md) §2). It
  removes the 51 KB payload, the interpreter start and the helper load at once, and it inherits the redundant-call
  elimination rather than requiring it first.
- **Redundant-call elimination, corrected (research §9).** The earlier "resolve the allow list lazily" idea is
  **withdrawn as unsafe**: resource locations live *inside* the workspace root (`<workspace>/.pi/skills`,
  `<workspace>/.agents/skills`, `<workspace>/.pi/prompts`, `<workspace>/.pi/SYSTEM.md`, …), so a *relative* path can
  name a resource location. Skipping authorization for "in-root" paths would stop refusing writes to in-project
  resources and would change the reported path of an in-root resource read. What replaces it:
  - **A0 — skip authorization where it is provably unused.** `createTempDir`/`createTempFile` call the helper with no
    allow argument today and have no mutation target, and `reader.close` returns before any helper call. Temp methods
    3 → 1 runs, `reader.close` 2 → 0, byte-identical behaviour.
  - **A1′ — fold `host` into `discover`** (one run instead of two), preserving the documented property that the
    locations reads are authorized against are the host's own answer, not a value the gateway supplied.
  - **A2 — fold the `info` pre-check into the read** at **contract parity**: the read modes report the same codes and
    the same messages `bounded()` produces today, so no caller-visible diagnostic changes.
  - **A3 (reuse `discover()` across requests) and A4 (serve the allow list from the committed snapshot) are rejected**:
    no invalidation signal exists at the gateway, and a TTL is not an invalidation policy. Authorization stays per
    request; the session re-parses `allow` per request frame.
- **Install and execution → one gateway-managed ControlMaster** ([`design-ssh.md`](design-ssh.md) §3), because those
  capabilities spawn one `ssh` per step and cannot ride the filesystem session. It is explicitly **not** stacked on the
  filesystem path and **not** applied to the terminal, which already holds one long-lived session.
- **User SSH configuration is preserved, with the scope of "override" stated exactly.** The gateway never passes
  `ControlMaster=no` and never edits or deletes anything under `~/.ssh`, so a user's own master may still exist and be
  used by the user's own interactive `ssh`, which keeps the `ControlPath` its own config gives it. What the gateway
  does is add explicit `-o` values **to the argv of the processes it spawns**: that overrides SSH configuration for
  **gateway-spawned** install/exec processes only, and it is the isolation that is wanted (the master is created with
  the profile's own identity and known-hosts files). Interactive SSH, the user's own masters and every other process are
  untouched. What is distinct and must not be conflated: **no gateway-managed master on the filesystem path** (the
  session is that capability's one reuse mechanism) versus **no stacking of two gateway-managed mechanisms on one
  capability**.

### 3.3 Seams and tests for route 4

- Seam: `SshFilesystem` keeps its interface and its confinement; the session lives behind its existing call boundary,
  so the transport's failure contract (timeout/abort/exit 255 → `outcome_unknown`, spawn error → `unreachable`, nothing
  retried) is preserved. The one new invariant the session adds to the shared framing is a **max frame length on both
  sides** ([`design-ssh.md`](design-ssh.md) §2.3), because the terminal's reader has no length bound.
- **Public acceptance criteria that must be stated as such** (they are user-visible contracts, not internals):
  - a request **queued but never written** fails locally (`aborted`, "the request was not sent") and is **never**
    reported `outcome_unknown`;
  - a request **dispatched whose response is lost** is `outcome_unknown` and is **never retried**;
  - a **write pins one session** from `write_begin` through `write_commit`/`write_abort`, so an idle-close or a
    cancellation cannot move a half-written file to another session, and a lost `write_commit` response is
    `outcome_unknown` even though the rename may have happened;
  - a session that dies while a request waits, or after its frame was written, produces exactly one of the two answers
    above — never a silent retry and never a fabricated success.
- Tests, against the real-sshd fixture the repository already has: helper runs per operation against the recorded
  baseline (and the corrected counts of research §9.4); confinement per operation including a symlink swapped between
  two operations; the queued-vs-dispatched failure split; write pinning; staging-file cleanup limited to files the live
  session created; `runner.open` absent → named `not_supported` with no second code path; the existing
  `ssh-filesystem`, `ssh-resources`, `ssh-workspaces`, `file-transfer-sshd` and `resource-snapshot` suites green.
- **Residue and diagnostics are limits, not open questions.** A session killed abnormally leaves its staging file and a
  later session must not sweep it (the file is not that session's; deletion by pattern can remove a concurrent writer's
  file). Existing temp-file visibility, directory listing and diagnostics are preserved unchanged — no filtering rule,
  no new wording and no cleanup subsystem is introduced. A gateway crash leaves a stale socket in the gateway's own
  per-instance directory, which is removed only when that instance closes its own sockets; nothing is deleted merely
  because a name or a pid looks dead.

---




---

## 4. One effort, four routes

No route is deferred: the user asked for all four in the same effort. The only ordering that exists is **dependency**,
not scope:

1. Route 1's heartbeat (1b) is independent and smallest — a comment frame at the two origin writers, forwarded
   untouched by the two proxies.
2. Route 1's accounting (A + C) depends on the terminal attachment seam, which route 2's frame work does not touch.
3. Routes 2 and 3 share the frame-builder seam and the two tokens; route 3's paged read is route 2's window seen from
   the cold side.
4. Route 4 is independent of all of the above (different process, different host) and can proceed in parallel.

Every route's validation is a **measured** reduction against a recorded baseline, not a claim.

---

## 5. What is left to decide

### 5.1 No genuine UX ambiguity remains

The items earlier drafts listed here are resolved without a user question:

1. **Old-history paging is already settled by the copied surface.** The preserved pi-web context route
   (`apps/web/vendor/pi-web/app/api/sessions/[id]/context/route.ts`) already takes `tail` (default 50, capped at 1000)
   and `before` (rewind the ancestor walk so an older page can be prepended without re-fetching the branch), and the
   copied client already pages on top of it (`apps/web/lib/chat-lazy-load.ts`: `VISIBLE_PAGE_SIZE = 50`,
   `getVisibleRenderWindow`, `getNextVisibleCount`). Route 3 therefore **follows the existing behavior** rather than
   inventing one. Not a new product question, and not asked again.
2. **A reattach outside the retained 128 KiB terminal tail clears the screen today** (`reset: true` →
   `terminal.reset()`). Current behavior is preserved as-is; a short explanatory label is harmless presentational
   judgment, not a user decision.
3. **A compaction/reset moving the head marker and the loaded prefix.** Resolved the native-first way: a new head marker
   is a **re-baseline**, so the window is replaced from the marker and the prefix is dropped, matching what the model
   can see and what the current projection already implies. The wire still carries `historyHead`, so a different
   presentation would not need a wire change. No user question.
4. **SSH residue and diagnostics.** Existing temp-file visibility, directory listing and diagnostics are preserved
   unchanged; a session killed abnormally leaves its staging file and a later session must not sweep it. A gateway crash
   leaves a stale socket in the gateway's own per-instance directory, removed only when that instance closes its own
   sockets — nothing is deleted because a name or a pid looks dead. The **first-request latency after an idle close**
   is a measured cost, not a user choice; the idle value is derived and would change only on evidence.

Every remaining engineering choice is decided in this memo, in [`design-history.md`](design-history.md) §1 (D1–D10) and
in [`design-ssh.md`](design-ssh.md) §0 (D1–D12) with reasons. The hierarchy means *durable-first, native-first, use
judgment* — not asking the user about mechanics.

### 5.2 Approval asked for — one combined decision

The design, the seams, the acceptance criteria and the ticket granularity are presented together as
[`spec.md`](spec.md) and [`ticket-proposal.md`](ticket-proposal.md). The user's single combined approval covers all
four at once: there is no separate abstract-seam approval and no second approval for ticket granularity. In summary,
per route:

- **route 1:** the acquisition predicate inside `CompletionDelivery`; a terminal fan-in seam holding per-session
  cursors with mounted == attached; heartbeat comment frames written at the two origin writers and passed through
  untouched by the proxies; the count-and-behavior e2e with terminals in the count plus the 4-held control.
- **routes 2–3:** one frame builder beside `project()` with one shared `projectEntry`; a delta frame on the existing
  conversation stream with `baseRevision` as the continuity guard and every scalar full; `(projectionId, revision)` as
  identity and a separate public-primitive-derived `historyRevision` for prefix validity; a fresh bounded snapshot for
  any uncontinuable baseline with by-request settlement; the bounded window with entry-id pages on demand; the two
  per-entry read blocks that make deferral real.
- **route 4:** the persistent filesystem helper session (D1–D10 of [`design-ssh.md`](design-ssh.md)) including the
  corrected redundant-call elimination (A0/A1′/A2, with the unsafe lazy-authorization idea withdrawn), and one
  gateway-managed ControlMaster for install/exec (D11–D12) whose explicit `-o` values override SSH config for
  gateway-spawned processes only, leaving interactive SSH and the user's own masters untouched.

**Approved 2026-10-13.** The spec and its tickets are published; product code changes only through those tickets on
`integration/perf-follow-up`.

---

## 6. Evidence

- Scope decisions and hierarchy: [`decisions.md`](decisions.md).
- Concrete designs: [`design-history.md`](design-history.md) (window contract, wire, prefix algorithm, read blocks,
  public seams, benchmark) and [`design-ssh.md`](design-ssh.md) (session, ControlMaster, decisions D1–D12).
- Research: [`research/sse-connection-budget.md`](research/sse-connection-budget.md) (pool, source inventory, 501
  behavior, what a budget can guarantee, constraints for terminal tests),
  [`research/incremental-state-frames.md`](research/incremental-state-frames.md) (wire, native delta primitives,
  baseline identity, gap policy),
  [`research/ssh-helper-reuse.md`](research/ssh-helper-reuse.md) (per-RPC cost, confinement, reusable/per-call
  classification, the corrected Track A counts, OpenSSH sources).
- Lane records were pinned to the sibling worktrees and revisions that produced them (`.dev/worktrees/perf-lane-c`
  `perf/lane-c` at `cb4494b`, `.dev/worktrees/perf-lane-b` `perf/lane-b` at `cb4494b`, and
  `.dev/worktrees/chat-lifecycle-integration` `integration/chat-lifecycle` at `b9b28dd`); those worktrees are not part
  of this checkout, so the records are named for provenance rather than linked. The retained findings are the research
  notes above, and the in-repo terminal-in-pool evidence is [`evidence/README.md`](evidence/README.md) with
  [`evidence/terminal-pool-probe.json`](evidence/terminal-pool-probe.json).
- Code cited: `apps/server/src/{server.ts,terminal-relay.ts,session-search.ts}`;
  `apps/web/adapters/{durable-api,terminal}.ts`; `apps/web/components/{AppShell,TerminalPanel,ChatWindow,MessageView}.tsx`;
  `apps/web/lib/{agent-event-connection,agent-event-stream,completion-delivery,lifecycle-projection,chat-lazy-load,session-reader,http-dispatcher}.ts`;
  `packages/gateway/src/{terminal,index,ssh-filesystem,runner,install}.ts`;
  `packages/{protocol,session}/src/index.ts`; `undici@8.10.2/lib/dispatcher/client.js`.
- Governing decisions: ADR 0007, ADR 0006, `docs/chat.md` (see the links in `decisions.md`).
