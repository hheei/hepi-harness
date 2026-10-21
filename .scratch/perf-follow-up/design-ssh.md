# SSH transport and helper reuse — design recommendation

No code, no new measurement, no production write. This is the concrete design for the two mechanisms the research note
(`research/ssh-helper-reuse.md`) left open, on the same base: `integration/chat-lifecycle` = `b9b28dd`
(`b9b28dda040d09aa7472514726e5ec6d1d7d0bb5`), identical in code to the deployed `cb4494b`. Every claim below is
derived from source at that revision or from the measurements already recorded in
`.dev/worktrees/chat-lifecycle-integration/.scratch/perf-a/`; nothing here is re-measured.

Scope: **filesystem → one persistent helper session; install and execution → one gateway-managed ControlMaster; no
ControlMaster on the filesystem path and no session on install/exec.** §5 says why. Every remaining open item is in §6;
nothing in §6 is a question for the user about framing, queue size or vocabulary.

## 0. Decisions

| # | Decision | Mechanism |
| --- | --- | --- |
| D1 | Filesystem helper runs as one persistent session per `(profile, root)`, opened with the existing `SshRunner.open` | `runner.open` + the terminal's frame layout |
| D2 | `runner.open` absent ⇒ named `not_supported`; **no** second per-call fallback path | mirrors `terminal.ts:439-440` |
| D3 | Exactly one request in flight per session; further callers wait in the gateway, not in a queue buffer | promise chain, §2.4 |
| D4 | Waiting is bounded by the request's own deadline; a request that expires **before dispatch** fails locally and is never `outcome_unknown` | `aborted`, §2.4 |
| D5 | A request whose frame was written and whose session then died is `outcome_unknown`; never retried | unchanged from today |
| D6 | A write pins one session from `write_begin` to `write_commit`/`write_abort`; idle-close and cancellation cannot move it | §2.5 |
| D7 | Staging-file cleanup removes **only** files that the live session's helper created; no directory sweeping | §2.5 |
| D8 | `readTextFile`/`readBinaryFile`/`openBinaryReader` keep their current diagnostics with one call instead of two | §2.6 |
| D9 | Session idle-close 120 s, teardown grace 5 s, per-request deadline 60 s — all existing values | §2.7 |
| D10 | Frame bounds: request ≤ 1 MiB, response ≤ 64 MiB, both enforced on both sides | §2.3 |
| D11 | Install + execution get a gateway-managed ControlMaster in a gateway-owned 0700 socket directory, keyed on the full connection profile | §3 |
| D12 | The gateway's explicit `-o` values override SSH config for **gateway-spawned** install/exec processes only: it never passes `ControlMaster=no`, never touches `~/.ssh`, and never touches a socket it did not create, so interactive SSH and the user's own masters are untouched | §3.3 |

## 1. What already exists and is reused verbatim

- `SshRunner.open?` (`runner.ts:41-46`) returns the child carrying the pipes, and is documented as "Absent on a
  transport that cannot hold a session open, which is then reported as a named limit rather than a failure". The real
  transport implements it (`runner.ts:115-121`: `spawn("ssh", [...connection, "--", host, "exec " + argv], { stdio:
  ["pipe","pipe","pipe"] })`), so D2 needs no new capability.
- The frame layout: 1-byte kind, 4-byte big-endian length, payload (`terminal.ts:295-300`), read across chunk
  boundaries (`FramedTerminal#consume`, `:355-373`).
- Per-operation confinement in the helper: `confine_read` (helper `:40-49`), `confine` (`:244-258`), `identity`
  (`:293-304`) — all already per operation, so a session changes nothing about them.
- The one-shot helper program itself: `REMOTE_FILESYSTEM_SCRIPT` (38,382 bytes, base64 51,176 bytes). The session
  runs **the same program** with a request loop instead of the single dispatch at the end.
- `SshFilesystem.close()` (`ssh-filesystem.ts:156`) already aborts in-flight work through `#controller` and is
  called from gateway shutdown (`main.ts:61` → `index.ts:837`), so the session's teardown hook exists.
- The transport's failure vocabulary: `exit 255`/`null`/timeout/abort → `outcome_unknown`, spawn error →
  `unreachable`, nothing retried (`runner.ts:147-155,170,182`); install already documents "nothing was replayed"
  (`install.ts:993-1002`).

