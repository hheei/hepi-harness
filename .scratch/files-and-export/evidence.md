# Evidence: upload, binary preview/download

Every command below ran in this worktree (`.dev/worktrees/files-transfer`, branch `impl/files-transfer`) on
2026-10-12, against the revision the row names. Logs the shipped runners wrote live under the git-ignored
`.dev/verify/<timestamp>-<label>/`; the ones quoted here are the commands' own output.

## Fail before, pass after

| Slice | Command | Before | After |
| --- | --- | --- | --- |
| gateway payload routes | `cd packages/gateway && node --test test/file-transfer.test.ts` | `404 !== 200` on the first case (no such route), 1 fail | 11 pass, 0 fail; `node --test test/*.test.ts` 133 pass |
| backend relay | `cd apps/server && node --test test/file-relay.test.ts` | `ERR_MODULE_NOT_FOUND` for `src/file-relay.ts` | 6 pass, 0 fail |
| Web adapter | `cd apps/web && node --test adapters/files-transfer.test.mjs` | 7 fail (501 for upload, binary read and download) | 7 pass, 0 fail; `node --test adapters/*.test.mjs` 77 pass |
| end to end | `cd apps/server && node --test test/files-transfer.test.ts` | not written before the routes existed | 2 pass, 0 fail |
| SSH workspace, same rules | `node --test packages/gateway/test/file-transfer.test.ts` (the case through `pythonSshRunner`) | — | 1 pass: a 2 MiB new file staged and committed by the remote helper (no `.hepi-upload-` left in the root or in a subdirectory it wrote into), byte-exact on the host, `409` on an existing name, `206` for `bytes=0-15`, and `403` for a path that climbs out of the root — for a write and for a read — with nothing created beside the root |

| whole path, production Web server | `pnpm --filter @hepi/web build && node apps/web/e2e/files-transfer.mjs` | the routes did not exist | 19 assertions, exit 0 |
| the same script on the pre-implementation tree | `node apps/web/e2e/files-transfer.mjs` in the `576a49e` baseline worktree (built there) | — | exit 1, 13 FAIL — the upload answers 501 and the browser's own upload control reports the refusal |

Commits, one per slice: `5216cc3` (gateway), `499a61b` (backend relay), `258bd35` (Web adapter + end to end),
`b3d2f33` (docs), `8e2f611` (scope outcome + evidence), `876c535` (the production-Web demo).

The last row is the demo the slice was asked to reach: the built Next server, the backend, a real gateway and a real
workspace, driven at the browser's own addresses. It uploads a 1,400,013-byte file through the copied explorer's
multipart URL, reads the pre-flight answer and the 409 conflict refusal, downloads the file whole as an attachment,
previews the image as `image/png` with its own bytes, and answers `Range: bytes=1048570-1048580` with `206` and the
file's own slice.

It then drives the copied components in a headless browser over the same four processes: the explorer's own upload
control (its file chooser, its pre-flight `upload-check`) writes a 2x2 PNG into the workspace, the tree shows the row,
clicking it opens the viewer, the browser decodes the image from its own bytes (2x2 through `?type=read`), and the
explorer's download link returns the file byte for byte. Every wait is an observable change — the row appearing, the
image completing — and no sleep. The same script against the `576a49e` baseline fails: the browser's upload control
gets `501` and the explorer shows the refusal, so the run is sensitive to the change it covers.

Two defects the runs caught, both fixed:

