# Container deployment: the backend image

**One image.** `hepi-backend` packages the durable backend — the single SQLite writer, the agent loop and model access.
The Web origin is **not** a container: it is the client ingress, a Node process serving the Vite build and answering
`/api` on the same listener, released and run as a systemd user unit beside the backend
([client-runtime release](client-runtime-release.md), [client ingress](client-ingress.md)). Its former Next container,
`hepi-web`, was retired with the ingress cutover (client-app ticket 17); `deploy/compose.yaml` has one service and
`deploy/docker/` holds one Dockerfile. [Deployment](deployment.md) covers the roles and the SSH topology.

Since 2026-10-16 the test backend runs on the workstation with the gateway, on amd64; its former remote instance is
stopped. [The migration record](backend-local-migration-2026-10-16.md) owns that topology and its rollback; the split
Compose recipe below remains available for an explicit split deployment.

The image builds from the repository root on the root `pnpm-lock.yaml`, and its runtime stage carries **no secret**:
every provider key and token is runtime environment. The Dockerfile declares no `ARG` at all, so nothing secret can be
baked in by a build argument, and `deploy/.env` is git-ignored.

## What the image contains, and what it deliberately does not

- **Node 24 and pnpm 12.4.1, pinned.** `node:24-bookworm-slim` plus `corepack prepare pnpm@12.4.1`, matching the root
  `packageManager`. Node 24 is required: the backend, gateway and protocol packages are TypeScript run directly through
  Node's type stripping, so no compiled output exists to ship.
- **No Web server.** The static Web build is `apps/web/dist`, produced by `pnpm --filter @hepi/web build` on the build
  host and served by the ingress from `HEPI_INGRESS_STATIC_DIR`; the release that carries it is described in
  [client-runtime release](client-runtime-release.md). This image contains no page, no Next runtime and no BFF process.
- **Native dependencies.** `node:sqlite` (`DatabaseSync`) is built into Node 24 and backs the conversation database and
  the skill repository. The browser terminal is a session on the execution host (`packages/gateway/src/terminal.ts`).
- **No provider, no credential, no host access at build time.** The build runs `pnpm install` and emits nothing secret.

## Build

Build host (`workstation` or CI) only:

```bash
docker build -f deploy/docker/backend.Dockerfile -t hepi-backend:local .
```

Multi-architecture: the image is an arch-neutral input to `docker buildx build --platform linux/amd64,linux/arm64`,
which is what the release workflow uses. A local cross-architecture build needs binfmt/QEMU registered on the builder
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`); a native builder of the target architecture needs
nothing extra.

**Run image builds on `workstation` or in CI — never on `remote-host`.** That host deploys and runs images; it does not build
them — no `docker build`, no `docker buildx`. Build for the architecture it runs (`linux/arm64`) here or in CI and
move the prebuilt image there by pinned tag/digest or tarball; see [deployment](deployment.md) and
[the Oracle guide](oracle-tailscale-deployment.md). Only `linux/amd64` and `linux/arm64` are supported.

## Run with compose

Requires Docker Compose 2.24.4 or newer; the bridge override uses `!reset` to remove host networking and the base file
uses optional environment files.

Two recipes, and the difference matters: one builds, one only runs the artifact. **`up --build` is a build command and
belongs to the build host (`workstation` or CI). A deployment host runs the second recipe.**

Build host — build, start, and confirm:

```bash
cp deploy/.env.example deploy/.env      # fill in HEPI_AUTH_TOKEN, workspace binding, provider
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps        # health is reported per service
```

Deployment host (`remote-host`) — runtime only, the image already present as a pinned tag or digest:

```bash
docker compose -f deploy/compose.yaml up -d --no-build
docker compose -f deploy/compose.yaml ps
```

Both need `deploy/.env` next to the compose file (the deployment host gets its own, or the release's env file). Only
`HEPI_AUTH_TOKEN` is obligatory to start; the host port, the image tag and the provider variables all have working
defaults.

**`remote-host` has one operational path: the prebuilt image with `up -d --no-build`.** A compose command without
`--no-build` on that host is a build, and if the tag is missing it fails or falls back to a local build. Build where the
toolchain is, transfer the pinned tag or digest, then run. The stage-by-stage sequence, including backups and rollback,
is [the deployment runbook](deployment-runbook.md).

### Published image

The release workflow pushes the backend image to GHCR on a version tag. To run that instead of building, put the tag in
`deploy/.env` and pull:

```bash
# deploy/.env
HEPI_BACKEND_IMAGE=ghcr.io/<owner>/<repo>/backend:v0.1.0

