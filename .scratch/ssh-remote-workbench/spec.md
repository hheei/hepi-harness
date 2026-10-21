# SSH Remote Workbench

Status: approved framework; tickets 01, 02 and 03 delivered, reviewed and integrated (`integration/client-app`
`55a594e`, `94e62b1`, `7807c46`). Ticket 05 (DOCX byte preview, with the App's own reader declaration) is delivered on `impl/ssh-workbench-05` and integrated at `871ae72`; 06/08 and the 04 closeout are reviewed and integrated at `0994ffe` (2026-10-19); 07 remains live-watch deferred; new09 follows 04 and client-app17. The scope of these issues is the approved seven-row capability
proposal; proposal-row to issue-file mapping is in [ticket-proposal.md](ticket-proposal.md). Live watch stays
explicitly deferred by ticket07; any future implementation needs a separate event-protocol decision. DOCX preview is **no longer** an
owner-decision abstention: this spec's "existing browser rendering" premise was false (`mammoth` declared, imported by
nothing), so ticket 05 supplied the renderer - text-only, bounded, over the byte route the surface already served.

Labels: ssh, workbench, gateway
Date: 2026-10-17

## Problem

SSH Gateway already owns remote workspaces, filesystem access, Git worktrees and an SSH runner, but the read-only workbench capability is currently mounted only on Local Gateway. Web file listing, preview, changes and diff therefore report the remote workbench as unavailable even when the workspace is valid.

## Goal

Make existing workbench operations work for SSH-backed workspaces through Gateway, preserving one backend runtime, one Gateway capability boundary and the existing protocol. Remote files and Git operations execute on SSH host; browser and backend do not receive SSH credentials or construct SSH commands.

## Approved architecture

- `GatewayRpcServer` mounts `GatewayWorkbench` for SSH Gateway too.
- `GatewayWorkbench` receives the SSH workspace registry and a Git executor backed by the existing `SshRunner`.
- Workbench file listing/read resolve paths against the SSH workspace root and use `SshFilesystem` or an equivalent existing host adapter.
- Changes/diff execute Git on the remote host through the existing runner and the same path validation as local workbench.
- Backend calls `GatewayHostClient.control.workbench`; it does not call SSH or `/v1` routes directly.
- Web keeps the existing workbench adapter and wire DTOs. Host refusal/offline/path errors remain named capability outcomes.
- Remote writes use existing `/v1/files/upload` staging/conflict/ledger behavior; they do not become `/v1/workbench` JSON mutations.
- DOCX preview uses bounded `/api/files` byte streaming and renders in the browser. It is best-effort **text**
  preview, not Office-fidelity rendering. The original "existing browser rendering" premise was not true: `mammoth` is a
  declared dependency of `packages/ui` and `apps/web` that no source file imports, so ticket 05 supplies the renderer.
  It renders a document's text into text nodes through the connection that owns the credential and never its markup, so
  no document content reaches the page as HTML, a `srcDoc` frame or a script, and nothing a remote document carries can
  execute here. The 10 MiB `DOCX_PREVIEW_MAX_BYTES` bound sits under the gateway's 16 MiB read policy, so a previewable
  document is answerable on both hosts.
- SSH terminal is an existing capability. Scope is parity and reliability acceptance, not protocol replacement.
- Live watch, when eventually designed, emits invalidation hints with cursor/overflow/resync semantics; it never promises lossless file-content replication.

## Scope

In scope: files listing, bounded text read/preview, remote upload/write through existing file-transfer capability, changes/status, file diff, DOCX byte preview, path containment, SSH connection reuse, timeout/caller abort, host offline/error mapping, local/SSH parity tests, terminal parity tests, and documentation.

Out of scope for initial implementation: live file watch implementation, linked-directory approval, worktree CRUD changes, a second remote workbench protocol, or moving SSH credentials into backend/Web. Live watch requires a separate event protocol design ticket.

## Invariants

