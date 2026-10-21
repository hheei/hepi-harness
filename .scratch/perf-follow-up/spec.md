# Spec — performance follow-up: SSE efficiency, bounded history with deltas, SSH reuse

**Status: APPROVED 2026-10-13** — the user approved this spec in full with the instruction "implement spec". Design, seams,
acceptance criteria and ticket granularity were approved as one combined decision. Implementation tickets are published
under [`issues/`](issues/) as `ready-for-agent`; the integration branch is `integration/perf-follow-up`.

Base: `integration/chat-lifecycle` = `b9b28dd` (`b9b28dda040d09aa7472514726e5ec6d1d7d0bb5`); production branch
`deploy/cb4494b0` is the same code (`cb4494b` differs in `docs/` only). Every measurement cited was taken at that
revision and is kept where it was produced, pinned by worktree.

Design inputs (read-only, already written): [`decisions.md`](decisions.md) (scope, attribution, hierarchy),
[`DESIGN-memo.md`](DESIGN-memo.md) (options and recommendations per route),
[`design-history.md`](design-history.md) (window contract, wire, prefix algorithm, read blocks, seams, benchmark),
[`design-ssh.md`](design-ssh.md) (session and ControlMaster decisions D1–D12), and the three research notes under
[`research/`](research/sse-connection-budget.md).

---

## Problem Statement

Four performance failures are in scope. Three are **production failures, measured on the deployed split topology** —
the connection exhaustion, the whole-transcript re-send per turn, and the full-history read with inert paging. The
fourth, the SSH per-call cost, is **latent in production**: the deployed gateway is local and runs no SSH profile, so no
live traffic exercises that path. Its numbers come from a **controlled measurement** against the repository's real-sshd
fixture on the build host, and the route is fixed ahead of the deployment that would expose it. Nothing below is
inferred, and every number names the surface it was measured on.

1. **The page runs out of browser connections.** The Web UI is served over HTTP/1.1, so the browser allows six
   connections per origin. The page holds one stream per conversation with a live interest, one per **mounted terminal
   tab** (even when the terminal panel is closed), and it is the count across **both** kinds that matters. Measured with
   no application code at all: five same-origin streams leave an ordinary read settling in 4 ms, **six exhaust the
   pool** and the read never settles. With the real app at six held runs the composer is unreachable, nine to eleven
   requests stay pending, and a session switch times out at 40 s — while the same read outside the page's pool answers
   in 5 ms, proving the backend is healthy and the browser is the limit. The terminal half is measured too, on the
   prebuilt app with the fixture's own controlled completions endpoint: **4 conversations (1 selected + 3 running) plus
   2 restored terminal tabs = 6 held sources, and the page's own ordinary read misses a 3000 ms deadline — with the
   right panel open and with it closed**, because a closed panel still spends connections; one terminal tab (5 held)
   and the same read settles in 46 ms. Idle streams are also torn down after roughly 300 s by a transport **idle**
   default on the server-to-backend hop, so the page silently re-baselines.
2. **Every turn re-sends the whole transcript.** One publication sends the entire replacement projection to every
   attached client. Measured in-process: 5,524 → 26,152 → 76,575 → 152,175 bytes per turn from 10 to 60 turns, largest
   single frame 30.5 kB; the same object is up to 4.78 MB over HTTP and 4.71 MB as the initial stream frame.
3. **A long conversation is loaded whole, every time, and its paging is inert.** The initial read, the reconnect read
   and the state frame all carry the full transcript; the paging UI sends `before`/`tail` that the durable adapter
   never reads, so `hasMore` is hardcoded false, the paged prefix is discarded on every read, and the view cache never
   fills. A reconnect mid-run therefore re-downloads everything and throws away history the user already had on screen.
4. **A remote filesystem operation pays for setup it does not need, every time.** Each non-snapshot file RPC runs the
   remote helper two extra times for authorization and once more for a size pre-check; the helper program is 51,176
   bytes of base64 argv on **every** call. Measured on a real link: ~946 ms per call plain, ~220 ms with connection
   multiplexing — and the 51 KB payload alone is ~211 ms that multiplexing does not touch.

## Solution

Fix the four at their owning seams, in one effort, without adding a second lifecycle anywhere:

