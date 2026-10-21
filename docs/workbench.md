# Read-only workbench

Ticket 07 selected file browsing, text preview, Git changed-file status and diff review. The shared workbench in
`packages/ui` is the one surface for both entries: the Web page and the desktop App reach the ingress, which forwards to
the backend's authenticated `/api/workbench`, and the backend forwards to the configured gateway's authenticated
`/v1/workbench`. Gateway credentials and workspace root paths never reach the browser, there is no browser filesystem
access and there is no second agent runtime. (`apps/server` still serves its own authenticated **Diagnostic Page** at
`/workbench`; it is read-only and not a client entry.)

The read-only workbench serves both kinds of gateway. `startGateway` mounts one `GatewayWorkbench` either way — over this machine's registry for a local gateway, and over the SSH registry for a remote profile — so the same `POST /v1/workbench` protocol, the same path rules and the same DTOs answer for an SSH-backed `/workspace/<id>`. Only the host differs: on an SSH gateway a preview is a bounded read through the `SshFilesystem` session the file routes already use, a listing walks the host's own directories through the same session, and the changed files and the diff run the same git argv through the `SshRunner` the worktree surface already uses. SSH auth and host-key material stay in the profile the gateway started with, so neither the backend nor the browser receives a credential or constructs a command. See [the SSH workbench](#the-ssh-workbench). No terminal state is added to durable conversation transcripts.

## Terminal sessions

Terminal sessions are their own gateway surface, not part of the read-only workbench. `POST /v1/terminal` opens one in a
registered workspace root, `GET /v1/terminal/<id>/events` streams its output as server-sent events and ends with one
exit frame, `POST /v1/terminal/<id>/input` and `.../resize` reach the shell, and `DELETE /v1/terminal/<id>` closes it
and answers the exit that follows. The shell runs through the gateway's own Python 3 helper on the execution host —
this machine, or the SSH host over the same runner the other surfaces use — which gives it a real pseudoterminal and
ends the process group on close, on shell exit, or when the gateway that owned it disappears. The page reaches the same
surface through the Web adapter's `/api/terminal` and the backend's relay, and holds **one** stream for every mounted
tab (`/v1/terminal/events?tabs=`), each frame naming its session.

**A slow receiver is disconnected; its shell is not.** A terminal subscriber is synchronous and returns nothing, so a
consumer that stops reading cannot be paced — the helper keeps reading its pseudoterminal whatever the gateway does with
the bytes. Every terminal byte, output frames and the keepalive alike, goes through one writer that encodes the frame
once and compares `response.writableLength` against `TERMINAL_STREAM_BUDGET_BYTES` (4 MiB,
`packages/gateway/src/terminal.ts`, overridable per `TerminalSessions` for tests). Once a connection is **already**
holding more than that, it is ended; the session is untouched, so the caller reconnects with the cursor it read and is
answered from the session's own retained tail. The comparison is deliberately "already over" rather than "would go
over": that keeps a frame the unit of progress, so even a replay larger than the budget delivers a whole frame and the
caller's cursor advances instead of looping. The bounded quantity is the pending bytes — the budget plus at most the
one frame being written — and it is one number per connection, not per tab.

**A permanently slow reader is not promised lossless history.** It is answered from the retained tail with
`reset: true`. What it must do with that is replace what it shows rather than append.

**A quiet stream stays attached.** Between keystrokes a terminal writes nothing, so the gateway writes a **comment
frame** — an event-stream line with no field name — on the cadence in `TERMINAL_HEARTBEAT_MS` (30 s, or
`HEPI_TERMINAL_HEARTBEAT_MS`/`heartbeatIntervalMs`; `0` states no keepalive). It carries no `id:` line: a cursor on a
comment frame would move the caller's reconnect position to an offset no output exists at. It is written through the
same writer and measured against the same budget as every other terminal byte.

**Reconnect, replay and the session's own name.** A session keeps at most **128 KiB of its own output**
(`TERMINAL_REPLAY_CHARS`), measured in the characters a caller sees, so a reconnect is bounded and a long-running
command cannot grow a gateway's memory without limit. A session with no caller attached is kept for a **120-second
reconnect window** (`TERMINAL_RECONNECT_MS`) and then closed, so a dropped browser connection has time to come back and
a closed tab leaves no shell behind; a session that has already ended is forgotten when its window runs out.
`GET /v1/terminal/<id>/events` takes the caller's cursor as `after` or as the standard `Last-Event-ID` header and
answers with the output produced since it, or with the retained tail and `reset: true` when the cursor is behind what
is kept. Every output frame carries its own offset as the event's `id`, which is what a browser's own `EventSource`
reconnect continues from. A caller may name its session with `id` on `POST /v1/terminal`: opening an id already
running in the same workspace reaches that session instead of starting a second shell, an id already running in another
workspace is refused, and `GET /v1/terminal/<id>` reports what the session is (including whether it has ended) without
attaching to it. On the shared stream, one tab's exit ends that tab's frames and nothing else — the stream stays open
for the tabs still running and is ended by the caller going away.

A host that cannot serve a session names its reason in the body: `not_supported` for a machine with no Python 3, no pty
module or a transport that cannot hold a session open, and `unreachable` for an SSH host that cannot be contacted. Both
travel as the route's one refusal status, `409`, which is what the panel shows; `501` stays the answer of a gateway
**composed without the terminal capability at all**, a different fact about the deployment rather than about the host.
An unknown session answers `unknown_terminal`; a cwd outside the workspace answers `path_denied`.
The two hosts are answered alike: an SSH host whose `python3` is missing is read from the host's own stderr and exit 127,
a local one from its spawn error, and both name python3 (`packages/gateway/src/terminal.ts`).
The terminal panel in the browser is ticket 13's; the two numbers above and the stream budget are this surface's whole
configuration. See [local integration](local-integration.md) for the CLI and the request shapes.

## Worktrees

Worktree list, create and remove are a gateway host capability of their own, on `POST /v1/worktrees`, served by both kinds of gateway: `GatewayWorktrees` runs git on this machine and `SshWorktreeServer` runs the same git argv through the existing SSH runner, so a local host and a remote host apply one set of rules. `packages/gateway/src/worktrees.ts` is adapted from pi-web's `lib/worktree.ts` at the pin below — the snapshot is
`packages/gateway/vendor/pi-web/worktree.ts` — and upstream's Next route (`app/api/worktrees/route.ts`) is the
request/response contract, declared in `packages/protocol/src/gateway.ts`.

| Request | Answer |
| --- | --- |
| `{ operation: "list", workspaceId }` | `{ projectRoot, isGit, isTopLevel, currentWorktreePath, worktrees: [{ path, branch, isMain }] }` |
| `{ operation: "create", workspaceId, branch }` | `{ path, branch }` |
| `{ operation: "remove", workspaceId, path, force? }` | `{ removed }` |

The rules the host enforces, all decided before git is asked to write anything: a create needs a registered root that is a checkout and a non-blank branch (an empty or unusable branch is `invalid_request`, an unregistered id is `unknown_workspace`, a directory that is no checkout is `invalid_root`, and each of them leaves no directory and no git state behind); a remove of the main checkout is `main_worktree` and of a path that is no worktree of this repository is `not_a_worktree`; a removal git refuses for uncommitted work answers `dirty` with git's own message, and `force: true` is a separate, explicit request that succeeds. Worktrees are created at `<repo>-worktrees/<branch>`, as upstream places them, and a listing for a root whose checkout is already gone falls back to the repository the `-worktrees` convention names, reporting it as the project root rather than failing. A prunable entry, and any listed path that is not a directory on the host, is left out of the listing.

A host that cannot serve the capability answers `not_supported` with its own name — a gateway composed without a worktree surface, and a host whose git is absent, both do. A transport failure names its own state (`unreachable`, `outcome_unknown`) and never falls back to this machine's repository.

Verification: `packages/gateway/test/worktrees.test.ts` builds real repositories and asserts every case above through `POST /v1/worktrees` on a local gateway, plus the same contract on an isolated localhost SSH host driven by the `sshd` fixture (skipped, and reported, only when that fixture is unavailable). Every wait is an observable state, with no sleeps.

### The browser picker

The browser reaches the same capability through the Web adapter's `GET`/`POST`/`DELETE /api/worktrees`, which keeps the copied route's request and response shape — the browser asks by `cwd` and reads `{ isGit, isTopLevel, currentWorktreePath, worktrees }`, and a create is `{ cwd, branch }` while a removal is `{ cwd, path, force? }` — and adds the one thing a conversation needs: **a checkout is a target only when it is recorded as a workspace**. A conversation binds a workspace id, so `POST /api/worktrees` records the created checkout as a folder of the project (the host canonicalizes and registers the root first, and the record is written only after the host accepted it), and `DELETE` drops that folder record in the same request, retaining its binding so a conversation already bound there keeps running. A checkout hepi holds no record of is listed truthfully and is not pickable, and the menu says why. A removal of a project's default folder is refused before git runs, because a project always keeps a default (the replacement rule is its own operation).

The picker itself is the copied `ProjectWorktreePicker`, wired: the list marks the main checkout from the host's own answer, a create adds the checkout without a page reload and moves the composer into it, a dirty removal becomes the menu's own question with `Force` as a separate action, and a host that cannot serve worktrees shows a named limit where the list would be while the project box keeps working. A checkout whose directory is gone falls back to the project root instead of breaking the list.

Verification: `apps/server/test/worktree-picker.test.ts` (the backend's own route over a real repository and a real store: list, create, the recorded folder and the conversation that runs inside the created checkout, a bad create that leaves the list unchanged, the dirty refusal with its 409 and its `dirty` marker, the forced removal with its retained binding, a vanished checkout, an unregistered workspace, the default-folder refusal, and a gateway composed without the worktree surface answering `not_supported`), `packages/ui/src/lib/workspace-api.test.mjs` (the picker's request and answer shapes, the workspace a cwd names, and the home/default derivation behind the picker), and `apps/web/e2e/ux-worktree-picker.mjs` (`pnpm --filter @hepi/web test:worktree-picker`; the production build, the real backend, a real gateway and a real git repository in a headless browser, with every wait an observable UI, request, filesystem or stored-state change).

The React UI speaks one file vocabulary, and one implementation answers it: `packages/gateway/src/files-surface.ts`
(exported as `createFileSurface`), whose rules are declared in `packages/protocol/src/files.ts`. The **client ingress**
serves it for a Web page and for an App, so there is no second copy of listing, preview, upload or Git logic anywhere
on the browser path.

| Copied surface | Browser request | What answers it |
| --- | --- | --- |
| FileExplorer tree | `GET /api/files/<routing path>?type=list` | the workbench `files` operation, filtered per directory |
| FileViewer text source | `GET /api/files/<routing path>?type=read` or `?type=meta` | the workbench `read` operation |
| FileExplorer changes | `GET /api/git/status` | the workbench `changes` operation |
| `@` mention index | `GET /api/file-index` | the workbench `files` operation, ranked by the protocol's own scorer |
| FileViewer diff mode | `GET /api/git/diff` | the workbench `diff` operation |
| upload control, composer drop | `POST /api/files/<routing dir>?type=upload&conflict=` | one byte request per file, to the host that holds the folder |
| download link, binary preview | `GET /api/files/<routing path>?type=download` or `?type=read` | the host's own byte payload route |

On the browser's side every one of those requests is made by one named seam on the connection,
`packages/ui/src/lib/file-seam.ts`: the explorer, the viewer, the composer's `@` menu, a dropped upload and a markdown
image all ask it, and none of them assembles an address. That is what makes the same tree work in two hosts — a Web page
is served from the origin it calls, so its relative path and its httpOnly cookie are enough, while an App's document is
a bundle on `tauri://localhost`, where a relative `/api/files/…` asks the shell for a file it does not serve and no
element can present the device bearer. The seam resolves the routing path against the connection's own origin and
presents the connection's own credential.

Bytes follow that credential, and the seam states the difference rather than hiding it. A cookie page's `<img>`, media
element or download navigation carries the cookie by itself, so the answer is an **address** and nothing is read through
the connection — the bytes stream with whatever range the element asks for. An App's connection reads the bytes into a
**bounded, revocable lease** (`client.resources.image`, the same read-block scope the transcript uses); a file past the
lease's bound is refused with that reason, and the bound is the host's to state (`createClient({ limits })`).

A **download** on a bearer connection has no element address, and the save control is not the same thing: see
[native save](#native-save-the-apps-own-write-path) below.

The seam hands out an address only where a browser element can carry the connection's credential, so a bearer
connection has none: the markdown body's local image and the viewer's own image ask it for bytes and show the lease, and
a file it cannot read is stated in words rather than framed as an empty element.

Live file watch is not connected anywhere in that tree: the viewers show the file they read and say so once, in the
header, rather than opening a watcher the surface answers `501` for.

A routing path is a path, and the address that carries it is a URL, so the two are not the same string: a file called
`my note.md`, `笔记.md` or `100%.md` reaches the surface as `%20`, UTF-8 escapes and `%25`, and the surface decodes
the path **once**, at the point the URL stops being a URL (`routingPathOf` in `files-surface.ts`). Everything behind
that point — the protocol's own parser, the Backend, the host's confinement — reads a path, which is what makes an
encoded `..` an ordinary path the host refuses instead of a hop that skipped the check. A path that is not valid
percent-encoding names no file and is answered `400`, and the download's own name comes from the decoded path, so a file
saves under the name it has on the host.

### Native save: the App's own write path

Saving a file means two different things on the two hosts, and neither is a preference.

| Host | What the control is | Where the bytes go |
| --- | --- | --- |
| Web page | an anchor on `?type=download` | the browser navigates and streams the file to disk under its own name; the page never holds it |
| Packaged App | a button, and the shell's own save | the connection reads the file, and the shell writes it in slices the page awaits |

The App's document is a bundle on `tauri://localhost`, so it has no download navigation to give an element, and no
element of it can present the device bearer. Its save is therefore the shell's: `app_save_choose` asks the platform's
own save dialog under the file's name; `app_save_begin`, `app_save_append`, `app_save_finish` and `app_save_abort`
open, write, commit and remove one destination. The page reads the file through the connection it already has — the
same `?type=download` address, under the same credential, with no token in any URL — and hands the shell one slice at a
time.

**The bound is at the IPC boundary.** `SAVE_CHUNK_BYTES` is 1 MiB, the page awaits each slice before reading the next,
and the shell refuses a slice larger than that. Ticket 04 measured why: handing the WebView's own 69–73 MB chunk across
IPC peaked at ~3.02 GB RSS for a 96 MiB file, while 1 MiB slices saved the same bytes at ~225 MB. Neither the page nor
the shell ever holds the whole file, and the source is only ever read.

**What a person gets on every way out.** A closed picker transfers nothing and reports nothing. A refused read never
creates the destination, so a missing, denied or over-policy file leaves no empty file behind. A failure mid-write or a
failed flush removes the partial file this run opened and says why; it never reports success, and a failed remote write
is never retried. Replacing an existing file happens only when the platform's own dialog confirmed it — the shell
refuses to truncate one that was not confirmed, and an abort removes only the file this save opened.

The destination is fixed when the save starts: the connection, the routing path and the path on disk are captured by
the call, so a view that switches file, workspace or connection cannot redirect bytes that are already moving. Closing
the connection ends the read, which the save reports as a cancellation and cleans up as one.

The seams are `packages/ui/src/lib/file-save.ts` (the read-slice-write loop and `savePathOf`, the one decision about
which path a host has), `packages/ui/src/components/FileSaveControl.tsx` (the control the viewer and the explorer
both render), `apps/app/src/save-host.ts` (the App's half of the IPC contract) and `apps/app/src-tauri/src/save.rs`
(the shell's file handling and its tests).

### File bytes: upload, download and binary preview

A file is moved as a body, not inside a JSON request. The workbench proxy reads a JSON request capped at 1 MiB — about
768 KiB of file once base64 has inflated it — against a file policy of 16 MiB (`MAX_FILE_BYTES`), so the bytes take
their own routes beside it. Every read and every write below is one `execute` call on the filesystem the gateway
already serves, so a local workspace and an SSH workspace apply one set of rules, and the host's own confinement is
what refuses a path that climbs out of the workspace.

| Layer | Route | Carries |
| --- | --- | --- |
| browser → Web | `POST /api/files/<routing dir>?type=upload&conflict=<strategy>` | multipart, field `files` (the copied client) |
| browser → Web | `POST /api/files/<routing dir>?type=upload-check` | `{ fileNames }` |
| browser → Web | `GET /api/files/<routing path>?type=read|download` | the browser's own `Range` header |
| Web → backend | `POST /api/files/upload?cwd=<routing file>&conflict=` | the file's bytes, streamed |
| Web → backend | `POST /api/files/upload-check` | `{ cwd, fileNames }` |
| Web → backend | `GET /api/files/bytes?cwd=<routing file>` | the bytes back, streamed |
| backend → gateway | `POST /v1/files/upload?workspaceId=&path=&conflict=` | the file's bytes, streamed |
| backend → gateway | `POST /v1/files/upload-check` | `{ workspaceId, path, names }` |
| backend → gateway | `GET /v1/files/bytes?workspaceId=&path=` | the bytes back, streamed |

The host's own rules, unchanged from the copied route they come from: the parent directory must exist and be a
directory; a target that exists is a conflict, and under the copied default (`error`) the whole request is refused
with the names that exist and the names that cannot be replaced before anything is written; `skip` leaves an existing
name alone and reports it; `overwrite` replaces a regular file atomically — staged in a host-created temporary file
and renamed over the target — and refuses a directory or a symbolic link, whose contents are not this file's to
replace. A replacement keeps the target's own permissions, on both the local and the SSH host, so an executable that
was replaced is still executable. A write that fails mid-stream — a refused request, a body that dies, a caller that
disconnects — leaves no partial file and no staging file. A file over the 16 MiB per-payload policy is refused with
`file_too_large` (HTTP 413) rather than streamed unbounded, and the same ceiling applies to a download, which is the
file itself rather than a text preview: one `Range: bytes=a-b` is served as 206 with `content-range`, an
unsatisfiable range as 416, and `accept-ranges: bytes` is advertised.

An upload request may carry several files and up to 100 MiB in total (`MAX_UPLOAD_BATCH_BYTES`, or
`HEPI_UPLOAD_BATCH_BYTES` on the ingress), enforced while the body is read rather than after it is buffered: the
surface parses the multipart body as it arrives and relays each file onward as its own streamed request, so no hop holds
a whole file or a whole batch. The two limits answer separately, and each says which it is: one file's 16 MiB is the
host's policy and the host names the file it refused, while the batch bound is refused by the hop reading the form, with
the total it passed. A refusal that arrives while the caller is still sending is written first and the rest of the body
is read out afterwards, so the caller reads the refusal instead of a reset connection.

`type=read` serves bytes for the kinds the browser renders itself — image, audio, video, PDF **and Word document** — and
for a file the preview reports as binary, with the MIME from `packages/protocol/src/files.ts`; a text file answers
`{ content, language, shownBytes, size, truncated, previewOnly }`. Those last two numbers are the host's own: how many of
the file's bytes this one chunk carries, and the whole size the host stated (`null` when it stated none). The preview is a
fixed 200 KiB bound with **no continuation** — `offset` is not a parameter this surface serves, and a request naming one
is answered by the named `501` rather than the first chunk again — so a viewer states the bound instead of drawing a
progress bar out of its own delivered size. `type=meta` still answers
`{ size, language, mime, previewKind }` for every kind. A `.docx` is served as its own bytes because a text preview of a
package says nothing about the document: the browser reads it (see [the Word document preview](#the-word-document-preview)).
Live file watch and linked-directory approval answer a named `501` — the capabilities do not exist, and this migration
does not invent a watcher.

**A refusal answers with the cause it has.** The workbench is the surface's only route to a host's tree, and one call
can fail for five different reasons, each of which asks the browser for a different next move. They are no longer
collapsed: `unknown_workspace` is the `404` it always was, a path the host refused is its `403`, **a path the host does
not have is `404 not_found`** — the workbench's own code for it, told from this machine's `ENOENT` or an SSH helper's
`not_found` — a host the Backend could not reach is the `503 gateway_offline` the backend stated, a gateway composed
**without** a workbench answers `501 not_supported` (the gateway route's own absence fallback, matching `/v1/worktrees`
and `/v1/installs`), and any other refusal — a read the host could not complete — is `500 operation_failed`. Until this
revision every cause but the first two shared one `501` reading "this host cannot serve a file listing: it is composed
without the workbench surface", which stated a false fact about the deployment in the ordinary case: the tree and the
surface both cache a listing, so opening a file that was deleted after the cache was filled asked the host for a file it
no longer has and the browser was told its gateway cannot browse files at all. A gone file then kept one name for
everything else that failed, and `500` and `404` are different next moves for a person: a read that may answer next time,
and a folder that has to be re-read because the file it listed is not there. The words now name the cause, and no reason
the host did not give is invented.

**A refusal says nothing about where the workspace lives.** A payload refusal that came from the host's own disk
states the host's *filesystem* path — a registered local root, or a profile's remote root — in its message and in its
`path` field, because that is where the host found the failure, and the general `/v1/files` surface must keep reporting
real host paths for the execution tools that act on them (ADR 0002). The browser's payload routes are not that surface:
the answer there keeps the host's code and status and states the failure about the path the caller itself named, with no
host path in it. Only a host answer is rewritten; a refusal this package words itself already speaks in workspace paths.

### The file surface is one implementation

The browser's file vocabulary is read by **one** module, `packages/gateway/src/files-surface.ts`, and its rules —
the routing path parser, the MIME and preview-kind table, the `@` index scorer, the upload conflict strategies and the
name rules — are declared once in `packages/protocol/src/files.ts`. The client ingress serves that surface for a Web
page and for an App, so a browser path cannot mean one thing at one entry and another somewhere else. Live file watch,
linked-directory approval and file CRUD other than upload stay `501`; **a `.docx` is not among them** — it is served as
bytes and previewed in the browser (see [the Word document preview](#the-word-document-preview)).

The upload's multipart body is read by `packages/gateway/src/multipart.ts` over the public `busboy` dependency. The
old reader imported `next/dist/compiled/busboy`, a file inside a framework build that only one entry happened to ship;
it is gone, along with its type declaration. The reader's contract is unchanged and still asserted: a declared body
over the batch bound is refused before a byte of it is read, a chunked one is counted as it arrives, each file is handed
on as its own stream, and a caller's refusal ends the request where it stands.

A download's body is the Backend's own, piped rather than collected, and its write waits on the caller's socket: a
reader that stops reading pauses the host's read, and a caller that goes away mid-download closes the Backend request,
which releases the host's reader handle. Both hops had a wait that could hang forever — a backpressure wait that
registered its `close` listener after the close had already fired — so an abandoned download held a host reader until
its idle expiry; both now check the state before waiting.

Verification: `packages/gateway/test/ingress-files.test.ts` (the surface at the seam a client uses: browse, preview,
meta, listing, the `@` index, an upload past the JSON request limit, the pre-flight check and conflict refusal, a
whole download and a `206` range, an SSH workspace routing to its own host, the device-bearer and undeclared-origin
branches, the named `501`s, a batch past the bound refused with the bound and nothing written, and a download whose
reader is paced by its caller and released when the caller goes away), `packages/gateway/test/multipart.test.ts` (the
bounded reader on its own), `packages/gateway/test/file-transfer.test.ts` and
`packages/gateway/test/file-transfer-sshd.test.ts` (the payload routes on a local gateway and through the in-process
SSH host, down to the frames it was handed), `apps/server/test/file-relay.test.ts` (the backend relay: the binding a
routing cwd resolves to, the streamed body, the host's own refusal, and the caller's connection cancelling the host
request), `apps/server/test/files-transfer.test.ts` (the same routes end to end through a real gateway and the real
workspace filesystem), and `packages/ui/src/lib/file-upload-client.test.mjs` (the upload and conflict shapes the
explorer and viewer read, through the shared client).

The whole path is driven in a real browser against the **client ingress** by
`pnpm --filter @hepi/web test:files-transfer`: the page's own login cookie, an `XMLHttpRequest` multipart upload the
browser builds itself, a 1.4 MB file past the JSON request limit, the pre-flight check and conflict refusal, an
`<img>` that decodes the uploaded image, a `206` range answered from the host's reader, a download navigation that
saves the whole file under its own name, and the named `501` — all through a real gateway, a real Backend and a real
workspace. (The browser components' own rendering is `ux-workbench-scope.mjs`'s.)

What a person reads when a file surface fails is `pnpm --filter @hepi/web test:file-failures`
(`apps/web/e2e/ux-file-failures.mjs`): four workspaces mounted side by side in the real `FileExplorer` and `FileViewer`
— one that answers, a read that failed, a host that could not be reached, and a gateway composed without the workbench —
each answered with the body the real surface writes for that cause, plus two `FileViewer` cases of the file's own
lifetime and bound: a read answered `404 not_found` (a file deleted after the listing was read) and a preview that is
one bounded chunk of a larger file. It asserts the causes are worded apart from each other, that a failed read is a
failure with a Retry button beside it rather than a capability claim, that a gone file is stated as gone and its button
is the shell's own folder reload (clicked, and the reload hook counts it), that no host path reaches the screen, and that
a bounded preview says its shown bytes against the host's total with no "Load more" beside it.

Representative size, memory, backpressure and cancellation:
`node packages/gateway/test/file-transfer-evidence.ts` drives the ingress, Backend and gateway with a file at the
host's own 16 MiB ceiling, a paused reader, an abandoned download and an over-bound batch, and prints the peak RSS
beside each step. Its numbers are recorded with the revision in
[verification](verification.md#files-and-workbench-streaming-ticket-08).

The browser sees only routing paths (`/workspace/<id>`; see [glossary](../GLOSSARY.md)); the adapter converts them to workspace-relative gateway paths and back. Everything the workbench serves is addressed as `/workspace/<id>`; a cwd that names no workspace of this deployment is refused rather than guessed. No surface *shows* the routing path — a folder's own host path is what the UI displays, while requests keep addressing `/workspace/<id>`; see [docs/projects.md](projects.md). The server still owns the gateway origin and token, so no credential reaches the browser. Live file watch, linked-directory approval and file CRUD other than the upload still answer 501; a `.docx` no longer does (see [the Word document preview](#the-word-document-preview)). (Image *submission* in the composer is a different path and is supported; see docs/chat.md.) The file index and tree share a listing cached for five seconds in at most 32 workspaces, and an upload drops that workspace's cached listing, so the tree the explorer refreshes right after an upload sees the files it just wrote. Listing/diff transport failures are errors, not empty-success responses. A text download is the file's own bytes rather than a preview, so it is no longer refused for exceeding the 200 KiB preview limit; a request for an additional *preview* chunk still returns 501 — the preview has no continuation, and the viewer says so instead of offering one — and a file over 16 MiB is refused with `file_too_large` on both read and download. Changed-file line counts are not available from the gateway, so the sidebar shows zero additions/deletions. Live tool output travels as pi.live.tools in the durable SSE state frame (liveTools), not through the workbench.

### The Word document preview

A `.docx` is a zip of XML parts, so the gateway's *text* preview of one is the placeholder "binary content not
displayed", which says nothing about the document. That is why the file surface routes a `.docx` to the byte route
instead — `servesBytes` in `packages/protocol/src/files.ts`, which is what `files-surface.ts` asks before it decides
between a workbench read and a byte answer — and the browser reads the document from those bytes.

The renderer is `packages/ui/src/lib/docx-preview.ts`, over `mammoth` 1.13.0 (BSD-2-Clause, recorded in
[upstream sources](upstream-sources.md)), which `packages/ui` already declared and imported by nothing until this
ticket. It is consumed through the package's **own** `browser` field mappings — no fork, no
patch, no bundler shim, no polyfill — and those mappings decide the input shape: `browser/unzip.js` accepts only
`{ arrayBuffer }` and rejects anything else with "Could not find file in options", while the Node
`lib/unzip.js` accepts `{ path }` or `{ buffer }` and reaches for `Buffer`. That is why the preview hands mammoth
an `ArrayBuffer` and why the same call cannot run under Node against the Node build's input shape.

Two deliberate limits on what a remote document may do in this browser:

- **It is rendered as text, not markup.** `mammoth.extractRawText` returns the document's text runs and drops
  structure, styles, images and links, so what reaches the page is inert plain text mounted as React text nodes.
  `convertToHtml` is deliberately not used: it emits an HTML document the archive chose, and that string would have
  to reach the page through a frame or a sanitiser policy, which is an owner decision, not this ticket's. The
  preview says what it is — a "text preview" badge and, for a document with no text, a message rather than a blank
  frame a reader has to interpret.
- **It is bounded, and refused before the bytes are asked for.** One number, `DOCX_PREVIEW_MAX_BYTES` (10 MiB),
  declared once in `packages/protocol/src/files.ts`. `FileViewer` reads `?type=meta` first and refuses an over-bound
  document without issuing a read at all; `readDocxBytes` then enforces the same bound twice more — from a
  `content-length` claim, and while the body arrives, cancelling the stream at the bound so a response that lied
  about its length cannot hand an unbounded buffer to the parser. The refusal names the size it read and offers the
  download; the same document still downloads whole, because a preview and a file are not the same promise.
- **It stops when the page stops caring, at the read rather than in the loop.** `useDocxPreview` aborts its controller
  when the document leaves the screen, and `readDocxBytes` is what makes that abort land: `previewSignal` composes the
  caller's signal with any signal the request init already names (`AbortSignal.any`, so neither owner is the silent
  loser), puts the result on the request that goes out, and registers it on the reader. A read parked on
  `reader.read()` has no next chunk to check a flag between, so an abort that only set a flag would leave the remote
  read, the stream and one handle of the filesystem reader registry waiting for a byte nobody would look at; closing the
  reader is what settles it. The listener is dropped in a `finally`, and a stop that arrives on the document's last
  chunk is reported as the caller's abort instead of as text to parse — the same answer either side of the final
  read, because a preview that ended is not a document.

The preview is **dynamic-imported**, so a page that never opens a document never pays for the reader: the shipped
chunk is 308 KB minified in `apps/web/dist/assets` (694 KB unminified by the same esbuild settings), off the entry
chunk entirely. `extractRawText` throws on a malformed archive, and the viewer states "This file is not a readable
Word document" with the download beside it. Nothing is converted on the host: the archive is parsed in the page from
bytes the file surface already served, so there is no second format converter, no server-side dependency and no new
wire contract.

Both hosts answer this identically, because nothing preview-specific was added to either: the byte route is the
16 MiB filesystem reader both gateways already serve for downloads and ranges (`MAX_FILE_BYTES`), so a document
under the 10 MiB preview bound is answerable on a local and an SSH workspace alike.

The **packaged App reads documents too**, and there is no App-side gap to wait for: `apps/app` builds the same
`@hepi/ui` workbench, whose graph reaches the viewer through `workbench` -> `components/AppShell` ->
`components/FileViewer`, and `mammoth` is therefore declared by `packages/ui` — the package that imports it — in
`dependencies`, not by a host that merely builds it. `apps/app/test/docx-preview-bundle.test.mjs` asserts *which*
reader the App's bundle gets, using the App's own tsconfig and `platform: browser`: `mammoth/browser/*` is a
metafile input and neither `lib/unzip.js` nor `lib/docx/files.js` is, because the Node pair reaches for `Buffer` and
a webview has none. Which browser field the bundler resolves is the whole question, so no Rust shell and no `.deb`
is needed to answer it; the packaged artifact's own measurements are ticket 04's.

The licence follows the artifact rather than the repository, and the notice has one owner: `packages/ui/THIRD_PARTY_NOTICES.md`
carries mammoth's BSD-2-Clause text and its copyright line, because esbuild keeps only `@license`/`@preserve`
comments and mammoth's browser build has neither, and `thirdPartyNoticesPlugin()`
(`packages/ui/src/lib/third-party-notices.ts`) copies it from `closeBundle` into each host's `build.outDir` —
`apps/web/dist`, which the client ingress serves, and `apps/app/dist`, which the Tauri shell embeds through
`build.frontendDist`. `closeBundle` is the hook that runs after Vite has emptied the directory, so the copy survives
`emptyOutDir` instead of being one of the files it deletes. `packages/ui/src/lib/third-party-notices.test.mjs` reads
the installed package's own `LICENSE` and asserts the notice, the copy, and that no host keeps a second copy that can
drift from it.

Verification — `packages/ui/src/lib/docx-preview.test.mjs` (16 tests: the bound read from a `content-length`
without touching the body, a body that overruns its own claim abandoned **at** the bound with the stream closed,
an abandoned preview cancelling its reader, a caller that was already gone asking for nothing, the composed abort
reaching the request and both owners' signals being honoured, an abort during headers read as the caller's stop and
not as a transport failure, a read parked on a host that stopped sending being closed by the abort rather than
waiting for the next chunk, no abort listener outliving the read it was for, a transport that
stops mid-document as a refusal rather than a truncated preview, the surface's own refusal kept as words, bytes
inside the bound handed over whole, and the paragraph split); `packages/ui/src/hooks/useDocxPreview.test.mjs` (3
tests against the real call site: unmounting the viewer aborts the request it issued and closes the stalled read,
switching documents stops the one that left the screen without aborting the new one, a StrictMode replay leaves one
live read, and `mammoth` is never imported for an abandoned preview); `packages/ui/src/lib/i18n/messages/locale-keys.test.mjs`
(3 tests: every key a component translates exists in all three locales, the locales match English's key and
required-placeholder sets, and the four docx keys name their `{max}` bound in each locale);
`packages/gateway/test/files-surface.test.ts` (a `.docx` read goes to the byte route and never to `/api/workbench`,
and its `meta` answer keeps `previewKind: "docx"`, which is what the viewer reads before deciding to fetch); and
`packages/gateway/test/ingress-ssh-workbench.test.ts` (one real archive, the same bytes and MIME on a local and an
SSH workspace, and a `Range` answered `206`). That the **App**'s bundle reaches the *browser* reader rather than the
Node one is `apps/app/test/docx-preview-bundle.test.mjs` (2 checks: the App's own tsconfig at
`platform: browser`, `mammoth/browser/*` among the metafile inputs, no `lib/unzip.js`, no `lib/docx/files.js`, no Node
builtin in the output). What only a browser can show is
`apps/web/e2e/ux-docx-preview.mjs` — 15 checks in Chromium (`pnpm --filter @hepi/web test:docx-preview`): the
document's three paragraphs as three blocks on a cookie connection and on the App's bearer connection, every
request presenting its own credential, a paragraph containing `<script>window.__pwned = 1</script>` arriving as
words with zero frames, zero script elements and the assignment never run, an over-bound document stating its limit
with **zero** read requests made for it, and a textless document stating that it holds no text.

### The SSH workbench

An SSH-backed workspace answers the same four operations, and the surface is one class either way:
`GatewayWorkbench` takes a `WorkbenchHost` per workspace, and only that host differs.

| Operation | Local gateway | SSH gateway |
| --- | --- | --- |
| `files` | git `ls-files` in the root, else a walk of this machine's directories | the same git argv through `SshRunner`, else a walk through the `SshFilesystem` session |
| `read` | one bounded local file read | one bounded reader handle on the host: `fileInfo`, `openBinaryReader`, one `reader.read` of the bound plus a byte, `reader.close` |
| `changes` | `git status --porcelain=v1 -z` here | the same argv on the host, same DTO and status mapping |
| `diff` | the unstaged, staged then untracked fallback here | the same three argv on the host |

The registry decides the host: a workspace id resolves through `workspaceOwner` to the profile and the canonical root it
was registered with, so a folder the backend registered at runtime is browsable without rebuilding the surface, and an
id that was never registered is `unknown_workspace` rather than a prefix that happens to match a profile. Git runs with
the workspace root as both its working directory and the runner's confinement root, so a path from a request never
becomes a working directory; the connection settings, identity file and known-hosts file come from the profile the
gateway started with and are never returned in an answer.

Path rules are the local workbench's, unchanged and shared: a traversal or an absolute path is refused before the host
is asked anything, and a symlink inside the root whose real location leaves the workspace is refused by the helper's own
confinement. Both raise the same refusal, and it stays the workbench's `path_denied` — the route's `409` — on either
host. A symlink that stays inside the workspace is previewed as its target on both hosts: the local surface resolves it
with `realpath`, and the remote one asks the helper's `canonicalPath` before it inspects the file, so the preview carries
the target's content and size rather than the link's. A directory previews the same binary placeholder either way.

The parity contract, operation by operation:

- **An operation that did not answer is a failure.** A transport tagged `unreachable`, `outcome_unknown` or
  `operation_failed`, a host command killed by its deadline, and a command ended by its caller are one class — the host
  never said anything about the checkout — and both hosts report them as `operation_failed`. Locally the same fact is
  `execFile` returning a killed process or `ABORT_ERR`; the classification is shared (`didNotAnswer`), so neither host
  can turn it into an empty listing, an unavailable change set or an empty diff, which are all answers a caller would
  read as "nothing changed". Git running and exiting non-zero is the opposite: it answered, and the existing
  `isGitRepository: false` / `git-status-failed` / empty-diff-for-an-unmodified-file behaviour is preserved unchanged.
- **Output is bounded the same way.** The preview bound is one number for both hosts (200 KiB) and exactly that plus one
  byte crosses the transport. Git output bounds travel with the command — 64 MiB for the listing, 2 MiB for status,
  5 MiB for a diff — and the SSH executor applies the same bound to the output its runner collected, reporting
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` as a local `execFile` does. An overflow is Git having answered more than the
  surface can hold, so it keeps the unavailable answer rather than becoming a failure.
- **A caller that goes away ends the work.** `POST /v1/workbench` binds an `AbortController` to the response's `close`
  the way `/v1/mcp` already does, and `GatewayWorkbench.execute` hands that signal to every host command it runs
  (`GitCommandOptions.signal`, which local `execFile` takes directly and the SSH executor composes with the command's own
  deadline through `AbortSignal.any`). The workbench stays read-only, so a cancelled call has nothing to roll back; what
  it stops is a remote `git` outliving the browser that asked for it.
- **The host answers inside the caller's window.** One host Git read is bounded at 15 s, below the control route's 20 s
  workbench deadline, so a slow host produces the operation's own named failure instead of both sides timing out at the
  same instant and the caller classifying a live call as lost (`gateway_offline`).
- **Refusals keep their names across the transport.** A host refusal travels as the workbench's code and the route's
  `409`; only a call the transport could not complete at all is the backend's `503`. The file payload routes answer the
  same status and the same code for the same request whether the workspace is this machine's directory or an SSH host's,
  including the conflict strategies, `not_replaceable`, the `413` over the read bound, and an unregistered workspace id.
- **The two hosts fail alike, and say the same thing about it.** Asked of one tree shape through the browser's own
  addresses, an SSH workspace and a local one answer listing, preview, metadata, the `@` index, changed files, a diff,
  an upload with its conflict strategies, an overwrite and a download identically. The only field allowed to differ is
  the routing workspace a listing names, which is the caller's own address. The refusals match too: a file the tree no
  longer has, a workspace this deployment does not serve, a path that leaves the workspace. A host that goes away is
  `503 gateway_offline` for that workspace alone, with the other workspace still serving.

One preview limit differs, and is recorded rather than fixed: the remote read rides the filesystem reader, which enforces
the gateway's 16 MiB read policy, while the local preview opens its own file handle and never asks the filesystem. A text
file past 16 MiB is therefore previewed (truncated at 200 KiB) on a local workspace and refused with `operation_failed` on
an SSH one. Raising the read bound to match would widen a policy that uploads and downloads share; a whole large file
still arrives through the byte route on both hosts.

No live watch, no second protocol and no second connection pool: the preview and the listing share the one
`SshFilesystem` session the file routes already use, and Git rides the plain runner the worktree surface already uses.

Verification: `packages/gateway/test/ssh-workbench.test.ts` (an SSH workspace listing, previewing, reporting changes and
diffing through the in-process host of `fake-ssh.ts` plus real git, the preview bound and the released reader handle, the
refusals a traversal, an absolute path and a symlink get before and at the host, a non-checkout's unavailable changes, a
transport that cannot answer reported as an operation failure, an unknown workspace, and the same answers over
`POST /v1/workbench` on a composed `SshGateway`; the two hosts asked the same operations about one tree and compared
answer to answer, a deadline and a caller's cancellation ending the host command, and a caller that disconnects from the
route), `packages/gateway/test/workbench.test.ts` (the local host: the same never-answered classification, and a root
directory that cannot be read failing the listing instead of answering an empty one),
`packages/gateway/test/file-transfer.test.ts` (a local workspace and an SSH workspace answering the payload routes with
one set of statuses and codes, and a mid-upload disconnect on the remote host leaving no partial file and no staging
file), `packages/gateway/test/startup.test.ts` (the shared composition mounting the workbench on the SSH gateway),
`packages/gateway/test/ingress-ssh-workbench.test.ts` (the journey and the refusals above, at the browser seam: the real
client ingress, the real Backend, two real gateways, and the SSH gateway **mounting** its workbench — the composition
`ingress-files.test.ts` deliberately does not have, because that suite asks the routing question rather than the
capability one), and `packages/gateway/test/files-surface.test.ts` (each refusal cause mapped to its own status, code
and wording, an unreadable Backend answer, and the named `501`s that are the surface's own).

## Start locally

In one terminal, from the repository root:

```bash
HEPI_GATEWAY_TOKEN=local-gateway-token HEPI_WORKSPACE_ROOT="$PWD" HEPI_WORKSPACE_ID=local pnpm --filter @hepi/gateway start
```

In another terminal:

```bash
HEPI_AUTH_TOKEN=local-server-token HEPI_GATEWAY_TOKEN=local-gateway-token HEPI_GATEWAY_URL=http://127.0.0.1:8788 HEPI_WORKSPACE_ID=local pnpm --filter @hepi/server start
```

Open http://localhost:8787/workbench and enter local-server-token. Connect lists the server-configured workspaces. Select a file for preview, or Changes to inspect Git status and select a changed file for diff. Credentials stay in page memory. The gateway CLI binds loopback and exposes only the configured workspace; shell commands are disabled in this workbench CLI.

## Upstream preservation

Worktree operations are additionally adapted from pi-web at 76bdc57027172eb381a216d647225a6d24f23360 (v0.10.0), MIT, copyright 2026 agegr: `lib/worktree.ts` and the request/response contract of `app/api/worktrees/route.ts`. The source snapshot is `packages/gateway/vendor/pi-web/worktree.ts` with the upstream `LICENSE` beside it (client-app ticket 17 moved it there from the retired `apps/web/vendor/` tree); the contract is the protocol declaration named above, not a licence-bearing copy. The adaptation is `packages/gateway/src/worktrees.ts`, which keeps upstream's rules, refusal statuses and `dirty` detection while running git on the execution host.

Source: https://github.com/minghinmatthewlam/pi-gui at 572c0c6de8ffd3a245c224b912bb8752ca200780, MIT, copyright 2026 Matthew Lam.

Original snapshots and the MIT license are under packages/gateway/vendor/pi-gui/. Corresponding executable adapters are under packages/gateway/src/workbench/.

| Original source | Snapshot | Executable adaptation |
| --- | --- | --- |
| apps/desktop/contracts/ipc.ts (changed-file and preview DTOs) | ipc-contracts.txt | `packages/protocol/src/gateway.ts` (`Workbench*`) |
| apps/desktop/electron/platform/files/app-store-files.ts | app-store-files.ts | app-store-files.ts |
| apps/desktop/electron/platform/files/app-store-diff.ts | app-store-diff.ts | app-store-diff.ts |
| apps/desktop/electron/platform/files/workspace-paths.ts | workspace-paths.ts | workspace-paths.ts |
| apps/desktop/electron/platform/files/git-environment.ts | git-environment.ts | git-environment.ts |

Executable adaptations change module import paths and contract locations. The changed-file and preview DTOs the desktop IPC declared are the wire shapes of `POST /v1/workbench`, so they live once in `packages/protocol/src/gateway.ts` (`WorkbenchFile`, `WorkbenchChangedFile`, `WorkbenchChanges`) and the gateway's workbench surface plus the Web workbench adapter read that declaration instead of keeping a copy each; `packages/gateway/src/workbench/contracts.ts` is gone. Original file listing, preview bounds, binary detection, Git environment isolation, status parsing and diff fallback logic are preserved. No Electron IPC, desktop supervisor or renderer dependencies are imported. The upstream stageFile export is retained with its source; it is not exposed by the workbench API.

## Verification

Two small tests cover listing/status/diff and path traversal denial, without sleep. A one-time local HTTP smoke passed for page/assets, authentication, secret-free workspace metadata, files, preview, Git changes, untracked diff and symlink confinement. A second one-time HTTP smoke drove the copied UI adapter through a production Next server: login, directory listing, text read/meta, Git status, diff, file index and ranked file search passed, and watch, upload and non-workspace paths answered 501. Dependency-complete critical upstream baselines have since been rerun (including architecture and driver); exact failures/pass counts remain in docs/upstream-sources.md. Copied React adapter production HTTP smoke passed. Full visual/desktop parity remains out of selected subset.
