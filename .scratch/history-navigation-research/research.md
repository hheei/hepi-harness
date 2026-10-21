# Research: full-history navigation and precise jumps

**Status:** historical evidence; the "research only, no implementation authorization" status is superseded by [spec.md](spec.md) and [ticket-proposal.md](ticket-proposal.md). Findings below describe the earlier baseline and are preserved as evidence, including the now-settled BFF-era file references.  
**Source revision:** `848f391b4245070b6677704d6a64e2a0d7356996` (dirty worktree; source code unchanged for this research)

## User problem

The right-side conversation history navigation should outline the full conversation, not only blocks already loaded into the transcript, and should support precise jumps to ranges/turns outside the current loaded window.

## Findings

### Current behavior

- `apps/web/components/ChatMinimap.tsx` builds nodes by measuring currently available messages and their rendered elements. Unloaded turns have no `TurnInfo`, anchor, or measured scroll position. Node placement is ordinal among this loaded set, not based on full-history coordinates. Assistant previews and heading jumps also require measured elements.
- `apps/web/components/ChatWindow.tsx` resolves minimap anchor IDs only against loaded `turnModel.turns` and `entryIds`. If resolution fails, no reveal key is set, so the callback becomes a no-op. `useTranscriptWindow` can mount an out-of-viewport turn only after that turn exists in the loaded turn model.
- `apps/web/hooks/useAgentSession.ts` owns the bounded loaded prefix and exposes `loadContext(sid, leafId, before, options)`. This reads older pages only. Search already loops through this API to locate an unloaded result; the minimap does not have an equivalent way to identify or load an unloaded target.
- `apps/server/src/server.ts` exposes a bounded active-range suffix and `GET /entries?before=&tail=`. `pageEntries` slices the runtime's native active order using an exclusive entry-ID cursor. Pages carry `oldestEntryId` and `hasMore`, but not `historyHead`. `GET /read` is a different, line-oriented raw-history interface; it does not provide turn coordinates or a navigation outline.
- `apps/server/src/history-window.ts` defines existing bounded projection and history facts. `packages/session/src/index.ts` owns prefix retention by stable entry identity and head/range facts. Any new outline/read must preserve those ownership boundaries and fork-aware identity semantics.

### Why precise unloaded jumps fail

There are two separate missing capabilities: the rail has no server-published coordinate/outline for turns outside the loaded prefix, and the receiving transcript can resolve/reveal only an ID already loaded into its turn model. The minimap's pending-navigation mechanism waits for a rendered element, so it handles loaded-but-unmounted turns, not unloaded turns.

The navigation surface also needs an explicit meaning for unloaded ranges. An ordinal among loaded nodes cannot truthfully represent the full conversation's relative position, while exact vertical pixel positions cannot be known without rendered heights (which vary with content, expansion, and deferred blocks).

### Runtime and consistency constraints

- The current page cursor is an entry ID in native active-range order, not an absolute ordinal. Compaction can remove an ID. Worker investigation reports that querying `before` with a compaction-dropped ID and with an ID unknown to that conversation currently yields the same empty result, so a client paging loop cannot infer which case occurred.
- Worker source inspection found no native `around`, count, or turn-index API in the installed runtime. Entry IDs are inherited by forks; coordinates must be scoped to the conversation/history revision, not treated as globally unique turn positions.
- `historyHead` and `historyRevision` describe re-baselining of the active range. The current `/entries` page does not state the head it was read against. An outline/page must define staleness and behavior if compaction or append changes the range mid-navigation.
- A complete list is not necessarily bounded: the worker measured a projected index at 8,000 turns exceeding the existing 512 KiB frame target. These probe values are worker-reported read-only measurements, not independently reproduced in this coordinator session. They support investigating paged outline/index delivery rather than assuming one unbounded response is acceptable.
- Turns are presentation constructs. The minimap's anchor enumeration and `buildTurnModel` can differ for leading mid-turn segments. Preserve stable entry identity; do not equate list position, anchor count, and rendered turn count without defining which one the rail represents.

