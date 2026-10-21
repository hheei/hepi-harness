# Split-topology deployment of 78078de

Deploys the `ux-follow-up` integration tip `78078de`
(`78078de4f4d6d16f480c3cbf4b31e3d83014ac1b`) to the split test topology: the durable backend on the
runtime host and the Web UI on the client host. Databases, agent directory, provider credentials, tunnel and
Tailscale Serve routes were preserved. No paid model call was made. The gateway keeps `release-51492c4` and was
not restarted.

Unlike `39c168d`, **both halves carry new runtime code** in this range, so both were genuinely rebuilt, retagged
and restarted once. Neither was a retag.

## What changed between 39c168d and 78078de

| Area | Files | Runtime effect |
| --- | --- | --- |
| `apps/server` | 8 (`src/server.ts` +117/−20, tests) | **backend changes** — submission lifecycle and projection |
| `apps/web` | 24 | **Web changes** — reconciliation module, pending-set rules, i18n, TPS |
| `packages/protocol` | 2 (`src/index.ts` +47, new test) | shared projection type; bundled into the backend image |
| `packages/gateway` | 1 (`package.json`: adds a `dev` script) | **no runtime change** |
| `packages/client` | 1 (`README.md`) | **no runtime change** |
| `packages/session` | 0 | unchanged |
| `scripts`, `docs`, `deploy/.env.example` | 44 | tooling and prose only |

Backend runtime delta: `attachConversation` now consumes two durable streams (`conversation.watch()` for the
committed view, `watchEvents()` for the submission lifecycle) through one revision counter, seeds an outstanding
submission map from the committed table, publishes it on every state frame as `submissions`, and delivers a
settlement as its own `submission` frame. A new read-only route
`GET /api/conversations/:id/submissions?requestId=` answers the durable record or `null`. The Web adapter exposes
that same lookup at `GET /api/agent/:id/submissions?requestId=`.

`packages/gateway/src` is **byte-identical** across the range, and `packages/client/src` and
`packages/client/scripts` are unchanged, so the gateway has nothing new to run and its client bundle would be
byte-identical. It was left alone.

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes (`apps/server`, `packages/protocol`) | rebuilt for `linux/arm64`, transferred, container recreated |
| Web UI | client host | yes (`apps/web`) | rebuilt for `linux/amd64`, unit retagged, container restarted |
| gateway | client host | no (`packages/gateway/src` identical) | untouched, not restarted |
| client bundle | client host | no (`packages/client/src` identical) | untouched, still `release-51492c4` |
| oracle Web UI | runtime host | no | untouched, still `hepi-web:df24b7c` |

## Artifact identity

Built on the client host from a `git archive` of `78078de` (the gitlink `.agents/skills` is empty in the
archive by design, and the dirty skill link in the checkout is not part of the input).

| Half | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:78078de` | `sha256:cf79a29cbce05c9dcbe1734ff5599c214b384cdb9b8c486ffd0184a3a56621b6`, linux/arm64, 210,615,438 bytes |
| Web UI | `hepi-web:78078de` | `sha256:cf95dc319fb0d4e46ccec3f79e73cd6e13b7950703293c9cb86d092f579f222e`, linux/amd64, 405,991,840 bytes, `.next/BUILD_ID 3iFmBxghbQTBW_DoR8ZH2` |

`docker image inspect --format '{{.Id}} {{.Architecture}}'` reports those digests and architectures; the
architecture was read from the **image**, never from a running container.

Source identity:

    git archive 78078de → /tmp/hepi-78078de.tar      sha256 acf18b0e79cdeca4f6c0dee4dfca81df38a5f6dc0d3a79129e305e16884a8a81
    git archive --format=tar.gz 78078de → .tar.gz    sha256 543b0d86818ad66d991fd927f9bf969cd51915b80a2407dc16fc3721aafeed76

The transferred release tree was checked file by file against the local archive: with `node_modules` excluded on
both sides, the 1,308 archive files and their hashes are identical, and the staged tree's only extras are the
release's own `deploy/compose.oracle.yaml`, `SOURCE_COMMIT` and `SHA256SUMS`.

## Build gate (build host only)

Run in a clean extraction of the archive, never on the runtime host:

| Step | Command | Exit | Log |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile` | 0 | `/tmp/gate-78078de-install.log` |
| typecheck | `pnpm -r typecheck` | 0 | `/tmp/gate-78078de-typecheck.log` |
| tests | `pnpm -r test` | 0 | `/tmp/gate-78078de-test.log` |
| gate | `pnpm verify --profile=fast` | 0 (PASS/PASS) | `/tmp/gate-78078de-verify.log` |

