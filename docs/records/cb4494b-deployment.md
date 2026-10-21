# Split-topology deployment of cb4494b

Moves the `integration/chat-lifecycle` tip from `f603a48` to **`cb4494b`**
(`cb4494b0b4429bda1d9940257f661239171ce502`) on the split topology: the durable backend on the runtime host, the
client host's Web UI and execution gateway on the build host. Databases, the agent directory, provider credentials,
the tunnel, Tailscale Serve routes and the call journal were preserved, and no paid model call was made.

**Tested revision and date.** Everything below was verified against **exactly** `cb4494b`
(`cb4494b0b4429bda1d9940257f661239171ce502`) on **2026-10-13**, on the running hosts. No other revision was tested in
this range. One check in this range did **not** pass and is recorded as a failure, not as green: the runtime host's own
verify script (9 passed, 1 failed) — the same stale assertion the `f603a48` record already carries. See *Smoke test*.

Hosts are named by role (`build host`, `runtime host`, `client host`) and roots by placeholder
(`<runtime-root>`, `<client-root>`, `<client-home>`, `<build-tmp>`); the real mapping lives in the operator's
git-ignored private config (`deploy/deploy.local.env`, mode 0600). This record names roles, tags, digests, hashes and
counts, never a host name or address, a login account, a credential value, a credential-file path or a personal
filesystem path.

## What changed between f603a48 and cb4494b

This is the resource-snapshot increment: one resource discovery becomes one host round trip instead of one per file.

| Area | Files | Runtime effect |
| --- | --- | --- |
| `packages/gateway/src/filesystem.ts` | +307/−3 | **gateway change** — `resourceSnapshot`, the whole execution-side resource scope set in one value (roots, directories with entries, canonical targets, ignore files, skill heads and prompt bodies), bounded by `MAX_SNAPSHOT_BYTES` (16 MiB) and `MAX_SNAPSHOT_ENTRIES` (20 000) |
| `packages/gateway/src/resource-ignore.ts` | new (+40) | the gitignore grammar shared by the producer walk and the loader, ported from upstream `node-ignore` 7.0.5 (`node-ignore.LICENSE` kept verbatim) |
| `packages/gateway/src/environment.ts`, `index.ts` | +21/−6 | `ExecutionHostEnv` gains `resourceSnapshot`; the new types and constants are exported |
| `packages/gateway/src/ssh-filesystem.ts` | +18/−1 | the remote helper gains a `snapshot` mode, so an SSH host serves one discovery in one helper run |
| `apps/server/src/workspace-resources.ts` | +175/−71 | **backend change** — the loader reads its catalog from the snapshot and **requires** the method: a host that cannot answer it is refused instead of falling back to a per-file walk (ADR 0002) |
| `apps/web` | 12 files | **Web change** — `view.phase` (`idle`/`preparation`/`running`) and the `statusPhase` the window draws, plus the outstanding-submission notice and the new `chat.preparing` string |
| `packages/client` | 3 files | **bundle change** — the third-party notice for the Python `node-ignore` port and its `smoke:pack` assertion; no `src` change |
| `packages/protocol`, `packages/session` | 0 | no runtime change |
| `pnpm-lock.yaml` | −3 | `ignore` moves from `apps/server` to `packages/gateway` (its only consumer now) |

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes (`apps/server`, `packages/gateway` bundled into it) | rebuilt for `linux/arm64`, transferred as an image tarball, digest verified, container recreated |
| gateway | client host | **yes** (`packages/gateway/src`, `packages/client`) | rebuilt bundle, new install directory, unit line retagged, service restarted |
| client bundle | client host | yes | `release-cb4494b`, installed from the packed tarball |
| Web UI | client host | yes (`apps/web`) | rebuilt for `linux/amd64`, unit retagged on one line, container restarted |
| oracle Web UI | runtime host | no | untouched, still `hepi-web:df24b7c`, same `StartedAt` |
| tunnel | client host | no | untouched, `NRestarts=0` |

