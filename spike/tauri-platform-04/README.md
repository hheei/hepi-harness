# Ticket 04 — Tauri platform spike (throwaway)

A minimal **real** Tauri v2 app used only to observe the desktop target's native behaviour. It is not a client
implementation, adds no seam the shared client would reuse, and is deleted once ticket 05 replaces it with the real
App shell. Everything it measures is measured inside the actual WebKitGTK 4.1 WebView, not a browser or a simulation.

Target under test: Linux x86_64 on `workstation`, WebKitGTK 4.1 (2.52.3), Tauri v2 (crate 2.12.4, CLI 2.12.3).

## What is here

| Path | Role |
| --- | --- |
| `src-tauri/` | the Rust shell: env hand-off, keyring credential commands, native chunked file save, window lifecycle, stdout report |
| `dist/` | the page the WebView loads; runs each phase and reports what it observed |
| `harness/server.mjs` | fixture servers: SSE, submission, large body, upload, result collection, three origins |
| `harness/run.mjs` | fixture phases: transport, memory, cancellation, process death, credential persistence |
| `harness/ingress.mjs` | live phases against the **real** ticket 03/07 client ingress and Backend |
| `harness/package.mjs` | `.deb` inspection and packaged-binary smoke |
| `logs/` | the raw logs and `report.json` each run wrote; the evidence, not a summary |

## Reproducing

```sh
cd spike/tauri-platform-04
cargo build --release --manifest-path src-tauri/Cargo.toml     # needs Rust + libwebkit2gtk-4.1-dev
node harness/run.mjs --skip-build --log-dir=logs/desktop       # fixture phases, exit 0 = all assertions held
node harness/ingress.mjs --log-dir=logs/ingress                # live ingress + Backend, exit 0 = all assertions held
npx @tauri-apps/cli@2 build --bundles deb && node harness/package.mjs --log-dir=logs/package
```

The harnesses need `Xvfb` (present) and start their own display; `run.mjs` and `package.mjs` bind fixture ports
18080–18082 and `ingress.mjs` binds 18090, so a second concurrent run fails fast with exit 3 rather than measuring the
wrong server. `ingress.mjs` resolves the repository's own `apps/server` and `packages/gateway` sources, so run it from
a checkout with `pnpm install` done.

## Measured results

The desktop target is **evidenced**. See the ticket's report for the per-assertion table; the findings that changed the
plan are:

1. **The page origin is `tauri://localhost`.** Every gateway address is therefore cross-origin, so the ingress must
   answer it as a declared App origin (`HEPI_APP_ORIGINS`), and a gateway origin absent from the built CSP is refused by
   the WebView before any request leaves it (`TypeError: Load failed`).
2. **A truncated SSE stream is not an error.** A server that drops the socket ends the caller's reader cleanly with no
   exception; only the absence of a terminal event distinguishes it. Recovery has to key on the protocol, not on a throw.
3. **WebKitGTK rejects a streamed request body**: `fetch` with a `ReadableStream` body throws
   `NotSupportedError: ReadableStream uploading is not supported`. Uploads must be a `Blob`/`ArrayBuffer` body.
4. **Native fetch streams downloads incrementally**, but the WebView delivers very large chunks (up to ~70 MB for a
   96 MiB body). Handing such a chunk to IPC makes the process peak follow the chunk (~3.0 GB peak RSS); slicing before
   IPC keeps the same bytes on disk at a bounded peak (~225 MB). The upload side already buffers, so the split is:
   stream the read, bound what crosses IPC, and never assume a streaming upload.
5. **The OS credential store works** through `keyring` → Secret Service (gnome-keyring, present and unlocked): set,
   read back, delete, and read-after-delete across a separate process all behave, with no plaintext on disk.

The logs beside this file are the branch runs (`desktop-final`, `ingress-final`, `package-1`); `desktop-integration-2584b78`,
`ingress-integration-2584b78`, `package-integration-2584b78` and `android-integration-2584b78` are the same three suites
re-run on the integrated `integration/client-app` tree, with the same assertions and the same measurements.

Not evidenced, and not claimed: any Android or iOS target (no SDK, no device, no emulator), a system `dpkg -i` install
(the run inspects and executes the package's real installed layout instead, because installing needs root), and any
App UI above this spike.
