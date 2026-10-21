# perf-follow-up — scope decisions, attribution and hierarchy

Read-only design. No code change, no production write, no restart, no paid call. This file records **scope,
attribution, corrections and hierarchy**; the concrete options are in [`DESIGN-memo.md`](DESIGN-memo.md), the two
detailed designs in [`design-history.md`](design-history.md) and [`design-ssh.md`](design-ssh.md), and the
**approved** [`spec.md`](spec.md) with its published tickets under [`issues/`](issues/).

## 1. Revisions — what "current" means

| tree | revision | role |
| --- | --- | --- |
| `.dev/worktrees/chat-lifecycle-integration` (`integration/chat-lifecycle`) | `b9b28dd` | **intended integration base** for this effort |
| production branch `deploy/cb4494b0` | `b9b28dd` | production code; `cb4494b` is its ancestor and `git diff --stat cb4494b b9b28dd` is `docs/` only, so the code is identical |
| repository root checkout (`impl/capability-11`) | `fa495b4` | **unrelated** capability line — predates ADR 0007, has no `projectionId`, no `CompletionDelivery`, no acquisition fence. Never read it as "current" |
| `.dev/worktrees/perf-lane-c` (`perf/lane-c`) | `cb4494b` | where the lane C measurements and the red pair live |
| `.dev/worktrees/perf-lane-b` (`perf/lane-b`) | `cb4494b` | where the SSH layer measurements live |
| `.dev/worktrees/perf-follow-up` (`integration/perf-follow-up`) | `b9b28dd` | the isolated design tree this effort's documents are copied into; **no product change** |

Every code citation in the research notes is valid for both `b9b28dd` and `cb4494b`. Every measurement is cited where
it was produced and pinned to that worktree and revision — evidence is cited, never moved or re-derived.

## 2. Scope decisions (user-taken)

The user approved **one effort** with four in-scope routes, together, with no deferral:

1. **SSE connection efficiency** — the browser's HTTP/1.1 per-origin budget (6) versus the page's live streams.
2. **Incremental state frames** — the conversation stream re-sends a whole replacement projection per advance.
3. **Initial and reconnect large-history loading** — the cold/reconnect read and the first frame of a long transcript.
4. **SSH redundant call elimination plus persistent helper/connection reuse** — remove the per-RPC redundant resolution
   *and* reuse the connection/helper.

Also user-taken:

- **New endpoint / multiplexing is not prohibited.** The lane C memo's non-goal ("No endpoint, no protocol, no ADR
  change") and its invariant `I10` are the **memo's own recommendation, not a user decision**, and the user has not
  rejected multiplexing. The terminal fan-in in this design is a new endpoint precisely because of that. Never write
  "multiplex is rejected".
- **One combined approval, not two — done.** Design, seams, acceptance criteria and the breakdown were presented
  together ([`spec.md`](spec.md), [`ticket-proposal.md`](ticket-proposal.md)) and approved in a single decision.
- **Implementation starts now, per the user's instruction.** The spec is approved and the tickets are published under
  [`issues/`](issues/) as `ready-for-agent`; the source at `b9b28dd` changes only through those tickets on
  `integration/perf-follow-up`.
- **The lane C pair is input, not this effort's spec**
  (`.dev/worktrees/perf-lane-c/.scratch/perf-c-sse-budget/{spec.md,issues/01-background-stream-budget.md}`): its
  arithmetic assumed no terminal streams (§6). It is superseded by ticket 2.

## 3. Attribution — who found what, and what has been corrected

- **"Every mounted terminal tab holds its own SSE even when hidden" is a researcher finding (agent96), not a user
  finding.** It is a fact about the base: `AppShell` renders the right panel unconditionally and maps every terminal
  tab, and `TerminalPanel`'s stream effect has no visibility guard, so a mounted tab holds a source while the panel is
  closed and while the tab is not active. Confirmed by code inspection and by a controlled probe.