Unlike the two increments before it, this range **does** change the gateway: `packages/gateway/src` and
`packages/client` both move, and the loader refuses a host that cannot answer `resourceSnapshot`.

## Coordinated window: the backend and the gateway must move together

The backend and the gateway exchange the new method, and the loader has **no fallback**:

| Pair | Loader `resourceSnapshot` result | Discovery outcome |
| --- | --- | --- |
| old gateway, old loader (`f603a48`) | per-file walk | works (that was the old path) |
| old gateway, new loader (`cb4494b`) | `{"ok":false,"error":{"code":"not_supported"}}` | **fails**: "the conversation has no execution environment that can read its execution-side resources" |
| new gateway, old loader (`f603a48`) | `not_supported` on the old call path | the old loader walks per file and gets the same catalog |
| new gateway, new loader (`cb4494b`) | one snapshot value | works, one round trip |

Measured on the build host with the two revisions' own loaders against the two gateways (same workspace, read-only,
no durable write): the new loader against the old gateway failed in 9 ms; the old loader against the new gateway
returned the identical catalog (5 skills) in 52 ms; the new loader against the new gateway returned it in 21 ms.

**A partial release would therefore be a broken release, not a slow one.** The switch was taken as one coordinated
window with the backend and the gateway both stopped and restarted, and the loader's own refusal is what makes the
window's failure mode loud rather than silent: a backend running `cb4494b` against a still-old gateway answers every
first submit with an explicit resource-discovery error instead of quietly walking the host. The client host's Web UI
was moved in the same window, so the three roles never disagreed about the wire.

## Artifact identity

| Role | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:cb4494b` | `sha256:cc4f8a9c742b9a033fa1c3ee789c63e938ff099b41f45d9d5a9d213c06af45b4`, linux/arm64, 216,387,441 bytes |
| Web UI | `hepi-web:cb4494b` | `sha256:85c8fe0ce25939b911e21b751a3fd243ef743b8a4562d1146e84d9813d9f7ee0`, linux/amd64, `.next/BUILD_ID SNiHeL67MI1IUTRzUEg1L` |
| gateway bundle | `release-cb4494b` | `node_modules/@hepi/client/dist/cli.js` `sha256:5afe10caffae5e39e507eebd8d57596e1ec987495d491cb4df2f2d092a3651d0`; packed tarball `hepi-client-0.1.0.tgz` `sha256:28ad82100b81d3d8da02e5128b89935c766218bbe782d6279cffd19f98e7ce8e` (the previous `release-0628888e5a85` bundle hashes `02132c874719…`, so this is a genuinely different bundle) |

Both images were built on the build host with `docker buildx` — the backend for the runtime host's architecture, the
Web UI for the build host's — then the backend was `docker save`-ed, gzipped, transferred over SSH and `docker load`-ed.
The digest read on the runtime host equals the build host's, and the architecture was read from the **image**
(`docker image inspect`), never from a running container. Nothing was built, installed or compiled on the runtime host.

Source identity:

    git archive --format=tar.gz cb4494b -> hepi-cb4494b.tar.gz   sha256 56ef7eb5594bf60adf43f68421618f10da0abbd7fb32c60c234c9a58dfe9e892  4,135,115 bytes
    1,510 files in the release tree; SHA256SUMS over those 1,510 (excluding itself) verifies with `sha256sum -c`,
    SHA256SUMS sha256 21441e3b966421f4a208886c9caa02a6b2dbedb9087732bcdeab79dc009b236d,
    deploy/compose.oracle.yaml sha256 877722f4a84e4a71496996b23ed8597c8eefdbbcb9f4e2f6a179172f69bc7de1,
    SOURCE_COMMIT reads cb4494b0b4429bda1d9940257f661239171ce502.

Backend image tarball:

    hepi-backend-cb4494b.tar.gz  sha256 c96835d363cf14e753ab5349aad8c0178f605368f8813fdbb55121481933ecf1  215,317,628 bytes
    read back on the runtime host with the same sha256 before `docker load`

The release was assembled in `<runtime-root>/releases/.staging-cb4494b/`, verified there, and promoted with one `mv`
to `<runtime-root>/releases/cb4494b/`; the previous `f603a48` release directory and its image are both still in place.

## Build gate (build host only)

Run in a clean extraction of the archive (`<build-tmp>/cb4494b`), never on the runtime host:

| Step | Command | Exit | Log |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile` | 0 | `<build-tmp>/gate-cb4494b.log` |
| typecheck | `pnpm -r typecheck` | 0 | same log |
| tests | `pnpm -r test` | 0 | same log |
| client pack | `pnpm --filter @hepi/client build && smoke:pack` | 0 (6 checks ok) | `<build-tmp>/build-client-cb4494b.log` |

