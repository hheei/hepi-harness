# Private packaged-run environment and acceptance

Type: implementation
Status: resolved — integrated at `8a44daa9`
Blocked by: [01-callable-verification-operation](01-callable-verification-operation.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: native verification operation/environment and artifact acceptance support. Independent source ownership; only consume prebuilt artifacts; do not touch build/deployment hosts.

## Goal

Move cohesive display, fixture, packaged process and temporary-resource lifetime behind private implementation using existing credential-sandbox/offline-install owners. Preserve private Secret Service before any packaged credential action, login-keyring evidence, real cold-start/configure/restart/forget journey, owned-process cleanup and report finalization after teardown.

## Acceptance

- [x] **NV2–NV4**: satisfy corresponding acceptance rows in the spec, including stated ordinary-workflow semantics.
- [x] **Interface ownership**: No fake artifact/source substitute, global process kill, or generic platform runner; update releases, CI and App verification docs.
- [x] **Verification**: Run actual existing artifact acceptance against named prebuilt artifact; record artifact hash/revision, command, exit and logs. Build only on workstation/CI. Record actual command, tested revision/dirty state, exit code and raw log per [verification practice](../../../docs/agents/verification.md); planned checks are not passes.
- [x] Update owning current guides named by spec; remove superseded callers/tests in this slice, without aliases or fallback paths.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.

## Delivery and verification — 2026-10-21

Integrated `impl/nonui-native-02` at `8a44daa9` into `impl/architecture-consolidation`. Private
`apps/app/scripts/packaged-run.mjs` owns display, private credential session, ingress fixtures, packaged process
groups and temporary install roots. Operation retains product assertions and finalizes report after awaited teardown.
Existing CLI flags and 54 successful assertion names remain unchanged; `runCleanup` records cleanup completion.
App README, CI and releases guides updated. Source review completed by coordinator; independent reviewer agent-277
failed to connect twice, so no independent review pass is claimed.

Named prebuilt input: `.dev/worktrees/nonui-native-02/.dev/artifacts/nv02-debug/Hepi_0.1.0_amd64.deb`, debug x86_64,
source `ce8aa223a4674f7ac5aa902bc4e77931c64ca67e` with dirty verifier-only edits. Built on workstation before acceptance.
SHA-256: `d91110dffa6d4bd4fdbae7e1bbbbd626c5521f595cb07c72d3428dd1161605dc`.

- `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/nv02-debug --log-dir=.dev/verify/nv02-final`
  at `ce8aa223` + final implementation diff (subsequently committed unchanged as `8a44daa9`): exit 0, 54/54 assertions.
  Real dpkg transaction, cold start/configure/restart/forget, private credential entry, unchanged login keyring and
  completed teardown confirmed. Logs/report archived under `.dev/verify/native-artifact-verification-02/nv02-final`.
- `pnpm verify:changed --base=ce8aa223` at same dirty revision: exit 0; App typecheck, 29/29 tests and docs check passed.
  Raw selector logs archived under `.dev/verify/native-artifact-verification-02/2026-10-21T16-37-42-990-verify-changed`.
- Missing-artifact ordinary CLI failure at `8a44daa9`: exit 1 with `artifact-test-ran-to-completion` failed as expected;
  private display/credential teardown completed and login keyring unchanged. Logs under
  `.dev/verify/native-artifact-verification-02/nv02-early-failure`. This checks failure cleanup, not artifact acceptance.

Artifact provenance copied beside retained logs. Verification binds to tested revision/diff above; later integration
changes need their own relevant checks.
