# Client and container distribution

Status: complete (local implementation and verification). This is the approved scope as written; **nothing has been
published** — npm and GHCR publication remain unexecuted, and the current package/container state is in
[docs/releases.md](../../docs/releases.md) and [docs/container-deployment.md](../../docs/container-deployment.md).
User approved npm local client, standard Docker deployment, and CI releases following version
tags. npm publication must use Trusted Publishing/OIDC without a stored npm token. Baseline: `cb52734`.

## Deliverables

- A public-installable client tarball, provisionally `@hepi/client`, providing a CLI around the existing local/SSH
  gateway and a configuration/connectivity diagnostic. Preserve upstream implementations and license notices.
  Installation must work outside this checkout; no published `workspace:*`, checkout paths, or build-time tooling.
- Backend and Web Dockerfiles with locked dependencies, runtime configuration, health checks and persistent backend
  SQLite storage. Linux Compose retains the existing loopback SSH tunnel topology through host networking.
  Containers package deployment; trusted execution policy stays at the ExecutionEnvironment abstraction.
- CI checks on pull requests and branches. A pushed SemVer `v*` tag must match the client version before any publish.
  Stable npm releases use `latest`, prereleases use `next`. GHCR backend/web images carry exact version and SHA tags
  and build for Linux AMD64 and ARM64.
- npm publish runs on GitHub-hosted runners in `release.yml`, environment `npm-release`, with `id-token: write`.
  GHCR uses the workflow's ephemeral `GITHUB_TOKEN`. No npm token fallback, no production auto-deployment.
- Official cited documentation for Trusted Publisher setup and new-package bootstrap; instructions for runtime,
  tag release and rollback. No Git remote is currently configured, so account/repository/scope setup remains external.

## Acceptance

- Pack and install the client in an isolated directory; exercise CLI help, configuration diagnostics and actual
  authenticated gateway file/command operations without reaching checkout dependencies.
- Build both container images, start isolated fixtures, prove authenticated backend and UI readiness, and prove
  backend state remains after restarting the writer against the same volume.
- Run a real localhost OpenSSH daemon with isolated keys and pinned known hosts, use the packaged client's SSH
  gateway mode and a separate backend process, and exercise execution resources using real DeepSeek. Verify remote
  project discovery, exact file reads, script execution, Reload, installation, confirmed update, retained backup,
  empty files and unreachable-target failure without harness-local fallback. Do not modify the developer's account
  resource directories or existing services.
- Release workflow lint and tag validation tests pass; workspace typechecks and relevant tests pass. Existing whole
  Web-suite failures are recorded rather than expanded into unrelated fixes.
- No external registry publish or production oracle deployment is claimed without executing it. GitHub/npm account
  identity cannot be verified locally; setting the owning repository and npm Trusted Publisher is an operator step.

## Ownership

Coordinator owns `.github/workflows`, `scripts/release-plan.*`, root lockfile, release docs and integration checks.
Client worker owns `packages/client`. Container worker owns `deploy`, `.dockerignore`, container docs. SSH smoke worker
owns `apps/server/scripts/split-resources-smoke.ts` and distribution smoke evidence. Research worker owns cited npm
Trusted Publishing findings. Reviewers inspect standards and acceptance against this spec.