docker compose -f deploy/compose.yaml pull          # or ... -f deploy/compose.split.yaml for that topology
docker compose -f deploy/compose.yaml up -d --no-build
```

The tag is `ghcr.io/<owner>/<repo>/backend` with the version (`v0.1.0`, plus a `sha-<commit>` tag) as the release
workflow publishes it; `<owner>/<repo>` is lowercased. `--no-build` is what makes it use the pulled image rather than
a local build, so a typo in a tag surfaces as a pull failure instead of a silent rebuild.

### Default: host network

`deploy/compose.yaml` runs the backend with `network_mode: host`. This is not a shortcut, it is the topology:

- The backend reaches its execution host through an **SSH reverse forward that listens on the host's loopback**
  (`ssh -R 127.0.0.1:18788:127.0.0.1:28788 <host>`, [deployment](deployment.md)). A container on the default bridge
  network has its own loopback and **cannot** reach that forward, so `HEPI_GATEWAY_URL=http://127.0.0.1:18788` only
  works with the host network.
- The reverse forward must not be widened with `GatewayPorts` to make a bridge container work: that would expose the
  gateway port on a routable interface.
- Host networking does not expose anything by itself: the process still binds `127.0.0.1` only (`HEPI_BIND_HOST`),
  the same loopback-only surface as running it directly on the host.

With host networking there is no `ports:` mapping — the process binds the host's loopback directly at
`127.0.0.1:${HEPI_BACKEND_PORT}`, and the tunnel listens on `127.0.0.1:18788`. The port comes from `deploy/.env`
(default 8787) and `PORT` follows it, as does the healthcheck. The Web origin reaches this backend at
`http://127.0.0.1:<HEPI_BACKEND_PORT>` through `HEPI_INGRESS_BACKEND`.

### Split profile: bridge network

```bash
# build host: builds, then starts. Deployment host uses the same command with --no-build.
docker compose -f deploy/compose.yaml -f deploy/compose.split.yaml up -d --build
```

`deploy/compose.split.yaml` clears `network_mode` (`!reset null`, otherwise the merge keeps host networking and the
published port would be ignored) and puts the backend on Compose's default network, published on the host's loopback
only: `127.0.0.1:${HEPI_BACKEND_PORT}`. Inside the container the process binds its own interface
(`HEPI_BIND_HOST=0.0.0.0`) because a container's loopback is not the published one, and the internal port stays 8787 —
it is the published side that moves. The host side of the mapping is still `127.0.0.1`, so the reachable surface is
identical.

**The ingress is not part of either profile**, and that is the part to get right in a split: an ingress on the host
reaches the split backend as `HEPI_INGRESS_BACKEND=http://backend:8787` when it runs on the same Compose network, or
through the host-published loopback port. `host.docker.internal` is not that address — it is the bridge gateway, and the
host-published socket is a different socket it does not forward.

The remaining trade-off is the backend's SSH reverse forward, which is no longer on its own loopback. Either run the
forward inside a sidecar that shares the backend's network namespace, or give the backend a `HEPI_GATEWAY_URL` it can
route to — which means binding the forward on a routable address, so prefer the sidecar.

MCP is unaffected by this profile, because the MCP host service belongs to the **Web origin**, not to the backend: the
ingress names its host gateway in `HEPI_INGRESS_MCP_GATEWAY_URL`/`_TOKEN`/`_ID`
([MCP on the Web host](mcp-on-the-web-host.md)). A deployment that sets none answers `mcp_unavailable` and every other
setting keeps working.

Nothing in the split profile is a security boundary: it changes routing, not trust. Neither profile should be exposed
on a routable interface without HTTPS and an authenticating reverse proxy in front.

### Persistent state

`deploy/compose.yaml` mounts the named volume `hepi-state` at `/var/lib/hepi` and puts the durable files there:

- `hepi.sqlite` — conversations (single writer; do not start a second backend against it).
- `skill-repository.sqlite` — skill repository metadata, deliberately a separate file (ADR 0002).
- `projects.sqlite` — Project metadata (default: beside `HEPI_DB`).

Back them up as [deployment](deployment.md) describes, including the `-wal`/`-shm` siblings.

### Secrets, and which process sees which

The compose file hands the backend only the runtime environment it needs, never a Web login: the ingress keeps its own
mode-0600 env file (`HEPI_INGRESS_BACKEND`, `HEPI_INGRESS_SERVICE_TOKEN`, `HEPI_WEB_LOGIN_TOKEN`, the MCP host
gateway and the static dir — one table in [client-runtime release](client-runtime-release.md)). `deploy/.env` also
carries provider credentials and the gateway token, which the ingress has no use for.

- `HEPI_AUTH_TOKEN` — required (compose refuses to start without it). It is the backend API's own bearer token; the
  ingress presents it as `HEPI_INGRESS_SERVICE_TOKEN` on outbound calls, and the browser never receives either value.
  The human's Web login is the ingress's `HEPI_WEB_LOGIN_TOKEN`, a separate material.
