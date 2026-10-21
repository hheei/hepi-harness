# npm trusted publishing: primary-source constraints

Date: 2026-10-09 (sources retrieved 2026-10-09/10, UTC).

**Dated research record — primary sources retrieved on the dates cited, kept as evidence.** The bootstrap sequence is
implied, not executed: nothing has been published to npm from this repository, and the registry pins under
`[registry-check]` were the state on that date. npm's own docs remain authoritative and move independently. Operational
steps derived from this live in [docs/releases.md](../releases.md); current checks in [docs/verification.md](../verification.md).
Question: what does the npm registry (and GitHub Actions) actually require to publish this repository's client
package token-free with OIDC, including the first publish of a new package, allowed workflow shapes, runner/npm
versions, and provenance/visibility limits?
Scope: read-only research. No publication, no workflow run, no CI or account change was performed.

Every claim below is cited to the primary source that owns it. Secondary write-ups (GitHub issue threads) are used
only where they are the first-party record of a limitation npm has not documented elsewhere, and are marked as such.

## Essential constraints (read this first)

1. **A trusted publisher only publishes a package that already exists.** The npm CLI refuses to *create* a trust
   relationship for a missing package ("Package must exist"), and the npmjs.com Trusted Publisher UI lives in an
   existing package's settings. A brand-new package therefore cannot go live *directly* via OIDC on its very first
   version. Bootstrap is one of: a manual/first-token publish, or (since 2026-10-02) one `npm stage publish` with a
   local session or a granular access token — including a **stage-only** token — which creates the package with a
   placeholder version `0.0.0-stage` and puts the real version in the staging queue for a maintainer to promote. Only
   after the package exists can the trusted publisher be configured. [npm-tp] [npm-trust] [npm-stage] [changelog-new-pkg]
2. **The workflow must match the publisher configuration exactly, case-sensitively.** GitHub Actions fields:
   organization/user, repository, **workflow filename only** (`release.yml`, must end `.yml`/`.yaml`, must exist
   under `.github/workflows/`), and an optional environment name. Errors surface only at publish time as `ENEEDAUTH`
   or a misleading `404`. [npm-tp]
3. **`repository.url` in package.json must exactly match the GitHub repository** that runs the workflow, and
   `id-token: write` must be set on the publishing job. Self-hosted runners are unsupported. [npm-tp] [gh-oidc]
4. **Automatic provenance needs all three of: OIDC publish, a public repository, and a public package.** OIDC from a
   private repo gets no attestation, even for a public package. Scoped packages are private by default, so an explicit
   `--access public` is required. [npm-tp] [npm-provenance] [npm-publish]
5. **A freshly created trusted publisher expires 48 hours after creation** unless it completes its first successful
   publish, which validates it and pins it to the repository's immutable identity. Expired configurations cannot be
   edited, only deleted and recreated. [npm-tp] [changelog-expiry]
6. **Events `pull_request_target` and `issue_comment` are rejected.** Publish from `push`, `release`, or
   `workflow_dispatch`. [changelog-expiry]
7. **Minimum versions: npm CLI 11.5.1 and Node 22.14.0.** Staged publishing and the `npm trust` command need npm
   `11.15.0`; OIDC `npm dist-tag` needs npm `11.21.0` (or `12.2.0`). `ubuntu-latest` (= Ubuntu 24.04) ships Node
   22.23.3 with **npm 10.9.9 — too old** — so the workflow must upgrade npm explicitly. [npm-tp] [npm-stage] [npm-trust] [runner-images]
8. **This checkout has no Git remote and `@hepi/client` is provisional.** The npm scope must be owned by the account
   or org, and `repository.url` must name the real GitHub repo. Nothing in the workflow can create an npm account,
   grant scope ownership, or configure package trust. (Repo state checked locally; see §8.)

## 1. Versions: runner image, Node, npm

| Item | Value | Source |
| --- | --- | --- |
| Trusted publishing minimum | npm CLI `>= 11.5.1`, Node `>= 22.14.0` | [npm-tp] |
| Staged publishing / `npm trust` minimum | npm CLI `>= 11.15.0` | [npm-stage] [npm-trust] |
| OIDC dist-tag minimum | npm CLI `11.21.0` or `12.2.0` | [npm-tp] |
| `ubuntu-latest` image | Ubuntu 24.04 (x64) | [runner-images] |
| Ubuntu 24.04 preinstalled | Node.js `22.23.3`, npm `10.9.9` | [runner-images-u24] |
| Node 22.14.0 release | Node 22.14.0 (2025-02-11) bundled npm `10.9.2` | [node-dist] |
| Node 24 line | v24.21.0 = latest 24.x LTS (2026-09-07), bundled npm `11.19.0` | [node-dist] |
| npm registry (examples) | `11.5.1` 2025-07-24; `11.15.0` 2026-05-20; `11.21.0` 2026-09-30; `12.2.0` = `latest` 2026-09-30 | [npm-packument] |

