# SSH transport and remote-helper reuse (perf route 3)

Research only: **no code changed, no production write, no paid call.** Grounded on the intended base
`integration/chat-lifecycle` = `b9b28dd` (`b9b28dda040d09aa7472514726e5ec6d1d7d0bb5`) and the deployed
`cb4494b` (`cb4494b0b4429bda1d9940257f661239171ce502`). The working-tree HEAD `fa495b4` (impl/capability-11) is
**unrelated** and is not used for any claim here except where it is explicitly named. Every source path is quoted from
the tree at `b9b28dd` unless a different revision is named.

Scope note (rev 2): the SSH connection/helper reuse work is **in this effort, not deferred**. Track A below was
re-derived line by line against the code at `b9b28dd` and its first draft's count math and safety argument were
wrong; §9 records the corrected version and the exact cuts. Track B is now a concrete lifecycle design (§11), not a
"reconsider later".

## 0. Revision map

| tree | revision | relevance |
| --- | --- | --- |
| `integration/chat-lifecycle` (branch) | `b9b28dd` | intended base; carries the resource-snapshot increment and the node-ignore port |
| `deploy/cb4494b0` / `perf/lane-c` | `cb4494b` | deployed code; `git diff cb4494b b9b28dd` is docs-only (5 files under `docs/`) |
| main worktree | `fa495b4` | unrelated; predates the snapshot helper, so its `ssh-filesystem.ts` has no `snapshot` mode |

`packages/gateway/src/ssh-filesystem.ts` is byte-identical in code between `cb4494b` and `b9b28dd` (the only diff is
documentation), so the line numbers below hold for both.

## 1. Where SSH runs today, and how a call is built

The gateway spawns a **new `ssh` process per helper run**; there is no connection sharing, no daemon and no
long-lived remote process on the file path.

- Transport factory: `packages/gateway/src/runner.ts:105` `createSystemSshRunner()`.
  - Shared connection args (`:107-113`): `-o BatchMode=yes -o ConnectTimeout=5`, then `-p`, `-i <identityFile> -o
    IdentitiesOnly=yes`, `-o UserKnownHostsFile=<file> -o StrictHostKeyChecking=yes`. **No `ControlMaster`,
    `ControlPath` or `ControlPersist` is passed** (grep count 0 in `runner.ts`, `ssh-filesystem.ts`, `install.ts`).
    The client's own `~/.ssh/config` therefore decides; on the build host `ssh -G <runtime-host>` reports `controlmaster false`
    and `controlpersist no` (only `Host scdcu` sets them, `~/.ssh/config:74-76`; `/etc/ssh/ssh_config.d` is empty;
    `~/.ssh/master` is empty).
  - `open()` (`:115-121`): `spawn("ssh", [...connection, "--", host, "exec " + argv])`, stdio `["pipe","pipe","pipe"]`.
    This is the **only long-lived session** the transport already supports, and it is what the terminal uses.
  - `execute()` (`:123-186`): remote shell wraps the argv in
    `root=$(realpath -- ROOT) || exit 126; cd ROOT; here=$(pwd -P); case "$here/" in "$root/"*) ... esac; exec env -i
    PATH=/usr/bin:/bin <argv>`, stdio `["ignore","pipe","pipe"]`. Failure mapping: `exit 255` or `null` →
    `outcome_unknown` (`:182`), a timeout (`:149`) and an abort (`:153`) → `outcome_unknown`, spawn error →
    `unreachable` (`:170`). Nothing is retried.
- File RPC helper: `packages/gateway/src/ssh-filesystem.ts:283` `#call` builds
  `python3 -c <bootstrap> <REMOTE_FILESYSTEM_BASE64> <root> <allowJSON> <mode> [args]`.
  `REMOTE_FILESYSTEM_SCRIPT` is one self-contained Python 3 program; at `b9b28dd` it is **38,382 bytes / 1,078
  lines** (verified by decoding the embedded literal), shipped as a **51,176-byte base64 argv word on every call**,
  with a 148-byte bootstrap (`:37-38`). It reads no stdin (`sys.stdin` appears nowhere) and `sys.exit(0)`s after one
  JSON result. Constants: `SSH_FILE_TIMEOUT_MS = 60_000` (`:10`), `WRITE_CHUNK_BYTES = 32*1024` (`:16`),
  `MAX_FILE_BYTES` bound from `filesystem.ts`.
- Install helper: `packages/gateway/src/install.ts:476` `REMOTE_INSTALL_SCRIPT` — **19,041 bytes / 406 lines**,
  **25,388 base64 bytes** per call, bootstrap at `:886`, `SSH_INSTALL_TIMEOUT_MS = 60_000` (`:890`). Same one-shot
  shape (`:964`).
- Terminal helper: `packages/gateway/src/terminal.ts:45` `TERMINAL_HELPER_SCRIPT` — **4,313 chars / 143 lines**,
  started through `runner.open` (`:435` `sshTerminalLauncher`, command at `:197`). Unlike the other two it **does
  read stdin** (a framed 1-byte-kind + 4-byte-length protocol, `terminal.ts:123-159`), so a persistent
  request/response session over SSH stdin is already proven in this codebase.
