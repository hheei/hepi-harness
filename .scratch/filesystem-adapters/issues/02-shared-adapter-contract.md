# Local/SSH adapter contract and alias retirement

Type: implementation
Status: resolved — integrated at ce8aa223
Blocked by: [01 SSH helper](01-readable-ssh-helper.md), [01 Gateway transport](../../gateway-transport/issues/01-file-and-terminal.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `packages/gateway/src/filesystem.ts`, filesystem constructor/type callsites and contract tests. Wait for Gateway ticket 01; owns shared FilesystemServer alias/import edits before Gateway ticket 02.

## Goal

Keep `FilesystemServer` as canonical seam. Migrate LocalFilesystem/SshFilesystem callers directly, share positive contract scenarios across ordinary admitted local and loopback SSH workflows, and remove obsolete aliases/redundant normalization tests after equivalent evidence exists. Preserve resource snapshots and host/account/scope semantics.

## Acceptance

- [x] **FA2, FA3, FA4, FA5**: shared positive local/real-loopback SSH contract, server project/resource integration, ignore parity and packed CLI checks passed.
- [x] **Interface ownership**: FilesystemServer remains the contract; workbench, execution-side skills and developer guide updated.
- [x] **Verification**: commands, tested state, exit codes and raw logs recorded below.
- [x] Removed GatewayFiles type/value aliases and renamed LocalFilesystemOptions; all current callers migrated.

## Delivery and verification

Implemented on `impl/nonui-filesystem-02`, fast-forward integrated into `impl/architecture-consolidation` at
`ce8aa223`. Tested source: `9828ff0d` plus this ticket working tree before commit, 2026-10-21. No filesystem
implementation behavior changed. Reviewed Spec and Standards directly; no material findings. Existing adapter-specific
tests remain: the new shared journey does not duplicate their transport/session ownership observations.

- `pnpm verify:changed --base=9828ff0d`: exit 0; server/gateway/web typechecks, gateway/server tests, Web unit and docs
  checks. Server suite 367/367. Raw log: `.dev/verify/filesystem-adapters-02/verify-changed.log`.
- `node --test --test-name-pattern=…` with the exact positive selector and six files recorded in
  `.dev/verify/filesystem-adapters-02/contract-resources-ignore.log`: exit 0, 19/19; local/loopback SSH contract,
  SSH project continuity, execution-account resources and 35,882 matching ignore decisions over 1,500 pattern sets.
- `pnpm --filter @hepi/client build && HEPI_REQUIRE_SSH_SMOKE=1 node .dev/positive-smoke-pack.mjs`: exit 0, six checks;
  packed CLI installed outside checkout, artifact notices, local and SSH authenticated reads, commands, MCP and
  worktrees. The driver retains ordinary admitted operations from smoke-pack; its exact source and output are in
  `.dev/verify/filesystem-adapters-02/positive-smoke-pack.mjs` and `packed-positive.log`.
- After adding the contract test to the gateway default script and editing guides:
  `pnpm --filter @hepi/gateway typecheck && pnpm check:docs`: exit 0; 463 Markdown files, zero broken links.
  `git diff --check`: exit 0.

The integration is a fast-forward of the tested source; verification is reused. No deployment or native save check
belongs to this ticket.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