Consequence for this repository: pinning the image and Node is not enough. The preinstalled npm is below every
threshold, and even Node 24's bundled npm (`11.19.0` at v24.21.0) is below the `11.21.0` needed for OIDC dist-tag
management. Upgrade npm inside the job (`npm install --global npm@<version>`) or vendored tooling must be pinned.

## 2. Trusted publisher configuration (GitHub Actions)

- Fields on npmjs.com → package → Settings → Trusted publishing: **Organization or user** (required), **Repository**
  (required), **Workflow filename** (required; filename only, not a path; must include `.yml`/`.yaml`; the file must
  exist in `.github/workflows/`), **Environment name** (optional), **Allowed actions** (optional). [npm-tp]
- All fields are case-sensitive and must match exactly; npm does **not** validate the configuration when saved, so
  mismatches only appear at publish time. [npm-tp]
- Each package may have up to 10 connections; connections are additive and independent — a publish is authorized if
  the OIDC token matches any one. Evaluation order is not guaranteed, so never build logic on which one matched.
  Existing connections cannot be edited: delete and recreate to change them. [npm-tp] [changelog-multi]
- Configurations created before 2026-05-20 allow `npm publish` only; those created before 2026-09-03 require an
  explicit allowed action; those created after 2026-09-03 default to **stage publish only**, with direct publish
  opt-in. [npm-tp] [changelog-multi]
- CLI equivalent (`npm trust github <package> --file release.yml [--repo owner/repo] [--env name] [--allow-publish]
  [--allow-stage-publish]`): npm `>= 11.15.0`, account-level 2FA, write access to the package, no bypass-2FA GAT,
  and **the package must already exist**; at least one permission flag is required; `--file` must end `.yml`/
  `.yaml` and be a bare filename (no path); the repository is inferred from `repository.url` when `--repo` is
  omitted. [npm-trust] [npm-cli-trust-github]
- Documentation drift: the `npm trust` manual still says "the registry only supports one configuration per package",
  which contradicts the current registry behaviour and the trusted-publishers page (up to 10). Treat the CLI text as
  stale. [npm-trust] [npm-tp]

## 3. First publish of a new package (bootstrap)

- Trusted publishing cannot create a package. npm's own CLI prerequisites say `Package must exist`, and the npmjs.com
  flow requires an existing package before Trusted Publisher settings are available. [npm-trust] [npm-tp] [cli-8544]
- First-party record of the limitation: npm/cli#8544 "[Allow publishing initial version with OIDC]" (open since
  2025-09-01) and npm/documentation#1926 (open), which reports that OIDC publish fails until a package exists and
  that the documented workaround is a manual first publish, after which OIDC works. [cli-8544] [doc-1926]
- Registry change of 2026-10-02: `npm stage publish` can now **create** a package — public scoped, public unscoped, or
  private scoped — using a local session or a granular access token, *including a stage-only token*. The first version
  enters the staged queue and needs a maintainer to promote it; only after package creation can trusted publishing be
  configured. [changelog-new-pkg] [npm-stage]
- Staging a package that does not yet exist publishes a publicly visible placeholder version `0.0.0-stage`; the staged
  version's contents stay private until approval. `npm stage publish` itself does not require 2FA, but *approval*
  does. [npm-stage]
- Practical bootstrap sequence implied by the above (not yet executed here): (1) own the npm scope; (2) either publish
  the first version manually, or run one `npm stage publish` with a stage-only token, then promote it with 2FA;
  (3) configure the GitHub Actions trusted publisher for `release.yml` + environment; (4) complete the first OIDC
  publish within 48 hours so the configuration is validated. [npm-tp] [npm-stage] [changelog-new-pkg]

## 4. Allowed actions, staging, and dist-tags

- Allowed actions are per configuration and independent: `npm stage publish` is always allowed; direct
  `npm publish` and `npm dist-tag` are opt-in. [npm-tp] [changelog-disttag]
- Dist-tag via OIDC requires npm `11.21.0`/`12.2.0` and the explicit "Allow npm dist-tag" permission, which is off
  by default for both new and existing configurations. It is independent of publish permission. [npm-tp] [changelog-disttag]
- `npm publish --tag <dist-tag>` is part of the OIDC publish path; a separate dist-tag permission is only needed for
  `npm dist-tag add/rm`. Other `npm stage` subcommands (`list`, `view`, `approve`, `reject`) require interactive
  authentication and cannot use OIDC, as do `install`, `view`, and `access`. `npm whoami` is not a check of
  trusted-publishing permission. [npm-tp]