- The node-ignore port is *inside* the filesystem helper (Python `class IgnoreRule` / `class Ignore` /
  `def ignores`, helper lines ~638/668/710), mirrored by `packages/gateway/src/resource-ignore.ts` (40 lines, TS) and
  licensed by `packages/gateway/src/node-ignore.LICENSE` (MIT, node-ignore 7.0.5). This is what inflated the helper to
  its current 38 KB; see `docs/migration-status.md:57-60` (b9b28dd).

## 2. Profile / workspace / auth mapping

- `SshProfile` (`packages/gateway/src/index.ts:99`): `{ id, host, remoteRoot, port?, identityFile?, knownHostsFile? }`.
  Built from env in `packages/gateway/src/main.ts:20-31` (`HEPI_SSH_HOST`, `HEPI_SSH_PROFILE`, `HEPI_SSH_PORT`,
  `HEPI_SSH_IDENTITY`, `HEPI_SSH_KNOWN_HOSTS`) and in `packages/client/src/config.ts:181-183` (`mode: "local" | "ssh"`).
- Workspace id → profile+root: `sshWorkspaceSeed` (`packages/gateway/src/workspaces.ts:111`) seeds `remote-<profile>`;
  `workspaceOwner` (`:120`) resolves an id **opaquely** through the shared `WorkspaceRegistry` (`:57`), and
  `registerResolved` (`:96`) stores `(id → root, profileId)`. Registration is idempotent for the same id+root and
  refuses a different root for a taken id, so a given `workspaceId` never changes root.
- Auth: HTTP RPC auth is a single shared `Bearer <gateway token>` (`packages/gateway/src/index.ts:518,531,544`); SSH
  auth is whatever the spawned `ssh` uses (agent / `-i` file / `~/.ssh/config`). There is no per-profile credential
  store in the gateway.

## 3. Confinement, read/write semantics (what a persistent helper would have to preserve)

- Helper confinement, per operation, in-process:
  - `confine_read(path)`: allow if lexically within `[root] + ALLOWED_ROOTS` **and** `realpath` stays within that same
    candidate, or the path is in `ALLOWED_FILES` and its realpath is too; else `permission_denied` (helper lines
    ~40-49). **A path inside the workspace root is allowed by `root` alone; the allow list is not consulted for it.**
  - `confine(root, path)` (every mutation): confines to `root` only; the allow list is unused.
  - `identity(path, dev, ino)` re-opens and re-checks device+inode on every reader call, so a swapped file is caught at
    the moment of the operation.
- Gateway side: `readAuthorization(host, method)` (`ssh-filesystem.ts:309`) turns the host's own `ExecutionHost` into
  `{roots, files, denied}`; `remoteReadPath` (`:361`) only decides whether an absolute path is a resource location;
  `mutationDenied` (`:352`) refuses a mutation naming a resource. `READ_METHODS` at `:301`.
- **Mandatory per RPC for trust** (cannot be cached without weakening a documented property):
  1. the runner's own `realpath + cd + pwd -P` workspace-root check (`runner.ts:126`), and
  2. the helper's per-path `realpath` confinement at the moment of the operation — a symlink swapped between two calls
     must be caught then.
- **Reusable** (identical across calls, or a pure function of stable inputs): the helper program text (byte-identical
  every call), the Python interpreter start, and the account identity (`host` → `pwd.getpwuid`).
  The `discover()` result is *not* safely reusable without an invalidation signal that does not exist — see §9 A3.

## 4. What each non-snapshot RPC pays today (the redundancy)

`SshFilesystem.execute` (`ssh-filesystem.ts:100`) short-circuits `executionHost` (`:109`) and `resourceSnapshot`
(`:112`, one helper run), but **every other method** calls `#readAuthorization` (`:115` → `:186`), which calls
`#host` (`:171`), which runs **two** helper programs: `host` then `discover` (`:172,177`). So:

| method | helper runs today | modes |
| --- | --- | --- |
| `resourceSnapshot` | 1 | `snapshot` |
| `executionHost` | 2 | `host`, `discover` |
| `fileInfo` / `listDir` / `canonicalPath` / `exists` | 3 | `host`, `discover`, op |
| `readTextFile` / `readBinaryFile` | 4 | `host`, `discover`, `info`, `read_*` |
| `openBinaryReader` | 4 | `host`, `discover`, `info`, `open_reader` |
| `reader.info` / `reader.read` / `reader.scanLines` | 3 | `host`, `discover`, `reader_*` |
| `reader.close` | 2 | `host`, `discover` (no helper call of its own) |
| `writeFile` (1 chunk) | 5 | auth, `write_begin`, `write_chunk`, `write_commit` |
| `appendFile` / `truncateFile` / `flushFile` / `renameFile` / `remove` / `createDir` (1 chunk) | 3 | auth, op |
| `createTempDir` / `createTempFile` | 3 | auth, `tmpdir`/`tmpfile` (called with **no** allow list) |

The two authorization runs are constant overhead (they do not grow with path depth or file size), and each is a full
process spawn + SSH round trip. `#call` also passes `signal: this.#controller.signal` with a 60 s timeout.

## 5. Current deployment topology: the per-RPC path is **latent**, not normal

