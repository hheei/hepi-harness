# 09: Project removal and folder unlink in the UI

**What to build:** The Project surfaces expose the removal and unlink operations built by tickets 07 and 08: removal
from the Project's own menu, unlink per folder, and a replacement prompt when the default folder is being removed. The
copy states that only metadata is removed and that no directory is deleted.

**Blocked by:** 07: Retained workspace bindings survive Project and folder removal; 08: Unlink a folder and keep a
Project's default valid

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** In the browser, remove a Project from its menu, unlink a folder from another Project, and be asked for a
replacement default when removing the default one.

**Stories:** 46, 47, 48, 52, 53, 54

**Seam:** browser → existing Web adapter → durable backend.

- [x] The Project menu offers removal and the folder list offers unlink for each non-default folder; removing the
      default folder requires choosing a replacement before the request is sent.
- [x] The confirmation names what is removed (hepi metadata) and what is not (the directory on disk, the
      conversations), before the action is taken.
- [x] After a removal the Project, its folders and its place in the project order leave the sidebar and the target
      picker without a page reload.
- [x] A refused removal (missing replacement, unknown folder, unknown Project) leaves the UI exactly as it was and
      shows the reason the backend gave.
- [x] A conversation of the removed Project stays listed and openable, and still runs a workspace tool.
- [x] Two windows of one backend agree after the action: the removal is visible in the other window.

**Context:** [Spec](../spec.md) stories 46–54; decisions 18–25. The backend halves are tickets 07 and 08.

## What was built

The Project's own menu in the sidebar (the group row's ⋯, `sidebar.projectActions`) gains two items for a group the
registry records: **Folders of <name>** and **Remove Project…**. Both open one body in the same menu
(`apps/web/components/ProjectRemovalMenu.tsx`) rather than a second dialog, so the menu's own focus handling, its
phone sheet and its Cancel keep working:

- the **folder list** names every folder by its own path on its host — never by the `/workspace/<id>` it is addressed
  by — marks the default, and gives each folder an unlink control;
- a **non-default folder's unlink** confirms first: the copy states that only hepi metadata is removed and that no
  directory on disk and no conversation is. Confirming sends `DELETE /api/projects/:id/folders/:folderId`;
- the **default folder's unlink** asks which of the project's other folders becomes the default, and its control stays
  unavailable until one is chosen: the chosen folder rides the same request as `defaultFolderId`, so the backend's
  `default_replacement_required` can never be provoked by this UI. When the folder is the project's last one, no
  replacement is asked for and the body says the project goes with it;
- **Remove Project…** confirms with the same metadata-only copy plus the statement that the conversations stay listed
  and keep running, and sends `DELETE /api/projects/:id`;
- a **refusal** leaves the step exactly where it was and shows the backend's own `error` text (the status when there is
  no readable body) — `apps/web/lib/project-removal.ts` `removalRefusal`;
- **after either operation** the registry's answer is applied to the list the sidebar shows and the rows are read again,
  so the removed project's name leaves the sidebar and the picker, its folders' conversations stay listed under the
  folder that retained them, and no page reload happens. A pin is what would otherwise keep an empty group on screen,
  so a pin for a key the registry no longer holds is dropped — by the same rule whichever window removed it;
- **another window** hears the removal from the poll it already runs: `GET /api/conversations` now carries the
  registry's own `projectsRevision` (this process's publication order, advanced by every accepted project mutation),
  the Web adapter forwards it on `GET /api/agent/running`, and the sidebar re-reads the registry and the rows when it
  changes.

The rules — which folder's removal needs a replacement, which one takes the project with it, what the request
addresses, what the answer makes of the list — are pure and live in `apps/web/lib/project-removal.ts`.

Deliberately not built: no default-editing control (`PATCH` stays a metadata contract), no reordering of folders, no
"remove all folders", and no removal control for a group the registry does not record (a configured folder, or a
conversation bound to a folder no project holds any more — neither has a project to remove).

## Verification

Merged with the integration branch before this run: `git merge-base --is-ancestor integration/ux-wave3 HEAD`
holds at `d316f62`, the wave-3 tip, so the measured revision is that integration branch plus this ticket. Everything
below ran in a clean worktree of `impl/capability-09` at its tip, `a597e47`.

| Check | Revision | Result | Log |
| --- | --- | --- | --- |
| `node apps/web/e2e/ux-project-removal.mjs` (real Chromium, real backend, real gateway, two windows, a controlled model endpoint) | `a597e47` | 0, passed | `/tmp/hepi-capability-09/.dev/verify/ticket09/e2e.log` |
| `node --test apps/web/lib/project-removal.test.mjs apps/web/components/ProjectRemovalMenu.test.mjs` | `a597e47` | 0, 13/13 pass | `/tmp/hepi-capability-09/.dev/verify/ticket09/unit.log` |
| `node scripts/verify.mjs --profile=fast` (typecheck + workspace tests) | `a597e47` | 0, PASS/PASS | `/tmp/hepi-capability-09/.dev/verify/2026-10-11T21-02-57-757-verify-fast/verify.json` |
| `node scripts/compare-tests.mjs --base=d316f62 --suite=web-unit` | base `d316f62` → tip `a597e47` | identical failure set: 23 pre-existing names, 0 new, 0 gone | `/tmp/hepi-capability-09/.dev/verify/2026-10-11T21-02-03-278-compare-tests/tip/web-unit.log` |
| `pnpm --filter @hepi/web build` (before the browser driver) | `a597e47` | 0 | see the run log |

## Review notes

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).

- **The removal control lives in the sidebar's project menu, not in the picker's.** Both surfaces list the same
  projects — the picker's choices are built from the sidebar's groups and from conversations — so one surface was
  enough, and the state machine stayed where the registry, the requests and the sessions already live. Moving it into
  the picker would have threaded three props through a component that owns none of that state.
- **A project the registry records but nothing shows cannot be removed from the UI.** It has no sidebar group (groups
  come from conversations, the current project and pins) and no picker row (same set plus conversations), so it is
  invisible everywhere; the removal has no control to offer. Not addressed here: making such a project visible is the
  project list's own question, not this ticket's.
- **One source-assertion test was updated, not worked around.** `apps/web/components/SessionSidebar.test.mjs`
  asserted the running poll's effect ended with `[loadSessions, noteUiRevision]`. The effect now also re-reads the
  registry, so it is keyed by `listProjects` too; the assertion was updated to the effect's real dependencies and
  extended with the registry revision it reads, rather than leaving the poll's deps stale.
- **The group folds up after its project is removed.** The folder that retained the conversations is a new group key,
  so its expansion defaults to folded. The conversations are still listed inside it; the fold is the sidebar's ordinary
  default for a group that is neither current nor pinned.
