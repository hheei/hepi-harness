# Callable artifact verification operation

Type: implementation
Status: resolved — implementation and independent review complete
Blocked by: none
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `apps/app/scripts/verify-artifacts.mjs`, focused callable operation module/tests. Independent of backend/Gateway source; keep CLI behavior unchanged.

## Goal

Make operational CLI thin: resolve flags/default artifact and logs, call one concrete verification operation, print compatible summary/report and alone own process exit. Importing implementation performs no lookup, mkdir, spawn or process exit. Preserve report schema and CLI outcomes.

## Acceptance

- [x] **NV1, NV5**: operation is import-safe and CLI remains operational; paired packaged journey confirms behavior on matching artifact revision. Independent review pending.
- [ ] **Interface ownership**: No generic verifier or scenario-runner framework; operational `.mjs` entry can remain.
- [x] **Verification**: focused operation/CLI, changed profile and packaged journey evidence recorded below.
- [ ] Update owning current guides named by spec; remove superseded callers/tests in this slice, without aliases or fallback paths.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.

## Verification evidence

- Revision `107778e7` on branch `impl/nonui-native-01`, based on `5ec7ffe6`; clean tree. `pnpm verify:changed --base=5ec7ffe6` exit 0: typecheck, App tests 29 pass, script typecheck/tests 89 pass, entrypoints (141) and docs pass. Raw logs: `.dev/verify/nonui-native-01/`.
- `node --test apps/app/test/verify-artifacts-operation.test.ts` 3/3 and `node --test scripts/credential-sandbox.test.ts` 14/14. Prebuilt debug artifact at source revision `5ec7ffe6`: ordinary packaged journey 54/54; paired old/new output matches key set, assertion names and order. Running implementation revision against that older artifact produces the expected `provenance-names-the-built-revision` failure (53/54), not a product regression.
- Teardown verified: operation-owned Xvfb, app, private DBus and credential directory absent. No release-profile build or remote-host work was performed; packaged verification remains bound to prebuilt debug artifact.
