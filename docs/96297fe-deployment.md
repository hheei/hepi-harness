# Incremental split-topology deployment of 96297fe

Moves the `ux-follow-up` tip from `19d7cda` to **`96297fe`** (`96297fe9c497478c019761cf48b6392f3d7ea7cf`) on the
split topology. The backend and the Web UI carry new runtime code and were genuinely rebuilt; the gateway and the
runtime host's own Web container were **not** touched. Databases, the agent directory, provider credentials, the
tunnel, Tailscale Serve routes and the call journal were preserved. No paid model call was made.

`96297fe` merges two reviewed fixes onto `19d7cda`'s successor `e17de9e`:

| Change | Files | Behavior |
| --- | --- | --- |
| the catalogue lists conversations, not the runtime's root record | `apps/server/src/server.ts` (+5/-1) | the runtime's own **root conversation** - the framework record that owns the work belonging to no conversation - is never attached, so it is in no catalogue, no search result and no conversation route, and no surface can present it as a project of its own. Its record stays in the store; nothing removes it. |
| a bare load opens no project | `apps/web/components/SessionSidebar.tsx`, `AppShell.tsx`, `lib/session-tree.ts` | a page whose URL names no conversation adopts no project and opens no conversation. Only an explicit pick, a `?cwd=` / `?session=` URL, or the tab's own remembered pick opens something. A cwd that names no workspace (`/durable`) never becomes a group of its own, so no empty phantom group appears. |

The second change is the correction to the report that a deployment came up titled by its own configured workspace.

## Affected roles

| Role | Host | Affected | Action |
| --- | --- | --- | --- |
| backend | runtime host | yes (`apps/server/src`) | rebuilt for `linux/arm64`, transferred as a tarball, digest verified, container recreated |
| Web UI | client host | yes (`apps/web`) | rebuilt for `linux/amd64`, unit retagged on one line, container restarted |
| gateway | client host | **no** - no `packages/gateway` or `packages/client` file changed | untouched: no rebuild, no install, no unit change, no restart |
| oracle Web UI | runtime host | no (same image `hepi-web:df24b7c`) | untouched - not even recreated this time |
| tunnel | client host | no (at the switch) | untouched |

## Artifact identity

| Role | Artifact | Identity |
| --- | --- | --- |
| backend | `hepi-backend:96297fe` | `sha256:165190a59c6a4cc90fdba46c24db3534ad2ab5f4a40d943d91e6102e03f59ebc`, linux/arm64, 210,759,546 bytes |
| Web UI | `hepi-web:96297fe` | `sha256:be0b864f21134be2c469eb1879de22542797d893fbb05bca008c687a06fc1041`, linux/amd64, 407,297,659 bytes, `.next/BUILD_ID ttTAE3rb0nuHroa81aCxN` |
| client bundle | `release-19d7cda` | unchanged - `dist/cli.js` is still `sha256:169c7e5b46a07a31c082f1d92b7606b1761596f92b167cdf1b388942b95812d4`, and the gateway service still names `release-19d7cda` |

Both images were built on the client host, then the backend was `docker save`-ed, gzipped, transferred over SSH and
`docker load`-ed. The digest on the runtime host reads back **equal** to the build host's
(`sha256:165190a59c6a... arm64`).

Emulated-on-the-build-host runtime probes inside the images:

| Check | Result |
| --- | --- |
| `process.version` / `process.arch` in the backend image | `v24.21.0` / `arm64` |
| `node:sqlite` `DatabaseSync` in the backend image | opens, creates, inserts, reads back |
| `quickjs-wasi` `6 * 7` in the backend image | `42` |
| `apps/server/public/chat.js` in the backend image | present, 14,711 bytes |
| `node-pty` in the Web image (native amd64) | spawns `/bin/sh`, `pty-ok` read back |
| `.next/BUILD_ID` in the Web image | `ttTAE3rb0nuHroa81aCxN` |

## Release directory (runtime host)