1. **The file tree did not show a file just uploaded.** The Web adapter cached a workspace's listing for five seconds
   (`LISTING_CACHE_MS`, pre-existing) and an upload did not drop it, so the tree the copied explorer refreshes
   immediately after an upload read a listing from before the write — the flow this feature exists for, broken by a
   cache. `forgetListing` now drops the workspace's listing when an upload wrote something, pinned by
   `apps/web/adapters/files-transfer.test.mjs` ("a listing is cached for the tree, and an upload makes the next one
   fresh"): red without the call (1 fail), green with it.
2. **A request whose body was fully read was treated as a disconnection.** The backend relay watched `close` on the
   incoming request; Node fires it once the body has been read, so every upload ended as a caller abort. It now reads
   `aborted` on the request and a response `close` before the response was ended.

## Two defects the tests caught, and the fix each needed

1. **The pre-flight check named no workspace.** The relay's first version sent the workspace id in the JSON body of
   `/v1/files/upload-check`, while the gateway reads it from the query string. The unit test at the relay seam asserted
   the request it had been written to send, so it passed; the end-to-end test — a real backend, a real gateway — failed
   with `400 !== 200`, which is exactly what the seam could not see. The route now carries
   `?workspaceId=<id>` like its two siblings, and both tests assert it.
2. **A completed request body read as a disconnection.** The relay watched the incoming request's `close` event as its
   cancellation signal. Node fires that event as soon as a request body has been read to the end — every completed
   upload — so the relay cancelled its own host request and answered nothing: the POST routes hung. The signal is now
   the request's `aborted` event and the response closing before it was ended, which is what actually says the caller
   went away.

## Verification runs

| Check | Command | Revision | Result |
| --- | --- | --- | --- |
| gateway payload suite | `node --test packages/gateway/test/file-transfer.test.ts` | the tip | exit 0 — 14 tests, including the mode a replacement keeps, a throwing body, a mid-body disconnect, and the SSH loopback's own upload, conflict, mode, range and escape refusals |
| gateway payload suite, real sshd | `node --test packages/gateway/test/file-transfer-sshd.test.ts` | the tip | exit 0 — 1 test against a real localhost sshd through the real `ssh` client; red (1 fail) with the `preserveMode` seam removed |
| multipart reader | `node --test apps/web/lib/bounded-form-data.test.mjs` | the tip | exit 0 — 6 tests |
| web unit suite (adapters) | `node --test apps/web/adapters/*.test.mjs` | the tip | exit 0 — 80 tests |
| adapter payload suite | `node --test apps/web/adapters/files-transfer.test.mjs` | the tip | exit 0 — 8 tests |
| browser phase | `node apps/web/e2e/files-transfer.mjs` | the tip | exit 0 — 19 assertions |
| browser phase, pre-implementation | the same script in the `576a49e` baseline worktree | `576a49e` | exit 1 — 13 FAIL, the upload control's own request answers 501 |
| gate, review round | `pnpm verify --profile=fast` | `34918b5` and again at the tip `a0e9f1f`, clean tree both times | exit 0 — typecheck 0, workspace tests 0 |
| failure set, review round | `pnpm compare:tests --base=576a49e` | base `576a49e`, tip `34918b5` | exit 0 — identical failure set: 22 names on both sides, 0 new, 0 only on base; base 2139/2117 pass, tip 2152/2130 pass |
| entrypoints | `pnpm check:entrypoints` | `34918b5` | exit 0 — 61 present, the same 2 known-missing, 0 newly missing |
| whole path, browser | `pnpm --filter @hepi/web build && node apps/web/e2e/files-transfer.mjs` | `34918b5` | exit 0 — 19 assertions |
| gate | `pnpm verify --profile=fast` | `74ddd3b`, clean tree | exit 0 — typecheck 0, workspace tests 0 (gateway 122, server 227, client 9, protocol 46, session 3) |
| failure set | `pnpm compare:tests --base=576a49e` | base `576a49e`, tip `74ddd3b` | exit 0 — identical failure set: 23 names on both sides, 0 new, 0 only on base; tests base 2139/2117 pass, tip 2146/2124 pass |
| docs | `pnpm check:docs` | `74ddd3b` | exit 0 — 135 files, 0 broken links, 0 guides missing |
| entrypoints | `pnpm check:entrypoints` | `74ddd3b` | exit 0 — 61 present, the same 2 known-missing, 0 newly missing |
| Web unit suite | `pnpm test:web:unit` | `258bd35` | exit 1 — the recorded baseline exactly: 22 fail, 23 names, identical to the base |

At `685f73b` the gate was run twice on the clean tree: the first run failed once in
`apps/server/test/models-config.test.ts:245` ("environment mode keeps credentials in memory…",
`false !== true`), the second passed. `cd apps/server && node --test test/*.test.ts` passes alone (227/227), and the
case is unrelated to the file payload routes — recorded as a pre-existing flake in the models-config credentials test
under the gate's parallel load, not fixed here.

No build was run on the runtime host, no deployment command was run, no paid model call was made, and no live host was
contacted.

## Review round: the findings fixed here

Three commits answer the parent's review findings; each has its own red/green evidence.

`d66ba8f` — **a replacement lost the target's mode, and a dead body left a staging file.**

- `packages/gateway/test/file-transfer.test.ts` gains the mode case (an overwrite of a 0755 file and of a 0600 file),
  the throwing-body case, and a real mid-body disconnect: 4 fail before the fix (the disconnect case by timeout,
  because nothing ever removed the stage), 14 pass after. The SSH loopback case carries the same mode assertion.
- Fix: `renameFile` takes `preserveMode`, applied by both filesystems from the target's own mode and only when a
  replacement is happening; the staged lifecycle is one `try/finally` that owns the staging file until the rename
  succeeded.

`b9caaae` — **the batch bound was one buffered 17 MiB body.**

- `apps/web/lib/bounded-form-data.test.mjs` (new, 6 cases: declared bound, chunked bound, part order and the name as
  sent, whole-body read, a caller that refuses a part, no file parts) and two adapter cases (a partial batch that still
  drops the cached listing; a >100 MiB body refused mid-stream with the batch reason, ~94 ms and one chunk held at a
  time). All fail before the rewrite (no such module shape), 10 adapter cases and 6 reader cases pass after.
- Fix: `readUploadParts` parses the multipart body as it arrives (Next's own compiled busboy, no new dependency) and
  each file is relayed onward as a streamed request; the batch bound is the copied route's 100 MiB; one file's 16 MiB
  stays the host's per-file answer; `preservePath` keeps the browser's name so the upload's own rules refuse a path
  rather than this hop substituting a basename; `forgetListing` moved into the `finally`, so a partial batch
  invalidates the listing too.
- Dependency choice (reported, not invented): `next/dist/compiled/busboy/index.js`, resolved by the bundler and by
  Node's ESM rules, declared in `apps/web/lib/next-compiled.d.ts` and added to the tsconfig include list.

`fab3158` — **SSH was proven only through the loopback runner.**

- `packages/gateway/test/file-transfer-sshd.test.ts` (new) starts a real localhost `sshd` with generated keys, a
  pinned known-hosts file and the gateway's own `createSystemSshRunner`: a 1 MiB+ file past the JSON reader arrives
  whole, a replacement keeps 0755, `bytes=1048570-1048580` answers 206 from the host's own bytes, and `/../escape.bin`
  answers 403 with nothing created beside the root. Red without the `preserveMode` seam (1 fail), green with it.
- Skipped where no `sshd`/`ssh-keygen` exists; `HEPI_REQUIRE_SSH_SMOKE=1` turns that skip into a failure, as the
  packaged smoke already does.

## The leaked localhost sshd processes: where they came from

The 42 leftover `sshd -D -f /tmp/hepi-sshd-*/sshd_config` processes were **not** this branch's fixture. Its
`packages/gateway/test/file-transfer-sshd.test.ts` uses the prefix `hepi-file-transfer-sshd-` and starts the daemon
**without** `bwrap`; running it leaves 0 processes and 0 directories under that prefix. The leaked ones carry the
prefix of the pre-existing shared `packages/gateway/test/sshd-fixture.ts` (`mkdtemp(join(tmpdir(), "hepi-sshd-"))`,
used by `terminal.test.ts`, `worktrees.test.ts`, `ssh-workspaces.test.ts`,
`apps/server/test/terminal-transcript.test.ts` and `apps/server/test/ssh-project.test.ts`).

Reproduced in isolation, one fixture at a time: the non-isolated path cleans up (0 left), the `isolated: true` path
leaves 1. `stop()` does `child.kill("SIGKILL")` on the `bwrap` process, but sshd is the `exec`'d child of the
`/bin/sh` **inside** that namespace, so killing the wrapper does not signal the daemon; it is reparented to init and
listens forever on a port nothing will close. 41 of the 42 were in a mount namespace of their own — the isolated path
only — and one was non-isolated.

Proposed patch for the fixture's owner (`sshd-fixture.ts`, not this branch's file): `stop()` should kill the pid the
daemon itself recorded, before the wrapper — `await readFile(join(base, "sshd.pid"))` then
`process.kill(Number(pid), "SIGKILL")`, wrapped so a missing pidfile is not fatal, then `child.kill("SIGKILL")`. Proven
against a real reproduction: wrapper-only kill leaves 1 process; pidfile pid + wrapper leaves 0.

**Withdrawn after review** (`packages/gateway/test/sshd-fixture.ts`, `fix/sshd-fixture-teardown` `ca177c5` →
`93944ed`, blocked by review 73, which approved the final tree `722db2a` instead; **do not deploy either withdrawn
revision**): the pid file alone was not enough — it names the listener, while a *session* the host
served gets a session id of its own and survives both the pid-file kill and the wrapper's — so that revision killed
every process holding a file under the fixture's own tree. It removed the leak but was not ownership: any process may
hold a path, and the negative control's own observer holding `base/log` was the counterexample, which is also why the
scan had to walk the whole machine's `/proc/*/fd`. The reviewer named both, and the uncontained remote command it
could not reach: the connection's children hold the fixture's log, the command those children started holds nothing.

**Landed** (`2e96779`): both shapes run the daemon inside one sandbox,
`bwrap --dev-bind / / --unshare-pid --proc /proc --die-with-parent --tmpfs /run --dir /run/sshd` (plus the private
tmpfs only for `isolated`). The fixture's own child is then the sandbox's pid 1, and `stop()` signals exactly that
process, waits — bounded — for it to exit, and removes the tree; the kernel ends the rest of the namespace with its
pid 1. Measured against a real fixture, both shapes, with a session running `sleep 300 & wait`:

| observed | before (wrapper-only kill) | `2e96779` |
| --- | --- | --- |
| the listener after `stop()` | still open | refused within 24–26 ms |
| the connection's children (`sshd: <user> [priv]`, `sshd: <user>@notty`) | alive | gone |
| the shell the session ran in, and its `sleep 300` | alive | gone |
| a process holding the fixture's `log` open, from outside the sandbox | killed by the holder scan | survives, and the tree still removes |
| `sshd.pid` written by the daemon | `2` — a pid of the sandbox's namespace, which names nothing out here | unchanged, and no longer used to signal anything |

The tests read those identities without signalling: `NSpid` and `/proc/<pid>/stat` field 22 (start time, so a reused
pid cannot pass for the process that ended), walked from the wrapper's own children and never from the machine at
large. Availability is a real sandbox probe rather than a binary check, and `HEPI_REQUIRE_SSH_SMOKE=1` turns a missing
prerequisite into a failure instead of a skip.

The leak is reproducible on demand: **every `pnpm verify --profile=fast` in this branch leaves exactly 2**, and the
gate re-run twice at the tip did so both times. That count is this branch's fixture contributing 0 (its own prefix,
`hepi-file-transfer-sshd-`) and the shared fixture's isolated path contributing the 2 — the 2 isolated cases in
`terminal.test.ts` (`startSshdFixture({ isolated: true })`), the only isolated consumers in the tree.