## 2. Filesystem: one persistent helper session

### 2.1 Session key and transport

Key: `(profileId, host, port ?? 22, identityFile ?? "", knownHostsFile ?? "", root)`. The profile id is part of the key
because `%C`-style host/port/user keys cannot discriminate two profiles that share `user@host:port` but differ in
identity file (ssh_config(5) TOKENS: `%C` hashes `%l%h%p%r%j` only). `root` is part of the key because the helper
confines to it and the runner's own check is per root.

The session is opened exactly like the terminal's (`terminal.ts:441-450`) with the profile's own
`identityFile`/`knownHostsFile`:

```
open({ profile, host, root, cwd: root, port, identityFile, knownHostsFile,
       command: ["python3", "-c", REMOTE_BOOTSTRAP, REMOTE_FILESYSTEM_BASE64, root] })
```

The helper receives `root` as `sys.argv[1]` exactly as today (`ssh-filesystem.ts:283` builds the same argv), so
`root = os.path.realpath(sys.argv[1])` and every confinement path is unchanged. `allow` no longer travels as
`sys.argv[2]`; it travels per request (§2.2) because it differs per method (`readAuthorization`,
`ssh-filesystem.ts:309-317`).

D2: when `runner.open` is absent, `SshFilesystem` reports `FileError("not_supported", ...)` on the first request and
keeps no second code path. The per-call `execute` implementation is deleted for the file surface rather than kept as a
fallback: the only transport that lacks `open` is a test fixture, and the fixture can implement it in three lines
because it already runs the real helper as a local process (`test/ssh-transport.ts:42-63`). Removing the dual path
removes the "which path am I on" class of bug, and the capability limit stays named instead of silently degrading.

### 2.2 Request and response frames

Request frame payload (UTF-8 JSON): `{ mode, args: string[], root, allow: { roots: string[], files: string[] } }`.
The helper re-parses `allow` per request and rebuilds `ALLOWED_ROOTS`/`ALLOWED_FILES` before dispatching `mode`, so
`readAuthorization` stays per request and the gateway's own path decisions (`remoteReadPath`, `mutationDenied`,
`isResourceRead`, `reportPath`) are untouched.

Response frame payload: the same JSON the one-shot helper prints today (`{"ok": true, "value": ...}` or
`{"ok": false, "error": {"code", "message"}}`). Frame kinds are the terminal's numeric space with filesystem values,
so a reader can tell a filesystem session from a terminal session if the two ever share a transport.

### 2.3 Bounds (derived, both sides)

- **Request ≤ 1 MiB.** That is the existing bound on the JSON body the file RPC accepts (`readJson`,
  `index.ts:911-916`: `if (bytes > 1024 * 1024) return undefined`), and the largest legitimate request is an upload
  `appendFile`: `UPLOAD_CHUNK_BYTES = 512 * 1024` raw (`file-transfer.ts:19,141`) → 699,051 base64 characters plus
  the JSON envelope, i.e. under the same MiB. No new number is invented.
- **Response ≤ 64 MiB.** The largest legitimate response is the larger of `base64(MAX_FILE_BYTES)` = 22,369,622 bytes
  (`read_binary`/`reader_read`, `MAX_FILE_BYTES = 16 MiB`, `filesystem.ts:16`) and the `snapshot` envelope, which the
  helper already refuses above `MAX_SNAPSHOT` = 16 MiB (helper `resource_snapshot`: `if len(json.dumps({"ok": True,
  "value": snapshot}).encode("utf-8")) > MAX_SNAPSHOT: fail("invalid", ...)`). 64 MiB is the next power of two above
  22.4 MiB and leaves headroom for JSON escaping of `read_text` (`json.dumps` expands control characters).
- **Enforcement.** The helper applies the same envelope check it already applies to `snapshot` to **every** mode
  (one `emit` guard, reusing the existing mechanism and message shape) and fails `invalid` when exceeded. The gateway's
  frame reader rejects a declared length above 64 MiB instead of slicing it — the terminal's reader has no such check
  (`terminal.ts:359-362` takes any `readUInt32BE` up to 4 GiB), so this is the one new invariant the filesystem session
  adds to the shared framing. Violation behaviour: fail the request `unknown` and drop the session (the stream is no
  longer trustworthy), never resynchronize.

