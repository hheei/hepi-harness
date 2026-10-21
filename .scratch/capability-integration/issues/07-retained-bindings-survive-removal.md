# 07: Retained workspace bindings survive Project and folder removal

**What to build:** Removing a Project, or unlinking one of its folders, removes only hepi metadata: no directory on the
host is touched, no conversation is deleted, and a conversation already bound to that folder keeps its execution
environment. The removal records a retained workspace binding in the same transaction, and that binding stays
resolvable for the conversations that hold it while never becoming a target for a new one.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Remove a Project whose folder an existing conversation is bound to. The Project disappears from the
project list, the directory is still on disk untouched, and that conversation still runs a workspace tool. A new
conversation cannot pick the removed folder.

**Stories:** 46, 47, 48, 49, 50, 51, 55, 56, 57

**Seam:** browser → existing Web adapter → durable backend, with the real store. The retained-binding effect is read
back through the backend's public project, workspace and conversation answers.

- [x] A Project removal removes the project record and its folder links in one transaction, and no directory on the
      execution host is created, changed or deleted (assert the directory and a file inside it are byte-identical
      afterwards).
- [x] A conversation bound before the removal still resolves its execution environment and completes a turn that runs
      a workspace tool.
- [x] The removal writes a retained binding carrying the workspace id, the host id, the profile id and the root, in the
      same transaction as the removal, additive to the existing schema and changing nothing about the existing project,
      folder or default-folder records.
- [x] A removal of a Project whose folders have bound conversations is answered as success: no request is refused
      because conversations are bound, and no bound-conversation count is computed or returned.
- [x] A retained workspace id never appears in the new-session target picker, never answers the home or
      default-directory queries, and never returns to the folder list.
- [x] Re-adding the same directory as a new Project folder mints a new workspace id; the retained id is never reused
      for a different root, and the host's own conflict refusal stays in place.
- [x] After the execution host's gateway restarts, the retained root is registered again and the bound conversation
      still resolves its display root and its tools.
- [x] Nothing is unregistered on the host: the retained record is what re-registers the root.

**Context:** [Spec](../spec.md) decisions 18–23 and 29; stories 46–51, 55–57; [design notes](../design-notes.md)
sections on retained bindings. Read [the breakdown](../ticket-breakdown.md#dispatch-order) before choosing work.

## What was built

**Store** (`apps/server/src/project-store.ts`). A `retained_bindings` table —
`workspace_id PRIMARY KEY, host_id, profile_id, root, retained_at` — created by one `CREATE TABLE IF NOT EXISTS`
inside the existing `migrate()` seam, beside the two table constants, so a file of either released version gets it in
place and nothing else about the schema changes: no `ON DELETE CASCADE` touched, no column altered,
`projects.default_folder_id` untouched. `remove(projectId)` reads the project, inserts one retained row per folder and
deletes the project row inside **one** `BEGIN IMMEDIATE`, and rolls back as a whole; the cascade takes the folder rows
and the deferred default reference is checked at COMMIT. `retained()` lists them. The store never touches a directory
and never reads a conversation.

**Backend** (`apps/server/src/server.ts`). Resolution is configured workspaces → retained bindings → project folders
(`bindingOf`), and the retained records are replayed on every start and re-asserted before a request that uses them
(`registerRetained`), because a gateway has no unregister and a restart serves nothing but its own seeded workspace.
`DELETE /api/projects/:id?hostId=` removes metadata only and answers the project that went; it refuses an unknown
project (`404 unknown_project`) and an origin that does not serve the project's host (`409 wrong_host`), and it never
refuses because a conversation is bound — no conversation is read, so no bound-conversation count exists to return.
`GET /api/workspaces` lists retained bindings with `retained: true` so a bound conversation resolves its display
root, while `allBindings()` — the new-target list the installer and the creation route use — is built from the
configured workspaces and the recorded Project folders only, so a retained binding is never a target.
`POST /api/conversations` refuses a retained workspace id as `unknown workspace`.

**Web adapter** (`apps/web/adapters/durable-api.ts`). `DELETE /api/projects/:id` forwards to the backend with this
origin's host and passes the refusal through with the backend's status and code. `rootsByWorkspaceId` became
`workspaceRoots()`, returning the roots **and** the retained ids from one read, so the session catalogue marks a
conversation bound to a retained folder (`workspaceRetained`) while still reporting its display root, and
`configuredWorkspaces` — the source of `GET /api/home` and `POST /api/default-cwd` — excludes retained ids.

**Browser rules.** `ProjectRoutingFolder.retained` / `ProjectGroup.retained` carry the marker through
`project-routing.ts`; `SessionSidebar`'s project list and `getRecentProjects` leave a retained folder out of every
new-session picker, `session-tree.ts` marks the group, and the group's "+" is not rendered for it at all (the sidebar
callback refuses it too, so the rule holds where the action is taken). The installation panel's execution-host selector
uses `selectableWorkspaces`, which is the same rule for the same reason.

