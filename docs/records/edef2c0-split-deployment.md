# Split-topology upgrade to edef2c0 (workstation web/gateway + remote-host backend)

Upgrades both halves of the live split topology to the merged ux-follow-up integration tip
`edef2c0a15e13cf3d12f70ef01cb56796f35f3dc`, on top of the previous `51492c4` release. The two halves are the local
gateway and Web UI on `workstation` (`docs/local-tailscale-deployment.md`) and the durable backend on `remote-host`
(`docs/oracle-tailscale-deployment.md`). Database, agent directory, credentials, tunnel and Tailscale Serve routes
were preserved; no paid model call was made.

This step is **superseded**. The later [39c168d deployment](39c168d-deployment.md) moved both hosts on: the
oracle backend now runs the same image object as `hepi-backend:edef2c0` under the tag `hepi-backend:39c168d`
(a retag — no rebuild, no container recreation), and the workstation Web UI is `hepi-web:39c168d`. The gateway is still
`release-51492c4` and was never restarted, because `packages/` is byte-identical across the whole range.

**State at the edef2c0 cutover (2026-10-11, historical).** remote-host backend `hepi-backend:edef2c0`, remote-host Web
UI `hepi-web:df24b7c`, workstation Web UI `hepi-web:edef2c0`, workstation gateway client `release-51492c4` (bundle
byte-identical to `edef2c0`). The backend's login token was rotated after this cutover; the local and Oracle
guides carry the current units.

## What changed between 51492c4 and edef2c0

`packages/` is byte-identical across the range, so the gateway has nothing new to run. Only two trees moved:

| Tree | Commits | Effect |
| --- | --- | --- |
| `apps/server` | `4f11350` (recall route, catalogue fields), `f0f2a9f` (skill-install fan-out under one bound) | `POST /api/conversations/:id/recall-queue`; the catalogue now carries `busy`/`revision`/`messageCount`/`firstMessage` |
| `apps/web` | `3d15f30`, `4f11350`, `cb03386` | session list and running poll read one catalogue response instead of every conversation's state; project surfaces show a folder's own host path while the API still addresses the routing path |

## Images and units

| Half | Artifact | Identity |
| --- | --- | --- |
| oracle backend | `hepi-backend:edef2c0` (linux/arm64) | `sha256:3a2dbec16ec294b72f5ff2e7bee580c5b0532455a00568baf759cc13c39de4c1` |
| workstation web | `hepi-web:edef2c0` (linux/amd64) | `sha256:9b6ecada68aeb2db53237b8ad1a04b24dd6d1fa930bb242143f1eb610df83417` |
| workstation gateway | installed client `release-51492c4` **unchanged** | rebuilt bundle is byte-identical: `cli.js sha256 f28f890b634dee4ccd5700c90c4084d313286e65ac2547a2a27f3dcfb68a9342` |

Both images were built from `git archive edef2c0`, `sha256 75ad35fc7723663b2538756b70de6812582dfa924f8b29c3c85e1fdbc712f4b7`.

- Oracle: source extracted to `releases/edef2c0`, `compose.oracle.yaml` merged over the repository's
  `deploy/compose.yaml` (override `sha256 6962e3223ac3182d6c4041261634f0a39ccc4c6413f40929ea8425fe1bb28dea`), wrapper
  `bin/run-edef2c0.sh`; the Web image deliberately stays `hepi-web:df24b7c` because the Web UI belongs to the local
  half. Environments, `env/backend.env`, host networking, loopback binding, `user: 1001:1001` and both bind mounts
  are unchanged from 51492c4.
- workstation: `hepi-web.service` `ExecStart` names `hepi-web:edef2c0`. The temporary
  `hepi-web.service.d/cleanup-session-filter.conf` drop-in (a stopgap that filtered unbound conversations out of the
  old per-conversation fan-out) was removed: the catalogue design supersedes it, and a drop-in that silently
  overrode the unit's image would have pinned the deployment to a pre-integration build.
- `hepi-gateway.service` and `hepi-tunnel.service` were not restarted or edited.

## Restart semantics (no `docker kill`)

The cutover used Compose recreation only:

    bash bin/run-edef2c0.sh up -d        # recreates hepi-oracle-backend-1, leaves hepi-oracle-web-1 running

Compose stopped the old backend gracefully and started the new one; both containers report
`RestartCount=0`. The local Web was restarted with `systemctl --user restart hepi-web.service`. No `docker kill`
was used anywhere, so the previous deployment's operator-stop caveat does not apply to this change.

