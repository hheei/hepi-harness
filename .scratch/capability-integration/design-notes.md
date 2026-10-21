# UI capability integration — preparation notes

Preparation only: no application, runtime-configuration or deployment change accompanies this file. It records the
source pin, what is already reused, what the framework actually offers, the decisions that follow, and the questions
that are genuinely the product owner's. Plan of record for the batches: this file, the specification in
[spec.md](spec.md) — now `ready-for-agent` — the 18 tickets in
[the breakdown](ticket-breakdown.md) and the manifest in
apps/web/vendor/pi-web/app/README.md (`../../apps/web/vendor/pi-web/app/README.md`).

Scope of this preparation: the first three batches — (A) session sidebar and UI-state persistence, (B) session
management, (C) project/folder UI and worktree routes/helpers. Nothing beyond them is prepared.

## 1. Source pin and snapshot state

| Fact | Evidence |
| --- | --- |
| pi-web pin is `76bdc57027172eb381a216d647225a6d24f23360` (v0.10.0), MIT | [docs/upstream-sources.md](../../docs/upstream-sources.md); `apps/web/vendor/pi-web/LICENSE` |
| The clone used is at exactly that revision with a clean worktree | `git -C <clone> rev-parse HEAD` = the pin; `git status --porcelain` empty; no fetch was needed |
| `apps/web/vendor/pi-web/lib` is byte-identical to the clone's `lib/` | `diff -rq apps/web/vendor/pi-web/lib <clone>/lib` → no output |
| The snapshot previously held `lib/` only; upstream `app/` was never copied | `apps/web/app` has `page.tsx`, `layout.tsx`, `api/[...path]/route.ts` only; `.scratch/ux-follow-up/skills-reuse.md` §3 states it |
| 23 upstream route files are now copied verbatim into `apps/web/vendor/pi-web/app/` | manifest table with per-file bytes, sha256, md5, and a byte-identity check against the clone |
| Every `@/lib/*` import of those 23 files resolves inside the existing `lib/` snapshot | dependency check reported no missing source; nothing else was copied — no `node_modules`, no `.next`, no full repository |
| The new directory is outside typecheck, the Next import graph and the docs/discovery walk | `apps/web/tsconfig.json` includes only `app/components/hooks/adapters/e2e`; `scripts/lib/discovery.mjs` `SKIP_DIRS` contains `vendor` |

Reproduction: clone the URL, check out the pin, verify the license, then compare each path with `sha256sum` against
the manifest. The upstream regression files (`*.test.mjs`) encode request/response contracts to re-derive from; they
do not run in this repository, and their dependencies are not installed here.

## 2. Reuse inventory

The vendored `lib/` helpers are the reusable half of pi-web; the copied routes are the reference for *what the UI
expects*. Verified with `cmp` against the clone:

| Helper | In `apps/web/lib` | Note |
| --- | --- | --- |
| `session-ui-state.ts`, `session-ui-state-shared.ts` | verbatim | read/write + pure rules for pins, archive and project order |
| `session-reader.ts`, `session-list-scanner.ts`, `session-path.ts`, `session-revision.ts`, `session-view-cache.ts` | verbatim | JSONL scanning, listing and caching — all filesystem-shaped |
| `session-fork.ts`, `session-fork-name.ts`, `session-title.ts`, `session-search.ts` | verbatim | fork, name suffix, title generation, content search |
| `session-stats.ts`, `session-timing.ts`, `session-family.ts`, `session-row-context-menu.ts`, `sidebar-actions.ts`, `sidebar-prefs.ts` | verbatim | list/row/sidebar presentation helpers |
| `worktree.ts`, `directory-browser.ts`, `default-cwd.ts`, `git-changes.ts`, `git-status.ts`, `git-types.ts`, `file-access.ts`, `path-security.ts`, `json-response.ts`, `perf.ts`, `subagents.ts`, `session-tool-selection.ts` | verbatim | Git worktree and reads, path allow-list, response helpers |
| `project-identity.ts`, `project-trust.ts` | verbatim | a folder's **derived** identity key and the trust decision store — neither records a project |
| `project-tree.ts` | verbatim | the **branch/entry tree projection** (`MAX_PROJECTED_TREE_DEPTH`, `BranchPreview`). It is not a project model and must not be read as one |
| `session-tree.ts`, `project-groups.ts` | adapted | import the app-local `workspace-memory` / `project-routing` seams; `project-groups.ts` groups sessions by a cwd-derived key |

