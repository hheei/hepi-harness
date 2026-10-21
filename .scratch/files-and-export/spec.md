# Files transfer: upload into an execution folder, and binary preview/download

Status: **implemented** on `impl/files-transfer` (`5216cc3`, `499a61b`, `258bd35`, `b3d2f33`); evidence in
`evidence.md` beside this file. Session export is deliberately **out of scope** here and stays a separate, deferred
capability (see `research.md` on `research/files-and-export`).

## Scope

In: (1) uploading a file into a directory of an execution workspace, with the copied browser UI unchanged, and (2)
serving binary preview/download bytes, so the copied viewer shows images, audio and video and its download link works.

Out, and left exactly as they are: session export, live file watch, DOCX/PDF preview, file CRUD, provider or subagent
work, and every unrelated surface.

## Reused sources

- Copied browser UI, unchanged: `apps/web/components/FileExplorer.tsx` (upload + `upload-check` + conflict question),
  `apps/web/components/ChatWindow.tsx` (chat drop), `apps/web/components/SessionSidebar.tsx` (upload to project root),
  `apps/web/components/FileViewer.tsx` (`type=read|download|meta`).
- Copied pi-web libraries, reused verbatim where they are host-independent: `apps/web/lib/file-upload-client.ts`
  (the request shape), `apps/web/lib/file-upload.ts` (`validateUploadFileNames`, `parseUploadConflictStrategy`,
  `UPLOAD_CONFLICT_STRATEGIES`), `apps/web/lib/bounded-form-data.ts` (`parseFormDataWithinLimit`),
  `apps/web/lib/file-types.ts` (MIME and preview kinds).
- Host-side file work, reused unchanged: the gateway's file RPC primitives — `fileInfo`, `createTempFile`,
  `appendFile`, `renameFile`, `remove`, `openBinaryReader`, `reader.read`, `reader.close` — on the local filesystem
  and through the SSH filesystem, both already bounded by `MAX_FILE_BYTES` (16 MiB).
- The backend relay pattern: `apps/server/src/terminal-relay.ts` (binding by routing cwd, streamed pass-through,
  caller-cancelled host request).

The host-dependent halves of the copied upload library (`inspectUploadTargets`, `replaceUploadFile`) read the local
filesystem, and the files here live on the execution host, so those two rules are implemented where the files are — in
the gateway — instead of being run on the Web host, which owns none of them.

## Transport

Four hops, each one a seam this repository already has. Only the payload routes are new; the JSON file RPC
(`/v1/files`) is untouched.

| Hop | Route | Carries |
| --- | --- | --- |
| browser → Web | `POST /api/files/<routing dir>?type=upload&conflict=<strategy>` | multipart, field `files` (copied client, unchanged) |
| browser → Web | `POST /api/files/<routing dir>?type=upload-check` | JSON `{fileNames}` |
| browser → Web | `GET /api/files/<routing path>?type=read|download` | the browser's own `Range` header |
| Web → backend | `POST /api/files/upload?cwd=&name=&conflict=` | the file's bytes, streamed |
| Web → backend | `POST /api/files/upload-check` | JSON `{cwd, fileNames}` |
| Web → backend | `GET /api/files/bytes?cwd=` | the bytes back, streamed |
| backend → gateway | `POST /v1/files/upload?workspaceId=&path=&conflict=` | the file's bytes, streamed |
| backend → gateway | `POST /v1/files/upload-check` | JSON `{workspaceId, path, names}` |
| backend → gateway | `GET /v1/files/bytes?workspaceId=&path=` | the bytes back, streamed |
| gateway → host | the existing file RPC methods | bounded chunks |

Why a byte route rather than the existing JSON one: the gateway's JSON reader caps a request at 1 MiB, and base64
inflates by a third, so the effective ceiling was about 768 KiB against a 16 MiB file policy. The byte routes stream
in bounded chunks and keep the same 16 MiB ceiling, so no hop ever holds a whole file beyond the one place it must.

## Contract

**Upload.** Per file, on the host: the parent directory must exist and be a directory; the target is inspected with
`fileInfo` (`lstat` semantics, so a symbolic link is a link and not the file it points at).