Test totals from that log: `packages/protocol` 47, `packages/client` 9, `packages/session` 3, `packages/gateway` 140,
`apps/server` 244 — **443 tests, 0 failures**. Those four steps are the build gate; they do not cover the host-side
failure recorded below.

## Artifact boot check (build host, throwaway)

Both images were started once on the build host and then removed, so the deployed pair was not the first thing to run
them:

| Check | backend `hepi-backend:cb4494b` | Web `hepi-web:cb4494b` |
| --- | --- | --- |
| runtime | `node v24.21.0 arm64` | `node v24.21.0 x64` |
| readiness | unauthenticated `/api/models` `401`, authenticated `200` | `/` `200`, `.next/BUILD_ID SNiHeL67MI1IUTRzUEg1L` |
| native | `node:sqlite` opens and queries; the QuickJS wasm module compiles and `evalCode('6 * 7')` evaluates on arm64 | `node-pty` spawns `/bin/sh` and reads back `pty-ok` |
| served page | `/app/apps/server/public/chat.js` present, 14,711 bytes | — |

## Database and configuration backups (online, writers never stopped)

Every database in use was copied with the SQLite online backup API — the writer kept running — and each copy was then
read back for `pragma integrity_check`, its table list and its per-table row counts:

| Host | Backup directory | Contents |
| --- | --- | --- |
| runtime host | `<runtime-root>/backups/20261013T122822Z-online-cb4494b/` (mode 0700) | `hepi.sqlite`, `projects.sqlite`, `skill-repository.sqlite`, plus `backend.env.copy` (mode 0600) |
| client host | `<client-home>/.local/share/hepi/backups/20261013T122822Z-online-cb4494b/` (mode 0700) | `calls.sqlite`, plus the two env files and all three unit files (mode 0600), with `report.json` |

| Database | `integrity_check` | sha256 of the copy | Counts read from the copy |
| --- | --- | --- | --- |
| `hepi.sqlite` | ok | `8161b57379036a9e1d3acfed29459002c317efaeb0aa22394375edd7529794cc` | conversations 15, entries 1,558, record ids 3,227, submissions 28, tasks 1,514, documents 112, document revisions 126 |
| `projects.sqlite` | ok | `62d0e09ef4c8f25d3990288babffd2c1eb5b3de461c168e3ff51b3032c0f02b8` | projects 4, project folders 4, retained bindings 0 |
| `skill-repository.sqlite` | ok | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | bundles 0, bundle files 0 |
| `calls.sqlite` (gateway journal) | ok | `9987197ff888d52a2886d0cff6a99442a5f338a453145576ae07f8de5612abec` | 785 `gateway_call` rows |
| `backend.env` copy | — | `49c1988dd87b87a99786591fedde15d0a1e334b014c2a178903ff32125771239` | keys unchanged, no value recorded here |

Copied private configuration and units, hashed for rollback: `gateway.env` `795f548d80ee…`, `web.env`
`d84ee8d9baa1…`, `hepi-gateway.service` `7579a8b15a17…`, `hepi-tunnel.service` `60a7e67a449f…`,
`hepi-web.service` `bededb8dfdfb…`.