`releases/96297fe/` is the real tree of `96297fe` (rsync of a clean detached checkout, without `.git`,
`node_modules`, `.next`), assembled in `releases/.staging-96297fe/` and promoted with a single `mv`, so a
failure in verification would have left the running service untouched.

    SOURCE_COMMIT                 96297fe9c497478c019761cf48b6392f3d7ea7cf
    SHA256SUMS                    1,417 files hashed
    deploy/compose.yaml           sha256 c1afdfbdcc0ae221896a925441e8f5be41543b2775a049d981f5aa63952a963d  (tracked, unchanged from 19d7cda)
    deploy/compose.oracle.yaml    sha256 d2a73f0bef251661a56064a074e4fa44b3ff3382620ea8ba4418b3b9b3ccf513  (deployment-generated)
    bin/run-96297fe.sh            compose wrapper for this release (backend 96297fe, Web df24b7c)

The override is the `19d7cda` override repinned to `hepi-backend:96297fe`; host networking, loopback-only
binding, `env/backend.env` (mode 600, unchanged), `user: 1001:1001`, both mounts (`state`, `agent`) and the
Web line at `hepi-web:df24b7c` are unchanged. No new named volume and no `:local` fallback.

## Database backups (online, writer never stopped)

Taken with SQLite's own `VACUUM INTO` against the running writer, so no process was stopped for it.

Runtime host, `backups/20261012T050424-online-96297fe/` (`SHA256SUMS` covers all three):

| File | sha256 | Result |
| --- | --- | --- |
| `hepi.sqlite` | `a24c10be50bf7f5dd508af947b461830c5d8d992747aee31c37b58acd1ca8a27` | integrity ok; 11 conversations `[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]`, 1,536 entries, 3,147 record ids, 21 submissions, 76 documents, 82 document revisions, 1,503 tasks |
| `projects.sqlite` | `d62fe7bb61c3ce1e556e32dd1f593d567417343afe6d4bb0a8b56f0063455b1d` | integrity ok; 4 projects, 4 folders, 0 retained bindings |
| `skill-repository.sqlite` | `290e9048b08b93a7bbc30965890beb6f24c6050ae879cd6151ef987718b0088d` | integrity ok; 0 bundles, 0 files - byte-identical to the `19d7cda` backup |

Client host, `~/.local/share/hepi/backups/20261012T050424-online-96297fe/` (mode 700 directory, 0600 files):

| File | sha256 | Result |
| --- | --- | --- |
| `calls.sqlite` | `e33d8f969bc8a5c5ba7964634f67f1a10a1a6c0fa2f2693d7cb5434e31754e0a` | integrity ok; 783 `gateway_call` rows |
| `config/` | - | private copies of the three user units and both env files, mode 600 |

The client backup is byte-identical to the `19d7cda` one, so no call was journalled between the two deployments.
Both gates were satisfied before the first write: **backup-verified** (all four durable databases copied by this run
and read back) and **single-writer** (`127.0.0.1:8787` had exactly one listener and one container runs
`hepi-backend:96297fe`).

## Switch

Backend (runtime host) - genuinely recreated because the runtime changed:

    bin/run-96297fe.sh up -d --no-build
    hepi-oracle-backend-1  Recreate -> Recreated -> Started
    Image=hepi-backend:96297fe  ImageID=sha256:165190a59c6a...  RestartCount=0  StartedAt=2026-10-12T05:17:37Z  healthy

The runtime host's own Web container was **left running** by the same compose run
(`hepi-oracle-web-1  Running`, `StartedAt 2026-10-12T02:45:38Z`, `RestartCount=0` - the same start as the
previous deployment), so nothing was recreated for it this time.

Web UI (client host) - `hepi-web.service` changed on exactly one line, the image tag
`hepi-web:19d7cda` -> `hepi-web:96297fe`; `HEPI_WEB_HOST`, `PORT=30141`, `--network host` and
`--env-file` are unchanged, and `~/.config/hepi/web.env` was not edited at all (it already carried the two MCP
variables the previous deployment added). `systemctl --user daemon-reload && systemctl --user restart
hepi-web.service`.

**Not restarted or rebuilt:** `hepi-gateway.service` (still `release-19d7cda`), Tailscale Serve
(8443 -> 30141, 8444 -> 8787) and every unrelated container.

