# 03 - Web acceptance

Status: delivered (plan A) on `impl/ssh-workbench-03` `bc6c71a`, reviewed APPROVED and **integrated** into
`integration/client-app` as `7807c46` — see the merge section at the end of this file
Blocked by: 01, 02 — both satisfied

Verify existing Web workbench adapter can list/read remote files and show changes/diff without protocol changes. Verify remote upload through existing file relay and DOCX preview through bounded byte response. Keep live watch visibly unsupported.

Acceptance: browser journey covers remote workspace list, text preview, upload, DOCX preview, Git status and diff; offline/error states remain actionable and live watch remains explicit unsupported.

## Readiness from ticket 02

The gateway half of this ticket's premise is settled: local and SSH workspaces answer the same four
operations with the same DTOs, codes, statuses and bounds (`impl/ssh-workbench-02` @ `83a1188`), and
`docs/workbench.md` states the contract. What ticket 03 still has to decide on its own:

- the wording the browser shows for `operation_failed` when the cause was a transport that never answered
  versus a host refusal, since both arrive as 409 with the same code.
- a text file past the 16 MiB read policy previews locally and is refused on an SSH host (recorded limit,
  not fixed): the viewer must show that as a named limit, not an empty file.
- remote upload through the existing relay, DOCX preview through the bounded byte response, and live watch
  staying visibly unsupported — all unchanged by ticket 02, so their acceptance is this ticket's.

## Delivered (2026-10-19, `impl/ssh-workbench-03`, plan A)

The three open questions above are resolved; `not_supported` is the only refusal code introduced, so no remote write
or live-watch scope was added.

- **The wording question.** A refusal now answers with the cause it has: `unknown_workspace` 404, `path_denied` 403,
  `gateway_offline` 503, `not_supported` 501 (the one true absence — now the gateway's own answer, which is why the
  code joined the workbench vocabulary), anything else `operation_failed` 500 with the operation named. A host refusal
  keeps its own code, so a lost transport and a refused path are no longer one sentence in the browser.
- **Past the 16 MiB read policy.** Still the recorded limit ticket 02 left; the browser now reads it as a refusal
  carrying the host's code instead of a bare status-shaped string, so it is a named limit and never an empty file.
- **Upload, watch, DOCX.** Remote upload accepted through the existing relay including its conflict strategies and a
  mid-upload disconnect; live watch stays the named 501. **DOCX preview is not delivered**: the premise is false
  (`mammoth` declared in `packages/ui` and `apps/web`, imported nowhere; `DocumentViewer` says "not connected"),
  and enabling it means rendering untrusted remote documents in the browser — an owner decision, not a verification
  gap. Ticket 02's 16 MiB reader bound applies upstream to it anyway.

## Acceptance evidence

| Seam | Command | Result |
| --- | --- | --- |
| Journey + refusals, mounted SSH workbench | `cd packages/gateway && node --test test/ingress-ssh-workbench.test.ts` | 5 pass / 0 fail |
| Refusal cause mapping | `cd packages/gateway && node --test test/files-surface.test.ts` | 6 pass / 0 fail |
| Payload bodies identical, host path gone | `cd packages/gateway && node --test test/file-transfer.test.ts` | 17 pass / 0 fail |
| What a person reads in chromium | `pnpm --filter @hepi/web test:file-failures` | 15 checks pass |
| Unchanged local journey regression | `pnpm --filter @hepi/web test:file-surfaces`, `test:files-transfer` | 10 / 17 checks pass |
| Full gateway suite | `cd packages/gateway && node --test --test-concurrency=6 test/*.test.ts` | 432 pass / 0 fail — this branch tree's count; it does not carry provider 02's 6 relay cases, so at the merge base `283caa0` the suite is 426 and at the integrated tip 438 |
| Selected gates | `pnpm verify:changed --base=cceb0ef` | all pass but `check-docs` (12 pre-existing links) |

