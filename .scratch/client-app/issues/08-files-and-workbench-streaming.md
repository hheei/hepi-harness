# 08 — 接通文件工作台、流式上传与下载

Type: implementation
Status: resolved
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在本地/SSH 工作区浏览、预览和传输文件，大文件不会占满 App 内存。

## Scope

迁移 workbench 文件浏览/changes/预览与传输。Gateway 使用独立 multipart parser；沿用 Backend 授权 relay、限额、Range 和取消。区分图片 blob 展示和大文件保存，采用票据 04 验证的 native/browser 路径。

## Acceptance

- [x] 现有上传检查、multipart 上传、bytes/Range 下载、预览、文件操作及 changes 在新入口有明确 owner。
- [x] 大小上限、慢接收者、断开和中途取消均有界；不会先把整个上传/下载载入 JS/IPC 再声称 streaming。
- [x] 本地和 SSH workspace 访问正确，路径越界与错误绑定被拒绝。
- [x] file watch 仍明确 not-connected/501；旧 Next 私有 busboy 依赖在替代能力完成后移除。

## Verification

现有文件传输/工作台回归 + 代表性大文件、Range、背压和取消；记录平台、文件大小及峰值内存。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G3/G7/G10，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Report

Revision: the branch tip of `impl/client-app-08`, merged onto `integration/client-app` at `47f501c`. Branch runs
before the final merge are named where they differ. Re-landed on 2026-10-18 as `fix/client-app-08-fresh`: one commit
`be2712f` directly on the current integration tip `e257e3d`, with a tree identical to the branch tip. The focused checks
were re-run on that revision; every other row below still belongs to the reviewed branch, not to it.

### What now owns the file surface

`packages/gateway/src/files-surface.ts` is the **one** implementation of the browser's file vocabulary: the routing
path, the listing, the text/meta preview and byte-served kinds, changed files and diff, the `@` index, the upload's
conflict rules, and the truthful `501` for what does not exist. It is exported as `createFileSurface` and served from
two entries:

| Entry | How it serves the surface |
| --- | --- |
| client ingress (`packages/gateway/src/ingress/index.ts`) | directly, for a Web page's cookie or an App's device bearer |
| Web origin (`apps/web/adapters/workbench.ts`) | assembles the same implementation over its own Backend call, while the Next entry is still the deployed one |

The rules themselves — the routing parser, the MIME/preview table, the index scorer, the conflict strategies and the
name validation — moved to `packages/protocol/src/files.ts`, so the ingress, the Backend's relays and the React
surfaces read one declaration. `apps/web/lib/{file-types,git-types,file-fuzzy,file-upload}.ts` and the Backend's
`apps/server/src/routing-location.ts` copy are now thin re-exports or gone.

`packages/gateway/src/multipart.ts` replaces the Next-private parser: the bounded multipart reader now depends on the
public `busboy` 1.6.0 (with `@types/busboy`) instead of `next/dist/compiled/busboy/index.js`, and
`apps/web/lib/next-compiled.d.ts` is deleted. Its contract is unchanged: a declared over-bound body is refused before
it is read, a chunked one is counted as it arrives, every file is handed on as its own stream in arrival order, and a
caller's refusal ends the request.

### The client half: one file seam on the connection

The React surfaces no longer assemble a file address. `packages/ui/src/lib/file-seam.ts` is the client's half of the
same vocabulary: listing, text preview, meta, the upload check and the upload body, changed files, one diff, the `@`
index, and the two addresses a browser element needs (`read`, `download`). Every one of them resolves against the
connection's own origin and presents the connection's own credential — a Web page's httpOnly cookie or an App's device
bearer — because the App's document is a bundle on `tauri://localhost` and a relative `/api/files/…` there asks the
shell for a file it does not serve.

Bytes follow the credential, and the seam states why rather than hiding it: a cookie page's element carries the cookie
by itself, so the answer is an address and nothing is read through the connection; an App's connection reads the bytes
into a **bounded, revocable lease** (`client.resources.image`, the same read-block scope the transcript uses), and a
file past the bound is refused with that reason instead of being silently truncated. A **download** on a bearer
connection is not an address: streaming a large file to disk is the App shell's native save, which this ticket does not
build, so the control states the absent capability instead of collecting a hundred megabytes into a page blob.

Surfaces migrated to it: `FileExplorer` (list, index, upload check + upload, changed files, download), `FileViewer`
(image/audio/video/pdf bytes, meta, text preview, Git diff, download), `ChatInput` (the `@` index and its server-side
ranking), `ChatWindow` (dropped-file upload), `MarkdownBody` (a local image in a message) and `MessageView`. The
per-component `XMLHttpRequest` path in `packages/ui/src/lib/file-upload-client.ts` is gone — the module now owns only
what a drop *means* — and no surface in the tree opens an `EventSource` or names `/api/files`, `/api/file-index` or
`/api/git` itself; `packages/ui/src/lib/file-seam.test.mjs` asserts both by reading the sources.

