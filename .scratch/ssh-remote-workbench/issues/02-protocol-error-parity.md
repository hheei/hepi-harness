# 02 - Protocol and error parity

Status: delivered (`impl/ssh-workbench-02` `83a1188`), reviewed APPROVED and **integrated** into
`integration/client-app` as `94e62b1`
Blocked by: 01

Exercise path containment, output limits, caller abort, deadlines, offline/unknown workspace/refusal mapping and Git non-repository behavior. Compare local and SSH DTOs and statuses; fix only contract differences. Include remote upload conflict policy, bounded streaming, and lost-response outcome_unknown behavior through the existing file-transfer capability.

Acceptance: stable named outcomes, bounded output and no false success on transport loss.

## What was delivered

One tree, asked of both hosts, answer compared to answer (`packages/gateway/test/ssh-workbench.test.ts`
parity case). Four contract differences showed up; each is fixed at the owning seam, and the local
behaviour a caller already reads is otherwise unchanged.

- **No false success when the root could not be read.** `walkWorkspaceFiles`
  (`src/workbench/app-store-files.ts`) reported a directory-listing failure at the workspace root as a
  workspace with no files and cached it for 30s — which is exactly what a dead SSH session produced. A
  root failure now propagates (`operation_failed`); a root that is simply absent keeps the empty listing,
  and an unreadable subdirectory keeps being skipped. Git-answered listings still fall back to the walk.
- **An in-workspace symlink previews its target on both hosts.**
  `readRemoteWorkspaceFile` (`src/workbench/ssh-files.ts`) inspected `fileInfo`, which is an lstat on the
  helper, so a link answered a binary placeholder carrying the link size while the local surface
  (`realpath` + `open`) answered the target text. The remote read now resolves the helper's
  `canonicalPath` first — the host's own `realpath(strict)` under confinement — and inspects that, so the
  target's content and size come back either way and a link that leaves the workspace is still refused by
  the helper (`path_denied`). `test/fake-ssh.ts` serves `canonical` for this.
- **One classification for "the host never answered".** `didNotAnswer`
  (`src/workbench/app-store-diff.ts`) replaces the transport-tag-only check: the transport tags
  (`unreachable`, `outcome_unknown`, `operation_failed`), a process killed by its deadline (`killed`,
  `ETIMEDOUT`) and a caller's cancellation (`ABORT_ERR`) are one class on either host, so `changes` and
  `diff` fail instead of returning an unavailable change set or an empty patch. Git running and exiting
  non-zero is an answer and keeps `git-status-failed` / `isGitRepository: false` / the empty diff for an
  unmodified file. An output bound Git overflowed (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which the SSH
  executor now raises for the same overflow it measures after the runner collected the output) keeps the
  unavailable answer too — Node does not set `killed` for a buffer overrun, so the two hosts agree.
- **A caller that goes away ends the host command, inside the caller's window.**
  `GatewayWorkbench.execute` takes `WorkbenchCallOptions`, `GitCommandOptions` takes a `signal`, and
  `POST /v1/workbench` binds an `AbortController` to the response's `close` the way `/v1/mcp` already
  does (a cancelled call writes nothing). The signal reaches local `execFile` directly and is composed
  with the command deadline on the host (`AbortSignal.any`). One host git read is bounded at 15s, not 20s,
  so a slow host names `operation_failed` instead of colliding with `CONTROL_TIMEOUT_MS.workbench` (20s)
  and the caller's classification of a lost read as `gateway_offline`.

Refusal and status mapping needed no change and is now pinned rather than assumed: the two hosts return
identical `{ok:false, code}` DTOs and identical wire statuses for `unknown_workspace`, `path_denied
(409)`, `operation_failed`, a non-repository's `available:false` changes, and every payload-route case
(`test/file-transfer.test.ts`: conflict default/`overwrite`/`skip`, `not_replaceable`, `413
file_too_large`, `404`/`403`/`400` byte-range and directory refusals, an unregistered workspace id), plus a
mid-upload disconnect on an SSH workspace leaving no partial file and no `.hepi-upload-` staging file. The
lost-response half was already the file-transfer capability's contract (`outcome_unknown` for a mutation,
`gateway_offline` for a read) and is asserted there unchanged.

Docs: `docs/workbench.md` (the parity contract, per concern, with the recorded preview difference) and
`docs/migration-status.md` (the browsing row).

## Evidence

Revision `83a1188` on `impl/ssh-workbench-02`, with `integration/client-app` at `1873d24` merged in
(fast-forward; the branch's previous tip `2ff97b0` is an ancestor, so no source of either side is lost and
the merge carried only `.scratch/` and `docs/verification.md` changes).

- `pnpm verify:changed --base=1873d24` — report
  `.dev/verify/2026-10-18T15-32-11-399-verify-changed/`, `dirty: false`. Steps:
  `changed-typecheck` (server, web, gateway) exit 0; `changed-test` exit 0 — gateway **420** tests, 420
  pass, 0 fail; server **468** tests, 468 pass; `web-unit` exit 0; `check-docs` **exit 1** with the same
  12 broken `.scratch/` links the base revision reports (see ticket 01), none naming a file this change
  touched.
- Focused seam run: `cd packages/gateway && node --test test/ssh-workbench.test.ts
  test/workbench.test.ts test/file-transfer.test.ts test/startup.test.ts test/control.test.ts
  test/filesystem.test.ts test/ssh-filesystem.test.ts` — exit 0, 84 tests, 84 pass, 0 skipped.