- `HEPI_GATEWAY_URL`/`HEPI_GATEWAY_TOKEN`, `HEPI_MCP_TOOLS` (the operator's fallback presentation for MCP tools —
  names and schemas only, never a credential, offering nothing by itself and no ceiling over what a conversation may be
  granted; [MCP on the Web host](mcp-on-the-web-host.md)) and provider credentials (`HEPI_PROVIDER_API_KEY`,
  `OPENAI_API_KEY`, or `HEPI_CONFIG_SOURCE=pi` with `PI_CODING_AGENT_DIR`) are read by the backend process only — see
  [providers](providers.md) for the strict startup rules and [Pi configuration](pi-config.md) for the Pi-agent-directory
  mode. A mounted Pi agent directory is the one case where credentials live on disk; mount it read-only at your own path
  and point `PI_CODING_AGENT_DIR` at it.

A provider key a person stores in Settings is not one of those variables: it goes to the **ingress's** host gateway,
which writes that host account's own files, and the backend resolves only what its own account, environment or
`models.json` makes available ([providers](providers.md#secrets)).

## Health and readiness

The backend declares a `healthcheck`, and the probe is readiness, not "is the process alive":

- Backend: `GET /api/models` **with the bearer token**. That route resolves the model registry, so it only answers
  `200` once the harness, the SQLite store and the model catalog are up. Without the token the same route answers
  `401` — which is the check to make by hand:

  ```bash
  P=${HEPI_BACKEND_PORT:-8787}
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$P/api/models"                        # 401
  curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $HEPI_AUTH_TOKEN" \
       "http://127.0.0.1:$P/api/models"                                                            # 200
  ```

  A health endpoint that answered `200` without authentication would be a false green and an unauthenticated
  information leak, so there is none.

  Startup validation is strict about a *contradictory* configuration — an unusable `models.json` or `settings.json`, or
  a provider id that arrives without its model — and such a backend fails instead of reporting healthy. It is not strict
  about an *absent* default: with no default provider/model configured, or with a saved default the catalog no longer
  serves, the backend reports the condition as a startup warning and stays operational with settings access, taking the
  first authenticated catalog entry as Pi's own fallback does in `HEPI_CONFIG_SOURCE=pi` mode. In environment mode
  there is no such fallback, and an unconfigured deployment offers no model and states `defaultModel: null`; see
  [providers](providers.md) and [Pi configuration](pi-config.md) for the exact rules.

- Web origin: it is **not in this compose file**. Check the unit (`systemctl --user status hepi-ingress.service`) and
  the ingress's own read-only smoke list in [client-runtime release](client-runtime-release.md).

`docker compose ps` shows `healthy` once the backend probe passes. If it stays `starting`, read the logs: a provider
misconfiguration, a missing `HEPI_AUTH_TOKEN`, or a second writer on the same database all fail loudly there.

## Smoke test

`deploy/docker/smoke.sh` (no arguments) builds the image, runs it on an ephemeral loopback-published port on a private
network with a throwaway state directory, and removes everything afterwards. It needs only the Docker daemon: the image
installs pnpm itself, so CI does not need Node or pnpm for this job. It configures no model provider — no live
credential, no network model call, no cost — and asserts:

- the backend answers `GET /api/models` with the token and `401` without it;
- the unconfigured catalog states `"defaultModel":null`;
- a conversation created through `POST /api/conversations` still exists after `docker restart`;
- `hepi.sqlite` and `skill-repository.sqlite` are in the state directory after the run.

It prints one `PASS`/`FAIL` line per check and exits non-zero if any failed. The CI workflow runs it in the release
gate. The ingress has its own read-only smoke list, which is where a Web-origin check belongs now.

## Verification, and what is historical

The image's own recorded run is the smoke list above. Earlier container evidence in this file's history — two images,
the Web container's login-proxy checks, the 14/14 smoke count — was measured against the retired Next Web container and
is **not** a statement about this topology: ticket 17 removed that image and the route it probed.
[Verification](verification.md) holds the current commands and the revisions they ran on.

Not verified by this work:

- No live provider, live SSH host or real model was exercised through this image. The smoke test is deliberately
  offline.
- `linux/arm64` correctness is checked by building and running the image, not by a full end-to-end session on arm64
  hardware; the release workflow builds both platforms, and only a pushed tag publishes them.

## Trusted-agent model, and what this is not

The agent runs with the user's trust on the execution host and already has a shell there. This container packages the
process; it is not a sandbox and this document claims no isolation from it. Two consequences worth stating plainly:

- The backend container can reach whatever the host network reaches, and with host networking that includes the
  loopback the SSH forward listens on. That access is the feature.
- Path guards in the file tools (workspace confinement, read-only resource locations, install placement) are path
  discipline for the loader and install code, not a containment boundary; see
  [execution-side resources](execution-side-skills.md). Isolation, where it is wanted, belongs at the
  execution-environment boundary.