| Conflict strategy | Target absent | Target is a regular file | Target is a directory or a symlink |
| --- | --- | --- | --- |
| `error` (default) | written | 409 `conflict` with `conflicts`/`nonReplaceable`, nothing written | 409 `conflict`, nothing written |
| `overwrite` | written | replaced atomically (staged in the workspace root, then renamed over the target, keeping the target's mode) | refused, `not_replaceable`, target untouched |
| `skip` | written | skipped, reported in `skipped` | skipped, reported in `skipped` |

A write that fails mid-stream leaves no partial file: the bytes go to a host-created temporary file and are renamed
over the target only once the whole body arrived. Over the 16 MiB ceiling the upload is refused with `file_too_large`
and the temporary file is removed.

**Download and preview.** `GET /v1/files/bytes` streams a regular file up to 16 MiB with `accept-ranges: bytes`,
answering a single `Range: bytes=a-b` with 206 and `content-range`, an unsatisfiable range with 416, and a file over
the ceiling with 413 `file_too_large`. The Web adapter gives binary kinds their own MIME from `file-types.ts`, keeps
`content-disposition` (RFC 5987) for `type=download`, and leaves the text preview JSON path as it is.

## Seams under test

1. `packages/gateway` HTTP surface (`POST /v1/files/upload`, `POST /v1/files/upload-check`,
   `GET /v1/files/bytes`) against `LocalFilesystem`, and the same upload contract against the localhost SSH fixture.
   Catches: conflict rules, atomicity, the 16 MiB bound, range answers. Misses: the browser's own rendering.
2. `apps/server` relay routes. Catches: routing-cwd to workspace binding, the streamed body arriving whole, refusals
   keeping the gateway's status, the caller's connection cancelling the host request. Misses: host file behaviour.
3. `apps/web/adapters/workbench.ts` at its request/response contract (stand-in backend, as
   `worktree-picker.test.mjs` does). Catches: the shapes the copied UI reads, name validation, conflict passthrough.
   Misses: real filesystem behaviour.

## Decisions taken

1. **A byte route beside the JSON RPC**, rather than raising the JSON cap or chunking through `writeFile`/`appendFile`
   per request: it is the only shape that keeps one request per file, no base64 inflation, and a bounded buffer at
   every hop. The JSON RPC keeps its 1 MiB reader unchanged.
2. **One file's bound is the host's, the batch's is the copied route's.** `MAX_FILE_BYTES` 16 MiB is enforced per
   file by the host, which names the file it refused; the whole upload is bounded at the copied route's own 100 MiB
   (`MAX_UPLOAD_TOTAL_BYTES`), enforced by the Web hop while the multipart body is read. The body is parsed as it
   arrives and each file is relayed onward as its own streamed request, so neither hop holds a whole file or a whole
   batch. (Earlier this was one 17 MiB buffered body; the parent directed the change.)
3. **Downloads keep the 16 MiB ceiling**, so a larger file is refused with a named limit rather than streamed
   unbounded; media seeking works through `Range` for files within the ceiling.
4. **Nothing is written before every conflict is known**: `error` inspects first and refuses the whole request.

## Open decisions (not invented here; reported to the parent)

Decisions 1-4 above were implemented as written; the limits they imply are listed in `evidence.md`. What follows stays
open and is unchanged by this work.

1. **Resolved by the parent: the batch bound is the copied route's own 100 MiB, streamed.** The earlier 17 MiB
   buffered body was narrower than any policy in the tree and was replaced by a streaming multipart parse; the parser is
   Next's own compiled copy of busboy (`next/dist/compiled/busboy/index.js`), already in the tree, rather than a new
   dependency.
2. **The copied UI carries no size policy of its own**: it has no pre-check and no warning for an oversized file — the
   explorer shows progress (`files.uploading`) and then the server's own refusal text. Only the composer's image path
   has client-side limits (10 MiB per image, 10 images, `apps/web/lib/image-attachments.ts`), and a chat drop splits
   by kind: images to the prompt, everything else to the upload route (`splitDroppedItems`). So a per-file/per-request
   decision is the server's alone to make; no UI text has to change with it.
3. Whether `type=download` should stream past 16 MiB (streaming without buffering is possible, but it leaves the
   existing per-payload policy).
3. Whether the copy `error` default should stay the default in this deployment, where the browser always pre-checks
   with `upload-check` first.