- **"Suspending a hidden terminal's stream kills its shell" is a researched invariant of the current code, not a user
  statement.** `TERMINAL_RECONNECT_MS = 120_000` (`packages/gateway/src/terminal.ts:29`): a session with no attached
  caller is closed when that window runs out (`#renew` `:668`, `#expire` `:682`), and the relay cancels the host
  request with the caller's own connection (`apps/server/src/terminal-relay.ts`), so an abandoned request cannot keep a
  shell alive. `TERMINAL_REPLAY_CHARS = 128 * 1024` (`:28`) bounds what a reattaching caller can be shown, and a
  caller behind that tail is answered with `reset: true`, which makes the panel clear its screen
  (`TerminalPanel.tsx:127-131`). The user did not assert this; the code does.
- **Technical choices are agent-resolvable, not user-only.** Fan-in versus an explicit lease mechanism, the budget
  arithmetic, whether the selected conversation counts as a constant 1, the delta baseline and vocabulary, the gap
  policy, the prefix rule and the SSH track order are engineering decisions. They are **decided in the designs with
  reasons**; the hierarchy in §4 means *native-first, durable-first, use judgment*, not *ask the user about mechanics*.
- **Preserving today's terminal behavior needs no new user decision.** Every mounted terminal tab keeping its shell
  running is what the product already does. The design preserves it and makes it explicit and cheap (mounted ==
  attached through the fan-in) rather than implicit and expensive (one stream per tab).

### 3.1 Withdrawn or corrected claims

Two earlier claims were **wrong and are withdrawn**; neither may reappear in a ticket.

1. **"Resolve the allow list lazily for in-root paths" — withdrawn as unsafe.** Resource locations live *inside* the
   workspace root (`<workspace>/.pi/skills`, `<workspace>/.agents/skills`, `<workspace>/.pi/prompts`,
   `<workspace>/.pi/SYSTEM.md`, …), so a relative path can name a resource location. Skipping authorization for
   "in-root" paths would stop refusing writes to in-project resources and would change the reported path of an in-root
   resource read. Replaced by the corrected cuts in [`design-ssh.md`](design-ssh.md) §2.6 and
   [`research/ssh-helper-reuse.md`](research/ssh-helper-reuse.md) §9: **A0** skip authorization where it is provably
   unused (temp-dir/temp-file creation, reader close), **A1′** fold `host` into `discover`, **A2** fold the size
   pre-check into the read at message parity. **A3/A4** (reusing `discover()` across requests, serving the allow list
   from the snapshot) stay rejected: no invalidation signal exists at the gateway and a TTL is not one.
2. **"The frame budget is a hard 512 KiB bound" — corrected to a soft target with explicit exceptions.** A single entry
   and the live partial are indivisible, and there is no read block for oversized **text** tool output (upstream
   included), so a hard bound is not achievable and a benchmark asserting one would be false. The design states the
   order (defer, then shrink from the oldest end by whole entries, never drop the newest entry or the live partial),
   ships an undeferrable oversized entry whole as a **recorded limit**, and requires an **actionable error** rather than
   an endless `resync_required` loop when a frame would still exceed the transport's own limit.

### 3.2 Facts that must not be conflated

- **No gateway-managed master on the filesystem path** is not the same as **no stacking of two gateway-managed reuse
  mechanisms on one capability**, and neither is "ControlMaster is disabled". The gateway never passes
  `ControlMaster=no` and never touches a socket or file under the user's `~/.ssh`; the explicit `-o` values it adds
  apply to **gateway-spawned install/exec processes only**, so a user's own configuration, an interactive `ssh` and
  its own masters keep working. The design states both halves and says which processes are affected.
- **The transport's idle bound and a per-call total-duration timeout are different bounds.** The heartbeat defeats the
  former; substituting the latter would kill a healthy long-lived stream and prove nothing.
- **A missing durable route is not a missing upstream capability.** Thinking and tool-result images both have read
  blocks in the copied app; the durable per-entry routes do not exist (they 501), so they are part of this work rather
  than assumed present.
