# Split-topology deployment of 0628888e5a85

Moves the `ux-follow-up` tip from `96297fe` to **`0628888e5a85`**
(`0628888e5a8544b39b1732d712b1397b2acde82d`) on the split topology. All three roles moved in this range, so all three
were genuinely rebuilt or repacked and switched; the runtime host's own Web container was left running. Databases, the
agent directory, provider credentials, the tunnel, Tailscale Serve routes and the call journal were preserved, and the
gateway's pinned interpreter was kept. No paid model call was made.

`0628888e5a85` merges `fix/sshd-fixture-teardown` (review 73's approved tree `722db2a`, code `2e96779`) into the
`integration/p1` record: the file-payload capability (`POST /v1/files/upload`, `POST /v1/files/upload-check`,
`GET /v1/files/bytes` on the gateway; the backend's own relay at the same three paths; the browser explorer and viewer
through the Web adapter), the SSH fixture's pid-namespace teardown, the browser-stability and deploy-probe merges, and
CI's `bubblewrap` prerequisite.

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes — 8 files under `apps/server/src` | rebuilt for `linux/arm64`, transferred as an image tarball, digest verified, container recreated |
| Web UI | client host | yes — 12 files under `apps/web` | rebuilt for `linux/amd64`, unit retagged on one line, container restarted |
| gateway | client host | yes — `packages/gateway/src` gained the file payload routes | bundle rebuilt and reinstalled, unit's release path repointed, service restarted under the same pinned `/usr/bin/node` |
| oracle Web UI | runtime host | no (same image `hepi-web:df24b7c`) | untouched — not recreated |
| tunnel | client host | no | not restarted; the reverse forward on `18793` and the local forward on `18787` were already up |

## Artifact identity

| Role | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:0628888e5a85` | `sha256:241c204097cc9f11c8260317430ea0c82a3ff46f35a33447563558ea73f57e97`, linux/arm64, 210,881,386 bytes |
| Web UI | `hepi-web:0628888e5a85` | `sha256:8b87a3eec934611d2f871f81ecb5aeb179b577f3a9a3443c6d0e48a0ce5c56f5`, linux/amd64, 407,487,981 bytes, `.next/BUILD_ID AArWDh5qNdDkz1U-Zxlpf` |
| gateway bundle | `release-0628888e5a85` | tarball `hepi-client-0.1.0.tgz` `sha256:96c42c83bdcc210cfa46eeb9266d4d391cad74f0447379e2cb9a08382bd8b59b`; `dist/cli.js` `sha256:02132c8747197c35526b2a76795529328f1f26a88610eaef323cea6e8000dbb7` (built tree and installed file read back equal) |

Both images were built on the client host with `docker buildx` — the backend for the runtime host's architecture, the
Web UI for the client host's — then the backend was `docker save`-ed, gzipped, transferred over SSH and
`docker load`-ed. The digest read on the runtime host equals the build host's.

Artifact checks before any switch:

| Check | Result |
| --- | --- |
| image architecture, read from the image | backend `arm64`, Web UI `amd64` |
| Web image boot, sentinel container on a throwaway name and port `30199` | `/` `200`; Next.js ready; container stopped |
| backend image boot, sentinel container on port `8799` with a disposable state directory | `/api/models` `401` unauthenticated; it created `hepi.sqlite`, `projects.sqlite` and `skill-repository.sqlite` in that directory; container stopped and directory removed |
| gateway bundle | installed release's `cli.js` hash equals the built and packed hash |

## Release directory (runtime host)

`releases/0628888e5a85/` is the tracked tree of `0628888e5a85` from `git archive` (1,427 files), assembled in
`releases/.staging-0628888e5a85/`, checked there with `sha256sum -c`, then promoted with a single `mv`, so a failure
in verification would have left the running service untouched.

    SOURCE_COMMIT                  0628888e5a8544b39b1732d712b1397b2acde82d
    SHA256SUMS                     1,429 files hashed, verified in staging
    deploy/compose.yaml            sha256 c1afdfbdcc0ae221896a925441e8f5be41543b2775a049d981f5aa63952a963d  (tracked, unchanged)
    deploy/compose.oracle.yaml     sha256 49fc73b8107e09c1e3cbf15a86b8ef8124981cbb1fe374507636e96903954176  (deployment-generated)
    bin/run-0628888e5a85.sh        compose wrapper for this release (backend 0628888e5a85, Web df24b7c)

The override is the `96297fe` override repinned to `hepi-backend:0628888e5a85`; host networking, loopback-only
binding, `env/backend.env` (mode 600, unchanged), `user: 1001:1001`, both mounts (`state`, `agent`) and the Web line at
`hepi-web:df24b7c` are unchanged. No new named volume and no `:local` fallback. The range adds no environment
variable to the backend or the Web UI, so neither env file was edited.

## Database backups (online, writer never stopped)

Taken with SQLite's own online backup against the running writers, so no process was stopped for them.

Runtime host, `backups/20261012T215942-online-0628888e5a85/` (`SHA256SUMS` covers all three):

| File | sha256 | Result |
| --- | --- | --- |
| `hepi.sqlite` | `301ffdf7ff5d8bcb8348b26c3edcb9a9ea21850f889cd9b783c49a836dcfad1b` | integrity ok; 11 conversations, 1,536 entries, 3,147 record ids, 21 submissions, 76 documents, 82 document revisions, 1,503 tasks |
| `projects.sqlite` | `62d0e09ef4c8f25d3990288babffd2c1eb5b3de461c168e3ff51b3032c0f02b8` | integrity ok; 4 projects, 4 folders, 0 retained bindings |
| `skill-repository.sqlite` | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | integrity ok; 0 bundles, 0 files |

Client host, `~/.config/hepi/deploy-backups/0628888/20261012T215942-online-0628888e5a85/` (mode 700 directory, 0600
files): `calls.sqlite` `sha256:f643ac09311e5dfa501467b4ee83ff223e59f9495f4d78d60a23b70fc66bd764`, integrity ok, 783
`gateway_call` rows. The same directory holds private copies of the three user units and both env files taken before
any edit (mode 600).

Both gates were satisfied before the first write: **backup-verified** (all four durable databases copied by this run and
read back) and **single-writer** (one backend container on `127.0.0.1:8787` before the switch, and the old gateway
stopped before the new one started).

## Switch

Backend (runtime host) — genuinely recreated because the runtime changed:

    bin/run-0628888e5a85.sh up -d --no-build
    hepi-oracle-backend-1  Recreate -> Recreated -> Started
    Image=hepi-backend:0628888e5a85  RestartCount=0  StartedAt=2026-10-12T14:04:52Z  healthy

The runtime host's own Web container was **left running** by the same compose run
(`hepi-oracle-web-1  Running`, `RestartCount=0`, the `df24b7c` start unchanged).

Gateway (client host) — the bundle really changed (the file payload routes are new), so it was rebuilt, packed,
installed into `release-0628888e5a85` and switched:

    ExecStart=/usr/bin/node <client-root>/.local/share/hepi/client/release-0628888e5a85/node_modules/@hepi/client/dist/cli.js gateway
    hepi-gateway.service  active, NRestarts=0, started 2026-10-12T22:05:45+08:00, listening on 127.0.0.1:28788

The interpreter pin is preserved: the unit still starts the bundle with `/usr/bin/node`, never the `.bin` shim's
`#!/usr/bin/env node`, so the service does not depend on the user manager's `PATH`. `release-19d7cda` remains installed
as the rollback bundle.

Web UI (client host) — `hepi-web.service` changed on the tag line only; `HEPI_WEB_HOST`, `PORT=30141`,
`--network host` and `--env-file` are unchanged, and no environment file was edited:

    hepi-local-web  Image=hepi-web:0628888e5a85  RestartCount=0  StartedAt=2026-10-12T14:06:29Z

`hepi-tunnel.service` was not restarted; its forward was re-established by the switch cycle that stopped and started
the gateway and Web units (the tunnel unit is `Requisite=` on the gateway and a `Requisite` of the Web unit), and it is
active with `NRestarts=0`.

### Workspace re-registration (the gateway keeps its registry in memory)

A gateway restart forgets every workspace registration, so the four project-folder workspaces answered
`unknown workspace` again after the switch. They were re-registered through the path the backend already uses —
one `POST /api/worktrees` with `operation: "list"` per recorded folder, an operation these folders do not support and
whose branch registers the binding before it answers `not_supported` — which is also what the backend's own start and
`ensureBinding` do. No durable state was written. `GET /api/workspaces` then answered **5 workspaces with 0
`hostError`**, where it had answered 4 with an error before.

## Smoke test (read-only)

Authenticated first. No write to a user directory, no model call, and no paid provider was reached.

| Check | Result |
| --- | --- |
| `GET /api/models` unauthenticated / authenticated | `401` / `200` |
| `GET /api/workspaces` | 5 workspaces, 0 `hostError` |
| `GET /api/projects` | 4 projects, 4 folders, all `hostId=workstation` |
| catalogue through the Web UI (`GET /api/sessions`) | 10 conversations `[8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]`, the runtime's own root conversation absent |
| session state (`/api/sessions/8/state`, `/api/sessions/8`) | `200` |
| SSE (`/api/agent/8/events`) | `connected` and `durable_state` frames |
| login through the UI's own route | wrong token `401`, right token `200`, `httpOnly` `SameSite=strict` cookie set |
| `GET /api/mcp` | `{"mcp":{"available":true},...}` — the Web host's own gateway answers |
| non-GET without a matching `Origin` | `403` |
| Web UI `/` on the tailnet address | `200`; `127.0.0.1:30141` refused (tailnet bind only) |
| browser (headless Chromium) | bare load opened no project and no conversation; after login the sidebar listed the projects; a reload kept the session; **0 page errors**, every response `200` |

### File payload routes (the new capability)

Read-only against the live pair, through the backend relay and through the Web proxy, on the configured workspace and
on a project-folder workspace:

| Check | Result |
| --- | --- |
| `GET /api/files/bytes` without a token | `401` |
| no `cwd` / unknown workspace / directory named as a file | `501` / `404` / `400` |
| read a file (backend relay and Web `?type=read`) | `200`, whole body |
| download (Web `?type=download`) | `200`, `accept-ranges: bytes`, `content-disposition: attachment` |
| `Range: bytes=0-9` | `206`, `content-range: bytes 0-9/<size>`, 10 bytes |
| unsatisfiable range / missing file | `416` / `404` |
| `cwd` escaping the workspace | `403` |
| listing a folder | `200` with entries |
| `POST /api/files/upload` and `/upload-check` without a token | `401`; a malformed check `400`/`501` |
| gateway payload routes without a token | `401` |

The mutating half was exercised **only** against a disposable fixture, never against a user directory: the release's
own `cli.js` was started as a second gateway on a free loopback port with a temp workspace root, its own temp journal
and a temp token, and the whole temp directory was removed afterwards. There:

| Check | Result |
| --- | --- |
| `upload-check` | `200`, names the existing file as a conflict |
| `upload` | `200`, file written under the temp root, contents read back |
| the same upload with `conflict=error` | `409` with the conflict named |
| read back whole / `Range: bytes=0-6` | `200` / `206` with `content-range` |
| bytes without a token / traversal / unknown workspace | `401` / `403` / `403` |

Native runtime inside the deployed images:

| Check | Result |
| --- | --- |
| `process.version` / `process.arch` in the backend container | `v24.21.0` / `arm64` |
| `node:sqlite` `DatabaseSync` in the backend container | opens, creates, inserts, reads back `42` |
| `quickjs-wasi` in the backend container | `evalCode("6 * 7")` → `42` |
| `node-pty` in the Web image | spawns `/bin/sh`, `pty-ok` read back, `v24.21.0` `x64` |
| `apps/server/public/chat.js` in the backend image | present, 14,711 bytes |
| terminal capability through the Web adapter | a disposable session opened, one `echo` sent, output seen on the event stream, session closed, `unknown_terminal` after it |
| durable state after the switch | `hepi.sqlite` 11 conversations / 1,536 entries / 3,147 record ids / 21 submissions / 76 documents / 82 revisions / 1,503 tasks, `projects.sqlite` 4/4/0, `skill-repository.sqlite` 0/0, `calls.sqlite` 783 rows — all `integrity ok`, all identical to the pre-switch reading |

## Verification run against this revision

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm -r typecheck` | 0 |
| `pnpm -r test` | 0 — client 9, protocol 46, session 3, gateway 130, server 227 (415 total), 0 fail, 0 skipped |
| the gateway's SSH fixture and its six consumers, on the merged tree | 4 + 33 tests pass, 0 skipped, 0 leaked processes, 0 leftover `/tmp/hepi-sshd-*` directories |
| `pnpm check:docs` | 136 files, 0 broken relative links, 0 guides missing from the index |
| `pnpm deploy:inspect --probe` | **3**, `probe FAILED field=containerDetail` — the pre-existing limit recorded in the runbook, not this range's |

Raw logs: `.dev/deploy-0628888e5a85/` (inspect, plan, gate, build, verify, backup, switch, smoke) and
`.dev/verify/p1/2026-10-12T21-31-p1-fixture-merge.log`; the SSH fixture's own records are in
[verification](verification.md#shared-ssh-fixture-teardown-the-leaked-localhost-sshd-processes).

## Guide versions left current

- `docs/README.md` — current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` — Web image, gateway release and last-recorded lines; the interpreter pin is
  recorded as preserved.
- `docs/oracle-tailscale-deployment.md` — backend image table and last-recorded section.
- `docs/deployment.md` — last-recorded-state line.
- `docs/migration-status.md` — the file-payload capability is recorded as deployed, not only implemented.
- `docs/mcp-on-the-web-host.md` — unchanged: this range adds no variable and does not move the MCP surface.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    bash <runtime-root>/bin/run-96297fe.sh up -d --no-build

`hepi-backend:96297fe` (`sha256:165190a59c6a...`) is still on disk. This range adds no schema change — `projects.sqlite`
keeps the `retained_bindings` table it already had and no migration runs — so the previous image reads the same
databases and no restore is required.

**Web UI (real).** `hepi-web:96297fe` (`sha256:be0b864f2113...`) is still on disk; restore the backed-up unit or edit
the one tag line back, then `systemctl --user daemon-reload && systemctl --user restart hepi-web.service`.

**Gateway (real).** `release-19d7cda` is still installed; point the one `ExecStart` line back at it and restart
`hepi-gateway.service`. Reverting loses the file payload routes, which is what the previous deployment served.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate recovery
action, not part of reverting this deployment, and that path was not exercised here.

## Remaining limits

- The live model turn was not run: the backend's catalog, auth, durable reads, file routes and terminal relay are
  proven, generation is not. No paid call was made.
- The gateway's file payload routes were smoke-tested against a disposable fixture gateway rather than against the
  live gateway's own workspace, so no user directory was written to. The live gateway's routes answer identically
  because it is the same bundle, and the backend relay's own end-to-end tests cover the live shape
  (`apps/server/test/files-transfer.test.ts`, `apps/server/test/file-relay.test.ts`).
- `deploy:inspect --probe` still exits 3 at `containerDetail` on a host with a container that has no `HEALTHCHECK`
  (pre-existing, recorded in the runbook).
- The Web unit suite's pre-existing failures are unchanged by this range and were not re-measured here.
