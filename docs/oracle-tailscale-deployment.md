# Oracle deployment (remote-host)

**Current role, verified 2026-10-16:** the durable backend moved to the workstation. The former `hepi-oracle-backend-1` container is stopped with restart policy `no`; its state remains rollback evidence, not a current writer. Remote Web and Tailscale API listeners remain available through `127.0.0.1:8787`, now an SSH reverse forward to the workstation backend. [Migration record](backend-local-migration-2026-10-16.md) owns the current topology and state-transfer rollback. Do not run the historical backend Compose wrappers against stale remote state.

## Historical split deployment

Everything below describes the earlier backend placement. The ban on building on this remote host remains in force.

The remote half of the split topology: the durable backend and the Web UI as containers on the arm64 runtime host
`<runtime-host>` (login `<runtime-user>@<runtime-host-tailnet-ip>`, tailnet `<runtime-host-tailnet-ip>`, MagicDNS
`<runtime-host>.<tailnet>.ts.net`), replacing the previous `systemctl --user hepi-backend.service` process. The
local half — the gateway and the Web UI on the client host `<client-host>` — is docs/local-tailscale-deployment.md
and is owned separately. Real host names, addresses and account names live in git-ignored private configuration, not
in this file (see docs/README.md).

**Last recorded state (2026-10-13): backend `hepi-backend:cb4494b`, Web UI `hepi-web:df24b7c`.** On that date the
backend's environment also stopped configuring a workspace: `HEPI_WORKSPACE_ID` was removed from `env/backend.env`
(mode 0600 preserved, every other key unchanged) and the six sessions that had been bound to that workspace were
removed through the existing tombstone route, so this host now serves only the four recorded project folders. See
[the workspace-removal record](f603a48-workspace-removal.md). The backend was
last moved to `cb4494b`, which **does** change the backend runtime (one lifecycle payload on both transports, the
submission projection's `answerId`, and the resource loader's new one-request discovery), so the image was genuinely
rebuilt for arm64, transferred as a tarball, digest-verified and the container recreated once — not a retag. That
increment also changes the gateway on the client host, and the loader **requires** the gateway's new
`resourceSnapshot` method, so the two roles had to move together. See
[the cb4494b deployment record](cb4494b-deployment.md); the earlier steps are
[the f603a48 deployment record](f603a48-deployment.md),
[the 0628888e5a85 deployment record](0628888e5a85-deployment.md),
[the 96297fe deployment record](96297fe-deployment.md),
[the 19d7cda deployment record](19d7cda-deployment.md),
[the 78078de deployment record](78078de-deployment.md), [the 39c168d deployment record](39c168d-deployment.md) and
[the edef2c0 split deployment](edef2c0-split-deployment.md). The Web container deliberately stays on `df24b7c`,
because the Web UI is the local half's; the `96297fe` compose run left it running untouched (the `19d7cda` run had
recreated it at that same image, because the compose project's config-file path moved), and no Web image was
deployed here.

