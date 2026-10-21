# Performance follow-up: integrated verification (tickets 01–07)

This is the revision-scoped record for the performance follow-up effort: what was measured on the integrated
revision, what the numbers are compared against, and what they do **not** claim. Current behaviour lives in the
owning guides linked at the end; a number here belongs to the revision in its row, not to the current tip.

**Integrated revision:** `integration/perf-follow-up` at `b068a90` (2026-10-14 UTC), the revision that closes
tickets 01–07. Read [verification practice](agents/verification.md) before comparing a baseline: a before-number is
pinned to the worktree and revision that produced it.

## What ran

Every command below ran on the **build host** against a checkout of `b068a90`. Nothing built or compiled on the
runtime host, no container was deployed, no paid provider was called, and the browser checks used a prebuilt
production Web build (`pnpm --filter @hepi/web build`, exit 0, log `web-build.log`) with this repository's own
controlled completions endpoint in place of a provider. Raw logs are under `.dev/verify/ticket-08/` (git-ignored).

| Check | Command | Exit | Log |
| --- | --- | --- | --- |
| Repository gate | `node scripts/verify.mjs --profile=fast` | 0 (PASS/PASS) | `verify-fast.log`, `verify-fast/verify.json` |
| History scaling | `node apps/server/scripts/perf-history-scaling.mjs` | 0, "all history-scaling claims hold" | `perf-history-scaling.log`, `perf-history-scaling.json` |
| Terminal budget e2e | `node apps/web/e2e/ux-terminal-budget.mjs` | 0, 15 checks / 0 failed | `ux-terminal-budget.log` |
| History prefix e2e | `node apps/web/e2e/ux-history-prefix.mjs` | 0, all checks passed | `ux-history-prefix.log` |
| Idle keepalive e2e | `node apps/web/e2e/stream-heartbeat-idle.mjs` | 0, all checks passed | `stream-heartbeat-idle.log` |
| SSH helper, layer and multiplexing probe | `node .dev/verify/ticket-08/ssh-measurements.mjs` (agent-98's lane) | 0 | `ssh-measurements.json`, built from `baseline-52b0131.json` and `current-b068a90.json` |
| Documentation links | `node scripts/check-docs.mjs` | 0, 179 files, 0 broken links | printed |

The `fast` row's first run is recorded with `dirty: true`: the ticket file this change retargets was edited before
it ran, and no product file was modified. The same gate was re-run on a **clean tree** at the docs commit that
publishes this record, `394422a` (which differs from `b068a90` in Markdown only), and reports `dirty: false`,
`ok: true` in `.dev/verify/ticket-08/verify-fast-clean/`. The other rows ran at `b068a90`; the product source is
identical at both, so they are not re-run for a Markdown-only change.

## Measured reductions

Each row is a measurement against a recorded baseline, with the baseline pinned to the worktree and revision that
produced it. Before-numbers are not re-measured here; they are the ones the owning tickets recorded, and they are
reproducible from the logs named beside them.

### 1. A quiet stream stays attached (ticket 01)

| | Before | After |
| --- | --- | --- |
| A held stream with no application frames | The transport's idle bound tore down both the conversation and the terminal stream; the page re-baselined and one source became two | A comment frame on the stated cadence keeps both attached; the page holds exactly one source per stream across three stated idle windows with no error |

Baseline: `.scratch/submit-stall/diagnosis.md` records the ~300 s idle SSE teardown (`BodyTimeoutError`) as the
finding it deliberately left alone, and the acceptance fixture run at the branch point `b9b28dd` failed 10 checks
with the same fixture file. Cadence: `HEPI_HEARTBEAT_MS` for the conversation stream and
`HEPI_TERMINAL_HEARTBEAT_MS` for the terminal stream, both defaulting to 30 s, `0` stating no keepalive. The
disabled control still crosses the same window behind the same bound and is torn down, so the cadence is the only
variable in the run.

### 2. Terminal fan-in and the page's connection budget (ticket 02)

| | Before (`cb4494b`, lane C) | After (`b068a90`) |
| --- | --- | --- |
| Live sources, two mounted terminal tabs + four held runs | **6** (2 terminal + 4 conversation) | **4** (1 terminal + 3 conversation) |
| The page's ordinary in-page read | did **not** settle within 3000 ms, with the panel open and with it closed | settled, 3 ms |
| Session switch | — | 61 ms |
| Terminal stream identity | one source per tab | one source for every attached tab (`/api/terminal/events`) |

Baseline: `.scratch/perf-follow-up/evidence/terminal-pool-probe.json` — worktree `perf-lane-c`, revision
`cb4494b`, `BUILD_ID = vRBY79KO3pFNmp2MFtFCX`, 4 held runs, HTTP/1.1, 7 checks. Its own limits are respected: the
tabs are restored rather than clicked, the sessions are created out-of-band, and it is one fixture, one browser and
one Next build. The after-run asserts the same scene plus what the ticket asks for — the composer is ready, a
session switch completes, an in-page read settles, both shells are still the same sessions afterwards, keystrokes
echo, and a reattach inside the retained tail does not reset the screen. The control with one fewer held run and no
terminals passes, so a failure is attributable to the count rather than to load.

### 3. Bounded history, incremental frames and paging (tickets 03 and 04)

| | Before (`cb4494b`, lane B) | After (`b068a90`) |
| --- | --- | --- |
| State bytes per turn | 5,524 → 152,175 from 10 to 60 turns | **720.7 → 725.8** from 10 to **240** turns — flat |
| Largest single frame | 1,198 → 30,5xx | ≤ **1,047 B** |
| First load | 4.7 MB at 197 turns | **9.1 KB → 22.8 KB**, bounded by the window (76 entries; 50 visible messages, 300 raw entries cap) |
| Older history | — | paging reaches all **722** entries of the 240-turn transcript in 9 pages |

Baseline: `.dev/worktree-archive/perf-lane-b/.scratch/perf-b/REPORT.md` at `cb4494b`, findings 1 and 2, as recorded in
`.scratch/perf-follow-up/research/incremental-state-frames.md`. The after-run folds frames through the **shared
reducer a real client uses** (`@hepi/session`), so the measurement and the browser agree about what a frame means:
after the baseline a frame carries `baseRevision` plus the entries it appended and no `entries`, its
`baseRevision` is exactly the previous frame's `revision`, and the appended entries are byte-identical to the same
entries read one at a time. Recovery after a reconnect lands on one chain and is bounded.

### 4. The history a reader loaded survives the window moving (ticket 05)

Before, an entry a client already held directly below the window was dropped when the window's start advanced. The
after-run opens a conversation long enough to be paged, scrolls back until older history is loaded, produces a new
turn, and requires every message the reader had loaded to still be on screen, no turn rendered twice, and the loaded
history to survive a reconnect. All checks pass at `b068a90`.

### 5. SSH: the helper session (ticket 06)

Before, every remote operation paid a fresh connection, the ~51 KB helper payload and a Python start. Both revisions
were measured by the same probe on the build host against the repository's real-sshd fixture
(`.dev/verify/ticket-08/ssh-measurements.json`; the baseline run is `baseline-52b0131.json` in a worktree at the
branch point, the current run `current-b068a90.json` here):

| | Before (`52b0131`) | After (`b068a90`) |
| --- | --- | --- |
| A full operation set | **87** ssh processes, no session | **1** session open, **0** ssh processes, 57 request frames, **1** connection |
| Helper starts per operation | `executionHost` 2, `fileInfo` 3, `readTextFile` 4, `listDir` 3, `exists` 3, `createTempDir` 3, `writeFile` 5, `resourceSnapshot` 1 | **0** for every operation (`resourceSnapshot` was already one run and is one frame now) |
| A warm `fileInfo` (20 calls) | median **520.4 ms** | median **0.34 ms** (≈1500×) |
| Cold first call | **557.4 ms** | **164.9 ms** (the one session open) |
| The layers a one-shot request pays | ssh transport median **151.4 ms**, Python start **157.3 ms** end to end (**5.9 ms** of it above the transport) | paid **once per session**, not per operation |
| Request frames a path-naming read sends | 3 (discovery, size pre-check, operation) — ticket 06's recorded count; the one-shot transport has no framed session for the lane to count | 2 (discovery, operation) |

The counts are **helper requests the host receives**, not a claim of zero round trips: a read still sends 2 frames
and a write 4. What the session removes is the per-operation connection, the helper payload and the Python start. The
lane's cross-check reproduces the recorded per-operation counts exactly (helper starts 2/3/4/3/3/3/5/1 and session
frames 1/2/2/2/2/1/4/1), so the before-numbers agree with the ones the ticket recorded at
`.dev/worktree-archive/chat-lifecycle-integration/.scratch/perf-a/logs/`.

