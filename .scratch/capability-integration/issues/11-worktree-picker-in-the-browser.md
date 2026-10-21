# 11: Worktree picker in the browser

**What to build:** The existing worktree picker and create form are wired to the real host operations from ticket 10:
list the Project's worktrees, mark the main checkout, create one, remove one, and show the dirty refusal as a distinct
prompt with an explicit force.

**Blocked by:** 10: Worktree list, create and remove on the execution host

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** In the browser, open the worktree picker for a Project, create a worktree on a branch, start a
conversation in it, then remove it and be asked before forcing a dirty one.

**Stories:** 59, 60, 62, 63, 64, 65, 66

**Seam:** browser → existing Web adapter → durable backend → execution host.

- [x] The picker lists the Project's worktrees with the main checkout marked, from the host's own answer.
- [x] Creating a worktree with a branch adds it to the list without a reload, and a bad create shows the backend's
      reason and leaves the list unchanged.
- [x] Removing a worktree removes it from the list; a dirty worktree is refused with a distinct dirty message, and
      force is a separate, explicit action.
- [x] A host that cannot serve worktrees is shown as a named limit, and the rest of the picker keeps working.
- [x] A worktree entry whose directory is gone falls back to the Project root instead of breaking the list.
- [x] A conversation created with a worktree as its target runs its file and shell tools in that worktree.

**Context:** [Spec](../spec.md) stories 59–66; decision 27.

## What was built

The host operation already existed (ticket 10, `POST /v1/worktrees`). This ticket is the seam between the copied
picker and it, and it needed one thing the host does not have: **a checkout is a conversation target only when hepi
records it as a workspace**, because a conversation binds a workspace id and never a directory.

- **Backend** (`apps/server/src/server.ts`): `GET`-shaped `POST /api/worktrees` with the host's three operations,
  addressed by workspace id exactly as the host's surface is. `create` registers the host's own canonical root under a
  fresh workspace id and records it as a folder of the Project (the record is written only after the host accepted it);
  `remove` drops that folder record in the same request and retains its binding, so a conversation already bound there
  keeps running. Every refusal keeps its own name and status: `dirty` is 409 with upstream's `dirty: true`,
  `not_supported` is 501, a transport failure is 503, and a removal of the Project's default folder is refused before
  git runs (naming a replacement is ticket 08's operation).
- **Store** (`apps/server/src/project-store.ts`): `addFolder` (keyed by root, so a checkout seen twice is one folder
  with one workspace id) and `removeFolder` (refuses the default folder; writes the retained binding in the same
  transaction, as a project removal does).
- **Adapter** (`apps/web/adapters/durable-api.ts`): keeps the copied route's shape — the browser asks by `cwd`, reads
  `{ isGit, isTopLevel, currentWorktreePath, worktrees }`, creates with `{ cwd, branch }` and removes with
  `{ cwd, path, force? }` — and adds the workspace each entry is recorded as. The checkout the asked-about cwd is in is
  addressed by the workspace that cwd names, so a configured workspace (which no Project records) is still a target.
- **Presentation**: the picker is the copied `ProjectWorktreePicker`, unchanged in shape. A checkout with no recorded
  workspace is listed and disabled with a reason; a pick is addressed by `worktreeCwd(worktree)` (its workspace, else
  its directory), one rule shared by the picker, the context and the sidebar; a create moves the composer into the
  created workspace; a removal refetches the Project list as well as the checkouts.

Verification (`impl/capability-11`, base `155a002`): `pnpm --filter @hepi/web typecheck` exit 0;
`pnpm --filter @hepi/server typecheck` exit 0; `pnpm --filter @hepi/server test` 191 pass / 0 fail (5 new cases in
`apps/server/test/worktree-picker.test.ts`, real git repositories and a real store, one of them composing a gateway
without the worktree surface); `apps/web/adapters/worktree-picker.test.mjs` 6 pass; the touched Web unit files 105
pass; `pnpm test:web:unit` 2115 tests / 2092 pass / 23 fail, the recorded baseline failure set unchanged;
`node apps/web/e2e/ux-worktree-picker.mjs` (`pnpm --filter @hepi/web test:worktree-picker`) exit 0 over 27 checks —
the production build, the real backend, a real gateway and a real git repository in a headless browser. Every wait is
an observable UI, request, filesystem or stored-state change; no fixed sleeps.

## Review notes

- **Recorded: a create writes the folder record in a second step, after the checkout exists.** If the backend cannot
  register or record the checkout — an unreachable host between the two calls, a full store — the checkout exists on
  the host and hepi holds no folder for it, and the browser is told `not_recorded` naming the path. Trigger: a
  transport failure or a store failure exactly between the host's create and this backend's registration. Impact: a
  checkout the user must remove by hand (or re-create through the picker, which records it) and no target claiming to
  be one. Revisit if such a checkout is ever reported left behind in ordinary use.
- **Recorded: a removed checkout's folder record is dropped after the host's removal succeeds.** The same gap in the
  other direction: a failure between the two leaves the host without the checkout and hepi still listing its folder,
  which answers `not_a_worktree` on a later removal attempt. Trigger: the same narrow window. Impact: a stale folder
  row, not lost work — the checkout is already gone and a retained binding is never offered back. Revisit if a stale
  folder row is ever observed in ordinary use.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
