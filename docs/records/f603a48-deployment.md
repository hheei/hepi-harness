# Split-topology deployment of f603a48

Moves the `integration/chat-lifecycle` tip from `0628888e5a85` to **`f603a48`**
(`f603a4853345728e72d8418fd6c79df2c7bb03ba`) on the split topology: the durable backend on the runtime host, the Web UI
on the client host. Databases, the agent directory, provider credentials, the tunnel, Tailscale Serve routes and the
call journal were preserved. No paid model call was made.

**Tested revision and date.** Everything below was verified against **exactly** `f603a48`
(`f603a4853345728e72d8418fd6c79df2c7bb03ba`) on **2026-10-13**, on the running hosts. No other revision was tested
in this range. Two checks in this range did **not** pass and are recorded as failures, not as green: the runtime
host's own verify script (9 passed, 1 failed) and `deploy:inspect --probe` (exit 3). See *Smoke test* and *Remaining
limits*.

Hosts are named by role (`build host`, `runtime host`, `client host`) and roots by placeholder
(`<runtime-root>`, `<client-root>`, `<client-home>`); the real mapping lives in the operator's git-ignored private
config (`deploy/deploy.local.env`, mode 0600). This record names roles, tags, digests, hashes and counts, never a
host name or address, a login account, a credential value, a credential-file path or a personal filesystem path.

The backend and the Web UI carry new runtime code and were genuinely rebuilt; the gateway and the runtime host's own
Web container were **not** touched. Nothing was built, installed or compiled on the runtime host.

## What changed between 0628888e5a85 and f603a48

| Area | Files | Runtime effect |
| --- | --- | --- |
| `apps/server/src/server.ts` | +108/−20 | **backend change** — one lifecycle payload on both transports (`projectionId`, `revision`, `run`, the outstanding submissions), the submission projection's `answerId`, and the run's own terminal fact |
| `packages/protocol/src/index.ts` | +8 | the shared `SubmissionProjection.answerId` / `SubmissionFacts.answer`; bundled into the backend image |
| `apps/web` | 29 files | **Web change** — `lib/lifecycle-projection.ts`, `lib/lifecycle-acquisition.ts`, `lib/completion-delivery.ts`, `lib/run-marks.ts`, the `useAgentSession` rewrite, the unread marker read from the run's own end |
| `packages/gateway`, `packages/client` | 0 | **no runtime change** — `git diff --name-only` is empty, so nothing new to run |
| `docs/adr/0007-lifecycle-facts-one-projection.md` | new | prose |
| `.scratch/chat-lifecycle`, `docs` | 33 + 7 | effort records and prose only |

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes (`apps/server`, `packages/protocol`) | rebuilt for `linux/arm64`, transferred as an image tarball, digest verified, container recreated |
| Web UI | client host | yes (`apps/web`) | rebuilt for `linux/amd64`, unit retagged on one line, container restarted |
| gateway | client host | no (`packages/gateway/src`, `packages/client/src` unchanged) | untouched: no rebuild, no install, no unit change, no restart |
| client bundle | client host | no | untouched, still `release-0628888e5a85` |
| oracle Web UI | runtime host | no | untouched, still `hepi-web:df24b7c`, same `StartedAt` |
| tunnel | client host | no | untouched, `NRestarts=0` |

## Artifact identity