### Two dead paths removed rather than faked

- **Live watch.** `FileViewer` opened an `EventSource` per media/document viewer against `?type=watch`, which the
  surface answers `501` for, and which cannot carry a device bearer in any case. The watcher is gone and the header
  states the limit once, in all three locales, instead of a "live" indicator no surface ever answered.
- **Bash full output.** `MessageView` fetched `/api/agent/:id/bash-output`, a route no Backend serves (the old Next
  route that read `/tmp/pi-bash-*.log` was retired in ticket 04). The complete output is a spill file on the *execution
  host*, outside every workspace root this connection can read, so the block says that instead of issuing a request that
  could only look like a page failure.

### Two cancellation defects this ticket fixed

Both hops waited for a response's `close` event **after** a write reported backpressure. A caller that goes away
mid-download has already closed by then, so the wait never ended: the Backend's relay never released the host request
and the host reader stayed open until its five-minute idle expiry. The ingress had the same shape. Both now check
`writableEnded`/`destroyed` before waiting (`drained()` in `packages/gateway/src/index.ts` and in
`apps/server/src/file-relay.ts`), and the surface carries the caller's own `AbortSignal` to every Backend call, so a
download abandoned by its reader releases the host handle. Asserted by `ingress-files.test.ts`'s paced-download case
and by `file-transfer-evidence.ts`'s abort step.

### Measured behaviour

