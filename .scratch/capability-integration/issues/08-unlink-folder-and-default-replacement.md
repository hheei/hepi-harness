# 08: Unlink a folder and keep a Project's default valid

**What to build:** A Project's folder list gains an unlink operation of its own, separate from the default selector.
Unlinking a non-default folder leaves the Project's default alone; a request that removes the default folder must name
the replacement in the same call; removing the last folder removes the Project in the same transaction. Every unlink
retains the folder's workspace binding exactly as a Project removal does.

**Blocked by:** 07: Retained workspace bindings survive Project and folder removal

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** Unlink a non-default folder from a Project and watch it leave the new-session picker while the Project
keeps its default; then try to remove the default folder without naming a replacement and be refused.

**Stories:** 52, 53, 54, 58

**Seam:** browser → existing Web adapter → durable backend, with the real store.

- [x] A non-default folder can be unlinked through its own control, not through the default selector; afterwards the
      Project still lists its other folders and its default is unchanged.
- [x] A request that removes the default folder without naming a replacement is refused with a readable reason, and
      nothing is removed.
- [x] The same request naming a folder of that Project succeeds and leaves the named folder the default.
- [x] Removing the last folder of a Project removes the Project in the same transaction: no request ever reads an empty
      Project.
- [x] Each unlink writes the same retained binding as ticket 07, with the workspace id, host id, profile id and root.
- [x] A conversation bound to an unlinked folder still resolves its display root, and still cannot be reached from the
      target picker.
- [x] The "use default directory" answer and the home answer are derived from real Project folders only.

**Context:** [Spec](../spec.md) decisions 19, 22, 23, 24, 25; stories 52–58. Depends on the retained binding ticket
because the unlink path and the Project removal path must write the same record.

## What was built

**Store** (`apps/server/src/project-store.ts`). `unlink(projectId, folderId, replacementDefaultId?)` is a new
primitive beside `remove`, and it is the only writer of a single folder's departure. It reads the project, refuses an
unknown project or a folder that is not that project's, and then decides on the default rule before writing anything: a
non-default folder goes on its own with the default untouched; the default folder may only go when
`replacementDefaultId` names another folder **that stays** — a replacement for a non-default folder is refused as
`unexpected_replacement`, because it would otherwise read as a default change that never happened — and the last
folder's departure needs no replacement because the project goes with it. One `BEGIN IMMEDIATE` writes the retained
row, updates the default reference when one was named, and deletes either the folder row alone or the whole project row
(whose `ON DELETE CASCADE` takes the remaining folder rows, exactly as `remove` does). A failure rolls back to the
untouched project. The result is the project as it stands afterwards, or `null` when it went, plus the
`RetainedBinding` written for the folder — the same record, shape and transaction placement ticket 07's project
removal uses, which is the whole reason this ticket depends on it. No directory is read, written or deleted, and no
conversation is read.

**Backend** (`apps/server/src/server.ts`). `DELETE /api/projects/:projectId/folders/:folderId` is the folder's own
route, addressed inside the project because a folder is the project's own and not a workspace; the optional
`defaultFolderId` query parameter is the replacement named in the same call, and it is the only way to remove a
project's default folder. The route refuses an unknown project (`404 unknown_project`), a folder that is not the
project's (`400 unknown_folder`), a missing replacement (`400 default_replacement_required`), a replacement named
for a non-default folder (`400 unexpected_replacement`), an unnamed host (`409 configuration_required`) and an
origin that does not serve the project's host (`409 wrong_host`) — the same host check the PATCH and DELETE routes
make. Success answers `200` with the project as it stands and `removedFolderId`, or with `project: null` when the
last folder took the project with it, and the process's own `projects` list follows the answer in the same step. The
retained record is appended to `retained`, so the unlinked folder resolves for the conversations already bound to it
and is re-registered after its host's gateway restarts, while `allBindings()` still leaves it out of every target.

**Web adapter** (`apps/web/adapters/durable-api.ts`). `DELETE /api/projects/:id/folders/:folderId` forwards to the
backend's own folder route with this origin's host and, when the browser sent one, the replacement default; the
backend's status, code and reason are passed through unchanged.

**Browser rules.** None. Ticket 09 owns the unlink control, the replacement prompt and the copy; nothing in the browser
calls this route yet, and the browser-side rules this ticket's acceptance criteria name (a retained folder out of the
target picker, out of the home answer and out of "use default directory") are already delivered by ticket 07 and
unchanged here.

## Verification

Merged with the integration branch before this run: `git merge-base --is-ancestor integration/ux-follow-up HEAD`
and `git merge-base --is-ancestor integration/execution-resources HEAD` both hold at `78678f9`, the merge of ticket
16 and the current tip of `integration/ux-follow-up`, so the measured revision is the integration branch plus this
ticket. Everything below ran in a clean worktree of `impl/capability-08`; the code is `1743da5` and the branch tip
is `d73ed9c`, a docs-only commit after it.

