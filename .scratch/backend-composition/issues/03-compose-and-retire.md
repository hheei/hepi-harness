# Backend composition and route integration

Type: implementation
Status: resolved — implementation `4197c3e6`, integrated `8f19a31b` (identical tree); independent review: no material findings
Blocked by: [02 Domain handlers](02-domain-handlers.md), [02 Project operations](../../workspace-registry/issues/02-project-routes.md), [01 Backend locality verdict](../../ingress-binding/issues/01-backend-locality-verdict.md)
Baseline: 5ec7ffe6 (design source baseline)
Spec: [design contract](../spec.md)

## File ownership and conflict boundary

Files: `apps/server/src/server.ts` composition and project route integration. Final Backend owner consumes registry and ingress route changes; no parallel edits to this file.

## Goal

Keep `createBackendServer(options)` and `BackendServer` public contract. Compose concrete modules in existing startup order; integrate registry-owned project/workspace handlers; preserve safe outer error and unknown-route behavior. Remove superseded closure state and redundant private/source-extraction tests only after equivalent admitted coverage.

## Acceptance

- [x] **BC1–BC5**: route inventory diff against `d857e291` shows the same path predicates and method gates; no route was added or dropped. Statuses, body limits, safe refusals, stream backpressure and admission order are unchanged; the 404 `{code:"not_found"}` answer from `8a1ef5bc` is preserved and asserted.
- [x] **Interface ownership**: a representative route change now touches its owner and one composition line. `docs/architecture.md` and `docs/developer-guide.md` state the delivered owners; no registry, generic router or context bag was added.
- [x] **Verification**: changed verification plus focused stream/recovery and ordinary admitted HTTP integration tests; recorded below with command, revision, dirty state, exit code and log path.
- [x] Owning current guides updated; the moved closure state was removed without aliases or fallback paths.

## Implementation and evidence

Independent review by agent-292 of `d857e291..4197c3e6`: standards and spec have no material findings. Reviewed extracted handlers, catalogue callers, composition order, admission, safe errors, unknown-route fallback and host lost-answer semantics. Confirmed integration `8f19a31b` has identical tree; `git diff --check` passed. Source-based review reused clean implementation verification and 110/110 focused journeys; no additional tests run.

Delivered `4197c3e6` on `impl/backend-composition-final`, branched from the integrated `d857e291` (`impl/architecture-consolidation` with Ingress01 merged).

- `conversation-catalogue.ts` — the one catalogue row projection (`entry` plus the list-wide `facts`), read by the list, the running poll, a search hit, the fork answer and the subagent catalogue row. The type and its documentation moved out of `server.ts`.
- `conversation-catalogue-http.ts` — `GET /api/conversations` (filters, paging, list version, `running=compact`), `GET /api/search`, `POST /api/conversations` (target check, re-registration, relation validation, creation commit, attach, row answer).
- `project-http.ts` — `GET /api/projects`, `POST/PATCH/DELETE /api/projects…`, the folder unlink path, `POST /api/worktrees`, `POST /api/workbench` and `GET /api/host/directories`. Routes decode and encode; `project-registry.ts` performs host work, store writes, retained bindings and the publication revision.
- `extensions-http.ts` — `/api/extensions` and `/api/skill-market/*`, with the installer, market and default-selection wiring the closure held.
- `project-registry.ts` — `hostCall` and `workbench` join the registry, so host browsing and the read-only workbench proxy reuse one origin join, bearer header and lost-answer classification instead of a second client.
- `server.ts` — 1343 → 868 lines; keeps composition, admission, the fixed dispatch order, the outer safe error answer and the final unknown-route fallback. The project view projection, host resolution helpers, catalogue facts/entry and skill-market dispatch left the closure with no aliases.

Verification at clean `4197c3e69efc647b392c3109bf178b2236becff3`:

- `pnpm verify:changed --base=e6a0ffd2` — exit 0. `changed-typecheck` 0, `changed-test` 0 (server 378/378, gateway 183/183), `web-unit` 0, `check-docs` 0 (463 Markdown files, no broken links). Report `.dev/verify/2026-10-22T02-34-18-905-verify-changed/verify.json` (sha `4197c3e6`, `dirty: false`); raw log `.dev/verify/2026-10-22-backend-composition-final/verify-changed-clean.log`.
- Focused stream/recovery and admitted project/worktree journeys: `node --test test/conversation-heartbeat.test.ts test/delta-frames.test.ts test/conversation-navigation.test.ts test/acceptance-multisession.test.ts test/acceptance-recovery.test.ts test/subagents.test.ts test/subagent-reports.test.ts test/web-delegate.test.ts test/project.test.ts test/ssh-project.test.ts test/worktree-picker.test.ts test/catalogue-binding.test.ts test/workspace-locality.test.ts test/http-dispatch.test.ts` — exit 0, 110/110. Log `.dev/verify/2026-10-22-backend-composition-final/focused-journeys.log`.
- Composition proof: `apps/server/test/http-dispatch.test.ts` drives the real admitted entry — unauthenticated 401 for owned and unowned paths, the entry's own `404 {code:"not_found"}` for paths no owner claims, a module's own 405, the catalogue's own 400 page-bound refusals, the registry's own `configuration_required`/`unknown_workspace` outcomes through `project-http.ts`, and one row answered by the shared projection.

Known limit, unchanged and pre-existing: `mcp-conversation-tools.test.ts` is not part of the server test script and fails identically on the `e6a0ffd2` baseline because `packages/gateway/test/fixtures/mcp/stdio-server.mjs` was deleted by `a57100bb`; successful MCP execution therefore remains unverified, as recorded in ticket 02.

## Scope boundaries

Follow shared [design and acceptance requirements](../../non-ui-architecture-design/requirements.md). Preserve shipped behavior unless spec names a replacement. Use ordinary admitted workflows; never design tests/probes that bypass auth, authorization, preflight or safety boundaries.