Workspace counts at `78078de`: protocol **19**, client **9**, session **3**, gateway **80**, server **148**
(179 total, 0 fail). `@hepi/protocol` gained 4 and `@hepi/server` gained 10 tests over `edef2c0`'s
15 and 138. The Web unit suite is not part of the fast profile and was not re-run for this deployment.

## Artifact boot check (build host, throwaway)

The arm64 image was started once on the build host under a throwaway name with a temporary database, then removed.
It answered `401` unauthenticated and `200` authenticated on `/api/models` and `/api/conversations`, and
`node:sqlite` opened and wrote a database under emulation. This proves the artifact boots; it is not the
production start.

## Release directory and scripts (runtime host)

    /home/<runtime-user>/hepi-harness-deploy/releases/78078de/
        SOURCE_COMMIT              78078de4f4d6d16f480c3cbf4b31e3d83014ac1b
        SHA256SUMS                 1,311 entries
        deploy/compose.oracle.yaml sha256 d9b9f5de7dbca2dec6a41db9db1012b52ac96c67505f204d9c453c2626fcea1d

Assembled in `releases/.staging-78078de/`, verified there, then promoted with a single `mv` — nothing was renamed
or retagged before the promotion, so a failure in verification would have left the running service untouched.

    bin/run-78078de.sh            compose wrapper for this release (backend 78078de, web df24b7c)
    bin/rollback-to-39c168d.sh    stop this backend, start the previous 39c168d backend

`releases/78078de/deploy/compose.oracle.yaml` is the `39c168d` override repinned to `hepi-backend:78078de`;
it keeps host networking, loopback-only binding, `env/backend.env` (mode 600, unchanged), `user: 1001:1001`,
both mounts (`state`, `agent`) and the Web line at `hepi-web:df24b7c`. `docker compose config` was resolved
before the switch to confirm the pinned image and that the state paths are the existing ones
(`HEPI_DB`, `HEPI_SKILL_REPOSITORY`, `PI_CODING_AGENT_DIR`); no new named volume and no `:local` fallback.

## Database backups (online, writer never stopped)

Taken with SQLite's own backup API against read-only connections, so the running backend was not stopped for it.

Runtime host, `backups/20261011T172056-online-78078de/` (`SHA256SUMS` covers all three):

| File | sha256 | Result |
| --- | --- | --- |
| `hepi.sqlite` | `1eba7e7fbf2959899413b02dd01850c230ec38e09aee53ce7bb736f8975e0902` | integrity ok; 11 conversations `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]`, 1,536 entries, 21 submissions, 3,146 record ids |
| `projects.sqlite` | `04e3fc5167585b0487406b0fd44bfb733a69d2cc5ca634d6803dd7d9fa460b99` | integrity ok; 4 projects, 4 folders |
| `skill-repository.sqlite` | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | integrity ok; 0 bundles |

Client host, `~/.local/share/hepi/backups/20261011T162102-online-78078de/calls.sqlite` (mode 700 directory,
0600 file):

| File | sha256 | Result |
| --- | --- | --- |
| `calls.sqlite` | `2aeb482a276bb2bc3104773cc88673970544934b912c8ef906cc05d81ac14bc8` | integrity ok; 783 `gateway_call` rows |

Every backup was read back, not merely copied. Both gates were satisfied before the first write: **backup-verified**
(all four durable databases copied by this run and verified) and **single-writer** (one process per state file; the
predecessor container was stopped by the compose recreate and no second process held the file; the old
`hepi-backend` systemd unit is `not-found`/`inactive`).

## Switch

Backend (runtime host) — the container was genuinely recreated because the runtime changed:

    bin/run-78078de.sh up -d --no-build backend
    hepi-oracle-backend-1  Recreate → Recreated → Started
    Image=hepi-backend:78078de  ImageID=sha256:cf79a29cbce0…  RestartCount=0  StartedAt=2026-10-11T08:24:39Z

Web (client host) — private backup first, `~/.config/hepi/deploy-backup-78078de/` (mode 700):
`hepi-web.service.bak-b324edb` and `web.env.bak` (mode 600). `hepi-web.service` changed on exactly one line,
the image tag `hepi-web:b324edb` → `hepi-web:78078de`; `HEPI_WEB_HOST`, `PORT=30141`, `--network host`,
`--env-file` and every env key are unchanged. `systemctl --user daemon-reload && systemctl --user restart
hepi-web.service` → active, `RestartCount=0`, `hepi-local-web` on `hepi-web:78078de`. Env values were never
printed.

Artifact assertions on the Web half:

