# Advanced Web interactions — exploration

Scope: source read-only, evidence read at revision `68c2fb2` (that commit touched docs and test reports only; the tree holds no other change besides this untracked directory). Primary graph `graphify-out/graph.json` queried narrowly per discovery question, then confirmed in source. No product edits, tests, builds, deploys, graph rebuilds or paid calls. Subagent UX belongs to the sibling reports; only shared data is noted.

## Confirmed current state

| Interaction | Source-backed state | Owning module |
| --- | --- | --- |
| Session export | Toolbar control exists and is enabled for any selected session: `handleViewFullHistory` opens `/api/sessions/<id>/export?inline=1` (`apps/web/components/AppShell.tsx:1272`, button `:1542`, label `history.full`). The adapter's GET `sessions/<id>/...` branch (`apps/web/adapters/durable-api.ts:508`) maps only `context`, entry read blocks and `state`; `export` falls to the generic `unsupported(...)` → 501 (`:798`). No export route exists in `apps/web/app` (only `app/api/[...path]/route.ts`); upstream 0.10.0's vendored `app/api/sessions/[id]/` has none either. Upstream's export read a pi session JSONL through `vendor/pi-web/lib/session-reader.ts` — a file the durable runtime does not have. | Web toolbar → adapter fallthrough; data would come from backend entry reads |
| Live file watch | Media viewers open an EventSource when `watchEnabled`: `ImageViewer` (`FileViewer.tsx:501`), `AudioViewer` (`:673`), `VideoViewer` (`:803`), `DocumentViewer` (`:983`); `AppShell.tsx:2657` passes `watchEnabled={rightPanelOpen}`. The badge shows `live`/`static` from `i18n.liveSync`/`notWatching`. `apps/web/adapters/workbench.ts:347` answers 501 `type=watch`; `docs/workbench.md:132` states it. The text viewer does not watch (manual `refreshKey`). | Web viewer → workbench adapter; no gateway producer |
| Fork from a message | Delivered: per-user-message button (`MessageView.tsx:415,677` → `ChatWindow` `handleFork`, `forkingEntryId`) reaches `POST /api/sessions/[id]/fork` (`durable-api.ts:548`) or the `fork`/`fork_branch` agent command (`:614`) → backend `POST /api/conversations/:id/fork` (`apps/server/src/server.ts:1795`) → pi-durable `Conversation.fork(entryId)`. Named refusals `not_found/unsaved/empty/subagent` (`FORK_REFUSALS`). | Backend fork route; Web MessageView/ChatWindow |
| Edit-from-here | Absent, not stubbed: no `onEdit`/`editMessage`/`handleEdit` anywhere in `MessageView.tsx`/`ChatWindow.tsx`; the prompt's own copy action remains (`copyContent`, `:489`). | retired (README, ticket 09) |
| Message-level branch tree | Not derivable: pi-durable's `EntryRecord` (`dist/types.d.ts:274`) carries `id, conversationId, kind, model, data, head, edits, byTaskId` — no parent/branch link — and the view exposes the **active** transcript only. Ancestry exists at conversation level: `ConversationRecord.parent {conversationId, at}` (`:250`), surfaced as `parentConversationId` in the catalogue row (`server.ts:1041`) and mapped by the adapter to `parentSessionId` + `relation.kind:"fork"` (`durable-api.ts:128`), with `subagentParentConversationId` → `relation.kind:"subagent"` (`:133`). | Catalogue row + `apps/web/lib/session-family.ts` |
| Fork/subagent family navigation | `listSessionFamilies` (`session-family.ts:52`) groups only **subagent** descendants under a root; a fork is a root, so forks stay top-level rows (documented in `apps/web/README.md`). A source edge and fork children are already on the wire. | `apps/web/lib/session-tree.ts` + SessionSidebar |
| Long-history search | Delivered end-to-end: `GET /api/search` (`server.ts:1577`, no index, `apps/server/src/session-search.ts` matcher, `SearchQueryTooLong` → 400) → adapter `sessions/search` (`durable-api.ts:448`) → `apps/web/components/SessionSearch.tsx`; hit navigation via `searchTarget` (`AppShell.tsx:297,892`) and `pendingSearchScroll`/`searchBlock`. | server search + SessionSearch + AppShell |
| Long-history navigation (minimap) | `revealHistoryForMinimap` (`ChatWindow.tsx:1056`) resolves only among turns the window already draws (`setRevealTurnKey`); a turn outside the loaded window has no key and nothing happens — the recorded limit in `docs/migration-status.md`. | ChatWindow + `packages/session` window/prefix rules |
| Extension dialogs/widgets | No producer anywhere: pi-durable 1.1.0 extensions declare `tools, sections, hooks, wraps, tasks` only (README "Extensions"); `dist/` has no dialog/widget/attention API; `packages/protocol/src/index.ts` carries `extensions: readonly string[]` (`:216`) only. Client leftovers: `useAgentSession.ts:457` holds `extensionWidgets`, written from `liveState.extensionWidgets`/`agentState.state.extensionWidgets` (`:914`, `:2123`) that nothing emits, and `ExtensionStatusBar` is mounted at `ChatWindow.tsx:1560` and renders nothing. pi-coding-agent 1.2.0 ships only `dist/extensions/{codemode,llama,mcp,tool-search}` — no UI API to adopt either. | dead state + bar; ticket 09 retired the vendored queue |