## Open design decisions

1. What should the rail promise for unloaded content: a proportional outline with approximate turn positions, stable anchor markers, or only loaded-range navigation plus explicit gaps?
2. What is the canonical coordinate: `(conversationId, historyRevision, historyHead, entryId)`, or another opaque server-owned cursor? Can a coordinate survive append, and what invalidates it after compaction?
3. Where should lookup happen: additive server-side `around=<entryId>` bounded window, or a paged lightweight outline/index followed by existing `before` page reads? Both remain options; neither is selected here.
4. What does the outline count: user/assistant turns, message-group anchors, or transcript `TurnDescription`s? How are tool-only/leading segments represented?
5. What should navigation report for a target removed by compaction, belonging to another fork branch, or no longer in the active range?
6. Does precise jump mean align target turn to viewport, reveal a bounded surrounding range, or support actual range selection? The visual/interaction contract needs to distinguish these.

## Candidate research/spec boundary

Next work should decide the public outline/coordinate contract and unloaded-range UX before implementation. Keep it focused on one end-to-end vertical slice: obtain stable full-range navigation identities, request a bounded target window, merge it through the existing history owner, and land the target without mounting intervening turns. Do not fetch the entire transcript, persist per-turn heights, or silently guess after compaction. Acceptance should cover long histories, append during navigation, compaction/rebaseline, fork-inherited entries, bounded mounted turns, and a browser jump to a known unloaded target.

The exact API, ordinal semantics, coordinate invalidation rules, and visual representation remain unresolved and require user/product decisions. Existing source/tests/docs inspected include `ChatMinimap.tsx`, `ChatWindow.tsx`, `transcript-window.ts`, `chat-turn-identity.ts`, `chat-turn-model.ts`, `useAgentSession.ts`, `durable-api.ts`, `apps/server/src/server.ts`, `history-window.ts`, `packages/session/src/index.ts`, `docs/chat.md`, `docs/migration-status.md`, `.scratch/perf-follow-up/issues/05-loaded-history-integration.md`, and `.scratch/webui-next-exploration/advanced-interactions.md`.

## Approved direction

The user approved using each user message as one navigation anchor. This is a design decision for the next spec, not implementation authorization.

- Each user message gets one navigation node. Node identity is the stable user-entry ID, scoped by conversation and history revision; ordinal cursors are for ordering/display only, never jump identity.
- The navigation index is paged and returns user-message anchors plus short previews. It represents fork-aware committed history, while snapshot/revision changes control ordering and staleness handling.
- Jumping to an unloaded anchor requests a bounded window around that user entry, then merges through the existing loaded-history owner and transcript virtualization. It must not mount every intervening turn.
- Search remains more precise than the navigation rail: it may target assistant or tool blocks inside a user-anchored turn without creating extra rail nodes.
- Assistant-only leading content needs an explicit first-range treatment in the next spec; it must not silently acquire an unstable positional identity.
- Fork-inherited user entries retain their entry identity but remain scoped to the fork's conversation/history coordinate.

This direction is preferred because user messages are stable semantic landmarks, reduce index size and minimap density, and avoid coupling navigation identity to presentation-level assistant/tool grouping.


## Related prior evidence

- `.scratch/perf-follow-up/issues/05-loaded-history-integration.md` closed search/fork/prefix behavior but left minimap paging unresolved; its accepted note says the minimap needs a decision for turns outside its loaded data.
- `docs/migration-status.md` records the same limitation.
- `.scratch/webui-next-exploration/advanced-interactions.md` previously ranked unloaded-entry jump as option D and left frequency of out-of-window targets unknown. User report in this session establishes a concrete usability need; usage frequency remains unmeasured.
- Worker agent-178 supplied source-level analysis and read-only probe results summarized above. No files were edited by that worker; coordinator did not rerun its temporary-store probes.

