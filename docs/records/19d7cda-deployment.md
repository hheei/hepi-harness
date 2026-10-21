# Split-topology deployment of 19d7cda

Deploys the `ux-follow-up` tip **`19d7cda`** (`19d7cdac975159a262085d45102f5765a86639a1`) to the split test
topology: the durable backend on the runtime host, the Web UI and the execution gateway on the client host.
Databases, agent directory, provider credentials, the tunnel, Tailscale Serve routes and the runtime host's own Web
container were preserved. No paid model call was made.

`19d7cda` is `417ab0c` plus one deployment fix, and the fix is why the artifact id is not `417ab0c`:

> **`417ab0c` cannot build the Web image.** `apps/web` gained a dependency on `@hepi/protocol`
> (`workspace:*`) in this range, and `deploy/docker/web.Dockerfile` copied only the workspace *manifests*, so
> pnpm linked the package by name to a directory with no sources and `pnpm --filter @hepi/web build` stopped with
> `Module not found: Can't resolve '@hepi/protocol'`. `backend.Dockerfile` already copied `packages/` for the
> same reason. `19d7cda` adds that copy to both stages of the Web Dockerfile and nothing else
> (`deploy/` is in `.dockerignore`, so the build context — and therefore the backend image — is unchanged).

Unlike `39c168d`/`78078de`, **all three roles carry new runtime code** in this range, so the backend, the Web UI
and the client bundle were all genuinely rebuilt and restarted once. None was a retag.

## What changed between 78078de and 19d7cda

| Area | Files | Runtime effect |
| --- | --- | --- |
| `apps/server` | 22 (9 in `src/`, +1,642/−45) | **backend changes** — session search, auto-name, tombstones, sidebar state, retained bindings, project unlink, terminal relay, extension selection, MCP-free |
| `apps/web` | 125 (+12,125/−4,277) | **Web changes** — session delete/search/auto-name, worktree picker, terminal tabs, project removal, extensions panel, MCP settings, i18n |
| `packages/gateway` | 18 (9 in `src/`, +3,023/−22) | **gateway changes** — worktrees, terminal sessions, `POST /v1/mcp`, remote path resolution |
| `packages/client` | 5 (`src/gateway.ts` +12/−2) | **client changes** — the bundle the gateway runs |
| `packages/protocol` | 3 (+1,073) | shared sidebar-state and projection types, bundled into both images |
| `packages/session` | 0 | unchanged |
| `docs`, `scripts` | 18 (+963/−60) | prose and tooling |
| `deploy` | 2 (+9) | the Web Dockerfile fix and the MCP variables in `compose.yaml` |

Whole range: 218 files, +26,021/−3,566.

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes | rebuilt for `linux/arm64`, transferred as a tarball, digest verified, container recreated |
| Web UI | client host | yes | rebuilt for `linux/amd64`, unit retagged on one line, container restarted |
| gateway | client host | yes (`packages/gateway/src`, `packages/client/src`) | new client bundle installed, unit retagged, service restarted |
| oracle Web UI | runtime host | no (same image `hepi-web:df24b7c`) | container recreated by compose only, because the compose project's config-file path moved to the new release directory |
| tunnel | client host | no | untouched, not restarted |

## Artifact identity