- **"One publication is one frame, so scalars apply in either order" — corrected to an exact-base gate.** Order
  independence was claimed from the counter alone, which is not enough: the guarantee is that **publication is
  serialized by the single owner of the revision**, so a frame is emitted only from a serialized publication and
  `baseRevision` is exactly the client's current revision; the client **applies a frame only on an exact match and
  rejects a stale or out-of-order frame without applying it**, then takes a fresh bounded snapshot. Complete scalars
  make the *content* of an accepted frame order-independent; they never authorize applying a frame whose base does not
  match. Every surface must state it that way.
- **Append-only deltas alone cannot keep a bounded window — and the trim prunes the window, not the user's loaded
  history.** A frame that appends without carrying the window's bookkeeping lets the client's **tail store** grow past
  the server's window, and past the raw cap the delta state stops equalling the equivalent snapshot state. So **the
  authoritative trim rides every advancing frame** (`oldestEntryId`, `hasMore`): it prunes the tail window, and
  already-visible evicted entries **migrate into the separately loaded prefix** (extending the known contiguous range)
  rather than being deleted. Equality after eviction is a test property over the **tail window plus the scalars**; the
  budget bounds a fetch and the live projection, and **no claim** is made about the total history a user has loaded.
- **"The gateway's ControlMaster never overrides SSH configuration" overstates the scope.** It overrides SSH config for
  **gateway-spawned** install/exec processes only — that is what adding explicit `-o` values does — while interactive
  SSH, the user's own masters and every other process are untouched. Say which processes, not "never".
- **A production failure and a controlled measurement are not the same evidence.** The three chat/connection failures
  were measured on the deployed split topology; the SSH per-call cost is **latent in production** (the deployed gateway
  is local and runs no SSH profile) and its numbers come from the build host against the repository's real-sshd
  fixture. An introduction that calls all four "deployed failures" is false.
- **A private native import is not an option.** Where a needed native fact is not exported, the route is upstream's
  documented surface or a committed request to it — never `readContextFrom`/`captureContextBounds` by internal path.

## 4. Decision hierarchy

When two options conflict, resolve in this order:

1. **Durable path first.** The runtime is the single authority (ADR 0001/0006/0007). A change that keeps the browser a
   pure projection of durable facts and native terminal facts wins over one that adds client-side state, timers or a
   second lifecycle, even at a higher implementation cost.
2. **Native / pi-web next.** Reuse the native primitives and the preserved upstream implementations through explicit
   seams rather than rewriting them (copy-first integration). A pi-web-shaped solution is acceptable when it does not
   contradict (1).
3. **Genuine UX ambiguity last.** A product answer that changes the design is recorded and asked (§5). The hierarchy
   does **not** mean escalating engineering detail to the user.

## 5. What is left to decide — nothing that needs a user question

Every earlier candidate has been resolved without asking:

1. **Old-history paging.** Settled by the copied surface: the preserved pi-web context route already takes `tail`
   (default 50, capped at 1000) and `before` (rewind the ancestor walk so an older page prepends without re-fetching),
   and the copied client already pages on top of it (`VISIBLE_PAGE_SIZE = 50`). Route 3 follows that contract.
2. **A reattach outside the retained 128 KiB terminal tail clears the screen today.** Current behavior is preserved;
   a short explanatory label is harmless presentational judgment.
3. **A compaction/reset moving the head marker and the loaded prefix.** Resolved native-first: a new head marker is a
   **re-baseline**, so the window is replaced from the marker and the prefix is dropped — matching what the model can
   see and what the current projection already implies. The wire still carries the head marker, so a different
   presentation would need no wire change.
4. **SSH residue and diagnostics.** Existing temp-file visibility, directory listing and diagnostics are preserved
   unchanged; a session killed abnormally leaves its staging file and a later session must not sweep it. A gateway crash
   leaves a stale socket in the gateway's own per-instance directory, removed only when that instance closes its own
   sockets — nothing is deleted because a name or a pid looks dead. Crash residue is recorded as a limit.
