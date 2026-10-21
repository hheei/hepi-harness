# 01 - Recovery capability audit

Status: resolved (audit complete; evidence in [capability audit evidence](01-capability-audit-evidence.md))
Blocked by: None

Read pi-durable recovery contracts and trace current child anchor, reporter, submission, tool, Gateway execution and status projection paths. Build crash-window evidence table: durable identities/checkpoints, recovery action, replay policy, unknown outcome handling and current user-visible state. Reuse SIGKILL/recovery tests; add no speculative runtime behavior.

Acceptance: cover model/tool interrupted paths, safe/unsafe replay, Gateway lost mutation, submission lookup, child settlement/reporter handoff, preparation retry, blocked task definitions and user fork. Cite source/tests and distinguish verified facts from gaps.

## Result

Done at `95f9257`. The capability matrix (24 durable objects/states), the crash-window identity table, the verified/gap
split and the exact commands, exit codes and logs are in
[capability audit evidence](01-capability-audit-evidence.md). Read-only assertions that pin the three load-bearing
claims are `apps/server/test/recovery-capability-audit.test.ts` (3 tests, exit 0). No product behavior, projection,
retry, fork, replay or deployment changed.

Evidence gaps carried forward, not defects: gateway `outcome_unknown` is flattened to a generic tool error before the
model (candidate for 02), and model-request interruption, `task_too_old`/`migration_failed` and the child-side
`outcome_unknown` journey are unmeasured (candidate for 04).

## Merge into `integration/client-app`

Merged into the integration tip as `01901bc` (`--no-ff`, `ort`, second parent `c8ed522`) with no conflict and no
hand-edit: `git diff c8ed522..01901bc -- apps/server/test/recovery-capability-audit.test.ts` is empty, and the merge
adds exactly this ticket's 9 files. The ticket stays resolved and no recorded gap changed status.

The audit's claims were measured at `95f9257`, which is an ancestor of the merged tree; `git diff
95f9257..01901bc -- apps/server/src` names only `conversation-operations.ts`, `server.ts` and the new
`subtree-control.ts` (subagent-subtree-control ticket 01), none of which this audit's rows depend on for its
load-bearing claims, so §6's family runs stand unchanged and were not repeated.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| New assertions on the merged tree | `node --test apps/server/test/recovery-capability-audit.test.ts` | `01901bc` | 0 (3/3 pass) | `.dev/verify/merge-client-app-8/recovery-audit.log` |
| Full server + gateway suites on the merged tree | `pnpm verify:changed --base=80608d6` → `changed-test` (`pnpm --filter @hepi/server --filter @hepi/gateway -r test`) | `01901bc` (`dirty: false`) | 0 (server 467, gateway 381) | `.dev/verify/2026-10-18T10-34-50-879-verify-changed/changed-test.log` |
