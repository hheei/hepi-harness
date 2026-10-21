# 01 - Gateway remote workbench

Status: delivered (`impl/ssh-workbench-01` `bd80fc2`), reviewed PASS and integrated (`integration/client-app` `55a594e`;
workbench mounting on the SSH gateway still stands at the merged tip `bbd0d59`)
Blocked by: None

Mount `GatewayWorkbench` for SSH startup with remote workspace registry, `SshFilesystem` bounded reads and `SshRunner` Git command executor. Preserve existing workbench request/result protocol and local path rules.

Acceptance: SSH list/read/changes/diff integration tests pass; credentials remain Gateway-owned; no direct backend/Web SSH path.

## What was delivered

`GatewayWorkbench` now takes a per-workspace `WorkbenchHost` — `executeGit`, `tree`, `readFile`, `resolveExisting` —
and no host given is this machine, exactly as before. `startGateway` mounts one workbench in both modes: the local one
over this machine's registry, and `sshWorkbench(...)` over the SSH registry.

- `packages/gateway/src/workbench/ssh-files.ts` (new): the SSH host adapter. A preview is `fileInfo` +
  `openBinaryReader` + one `reader.read` of the 200 KiB bound plus a byte + `reader.close` through the gateway's own
  `SshFilesystem`; the listing's directory walk is `listDir`/`readTextFile` through the same session; Git is the same
  argv through the same `SshRunner` the worktree surface uses, with the workspace root as cwd and confinement root and
  the profile's own connection settings; `resolveExisting` is the helper's `canonicalPath`, which is what refuses a
  symlink escape.
- `packages/gateway/src/workbench/index.ts`: the host seam and one refusal vocabulary. `isPathDenied` accepts the local
  lexical/real-path refusal and the host's own `permission_denied`, so both hosts answer `path_denied`.
- `packages/gateway/src/workbench/workspace-paths.ts`: one `pathDenied` error carrying the workbench's own code.
- `packages/gateway/src/workbench/app-store-files.ts`: the directory walk takes a `WorkspaceTree`, defaulting to this
  machine; the local behaviour is unchanged. A host `not_found` counts as "no `.gitignore`", as `ENOENT` did.
- `packages/gateway/src/workbench/app-store-diff.ts`: a *thrown* executor (the transport's tagged
  `unreachable`/`outcome_unknown`/`operation_failed`) is rethrown instead of being reported as
  `git-status-failed`/unavailable, so a transport that could not answer is `operation_failed` rather than an empty
  change set. Git's own non-zero exit keeps the existing unavailable answer.
- `packages/gateway/src/startup.ts`: composes the workbench for SSH; comment updated (no longer "local-only").
- `packages/gateway/src/files-surface.ts`: the `501` wording now describes a gateway composed without the surface,
  which is the only shape that still answers it.
- `packages/gateway/test/fake-ssh.ts`: the in-process host gained `open_reader` and `reader_read`, which the preview
  reads through.
- Docs: `docs/workbench.md` (new "The SSH workbench" section with the per-operation table, path rules, bounds and
  verification) and `docs/migration-status.md` ("Browsing is local-only" replaced).

Not added, by ticket scope: live watch, a second workbench protocol, a second SSH connection pool, DOCX preview, and
any backend/Web SSH path. The preview and the listing reuse the one `SshFilesystem` session; Git reuses the plain
runner. Credentials stay in the gateway's profile; no answer carries host, identity-file or known-hosts material.

## Evidence

Revision `bd80fc2f891b65d872c418964eb2b6efe7cd3778` on `impl/ssh-workbench-01`, based on `integration/client-app`
`95f9257` (fetched at implementation time; no newer integration tip existed — `origin` has no
`integration/client-app` ref, so the local branch is the only one).

- `pnpm typecheck:gateway` — exit 0.
- `pnpm typecheck:server`, `pnpm typecheck:protocol` — exit 0.
- `cd packages/gateway && node --test test/*.test.ts` — exit 0, 381 tests pass (includes the new
  `test/ssh-workbench.test.ts`, 7 tests).
- `pnpm --filter @hepi/server test` — exit 0, 455 tests pass.
- `pnpm verify:changed --base=95f9257` — report `.dev/verify/2026-10-18T08-20-12-977-verify-changed/verify.json`,
  sha `bd80fc2`, `dirty: false`. Steps: `changed-typecheck` exit 0, `changed-test` exit 0 (gateway 381 + server 455),
  `web-unit` exit 0 (52 tests), `check-docs` **exit 1** with the same 12 pre-existing broken relative links that
  `95f9257` itself reports (`node scripts/check-docs.mjs` in a clean `--detach 95f9257` worktree: identical 12
  `BROKEN` lines, same exit 1). No broken link names a file this change touched.

## Limits recorded

- `check-docs` is red on the base revision for 12 `.scratch/` links; not this change's, not fixed here.
- The preview is the workbench's single fixed bound with no offset reads (unchanged): a truncated preview still answers
  the existing `501` for additional chunks.
- The SSH Git path has no managed-master reuse — it uses the same plain runner as worktrees and files, per the spec's
  "use shared existing transport unless tests show isolation is required".
- `pnpm check:docs` was run against this revision only; no deployment, no live SSH host mutation.
