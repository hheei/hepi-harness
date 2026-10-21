# 08 - Failure and boundary acceptance

Type: verification
Status: resolved — reviewed and integrated at `0994ffe`; delivered (2026-10-19) on `impl/ssh-workbench-acceptance-next` `5527f68` — every row green, the stale driver
repaired onto the client ingress; see the record at the end of this file.
Blocked by: [01](01-gateway-remote-workbench.md), [02](02-protocol-error-parity.md), [05](05-docx-byte-preview.md) (all integrated)

Accept the ordinary failure states on **both** hosts, at the seams that already exist, and record what each one answers.
This is the proposal's failure/security acceptance row minus anything that would mean probing a confinement rule from
outside: this ticket exercises normal failures (a host that is gone, a host that is slow, a caller that disconnects, an
oversized ordinary file, a directory that is not a git checkout) and asserts the named outcome the
contract already states. Path confinement itself is owned by ticket 01/02 and the gateway boundary tests, and stays there.

Covered, with its owner today:

| Boundary | Owner |
| --- | --- |
| transport loss, host deadline, caller abort → `operation_failed`, no empty success | `test/workbench.test.ts`, `test/ssh-workbench.test.ts` (ticket 02) |
| `unknown_workspace` / `path_denied` / traversal both directions | `test/workbench.test.ts`, `test/ingress-ssh-workbench.test.ts` |
| offline host, oversized upload (413), conflict strategies, mid-upload disconnect leaving no staging file | `test/file-transfer.test.ts`, `test/host-files.test.ts` |
| git non-repository → `isGitRepository: false`, not a transport failure | `test/workbench.test.ts`, `test/ssh-workbench.test.ts` |
| refusal cause → status/wording at the browser seam | `test/files-surface.test.ts`, `apps/web/e2e/ux-file-failures.mjs` (ticket 03) |
| lost mutation stays `outcome_unknown`, never replayed | `test/control.test.ts`, `test/host-files.test.ts` |

Work: run the rows at the current revision and close only what the run leaves uncovered. Two recorded limits are this
ticket's to re-check rather than re-litigate: a text file past 16 MiB previews locally and is refused over SSH, and a
file the tree no longer has is `operation_failed` because the workbench has no `not_found` code (adding one is its own
public-vocabulary decision). Repair or retire the stale precondition in `apps/web/e2e/ux-ssh-project.mjs` (it asserts a
`.next/BUILD_ID` while `@hepi/web` builds to `dist/` under Vite) and update the pointer in `docs/projects.md` — the
remote-project browser journey is a failure-boundary claim, so it is fixed here rather than left to assert a build it no
longer has.


## UX followup disposition (2026-10-19)

Known missing-file classification and misleading truncated-preview progress are implemented in new [09](09-file-failure-and-preview-feedback.md) after current scope. This ticket verifies/reports current semantics and retires stale drivers, without redoing delivered SSH transfer/DOCX. Boundary rows above identify existing evidence only; no new tests/probes aimed at bypassing authentication, authorization, preflight or confinement. Ordinary deleted-file lifetime is sufficient for09.

## Delivered (2026-10-19, `impl/ssh-workbench-acceptance-next`)

Ran every boundary row above at `3e69c62` and again at the merged tip `5527f68`: 149 tests / 0 fail across the 15 gateway
files the table names, plus `apps/server/test/ssh-project.test.ts` 6/0 and the ticket-03 browser rows
(`ux-file-failures` 15, `ux-file-surfaces` 10, `ux-docx-preview` 15). **No row was left uncovered and no new probe was
designed**: transport loss, deadline, caller abort, `unknown_workspace`, `path_denied` both directions, offline host, 413,
conflict strategies, mid-upload disconnect, non-repository, `outcome_unknown` — all already asserted and all green.

**The stale precondition is repaired, not retired.** `apps/web/e2e/ux-ssh-project.mjs` asserted `.next/BUILD_ID` and
started `next start`, which no command in this tree produces (`@hepi/web`'s build is `vite build` -> `dist/`). It now
drives the same journey against the deployed shape: the **client ingress** serving `apps/web/dist`
(`HEPI_INGRESS_STATIC_DIR`, overridable with `HEPI_UX09_PAGE_DIST`), the page's own session through
`HEPI_WEB_LOGIN_TOKEN` and the rendered login form, the backend service credential kept as a separate role, and no
`HEPI_INGRESS_DEFAULT_HOST` — which is what makes the two remote profiles the only targets the dialog offers. The turn
reader was also wrong about the stream: an event stream sends `appended` deltas once it holds the baseline window, so it
now accumulates both frame shapes. Same 31 checks, same assertions, exit 0 over a real `sshd`. `docs/projects.md`'s
pointer now names the ingress and the build the driver needs.

Two terminal drivers carried the identical stale precondition and were repaired the same way, because this ticket's
caller-close/abort evidence reads them: `ux-terminal-close.mjs` (9 scenarios) and `ux-terminal-session.mjs` (38 checks /
7 scenarios).

**Deliberately left, with owners.** (1) 33 of 57 files under `apps/web/e2e/` still assert `.next/BUILD_ID` (36 at the
base); `ux-terminal-budget.mjs` additionally reaches `/api/durable-login` and `/api/agent`, routes the ingress does not
serve. Retiring the Next entry files and their harnesses is **client-app 17**'s scope — migrating 33 drivers here would
duplicate it and was not this ticket's claim. (2) The two re-checked limits still read as recorded and are asserted, not
assumed: a text file past 16 MiB previews locally (`ok: true`) and is refused over SSH (`operation_failed`), and a path
the tree no longer has is `operation_failed` on **both** hosts because the workbench has no `not_found` code. Adding one
is a public-vocabulary decision and belongs to [09](09-file-failure-and-preview-feedback.md), which is blocked behind this
ticket and client-app 17 and is not taken early. Evidence, commands, exits and logs:
[docs/verification.md](../../../docs/verification.md), section "SSH workbench tickets 06 and 08", raw logs under
`.dev/verify/ssh-workbench-06-08/`.
