# Bug 21 — a project created after boot is not an installation target

**Status:** fixed on `impl/ux-follow-up-live-skill-target`, merged into `integration/ux-follow-up` as `4a243ae`, and the
focused recheck (ticket 21) is complete: **F1 SPEC PASS** at `5db97fc`. Ordinary current-project path, legacy root
preservation and the single local/SSH lookup are all re-verified (see the code review and `validation.md`).

The recheck of this seam found an adjacent material defect, **F2**, proven red/green and since fixed at source `d7cdff0`
(`impl/ux-follow-up-live-env-factory`) and merged as `bb3c4f7`: a deployment that starts with no configured workspace installs no harness `env`
factory, so a project created after boot has skills but no `read`/`write`/`edit`/`bash` until restart. See
`../../code-review.md` and `../validation.md`.

## Trigger

Create a project through the public `POST /api/projects` after the backend is already serving, then use the built-in
Skills panel for it (inventory, install, toggle, check, update) without restarting. The folder is registered on the
gateway at once and the project is listed, but every skill request naming that folder's `workspaceId` answers
`404 {"error":{"code":"not_found","message":"unknown workspace"}}`.

## Root cause

`apps/server/src/server.ts` built the installer once at start:

```ts
const installer = createInstaller({ workspaces: allBindings(), ... });
```

`allBindings()` **calls** the function and passes the array it returned. The installer then answered from
`options.workspaces.find(...)` — a list captured before any project existed. `POST /api/projects` pushes into the
live `projects` array (`server.ts:619`), so the record is real and `bindingOf`/`ensureBinding` resolve it for
conversations; only the installer kept the stale snapshot. The error is raised in `target()` before any host call.

This is the ownership boundary, not a caller problem: `bindingOf` already reads the live `projects` array on every
request, so the installer was the one consumer holding a copy instead of asking the owner.

## Fix

The installer takes the lookup, not a list — one dependency, no second registry and no state mirror:

- `InstallerOptions.workspaces` is now `() => readonly InstallBinding[]`, documented as read at request time.
- `bindingOf` calls it.
- `server.ts` passes `allBindings` (the function) instead of `allBindings()` (its value).

No snapshot guard is added after the `POST`, no per-endpoint fallback, and the configured workspaces are unchanged:
the live lookup only adds targets. One lookup serves both host kinds, because `folderBinding` resolves a project
folder to its gateway connection by `hostId` — a local project and an SSH project take the identical path.

## Regression

`apps/server/test/live-skill-target.test.ts` — a real backend, a real local gateway with a shared `WorkspaceRegistry`,
and the public HTTP endpoints. It publishes a bundle, creates a project after the server is listening, and then uses
**that** workspace for inventory, install, inventory, toggle, check, status and update, plus the boot-configured
workspace to prove the configured targets still answer. Red before the change (`404 unknown workspace` at the first
inventory), green after, in the same running backend with no restart.

The SSH path is the same lookup and is exercised by the existing `skill-install.test.ts` remote-host cases; no second
fixture was added because the fix is host-agnostic.