- `--access`: defaults to `public` for new packages and does **not** change an existing package's access level;
  scoped packages are private by default, so a public scoped release needs an explicit `--access public`. Unscoped
  packages cannot be restricted. [npm-publish] [npm-scopes]
- Irreversibility: once a name+version is published it can never be reused, even after `npm unpublish`. [npm-publish]

## 5. Provenance

- With OIDC publish from GitHub Actions or GitLab CI/CD, npm generates and publishes provenance attestations
  automatically; `--provenance` is not needed (it was already redundant from the 2025 GA release). Provenance is not
  generated for CircleCI. [npm-tp] [changelog-ga]
- Conditions, all required: OIDC publish + **public repository** + **public package**. Private repositories get no
  attestation even for public packages. [npm-tp] [npm-provenance]
- Provenance can be disabled (`NPM_CONFIG_PROVENANCE=false`, `.npmrc` `provenance=false`, or
  `publishConfig.provenance=false`); a `provenance-file` takes precedence over automatic generation. [npm-tp] [npm-publish]
- The statement points at the public Sigstore transparency log, so publishing source must be a public repo. [npm-provenance]

## 6. Permissions and events on the GitHub side

- The job needs `permissions: id-token: write`; this grants only the ability to request an OIDC token — it does not
  grant write access to repository resources. `contents: read` remains the default for checkout. [npm-tp] [gh-oidc]
- Only GitHub-hosted runners are supported for trusted publishing (self-hosted are unsupported, "planned"). [npm-tp]
- Rejected events: `pull_request_target` (existing) and `issue_comment` (added 2026-10-02). Use `push`, `release`,
  or `workflow_dispatch`. A tag-push trigger is a `push` event and is permitted. [changelog-expiry]
- Recommended hardening (not required by the protocol): use an environment with protection rules, enable tag
  protection, then set package Settings → Publishing access → "Require two-factor authentication and disallow
  tokens". Token restriction does not affect OIDC publishers. [npm-tp] [gh-oidc]

## 7. Accounting of the OIDC handshake

- npm CLI detects OIDC environments and exchanges the provider ID token for a short-lived, workflow-scoped registry
  token before falling back to traditional tokens; no `NPM_TOKEN`/`NODE_AUTH_TOKEN` is needed for publishing.
  Installing *private dependencies* still needs a read-only token, because trusted publishing is not an `npm install`
  mechanism. [npm-tp]
- The provider-side contract is a signed, audience-scoped ID token (GitHub sets `aud`; GitLab requires
  `aud: "npm:registry.npmjs.org"`); npm's registry exposes a token-exchange endpoint for it. [npm-tp] [gh-oidc]
- Known failure modes are unhelpful: bad/missing trust configuration looks like `404 Not found` or `ENEEDAUTH "please
  log in"`, and an outdated npm CLI is a documented cause. Do not treat either error as proof of package-type or
  token-placement problems. [npm-tp] [cli-9088]

## 8. State of this repository at read time

- `git rev-parse HEAD` = `af10fad` on branch `integration/execution-resources`; `git remote -v` is **empty** — no
  Git remote is configured in this checkout. [repo]
- `package.json` is private (`hepi-harness`, `private: true`); workspace packages are `@hepi/server`, `@hepi/web`,
  `@hepi/gateway`, `@hepi/protocol`, `@hepi/session`. **`packages/client` does not exist** at this revision, while
  `.github/workflows/ci.yml` and `release.yml` both run `pnpm --filter @hepi/client build` /
  `npm pack ./packages/client`; those steps cannot succeed until the package is added. [repo]
- `.github/workflows/release.yml` (committed in `dbcc299`) publishes on `v*` tag push with
  `runs-on: ubuntu-latest`, Node 24, `environment: npm-release`, `permissions: { contents: read, id-token: write }`,
  `npm install --global npm@11.21.0`, and
  `npm publish release-artifacts/*.tgz --access public --tag "$NPM_DIST_TAG"`. That shape matches the constraints
  above (tag push is an allowed event; npm is upgraded past every threshold; `--access public` is explicit;
  `--tag` needs no dist-tag permission). [repo]
- `docs/releases.md` declares the intended one-time setup: Trusted Publisher bound to `release.yml`, environment
  `npm-release`, direct `npm publish` allowed, and no `NPM_TOKEN`/`NODE_AUTH_TOKEN`. [repo-docs]
- The npm registry currently has **no `@hepi` scope and no `@hepi/client` package** (`registry.npmjs.org/@hepi%2fclient`
  → `404`; the `@hepi` search returns only unrelated `@<personal-scope>/*` names). An npm user account and/or organization owning
  the final scope must exist before any publish, and the placeholder name `@hepi/client` may change. [registry-check] [repo-docs]