1. **A global, countable stream budget.** Background conversation watches acquire a stream only when a slot is free
   (deferred acquisition, no timers, no scheduler), the selected conversation is never deferred, and **one terminal
   fan-in stream** replaces one stream per mounted terminal tab while keeping every mounted tab's shell attached for
   exactly as long as the tab exists — which is what the product already does, made cheap and countable. Keepalive
   comment frames written at the two origin writers (backend conversation stream, gateway terminal stream) keep every
   hop's **idle** bound from killing a quiet stream; the proxies pass them through and never inject one.
2. **Incremental state frames.** The stream keeps one baseline frame per attachment and then sends **projected**
   append-only deltas (`baseRevision` continuity guard, every scalar full) **together with the window's bookkeeping**,
   so the client's **window** is exactly the server's window — the authoritative trim rides every advancing frame and
   prunes the **tail store** to it, while history the user already paged in is held in a separate **prefix store** and
   is never pruned by a moving window. A head-marker change is a re-baseline. Any baseline the client cannot
   continue is answered with a **fresh bounded snapshot**, never a replay, and outstanding turns settle **by request
   id**.
3. **Bounded history with real paging.** The baseline read, the stream's first frame and `GET /state` carry the newest
   **window** (50 visible messages, raw-entry cap) with `hasMore` and the window's oldest id; older history is served by
   **entry-id pages** on a native bounded scan; the paged prefix survives a reconnect by **id** comparison; the two
   per-entry read blocks (tool-result images, thinking) are implemented so deferral restores exactly what it removed.
4. **SSH reuse.** The filesystem capability runs the helper as **one persistent session** per `(profile, root)` over
   the existing `runner.open` framing, which removes the 51 KB payload, the interpreter start and the helper load at
   once, and inherits the corrected redundant-call elimination (skip authorization where it is provably unused; fold
   `host` into `discover`; fold the size pre-check into the read at contract parity). Install and execution get one
   **gateway-managed ControlMaster** in a gateway-owned socket directory, keyed on the full connection profile, never
   overriding the user's own SSH configuration.

## User Stories

1. As a user with several conversations running, I want the page to stay responsive, so that I can read and send
   messages without the UI stalling while background work continues.
2. As a user with terminal tabs open, I want my shells to keep running while I use the chat, so that a long build or
   server is not killed by the UI's connection limit.
3. As a user, I want the terminal panel closed or on another tab to cost less than one connection per tab, so that
   having had terminals open does not degrade the chat.
4. As a user who reloads the page, I want my restored terminal tabs to attach to the same shells, so that a reload does
   not lose running work.
5. As a user, I want a completion notice for a background run that finished while I was elsewhere, so that I do not
   miss an answer.
6. As a user, I want at most one notice and one sound per answer, so that a reconnect or a duplicate stream cannot
   double-notify me.
7. As a user, I want the unread marker to be right even for a run that started and ended between two polls, so that I
   can trust the sidebar.
8. As a user, I want a quiet stream to stay connected instead of silently reconnecting every few minutes, so that
   nothing re-baselines behind my back.
9. As a user in a long conversation, I want each turn to cost roughly the same as the first, so that turn 200 does not
   feel slower than turn 10.
10. As a user opening a long conversation, I want the newest messages immediately, so that I can read and reply without
    waiting for the whole transcript.
11. As a user scrolling up, I want older messages to load as I reach them, so that history is available without a
    full-transcript download.
12. As a user, I want the transcript I have already loaded to survive a reconnect, so that a dropped stream does not
    discard what I was reading.
13. As a user, I want the first load of a long conversation to be bounded, so that opening a 200-turn conversation does
    not download megabytes.
14. As a user, I want thinking text and tool-result images to load when I expand them, so that the initial payload stays
    small without losing content I can still read.
15. As a user, I want a deferred block to always be retrievable, so that "load more" never leads to an error page.
16. As a user, I want an oversized item to be shown rather than silently dropped, so that I never believe I have seen
    the whole transcript when I have not.
17. As a user, I want to be told when something genuinely could not be delivered, so that I can retry instead of
    watching a spinner forever.
18. As a user, I want search hits, fork points and the minimap to work for messages that are not currently loaded, so
    that paging does not break those features.
19. As a user, I want a fork to work from any message id, so that I can branch from history I have not scrolled to.
20. As a user, I want a search hit to open at the right message, so that paging and search agree.
21. As a user, I want the transcript on screen to match what the model can see after a compaction, so that I am not
    asking about messages the model no longer has.
22. As a user of the session SDK, I want a snapshot to merge into what I already hold, so that a long-lived session does
    not lose its earlier entries.
