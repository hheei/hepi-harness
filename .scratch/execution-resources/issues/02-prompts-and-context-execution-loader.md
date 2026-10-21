# 02: Prompts and context use the same execution-side loader

**What to build:**
Unify prompt templates, system prompts, append prompts, and context files under the Workspace Resource Loader. All three resource types are read exclusively from the bound ExecutionEnv, preserving upstream precedence, argument substitution, and collision diagnostics.

**Copy / Borrow from:**
- Templates & Expansion: `@earendil-works/pi-coding-agent` core `prompt-templates.ts` (`substituteArgs`, `parseCommandArgs`).
- Context Precedence: `@earendil-works/pi-coding-agent` core `system-prompt.ts`.

**Blocked by:** 01: Local skills follow a fixed conversation workspace

**Status:** complete

- [x] Loads prompt templates and system/append prompts from the execution host via ExecutionEnv.
      `apps/server/src/workspace-resources.ts` reads the account `<home>/.pi/agent/prompts` and `SYSTEM.md`/`APPEND_SYSTEM.md`
      plus the project `.pi` counterparts through `ExecutionHostEnv`. `main.ts` wires only this loader; the legacy
      `pi-resources.ts` module keeps its exports for its own tests but is not in the production path.
- [x] Discovers context files (`AGENTS.md`, `CLAUDE.md`, etc.) using verified upstream precedence rules.
      The gateway reports the host's context files in `loadProjectContextFiles` order (account directory first, then the
      workspace and each ancestor outermost first, first matching name per directory); the loader renders them inside
      `<project_instructions path="...">` in `buildSystemPromptSections` order.
- [x] Supports command argument substitution for templates and skills without harness-local file fallbacks.
      Prompt templates expand through `substituteArgs`/`parseCommandArgs` from `pi-resources.ts`; a skill body is read
      from its real host path when the command runs, with `formatSkillToolContent`-style location and relative-reference
      text. No command path reads the harness filesystem.
- [x] Persists complete adopted loading result (skills + prompts + context) in conversation durable state.
      `hepi.workspace-resources` holds host identity, roots, system/append prompt, context contents, the complete
      skill+prompt catalog and the rendered prefix. Restart replays it; an ordinary read still sees current host files.
- [x] Resource read/parse errors produce clear diagnostics and remain conversation-scoped.
      An unreadable candidate (including a permission failure) or malformed frontmatter fails the whole load, commits a
      failed state, returns HTTP 500 for that attempted run, and leaves the service, the conversation list and other
      conversations usable. A missing optional directory is empty, and an escaping or broken symlink is reported by path.

**Acceptance corrections carried over from ticket 01:**
- `.gitignore`/`.ignore`/`.fdignore` rules now filter skill candidates, with each directory's patterns prefixed by its
  path relative to the root, matching upstream `skills.js`/`package-manager.js`.
- A symlink whose target stays inside the same resource root is followed (as upstream follows it) and deduplicated by
  canonical path, so the same skill reached twice is adopted once; an escaping or broken link is skipped and reported.
- An unreadable or malformed candidate is a failed complete load, not a silently skipped resource. Permission errors are
  not swallowed. Missing optional directories remain empty.
- `localExecutionHostIdentity` uses `os.userInfo().username`, not an inherited `process.env.USER`, so the reported
  account is the one whose home and files the tools actually use.

**Evidence:** `pnpm -r typecheck` and `pnpm -r test` pass (apps/server 55 passed, packages/gateway 31 passed,
protocol 10, session 3). Critical tests: `apps/server/test/workspace-resources.test.ts` (13 cases, authenticated
HTTP/SSE through a real local gateway with a temporary execution account home distinct from the harness home) and
`packages/gateway/test/filesystem.test.ts` ("resolves the execution account and serves resource roots read-only", now
covering prompt/context metadata, read-only refusal and non-resource account files). Red-then-green: the new suite fails
9/10 with the implementation stashed and passes 10/10 with it.

**Known limitations:** SSH host identity is ticket 04 (`SshFilesystem` does not answer `executionHost`). The gateway
side of the linked-worktree context shadow rule is implemented in ticket 04's follow-up:
`packages/gateway/src/worktree-shadow.ts` `findShadowedContextFile` supplies `ExecutionHost.shadowedContextFile` for a
local workspace and the SSH helper resolves the same field on the remote host, so this loader's `visibleContextFiles`
filter is fed by real git metadata. Pi packages/extensions/themes/MCP and a `PI_CODING_AGENT_DIR` override on the host
are not adapted.

## Comments

- 2026-10-09 (follow-up review): directory traversal now records each entered directory by canonical path once per root,
  so a symlink to itself, an ancestor or any directory of the same root terminates; the critical test times out without
  the guard. Ignore rules and traversal now use the logical entry path rather than the canonical path the gateway's
  `listDir` reports, restoring upstream's match semantics; a test asserts a link into a directory whose real path is
  ignored is still discovered. Skill and prompt file dedup stays canonical. `visibleContextFiles` implements the
  worktree shadow filter with the host field documented for ticket 08. No change to `server.ts` (agent 07 owns reload).
- 2026-10-09: `apps/server/src/workspace-resources.ts` supersedes `workspace-skills.ts` as the production loader and
  adopts skills, prompts, system/append prompts and context in one discovery pass, committing one complete result. The
  legacy `pi-resources.ts` exports (`substituteArgs`, `parseCommandArgs`, `createPiResources`, `resourceUri`) stay until
  ticket 08 removes the module with its `pi-resource://` namespace and `read_pi_resource` tool.
- 2026-10-09 (ticket 08): the legacy `pi-resources.ts` module is deleted. `substituteArgs` and `parseCommandArgs` moved
  byte-for-byte with their upstream provenance comment into `apps/server/src/prompt-templates.ts`, which
  `workspace-resources.ts` now imports; `createPiResources`, `resourceUri`, the `pi-resource://` namespace and the
  `read_pi_resource` tool are gone with their module tests. The `enableSkillCommands` setting is carried through
  `createWorkspaceResources` so Pi's configured behaviour for listing `/skill:` commands is preserved.
- 2026-10-09: Pi settings' `skills`/`prompts` paths and the harness `agentDir` no longer supply resources in production.
  `main.ts` reports configured paths as not applied instead of loading harness-local files, and `projectTrusted` comes
  from the same `defaultProjectTrust: "always"` setting Pi uses. Ticket 03 builds atomic Reload on this loader's
  `discover`/`ensureAdoptedResources` result.
