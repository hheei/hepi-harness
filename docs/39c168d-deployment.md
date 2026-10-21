# Split-topology deployment of 39c168d

Deploys the merged `ux-follow-up` integration tip `39c168d`
(`39c168d06664dca567730a254edfebdbc45e9946`) to the split test topology: the durable backend on `remote-host`
and the Web UI on `workstation`. Databases, agent directory, provider credentials, tunnel and Tailscale Serve routes
were preserved. No paid model call was made. The gateway keeps `release-51492c4` and was not restarted.

The two halves were treated differently, because the code differed. The **backend adds nothing** over the running
`edef2c0`, so its verified image was retagged and its container was left alone. The **Web half changed** (the
navigation guard), so it was genuinely rebuilt, retagged in the unit and restarted once. See *Backend kept running*
and *Web half rebuilt and restarted*.

## What changed between edef2c0 and 39c168d

Nothing executable on the backend or gateway side. The non-Markdown trees of `apps/server` and `packages` are
byte-identical across the range:

    diff <(find apps/server packages -type f ! -name '*.md') → identical file lists, identical content
    aggregate sha256 of backend/gateway non-md files: a1d5672d43e141cbe00244c6b640f4dd5c253fbc76741fb17da3bf68f24aa55c  (both)

The only files differing under those two trees are two READMEs:

| File | Nature |
| --- | --- |
| `apps/server/vendor/cc-switch/README.md` | provenance/attribution prose, never executed |
| `packages/client/README.md` | documentation prose, not part of the backend image |

`pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root `package.json`, `deploy/compose.yaml` and
`deploy/docker/backend.Dockerfile` are byte-identical, so a backend rebuild would have produced the same image
from the same inputs. The **Web half does change**: `apps/web/components/AppShell.tsx` (+9, the
identity-hydration navigation guard), `apps/web/e2e/ux-nav-flicker.mjs` (new driver) and
`apps/web/package.json` (`test:nav-flicker`). The rest of the range is documentation (per-host guides,
verification records, ADR cross-references).

## Artifact identity

| Half | Artifact | Identity |
| --- | --- | --- |
| oracle backend | `hepi-backend:39c168d` = `hepi-backend:edef2c0` | `sha256:3a2dbec16ec294b72f5ff2e7bee580c5b0532455a00568baf759cc13c39de4c1`, linux/arm64 |
| workstation web | `hepi-web:39c168d` (amd64) | `sha256:2065995356b5d7fd860e59d748879e9a10c1aa21527aa266de772273897107ec`, `.next/BUILD_ID j0uuxLKDAbisf4kxODSZI` |
| workstation gateway | installed client `release-51492c4` **unchanged** | not restarted; `packages/` did not move |

The backend tag `39c168d` is the **same image ID** as `edef2c0`: `docker tag hepi-backend:edef2c0
hepi-backend:39c168d` adds a name for the source revision that was deployed, with no rebuild and no new layer. The
running container's image ID still resolves to `sha256:3a2dbec16ec2…`, which is what the `edef2c0` build
produced; the artifact is one object under two tags.

Runtime identity was confirmed file by file, not by tag: the 87 runtime files inside the running image
(`apps/server/src`, `packages/{gateway,protocol,session}`, manifests, lockfile) hash-match the local `39c168d`
checkout, and the only in-image extras are the generated `apps/server/public/chat.js` and the two READMEs above.

## Backend kept running

The oracle backend container was left running and untouched. Both candidates would have been harmless, but
recreating a healthy single-writer SQLite service for zero runtime delta carries avoidable risk, so Compose was not
invoked for it:

    hepi-oracle-backend-1  Image=hepi-backend:edef2c0  ImageID=sha256:3a2dbec16ec2…
                           RestartCount=0  StartedAt=2026-10-10T23:04:59Z  Health=healthy  (unchanged before/after)

No `docker kill`, no `docker stop`, no compose recreate on this half. The graceful-update path stays available
(`bin/run-39c168d.sh up -d` recreates only the backend service if a future runtime change needs it); it was simply
not needed here.

## Web half rebuilt and restarted

The workstation Web image was **not** reused: `hepi-web:39c168d` was built from a clean archive of `39c168d`
(`deploy/docker/web.Dockerfile`, exit 0, log `/tmp/hepi-build-39c168d.log`), and the served bundle differs from
`hepi-web:edef2c0` (the guard is present in the new one and absent in the old). The change was a real swap, not a
tag rename:

- Private backup first, `~/.config/hepi/deploy-backup-39c168d/` (mode 700): `hepi-web.service.bak-edef2c0` and
  `web.env.bak-edef2c0` (mode 600). Env values were never printed.
- `~/.config/systemd/user/hepi-web.service` changed on exactly one line, the image tag
  `hepi-web:edef2c0` → `hepi-web:39c168d`; `HEPI_WEB_HOST`, `PORT=30141`, `--network host`,
  `--env-file` and every env key are unchanged.
- `systemctl --user daemon-reload && systemctl --user restart hepi-web.service` → active,
  `NRestarts=0`, container `hepi-local-web` on `hepi-web:39c168d`.
- `hepi-gateway.service` and `hepi-tunnel.service` were **not** restarted (gateway
  `ExecMainStartTimestamp` still 00:17:32).

Artifact assertions on the Web half:

| Assertion | Result |
| --- | --- |
| `AppShell.tsx` inside image vs the `39c168d` blob | identical |
| guard comment `identity hydration, not a workspace switch` in image source | 1 hit |
| `e2e/ux-nav-flicker.mjs` in image | present |
| `.next` js-tree digest, `edef2c0` image vs `39c168d` image | `3d1ec920…` vs `ab4be834…` (differs) |
| running container `.next` digest vs the built image | `ab4be834…` == `ab4be834…` |

## Source, release directory and scripts

    git archive 39c168d → hepi-39c168d.tar, sha256 6c13de70cfc9fb20a3334180263405cb9ea37e147b331da314b1f9a28884f1bd
    /home/<runtime-user>/hepi-harness-deploy/releases/39c168d/
        SOURCE_COMMIT          39c168d
        SOURCE_ARCHIVE.sha256  6c13de70cfc9fb20a3334180263405cb9ea37e147b331da314b1f9a28884f1bd
        deploy/compose.oracle.yaml  sha256 8ed5eb241a799c563fc35b6347ea7f1331c7639b22c84a1ea71764af44d03044

`releases/39c168d/deploy/compose.oracle.yaml` is the `edef2c0` override repinned to `hepi-backend:39c168d`;
it keeps host networking, loopback-only binding, `env/backend.env` (mode 600, unchanged), `user: 1001:1001`, and
both mounts (`state`, `agent`). The Web service line still names `hepi-web:df24b7c` because oracle's Web container
is not part of this deployment.

    bin/run-39c168d.sh          compose wrapper for this release (backend 39c168d, web df24b7c)
    bin/rollback-to-edef2c0.sh  stop this stack, start the previous edef2c0 stack (same state and agent dirs)

## Database backup (online, writer never stopped)

`backups/20261011T103310-online-39c168d/`, taken with SQLite's own backup API against read-only connections at
`2026-10-11T10:33:10+09:00`, so the running backend was not stopped for it:

| File | sha256 | Result |
| --- | --- | --- |
| `hepi.sqlite` | `205a42955c8271e61bfcf1be5aa96457a96cc2701ddde8f1e182694a8c6dfc06` | integrity ok; conversations `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655]`, 1533 entries, 3133 record ids |
| `projects.sqlite` | `04e3fc5167585b0487406b0fd44bfb733a69d2cc5ca634d6803dd7d9fa460b99` | integrity ok; 4 projects, 4 folders |
| `skill-repository.sqlite` | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | integrity ok; 0 bundles |
| `state-dir.tar.gz` | `b7c2975f104a26ab1024aa121664ac57f3c16d60f1f3f6585c6ba474fdab17aa` | whole state directory |

`SHA256SUMS` covers all four. The projects file is **not** empty: 4 registered projects
(`Hepi Mono`, `Hepi Harness`, `hey`, `hepi-harness`) and 4 folders existed at this timestamp.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Oracle health/continuity | `bin/verify-oracle.sh` | **10 passed, 0 failed**, exit 0 (`/tmp/oracle-verify-39c168d.log`) |
| Backend container | `docker inspect hepi-oracle-backend-1` | healthy, RestartCount=0, StartedAt unchanged |
| Web half, pre/post probe | `node /tmp/hepi-ux-deployment-browser-check.mjs` | **exit 0**, identical before and after (`/tmp/hepi-39c168d-pre-deploy-browser.log`, `…-post-deploy-browser.log`) |
| Live read-only browser | `node /tmp/live-39c168d-browser.mjs` | **16 ok, 0 FAIL**, exit 0 (`/tmp/live-39c168d-browser.log`) |
| Auth coherence | local `web.env` vs oracle `backend.env` | the existing tokens match; values not printed |
| Bindings | `ss -ltn` | `127.0.0.1:8787` and `127.0.0.1:30141` only; no public port |

The Web-half check (`/tmp/hepi-39c168d-post-deploy-browser.log`) logs in, reloads and hits six authenticated
endpoints, all `200` — `/api/models`, `/api/models-config`, `/api/projects`, `/api/hosts`,
`/api/cwd/browse`, `/api/skill-market/inventory?workspaceId=integration` — with
`browserLogin=passed`, `reloadAuthentication=passed`, `pageErrors=0`, and it matches the pre-deploy baseline
exactly. No token value appears in either log.

The live read-only pass logged in with the existing secret read privately from `~/.config/hepi/web.env`
(**never printed**) and exercised **read-only** surfaces only: `/api/sessions` (200, 10 sessions, numeric
`sessionListVersion`, every row carrying `messageCount`/`firstMessage`, 9/10 with `projectDisplayRoot` separate
from the routing `projectRoot`, none leaking `/workspace/<uuid>`), `/api/home` 200, opening a conversation keeps
`?session=<id>` in the URL, the DOM shows no routing path, **0** per-conversation `…/state` fan-out calls, and 0
page errors. **No model message was sent**: this is a live route/read check, not a model turn.

## Navigation guard in the deployed artifact

The home-flicker guard (`9e5af9d`, nine lines in `apps/web/components/AppShell.tsx`) is in `39c168d`; its
driver source is identical to the previously verified `c122f0b` (`AppShell.tsx`, `e2e/ux-nav-flicker.mjs` and
the `test:nav-flicker` script all hash-match between `c122f0b` and `39c168d`). The guard string is present in
the running `hepi-web:39c168d` bundle and **absent** from `hepi-web:edef2c0`, so the deployed Web artifact does
carry the fix. The prior driver evidence (`c122f0b`, 8 checks, `UX nav flicker checks PASSED`) is the behavioural
proof; no fresh paid turn was taken, and no live model turn is claimed.

## What was deliberately not changed

- The workstation gateway (`release-51492c4`) — `packages/` did not move; not restarted.
- oracle's Web container (`hepi-web:df24b7c`) — the Web UI is the local half's; its token still matches the
  backend's, so login coherence holds without touching it.
- Tailscale Serve (8443 → 30141, 8444 → 8787), nginx, and every unrelated container.

## Rollback

**Backend (nominal).** Both tags resolve to the same image ID, so this only restores the release record and the
wrapper:

    ssh remote-host
    bash /home/<runtime-user>/hepi-harness-deploy/bin/rollback-to-edef2c0.sh

**Web (real).** The `edef2c0` image is still on disk; revert the one line by restoring the backed-up unit and
restarting the service, exactly as the Web deploy worker recorded
(`/tmp/hepi-39c168d-deployment-evidence.md`):

    cp ~/.config/hepi/deploy-backup-39c168d/hepi-web.service.bak-edef2c0 ~/.config/systemd/user/hepi-web.service
    systemctl --user daemon-reload && systemctl --user restart hepi-web.service

The env file is untouched, so no key needs reverting. The gateway was never part of this deployment, so no change
to the workstation gateway unit is needed to revert it.

The online backup in `backups/20261011T103310-online-39c168d/` exists as a pre-change snapshot of durable state;
restoring a database into `state/` is a separate recovery action, not part of reverting this deployment, and the
restore path was not exercised here.