| Assertion | Result |
| --- | --- |
| `lib/submission-reconciliation.ts` inside image vs the `78078de` blob | identical (`77241b64…`) |
| `hooks/useAgentSession.ts` inside image vs the `78078de` blob | identical (`3adf0f14…`) |
| `adapters/durable-api.ts` inside image vs the `78078de` blob | identical (`efb7fed6…`) |
| `.next/BUILD_ID` of the running container vs the built image | `3iFmBxghbQTBW_DoR8ZH2` == `3iFmBxghbQTBW_DoR8ZH2` |

**Not restarted:** `hepi-gateway.service` and `hepi-tunnel.service` (gateway `ExecMainStartTimestamp` still
`00:17:32`), the oracle Web container (still `hepi-web:df24b7c`, started `2026-10-10T23:04:59Z`,
`RestartCount=0`), Tailscale Serve (8443 → 30141, 8444 → 8787) and every unrelated container.

## Smoke test (read-only)

`bin/verify-oracle.sh` on the runtime host: **10 passed, 0 failed**, exit 0 (`/tmp/verify-oracle-78078de.log`).
Unauthenticated `/api/models` `401`, authenticated `200` naming `magpie / deepseek-v4.1-flash`, conversation
continuity `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]`, Web `/` `200` and its unauthenticated proxy call
`401`, Web login cookie `200` through the proxy, `node:sqlite` and `node-pty` working on arm64 inside the
containers, and only `127.0.0.1:8787` and `127.0.0.1:30141` listening.

Backend submission seam, read-only, with a request id taken from the backup (no write, no model turn):

| Request | Answer |
| --- | --- |
| `GET /api/conversations/3140/submissions?requestId=bff4895…` | `200` — the terminal durable fact, `status=done`, `entryId=3148` |
| same route, unknown request id | `200` — `{"submission":null}`, a statement about that request, not a failure |
| same route, no `requestId` | `400` |
| same route, unauthenticated | `401` |
| `GET /api/conversations/3140/state` | `200` — carries the `submissions` array (0 outstanding) |
| `GET /api/conversations/:id/events` (bounded read) | `snapshot` frame delivered |

Live read-only browser pass (`/tmp/live-78078de-browser.mjs`, `/tmp/live-78078de-browser.log`): **22 ok,
0 FAIL**, exit 0. Unauthenticated `/api/models` `401`; browser login with the existing secret accepted; `200` on
`/api/models`, `/api/models-config`, `/api/projects`, `/api/hosts`, `/api/cwd/browse`,
`/api/skill-market/inventory?workspaceId=integration`, `/api/sessions`, `/api/home`; the catalogue returns 11
sessions with `messageCount` and `firstMessage` on every row, a numeric `sessionListVersion`, and
`projectDisplayRoot` on rows, none leaking a `/workspace/<uuid>` routing path; opening conversation `8` keeps
`?session=8` in the URL and renders no routing path in the DOM; the session state seam answers; the submission
lookup through the **Web adapter** returns the terminal fact and `null` for an unknown id; no page errors; reload
keeps the session. No model message was sent — this is a live route/read check, not a model turn.

Post-switch state re-read on the runtime host: all three databases `integrity_check ok`, counts unchanged from the
backup (11 conversations, 1,536 entries, 21 submissions, 4 projects, 4 folders). The gateway call journal still
holds **783** rows, so no paid call was made during the deployment.

The unauthenticated probes were run against the tailnet address; the `501` from a raw `/api/conversations/…/state`
through the Web origin is the Web tier's deliberate refusal of backend-raw paths — the Web seam is
`/api/sessions/:id/state` and `/api/agent/:id/submissions`, both of which answer.

## Guide versions left current

- `docs/README.md` — current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` — Web image line and upgrade section moved to `78078de`.
- `docs/oracle-tailscale-deployment.md` — backend image table and last-recorded section moved to `78078de`.
- `docs/verification.md` — workspace counts and the gate row re-measured at `78078de`.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    ssh <runtime-host>
    bash /home/<runtime-user>/hepi-harness-deploy/bin/rollback-to-39c168d.sh

`hepi-backend:39c168d` (`sha256:3a2dbec16ec2…`) is still on disk. The schema written by `78078de` is the same
durable schema `39c168d` reads — no migration ran in this deployment — so no database restore is required.

**Web (real).** `hepi-web:b324edb` is still on disk; revert the one line by restoring the backed-up unit:

    cp ~/.config/hepi/deploy-backup-78078de/hepi-web.service.bak-b324edb ~/.config/systemd/user/hepi-web.service
    systemctl --user daemon-reload && systemctl --user restart hepi-web.service

The env file is untouched, so no key needs reverting. The gateway and the oracle Web container were never part of
this deployment, so neither needs a change to revert it.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate
recovery action, not part of reverting this deployment, and the restore path was not exercised here.
