# 05 - DOCX byte preview

Status: delivered on `impl/ssh-workbench-05`, App parity included — see the record at the end of this file.
Integrated into `integration/client-app` as `871ae72835c7264d74782cee612a61d2e247798c` (source `f39669d`, tip `f6e1004`);
merged-tip counts in [verification](../../../docs/verification.md#client-app-integration-ssh-workbench-ticket-05-2026-10-19).
The cancel-seam proof is the cancelled-stalled-stream coverage, **not** a live remote-host interruption.
Blocked by: 01, 02

Serve a workspace `.docx` as its own bounded bytes and render a best-effort preview in the browser, on either host.

The byte route already exists (`GET /api/files/...?type=read|download` → the host's own reader, relayed by the Backend,
bounded by the gateway's 16 MiB read policy). A docx is today served to the browser as a **binary text preview** (the
workbench's JSON answer says `binary: true` and the surface then falls through to the byte route), so the bytes arrive
while the viewer still says "DOCX preview is not connected". The gap is therefore a routing decision and a renderer, not
a new transport:

- `packages/protocol/src/files.ts` `servesBytes()` — a document this client renders is served as its own bytes, so a
  docx stops making a useless workbench round trip and states `documentPreviewKind()` as the single source of "renders
  from bytes".
- The viewer renders it on the connection it was given, under `DOCX_PREVIEW_MAX_BYTES` (10 MiB), which sits under the
  host's 16 MiB read policy, so a previewable document is answerable on both hosts. The bound is checked before the
  bytes are asked for and again while the stream is read, so a body whose stated length lied is cancelled rather than
  buffered.
- Parsing happens in the browser only. Nothing on the host or in the gateway converts a document, and no document's
  markup becomes page markup: the renderer takes the document's **text** and mounts it as text, so a script inside a
  document is inert content rather than an executable or a sanitising problem.

Acceptance: the byte route answers a docx identically on a local and an SSH workspace (`packages/gateway`), the bounded
reader and the refusal states are unit-tested at their own seam (`packages/ui`), and a real browser shows the document's
text — an over-bound document states its limit without fetching, and a document containing markup shows it as words.
Fidelity is out of scope: headings, tables and images render as text or not at all, per the spec's "best-effort preview,
not Office-fidelity".

## Delivered

The gap was exactly as stated: a routing decision and a renderer, no new transport. What shipped:

- `packages/protocol/src/files.ts` — `servesBytes()` now covers every `documentPreviewKind` path, so a docx stops
  making a workbench round trip and its `meta` answer carries `previewKind: "docx"`. `files-surface.ts` asks that one
  declaration; `byteServedMime` already answered the docx MIME.
- `packages/ui/src/lib/docx-preview.ts` — `readDocxBytes` (bound enforced from the `content-length` claim and again while
  the body arrives, stream cancelled at the bound) and `loadDocxText` (mammoth's browser entry, `extractRawText`, text
  nodes only). `packages/ui/src/hooks/useDocxPreview.ts` reads the address `useFileBytes` already resolved, so a
  document is fetched **once** per connection. `FileViewer` checks the size from `meta` first and refuses an over-bound
  document without issuing a read; a textless document, a refusal and a pending read are each stated as themselves.
- i18n: four `files.docxPreview*` keys in all three locales; `files.docxPreviewUnavailable` is gone with the code path
  that used it. `packages/ui/src/lib/i18n/messages/locale-keys.test.mjs` now fails if a component asks for a key no
  locale answers — which is the bug this ticket actually created once (the key was deleted while the viewer still
  translated it), so the guard is pinned rather than promised.
- Licence inside every artifact: `packages/ui/THIRD_PARTY_NOTICES.md` (owner = the package that declares the reader)
  carries `mammoth`'s BSD-2-Clause text and its `Copyright (c) 2013, Michael Williamson` line, because the bundled chunk
  states no copyright of its own. `thirdPartyNoticesPlugin()` copies it into each host's `build.outDir` from
  `closeBundle` — 3,313 bytes measured at `apps/web/dist/THIRD_PARTY_NOTICES.md` and at `apps/app/dist/` — and
  `packages/ui/src/lib/third-party-notices.test.mjs` (7) asserts the notice against the installed package, the copy
  against a real output directory, that a build which cannot place it fails, and that no host keeps a second copy.
- Evidence: `packages/protocol/test/files.test.ts` (2), `packages/ui/src/lib/docx-preview.test.mjs` (8),
  `packages/ui/src/lib/i18n/messages/locale-keys.test.mjs` (3), `packages/ui/src/lib/third-party-notices.test.mjs` (7),
  `apps/app/test/docx-preview-bundle.test.mjs` (2), `packages/gateway/test/files-surface.test.ts` (1 case),
  `packages/gateway/test/ingress-ssh-workbench.test.ts` (1 case: same bytes/MIME on both hosts, `Range` → 206),
  `apps/web/e2e/ux-docx-preview.mjs` + fixture (15 chromium checks, `pnpm --filter @hepi/web test:docx-preview`),
  `packages/gateway/test/docx-fixture.ts` (a real zip from `node:zlib`, no dependency for the gateway).
  Full commands, exits and logs: [verification](../../../docs/verification.md#ssh-workbench-ticket-05-the-browser-reads-a-docx-2026-10-19).

Two things the ticket text assumed, and what happened instead:

- **"existing browser rendering" did not exist.** `mammoth` was declared and imported by nothing, so the renderer is new
  code, not an adoption. It is text-only, and `convertToHtml` is deliberately unused: an untrusted remote document does
  not get to choose this page's markup.
- **The bound is checked three times, not once.** `meta.size` before any request, the response's own `content-length`,
  then the arriving body. The host's 16 MiB read policy still sits above all three, which is why no preview-specific
  reader bound was opened for either host.

**Corrected after review (App parity).** This file first claimed the App bundles no reader because
`@hepi/ui/workbench` "does not import `FileViewer`". That was wrong: `workbench.tsx` -> `components/AppShell.tsx` ->
`components/FileViewer.tsx`, so the App's graph already reached the preview and `pnpm --filter @hepi/app build` was
already emitting `apps/app/dist/assets/lib-4L70xDUm.js` (308,121 bytes). What made it safe was not that build — it
succeeded only because a dev install had happened to put `mammoth` within the App's bundler's reach. So `packages/ui`
now declares `mammoth` in **`dependencies`**, `apps/web`'s duplicate `devDependencies` entry is deleted, and the
coupling is a manifest statement: with the declaration removed the App's build fails at once
(`Rolldown failed to resolve import "mammoth" from packages/ui/src/lib/docx-preview.ts`), and `apps/app/test/
docx-preview-bundle.test.mjs` (2) proves the App's bundle resolves mammoth's **browser** entry — `mammoth/browser/*` in
the metafile inputs, no `lib/unzip.js`, no `lib/docx/files.js`, no Node builtin in the output — which is the assertion
that matters for a webview with no `Buffer`. No Rust build was needed to answer a bundler-resolution question; the
packaged `.deb` measurements stay ticket 04's. Recorded in
[upstream sources](../../../docs/upstream-sources.md#browser-document-renderer---mammoth-1130-ssh-remote-workbench-ticket-05-2026-10-19).

**Corrected after review (the cancel seam, `f39669d`).** The delivered read checked the caller's abort
**between chunks only**, and never put it on the request it sent: `readDocxBytes` called
`open(address, options.init)` while the viewer passed its controller separately in `signal`. So on an
ordinary close of a document whose host had stopped mid-send, the page had no next chunk to check against - it sat on a
pending `reader.read()`, keeping its stream and one of the host reader handles (64 per filesystem, five-minute
idle expiry: `packages/gateway/src/filesystem.ts:18`) waiting for a byte nobody would look at, with the remote SSH
read still live behind it. `readDocxBytes` now owns the abort: `previewSignal` composes the caller's
signal with any signal the request init already names (standard `AbortSignal.any`, so neither owner is the silent
loser), puts the result on the request that goes out, and registers it on the reader so an abort closes the pending read
instead of waiting for the stream to settle; the listener is dropped in a `finally`, and an abort arriving on the
document's last chunk returns the caller's abort rather than a document to parse, so the answer is the same either side
of the final read. The signal is deliberately not re-checked after the `mammoth` import: the bytes own the abort,
and a document that reaches the reader was still wanted while its last byte was in flight.

Evidence: `packages/ui/src/lib/docx-preview.test.mjs` 8 -> 16 and
`packages/ui/src/hooks/useDocxPreview.test.mjs` (3, new: the real call site under unmount, address switch and
StrictMode replay). The injectable source now stalls the way a transport does - pull asked only while a read waits
`highWaterMark: 0`, nothing settled but a cancel - which is the only shape that separates an abort acted on from an
abort remembered; a stream that keeps producing passes either way. Every part is load-bearing: dropping the listener
hangs the stalled-host case to its timeout (exit 124) and fails 3 of 3 hook cases; sending the old init fails 3 lib cases
and all 3 hook cases; dropping the final check fails 3; dropping the listener cleanup fails 1; composing the caller's
signal alone fails "a stop from either the preview or the request itself ends the read". Logs:
`.dev/verify/ticket-05-docx/MUTATION-*.log` and `.dev/verify/ticket-05-docx/f39669d-*.log`; prose in
[workbench](../../../docs/workbench.md#the-word-document-preview) and
[verification](../../../docs/verification.md#ssh-workbench-ticket-05-follow-up-the-preview-cancel-seam-2026-10-19).
