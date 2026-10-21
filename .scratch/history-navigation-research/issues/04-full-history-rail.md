# 04 - Full-history rail

Status: in-review — delivered on `impl/history-navigation-04` (branched at the integration tip `2c28d1c`), source commit
`7116eaf` plus this record at `3e2ac68`, and **integrated** by cherry-picking those three commits onto this line's tip
`2c28d1c` (the `client-app-integration` worktree's `main`), where the pick produced no conflict. Not pushed.
Blocked by: [01](./01-historical-anchor-contract.md) (resolved and integrated), [03](./03-navigation-jump-coordinator.md)
(delivered and integrated — its `reduceOutlinePages` is the paged-outline state this rail reads, and
`NavigationCoordinator.jump` is the seam a rail anchor calls)

Replace the rail's complete-history dependency on measured loaded DOM with paged user-anchor metadata and short previews. Keep local measured assistant/heading navigation for loaded content. Render unloaded nodes without pretending to know exact pixel heights; do not fabricate an identity for assistant-only prefix.

Acceptance: long history displays nodes beyond loaded window, previews remain bounded, nodes are ordered by server cursor, local loaded jumps still work, unloaded jump delegates once, smooth animation does not request crossed nodes, and a search result whose target is outside the loaded window shows the same named pending/failed state as a rail jump rather than a silent miss.

## Answer

Delivered on `impl/history-navigation-04`, branched at the integration tip `2c28d1c`; source commit **`7116eaf`**.
Ticket 03's coordinator, `useHistoryNavigation`, `landWindow`, the read-recovery panels, the model catalog capability
gate and the Web logout work are **consumed unchanged** — they are ticket 03's and the integration line's owners.

Delivered as `packages/ui/src/lib/history-rail.ts` (the one join rule, `buildRailNodes`, and `railPreview`),
`components/ChatMinimap.tsx` (the rail surface: nodes, dots, previews, the outline's own paging control), the minimal
`components/ChatWindow.tsx` wiring (one page on open, one page per activation, one coordinate per unloaded-node click,
and the rail's landing routed through ticket 03's settlement rule), and one message key per locale
(`chatMinimap.moreAnchors`).

**The join, stated once.** `buildRailNodes` takes the paged outline and the measured turns and returns ordered nodes. The
outline is the authority on *which* nodes exist and in what order (server cursor, never arrival order, never a node's
position); the measured transcript is the only source of pixel geometry. A node the transcript carries is **loaded** and
keeps its measured turn — every local user/assistant/heading jump is the code it was. A node it does not carry is
**unloaded**: identity, cursor, bounded preview, `turn: null`. No height is invented for it, its dot is hollow, and
`data-minimap-node-visible` is never set on one, because the rail has nothing to compare against a viewport.

**Two ordering rules the naive merge gets wrong.** A loaded turn the outline does not enumerate — the assistant-only
prefix, a compaction marker, a subagent report — is **not** a node once a page exists: ticket 01's anchor rule already
excluded it and this surface must not fabricate the identity spec decision 10 forbids. A loaded turn **newer** than the
newest listed anchor **is** a node: the reader's window sits at the tail, so a turn committed after the last page was
read is newer than that page, and dropping it would leave the rail's bottom edge behind the transcript.

**Acceptance, item by item.**

| ticket requirement | where it is answered | how it is proven |
| --- | --- | --- |
| long history displays nodes beyond the loaded window | `buildRailNodes` maps every outline anchor to a node whether or not the transcript measured it; `ChatMinimap` renders the derived list, not the measured one | unit "an outline lists nodes beyond the loaded window…" (4 anchor ids against 2 measured turns) and browser "the rail lists the first page and the measured tail past it" — 6 listed anchors + 3 measured tail turns against a transcript carrying only those 3 |
| previews remain bounded | the page's own 240-UTF-8-byte preview, plus `railPreview` clamping whatever a measured message states to `RAIL_PREVIEW_MAX_CHARS` | unit "a preview is bounded…" (over-long cut with its ellipsis, exactly-at-bound kept whole) and the browser reading the rendered row's length |
| nodes are ordered by the server cursor | `buildRailNodes` sorts by `cursor` alone, stable, with the measured tail appended in transcript order | unit "nodes are ordered by the server cursor, not by the measured list" (measured list handed over reversed) and the browser's ascending-entry-id check |
| local loaded jumps still work | `scrollToNode`/`scrollToAssistant`/`scrollToHeading` unchanged for a node whose `turn` is non-null; the focus moved from a node **index** to an **entry id** so a page arriving in front of the list cannot move it | unit "the rail is the measured transcript until an outline page arrives"; `apps/web/e2e/ux-visible-turns.mjs` still passes end to end (click, keyboard, streaming growth, resize); browser "clicking a loaded node scrolled to its measured turn" plus "issued no navigation request at all" |
| unloaded jump delegates once | `scrollToNode` calls `onJumpAnchor(anchor, entryId)` **only** when `turn === null`, and `ChatWindow.jumpToRailAnchor` calls `jumpNavigationAnchor` once | browser: "one click handed over exactly one coordinate" **and** "it asked for no outline page" (`outlineRequests() === 0`) — the shape a sequential walk would fail |
| smooth animation does not request crossed nodes | the rail issues nothing on the jump path; the surface's hold comes from ticket 03's `navigationHoldsViewport`, and `railLanding` is passed as the request so the gate is closed from the click until alignment ends | browser "the landing cost one request in total, with nothing issued for the nodes the viewport crossed (1)"; the sentinel gate itself is ticket 03's asserted case, re-run here |
| a deep search outside the window shows the same named pending/failed state as a rail jump | both requests settle through one `searchSettlementAction`; a rail failure is left standing for its own retry exactly as the shell's is, and `NavigationOutcomeBanner` renders it | `apps/web/e2e/ux-navigation-retry.mjs` re-run green on this tree (8/8: the production `ChatWindow` under `StrictMode`), plus ticket 03's 22 coordinator cases and 3 banner cases |
| no fabrication for an assistant-only prefix | the prefix turn is measured but not listed, because the outline is the authority once a page exists | unit "a measured turn the outline does not list is a node only when it is newer than the newest page" |
| one page on open, one per activation | `ChatWindow` reads the first page once per conversation; `ChatMinimap` offers one control per outstanding continuation and reads on activation, never on visibility | browser: "reaching for the rest of the history asked for exactly one page", "the page that answered it is listed… and listing it cost no further read", and "a failed page is a named state, not the end of the list" |

**Deliberate limits, recorded rather than guessed.**

- **One page on open is a page, not an index.** The rest of the history is behind the rail's own control, so the rail's
  list is bounded by what the reader asked for rather than by the history's length (spec decision 5).
- **No rail-side alignment of its own.** The landing, the reveal and `startScrollSettlement` are ticket 03's and
  `ChatWindow`'s; this ticket adds the rail's request to that path rather than a second one.
- **The rail's request is released by the gestures that end it, and by nothing else.** A landing hands the entry to the
  pending scroll and releases it; a failure **stays**, because the banner's Retry answers that very request; a
  conversation switch releases it, and dismissing the outcome releases it. A request left standing after the last two
  would read to `navigationHoldsViewport` as a navigation owing nothing, which gates the older-history sentinel for the
  rest of the session.
- **A measured tail newer than the outline is drawn, but not addressable.** Such a node carries `anchor: ""` and
  `loaded: true`, so its local measured jump works; it gains a coordinate when the outline pages it in. Deliberate — a
  client-minted coordinate would be a second address authority beside the Backend's.
- **The rail is not rendered on mobile or while a restore is pending**, exactly as before (`isMobile ||
  pendingScrollRestore` guard in `ChatWindow`). Widening that is not this ticket.
- **The rail browser scene mounts the production `ChatMinimap`, not the production `ChatWindow`.** `ChatWindow` cannot
  be mounted without a connection, a Backend and a conversation, so the scene proves the surface boundary the rail owns
  (what it lists, what a click hands over, how many reads it issues) against a fixture surface that stands in for the
  coordinator's owner; the `ChatWindow` wiring is typechecked and ticket 03's `ux-navigation-retry.mjs` exercises the
  production window. Ticket 05 owns the real-Backend journeys.
- **The evidence is not the system matrix.** Compaction, fork inheritance, an append during a navigation, stale
  coordinates and the deep-search journeys observed together are ticket 05's.

### Evidence

All rows were taken in this worktree at source commit `7116eaf` on top of `2c28d1c`; logs are under `.dev/verify/hn04/`
(browser/unit/focused runs). The selector row was re-run once more at the record commit `3e2ac68` with
`dirty: false` and the identical step results (`.dev/verify/2026-10-20T02-34-42-264-verify-changed/`); nothing under
`packages/` or `apps/` differs between `7116eaf` and `3e2ac68`, so the focused rows still describe the delivered
source.

| check | command | exit | result | log |
| --- | --- | --- | --- | --- |
| selector over the delivered tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=2c28d1c` | 1 | `changed-typecheck` **0** (5 packages); `changed-test` **0** — ui 344, app 26, gateway 166, server 346 = **882 pass / 0 fail**; `web-unit` **0** (14/14); `check-docs` **1** — the same 12 pre-existing broken `.scratch/…` links, 0 guides missing from the index | `.dev/verify/2026-10-20T02-34-42-264-verify-changed/` |
| the rail's own join rule | `node --test packages/ui/src/lib/history-rail.test.mjs` | 0 | 6 pass / 0 fail (fallback to the measured transcript, unloaded nodes with no geometry, server-cursor order, the newer-than-the-last-page tail rule, one node per entry across an outline refresh, the preview bound) | `.dev/verify/hn04/history-rail-unit.log` |
| the rail in a browser against the production component | `node apps/web/e2e/ux-history-rail.mjs` | 0 | 23 checks pass: 6 listed anchors + 3 measured tail nodes, unloaded dots never "visible", bounded preview (38 chars), **one** coordinate and **zero** page requests on an unloaded click, the landed node becoming loaded, the local measured jump unchanged and read-free, one read per "more", a named failed page that keeps the anchors it held and does not move the transcript, no page error | `.dev/verify/hn04/history-rail-browser.log` |
| ticket 03's coordinator and outline reducer, unchanged | `node --test packages/ui/src/lib/history-navigation.test.mjs` | 0 | 22 pass / 0 fail | `packages/ui` suite below |
| rendered outcome states, unchanged | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | 0 | 3 pass / 0 fail | same |
| the transcript's owner, unchanged | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | 0 | 26 pass / 0 fail | same |
| whole ui suite | `pnpm --filter @hepi/ui test` | 0 | **344 pass / 0 fail** | `.dev/verify/hn04/ui-suite.log` |
| ui/web typecheck | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | 0 · 0 | no diagnostics | `.dev/verify/hn04/ui-typecheck.log`, `…/web-typecheck.log` |
| the Web app's own build (the browser scene's host) | `pnpm --filter @hepi/web build` (Vite) | 0 | `✓ built in 1.03s`, third-party notice emitted | `.dev/verify/hn04/web-build.log` |
| ticket 03's failed-hit → Retry → landing scene, on this tree | `node apps/web/e2e/ux-navigation-retry.mjs` | 0 | PASS, 8/8 (production `ChatWindow` under `StrictMode`; one navigation read, 0 older-history reads during the settlement) | `.dev/verify/hn04/navigation-retry-browser.log` |
| the unchanged local navigation | `node apps/web/e2e/ux-visible-turns.mjs` | 0 | `UX-02 BROWSER CHECKS PASSED`, 29 checks — highlight, click, keyboard, streaming growth, resize all still hold with the rail reading a page | `.dev/verify/hn04/visible-turns-browser.log` |
| the windowed transcript journey | `node apps/web/e2e/window-experiment.mjs` | 0 | `WINDOW EXPERIMENT CHECKS PASSED` | `.dev/verify/hn04/window-experiment.log` |
| whitespace / conflict markers | `git diff --check` | 0 | no output | — |

Guides updated in the same change: [Chat](../../../docs/chat.md#the-full-history-navigation-outline),
[migration status](../../../docs/migration-status.md#full-history-navigation-history-navigation-tickets-0105),
[verification](../../../docs/verification.md#history-navigation-ticket-04-delivery-2026-10-20) and the new term
**Rail Node** in [GLOSSARY.md](../../../GLOSSARY.md). `apps/web/package.json` gains `test:history-rail`.

Not claimed here, by the ticket's own scope: the system acceptance matrix (compaction, fork inheritance, append during a
navigation, stale coordinates, the deep-search journeys together) is [ticket 05](./05-system-acceptance.md). No
deployment, restart or `remote-host` build; no bypass or security-control probe was designed or run.