That line is a dated record, not a live reading: **no deployment has been recorded or verified on this host since
2026-10-12**, and nothing has been shown to have moved it. Use the
[routine deployment path](deployment-runbook.md#routine-deployment-default) and read the affected live service
rather than trusting this line; installation and state changes use the full runbook. Everything below
describes the original `df24b7c` setup and is a point-in-time record of that deployment, not a description of what
runs now.

## This host deploys and runs; it does not build

**No compile or build task runs on `remote-host`** — no `pnpm build`, no Next.js `build`, no TypeScript emit
(`tsc` without `--noEmit`), no `docker build`/`docker buildx` and no remote builder, and no dependency install
that compiles native modules. Build on `workstation` or in CI, matching this host's architecture (`linux/arm64`), then move
the **prebuilt** artifact here: a pinned image tag/digest pulled from the registry, or a tarball transferred over SSH.

**This host's one operational path is `docker compose ... up -d --no-build` against pinned prebuilt images**
(`releases/<commit>/deploy/compose.oracle.yaml` pins the tags, `bin/run-oracle.sh` wraps it). A compose command
without `--no-build` can build or fall back to a local build, so it is not used here. Beyond that, what stays allowed
is deploying, running, and read-only verification: restarting the units, `bin/verify-oracle.sh`, `GET`/health
checks, reading logs and digests. `pnpm -r typecheck` (`tsc --noEmit`) is a read-only check and is allowed;
`pnpm -r test` is not read-only in the same sense (it starts processes and writes fixtures) and belongs to the build
host or CI. There is no install or build step on this host: the release tree arrives with its dependencies already
installed. The scripts in a release's `bin/` that build (`bin/build-<commit>.sh`) are historical and now run on
`workstation` or CI, with the resulting image transferred here. Step-by-step sequence:
[the deployment runbook](deployment-runbook.md).

The sections below are point-in-time records. Where an earlier release says it was built on this host, read that as
what happened then, under the rule above: **build on the workstation or CI, transfer the artifact, deploy and verify
here.** See [deployment](deployment.md) for the split topology and [container deployment](container-deployment.md)
for the images and their cross-architecture prerequisites.

Release **df24b7c** (`df24b7c9ee4cc10208c76a0c3ccaf7bfc91bb4df`), built natively on the host from a `git archive` of
that commit (`sha256 948f3f8a9fb2641a29e5098b7f340320b45f98253395316fd89dc9a34e544fad`). No registry is involved:
the images are local tags and the release directory is immutable input. The `df24b7c` release directory, the
`bin/` wrappers named after it and the image digests in the next sections are what that release installed.

## Addresses

| What | Where | Notes |
| --- | --- | --- |
| Web UI (tailnet) | `https://<runtime-host>.<tailnet>.ts.net:8443` | `tailscale serve`, HTTPS, tailnet only |
| Backend API (tailnet) | `https://<runtime-host>.<tailnet>.ts.net:8444` | `tailscale serve`, HTTPS, tailnet only; bearer token required |
| Web UI (on the host) | `http://127.0.0.1:30141` | loopback only, never published |
| Backend (on the host) | `http://127.0.0.1:8787` | loopback only, never published |
| Gateway reverse forward | `127.0.0.1:18793` on the host | OpenSSH forward from `workstation`, carried by this host's own `sshd` on port `2222`; the container reaches it directly. Moved off `18788` and off Tailscale SSH on 2026-10-12: Tailscale SSH accepts a remote forward without binding it, and a session killed while holding one leaks the port. `18788`/`18789`/`18791`/`18792` were re-checked later the same day and are free; nothing was moved back |
| Conversation database | `/home/<runtime-user>/hepi-harness-deploy/state/hepi.sqlite` | WAL mode, same file the old unit used |
| Skill repository | `/home/<runtime-user>/hepi-harness-deploy/state/skill-repository.sqlite` | beside the conversation database |
| Backups | `/home/<runtime-user>/hepi-harness-deploy/backups/<timestamp>/` | database plus sidecars with `SHA256SUMS` |

The `sshd` that carries that reverse forward is this host's own, on port `2222` in addition to `22`: Tailscale
SSH intercepts the tailnet on `22` and its remote-forward implementation accepts a request without binding it, so
the tunnel connects on `2222` instead. That listener comes from an `ssh.socket` drop-in
(`/etc/systemd/system/ssh.socket.d/60-hepi-tunnel.conf`), because socket activation owns this host's listening
sockets; deleting the file and reloading `ssh.socket` removes it. It is **not** publicly reachable: this host's
`iptables` `INPUT` chain admits only `22`, `80`, `443` and `28443` and ends in a `REJECT`, while
`ts-input` accepts the `tailscale0` interface, so `2222` is a tailnet-only listener and no firewall rule was
added for it.

Both services run with `network_mode: host`, which is not a preference: the backend must reach the gateway's reverse
forward on the host's loopback, and a bridge container cannot. The processes bind `127.0.0.1` only, and Tailscale
Serve is the sole way in from the tailnet. `tailscale funnel` is unset, so nothing is exposed publicly; nginx on
`443`/`80` and every unrelated service were left untouched.

## Layout on the host

```

[202 more lines in file. Use offset=101 to continue.]