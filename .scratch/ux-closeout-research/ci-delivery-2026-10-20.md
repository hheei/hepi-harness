# CI delivery evidence — 2026-10-20

Raw local runs behind [docs/ci.md](../../docs/ci.md). Tied to the revisions and timestamps below; it establishes what
was measured at this date, not the health of any later run or of any GitHub-hosted execution.

Branch `ci/current-stack`, commits `478a7b3` → `6f664b5` → density pass, branch base `2b1cdf2`, rebased onto main
`377e4ee` (main tip at handoff `36ba13d`, not rebased again; the parent cherry-picks the owned commits).

## Group A — this worktree at base `2b1cdf2`, CI/docs edits uncommitted, 21:30–21:35 and 22:09–22:12

The three files this change touches (`.github/workflows/ci.yml`, `docs/ci.md`, `docs/README.md`) are read by no command
below except the two documentation checks, so the commands exercised the same code as the branch tip.

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | | `/tmp/ci-install.log` |
| `pnpm -r typecheck` | 0 | all projects Done | `/tmp/ci-tc.log` |
| `HEPI_REQUIRE_SSH_SMOKE=1 pnpm -r test` | 0 | app 26, gateway 166, server 357 pass; 0 fail | `/tmp/ci-test.log` |
| `pnpm --filter @hepi/web build` | 0 | | `/tmp/ci-webbuild.log` |
| `pnpm --filter @hepi/app build` | 0 | | `/tmp/ci-appbuild.log` |
| `pnpm --filter @hepi/client build` | 0 | | `/tmp/ci-clientbuild.log` |
| `pnpm test:scripts` | 0 | | `/tmp/ci-scripts.log` |
| `pnpm check:entrypoints` | 0 | 158 present, 0 newly missing | `/tmp/v2-entry.log` |
| `pnpm check:docs` | 0 | 0 broken links, 0 uncovered guides | `/tmp/v2-docs.log` |
| `pnpm test:web:unit` | 0 | 14 pass / 0 fail | `/tmp/ci-webunit.log`, `.dev/verify/2026-10-20T13-30-37-949-web-unit/` |
| `node apps/web/e2e/ux-chat-scroll.mjs` | 0 | all checks passed | `/tmp/ci-browser2.log` |
| `node apps/web/e2e/ux-references-acceptance.mjs` | 0 | 45 checks, 0 failures | `/tmp/ci-refacc.log` |
| `node apps/web/e2e/ux-mcp-acceptance.mjs` | 0 | 58 checks, 0 failures | `/tmp/ci-mcpacc.log` |
| `node apps/web/e2e/ux-provider-connection-acceptance.mjs` | 0 | 64 checks, 0 failures | `/tmp/ci-provacc.log` |
| `node apps/web/e2e/ux-client-acceptance.mjs` | 0 | 58 checks | `/tmp/ci-clientacc.log` |
| `node apps/web/e2e/ux-native-acceptance.mjs` | 0 | 27 checks — developer-host desktop journey, not a CI job | `/tmp/ci-nativeacc.log` |
| `node apps/web/e2e/ux-ssh-project.mjs` | 0 | 31 checks | `/tmp/ci-sshproj.log` |
| `HEPI_REQUIRE_SSH_SMOKE=1 pnpm --filter @hepi/client smoke:pack` | 0 | 6 checks incl. real localhost sshd | `/tmp/ci-smokepack.log` |
| `bash deploy/docker/smoke.sh` | 0 | all checks passed | `/tmp/ci-smoke.log` |
| `pnpm --filter @hepi/app test` | 0 | 26 pass / 0 fail | `/tmp/ci-apptest.log` |
| `cargo test --manifest-path apps/app/src-tauri/Cargo.toml` under the debug profile | 0 | 9 pass / 0 fail | `/tmp/ci-cargo.log` |
| `HEPI_REQUIRE_SSH_SMOKE=1 pnpm --filter @hepi/gateway test:acceptance` | 0 | 495 pass | `/tmp/ci-gwacc.log` |
| `HEPI_REQUIRE_SSH_SMOKE=1 pnpm --filter @hepi/server test:acceptance` | 0 | 566 pass | `/tmp/ci-serveracc.log` |
| `pnpm verify` (full), `pnpm verify:changed` | 0 / 0 | reports under `.dev/verify/2026-10-20T13-42-04-616-verify-full/`, `…13-43-32-608-verify-changed/` | `/tmp/ci-verify.log`, `/tmp/ci-changed.log` |

## Group B — `478a7b3`