The browser case is written to fail on the old silence, and was checked to: restoring `FileExplorer`'s catch to
`setGitFiles([])` makes `test:file-failures` exit 1 on "and names which surface failed" and "the panel offers to ask
again". It checks that the Retry button is present; it never clicks it, so the click's re-ask and recovery is
source-reviewed only (`FileExplorer.tsx:1010` → `changesRetryKey` → the effect's dependencies at `:800`).

## Merge into `integration/client-app`

Merged as `7807c46` (`--no-ff`, `ort`, parents `283caa0` + `bc6c71a`); `git merge-tree --write-tree` previewed clean as
`f58b99d` (exit 0), no conflict, no hand resolution. The branch merged the integration tip itself at `ed27c21`, so
`git diff --exit-code bc6c71a HEAD` exits 0 at the merged tip — the integrated tree *is* the reviewed tree. One correction
to the record above, made here because the text was written before the merge: `cceb0ef` is this branch's own pre-merge tip
(single parent `6b9341e`), not ticket 02's merge tip; ticket 02 integrated at `94e62b1`, and this ticket's merge base is
`283caa0`.

At the integrated tip: the gateway suite passes **438/438** three times (`node --test --test-reporter=tap test/*.test.ts`,
`.dev/verify/merge-client-app-13/gateway-serial-{1,2,3}.log`); this ticket's three files alone give 5 / 6 / 17
(`ingress-ssh-workbench`, `files-surface`, `file-transfer`); the 13-file combined seam gives 140/140 (`seam-gateway.log`);
server 473/473, ui 198/198, protocol 51, session 52, app 9, seven-package typecheck 0, `check-entrypoints` 0 (77 present,
including the new `test:file-failures`; 2 known-missing, 0 newly missing). The browser seams were re-run because they
carry this ticket's public claims: `test:file-failures` 15 checks, `test:file-surfaces` 10, `test:files-transfer` 17, all
exit 0 (`browser-*.log`). `check-docs` exits 1 on the same 12 baseline links over 386 files.

**What the merge actually combines.** `files-surface.ts` now maps a workbench refusal to a status per cause, and the
surface's host call goes through the same `GatewayHostClient` path ticket 02 gave parity to; the provider relay and the
MCP relay share `ingress/index.ts` with the routes this ticket's acceptance suite drives end to end. That is why the
13-file combined seam and the whole gateway suite were run at the tip rather than only this ticket's three files: 426 at
the merge base + 5 (`ingress-ssh-workbench`) + 6 (`files-surface`) + 1 (`file-transfer` 16 -> 17) = 438, which is the
number the next ticket inherits.

**One gate is flaky and it is not this ticket.** `pnpm verify:changed --base=283caa0` failed `changed-test` once on
`packages/gateway/test/ingress-mcp.test.ts:260` — `seen = ['/', '/v1/mcp']` where the test expects `['/v1/mcp']`. The
identical command fails the identical assertion at base `283caa0`
(`.dev/verify/merge-client-app-13/base-concurrent-fail.log`), and that file is unchanged by this merge
(`git diff --exit-code 283caa0 HEAD -- packages/gateway/test/ingress-mcp.test.ts` is 0). Under the concurrent runner the
recorder on the test's own bare host stub sometimes sees a root-path request the reviewed code never issues —
`ingress/mcp.ts:63` fetches `host.origin + "/v1/mcp"` and nothing in the shipped path fetches the root. The assertions that
matter (503 `mcp_unreachable`, then 401 after revocation) held in every run. Recorded with mechanism in
`docs/verification.md`; the harness fix belongs to whoever owns that test, not to this merge. No retry, no silent re-run
presented as evidence.
## Ticket 04 readiness

Blocked-by edges are satisfied. Ticket 04 inherits: gateway 438 tests at the integrated tip `7807c46` (432 on this branch's
tree), the browser-visible before/after table in
`docs/verification.md`, `test:file-failures` as the regression for failure wording, and the review point it names —
this ticket added no remote write and no live-watch capability. `apps/web/e2e/ux-ssh-project.mjs` (the sshd remote
project journey) is **stale on this tree** — it asserts a `.next/BUILD_ID` while `@hepi/web` builds to `dist/` under
Vite — so it fails its own precondition; it is unrelated to this change and untouched, and ticket 04 decides whether to
repair it or retire it.
