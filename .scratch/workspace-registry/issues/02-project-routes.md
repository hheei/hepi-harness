# Project mutations and retained bindings

Type: implementation
Status: resolved — integrated at `bcac9ff5`
Blocked by: [01-resolution-and-registration](01-resolution-and-registration.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: project/worktree branches in `apps/server/src/server.ts`, registry module, focused server tests. Only this ticket migrates project mutation routes; Backend composition consumes result afterward.

## Goal

Move create/update/default/unlink/remove project workflows into registry operations that own persistence, retained-binding updates, host registration/refusal and publication order. HTTP routes stop editing arrays or incrementing revision themselves. Preserve metadata-only unlink and existing bindings.

## Acceptance

- [x] **WR1–WR4, WR6**: project mutation owner, retained bindings and host verdicts source-reviewed. Checkout WR5 remains ticket 03.
- [x] **Interface ownership**: publication advances once for changed metadata; unchanged default keeps revision. Refusal/read preserve snapshot.
- [x] **Verification**: changed checks and admitted local/SSH project journeys recorded below.
- [x] Current project/architecture guides updated; old route workflows removed.

## Implementation and evidence

Integrated worker commit `ec036286` plus correction `bcac9ff5` into `impl/architecture-consolidation`. Coordinator found unconditional publication for unchanged default; owner now compares prior/result default. Existing test now chooses non-default by identity, avoiding random UUID sort assumptions, and checks repeat selection.

- `pnpm verify:changed --base=8a44daa9`, worker worktree at `ec036286` plus correction dirty source: exit 0; 368 backend tests, typecheck/docs. Report `.dev/worktrees/nonui-registry-02/.dev/verify/2026-10-21T16-53-56-966-verify-changed/verify.json`; raw log `/home/chlo/.pi/agent/sessions/--home-chlo-Documents-dev-hepi-harness--/tasks/01a15c17-51ee-75d2-80b8-9ae57d3c15af/bash-f4a6b0-7.log`. Prior run failed because test chose arbitrary second folder; retained in adjacent `bash-f4a6b0-6.log`, corrected before delivery.
- `node --test test/project.test.ts test/ssh-project.test.ts test/catalogue-binding.test.ts test/worktree-picker.test.ts`, from integrated `apps/server` at clean `bcac9ff5`: exit 0, 31 tests including retained folder unlink, restart and SSH execution. Raw log same task directory `bash-f4a6b0-8.log`.
- Source/diff review by coordinator: no remaining material finding in ticket 02. Independent reviewers could not connect to parent bridge; no independent-review claim. Checkout duplicate-root publication belongs to ticket 03.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