- The deployed gateway is a **local** gateway. `~/.config/hepi/gateway.env` contains **0** `HEPI_SSH*` keys
  (`HEPI_ALLOWED_COMMANDS, HEPI_GATEWAY_DB, HEPI_GATEWAY_ID, HEPI_GATEWAY_PORT, HEPI_GATEWAY_TOKEN,
  HEPI_WORKSPACE_ROOT`); `packages/gateway/src/main.ts:20-59` then builds `LocalGateway` / `LocalFilesystem` and never
  calls `createSystemSshRunner()`.
- `systemctl --user show hepi-gateway.service` → `ActiveState=active`, `NRestarts=0`,
  `ExecStart=.../release-cb4494b/node_modules/@hepi/client/dist/cli.js gateway`; the process listens on
  `127.0.0.1:28788`.
- The per-RPC SSH path is the **SSH-profile gateway** (an SSH Project, ADR 0005), reachable only when
  `HEPI_SSH_HOST` is configured. `packages/gateway/src/main.ts:20` is the switch; `packages/client/src/config.ts:183`
  sets `mode: "ssh"`.
- Consequence: any statement of the form "the gateway pays 3–5 ssh spawns per file op" describes the **SSH-profile
  capability**, not the running deployment. The route-3 work is therefore about making that capability correct and
  cheap, not about a live regression on the build host today.

## 6. Measurements already available (do not re-run to cite)

All under `.dev/worktrees/chat-lifecycle-integration/.scratch/perf-a/` (worktree HEAD `b9b28dd`) and
`.dev/worktrees/perf-lane-b/.scratch/perf-b/`:

- `perf-a/logs/helper-layers.log` — local real-sshd fixture, per-RPC split:
  ssh setup **146.6 ms**, Python start **4.8 ms**, helper load **13.2 ms**, request's own work **0.6 ms**; plain RPC
  **167.8 ms** → ControlMaster **22.3 ms** (−86.7 %) → one persistent stdin session **2.3 ms/req** (−98.6 %).
- `perf-a/logs/helper-layers-real-link.log` — real link (build host → runtime host, ~110 ms RTT): ssh+true 1,040 ms plain /
  218 ms mux; **51 KB helper payload costs 211 ms** (transfer+decode) + 41 ms compile/exec/account = **252 ms/req that
  ControlMaster does not touch**; `mux-helper-host` 432 ms, `mux-helper-info` 452 ms.
- `perf-a/logs/controlmaster.log` — fixture: plain shell p50 152.3 ms / 10 authentications / 10 distinct remote pids;
  mux shell 3.9 ms / 1 auth / 10 pids; mux python 8.7 ms / 0 auth. Stale socket recovers automatically (155.7 ms then
  10.4 ms); a **missing `ControlPath` directory exits 255 with no fallback**; a second call naming a nonexistent
  `identityFile`+nonexistent known-hosts **still exits 0 riding the master** (identity and host-key policy not
  re-enforced).
- `perf-a/logs/controlmaster-real-link.log` — real link: plain 946/978/894/933/926 ms; mux 909 (master) then
  230/222/218/219 ms; per-call saving ≈ 700 ms (≈6 RTT).
- `perf-a/logs/ssh.log` — helper runs per operation: `resourceSnapshot` 1; `skillBodyRead` 4; `fileInfo` 3;
  `listDir` 3.
- `perf-a/logs/diag.log` — `diag-ssh-rpc-count --flat --skills=65`: `helperRuns: 1`, `authorizationRuns: 0`
  (the snapshot path already removed the overhead for discovery).
- `perf-b/ssh-controlmaster.md` and `perf-b/REPORT.md` finding 3 — the same 2-uncached-spawn observation, plus the
  deployed-pair context ("the deployed pair never exercises the per-RPC ssh path").
- `.scratch/submit-stall/diagnosis.md` (at `44c485f`) — 328–716 helper runs per resource walk, 60–62 % of them
  `host`+`discover`, before the snapshot increment.

Repro commands already recorded: `node .scratch/perf-a/measure-helper-layers.mjs`,
`measure-helper-layers-real-link.mjs`, `measure-controlmaster.mjs`, `measure-controlmaster-real-link.sh <runtime-host>`,
`node apps/server/scripts/diag-ssh-rpc-count.ts --flat --skills=65`.

## 7. OpenSSH primary sources (official)

- `ControlMaster` / `ControlPath` / `ControlPersist` — ssh_config(5), <https://man.openbsd.org/ssh_config.5>:
  multiplexing shares one network connection over a Unix-domain control socket; passengers use the same `ControlPath`
  with `ControlMaster=no` and fall back to a normal connection if the socket is absent; `ControlPersist` keeps the
  master in the background after the first client closes, indefinitely for `yes`/`0` or for a timeout.
- `ControlPath` tokens — ssh_config(5) TOKENS: the accepted set is `%%, %C, %d, %h, %i, %j, %k, %L, %l, %n, %p, %r,
  %u`, and **`%C` is a hash of `%l%h%p%r%j` only**. There is no token for the identity file or known-hosts file, so a
  `%h/%p/%r` or `%C` path cannot discriminate two profiles that share `user@host:port`. The docs recommend the path
  live in a directory not writable by other users.