## Smoke test (read-only)

| Check | Result |
| --- | --- |
| `/api/models` on the runtime host, unauthenticated / authenticated | `401` / `200` |
| `/api/models` through the client tunnel, unauthenticated / authenticated | `401` / `200` |
| catalog | `deepseek-v4.1-flash` |
| conversation catalogue (the fix) | **10** ids `[8, 60, 77, 90, 159, 172, 197, 249, 655, 3140]` - the runtime's root record `1` is no longer listed |
| stored conversations | still 11, ids `[1, 8, 60, ...]` - the root record is present in the store and unreachable through the API, which is the intent |
| live state databases | `integrity_check ok` on all three; counts identical to the backup |
| Web UI `/` / unauthenticated `/api/sessions` | `200` / `401` |
| Web login | `200` with the configured token, session cookie set |
| sessions, extensions, models config, sidebar UI state through the Web origin | `200`; the catalogue through it lists the same ten |
| MCP surface through the Web origin | `{"mcp":{"available":true}}` with the host's own `mcp.json` read |
| conversation event stream (`/api/agent/8/events`) through the Web origin | `200`, `connected` + `durable_state` frames |
| `/api/sessions/1/state` | `404 conversation not found` - the framework record is not a conversation route |
| gateway call journal | still 783 rows: no paid call was made |

Live read-only browser pass (headless Chromium against the tailnet Web origin): **12 checks, all passing** - a bare
`/` in a fresh authenticated context comes up titled `Pi Web` (no project adopted), opens no conversation, never
requests `/api/default-cwd`, does not show the configured workspace's folder, lists the groups
`workspace, hey, Hepi Mono, Hepi Harness` with 10 session rows and **no group named after the `/durable`
sentinel**, and raises **no page error**; picking a conversation opens it (`?session=8`, title
`workspace - Pi Web`) and a reload keeps it open. The only failing requests are the documented limits below.

## Post-reboot tunnel recovery (recorded because it changed the live topology)

The client host rebooted during this cycle and the tunnel's **reverse** half — the backend → gateway direction —
had to be rebuilt on a different transport. This is recorded in full because it changed the live topology: the
reverse forward moved from Tailscale SSH to the runtime host's own `sshd`, and from port `18788` to `18793`.

