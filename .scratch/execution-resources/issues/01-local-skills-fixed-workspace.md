# 01: Local skills follow a fixed conversation workspace

**What to build:**
Create a conversation bound to a local workspace, resolve the execution account and home on that host, discover existing skills (global, project, ancestor), advertise real host paths to the model, and allow ordinary read tools to access skill files and references. Persist the initially adopted skill catalog so restart does not trigger rediscovery, and enforce that conversations never switch workspaces.

**Copy / Borrow from:**
- Path & Reference Formatting: `github.com/vastsa/PI-Desktop` `apps/desktop/electron/main/skill-document.ts` (`formatSkillToolContent`).
- Discovery Scanner: `github.com/vastsa/PI-Desktop` `apps/desktop/electron/main/importers/agent-skill-scan.ts` (global and project scanning across `pi-*` and `claude-*` conventions).
- Discovery & Parsing: `@earendil-works/pi-coding-agent` core `skills.ts` (`loadSkillsFromDir`, ignore logic, frontmatter parsing).
- ExecutionEnv Adapter: Adapt gateway filesystem RPC to access execution account home and workspace roots without falling back to harness home.

**Blocked by:** None (can start immediately)

**Status:** complete (superseded in production by ticket 02's unified loader)

- [x] Resolves local target execution account and user home via ExecutionEnv.
      Gateway `/v1/files` `executionHost` returns the account and canonical home of the host served;
      `gatewayEnvironment` exposes it as `ExecutionHostEnv.executionHost`. The backend never derives a home itself.
- [x] Discovers global skills (~/.agents/skills), project skills, and ancestor skills using real host paths.
      `resourceRoots` reports existing `<dir>/.agents/skills` from the workspace to the repository root, then the
      account home; `workspace-skills.ts` walks them with upstream `loadSkillsFromDir` rules.
- [x] Advertises real filesystem paths to the model transcript; ordinary `read` tool reads skill files.
      Upstream `formatSkillsForPrompt` with the real `<location>`; a read-only resource-root read serves the real
      canonical path, so `read` reaches a global skill outside the workspace. Those roots refuse every mutation.
- [x] Persists adopted skill metadata with conversation state; runtime restart does not rediscover or alter prefix.
      `hepi.workspace-skills` document holds host identity, roots, catalog and rendered prefix; restart replays the
      committed prefix while an ordinary read still returns the current host file.
- [x] Prevents workspace switching on existing conversations (even when idle).
      `validateCommand` returns `workspace_immutable` when a submit names another workspace; HTTP 400.
- [x] First-load failure is isolated to that conversation and does not break service startup or other conversations.
      Unreachable or absent execution host fails that attempted run (HTTP 500), commits a failed state, leaves the
      conversation list and other conversations usable, and allows retry.

**Evidence:** `pnpm -r typecheck`, `pnpm -r test` (apps/server 41 passed, packages/gateway 31 passed, protocol/session
passed). Critical tests: `apps/server/test/workspace-skills.test.ts` (HTTP/SSE through a real local gateway with a
temporary execution account home distinct from the harness home) and `packages/gateway/test/filesystem.test.ts`
("resolves the execution account and serves resource roots read-only").

**Known limitations:** SSH host identity is ticket 04. Recorded in docs/execution-side-skills.md. Ticket 02 replaced
`workspace-skills.ts` with `workspace-resources.ts` and closed the ignore-file and symlink gaps noted here, along with
the unreadable/malformed-candidate and `process.env.USER` corrections: see that ticket's acceptance corrections.

## Comments

- 2026-10-09: Skills were moved off the legacy `pi-resources.ts` path rather than duplicated on it. That module keeps
  prompts and context only (`includeSkills: false` in `main.ts`) and its skill commands are dropped from the commands
  endpoint when the execution-side loader is installed, so one skill is never listed twice. This is migration
  sequencing for ticket 02, not a runtime fallback: production skill discovery has no harness-local source.
- 2026-10-09: A read-only request inside a resource root reports the real host path, while a workspace read keeps its
  logical workspace path. Mutating methods refuse a resource-root path with `permission_denied` instead of silently
  remapping it into the workspace, so the account home is readable exactly where a resource lives and never writable
  through the file RPC.