Presentation is likewise already in place and mostly unmodified: `components/SessionSidebar.tsx`,
`SessionTree.tsx`, `SessionSearch.tsx`, `ProjectWorktreePicker.tsx`, `DirectoryPicker.tsx` are adapted;
`SidebarMenu.tsx`, `SidebarToast.tsx`, `SidebarIcons.tsx`, `WorktreeCreateForm.tsx`, `ProjectTrustDialog.tsx`,
`NewSessionContextBar.tsx` and `session-catalog-helpers.ts` are verbatim. `hooks/useSessionUiState.ts` is
verbatim.

**Reuse rule for the batches:** consume these helpers through the existing adapter seams rather than copying again.
The two seams are `apps/web/adapters/durable-api.ts` (durable backend) and `apps/web/adapters/workbench.ts`
(execution host through the gateway); both are reached through the single catch-all
`apps/web/app/api/[...path]/route.ts`. The copied routes are read as contracts, never imported.

Two groups are **not** reusable for the batches, in `apps/web/lib` and in the vendored snapshot alike, and are named
here so they are not mistaken for seams: the `mcp-*` family (`mcp-host.ts`, `mcp-config-read.ts`, `mcp-transport.ts`,
`mcp-sign-in.ts`, …) and `plugin-updates.ts`. They are shaped for a Pi SDK `ExtensionAPI` session and for the Pi
package manager (`DefaultPackageManager`, `getAgentDir()`, `pi install …` text), neither of which exists in this
architecture. They are provenance for the request/response shapes, nothing more. See §6a, §6b and §8.

## 3. Confirmed framework facts (pi-durable 1.1.0, installed package)

Paths below are relative to
`node_modules/@earendil-works/pi-durable/dist/`.

| Question | Fact | Source |
| --- | --- | --- |
| Conversation creation | `Tx.createConversation({ ownership })` and `Harness.createConversation(options, context)` | `types.d.ts:701`, `harness/types.d.ts:520` |
| Fork | `Tx.forkConversation(parentConversationId, at, { ownership })` and `Conversation.fork(at, options, context)` | `types.d.ts:705`, `harness/types.d.ts:489` |
| Conversation record shape | `{ id, parent?: { conversationId, at }, owner?: { conversationId, taskId } }` — **no title, no metadata, no timestamps** | `types.d.ts:248` |
| Conversation listing | `scanConversations({ ownerConversationId?, ownerTaskId?, order? }, limit, cursor)` — no filter on title, pin or archive | `types.d.ts:551`, `types.d.ts:820` |
| Entry listing | `scanEntries({ conversationId, minEntryId?, maxEntryId?, order? })` — an ID range; **paginated reads are the only content access there is** | `types.d.ts:558` |
| Documents | `defineDoc` / `defineDocFamily` with `scope: "session" \| "conversation" \| "task"`; read by `snapshot`, `documentState`, `watchDoc`; written through `tx.doc` | `documents.d.ts`, `types.d.ts:687-743` |
| Document retirement | `tx.retireDoc(...)` retires one document **incarnation** | `types.d.ts:738` |
| Conversation/entry deletion | **absent.** `Storage` exposes commit/mintId/conversation/scanConversations/entry/scanEntries/task/scanTasks/submission/scanSubmissions/findDocument/document/scanDocuments/close — no delete or purge. Grep of `dist`, `README.md` and `CHANGELOG.md` finds no `deleteConversation`/`removeConversation` | `types.d.ts:810-858` |
| Submission recovery | `tx.submissionByRequest(conversationId, requestId)`; the backend already answers `GET /api/conversations/:id/submissions` from it | `types.d.ts:699`; `apps/server/src/server.ts` |

Backend contract already in place (read from `apps/server/src/server.ts`): `GET/POST /api/conversations`,
`GET /api/conversations/:id/state|submissions|commands|settings|events`, `POST .../messages|abort|recall-queue|reload|busy`,
`PATCH .../settings`, `GET /api/hosts`, `GET /api/host/directories`, `GET/POST /api/projects`,
`PATCH /api/projects/:id`, `POST /api/workbench`, `/api/models-config`. The catalogue entry carries
`workspaceId, gatewayId, busy, revision, messageCount, firstMessage` and nothing else.

How a conversation is bound to a folder, because every removal question turns on it
(`apps/server/src/server.ts:25, 281-290, 396-462, 800-809`):

- The binding is a conversation-scoped document, `WorkspaceDoc = defineDoc<{ workspaceId?: string }>({ kind:
  "hepi.workspace", version: 1, scope: "conversation", history: "latest", fork: "current" })`.
- `bindingOf(workspaceId)` resolves it through the configured workspaces first, then through **every folder of every
  recorded project**; `ensureBinding` re-registers the owning project folder on the host before a request is served.