- GHCR side note (outside npm): public container packages allow anonymous pulls; a freshly published image defaults to
  inherited repository visibility, so set the package public if anonymous pulls are required. Not verified here.
  [gh-packages]

## 9. Verification boundary

Only documentation was read, plus registry/index metadata. No npm publish, no CI run, no GitHub environment or npm
account change was made. Everything in §3 is a constraint synthesis from the cited pages, not a tested procedure in
this repository; the first real publish remains an operator action on the owning GitHub repository and npm account.

## Sources

| Key | Source | Retrieved |
| --- | --- | --- |
| [npm-tp] | npm Docs — Trusted publishing for npm packages, https://docs.npmjs.com/trusted-publishers (page states last edited 2026-10-06) | 2026-10-09 |
| [npm-stage] | npm Docs — Staged publishing for npm packages, https://docs.npmjs.com/staged-publishing | 2026-10-09 |
| [npm-trust] | npm Docs — `npm trust` CLI (v11/v12), https://docs.npmjs.com/cli/v12/commands/npm-trust ; npm CLI repo manual docs/lib/content/commands/npm-trust.md | 2026-10-09 |
| [npm-cli-trust-github] | npm/cli source — `lib/commands/trust/github.js` and `lib/trust-cmd.js`, npm 12.2.0 tarball (https://registry.npmjs.org/npm/-/npm-12.2.0.tgz) | 2026-10-09 |
| [npm-publish] | npm Docs — `npm publish`, https://docs.npmjs.com/cli/v11/commands/npm-publish | 2026-10-09 |
| [npm-provenance] | npm Docs — Generating provenance statements, https://docs.npmjs.com/generating-provenance-statements | 2026-10-09 |
| [npm-scopes] | npm Docs — About scopes, https://docs.npmjs.com/about-scopes ; Package scope, access level, and visibility, https://docs.npmjs.com/package-scope-access-level-and-visibility | 2026-10-09 |
| [npm-packument] | npm registry packument, https://registry.npmjs.org/npm (`dist-tags`, `time`) | 2026-10-09 |
| [runner-images] | actions/runner-images README (image-to-label map; `ubuntu-latest` → Ubuntu 24.04) | 2026-10-09 |
| [runner-images-u24] | actions/runner-images `images/ubuntu/Ubuntu2404-Readme.md` (Node.js 22.23.3, npm 10.9.9) | 2026-10-09 |
| [node-dist] | Node.js release index, https://nodejs.org/dist/index.json | 2026-10-09 |
| [gh-oidc] | GitHub Docs — Configuring OpenID Connect in cloud providers (id-token: write semantics; environments) | 2026-10-09 |
| [gh-packages] | GitHub Docs — Configuring a package's access control and visibility (container registry anonymous pulls) | 2026-10-09 |
| [changelog-ga] | GitHub Changelog 2025-07-31 — npm trusted publishing with OIDC is generally available | 2026-10-09 |
| [changelog-multi] | GitHub Changelog 2026-09-03 — Multiple trusted publishing configurations for npm | 2026-10-09 |
| [changelog-disttag] | GitHub Changelog 2026-09-30 — Opt-in dist-tag permissions for npm trusted publishing | 2026-10-09 |
| [changelog-expiry] | GitHub Changelog 2026-10-02 — Unvalidated npm trusted publishing configurations now expire (48 h; `issue_comment` rejected) | 2026-10-09 |
| [changelog-new-pkg] | GitHub Changelog 2026-10-02 — npm staged publishing now supports creating new packages | 2026-10-09 |
| [bypass2fa] | GitHub Changelog 2026-07-31 / 2026-07-08 — bypass-2FA GAT restrictions; direct publish removal targeted ~January 2027 | 2026-10-09 |
| [cli-8544] | npm/cli issue #8544 — Allow publishing initial version with OIDC (open) | 2026-10-09 |
| [doc-1926] | npm/documentation issue #1926 — Missing guidance for first-time package publishing with Trusted Publishers (open) | 2026-10-09 |
| [cli-9088] | npm/cli issue #9088 — Trusted publishing failures report misleading 404 / ENEEDAUTH errors (open) | 2026-10-09 |
| [registry-check] | npm registry queries: `/@hepi%2fclient` → 404, `/-/v1/search?text=hepi` returns no `@hepi` packages | 2026-10-09 |
| [repo] | This repository: `af10fad`, `git remote -v` empty, package.json, .github/workflows/{ci,release}.yml | 2026-10-09 |
| [repo-docs] | `docs/releases.md` (one-time setup and release sequence) | 2026-10-09 |