### 2.4 Dispatch, waiting, and the two failure classes

- **One in flight (D3).** N>1 concurrent channels is unnecessary: every file RPC is a short request/response, the
  measured per-request cost inside a session is the round trip alone, and the server's `MaxSessions` default of 10
  (sshd_config(5)) is a ceiling to stay under, not a target. A second caller waits on the session's current request
  instead of opening a channel.
- **Bounded waiting (D4).** The wait is a promise, not a buffered queue, and the request's existing deadline
  (`SSH_FILE_TIMEOUT_MS = 60_000`, `ssh-filesystem.ts:10`) starts when the request arrives, not when it is dispatched.
  A request that expires or is aborted **before its frame is written** is answered `FileError("aborted", "the request
  was not sent") ` — a local failure with no remote effect. No separate queue-size limit is added: each waiter is one
  promise, and the HTTP layer already bounds concurrent requests.
- **Two failure classes (D5).** The session tracks per request whether its frame was written:
  - *queued, never written* → `aborted` (deadline, caller abort, or session death while waiting). Safe, local, never
    `outcome_unknown`.
  - *dispatched, response lost* → `unknown` with the existing "ssh filesystem outcome unknown" wording. Never retried.
  This distinction does not exist today (a spawn-per-call transport cannot be "waiting" for a child that does not exist
  yet), so it is introduced deliberately and only in this direction: `outcome_unknown` is never used for a request that
  was not written, and `aborted` is never used for one that was.
- **Deadline while dispatched.** A session has no per-request child to kill, so the deadline cannot mean "stop the
  remote operation". On expiry the request is answered `outcome_unknown` **and the session is dropped**, because a late
  response would otherwise be attributed to a later request. Dropping does not prove the remote operation stopped
  (`docs/ssh-interruption-verification.md`, `docs/local-integration.md`), so the wording stays outcome-unknown.

### 2.5 Writes: pinning and owned cleanup

- A write is several requests (`write_begin`, `write_chunk`*, `write_commit`/`write_abort`,
  `ssh-filesystem.ts:254-268`). **D6:** `write_begin` captures the session instance and every subsequent frame of that
  write goes to that instance, held as a pinned writer. A pinned session is not idle, so idle-close cannot fire
  mid-write; a cancellation aborts the write on the same instance (`write_abort`) and then releases the pin. A new
  session is never substituted for a half-written staging file.
- **D7:** the helper records the staging paths *it* created through `write_begin` in its own session state. On a
  graceful end (gateway `close()`, stdin EOF, or a CLOSE frame) the helper removes exactly those paths before exiting.
  It never enumerates a directory and never matches a pattern. If the session dies abnormally (transport loss, SIGKILL),
  the staging file is left in place and is **not** swept by a later session: it is not that session's file. The residue
  is harmless because each `write_begin` uses a fresh `randomUUID` name, so a later write to the same target cannot
  collide with it.
- **No replay.** A lost `write_commit` response is `outcome_unknown` even though the rename may have happened, and is
  never re-sent — the existing contract (`install.ts:993-1002`) restated for the session. `write_abort` is only sent
  for a failure in the same live session.

### 2.6 Read diagnostics under one call (D8)

Today `#readText`/`#readBinary`/`#open` issue `info` only to run `bounded()` (`ssh-filesystem.ts:192-229, 373-378`),
and the helper's `read_text`/`read_binary`/`open_reader` already call `regular(path)` (helper `:281-291`). The two
differ only in wording: `bounded()` says `is_directory` / "Not a regular file" and "file is N bytes; the gateway limit
is M bytes", while `regular()` says "Is a directory". The session's recommendation is to make the read modes report
**the same codes and the same messages** `bounded()` produces (including the path field), so dropping the `info`
pre-check changes no diagnostic a caller can see. This is the A2 cut from the research note, resolved as parity rather
than as a message regression. `open_reader`'s extra `no_follow` refusal ("Refusing to follow a symbolic link") is
unaffected because `info` never produced it.

### 2.7 Teardown, idle, and derived values (D9)

