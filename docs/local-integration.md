# Gateway integration

## Development

`pnpm dev` from the repository root starts the gateway, the backend and the Vite dev server together with hot restart.
The gateway runs under `node --watch` like the backend, so an edit to `packages/gateway` restarts both. Development state
(SQLite files) goes to `.dev/`; `HEPI_DEV_WORKSPACE` picks the workspace root, which defaults to the repository. The backend's three SQLite files
(conversations, skill repository, project metadata) all live under `.dev/` too; `HEPI_PROJECTS` names the project
metadata file and defaults to `projects.sqlite` beside `HEPI_DB` (see [projects](projects.md)). The manual
per-terminal commands below remain the production-shaped path and run without a watcher.

## Local startup

Use separate terminals:

```bash
HEPI_GATEWAY_TOKEN=local-gateway-token HEPI_WORKSPACE_ROOT=/absolute/workspace \
HEPI_WORKSPACE_ID=local HEPI_ALLOWED_COMMANDS=bash pnpm --filter @hepi/gateway start
# Add HEPI_TERMINAL_HEARTBEAT_MS=<ms> to state the terminal stream's keepalive cadence, or 0 for none.
# Unset reads the stated default (30 s).
```

```bash
HEPI_AUTH_TOKEN=local-server-token HEPI_WORKSPACE_ID=local \
HEPI_GATEWAY_URL=http://127.0.0.1:8788 HEPI_GATEWAY_TOKEN=local-gateway-token \
pnpm --filter @hepi/server start
# Add HEPI_HEARTBEAT_MS=<ms> to state the conversation stream's keepalive cadence, or 0 for none.
# Unset reads the stated default (30 s).
# Add HEPI_MCP_TOOLS='<JSON array>' to state the operator's fallback presentation of MCP tools; see
# docs/mcp-on-the-web-host.md#from-a-durable-conversation-ticket-02. It offers nothing by itself and
# is no ceiling: unset, the backend still installs hepi.mcp, and every tool a conversation is
# granted comes from the host's own listing of its server.
```

**The page needs an ingress, and `pnpm dev` does not start one.** `pnpm dev` runs the Vite dev server on
`127.0.0.1:30141` with `/api` proxied to `HEPI_INGRESS_ORIGIN` (default `http://127.0.0.1:8790`), so that address has to be
a running client ingress or the page has no API. Start one against the backend `pnpm dev` started, with its own release
or the repository source:

```bash
HEPI_INGRESS_BACKEND=http://127.0.0.1:8787 \
HEPI_INGRESS_SERVICE_TOKEN=local-server-token \
HEPI_INGRESS_PORT=8790 \
HEPI_INGRESS_DEFAULT_HOST=workstation \
HEPI_INGRESS_MCP_GATEWAY_URL=http://127.0.0.1:8788 HEPI_INGRESS_MCP_GATEWAY_TOKEN=local-gateway-token \
HEPI_INGRESS_MCP_GATEWAY_ID=workstation \
node packages/gateway/src/ingress/main.ts          # no static dir: the dev server serves the page
```

