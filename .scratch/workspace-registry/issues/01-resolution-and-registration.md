# Workspace resolution and binding owner

Type: implementation
Status: resolved — implementation, verification and independent reviews complete; integrated on `impl/architecture-consolidation` at `e3c278c0`
Blocked by: none
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `apps/server/src/server.ts`, `project-store.ts`, `catalogue-binding.ts`, new registry module/tests. This ticket owns registry extraction from `server.ts`; Backend and ingress server edits wait for this ticket to merge.

## Goal

Create backend-internal registry over configured workspaces, optional ProjectStore, gateway connections and host clients. Move resolution, registration replay and catalogue binding projection behind it; preserve configured → retained → project-folder precedence and existing profile routing.

## Acceptance

- [x] **WR1, WR3, WR6**: registry owns configured/retained/project resolution, registration replay and route projections; no-store startup behavior is preserved. Independent Spec review found no material issues.
- [x] **Interface ownership**: Configured workspace resolution, reads, catalogue and execution preparation still work without ProjectStore; mutations preserve unavailable outcomes. Server routes no longer own workspace snapshot or revision state.
- [x] **Verification**: `pnpm --filter @hepi/server test` passed 367/367 at `e3c278c0`; includes `src/project-registry.test.ts`, catalogue, project API and SSH project suites. `pnpm verify:changed --base=impl/architecture-consolidation` passed all selected checks on clean revision `e3c278c05a249683a2115e4c0a4bacacd3e78d7d`; details and raw logs: `.dev/verify/workspace-registry-01/2026-10-21T13-38-44-057-verify-changed/`. The initial review caught the missing explicit test-list entry; fixed in `e3c278c0` and rerun clean.
- [x] Updated `docs/projects.md` and `docs/architecture.md`; superseded server-owned resolution and publication helpers were removed.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.

## Independent review

- Spec review: no material Ticket 01 findings (`631c954e`..`1bb15f7a`); focused tests 36 pass and server typecheck pass.
- Standards review identified that the colocated test was absent from `@hepi/server`'s explicit routine test list. Added it in `apps/server/package.json`; `pnpm --filter @hepi/server test` then passed 367/367 and clean changed verification passed at `e3c278c0`.
- `git diff --check` clean.
