# SSH Remote Workbench Research

Date: 2026-10-17
Status: completed research; implementation decisions recorded in `spec.md`.

## Executive findings

1. Remote writes are viable now. Existing `SshFilesystem` and `file-transfer.ts` already provide confined upload, temporary staging, append/rename and streamed download paths. Workbench writes should reuse that capability and its conflict/outcome semantics, not add JSON/base64 writes to `/v1/workbench`.
2. Live watch is a separate distributed event problem. A remote watcher/helper must own event production, cursor/replay, overflow and teardown. Local `fs.watch` behavior is platform-dependent and does not give a reliable cross-host protocol. Do not implement SSH watch as polling disguised as SSE.
3. DOCX preview is feasible through the existing byte download path and browser parser. `FileViewer` already has DOCX handling and a 10 MiB bound; the missing piece is routing `type=preview` to bounded bytes. Preview is best-effort rendering, not fidelity or security proof.
4. SSH terminal already exists through `sshTerminalLauncher`, `SshRunner.open`, the terminal helper and GatewayHostClient terminal SSE. Terminal work is parity and failure testing: reconnect cursor, resize, abort/close, unreachable host, missing PTY/helper and stream budget.
5. Path confinement must happen on execution host. Local `realpath` cannot validate remote paths. Reuse the SSH helper's canonical/confine operations and preserve symlink escape denial.

## Local evidence

### Remote writes and transfer

- `packages/gateway/src/ssh-filesystem.ts`: remote helper supports `readTextFile`, `readBinaryFile`, binary readers, temporary files, append, rename and canonical/confine operations.
- `packages/gateway/src/file-transfer.ts`: upload uses temporary staging and conflict policy; download streams bytes. Existing SSH transfer tests cover the real-sshd path.
- `apps/server/src/file-relay.ts`: backend owns the capability relay; browser does not construct Gateway URLs or SSH calls.
- `packages/gateway/src/control.ts`: mutations are classified separately from reads; lost mutation responses must remain `outcome_unknown` and must not be blindly replayed.

### Workbench gap

- `packages/gateway/src/startup.ts`: SSH startup passes no `GatewayWorkbench` to `GatewayRpcServer`.
- `packages/gateway/src/workbench/index.ts`: current workbench uses Node `fs` and local Git executor; its interface needs a host filesystem/read adapter before SSH mounting is correct.
- `packages/gateway/src/workbench/workspace-paths.ts`: current local `realpath` checks are not valid for a remote root.
- `apps/web/adapters/workbench.ts`: static listing/read/changes/diff already route through backend; `watch` and `preview` currently return unsupported.

### DOCX

- `apps/web/components/FileViewer.tsx`: DOCX preview path consumes an `ArrayBuffer` and uses the existing browser DOCX renderer path; `DOCX_PREVIEW_MAX_BYTES` is 10 MiB in `apps/web/lib/file-types.ts`.
- Preview must use `/api/files/...type=download` or an equivalent byte stream, not workbench text JSON. Do not buffer unbounded remote DOCX content in Gateway or Web.
- External library research indicates browser DOCX-to-HTML renderers aim for semantic HTML and have incomplete/fidelity limitations. Treat output as preview, display a limitation/error state, and never claim Office layout equivalence.

### Live watch

- `apps/web/components/FileViewer.tsx` requests an EventSource watch route, but `apps/web/adapters/workbench.ts` returns unsupported.
- A remote design needs: watch scope, event schema, monotonic cursor, reconnect/resync, overflow signal, deletion/rename identity, symlink policy, max watchers, per-watch timeout/idle close, host disconnect and explicit snapshot refresh.
- A watch event is a hint that invalidates/reloads a bounded snapshot. It is not a file-content mutation stream and must not silently claim no events were lost.

### Terminal

- `packages/gateway/src/terminal.ts`: `sshTerminalLauncher` opens the terminal helper through `SshRunner.open`, confines cwd on remote host, maps SSH exit 255 to `unreachable`, and preserves terminal output budget/replay.
- `apps/server/src/terminal-relay.ts` and `packages/gateway/src/host-terminal.ts`: lifecycle and SSE already pass through the Gateway boundary.
- Scope should verify remote/local parity, reconnect `Last-Event-ID`, resize, close/abort and bounded backlog. No terminal protocol rewrite is justified by current evidence.

## Failure and security matrix

| Boundary | Required behavior | Never do |
| --- | --- | --- |
| path escape/symlink | canonicalize and confine on remote host before read/write/Git/watch | validate remote path with local `fs.realpath`; follow symlink outside root |
| offline/SSH exit 255 | named unreachable/offline result; close streams and watchers | retry forever or return empty success |
| timeout | abort runner/helper, bound cleanup, return explicit timeout | leave remote process/watch orphaned |
| caller abort | propagate `AbortSignal` through Gateway and SSH runner | convert cancellation into successful empty result |
| output/file/list limits | enforce before unbounded buffering; preserve truncation/error metadata | raise limits implicitly because host is remote |
| Git non-repository | return existing `isGitRepository: false` shape | classify absent `.git` as transport failure |
| write response lost | preserve mutation identity/outcome_unknown; offer resolution/refresh | resend upload under new identity |
| watch overflow/reconnect | send overflow/resync marker, force fresh bounded listing | pretend cursor continuity |
| DOCX parse/render | bounded bytes, sandboxed browser render, explicit unsupported/error state | execute document macros or claim exact Office fidelity |
| terminal stream | bounded replay and cursor-aware reconnect | replay unlimited output or silently drop cursor range |

## External primary sources

- Node.js File System API: <https://nodejs.org/api/fs.html>. It documents that `fs.watch` is not fully consistent across platforms, recursive support is platform-dependent, network/virtualized filesystems can be unreliable, and inode replacement can stop events for the recreated path.
- Node.js v19.1.0 release notes: <https://nodejs.org/en/blog/release/v19.1.0>. It records recursive Linux watch support as a platform feature, reinforcing that capability must be detected rather than assumed.
- `docx-preview` project README: <https://github.com/volodymyrbaydalka/docxjs>. It describes DOCX-to-HTML rendering and notes incomplete/final-API and fidelity limitations; this is suitable for preview, not authoritative document layout.
- `docx-preview` package README: <https://github.com/zphhhhh/docx-preview/blob/main/README.md>. It describes the goal of rendering/converting DOCX to HTML while preserving semantics as far as possible.
- xterm.js addon guide: <https://xtermjs.org/docs/guides/using-addons/>. Existing terminal UI should use its addon/fit lifecycle and send resize from committed dimensions, not infer terminal state from text output.
- OpenSSH configuration manual: <https://man.openbsd.org/OpenBSD-current/ssh_config.5>. `ConnectTimeout`, keepalive and connection settings are transport controls; application-level Gateway deadlines and abort still need explicit enforcement.

## Decisions

- Expand remote workbench spec to include writes and DOCX preview now, terminal parity acceptance now, and live watch as a design/research ticket before implementation.
- Reuse file transfer for remote writes; do not overload read-only `/v1/workbench` with mutation calls.
- Route DOCX preview through bounded byte streaming; do not create a server-side conversion service in this phase.
- Keep live watch disabled until cursor/overflow/resync semantics and remote helper lifecycle are specified and tested.
- Treat all remote operations as Gateway capabilities. Backend and Web remain transport-agnostic.