1. Remote root is resolved by the SSH workspace registry; browser paths remain opaque `/workspace/<id>` paths.
2. Every path is canonicalized/contained on remote host. Traversal, symlink escape and invalid workspace are refused before Git/read work.
3. SSH commands use argv-safe execution through `SshRunner`; no shell-built command from browser input.
4. Git operations run with the workspace's remote cwd and preserve local DTO status/diff semantics.
5. Caller cancellation reaches the runner; deadlines are bounded. Lost read answers may repeat because reads are idempotent; mutation responses remain outcome_unknown and are not blindly replayed.
6. SSH auth/host-key material stays in Gateway startup/profile configuration. Errors redact identity details where required.
7. A remote Gateway that cannot expose a capability reports a stable named refusal; Web must not show support based only on workspace existence.
8. Local behavior remains unchanged and shares tests/contracts where possible.

## Failure semantics

- Unknown workspace/path denied: definitive refusal, preserve code/status.
- SSH connection not opened or host unreachable: named `gateway_offline`/`unreachable` outcome, no retry loop in Web.
- Timeout or caller abort: abort remote command, return explicit failure; do not report empty files/diff as success.
- Malformed/oversized remote output: bounded failure, no unbounded buffering; preserve existing workbench limits.
- Git repository absent: existing `isGitRepository: false` result, not transport failure.
- Remote file changed between listing/read/diff: answer current host result or explicit read error; no browser-side snapshot claim.

## Acceptance

- SSH-backed `/workspace/<id>` lists directories/files and reads bounded text through Gateway.
- SSH-backed workspace returns Git status and diff with same DTO/status mapping as local workspace.
- Path traversal, unknown workspace, offline SSH, timeout and caller abort have stable tested outcomes.
- Backend source contains no SSH command construction or direct `/v1` workbench fetch; Gateway boundary tests remain green.
- Local and SSH workbench share protocol validation and relevant path/security tests.
- Remote upload/write, DOCX preview and existing SSH terminal work for SSH-backed workspaces with local-equivalent
  boundaries (DOCX: issue 05; terminal: issue 06).
- Live watch remains an explicit unsupported state; no UI implies it works.
- Remote writes with lost responses remain `outcome_unknown` and are not replayed under a new call identity.
- Focused package/server/Web tests, typechecks, `pnpm verify:changed`, browser journey and docs checks record revision, commands, exit codes and logs.

## Resolved by ticket 01

- Remote read reuses `SshFilesystem`'s bounded reader (`openBinaryReader` + one `reader.read`) with the workbench's own
  200 KiB preview bound, so one bounded limit is stated once and the transport carries at most the bound plus a byte.
- The Git executor runs through the same plain `SshRunner` the worktree and file surfaces already use — no managed
  master and no second pool; the connection settings are the profile's own.
- Refusal vocabulary: `unknown_workspace`/`path_denied`/`not_found`/`operation_failed` over `/v1/workbench` (409 for a
  refusal), and a transport that could not answer is `operation_failed` rather than an empty listing, change set or
  diff. `gateway_offline` stays the backend's classification of a lost control call. Ticket 09 added `not_found`: this
  machine's `ENOENT` and an SSH helper's `not_found` are the one fact the workbench now names, and the browser surface
  answers it 404 instead of 500.
- The text preview answers the host's own `shownBytes` and `size` (`null` when the host stated none) with
  `previewOnly: true` and no offset continuation, so a bounded chunk is shown as a bound rather than as a complete file.

## Open details for tickets

- Ticket 02: exercise the remaining parity surface (deadlines, caller abort, oversized output, upload conflict policy,
  lost-response `outcome_unknown`) and fix only contract differences.


## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.



## UX 收口追加（2026-10-19）

[09 缺文件/截断预览反馈](issues/09-file-failure-and-preview-feedback.md) 在现有04验收与 client-app17 后实施，明确缺文件词汇、普通删除后的读取恢复、已显示字节与总大小；不重开已交付01–03/05。App bearer 原生另存由 [client-app20](../client-app/issues/20-native-file-save.md) 单独拥有，SSH adapter 不重做下载UI或上传。

06/08 继续补终端、普通失败与旧driver的当前证据；07只记录保持watch deferred，现有501/静态viewer保留。最终新UX旅程归 [client-app22](../client-app/issues/22-ux-system-acceptance.md)，依赖见 [执行图](../ux-closeout-research/spec.md)。修改功能同票更新 workbench/projects/能力限制指南；不设计、运行或提交绕过安全边界的测试或探测。
