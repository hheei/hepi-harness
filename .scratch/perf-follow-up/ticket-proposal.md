# Ticket proposal — 8 vertical slices

**Status: APPROVED 2026-10-13, published.** Each slice below is one file under [`issues/`](issues/), numbered in
dependency order, `Status: ready-for-agent`, with the `Blocked by` line naming the files that gate it. This proposal
stays as the rationale for the granularity; the ticket files are the tracker records.

Source: [`spec.md`](spec.md); designs [`design-history.md`](design-history.md) and
[`design-ssh.md`](design-ssh.md); scope and hierarchy [`decisions.md`](decisions.md).

Rules applied: each slice is **vertical** (cutting through every layer it needs, demoable or verifiable on its own),
sized for one fresh context window, and never a schema-only or layer-only slice. Blocking edges are only the tickets
that genuinely gate the work.

---

## 1. Idle-stream keepalive at the origin writers

**Blocked by:** None (can start immediately).

**Delivers:** a quiet conversation stream and a quiet terminal stream stay connected instead of being killed by the
transport's idle bound and silently re-baselining; the two Web proxies forward the comment frame untouched.

**Acceptance criteria**

- [ ] A held conversation stream with no application frames stays attached across a window longer than the transport's
      idle bound and receives heartbeat frames; the page observes **one** source with no reconnect over that window.
- [ ] The same holds for the gateway's terminal stream, and a terminal reconnect still continues from `Last-Event-ID`
      or is told `reset: true` exactly as today.
- [ ] The two proxies pass a comment frame through byte-for-byte and never inject one; a test drives a frame split
      across chunk boundaries and asserts the payload arrives intact.
- [ ] The test runs against a shortened, controlled idle bound with the clock advanced by event barriers — no sleep and
      no real multi-minute wait; the bound under test is the idle one, not a total-duration timeout.
- [ ] No process-global dispatcher or global timeout change is introduced.

## 2. Terminal fan-in plus the conversation stream budget, end to end

**Blocked by:** None for the budget half; the fan-in half has no hard blocker either, but it must land with the budget
in one slice so the count is true. (If the two are split, the fan-in is the blocker of the budget.)

**Delivers:** the page stays usable with terminal tabs open and several conversations running — the composer is
reachable, a switch is fast, and an ordinary read settles — while every mounted terminal tab keeps its shell.

**Acceptance criteria**

- [ ] With N real mounted terminal tabs (including the panel closed and a non-active tab selected) plus held chat runs,
      the observed count of OPEN sources is within the pool budget and the composer is ready, a session switch
      completes and an in-page read settles inside their deadlines.
- [ ] The 4-held control with no terminals passes today's behaviour unchanged, so a failure is attributable to the
      count and not to load.
- [ ] Every mounted terminal tab's shell is the **same** session after the measurement, keystrokes still echo, and a
      reattach inside the retained tail does not reset the screen.
- [ ] At most the derived number of background conversation watches hold a source; a nomination over budget opens
      nothing, keeps its projection, and acquires when a slot frees.
- [ ] The selected conversation's source is never given up, one notice per answer still holds, no duplicate audio, and
      an idle source is still released.
- [ ] The counting is test instrumentation inside the page (the existing recorder pattern); no production diagnostics
      module is added.
- [ ] The measurement this ticket extends is reused, not re-derived: the recorded terminal-in-pool run (worktree
      `perf-lane-c`, revision `cb4494b0b4429bda1d9940257f661239171ce502`, prebuilt `BUILD_ID =
      vRBY79KO3pFNmp2MFtFCX`, node `v26.5.1`, HTTP/1.1, 7 checks / 0 failures, nothing rebuilt or deployed) is the
      baseline, and its limits are respected: restored tabs rather than clicked, sessions created out-of-band, one
      fixture, one browser (Chromium), one Next build, no HTTP/2 claim, and **no assertion about the 120 s
      detached-session lease** — that lease is tested separately with a short configured window if a criterion needs it.

## 3. Bounded history window, older pages, and the per-entry read blocks

**Blocked by:** None (can start immediately).

**Delivers:** opening a long conversation loads the newest messages only, scrolling up loads older pages on demand, and
thinking text / tool-result images load when expanded instead of riding the initial payload.

**Acceptance criteria**

- [ ] A long conversation's baseline read, its first stream frame and `GET /state` carry at most the window (50 visible
      messages, raw-entry cap) with a real `hasMore` and a real oldest id; a short conversation carries everything with
      `hasMore` false.
- [ ] The window's oldest id and `hasMore` are published on every surface that returns a window, so a consumer can trim
      to the server's window instead of growing its own transcript.
- [ ] No unbounded mode is added to the state route: a consumer that needs everything pages.
- [ ] Paging backwards from the tail reproduces exactly the entry-id set an unbounded read would return, never repeats
      the boundary entry, and never crosses a head marker (post-compaction entries are not paged back).