- `ssh -O ctl_cmd` — ssh(1), <https://man.openbsd.org/ssh.1>: valid commands are `check`, `forward`, `cancel`,
  `exit`, `stop`; this is how a master is inspected or reaped.
- Multiplexed session protocol — PROTOCOL.mux, <https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.mux>:
  passenger clients open a session with `MUX_C_NEW_SESSION` **passing stdio file descriptors over the control socket**;
  proxy clients use `MUX_C_PROXY` and speak a subset of the SSH connection protocol. A persistent helper with per-call
  stdin/stdout is exactly the passenger shape.
- `sshd_config` `MaxSessions` default **10** per network connection; `MaxStartups` default `10:30:100` —
  <https://man.openbsd.org/sshd_config.5>.
- `no-more-sessions` global request (PROTOCOL §2.2, `openssh-portable/PROTOCOL`): an OpenSSH client with multiplexing
  disabled tells the server to refuse further session channels. This is the security reason multiplexing is the
  recommended way to reuse one authenticated connection; it does **not** change per-channel semantics.

## 8. Reusable vs per-RPC-mandatory: the classification

| computation | reusable across RPCs? | key / invalidation |
| --- | --- | --- |
| helper program text + base64 | yes, byte-identical | constant; a persistent session removes it entirely |
| Python interpreter start | yes, once per session | constant |
| account identity (`host` → `{user,home}`) | yes | key `(profileId, remote uid)`; changes only with the account |
| `discover()` result (roots, context/prompt files, shadowed context) | **not today** — no invalidation signal exists (§9 A3) | would need a key `(profileId, root)` *and* an owner for invalidation |
| canonical workspace root (`realpath+cd+pwd -P`) | no — per operation | must stay per RPC |
| helper per-path `realpath` confinement | no — per operation | must stay per RPC |
| the `info` pre-check in `#readText`/`#readBinary`/`#open` | removable (the read already checks) | see §9 A2 — message parity, not a free cut |
| snapshot (`resourceSnapshot`) | already one call | the **server** commits it; the gateway never holds it |

Stable facts from the code: `#profiles` is a map built once at construction (`ssh-filesystem.ts:93-96`); a profile
change needs a new instance. `WorkspaceRegistry.register`/`registerResolved` refuse a second root for a taken id
(`workspaces.ts:96-109`), so a `workspaceId` never moves.

**The gateway has no invalidation API.** There is no reload route, no resource-change notification and no method on
`SshFilesystem` that tells it the host's resource layout changed; the only teardown hook is `close()`
(`ssh-filesystem.ts:156`). Reload exists only as a **conversation** action on the server
(`apps/server/src/workspace-resources.ts:505` `reloadResources`, ticket 03) and the gateway is never told. The
committed snapshot is fetched by the server (`workspace-resources.ts:193`) and answered from in-process
(`snapshotEnvironment`, `:585`), so the gateway neither stores nor learns of it. Any caching of `discover()` at the
gateway is therefore **a design requirement to be built (an invalidation signal and its owner), not an existing
capability** — and a TTL is not an invalidation policy, so it is not offered as one here.

## 9. Track A, re-derived (corrected)

The first draft of Track A claimed "resolve the allow list lazily: only a read whose path is absolute and outside the
workspace, or a mutation whose target is absolute, needs it" and stated "2 runs instead of 4 (3→2 for `fileInfo`)".
Both parts are wrong.

**9.1 Count math.** `#readAuthorization` is **two** helper runs (`host`+`discover`). Removing both gives
`fileInfo` 3→**1**, not 3→2; only the content reads go 4→2. Corrected counts are in §9.4.

**9.2 Safety: the lazy test changes behaviour, because resource locations live *inside* the workspace root.**
`resource_roots()` in the helper adds, among others, `<workspace>/.pi/skills`, `<workspace>/.agents/skills` and
`<workspace>/.pi/prompts` (helper `add(os.path.join(workspace, ...))`, lines ~174-208), and `prompt_files` adds
`<workspace>/.pi/SYSTEM.md` and `<workspace>/.pi/APPEND_SYSTEM.md`. `context_files()` walks the workspace *and its
ancestors*, so a context file can also be in-root. Therefore a **relative** path (or the logical `/.agents/...` form)
can name a resource location. Consequences of skipping authorization for "in-root" paths:

- **`mutationDenied` would stop refusing writes to in-root project resources.** `readAuthorization` returns
  `denied: [...resourceRoots, ...resourceFiles]` for every non-read method (`ssh-filesystem.ts:313-317`), and
  `mutationDenied` (`:352-355`) checks **both** the raw path and `remotePath(root, path)`, precisely so a relative or
  logical alias cannot write a resource its physical path is refused (same invariant on the local side:
  `filesystem.ts:766-786` `mutationPath`/`namesResource`). With an empty `denied` list,
  `writeFile(".agents/skills/x/SKILL.md")` and `createDir(".pi/prompts")` would no longer be refused by the gateway;
  whether the helper's own `confine(root, ...)` then also refuses them depends only on whether that in-root resource
  directory resolves inside the root (it does when it is a real directory, which is the normal project case) — so a
  read-only host location becomes writable. That is a behaviour and security change, not an optimization.
