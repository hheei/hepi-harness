# Execution-side resources (tickets 01–08)

Skills, prompt templates, system/append prompts and context files are execution-side resources (ADR 0002): the
Workspace Resource Loader discovers and reads them through the conversation's ExecutionEnv on the selected execution
host and account, and the model is given their real host paths. Nothing comes from the harness filesystem, and an
unreachable or unreadable host produces an error, never a harness-local substitute.

## What is implemented

- **Execution host resolution.** The gateway answers `executionHost` on `/v1/files` with the account and canonical home
  of the host it serves, plus that host's resource roots, context files and system/append prompt candidates
  (`packages/gateway/src/filesystem.ts`). A local gateway uses the process account from `os.userInfo()`; an inherited
  `USER` value is not trusted, because it can name a different login than the one whose home and files the tools use.
  The backend never derives a home from its own environment. `gatewayEnvironment` exposes it as
  `ExecutionHostEnv.executionHost`.
- **One snapshot per discovery.** A discovery is one request, not one per file. `resourceSnapshot` on `/v1/files`
  returns the whole resource scope set of the host in a single bounded response — its account and canonical home, every
  root, its context, system-prompt and append-prompt files, every directory of every root the loader would enter with
  its entries, and the text of every ignore file, skill declaration and prompt template — exposed as
  `ExecutionHostEnv.resourceSnapshot`
  (`packages/gateway/src/filesystem.ts`, `packages/gateway/src/environment.ts`). The loader makes exactly one call
  and then runs the walk below against an in-memory view of that snapshot, so the backend issues no per-file
  `listDir`, `canonicalPath`, `readTextFile` or `fileInfo` call at all. The bound is measured on the response as it
  is serialized, including every path, kind, timestamp and JSON escape and the host metadata, not on the text alone; over
  `MAX_SNAPSHOT_BYTES` (16 MiB) or `MAX_SNAPSHOT_ENTRIES` (20,000) the request fails with a clear error: the response
  is one value or none, never a truncation and never a second call for the rest. An environment that cannot snapshot is refused exactly as one that
  cannot resolve its host already was, so nothing falls back to harness-local content. On the SSH filesystem the remote
  helper's `snapshot` mode composes the primitives it already had into one in-process walk, so the host is resolved
  and the read authorization taken once per discovery instead of once per request.
- **What a snapshot carries, per kind.** Context, system and append prompt files and prompt templates are carried
  whole, because the prefix renders them and a template's body *is* the command's expansion. A skill is carried as its
  frontmatter alone — the declaration the prefix advertises — and its body is still read from its real host path when
  `/skill:<name>` runs, one read. Ignore files are carried whole, because the loader's own rules need their lines.
  Supporting files are neither discovered nor read, and no resource content is uploaded anywhere.
- **The snapshot prunes while it walks.** The producer applies the same `.gitignore`/`.ignore`/`.fdignore` rules the
  loader applies, through one shared `ResourceIgnoreRules` (`packages/gateway/src/resource-ignore.ts`), so an ignored
  file or subtree is never read, never transmitted and never counted against the bounds. It also stops where the loader
  stops: a directory declaring `SKILL.md` contributes that declaration and nothing beside or below it, and a prompts
  root is read one level deep. Both walks enter the same directories in the same order, so the accumulated patterns and
  therefore every decision are identical. The loader still reaches its own decision over the snapshot, which is what
  keeps it the authority on precedence, collisions and frontmatter. On the SSH transport the Python helper reads the
  same three file names and matches a pattern with **a port of the same `node-ignore` engine** — the same REPLACERS
  chain, the same trailing-wildcard handling, the same rule ordering with negations and the same parent-directory
  traversal — so there is one grammar and no subset to fall back from. A negation, a bracket class, `?`, a brace, a
  backslash escape and an interior `**` are all read by both producers, and an ignored file or subtree is pruned
  before it is read on either host. The port is pinned by a differential test that runs both engines over a generated
  corpus and requires every decision to agree (`packages/gateway/test/ignore-parity.test.ts`).
  Skill terminality is a separate decision and does not follow pruning: a directory declaring `SKILL.md` contributes
  that declaration and nothing beside or below it, on either producer.