| value | new session | derivation |
| --- | --- | --- |
| per-request deadline | 60,000 ms | `SSH_FILE_TIMEOUT_MS` (`ssh-filesystem.ts:10`), unchanged |
| idle-close | 120,000 ms | `TERMINAL_RECONNECT_MS` (`terminal.ts:29`), the codebase's existing "how long a session with no caller is kept" |
| end grace | 5,000 ms | `TERMINAL_END_GRACE_MS` (`terminal.ts:31`), SIGHUP-then-SIGKILL |
| helper select slice | 0.5 s | `HELPER_SELECT_SECONDS` (`terminal.ts:33`) |

Teardown order on `close()`: stop accepting requests → send a CLOSE frame → wait up to the grace for the helper to
exit (it removes its own staging files first) → SIGKILL → resolve every in-flight request by class (§2.4) → drop the
key. Idle-close uses the same order but only when the session has no in-flight request and no pinned writer, and it
removes only the session, never authorization state (§2.2: authorization is per request, so there is nothing to
invalidate).

### 2.8 What must not change

`confine_read`/`confine`/`identity` per operation; `allow` per request; `remoteReadPath`/`mutationDenied`/
`isResourceRead`/`reportPath` in the gateway; `255`/`null`/timeout/abort → `outcome_unknown` with no retry;
`not_supported` when the host has no `python3` (`sshFailure`, `ssh-filesystem.ts:379-383`); reader handles stay
gateway-local with their existing TTL (`READER_TTL_MS = 5 min`, `MAX_READERS = 64`, `filesystem.ts:18,20`);
`reader.close` still touches no host state.

## 3. Install and execution: one gateway-managed ControlMaster

### 3.1 Justification

Both capabilities spawn one `ssh` per step and cannot ride the filesystem session:

- install: one `execute` per 32 KiB chunk (`install.ts:949-955`; `WRITE_CHUNK_BYTES = 32 * 1024`), plus
  `publish_begin`/`publish_commit`/`publish_abort`/`inspect`/`lock_read`/`toggle`/`lock_record`
  (`install.ts:917-934`). A 1 MiB skill directory is ~32 chunk calls; over the measured real link (~1,040 ms plain,
  ~218 ms warm) that is the difference between ~33 s and ~8 s of transport setup alone.
- execution: one `execute` per command (`runner.execute`), and a run of many commands is many processes.

ControlMaster is the right mechanism for these and the wrong one for the filesystem: it removes transport setup only,
while the session removes setup **and** the 51,176-byte payload transfer/decode (211 ms measured) **and** interpreter
start + helper load, and it does not change the number of helper runs (measured: 10 distinct remote pids in both
modes). Layering a master under the filesystem session would add a second reuse lifecycle and a second failure mode for
one capability that already holds one connection.

### 3.2 Owned socket lifecycle and the connection-profile key

- **Directory.** `join(HEPI_GATEWAY_DATA ?? ~/.hepi/gateway, "ssh-control")` — the gateway's existing owned state
  directory (`main.ts:28`), never the workspace. Created at startup with mode `0700` (ssh_config(5) requires a
  ControlPath directory not writable by others) and its mode re-checked; a failure to create or a wrong mode is a
  startup failure, not a silent fallback.
- **Socket name.** `hepi-<sha256(full profile key)[0:16]>`, where the key is
  `(profileId, host, port ?? 22, identityFile ?? "", knownHostsFile ?? "")`. `%C` is not used: it cannot discriminate
  two profiles that share `user@host:port` (ssh_config(5) TOKENS).
