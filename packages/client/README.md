# @hepi/client

The Hepi execution gateway as one command. It serves the existing local or SSH gateway over authenticated loopback
HTTP — the same `/v1/execute`, `/v1/files`, `/v1/installs`, `/v1/workspaces`, `/v1/worktrees` and `/v1/terminal`
surfaces the harness backend already speaks — and can check its own configuration and reachability before you start it.
Local mode also serves `/v1/workbench` and `/v1/mcp`; SSH mode has neither. Both modes serve `/v1/terminal`: a
long-lived shell in a registered workspace root, whose output streams, whose input and resizes are applied, and whose
close ends the process on the host. The remote host needs Python 3 for it, the same requirement the file and workspace
surfaces already have; a host without it answers `not_supported`. Runtime workspace registration supports Project
folders through the shared registry. See [Projects](../../docs/projects.md) for host ownership and folder binding.

`/v1/worktrees` is a host capability of both modes, served for every workspace the shared registry holds, so a folder
the backend binds at runtime is listed, created and removed through the same route as the configured one. It lists the
checkouts of a root, creates one on a branch at `<repo>-worktrees/<branch>`, and removes one; a root that is not a
checkout answers an empty listing, and a remove that does not ask for force refuses a dirty checkout under its own
name. A local gateway runs git on this machine and an SSH gateway runs the same git argv on the host the profile
names, so the two modes answer the same rules.

`/v1/mcp` is the host's own MCP capability, and it exists only on a local gateway: MCP configuration and OAuth
credentials belong to the account and filesystem of the Web host, which is the machine this process runs on when it
serves the Web origin. It reads and writes the global `~/.pi/agent/mcp.json` and a trusted project's
`<folder>/.pi/mcp.json`, reads a folder's trust decision from the same `trust.json` the `pi` CLI uses, tests a
configured server, and signs in to and out of one. Every failure reason it reports is masked, and no credential ever
leaves the host: the harness backend is not an MCP participant.

Requires Node 24 or newer. There is no separate build step at install time: the published package contains the
bundled CLI and its dependencies.

```bash
npm install --global @hepi/client
hepi-client --help
```

## Commands

```bash
hepi-client gateway [options]   # start the gateway on 127.0.0.1
hepi-client doctor  [options]   # check configuration and reachability
hepi-client --version
```

`gateway` prints one JSON readiness line and then serves until it is asked to stop:

```json
{"event":"listening","origin":"http://127.0.0.1:8788","port":8788,"mode":"local","gatewayId":"workstation","workspaceId":"local","workspaceRoot":"/workspace/local","journal":"/home/me/.hepi/gateway/calls.sqlite","allowedCommands":["bash"]}
```

`doctor` exits 0 when every check passes, 1 when a check fails, and 2 on a usage or configuration error. It never
prints the token.

### One startup, two entries

This CLI and the gateway package's own environment-configured entrypoint (`pnpm --filter @hepi/gateway start`, or
`node packages/gateway/src/main.ts`) start the **same** gateway. A caller that embeds a gateway imports that subpath
itself (`@hepi/gateway/startup`) rather than copying an assembly. One shared startup Module in `@hepi/gateway/startup`
consumes the resolved settings and owns the registry every surface shares, the call journal, the SSH runner and its
managed master, the surfaces, the loopback listener and the close order (surfaces first, then the master this process
created). Each entry keeps only what belongs to an entry: reading configuration, its own output and its signal handling.
A startup that fails releases what it created before it reports the failure, and closing twice closes nothing twice.

Local and SSH are mutually exclusive and follow the resolved settings: an SSH gateway serves one profile's remote root,
seeds its registry from that profile under `remote-<profile>`, and serves no MCP; a local gateway serves its own
configured root and owns MCP. Worktrees, terminals, installation, files and workspace management are composed the same
way in both modes, and a workspace the backend registers at runtime is served by all of them at once.

## Configuration