## Native constraints (do not assume capability)

- pi-durable 1.1.0 has **no** extension UI surface, **no** session-file/export concept, **no** file-watch capability, and **no** per-entry branch pointer. Its write surfaces are tools, sections, hooks, wraps, tasks, docs, entries, `fork`, `reset`, `compact` and `ContextEdit` (`EntryRecord.edits`: omit/replace an entry's *model context*, display untouched).
- The gateway's file surface is request/response (`FilesystemServer.execute(FileRequest)`, `packages/gateway/src/filesystem.ts:38`) behind POST `/v1/{execute,workbench,files,installs,abort,workspaces,worktrees,mcp}` (`packages/gateway/src/index.ts:527`). The only push channel is terminal SSE (`/v1/terminal/events`, `:977`) with the relay precedent in `apps/web/adapters/terminal.ts` → `apps/server/src/server.ts` → browser, including `id:` cursors and heartbeat bounds.
- Read primitives an export or jump would use already exist and are bounded: `GET .../state`, `GET .../entries?before=&tail=`, `GET .../entries/:id`, `.../thinking`, `.../text`, `.../tool-result-image` — all resolved through the conversation's fork-aware history.

## Ranked deliveries

| # | Delivery | Size | Data semantics | Compatibility | Verification seam |
| --- | --- | --- | --- | --- | --- |
| A | Make the dead affordances honest: state the limit on export (or hide the button), stop advertising `live` for watch | tiny | none | none; keeps the 501 contract | `apps/web/e2e/ux-truthfulness.mjs`, adapter tests |
| B | Session export / read-only full-history document from committed entries (backend route; page the active range and reuse the read blocks) | medium | active range only (compaction-dropped entries excluded), fork ancestors included, thinking signature dropped, images only where the image policy serves them; a tombstoned or task-owned conversation needs a stated rule | new backend route; the client's existing URL/shape can be kept so the toolbar control starts working | new `apps/server/test` case beside `history-text.test.ts`; e2e `ux-deferred-text.mjs` fixture already drives read blocks |
| C | Fork-family navigation over `parentConversationId` (open the source from a fork; optional "forks of this session" list) without changing top-level grouping | small–medium | the catalogue edge is the only ancestry; no message-level branches | keeps documented top-level rows | `apps/web/adapters/session-fork.test.mjs`, e2e `ux-session-fork.mjs` |
| D | Jump to an unloaded entry: backend `entries?around=<id>` window read + minimap/search reveal outside the window | medium | must obey the same head-marker, count and byte rules as `before`; one read instead of a client paging loop | additive query parameter | `apps/server/test/history-window.test.ts`, e2e `ux-windowed-transcript.mjs`, `ux-visible-turns.mjs` |
| E | Live file watch: gateway watch capability + SSE fan-in mirroring terminal (SSH hosts keep `not_supported`) | large | per-file bytes; invalidation from the host that owns the file; must interact with the adapter's 5 s listing cache and the reader TTL | new gateway route + relay; browser EventSource contract unchanged | gateway tests + `apps/server/test/file-relay.test.ts` + e2e `files-transfer.mjs` |
| F | Delete the dead `extensionWidgets` state and `ExtensionStatusBar`; keep the vendored queue retired | tiny | none | removal only | typecheck + `ux-extensions-panel.mjs` |

## Explicit unknowns

- Whether anything but the toolbar control reaches the export URL (no other caller found; a saved link is possible).
- Whether any deployment renders extension status outside these repos (source shows none).
- How often search or minimap targets land outside the window — source cannot say; use evidence decides D.
- Whether another host capability could carry a watch loop for non-SSH hosts — not inventoried.
- Whether export output must be stable for external consumers (none found).

Ranking rationale: A removes a lie now; B is highest-value because a visible control fails today and every read it needs is bounded, projected and tested; C is cheap but changes navigation, so it waits on the subagent reports' row model (both would consume the same catalogue ancestry); D is valuable exactly when search hits land outside the window; E is the only one needing new host capability, its honest alternative being A; F is cleanup, not an interaction.

## User decisions (≤5)

1. Export: HTML print view, or a Markdown "copy full transcript"? Which scope is the transcript — active range only, and are fork-inherited ancestor entries included?
2. Watch: build the gateway watch channel, or remove the `live` affordance and state the limit where the badge sits?
3. Fork navigation: keep forks top-level and add only "open source"/"forks" affordances, or make the sidebar a fork tree (contradicts the documented behaviour)?
4. Edit-from-here: accept "fork here + prefill the composer from this prompt" as the substitute, or fund a native `ContextEdit` route (changes only what the model sees, not what is displayed)?
5. Long-history jump: add the backend `around` read, accept a client paging loop, or keep the recorded limit?

## Recommendation

Do A and F now (no design needed). Deliver **B (session export)** first: the toolbar's "view full history" is a live control that answers 501 today, the backend already pages and projects the fork-aware active range, and the work is one route plus a document shape with clear refusals. Then D if search hits outside the window prove common, C after the subagent row model is settled, and E last or not at all — a stated limit is better than a dead `live` badge.