- The environment factory reads the binding back from the document and returns **no environment** when it does not
  resolve — "with no fallback to another project's root" — so a folder that disappears leaves a bound conversation
  with its history, its stored workspace id still reported, and no execution environment. Nothing surfaces an error.
- `ProjectStore` has `list`, `create`, `setDefault` and no removal; the schema, however, already carries
  `project_folders.project_id REFERENCES projects(id) ON DELETE CASCADE`, and `projects.default_folder_id` is a
  deferred reference into `project_folders`. A removal primitive is absent at the store and route level only.
- The gateway workspace registry (`packages/gateway/src/workspaces.ts:37-40, 160-170`) implements
  `list | register | browse | profiles` and **no unregister**. Registered roots live in the gateway process's memory,
  so a backend-side removal cannot un-register a root on its host.

## 4. Corrections to earlier statements

- **pi-web does have delete, rename, fork, pin/archive and worktree endpoints.** `DELETE /api/sessions/[id]`
  (cascades to subagent children, re-parents direct children, clears the session's pins and archive times, shuts down
  live wrappers, unlinks the JSONL), `PATCH /api/sessions/[id]` (rename through `appendSessionInfo`),
  `POST /api/sessions/[id]/fork`, `GET/POST /api/sessions/ui-state` (pins, archive, project order) and
  `GET/POST/DELETE /api/worktrees` all exist at the pin.
- **The 501s in `apps/web/README.md` are this repository's adapter answering, not upstream absence.** The line
  "pin/archive persistence (only `GET /api/sessions/ui-state` is answered; its write is not)" describes
  `apps/web/adapters/durable-api.ts` returning a static empty state on `GET` and falling through to `unsupported`
  on `POST`. Read it as a gap in this repository, never as a fact about pi-web.
- **pi-web has no Project model at all**, and nothing may be inferred from it about hepi's multi-folder Project. There
  is no `app/api/projects`, no project store, no project creation, no project removal and no folder removal.
  `project-identity.ts` derives an equality key from a cwd, `project-groups.ts` groups sessions by that key, and
  `project-trust.ts` stores a trust **decision** per folder path in `trust.json` (nearest ancestor wins; an explicit
  `false` is a decision). A "project" in pi-web is therefore whatever folder a session runs in, and a folder
  disappears from its UI when no session names it. It is a grouping rule, not a record.
- **pi-web's only folder-level removal is a Git worktree removal**, and it is a host mutation:
  `DELETE /api/worktrees { cwd, path, force? }` → `removeWorktree(cwd, path, force)`; git's own refusal of a dirty or
  submodule-bearing worktree surfaces as HTTP `409` with `dirty: true` so the UI can ask for confirmation, and `400`
  otherwise. It is gated by the file-access allow-list, and `GET` deliberately falls back to the inferred project root
  for a session whose worktree is already gone.
- **`POST /api/default-cwd` does not mean the same thing upstream.** pi-web's route creates `~/pi-cwd/<YYYYMMDD>` on
  the Web host and returns that path for the client to validate. hepi's route names the workspace the deployment was
  configured with. The upstream body is not a contract to port; only the name is shared.
- **The absence of a native full-text search does not force an index.** Upstream `session-search.ts` carries the
  opposite conclusion in its own comment — "scan recent files without an index; add indexing if measured latency
  warrants it" — with bounds of 500 files, 30 results, a 3 s budget, 16 MiB per file, a 1 MiB line cap and a 200
  character query. Bounded scanning is the upstream answer, so no index is prepared here.
- **The earlier vendor note that "no original Next API routes ... are copied" is still true of `app/` as an
  executable path** — the newly copied routes live under `vendor/` and nothing imports them.
- **Upstream's plugin routes are not a model for hepi extensions.** `app/api/plugins` lists and mutates Pi
  *packages* through `DefaultPackageManager` (npm/git sources, `pi install` parsing, package update checks). The
  batches mean durable extensions (§5 terminology, §6b); the package manager is out of scope and no compatibility
  with it is prepared.
- **The earlier recommendation in §6 to refuse a removal while conversations are bound is withdrawn.** It was written
  before the decision below; removal is metadata-only and succeeds, with the binding kept resolvable by a retained
  read instead of by a refusal.

## 5. Settled decisions

**Terminology (normative, confirmed by the product owner).** In this plan and in everything derived from it —
spec, tickets, code, UI copy and comments — **"extensions" means pi-durable extensions exclusively**: the
`Extension` objects installed in the backend's `Registry` and selected by name (§6b). Nothing else may be called an
extension.