Built on the client host from a `git archive` of `19d7cda` (the gitlink `.agents/skills` is empty in the
archive by design; the checkout's dirty skill link is not part of the input).

| Role | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:19d7cda` | `sha256:6d8fce1201bbeca7ff21dab75d02852823ef4a5b691bc46abafd44d812d3f26c`, linux/arm64, 210,863,664 bytes |
| Web UI | `hepi-web:19d7cda` | `sha256:bb0860a7960436a638006c86d2f32d547080a5b78a25e926e999ba912d972a7a`, linux/amd64, 407,367,718 bytes, `.next/BUILD_ID 1xjBgutMponqN3gB6pXKG` |
| client bundle | `release-19d7cda` | `@hepi/client` 0.1.0 packed from `19d7cda`; `dist/cli.js` `sha256:169c7e5b46a07a31c082f1d92b7606b1761596f92b167cdf1b388942b95812d4` |

The client bundle is **not** the bundle `release-51492c4` holds: that one's `cli.js` is
`sha256:f28f890b634dee4ccd5700c90c4084d313286e65ac2547a2a27f3dcfb68a9342`. The gateway genuinely changed.

Source identity:

    git archive --format=tar.gz 19d7cda → hepi-19d7cda.tar.gz   sha256 7b776cc0a8bca586bf9084707c8d26eb7fd1178517f170e4c0aa36315bc06763
    assembled release tarball                                    sha256 a3d0ebb30a2bfccc16e404af2ddb4e31ca76b9d191f96d141a84cabbb28f513a

## Build gate (build host only)

`417ab0c` had already passed `pnpm verify --profile=fast` before this deployment; the only change since is
`deploy/docker/web.Dockerfile`, which no test covers, so the gate was re-run at `19d7cda`:

| Step | Command | Exit |
| --- | --- | --- |
| gate | `pnpm verify --profile=fast` | 0 (typecheck PASS, tests PASS) |
| docs | `pnpm check:docs` | 0 (131 Markdown files, 0 broken relative links) |
| entrypoints | `pnpm check:entrypoints` | 0 (59 present, 2 pre-existing known-missing) |
| tickets | `check-tickets.mjs` | 0 (0 blocker problems) |

Workspace counts at `19d7cda`: protocol **46**, client **9**, session **3**, gateway **111**, server **218** —
387 total, 0 fail. Nothing here ran on the runtime host.

## Artifact checks before the switch

| Check | Result |
| --- | --- |
| `docker image inspect` on the build host | backend `6d8fce12…` arm64, Web `bb0860a7…` amd64 |
| digest on the runtime host after the transfer | `sha256:6d8fce1201bbeca7ff21dab75d02852823ef4a5b691bc46abafd44d812d3f26c arm64` — equal to the build host's |
| arm64 identity in the backend image | `v24.21.0 arm64` |
| `node:sqlite` `DatabaseSync` in the backend image (arm64, emulated on the build host) | opens, creates, inserts, reads back |
| `quickjs-wasi` `6 * 7` in the backend image (arm64) | `42` |
| `node-pty` in the Web image (native amd64) | spawns `/bin/sh`, `pty-ok` read back |
| `apps/server/public/chat.js` in the backend image | present, 14,711 bytes |
| Web image sentinel start on the build host, throwaway name, ephemeral port | `/` `200`, `/api/models` `401`; removed afterwards |

`node-pty` is a dependency of `apps/web`, not `apps/server`, so it is absent from the backend image by design;
its arm64 prebuild was exercised by the earlier releases and is unchanged here.

## Release directory (runtime host)

    <runtime-root>/releases/19d7cda/
        SOURCE_COMMIT               19d7cdac975159a262085d45102f5765a86639a1
        SHA256SUMS                  1,412 entries, verified in place with sha256sum -c
        deploy/compose.oracle.yaml  sha256 ef06e2486c6a82b5faa6d119624f905db5ec4067568805a566b3366350b52ae5

Assembled and verified in `releases/.staging-19d7cda/` and promoted with a single `mv`, so a failure in
verification would have left the running service untouched.

    bin/run-19d7cda.sh    compose wrapper for this release (backend 19d7cda, Web df24b7c)

The override is the `78078de` override repinned to `hepi-backend:19d7cda`; host networking, loopback-only
binding, `env/backend.env` (mode 600, unchanged), `user: 1001:1001`, both mounts (`state`, `agent`) and the
Web line at `hepi-web:df24b7c` are unchanged. No new named volume and no `:local` fallback.

## Database backups (online, writer never stopped)

Taken with SQLite's own `VACUUM INTO` against the running writer, so no process was stopped for it. Runtime host,
`backups/20261012T023759-online-19d7cda/` (`SHA256SUMS` covers all three):

| File | sha256 | Result |
| --- | --- | --- |
| `hepi.sqlite` | `11d880f40d969d7573b2f24e96cacadf3a994b9405b3a1ac525cbf706ef39588` | integrity ok; 11 conversations `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]`, 1,536 entries, 3,146 record ids, 21 submissions, 75 documents, 81 document revisions, 1,503 tasks |
| `projects.sqlite` | `895bbdc0648b4389fbbfb461fe91983afd7b9c3c1114df5b93924609f5cbed9c` | integrity ok; 4 projects, 4 folders |
| `skill-repository.sqlite` | `290e9048b08b93a7bbc30965890beb6f24c6050ae879cd6151ef987718b0088d` | integrity ok; 0 bundles, 0 files |

Client host, `~/.local/share/hepi/backups/20261012T023759-online-19d7cda/` (mode 700 directory, 0600 files):

| File | sha256 | Result |
| --- | --- | --- |
| `calls.sqlite` | `e33d8f969bc8a5c5ba7964634f67f1a10a1a6c0fa2f2693d7cb5434e31754e0a` | integrity ok; 783 `gateway_call` rows |
| `config/` | — | private copies of the three user units and both env files, mode 600 |

Every backup was read back, not merely copied. Both gates were satisfied before the first write: **backup-verified**
(all four durable databases copied by this run and verified) and **single-writer** (the compose recreate stopped the
predecessor container; `127.0.0.1:8787` had exactly one listener and exactly one container runs
`hepi-backend:19d7cda`).

## Switch

Gateway (client host) — the runtime changed, so the bundle was genuinely replaced:

    ~/.local/share/hepi/client/release-19d7cda/   npm-tarball install, dist/cli.js 169c7e5b…
    hepi-gateway.service  ExecStart … release-51492c4 … → … release-19d7cda …
    systemctl --user daemon-reload && systemctl --user restart hepi-gateway.service
    listening on 127.0.0.1:28788, gatewayId workstation, workspaceId integration

Web UI (client host) — `hepi-web.service` changed on exactly one line, the image tag
`hepi-web:78078de` → `hepi-web:19d7cda`; `HEPI_WEB_HOST`, `PORT=30141`, `--network host` and
`--env-file` are unchanged. `~/.config/hepi/web.env` (mode 600) gained the two MCP variables this range needs:

    HEPI_WEB_GATEWAY_URL=http://127.0.0.1:28788
    HEPI_WEB_GATEWAY_TOKEN=<the existing gateway token, copied from ~/.config/hepi/gateway.env, never printed>

The gateway token is the pre-existing independent secret; it was not rotated, and the copy was checked by comparing
the two files' values without printing either. The Web container runs on the host network, so `127.0.0.1` inside it
is the client host's own loopback — the gateway the Web origin must reach is its own host's.

Backend (runtime host) — genuinely recreated because the runtime changed:

    bin/run-19d7cda.sh up -d --no-build
    hepi-oracle-backend-1  Recreate → Recreated → Started
    Image=hepi-backend:19d7cda  ImageID=sha256:6d8fce1201bb…  RestartCount=0  StartedAt=2026-10-12T02:45:38Z

The runtime host's own Web container was **recreated by the same compose run at the same image**
(`hepi-web:df24b7c`, `RestartCount=0`, `StartedAt=2026-10-12T02:45:38Z`): compose keys a service on the
project's config-file set, and that path moved from `releases/78078de/` to `releases/19d7cda/`. No image changed
for it, so this is a container recreate, not a deployment of the Web role.

**Not restarted:** `hepi-tunnel.service`, Tailscale Serve (8443 → 30141, 8444 → 8787) and every unrelated
container.

## Schema

The new backend migrates `projects.sqlite` in place on first open, adding the `retained_bindings` table
(0 rows after the migration). Nothing is rewritten: `projects` (4) and `project_folders` (4) are unchanged, and
`hepi.sqlite` and `skill-repository.sqlite` carry no schema change at all. Because the change is additive, the
previous image reads the same file, so an image rollback needs no database restore.

## Smoke test (read-only)

| Check | Result |
| --- | --- |
| `/api/models` on the runtime host, unauthenticated / authenticated | `401` / `200` |
| catalog | `magpie / deepseek-v4.1-flash` |
| conversation continuity | `1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140` — the same eleven as the backup |
| live state databases | `integrity_check ok` on all three; counts identical to the backup |
| conversation event stream, direct and through the Web origin | `snapshot` / `durable_state` frames delivered |
| Web UI `/` | `200`; unauthenticated `/api/models` through it `401` |
| Web login | wrong token `401`, right token `200`, session cookie set |
| MCP surface through the Web origin | `{"mcp":{"available":true}}` with the host's own `mcp.json` read — the new `HEPI_WEB_GATEWAY_URL`/`_TOKEN` wiring answers |
| project trust | `200`, decision read from the host's own store |
| extensions, models config, sidebar UI state, session catalogue | `200` |
| worktrees for the configured workspace | `not_supported` — "this host cannot serve worktree operations" (the persistent workspace is not a git checkout) |
| gateway call journal | still 783 rows: no paid call was made |

Live read-only browser pass (headless Chromium against the tailnet Web origin, private evidence under
`.dev/deploy-19d7cda/evidence/`): the app shell renders with **no page errors**, the sidebar lists the four
Projects and the two workspace groups, and the only failing requests are the documented limits —
`501 /api/app-update`, `501 /api/worktrees` (not a git checkout) and `502 /api/git/status`, which the gateway
answers for the same reason (`fatal: not a git repository` for the workspace root). No model message was sent.

## Observed state of the historical unbound conversation and the sidebar groups

Read-only, after the switch, through the backend and the Web origin:

- **Conversation `1` is unbound**, not synthetic: `workspaceId: null`, `gatewayId: null`,
  `cwd: /durable`, `workspaceBound: false`, 0 messages. It is the pre-Project conversation from the first
  cutover. `/durable` is the Web tier's synthetic *label* for "no execution workspace", not a path on any host,
  which is why the sidebar shows it as a group of its own. Its archive and its project-removal actions have no host
  to act on, because there is no workspace and no gateway recorded for it.
- **The `durable` and `workspace` sidebar entries are workspace groups, not Projects.** `workspace` is the
  configured `integration` workspace; `durable` is the unbound group above. The four real Projects — `hey`,
  `hepi-harness`, `Hepi Mono`, `Hepi Harness` — are listed separately, each with one folder.
- **Before this switch the same read answered `hostError: "unknown workspace"` on all four Projects** (the
  `78078de` backend resolved a Project through its folder's workspace registration); after it, the same request
  answers each Project with a `host` block (`user`, `home`) and no `hostError`, because this range resolves
  a Project through its recorded host instead. No project, folder, workspace or conversation record was created,
  changed or deleted by this deployment — the durable rows are the ones the backup holds.

That is evidence about the records and the API answers, not a claim about every control in the browser: whether the
removal and archive controls are offered for each row is the UI's own decision and is owned by the follow-up work.

## Guide versions left current

- `docs/README.md` — current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` — Web image line, gateway release line, the two new Web variables and a
  new upgrade section.
- `docs/oracle-tailscale-deployment.md` — backend image table and last-recorded section moved to `19d7cda`,
  with the Web container's recreate recorded.
- `docs/mcp-on-the-web-host.md` — records that this deployment sets both variables, so the surface is served.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    bash <runtime-root>/bin/run-78078de.sh up -d --no-build

`hepi-backend:78078de` (`sha256:cf79a29cbce0…`) is still on disk. The schema this release writes is additive
only, so `78078de` reads the same databases and no restore is required.

**Web UI (real).** `hepi-web:78078de` (`sha256:cf95dc319fb0…`) is still on disk; restore the backed-up unit
(`config/hepi-web.service` in the backup directory above) or edit the one tag line back, then
`systemctl --user daemon-reload && systemctl --user restart hepi-web.service`.

**Gateway (real).** `release-51492c4` is still installed; point `hepi-gateway.service`'s `ExecStart` back at it
and restart. The MCP surface then answers its named limit again, because the old gateway serves no MCP capability,
which is a limit and not an error.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate
recovery action, not part of reverting this deployment, and that path was not exercised here.