- [ ] A paged entry and a streamed entry are identical, redaction included.
- [ ] One entry can be read by id: a projected, redacted entry; unknown id → 404; out-of-range block index → 400; an
      image outside the mime/size policy → refused with an actionable message.
- [ ] A frame that would still exceed the transport's own limit yields an **actionable error** for that read, never an
      endless resync loop and never a silently truncated transcript that claims completeness.
- [ ] An entry whose content cannot be deferred ships whole and is recorded as a limit; when the newest entry cannot
      be brought inside the transport limit at all, that read answers with an **actionable error** and the entry stays
      retrievable through its full-entry read — no bounded-first-load claim is made for content that is not bounded.
- [ ] A benchmark at 10/60/120/240 turns asserts flat bytes-per-turn and a bounded first load against lane B's recorded
      numbers, with the soft-target exceptions asserted as behaviour rather than a hard byte ceiling.

## 4. Projected incremental state frames

**Blocked by:** 3 (the bounded window is what a delta continues; without it a delta frame would still carry an unbounded
baseline).

**Delivers:** each turn's stream frame carries only what changed, so turn 200 costs roughly what turn 10 costs, while
redaction and the lifecycle contract stay exactly as they are.

**Acceptance criteria**

- [ ] After the baseline, a turn's frames carry `baseRevision` = previous revision and only the appended entries plus
      every scalar and the window bookkeeping (`oldestEntryId`, `hasMore`), and `revision` advances by exactly one per
      frame.
- [ ] **Eviction rides the frame and prunes the window, not the loaded history**: an advancing frame whose window
      moved carries the new `oldestEntryId` and the client prunes its **tail store** to it, while entries already loaded
      below the window **migrate into the prefix** when the prefix's newest id is contiguous with them. A client that has
      followed more than 300 entries holds exactly the server's **window** in its tail store, and its rendered transcript
      is `prefix ∪ tail` by entry id — with no assertion that the total history a user loaded is bounded, and no path
      where a later turn deletes an entry the user is reading.
- [ ] **Equality after eviction**: folding a commit sequence longer than the raw cap onto the baseline equals folding
      snapshots only (property test over a random commit sequence), **compared over the tail window plus the scalars**,
      including scalar-only frames with no appended entries — this is the assertion an append-only-without-eviction
      design fails.
- [ ] **Exact-base gate**: a frame whose `baseRevision` is not the client's current revision (stale or out-of-order) is
      **rejected without being applied** and followed by a fresh bounded snapshot; a matching frame is applied exactly
      once; no frame is ever applied out of order.
- [ ] A head-marker change arrives as a whole-window frame (a re-baseline), never as a delta.
- [ ] A frame the client cannot continue produces a **fresh bounded snapshot** and `resync_required` with nothing
      replayed, and an outstanding turn is then settled **by request id**.
- [ ] Redaction holds identically on the baseline, a page and a delta append (credential failure and unregistered api
      id), and it runs once per entry through the one shared projection expression.
- [ ] Chord operation passthrough is not used as a wire format; no raw entry record or raw live document reaches the
      wire.
- [ ] The server keeps no per-client cursor, buffer, ack or epoch.

## 5. Loaded-history integration: prefix across reconnect, search, fork, minimap, SDK

**Blocked by:** 3 and 4.

**Delivers:** history the user already loaded survives a reconnect and a session switch; search hits, fork points and
the minimap work for messages that are not loaded; the session SDK does not lose earlier entries when a bounded snapshot
arrives.

**Acceptance criteria**

- [ ] The prefix decision is one pure function over ids and the two history facts: kept when the window still follows
      it, truncated on overlap **by id**, dropped when there is nothing older or when the head marker moved, and kept
      across an attachment identity change (a new attachment must not discard loaded history). It also **receives** the
      entries an advancing window evicted while they were already on screen when the prefix is contiguous with them
      (migration, not deletion), so window movement and loaded history never share a store.
- [ ] The history token is unchanged across two reads with no commit, changes on an append, changes on a head marker,
      is equal for two different attachments of the same conversation, and is **equal after a backend restart on the
      same store**.
- [ ] A reconnect that returns a fresh tail keeps the loaded prefix instead of discarding it; today's discard behaviour
      is gone.
- [ ] A search hit outside the loaded window opens at the right message; a fork by id works for an entry that was never
      loaded; the minimap can request the next page instead of only growing its visible count.
- [ ] The shared session reducer merges a bounded snapshot into what it already holds and exposes `hasMore`, so the SDK
      and the web app cannot disagree.
- [ ] The token is derived from **public** native primitives only; no private native import is introduced.

## 6. Persistent remote filesystem session, including the corrected redundant-call elimination

**Blocked by:** None (can start immediately).

**Delivers:** remote file reads, writes and stats stop paying a fresh connection, a 51 KB helper payload and a Python
start per operation, with the same confinement, the same write refusal and the same honest failure reporting.

**Acceptance criteria**

