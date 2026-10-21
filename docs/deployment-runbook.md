# Deployment runbook

Default path for routine deployments, plus a full runbook for installation and state changes on local or split topologies.
Per-host commands stay in [Oracle](oracle-tailscale-deployment.md), [workstation](local-tailscale-deployment.md) and
[container deployment](container-deployment.md).

**Current test topology (2026-10-18): backend, gateway and the primary Web origin run on the workstation, and that origin is the client ingress.** Backend listens on local loopback `18787`, reaches gateway directly on `28788`, and runs an amd64 image. The remote backend is stopped; remote Web/API use a compatibility forward. [Current units/state](local-tailscale-deployment.md#current-local-backend), [the 1873d24 cutover record](records/1873d24-deployment.md), [migration/rollback evidence](backend-local-migration-2026-10-16.md).

Build on the workstation or CI. The remote host remains runtime-only: no builds, installs or compilers there. Match artifacts to actual target architecture. Split-specific commands below apply when deliberately selecting that topology.

## Routine deployment (default)

Use this path when shipping a revision into the existing topology with the same state paths, compatible database
schemas and existing credentials. A request to deploy authorizes the normal service switch and restart; proceed
through verification without another approval round.

1. **Resolve the target.** Use the revision and services the user named; otherwise use the current committed HEAD
   and the configured current topology. Read the affected unit/compose or established wrapper once to confirm its
   active image and state mounts. Reuse known host configuration and commands. Build committed source even if
   unrelated local work is present; leave that work alone.
2. **Execute the established build/transfer and switch commands.** Build only affected artifacts on the build host
   or reuse matching prebuilt artifacts. Pin the new tag/digest, preserve the existing state mounts, keep the previous
   image available, and restart only affected services. Reuse valid checks for the same source; run targeted checks
   only where evidence is missing or source changed. Dependency installation is needed only when the chosen build
   environment requires it.
3. **Verify once and finish.** Confirm the running image and service state, then run the affected service's read-only
   smoke: Web response/auth rejection for a Web update; authenticated catalog and conversation continuity for a
   backend update; gateway connectivity for a gateway update. Report revision, changed services and smoke results.
   On failure, read the relevant log and fix the concrete failure or roll back to a schema-compatible previous image.

The routine path does not require `deploy:plan`, a fresh full test suite, specs/tickets, a formal review/retro cycle,
or a new Markdown deployment record. A Web-only deployment needs no database backup. A compatible application
update preserving state paths does not require a fresh backup of every database; it leaves the configured backup
policy unchanged. If compatibility is unknown, inspect the relevant migration code before switching. Schema or
state-path changes use the full runbook below, with a verified backup of the affected databases.

Keep operational evidence in git-ignored `.dev/deploy/<run-id>/` or the existing private host logs, with revision,
artifact identity, previous image, changed services, date and smoke results; keep secrets out of shareable reports.
The final response may carry this concise record. Update tracked guides when the mechanism, topology or configuration
contract changes, or when the user requests a published deployment report. Historical records remain dated evidence.

**Client-runtime releases.** A Web-origin switch ships one release directory — the client ingress bundle, the static Web
build and the Backend image, named by the commit — built on the build host with
`node scripts/build-client-runtime.mjs`. The ingress unit and its env template come from
`node scripts/ingress-unit.mjs`; the release layout, the configuration table and the prepared cutover sequence are in
[client-runtime release](client-runtime-release.md). This path replaces the Next Web image rather than running beside it,
so the unit that binds the Web origin's port is stopped **and disabled** before the ingress takes it — otherwise a boot
or logout could raise a second Web origin beside it — and nothing keeps a second Web service warm. The workstation's
Web origin has been an ingress since 2026-10-18 ([the 1873d24 record](records/1873d24-deployment.md)); a later Web-origin
revision follows the same release-and-unit path against `hepi-ingress.service`, and the Backend and gateway move with it
when the release carries them.

**Command source.** Reuse the operator's fixed commands when available. For the current local backend, use its pinned `hepi-backend.service` image and persistent state mount; restart with `systemctl --user restart hepi-backend.service`, then check the client ingress it answers through (`hepi-ingress.service`) and the compatibility-forward unit if needed. A gateway restart is also a workspace re-registration event: confirm the catalogue answers the recorded project folders with no host error. For the historical remote arrangement,
`bin/run-oracle.sh` wraps pinned Compose inputs and `bin/verify-oracle.sh` supplies verification; check their current
contents before reuse because the host guide records older installations. Invoke Compose with `--no-build` and
the affected service name. Restarting a unit alone does not ship a new image. The repository
ships inspect/plan helpers and the client-runtime release builder, not a universal apply command; use the configured
host commands rather than inventing a `pnpm deploy` entry point. If a required command is missing, resolve that
specific gap.

### Existing open pages at a Web contract switch

A browser that is already showing the old Web build keeps running that JavaScript until it is refreshed: a new build is
never pushed into an open page. When the switch changes the browser contract (the payloads the page reads), that page is
therefore stale rather than broken, and the refresh is the deliberate step that moves it.

- **Preserve what only the old page holds, before its first refresh.** A composer draft lives in the page's memory in
  the pre-switch build, so it cannot be checkpointed for it. Copy any unsent text and save any attached image by hand
  before refreshing that page. Drafts written by the new build survive later reloads in the tab's own store
  ([Chat](chat.md#composer-drafts-across-a-refresh)).
- **Refresh each open page once, after the switch.** The reload is what loads the new build and adopts the new
  payloads. Until then the page keeps the old contract, and a refresh is expected to lose only what the old page held in
  memory — which is the step above.
- **A pending submission is looked up, never resent.** The browser-generated `requestId` is what recovers an in-flight
  or settled turn after the refresh, and a reload neither resends nor re-notifies a completed run
  ([Submission recovery](chat.md#submission-recovery)).
- **Rolling back is re-pointing the unit at the previous release.** The Web origin has no image to roll back: re-pin
  `ExecStart` and `HEPI_INGRESS_STATIC_DIR` at the previous `release-<artifact-id>` and restart
  `hepi-ingress.service`, then refresh the open pages again. No durable state is involved, and no draft store needs
  migrating ([client-runtime release](client-runtime-release.md)).

## Full runbook (installation and state changes)

Use the stages below for first installation, topology or credential changes, schema migration, state-path changes,
or a user-requested audited release. Database restore has its separate rules at the end. Apply stages to affected
roles and databases; stateless services need no database backup. A required stage that cannot produce its evidence
stops the affected switch. `deploy:plan` prints this full-runbook reference, not the routine deployment path.

| Stage | Question it answers | Evidence it leaves |
| --- | --- | --- |
| 1 Inspect | What is running now, and what exactly is the input? | Current units, image tags/ids, commit, architecture |
| 2 Plan | What changes, where, and what is the way back? | Affected roles, artifact identity, previous image, backup plan |
| 3 Build | Produce the artifact on a build host | Image tag + `sha256` (or tarball hash), architecture |
| 4 Verify the artifact | Is this the thing I intended to run? | Digest, arch, `--no-build` start, its own startup log |
| 5 Back up durable state | What do I have if this goes wrong? | Backup directory, `integrity_check`, row counts |
| 6 Switch | Replace only what changed | New tag in the unit/compose, restart count, start time |
| 7 Smoke (read-only) | Does the deployed pair actually answer? | Auth `401`/`200`, catalog, conversation continuity |
| 8 Record | What was done, with what proof? | A dated point-in-time deployment record |

## 1. Inspect

Read the state; do not assume it from a document. Documents here are dated records, not live status.

Two read-only commands implement this stage and the next. Neither writes to a host, reads a secret, or prints a real
host name, address, login or absolute root; both take their host facts from git-ignored private configuration
(`deploy/deploy.local.env`, below) and report those fields as booleans.

```bash
pnpm deploy:inspect             # source identity, configured roles, pinned tags, evidence timestamp
pnpm deploy:inspect --probe     # plus fixed read-only SSH reads: the release marker, images, containers, digests, architecture
pnpm deploy:plan                # the offline plan, with the concrete artifact identity
```

These helpers inspect and print the full-runbook reference; applying a deployment uses the established host commands.

- Which services run, and from which unit or compose project: `systemctl --user status hepi-gateway.service`,
  `docker compose ps`, `docker inspect`.
- Which artifact each one runs: the `ExecStart` image tag on `workstation`, the pinned tag in
  `releases/<commit>/deploy/compose.oracle.yaml` and `bin/run-oracle.sh` on `remote-host`. Resolve each tag to an
  image id and record both.
- Which commit that artifact came from — `SOURCE_COMMIT` in the release directory,
  `<runtime-root>/releases/<artifact-id>/SOURCE_COMMIT`. `deploy:inspect --probe` resolves `<artifact-id>` from
  the tag of the running backend image and reads the marker there; a release directory no running container names is
  reported, never guessed. Whether the working tree is dirty. A running container without a `HEALTHCHECK` is the
  normal state on a shared runtime host and does not fail the read: the container detail read reports `health=none`
  for it, and every container that has a health check still reports its own. (The recorded limit in
  `.scratch/deploy-review-fixes/review-notes.md` — one such container made `containerDetail` exit 3, before the
  marker read — was fixed 2026-10-14; evidence in
  [.scratch/development-audit/fixes-deploy-probe.md](../.scratch/development-audit/fixes-deploy-probe.md).)
- What is reachable: the two SSH forwards, the loopback ports, the Tailscale serve mappings.

If a tag resolves to a different image than the record claims, stop and treat the running state as the source of
truth.

**Private configuration.** The real mapping lives in `deploy/deploy.local.env`, git-ignored, mode 0600, on the
operator's machine: `DEPLOY_BUILD_{HOST,SSH,ROOT,ARCH}`, `DEPLOY_RUNTIME_{HOST,SSH,ROOT,ARCH}` and
`DEPLOY_REGISTRY`. `DEPLOY_RUNTIME_ROOT` is the deploy root that holds `releases/`, `state/`, `env/` and
`bin/` — not a release directory, and not the marker's own directory. Public docs use the generalized roles
(`<client-host>`, `<runtime-host>`) and placeholders; this
file is the only place the real values belong. `deploy:inspect` reports a role as configured or incomplete and never
echoes a value from it, and it ignores any key it does not recognize rather than silently treating a typo as "not
configured".

The current local role has no working SSH probe alias; private configuration intentionally leaves runtime SSH empty rather than probing the former backend. Offline inspect/plan report that limit. Use local unit/image inspection and authenticated smoke for current evidence.

## 2. Plan

Decide the change and its shape before touching a host.

- **Immutable source identity.** Deploy a commit, not a working tree. `git archive` of a commit (or a checkout whose
  `HEAD` you record and whose status is clean) is the input; the commit hash is the release name.
- **Artifact identity.** For each image: tag, image id/`sha256`, and for a tarball its `SHA256SUMS`. A release that
  is retagged rather than rebuilt must say so: the 39c168d backend is the same image object as `edef2c0` under a new
  tag, and asserting byte-identity is what justified not recreating the container.
- **Architecture, per role.** The backend image targets its actual runtime (`linux/amd64` for the current workstation, `linux/arm64` for the historical remote host); the
  Web UI and the gateway are built for the build center (`linux/amd64` on `workstation`). Confirm each one in the image
  itself (`docker image inspect --format '{{.Id}} {{.Architecture}}'`), not just in the build command, and never by
  reading a running container's architecture.
- **Previous image and previous unit.** The way back is the tag and the unit file that were there before. Record
  both, and keep a copy of the unit file you are about to edit.
- **Affected roles.** Name them: backend (current workstation or explicitly selected remote host), Web UI (which host), gateway, client bundle. "Everything" is
  not an answer: it hides restarts that were not needed.
- **Backup plan.** Which databases exist in use, where their files are, and where the backup will land.

Roles that are provably unchanged do not get restarted. Compare the trees first: if `packages/` or `apps/server`
did not move across the range, the gateway and the backend have nothing new to run.

## 3. Build (build host or CI)

On `workstation` or in CI, from the immutable source of stage 2:

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r test          # gate; starts processes, so it is a build-host step
docker buildx build --platform linux/<runtime-arch> -f deploy/docker/backend.Dockerfile -t hepi-backend:<commit> .
pnpm --filter @hepi/web build
```

The backend image targets runtime architecture. The Web UI is a static Vite artifact and the gateway bundle target the
build center. `deploy:plan` prints the resolved backend platform beside the image and marks it `<runtime-arch>` until
private configuration supplies it.

Tag by commit, never `:latest`, and record each image id. Move the artifact to the deployment host as a pinned tag
or digest from the registry, or as a tarball over SSH; a transferred release directory and a source tarball both get
a `SHA256SUMS`.

## 4. Verify the artifact

Before anything is switched, prove the thing you are about to run is the thing you built — **by reading it, not by
starting it production**.

- The digest on the deployment host equals the digest you recorded in stage 3:
  `docker image inspect --format '{{.Id}} {{.Architecture}}' <pinned-tag>`.
- `Architecture` matches the runtime: `linux/amd64` for the current backend, `linux/arm64` for the remote host, and the build center's architecture
  for the Web UI. Read the *image's* architecture, never a running container's.
- A sentinel start that proves the image boots is **not** this stage: starting the production service here would
  replace what stage 5 backs up and stage 6 switches. If a boot must be proven, prove it on the build host under a
  throwaway name, or fold it into stage 6 with that stage's gates already satisfied.
- A source-tree release confirms its `diagnostics.js` Diagnostic Page bundle is present, since `pnpm build:ui` produced it on the
  build host and it was transferred; that is a file check, not a start.

For a native arm64 runtime check, run the release scripts' own check inside the *build-host* image or in CI:
`node:sqlite` `DatabaseSync`. The Web image no longer installs `node-pty` (ticket 04), and neither image resolves a
QuickJS worker.

**Nothing in this stage runs `docker compose up`.** The compose override that pins the image and keeps the existing
state volume is stage 6's input, and it is supplied by the operator: a bare `compose up` would resolve
`hepi-backend:local` and a fresh named volume, so it is never a step of this runbook.

## 5. Back up durable state

Back up every database affected by the state change, not only the conversation database. A first cutover of the
whole durable stack includes all databases below; a stateless Web update includes none. A live `cp` of the `.sqlite`
file is not a backup: WAL commits live in the `-wal` sidecar.

| Database | Holds | Where |
| --- | --- | --- |
| `hepi.sqlite` | conversations, entries, submissions, tasks | backend state dir |
| `skill-repository.sqlite` | skill repository metadata | backend state dir (ADR 0002) |
| `projects.sqlite` | projects, folders, the default | backend state dir, beside `HEPI_DB` |
| `calls.sqlite` | gateway call journal, the outcome-unknown ledger | gateway host |

Use the SQLite online backup against the running process; no writer is stopped for it:

```bash
sqlite3 /path/hepi.sqlite ".backup '/backup/hepi-$(date +%Y%m%dT%H%M%S).sqlite'"
# or VACUUM INTO, and for a stopped copy: PRAGMA wal_checkpoint(TRUNCATE) first
```

Then verify the backup, not just the copy: `pragma integrity_check` **in the backup file**, plus the rows you expect
(conversation ids, projects and folders, submission counts). A backup you have not read is not evidence.

**Private configuration stays private.** Host-specific facts — real host names and addresses, login accounts,
absolute install roots, token and key material — do not belong in this repository or in any deployment record. Public
guides use generalized roles (`build host`, `runtime host`, `client host`) and placeholders; the real mapping lives
in a git-ignored private config (mode 0600) that the host-side tooling reads. Environment-file and unit-file copies go
to a private directory (mode 700) outside the release tree. Records name roles, tags, digests, hashes and counts;
never a secret value, a credential-file path or a personal filesystem path.

## 6. Switch only the affected services

**Two gates hold before the first write, both for this run and both proven, not assumed:**

| Gate | Must be true | How it is proven |
| --- | --- | --- |
| backup-verified | stage 5 produced a copy of every affected durable database, taken by this run (stateless roles: not applicable) | `pragma integrity_check` in the backup file plus its expected rows |
| single-writer | exactly one process holds each state file; any predecessor is stopped | the old unit is down, the port is free, no second process on the file |

A stage 5 that could not name or copy an affected database leaves this gate unsatisfied and stops that switch here. A backup
taken yesterday, or one whose rows were never read, does not satisfy it.

One writer per database. The order matters:

1. Confirm the reverse forward is up if the role being started needs it (the backend reaches the gateway through it).
2. If two processes would open the same SQLite file (an old unit and a new container), stop one and assert the port
   is free before starting the other.
3. Point the unit or the compose override at the new pinned tag **and keep the existing state paths**: the same
   volume or directory, the same `HEPI_DB`/`HEPI_PROJECTS`/`HEPI_SKILL_REPOSITORY`. A switch that resolves new
   defaults (a fresh named volume, a state path under the release directory) would start the backend on an empty
   database and silently abandon the durable state the backup just protected.
4. Start it. When the artifact is byte-identical, confirm the container was **not** recreated: `RestartCount=0` with
   an unchanged `StartedAt` is the evidence.
5. Leave every unaffected unit alone. Unchanged role, unchanged tag, no restart.

A release directory is immutable input: pin tags in the override so a bare `compose up` can never fall back to a
`:local` tag that does not exist on that host, and never to a new volume. Moving, renaming or migrating a state path
is a deliberate change of its own, recorded separately — it is never a side effect of this stage.

## 7. Smoke test (read-only)

Authenticated first, or the result is meaningless. A health route that answered without a token would be a false
green, so there is none.

```bash
P=8787
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$P/api/models"                 # 401 without a token
curl -s -H "authorization: Bearer $HEPI_AUTH_TOKEN" "http://127.0.0.1:$P/api/models"       # 200, catalog
```

Then, still read-only: the conversation list and the durable counts you witnessed in stage 1, `pragma
integrity_check` on each live database, the Web UI serving `/` and refusing an unauthenticated API call, and login
succeeding or failing for the right and wrong token. `bin/verify-oracle.sh` runs this set on `remote-host`. No writes,
no model calls: a smoke test must not change the state it is measuring.

## 8. Record the evidence

Write a dated, revision-scoped record under `docs/` (`<commit>-deployment.md`), as
[the 39c168d record](records/39c168d-deployment.md) and [the edef2c0 record](records/edef2c0-split-deployment.md) do. It holds the
commit, the artifact tags, ids and digests, what was and was not restarted, the backup path and its verified counts,
the smoke results, and the guide version it left current. Update the *current state* line in [docs/README.md](README.md),
[workstation](local-tailscale-deployment.md) and [Oracle](oracle-tailscale-deployment.md) when the deployment actually
changes, and say on what date you last verified it.

Deployment records are point-in-time. Nothing here makes an older record describe the live hosts; a record says what
was true at its date and commit, and only a fresh inspection (stage 1) says what is true now.

## Roles and persistent layout

Build and runtime are roles; the current test backend co-locates them on the workstation. The earlier split-role table applies when choosing a remote backend:

| Role | Job | Runs |
| --- | --- | --- |
| build center (client host) | build, static Web UI, execution gateway | `pnpm`, `docker buildx`, Vite, the gateway |
| runtime host | durable backend only | the prebuilt image, `docker compose up -d --no-build` |

The build center builds; the runtime host runs. There is no third role and no builder on the runtime host.

### Fixed roots

Paths are stable so a release can be addressed without inventing a new one each time:

```text
<client-root>/hepi-harness/            checkout, builds, Web UI, gateway
<runtime-root>/hepi-harness-deploy/
  releases/<artifact-id>/              immutable: the release as it was verified
  state/                               the durable databases, shared by every release
  backups/<timestamp>/                 pre-change copies
  env/                                 private env files (mode 0600)
  bin/                                 the release wrappers
```

`<artifact-id>` is the commit (short SHA), optionally with a tag or digest suffix. A release directory is never
edited in place: a change is a new `<artifact-id>`.

**Persistent state lives outside `releases/` and is never moved implicitly.** The databases already sit in
`state/`; a deployment points a new release at those same paths. Moving, renaming or migrating a state path is its
own deliberate change, not a side effect of shipping a release, and no step here does it.

### Transfer, and what is incremental

Prefer the smallest transfer that carries the artifact:

- **Registry digest pull** — `docker pull <image>@sha256:<digest>`. The digest is the identity; a re-pull of an
  already-present layer is a no-op.
- **Image tarball over SSH** when no registry is in play: `docker save <image> | ssh <runtime-host> docker load`,
  verified afterwards by digest. This carries only the artifact, not the source tree.
- **Source tarball** only for a source-tree deployment, and only from the build center; the runtime host receives
  it already built (the `diagnostics.js` Diagnostic Page bundle included).

What is genuinely incremental is on the **build center**: the Docker layer cache and the pnpm store make a rebuild
after a small change cheap, and a source sync into the checkout there is a normal `git fetch`. The runtime host
gets a new release directory and a new image; it does not get a rebuild, a dependency install or a compile, so
"incremental" never means "build a little on the runtime host".

### Staging, then atomic promotion

1. Assemble the release in `releases/.staging-<artifact-id>/` on the same filesystem as `releases/`.
2. Verify it there: image digest and architecture, `SOURCE_COMMIT`, and a `SHA256SUMS` for a tarball.
3. Promote with a single rename: `mv releases/.staging-<artifact-id> releases/<artifact-id>`.
4. Point the unit or the compose override at the new `<artifact-id>` and start it.

A failure in step 2 leaves the previous release and the running service untouched, because nothing was renamed and
no tag moved. Promotion is the only step that changes what a start would pick up.

### Retention and rollback

Keep the current release and the one it replaced, plus their images: that pair is what makes an image rollback a
re-pin instead of a rebuild. Prune older releases only after the new one has served a read-only smoke, and never
prune the release the rollback path names. Rolling back re-points the tag or the unit and restarts; it does not
touch the database, and a schema-compatibility check comes first (see *Rollback and database restore are different
operations*).

### Background verification

A verification run that is allowed to happen on its own still has to be bounded and harmless:

- **Offline and read-only by default.** No paid provider, no model call, no write to a database, no deploy, no
  build on the runtime host. The `fast` profile is exactly this.
- **Its own run id, log directory and result file**, so two runs never overwrite each other and a result can be
  traced to the revision it measured (the `.dev/verify/<timestamp>-<label>/` layout the check scripts already use).
- **One status query, not polling.** A run is inspected by reading its result file or its process state once; no
  agent loop watches it.
- **Bounded lifetime, and it cleans up its own processes.** A run has an end (a timeout at minimum) and removes the
  worktrees and child processes it created, so a lost run cannot hold the machine.

### Not implemented here

The read-only inspection and the offline full-runbook plan exist (`deploy:inspect`, `deploy:plan`); the transfer,
promotion and background-run pieces above are not scripts this repository ships. Routine deployment reuses
established host commands. A universal repository build/apply command and background scheduler remain unimplemented;
the runtime host is only ever deployed to and read from.

## Rollback and database restore are different operations

Rolling the application back is routine. Restoring a database is not, and the two must not be confused or combined
into one step.

**Application rollback: the image or the unit.** Re-pin the previous tag (or restore the unit file you copied in
stage 2) and restart. The database is untouched, and no data is rewritten. When the schema did not change, rolling
forward again is just the switch from stage 6.

**Schema compatibility is checked before an image is rolled back.** A newer backend may have migrated a database in
place (for example a `projects.sqlite` written by the single-folder version). An older image pointed at a
newer-schema database that it cannot read is a broken deployment, not a rollback. Before rolling an image back,
confirm the database schema is still one the older image understands, or restore the matching backup instead and
accept the loss of everything written since it was taken.

**Restoring a database is a deliberate, separate step.** It overwrites live durable state, so:

- the writer is stopped first, and it is proven stopped (port free, no second process on the file);
- the backup is verified before it replaces anything, by `integrity_check` and expected rows;
- the live file is moved aside rather than deleted, so the restore itself is reversible;
- the restore is recorded with the backup path it came from.

No script here overwrites a live database automatically, and a deployment never silently reverts data. If a rollback
needs data older than the current state, that is a decision the operator makes and records, not a side effect of
switching an image tag.