- **Resource roots.** `resourceRoots` reports, in upstream's precedence order, the existing `<workspace>/.pi/skills`,
  `<workspace>/.agents/skills`, each ancestor's `.agents/skills` up to the repository root, the account's
  `<home>/.pi/agent/skills` and `<home>/.agents/skills`, then the workspace's `.pi/prompts` and the account's
  `<home>/.pi/agent/prompts`. That is `addAutoDiscoveredResources`' collection order after `toResolvedPaths` sorts by
  `resourcePrecedenceRank` (project `local` < project auto < user `local` < user auto, collection order inside one
  rank), so the workspace's `.pi` root outranks its `.agents` root, which outranks the account's `.pi/agent` root,
  which outranks its `.agents` root — for prompts the workspace's project `local` root outranks the account's user
  `local` one the same way. Only existing directories are listed, and the account home itself is never a root.
  The account's own `.agents/skills` is filtered out of the ancestor walk when the workspace sits below the account
  home (upstream `collectAncestorAgentsSkillDirs`), so it keeps its user rank instead of reappearing as an ancestor.
  A root carries `requiresTrust` when it is the workspace's own `.pi` directory, which upstream loads only under
  project trust; `.agents/skills` roots are host content and load regardless.
- **Read access.** A read-only file RPC naming a file below a skills root, or exactly one of the host's context,
  system-prompt or append-prompt files, is served with its real canonical path, so ordinary `read` and `listDir` calls
  reach them outside the workspace. Those locations are read-only: every mutating method refuses a path inside a root or
  naming a resource file with `permission_denied`, and a path outside the workspace and outside a resource stays
  confined as before. A link to a resource file is not that file: only the canonical path is authorized.
- **Every named form of a resource is refused.** A mutation is refused when it names a resource root or resource file
  as a physical host path, as the logical workspace-relative path (`/.agents/skills/deploy/SKILL.md`) or as a relative path
  (`AGENTS.md`), for both the source and the destination of `renameFile`, on the local and the SSH filesystem alike.
  Checking only the physical form would let a logical or relative spelling of a resource write what its own path is
  refused.
- **These checks are path discipline, not a sandbox.** The agent runs with the user's trust: it already has a shell on
  the execution host, so the resource read-only rule keeps the loader and installation code from writing a resource by
  naming it, and keeps the Gateway's file tools unambiguous. It is not an isolation boundary against a determined
  process, and the implementation does not accumulate per-tool guards trying to become one. Where isolation is wanted it
  belongs at the execution-environment boundary, applied best-effort there. Canonicalizing paths for correct resource
  discovery, deduplication and install placement stays, because it is a correctness need, not a containment claim.
- **Discovery and precedence.** `apps/server/src/workspace-resources.ts` walks each root with the upstream rules of
  `@earendil-works/pi-coding-agent@1.1.0`, over the one snapshot that discovery read rather than over the host itself:
  - Skills (`dist/core/skills.js` `loadSkillsFromDirInternal`): a directory holding `SKILL.md` is one skill and is not
    searched further, a directory without one contributes its `.md` children, subdirectories are searched recursively,
    hidden entries and `node_modules` are skipped, and `.gitignore`/`.ignore`/`.fdignore` rules filter the tree with
    each directory's patterns prefixed by its path relative to the root. Ignore rules match the **logical** entry path,
    as upstream's `readdir`-based walk does; the gateway's directory listings report canonical paths, so the loader
    rebuilds the logical path from the directory it is walking plus the entry name. A symlink is followed when its target
    stays inside the same root, and the same file reached twice is adopted once by canonical path (`loadSkills`
    `realPathSet`). Directory traversal is guarded the same way: the directory actually entered is recorded by canonical
    path and walked once per root, so a link to itself, to an ancestor, or to any directory of the same root terminates
    instead of recursing forever, while a directory the walk never entered (an ignore rule excluded it) is not recorded
    and does not shadow the real directory. One name is one skill: the nearest root wins and every later candidate is
    reported.
  - Prompts (`dist/core/prompt-templates.js` `loadTemplatesFromDir`): non-recursive `.md` files in each prompts root
    in root order, so the workspace's project `local` `.pi/prompts` root precedes the account's user `local` one and
    wins a name collision, with `substituteArgs`/`parseCommandArgs` expansion.
  - Root order (`dist/core/package-manager.js` `addAutoDiscoveredResources` + `resourcePrecedenceRank`): the workspace's
    `.pi/skills`, its `.agents/skills`, each ancestor's `.agents/skills`, `<home>/.pi/agent/skills`,
    `<home>/.agents/skills`, then the workspace's `.pi/prompts` and `<home>/.pi/agent/prompts`. A name declared by
    more than one root is adopted from the nearest one and the later candidate is reported, so a `.pi` root always
    beats the `.agents` root of the same scope, and a project-scoped root beats an account-scoped one.
  - System and append prompts (`dist/core/resource-loader.js` `discoverSystemPromptFile`): a project
    `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md` replaces the account file when project trust is on, otherwise only the
    account file loads.
  - Context (`loadProjectContextFiles`): `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`,
    one file per directory, the account directory first and then the workspace and each ancestor outermost first. The
    loader subtracts the linked-worktree shadow file when the host reports one, through `visibleContextFiles`; both sides
    are canonical paths, matching upstream's `canonicalizePath` comparison.
  - Prefix order follows `dist/core/system-prompt.js` `buildSystemPromptSections`: system prompt, append prompt,
    `<project_instructions>` context, then `formatSkillsForPrompt` with the real host path as `<location>`.
