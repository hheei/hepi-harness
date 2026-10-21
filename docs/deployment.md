# Deployment: local and split topologies

**Current test deployment, verified 2026-10-18:** durable backend, gateway and the primary Web origin run on the
workstation, and the origin is the **client ingress** — one Node process serving the Vite build and answering `/api`, not a
container. The ingress forwards `/api` to the backend at loopback `18787`; the backend reaches the gateway directly at
loopback `28788`. All three run source `1873d24` (`hepi-ingress.service` + `release-1873d24`,
`hepi-backend:1873d24-workstation` amd64, `release-1873d24` bundle); the old Web unit is stopped and disabled. Only compatibility
access from the remote Web/API uses an SSH forward. [The 1873d24 cutover record](records/1873d24-deployment.md),
[migration and rollback](backend-local-migration-2026-10-16.md), [local units](local-tailscale-deployment.md#current-local-backend)
and [runbook](deployment-runbook.md) describe current operations.

## Historical split topology

The split-specific commands below describe the earlier remote-backend arrangement. Use them when deliberately restoring that topology, with current state and verified backups.

Minimal split across three roles: **oracle durable server** (single SQLite writer, agent loop, model access), **local Web origin** (the client ingress: static page plus `/api` proxy, no agent loop), **local gateway** (execution + workbench, loopback only). Oracle host here is the durable server; the workstation runs UI and gateway. The plan below is generic; the executed reference deployment at the end records what was actually run on real hosts, including the local gateway and UI and the live tunnel. **Last recorded state:** the executed
reference deployment below is dated 2026-10-09; the test topology as last recorded is
[the cb4494b record](records/cb4494b-deployment.md) (2026-10-13), with [the workspace-removal record](records/f603a48-workspace-removal.md) for the same date's removal of the configured default workspace and its six sessions; inspect the hosts
([runbook](deployment-runbook.md)) rather than reading a guide as live status. [Container deployment](container-deployment.md)
is the containerized form of the same two roles, and [the deployment runbook](deployment-runbook.md) is the sequence
that moves a revision onto them.

Read docs/architecture.md (ownership), docs/local-integration.md (gateway bounds), docs/workbench.md and apps/web/README.md (UI) first. Runtime facts that shape the split:

- Backend binds loopback by default and needs `HEPI_AUTH_TOKEN` before any non-loopback bind (apps/server/src/main.ts:5-7). Keep it on loopback and let the tunnel carry it.
- Gateway always binds `127.0.0.1` and needs `HEPI_GATEWAY_TOKEN` + `HEPI_WORKSPACE_ROOT`; its entrypoint reads them and starts the shared composition in `packages/gateway/src/startup.ts`, which the packaged CLI calls with its own resolved settings.
- The Web origin talks only to the backend, and the browser only to that origin: file, preview and diff reads reach the
gateway through the backend's authenticated `/api/workbench`, never from the browser. The one exception is MCP, whose
host service is the gateway on the Web origin's own host ([MCP on the Web host](mcp-on-the-web-host.md)).
- Workspace identity is a logical ID; the backend resolves it to `HEPI_GATEWAY_URL` + `HEPI_GATEWAY_TOKEN`, the gateway resolves it to physical roots (docs/architecture.md). Backend and gateway must agree on `HEPI_WORKSPACE_ID` and `HEPI_GATEWAY_ID`; a deployment may configure **no** workspace id (the backend then serves only recorded project folders), which is what the current test deployment does ([workspace-removal record](records/f603a48-workspace-removal.md)).

## Topology

```text
workstation                                oracle host
  UI 127.0.0.1:30141 ──┐
  gateway 127.0.0.1:28788 ──┐             durable server 127.0.0.1:8787
                            │                       │
        ssh -L 18787:127.0.0.1:8787  ◄──────────────┘  (UI -> backend)
        ssh -R 127.0.0.1:18788:127.0.0.1:28788 ─────────►  (backend -> gateway)
```

Both forwards start **on the workstation** (outbound SSH). The oracle host opens no inbound application port; it does hold the gateway token, which it presents over the tunnel to authenticate to the gateway.

## Private SSH forward topology

Two long-lived sessions, or one session with both flags. The executed deployment used `ssh -f -N` for exactly these forwards:

```bash
# UI -> backend. Local 18787 reaches the oracle backend's loopback 8787.
ssh -f -N -L 18787:127.0.0.1:8787 remote-host

# backend -> gateway. Remote loopback 18788 reaches the workstation gateway on 28788
# (28788, because 8788 on the workstation already hosts an unrelated service).
# The explicit 127.0.0.1 bind keeps the remote listener loopback-only; do not use GatewayPorts.
ssh -f -N -R 127.0.0.1:18788:127.0.0.1:28788 remote-host
```

- The Web origin (client ingress) sets `HEPI_INGRESS_BACKEND=http://127.0.0.1:18787`.
- The backend sets `HEPI_GATEWAY_URL=http://127.0.0.1:18788`. The ports here are the plan's choices, not a
  contract: the live test deployment currently uses `127.0.0.1:18793` and carries the forward over the runtime
  host's own `sshd` on port `2222` rather than over Tailscale SSH, because Tailscale SSH acknowledges a
  remote-forward request without binding it, and a session killed while holding a forward leaks that port until
  it is released. See [the 96297fe record](records/96297fe-deployment.md), *Post-reboot tunnel recovery*, and its
  *Old-port reclamation* section: those ports are free again, and the extra `sshd` listener the forward needs is
  a tailnet-only one on that host.
- Both endpoints stay plain HTTP inside the tunnel. That is the private link; do not bind the backend or gateway to a routable interface, and add HTTPS or a private overlay before any non-loopback exposure.
- Order matters: the reverse forward must be up before a tool call, because gateway dispatch is never retried. Tunnel loss leaves the outcome unknown; the gateway journal records it as such (docs/local-integration.md).
- `-N` (no remote command) is enough. Keep the tunnel under a supervisor or systemd unit so a dropped SSH does not silently remove execution.

## Build here, run there

**`remote-host` is a deployment host, not a build host.** Do not run a compile or build task on it: no `pnpm build`,
no Next.js `build`, no TypeScript emit (`tsc` without `--noEmit`), no `docker build`/`docker buildx` and no remote
builder, and no dependency install that compiles native modules. It is a small remote box meant to run containers.

Build on `workstation` (the workstation) or in CI, matching the architecture `remote-host` runs (`linux/arm64`), and move the
**prebuilt** artifact there — a pinned image tag/digest pulled from the registry, or a tarball over SSH. A source
checkout on `remote-host` is only ever run from, never compiled: `pnpm install --frozen-lockfile` is acceptable there
only because the root `pnpm-workspace.yaml` disables every install script that would compile (see
`docs/container-deployment.md`), and it does not make a build acceptable. `pnpm -r typecheck`/`pnpm -r test` are
read-only checks and stay allowed. Cross-architecture builds and their QEMU/binfmt prerequisites are the
workstation's or CI's problem, documented in `docs/container-deployment.md`.

## Install and run

Node 24+ is required for direct `.ts` entrypoints (stable type stripping); verified on Node 26.5.1. pnpm 12.4.1 with the root lockfile.

**Install and the gate are build-host steps, not deployment steps.** `pnpm install` writes `node_modules` and can
compile or fetch native artifacts; `pnpm -r test` starts processes and writes fixtures. Both belong on `workstation` or
CI. Only `pnpm -r typecheck` (`tsc --noEmit`) is genuinely read-only, and it too is a gate, not part of a cutover.

Build host, from a checkout (never by copying `node_modules`):

```bash
git clone <repo> hepi-harness && cd hepi-harness
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r test          # build-host gate
```

Oracle (backend, one writer, one process) runs the artifact the build host produced; nothing below compiles here and
there is no install step. The bundle that `@hepi/server start` would produce (`pnpm build:ui` →
`public/diagnostics.js`, the Diagnostic Page script) is part of the artifact — run that on the build host and transfer
`apps/server/public/diagnostics.js` with the rest of the tree, or use an image, which already contains it. Start the
server directly instead:

```bash
cd <release>/apps/server                   # main.ts resolves its paths from here, as the package script does
HEPI_DB=/var/lib/hepi/hepi.sqlite \
HEPI_WORKSPACE_ID=workstation HEPI_GATEWAY_ID=workstation \
HEPI_GATEWAY_URL=http://127.0.0.1:18788 HEPI_GATEWAY_TOKEN=<gateway-token> \
node src/main.ts
```

Default DB is `apps/server/data/hepi.sqlite`; put it on a volume you back up. Never start a second backend process against the same database. Container startup, published images and the runtime-only compose recipe are in [container deployment](container-deployment.md); the cutover sequence is [the deployment runbook](deployment-runbook.md).

Workstation gateway:

```bash
HEPI_GATEWAY_TOKEN=<gateway-token> HEPI_GATEWAY_ID=workstation \
HEPI_WORKSPACE_ID=workstation HEPI_WORKSPACE_ROOT=/absolute/workspace \
HEPI_ALLOWED_COMMANDS=bash HEPI_GATEWAY_DB=/var/lib/hepi-gateway/calls.sqlite \
pnpm --filter @hepi/gateway start
# Optional: HEPI_TERMINAL_HEARTBEAT_MS=<ms> states the terminal stream's keepalive cadence (0 = none; unset = 30 s).
```

Allowing bash authorizes arbitrary scripts as the gateway user; the workspace root is confinement for file RPC, not a shell sandbox. An empty `HEPI_ALLOWED_COMMANDS` denies every command, so the bash tool fails rather than degrading silently.

**SSH-profile gateways multiplex install and execution.** A gateway started with `HEPI_SSH_HOST` creates
`<HEPI_GATEWAY_DATA>/ssh-control` (next to `calls.sqlite`) with mode 0700 at startup and runs its `/v1/installs` and
`/v1/execute` ssh processes through one gateway-managed `ControlMaster` per full connection profile; the user's own
`~/.ssh/config`, agents and masters are untouched, and the gateway's own processes never pass a disable option.
Shutdown runs `ssh -O exit` for the masters this process created and removes only its own sockets — there is no startup
sweep, so an abnormal exit leaves sockets in that directory as a recorded limit. A host whose SSH configuration
previously had no multiplexing therefore behaves differently for **gateway-spawned** install and execution processes
after this change, and only for them. The directory must be on a filesystem that supports Unix sockets and its parent
must be writable by the gateway account. See [Gateway integration](local-integration.md#ssh-prerequisites).

Workstation Web origin — the `build` step belongs to the workstation or CI, never to `remote-host`. The origin is the
**client ingress**, one Node process serving the Vite build and answering `/api`; there is no Web server package to
start. Build the page, then run the ingress against the backend:

```bash
pnpm --filter @hepi/web build                    # emits apps/web/dist

HEPI_INGRESS_BACKEND=http://127.0.0.1:18787 \
HEPI_INGRESS_SERVICE_TOKEN=<backend-token> \
HEPI_WEB_LOGIN_TOKEN=<the login material a person types> \
HEPI_INGRESS_STATIC_DIR="$PWD/apps/web/dist" \
HEPI_INGRESS_PORT=30141 \
HEPI_INGRESS_DEFAULT_HOST=workstation \
HEPI_INGRESS_MCP_GATEWAY_URL=http://127.0.0.1:28788 HEPI_INGRESS_MCP_GATEWAY_TOKEN=<gateway-token> \
HEPI_INGRESS_MCP_GATEWAY_ID=workstation \
node packages/gateway/src/ingress/main.ts
```

Open http://127.0.0.1:30141 and enter the login material; the ingress exchanges it for an HttpOnly
`hepi-web-session` cookie and presents `HEPI_INGRESS_SERVICE_TOKEN` to the backend on its own outbound calls, so the
browser never holds a backend credential. A packaged release runs the same settings from `ingress.mjs` with
`node scripts/ingress-unit.mjs --env-template` rendering the file ([client-runtime release](client-runtime-release.md)).

`HEPI_WEB_LOCAL_GATEWAY_ID` names which of the backend's configured gateways is **this** Web origin's execution
host — the same id the gateway reports as `HEPI_GATEWAY_ID` and the backend as `HEPI_GATEWAY_ID`, here
`workstation`. One backend can serve several Web UIs on different computers, and the backend's own account says
nothing about any of them, so each origin states its own. It is an id, never a gateway URL or token, and the browser
never receives it. Leaving it unset is not a fallback: New Project answers `configuration_required` instead of
guessing a host, so a UI started without it cannot create a project. The same variable is documented for the container
topology in docs/container-deployment.md.

## Secrets

Tokens live in environment, never inline in a shared command line, shell history, or repository files. Use a mode-600 env file per host and reference it from the supervisor:

```ini
# /etc/hepi/backend.env   (root:root 0600)
HEPI_AUTH_TOKEN=...
HEPI_GATEWAY_TOKEN=...
HEPI_DB=/var/lib/hepi/hepi.sqlite
HEPI_GATEWAY_URL=http://127.0.0.1:18788
```

`.env` is git-ignored. Provider keys belong on the backend only. Rotate backend and gateway tokens independently; the gateway token is deployment config and must never reach browser state or persisted conversation metadata.

## systemd (optional, one unit per role)

Only if you want restarts. Nothing here needs containers, orchestration, or a second supervisor.

```ini
# /etc/systemd/system/hepi-backend.service
[Service]
User=hepi
WorkingDirectory=/srv/hepi-harness/apps/server
EnvironmentFile=/etc/hepi/backend.env
ExecStart=/usr/bin/node src/main.ts
Restart=on-failure
```

`ExecStart` runs the server directly rather than through `pnpm --filter @hepi/server start`, because that script's
first step is `pnpm build:ui` — a build, and a deployment host must not run one. The bundle it would produce
(`apps/server/public/diagnostics.js`) arrives with the artifact.

Mirror it for the gateway and, if you prefer, a `hepi-tunnel.service` running the two `ssh -N` forwards with `Restart=always`. Keep `EnvironmentFile` permissions at 0600; systemd does not expose the file contents in `ps`.

## Backup

The backend and the gateway journal both open SQLite in WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`). A live `cp` of the `.sqlite` file alone is **not** a valid backup: recent commits live in the `-wal` sidecar and a torn copy can lose or corrupt them.

Do one of:

- Stop the writer, then copy the database and any `-wal`/`-shm` siblings together (cleanest), or
- Use SQLite's own online backup against the running process, e.g. `sqlite3 /var/lib/hepi/hepi.sqlite ".backup /backup/hepi-$(date +%F).sqlite"` (or `VACUUM INTO`). The backup is consistent without stopping the server.
- For a stopped copy, `PRAGMA wal_checkpoint(TRUNCATE)` first so the main file is self-contained.

Back up the gateway `calls.sqlite` too: it is the outcome-unknown tombstone ledger, so losing it can make a replayed call look new. Do not delete it to reclaim space while old call IDs may still be submitted.

## Flag: custom-provider config and worker handling

- The durable backend builds its model registry itself, and every mode is one backend-owned `ModelRuntime` over the backend agent directory's `models.json`. In the default environment mode it registers upstream OpenAI with `OPENAI_API_KEY`, or a custom `HEPI_PROVIDER`/`HEPI_MODEL`/`HEPI_PROVIDER_BASE_URL`/`HEPI_PROVIDER_API_KEY` provider from `provider-config.ts`, as an environment-owned base layer (with neither, no base provider is registered and the deployment must name its models in `models.json`); the file overlays it and is what Settings › Models reads and saves. The opt-in `HEPI_CONFIG_SOURCE=pi` mode builds the same runtime from the `pi` agent directory on the backend host, including `auth.json`, and the environment endpoint/key variables are rejected instead of overriding it. See `docs/providers.md` and `docs/pi-config.md`. This reference deployment used environment mode and explicitly exported a selected provider into the backend environment. Configure providers per backend, not per UI.
- Settings › Models (`GET`/`PUT /api/models-config`) is connected: the Web process proxies it to the backend, which owns the file, and never reads its own host's `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. The credential surfaces (`/api/auth/providers`, `/api/auth/api-key/:id`, `/api/auth/login/:id`, `/api/auth/logout/:id`) are connected too, but to the **gateway on the Web host**, not to this backend: they write that host's `auth.json` and never reach the backend at all (docs/architecture.md), so they are not backend configuration and a key stored there is not what makes a model serve here. Availability follows whichever account *this* process was configured with — environment mode its own `HEPI_*` variables, Pi mode the agent directory it was pointed at — and the stale answer a credential change leaves behind belongs to the browser's own catalog cache, which the panel drops (docs/providers.md). Do **not** close that gap by mounting the Web host's agent directory into a backend container: that would put a workstation user's OAuth refresh tokens inside the container's reach, which is the isolation a separate `PI_CODING_AGENT_DIR` exists to keep. A deployment that wants host-stored credentials to serve its models runs both roles against one account intentionally, on one host.
- MCP is connected, and deliberately **not** through the backend: the Web process reaches the gateway running on its own host at `HEPI_WEB_GATEWAY_URL`/`HEPI_WEB_GATEWAY_TOKEN`, which owns the MCP configuration and credentials in that host's account. Unset, `/api/mcp` answers `mcp_unavailable` and the rest of the settings keep working. See [MCP on the Web host](mcp-on-the-web-host.md).
- Worker handling: the Web UI hosts no agent extensions and resolves no QuickJS worker. The dormant `apps/web/lib/builtin-extensions.ts` that assembled the SDK's codemode/tool-search/MCP builtins in the Web process was retired in ticket 04; the execution side installs its own extensions (`apps/server/src/harness.ts` installs `CodingTools` plus the resource extension), so codemode is an execution-host capability, not a Web one. The UI is still deployed from the same `pnpm install` tree rather than a repackaged bundle, because its server-side modules resolve the SDK's own files at run time.

## Not claimed

The plan above is not evidence of a deployment; only the executed reference deployment section records real runs. The oracle host name is the authorized target used there. Real-provider behavior beyond the one configured model and UI parity with upstream remain separate gates in docs/verification.md and docs/migration-status.md. The SSH transport interruption matrix is separately verified in docs/ssh-interruption-verification.md (10/10 on a real localhost `sshd`, no replay, unknown remote outcome treated as possibly alive), and ticket 06 is done.

## Executed reference deployment (2026-10-09, remote-host) — historical record

This section records one dated run of the plan above. It is not the current state of either host: the deployment has
since moved to `df24b7c`, then `51492c4`, then the merged `edef2c0` tip, and the login token was rotated. For what
is running now see [the edef2c0 split deployment](records/edef2c0-split-deployment.md) plus
[workstation](local-tailscale-deployment.md) and [Oracle](oracle-tailscale-deployment.md), which carry the current units and
images. Read the numbers below as that run's evidence, not as a description of the live hosts.

Backend role deployed on the remote host and then exercised end to end against the workstation gateway and UI across the SSH tunnel. Everything below was run; where a claim comes from the parent's own browser session rather than from this deployment's commands, it says so.

Target: `remote-host`, Ubuntu aarch64, user `<runtime-user>`, 166 GB free, no system node/pnpm. Own directory `/home/<runtime-user>/hepi-harness-deploy`, separate from existing services; no existing service was touched.

Toolchain, user-local, official tarball with checksum verification:

```bash
BASE="$HOME/.local/hepi"; NODE_VER=v24.21.0; ARCH=linux-arm64
curl -fsSLO "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$ARCH.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt"
grep -F "  node-$NODE_VER-$ARCH.tar.xz" SHASUMS256.txt | sha256sum -c -   # OK
tar -xJf node-$NODE_VER-$ARCH.tar.xz -C "$BASE"
npm_config_prefix="$BASE" npm install -g pnpm@12.4.1
```

Result: `node v24.21.0`, `npm 11.19.0`, `pnpm 12.4.1` at `$BASE/bin/pnpm`; store `$BASE/pnpm-store` (set with `pnpm config set --global store-dir`).

Source copy from the workstation (untracked tree, so a tar pipe rather than `git archive`; secrets, `.git`, `node_modules`, `.next`, `.agents` and `data` excluded):

```bash
tar --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.git' --exclude='./.next' \
    --exclude='*/.next' --exclude='./.agents' --exclude='*/data' --exclude='*.tsbuildinfo' \
    --exclude='./.env' --exclude='./.env.*' -czf - . |
  ssh remote-host 'tar -xzf - -C /home/<runtime-user>/hepi-harness-deploy/src'
```

1059 files under `apps/` and `packages/`; local and remote `sha256sum` manifests matched exactly after the final copy. Dependency install: `pnpm install --frozen-lockfile --filter "@hepi/server..."` in `src/` (161 MB `node_modules`), plus `pnpm --filter @hepi/server build:ui` for the diagnostic `diagnostics.js`.

Environment, written to `/home/<runtime-user>/hepi-harness-deploy/env/backend.env` (mode 0600, directory 0700). Values were generated locally and piped in; no secret was ever echoed to a terminal, log, or the systemd unit:

- `HEPI_BIND_HOST=127.0.0.1`, `PORT=8787`, `HEPI_DB=/home/<runtime-user>/hepi-harness-deploy/state/hepi.sqlite`
- `HEPI_WORKSPACE_ID=integration`, `HEPI_GATEWAY_ID=workstation`, `HEPI_GATEWAY_URL=http://127.0.0.1:18788`, `HEPI_GATEWAY_TOKEN` (matches the workstation gateway token)
- `HEPI_PROVIDER=magpie`, `HEPI_MODEL=deepseek-v4.1-flash`, `HEPI_PROVIDER_BASE_URL`/`HEPI_PROVIDER_API_KEY` read at deploy time from the workstation's own `$PI_CODING_AGENT_DIR/models.json` (or `~/.pi/agent/models.json`) without printing values

Service: systemd user unit `hepi-backend.service` (source in the repo's deployment notes, `WorkingDirectory` = `src/apps/server`, `ExecStart` = the pinned `node src/main.ts`, `Restart=on-failure`), enabled with `loginctl enable-linger <runtime-user>` so it survives logout. Readiness was proven by request, not by polling: an authenticated `GET /api/models` returned 200 listing `magpie/deepseek-v4.1-flash`, while an unauthenticated request returned 401. The listener is `127.0.0.1:8787` only (`ss -ltnp`).

Evidence: `systemctl --user is-active hepi-backend.service` = `active`, `SubState=running`; `MainPID` recorded at launch (it changes on restart — read it from systemd, not from a note). State files `state/hepi.sqlite` with its `-wal`/`-shm` sidecars appeared on first start. The reverse tunnel port `18788` was free on the host before deployment.

Operational notes for this host:

- The workstation side uses a dedicated gateway port: local gateway `28788` (not 8788, which an existing local service already owns), UI `30141`, local tunnel `18787`; the reverse forward maps remote `127.0.0.1:18788` to workstation `127.0.0.1:28788`. The backend only ever names `http://127.0.0.1:18788`. Observed during this deployment: gateway pid 3965293 on `127.0.0.1:28788`, Next server on `127.0.0.1:30141` (pid 3985864 after the auth fix; the earlier pid was replaced by that restart), and the two `ssh -f -N` forwards on local `18787` and remote `18788`. These processes are parent-owned and may be restarted; the ports and the shared `HEPI_GATEWAY_TOKEN` are the contract.
- The model registry is supplied by the custom-provider env above; no `models.json` exists on the remote and none is read. Model metadata comes from the upstream catalog, not from the provider id: `magpie/deepseek-v4.1-flash` therefore reports its real input modalities, reasoning support and limits in `/api/models` (docs/providers.md, "Model metadata"). A genuinely unknown id keeps the `(unverified)` placeholder, whose context window, limits and zero cost are unmeasured.
- Re-deploying code means re-running the tar pipe (the backend and gateway packages may change together) and then `systemctl --user restart hepi-backend.service`. `node_modules` is intentionally not re-copied. A single file can be synced directly, as was done for the hardened `provider-config.ts`: `scp apps/server/src/provider-config.ts remote-host:/home/<runtime-user>/hepi-harness-deploy/src/apps/server/src/provider-config.ts` (local and remote `sha256` `6aa41aa1…ad87`), then restart. The retired UI-owned files from the old Next application (`page.tsx`, the login wrapper, `auth.ts`, the API route — all
removed by ticket 17) are not needed on the remote backend.
- To stop: `systemctl --user stop hepi-backend.service`. Do not start a second backend against `state/hepi.sqlite`.


### End-to-end verification across the split

The reverse forward was live (remote `127.0.0.1:18788` listening), so the backend's gateway path was exercised for real, not just its own HTTP surface:

- `POST /api/workbench` with `operation: "files"` returned `{"ok":true,"value":["README.md","split-proof.txt","src/billing.ts","test/billing.test.ts","tsconfig.json"]}` — the listing of the workstation workspace, fetched by the remote backend through the tunnel.
- Conversation `8` on the remote backend holds one real model run against the configured `magpie/deepseek-v4.1-flash` model: four assistant messages carrying five tool calls (`read` on README.md; `bash` for `pwd`; `bash` running `node --test test/billing.test.ts`, whose tool result shows all three tests passing; `write` of `split-proof.txt`; `read` of it back), with five matching tool results and the final reply `Done. node --test test/billing.test.ts passed all 3 tests`. Every assistant message records `model: deepseek-v4.1-flash`. `GET /api/conversations` lists that conversation bound to workspace `integration` / gateway `workstation`.

The workstation UI was exercised by the parent, not by this deployment's commands: the local production build passed, the browser loaded conversation `8`'s tool history and final reply from the remote backend, a reload stayed authenticated after server-side cookie validation, and a wrong cookie fell back to the login screen with API `401`. The UI and gateway processes are parent-owned (see the ports note above) and were left running.

Still open here: a UI-submitted prompt end to end (parent's agent3 is running one real `read` through the browser) and the gateway path-handling patch expected from agent2. The SSH transport interruption matrix is not an open item: docs/ssh-interruption-verification.md records 10/10 over a real localhost `sshd` with no automatic replay and unknown remote outcome treated as possibly alive, and ticket 06 is done. Untested by this deployment, and open separately: aborting a real model run against the deployed oracle backend.