| Command | Revision | Exit | Log |
| --- | --- | --- | --- |
| `node scripts/verify.mjs --profile=fast` (typecheck + workspace tests) | `d73ed9c` | 0, PASS/PASS | `/tmp/hepi-capability-08/.dev/verify/2026-10-11T17-33-08-554-verify-fast/verify.json` |
| `node scripts/verify.mjs --profile=fast`, first run on the code commit | `1743da5` | 0, PASS/PASS | `/tmp/hepi-capability-08/.dev/verify/2026-10-11T17-23-47-613-verify-fast/verify.json` |
| `node --test test/project.test.ts test/ssh-project.test.ts` (21 tests, apps/server) | `1743da5` | 0, 21 pass | run in the clean worktree; the SSH half ran against the real localhost `sshd` |
| `node scripts/test-web-unit.mjs` (257 files) | `1743da5` | 1, the recorded 23-failure baseline | `/tmp/tip2.json`; 2111 tests, 23 fail, and the failing **names** are exactly the 23 names the same suite reports at the base `78678f9` (`/tmp/base2.json`: 2108 tests, 23 fail, same names) — none added, none removed, 3 tests more |
| `pnpm --filter @hepi/web build` | `1743da5` | 0 | production Next build |
| `node scripts/check-docs.mjs` / `node scripts/check-entrypoints.mjs` | `1743da5` | 0 / 0 | 131 files, 0 broken links; 2 pre-existing known-missing entry files, 0 newly missing |

Not run: a browser driver. This ticket's seam is the backend's own public surface, and ticket 09 owns the browser half
of the demo path; no e2e script is added for a route no UI calls yet.

### What the tests assert

- `apps/server/test/project.test.ts` — `unlinking a folder keeps the project's default valid and retains the folder's
  binding`: a three-folder project on a real loopback gateway, with a conversation bound to the folder about to go and
  already proven to read there. Unlinking that non-default folder answers `200` with the folder gone, the default
  unchanged and the directory and its file byte-identical; the retained row read back from the store with the workspace
  id, host id and root; the conversation still reading and `pwd`-ing in the unlinked folder afterwards, with
  `POST /api/conversations` refusing that id as `unknown workspace`; removing the default refused as
  `default_replacement_required` with nothing removed; a replacement that is not another of the project's folders
  refused as `unknown_folder`; the same request naming a real folder succeeding and leaving **it** the default; a
  replacement named while unlinking a non-default folder refused as `unexpected_replacement`; an origin that does not
  serve the project's host, a foreign folder and an unknown project each refused with the backend's own code; and the
  last folder's removal answering `project: null` with the project gone from the list, every root retained and the
  directory still on disk.
- `apps/server/test/project.test.ts` — `a project's last folder removes the project and its binding is what comes back
  after a restart`: the unlinked root re-registered by the retained record after the gateway restarts bare, with the
  conversation still executing there.
- `apps/server/test/ssh-project.test.ts` — `an unlinked remote folder's binding survives the SSH gateway
  restarting` over a **real localhost `sshd`**: the non-default remote folder unlinked, the project's default and
  both directories untouched, and the retained record's profile id the only thing that can put the remote root back
  after the SSH gateway alone restarts — with the conversation executing there, the retained entry reporting the remote
  root, and the unlinked id refused as a new target.
- `apps/web/adapters/project-removal.test.mjs` — the adapter against a stand-in backend that records every request:
  the unlink reaching the backend's folder route with this origin's host, the replacement default riding the same call,
  and a refusal (`default_replacement_required`, `unknown_project`) forwarded with the backend's status, code and
  reason.

## Fixed by the final code review

One finding from the review of the merged effort is fixed in this ticket's own route.

| # | Finding | Trigger and impact | Fix |
| --- | --- | --- | --- |
| 1 | `DELETE /api/projects/:projectId/folders/:folderId` and `PATCH /api/projects/:id` took the calling origin's host from the request and refused the Project when it differed (`409 wrong_host`). A folder of a remote Project could therefore never be unlinked, nor its default changed, from the browser showing it — the browser half this ticket's own follow-up (ticket 09) delivers. | Both routes now resolve through `projectHostOf()` in `apps/server/src/server.ts`: the recorded Project's `hostId` is the identity the operation acts on, a named host may only confirm it, a different one stays `409 wrong_host` and an unconfigured one is `409 configuration_required`. `apps/web/adapters/durable-api.ts` stops naming a host on both routes. Regression: `apps/web/adapters/remote-project-removal.test.mjs`, which changes a remote Project's default and unlinks its folder through the adapter and asserts the retained binding, the untouched directory and the intact refusal for a caller naming another host. |

## Review notes

- **Recorded: the unlink route is backend-only until ticket 09.** Nothing in the browser calls
  `DELETE /api/projects/:id/folders/:folderId` yet, so the user-visible half of the demo path (a folder leaving the
  picker from its own control, and the replacement prompt) arrives with ticket 09. Trigger: none today — the route is
  reachable only through the adapter and the backend's own API. Impact: none on this ticket's contract, which is the
  backend effect read back through the backend's public answers. Revisit when ticket 09 wires the folder list.
- **Recorded: the replacement is named by folder id, not by root.** `defaultFolderId` is a folder row's id, which is
  what `PATCH /api/projects/:id` already takes, so the two default-related contracts speak one language. Trigger: a
  browser that holds only roots would have to map one to the other; the folder list it reads already carries both.
  Impact: none today. Revisit if a caller can hold a root without the project's own answer.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