- **Durable adoption.** The rendered prefix, the complete catalog (skills and prompts), host identity, roots and the
  context contents are committed as one conversation-owned document (`hepi.workspace-resources`, version 2). The
  document holds an `adopted` baseline, and, when a Reload happens during an active run, a `candidate` tagged with that
  run's `pi.live.run.inputs[0]`. A restored conversation replays the result in effect, so a runtime restart is not a
  hidden reload and a host change enters only through an explicit Reload. Version-1 documents (a single `state`) migrate
  to `adopted`. Persisted state is not a snapshot: an ordinary read still returns the current host file, and a skill
  command reads its body from the host when it runs.
- **Retired records.** `hepi.workspace-skills` records are no longer read. Only `hepi.workspace-resources` restores adopted resource state; old records remain untouched in SQLite but do not restore a conversation's resource prefix.
- **Explicit Reload.** `POST /api/conversations/:id/reload` discovers and parses a complete candidate, then commits it
  in one transaction that also reads run status: an idle conversation promotes it immediately, an active run keeps its
  adopted prefix and the candidate is promoted on the next run. `pi.live.run.inputs[0]` is stable across one run's
  generations, retries and tool rounds, so a render for that run never sees the candidate, a steer placed into it keeps
  the baseline, and successive reloads inside one run promote the earlier candidate before recording the newer one
  rather than reverting to an older result. A discovery failure throws before any commit, so the previous prefix and
  catalog stay and the endpoint answers HTTP 500 with the error; the UI shows that error notice and its conversation
  stays usable. Committed state (with a `pending` flag for a deferred candidate) rides on the existing conversation
  state snapshot and SSE `state` event, so a reconnecting client sees it without a second event architecture.
- **Failure isolation.** A candidate that cannot be read (including a permission failure) or that has malformed
  frontmatter, and a missing or unreachable execution host, fail the whole load: the conversation commits a failed state,
  that attempted run gets HTTP 500, and the service, the conversation list and other conversations keep working. A
  missing optional directory is simply empty, and a later attempt retries discovery because no catalog was adopted.
- **Fixed workspace binding.** `validateCommand` refuses a submit whose `workspaceId` differs from the conversation's
  bound workspace with `workspace_immutable`, whether or not the conversation is busy.

## Explicit installation (ticket 06)

A Skill Bundle is published onto the execution host at an explicit global or workspace scope through the gateway's
narrow installation capability (`/v1/installs`), which stages a whole directory beside its destination and publishes
it with one rename. The install-time content baseline and provenance are recorded in a `.skill-lock.json` beside the
skills directory it describes; an absent baseline is unknown, not proof of local modification. A successful
installation asks the initiating conversation to Reload through the existing path, and publication and adoption are
reported as two separate outcomes: a failed Reload never rolls back published files. See
[execution-side installation](execution-side-installation.md).