### 6. SSH: gateway-managed ControlMaster for install and execution (ticket 07)

| | Before (`52b0131`) | After (`b068a90`) |
| --- | --- | --- |
| One publication + one execution | **7** authentications, 6 before the execution | **1** |
| 8 sequential execute calls | median **151.6 ms**, **8** connections (derived: that revision has no master) | **157.7 ms plain / 6.0 ms on the master**, 8 plain / **1** on the master (first call 160.4 ms opens it) |
| A 4-file publication | **1,052 ms**, 6 connections | **289 ms**, **1** connection |
| Reaping the master | — | `ssh -O exit`, bounded at 5 s; **2.7 ms** measured |

The current connection counts are read from the **daemon's own log** (one line per accepted login); the baseline
revision's fixture exposes no sshd log, so its count is derived from its own process count — one ssh process is one
connection on a revision with no multiplexing. The 7 → 1 authentication count is ticket 07's own record
(`baseline-52b0131-authentications.log`, `managed-master-authentications.log`), taken against the real-sshd fixture
with the authentication lines counted in the daemon's log, and the lane reproduces it.

The master is scoped to install and execution only: the filesystem session and terminal sessions keep the plain
transport, so a terminal holds its own connection for the life of the session rather than sharing a master.

**Nothing in the SSH lane failed to reproduce.** Both recorded baselines were reproduced on the real fixture and no
claim was dropped; the lane's own narrative is `.dev/verify/ticket-08/SSH-EVIDENCE.md` and its reproduction commands
are in `ssh-measurements.json`.

