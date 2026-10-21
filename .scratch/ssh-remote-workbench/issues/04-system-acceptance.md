# 04 - System acceptance

Type: verification
Status: resolved — reviewed and integrated at `0994ffe` (2026-10-19); original closeout tested `5527f68`.
Blocked by: none — 06/08 integrated; 01/02/03/05 integrated; 07 resolved as deferred.

Final closeout of the approved capability scope (proposal rows P01-P07; see the mapping in
../ticket-proposal.md). It is **not** ready while a capability of that scope is undecided: DOCX preview (05), terminal
parity evidence (06) and the live-watch decision (07) each have to reach an answer first, even when the answer is a named
deferral.

Run ordinary local/SSH regression, package typechecks, verify:changed, browser checks and docs sync. Consume existing boundary evidence; do not design or execute bypass probes. Include
existing SSH terminal reconnect cursor, resize, caller close/abort, unreachable host, missing PTY/helper and bounded replay
tests - those are issue 06's evidence, which this ticket consumes rather than repeats. Add tests only for uncovered
failures. Record exact revision, commands, exit codes and logs. No deployment/restart implied.

Review must confirm no remote write/live-watch scope was added accidentally.


## Followup scope

[09 缺文件/预览反馈](09-file-failure-and-preview-feedback.md) 在本票和 client-app17 后实施；现有缺文件 vocabulary 等限制保留为真实已知限制，本票不反向依赖09。新 UX 总验收由 client-app22 收口。

## Integration verification (2026-10-19)

Parent inspected the terminal classification diff and original verification report; independent reviewer found no
material correctness/spec findings. Merged at `0994ffe`. `pnpm verify:changed --base=e99bed1` ran against
`0994ffe8cf43cc4b369fa6c408f7fb45284bce13` plus documentation-only status edits: typecheck, gateway/server tests and
Web unit checks exit 0; overall exit 1 from the same 12 historical broken links. Raw logs and exact step commands:
`.dev/verify/2026-10-19T12-48-05-262-verify-changed/verify.json` in the integration worktree.

Recorded minor review notes: launcher cleanup assertion uses an unrelated session ID; terminal-close success ignores
`--keep`; route/relay refusal status wording needs clarification if edited again. Reopen these only on observed impact
or explicit prioritization. Original acceptance evidence remains tied to `5527f68`; integration is not a deployment.

## Closeout executed (2026-10-19, `impl/ssh-workbench-acceptance-next`)

Consumed 06 and 08 rather than repeating them. The P01–P07 row-by-row answer, the ten browser drivers that run on this
tree with their counts, the scope check (`git diff --name-only 68ce3ca 5527f68` is 11 files, and its only source change is
the terminal launcher's classification — no watch, no write, no new route or protocol field, no polling path) and the four
limits that survive the closeout are recorded in [docs/verification.md](../../../docs/verification.md) under
"SSH workbench tickets 06 and 08", in its ticket-04 section.