- Mutation checks that the new tests fail their assertion (not merely pass): removing
  `{ signal: controller.signal }` from the `/v1/workbench` route fails the disconnect test on elapsed time
  (the command ends at its 20s deadline, not when the caller leaves), and before the symlink fix the parity
  test reported `link.md` as a 41-byte binary placeholder against the local 8-byte target text.
- No security-boundary bypass probe was designed or run: the traversal, absolute-path and
  escaping-symlink cases are the existing refusals, asserted at the workbench seam and at the host's own
  confinement, and `check-docs`/tests touch no live service. Nothing was deployed, no `remote-host` command
  was run, no graph was rebuilt.

## Merge into `integration/client-app`

Status: delivered on `impl/ssh-workbench-02` (source `83a1188`), **reviewed APPROVED** and merged into
`integration/client-app` as `94e62b1` (`--no-ff`, `ort`, parents `2cc7d0d` + `6b9341e`). No conflict, no hand resolution;
`git merge-tree --write-tree` previewed clean as `d69f0dc` before the merge.

The branch merges the integration tip `1873d24` directly (its previous tip `2ff97b0` is an ancestor, so neither side lost
source). Its only overlap with the rest of this serial batch is one documentation line group: `docs/migration-status.md`
line ~51, the browsing row — auto-merged against the same file's edits at ~42/~179/~574/~640/~701 by the cutover and
subtree branches. Of the batch this is the branch that touched `packages/gateway/src/index.ts` (the workbench mounting and
the 9-argument `GatewayRpcServer`/`startGateway` composition); the provider branch of the same batch did **not** touch it,
so no composition argument was lost and the local/SSH `profile === undefined` split is unchanged from ticket 01.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Workbench parity seam on the merged tree (ssh-workbench 12, workbench 5, file-transfer 16, plus provider/MCP/startup/control/execution suites) | `node --test packages/gateway/test/ssh-workbench.test.ts packages/gateway/test/workbench.test.ts packages/gateway/test/file-transfer.test.ts packages/gateway/test/ingress-providers.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts packages/gateway/test/control.test.ts packages/gateway/test/mcp-invocation.test.ts packages/gateway/test/execution.test.ts packages/gateway/test/ingress-files.test.ts` | merged tip `bbd0d59` | 0 (124/124) | `.dev/verify/merge-client-app-12/seam-gateway.log` |
| Whole gateway suite | `pnpm verify:changed --base=1873d24` (`changed-test` → `@hepi/gateway -r test`) | `bbd0d59` (`dirty: false`) | 0 | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/changed-test.log` |
| Gateway typecheck (with app, server, web, ui) | `pnpm verify:changed --base=1873d24` (`changed-typecheck`) | `bbd0d59` | 0 | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/changed-typecheck.log` |

The source here is byte-identical to the reviewed tip — `git diff --exit-code 6b9341e -- packages/gateway/src/workbench`
and every test file exit 0 at the merged tip — so the branch's own `83a1188` runs stand as the product evidence. What the
merge adds is the combination: gateway on the merged tree reports **426** tests, which reconciles exactly as
`411 (integration before this batch) + 9 (this ticket: ssh-workbench +5, workbench +2, file-transfer +2) = 420` at the
branch's own gate, `+ 6` provider-relay cases from the same batch = **426**. Ticket 02's mutation checks (the missing
`{ signal: controller.signal }` and the symlink placeholder) stay the evidence that the new tests hold the fix.

`check-docs` exits 1 at the merged tip on the same 12 pre-existing links over 385 files
(`.dev/verify/merge-client-app-12/broken-merged.txt`, diffing empty against the `80608d6` baseline). No deploy, no
`remote-host` build, no push, no graph rebuild. **Ticket 03 (Web acceptance) is now unblocked** — its `Blocked by: 01, 02`
are both integrated — and agent30 may start from `bbd0d59`.

## Limits recorded (for ticket 03 and beyond)

- **A preview past the gateway's 16 MiB read policy differs by host.** The remote preview rides the
  `SshFilesystem` reader, which enforces that policy (a file over it is refused `invalid`, which the
  workbench reports as `operation_failed`), while the local preview opens its own handle and never asks the
  filesystem, so it truncates at 200 KiB whatever the size. Left as is: raising the read bound would widen
  a policy uploads and downloads share. A whole large file still arrives through the byte route on either
  host, and a browser-facing text preview of one is a ticket-03 UI question with an actionable wording, not
  a silent empty file.
- **The workbench's wire vocabulary is unchanged** — `unknown_workspace` / `path_denied` /
  `operation_failed` (409), with `gateway_offline` staying the backend's classification of a lost control
  call (503). A caller therefore cannot tell "host refused" from "host never answered" from the HTTP status
  alone; ticket 03 should check the wording the browser shows for each.
- **One host git read is bounded at 15s and the listing runs four of them in parallel**; a very slow host
  can still spend the caller's 20s window on a listing. Not tuned further without a real-host measurement.
- Caller cancellation reaches the host command, and the workbench is read-only, so there is no outcome to
  be uncertain about; a *write* interrupted mid-flight remains `outcome_unknown` and is never replayed
  (already the file-transfer capability's contract).
- Live watch remains `501`; the preview still has no offset reads (additional chunks answer the named 501).