Host `workstation`, Linux 6.17.0-23-generic x86_64, Node v26.5.1. `node packages/gateway/test/file-transfer-evidence.ts`
drives the real ingress, Backend and gateway (single process, so its peak RSS is the whole stack's):

| Step | Size | Result |
| --- | --- | --- |
| upload, browser form | 16 MiB (the host's `MAX_FILE_BYTES` ceiling) | 98 ms, sha256 matched, peak RSS 333.6 MiB |
| download, paused reader | 16 MiB in 259 chunks | 59 ms, sha256 matched, peak RSS 333.6 MiB |
| range | last 4096 bytes | `206`, bytes matched |
| abandon mid-download | — | host reader released (0 open handles) |
| batch past the bound | 3 × 8 MiB against a 20 MiB bound | `413` naming the bound, nothing written, peak RSS 405.8 MiB |

Peak RSS is reported beside each step and is **not** a claim that the transfer is free: it is the whole Node process
including the fixture payload the script itself allocated. What the numbers do establish is the shape the acceptance
asks about — the transfer does not grow with the file, and the bound and the cancellation are real. Platform-native
memory is ticket 04's measurement, not this ticket's.

### Ticket 04's constraints, as they apply here

Ticket 04 measured the desktop WebView and its findings constrain this surface; none of them is re-measured here, and
none is claimed as accepted:

| Constraint (ticket 04) | What this ticket does about it |
| --- | --- |
| the App page origin is `tauri://localhost`, so every gateway origin is cross-origin | the surface is served on the ingress under the same declared-origin rule as every other route; an undeclared origin is refused before it is reached (asserted in `ingress-files.test.ts`) |
| WebKitGTK refuses a `ReadableStream` request body | the browser's own upload path is a form/Blob (`apps/web/lib/file-upload-client.ts`), which is what the measured WebView accepts; no page code streams a request body |
| large downloads must be sliced to ≤1 MiB before IPC (96 MiB whole-chunk IPC peaked 3.06 GB vs 225 MB sliced) | the surface streams from the gateway in bounded chunks and never collects a body; the App's own save path and its IPC slicing belong to the App shell, which this ticket does not build |
| a dropped SSE stream can end cleanly with no throw | unaffected here — file transfers are not SSE, and the terminal protocol's `resync_required` rule is ticket 09's |

Android remains unsupported and unverified; nothing in this ticket is claimed for a mobile target.

### Remaining limits, recorded

- **Browsing was local-only at this ticket's close** — a gateway composed without a workbench served file payloads and
  answered `501 not_supported` for listing, preview, meta, changed files, diff and the index rather than answering from
  this machine's filesystem. That was the truthful state then and is asserted. It is superseded by
  `ssh-remote-workbench` ticket 01 (`impl/ssh-workbench-01` `bd80fc2`, merged into `integration/client-app` as
  `55a594e`), which answers those operations for an SSH-backed workspace through the same `GatewayWorkbench` protocol;
  see [workbench](../../../docs/workbench.md#the-ssh-workbench). This ticket is not reopened: it built no remote host
  adapter, and remote writes, live watch and DOCX preview were outside both tickets.
- **The App's native save is not built.** The shared surfaces are wired to the connection (above), and a download
  navigates on a cookie host. On a bearer host the control states that saving needs the App shell's native save, which
  is ticket 15's work; this ticket neither collects the file into memory nor claims a download it cannot perform.
- **A bearer preview is bounded by the connection's lease budget** (`limits.imageBytes`, 32 MiB by default): past it the
  file is refused with that reason. The bound is the host's to state, which is why `createClient` now takes `limits`.
- **file watch, DOCX preview and linked-directory approval stay `501`** by decision (spec: no watcher).

### Checks

| Check | Command | Exit | Log |
| --- | --- | --- | --- |
| gateway suite (339 tests) | `node --test packages/gateway/test/*.test.ts` | 0 | see below |
| file surface + reader | `node --test packages/gateway/test/ingress-files.test.ts packages/gateway/test/multipart.test.ts` | 0 | 14 tests |
| backend relay + end to end | `node --test apps/server/test/file-relay.test.ts apps/server/test/files-transfer.test.ts` | 0 | 8 tests |
| Web unit suite (150 tests) | `node scripts/test-web-unit.mjs` | 0 | `.dev/verify/<run>/web-unit.json` |
| workspace typecheck | `pnpm -r typecheck` | 0 | |
| selected checks | `node scripts/verify.mjs --profile=fast` | 0 | `.dev/verify/<run>/verify.json` |
| real-browser path through the ingress | `node apps/web/e2e/files-transfer.mjs` | 0 | 17 checks passed |
| representative transfer | `node packages/gateway/test/file-transfer-evidence.ts` | 0 | numbers above |
| shared UI suite (167 tests) | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/ticket-08/ui-suite.log`; `packages/ui/src/lib/file-seam.test.mjs` is this ticket's case |
| whole gateway suite (362 tests) | `node --test packages/gateway/test/*.test.ts` | 0 | `.dev/verify/ticket-08/gateway-suite.log` |
| shared UI typecheck | `pnpm --filter @hepi/ui typecheck` | 0 | |
| changed-package checks | `pnpm verify:changed --base=integration/client-app` | 1 — `check-docs` is the only failing step, with the same 12 pre-existing links under `.scratch/` and none of them in a file this ticket touched; changed typecheck, workspace tests, Web unit (54) and script tests (51) and entrypoints 0 | `.dev/verify/2026-10-18T02-38-24-645-verify-changed/verify.json` (sha `b236f70`, clean) |
| encoded browser path at the ingress (9 tests) | `node --test packages/gateway/test/ingress-files.test.ts` | 0 | `.dev/verify/ticket-08/ingress-files-encoded.log` — one case is the decoded name: space, Unicode, `%`, encoded separator, encoded escape, malformed encoding |
| mounted file surfaces under a bearer (10 checks) | `node apps/web/e2e/ux-file-surfaces.mjs` | 0 | `.dev/verify/ticket-08/file-surfaces-bearer.log` — production `MarkdownBody` and `FileViewer` behind a real bearer client: every file request carried it, both images are leases |
| the review's own repros, rerun | `node /tmp/ticket08-review-19b2c59-seam.mjs`, `node /tmp/ticket08-review-19b2c59-browser.mjs` | 0 | `.dev/verify/ticket-08/review-repro-seam.log`, `review-repro-browser.log` — the Backend is asked for `my note.md`; every file request carries the bearer and no image fails |
| documentation links | `pnpm check:docs` | 1 — the same 12 pre-existing links under `.scratch/`, none of them in a file this ticket touched | `.dev/verify/2026-10-18T01-59-53-389-verify-changed/check-docs.log` |

### Review fixes

The review on `19b2c59` reported three material findings: two are this ticket's, one belongs to the shared read-block
reader and was delegated rather than edited here.

- **A local markdown image on a bearer connection built its own `<img src>`**, and the viewer's first frame pointed an
  element at an address no element can authenticate, so the `401` arrived before the lease did and the viewer reported a
  failed image. Fixed where the difference belongs: `FileSeam.url` answers an address only where a browser element can
  carry the credential — a Web page's cookie — and `useFileBytes` starts with no address on a bearer connection. The
  markdown body reads through that hook, shows the lease, states the refusal in words when there is one, and never
  renders a protected address; the viewers clear a load error when the address changes, so a failure belongs to the
  address it failed for.
- **A percent-encoded browser path reached the host still encoded** (`files-surface.ts`), so a name with a space, a
  Unicode letter or a `%` could not be browsed, previewed, uploaded or downloaded. The surface now decodes the path
  exactly once, where the URL stops being a URL, answers `400` for a path that is not valid encoding, and leaves every
  escape to the host's own confinement.
- **The shared read-block reader buffers a whole response before it checks its budget** — the shared reader's own fix,
  delegated and not edited here. The seam's semantics for its own refusal are corrected: a file past the bound cannot be
  *shown* here, which is a preview's answer, not the native save a download states.

Exact commands, revisions and log paths are recorded in
[verification](../../../docs/verification.md#files-and-workbench-streaming-ticket-08).
