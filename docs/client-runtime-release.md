# Client-runtime release and Web-origin cutover

Ticket 16's packaging slice: one immutable release that carries the client ingress, the static Web build and the Backend
image, plus the unit and environment shapes that run it. The ingress listener itself — its static surface, its routes and
the four materials — is described in [client ingress](client-ingress.md); this guide is what a deployment does with it.

This is now the **only** Web deployment path. Ticket 17 retired the Next presentation layer: there is no `hepi-web` image,
no `apps/web/next.config.ts`, no Compose `web` service and no `next start` process to keep beside the ingress. The
artifacts below are the whole surface — a deployment that has a release directory and the ingress unit has everything.

The cutover below **was executed on the workstation on 2026-10-18** at source `1873d24`. The paragraph that follows is a
**dated snapshot of 2026-10-19**, not a statement about the current deployment: on that day `hepi-ingress.service` ran
`release-ad225f8/ingress.mjs` with `HEPI_INGRESS_STATIC_DIR=…/release-ad225f8/web`, the Backend ran
`hepi-backend:ad225f8-workstation` (`sha256:e7281d46…44c2`, amd64) and the gateway bundle was the same release; all three units
were active and the deployed directory verified against its own `SHA256SUMS` (177 entries, exit 0, read-only). Evidence —
artifacts, image ids, backups, gates, the window's step exits and the read-only smoke — is in
[the 1873d24 deployment record](records/1873d24-deployment.md) for that earlier window and in the deployment record for the later one
(`.dev/deploy/login-layout/result.json` in the integration worktree). Ticket 16's journeys ran on that release's exact bytes:
[the concrete closeout](../.scratch/client-app/issues/16-integration-and-direct-cutover.md#concrete-closeout-on-the-live-release-2026-10-19--ad225f8).
**What the deployment runs now is not read from this guide:** the release id, image tag, bundle and env file are the
units' own current state, and [step 1 of the runbook](deployment-runbook.md#1-inspect) is how to read them. A revision
inspected later than that snapshot (`3d15c86`, `2c28d1c`) is not claimed here either — this file states what a build
publishes and how a switch is performed, and the deployed revision is whatever the units say on the day you look.
Earlier measurements against throwaway state at `0746d7a`, `f50df75` and `94526e2` remain below. Ticket 16's acceptance
list is no longer blocked only by evidence: what stays open there is a named limit set — debug-only native numbers and no
second physical host. The retired-Next drivers it named as a third limit are gone with the presentation layer (ticket 17);
the Web journeys that remain run against the release bytes.

## What a release is

```text
<client-root>/.dev/releases/release-<artifact-id>/     built here, on the workstation
  ingress.mjs                the client ingress, one ESM bundle
  gateway/hepi-client-*.tgz  the execution gateway, packed for install as release-<artifact-id>
  web/                       the Vite build the ingress serves (HEPI_INGRESS_STATIC_DIR)
  SOURCE_COMMIT              the commit the release was built from
  SHA256SUMS                 every shipped file's digest
  provenance.json            revision, host, arch, platform, toolchain, artifacts, steps
  LICENSE, THIRD_PARTY_NOTICES.md
```

The gateway tarball is part of the release because the ingress calls the host-local gateway's `POST /v1/mcp`, and a
gateway bundle from another revision can be missing behavior the ingress depends on. The bundle found installed on this
workstation at the 2026-10-19 snapshot (`release-1062840`) predated that route forwarding the request's abort signal, so
an MCP call it served could not be cancelled when the caller disconnected; the release carries a bundle that does. Which
bundle is installed *now* is the gateway unit's own `ExecStart`, not this paragraph.

`<artifact-id>` is the short commit, as every earlier deployment named its client bundle. A release directory is never
edited in place; a change is a new id. The same command builds the Backend image, tagged with the convention the
current deployment already uses (`hepi-backend:<artifact-id>-workstation`).

```bash
node scripts/build-client-runtime.mjs                      # all three artifacts
node scripts/build-client-runtime.mjs --skip-backend        # bundle + static Web only (fast, no Docker)
node scripts/build-client-runtime.mjs --platform=linux/arm64 # a Backend image for a different runtime host
```

It refuses a dirty tree: the release is named by a commit, and bytes that came from uncommitted edits cannot be named.
It assembles in a unique `.staging-<id>-<uuid>` directory and promotes with one rename, so a failed build leaves no
directory a unit could start. It deploys nothing, reads no secret and contacts no host.

**A published release is immutable, including against its own revision.** Building a revision whose
`release-<artifact-id>` already exists is refused before anything is compiled, and promotion refuses again, so two
builds racing on one revision cannot replace each other: the first rename publishes, the second is refused and its
staging directory is discarded. A rebuild therefore never deletes a directory an ingress may be serving — the window
where a delete-then-rename would have made the page `404` does not exist. To publish changed bytes, build a new commit;
to rebuild the same commit deliberately, remove that release directory first and say so.

The deployment plan prints the same directory name from the same commit (`release-<artifact-id>`, seven characters),
through the one function in `scripts/lib/client-runtime.mjs` the builder uses, so a plan cannot name a release the
build never creates.

`--skip-web` and `--skip-backend` are the exception, and deliberately not releases: they assemble into `partial-<id>`,
which nothing serves and each run of the same revision replaces, because a measurement you cannot repeat is not one.

### Why the ingress is its own bundle

The ingress is not the execution gateway. `@hepi/client`'s published entry starts `gateway` — the internal `/v1`
listener on loopback with its own token — while the client surface is a different bind, a different credential and a
different audience. Bundling `packages/gateway/src/ingress/main.ts` directly keeps that separation and needs no install
step on the deployment host: one file, run by the same Node the execution gateway already runs.

The bundle keeps the settings `packages/client/scripts/build.mjs` uses for the execution bundle (ESM, Node 24, third-party
license comments at the end of the file, and the CJS `require` banner the bundled MCP client needs), so the two bundles
cannot drift in module format or legal notices.

## Configuration, without values

The process reads these and nothing else. The names, roles and secret status are one table in
`scripts/lib/client-runtime.mjs`; `node scripts/ingress-unit.mjs --env-template` renders it as a file, and
`--check` prints it as JSON.

The template assigns only the required lines (empty, for the operator to fill in) and the two documented defaults
(`HEPI_INGRESS_HOST`, `HEPI_INGRESS_PORT`). Every other variable is printed **commented out**: the ingress parses
`HEPI_REVOCATION_CHECK_MS` and `HEPI_UPLOAD_BATCH_BYTES` as numbers when they are set, and `Number("") === 0` is a
positive-number failure at start — so an empty assignment there would produce a template that cannot run once its
required materials are filled in. Uncomment a line only when this deployment states that value; unset is the absence of
the line, not an empty value.

| Variable | Required | Secret | Role |
| --- | --- | --- | --- |
| `HEPI_INGRESS_BACKEND` | yes | no | the Backend origin this ingress fronts |
| `HEPI_INGRESS_SERVICE_TOKEN` | yes | **yes** | the credential the ingress presents to the Backend (outbound only) |
| `HEPI_WEB_LOGIN_TOKEN` | for a public bind | **yes** | the Web login material a browser exchanges for the session cookie |
| `HEPI_INGRESS_HOST` | no | no | the bind address (a non-loopback bind requires the login material) |
| `HEPI_INGRESS_PORT` | no | no | the Web origin's port (30141 in the current deployment) |
| `HEPI_INGRESS_STATIC_DIR` | for a Web origin | no | the release's `web/`; unset serves no page |
| `HEPI_APP_ORIGINS` | no | no | comma-separated App origins answered cross-origin |
| `HEPI_INGRESS_DEFAULT_HOST` | no | no | the execution host (gateway id) this origin serves |
| `HEPI_INGRESS_MCP_GATEWAY_URL` | no | no | this host's MCP service origin |
| `HEPI_INGRESS_MCP_GATEWAY_TOKEN` | no | **yes** | that service's token (outbound only) |
| `HEPI_INGRESS_MCP_GATEWAY_ID` | no | no | that service's name in the Backend's vocabulary |
| `HEPI_REVOCATION_CHECK_MS` | no | no | the revocation re-check interval for attached responses |
| `HEPI_UPLOAD_BATCH_BYTES` | no | no | the largest one browser upload may carry |

The three secrets are the deployment's own materials, kept apart from each other and from every credential a client
holds: the ingress's service credential is never sent to a client, the Web login material is never sent to the Backend,
and the execution gateway's token is not read by this process at all (it serves no `/v1` route). The template renders
every secret as an empty value, so nothing that looks like a token can be committed by accident.

The Backend keeps its own environment unchanged, including the device-credential store
(`HEPI_DEVICE_CREDENTIALS`, defaulting to `device-credentials.sqlite` beside the conversation database). A Backend that
predates the credential routes has no such file and answers no `/internal/credentials/verify`; the ingress then refuses
every device bearer with `503 authority unreachable`, which is why the Backend is rebuilt in the same release.

## The unit

```bash
node scripts/ingress-unit.mjs --release-dir=<client-root>/.local/share/hepi/client/release-<id> \
  --env-file=%h/.config/hepi/ingress.env > ~/.config/systemd/user/hepi-ingress.service
node scripts/ingress-unit.mjs --env-template > /tmp/ingress.env.template   # then fill it in, chmod 0600
```

It follows the units this deployment already runs: `Type=simple`, a pinned `/usr/bin/node`, the environment from a 0600
file rather than the unit or a command line, `Restart=always`. It has no `Requisite=` on the unit it replaces — the
ingress takes over the Web origin's port, so the old holder must be stopped first, and a dependency would block the
switch rather than order it. That ordering is the operator's step below.

The release directory must be reachable by the unit and `web/` must be readable; the ingress resolves
`HEPI_INGRESS_STATIC_DIR` through its real path per request, so a `current` symlink swapped to a new release is a valid
way to publish one.

## Cutover (executed 2026-10-18 at `1873d24`)

Direct replacement of the Next Web service, in one window. No dual stack, no rollback drill, no Next fallback — and, since
ticket 17, nothing left to fall back to: the old unit's process, image, Dockerfile, Compose service and build config are
deleted, so the ingress is not one of two Web paths but the only one. What the executed window adds to the sequence below:
the old Web unit is **disabled** as well as stopped, so a boot cannot raise a second origin on the port; the tunnel is
deliberately not restarted (it carries only remote compatibility, and a restart can fail on the remote `sshd`'s still-held
forward port); and the gateway's tarball is installed into the promoted release directory with the host's npm-tarball
workflow before the `mv`, then verified against the release's own `SHA256SUMS`.

**Before the window**

1. Merged-build checks green on the integrated tip. (Ticket 16's Web acceptance ran at `0d90b7d`; its native/App half is
   still open, so the 2026-10-18 switch shipped on the user's operational authorization and is recorded as a cutover with
   open acceptance, not as ticket 16's completion.)
2. `node scripts/build-client-runtime.mjs` on the workstation, from a clean committed tree. Record the release id, the
   `SHA256SUMS` digest, the Backend image id and its architecture (`docker image inspect --format '{{.Id}} {{.Architecture}}'`).
3. Promote by copying the release directory to the host's client-release root (or building there — it is the same host)
   and renaming it into place. A release directory that already exists there is immutable: a second build of the same
   revision is refused rather than replacing it, so promote a new revision instead. Verify `SHA256SUMS` after the copy.
4. Render the ingress unit and fill the env file at 0600. Values come from the existing private files; no value is
   printed, echoed or recorded.
5. Rebuild the execution gateway client bundle from the same revision and install it as `release-<id>`, so the gateway
   and the ingress come from one commit. At the 2026-10-19 snapshot the installed bundle was still `release-1062840`,
   which predated `POST /v1/mcp` forwarding `controller.signal`, so an MCP call it served could not be cancelled when the
   caller disconnected. Read the gateway unit to see which bundle is installed on the day of the window.

**The window**

6. Back up every durable database the Backend writes, verified with `integrity_check` and expected row counts
   ([runbook stage 5](deployment-runbook.md#5-back-up-durable-state)). A compatible update that preserves state paths
   needs no fresh backup of every database; a Backend image that adds a device-credential sidecar is such an update, and
   the existing state directory stays as it is.
7. Stop the process that binds the Web origin's port and prove it stopped: the port is free and no second process holds
   it. On a deployment cut over before ticket 17 that holder was `hepi-web.service`; it is deleted now, so this step is a
   port check rather than a unit to disable.
8. Switch the Backend unit to the new pinned image, keeping its state mount and its env file exactly as they are. Restart
   it and confirm it answers `401` unauthenticated and `200` authenticated on `/api/models`.
9. Start `hepi-ingress.service` on the Web origin's port. Confirm the port is bound by the ingress and by nothing else.
10. Switch the execution gateway unit to `release-<id>` and restart it. The gateway's registry is in memory, so
    re-register the project folders through the Backend's existing path afterwards.

**Smoke (read-only)**

11. `/` answers `200` with the Vite page; a hashed asset answers with an immutable cache header; `/conversations/<id>`
    answers the shell; `/missing.js` answers `404` and not HTML.
12. `/api/web-auth` answers `{"enabled":true}`; a wrong login is `401`; a right one sets `hepi-web-session`; an
    unauthenticated `/api/models` is `401` and an authenticated one is `200`.
13. One conversation's event stream opens through the ingress and survives a reload; a submission's `requestId` lookup
    answers once, not twice.
14. A device bearer reaches the same `/api` surface, an internal `/v1` path is `404` on this listener, and the gateway's
    own `/v1` still refuses a client credential.
15. Record the revision, the release id, the image ids, the restarts, and what was and was not restarted.

**After**

Nothing. There is no old service to keep warm and, since ticket 17, no old service to keep at all: the Next image, its
Dockerfile, its Compose service, its build config and its adapter tree are deleted from this repository. A deployment
that still has the stopped unit file on disk removes it; nothing in this repository references it.

## Evidence: what was measured on this branch

Built and exercised on the workstation at `0746d7a` and again at `f50df75` — the second is
`impl/client-app-16-runtime` merged with `integration/client-app` including the ingress static surface and the changed-
verification slice. No live service was touched. The ingress bundle (`1ab622ca…`) and the gateway tarball
(`5340b2d3…`) are byte-identical across the two revisions, because neither range touched their sources.

| Check | Result |
| --- | --- |
| `node scripts/build-client-runtime.mjs` | exit 0, `release-0746d7a`, four artifacts, 56 s total (bundle 0 s, gateway pack 0 s, Web 1 s, Backend image 55 s); re-run at `f50df75` in 38 s, same bundle and tarball digests, `hepi-backend:f50df75-workstation` |
| `sha256sum -c SHA256SUMS` in the release | exit 0, 174 entries |
| Backend image | `hepi-backend:0746d7a-workstation` `sha256:c287f8b8…` amd64, read from the image |
| Backend, throwaway state | 401 unauthenticated / 200 authenticated on `/api/models`; `POST /internal/credentials/verify` answers `{"ok":false,"reason":"unknown"}` for an unknown token |
| Ingress serving the release | `/` 200, `/conversations/x` 200 (shell), `/manifest.webmanifest` 200, hashed asset 200 with `public, max-age=31536000, immutable`, shell `no-cache`, `/missing.js` 404, `/../package.json` and `/%2e%2e/package.json` 404, `/v1/files` 404 |
| Client API through the ingress | `/api/web-auth` 200 `{"enabled":true}`; unauthenticated `/api/models` 401; wrong login 401; right login 200 + cookie; cookie `/api/models` 200; `/api/conversations` 200; `/api/descriptor` 200 |
| Device credential | issued by the Web session (201), works as a bearer (200), refused when it tries to issue one itself (403), refused after revocation (401) with `HEPI_REVOCATION_CHECK_MS=300` |
| Ingress → gateway MCP | `GET /api/mcp` 200 with the host's own listing, from the release's own gateway tarball installed into a clean directory |
| Restart durability | conversation created, Backend restarted on the same state, conversation still listed; all four SQLite files pass `integrity_check` |
| Re-run at the merged tip `f50df75` | `SHA256SUMS` verified; `/`, `/conversations/abc`, `/sw.js` 200, `/api/web-auth` 200, unauthenticated `/api/models` 401, `/v1/files` 404, `/missing.js` 404; cookie session 200 on `/api/models`, `/api/conversations`, `/api/descriptor` |
| Gateway tarball | installed with `npm install <tgz>` in a clean directory, `--version` 0.1.0, `doctor` ok, `POST /v1/mcp` 200 authenticated / 401 not; bundle carries `#mcp.execute(body, controller.signal)` |

### Cache accounting, measured

| Point | `<repo>/.dev/cargo-target` |
| --- | --- |
| before (no shared cache existed; no `cargo`/`rustc` running) | absent |
| after one debug build | 2837 MiB, one generation |
| after a second debug build of the same sources (4 s instead of 33 s) | 2887 MiB |
| after the runs in this table | 3702 MiB, still one generation |

The earlier per-checkout tree this replaces is `client-app-15/apps/app/src-tauri/target` at 3.4 GiB. It was **not**
migrated and **not** deleted: it belongs to another worktree at another revision, no `cargo` or `rustc` process holds
it, and copying it into the shared cache would put another checkout's fingerprints under this repository's target
directory. It stays until its owner removes it. `--prune-cache` keeps at most two generations and only ever removes
directories this project created under `.dev/`.

### What this revision's journeys measured (2026-10-19, `release-ad225f8`)

The runs below are the ticket 16 closeout, on the release bytes the deployment serves. They are this host's representative
numbers, not a production benchmark; the native half is a **debug** build, because this project does not pay for release
optimisation on a test-only path.

| Measurement | Value |
| --- | --- |
| Web requests / App requests per journey | 83 / 35 |
| Cold first visible → warm first visible (same origin, second document) | 212 ms → 176 ms |
| React commits, page's own read | sign-in surface 2 → catalogue ready 18; warm document 21 at shell-up; 17 for one streamed answer; 51 on the warm document in total |
| Long tasks on the page | 1 (77 ms); none inside the streamed answer |
| JS heap | 30 MB |
| Script bytes | Web 3 306 577 B, App 3 309 647 B |
| Peak RSS, the three services | backend 214 MB (container-reported), gateway 82 MB, ingress 90 MB |
| Peak RSS, native shell per run (debug, VmHWM) | cold start 155 MB, configured 160 MB, revoked credential 155 MB |
| Revocation to refusal | 131 ms with `HEPI_REVOCATION_CHECK_MS=400` — the interval is the contract, not the number |

What is deliberately **not** claimed: no release-profile performance figures, no second physical host (the multi-host
evidence uses a loopback `sshd`), and nothing about a mobile target.

## Not claimed

- **The cutover ran; the journeys ran on the artifact it switched to.** At the 2026-10-19 snapshot the Web origin was
  `release-ad225f8`, whose bytes ticket 16 drove both journeys on (`--release=…/release-ad225f8`), with the three identity
  assertions (ingress argv, installed gateway tarball, byte-identical `web/index.html`) and the deployed entry driven at two
  viewports. No claim is made about `1873d24`'s origin: that build predates the Web login gate, so a cold browser there got
  `unauthorized` with no sign-in surface — recorded when observed, and superseded by the release that ran then. The live
  revision today is the units' own state, not this paragraph. See
  [the release-artifact record](verification.md#the-journeys-now-run-against-the-published-release-itself-2026-10-19--bdc8746)
  and [the live closeout](../.scratch/client-app/issues/16-integration-and-direct-cutover.md#concrete-closeout-on-the-live-release-2026-10-19--ad225f8).
- **The App bundle is not in a client-runtime release.** The release carries the ingress bundle, gateway tarball, static Web
  build and Backend image; the drivers name the checkout's `apps/app/dist` as the component they substitute. A release that
  ships the desktop package belongs to ticket 15's artifact path, not here. **Android is not built and no longer a delivery
  gate** (user decision, 2026-10-19); the mobile absence is recorded as an absence in tickets 04 and 15.
- **No TLS and no reverse proxy.** If one is added in front, the cookie's `Secure` flag follows the forwarded protocol
  and nothing else in this release changes.
- The release's Backend image was run with a throwaway state directory, never against the deployment's own databases.
- The App's Rust cache has been measured, not optimized further: 3.7 GiB for one debug build tree is the current cost of
  building this shell once, and the shared directory is what stops it being paid once per checkout.