23. As a user, I want credentials never to appear in any frame, so that redaction holds on the baseline, on a page and
    on an incremental frame alike.
24. As a user, I want a stream that cannot be continued to recover by itself, so that a stale client does not hang.
25. As a user, I want a turn whose outcome I cannot observe to be resolved by asking about that specific request, so
    that I learn the real answer instead of guessing.
26. As a user of a remote workspace, I want file reads and writes to be fast, so that browsing a remote project does not
    take a second per operation.
27. As a user, I want remote operations to keep the same safety guarantees, so that confinement and write refusal do not
    weaken because the transport got faster.
28. As a user, I want an operation that was never sent to be reported as not sent, so that I do not chase a phantom
    remote failure.
29. As a user, I want an operation whose response was lost to be reported as unknown and never retried, so that a write
    is never silently applied twice.
30. As a user, I want a multi-part write to stay on one session, so that a half-written file cannot be finished on a
    different connection.
31. As a user, I want installation and command execution over SSH to stop paying a fresh handshake per step, so that
    publishing a skill directory is not dominated by transport setup.
32. As a user, I want my own SSH configuration and masters to keep working, so that the gateway's optimization does not
    change my interactive SSH.
33. As a user, I want a gateway restart to leave nothing behind that the gateway would delete on its own initiative, so
    that cleanup never removes something it does not own.
34. As a user, I want the same behaviour whether or not my host supports the optimization, so that an unsupported host
    reports a named limit instead of degrading silently.
35. As an operator, I want deployment notes to name roles, not hosts, so that a published record carries no personal
    fact.
36. As an operator, I want the gateway's socket directory to be owned and mode-checked, so that multiplexing cannot be
    hijacked.
37. As a reviewer, I want each change validated against a recorded baseline, so that "faster" is a measurement, not a
    claim.
38. As a reviewer, I want a deterministic red test for each behaviour before the fix, so that the change is proven to
    address a real symptom.
39. As a reviewer, I want the acceptance criteria to be public behaviour at an HTTP route, a pure function or a
    rendered surface, so that tests do not encode internals.
40. As a maintainer, I want one projection expression shared by baseline, page and delta, so that redaction and entry
    shape cannot drift between surfaces.
41. As a user in a long conversation, I want the window to keep moving as turns arrive, so that the transcript does not
    stop updating once it reaches its size limit.
42. As a user, I want the current window to be exactly what the server published and what the model can see, so that I
    never keep a window entry the server dropped; and I want history I already paged in to stay readable, so that a
    moving window does not delete what I loaded — only a compaction or reset, which moves the head marker, ends that
    context.
43. As a user, I want a frame I cannot continue to be refused rather than half-applied, so that my transcript cannot
    drift out of order or silently lose a turn.

## Implementation Decisions

**Route 1 — connections**