| Role | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:f603a48` | `sha256:95cd7eca1535433094a1f5c41df869fea641c3497cf552ef53370a3505fab631`, linux/arm64, 216,247,302 bytes, 19 layers |
| Web UI | `hepi-web:f603a48` | `sha256:bca3331fd93f230dbc5f930bab94c10dd61682db78f922adad508a32b82d2ae6`, linux/amd64, 2.34 GB, `.next/BUILD_ID BSLGqAu7czgkd_JG-NrSa` |
| gateway bundle | `release-0628888e5a85` | unchanged — `packages/gateway` and `packages/client` did not move across the range |

Both images were built on the client host with `docker buildx` — the backend for the runtime host's architecture, the
Web UI for the client host's — then the backend was `docker save`-ed, gzipped, transferred over SSH and
`docker load`-ed. The digest read on the runtime host equals the build host's, and the architecture was read from the
**image**, never from a running container.

Source identity:

    git archive --format=tar.gz f603a48 -> hepi-f603a48.tar.gz   sha256 c3ea51d0b616b8e41f0bea257dbe4c6332e3ad31d11ac1f3d047dadc33fc22dc
    1,473 files in the archive; the release tree staged from it holds 1,476 files (the tracked tree plus
    deploy/compose.oracle.yaml, SOURCE_COMMIT and SHA256SUMS), of which 1,475 hash OK under `sha256sum -c`.

Backend image tarball:

    hepi-backend-f603a48.tar      sha256 17fc004ba4d1610ea9b55b624289ebf6ef6d0a6f6f9a33932b01a6c38d2665c9  216,275,456 bytes
    hepi-backend-f603a48.tar.gz   sha256 ee4dfa545fc34ec28d64123dfe444e9dd1ed161d06c3285fd618b5ca549133eb  215,167,858 bytes
    read back on the runtime host with the same sha256 before `docker load`

## Build gate (build host only)

Run in a clean extraction of the archive (`<build-tmp>/f603a48`), never on the runtime host:

| Step | Command | Exit | Log |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile` | 0 | `<build-tmp>/install.log` |
| typecheck | `pnpm -r typecheck` | 0 | `<build-tmp>/typecheck.log` |
| tests | `pnpm -r test` | 0 | `<build-tmp>/test.log` |
| gate | `pnpm run verify --profile=fast` | 0 (PASS/PASS) | `<build-tmp>/verify.log` |

Those four are green. They are the build gate only; they do not cover the two host-side failures recorded below.

Workspace counts at `f603a48`: client **9**, protocol **47**, session **3**, gateway **130**, server **232** (421
total, 0 fail, 0 skipped). `@hepi/protocol` gained 1 and `@hepi/server` gained 5 over `0628888e5a85`'s 46 and 227.
The Web unit suite is not part of the fast profile and was not re-run for this deployment.

