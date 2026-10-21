# Continuous integration

`.github/workflows/ci.yml` is the repository's CI: what runs on every pull request and branch push, what each job
needs, and what it deliberately does not verify. The [release workflow](releases.md) is separate and publishes on a `v*`
tag only — CI never publishes or deploys. Read [verification](verification.md) for the same checks under a developer's
own runner, and [agents/verification.md](agents/verification.md) for the rule every result follows.

## Toolchain and host

| Fact | Value |
| --- | --- |
| Runner | `ubuntu-24.04`, stated on every job |
| Node | `24` |
| pnpm | `12.4.1`, matching the root `packageManager` |
| Install | `pnpm install --frozen-lockfile` |
| Permissions | top-level `contents: read` and nothing else |
| Concurrency | `ci-<workflow>-<ref>`, `cancel-in-progress: true` |
| Timeouts | 20 (test, checks), 45 (browser), 30 (client-smoke, containers), 40 (native) |

The frozen lockfile is what makes a run reproducible: versions come from the lockfile, and an install that would edit it
fails. `cache: pnpm` on `setup-node` is only performance — it skips re-downloading an unchanged store, and a cache miss
resolves to the same tree. `pnpm/action-setup` runs **before** `setup-node`, which is the order that cache requires.
The image tag is pinned to a specific Ubuntu release rather than the floating `ubuntu-latest` so that an operating-system
change upstream cannot alter what a green run meant. No job writes to the repository, authenticates to a registry, or
reads a secret.

## Jobs

### `test` — the ordinary gate

`pnpm typecheck`, `pnpm -r test`, then the `@hepi/web`, `@hepi/app` and `@hepi/client` builds.

**Prerequisite:** OpenSSH server and `bubblewrap`. The gateway's shared SSH fixture runs a real `sshd` inside a `bwrap`
pid namespace (`packages/gateway/test/sshd-fixture.ts`). `HEPI_REQUIRE_SSH_SMOKE=1` makes a missing binary a failure
instead of a skip — a skip is never reported as a pass. This job is not free of host boundaries: it starts a daemon and
writes real files. It is the gate because those boundaries are short and deterministic; the jobs below need a browser, a
container runtime or a desktop toolchain.

### `checks` — the repository's own gates

`pnpm test:scripts`, `pnpm check:entrypoints`, `pnpm check:docs`, `pnpm test:web:unit`. No prerequisite beyond
dependencies.

The Web unit suite has its own job because `apps/web` declares no `test` script, so `pnpm -r test` never reaches it.
Only `test:web:unit` writes files (`.dev/verify/`: TAP plus raw log) — those are uploaded, and the other three checks are
read from the step's own log.

### `browser` — four browser journeys, one job

`pnpm --filter @hepi/web build`, `playwright install --with-deps chromium`, then four drivers as four sequential steps.

| Driver | The contract it protects |
| --- | --- |
| `chat/ux-chat-scroll.ts` | the transcript scrolls inside the page: the Tailwind utilities `packages/ui` emits are really in the built stylesheet, and the measured page bounds them |
| `chat/ux-references-acceptance.ts` | cross-session references over the real routes: create, follow, fork, refuse, remove, and a named limit during a real Backend outage and restart |
| `mcp-skills/ux-mcp-acceptance.ts` | MCP on the Web host through the ingress's own gateway: import, listing, invocation, and the SSH host's own named limit |
| `acceptance/ux-provider-connection-acceptance.ts` | provider connection states without a real provider: absent, refused, stored, revoked, each surfaced honestly, no credential in a console or log |

Each runs over the real shape — `apps/web/dist` served by the real client ingress on the same origin as `/api`, the real
Backend over SQLite files the run created, a real execution gateway, and one controlled completions endpoint in place of
a paid model. **Prerequisite:** OpenSSH server and `bubblewrap` (every driver starts the real execution gateway), plus
Chromium for the driver.

One job and sequential steps, not a matrix: install, build and the browser download are paid once, and the first real
failure stops the run instead of costing three more legs. Each driver writes its own log under `.dev/e2e/` and all four
are uploaded, on failure as well as success.

Every driver step declares `shell: bash`. This is load-bearing: GitHub's default non-Windows shell for a `run: |` step is
`bash -e {0}` with no `pipefail`, so `node … | tee …` reports `tee`'s status and a failed journey turns the job green.
`shell: bash` expands to `bash --noprofile --norc -eo pipefail {0}`. A separate step creates `.dev/e2e` first, because
`tee` into a missing directory is itself an exit 1. There are no retries: a retry would hide the failure the log exists
to show, and a rerun starts from the same state each time.

None of the four needs `apps/app/dist`.

### `client-smoke` — the packaged client runtime

`pnpm --filter @hepi/client build`, then `smoke:pack` with `HEPI_REQUIRE_SSH_SMOKE=1`. **Prerequisite:** OpenSSH server
and `bubblewrap`. This is the check that the packed tarball installs and works outside the checkout: the CLI's
help/version/doctor, a local execution gateway (read, command, MCP listing, worktree create/remove, a bad token and a
traversal path refused), and the SSH gateway against a real localhost `sshd` on a port this run owns. Separate from
`test` because it needs a real install plus `sshd` and an ephemeral port, not because it needs a browser.

### `containers` — the packaged backend

`bash deploy/docker/smoke.sh`, unchanged in substance. **Prerequisite:** `docker/setup-buildx-action`. The image is built
and run on a loopback-published ephemeral port with its own network, state directory and the caller's uid. The driver
asserts the authenticated model catalog answers 200, the same request without the token answers 401, no default model is
stated, a created conversation survives a restart on the same volume, and both SQLite files exist. The bearer token is
generated by the run (`smoke-*`), so no repository credential is read.