- **Creation.** The gateway's own ssh processes pass `-o ControlMaster=auto -o ControlPath=<path> -o
  ControlPersist=120` — `auto` so the first call becomes the master, `ControlPersist=120` derived from the same
  existing session-idle value as §2.7. The directory is created before the first spawn because a missing `ControlPath`
  directory exits 255 with **no fallback** (measured, `perf-a/logs/controlmaster.log`).
- **Reaping.** On gateway `close()` the gateway runs `ssh -O exit` for each master it created (ssh(1): `-O` accepts
  `check|forward|cancel|exit|stop`), with a bounded wait, then removes its own socket file and the directory. The
  gateway never removes a socket it did not create.
- **Restart residue, left alone.** Socket names are per gateway process (a start-time/pid component is included), so a
  restart never collides with a live sibling and never reuses another process's name. **There is no startup sweep at
  all**: nothing is deleted because a name or a pid looks dead, because a liveness guess is exactly the kind of
  speculative cleanup that can remove a socket a live process is still using. An abnormal exit therefore leaves its
  sockets in the gateway's own directory, and that residue is recorded as a **limit** in the owning guide rather than
  cleaned up speculatively.

### 3.3 Preserving user SSH config (D12)

The gateway adds its `-o` values to the argv it builds; it never passes `ControlMaster=no`, and it never edits or
deletes anything under `~/.ssh`. Consequences, stated rather than hidden:

- The user's own interactive `ssh` keeps its own `ControlPath` from `~/.ssh/config`; the gateway's explicit
  `ControlPath` applies to gateway-spawned processes only.
- If the user's config would have let gateway processes share the user's master, they now use the gateway's own socket
  instead. That is the intended isolation: the master is created with the profile's `identityFile`/`knownHostsFile`,
  and host-key verification happens once, at creation, by the process the gateway configured.
- On the runtime host, `ssh -G <runtime host>` currently reports `controlmaster false` and `controlpersist no`, so the
  change is a real behaviour change **for gateway-spawned install/exec processes on that host** and must be documented
  with the deployment notes. Nothing changes for the user's interactive `ssh`.

### 3.4 Not on the terminal

The terminal already holds one long-lived `open` per session (`terminal.ts:435-453`), so a master would save one setup
per session and add a second lifecycle to a capability that has one. Leave it alone.

## 4. Rejected

- **Caching `discover()`/`readAuthorization` (A3) or serving it from the committed snapshot (A4).** No invalidation
  signal exists at the gateway (research §8), and a TTL is not an invalidation policy. Authorization stays per request.
- **A dual path (session when `open` exists, per-call `execute` otherwise).** Speculative fallback; D2 replaces it with
  a named `not_supported`.
- **Sweeping `.hepi-write-*.tmp`** on session start or during `listDir`. The files are not that session's; deletion by
  pattern can remove a concurrent writer's file.
- **N>1 channels per session or a buffered queue.** Unnecessary for a short request/response protocol; the wait is a
  promise with the request's own deadline.
- **ControlMaster on the filesystem path, or a master under the session.** Two reuse mechanisms for one capability.

## 5. Order of work (each step independently verifiable)

1. `runner.open` presence check + named `not_supported` for `SshFilesystem`; test fixture gains `open` (runs the real
   helper as a local process, as it already does).
2. Session transport: open, frame writer/reader with the 1 MiB/64 MiB bounds, one-in-flight dispatch, the
   queued-vs-dispatched failure split, teardown/idle with the derived values.
3. Move `allow` into the request frame; add the helper's request loop; extend the envelope bound to every mode.
4. `regular()` message parity (§2.6), then delete the three `info` pre-checks.
5. Write pinning and helper-owned staging cleanup.
6. Install/exec ControlMaster: owned directory, profile key, `ControlPersist`, `-O exit` reaping.
7. Docs: deployment notes (gateway-managed ControlPath, the runtime host's behaviour change for gateway-spawned
   processes) and
   `docs/migration-status.md` for the session capability limit.

Existing coverage to keep green while doing this: `test/resource-snapshot.test.ts` (one helper run for a snapshot),
`ssh-filesystem.test.ts`, `ssh-resources.test.ts`, `ssh-workspaces.test.ts`, `file-transfer-sshd.test.ts`,
`sshd-fixture.test.ts`, and `apps/server/scripts/diag-ssh-rpc-count.ts` (helper-run counts).

## 6. Remaining uncertainty (UX only)

These are product-visible and are not answerable from the code. Nothing else is open; queue size, framing, bounds,
teardown values and vocabulary are decided above.

1. **Orphaned staging files become visible.** After an abnormal session death the residue is a real
   `.hepi-write-<uuid>.tmp` file in the target directory, so it can appear in a directory listing or a resource
   snapshot. Decide whether such names are filtered from listings/snapshots (a presentation rule), or whether the residue
   is accepted and documented.
2. **Wording of a session death.** Today a lost response is "ssh filesystem outcome unknown". With a session the user
   could be told "the SSH session ended; the operation's outcome is unknown", which is more actionable but a new string
   surface. Decide whether the distinction is worth surfacing.
3. **First-request latency after an idle close.** A session that closed after 120 s idle pays one full setup on the next
   request. If that is noticeable in the UI (a file view opened after a pause), the idle value may need to be larger;
   the value itself is derived above and would only change for this UX reason.

## 7. Facts cited

- `packages/gateway/src/runner.ts` (`b9b28dd`) — `:29-38` `SshOpenRequest`, `:41-46` optional `open` with its
  "named limit" wording, `:105` factory, `:107-113` connection args, `:115-121` `open` spawn (`stdio
  ["pipe","pipe","pipe"]`), `:123` `execute`, `:126` realpath/cd/pwd check, `:147-155` timeout/abort,
  `:170` `unreachable`, `:182` `255`/`null`.
- `packages/gateway/src/ssh-filesystem.ts` (`b9b28dd`) — `:10` `SSH_FILE_TIMEOUT_MS`, `:16`
  `WRITE_CHUNK_BYTES`, `:37-38` helper/base64/bootstrap, `:156` `close()`, `:192-229` read methods and their
  `info` pre-checks, `:254-268` `#write`, `:283` `#call`, `:301` `READ_METHODS`, `:309-317`
  `readAuthorization`, `:325-330` `isResourceRead`, `:336-343` `reportPath`/`reportInfo`, `:352-355`
  `mutationDenied`, `:361` `remoteReadPath`, `:373-378` `bounded`, `:379-383` `sshFailure`.