The build host had **no arm64 `binfmt` registration**, so the arm64 `RUN` steps of the backend build failed with
`exec format error`. The documented prerequisite was applied **on the build host**
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`, docs/container-deployment.md) and the backend build
then succeeded. The runtime host was never asked to emulate or build anything.

## Artifact boot check (build host, throwaway)

The arm64 backend image was started once on the build host under a throwaway name on port `8799` with host networking
and a temporary state directory, then removed. Nothing on the runtime host was replaced by it.

| Check | Result |
| --- | --- |
| `process.version` / `process.arch` | `v24.21.0` / `arm64` |
| unauthenticated / authenticated `GET /api/models` | `401` / `200` |
| `node:sqlite` `DatabaseSync` | opened, created, inserted, read back `42` |
| `quickjs-wasi@3.6.2` `evalCode('6 * 7')` | `42` on arm64 (this version needs an explicit `wasm` option: `QuickJS.create({ wasm })`) |
| `apps/server/public/chat.js` in the image | present, 14,711 bytes |
| `.next/BUILD_ID` in the Web image | `BSLGqAu7czgkd_JG-NrSa` |
| `node-pty` in the Web image (native amd64) | spawned `/bin/sh`, read back `pty-ok` |

## Release directory (runtime host)

`<runtime-root>/releases/f603a48/` is the tracked tree of `f603a48` from `git archive`, assembled in
`releases/.staging-f603a48/`, checked there with `sha256sum -c` (1,475 OK, 0 not-OK), then promoted with a single
`mv` — a failure in verification would have left the running service untouched.

    SOURCE_COMMIT                f603a4853345728e72d8418fd6c79df2c7bb03ba
    SHA256SUMS                   1,475 files hashed, verified in staging
    deploy/compose.oracle.yaml   sha256 034e94bfef6724d15417da12f73dd5e6e64cec3016ad5055384b915d443600d3  (deployment-generated)
    bin/run-f603a48.sh           compose wrapper for this release (backend f603a48, Web df24b7c)
    bin/rollback-to-0628888e5a85.sh

`deploy/compose.oracle.yaml` is the `0628888e5a85` override repinned to `hepi-backend:f603a48`; host networking,
loopback-only binding, `env/backend.env` (mode 0600, unchanged), `user: 1001:1001`, both mounts (`state`, `agent`) and
the Web line at `hepi-web:df24b7c` are unchanged. `docker compose config` was resolved **before** the switch to
confirm the pinned image and the existing state paths (`HEPI_DB`, `HEPI_SKILL_REPOSITORY`, `PI_CODING_AGENT_DIR`);
no new named volume and no `:local` fallback.

## Database backups (online, writer never stopped)

Taken with SQLite's own backup API against read-only connections (`src.backup(dst)`), so the running backend was not
stopped for it. Every copy was read back, not merely written.

Runtime host, `<runtime-root>/backups/20261013T064500Z-online-f603a48/` (`SHA256SUMS` covers all three):

| File | sha256 | Verified |
| --- | --- | --- |
| `hepi.sqlite` | `47ea56d623da37bb9bce6737ac1c9a15608f6f4e45d4c5da707db12fae1a8cf0` | `integrity_check ok`; 12 conversations `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140, 3154]`, 1,541 entries, 3,164 record ids, 23 submissions, 1,505 tasks, 83 documents, 89 document revisions |
| `projects.sqlite` | `62d0e09ef4c8f25d3990288babffd2c1eb5b3de461c168e3ff51b3032c0f02b8` | `integrity_check ok`; 4 projects, 4 folders, 0 retained bindings |
| `skill-repository.sqlite` | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | `integrity_check ok`; 0 bundles, 0 bundle files |

Client host, `<client-root>/.local/share/hepi/backups/20261013T145000-online-f603a48/calls.sqlite` (directory mode
700, files 0600):

| File | sha256 | Verified |
| --- | --- | --- |
| `calls.sqlite` | `f643ac09311e5dfa501467b4ee83ff223e59f9495f4d78d60a23b70fc66bd764` | `integrity_check ok`; 783 `gateway_call` rows |

Both gates were satisfied before the first write: **backup-verified** (all four durable databases copied by this run
and read back) and **single-writer** (one process held `127.0.0.1:8787` and the state file — the backend container's
own `node src/main.ts`; the old `hepi-backend` systemd unit is `inactive`/disabled and no second process held the
file).

## Switch

Backend (runtime host) — genuinely recreated because the runtime changed:

    bin/run-f603a48.sh up -d --no-build backend
    hepi-oracle-backend-1  Recreate -> Recreated -> Started
    Image=hepi-backend:f603a48  ImageID=sha256:95cd7eca1535…  RestartCount=0  StartedAt=2026-10-13T06:45:34Z  healthy

Web UI (client host) — private backup first, `~/.config/hepi/deploy-backup-f603a48/` (mode 700):
`hepi-web.service.bak-0628888e5a85` and `web.env.bak` (mode 600). `hepi-web.service` changed on exactly one line, the
image tag `hepi-web:0628888e5a85` → `hepi-web:f603a48`; `HEPI_WEB_HOST`, `PORT=30141`, `--network host` and
`--env-file` are unchanged, and `web.env` is byte-identical to its backup. `systemctl --user daemon-reload &&
systemctl --user restart hepi-web.service` → active, `NRestarts=0`, `hepi-local-web` on `hepi-web:f603a48`
(`sha256:bca3331fd93f…`, `StartedAt=2026-10-13T06:46:12Z`), `.next/BUILD_ID BSLGqAu7czgkd_JG-NrSa` equal to the
built image. Env values were never printed.

**Not restarted:** `hepi-gateway.service` and `hepi-tunnel.service` (`packages/gateway` and `packages/client` are
byte-identical across the range), the oracle Web container (same image, same `StartedAt`, `RestartCount=0`),
Tailscale Serve (8443 → 30141, 8444 → 8787) and every unrelated container.

Because the gateway was not restarted, its in-memory workspace registry still held every root and no workspace had to
be re-registered: `GET /api/workspaces` answered all five bindings with their roots and no `hostError`.

## Smoke test (read-only)

`bin/verify-oracle.sh` on the runtime host: **9 passed, 1 failed**, exit 1 — **not all green**. The single failure is a stale assertion
in the script, not a regression: it expects conversation id `1` in `GET /api/conversations`, but `1` is the
runtime's own root record, which `96297fe` deliberately stopped projecting into the catalogue (the record is still in
the database and in the backup). The same script's other checks passed: unauthenticated `/api/models` `401`,
authenticated `200` naming `magpie / deepseek-v4.1-flash`, the Web UI serving `/`, its unauthenticated proxy call
`401`, login setting a cookie, the proxied `/api/models` `200`, `node:sqlite` and `node-pty` working on arm64
inside the containers, and only `127.0.0.1:8787` and `127.0.0.1:30141` listening.

Read-only checks against the deployed pair (backend through the client host's `127.0.0.1:18787` forward, Web through
the tailnet address). Everything in this table passed:

| Check | Result |
| --- | --- |
| unauthenticated `/api/models`, `/api/conversations` | `401`, `401` |
| authenticated `/api/models` | `200`, the configured catalog |
| catalogue continuity | 11 conversations `[8, 60, 77, 90, 159, 172, 197, 249, 655, 3140, 3154]`, identical to the pre-switch reading |
| `GET /api/conversations/8/state` | `200` — carries `projectionId`, `run` and the `submissions` array |
| `GET /api/conversations/8/submissions?requestId=<known>` | `200` — the terminal durable fact, `status=done`, `entryId=15`, **`answerId=35`** (the fact this release adds) |
| same route, unknown request id | `200` — `{"submission":null}` |
| same route, no `requestId` / unauthenticated | `400` / `401` |
| the same lookup through the Web adapter (`/api/agent/8/submissions`) | `200`, same payload |
| bounded `/api/conversations/8/events` read | a `snapshot` frame carrying `projectionId`, `run: null` and the settings |
| Web UI `/` on the tailnet address | `200`; `127.0.0.1:30141` refused (tailnet bind only) |
| Web unauthenticated API / wrong token / right token | `401` / `401` / `200` with a session cookie |
| Web catalogue (`GET /api/sessions`) | 11 sessions, same ids as the backend catalogue |
| oracle Web UI on `8443` / backend on `8444` | `200` / `401` unauthenticated |

Post-switch state re-read on the runtime host: all three databases `integrity_check ok`, every count identical to the
backup (12 conversations, 1,541 entries, 3,164 record ids, 23 submissions, 1,505 tasks, 4 projects, 4 folders,
0 retained bindings). The gateway call journal still holds **783** rows, so no paid call was made.

## Deployment-configured default workspace grouping: NOT REMOVED — inspected, then stopped

**Superseded on 2026-10-13 by [the workspace-removal record](f603a48-workspace-removal.md).** The operator then
authorized the removal: the six conversations bound to `integration` were deleted through the existing tombstone
route and the `HEPI_WORKSPACE_ID` line was dropped from the backend and gateway environments, so the deployment now
configures no workspace. Everything below is this record's point-in-time evidence for the state it was written in.

An additional constraint asked this deployment to remove the deployment-configured default workspace grouping, with
project/group metadata and folder-link records as the only removables, a projects.sqlite backup first, a formal
API/store route rather than a direct SQLite write, and historical bound sessions left executable.

**Inspection (read-only, before any write).** The group in question is the sidebar/catalogue group keyed
`/workspace/integration`, whose display root is `<client-root>/.local/share/hepi/workspace` and which holds
conversations `8, 60, 77, 90, 159, 3140`. Its source is the **deployment's own configured workspace**, not Project
metadata:

- `HEPI_WORKSPACE_ID=integration` in `<runtime-root>/env/backend.env`, and `HEPI_WORKSPACE_ID=integration` with
  `HEPI_WORKSPACE_ROOT=<client-root>/.local/share/hepi/workspace` in the client host's `gateway.env`.
- `GET /api/workspaces` lists `integration` with that root and **no** `retained` marker, beside the four project
  folders.
- `projects.sqlite` holds 4 projects, 4 folders and **0 retained bindings**; no project and no folder names the
  workspace id `integration` or the root `<client-root>/.local/share/hepi/workspace`:

| Project id | Name | Folder id | Folder workspace id | Root |
| --- | --- | --- | --- | --- |
| `b21ebf5a-8d3c-428b-973a-59dcb93e8c64` | `<project-1>` | `b452fc66-91fa-4749-9f7e-c892812868b0` | `eb9e65c0-5011-4ea1-89d9-86215969933a` | `<client-home>/Downloads` |
| `eaaf7231-5d3e-436f-928d-94567b2beacc` | `<project-2>` | `b55a0e7d-998c-4657-b7eb-677c0ab9b945` | `44d5cf16-1890-4aa2-bae0-c5fdf7664ee8` | `<client-home>/Documents/dev/hepi-harness` |
| `06bd7829-87a9-4fd4-844a-f0bc058c4620` | `<project-3>` | `f6a9f779-5e88-4d7b-abdb-c0a29a7ca3f8` | `8fcee670-f18b-4d32-8e4d-790fb93061b3` | `<client-home>/Documents/dev/hepi-mono` |
| `3abd307e-20aa-4dc2-ab75-9ae1aaa94636` | `<project-4>` | `5fc2dbbe-65f6-4982-8fd7-7de4b9862746` | `6db69324-7e58-42e8-84c2-f1c9e30d6145` | `<client-home>/Documents/dev/hepi-harness` |

Display names are replaced by `<project-N>` placeholders; the ids are the durable metadata this deployment inspected,
and the roots under `<client-home>` are the operator's own paths, shown here only as `<client-home>`-relative
placeholders.

**Conclusion: the grouping is a fallback (the deployment-configured workspace), not projects.sqlite Project
metadata.** There is no project id and no folder-link row to remove for it.

**Result: the group is still present. Nothing was removed, and no configured workspace, environment value or
binding was changed.** `HEPI_WORKSPACE_ID`, `HEPI_WORKSPACE_ROOT`, both environment files and `projects.sqlite`
are exactly as they were; the group `/workspace/integration` is still listed by `GET /api/workspaces` and still
renders in the sidebar, with all six conversations still bound to it.

**No mutation was applied, and the reason.** The prescribed removal — project and folder-link metadata through the
formal route — has no target here. The only supported writer of a retained binding is a Project or folder removal
(`ProjectStore.remove` / `removeFolder`), so no supported API can keep conversations `8, 60, 77, 90, 159, 3140`
executing once `HEPI_WORKSPACE_ID` stops being configured: resolution is configured → retained → project folders, and
dropping the configured workspace with no retained row leaves those six conversations without an execution
environment. Dropping it would not remove the group either, because the catalogue still keys those rows by the routing
path `/workspace/integration`. Creating a project for that root and removing it mints a **new** workspace id and
retains that, not `integration`. A direct SQLite write was not made. Stopped before the mutation under the
constraint's own ambiguity/unsafe clause; the four recorded projects, the physical directory
`<client-root>/.local/share/hepi/workspace` and every conversation record and binding are untouched.

**Decision needed.** Either (a) a later revision stops presenting a deployment-configured workspace as a group, or
(b) a supported store/route operation converts `integration` into a retained binding before the deployment stops
configuring it, or (c) the intended Project is named — none of the four recorded projects matches this group.

**Recommended path, not taken here.** This is a capability gap, not a deployment step: option (b) needs its own
approved task — a supported `ProjectStore`/route operation that writes a retained binding for a *configured*
workspace (`workspace_id`, `host_id`, `profile_id`, `root`, `retained_at`) before the deployment stops
configuring it, so the six bound conversations keep an execution environment while the group leaves the new-session
targets and the workspace picker. This deployment made no code change and no data change; nothing was migrated.

## Guide versions left current

- `docs/README.md` — current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` — Web image line and last-recorded section moved to `f603a48`.
- `docs/oracle-tailscale-deployment.md` — backend image table and last-recorded section moved to `f603a48`.
- `docs/deployment.md` — last-recorded-state pointer moved to this record.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    bash <runtime-root>/bin/rollback-to-0628888e5a85.sh