## What this record does not claim

- **The numbers come from the deployment shape on the build host, not from the live split deployment.** The chat,
  connection and history measurements ran with a prebuilt production Web build, the real backend over a real SQLite
  store and a real local gateway — the shape the deployment uses, and the same shape that produced every recorded
  baseline — but no deployment was performed and no number was read from the running `<client-host>`/`<runtime-host>`
  pair. Treat the deployed topology as unmeasured here.
- **The SSH numbers are latent in production.** The deployed gateway is local and runs no SSH profile, so both SSH
  rows are build-host measurements against the real-sshd fixture, not production traffic. Their absolute milliseconds
  are a **loopback** transport, so they size the per-call work removed rather than a remote latency; there is one run
  per revision, and the baseline revision's connection count is derived from its own process count because its fixture
  exposes no sshd log.
- **One fixture, one browser, one Next build, HTTP/1.1** for every browser check; the measured idle windows are a few
  stated windows (seconds), not a multi-minute soak.
- **Nothing here is a general performance guarantee.** A row states what one run at `b068a90` measured against one
  recorded baseline.

Recorded capability limits, stated rather than smoothed over:

- A large **text** tool output has no read block (upstream included), so such an entry ships whole; a frame that still
  cannot be carried answers the named `frame_too_large` reason with the entry id and its size instead of destroying
  the connection into an endless resync, and the entry stays readable by id. Pages ask the same question.
- A transport that cannot hold a filesystem session open has **no** filesystem capability at all: the answer is the
  named `not_supported` limit, with no per-call fallback to the deleted one-shot path.
- An abnormal gateway exit leaves its SSH master sockets and an abnormal filesystem session can leave a staging file
  in the target directory. Neither is swept: nothing is deleted because a name or a pid looks dead. See
  [Migration status](migration-status.md#performance-follow-up-ssh-reuse-tickets-06-and-07-delivered).
- The minimap still cannot request a page for a turn it is not drawing, and the reported sustained multi-second stall
  is neither reproduced nor claimed fixed.

## Where the behaviour is documented

[Chat](chat.md) for the window, the incremental frames, paging, the read blocks and the loaded prefix;
[Gateway integration](local-integration.md#ssh-prerequisites) and
[Execution-side installation](execution-side-installation.md) for the gateway-managed socket directory and the
ControlMaster behaviour change; [Migration status](migration-status.md) for the delivered tickets and the recorded
limits; [Verification](verification.md) for the per-ticket check records this one integrates.