The runtime host's `env/backend.env` was read to confirm the environment this deployment inherited: it holds the auth
token, the bind host, the port, the database paths, the gateway id/URL/token and the provider selection. It carries
**no `HEPI_WORKSPACE_ID`** — the removal recorded in
[the workspace-removal record](f603a48-workspace-removal.md) still holds, so the backend configures no workspace and
serves only the four recorded project folders. Nothing in it was changed by this deployment.

## Switch

One writer per database throughout: the backend container is the only process on the runtime host's state directory,
and the client host's gateway is the only process on the call journal.

| Role | What was done | Evidence it was the intended artifact |
| --- | --- | --- |
| backend | `bash <runtime-root>/bin/run-cb4494b.sh up -d --no-build backend` (the new `bin/run-cb4494b.sh` pins `hepi-backend:cb4494b` over the release's `compose.oracle.yaml`) | container recreated at `2026-10-13T12:41:08.613413941Z`, image `sha256:cc4f8a9c742b…`, `RestartCount=0`, health `healthy` |
| oracle Web UI | **nothing** | still `hepi-web:df24b7c` `sha256:624043a1…`, same `StartedAt 2026-10-12T02:45:38.441489959Z` |
| gateway | `ExecStart` moved one line to `<client-home>/.local/share/hepi/client/release-cb4494b/…/cli.js`, `daemon-reload`, `systemctl --user restart hepi-gateway.service` | `NRestarts=0`, active, listening on `127.0.0.1:28788`; `GET /v1/workspaces` answers and re-registration repopulated the registry |
| Web UI | `ExecStart` moved one line to `hepi-web:cb4494b`, `daemon-reload`, `systemctl --user restart hepi-web.service` | container `hepi-local-web` started `2026-10-13T12:42:53.695466422Z`, `RestartCount=0` |
| tunnel | **nothing** | `NRestarts=0` |

The gateway's workspace registry is in memory, so the backend replayed all four recorded project folders on the first
host-facing request. Read back after the switch: `GET /v1/workspaces` lists `local` plus the four folder workspace
ids, and `GET /api/workspaces` lists exactly those four with no `hostError` on any of them.

## Smoke test (read-only)

`bin/verify-oracle.sh` on the runtime host: **9 passed, 1 failed**, exit 1 — **not all green**. The single failure is
the same stale assertion the `f603a48` record already carries: it expects conversation id `1` in
`GET /api/conversations`, but `1` is the runtime's own root record, which `96297fe` deliberately stopped projecting
into the catalogue (the row is still in the database and in the backup). Every other check passed: unauthenticated
`/api/models` `401`, authenticated `200` naming `magpie / deepseek-v4.1-flash`, the Web UI serving `/`, its
unauthenticated proxy call `401`, login setting a cookie, the proxied `/api/models` `200`, `node:sqlite` and
`node-pty` working on arm64 inside the containers, and only `127.0.0.1:8787` and `127.0.0.1:30141` listening.

Read-only checks against the deployed pair (backend through the client host's `127.0.0.1:18787` forward, Web through
the tailnet address). Everything in this table passed:

| Check | Result |
| --- | --- |
| unauthenticated `/api/models` | `401` |
| authenticated `/api/models` | `200`, the configured catalog |
| catalogue continuity | 7 conversations `[172, 197, 249, 655, 3154, 3177, 3190]`, identical to the pre-switch reading |
| removed sessions stay removed | the six conversations tombstoned on 2026-10-13 are still absent; `hepi.sqlite` holds 15 conversation rows and 7 `hepi.deleted` documents (the six plus the diagnostic conversation removed on the same date) |
| project continuity | `GET /api/workspaces` returns the four recorded project folders, none reporting a host error |
| conversation state read-back (`3154`, `3190`) | `200`, `busy:false`, `resources` `loaded` with 41 skills |
| Web UI `/` on the tailnet address | `200`; `127.0.0.1:30141` refused (tailnet bind only) |
| Web unauthenticated API / wrong token / right token | `401` / `401` / `200` with a session cookie |
| Web catalogue (`GET /api/sessions`) | the same 7 ids as the backend catalogue |
| Web `/` on the runtime host's own container (`8443`) / backend (`8444`) | `200` / `401` unauthenticated |

Post-switch state re-read on the runtime host: all three databases `integrity_check ok` with **every count identical
to its backup** (15 conversations, 1,558 entries, 3,227 record ids, 28 submissions, 1,514 tasks, 4 projects, 4 folders,
0 retained bindings). The gateway call journal still holds **785** rows, so no paid call was made.

## The snapshot method, verified against the deployed gateway

The new capability was exercised on the deployed pair with the deployed loader, read-only: no durable write, no
conversation created, no model call, no reload. The probe imports the release's own `createWorkspaceResources` and
`gatewayEnvironment`, so it measures the shipped code, not a copy.

| Workspace | One discovery (new pair) | Same tree walked per file (legacy RPCs) |
| --- | --- | --- |
| the configured workspace root | 17 ms, 8 directories, 5 files, 5 skills | 35 RPCs, 0.13 s |
| a recorded project folder (41 skills, 122 directories, 133 Markdown files) | **40 ms, 1 request**, 41 skills | **520 RPCs, 79.6 s** through the tunnel from the runtime host; **1.4 s** on the client host |
| a second recorded project folder | 22 ms, 56 directories, 84 files | — |
| a third recorded project folder | 3 ms, 7 directories, 5 files | — |
| a fourth recorded project folder | 2 ms, 6 directories, 4 files | — |

The snapshot's own size is bounded and reported: 465,898 bytes for the 41-skill project folder, 8,796 bytes for the
configured root. The legacy walk is the same one that produced the measured 70-second first-submit stall diagnosed on
this date (recorded separately as `diagnosis-submit-stall-f603a48.md`, on its own documentation branch); on this pair
the first discovery of that folder costs one request instead.

## Guide versions left current

- `docs/README.md` — current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` — installed-client and Web-image lines and the last-recorded section moved to `cb4494b`.
- `docs/oracle-tailscale-deployment.md` — backend image table and last-recorded section moved to `cb4494b`.
- `docs/deployment.md` — last-recorded-state pointer moved to this record.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    bash <runtime-root>/bin/rollback-to-f603a48.sh

`hepi-backend:f603a48` (`sha256:95cd7eca1535…`) is still on disk, and the new wrapper stops this release's backend
before starting the previous one on the same state. This range adds no schema change — no migration runs — so the
previous image reads the same databases and no restore is required.

**Gateway (real, and it must move with the backend).** Restore the backed-up unit or edit the one `ExecStart` line
back to `release-0628888e5a85`, then `systemctl --user daemon-reload && systemctl --user restart hepi-gateway.service`.
Because the loader refuses a host without `resourceSnapshot`, a backend rollback alone leaves discovery broken; roll
the two roles back together.

**Web UI (real).** `hepi-web:f603a48` (`sha256:bca3331fd93f…`) is still on disk; restore the backed-up unit or edit
the one tag line back, then reload and restart the unit.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate recovery
action, not part of reverting this deployment, and that path was not exercised here.

## Remaining limits

- The live model turn was not run: the catalog, auth, durable reads, the snapshot discovery and the lifecycle payload
  are proven, generation is not. No paid call was made.
- The runtime host's own Web container stays on `hepi-web:df24b7c` by design (the Web UI is the client half's), so
  `8443` keeps serving the pre-lifecycle Web UI.
- `bin/verify-oracle.sh` **fails one check** (9 passed / 1 failed, exit 1), the same stale conversation-`1`
  assertion the `f603a48` record already carries. Recorded as a **failure in the result, not a pass**, and not fixed here.
- `deploy:inspect --probe` still exits 3 for the pre-existing reason the `f603a48` record names
  (`<runtime-root>/SOURCE_COMMIT` does not exist; the marker lives in each `releases/<id>/`). Unchanged by this range.
- The probe was a single discovery per workspace, not a load measurement under concurrency: the 79.6-second legacy
  figure is one sequential walk of one folder, and the snapshot figure is one request for the same tree.
- The client host's Web unit suite's pre-existing failures were not re-measured here.