- The acquisition predicate lives inside `CompletionDelivery` (the module that already owns "which conversations are
  watched" and the single source per conversation). An over-budget watch keeps its projection and its `nominated` flag
  and acquires on the next reconsider; there is no timer and no scheduler.
- The count is global: `1 (selected conversation) + 1 (terminal fan-in, only while a terminal tab is mounted) +
  background watches + 2 (HTTP headroom) ≤ 6`, so the background budget is 2 with a terminal tab mounted and 3 without.
  The arithmetic is derived from the pool and the terminal invariants, not assumed.
- A **terminal fan-in** seam owns terminal attachment: one stream per page, per-session cursors, and an attachment held
  for exactly as long as the tab is mounted (mounted == attached). The panel keeps its terminal widget and its writer
  and stops owning transport. Existing lease, replay-cap and `reset` semantics are unchanged; a hidden tab keeps its
  shell, as today.
- Heartbeat comment frames (`:\n\n`, ~30 s, reusing the existing interval shape) are written **only** where frame
  boundaries are owned: the backend conversation stream and the gateway terminal stream. The Web adapters forward them
  and never inject one — a proxy that appends bytes mid-frame can corrupt a payload. The bound being defended is the
  transport's **idle** bound; a per-call total-duration timeout is a different bound and is not a substitute.
- The process-global HTTP dispatcher stays unwired for this effort (it is imported by nothing and its default is the
  value the heartbeat must stay under).

**Routes 2–3 — history and deltas**

- One frame builder beside `project()`, with a single `projectEntry(entry)` used by the baseline, every page and every
  delta append, so `safeEntry` runs once per entry and no surface can forget it.
- Window: 50 visible messages (user, assistant, compaction) with a raw-entry cap `max(200, 6 × visible)`; both are
  server-side constants, never wire fields.
- Budget: a **soft target with explicit exceptions**. Deferral of heavy content first (lossless), then shrink the window
  from the oldest end by whole entries; the newest entry and the live partial are never dropped; an entry whose own
  content cannot be deferred ships whole and is recorded as a limit; a frame that would still exceed the transport's own
  limit produces an **actionable error** for that read, never an endless `resync_required` loop.
- Two tokens, two jobs: `(projectionId, revision)` keeps its ADR 0007 meaning (attachment identity and its publication
  counter); a separate `historyRevision` derived from **public** native primitives (conversation, head marker, tail)
  answers "may I keep the paged prefix" and survives a backend restart. `historyHead` travels with it. No private
  native import: where a needed fact is not exported, the route is upstream's documented surface or a committed request
  to it.
- Delta frames: `baseRevision` = the previous revision, `appended: ServerEntry[]` **plus the window bookkeeping**
  (`oldestEntryId`, `hasMore`), and **every scalar full in every frame**. **Publication is serialized by the one owner of
  the revision**, so a frame is emitted only from a serialized publication and `baseRevision` is exactly the client's
  current revision. The client **applies a frame only when `baseRevision` matches exactly**; a stale or out-of-order
  frame is **rejected without being applied**, and a gap takes a fresh bounded snapshot. There is never an out-of-order
  apply and never an inferred base. A head-marker change carries the whole window instead of `appended` — a
  re-baseline.
- Gap: a fresh bounded snapshot, then `resync_required`; the client settles by **request id** through the existing
  by-request read. No per-client server state: no cursor, buffer, ack or epoch.
- Paging: `GET /api/conversations/:id/entries?before=<id>&tail=<n>`, `before` exclusive, bounded below by the newest
  head marker at or before it, same count rule, same budget, same `projectEntry`. The browser's existing
  `before`/`tail` parameters and `hasMore`/`oldestEntryId` consumption are unchanged; the adapter translates.
- **Window trim is authoritative and rides the frame — over the window, not over the user's loaded history.** Every
  frame that advances the window carries the new `oldestEntryId` and `hasMore`. Two stores, two rules, and they are
  never conflated: the **tail store** is the current window and is pruned to exactly the frame's window; the **prefix
  store** is the older history the user paged in (the prefix rule owns it) and window eviction never prunes it. The
  rendered transcript is the union of the two by entry id. When an advancing frame would evict tail entries that are **already on
  screen** and the prefix's newest id is contiguous with them, those entries **migrate into the prefix** — the known
  contiguous range is extended — instead of being deleted, so a turn the user is reading is not removed by a later turn
  arriving. Without the trim, an append-only delta stream lets the tail store grow past the server's window and after
  more than 300 entries the delta state and the equivalent snapshot state stop being equal; without the migration, the
  fix for that would silently delete fetched data. Eviction is therefore part of the delta vocabulary, not a
  client-side convenience. The equality is a test property (below) asserted over the **tail window plus the scalars**,
  and the budget bounds a **fetch and the live projection** — baseline, page, delta frame — with **no claim** about the
  total history a client has loaded.
- Prefix validity is one **pure function** over ids and the two history facts (keep, truncate on overlap by id, drop on
  `!hasMore` or head-marker change), and the shared session reducer gains the same merge-not-replace rule.
- Read blocks: per-entry routes for thinking text and tool-result images, with the copied app's URL shape and notice
  text, and one mime/size policy in `packages/protocol` instead of two web copies. Deferral is applied for history
  entries (not the live partial) and a deferred block is never emitted without a route that serves it.
- What is not silently excluded: `hasMore` and `oldestEntryId` are real, the newest entry and live partial are always
  present, and payload shaping with no durable producer (`tree`, `deferMedia`) stays explicitly absent and recorded
  rather than quietly dropped.

**Route 4 — SSH**

- Filesystem: one persistent helper session per `(profile, root)` over the existing `runner.open`, running the same
  helper program with a request loop; `allow` and `root` travel per request and confinement runs per operation; exactly
  one request in flight with waiters bounded by the request's own deadline; two failure classes (queued-but-never-written
  → `aborted`, dispatched-and-lost → `outcome_unknown`, never retried); a write pins one session from `write_begin` to
  `write_commit`/`write_abort`; staging cleanup removes only files the live session created; teardown/idle values are the
  codebase's existing session values; `runner.open` absent is a named `not_supported` with no second code path.
