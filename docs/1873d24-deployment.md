# Web-origin cutover to the client ingress — 1873d24

Executed 2026-10-18 on the workstation. The primary Web origin moved from the Next container (`hepi-web.service`)
to the client ingress: one Node process that serves the Vite build statically and answers `/api` as the client
listener, on the **same address and port and with the same login material** as before. The Backend image and the
execution gateway's client bundle moved to the same revision in the same window, because the ingress calls the host
gateway's `POST /v1/mcp` and the Backend answers the ingress's device-credential verification — neither route exists
in the artifacts that were running.

| Role | Before | After |
| --- | --- | --- |
| Web origin (tailnet `:30141`) | `hepi-web:b6b6745` (`sha256:6baec63a1b50…`, amd64) under `hepi-web.service` | `hepi-ingress.service` running `/usr/bin/node …/release-1873d24/ingress.mjs` |
| Backend | `hepi-backend:848f391-workstation` (`sha256:5f987671573b…`, amd64) | `hepi-backend:1873d24-workstation` (`sha256:5d9851629fd1…`, amd64) — same unit, same `--env-file`, same state mount |
| Execution gateway | client bundle `release-1062840` (`SOURCE_COMMIT 1062840…`, `dist/cli.js` `sha256:8d022b306568…`) | `release-1873d24` (`dist/cli.js` `sha256:5ca199164dc3…`) — same unit, one `ExecStart` line changed |
| Compatibility forward | `hepi-tunnel.service` | unchanged and not restarted (source `56ff08f` range did not touch it) |

Source: `1873d244289db…` — see the private run directory for the full SHA and the pinned-commit reason. Built on the
workstation from a clean detached worktree at that commit
(`git worktree add --detach .dev/build-1873d24 1873d24…`), because the shared integration worktree is being edited by
other sessions. No oracle build, no native/Rust/App build, no install on the runtime host beyond the release
directory and the packed tarball.

## Artifacts and commands

One release, one command: `node scripts/build-client-runtime.mjs` (exit 0) produced `release-1873d24` — the ingress
bundle `ingress.mjs` (`sha256:b3e5b41625ea…`, 275.8 KiB), the packed execution gateway
`gateway/hepi-client-0.1.0.tgz` (`sha256:7dbb9dc075dc…`, 807.6 KiB), the Vite build `web/` (169 files) and the Backend
image `hepi-backend:1873d24-workstation` for `linux/amd64`, read from the image, not the build command.
`sha256sum -c SHA256SUMS` in the release: exit 0, 175 entries. Steps: ingress bundle 0 s, gateway build+pack 0 s,
Web build 2 s, Backend image 84 s.

The gateway tarball was installed into the promoted directory with the established npm-tarball workflow
(`npm install --prefix <staging>`, exit 0) — the manifest's `file:` dependency rewritten to the promoted path before
install — and the bundle's one contract this deployment depends on was read back out of the installed file: it carries
`mcp.execute(body, controller.signal)`, which `release-1062840` does not, so an MCP call the host gateway serves can
now be cancelled when the caller disconnects. `--version` 0.1.0. Promotion is one `mv`, and the release directory is
immutable: it was staged under `.staging-release-1873d24`, verified there against its own `SHA256SUMS`, and renamed.