**First failure: a restart loop.** The pre-reboot tunnel's reverse forward left port `18788` bound in the runtime
host's `tailscaled`, so `hepi-tunnel.service` (`ExitOnForwardFailure=yes`) restart-looped on `remote port
forwarding failed for listen port 18788`, and `hepi-web.service` — which declares
`Requisite=hepi-tunnel.service` — was restarted with it every few seconds, so the Web origin answered `502` on
its data routes. Cleared with `tailscale debug break-tcp-conns` on the runtime host (no daemon restart, no
reboot): the stale listener was released and the tunnel came up on the next retry. No durable row was touched.

**Second failure: Tailscale SSH accepted the reverse forward and never carried it.** After that, the tunnel's
reverse half was gone in a way that reports success:

| Forward | Path it serves | State |
| --- | --- | --- |
| `-L 127.0.0.1:18787` | client → backend | **works** — `401`/`200` from `/api/models`, the whole Web UI and its event streams |
| `-R 127.0.0.1:18788` | backend → client gateway | **accepted, never carried**: no listener on the runtime host, and `fetch('http://127.0.0.1:18788/v1/mcp')` from inside the backend container answers `ECONNREFUSED` |

The unit ran with `ExitOnForwardFailure=yes`, stayed `active`, and its verbose trace said
`remote forward success for: listen 127.0.0.1:18788` — the request is acknowledged without a bind, so the guard
never fires. Three further observations pinned the mechanism down:

- A **fresh port carried traffic**: a verbose, non-multiplexed probe bound `127.0.0.1:18789` and answered
  `400` to `POST /v1/mcp` from both the runtime host and the backend container. So the transport worked; the
  port was the casualty.
- **A port a killed session held leaks.** That probe's own forward died within minutes and left `18789` in the
  same accepted-but-unbound state; `18791` and `18792` repeated it. The client-side ssh process stayed alive
  throughout and its **local** forward kept working, so the runtime host's `tailscaled` was dropping the
  remote-forward listener without touching the session. Its journal shows control-plane churn in the same window
  (`PollNetMap: http2: client connection force closed via ClientConn.Close`, and a
  `derp.Recv … use of closed network connection`). This is a leak, not permanent damage — all four ports were
  re-checked the same day and are free, without restarting `tailscaled`: see
  *Old-port reclamation and the 2222 exposure audit* below.
- The gateway was never at fault: a local `POST /v1/mcp` on `127.0.0.1:28788` with the backend's own token
  answers `400` (route present, empty body rejected), both sides' tokens hash the same, and the Web origin's MCP
  surface — which reaches the gateway on the same host — answered `available: true` throughout.

**The repair: carry the reverse forward with OpenSSH, not with Tailscale SSH.** Tailscale SSH intercepts the
tailnet on port `22` only, so the runtime host's own `sshd` is reachable on another port, and OpenSSH's remote
forwarding is the well-tested implementation of exactly this flag.

1. **Runtime host: a second `sshd` listener on `2222`.** `ssh.socket` owns the listening sockets on that host
   (socket activation), so the change is a socket drop-in —
   `/etc/systemd/system/ssh.socket.d/60-hepi-tunnel.conf` with `ListenStream=0.0.0.0:2222` and
   `ListenStream=[::]:2222`, port `22` untouched — plus `systemctl daemon-reload` and
   `systemctl restart ssh.socket`. The host's own `sshd_config` was **not** modified (a copy was taken and a
   `sshd_config.d` attempt was reverted once socket activation turned out to own the ports). The `ubuntu`
   account already authorizes this client's key, so no credential was added. Reverting is deleting one file.
2. **Client: the same unit, a different transport.** `hepi-tunnel.service` now runs
   `ssh -N -p 2222 -o ControlMaster=no -o ControlPath=none … -R 127.0.0.1:18793:127.0.0.1:28788 remote-host`:
   same host alias, same private key, same local forward, and `-o ControlMaster=no -o ControlPath=none` pinned so
   the client host's global `Host *` `ControlMaster auto` can never route this unit's forwards through, and then
   lose them with, another session's master connection.
3. **The reverse listener is now OpenSSH's.** `ss -ltnp` on the runtime host shows
   `127.0.0.1:18793 … users:(("sshd-session",…))` instead of `tailscaled`.
4. **The backend's URL followed the port.** `HEPI_GATEWAY_URL=http://127.0.0.1:18788` became
   `http://127.0.0.1:18793` — a one-line edit to the existing `env/backend.env`, mode 600 kept, a private copy
   taken first, nothing else in the file changed.
5. **The backend container was recreated, not rebuilt.** `bin/run-96297fe.sh up -d --no-build`: `Recreate`,
   `Started`, `RestartCount=0`, healthy; the Web container was reported `Running` and kept its
   `StartedAt 2026-10-12T02:45:38Z`. State is bind-mounted, and the post-recreate counts are identical — 11
   conversations, 4 projects, 783 gateway calls, `integrity_check ok` on all three stores.

**Verified after the repair**, all read-only: the runtime host and the backend container both answer
`POST /v1/files {method: executionHost, workspaceId: integration}` with `200` and the execution host's real
account (`user: developer`, `home: /home/developer`, `workspaceRoot: …/hepi/workspace`); `GET /api/workspaces` returns
**five workspaces with zero `hostError`** and real host metadata on each, where it previously reported
`gateway unavailable or dispatched filesystem outcome unknown` for all five; and the browser pass drops the
`502 /api/files/…` that came from the broken dispatch, keeping only the documented `502 /api/git/status` and
`501 /api/worktrees`. A sidebar detail corroborates it: while the dispatch was broken the workspace group was
named after the workspace **id** (`integration`), and with the host resolved it is named after the folder again
(`workspace`).

**Private copies taken before any of this**, so every step is reversible: the tunnel unit
(`hepi-tunnel.service.before`), the backend environment (`backend.env.before-tunnel-fix`, and a hash of the
`HEPI_GATEWAY_URL` line), and `/etc/ssh/sshd_config` on the runtime host, all under this cycle's backup
directory with mode 600.