- The one new invariant in the shared framing is a **max frame length on both sides** (request and response), because
  the terminal's reader has no length bound. The engineering cap is what it is; the **existing tighter file and snapshot
  limits remain the effective ones** for content.
- Redundant-call elimination: skip authorization where it is provably unused (temp-dir/temp-file creation, reader close);
  fold `host` into `discover`; fold the size pre-check into the read at message parity. The earlier "lazy
  authorization for in-root paths" idea is **withdrawn as unsafe** — resource locations live inside the workspace root,
  so it would stop refusing writes to in-project resources and change a reported path.
- Install and execution: one gateway-managed ControlMaster in a gateway-owned, mode-checked socket directory, keyed on
  the full connection profile (never `%C` alone), created before first use, reaped with `ssh -O exit` on gateway close.
  No gateway-managed master on the filesystem path (the session is that capability's one reuse mechanism), and no
  stacking of two gateway-managed mechanisms on one capability. The gateway never passes `ControlMaster=no` and never
  touches a socket or a file under the user's `~/.ssh`: the user's own configuration and masters keep working. Cleanup
  is limited to sockets this gateway instance created — nothing is deleted because a name or a pid looks dead; a crash
  leaves residue that is recorded as a limit.
- Terminal transport is untouched.

## Testing Decisions

A good test here exercises **public behaviour**: an HTTP route, a pure function, or a rendered surface. No test asserts
an internal counter, a private field, or a timing constant that is not itself the behaviour under test.

- **Unit, deterministic (no browser, no sleeps):** **delta-vs-snapshot equality after eviction** — fold a commit
  sequence of more than 300 entries both ways (baseline plus deltas, and snapshots only) and assert the two states are
  equal, which is the assertion an append-only-without-eviction design fails; **frame gating** — a frame whose
  `baseRevision` is not the current revision (stale and out-of-order both) is not applied, a matching frame is applied
  exactly once, and eviction prunes the tail window to exactly the entries at or above `oldestEntryId` while
  migrating already-visible evicted entries into the prefix; the acquisition rule (at most the budget in background sources, the
  selected source never given up, an over-budget nomination acquires when a slot frees and is claimed exactly once);
  the prefix function (keep, truncate on overlap by id, drop on `!hasMore`, drop on head change, keep across an
  identity change); the lifecycle fold's five delta rules including "delta and equivalent snapshot fold to the same
  core"; the shared reducer's merge-not-replace; the mime/size policy.
- **Server HTTP (`pnpm test:server`):** the window contract on a long and a short conversation; paging round-trip
  (pages read backwards reproduce exactly the entry-id set of an unbounded read, and a page never crosses a head
  marker); delta rules (`baseRevision` contiguity, scalar-only frame with `appended: []`, compaction as a
  re-baseline, stale baseline → snapshot + `resync_required` with no replay); `historyRevision` stability across two
  reads, an append, a head marker, two attachments, and **a backend restart on the same store**; redaction asserted
  identically on baseline, page and delta; the per-entry read blocks (unknown id 404, bad block index 400,
  policy-refused image refused); the transport limit producing an **actionable error** rather than a resync loop.
- **Web unit (`pnpm test:web:unit`):** the adapter translates `before`/`tail` onto the paged route and fills
  `hasMore`; `get_state`/`get_tools` still issue exactly one bounded read.
- **E2E (Playwright, named barriers, no sleeps):** the connection budget end to end — real mounted terminal tabs plus
  held chat runs, asserting the observed OPEN count, composer readiness, a switch deadline and an in-page read
  settling, plus the 4-held control with no terminals that must pass today; and a terminal-still-works assertion
  (keystrokes echo, a hidden tab's shell is the same session afterwards, a reattach inside the retained tail does not
  reset). The heartbeat test runs against a **shortened, controlled idle bound with the clock advanced by event
  barriers** — never a real five-minute wait.
- **Gateway, against the real-sshd fixture the repository already has:** helper runs per operation against the recorded
  baseline and the corrected counts; confinement per operation including a symlink swapped between two operations; the
  queued-vs-dispatched failure split; write pinning; cleanup limited to the session's own staging files; `open` absent →
  named `not_supported`; the existing `ssh-filesystem`, `ssh-resources`, `ssh-workspaces`, `file-transfer-sshd`,
  `resource-snapshot` suites green.
- **Benchmark (in-process, faux provider, no paid calls, build host or CI only):** the history scaling script asserting
  flat bytes-per-turn and a bounded first load against lane B's recorded numbers, with the soft-target exceptions
  asserted as behaviour rather than as a hard byte ceiling; and the SSH helper-layer measurement re-run to confirm the
  session's reduction.
- Prior art to follow: the lane C budget e2e (`apps/web/e2e/perf-lane-c-sse-budget.mjs`: held resolvers, bounded reads,
  per-source `readyState` recording), the terminal-in-pool evidence fixture and driver
  ([`evidence/`](evidence/README.md), the measurement behind research §15: real backend plus real local gateway, restored
  tabs, held runs, a deadline-raced in-page read), the lane B in-process harness, the bwrap real-sshd fixture, and the
  existing lifecycle-projection and completion-delivery unit suites.

## Out of Scope

- Any change to the durable runtime's authority, ADR 0006/0007 semantics, or the terminal's lease/replay/reconnect
  behavior.
- HTTP/2 termination and an application-level multiplexed conversation endpoint: recorded options, not adopted here.
  The terminal fan-in is the one new transport this spec adds, and it carries terminal frames only.
- A server-side per-conversation window cache, a stored history epoch, a hash of the transcript, or any per-client
  delta buffer.
- Authorization caching (no TTL, no reuse of `discover()` across requests) and serving the allow list from the
  committed snapshot.
- ControlMaster on the filesystem path, the terminal path, or stacked under the filesystem session.
- Sweeping orphaned staging files, filtering them out of listings, or any new cleanup subsystem.
- Payload shaping with no durable producer (`tree`/`deferMedia`) and the branch navigator's data.
- A read block for oversized **text** tool output: recorded as a limit; such an entry ships whole.
- Paid model calls in any verification, and any build or compile on the runtime host.
- **Compatibility code for historical persisted data or wire formats.** The app supports the **new canonical format
  only**: no runtime fallback, no dual read, no format-detecting adapter. A persisted record that the new format cannot
  read is converted **once**, by a script run on the remote host against a backup, with a dry run first — not by the
  running app. This does not restrict the functional contract: normal pagination, retention of an explicitly loaded
  prefix, tail migration, reconnect, and native compaction are behaviour, not compatibility. Where a boundary is
  required and unknown, the answer is a resync — never a guess at an older shape.

## Further Notes

- The four routes are independent in scope; the only ordering is dependency (heartbeat and the two SSH tracks can start
  immediately; the delta work sits on the bounded window; the integration ticket closes the effort).
- Two research claims are **withdrawn or corrected** in the designs and must not reappear in tickets: "resolve the allow
  list lazily for in-root paths" (unsafe) and "the frame budget is a hard 512 KiB bound" (soft target with explicit
  exceptions).