## Updating an installed skill (ticket 07)

An installation already at the chosen scope is updated rather than installed over. The host's real directory is
compared with the install-time baseline: an unchanged installation is replaced directly, while a locally modified or
unmanaged one needs the user's explicit confirmation and is pinned to the content that was inspected. A confirmed
replacement moves the directory it replaces to a unique `<name>.bak` beside the skills directory first, and puts it
back if the publish rename fails. See [execution-side installation](execution-side-installation.md).

## SSH execution hosts (ticket 04)

An SSH workspace resolves and reads its resources on the remote host. The gateway's `SshFilesystem` sends the same
Python 3 helper it uses for files, so the host needs no Pi installation, and nothing is read from the gateway machine.
Both adapters implement `FilesystemServer`; callers depend on that contract, while construction names
`LocalFilesystem` or `SshFilesystem`. Resource snapshots and agent-definition requests keep their execution host
identity and scope; this interface does not choose a different account or resource root.

- **Remote identity.** The helper asks the host's own account database (`pwd.getpwuid(os.getuid())`) for the login and
  home of the account its commands run as, in its own request (`host`), and canonicalizes the home on the host. The
  gateway process's account and home are never consulted. A host that cannot report them fails explicitly; the failure
  is not a reason to guess a path or substitute a gateway home (ADR 0002).
- **Remote discovery.** A second request (`discover`) computes the resource roots, context files, system/append prompt
  candidates and the linked-worktree shadow from that account and home with the same rules and the same order the local
  filesystem applies: the workspace `.pi/skills`, its `.agents/skills` and each ancestor's, the account's
  `<home>/.pi/agent/skills` and `<home>/.agents/skills`, then the workspace `.pi/prompts` and
  `<home>/.pi/agent/prompts`; context files account-first then outermost ancestor first; project-over-global system
  and append prompts, and the same project-over-user prompt precedence. The Python program repeats the precedence rule
  rather than importing it, so the two hosts are checked against each other by the same assertions. Because discovery is its own request, the locations reads are authorized against are
  the host's answer, not a value the gateway supplied.
- **Remote reads.** A read may name the workspace, an execution-side resource root, or exactly one of the host's
  context, system-prompt or append-prompt files; the helper enforces that list, so resource access does not widen into
  a general account-home read. A path outside it is reported missing rather than served, and the account's other files
  (`auth.json`, keys) stay unreachable. Resource locations are read-only: a mutating method naming one is refused with
  `permission_denied` instead of being remapped into the workspace. A result keeps the real remote path for a resource
  location and the logical workspace-relative path inside the workspace, as the local filesystem does.
- **Symlinks.** The helper classifies a symlink as `symlink` and resolves it for `canonicalPath`, following it only
  when the target stays inside the same authorized location, so a link out of every resource root is refused the same
  way a workspace link out of the workspace is.
- **Outage.** An unreachable host, or one that cannot report its account, fails the `executionHost` request itself. The
  conversation's load fails, that attempted run gets HTTP 500, and no gateway-local or harness-local resource is used.

## The shared workbench's seam (ticket 12)

The Skills panel, the Agents panel, the quick delegate and the composer's skill-dormancy annotation are one set of
components in both hosts, and each reads its host through the connection it was mounted under rather than by a relative
address: `useExecutionTarget(workspaceId)` gives the surface a `select`ed target of
`@hepi/session/execution-resources`, whose `inventory`, `install`, `update`, `toggle`, `check`, `definitions`,
`saveDefinition` and `removeDefinition` name a **workspace** and never a computer. Which gateway and which account
serve that workspace is the Backend's binding resolution, so a Web page's relative origin with its cookie and an App's
configured Gateway with its device bearer reach the same host, and the entry's own default host
(`HEPI_INGRESS_DEFAULT_HOST`) can never override a Project's recorded binding.