Then open http://127.0.0.1:30141/?cwd=%2Fworkspace%2Flocal; the dev server's `/api` calls reach that ingress and the
ingress reaches the backend. A loopback bind needs no `HEPI_WEB_LOGIN_TOKEN`. To exercise the **production** shape
instead, build the page and let the ingress serve it on its own port
(`HEPI_INGRESS_STATIC_DIR`, [deployment](deployment.md#secrets)); that is the one request origin a browser sees in a
deployment, so a cookie session behaves there as it will in production. `/durable` is chat-only. Persisted
conversations keep logical workspace IDs, not gateway credentials/physical paths.

Published upstream CodingTools read/write/edit/bash use gateway ExecutionEnv, installed as the one `coding-tools` extension whose own wrapper opens a call scope. Those four names are the whole tool vocabulary an agent definition may name: the definition surface reads them from this extension rather than repeating a list, so a definition cannot save a tool no request can offer, and the definition list answer states the same set as `capabilities.tools`. Shell execution identity is the conversation ID, durable task ID, model call ID and the command's ordinal within that call (`base#n`), so a tool that runs several commands — the same command twice included — produces several executions instead of colliding on one identity; a repeated request for one identity is still answered from the ledger. Outside a call scope the identity is random and no dedup is claimed. Execution results and liveTools share the authoritative durable state projection.

## SSH prerequisites

Gateway-only environment: HEPI_SSH_HOST=user@host, HEPI_SSH_PROFILE=loopback, HEPI_WORKSPACE_ROOT=/remote/root; optional HEPI_SSH_PORT, HEPI_SSH_IDENTITY and HEPI_SSH_KNOWN_HOSTS. Backend workspace ID must be remote-loopback. Host needs Python 3 on PATH for filesystem operations; no Pi, dependency installation, daemon or inbound application service is required. Workstation SSH config/agent/ProxyJump and host verification are retained.

**Installation and execution multiplex over one gateway-managed SSH master.** A gateway serving an SSH profile creates
`<HEPI_GATEWAY_DATA>/ssh-control` (default `~/.hepi/gateway/ssh-control`) at startup with mode **0700** and passes
`-o ControlMaster=auto -S <socket> -o ControlPersist=120` to the `ssh` processes it spawns for `/v1/installs` and
`/v1/execute`. The socket is its own argv word after `-S`, never an `-o ControlPath=` word: ssh re-parses an `-o` value
as a configuration line, so a space in the state directory — `.../hepi gateway data/ssh-control` — would end the path
there and fail the call with exit 255 before it authenticated. The socket is named from the **full** connection profile
— profile id, host, port, identity file and known-hosts file — plus this gateway process's pid, so two profiles that
share `user@host:port` never share a master and two gateways running at once never collide. The pid is not a nonce, so
a restarted process whose pid was recycled could name a socket an earlier crash left behind; that residue, and a
process running as the same account, are recorded as limits rather than defended against — see
[Migration status](migration-status.md#performance-follow-up-ssh-reuse-tickets-06-and-07-delivered). A
directory that cannot be created, or one whose mode is not 0700, is a startup failure: the gateway never falls back to
an unmultiplexed spawn behind the caller's back.
Files, workspace management, worktrees and terminal sessions keep the plain transport — a terminal already holds one
connection for the life of a session — so their SSH settings are exactly the user's own, and the filesystem keeps that
same plain transport as well: its session is described below and never stacks a master behind one.

Filesystem helper is a single embedded Python program passed through quote-safe argv. On an SSH workspace it runs as
**one persistent session per (profile, root)** over the runner's interactive transport, so the program text, the
Python start and the connection are paid once per session instead of once per operation; the local filesystem runs
in-process and has no session. A transport that cannot hold a session open reports `not_supported` and keeps no
per-call fallback path. Writes stage in the target directory then replace, and the whole write rides one pinned
session so an idle close or a cancellation cannot move a half-written file; SSH loss stays unknown, never retried, and
a request the session never wrote is reported as not sent. Every request carries the gateway's own file deadline
(`SSH_FILE_TIMEOUT_MS`), so a host that accepts a frame and never answers cannot hold a request or the waiters behind
it: a written request that passes the deadline is unknown, one that only waited is not sent. Every end the gateway
initiates asks the helper to close and gives it a bounded grace to remove the staging files it recorded itself. Remote readers reopen/check device/inode on each request
rather than hold persistent fd; replaced files fail invalid. Local opened readers retain upstream fd semantics.

## Capability bounds

File RPC supports text/binary read/write, append/truncate/flush, rename/remove, directory creation, workspace-local temporary files/dirs, metadata/list/canonical/exists and bounded binary reader operations. Payload cap is 16 MiB; at most 64 handles, idle expiry five minutes enforced on request, cleanup on shutdown. Temp names reject separators; logical temp paths stay inside root. Full watch/line/directory readers remain explicit not_supported, not full environment conformance.

A read-only file request naming a file below an execution-side resource root (`<workspace>/.pi/skills`, its
`.agents/skills` and each ancestor's up to the repository root, then the account's `<home>/.pi/agent/skills` and
`<home>/.agents/skills` and the account/workspace `.pi/prompts`), or exactly one of the host's context, system-prompt
or append-prompt files, is served with its real canonical path, so ordinary reads reach them outside the workspace;
results for those reads keep the real host path. That is upstream's `resourcePrecedenceRank` order, so a `.pi` root
wins a duplicate name over the `.agents` root of the same scope. Those locations are read-only: a mutating method
naming them as a physical path, as a logical `/.agents/skills/...` path or as a relative `AGENTS.md` path is refused,
for the source and the destination of a rename, and a link to a resource file is not that file. That refusal is path
discipline for the loader and install code, not a sandbox: the agent already runs with the user's trust on this host,
and the tool-level guards are not meant to contain a determined process.
`/v1/files` method `executionHost` reports the account, home, its agent directory (`agentDir`, the account's
`<home>/.pi/agent`), canonical workspace root, roots, context files, system/append prompt candidates and the
`shadowedContextFile` of the host being served (the main repository's context
file a nested linked git worktree shadows; see [execution-side resources](execution-side-skills.md)). On an SSH
workspace the remote helper resolves the account and
home from the host's own account database and computes the same roots, context files and prompt candidates there, in
one discovery request that returns the account and the scope set together, so no gateway-local value is used and a
request that needs the locations pays one round trip; reads name the workspace, a resource root or a resource file and
everything else on the host stays unreachable. See [execution-side resources](execution-side-skills.md).

One more location pair is served through the same surface, and only for agent definitions: a `/v1/files` request whose
`resource` is `agent-definitions` may read and mutate the project's `<workspace>/.pi/agents` and the account's
`<agentDir>/agents`, and nothing else — reads are authorized against exactly those two directories, and mutations are
confined to them, so a definition is the one write a workspace-scoped surface may place outside the workspace root. The
backend's definition surface (`apps/server/src/agent-definitions*.ts`) is the only caller: it resolves the workspace's
owning gateway from the binding, lists, reads, writes whole documents and deletes by name, and a host that cannot be
reached answers `host_unreachable` instead of falling back to the machine the backend runs on. A remote host computes
the same two directories from its own account database, so the account's `agentDir` is that host's, never the gateway's
or the backend's.

Shell /v1/execute uses NDJSON output frames followed by one result. Local output spill/window delegates to NodeExecutionEnv; full-output paths currently refer to gateway-local temp files, not browser-readable logical workspace files. Do not assume a spill diagnostic is downloadable remotely. Client awaits each frame callback; HTTP writes wait for drain and destroy a lagging connection over 1 MiB queued bytes. Local NodeExecutionEnv cannot pace its producer, so that connection may lose its response (unknown outcome); its command is still journaled. Gateway shutdown closes connections, aborts active commands and waits for settlement before closing SQLite.

**Capture is linear in what was written.** Each stream of a call owns its chunks, its retained UTF-8 byte count and its clipped state (`OutputCapture` in `packages/gateway/src/execution.ts`); appending measures only the chunk it is given and the retained text is joined once, when the call ends. The bound is `captureBytes` per stream (default 4 MiB, `DEFAULT_CAPTURE_BYTES`), a cut lands on a complete character, and stdout and stderr are limited separately. The live caller is never truncated: every chunk still travels the sink in full, and `truncated` reports only what the *ledger* dropped. `spill`, `spillUnsupported`, failure and `outcome-unknown` are unchanged, and a repeated call ID is still answered from the ledger with the same bounded capture and no second execution.

Terminal sessions are a separate gateway surface with their own lifecycle: `POST /v1/terminal` opens one in a registered workspace root, `GET /v1/terminal/<id>/events` streams its output as server-sent events and ends with one exit frame, `POST /v1/terminal/<id>/input` and `.../resize` reach the shell, and `DELETE /v1/terminal/<id>` closes it and answers the exit that follows. The shell runs through the gateway's own Python 3 helper on the execution host — the local machine, or the SSH host over the same runner the other surfaces use — which gives it a real pseudoterminal and ends the process group on close, on shell exit, or when the gateway that owned it disappears. A host that cannot serve a session names its reason with `not_supported` (no Python 3, no pty module, a transport that
cannot hold a session open) or `unreachable` (an SSH host that cannot be reached), and the gateway's open route answers
any refused open with `409`, the reason travelling in the body. The backend relay keeps that status and the host's own
code for a definitive refusal. `501` is the answer of a gateway composed *without* the terminal capability: the gateway
route answers it directly, and the relay, whose transport reads that status as a property of the host rather than a
rejection of the call, answers `501 not_supported` too. Unknown sessions answer `unknown_terminal`; a cwd outside the
workspace answers `path_denied`. Nothing about a session is written to a conversation transcript: a terminal belongs to no conversation.

**A quiet stream stays attached.** Between keystrokes a terminal writes nothing, so the gateway's own event stream writes a **comment frame** — an event-stream line with no field name — on the cadence in `TERMINAL_HEARTBEAT_MS` (30 s), armed with the attachment and cleared with it. It carries no `id:` line: a cursor on a comment frame would move the caller's reconnect position to an offset no output exists at. The terminal proxy in front of the gateway passes the frame through with the rest of the body, untouched, and never writes one of its own. A deployment whose fronting hop applies a stricter idle bound states its own cadence in `HEPI_TERMINAL_HEARTBEAT_MS` (or through the terminal sessions' `heartbeatIntervalMs` for an embedded gateway) rather than discovering it by watching a session reconnect; `0` states no keepalive.

**Reconnect, replay and the session's own name.** Two numbers are this capability's whole configuration, and they are the only new ones it introduces. A session keeps at most **128 KiB of its own output** (`TERMINAL_REPLAY_CHARS`), measured in the characters a caller sees, so a reconnect is bounded and a long-running command cannot grow a gateway's memory without limit. A session with no caller attached is kept for a **120-second reconnect window** (`TERMINAL_RECONNECT_MS`) and then closed, so a dropped browser connection has time to come back and a closed tab leaves no shell behind; a session that has already ended is forgotten when its window runs out, so the map does not grow with every terminal a user ever opened. `GET /v1/terminal/<id>/events` takes the caller's cursor as `after` or as the standard `Last-Event-ID` header and answers with the output produced since it, or with the retained tail and `reset: true` when the cursor is behind what is kept — a caller that sees `reset` replaces what it shows instead of appending, so a stream is never silently inconsistent. Every output frame carries its own offset as the event's `id`, which is what a browser's own `EventSource` reconnect continues from. A caller may name its session with `id` on `POST /v1/terminal`: opening an id already running in the same workspace reaches that session instead of starting a second shell, an id already running in another workspace is refused, and `GET /v1/terminal/<id>` reports what the session is (including whether it has ended) without attaching to it.

**A lost command answer stays an unknown outcome at the execution seam.** `gatewayEnvironment` (`packages/gateway/src/environment.ts`) is the conversion owner: the gateway answer's `timeout` and `aborted` become those `ExecutionError` codes, a definitive refusal (a denied command, a reused call ID, an offline gateway) keeps the gateway's own code as the message, and only `outcome-unknown` is rewritten — its message starts `outcome_unknown:` and says the command may have run, that the outcome is not established, that the call is never replayed, and which call ID it can be resolved under. Upstream's `ExecutionError` codes are a closed set with no unknown-outcome member, and the tool seam gives the caller only this text, so the distinction travels in the message instead of being flattened into one generic `unknown` failure (child-task-recovery ticket 02, gap G1). The `bash` tool throws the error, the Harness makes it an `isError` tool result carrying the output already streamed, and the tool task settles normally: no replay policy changes, and nothing is sent a second time under any identity.

**That statement is measured end to end, not only at the conversion.** `apps/server/test/recovery-acceptance.test.ts` delegates a child whose `bash` runs against a gateway in a **separate process** over its own SQLite journal, kills that gateway with `SIGKILL` after the command's side effect has landed, and reads the child's transcript after it settles: one `isError` result starting `outcome_unknown:` naming the child's own scoped call ID, and normal completion. Restarting the gateway on the same journal and replaying the **captured wire request** answers with that same call ID, code `outcome-unknown` and the gateway's own reason, and the side effect stays one line — the command did not run twice (ticket 04, gap G3). An interrupted answer is measured the same way: the backend is killed while a generation partial is committed, reopen converts exactly that partial into **one** assistant entry whose response ended (`stopReason: "aborted"`), and the reopened run takes the interrupted turn up itself with **one** model request handed the user's own turn — the retained partial is a fact for readers, not model context, so the turn is restated rather than continued (gap G4). Both stages are `SIGKILL` evidence about the isolated stacks they build; they state no power-loss, disk-corruption or cross-process exactly-once claim.

CLI call journal defaults to ~/.hepi/gateway/calls.sqlite; HEPI_GATEWAY_DB or HEPI_GATEWAY_DATA overrides it. One process owns each gateway journal. Admission/dispatched records left by restart are outcome-unknown, not retried. Output payloads have finite retention; spent IDs remain outcome-unknown tombstones so payload eviction cannot authorize replay. Identity metadata consequently grows with admitted calls; do not delete the journal to reclaim space while old IDs may be submitted. MemoryLedger loses identity on process exit; CLI SQLite journal preserves it. Only execution calls are recorded: the filesystem surface carries no call ID and has no journal, so a write whose response is lost is reported as an unknown outcome. Upstream unsafe tool recovery independently prevents automatic replay on backend restart. Do not claim general exactly-once execution.

## Trust and uncertainty

- Allowing bash authorizes arbitrary scripts as the gateway user; cwd/root allowlisting is not a shell sandbox.
- Lexical/realpath checks protect cooperative file requests, not hostile concurrent filesystem races.
- The agent operates with the user's trust and already has a shell on the execution host. Path guards on the file tools
  (workspace confinement, read-only resource locations, install placement) keep the loader and install code
  unambiguous; they are not a security boundary and are not extended toward one. Isolation belongs at the
  execution-environment boundary, applied best-effort there.
- SSH exit 255/timeouts/cancellation mean remote outcome unknown; closing local ssh cannot prove remote termination.
- The gateway's explicit ControlPath overrides the user's SSH configuration for **gateway-spawned install and execution
  processes only**: an interactive `ssh` on the same host still resolves its own `ControlPath` from `~/.ssh/config`
  and its own master still works, and nothing under `~/.ssh` is read, written or deleted by this feature.
- Gateway shutdown runs `ssh -O exit` for each master it created and removes only its own sockets. There is **no
  startup sweep**: an abnormal exit leaves its sockets in the gateway's own directory, because deleting a socket
  because its name or pid looks dead can remove one a live process is still using. That residue is a recorded limit,
  not something this gateway cleans up.
- Lost response after possible dispatch remains unknown; no automatic client retry. File operations carry no general dedup journal, likewise do not automatically retry mutations.
- Credentials are gateway/backend deployment configuration, never browser metadata. Use HTTPS/private networks outside loopback.

## Verification

Critical fast public-seam tests plus manual finite smokes:

- Real faux-generated local write/edit/read/bash through authenticated HTTP gateway.
- Two separate Next production UIs: close UI A while running; UI B receives results, continues and refreshes. Bash FIFO gate proves React output appears before process completion.
- SIGKILL backend after unsafe bash dispatch, restart: count remains once, interrupted tool result visible.
- Real isolated localhost SSH + Python filesystem: write/read/edit path, binary round trip, metadata/list/canonical, rename/remove/temp, scanLines/reader, symlink/traversal denial. Temporary sshd and keys cleaned without changing ~/.ssh.
- 102 conversation catalogue restart validates paged restoration; non-loopback backend without explicit token refused; optional paid smoke refuses faux.

Copied React read-only workbench maps to local gateway; see docs/workbench.md. Paid provider and entire desktop/UI parity are separate operator/out-of-subset gates.