### `native` — the App shell's Rust tests

`pnpm --filter @hepi/app build`, then:

```
eval "$(node apps/app/scripts/cargo-build.mjs --profile=debug)"
cargo test --manifest-path apps/app/src-tauri/Cargo.toml
```

**Prerequisites:** WebKitGTK 4.1 and GTK libraries (the shell links them), `dpkg-dev` (the App package's offline-install
suite builds a throwaway `.deb` to exercise a real `dpkg` transaction rather than an extraction), and the frontend
bundle itself — `tauri.conf.json` sets `frontendDist` to `../dist`, and the build script fails with "The `frontendDist`
configuration is set to \"../dist\" but this path doesn't exist" when it is absent. That build is a prerequisite, not an
extra check.

The App package's own `node --test` suite is not repeated here: `test` already runs it through `pnpm -r test`, so a
second run would add no coverage. The Rust tests are deliberately the debug profile with the repository's own build
accounting — `CARGO_TARGET_DIR=<repo>/.dev/cargo-target`, `CARGO_BUILD_JOBS=6`, `CARGO_INCREMENTAL=1` — read from the
module that owns them rather than restated on a command line where a log could disagree with the guide. The cache covers
that target directory, keyed on `apps/app/src-tauri/Cargo.lock`, so a dependency change misses and an unchanged one
restores.

**The Rust tests touch no credential store.** `main.rs`'s tests call `normalize_connection`, `content_security_policy`
and `connection_script`; `save.rs`'s tests write under `std::env::temp_dir()`. The `keyring` functions are reached only
from commands a real shell session runs, so nothing in this job can read or write the host's Secret Service and no
`DBUS_SESSION_BUS_ADDRESS` guard is needed. The journeys that do need store isolation are below.

## What this workflow does not verify

| Not in CI | Why | Where it is verified |
| --- | --- | --- |
| The desktop journey (`ux-native-acceptance.ts`) and the offline-package journeys (`verify-artifacts.mjs`, `offline-install.mjs`) | no desktop session is provisioned: no window manager, no GTK/WebKit display, no Secret Service bus, no `dpkg` install root. Journeys use their own private session bus and isolated keyring (`scripts/lib/credential-sandbox.mjs`). Artifact verification owns display, fixtures, packaged processes and install roots through private `packaged-run.mjs`, completes teardown before returning its report, and records `runCleanup.completed` | developer host: those commands. `verify-artifacts.mjs` consumes a prebuilt artifact, including a debug build. Native functional measurements are recorded in [apps/app README](../apps/app/README.md) |
| The rest of `apps/web/e2e` | only the four drivers above are selected; the other live drivers need a browser plus a build of their own and are run from a developer host. The suite is grouped by theme (`acceptance/`, `chat/`, `history/`, `mcp-skills/`, `workbench-files/`, `terminal/`, `auth-shell/`), and the obsolete Next-dependent drivers were deleted with their dead scripts — their history stays in [verification](verification.md) | the four drivers here; the rest per [developer guide](developer-guide.md#appswebe2e-web) |
| A real provider, a paid model, a remote host, or a login flow | CI sends no turn to a provider and holds no provider account. Each driver's own fixture stands in; `containers` mints its own throwaway token | n/a — deliberately not a CI concern |
| That this workflow runs on GitHub's runners | GitHub-hosted execution was not available from this repository's development environment | [Running this locally](#running-this-locally) |

## Running this locally

```sh
pnpm install --frozen-lockfile
HEPI_REQUIRE_SSH_SMOKE=1 pnpm -r typecheck && HEPI_REQUIRE_SSH_SMOKE=1 pnpm -r test
pnpm --filter @hepi/web build && pnpm --filter @hepi/app build && pnpm --filter @hepi/client build
pnpm test:scripts && pnpm check:entrypoints && pnpm check:docs && pnpm test:web:unit
pnpm --filter @hepi/web exec playwright install --with-deps chromium
mkdir -p .dev/e2e && node apps/web/e2e/chat/ux-chat-scroll.ts 2>&1 | tee .dev/e2e/chat-scroll.log
node apps/web/e2e/chat/ux-references-acceptance.ts 2>&1 | tee .dev/e2e/references-acceptance.log
node apps/web/e2e/mcp-skills/ux-mcp-acceptance.ts 2>&1 | tee .dev/e2e/mcp-acceptance.log
node apps/web/e2e/acceptance/ux-provider-connection-acceptance.ts 2>&1 | tee .dev/e2e/provider-connection.log
HEPI_REQUIRE_SSH_SMOKE=1 pnpm --filter @hepi/client smoke:pack
bash deploy/docker/smoke.sh
pnpm --filter @hepi/app build && eval "$(node apps/app/scripts/cargo-build.mjs --profile=debug)" \
  && cargo test --manifest-path apps/app/src-tauri/Cargo.toml
```

The local delivery record for this workflow — command, revision, exit code and log path for every run behind the
statements above, including the pipeline and `frontendDist` probes — is
[.scratch/ux-closeout-research/ci-delivery-2026-10-20.md](../.scratch/ux-closeout-research/ci-delivery-2026-10-20.md).
It is evidence tied to those revisions, not a claim about the health of any run.

`pnpm verify` / `pnpm verify:changed` covers typecheck, the workspace tests and the Web unit suite for one revision with
per-step raw logs; `browser`, `client-smoke`, `containers` and `native` are outside that selector because they are not
cheap, deterministic or host-independent.