- **Pi plugins / Pi packages are out of scope.** The Pi package manager, `DefaultPackageManager`, `getAgentDir()`,
  `pi install` and the upstream `/api/plugins` route are **not** part of this work and are **not** a compatibility
  target.
- **Agent Plugins bundle integration is out of scope.** A bundle format from another harness is not implemented,
  adapted or shimmed here, and no seam is reserved for one.
- Both remain **research references only**: they are read to learn a request/response shape or a UI pattern, never
  imported, and nothing in the batches depends on them.
- Where upstream's own vocabulary is quoted (a file name, a type name such as `PluginPackageInfo`, or the panel's
  `PluginsConfig.tsx`), it is a quotation of that source, not a term of this plan.

Ordered durable-first, then pi-web. Each is decided; §7 records how the product questions resolved.

1. **UI state (pins, archive, project order) becomes a hepi session-scoped document, not a file.** The rules already
   exist verbatim as `session-ui-state-shared.ts` (pure, client-safe); only the storage half changes.
   `apps/web/adapters/durable-api.ts` then answers `GET`/`POST /api/sessions/ui-state` from the document instead
   of a static empty state and a 501. **Shared per backend, as upstream is shared per agent directory**: one document
   serves every client of one backend. Rejected: reusing upstream's `pi-web-session-state.json` + `proper-lockfile`
   on the Web host, which would put user state on a process that is not the authority.
2. **Session title and rename become a hepi conversation document.** `ConversationRecord` has no title field and
   `ConversationQuery` cannot filter on one, so no framework change is implied and none is proposed; the title is
   hepi-owned state, exactly as `WorkspaceDoc` already is. Upstream's `PATCH /api/sessions/[id]`
   (`appendSessionInfo`) is the behavioural reference for the request/response shape only.
3. **Session delete is a hepi-owned tombstone that hides the conversation from the catalogue.** pi-durable 1.1.0 has
   no conversation or entry deletion and `retireDoc` retires a document incarnation, not a conversation, so the
   records are retained and the operation is presented as an ordinary removal. No UI may state or imply that the
   removal is not permanent. Two rules follow from that:
   - **No direct SQLite deletes.** The tombstone is written through the same durable API as any other document; the
     project database and the conversation database are never edited directly for this.
   - The owning implementation seam — wherever the tombstone is written and read back out of the catalogue — carries
     this comment verbatim:

     ```ts
     // Records are retained because pi-durable 1.1.0 has no conversation deletion; this hides the
     // conversation from the catalogue. Replace with the upstream deletion primitive when it exists.
     ```

   The upstream `DELETE /api/sessions/[id]` route is the reference for what deletion is expected to mean to a caller
   (subagent cascade, child re-parenting, pins and archive cleared), not for its implementation.
4. **Fork maps onto the framework directly.** `Conversation.fork(at, options, context)` (and `tx.forkConversation`)
   already exist, with fork-aware history and document fork semantics. The upstream route supplies the contract:
   answer with the new session id plus its catalogue row, refuse a not-found/unsaved/empty/subagent source with a
   `code`.
5. **Search is full historical body search, with no index.** Read entries through the public paginated reads
   (`scanEntries` per conversation over the catalogue from `scanConversations`) and reuse upstream's matcher, limits
   and response shape (`{ results, truncated }`, 500 sessions, 30 results, 3 s budget, 16 MiB per session, 200
   character query). Only the reading half of `session-search.ts` is replaced: it streams JSONL files, which is not
   how a durable conversation is stored. Bounded concurrency and bounded results are part of the contract, not tuning.
6. **Auto-name runs only on explicit request**, exactly as upstream's `POST /api/sessions/[id]/auto-name` does; there
   is no automatic naming after a first exchange. The entry point is still not portable: `lib/session-title.ts` drives
   an SDK `AgentSession` from `@earendil-works/pi-coding-agent`, and the durable backend runs a pi-durable `Harness`
   and owns no such session. The reusable parts are the transcript budget and the prompt shape; the generation call has
   to be made from what the backend has.
7. **Worktrees are in the requested scope** — they are part of batch C, not a question about whether they are wanted.
   They are a **gateway capability gap, not an adapter gap**: the gateway's workbench operations are
   `files | read | changes | diff` (`packages/gateway/src/workbench/index.ts`) and an SSH gateway serves no workbench
   at all, so `GET/POST/DELETE /api/worktrees` has no host operation to call yet. Upstream's semantics are settled and
   are reused as-is when the operation exists: `GET` falls back to the inferred project root for a removed worktree,
   `POST` requires an existing `cwd` and a branch, `DELETE` needs an explicit `force` and answers `409` with
   `dirty: true` when git refuses. `lib/worktree.ts` is already vendored and verbatim.