- **The reported path of an in-root resource read would change.** `isResourceRead` (`:325-330`) requires an absolute
  path inside `allow.roots` or in `allow.files`; for an in-root resource root that is true today, so `fileInfo`,
  `listDir`, `canonicalPath` and `reader.info` report the **real host path** (`reportPath`/`reportInfo`,
  `:336-343`). With no allow list they would report the logical workspace form `/.agents/skills/...` instead, which
  is the path the loader and the model's file tools address differently.
- The helper's `confine_read` is *not* the thing that changes: it already allows anything lexically inside `root`
  (helper `[root] + ALLOWED_ROOTS`), so an in-root resource root in `ALLOWED_ROOTS` is redundant for confinement. The
  allow list matters for **denial** and **reporting**, which is exactly what a lexical shortcut drops.

No lexical test can decide "this request cannot name a resource location", because the resource locations can be
inside the root. The owning seam is not the path form; it is **who resolves the host's resource locations and when**.
Track A therefore keeps authorization per request and makes it cheaper, instead of skipping it.

**9.3 Exact cuts (no cache, no TTL, no new trust boundary).**

- **A0 — three methods resolve authorization they provably do not use.** `execute` resolves `#readAuthorization`
  before the switch (`:115`), but:
  - `createTempDir` / `createTempFile` call `#call` **without** an allow argument (`:141-142`), so the helper already
    receives `{}` today (`:283` `allow ?? {}`), and the mutation loop has no target (`request.path` and
    `request.destinationPath` are both undefined, `:119-123`). Behaviour is byte-identical.
  - `reader.close` returns before any helper call (`#reader`, `:234`), and the mutation loop again has no target.
  Result: temp methods 3→**1**, `reader.close` 2→**0**.
- **A1′ — fold `host` into `discover`** (one helper run instead of two). `#host` (`:171-184`) runs `host`, then passes
  the claimed identity to `discover`; the helper's `discovery(claimed)` (helper `:220-234`) uses only
  `claimed['user']`, `claimed['home']` and the module-global `root`, and `account_of()` (helper `:51-63`) is in the
  same program. One invocation can compute the account and then the discovery itself. This **preserves the documented
  property** ("the locations reads are authorized against are the host's answer and not a value the gateway supplied",
  `:175-177`): the host still computes both; nothing the gateway invented enters. Removes **1** of the 2 authorization
  runs for every non-snapshot RPC, with no cache and no invalidation.
- **A2 — fold the `info` pre-check into the read** (contract parity required). `#readText` (`:192-198`),
  `#readBinary` (`:200-206`) and `#open` (`:218-229`) each issue `info` only to run `bounded()` (`:373-378`).
  The helper's `read_text`, `read_binary` and `open_reader` already call `regular(path)` (helper `:281-291`), which
  applies the same three checks against the same `MAX = 16 * 1024 * 1024` as `MAX_FILE_BYTES`. So the pre-check is
  redundant, **but the messages differ**: `bounded()` reports a directory as `is_directory` / "Not a regular file"
  while `regular()` says "Is a directory". A2 is a message/contract decision (whose text callers see), not a free cut.
  Removes **1** more run from `readTextFile`/`readBinaryFile`/`openBinaryReader`.
- **A3 — REJECTED as written: reuse the `discover()` result across requests.** The allow list is a snapshot of the
  host's layout, so caching it is state with a staleness window, and §8 shows the gateway has no invalidation API and no
  owner for one. This is a **design requirement to be built**, not a provided capability, and a TTL is explicitly not
  proposed as its invalidation policy.
- **A4 — REJECTED: serve the allow list from the committed snapshot.** The snapshot is server-side conversation state
  (`workspace-resources.ts:193,585`); the gateway never holds it, and `resourceSnapshot` does not even call `#host`
  (`:112,165-168`). Serving it would require a new per-request field carrying the host and would stop the gateway
  asking the host — a trust-boundary change with no existing caller.

**9.4 Corrected counts (helper runs per RPC).**

| method | today | A0 | +A1′ | +A2 |
| --- | --- | --- | --- | --- |
| `resourceSnapshot` | 1 | 1 | 1 | 1 |
| `executionHost` | 2 | 2 | **1** | 1 |
| `fileInfo` / `listDir` / `canonicalPath` / `exists` | 3 | 3 | **2** | 2 |
| `readTextFile` / `readBinaryFile` | 4 | 4 | 3 | **2** |
| `openBinaryReader` | 4 | 4 | 3 | **2** |
| `reader.info` / `reader.read` / `reader.scanLines` | 3 | 3 | **2** | 2 |
| `reader.close` | 2 | **0** | 0 | 0 |
| `createTempDir` / `createTempFile` | 3 | **1** | 1 | 1 |
| `writeFile` (1 chunk) | 5 | 5 | **4** | 4 |
| `appendFile` / `truncateFile` / `flushFile` / `renameFile` / `remove` / `createDir` | 3 | 3 | **2** | 2 |

