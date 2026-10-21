# Bug 22 — a zero-config deployment never installs its execution tools

**Status:** fixed and merged — source `d7cdff0` on `impl/ux-follow-up-live-env-factory` (branched from integration `5db97fc`), merged into `integration/ux-follow-up` as `bb3c4f7`; ticket 21 rechecked it read-only (RED at `5db97fc`, GREEN on the merged source). Verified at the merged pin: server typecheck exit 0, `project.test.ts` 10/10, `live-skill-target.test.ts` 1/1, `apps/server` 131/131.

## Trigger

An ordinary zero-config start: a backend with configured gateways but no configured workspace (`HEPI_WORKSPACE_ID`
unset, so `main.ts` passes `workspaces: []`, or `createBackendServer` called with `{ gateways }` alone). Create a
project through the public `POST /api/projects`, make a conversation on its default folder, and send a prompt that
needs a tool. The turn settles with `[error] Tool read is not available` (or bash/edit/write alike) and the tool never
runs. The Skills panel works — ticket 21 fixed the installer — so the project looks registered and usable, but **no
conversation on it can execute anything** until the backend restarts with a workspace already configured.

`docs/projects.md:49` states the promise this breaks: "A deployment with no `HEPI_WORKSPACE_ID` can still create
projects." A project that cannot run a tool is not an ordinary execution target.

## Root cause

Not a hypothesis: a boot-time decision about the whole process, made from a list that is legitimately empty at boot.

`apps/server/src/server.ts` passed the environment factory only when the workspace list was non-empty **at construction
time**:

```ts
const runtime = await openServerHarness(dbPath, defaultModel, models, allBindings().length ? async (target, context) => {
  const stored = await target.read.snapshot(WorkspaceDoc, target.conversationId, context);
  const binding = await ensureBinding(stored?.workspaceId);
  return binding ? gatewayEnvironment(binding, target.cwd ?? "/") : undefined;
} : undefined, ...);
```

`allBindings()` is the live lookup (already fixed as a thunk in ticket 21 for the installer), but here it is **called**
and only its `.length` is read, once, before any project exists. With zero configured workspaces the expression is
falsy, so `undefined` is passed as `env`, and `apps/server/src/harness.ts:53` only registers the execution tools
`if (env)`:

```ts
if (env) registry.install({ ...CodingTools, tools: CodingTools.tools?.map(...) });
```

The registry is built once, at open. A project registered later is an ordinary target with a perfectly good live binding
— the lookup would answer — but the tools were never installed, so there is nothing to run. The emptiness of the
workspace list at boot was wrongly treated as a decision that this deployment never executes anything.

This is the same class as ticket 21 and the same seam: a boot-time snapshot standing in for a live set. But the symptom
is worse — there the installer could not find a target, here the target exists and has no tools.

## Fix

The factory is always installed, and it remains the authority for one request:

- `server.ts` passes the factory unconditionally; the `allBindings().length ? ... : undefined` gate is deleted.

No new registry, no dummy wrapper, no late extension hooks. The factory still resolves the conversation's own stored
`WorkspaceDoc.workspaceId` through `ensureBinding` and returns `gatewayEnvironment(binding, ...)` or `undefined` —
the identical function it already was, so:

- a conversation bound to `undefined` (or to a workspace no binding resolves) gets `undefined` — no environment, no
  host, no native local-host fallback and no redirect to another project's root;
- a conversation bound to a live project folder gets that folder's gateway, unchanged from before.

`workspaces: allBindings` for the installer (ticket 21), the project-`POST` path and the `GET /api/workspaces` path
are untouched. Ticket 21's guard was already removed on the base this branches from.

## Regression

`apps/server/test/project.test.ts` — "a project created on a zero-config deployment executes its tools without a
restart". It reuses the existing real-gateway fixture (`startGateway` + `startBackend` with `bindLegacy: false`, so
**zero** configured workspaces), then through the public HTTP API: creates the project, creates a conversation on its
default folder, and runs a turn whose scripted tool call is a real `read` of a marker file that exists only in the
chosen folder. The assertion is on the **tool result content** read back over the real gateway — the registered tool
actually executing in the bound folder — not a fixture environment object and not a catalog listing. The same test
then makes an unbound conversation run `bash` and asserts the tool result is an error and that neither the chosen nor
the legacy root holds the file it would have written, pinning the "unbound reaches no host" invariant.

Red before the change, on the same public API and assertions: `[error] Tool read is not available`. Green after.

## Not changed

The conditional in `openServerHarness` stays valid: it is `if (env)` for a supplied factory, and a caller with no
execution target is still a supported shape (the zero-config root baseline in `server.test.ts` keeps its expected
behaviour; the text turns there have no tools to call). The fix installs the factory upfront rather than deciding at
boot which kind of deployment this is.