8. **Already-mapped routes are not re-prepared.** `GET /api/sessions`, `GET /api/agent/running`,
   `GET /api/sessions/:id/state|context`, `GET /api/cwd/browse`, `POST /api/cwd/validate`,
   `POST /api/default-cwd`, `GET /api/home`, `GET /api/git/status` and `GET /api/git/diff` are answered from
   the catalogue, the routing layer or the workbench proxy today. Their snapshots are contracts to keep honest, not
   work items.
9. **Presentation is reused as-is.** The sidebar, tree, search, project/worktree picker and directory picker are
   already adapted or verbatim; the batches wire endpoints behind them rather than replacing them.
10. **Removing a Project or a Project-linked folder removes metadata only.** The project record and the folder *link*
   go; no directory is touched, no conversation is deleted, no workspace id is reused and no host registration is
   undone. hepi never creates, renames or deletes a directory for a project, so physical removal stays an explicit
   user filesystem operation outside hepi. **Nothing is refused because conversations are bound** — the earlier
   recommendation to refuse is withdrawn; the binding is kept resolvable instead (§6).
11. **MCP runs on the Web host** — that is a statement about *which host's account and filesystem* the MCP servers
   belong to, not about the Web process. The Web process is a Next presentation/proxy with no agent loop and no
   session (docs/pi-config.md "Excluded"; apps/web/README), so it cannot host an `ExtensionAPI` MCP host the way
   upstream does. Placement is separate from the Web process, and the Web host also runs the gateway; see §6a.
12. **"Extensions" means durable extensions and nothing else** (§5 terminology). Pi packages, the Pi package
   manager, Pi plugins and any Agent Plugins bundle integration are removed from the plan: nothing in the batches
   installs, updates, checks or adapts one, and no `DefaultPackageManager`, `getAgentDir()` or `pi install` text is
   reused. The only extension mechanism is pi-durable's own registry (§6b); the other two are research references.
13. **Retained bindings never appear as a target.** They stay in `GET /api/workspaces` — a bound conversation's
   display root is resolved from that list — but carry a `retained: true` marker, are excluded from every picker, and
   are never the answer of `GET /api/home` or `POST /api/default-cwd` (`durable-api.ts:341-350`), which keep
   answering from project folders only. A retained binding is also never pruned and never offered back: nothing here
   deletes a conversation, and re-adding the same directory as a new folder mints a new workspace id and leaves the
   old binding alone.
14. **Removing a non-default folder gets its own UI.** The default selector is not the whole surface: an explicit
   unlink is needed for a non-default folder, and the last-folder case removes the project record in the same
   transaction (§6.1).
15. **MCP is owned by the Web host's co-located gateway.** The `hepi-gateway` process on the Web host — not the Next
   container, not the backend — owns the MCP server processes, as a new host operation beside `execute`/`files`/
   `workbench`, and it owns the configuration and OAuth state as files in the host's own account, keeping upstream's
   shapes (`mcp.json` at the global and project scopes, OAuth state beside it). Rejected: a new host service, and a
   hepi document as the storage authority. The container has no volume mount, so nothing in this path may assume the
   Web process can read those files (§6a).
16. **Durable-extension selection is a global default plus per-conversation overrides.** The global default lives in
   Settings and applies to **new** conversations; existing conversations keep the selection they were created with,
   and a conversation may override its own selection. Both are the framework's own layers, used natively:
   `HarnessSettings.extensions` for the default, `AgentState.extensions` for the per-conversation stored choice,
   `Registry.install/uninstall` for the installed set (§6b). No hepi state is invented for this.
17. **The extension surface is enable/disable among installed durable extensions.** Only the standalone-extension
   half of the existing settings panel is reused; install, remove, update and check are dropped, no online source is
   contacted, and there is no generic per-extension settings editor — an extension reads its own documents and owns
   its own UI. The panel keeps its upstream file name, which is a quotation and not a term of this plan (§5
   terminology).

## 6. Project and folder removal — settled semantics and the binding seam

What the two layers actually provide, before any behaviour is chosen.

**durable.** Nothing about a project exists in the framework. A conversation binds a workspace id once, in a
conversation-scoped `hepi.workspace` document, and there is no conversation deletion (§3). A binding that stops
resolving costs the conversation its tools silently.

**pi-web.** No project record, no project removal, no folder removal (§4). The nearest thing it has to "a folder
leaves the list" is a Git worktree removal, which is a host filesystem mutation with an explicit force step, and a
trust decision that can be recorded or forgotten.

