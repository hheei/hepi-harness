# Checkout list/create/remove lifecycle

Type: implementation
Status: planned
Blocked by: [02-project-routes](02-project-routes.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: worktree branches in `apps/server/src/server.ts`, registry module, worktree tests. Sequential after ticket 02; no concurrent Backend route migration.

## Goal

Move checkout list/create/remove workflows into registry owner. Owner performs default-folder refusal preflight before host removal, preserves host dirty refusal and partial-success truthfulness, and sequences persisted metadata publication. Remove caller preflight/snapshot surgery.

## Acceptance

- [ ] **WR5, WR6**: satisfy corresponding acceptance rows in the spec, including stated ordinary-workflow semantics.
- [ ] **Interface ownership**: All checkout mutation and preflight knowledge resides in owner; routes only decode request and encode domain result; update projects and architecture guides.
- [ ] **Verification**: `worktree-picker.test.ts`, `catalogue-binding.test.ts` and normal admitted worktree journeys. Record actual command, tested revision/dirty state, exit code and raw log per [verification practice](../../../docs/agents/verification.md); planned checks are not passes.
- [ ] Update owning current guides named by spec; remove superseded callers/tests in this slice, without aliases or fallback paths.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