Cleaned here: **6 processes**, each identified by its own `sshd_config` path and its start time against a run this
branch recorded — one isolated fixture from this branch's comparison probe, one from the first probe of this
reproduction, and four from two of this branch's own `verify --profile=fast` windows (`.dev/verify/2026-10-12T11-39-10-115-verify-fast`
and `.dev/verify/2026-10-12T11-41-22-784-verify-fast`), every one reparented to pid 1. Nothing belonging to another
session was signalled, the system sshd (pid 1642, port 22) was never a candidate, and no `/tmp/hepi-sshd-*` or
`/tmp/hepi-file-transfer-sshd-*` directory remains.

## The gateway restart of 2026-10-12: what a teardown experiment cost

An intermediate revision of this branch's fixture teardown — never committed, and not the one that landed — enumerated
*this session's own* mount namespace for the non-isolated case and SIGKILLed every process in it. It hit
`hepi-gateway.service`, the user's live gateway on the same host, not a fixture:

| time (2026-10-12) | event |
| --- | --- |
| 20:09:30, 20:09:53, 20:10:25, 20:10:38, 20:10:57 | gateway `Main process exited, code=killed, status=9/KILL`; each restart listened on 28788 |
| 20:10:59 | first failing start: `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite` |
| 20:10:59 → 20:38:55 | 187 failing starts, no listener on 28788; `hepi-web.service` deactivated |
| 20:39:07 | pinned `/usr/bin/node` start: listening again, Web back with it |