**hepi.** `ProjectStore` lists, creates and names a default; it has no removal. The schema would already cascade a
project's folders, so a removal is a missing primitive rather than an impossible one. The gateway has no unregister
operation, so no backend removal can stop a host serving a root it already knows.

The invariant every option has to respect is already written down and already implemented: *a conversation binds one
folder's workspace id and never changes it; every folder of a project stays resolvable for the conversations already
bound to it* ([docs/projects.md](../../docs/projects.md)). Removal therefore cannot leave a conversation without an
execution environment — the failure mode is a conversation that keeps its history, still reports a workspace id, and
can no longer run anything.

### 6.1 Settled semantics

1. **Removing a project removes the project record and the folder links.** No directory is touched, no conversation is
   deleted, no workspace id is reused, and the root stays registered on its host (there is no unregister to call, and
   the retained row is what re-registers the root after a gateway restart).
2. **The removed folder's workspace binding survives the unlink**, so a conversation already bound keeps resolving its
   host, its root and its environment. That is what the seam below is for.
3. **The default is never removed on its own.** A request that removes the default names the replacement default in
   the same call; a project is never left with zero linked folders, and removing the last one removes the project
   record in the same transaction. `projectGroup()` already returns `null` for a folderless project, so a folderless
   project is not a state to represent.
4. **No refusal and no bound-conversation count.** Nothing scans conversations to decide a removal, so a removal costs
   one transaction and the count question in the previous revision of these notes is gone.
5. **A physical directory is never removed.** The only folder-level removal upstream has is a Git worktree removal
   (§4), a host filesystem mutation; it is a different operation with different consent and is not this one.

### 6.2 Is a storage change necessary? Yes

Resolution today is `bindingOf(workspaceId)` = the deployment's configured workspaces, else `folderOf(workspaceId)`
over `projects[].folders[]` → `folderBinding(project, folder)` = `gateways.get(project.hostId)` →
`{ id: folder.workspaceId, gatewayId: project.hostId, gatewayOrigin, gatewayToken }` (`server.ts:384-408`). A folder's
binding therefore needs four values: the **workspace id** and the **root** (both on the folder row; the root is what
`registerFolder` re-asserts) and the **gateway id** and the **profile id**, both on the *project* row.

So deleting the project row deletes the gateway id and the profile id with it, and a folder row alone cannot name its
host. Verified consequence: with the project gone, `bindingOf` returns `undefined`, the environment factory returns
**no environment** (`server.ts:474-475`, deliberately "with no fallback to another project's root"), and the
conversation keeps its history and its stored workspace id while silently losing `read`/`write`/`edit`/`bash`. No
existing record survives with enough information, so yes: a storage change is necessary.

### 6.3 The smallest existing seam

**Decided: a `retained_bindings` table written in the same transaction as the removal**, holding
`workspace_id, host_id, profile_id, root`. It is additive — one `CREATE TABLE IF NOT EXISTS` inside the existing
`migrate()` seam (`project-store.ts:113-152`, beside the two table constants at `:84-85`) — and changes nothing
else: the `ON DELETE CASCADE` from `project_folders` to `projects`, `recordsOf()`'s inner join, the
`ProjectRecord`/`ProjectFolder` types and `projects.default_folder_id` all stay as they are. Resolution becomes configured → retained → project folders;
`allBindings()` adds the retained rows so `GET /api/workspaces` keeps answering a bound conversation's display root
(`durable-api.ts:175-180` `rootsByWorkspaceId`); `ensureBinding` re-registers from the retained row with its own host
and profile.

**Alternative, larger: make `project_folders.project_id` nullable and denormalize `host_id`/`profile_id` onto the
folder row**, so the folder row is self-sufficient and no second table exists. It costs a full rebuild of
`project_folders` (SQLite cannot drop `NOT NULL` or alter a foreign key in place — the same reason the existing
`migrate()` rebuilds `projects`), changes the folder type and the meaning of the join, and moves a project-level field
(one host per project, ADR 0005) onto every folder. Rejected: more change, same invariant.

Two properties make retention safe rather than a leak:

- **A workspace id is never reused.** It is minted per folder (`server.ts:699`) and the gateway refuses a different
  root for an id it already holds (`workspace_conflict`, `workspaces.ts:78-86`), so a retained id can never be
  silently re-pointed at another directory.
- **Nothing prunes it, because nothing can be deleted here.** A conversation is only ever tombstoned (§5.3), so a
  retained binding may be needed for the life of the store; and gateway registration is already retained without any
  work — `WorkspaceRequest` is `list | register | browse | profiles` and `WorkspaceRegistry` has no unregister, so the
  root stays served until that gateway process restarts.

### 6a. MCP placement: the Web host, not the Web process