## Database and state

Online backups were taken with SQLite's own backup API against read-only connections, with the writer still running,
so no service was stopped for the backup:

    backups/20261011T034722-online-edef2c0/
      hepi.sqlite projects.sqlite skill-repository.sqlite state-dir.tar.gz SHA256SUMS

All three report `integrity_check ok`. The conversation id set was `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655]`
immediately before and immediately after the edef2c0 swap, and the entry count continued to grow normally. That
comparison covers the edef2c0 cutover only: it is not a comparison against the earlier `51492c4` release, whose own
cutover recorded the smaller `[1, 8, 60]` set. `state/` and `agent/` stay the same host binds, so the rollback
stack reads the same untouched files.

## Verification

| Check | Result |
| --- | --- |
| `bin/verify-oracle.sh` | 10 passed, 0 failed (health, catalog, continuity, web proxy, native runtime, loopback bindings) |
| Containers | `hepi-oracle-backend-1 hepi-backend:edef2c0 healthy restarts=0`, `hepi-oracle-web-1 hepi-web:df24b7c healthy` |
| Tailnet backend | `https://<runtime-host>.<tailnet>.ts.net:8444/api/models` 401 unauthenticated |
| Local Web | `http://<client-host-tailnet-ip>:30141/` 200, `/api/models` 401 unauthenticated, `127.0.0.1:30141` still refused |
| `systemctl --user` | `hepi-gateway`, `hepi-tunnel`, `hepi-web` all `active` |

Read-only probes for the three changed behaviours:

1. **Queued recall route.** `POST /api/conversations/:id/recall-queue` returned 404 before the upgrade and 200 after.
   The live deployment held no queued input at cutover, so the controlled proof is the real backend with a faux
   provider: `apps/server/test/recall-queue.test.ts` `4/4` — queue recorded, recalled text returned in queue order,
   entry not delivered when the run settled, empty recall is an empty recall. Against the live deployment the route
   answers `200 {steering: [], followUp: []}` on an empty queue, and the Web route (`clear_queue`) returns
   `success: true` where it previously answered `501 not connected`.
2. **Session list no longer reads every conversation.** `tcpdump` on oracle's loopback over one catalogue + session
   list call counted **2** `GET /api/conversations` and **0** per-conversation `GET /api/conversations/:id/state`.
   The compiled Web route no longer contains the `Promise.all(...map(a=>T(a.id)))` fan-out (the 51492c4 image does).
3. **Workspace `displayRoot` alias.** For each listed workspace, `POST /api/cwd/validate` on `/workspace/<id>`
   returns `displayRoot` equal to the workspace's own host root (`/home/<client-user>/.local/share/hepi/workspace`,
   `/home/<client-user>/Downloads`, `.../dev/hepi-harness`), while `cwd`/`projectRoot` stay the routing path. Every bound
   session reports a `projectDisplayRoot` that is a host folder, none shows `/workspace/<uuid>`, and the unbound
   conversation keeps `/durable`. A real headless browser on the live UI raised no refusal message, displayed no
   routing path, and logged zero page errors; the ticket's own driver
   `apps/web/e2e/ux-workspace-routing.mjs` passed end to end.

## Rollback

    bash /home/<runtime-user>/hepi-harness-deploy/bin/rollback-to-51492c4.sh   # oracle: stop edef2c0, start 51492c4

    sed -i 's#hepi-web:edef2c0#hepi-web:51492c4#' ~/.config/systemd/user/hepi-web.service
    systemctl --user daemon-reload && systemctl --user restart hepi-web.service

The state databases were never migrated, so rolling forward again is `bin/run-edef2c0.sh up -d` plus the unit edit
back. Private copies of the unit and the removed drop-in were taken to
`~/.config/hepi/deploy-backup-edef2c0/` before the change.

## Rollback concerns

- The `hepi-web:cleanup-session-filter` image remains on disk but is no longer referenced by any unit; it is stale
  and can be deleted once this release is accepted.
- `hepi-web:51492c4` and `hepi-backend:51492c4` remain tagged, which is what the rollback path uses.
- The local Web upgrade is the first one to change the **session-list behaviour** the user sees: an older browser tab
  holding a cached bundle from the previous image should be reloaded once.
- `projects.sqlite` was created by the `51492c4` backend and carried forward as-is rather than migrated. It held
  no rows at the edef2c0 cutover; registered projects have accumulated in it since through ordinary use, so "empty"
  describes the cutover, not the current file.