- [ ] A remote operation's helper runs drop to the corrected counts, and the snapshot path is unchanged.
- [ ] Confinement still runs per operation: a symlink swapped between two operations is still refused at the operation,
      and a write to an in-project resource is still refused.
- [ ] A request that waited and was never written fails as **not sent** and is never reported as an unknown remote
      outcome; a request whose frame was written and whose response was lost is reported **unknown** and is never
      retried.
- [ ] A multi-part write stays on one session from begin to commit/abort, so a cancellation or an idle close cannot move
      a half-written file; a lost commit response is unknown even though the rename may have happened.
- [ ] Staging cleanup removes only files the live session itself created; nothing is deleted by pattern, and a later
      session never sweeps an earlier session's residue.
- [ ] A host without the session capability reports a **named** unsupported limit and keeps no second code path.
- [ ] The one new framing invariant (a maximum frame length, enforced on both sides) is enforced, while the existing
      file and snapshot content limits remain the effective ones; a violation fails the request and drops the session
      rather than resynchronising.
- [ ] A session that dies while a request waits or after its frame was written produces exactly one of the two answers
      above — never a silent retry and never a fabricated success.
- [ ] The existing filesystem, resources, workspaces, file-transfer and snapshot suites stay green; helper-run counts
      are measured against the recorded baseline.

## 7. Gateway-managed ControlMaster for install and execution

**Blocked by:** None (can start immediately); independent of 6 and deliberately **not** applied to the filesystem path.

**Delivers:** installing a skill directory or running a series of commands over SSH stops paying a handshake per step,
while the user's own SSH configuration and masters keep working.

**Acceptance criteria**

- [ ] Install and execution use one gateway-managed master keyed on the **full** connection profile (identity file and
      known-hosts file included), not on a host/port hash alone.
- [ ] The explicit options override SSH config for **gateway-spawned install/exec processes only**: an interactive
      `ssh` on the same host still reports the `ControlPath` its own config gives it, and the user's own master still
      works.
- [ ] The socket directory is gateway-owned, created before first use and mode-checked; a failure to create it or a
      wrong mode is a reported failure, not a silent fallback.
- [ ] Gateway shutdown reaps the masters this gateway instance created and removes only its own sockets; there is no
      startup sweep, nothing is removed because a name or a pid looks dead, and no path outside the gateway's own
      directory is touched.
- [ ] The gateway never passes a disable-master option and never edits or deletes anything under the user's SSH
      configuration; a user's own master may still exist and be used by the user's own `ssh`.
- [ ] No gateway-managed master is applied to the filesystem path or to the terminal, and no capability ends up with two
      gateway-managed reuse mechanisms.
- [ ] Crash residue (a stale socket after an abnormal exit) is recorded as a limit in the owning guide, not cleaned up
      speculatively.

## 8. Integrated regression, evidence, and owning guides

**Blocked by:** 1, 2, 3, 4, 5, 6, 7.

**Delivers:** the whole effort is verified together on one revision, with the measured reductions recorded and every
affected guide updated in the same change.

**Acceptance criteria**

- [ ] The full required check set passes on the integration revision, including the new budget e2e with terminals in the
      count, the history benchmark, and the SSH helper-run and layer measurements.
- [ ] Evidence is labelled by what produced it: the chat and connection numbers come from the **deployed** topology, the
      SSH numbers from the **build host against the real-sshd fixture** because that path is latent in production.
- [ ] Each route's claimed reduction is a **measurement against the recorded baseline**, with the before-numbers pinned
      to the worktree and revision that produced them, and any claim that did not reproduce is recorded as a failure
      rather than smoothed over.
- [ ] The owning guides are updated in the same change: the chat/lifecycle guide for the window, deltas, paging and the
      read blocks; the deployment notes for the gateway-managed socket directory and the behaviour change for hosts
      whose SSH config previously had no multiplexing; the capability-limits record for the named unsupported session
      case, the oversized non-deferrable content, and the crash residue.
- [ ] Published records name hosts by role and paths by placeholder; no personal host name, address, account or
      credential path appears in the change.
- [ ] No verification runs a compile or build on the runtime host, and no paid model call is made.

---

## Granularity — what to approve or change

- **Coarse/fine:** 8 slices, each ending in something observable: a quiet stream, a usable page, a bounded first load,
  a cheap turn, preserved history, a fast remote read, a fast install, and one integrated verification.
- **Edges:** 4 needs 3; 5 needs 3 and 4; 8 needs all. 1, 2, 3, 6 and 7 can start immediately, and 6 and 7 are
  deliberately independent of each other.
- **Merge/split candidates, if the reviewer prefers:** (a) 2 could split into fan-in and budget, at the cost of the
  budget being true only in the second half; (b) 3 and 4 could merge if a single reviewer holds both, at the cost of a
  very large slice; (c) 5 could absorb the SDK half of 4 if the reducer is considered part of the delta vocabulary.
  The default above keeps each slice inside one context window and each acceptance criterion a public behaviour.