Facts, from this tree and the pin:

- The Web process is a presentation/proxy. It holds no session, starts no agent loop and imports no `rpc-manager`
  (`apps/web/README.md`), and `pi-config.ts:122` lists `mcp` among the Pi settings the backend explicitly does not
  apply. Upstream's MCP host is an SDK `ExtensionAPI` extension (`lib/mcp-host.ts`) loaded *inside* an agent session,
  and its routes read and write `getAgentDir()` and `<cwd>/.pi/mcp.json` on whatever host that session runs on.
- In hepi the session is the durable `Harness` on the **backend** host, and a conversation's execution host is a
  *third* place: the gateway a project names (the Web host's own gateway, or an SSH host). Neither is the Web host by
  construction, so "MCP on the Web host" is a deliberate placement that follows from neither.
- The Web host is not just the Web container. On the real deployment it runs three units
  (`docs/local-tailscale-deployment.md:45-52`): `hepi-web.service` (the Next container), `hepi-tunnel.service`, and
  `hepi-gateway.service` — the host's own execution-side service, on `127.0.0.1:28788`, with an authenticated
  `/v1/...` surface (`execute`, `files`, `installs`, `workspaces`, `workbench`, `abort`), the host's account, and
  `HEPI_ALLOWED_COMMANDS`. That process, not the Next container, is the candidate for "a service on the same host".
- Two facts constrain the mechanism: pi-durable has **zero** MCP support (a recursive grep of the installed
  `pi-durable/dist` for `mcp` finds only a sourcemap string), so an MCP client on the backend would be a new
  durable extension; and the gateway's execute surface is per-call and journaled with abort, modelling no long-lived
  child process, so a server-spawning MCP host needs a new host operation whichever process owns it.
- The Web container has **no volume mount**: `hepi-web.service` runs `docker run --network host --env-file
  ~/.config/hepi/web.env` and `deploy/compose.yaml`'s `web` service declares no volumes. So `getAgentDir()` and
  `<cwd>/.pi/mcp.json` inside that container are the container's paths, not the Web host's.

Placement is therefore settled (the Web host's account and filesystem) and so is the owner: the co-located gateway
process, with the configuration and OAuth state as files in that host's own account and upstream's shapes reused
(§5.15). The Web process is not the owner.

### 6b. Durable-extension registry and config seam

The existing seam is exactly three call sites and one framework type:

| Piece | Where | What it is |
| --- | --- | --- |
| `createRegistry()` | `apps/server/src/harness.ts:42` | The application-owned registry; `Harness.open({ registry })` |
| `registry.install(...)` | `harness.ts:43` (CodingTools, wrapped for per-call env), `harness.ts:47` (`configuration.resourceExtension`) | Every extension hepi has today |
| `defineExtension({ name: "workspace-resources", sections: [...] })` | `workspace-resources.ts:424` | The only first-party extension besides CodingTools |
| Selection | `harness.ts:49` (root), `server.ts:809` (new conversation), `server.ts:484-487` (`attach` force-adds) | By name, per conversation |

What the framework offers beyond that (`harness/types.d.ts:205-246, 251-278, 354-370`): `Registry.install/uninstall`
and `snapshot()`/`subscribe()`; `HarnessSettings.extensions` as the harness-wide default selection;
`AgentState.extensions` as a per-conversation name list or `{add, remove}`; `AgentChange.extensions` to add or remove
extension *objects* at `configure()` time; `ToolExecutionApi.registry` as a snapshot for a tool call.

What does **not** exist: any discovery or loader (nothing in `pi-durable/dist` reads a directory or dynamically
imports), any package/version concept, and any per-extension configuration surface — an extension reads its own
documents, as `workspace-resources` does with `WorkspaceResourcesDoc`. Extensions are TypeScript installed by the
backend process at startup.

Selection is stored by the framework, in both of its own layers (§5.16). The one subtlety worth writing down:
`HarnessSettings.extensions` is documented as "read at every resolution and never copied"
(`harness/types.d.ts:354`), so changing the global default would move under conversations that never made a choice.
The rule that a new default applies to *new* conversations only is therefore kept by the existing creation path,
which passes the selection explicitly — `server.ts:809` already builds the `extensions` array per conversation, and
`harness.ts:49` does the same for the root. A conversation's stored `AgentState.extensions` is then its own, and an
override is the same field written by `configure`.

**Implemented as ticket 15 (2026-10-11):** the panel is `apps/web/components/ExtensionsConfig.tsx` and the copied
`PluginsConfig.tsx` was removed with the package manager it drove; the paragraphs below are the plan that was
followed.

Native UI reuse: the settings panel `apps/web/components/PluginsConfig.tsx` (an upstream file name, quoted, not a
term of this plan — §5 terminology) is already adapted (a `displayCwd` prop) and calls
`GET /api/plugins`, `POST /api/plugins`, `POST /api/plugins/check`. Its model is two lists
(`PluginPackageInfo[]` for Pi packages, `PluginStandaloneExtensionInfo[]` for standalone extensions with
`kind | name | path | relativePath | scope | enabled`) plus `PluginAction = install | remove | update | disable |
enable`. The **standalone-extension half maps onto durable extensions** (a name, a path, an enabled flag); the package
half and the `install`/`remove`/`update`/`check` actions are the package manager and are dropped.
`components/settings-ui-helpers.ts` `itemsToSwitch()` is the reusable bulk-toggle rule. Only that half is
reused: install, remove, update and check are dropped and no online source is contacted (§5.17), and there is no
generic per-extension editor because the framework gives an extension no config surface.

## 7. Product questions — resolved

Nothing in this section is open. The resolutions are the decisions in §5 and §6; each entry names the decision it
became, so a later reader can find the reasoning rather than only the answer.

| Question | Resolution | Where |
| --- | --- | --- |
| Do retained bindings appear in workspace pickers? | They stay in the workspace list with a `retained: true` marker and are excluded from every picker and from `/api/home` / `/api/default-cwd` | §5.13 |
| Is a retained binding ever pruned or offered back? | No, ever; ids are never reused and nothing deletes a conversation | §5.13, §6.3 |
| Does removing a non-default folder need its own UI? | Yes, an explicit unlink; the last folder removes the project record in the same transaction | §5.14, §6.1 |
| Which process on the Web host owns MCP servers? | The co-located `hepi-gateway`, as a new host operation | §5.15, §6a |
| Where does MCP config and OAuth state live? | Files owned by the Web host's service, in upstream's shapes | §5.15, §6a |
| Is durable-extension enable/disable global or per conversation? | Global Settings default for new conversations, plus per-conversation overrides, using the framework's own layers | §5.16, §6b |
| Is installing a durable extension in scope? | No: enable/disable among already-installed extensions only | §5.17, §6b |
| Is a generic per-extension settings UI wanted? | No: an extension owns its document and its own UI | §5.17, §6b |

No further technical question about storage shape, schema or table is put to the product owner; those are resolved in
§6 and are implementation detail from here on.

### 7a. Out of scope until evidence exists

A separate effort is examining whether an alleged OpenAI harness standard or Agent Plugins bundle format is
compatible with this architecture. Until that research reports, nothing in these batches is shaped around it: no
adapter, no interface and no extension signature is prepared for a standard that has not been verified to exist or to
fit, and "extensions" keeps its single meaning (§5 terminology). If the research finds a real, loadable standard, the
extension seam in §6b is the place it would land, as a new decision — and the research is a reference input, not a
work item.

## 8. Explicit framework gaps

No replacement runtime, storage or registry is proposed for any of these.

| Gap | Consequence |
| --- | --- |
| No conversation or entry deletion in pi-durable 1.1.0 | session delete is a hepi tombstone that retains records; the comment in §5.3 marks the seam |
| `ConversationRecord` carries no title/metadata/timestamps | title/rename needs a hepi document; catalogue created/modified timestamps stay empty |
| No content search across conversations | search reads entries through the public paginated reads; no index is prepared, matching upstream's own bounded scan |
| No pin/archive/ordering primitive | UI state needs a hepi document |
| Gateway has no worktree read or mutation; SSH gateway serves no workbench | `/api/worktrees` has no host operation yet |
| Gateway has no workspace unregister | a removed project folder stays registered on its host until the gateway restarts — which is what retention relies on, not a defect to fix here |
| `ProjectStore` has no removal (schema would cascade) | project and folder removal is a new store and route primitive; the retained binding it writes is §6.3 |
| A folder row cannot name its host (the gateway id and profile id live on the project row) | removal without a retained binding silently costs a bound conversation its tools; §6.2 |
| No host-side MCP surface; pi-durable has no MCP support at all | MCP needs a new gateway host operation (the owner) plus a new durable extension on the backend to reach it; §6a, §5.15 |
| The Web container has no volume mount | host MCP config files are not reachable inside the Web process, which is why the co-located gateway owns them; §6a |
| The extension registry is code-only: no discovery, no loader, no package concept, no per-extension config | the extension surface can only be enable/disable among installed durable extensions; §5 terminology, §6b |
| Durable backend has no SDK `AgentSession` | upstream `session-title.ts` entry point is unusable as-is |