| Command | Exit | Log |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` (clean detached worktree `/tmp/rebase-check`) | 0 | `/tmp/rb-install.log` |
| `pnpm --filter @hepi/web exec playwright install chromium` | 0 | `/tmp/rb-pw.log` |
| `pnpm --filter @hepi/web build` | 0 | `/tmp/rb-build.log` |
| `node apps/web/e2e/ux-chat-scroll.mjs` | 0 | `/tmp/rb-e2e.log` |
| `pnpm check:entrypoints` (rebased tree, `/tmp/rebase-check`) | 0, 157 present | `/tmp/fix-entry.log` |
| `pnpm check:docs` | 0, 444 files | `/tmp/fix-docs.log` |

## Group C — the final job shape (this worktree, 22:28–22:5x)

The shape itself was exercised, not a runner. The workflow's structure was verified by parsing `ci.yml` and asserting
each job's `runs-on`, absence of `strategy`, timeouts, step order and the four `shell: bash` driver steps.

| Probe | Result | Log |
| --- | --- | --- |
| Four drivers chained in one `bash --noprofile --norc -eo pipefail` script into a fresh `.dev/e2e/` | 0; four logs written 1.4K / 4.4K / 5.9K / 6.0K | `/tmp/browser-seq.log`, `.dev/e2e/*.log` |
| Failing command left of `| tee` under that shell, followed by a second command | pipeline exit 3, second command did not run | `/tmp/chain.out`, `/tmp/chain-first.log` |
| The same failing driver under GitHub's default `bash -e` | exit 0 — the bug `shell: bash` prevents | `/tmp/probe-real2.out` |
| `node -e "process.exit(7)" 2>&1 \| tee …` under default `bash -e` vs `bash -eo pipefail` | 0 vs 7 | `/tmp/probe-a.out`, `/tmp/probe-b.out` |
| `tee` into a directory that does not exist | exit 1 (`mkdir -p .dev/e2e` step exists for this) | probe |
| `pnpm --filter @hepi/app build` then `cargo test`, in that order | 0 / 0, 9 pass | `/tmp/native-build.log`, `/tmp/native-cargo.log` |
| `cargo test` with `apps/app/dist` moved away | exit 101, "The `frontendDist` configuration is set to \"../dist\" but this path doesn't exist" — the failure the old `native` job carried | `/tmp/nodist-cargo.log` |
| `pnpm store path` | `/home/developer/.local/share/pnpm/store/v11` — the store `cache: pnpm` restores | — |
| Rust credential audit: `main.rs` tests call `normalize_connection`, `content_security_policy`, `connection_script`; `save.rs` tests use `std::env::temp_dir()`; no test reaches `keyring_entry` | no host credential touched, so no `DBUS_SESSION_BUS_ADDRESS` guard added | source |

## Deliberate failures observed, not repaired

| Command | Exit | Why it is recorded rather than fixed |
| --- | --- | --- |
| `pnpm --filter @hepi/web lint` | 2 | ESLint 9 finds no flat config (`eslint.config.js`) in `apps/web`. Pre-existing; no CI job runs it. |
| `node apps/web/e2e/ux-truthfulness.mjs` | 1 | Asserts `.next/BUILD_ID` from the retired Next tooling. One of the 34 unselected drivers. |
| `node apps/web/e2e/ux-agent-definitions.mjs` | 1 | Spawns a `next` binary the workspace no longer has. Same set. |

## Not run in any group, and therefore not claimed

Any GitHub Actions execution of this workflow: the `ubuntu-24.04` runner label, `actions/checkout@v6`,
`actions/setup-node@v6`, `pnpm/action-setup@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`,
`docker/setup-buildx-action@v3`, and every `apt` step (the prerequisites were already installed on this host, so the
`if ! test -x …` branches never ran). The pnpm cache and the cargo cache were likewise never exercised as caches.

## Hosted CI observation — attempted 2026-10-20 (read-only, no run available)

The six-job workflow in this checkout has **no observable GitHub-hosted run**, and this is a concrete tool/remote
result rather than an omission:

| Probe | Result |
| --- | --- |
| `git remote -v` in this worktree and in the main checkout | empty output, exit 0 — zero `remote.*` config keys, so the repository has no origin to ask GitHub about |
| `gh run list --limit 1` (in the worktree, gh account `hheei`, token scopes `repo`, `read:org`, `gist`, `admin:public_key`) | exit 1, `failed to determine base repo: no git remotes found` |
| `gh run list --repo hheei/hepi-harness` | exit 1, HTTP 404 `Not Found` on `/repos/hheei/hepi-harness/actions/runs`; `gh api repos/hheei/hepi-harness` answers 404 as well |
| `gh api repos/hheei/hepi-mono/actions/workflows` | exit 0, two workflows: `CI` and `Release` — the only repository reachable from this account that carries a CI workflow |

`hheei/hepi-mono` is **not** this repository's CI. Its `ci.yml` is a single `check` job on `ubuntu-latest` with
`actions/*@v4`, Node 22.19.0 and `pnpm run build`/`validate:packages`/`check`; it has none of this workflow's six jobs
(`test`, `checks`, `browser`, `client-smoke`, `containers`, `native`), no `shell: bash` driver steps, no artifact upload
and no `ubuntu-24.04` pin. Using its runs as evidence would measure a different workflow, so they are not recorded as
this workflow's evidence. The latest `main` run it does have, only to make the lookup complete: `c8ec99a`
(2026-10-20T10:37:27Z → 10:40:10Z, run duration 163,000 ms, its one `check` job success in ~160 s,
<https://github.com/hheei/hepi-mono/actions/runs/39409244611>).

Therefore these stay **unobserved for this workflow**: the `ubuntu-24.04` runner label, `actions/checkout@v6`,
`actions/setup-node@v6`, `pnpm/action-setup@v4`, `actions/cache@v4` restore/save, `actions/upload-artifact@v4`,
`docker/setup-buildx-action@v3`, every `apt` branch, and the per-job conclusions, durations and artifacts of the six
jobs. No push, remote trigger or workflow dispatch was performed to obtain them — the workflow has no manual dispatch,
and this record does not create one. Connecting this checkout to its owning GitHub repository is the prerequisite that
retires this gap; nothing else in the record depends on it.