A0+A1′+A2 leave the transport untouched, keep every confinement and denial decision in the same owner, add no state
and no invalidation, and preserve "the locations reads are authorized against are the host's own answer".

## 10. Track B — scope decision

**B is in this effort, not deferred.** Track A alone still pays one SSH process + interpreter + 51 KB payload per
request (§9.4: 2 runs for a content read, 1 for a stat). Track B removes that per-request cost rather than shrinking
it. The two tracks are independent: A0/A1′/A2 are correctness-preserving reductions that a persistent session also
inherits, and the session design in §11 does not depend on them.

## 11. Track B — persistent helper session: concrete lifecycle

The design reuses what already exists: `SshRunner.open` and the terminal's framing. Everything below states which
parts are **established semantics** (upstream or already implemented in this repo) and which are **remaining product
choices**.

**11.1 Transport — one session per `(profile, root)`, opened through the existing `open`.**
`SshRunner.open` is optional (`runner.ts:41-46`) and already receives `profile`, `host`, `port`,
`identityFile`, `knownHostsFile`, `root`, `cwd` and `command` (`SshOpenRequest`, `runner.ts:29-38`); the terminal
passes exactly those fields (`terminal.ts:441-450`). A filesystem session is therefore
`open({ profile, host, root, cwd: root, port, identityFile, knownHostsFile, command: ["python3","-c",BOOTSTRAP,HELPER,root] })`
— the same helper program with a request loop instead of a single `sys.exit(0)`. **Profile isolation is inherited,
not re-implemented**: the session is keyed on the profile, and each `open` passes that profile's `identityFile` and
`knownHostsFile` to the same connection args the one-shot path uses (`runner.ts:107-113`). When `open` is absent the
capability is already reported as a named `not_supported` (`terminal.ts:439-440`), which is the fallback the file path
can use verbatim (keep the per-call `execute` path).

**11.2 Framing — reuse the terminal's, plus one invariant it does not state.** Established: 1-byte kind, 4-byte
big-endian length, then payload (`terminal.ts:295-300`; helper `send`/`read_exact`); the reader reassembles across
chunk boundaries (`FramedTerminal#consume`, `:355-373`). **Not established: a bound on the declared length.** The
gateway-side reader accepts any `readUInt32BE` value up to 4 GiB (`:359-362`) and the terminal never needed a limit
because its payloads are bounded by the helper's own behaviour. A filesystem session carries file content, so the
session protocol must state a **max frame length on both sides** and what a violation does. That is a required new
invariant, not a reuse. (The payload itself is already bounded by `MAX_FILE_BYTES`/chunk sizes, but the frame reader
must not depend on the sender to be honest.)

**11.3 Per-operation path checks stay per operation, and `allow` is per request.** Established: `confine_read`,
`confine` and `identity` run on every operation (helper `:40-49, 244-258, 293-304`) and the runner's
`realpath+cd+pwd -P` check runs per `execute` (`runner.ts:126`). Required by that: the session's request frame carries
`{root, allow, mode, args}` and the helper re-parses `allow` per request, because `readAuthorization` returns a
different list per method (`ssh-filesystem.ts:309-317`: `denied` for mutations, `roots`+`files` for reads). The
workspace-root check has to be re-expressed too: with no per-request shell there is no `realpath+cd+pwd -P`, so the
session must perform the equivalent check in the helper per request (it already has `realpath` and `lexical_within`).

**11.4 Authorization is not cached (no TTL).** The session must not carry a `discover` result across requests. With
A1′ the session still answers `host`+`discover` as one request per RPC — on an already-open channel, so it costs one
round trip and no process start. Any *further* reduction needs the invalidation signal of §8/§9 A3, which does not
exist and is not assumed here.

**11.5 Bounded concurrency.** Established upstream: `sshd_config` `MaxSessions` defaults to **10** per connection, so
the server caps concurrent channels; the session must not rely on that as its own bound. The terminal sidesteps the
question (one shell per session), and the one-shot path gets concurrency for free (one process per request). A shared
session therefore needs an explicit in-flight bound and a queue policy — a product choice (§11.9).

**11.6 Cancellation and timeouts — cannot be copied, must be re-stated.** Today each request owns a child: timeout →
`child.kill("SIGTERM")` + `outcome_unknown` (`runner.ts:147-150`), abort → SIGTERM + `outcome_unknown` (`:151-155`),
`exit 255`/null → `outcome_unknown` (`:182-184`). A session has no per-request child, so "kill the request" has no
direct meaning. The design must choose between (a) a per-request deadline after which the **session is dropped** and
the in-flight request is reported `outcome_unknown`, or (b) no per-request timeout at all. Either way the existing
honesty property holds and must be stated: dropping a session does not prove the remote operation stopped
(`docs/ssh-interruption-verification.md`; `docs/local-integration.md`), so the answer stays `outcome_unknown`, never
"failed" and never a retry.

