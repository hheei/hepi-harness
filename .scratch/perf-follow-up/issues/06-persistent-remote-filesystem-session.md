# 06: Persistent remote filesystem session, including the corrected redundant-call elimination

**What to build:** remote file reads, writes and stats stop paying a fresh connection, a 51 KB helper payload and a Python start per operation, with the same confinement, the same write refusal and the same honest failure reporting.

**Blocked by:** None (can start immediately).

**Status:** complete — merged into `integration/perf-follow-up` as `eeb50626b1904e9b7b1317772a1f05995fd3c061`
(fast-forward onto `453152c`, no conflicts; ticket 07's master lives only on the install and execution runner — the
filesystem keeps the plain transport its session opens on, and both close paths are preserved). Implemented on
`impl/perf-ssh-06`; reviewer101 approved `eeb5062` with Standards 0 / Spec 0 after the two material P2s below were
fixed at `d5a8f68`.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `453152c` (the branch point was `b9b28dd`; `453152c` is
source-identical to `3256e65` and carries ticket 01 and ticket 07).

- [x] A remote operation's helper runs drop to the corrected counts, and the snapshot path is unchanged.
      Measured with `.dev/verify/ticket-06/probe-helper-runs.mjs` against the same probe on the pinned baseline worktree
      `.dev/worktrees/perf-ssh-06-red` at `52b0131`: `executionHost` 2→**1**, `fileInfo` 3→**2**, `readTextFile` 4→**2**,
      `listDir` 3→**2**, `exists` 3→**2**, `createTempDir` 3→**1**, `writeFile` 5→**4**, `resourceSnapshot` 1→**1**
      (unchanged). The remaining two runs for a path-naming read are the per-request discovery and the operation itself;
      the discovery is now one request (`A1'`) and the size pre-check is gone (`A2`).
- [x] Confinement still runs per operation: a symlink swapped between two operations is still refused at the operation, and a write to an in-project resource is still refused.
      `test/ssh-session.test.ts` re-points a link between two reads on one session and requires `permission_denied` for
      the second, and requires a write through the logical `/.agents/skills/...` alias to be refused with the file
      unchanged.
- [x] A request that waited and was never written fails as **not sent** and is never reported as an unknown remote outcome; a request whose frame was written and whose response was lost is reported **unknown** and is never retried.
      One session, two requests, one death: the answers are exactly one `unknown` ("ssh filesystem outcome unknown") and
      one `aborted` ("the request was not sent"), asserted as a set because the two requests are chained.
- [x] A multi-part write stays on one session from begin to commit/abort, so a cancellation or an idle close cannot move a half-written file; a lost commit response is unknown even though the rename may have happened.
      `sessionIdleMs: 0` closes an idle session the moment its last request settles, and a 700 KB write still rides
      **one** session from `write_begin` to `write_commit`.
- [x] Staging cleanup removes only files the live session itself created; nothing is deleted by pattern, and a later session never sweeps an earlier session's residue.
      A scripted host creates its staging file and dies: the residue is left in place and a later session on the same
      root leaves it untouched. A graceful close removes exactly the staging file the helper created, by the path it
      recorded, and leaves the target's original content.
- [x] A host without the session capability reports a **named** unsupported limit and keeps no second code path.
      A runner without `open` answers `not_supported` ("this SSH transport cannot hold a filesystem session open") and
      the one-shot `execute` path is deleted; the assertion counts the `execute` calls at zero.
- [x] The one new framing invariant (a maximum frame length, enforced on both sides) is enforced, while the existing file and snapshot content limits remain the effective ones; a violation fails the request and drops the session rather than resynchronising.
      Request frames are bounded by the gateway's own 1 MiB JSON bound and answers by 64 MiB; the helper refuses to emit
      a larger answer and fails the request, and the gateway refuses to slice a declared length above the bound. The
      effective content limits stay `MAX_FILE_BYTES` (16 MiB) and the helper's `MAX_SNAPSHOT`.
- [x] A session that dies while a request waits or after its frame was written produces exactly one of the two answers above — never a silent retry and never a fabricated success.
      Asserted above, plus: a host without Python 3 is `not_supported`, an `ssh` connection failure is "ssh host
      unreachable", and the same write is never written a second time (`host.frames` is `["discover", "write_begin"]`).