Why the restarts failed is the *unit*, not the kill: it started the bundle through a `.bin` shim whose shebang is
`#!/usr/bin/env node`, and the manager's `PATH` resolves that to `~/.local/node-v20/bin/node` (a Node 20), while the
bundle imports `node:sqlite` (Node 22+). Neither the unit file (10:40:43), the bundle (`cli.js` sha256
`169c7e5b46a07a31c082f1d92b7606b1761596f92b167cdf1b388942b95812d4`, unchanged since 10:40:29) nor that Node install
(ctime 2026-05-09) changed that day, so what moved the manager's `PATH` is not recorded; the pin removes the dependency.
The unit was therefore altered and restarted, and a backup of it is kept at
`~/.local/share/hepi/backups/20261012T203700-gateway-unit-node-pin/hepi-gateway.service`.

Impact, checked read-only afterwards:

- Services: gateway and Web were down 20:10:59–20:39:07 (Web deactivates with the gateway) and are active again;
  `hepi-tunnel.service` stayed active throughout; the `remote-host` containers were never restarted (`restarts=0`,
  backend `96297fe`, Web `df24b7c`).
- Data: `calls.sqlite` held its 783 rows before and after; no durable database was written.
- Workspaces: the gateway keeps its registry in memory, so the four project-folder workspaces (`hey`, `hepi-harness`,
  `Hepi Mono`, `Hepi Harness`) answered `unknown workspace` again, while the configured `integration` workspace
  resolved host metadata throughout. **Corrected read-only, 2026-10-12:** those four were re-registered through the
  path the server already uses (`ensureBinding`, reached by one `POST /api/worktrees` `operation: "list"` per recorded
  folder — the operation is unsupported on a folder that is not a git worktree, and registering is what that branch
  does first), after which `GET /api/workspaces` answered five workspaces with **0** `hostError` instead of four. No
  durable state was written, no service was restarted, and the registration is in-memory, so a future restart reverts
  to the same self-healing state.

The lesson this branch keeps: a teardown may only ever signal what the fixture itself owns, and *owning a path is not
owning a process*. The fixture now owns a pid namespace — its child is that namespace's pid 1 — so one signal ends
everything the daemon forked, including the sessions OpenSSH `setsid`s out of reach, and nothing outside it is a
candidate. The negative-control test asserts exactly that, in both shapes: a neighbouring fixture, the session it is
serving, an unrelated child of the test, and an unrelated process holding a file inside the tree being removed all
survive the stop.

## Limits left standing

- One upload request carries at most 100 MiB in total (the copied route's own batch bound), enforced while the body is
  read; a single file over the host's 16 MiB policy is refused by the host with `file_too_large` (413) and the file
  named. The two refusals name themselves separately.
- A download is capped by the 16 MiB policy, so a larger file is refused rather than streamed unbounded; media seeking
  works through `Range` for files within the ceiling. A download does not yet watch the caller's own signal — the
  backend relay does, and the gateway notices a closed response; recorded as advisory, not a blocker.
- Live file watch, DOCX preview, file CRUD other than upload, and session export remain unsupported, unchanged.