**11.7 `outcome_unknown` and no replay of writes.** Established: the file RPC maps transport failures to
`FileError` (`ssh-filesystem.ts:283-300`), the install server returns `outcome_unknown` and never replays
(`install.ts:963-980`), and the backend states "nothing was replayed" (`install.ts:993-1002`). A session preserves
this structurally: one request frame, one response frame, and a session death fails exactly the requests in flight.
One hazard the terminal does not have and the session must decide: a write is **several** requests
(`write_begin`, `write_chunk`*, `write_commit`, `:254-268`), so a session death between `write_begin` and
`write_commit` leaves an orphaned `.hepi-write-<uuid>.tmp` in the target directory and no `write_abort` runs. The
no-replay rule must be stated for `write_commit` specifically: a lost commit response is `outcome_unknown` even
though the rename may have happened, and it is never re-sent.

**11.8 Session cleanup.** Established lifecycle to reuse (terminal): the helper ends its own process group when its
stdin reaches EOF (helper `:149-154` → `end_session()` → SIGHUP, then SIGKILL after `TERMINAL_END_GRACE_MS = 5000`,
`terminal.ts:31`); a session with no caller attached is closed after `TERMINAL_RECONNECT_MS = 120_000` (`:29, 501`);
retained output is capped at `TERMINAL_REPLAY_CHARS = 128 * 1024` (`:28`); a transport loss resolves the exit as
`{exitCode: null, signal: 0}`, never an exit (`FramedTerminal#finish`, `:388-393`); and gateway shutdown aborts
in-flight work through `#controller` (`ssh-filesystem.ts:156`, `close()`). The filesystem session needs the same
shape: die with stdin, close on `close()`, and (choice) close when idle — where an idle close is a **resource
policy**, not an authorization cache, so it does not contradict §11.4. Note the filesystem helper today reads no stdin
at all, so the EOF-dies-with-gateway guarantee is an addition, not a reuse.

**11.9 Remaining product choices (only these).**

1. Session granularity: one session per `(profile, root)`, or one per profile with `root` per request (root must
   travel per request either way for confinement).
2. In-flight bound per session (1, or N with a queue) and the fate of queued requests when the session dies.
3. Cancellation/timeout contract for a session with no per-request child (§11.6) and which failures map to
   `outcome_unknown`.
4. Max frame length and its violation behaviour (fail the request vs drop the session).
5. Orphaned staging files after a session death: sweep on session start, `write_abort` on session death, or accept.
6. Idle-close policy for a session (a resource policy; explicitly not an authorization TTL).
7. Whether the session serves filesystem only, or also install (see §12).

## 12. ControlMaster alongside the persistent helper: additive or redundant?

Comparing the two mechanisms against the measured cost split (§6):

| what it removes | persistent session | ControlMaster |
| --- | --- | --- |
| transport setup (146.6 ms loopback / ~1,040 ms real link) | yes | yes (~700 ms real link) |
| 51 KB payload transfer + decode (211 ms real link) | yes | **no** |
| Python interpreter start + helper load (18 ms loopback / 41 ms real link) | yes | **no** |
| number of helper runs / remote pids | yes (the run *is* the session) | **no** (10 distinct remote pids in both modes) |

- **Where ControlMaster is still additive:** the capabilities that open *separate* `ssh` processes and cannot ride
  the filesystem session — the **terminal** (one `open` per session, `terminal.ts:435-453`), the **install server**
  (one `execute` per `publish_file` chunk, 32 KiB each, `install.ts:949-955`), and **execution/bash**
  (`runner.execute`). Those are many-process capabilities, so a master would help them.
- **Where stacking is redundant:** running ControlMaster **and** a persistent filesystem session means two reuse
  mechanisms with two lifecycles and two failure modes, for one capability. Measured costs of the master path that the
  session does not inherit: a missing `ControlPath` directory exits 255 with **no fallback**
  (`perf-a/logs/controlmaster.log`), a stale socket needs its own recovery, identity and host-key policy are enforced
  once at master creation and **not re-applied** to later calls (measured: a passenger naming a nonexistent
  `identityFile` still exits 0), and `%C` cannot discriminate profiles sharing `user@host:port` (ssh_config(5)
  TOKENS: `%C` is a hash of `%l%h%p%r%j`), so a per-profile `ControlPath` must carry the identity/known-hosts
  discriminator itself.
- **Recommended shape (one mechanism per capability):** filesystem → persistent session; terminal → already one
  long-lived `open` per session, so a master buys it one setup only; install/exec → ControlMaster, since reuse there
  would otherwise need a new protocol. If ControlMaster is adopted, it must be keyed on the full profile, not on `%C`
  alone.
- **No stacking on the same capability.** The persistent session must not also require a master: the session's own
  connection is already authenticated once with the profile's `identityFile`/`knownHostsFile`, and routing it through
  a master would move host-key verification to a different process than the one the gateway configured.

## 13. Established semantics vs remaining choices

**Established (no new decision needed; quoted above):** `SshRunner.open` is optional and its absence is a named
`not_supported`; the frame layout and cross-chunk reassembly; `confine_read`/`confine`/`identity` run per
operation; `allow` is per method; `255`/`null`/timeout/abort → `outcome_unknown` and never a retry; install and
file writes are never replayed; `MaxSessions` default 10; multiplexing passenger semantics and the `%C` token set;
the terminal's reconnect window, replay cap, SIGHUP→SIGKILL grace and EOF-dies-with-stdin; gateway shutdown aborts
in-flight work.