Selecting a target is also the race fence, and the fence is the target's **identity** rather than a request counter.
`useExecutionTarget` creates its target inside the effect that holds it, so the replay both hosts run in StrictMode
gets a live target instead of the one its cleanup disposed, and the frame between two selections hands out no target at
all. A read then checks, at every point where it would write — the answer, the failure, and the end of the loading
state — that its target is still the one on screen: a superseded read publishes nothing, so it cannot replace the new
host's inventory, cannot report the old host's error, and cannot end the loading state the new host is still in. A
`disposed` refusal is not a host failure and is not shown as one.

The panels also ask the right conversation to pick a change up. A definition save, a skill operation and the
shell-tool setting are changes one conversation re-reads through the connection's `refreshes`
(`lib/conversation-refreshes.ts`): the mounted chat publishes its own reload for its own id, and a panel names only the
`sessionId` it was opened for — never a session key, a mount counter or a refresh counter. A write to one conversation
cannot reload another, a read answered after the reader moved to another conversation is not published as the new one's,
and a conversation nothing holds answers `not_open` rather than claiming a reload. `AgentsConfig` therefore settles its
own inventory from the answer and reports the conversation's read beside it, and `SkillsConfig` re-reads the host's
inventory directly instead of counting a key.

Two consequences a caller has to get right. A panel whose operation writes to a folder other than the one on screen —
the add pane under a Project, whose scope resolves to the project's own default folder — needs a target for **that**
folder, not the selected one; without it the pane has nowhere to install and says so. And a read that answers after the
folder changed must be dropped by the same identity check wherever it is read, which is why the agents panel and the
quick delegate use it too.

Two Web adapters that spelled the same operations a second way are gone. The `PATCH /api/skills` branch in the
retired Next entry's `apps/web/adapters/durable-api.ts` — and the SKILL.md-path-to-directory translation it used — was
deleted, because the panel sends the canonical `PATCH /api/skill-market/skills` itself. The `/api/agent-definitions`
surface answers a `cwd=/workspace/<id>` link and forwards the shared client's `workspaceId` unchanged; it resolves no
host either way. Both now live in the shared client and the ingress, with no per-entry copy (client-app ticket 17).

## Known limitations

- **Pi packages, extensions, themes and MCP** are not execution-side resources and are not loaded.
- **A skill cannot be uninstalled.** The installation capability publishes and replaces; there is no delete or
  uninstall operation on any host, so the panel offers none.
- A `PI_CODING_AGENT_DIR` override is not consulted for the execution host's Pi directory; the host's account directory
  is `<home>/.pi/agent`, as upstream's default is.

## Linked-worktree context shadow

A linked git worktree checked out below its main repository has two context files in the same logical repository scope:
the worktree's own and the main repository's. Upstream loads only the worktree's own, and so does this loader.

- **Host metadata.** `executionHost` reports the optional `shadowedContextFile` alongside the other host metadata. The
  gateway resolves it on the host, where git metadata is readable, and the loader only subtracts it by path, since the
  loader may read no more than resource roots and the workspace.
- **Exact rule.** Adapted from `findShadowedContextFile` and `findGitPaths` (MIT,
  `@earendil-works/pi-coding-agent@1.1.0`, revision `6fb2e7815167e6b19006fc526d1a5d0f5f998787`): from the canonical
  workspace, find the nearest `.git`; a directory means no shadow (an ordinary repository, a bare layout or a
  submodule), a file means a `gitdir: <path>` pointer whose directory must hold `HEAD`; `commonGitDir` is that
  directory or its `commondir` target; the workspace counts as linked only when it is below `dirname(commonGitDir)` and
  `<main repo>/.git` canonicalizes to `commonGitDir`; the field is then `<main repo>/<basename of the worktree's own
  context file>`, canonicalized, and absent when the worktree has no context file of its own. A sibling worktree
  (`git worktree add ../feat`) is not shadowed, because the main repository is not its ancestor.
- **One rule, two hosts.** `packages/gateway/src/worktree-shadow.ts` `findShadowedContextFile` computes it for a
  local workspace and the SSH helper computes it on the remote host with the same steps, so a worktree reports the same
  shadow either way. The field is metadata, not a read: the gateway never serves the main repository's file.

## Provenance

- Discovery rules, ignore handling, frontmatter parser, prompt templates, prompt formatter and context order:
  `@earendil-works/pi-coding-agent@1.1.0` (MIT, earendil-works/pi at revision
  `6fb2e7815167e6b19006fc526d1a5d0f5f998787`).
