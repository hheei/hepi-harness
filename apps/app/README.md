# Hepi App

The desktop client: the shared workbench (`@hepi/ui`) inside a Tauri v2 shell, connected to a Hepi Gateway's client
ingress. Linux x86_64 with WebKitGTK 4.1 is the target this build is measured on; Android is **not** built or claimed
(no SDK on the build host — see [the blocked mobile target](#mobile-target-blocked-not-claimed)).

`apps/app/src` is the host (router, connection, first-run surface); `apps/app/src-tauri` is the shell (credential store,
window policy, packaged binary); `apps/app/scripts` builds and verifies the artifacts.

## Connection

The App is not served from the Gateway, so three facts are stated once per install:

| Fact | Where it lives | Why |
| --- | --- | --- |
| profile | credential store, with the token | names the connection in every scoped store (drafts, remembered views) |
| Gateway origin | credential store, with the token | the ingress origin; every request and the SSE stream are addressed to it |
| device bearer | OS credential store (Secret Service) | the credential the Backend issued for this install; never a service token |

They are handed to the page as `globalThis.__HEPI_CONNECTION__` by the shell's initialization script — not by a
build-time substitution, not from a file in the bundle, and never in a URL. A page with no connection renders the
first-run form; the form's values go to the shell through `app_configure`, which stores them and restarts, because the
Gateway origin has to be in the window's policy **before the window exists**.

### When the Gateway refuses the connection

A stored connection is not an admitted one. The device bearer can be revoked, or the Gateway can be unreachable, and the
App then shows a **refusal surface** rather than a workbench. That surface states which of the two it is, because the two
have different next steps:

| State | What the surface offers |
| --- | --- |
| credential refused (401/403 on the descriptor) | **Configure connection…** (primary, focused) and **Disconnect…**; no retry, because repeating the read cannot admit a credential the Gateway refused |
| Gateway unreachable (no answer, 4xx/5xx other than a refusal) | **Try again** (primary), then **Configure connection…** and **Disconnect…** |
| no connection at all | the first-run form |

All three are ordinary buttons in tab order, and the primary action receives focus, so the whole surface is keyboard-operable.
What each action does, and does not do:

- **Configure connection…** opens the same form over the connection this machine has. It starts from the stored profile and
  Gateway address, requires the credential to be typed again (the refused one is the value being replaced, and prefilling it
  would invite the same refusal), and writes nothing until Connect. **Cancel keeps the stored connection** — the form is
  opened over it, not after forgetting it. A successful replacement stores the new connection and restarts, and the profile,
  Backend, account scope and client identity that are then reported come from the **new** descriptor the Gateway admitted;
  the previous connection's descriptor is never carried over.
- **Disconnect…** asks first, in a panel that says what it does: it deletes the connection stored on **this machine** and
  reopens the App unconfigured. It does **not** revoke the device credential on the Gateway (the Backend owns that record —
  a Web session revokes it) and it does **not** stop a durable run already executing on the execution host.
- **Try again** re-reads the same connection descriptor. Nothing is deleted and nothing is replayed: it is a read.

The Web page has none of these: its credential is the ingress's own cookie, so a refused Web page is a sign-in form, and a
Web page never offers a connection it cannot manage. `hepi-app --configure` / `--forget` remain the headless equivalent of
the two App actions, for a machine with no display.

Without a display, the same two operations are available headlessly, and the artifact test uses the paths it ships:

```sh
# One connection as JSON on stdin, so the bearer stays out of the process list and the shell history.
printf '%s' '{"profile":"workstation","origin":"https://gateway.example","token":"<device bearer>"}' | hepi-app --configure
hepi-app --forget
```

The bearer is issued by a signed-in **Web** session on that Gateway (`POST /api/device-credentials`); the ingress
refuses issuance to a device, so an App cannot mint itself a second identity. Revocation is the ingress's business: the
Backend owns the records and the ingress re-checks every request, including an attached stream.

## Platform constraints this build inherits

These are measured on this target ([ticket 04](../../.scratch/client-app/issues/04-tauri-platform-spike.md#report)), not
assumed, and the shell is where two of them are enforced:

- **The page origin is `tauri://localhost`.** Every Gateway is cross-origin, so the configured origin is named in the
  window's `connect-src` when the window is built; an address outside it is refused by the WebView before the request
  exists. The Gateway must also have `tauri://localhost` in `HEPI_APP_ORIGINS` to answer the App's CORS preflight.
- **A dropped SSE stream is not an error.** The reader ends cleanly with no exception and no terminal event, so recovery
  keys on the protocol (`resync_required`) and the lifecycle facts, never on a throw.
- **WebKitGTK rejects streamed request bodies** (`NotSupportedError`), so uploads are bounded `Blob` bodies.
- **A large download must be sliced to ≤ 1 MiB before IPC**: handing the WebView's own tens-of-MB chunk across IPC peaked
  at ~3.06 GB RSS for a 96 MiB body against ~225 MB with 1 MiB slices. This build's save is what enforces that bound; see
  [saving a file](#saving-a-file).
- **The credential store is the OS's**: Secret Service round-trips across processes with no plaintext on disk.

## Saving a file

A Web page's download is a navigation the browser performs: the file streams to disk under its own name and the page
never holds it. The App has no such path — its document is a bundle on `tauri://localhost` — so the workbench's save
control is a button and the shell does the writing.

| Command | What it does |
| --- | --- |
| `app_save_choose` | the platform's own save dialog, under the file's name; `null` when the person closes it |
| `app_save_begin` | opens the chosen destination and answers this save's handle; refuses an existing file that was not confirmed, and a directory |
| `app_save_append` | appends one slice, at most 1 MiB, and answers the file's length |
| `app_save_finish` | flushes, commits to the device and closes |
| `app_save_abort` | closes and removes the partial file this save opened |

The page reads the file through its own connection — the same `?type=download` address under the device bearer, no
token in any URL — and awaits each slice before reading the next. That is the ≤1 MiB bound above, applied where it
matters: neither the WebView nor the shell ever holds the whole file. A cancelled dialog transfers nothing, a refused
read never creates a destination, and a failure or cancellation removes what this run wrote while leaving the source
untouched. Nothing is retried, because a write that failed once is not a write to repeat against a file a person is
looking at.

`apps/app/src/save-host.ts` is the page's half of that contract and `src-tauri/src/save.rs` is the shell's, with
its own tests for the slice bound, the overwrite rule and the abort cleanup.

## Build and package

```sh
pnpm --filter @hepi/app build          # the UI bundle the shell embeds
pnpm --filter @hepi/app exec tauri dev # a development shell against the Vite dev server
```

The artifact, its provenance and its reproducibility measurement are one command:

```sh
node apps/app/scripts/build-artifacts.mjs --reproduce             # development build (default)
node apps/app/scripts/build-artifacts.mjs --profile=release       # optimised build, when packaging a release
```

It builds the UI, the static Web product and the App package, then writes to `.dev/artifacts/<label>/`:

| File | What it is |
| --- | --- |
| `Hepi_<version>_amd64.deb` | the Debian package (`usr/bin/hepi-app`, desktop entry, icon) |
| `hepi-app` | the packaged executable on its own |
| `web/` | the static Web build, per-file checksums |
| `checksums.sha256` | every artifact's SHA-256 |
| `provenance.json` | revision, dirty state, host, target architecture, toolchain versions, **the Rust profile and the exact Cargo environment it ran with**, the cache it built into, artifact checksums, the reproducibility measurement, and every build step with its exit code and log path |
| `logs/` | each step's raw output |

### Which profile, and what it costs

`--profile=debug` is the default and is what current development and its acceptance use: a debug build with symbols
intact, incremental compilation on, and no release optimisation. `--profile=release` uses the release profile in
`src-tauri/Cargo.toml` (`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = "symbols"`,
`panic = "abort"`) and is what a production package would be. A release rebuild is expensive, so it is never the
default, and `provenance.json` states which profile produced the artifacts (`build.profile`, `build.production`) — a
debug artifact is never labelled production.

`apps/app/scripts/cargo-build.mjs` owns the build's cost, in one place:

| Setting | Value | Why |
| --- | --- | --- |
| `CARGO_TARGET_DIR` | `<git-common-dir>/.dev/cargo-target` | one shared cache for every worktree of the repository, instead of a `src-tauri/target` per checkout |
| `CARGO_BUILD_JOBS` | `6` | the build host keeps six crates in flight, so a compile leaves the workstation usable |
| `CARGO_INCREMENTAL` | `1` for debug, `0` for release | incremental is what makes the second development build cheap; a release artifact is built once and measured |

`src-tauri/.cargo/config.toml` states the job count for every build of the shell (including a bare `cargo build`), and
deliberately does not state `target-dir`. A checked-in relative path was measured to resolve against *each* checkout —
`cargo build` in the main tree and in a worktree produced two separate `.dev/cargo-target` directories — so a bare
`cargo build` without the environment below still creates a checkout-local tree. An ad-hoc run joins the shared cache:

```sh
eval "$(node apps/app/scripts/cargo-build.mjs)"   # then: cargo build / pnpm --filter @hepi/app exec tauri dev
node apps/app/scripts/cargo-build.mjs --prune-cache   # keep at most two cache generations (normally one)
```

Cargo's own target lock serializes two concurrent builds on that cache; the second waits instead of compiling the same
crate twice. Retention is `--prune-cache`'s job and it only ever removes directories this project created under
`.dev/` — a checkout's own `src-tauri/target` is not this project's to delete, because another worktree may own it.

The shell binary is stamped with the client and shell revisions it was built from, so a packaged run reports its own
source (`HEPI_APP_BUILD …` on stdout, and the first-run surface shows it).

**Reproducibility, measured.** Two builds of the same sources produce a byte-identical executable. The `.deb` wrapper
does not: the Tauri bundler writes the bundling time into the package's member mtimes and does not read
`SOURCE_DATE_EPOCH`, so the payloads match and the package checksums differ. `--reproduce` records both comparisons in
`provenance.json` rather than asserting either.

## Verify the artifact

```sh
node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/<label>
```

It runs against the produced package, not the sources: package contents, architecture and dependencies; the shared
libraries the packaged binary resolves; that neither the binary nor the bundle carries an internal credential or a
Node/Next runtime; a cold start with no connection; a cold start with a stored one, where a fixture Gateway sees the
descriptor request arrive with `Origin: tauri://localhost` and the stored device bearer; the first-run form driven
through the real window with `xdotool`; and a cold start after forgetting the connection. Report and logs land beside
the artifact.

`verify-artifacts.mjs` is only the entry point: it resolves `--artifact-dir`/`--log-dir` (the default is the newest
`.dev/artifacts/<label>` this checkout built), calls `runArtifactVerification({ artifactDir, logDir })` from
[`scripts/verify-artifacts.operation.mjs`](scripts/verify-artifacts.operation.mjs), prints `{ logDir, passed, failed }`
and owns the process exit. Everything the run does — artifact inspection, the packaged journey, the private display,
credential store, fixture listeners and packaged process groups it acquires and releases — lives in that operation, so
importing it starts nothing and a caller gets the completed report back only after teardown. Adding an assertion means
adding a step to that journey; the report's fields, assertion names and exit semantics are unchanged.

**The package goes through a real `dpkg` transaction, and it is still not a system install.** `dpkg --install` needs
euid 0, which this host does not grant. It does grant unprivileged user namespaces
(`kernel.unprivileged_userns_clone=1`) and `bwrap`, so
[`scripts/offline-install.mjs`](scripts/offline-install.mjs) runs the transaction as root of a **throwaway tree**: the
host is bind-mounted read-only, one private root is writable, and `dpkg`'s own status database and log live inside it,
seeded from the host's installed set so the package's `libwebkit2gtk-4.1-0` dependency resolves. Then the run asserts
five things extraction cannot state — dpkg reaches `Status: install ok installed`, `dpkg -V` agrees with what it
installed, the binary **that transaction placed** executes and lands its credential operation in the run's own private
store, the host's own record of the package in `/var/lib/dpkg/status` is read **before and after** and compared, and
dpkg's own transaction log survives into the report directory. The host comparison is deliberately not a presence check: a
workstation that already runs the App **has** such a record, and there the true claim is "unchanged". The log copy is
asserted from the retained file, because the private root it was written in is removed moments later.

Whether that is possible is decided, not assumed: `offlineDpkgInstall.supported` is false with a stated `reason` when
`dpkg`, `bwrap` or userns is missing, and then extraction is reported as the weaker evidence it is. There is no
`--force-*` fallback. The report keeps `systemInstall: false` — no system root was written — and adds the transaction's
own outcome under `offlineDpkgInstall`. Logs land beside the artifact.

## Mobile target (blocked, not claimed)

**Android is blocked.** This host has no Android SDK, no `adb`, no `sdkmanager`, no device and no emulator, and
`tauri android init` exits 1. No mobile artifact is built, installed or claimed; provisioning an SDK is not done
unattended.