Unrelated and left alone, but worth knowing on that host: `ts-proxy-udp.service`, a pre-existing user unit that
relays UDP over SSH, is in a 1200-plus restart loop, opening a new SSH session to the runtime host every few
seconds. It does not hold the tunnel's ports and nothing in this cycle touched it.

## Old-port reclamation and the 2222 exposure audit (same day, after the cycle)

Two questions the recovery left open were closed later on 2026-10-12. Apart from bounded probes that bound a port
and released it again, this was read-only, and it left nothing running.

**The four old ports are free — no `tailscaled` restart was needed.** `18788`, `18789`, `18791` and `18792`
were each checked at both levels on the runtime host:

| Port | Free at the OS level (plain `bind()` on `127.0.0.1`) | `tailscaled` accepts a `-R` on it | After teardown |
| --- | --- | --- | --- |
| `18788` | yes | yes — `ss` shows `tailscaled` bound `127.0.0.1:18788` | listener gone |
| `18789` | yes | yes | listener gone |
| `18791` | yes | yes | listener gone |
| `18792` | yes | yes | listener gone |

The state those ports were left in was a **leak that expires**, not a permanent reservation: the reservations that
made the earlier probes fail were gone by the time this was measured, and a forward torn down **gracefully**
(`ssh -O exit`, i.e. the `cancel-tcpip-forward` the daemon processes) releases its port — every probe ended with
no listener, no control socket and no surviving ssh process. The failure mode is therefore narrower than "the port
is burned": it is **a session killed while holding a forward**, which is what the earlier probes did to `18789`,
`18791` and `18792` themselves. Nothing on that host needs restarting for these ports, and the live forward on
`18793` was never involved: it is OpenSSH's and stayed up across every probe.

**The `2222` listener is not publicly reachable.** The runtime host's `iptables` `INPUT` chain is an allow-list
ending in `-A INPUT -j REJECT --reject-with icmp-host-prohibited`; the TCP ports it admits are `22`, `80`,
`443` and `28443` (plus `1081`/`7892` from `172.16.0.0/12`), and `ts-input` accepts the `tailscale0`
interface outright. `2222` is in none of those rules, so the added `sshd` socket is reachable over the tailnet
only, and no firewall was touched. Measuring this from the client host is **not** possible directly: that host's
transparent proxy accepts any TCP connect, so a control experiment showed ports `12345` and `45999` "open" as
well. The firewall rule set is the evidence, and it is the stronger statement — the host does not admit `2222`
from anywhere off the tailnet, whatever filtering the cloud layer adds on top.

Housekeeping from the same pass: `hepi-tunnel.service`'s description no longer names `18788`, the probe copies
under `/tmp` on the runtime host are gone, and the pre-change copies of the tunnel unit, the backend environment
and `/etc/ssh/sshd_config` sit together (mode 600) in the cycle's backup directory.

## Known limits

- `501 /api/app-update` and `501 /api/worktrees` still answer as documented, and the persistent workspace is
  still not a git checkout, so the gateway answers `fatal: not a git repository` for it. With the reverse forward
  repaired the gateway-backed routes reach that documented answer again instead of failing earlier — see
  *Post-reboot tunnel recovery* above.
- The reverse forward now lives on **`127.0.0.1:18793`**, not `18788`, and `HEPI_GATEWAY_URL` names it.
  `18788`, `18789`, `18791` and `18792` are **free** — verified the same day at both the OS and the
  `tailscaled` level, with no daemon restart — but nothing was moved back onto them: the live port is OpenSSH's
  and unchanged. No script or application code hardcodes a port — only these guides do — so it lives in
  `hepi-tunnel.service` and `env/backend.env` and nowhere else.
- The runtime host now runs a second `sshd` listener on **`2222`**, added for this tunnel through an
  `ssh.socket` drop-in. It is key-only, on a host whose port `22` is reachable only over the tailnet, and
  removing `/etc/systemd/system/ssh.socket.d/60-hepi-tunnel.conf` plus a `daemon-reload` and
  `systemctl restart ssh.socket` undoes it.