**Remaining product choices:** §11.9 items 1–7, plus (a) whether an invalidation signal for host resource locations is
built at all (without it, authorization stays per request, which is the safe default), and (b) whether the helper stays
one program with a request loop or is split. Nothing else is open.

## Evidence index (repo)

- `packages/gateway/src/runner.ts` (`b9b28dd`, 188 lines) — `:105` factory, `:107-113` connection args, `:115` `open`,
  `:123` `execute`, `:126` realpath/cd/pwd check, `:148-155` timeout/abort → `outcome_unknown`, `:170`
  `unreachable`, `:182` 255/null → `outcome_unknown`; `:29-38` `SshOpenRequest`, `:45-49` optional `open`.
- `packages/gateway/src/ssh-filesystem.ts` (`b9b28dd`, 385 lines) — `:10` timeout, `:16` chunk, `:37-38` helper/base64,
  `:93-96` profile map, `:100` `execute`, `:109` `executionHost`, `:112` snapshot, `:115` auth call, `:119-123`
  mutation loop, `:156` `close`, `:165` `#snapshot`, `:171-184` `#host`, `:186` `#readAuthorization`, `:192-206`
  `#readText`/`#readBinary`, `:208` `#info`, `:218-229` `#open`, `:234` `reader.close`, `:254-268` `#write`,
  `:283` `#call`, `:301` `READ_METHODS`, `:309-317` `readAuthorization`, `:325-330` `isResourceRead`,
  `:336-343` `reportPath`/`reportInfo`, `:352-355` `mutationDenied`, `:361` `remoteReadPath`, `:373-378` `bounded`.
- `packages/gateway/src/filesystem.ts` (`b9b28dd`, 903 lines) — `:16` `MAX_FILE_BYTES`, `:280-297` `executionHost`,
  `:302` `LocalFilesystem`, `:420-427` snapshot/frontmatter bounds, `:558` `resourceSnapshot`, `:714-764`
  `resourceRootOf`/`resourceFileOf`/`resourceReadPath`, `:766-786` `mutationPath`/`namesResource`, `:827`
  `relativePath`, `:867` `resolveWorkspacePath`, `:900` `within`.
- `packages/gateway/src/install.ts` (`b9b28dd`, 1010 lines) — `:476` helper, `:884` base64, `:889-890` chunk/timeout,
  `:906` server, `:949-955` per-chunk `publish_file`, `:964` `#call`, `:993-1002` no-replay contract.
- `packages/gateway/src/terminal.ts` (`b9b28dd`, 698 lines) — `:28-33` replay/reconnect/grace constants, `:45` helper,
  `:149-154` stdin-EOF ends the process group, `:194` bootstrap, `:197` command, `:295-300` `frame`,
  `:310` `FramedTerminal`, `:355-373` frame reader (no length bound), `:388-393` `#finish`,
  `:422`/`:435-453` launchers.
- `packages/gateway/src/workspaces.ts` — `:57` registry, `:96` `registerResolved`, `:111` `sshWorkspaceSeed`,
  `:120` `workspaceOwner`.
- `apps/server/src/workspace-resources.ts` (`b9b28dd`) — `:163` `SnapshotReader`, `:192-196` `resourceSnapshot` use,
  `:505` `reloadResources`, `:576-616` `snapshotEnvironment`.
- `packages/gateway/src/main.ts:20-59`, `packages/gateway/src/index.ts:99,411,518`,
  `packages/gateway/src/environment.ts:19`, `packages/gateway/src/resource-ignore.ts`,
  `packages/gateway/src/node-ignore.LICENSE`, `packages/client/src/config.ts:181-183`.
- Helper source (decoded from `REMOTE_FILESYSTEM_SCRIPT`, 38,382 bytes) — `account_of` 51, `confine_read` 40,
  `resource_roots` 174, `discovery` 220, `real_within` 237, `confine` 244, `info_of` 271, `regular` 281,
  `identity` 293, `resource_snapshot` 746, argv parse `ALLOWED_ROOTS`/`ALLOWED_FILES` 885-886.
- Tests at `b9b28dd`: `packages/gateway/test/{resource-snapshot,ssh-filesystem,ssh-resources,ssh-workspaces,sshd-fixture,ssh,file-transfer-sshd}.test.ts`
  and the fixtures `ssh-transport.ts` / `sshd-fixture.ts` (real `sshd` in a bwrap pid-namespace sandbox; the
  `pythonSshRunner` fixture runs the real helper under a controlled local transport).
- Docs: `docs/migration-status.md` (`b9b28dd`, lines 57-60), `docs/cb4494b-deployment.md`,
  `docs/local-tailscale-deployment.md`, `docs/ssh-interruption-verification.md`, `docs/local-integration.md`,
  ADR 0002, ADR 0005.
- Measurements: `.dev/worktrees/chat-lifecycle-integration/.scratch/perf-a/` (evidence.md + logs + scripts),
  `.dev/worktrees/perf-lane-b/.scratch/perf-b/` (ssh-controlmaster.md, REPORT.md),
  `.scratch/submit-stall/diagnosis.md`, `apps/server/scripts/diag-ssh-rpc-count.ts`.