- [x] The existing filesystem, resources, workspaces, file-transfer and snapshot suites stay green; helper-run counts are measured against the recorded baseline.
      `pnpm verify --profile=fast` → 0 (PASS/PASS) at `d5a8f68`, the current tip; the owning log is
      `.dev/verify/2026-10-13T17-56-10-225-verify-fast` and [Verification](../../../docs/verification.md#persistent-remote-filesystem-session-ticket-06)
      points at it. Before the two review corrections the same profile passed at `606add4`
      (`.dev/verify/2026-10-13T17-19-39-974-verify-fast`, product trees `apps` `3e78b20b`, `packages` `49e1332a`), and
      the earliest `.dev/verify/2026-10-13T16-47-42-128-verify-fast` is the pre-commit run recorded against `52b0131`
      with the working tree dirty: both are kept as history rather than as this revision's evidence. The probe's
      before/after JSON is under `.dev/verify/ticket-06/`.

**Evidence.** `node --test packages/gateway/test/ssh-session.test.ts` → 0 (10 pass, 0 fail);
`pnpm --filter @hepi/gateway test` → 0 (**164** pass at `d5a8f68`; 162 at `14f34fd` before the two review
corrections, and 150 at the pre-merge `e0658cf`, both kept as history); `pnpm --filter @hepi/gateway typecheck` → 0;
`pnpm --filter @hepi/server typecheck` → 0; `pnpm --filter @hepi/client typecheck` → 0;
`node apps/server/scripts/diag-ssh-rpc-count.ts --flat --skills=65` → `helperRuns 1`, `authorizationRuns 0`;
`node --test packages/gateway/test/ignore-parity.test.ts` → 35,882 decisions agree (the ported engine is unchanged).
Baseline probe: `.dev/worktrees/perf-ssh-06-red` at `52b0131`, logs under `.dev/verify/ticket-06/`.

**Remaining limits.** A session that dies abnormally leaves its staging file (`.hepi-write-<uuid>.tmp`) in the target
directory; it is never swept, and a later write cannot collide with it because the name carries a fresh UUID. A
transport that cannot hold a session open has no filesystem capability at all — there is no per-call fallback. The
idle-close window (120 s, the terminal's own reconnect window) means the first request after a quiet period pays one
session setup.

## Review notes

**The counts are helper requests, not a claim of no round trips.** Every number above is a request frame the host
receives, and a path-naming read still sends 2 and a write still sends 4 of them across the network. What the session
removes is the per-operation connection, the 51 KB helper payload and the Python start — one open per (profile, root)
instead of one per operation — plus the two redundant requests (A0, A1', A2). No count here is zero except the three
nameless methods, which provably resolved nothing.

**Review pins.** `14f34fd` was the revision under review; its product trees were `apps` `3e78b20b` and `packages`
`49e1332a`, identical at `606add4` and `14f34fd`, so the fast run at `606add4` covered it with only `docs/` differing.
The two review corrections are the product change on top of that pin and are carried by `d5a8f68`, whose own fast run
is the current evidence. The reviewer's approved tip is `eeb5062` (docs-only on top of `d5a8f68`: `apps` stays
`3e78b20b`, `packages` moves to `b67c39be`), so the `d5a8f68` fast run (`dirty: false`, both steps exit 0, 0 `not ok`,
`.dev/verify/2026-10-13T17-56-10-225-verify-fast`) is reused for it rather than re-run. The earlier 162-test evidence at
the `49e1332a` `packages` tree is obsolete for the fix and is not reused as its acceptance.

**Focus-path evidence, ad-hoc probes under `.dev/verify/ticket-06/` (not committed, not part of the suites):**

| Focus | Probe | Result |
| --- | --- | --- |
| A request arriving after the idle close | `idle-reopen.json` | The idle session is gone and the next request opens its own: `opensAfterFirst 1`, `opensAfterIdle 2`, both reads `ok`. The window is `SESSION_IDLE_MS` 120000, matching the terminal's reconnect window. |
| Abort / cleanup / no-replay on close | `abort-replay.json` | `close()` during an in-flight write answers `unknown` ("ssh filesystem outcome unknown"), the write is never re-sent (`writeBeginCount 1`), the helper removes its own staging file (`residue []`), and the session is not reused. |

**P2 corrections, both fixed on this branch after `14f34fd`.**

1. *No request deadline.* A dispatched request and every waiter behind it could stay unresolved forever. The session now
   carries the gateway's own file bound, `SSH_FILE_TIMEOUT_MS` (60 s, the deadline the one-shot transport applied),
   owned by the session rather than by a per-tool guard: a request that waited past it was never written and is
   `aborted` ("the request was not sent"), one whose frame was written and then timed out is `unknown` and is never
   replayed, and the session is not reused. Tests override the bound with `requestTimeoutMs`, so the check settles in
   ~0.5 s instead of a minute.
2. *A gateway-ended session killed the helper before its own cleanup.* `#drop` sent `SIGTERM` straight to the transport,
   and `SshFilesystem.close()` aborted first, so a helper that had already created its staging file was killed before
   its own `finally` could remove it. Every gateway-initiated end — idle close, cancellation, deadline — now takes one
   path: mark closed, fail the request in flight as `unknown`, send the close frame, and give the helper the bounded
   grace (5 s) to remove the paths it recorded itself, then kill it. The corrected check is a real barrier: the
   `write_begin` answer is committed before any chunk is sent, so the first `write_chunk` frame proves the staging file
   exists on disk, and only then does the test call `close()` and require the target unchanged and the staging file
   gone. The independent fixture reports `defectObserved false` for both probes
   (`.dev/verify/ticket-06-review/deadline-and-close-repro-after.log`: `residue []`, `childSignal null`,
   `settledBeforeCleanup 2`, `frames 1`).

**Advisory, recorded only.** A request that reaches `SshFilesystem.execute` *after* `close()` still
constructs a `Session`, and the constructor spawns eagerly, so one `ssh`/Python process is started for a request that
is then answered `aborted` ("the request was not sent") without a frame. The session is not in the array `close()`
already drained, so nothing reaps it; it ends by itself only when its own 120 s idle timer fires. The smallest coherent
fix is one guard at the top of `execute` (`if (this.#controller.signal.aborted) return fileFailure(aborted)`), which
covers `#write` and every other path. Impact is limited to a shutdown race and the process lives at most the idle
window, so it is recorded rather than changed under review.