## Verification

Merged with the integration branch before this run: `git merge-base --is-ancestor integration/ux-follow-up HEAD` and
`integration/execution-resources HEAD` both hold at `25695ec`, so the measured revision is the integration branch plus
this ticket.

| Command | Revision | Exit | Log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` (typecheck + workspace tests) | `25695ec` | 0, PASS/PASS | `.dev/verify/2026-10-11T14-47-25-088-verify-fast/verify.json` |
| `node --test test/project.test.ts test/ssh-project.test.ts` (18 tests, apps/server) | `25695ec` | 0, 18 pass | run in the worktree; the SSH half ran against the real localhost `sshd` |
| `node scripts/test-web-unit.mjs` (254 files) | `25695ec` | 1, the recorded 23-failure baseline | `.dev/verify/ticket07-web-unit/web-unit.json`; 2094 tests, 23 fail, and the failing **names** are exactly the 24 names the same suite reports at the base `76e75f7` (`/tmp/base-web.json`: 2083 tests, 23 fail, same names) — none added, none removed, 11 tests more |
| `pnpm --filter @hepi/web build` | `25695ec` | 0 | production Next build |
| `node scripts/check-docs.mjs` / `node scripts/check-entrypoints.mjs` | `25695ec` | 0 / 0 | 130 files, 0 broken links; 2 pre-existing known-missing entry files, 0 newly missing |

Not run: a browser driver. This ticket's seam is the backend's own public surface, and ticket 09 owns the browser half
of the demo path; no e2e script is added for a route no UI calls yet.

## Fixed by the final code review

One finding from the review of the merged effort is fixed in this ticket's own route.

| # | Finding | Trigger and impact | Fix |
| --- | --- | --- | --- |
| 1 | `DELETE /api/projects/:id` resolved the calling origin's host from the request's `hostId` and refused the Project when it differed (`409 wrong_host`). A remote Project — created on a configured SSH gateway from the same origin — could therefore never be removed from the browser that was showing it. | `apps/server/src/server.ts` now resolves the route through `projectHostOf()`: the **recorded Project's** `hostId` is the identity the removal acts on, a named host may only confirm it, and a different one is still `409 wrong_host` while the Project's own host not being configured is `409 configuration_required`. `apps/web/adapters/durable-api.ts` no longer names a host on this route. Regression: `apps/web/adapters/remote-project-removal.test.mjs` (adapter + real backend + real store + two real gateways) removes a remote Project from an origin whose own host is the other gateway and asserts the retained bindings, the untouched directories, and the intact refusal for a caller naming another host. |

## Review notes

- **Recorded: the removal route is backend-only until ticket 09.** Nothing in the browser calls
  `DELETE /api/projects/:id` yet, so the user-visible half of the demo path (a Project disappearing from the sidebar
  after its removal) arrives with ticket 09. Trigger: none today — the route is reachable only through the adapter and
  the backend's own API. Impact: none on this ticket's contract, which is the backend effect read back through the
  backend's public answers. Revisit when ticket 09 wires the Project menu.
- **Recorded: a retained binding stays in `GET /api/workspaces` for the life of the store.** It is never pruned
  because nothing here can delete a conversation, and the list is not paginated or bounded, so a store with many
  removals reports one entry per removed folder. Trigger: an operator who removes many Projects, on a Skills panel that
  reads the list. Impact: a longer list read; the panel's own selector filters retained entries out, so nothing is
  offered that should not be. Revisit if a real deployment reports the list cost, or when upstream gains conversation
  deletion and a retained binding can be pruned safely.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
