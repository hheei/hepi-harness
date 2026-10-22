# Readable statically bundled SSH helper

Type: implementation
Status: resolved — implementation and independent review complete
Blocked by: none
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `packages/gateway/src/ssh-filesystem.ts`, runtime bundle build inputs/loaders and helper tests. Does not change GatewayRpcServer dispatch or FilesystemServer aliases.

## Goal

Move embedded Python helper into a readable source module and inline it at build time using existing client-runtime bundling constraints. Keep source/build artifact self-contained at runtime; preserve remote-host validation and exact request/result behavior.

## Acceptance

- [x] **FA1, FA4, FA5**: readable helper extraction preserves the exact helper bytes; package and admitted SSH/file workflows pass. Independent review pending.
- [ ] **Interface ownership**: No runtime sidecar dependency; runtime package works without repository files; no helper driver that bypasses shipped admission.
- [x] **Verification**: helper source, gateway SSH/file, server SSH project, client build/pack and changed checks passed; evidence below.
- [ ] Update owning current guides named by spec; remove superseded callers/tests in this slice, without aliases or fallback paths.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.

## Verification evidence

- Revision `5edc96fe16bb5afea6a90bc75d75aaf8af101d93`, clean tree: `pnpm verify:changed --base=5ec7ffe6` exit 0. Additional `pnpm typecheck`, `pnpm --filter @hepi/client build`, and `HEPI_REQUIRE_SSH_SMOKE=1 pnpm smoke:pack` all exit 0; smoke includes localhost sshd read/worktree. Logs: `.dev/verify/nonui-filesystem-01/`.
- Helper extraction is byte-identical: decoded prior template vs new module equal, 43,443 bytes, SHA-256 `60f28535…cb4c`. Python compile/source test passes; `node --test packages/gateway/test/ssh-helper-source.test.ts` exit 0 (1/1).
- Gateway SSH/file suites 104/104; full Gateway acceptance 496/496; server SSH-project/agent-definitions/route suites 20/20. Raw logs retained under `.dev/verify/nonui-filesystem-01/` including `gateway-ssh-suites.log`, `gateway-acceptance.log`, `server-ssh-project.log`, `client-build.log`, and `client-smoke-pack.log`.
- Review initially alleged a backslash-escaping mismatch; exact test was run on `5edc96fe` and passed 1/1. Reviewer retracted finding; no patch required. Independent Standards review pending.
- Scope retained: alias retirement and cross-adapter scenarios belong to ticket 02. Parity corpus does not establish every `node-ignore` pattern; record as current test limit.