A flag beats the environment, which beats the config file. The config file is JSON keyed by the environment variable
names, so one shape covers both sources:

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--config <file>` | `HEPI_CLIENT_CONFIG` | JSON config file |
| `--token-file <file>` | — | read the gateway token from a file |
| — | `HEPI_GATEWAY_TOKEN` | token the backend must present; required |
| `--root <dir>` | `HEPI_WORKSPACE_ROOT` | workspace root on the execution host; required, absolute |
| `--workspace-id <id>` | `HEPI_WORKSPACE_ID` | workspace ID the backend addresses (default `local`; with `--host` it is fixed to `remote-<profile>` and any other value is rejected) |
| `--gateway-id <id>` | `HEPI_GATEWAY_ID` | gateway ID the backend expects (default `workstation`) |
| `--port <n>` | `HEPI_GATEWAY_PORT` | listen port on 127.0.0.1 (default 8788) |
| `--allowed-commands <list>` | `HEPI_ALLOWED_COMMANDS` | comma-separated command names that may run; empty denies every command |
| `--data-dir <dir>` | `HEPI_GATEWAY_DATA` | directory for the call journal (default `~/.hepi/gateway`) |
| — | `HEPI_GATEWAY_DB` | the journal file itself, overriding `--data-dir` |
| `--host <user@host>` | `HEPI_SSH_HOST` | run over SSH against this host instead of locally |
| `--profile <id>` | `HEPI_SSH_PROFILE` | SSH profile name (default `loopback`) |
| `--ssh-port <n>` | `HEPI_SSH_PORT` | SSH port |
| `--identity <file>` | `HEPI_SSH_IDENTITY` | SSH identity file (absolute) |
| `--known-hosts <file>` | `HEPI_SSH_KNOWN_HOSTS` | SSH known-hosts file (absolute) |
| `--terminal-heartbeat-ms <n>` | `HEPI_TERMINAL_HEARTBEAT_MS` | terminal stream keepalive cadence in milliseconds; `0` states none, unset reads the stated default (30 s) |
| `--json` | — | machine-readable doctor output |

```bash
hepi-client gateway --host user@host --workspace-id remote-loopback --terminal-heartbeat-ms 15000
```

A cadence that is not a non-negative number is a configuration error (exit 2), and both entries that start a gateway —
this CLI and the gateway package's own environment-configured entrypoint — apply the same rule, so neither accepts what
the other refuses and neither silently falls back to the default.

### Local gateway

```bash
HEPI_GATEWAY_TOKEN=local-gateway-token HEPI_WORKSPACE_ROOT=/absolute/workspace \
HEPI_ALLOWED_COMMANDS=bash hepi-client gateway
```

Point the backend at it with `HEPI_GATEWAY_URL=http://127.0.0.1:8788`, `HEPI_GATEWAY_TOKEN=local-gateway-token` and the
matching `HEPI_WORKSPACE_ID`/`HEPI_GATEWAY_ID`.

### SSH gateway

With `--host`, the gateway executes on that host over SSH using your existing SSH configuration, agent, ProxyJump and
host verification; the workspace ID is `remote-<profile>` and the backend must use that same ID. That mapping is the
gateway's, not a setting: `--workspace-id`/`HEPI_WORKSPACE_ID` must be `remote-<profile>` with `--host`, and anything
else is rejected as a configuration error rather than silently ignored. The remote host needs Python 3 on `PATH`; it
needs no Pi installation, no daemon and no inbound service.

```bash
HEPI_GATEWAY_TOKEN=local-gateway-token HEPI_WORKSPACE_ROOT=/remote/root \
HEPI_SSH_HOST=user@host HEPI_SSH_PROFILE=loopback HEPI_ALLOWED_COMMANDS=bash \
hepi-client gateway
```

An SSH gateway multiplexes its own installation and execution processes over one gateway-managed `ControlMaster` per
full connection profile (profile id, host, port, identity file, known-hosts file), in
`<data-dir>/ssh-control` created at mode 0700 before the first spawn. Your own `~/.ssh/config`, agent and masters are
untouched — an interactive `ssh` on the same host keeps its own `ControlPath` — and shutdown runs `ssh -O exit` for the
masters this process created, removing only its own sockets. There is no startup sweep, so an abnormal exit leaves its
sockets there. See [Gateway integration](../../docs/local-integration.md#ssh-prerequisites).

## What it does and does not do

The gateway is a capability server for the harness backend, not a shell sandbox. Allowing bash authorizes arbitrary
scripts as the gateway user. File operations are confined to the workspace root, and execution-side resource
locations are read-only, but that is path discipline for the loader and install code rather than containment of a
determined process. The gateway binds `127.0.0.1` only: put the backend and the gateway on the same host, or carry the
connection over an SSH tunnel or a private network. An SSH tunnel is the only transport this package configures; it
implements no tunnel of its own.

The gateway token is independent of the Web/backend login token. Changing a login token does not require changing
`HEPI_GATEWAY_TOKEN`; the backend's gateway connection and the gateway must agree on their own credential.

See [local integration](../../docs/local-integration.md) for capability bounds, cancellation and outcome-unknown rules,
and the [documentation index](../../docs/README.md) for deployment and verification.

## Development

```bash
pnpm --filter @hepi/client build      # bundle src/ into dist/
pnpm --filter @hepi/client test       # CLI parsing, configuration, doctor, and the gateway's HTTP worktree surface

The Gateway composition itself is tested where it lives: `packages/gateway/test/startup.test.ts` drives the shared
startup over real HTTP in both modes — one registry behind every capability, the listener and its close, a failed
startup releasing what it created, the terminal keepalive cadence, the `remote-<profile>` refusal, and a real
localhost `sshd`.
pnpm --filter @hepi/client smoke:pack # pack, install outside the checkout, and use the installed CLI
```

`smoke:pack` packs the tarball, installs it in a clean directory, then drives the installed CLI: help, `doctor`, an
authenticated local gateway read and command, and — when the machine has an OpenSSH daemon — an SSH gateway against a
real localhost `sshd` with generated keys and a pinned known-hosts file. It waits for that daemon to accept
connections before connecting, checks the tarball's identity against `package.json` rather than a fixed name and
version, and cleans up every temporary directory it creates.

Set `HEPI_REQUIRE_SSH_SMOKE=1` where an OpenSSH daemon is guaranteed: a missing `sshd` then fails the check instead of
skipping the SSH part. The gateway's shared SSH fixture reads the same variable, and needs `bwrap` as well — it runs
the daemon in a pid namespace of its own — so a machine that must exercise SSH fails there too rather than skipping.

## License

`UNLICENSED`. This repository grants no license for its own code. Bundled third-party packages keep their MIT terms;
see `THIRD_PARTY_NOTICES.md`.
