# 04: SSH resources resolve target identity and real host paths

**What to build:**
Support execution-side resource discovery and reading on SSH workspaces. Resolves the remote login user and remote home on the SSH host (not the gateway machine's home), advertises real remote paths, and executes tools on the remote host without requiring Pi installed remotely.

**Copy / Borrow from:**
- Gateway SSH Transport: `packages/gateway/src/ssh-filesystem.ts` and `packages/gateway/src/index.ts` (`SshGateway`).
- UI Presentation: Existing web adapter workbench/session layers.

**Blocked by:** 02: Prompts and context use the same execution-side loader

**Status:** complete

- [x] Resolves remote execution account and remote home over SSH connection.
      The remote helper answers `host` with `pwd.getpwuid(os.getuid())`'s login and canonicalized home, read from the
      host's own account database. `SshFilesystem#executionHost` returns it; the gateway process account and home are
      never consulted, and a host that cannot report them fails explicitly instead of guessing (ADR 0002).
- [x] Discovers remote global, project, and ancestor skills and prompts using remote paths.
      A second `discover` request computes roots, context files and system/append prompt candidates from that account
      and home with the local filesystem's rules and the same order: the workspace `.pi/skills`, its `.agents/skills`
      and each ancestor's, the account's `<home>/.pi/agent/skills` and `<home>/.agents/skills`, then the
      workspace `.pi/prompts` and `<home>/.pi/agent/prompts`; context account-first then outermost ancestor first;
      project-over-global system/append prompts, and the workspace prompt root beating the account one. The workspace
      `.pi` roots carry `requiresTrust`, upstream's project `local` resources. Separate requests mean the read authorization is the host's answer, not a gateway-supplied
      value.
- [x] Ordinary remote tool reads access advertised skills and references on the SSH host.
      A read may name the workspace, an execution-side resource root, or exactly one of the host's context, system-prompt
      or append-prompt files; the helper enforces that list, so there is no blanket account-home authorization
      (`auth.json` and keys stay unreachable). Results keep the real remote path outside the workspace and the logical
      workspace path inside it. Resource locations are read-only: a mutation naming one gets `permission_denied`
      rather than being remapped into the workspace, whenever it names the resource as a physical path, the logical
      `/.agents/skills/...` form or a relative `AGENTS.md`, and for both sides of a rename. A symlink the user
      creates inside the workspace is their own file and keeps the ordinary workspace-confinement and installation
      checks; no extra resource rule is layered over it.
- [x] Host outage or unreachable SSH target produces clean offline outcome, never falling back to harness files.
      An unreachable host, or one that cannot report its account, fails the `executionHost` request: the conversation's
      load fails, that run gets HTTP 500, no model call happens, and the conversation list plus already-adopted
      conversations stay usable.

**Adapter interface changes:**
- `SshFilesystem` now answers the `executionHost` file method and imports `ExecutionHost`, `ExecutionHostIdentity`,
  `ResourceRoot` and `relativePath`/`within` from `./filesystem.ts` (no duplicate discovery rules).
- New exports in `packages/gateway/src/ssh-filesystem.ts`: `ReadAuthorization`, `readAuthorization(host, method)`,
  `isResourceRead(allow, path)`, `reportPath(root, path, resourceRead)`, `reportInfo(root, info, resourceRead)`.
- `REMOTE_FILESYSTEM_SCRIPT` gains `host` and `discover` modes, a `confine_read` used by every read mode, and one
  extra leading argument (the read authorization) before the operation.
- `packages/gateway/test/ssh-transport.ts` extracts the exact-argv Python runner fixture and adds a controlled
  distinct remote account/home via a generated `sitecustomize` module (test-only; no production user spoofing).

**Evidence:** `pnpm -r typecheck` and `pnpm -r test` pass (apps/server 56 passed, packages/gateway 36 passed,
protocol/session unchanged). Critical tests:
- `packages/gateway/test/ssh-resources.test.ts` (5 cases): remote identity distinct from the gateway's, roots/context/
  prompt order, ordinary reads of global/ancestor/project skills and prompts at real remote paths, confinement of
  non-resource account files and non-resource absolute paths, read-only resource locations, symlink
  classification/canonicalization, and unreachable/no-account outcomes.
- `apps/server/test/ssh-resources.test.ts` (3 cases): authenticated HTTP/SSE through a real gateway and backend over the
  SSH transport fixture — catalog and remote paths in the model transcript, ordinary `read` of a global skill, target
  outage isolated to one conversation with no model call and no harness fallback, and restart replaying the committed
  result while the host file changes.
- `packages/gateway/test/ssh-filesystem.test.ts` still passes through the shared fixture (transport extraction).

Red-then-green: `ssh-resources.test.ts` fails 5/5 with `ssh-filesystem.ts` stashed and passes 5/5 with it.

## Comments

- 2026-10-09 (follow-up: linked-worktree context shadow): `executionHost` now also reports
  `shadowedContextFile` — the main repository's context file a nested linked git worktree shadows — computed by the
  shared helper `packages/gateway/src/worktree-shadow.ts` for a local workspace and by the same rule inside the remote
  Python helper (`find_git_paths`/`find_shadowed_context_file`, `discover` mode) for an SSH host. Real git layouts are
  covered in `packages/gateway/test/worktree-shadow.test.ts` (nested worktree, ordinary repo, sibling worktree, bare
  layout, submodule) and over HTTP in `apps/server/test/ssh-resources.test.ts`. The helper is a separate module so an
  installation ticket can reuse it without touching the filesystem dispatch.

**Follow-up (prompt precedence and nested-home review):** the workspace's `.pi/prompts` root was listed after the
account's `<home>/.pi/agent/prompts`, which inverted upstream's `resourcePrecedenceRank` (project `local` before user
`local`) for a duplicate prompt name; the two roots are now swapped on the local and the SSH host. The ancestor walk also
re-tagged the account's own `.agents/skills` as an ancestor when the workspace sits below the account home, so the walk
now skips that directory (upstream `collectAncestorAgentsSkillDirs`) and it keeps its single user-ranked root. Both are
covered in `packages/gateway/test/filesystem.test.ts`, `packages/gateway/test/ssh-resources.test.ts` (nested-home case)
and `apps/server/test/workspace-resources.test.ts` (project-first `/summarize` expansion plus the collision diagnostic).

**Follow-up (roots and alias parity review):** the roots list omitted the two `.pi` skills directories upstream
also loads, and the mutation guard only recognised absolute resource paths. Both are fixed here: `resourceRoots` (local
and the remote Python `resource_roots`) now returns upstream's `resourcePrecedenceRank` order with the workspace
`.pi/skills` and `<home>/.pi/agent/skills` roots and a `requiresTrust` marker the loader honours, and
`mutationPath`/`mutationDenied` check the workspace-resolved path as well as the raw one, so a logical or relative alias
of a resource — including a rename destination — is refused like its physical path.

**Known limitations:** No live SSH host was authorized, so verification uses the controlled transport fixture described
above; a real-host smoke test remains to be run (reported, not fabricated). SSH installation/update is ticket 06.
