# Full-history conversation navigation

Status: delivered — tickets 01–05 are implemented, integrated and accepted on this line; ticket 05's thirteen-row
matrix and 82 browser checks were re-measured on the integrated tree at `a0caf5d`. See
[ticket proposal](ticket-proposal.md) and [ticket 05](issues/05-system-acceptance.md).
Labels: ready-for-agent, navigation, history
Date: 2026-10-17

## Goal

The right-side conversation history rail shows one stable node per user message across the conversation's complete fork-aware committed history. A user can jump to a user message outside the loaded transcript window without loading or animating through every intervening node.

This spec covers navigation identity, paged outline delivery, bounded target reads, transcript integration, and browser acceptance. It does not cover session export, provider auth, push notifications, or file watching.

## Decisions

1. **User-message anchors.** Each committed user message is one navigation node. Assistant/tool grouping and visual `TurnDescription` boundaries do not define node identity.
2. **Raw history survives compaction.** The navigation source is the conversation's fork-aware committed history, not only the active context window. Compaction may change model context projection, but must not remove committed user-message anchors from navigation. A compacted anchor remains navigable through a bounded historical read.
3. **Forks preserve history.** A fork sees inherited user-message anchors in its own conversation coordinate. Shared entry IDs are not treated as globally unique; every navigation request is scoped to conversation identity plus history snapshot/version.
4. **Stable coordinate.** Jump identity is an opaque server-issued coordinate containing conversation scope, history snapshot/version, and user entry identity. Ordinal/cursor values order pages only and are never used as identity.
5. **Paged outline.** The full anchor list is delivered in bounded pages with short user-message previews. One unbounded index response is forbidden.
6. **Bounded target read.** Jumping requests a bounded window around the target anchor. The response is merged through the existing history owner or a clearly separate historical-view owner; it must not hydrate all preceding anchors into the transcript.
7. **Animation does not drive loading.** Navigation first obtains the target window and commits its layout. Smooth scrolling starts only after target DOM exists. During smooth scrolling, no intermediate minimap node may trigger a page request, no scroll position may cause sequential older-page loading, and no request is issued for nodes crossed by the animation.
8. **Exact search remains distinct.** Search may target assistant/tool blocks and land inside the target historical window. It does not create extra rail nodes. A deep result outside the loaded window resolves through the same bounded target coordinator as a rail jump: one target read, exact block placement, no sequential older-page loading.
9. **Missing/invalid targets are explicit.** A target removed, invalidated by a history reset, outside the requested scope, or cancelled by a conversation switch returns a named outcome: `stale`, `missing`, `cancelled`, `deferred-busy` or read `error`. The UI never silently lands on a nearby message, and never reports a failed locate as handled.
10. **Assistant-only prefix.** Assistant-only content before the first user message is represented by an explicit non-user prefix state, not a fabricated user anchor or positional ID.

## Required behavior

- Opening a long conversation loads only the normal bounded transcript window plus a bounded first outline page.
- Scrolling the rail or requesting more outline entries loads outline pages only; it does not load transcript bodies.
- Clicking any loaded or unloaded user node loads at most the target window budget, mounts only the target vicinity and normal overscan, and aligns the target user message after layout.
- A smooth jump has one target request and one target settlement. Its intermediate scroll events are presentation-only.
- A deep search result uses that same coordinator and settlement: one bounded target read for the exact block, then presentation-only scrolling. A lookup that fails, is cancelled or is deferred while the session is busy surfaces its named outcome with retry, rather than clearing the pending target silently.
- Appending messages refreshes or extends the current outline without changing existing anchor identities.
- Compaction changes active context facts but retains committed anchors and allows navigation to a compacted user message through historical content.
- Fork navigation includes inherited anchors in native history order and adds branch-local user messages at their committed positions.
- A target from another conversation, another fork scope, or an invalidated snapshot is refused rather than guessed.

## Non-goals

- Fetching the entire transcript or all message bodies to build the rail.
- Persisting rendered heights or claiming exact pixel positions for unloaded messages.
- Mounting every turn between current position and target.
- Making ordinal positions durable jump identities.
- Changing compaction semantics, fork ownership, raw history storage, or search result semantics.

## Proposed public seams

Names are provisional until ticket 01 confirms ownership and wire shape.

- `GET /api/conversations/:id/navigation?cursor=&limit=` on Backend returns bounded user-anchor pages, snapshot identity, short previews, ordering cursor, and `hasMore`.
- `GET /api/conversations/:id/navigation/around?anchor=&before=&after=` on Backend returns a bounded historical target window from the same snapshot, including target identity, exact entry block identity for search, and continuation/staleness facts.
- The client ingress relays both routes to Backend without reconstructing history; Web and App reach them through that ingress, and no separate BFF owns or rewrites the payload.
- `useAgentSession` or a dedicated historical-navigation owner stores outline pages and target windows; existing active-context prefix rules remain unchanged. The same owner serves rail jumps and deep search results.
- `ChatMinimap` consumes anchor metadata instead of deriving the complete rail from measured loaded DOM. Measured DOM remains responsible for local assistant/heading navigation.

## Acceptance

- Backend index pages are bounded, ordered, fork-aware, contain only user-message anchors, preserve short previews, never repeat cursors, and retain anchors after compaction.
- Backend target reads return a bounded window around a compacted and an inherited user anchor, reject wrong-scope/stale coordinates explicitly, and never require a full-history response.
- A history append during paging cannot reorder or duplicate anchors within a snapshot; a changed snapshot causes refresh or named stale handling.
- Web unit tests prove an unloaded anchor and a deep search result each cause one target-window request, not a loop over every preceding page, that animation emits no intermediate load requests, and that stale/missing/cancelled/busy/error outcomes each render a named state with no silent handled path.
- Browser acceptance uses a conversation longer than the active window, a compacted earlier user message, and a fork with inherited history. Rail nodes remain bounded in DOM, target lands correctly, and no silent no-op occurs.
- `git diff --check`, relevant package checks, focused server/Web tests, and browser acceptance are recorded with revision, exit code, and logs.

## Open implementation detail

Ticket 01 must choose whether the historical target window reuses raw `conversation-read` blocks or adds a projected entry window. The choice must preserve committed user text after compaction, bounded output, UTF-8 limits, fork visibility, and a clear rendering contract. This is the remaining technical choice, not permission to weaken the decisions above.


## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. Web/App reach it through the client ingress to Backend; it does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance integrate through the main full-stack rewrite spec and ticket breakdown (`.scratch/client-app/spec.md`); overlapping work belongs to the owning main ticket rather than a duplicate implementation. Cross-effort map: `../ux-closeout-research/spec.md`.