- The red pair already built in the `perf-lane-c` worktree (unit budget test plus the assert-mode e2e) is the harness
  for route 1; its arithmetic is replaced by the derived counts above.
- The terminal-in-pool measurement behind route 1 is anchored to worktree `perf-lane-c`, revision
  `cb4494b0b4429bda1d9940257f661239171ce502`, prebuilt `.next/BUILD_ID = vRBY79KO3pFNmp2MFtFCX`, node `v26.5.1` and
  HTTP/1.1, with 7 checks and 0 failures and **nothing rebuilt or deployed**. Its limits travel with it and must not be
  over-claimed in a ticket: the terminal tabs are **restored from storage** rather than clicked open, the sessions are
  created out-of-band through the backend relay, it is **one fixture, one browser (Chromium), one Next build**, it says
  nothing about HTTP/2, and it **does not exercise the 120 s detached-session lease** — a ticket that needs that lease
  behaviour must test it separately with a short configured window.
- Published documents name hosts by **role** (build host, runtime host, client host) and paths by placeholder. The
  working notes under `.scratch/` may cite the actual hosts where a measurement requires it; nothing personal goes into
  a commit.
- The frame-budget wording is coherent across all four documents: `design-history.md` D11, §2.3, §7.2 item 4 and §10
  check 3 state the same **soft target with explicit exceptions** as this spec, `DESIGN-memo.md` §2.2 item 3 and
  `decisions.md` §3.1 item 2. If the design's author lands a later copy of `design-history.md`, it must keep that
  wording; a copy that restores a hard bound reopens the item.
- Every validation is tied to the tested revision and date, and the deployment guide is updated in the same change.