- Prompt-template helpers: `substituteArgs` and `parseCommandArgs` live in `apps/server/src/prompt-templates.ts`,
  behavior-equivalent to that revision's `dist/core/prompt-templates.js`, because the package root re-exports neither
  and the `core/prompt-templates` subpath is not exported. The `pi-resource://` namespace, the `read_pi_resource`
  tool and the harness-local `agentDir` loader and its module tests were removed in ticket 08.
- Ignore matcher: `ignore@7.0.5` (MIT), the same package upstream `skills.js` and `package-manager.js` use.
- Path/reference prompt formatting and `.agents/skills` shapes: PI-Desktop revision
  `ed54ce9774c41cefb5d0cdcdf922de7e6df22621` (LGPL-3.0). Snapshots and the exact mapping are in
  `apps/server/vendor/pi-desktop/README.md`.

## Verification

`pnpm -r typecheck && pnpm -r test` on the merged integration tip `edef2c0` (apps/server 138 passed, packages/gateway
80 passed, protocol 15, session 3, 0 fail). The counts above were taken on the earlier tip `7985dbb`; see
[execution-resources validation](execution-resources-validation.md) for that run. The critical tests are
`packages/gateway/test/filesystem.test.ts` ("resolves the execution account and serves resource roots read-only") and
`apps/server/test/workspace-resources.test.ts`, which drive authenticated HTTP/SSE through a real local gateway with a
temporary execution account home distinct from the harness home: project-over-global system and append precedence,
context order, real host paths in the model transcript, same-name prompt collision resolved project-first with the
loser reported as a diagnostic, `/skill:` expansion from the
current host file, an ordinary read of prompts/context/skills outside the workspace, refusal of the account's other
files, restart replay of the committed result with a current ordinary read, project-trust gating, malformed and
unreadable candidates failing only that conversation, ignore-file filtering and symlink dedup, workspace-switch refusal,
and no harness fallback for a workspace-less conversation. A self-referential symlink directory is asserted to terminate
(the test times out without the visited-directory guard), the logical-link-path ignore case is asserted directly, and
the worktree shadow is covered end to end from both sides: `packages/gateway/test/worktree-shadow.test.ts` writes the
git metadata each layout consists of (a nested linked worktree, a sibling worktree, a bare layout and a submodule) as
directories and files, so no repository and no `git` binary is involved, and asserts the field for the local filesystem
and through the in-process SSH helper, and `apps/server/test/workspace-resources.test.ts` plus
`apps/server/test/ssh-resources.test.ts` assert that a real worktree workspace loads its own context file and not the
main repository's. The root order and its alias guard are asserted on both hosts: the local and remote suites build the
`<workspace>/.pi/skills`, `<workspace>/.agents/skills`, ancestor, `<home>/.pi/agent/skills` and
`<home>/.agents/skills` roots, load a duplicate name from each pair so the `.pi` winner is observable, read both `.pi`
roots through an ordinary call, and assert that `writeFile`, `remove` and both sides of `renameFile` are refused for
the physical, logical and relative form of a resource. Ticket 03 adds
reload cases driven by a deterministic provider gate (the provider holds a run open on a promise, with no timing sleep):
an explicit reload adopting a complete candidate and repeated reloads while idle, two reloads during one held run where
the in-flight request and a steer keep the baseline and the next run promotes the latest candidate, a failed reload
retaining the previous prefix and catalog while another conversation and a retry keep working, and a restart replaying a
candidate committed before the restart. The retired-kind mapping is covered by a pure unit case and an HTTP/SSE restart
case that writes the ticket-01 document through the durable harness itself, disconnects the execution host, reconnects it
on a new port with a changed catalog, and asserts the committed prefix and catalog are replayed until an explicit Reload
adopts the changed host (and that an unreachable host fails that Reload without changing the adopted catalog). `apps/web` adds `adapters/durable-api.test.mjs` (the reload command reaches
the backend endpoint and a failure surfaces as `DurableBackendError`) and a `useAgentSession` case asserting the reload
command reads the committed summary, says a deferred reload applies to the next run, and reports a failure through the
shared error notice.