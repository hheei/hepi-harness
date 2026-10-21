# Tag releases

`.github/workflows/release.yml` publishes the npm client and the backend GHCR image on a pushed `v*` tag. A tag such as
`v0.1.1` must equal the client package version. Prereleases such as `v0.2.0-rc.1` use npm `next`; stable releases use
`latest`. Only one image exists: the backend. The Web origin is the client ingress — a released directory plus a
systemd unit, not an image — so there is no Web artifact to publish or pull
([client-runtime release](client-runtime-release.md)). The workflow's `docker` job builds exactly one image from
`deploy/docker/backend.Dockerfile` in a single step: the `[backend, web]` matrix that would have named the deleted
`web.Dockerfile` was removed on 2026-10-20, so no release run names a Web image that does not exist. Images use exact version and commit
SHA tags, without a moving Docker `latest` alias. GHCR tags are mutable; use an image digest
when deployment must pin content. npm name/version pairs cannot be reused.

## One-time package bootstrap

This checkout currently has no Git remote. Choose the owning GitHub repository and npm scope before publishing;
`@hepi/client` is the provisional package name. Changing its scope requires updating the package name and workflow
filters together. The release builds set `repository.url` to the actual GitHub repository automatically.

**An npm Trusted Publisher requires an existing package.** The first package version cannot be created by this
OIDC workflow. Create it once from a maintainer's local authenticated session; no npm token is added to CI.
The current staged-publishing procedure is:

1. Own the chosen npm scope, enable account 2FA, and put `release.yml` in the actual GitHub repository.
2. Set the package repository metadata to that repository. For the provisional first version, from the checkout run
   `GITHUB_REF_NAME=v0.1.0 GITHUB_REPOSITORY=owner/repo node scripts/release-plan.mjs --prepare-package`, replacing
   `owner/repo` with the actual repository.
3. With Node 24 and npm 11.21.0, run `npm login` locally. Build with `pnpm --filter @hepi/client build`, then
   `npm pack ./packages/client --pack-destination <temporary-directory>`.
4. Run `npm stage publish <tarball-path> --access public`. npm creates a publicly visible `0.0.0-stage` placeholder
   and stages the real version. In npmjs.com's **Staged Packages** tab, inspect and approve it with 2FA. This publishes
   the first version, for example `0.1.0`. A local interactive `npm publish` is also a supported bootstrap option.
5. Configure the Trusted Publisher below. Bump the client to a **new** version, for example `0.1.1`, before the first
   CI tag release; tagging the already bootstrapped `0.1.0` would fail because npm versions cannot be republished.

In npm package settings, add a GitHub Actions Trusted Publisher with:

| Field | Value |
| --- | --- |
| Organization or user | Actual GitHub owner |
| Repository | Actual repository name |
| Workflow filename | `release.yml` (no directory prefix) |
| Environment | `npm-release` |
| Allowed action | Allow direct `npm publish` |

Create the matching `npm-release` GitHub environment. No required reviewer is configured by these files.
The workflow uses GitHub-hosted Ubuntu, Node 24, npm 11.21.0 and `id-token: write`. Do not add `NPM_TOKEN` or
`NODE_AUTH_TOKEN`; OIDC credentials are minted per run. New Trusted Publisher configurations default to staged
publishing only, so direct publication must be selected. Complete the first successful OIDC publish within 48 hours
of configuring trust, or the unvalidated configuration expires. See the [cited registry requirements](research/npm-trusted-publishing.md).
Automatic npm provenance requires both a public source repository and a public npm package.

GHCR uses the workflow's short-lived `GITHUB_TOKEN` with `packages: write`, without a separate registry secret.
The image is `ghcr.io/<owner>/<repo>/backend:<version>`. After first publication, set package visibility to public if
deployments must pull anonymously.

The repository has no root license grant. The client keeps its own code `UNLICENSED` and includes notices for copied
upstream code; choose an explicit project license if you want users to receive broader rights.

## Release sequence

1. Update both `packages/client/package.json` and `packages/client/src/version.ts`, regenerate the root lockfile,
   and commit the release changes. The build rejects version drift.
2. Inspect the npm package versions and `latest`/`next` tags; choose an unpublished version newer than the intended
   channel. Check that its Git tag has never been used. These are operator checks; tag validation does not query the
   registry or prevent an intentional downgrade of a dist-tag.
3. Run client tests, packed-install smoke and container smoke; inspect their recorded limits.
4. Push the reviewed commit and its matching version tag to the owning GitHub repository.
5. Inspect the Release workflow: verification must pass before publishing starts.
6. Install the published package and pull the exact-version images to verify registry delivery.

The verification job tests the workspace, builds the client, installs its tarball in a clean directory, and uploads
the tarball. The npm job publishes that artifact rather than rebuilding it. Docker builds the backend image for both
Linux AMD64 and ARM64 from the same tagged commit. Provider credentials are runtime configuration, never build
arguments.

Publication is not atomic across npm and GHCR. If one job succeeds and another fails, rerun only the failed job.
Rerunning a successful npm publication fails; rerunning Docker can replace tags even for the same source commit.
Never move a published Git tag to another commit. Fix release content under a new version. Deployment is separate
from publication: pushing a tag does not restart a backend or migrate its database.

## Rollback

Install an earlier client explicitly, for example `npm install --global @hepi/client@0.1.0`, and select an earlier
backend image digest or exact version tag in Compose. Substitute the actual package scope. A Web origin rolls back by
re-pointing its unit at the previous `release-<artifact-id>` ([client-runtime release](client-runtime-release.md)).
Back up SQLite before upgrading; rolling back an image does not roll back schema or contents. Keep backend state on the
persistent Compose volume and run one writer per database. See [container deployment](container-deployment.md).

If maintainers also need new installations to receive an earlier stable client, use an authenticated local session
to run `npm dist-tag add @hepi/client@0.1.0 latest`. This changes registry metadata and requires maintainer access.
An OIDC dist-tag operation would additionally require the separate **Allow npm dist-tag** permission; this workflow
only performs publication. Deprecating a broken version with `npm deprecate` is another explicit maintainer action.

## Verification boundaries

Local tests verify packing, startup, networking and persistence. They cannot prove npm Trusted Publisher identity or
GHCR permissions without running on the configured GitHub repository. No registry publish, remote push or production
service change is performed as part of implementing these files.
