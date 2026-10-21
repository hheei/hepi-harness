# Local tailnet deployment (workstation)

## Current local backend

**Authority for current state is the [deployment runbook](deployment-runbook.md#routine-deployment-default) plus a
read-only inspection of this host**, not this file. What this section owns is the *shape* — which roles run, on which
endpoints, and where each setting lives. It names revisions only as a dated snapshot: shipping a release changes a tag
without touching the topology, so a revision written here is history the moment the next release lands. Read the units
before relying on an id:

```bash
systemctl --user status hepi-backend.service hepi-gateway.service hepi-ingress.service hepi-tunnel.service
systemctl --user cat hepi-ingress.service      # the release directory its ExecStart names
```

Topology: the workstation runs the backend, the gateway and the primary Web origin, and that origin is the **client
ingress** — one Node process serving the Vite build and `/api`, not a Next container. `hepi-web.service` is stopped and
disabled.

**Dated snapshots of the revisions, not a current claim.** 2026-10-18: all three roles on source `1873d24` — image
`hepi-backend:1873d24-workstation` (amd64), client bundle `release-1873d24`, ingress running that release's `ingress.mjs`
under the pinned `/usr/bin/node` ([the 1873d24 cutover](1873d24-deployment.md); earlier,
[the 56ff08f migration](backend-local-migration-2026-10-16.md)). 2026-10-20, by read-only inspection: the ingress served
`release-3d15c86` from its own `web/` directory and `hepi-backend.service` ran `hepi-backend:2c28d1c-workstation`. Each
snapshot supersedes the ids in the one before it; neither is asserted as the tip.

| Endpoint | Current use |
| --- | --- |
| Workstation loopback `18787` | Backend itself; no local SSH forward |
| Workstation loopback `28788` | Gateway, called directly by backend |
| Existing tailnet Web port `30141` | Primary Web origin — the client ingress, serving the Vite build and `/api`; unchanged address, port and login material |
| Remote loopback `8787` | Compatibility reverse forward to workstation backend |

User units (all enabled in `default.target.wants`): `hepi-backend.service` runs the pinned image with host networking and the persistent state mount; `hepi-gateway.service` runs the pinned release's bundle; `hepi-ingress.service` binds the Web origin and reaches the backend on loopback with its own service credential; `hepi-tunnel.service` provides only remote compatibility and still depends on the backend. Nothing depends on `hepi-web.service` any more. The local Web/backend/gateway path works independently of SSH. The gateway's environment and journal were preserved unchanged.

Backend environment is `~/.config/hepi/backend.env` (0600); state is `~/.local/share/hepi/backend/state/`, including the three databases, the Backend's device-credential sidecar and the separate backend agent configuration. Backend sets `HEPI_GATEWAY_URL=http://127.0.0.1:28788` and `PORT=18787`. The ingress reads `~/.config/hepi/ingress.env` (0600), which is where the **live** login value and MCP gateway URL/token/id live; those are the same values the retired `~/.config/hepi/web.env` held, under new names (`HEPI_WEB_GATEWAY_URL`/`HEPI_WEB_GATEWAY_TOKEN`/`HEPI_WEB_LOCAL_GATEWAY_ID` map onto `HEPI_INGRESS_MCP_GATEWAY_URL`/`_TOKEN`/`_ID`). `web.env` is not read by any running unit; it was never edited after the switch and stays only as rollback material. Host-specific absolute paths and backup copies stay in private configuration.

Use `systemctl --user status hepi-backend.service hepi-gateway.service hepi-ingress.service hepi-tunnel.service` for current status. To ship a backend revision, build a pinned amd64 image from committed source on the build host, update the backend unit's image and restart that unit, preserving its state mount. A Web-origin revision is shipped instead through the client-runtime release: `node scripts/build-client-runtime.mjs` then `node scripts/ingress-unit.mjs` ([client-runtime release](client-runtime-release.md)), with the gateway bundle and Backend image moving with the release when it carries them. Inspect the ingress and gateway after a backend restart, and re-confirm the workspace listing after a gateway restart. Schema or state-path changes require the full runbook and fresh verified backups; a Web-origin-only change needs none. The remote backend stays stopped; returning it to service requires transfer of current state, not simply starting its old container.

## Historical split deployment

The earlier addresses, tags and two-way tunnel below are historical. The current section above supersedes their topology and unit commands.


The local half of the split deployment: a persistent Hepi gateway and the Hepi Web UI on the client host
`<client-host>` (tailnet `<client-host-tailnet-ip>`), talking to the backend on the runtime host
`<runtime-host>`. The remote half — the backend container, its state and its own Web UI — is owned by the remote
deployment and is not described here. Real host names, addresses and account names live in git-ignored private
configuration, not in this file (see docs/README.md).

Everything below is user-scoped: three `systemctl --user` units, no root, no sudo, no changes to other services.
Routine updates follow the [routine deployment path](deployment-runbook.md#routine-deployment-default); the
upgrade sections below are historical evidence, not steps to repeat on every deployment.

## Addresses

| What | Where | Notes |
| --- | --- | --- |
| Web UI (local, for the browser) | `http://<client-host-tailnet-ip>:30141` | bound to the tailnet address only; `127.0.0.1:30141` is deliberately not served |
| Gateway (execution host) | `http://127.0.0.1:28788` | loopback only; the backend reaches it through the tunnel |
| Backend, from this machine | `http://127.0.0.1:18787` | SSH local forward to `remote-host:127.0.0.1:8787` |
| Gateway, from the backend host | `remote-host:127.0.0.1:18793` | OpenSSH remote forward to `workstation:127.0.0.1:28788`, carried by the runtime host's `sshd` on port `2222`. Moved off `18788` and off Tailscale SSH on 2026-10-12: Tailscale SSH accepts a remote forward and never carries it, and the port a dropped session held cannot be reclaimed without restarting `tailscaled` (see the [96297fe record](96297fe-deployment.md)) |
| Workspace root served by the gateway | `/home/<client-user>/.local/share/hepi/workspace` | gateway id `workstation`. Since 2026-10-13 this deployment configures **no** workspace id: the root is served only under the gateway's own boot-seed id, no conversation binds it, and the execution targets are the recorded project folders ([the workspace-removal record](f603a48-workspace-removal.md)) |
| Call journal | `/home/<client-user>/.local/share/hepi/state/calls.sqlite` | the pre-existing ledger, preserved |
| Installed client — **historical, split-era layout** | `/home/<client-user>/.local/share/hepi/client/release-<id>` | a released client bundle installed from the packed tarball; its `release-<id>` suffix is current, the id is not (see *Current local backend*) |
| Web image — **historical** | `hepi-web:<id>@sha256:…` | split-era only. No `hepi-web` image is built, published or run any more; the Web origin is the client ingress, a release directory plus a systemd unit |

The Web UI speaks HTTP over the tailnet. Tailscale terminates the encryption between nodes, so the traffic is not
sent in clear over the network, but it is not HTTPS in the browser: no certificate, and the session cookie is not
`Secure`. Enabling HTTPS for this port is optional and needs local administrator/operator permissions (see *Remaining issues*).

## Secrets

Each live 0600 file is read by exactly one unit, and nothing is in a unit file, on a command line, or in this document.
`~/.config/hepi/backend.env` (`HEPI_AUTH_TOKEN`, provider settings), `gateway.env` and `ingress.env` are current;
`web.env` is retained rollback material that no running unit reads.

| File | Holds | Used by |
| --- | --- | --- |
| `~/.config/hepi/gateway.env` | `HEPI_GATEWAY_TOKEN` (the shared gateway token), workspace root/id, gateway id, allowed commands, port, journal path | `hepi-gateway.service` |
| `~/.config/hepi/web.env` — **retired** | the split-era Web environment: `HEPI_AUTH_TOKEN`, `HEPI_SERVER_URL`, `HEPI_WEB_LOCAL_GATEWAY_ID=workstation`, and since `19d7cda` `HEPI_WEB_GATEWAY_URL`/`HEPI_WEB_GATEWAY_TOKEN` | **no unit reads it.** It was the retired `hepi-web.service`'s file, kept unedited as rollback material. The live copies of the login value and of the MCP gateway URL/token/id are in `ingress.env`, under ingress names |
| `~/.config/hepi/ingress.env` | `HEPI_INGRESS_SERVICE_TOKEN` (what the ingress presents to the backend, outbound only), `HEPI_WEB_LOGIN_TOKEN` (the same login material `web.env` carries), the backend origin, the tailnet bind/port, the release's static dir, the default host id, and that host's MCP gateway URL/token/id | `hepi-ingress.service` (written 2026-10-18 from the existing private files, never printed) |

`HEPI_WEB_GATEWAY_TOKEN` holds the same independent gateway token `~/.config/hepi/gateway.env` already carries; it
was copied there for the `19d7cda` upgrade and no value is recorded here. The retired Web container ran on the host
network and the ingress runs as a host process, so the `127.0.0.1` in that URL is this machine's own loopback and
reaches the gateway directly — that is what makes Settings › MCP answer, and it is why the id/URL/token moved to
`ingress.env` unchanged in meaning. See [MCP on the Web host](mcp-on-the-web-host.md).

The login secret for a human is that token value, which the ingress reads as `HEPI_WEB_LOGIN_TOKEN` from
`~/.config/hepi/ingress.env`; the file path is given here, the value never is. The retired `web.env` and the ingress
environment were generated from the pre-existing split-deployment secrets, so the tokens were initially the same
shared values the backend and gateway already used; that statement describes the initial split deployment only.
`HEPI_AUTH_TOKEN` was subsequently rotated in place on 2026-10-11 — the same new value was written to the Web
environment and to the backend's `env/backend.env`, both at mode 0600, and the Web unit and the backend container were
restarted to pick it up. The gateway token is independent and was not part of that rotation. No value is recorded
here.

## Units

```
~/.config/systemd/user/hepi-gateway.service   gateway on 127.0.0.1:28788, Restart=always
~/.config/systemd/user/hepi-tunnel.service    both SSH forwards, Restart=always, after the gateway
~/.config/systemd/user/hepi-ingress.service   /usr/bin/node <client-release-root>/release-<id>/ingress.mjs,
                                              EnvironmentFile=~/.config/hepi/ingress.env,
                                              bound to <client-host-tailnet-ip>:30141, Restart=always
~/.config/systemd/user/hepi-web.service       (stopped and disabled since 2026-10-18) docker run --network host
                                              --env-file ~/.config/hepi/web.env, bound to the same port, Restart=always
```

`hepi-tunnel.service` replaces the earlier ad-hoc `ssh -f -N` forward with the same ports and the same
`remote-host` target; the old process was stopped first. When it ran, `hepi-web.service` started a pinned immutable
`hepi-web:<id>` image in its own container name (`hepi-local-web`), on the host network so it could reach
`127.0.0.1:18787` and bind the tailnet address directly. It is stopped and disabled; the ingress unit occupies that
port instead.

`hepi-gateway.service` runs the release's entry point under a pinned `/usr/bin/node`, not the `.bin` shim's
`#!/usr/bin/env node`. The bundle imports `node:sqlite`, which needs Node 22+, while the shim resolves `node` through the
user manager's `PATH` — where `/home/developer/.local/node-v20/bin` comes first on this host, a Node 20. `/usr/bin/node` is
26.5.1, the version [Deployment](deployment.md) records as verified.

Pinned 2026-10-12 after a restart loop: the service was signalled at 20:09:30–20:10:57 and every restart listened, then
every start from 20:10:59 to 20:38:55 failed with `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module:
node:sqlite` — 187 failing starts, no listener on 28788 until the pinned start at 20:39:07, with `hepi-web.service`
deactivated for the same window and `hepi-tunnel.service` active throughout. No durable data changed: `calls.sqlite`
held its 783 rows before and after, and the backend and Web containers on `remote-host` were not restarted. Neither the
unit file (10:40:43), the bundle (`cli.js` sha256
`169c7e5b46a07a31c082f1d92b7606b1761596f92b167cdf1b388942b95812d4`, unchanged since 10:40:29) nor that Node install
(ctime 2026-05-09) changed that day, so what moved the manager's `PATH` is not recorded; the pin is what stops the unit
depending on a `PATH` it does not control. The gateway keeps its workspace registry in memory, so a restart also reverts
the project-folder workspaces to `unknown workspace` until the next request for each re-registers it — `apps/server/src/
server.ts` replays them at its own start and in `ensureBinding`.

**Corrected read-only, 2026-10-12:** the four project-folder workspaces (`hey`, `hepi-harness`, `Hepi Mono`,
`Hepi Harness`) were re-registered through that same path — one `POST /api/worktrees` with `operation: "list"` per
recorded folder, an operation these folders do not support and whose branch registers the binding before it answers
`not_supported` — after which `GET /api/workspaces` answered five workspaces with **0** `hostError` instead of four,
and `executionHost` and the workbench file listing answered for each of them. No durable state was written, no service
was restarted, and the backend containers were untouched.

### Start, stop, restart

```bash
systemctl --user status hepi-gateway.service hepi-tunnel.service hepi-ingress.service
systemctl --user restart hepi-tunnel.service      # re-establish the SSH forwards
systemctl --user restart hepi-ingress.service     # restart the Web origin (no container involved)
systemctl --user stop hepi-ingress.service hepi-tunnel.service hepi-gateway.service
systemctl --user enable --now hepi-gateway.service hepi-tunnel.service hepi-ingress.service
journalctl --user -u hepi-ingress.service -f
```

All four units are enabled in `default.target.wants`, and the user has `Linger=yes`, so they start at boot and
survive logout without a login session. `hepi-web.service` is disabled: re-enabling it would collide with the ingress
over the Web origin's port. Restarting the ingress alone is enough for a changed `ingress.env` or a re-pointed release.

The gateway writes the journal outside the workspace it serves, so the workspace stays clean. The journal was
carried over from the earlier split run: the ledger already holds the prior calls, and an in-flight call is
answered as outcome-unknown after a restart instead of being run twice.

## Verifying

With the units active:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<client-host-tailnet-ip>:30141/          # 200 — the Vite build, not a Next render
curl -s -o /dev/null -w '%{http_code}\n' http://<client-host-tailnet-ip>:30141/api/models # 401 without a session
curl -s http://<client-host-tailnet-ip>:30141/api/web-auth                                 # {"enabled":true}
curl -s -o /dev/null -w '%{http_code}\n' http://<client-host-tailnet-ip>:30141/v1/files    # 404 — the client listener serves no /v1 route
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30141/             # connection refused: tailnet bind only
```

Log in through the UI with the token the ingress reads as `HEPI_WEB_LOGIN_TOKEN` from
`~/.config/hepi/ingress.env` (the same value the retired `web.env` carries); the address, port and login material were
unchanged by the switch away from the Next entry, so a signed-in tab from before it kept working after one refresh, and
the value itself is never recorded here. The login is what `POST /api/web-login` answers: the correct token 200 with an `HttpOnly`,
`SameSite=Strict`, `Path=/` session cookie, a wrong token 401. After login, `GET /api/models` returns the backend's real
catalog (provider `magpie`, model `deepseek-v4.1-flash`), and a file under
`/api/files/workspace/<project-folder-id>/...` is read by the gateway from that project folder's root — the round trip is
now browser on the tailnet → client ingress (page and client API in one process) → backend on loopback `18787` → gateway
on loopback `28788` → disk. The SSH forward is no longer in that path; it carries only remote compatibility.

A wrong token and a missing cookie are both rejected with 401, and a non-GET request without a matching `Origin`
is rejected with 403.

## Upgrade history — compact index to the per-revision records

Each step below has its own full record with artifact identities, hashes, backups and evidence. This file keeps only the
local half's one-line outcome and a pointer, because repeating each record's narrative here made two chronologies drift.
All of these are **point-in-time records of the split topology**, not the current state: the backend moved to the
workstation and the Web origin became the client ingress ([current local backend](#current-local-backend)).

| Revision | Date | Local halves that moved | Full record |
| --- | --- | --- | --- |
| `51492c4` | — | gateway bundle `release-51492c4` (adds `/v1/workspaces`), Web image `hepi-web:51492c4`, `web.env` gains `HEPI_WEB_LOCAL_GATEWAY_ID` | no separate record; described in [19d7cda](19d7cda-deployment.md) as the rollback target |
| `edef2c0` | — | Web image only; the `cleanup-session-filter.conf` drop-in was removed | [record](edef2c0-split-deployment.md) |
| `39c168d` | — | Web image only (home-flicker guard); gateway byte-identical | [record](39c168d-deployment.md) |
| `78078de` | 2026-10-11 | Web image only; gateway byte-identical and not restarted | [record](78078de-deployment.md) |
| `19d7cda` | — | both halves: bundle `release-19d7cda`, image `hepi-web:19d7cda`; `web.env` gains `HEPI_WEB_GATEWAY_URL`/`_TOKEN` | [record](19d7cda-deployment.md) |
| `96297fe` | 2026-10-12 | Web image only; the reverse forward moved to OpenSSH on the runtime host's port `2222` and the backend's `HEPI_GATEWAY_URL` became `18793` | [record](96297fe-deployment.md) |
| `0628888e5a85` | 2026-10-12 | both halves: bundle `release-0628888e5a85`, image `hepi-web:0628888e5a85` | [record](0628888e5a85-deployment.md) |
| `f603a48` | 2026-10-13 | Web image only; gateway untouched, no workspace re-registration needed | [record](f603a48-deployment.md) |
| `cb4494b` | 2026-10-13 | both halves plus the backend: bundle `release-cb4494b`, image `hepi-web:cb4494b` | [record](cb4494b-deployment.md) |

What the table keeps in one place: a step either moved the Web image, the gateway bundle, or both, and each record says
which — a Web-only step retagged one unit line and restarted one service, while a gateway step also re-registered the
four project folders, because that registry is in memory. `release-51492c4` is still installed on disk, which is what
made the gateway rollback a re-pin; the `hepi-web` images and their units are history now that the origin is the ingress.

### Configured default workspace removed — 2026-10-13

`HEPI_WORKSPACE_ID` and the six sessions bound to it were removed from the gateway's environment and the runtime host's
backend environment at the operator's request; no replacement default was configured, so only the four recorded project
folders were served (see [Projects](projects.md) for what replaced that notion). The gateway was restarted and the
folders re-registered through the existing path. Backups, the six tombstone removals and the residual limits are in
[the workspace-removal record](f603a48-workspace-removal.md).

## What was deliberately not changed

- No Tailscale `serve`/`funnel` configuration. `tailscale serve` needs the tailnet operator to grant this user
  rights, and without that it fails with "Access denied: serve config denied" while `sudo` needs a password. The
  UI is therefore reached over plain tailnet HTTP on the address above.
- No root, no privileged containers, no host socket.
- No wildcard or public bind: the container publishes nothing on `0.0.0.0`.
- The workspace was copied to its persistent home rather than moved destructively; the old fixtures under
  `/tmp/hepi-split-workspace` are still in place.
- Unrelated containers and listeners (including the service already on `8788`) were left alone.

## Remaining issues

- **HTTPS is not enabled locally.** Tailnet HTTP is encrypted in transit by Tailscale but is not browser HTTPS, so
  the login cookie is not `Secure`. HTTPS certificates are already enabled in the tailnet; configuring Serve on
  this machine requires a local administrator to grant this account operator permissions or run Serve.

## Final cross-host verification

The remote deployment is now live at `https://<runtime-host>.<tailnet>.ts.net:8443`, with its authenticated backend
at port 8444. See [the remote deployment](oracle-tailscale-deployment.md). Both Web instances share the same
durable backend and login token.

One real DeepSeek turn was submitted through this Web instance in conversation **60**. It called `read` on a
unique proof file in the persistent workspace, returned the exact on-disk marker, and produced an assistant
answer containing that marker. The remote Web context endpoint returned the same conversation and result.
No second paid turn was needed: an initial verifier assertion used the raw tool field `name` instead of the UI's
normalized `toolName`; correcting that assertion and inspecting the committed conversation confirmed the read.

Headless Chromium then logged in independently to both Web instances, rendered conversation 60, reloaded without
losing authentication, and filled and cleared the composer without submitting another prompt. Both pages had zero
JavaScript page errors. The local page has `isSecureContext=false`; the remote HTTPS page has `true`.