- Helper source (decoded from `REMOTE_FILESYSTEM_SCRIPT`, 38,382 bytes) — `confine_read` 40, `regular` 281,
  `identity` 293, `resource_snapshot` 746 with its `MAX_SNAPSHOT` envelope check at 878, `MAX_SNAPSHOT` 4,
  `MAX_SNAPSHOT_ENTRIES` 5, dispatch `root`/`allow`/`mode` 883-888.
- `packages/gateway/src/filesystem.ts` — `:16` `MAX_FILE_BYTES`, `:18` `READER_TTL_MS`, `:20` `MAX_READERS`.
- `packages/gateway/src/terminal.ts` — `:28-33` replay/reconnect/grace/select constants, `:295-300` `frame`,
  `:355-373` `#consume` (no length bound), `:435-453` `sshTerminalLauncher` incl. the `not_supported` wording.
- `packages/gateway/src/install.ts` — `:889-890` chunk/timeout, `:917-934` operations, `:949-955` per-chunk
  `publish_file`, `:964` `#call`, `:993-1002` no-replay contract.
- `packages/gateway/src/file-transfer.ts` — `:19` `UPLOAD_CHUNK_BYTES = 512 * 1024`, `:141` `appendFile`.
- `packages/gateway/src/index.ts` — `:526` the 1 MiB JSON-request comment, `:837` `files.close()` on shutdown,
  `:911-916` `readJson` 1 MiB bound.
- `packages/gateway/src/main.ts` — `:20-23` `HEPI_SSH_*` profile construction, `:28` `HEPI_GATEWAY_DATA ??
  ~/.hepi/gateway`, `:39-40` runner + `SshFilesystem` wiring, `:61` shutdown.
- `packages/gateway/test/ssh-transport.ts` — `:47-66` the local `pythonSshRunner` (real helper, local transport).
- `@earendil-works/pi-durable` `env` — `FileErrorCode = "aborted" | "not_found" | "permission_denied" |
  "not_directory" | "is_directory" | "invalid" | "not_supported" | "unknown"`.
- OpenSSH: ssh_config(5) `ControlMaster`/`ControlPath`/`ControlPersist` + TOKENS (`%C` = hash of `%l%h%p%r%j`;
  ControlPath directory must not be writable by others), ssh(1) `-O ctl_cmd`, sshd_config(5) `MaxSessions` default 10.
- Measurements (already recorded, not re-run): `perf-a/logs/helper-layers.log`, `helper-layers-real-link.log`,
  `controlmaster.log`, `controlmaster-real-link.log`, `ssh.log`, `diag.log`; `perf-b/ssh-controlmaster.md`.
- Interruption contract: `docs/ssh-interruption-verification.md`, `docs/local-integration.md`.