`hepi-backend:0628888e5a85` (`sha256:241c204097cc…`) is still on disk. This range adds no schema change — no migration
runs — so the previous image reads the same databases and no restore is required.

**Web UI (real).** `hepi-web:0628888e5a85` (`sha256:8b87a3eec934…`) is still on disk; restore the backed-up unit or
edit the one tag line back, then `systemctl --user daemon-reload && systemctl --user restart hepi-web.service`.

**Gateway (nothing to revert).** It was never part of this deployment.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate recovery
action, not part of reverting this deployment, and that path was not exercised here.

## Remaining limits

- The live model turn was not run: the catalog, auth, durable reads, the lifecycle payload and the submission seam are
  proven, generation is not. No paid call was made.
- The runtime host's own Web container stays on `hepi-web:df24b7c` by design (the Web UI is the local half's), so
  `8443` keeps serving the pre-lifecycle Web UI.
- `bin/verify-oracle.sh` **fails one check** (9 passed / 1 failed, exit 1). The failing assertion still expects
  conversation `1` in the catalogue; that expectation is stale since `96297fe`, which deliberately stopped projecting
  the runtime's own root record. The record is still in the database and in the backup. This is a **failure in the
  result, not a pass** — recorded, not fixed, in this deployment.
- `deploy:inspect --probe` **fails** with exit 3 before it reaches the image fields: it reads
  `<runtime-root>/SOURCE_COMMIT`, which has never existed at the deploy root (the marker lives in each
  `releases/<id>/`). Pre-existing, unchanged by this range, and also recorded as a failure rather than green.
- The Web unit suite's pre-existing failures were not re-measured here.
- The deployment-configured default workspace grouping was **not** removed; see the section above for the evidence and
  the decision it needs.