5. **First-request latency after an idle close.** A measured cost, not a user choice; the idle value is derived from the
   codebase's existing session value and would change only on evidence.

## 6. The connection budget is global, and its arithmetic is derived

The lane C proposal computed `maxBackgroundStreams = 6 − 1 (selected) − 2 (headroom) = 3`
(`.dev/worktrees/perf-lane-c/.scratch/perf-c-sse-budget/spec.md`). That equation has **no terminal term**, and terminals
are held sources. With the terminal fan-in in the design the count becomes:

```
live browser sources = 1 (selected conversation, kept warm while idle)
                     + 1 (terminal fan-in — one stream total, only while a terminal tab is mounted)
                     + B (background conversation watches)
pool                 = 6 per origin (HTTP/1.1; the deployed host answers h1 only)
```

So `B ≤ 2` while a terminal tab is mounted and `B ≤ 3` when none is — because the fan-in stream is not opened at all
in that case. The provisional 3 was not a wrong constant; it was a constant whose precondition (no terminal stream
exists) is not the normal case. Both numbers are derived from the pool and the terminal invariants and are asserted by
a test, not assumed.

## 7. Publication rules

- **Published documents name hosts by role** — build host, runtime host, client host — and paths by placeholder, as the
  existing deployment records do. The working notes under `.scratch/` may cite the actual hosts where a measurement
  requires it; nothing personal (host name, address, account, credential path, personal filesystem path) goes into a
  commit.
- **Evidence is pinned, not copied forward.** Lane records stay in the worktree that produced them at the revision they
  were taken at, and are linked by that path. No measurement is re-run to make a document look current.
- **The frame-budget wording is now coherent across every document.** `design-history.md` §2.3, D11, §7.2 item 4 and
  §10 check 3 were corrected in this pass to the soft target with explicit exceptions — defer, then shrink from the
  oldest end by whole entries, never drop the newest entry or the live partial, ship an undeferrable oversized entry
  whole as a **recorded limit** and keep it retrievable by id, and answer a frame that would still exceed the
  transport's own limit with an **actionable error** rather than an endless resync loop — and check 3 now claims a
  bounded first load **for deferrable content only**, asserting the exception as behaviour instead of a byte ceiling.
  If the design's author lands a later copy of `design-history.md`, it must keep this wording; the rule is stated in
  [`DESIGN-memo.md`](DESIGN-memo.md) §2.2 item 3, [`spec.md`](spec.md) and §3.1 above, and any copy that restores a
  hard bound reopens the item.
- **A validation record is tied to the revision and date it tested**, and the owning guide is updated in the same change
  that changes behavior.

## 8. Evidence links

- Scope, corrections and hierarchy: this file. Options and recommendations: [`DESIGN-memo.md`](DESIGN-memo.md).
  Designs: [`design-history.md`](design-history.md), [`design-ssh.md`](design-ssh.md). Proposal: [`spec.md`](spec.md),
  [`ticket-proposal.md`](ticket-proposal.md).
- Research: [`research/sse-connection-budget.md`](research/sse-connection-budget.md),
  [`research/incremental-state-frames.md`](research/incremental-state-frames.md),
  [`research/ssh-helper-reuse.md`](research/ssh-helper-reuse.md).
- Lane records were pinned to sibling worktrees that are not part of this checkout (`perf-lane-c` at `cb4494b`,
  `perf-lane-b` at `cb4494b`, `chat-lifecycle-integration` at `b9b28dd`); their retained findings are the research
  notes above and the in-repo [`evidence/README.md`](evidence/README.md).
- Governing decisions: [`docs/adr/0007-lifecycle-facts-one-projection.md`](../../docs/adr/0007-lifecycle-facts-one-projection.md),
  [`docs/adr/0006-durable-submission-lifecycle.md`](../../docs/adr/0006-durable-submission-lifecycle.md),
  [`docs/chat.md`](../../docs/chat.md).