- The runtime's root conversation **stays in the store** and is unreachable through the API by design; nothing in
  this range removes it.
- A sidebar group named after a folder nobody recorded - a deployment's own configured workspace is the common
  case - has no removal or unlink control, and removing such a workspace stays a deployment change: no
  environment-driven unlink was added, and no existing bound session was changed.
- `deploy:inspect --probe` reads `SOURCE_COMMIT` at the runtime **root** in this range, where the marker actually
  lives in `releases/<id>/SOURCE_COMMIT`; the probe exits 3 on that read. **Fixed after this record** on
  `impl/deploy-probe-layout`: the probe now resolves `<id>` from the running backend image's tag and reads the
  marker from the release directory (see [runbook](deployment-runbook.md), stage 1). The marker read is proven by the
  probe's own fixture: against a real host the probe still exits 3 earlier, at `containerDetail`, because one
  running container without a `HEALTHCHECK` fails the whole `docker inspect` call — a pre-existing limit recorded
  in the runbook rather than fixed here.
- `apps/web/e2e/ux-nav-new-session.mjs` is flaky: at both `e17de9e` and `96297fe` it fails roughly half its
  runs on the same assertion (`fresh: the sent turn never left the screen before its answer`), on a single
  transient sample of the fresh turn. Pre-existing and unchanged by this range. **Fixed after this revision**: the
  sample was a real frame, not a sampling artifact — the empty-new gate unmounted the transcript for it. See
  [verification](verification.md#new-session-navigation-testnav-new-session-and-auto-name-testsession-auto-name).
- The Web unit suite carries **22 pre-existing failures** (23 names, including
  `components/SessionSidebar.file-search.test.mjs` and `components/SettingsPanel.test.mjs`), an identical set
  before and after this range.

## Verification run against this revision

| Check | Result |
| --- | --- |
| `pnpm verify --profile=fast` | PASS - typecheck 0, tests 0; client 9, protocol 46, session 3, gateway 111, server 219 (388 total), 0 fail |
| `pnpm compare:tests --base=e17de9e` | base 2,115 pass / 22 fail, tip 2,117 pass / 22 fail, **0 new**, identical failure set |
| `pnpm check:docs` | 132 files, 0 broken relative links, 0 guides missing from the index |
| `pnpm check:entrypoints` | 60 entry files present, 2 known-missing (pre-existing, recorded), 0 newly missing |
| ticket validator | 0 blocker problems |
| focused browser suites | `ux-default-workspace`, `ux-workspace-routing`, `ux-sidebar-shared-state`, `ux-new-project`, `ux-session-delete`, `ux-session-search`, `ux-submission-recovery`, `ux-terminal-close`, `ux-project-removal`, `ux-terminal-session` - all exit 0 |

## Guide versions left current

- `docs/README.md` - current-deployment line moved to this record.
- `docs/local-tailscale-deployment.md` - Web image line and the new upgrade section; the gateway release line is
  deliberately unchanged.
- `docs/oracle-tailscale-deployment.md` - backend image table and last-recorded section moved to `96297fe`,
  with the Web container recorded as untouched.
- `docs/mcp-on-the-web-host.md` - unchanged: this range adds no variable and does not move the MCP surface.

## Rollback

**Backend (real).** The runtime changed, so this is a genuine image rollback:

    bash <runtime-root>/bin/run-19d7cda.sh up -d --no-build

`hepi-backend:19d7cda` (`sha256:6d8fce1201bb...`) is still on disk. This range adds no schema change, so the
previous image reads the same databases and no restore is required.

**Web UI (real).** `hepi-web:19d7cda` (`sha256:bb0860a79604...`) is still on disk; restore the backed-up unit
(`config/hepi-web.service`) or edit the one tag line back, then `systemctl --user daemon-reload && systemctl --user
restart hepi-web.service`.

**Gateway (not needed).** Untouched by this range - `release-19d7cda` is still the running bundle.

The backups above are pre-change snapshots of durable state; restoring a database into `state/` is a separate
recovery action, not part of reverting this deployment, and that path was not exercised here.
