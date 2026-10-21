# Distribution verification

Dated evidence: measured at baseline `cb52734` on integration branch `integration/execution-resources`; counts are
frozen at that pin. Current checks: [docs/verification.md](../../docs/verification.md).

| Check | Evidence |
| --- | --- |
| Frozen dependency installation | Root client importer committed in `6e5bc40`; `pnpm install --frozen-lockfile` passes |
| Workspace types and tests | Protocol 10, session 3, gateway 59, server 70, client 9; no failures |
| Release workflow validation | actionlint 1.7.11 passes CI and Release workflows; release-plan 3 tests pass |
| Packed client outside checkout | `30a97a9` plus final notice correction: 6/6 checks, clean npm install, help/version, doctor, authenticated local and required real localhost SSH gateway operations |
| Backend and Web containers | `a1631dd`: both AMD64 builds, Docker smoke 14/14 including authenticated UI proxy, persistent conversations and both databases; both Compose profiles verified from copied example env |
| ARM64 | Both images build under QEMU; backend catalog, builtin SQLite and node-pty prebuild load; native hardware session untested |
| Real model and SSH resources | Worker `2c7462e`: 77/77 checks in each packaged-CLI and source-gateway mode, DeepSeek 5 turns per run, separate processes and actual localhost OpenSSH |
| SSH smoke cleanup | Broken-provider fixture emits no marker secret or endpoint and leaves no child processes; account resource files remain byte-identical |
| npm setup documentation | `bc08648` primary-source research; `6e5bc40` explicit local staged bootstrap, subsequent new-version OIDC tag release, exact-version rollback and registry-tag mutability |

Review follow-ups complete: `30a97a9` replaces hardcoded package identity, cleans failed child startup and requires
SSH in CI. It rejects inconsistent SSH workspace IDs, sanitizes malformed config errors and probes journal write
access. `a1631dd` corrects bridge routing through Compose service DNS, limits Web environment to its own values,
supports published image references and host ports, and excludes nested app env files.

Final standards correction includes Matthew Lam's pi-gui MIT copyright and the pi-coding-agent adaptation identity
in the bundle and tarball notices. The new smoke assertion failed against the old bundle, then passed after rebuilding.
Clean tarball installation and all six checks, including real SSH, passed with `HEPI_REQUIRE_SSH_SMOKE=1`. Build tooling
now imports its declared esbuild dependency directly. Container docs specify Compose 2.24.4 or newer.

Review result: Spec axis accepted the final behavior at `a1631dd`; Standards axis's missing bundled notice was fixed
and proved by the packed-artifact assertion. Duplicate PR/branch CI runs remain a deliberate cost trade-off so branch
pushes and fork PRs both receive checks. Registry version freshness remains an explicit release operator check.

No GitHub workflow was executed remotely, no registry publication occurred, and no production `remote-host` service was
changed. The checkout has no remote and `@hepi/client` is provisional. Owning repository, npm scope, initial package
creation and Trusted Publisher binding are external account configuration steps. Whole upstream Web tests retain
the previously recorded 21 baseline failures; this work does not claim they pass.