The unit and its environment come from the checked-in generator, not a hand-written file:
`node scripts/ingress-unit.mjs --release-dir=<client-release-root>/release-1873d24 --node=/usr/bin/node` rendered
`hepi-ingress.service`; the interpreter stays pinned because the user manager's `PATH` puts an older Node (no
`node:sqlite`) first on this host. The environment file was assembled from the materials this deployment already
holds — the same login material the browser used before, the Backend's own service credential for the ingress's
outbound calls, the Backend's loopback origin, the same tailnet bind and port, the release's `web/` as
`HEPI_INGRESS_STATIC_DIR`, and the host-local gateway URL/token/id that the old Web environment already carried
(mapped onto the ingress's MCP variables, with the same value as `HEPI_INGRESS_DEFAULT_HOST`). Written once at 0600,
never printed; no value appears in this record or in the private run directory's logs (checked by scanning every run
file for the deployment's secret values: 0 hits over 29 files).

Nothing was disabled to make the preview work: the bind is non-loopback, so the login material is required by the
ingress itself, and it is the pre-existing value, so the human's login is unchanged.

## Backups and gates

This is the initial switch of the Web entry **and** a Backend image change, so the full-runbook stages applied rather
than the Web-only shortcut. Online SQLite backups (read-only source connections, `Backup` API, no writer stopped)
were taken before the window to `~/.local/share/hepi/backups/<timestamp>-online-1873d24-web-ingress/` (0700, files
0600). Every copy passed `pragma integrity_check` in the backup file with its expected rows:
`hepi.sqlite` 24 conversations / 1991 entries / 1933 tasks / 40 submissions, `projects.sqlite` 4 / 4 / 0 retained
bindings, `skill-repository.sqlite` 0 / 0, and the gateway call journal 1019 rows.

Both stage-6 gates were satisfied before the first write: backup-verified by this run, and single-writer — the old
Web container was stopped and the port proven free (`holders: 0`) before the ingress started, and the Backend's state
mount was carried over unchanged so exactly one process opens each database.

Schema compatibility was read before switching, not assumed: the range the deployed Backend moves over adds no
`ALTER TABLE`, no column and no state path. The one new store is the Backend's device-credential sidecar
(`CREATE TABLE IF NOT EXISTS`, beside `HEPI_DB`, default `device-credentials.sqlite`), which is a new file, not a
migration of durable conversation state. `durable_schema` is `1|1` in the pre-switch backup and in the live database
after the switch, the table list is identical, and the new sidecar was created empty and passes `integrity_check`.

## The window

Recorded step by step with exit codes in the private run directory (`window.log`): unit files installed and
`daemon-reload` (0); `systemctl --user stop hepi-web.service` (0) with the port then free; gateway restart (0);
Backend restart (0) — its container confirmed running `hepi-backend:1873d24-workstation` and answering `401` unauthenticated;
`systemctl --user start hepi-ingress.service` (0) — `192.0.2.10:30141` then held by the ingress and by nothing
else. `hepi-web.service` was then **disabled** (not just stopped) so a boot or logout cannot bring a second Web origin
back beside the ingress, and `hepi-ingress.service` was enabled; `default.target.wants` now names ingress, backend,
gateway and tunnel. The tunnel was deliberately not restarted: it carries only remote compatibility and
`Restart=always` keeps its forward, and a restart here can fail on the remote `sshd`'s still-held port.

## Smoke (read-only, no submission)

`smoke.mjs` (exit 0, results in `smoke.json`/`smoke.log`) against the live origin:
`/` 200 `text/html`; hashed JS and CSS 200 with `public, max-age=31536000, immutable`; `/conversations/<id>` shell
200; `/sw.js` and `/manifest.webmanifest` 200; an unknown `.js` 404 and an encoded traversal 404; `127.0.0.1:30141`
still refused (the tailnet bind only, as before). `/api/web-auth` → `{"enabled":true}`; wrong login 401; right login
200 with an `HttpOnly`, `SameSite=Strict` `hepi-web-session` cookie; unauthenticated `/api/models` 401.
Authenticated through the ingress: `/api/models` 200 (6 models, payload byte-identical to the Backend's own answer),
`/api/descriptor` 200, `/api/conversations` 200 with **all 16 previously-visible non-deleted conversations present**
(24 rows in the database, the same as the pre-switch backup), `/api/projects` 200 (4), `/api/workspaces` 200
(4 folders, 0 `hostError` — the gateway re-registered its workspaces through the Backend's own replay path on start),
`/api/hosts` 200 (1 host, no error), one conversation's history 200 (8 entries) and its `/events` stream opening
200 `text/event-stream` with the first frame read and cancelled. Gateway connectivity: `GET /api/mcp` 200
`available=true` answered from this host's own gateway, a workbench listing 200 (6 entries), and the execution
listener still refuses an unauthenticated `POST /v1/workspaces` on its own bind (401) while answering with its token
(200). The client listener serves no `/v1` route (404). Live databases re-checked read-only after the switch: all
`integrity_check` ok. No message was submitted, no model was called, no write was made; journal and conversation row
counts unchanged after the smoke.

**Re-verified against the live deployment later the same evening** (23:11 CST, an hour and a half after the
window; results in the private run directory's `live-report-2221/`). The revision actually serving is read, not asserted:
`release-1873d24/SOURCE_COMMIT` = `1873d244289db29e5aaa62118e3dfc1b30ffabb5`, and that release directory is what both
running units name — `hepi-ingress.service` `ExecStart=/usr/bin/node …/release-1873d24/ingress.mjs`, and
`hepi-gateway.service` `…/release-1873d24/node_modules/@hepi/client/dist/cli.js gateway`. Artifact hashes re-read from
the installed files: `ingress.mjs` `sha256:b3e5b41625ea…`, installed bundle `dist/cli.js` `sha256:5ca199164dc3…`,
gateway tarball `sha256:7dbb9dc075dc…`; `sha256sum -c SHA256SUMS` again exits 0 with **175** `OK` lines. The running
backend container reports image `hepi-backend:1873d24-workstation` /
`sha256:5d9851629fd18caf13477173c9e505ac9690b7790a3e0822b0ac44caaac52d8d`. Page and asset continuity: `/` answers 200
`text/html`, 1 860 bytes, and the two asset names the served document references — `/assets/index-oh_ZJ82Q.js` and
`/assets/index-BX9kmQvL.css` — are the same two the release's own `index.html` names, each 200 and `immutable`.
All 30 read-only checks re-passed: conversations still answer the **16** pre-switch ids with no loss, `/api/models` 6,
`/api/projects` 4, `/api/workspaces` 4 with 0 `hostError`, `/api/hosts` 1, MCP `available=true`, the history read 8
entries, the event stream 200 `text/event-stream` (first frame 7 927 bytes, then cancelled), four live databases
`integrity_check` ok with the device-credential sidecar still at 0 rows, and `127.0.0.1:30141` still refused.
`NRestarts=0` on all four units, and the user journal holds no error-priority entry for any of them — the only
recurring failure in the window is an unrelated `ts-proxy-udp.service` restart loop pointing at a missing script, which
this deployment neither owns nor touched.

One artifact check ran before the port moved: the new Backend image was started once against a throwaway state
directory on a spare port (401 unauthenticated, `/internal/credentials/verify` answering
`{"ok":false,"reason":"unknown"}` for an unknown token), then removed. The ingress was likewise preflighted on
loopback before the switch. Neither touched the deployment's databases.

## Operator notes

- **Open pages must be refreshed once.** A browser showing the old Next build keeps running that JavaScript until it
  is reloaded; the pre-switch build held a composer draft only in memory, so unsent text or an attached image must be
  copied by hand before that page's first refresh ([runbook](deployment-runbook.md#existing-open-pages-at-a-web-contract-switch)).
  A pending submission is looked up by its `requestId`, not resent.
- **Rolling the application back is a re-pin, not a data restore.** Restore the three `*.service.before` units,
  `systemctl --user daemon-reload`, `systemctl --user stop hepi-ingress.service && systemctl --user disable hepi-ingress.service`,
  then `systemctl --user enable --now hepi-web.service hepi-backend.service hepi-gateway.service`. The previous image
  `hepi-backend:848f391-workstation`, the previous Web image `hepi-web:b6b6745`, and the previous client bundle
  `release-1062840` all remain on the host, and `~/.config/hepi/web.env` was not edited. The schema is the one those
  artifacts already read (`durable_schema 1|1` unchanged), so no restore is needed; the only state the new Backend
  added is `device-credentials.sqlite`, which the old Backend ignores.
- **Evidence** stays in the git-ignored private run directory: the previous units and env copies, the rendered unit,
  the staged-release report, the install/build/window logs, the backup manifest, the baseline and smoke JSON, and the
  before/after runtime inspections.

## Limits, stated

This switch is the Web entry cutover. It is not ticket 16's completion: the native/App journey still has no evidence
at this revision (16's own acceptance list stays open, Android still blocked with no SDK or device), and no browser
journey drove this deployed origin — the page was fetched and its API surface exercised over HTTP, not driven through
Playwright against the live deployment. `apps/web`'s Next entry files stay in the tree for ticket 17 to retire; nothing
now runs them. No TLS is added: the origin is HTTP on the tailnet, the same as before, and the session cookie carries
no `Secure` flag for the same reason. The remote compatibility Web image still runs on the former runtime host against
the same backend through the forward, unchanged.
