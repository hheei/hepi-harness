# Split execution-resource smoke (real localhost SSH + real model)

**Historical record — one dated operator smoke, not a current check.** It needs a paid credential and a real `sshd`, so
it is not in `pnpm -r test` and has not been re-run since. The script it names,
`apps/server/scripts/split-resources-smoke.ts`, still exists. For current entrypoints see
[docs/verification.md](verification.md).

One real run of the split topology on this workstation: the harness acts as client, a **separate backend process**
serves the agent, a **separate gateway process** reaches a **real temporary `sshd`** over real SSH, and the model is
the operator's live DeepSeek endpoint. This is an operator smoke, not a CI test: it needs a credential and a working
OpenSSH daemon, so it runs only from the repository with the operator env file present.

| Item | Value |
| --- | --- |
| Script | `apps/server/scripts/split-resources-smoke.ts` (`node apps/server/scripts/split-resources-smoke.ts`) |
| Result | **PASS — 77/77 checks, 0 failures** (packaged-CLI gateway and `--gateway-src` gateway) |
| Model | `magpie/deepseek-v4.1-flash`, a real remote OpenAI-completions endpoint; **5 model turns** |
| Backend | separate process, `apps/server/src/main.ts`, Pi config (`HEPI_CONFIG_SOURCE=pi`), ephemeral SQLite |
| Gateway | separate process: packaged `@hepi/client` CLI (`packaged-cli`), or `packages/gateway/src/main.ts` with `--gateway-src` |
| SSH | real `/usr/sbin/sshd` (OpenSSH 9.6p1) on an ephemeral loopback port, its own host key and `AuthorizedKeysFile`, `StrictHostKeyChecking=yes`, identity pinned with `IdentitiesOnly=yes` |
| Remote account | the real login on this machine; the remote **home is the developer's own home, read only** |
| Writes | only `$TMPDIR/hepi-split-smoke-*/workspace` (unique per run) and the run's own temp sshd state |
| Docker | **not used here.** The container path belongs to `deploy/` and `deploy/docker/smoke.sh`; a local daemon is present (29.6.2) but is not exercised by this script |

## What it proves

**1. The daemon is real and the host key is pinned (6 checks).** A control `ssh` with the fixture known-hosts file
reaches the daemon and reports the real account and home, and runs in the fixture workspace. The **same connection with
an empty known-hosts file is refused**, and the recorded argv is asserted to contain no
`StrictHostKeyChecking=no` / `UserKnownHostsFile=/dev/null`: host verification is on, not merely configured.

**2. Remote discovery, exact reads, remote script (19 checks).** The first turn read a file at its **absolute remote
path** and got the file's exact bytes, and read a skill in the **real account home** (`~/.agents/skills/...`) and got
its exact bytes — the backend resolved the remote home, so both the workspace catalog (`skill:deploy`, `ship`) and the
account-home skills (`open-code-review`, `open-code-review-delegate`, `research`) were discovered from the host. The
second turn ran the fixture's own script through the gateway bash tool and got its output.

**3. Live skill body versus committed prompt template (22 checks).** After editing both files on the host, a
`/skill:deploy` expansion already showed the edited body (read from the host at expansion time) while the catalog
membership was unchanged, and `/ship` still expanded the **committed** v1 text with `$@` substituted. An explicit
Reload returned 200 and the next `/ship` expanded v2 with v1 gone, and no legacy `pi-resource://` URI appeared.

**4. Install, zero-byte file, confirmed update, retained backup (16 checks).** A published bundle installed into the
**remote workspace** scope; reads through the gateway file RPC returned the published bytes; a **zero-byte published
file installed as an empty file** and the directory held exactly `SKILL.md, empty.txt, notes.md`. Editing the installed
`notes.md` made the host report `locally-modified`; an unconfirmed update answered **409**; the confirmed update
(pinned to the inspected digests) returned the retained backup path at `<workspace>/.agents/split-bundle.bak`, that
directory holds the locally modified bytes, and the installed directory is back to the published bytes with the
zero-byte file still empty.

**5. sshd stopped mid-deployment (14 checks).** With the daemon stopped: the conversation that already adopted keeps
its committed resource state and its command list (served from committed state, not re-derived); an explicit Reload
fails **explicitly with 500** and names the transport (`ssh filesystem outcome unknown`), leaving the adopted state
intact; a **fresh conversation** cannot load at all (500) and **no harness-local or gateway-local resource stands in
for the host** — the failure carries no local path. The durable replay checks then confirm stream/state agreement, the
successful results the smoke relied on, and that no submitted entry names a checkout path or a legacy URI.

**Finally:** the real account resource directories (`~/.agents/skills`, `~/.pi/agent/skills`) are **byte-identical** to
before the run, so the developer's own resources were not modified.

## Credential and cleanup hygiene

The credential is read from `HEPI_SMOKE_ENV_FILE` (default `/tmp/hepi-backend.env`) in memory and copied into a
mode-0600 temporary Pi agent directory outside the repository. Everything logged passes a sanitizer: the api key and
base URL are redacted along with the run's own tokens, and stack traces are never printed. Only the provider id and
model id are shown. Child processes start from an **allowlist environment**, so no ambient `HEPI_*`/`PI_*` value leaks
into a role. The fixture's own sshd is the only daemon touched; the developer's `~/.ssh` is not read or written, and no
live SSH host or system sshd is involved.

A deliberately broken env file (unroutable base URL, marker secret) was used to check both the sanitizer and the
cleanup: the run failed its checks, **neither the marker nor the endpoint appeared in the output**, and no spawned
process, daemon or fixture directory was left behind.

## Validation commands

```bash
pnpm -r typecheck                                 # clean
pnpm --filter @hepi/server test                   # 70/70
node apps/server/scripts/split-resources-smoke.ts                # PASS 77/77 (packaged-CLI gateway when built)
node apps/server/scripts/split-resources-smoke.ts --gateway-src  # PASS 77/77 (repository gateway entrypoint)
```

`--keep` leaves the fixture for inspection. Without it the fixture, the daemon, and both child processes are removed
in a `finally` block that also covers a thrown failure.

## Limits and not claimed

- **One host, one account, one workspace, one gateway, one backend, one model endpoint.** The remote account is this
  developer's login; a multi-tenant or differently-permissioned host is not exercised.
- **No Docker.** The container deployment and its `deploy/docker/smoke.sh` are a separate deliverable; this script does
  not build, run, or verify images, and it makes no claim about the container topology.
- **No external registry, no publish, no remote host, no system sshd.** Nothing here pushes an artifact or touches
  `remote-host` or any other deployment.
- **The remote-termination guarantees are unchanged** and are covered by `docs/ssh-interruption-verification.md` (real
  sshd; cancellation, timeout and connection loss all report `outcome-unknown`); this smoke does not restate them.
- **The model's own tool choices are not asserted.** A failed extra call is noted with its tool name, not failed;
  every result the smoke relies on is asserted positively.
- **`packages/client` must be built for packaged-CLI mode**; the script falls back to the repository gateway
  entrypoint when `packages/client/dist/cli.js` is absent, and records which one ran.
