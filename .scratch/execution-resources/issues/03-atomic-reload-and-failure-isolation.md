# 03: Atomic Reload, durable recovery, and isolated notifications

**What to build:**
Explicit UI Reload action that rediscovers and parses candidate resources, committing the new loading result atomically only on full success. Changes apply to the next run without altering an active run mid-flight. Failures retain the previous prefix and show error notifications without bringing down the service.

**Copy / Borrow from:**
- Durable State: `apps/server/src/server.ts` (`WorkspaceDoc` pattern).
- Notifications & Error Wire: `apps/web/vendor/pi-web/lib/agent-event-wire.ts` and `apps/web/hooks/useAgentSession.ts`.

**Blocked by:** 02: Prompts and context use the same execution-side loader

**Status:** complete

- [x] Explicit Reload endpoint and UI action triggers candidate discovery and parsing.
- [x] Fully successful reload replaces adopted prefix and catalog atomically; in-flight runs keep their prefix until next run.
- [x] Partial or total failure retains previous prefix and catalog, returning an explicit error.
- [x] UI displays an actionable notification upon Reload failure; unaffected conversations remain functional.
- [x] Server restart restores committed prefix without triggering implicit Reload or changing prompt context.

## Implementation

- **Adoption schema (usable by 06/07).** `WorkspaceResourcesDoc` is now version 2 and holds
  `{ adopted?, candidate?, deferredForRun? }`. `adopted` is the promoted baseline; `candidate` is a complete loading
  result committed while a run was active; `deferredForRun` is that run's `pi.live.run.inputs[0]`, which stays fixed
  across one run's generations, retries, steering and tool rounds. Version 1 (`{ state }`) migrates to `{ adopted }`.
- **Public reload helpers.** `reloadResources(conversation, resources, env, context)` discovers a complete candidate
  outside the transaction, then commits it in one transaction that also reads run status: idle promotes it at once, an
  active run keeps its baseline and the candidate is deferred, and a candidate deferred for an earlier run is promoted
  before the newer one is recorded, so repeated reloads inside one run never revert to an earlier result. A discovery
  failure throws before any commit. `readEffectiveResources` is the render/expand/commands read;
  `resourceSummary(read, conversationId, context)` is the client-safe `{ status, skills, prompts, loadedAtMs, pending }`.
- **Endpoint.** `POST /api/conversations/:id/reload` returns 200 with the committed summary or 500 with the error and
  the unchanged summary. The summary also rides on the existing conversation state snapshot and SSE `state` event (no
  second event bus), so a reconnect sees the adopted catalog and a pending candidate.
- **UI.** `apps/web/adapters/durable-api.ts` forwards `type: "reload"` to that endpoint; a failure throws
  `DurableBackendError`, which `useAgentSession` already routes through the shared error notice, so the conversation
  keeps its prefix. The success notice reports the skill/prompt counts, and a deferred reload says it applies to the
  next run.
- **Isolation.** A failed reload commits nothing; the conversation list, another conversation and a retry all keep
  working, and the retained prefix is replayed on the next run.

## Evidence

`pnpm -r typecheck` and `pnpm -r test` pass (apps/server 59 passed, packages/gateway/protocol/session unchanged).
Red-then-green: with only `apps/server/src/*` stashed, the new server cases fail
("the state snapshot carries committed resource state") and pass with the implementation.

New server cases in `apps/server/test/workspace-resources.test.ts` (authenticated HTTP/SSE through a real local gateway
and a temporary execution account home distinct from the harness home, with a deterministic provider gate that holds a
run open on a promise — no sleeps):
- an explicit reload adopting a complete candidate, repeated idle reloads, and the next run using the newest catalog;
- two reloads during one held run: the in-flight request, a steer and the run's later rounds keep the adopted baseline,
  and the next run promotes the latest candidate rather than the earlier one or the initial state;
- a failed reload retaining the previous prefix and catalog, answering 500, keeping another conversation and a retry
  healthy;
- a reload racing a run start: the reload is never lost, the run's prefix is one complete catalog, and the next run sees
  the newest host content;
- restart replaying a candidate committed before the restart without rediscovering the host;
- a version-1 document migrating to `adopted`;
- the retired ticket-01 kind: a pure `migrateLegacySkillsState` case (exact prefix, skills, host identity, no prompts
  or context) and an HTTP/SSE restart case that writes `hepi.workspace-skills` through the durable harness, disconnects
  the execution host, reconnects it elsewhere with a changed catalog, and asserts the committed prefix and catalog are
  replayed (commands, state snapshot, SSE frame) until an explicit Reload adopts the changed host — including an
  unreachable host failing that Reload without changing the adopted catalog.

Web: `apps/web/adapters/durable-api.test.mjs` (the reload command reaches the backend endpoint; a failure surfaces as
`DurableBackendError`) and a `useAgentSession` case (committed summary, deferred message, shared error notice);
`node --test hooks/useAgentSession.test.mjs adapters/durable-api.test.mjs` passes (48).

## Follow-up (durability gap)

Ticket 01 committed skills alone under `hepi.workspace-skills` (version 1), a different kind from
`hepi.workspace-resources`, so no document migration could cross between them and a restored conversation silently
re-adopted on its next run. That is now a one-time mapping (`LegacyWorkspaceSkillsDoc` + `migrateLegacySkillsState`):
pure, no host read, exact committed prefix, skills as the whole catalog, host identity retained, no context or prompts
(that kind had none); the next run persists it under the current kind. A failed retired result carries over unchanged and
retries as before. Nothing writes the retired kind and no URI, tool or runtime path reads it as a live source.

## Limits

- The UI reload command is the existing built-in slash command; no new panel. A deferred reload's notice states the
  change applies to the next run.
- `resourceSummary` counts skills and prompts; it does not expose catalog names or paths, which the commands endpoint
  already provides.
- Live SSH reload behaviour is ticket 04's target-identity work; these tests use the local gateway.
