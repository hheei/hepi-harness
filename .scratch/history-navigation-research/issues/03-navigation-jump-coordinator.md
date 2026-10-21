# 03 - Navigation state and jump coordinator

Status: in-review — delivered on `impl/history-navigation-03-tip` (rebased onto `integration/client-app`'s tip `4a54277`) and **integrated into `integration/client-app`** by cherry-picking that branch's commits onto `1db108c`, so its source is on this line. 01 integrated at `1f5f173`; 02 integrated at `5e64cb9`.
Blocked by: [01](./01-historical-anchor-contract.md), [02](./02-bounded-target-window.md) (both resolved; 02's `## Answer` states the window, its bounds and its outcomes this coordinator consumes)

Add Web/App state ownership for paged outline and one target window. Keep active transcript prefix rules separate. On unloaded-node click, request target window, commit layout, then align target. Smooth scrolling begins only after target DOM exists; intermediate scroll events cannot load pages or trigger requests for crossed nodes.

Deep exact-block search uses this same coordinator rather than its own locate loop: one target read for the searched entry, exact block placement inside the returned window, then presentation-only scrolling. Every unresolved lookup maps to one explicit outcome — `stale`, `missing`, `cancelled` (conversation changed or superseded), `deferred-busy` (session busy, retryable), or read `error` — and each renders a named state with retry or raw-history offer. A failed locate clears the pending target only after showing that outcome; it is never reported as handled successfully.

Acceptance: unloaded anchor and deep search result each use one target request; mounted turn count stays bounded; target survives append/rebaseline according to snapshot rules; animation produces no sequential paging; stale, missing, cancelled, busy and error outcomes each have a distinct rendered state; no failure path ends as silent handled.


## Answer

See the evidence table below; the behaviour and the boundaries are recorded for the owner in
[Chat](../../../docs/chat.md#the-full-history-navigation-outline) and in
[migration status](../../../docs/migration-status.md), and the two new terms in
[GLOSSARY.md](../../../GLOSSARY.md) (**Navigation Outcome**, **Viewport Hold**).

Delivered as `packages/ui/src/lib/history-navigation.ts` (the rules), `hooks/useHistoryNavigation.ts` (the owner: the
paged outline state and the one target window), `components/NavigationOutcomeBanner.tsx` (the rendered states), the
`landWindow` half of `hooks/useAgentSession.ts` (the history owner), and two forwarded reads on
`lib/conversation-api.ts`. The rail is ticket 04; `reduceOutlinePages` is the state it will read.

**Acceptance, item by item.**

| ticket requirement | where it is answered | how it is proven |
| --- | --- | --- |
| unloaded anchor uses **one** target request | `NavigationCoordinator.#settle` — fence, loaded-check, busy, one read, land, name | coordinator test "an unloaded anchor costs exactly one target read…": `requests.length === 1`, addressed by `anchor=nav1.…` and pinned at the conversation's own `snapshot`, and asks for **no** `before`/`after`, so the Backend's bound is the one that cuts |
| deep search result uses this same coordinator, not a locate loop | the loop in `ChatWindow.tsx` is deleted; `searchTarget` calls `locate` once per target the shell hands over | "a deep search hit uses this coordinator: one read, its exact block, one settlement" — `entry` and `block` travel with the coordinate; and the loop's own shape is retired by "navigation issues no sequential page request whatever the distance", which asserts one request **and** one settlement when the window cannot carry the target |
| a target already loaded costs nothing | `host.activeEntryIds.includes(entryId)` short-circuits before any read | "a target the conversation already carries lands without a read" — zero requests, nothing handed to the history owner, `held`/`loaded: true` |
| exact block placement inside the returned window | the hit's `block` is echoed by the Backend's `target.blockIndex` after it checks the entry | real-HTTP case: `?anchor=&snapshot=&entry=&block=0` answers `target.blockIndex === 0` and `present: true` over a real Backend and ingress |
| then presentation-only scrolling | `held` sets the surface's pending scroll; the coordinator reads no scroll position and owns no DOM | `navigationHoldsViewport` is a pure value (below), and the existing finite settlement (`scroll-settlement.ts`) is untouched — one settlement per navigation, ended by arrival, the reader's gesture, or the target leaving the window |
| commit layout, then align the target | the window reaches the prefix owner **before** `held` is reported | `#settle` calls `host.landWindow` ahead of `#report`, asserted by "one window handed to the history owner" plus `landWindow`'s transcript case |
| intermediate scroll events cannot load pages or request crossed nodes | the sentinel's observer returns while a navigation holds a target | "a navigation owns the viewport from the owed read through the scroll, and nothing after" — both edges asserted: a read owed and an alignment gate paging, a landing whose scroll finished, a target already on screen and every named failure release it |
| active transcript prefix rules stay separate | a landed window enters the reader's paged prefix, never the lifecycle fold; `decidePrefix` still decides what it becomes | `landWindow` test — the landed span merges in history order, never twice, never over an entry the projection's window carries, and retires with the head marker a re-baseline moved. `mergeLandedPrefix` is tested directly for the ordering, the once-only rule and the overlap cut |
| mounted turn count stays bounded | the window is ticket 02's bounded read; the reveal mounts the target's turn, not the distance to it | unchanged from ticket 02's window bounds; the deleted loop is what used to grow the transcript page by page |
| survives append / rebaseline per snapshot rules | the fence reads `scope` (append-invariant) out of the conversation's own `snapshotRevision` | "an append keeps every anchor's identity and does not invalidate a held jump" (jump lands across a grown conversation, next read pinned at the newest snapshot) and "a stale coordinate is refused by the conversation's own fence before any read" — `stale-snapshot`, `wrong-scope`, `malformed` each cost **zero** reads |
| `stale`, `missing`, `cancelled`, `deferred-busy`, `error` each a distinct rendered state | `NavigationOutcomeBanner`, one `data-navigation-outcome` name and one sentence per outcome, `role="status" aria-live="polite"` | 3 banner cases over all seven names: distinct sentences (no collapsed pair), an unworded key would fail, and retry / raw-history / dismissal each present. Coordinator cases name each failure separately, including the two client-owned ones (`cancelled` on a switch mid-read, `deferred-busy` with its accept-then-land edge) |
| a failed locate clears the pending target only after showing the outcome, never as handled | the failure branch retires the shell's target **without** `onSearchTargetHandled` claiming success; dismissal retires it the same way | the settle effect's `kind === "failed"` path clears the pending scroll and reports the target as *not landed*; the banner's dismissal is asserted to retire it, and a `held` landing is the only path that reports handled |
| retry or raw-history offer | every failure carries `retry`; the banner offers the shell's own `onOpenSession(…, { rawHistoryFocus: true })` | "the raw-history offer is made only when there is an entry to open" — an unreadable address, no conversation, or a host without the seam each render two buttons, not three |

**Deliberate limits, recorded rather than guessed.**

- **No rail yet, and therefore no rail-side alignment in the shipped surface.** This holds the paged outline **state**
  (`reduceOutlinePages`, accumulation, de-duplication, ordering by the Backend's cursor, refresh on a moved snapshot or
  scope, and a failure that keeps the pages it held) and the one target window a jump asks for, and `jump` settles it
  exactly as a search hit does — but nothing lists a page, so there is no unloaded node to click. The reveal + alignment
  a rail needs after a `held` outcome (spec decision 7's "smooth scrolling begins only after the target DOM exists") is
  ticket 04's seam, taken from the same outcome plus the `blockIndex` the window echoes. Ticket 04 owns the surface.
- **A superseded jump is dropped, not reported.** Two jumps in one conversation are the reader changing their mind, and
  a late `cancelled` over the landing they asked for last would be the wrong state in the other direction. A jump
  retired by a **conversation switch** *is* reported, because that reader request would otherwise end as the silent
  no-op this ticket exists to remove. The distinction is asserted both ways.
- **A `deferred-busy` lands only if the reader took the offer.** `retry` is the accept; a run ending alone never
  re-issues a jump the reader abandoned, replaced or dismissed. No timer and no poll — the surface's busy edge calls
  `settleWaited`.
- **`frame_too_large` is rendered as `error`.** The surface has no sentence for a size the whole Backend answers, so the
  Backend's own detail is kept beside the name rather than a second vocabulary added here. `version_mismatch` narrows to
  `malformed` by the same rule, in the one function both reads map through.
- **One browser scene, not the full journeys.** The failed-hit/Retry/landing scene is this ticket's own request
  ownership and is covered in a browser (`apps/web/e2e/ux-navigation-retry.mjs`); the scenes that a person's click on a
  turn three hundred turns back is a landing, and "the animation requested no node it passed over" across a rail, are
  ticket 05's. Note that the Next build refusal earlier versions of this record cited is retired: `apps/web` builds
  with Vite since the Next app was retired on `integration/client-app`, so it is no longer the reason a journey is not
  claimed here — ticket 05's scene ownership is.

### Evidence


Every row below was re-taken on the rebased tip (base `4a54277`), not inherited from the pre-rebase branch: the
pre-rebase record's numbers were measured against `integration/client-app` at `c070e7e`, which has since moved 600+
commits, so they are superseded rather than quoted. Logs are under `.dev/verify/`.

| check | command | exit | result | log |
| --- | --- | --- | --- | --- |
| browser: a failed hit's Retry lands, and nothing pages during it | `node apps/web/e2e/ux-navigation-retry.mjs` | 0 | 8/8 checks: the failure renders as its own named state, one navigation read (no page walk), the failure does **not** retire the shell's target, the retry's landing is mounted and aligned in the viewport, the request is retired once by that landing, `0` older-history page reads, the banner is gone, no page error. The fixture mounts the production `ChatWindow` under `StrictMode` with only its network boundary replaced | re-run on the rebased tip `3aa2fb9` (Chromium against an esbuild bundle on 127.0.0.1:43123); the same driver fails 2 checks on the pre-fix tree |
| the navigation hook under a `StrictMode` replay | `node --test packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs` | 0 | 1 pass / 0 fail — a jump after the replay is read under a live lifetime rather than refused as the surface's own cancellation | run from `packages/ui` |
| selector run on the **delivered tip** (`--base=4a54277`) | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=4a54277` | 1 | `changed-typecheck` **0** (app, server, web, gateway, ui); `changed-test` **0** — ui 338, app 26, gateway 166, server 346 = **876 pass / 0 fail**; `web-unit` **0** (14/14); `check-docs` **1** — the same **12 pre-existing broken links**, the same set the base worktree at `4a54277` reports, and 0 guides missing from the index | `.dev/verify/2026-10-20T02-01-15-127-verify-changed/` — `verify.json` sha `5b80d9c`, `dirty: false`. The composition differs from the pre-rebase run because the integration tip's suites moved: gateway and server now split ordinary/acceptance profiles (`fb94b82`), so these are the packages' own `test` scripts rather than the acceptance profiles |
| coordinator + outline reducer | `node --test packages/ui/src/lib/history-navigation.test.mjs` | 0 | 22 pass / 0 fail (one read per jump, none for a loaded target, a deep hit's exact block, no sequential request at any distance, seven named outcomes with retry+dismiss, switch → `cancelled`, superseded → dropped, busy deferral landing only on accept, the three client-side fences costing zero reads, an answer of another identity refused before publishing, the prefix merge, page accumulation/ordering/refresh/failure, the viewport hold's two edges, and the four review corrections: the post-await scope fence, the idle Retry of a deferral, the search hit's per-attempt address, and what a settlement asks the surface to do) | run from `packages/ui` |
| rendered outcome states | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | 0 | 3 pass / 0 fail (all seven names, distinct sentences, `role=status`+`aria-live`, the three offers, the two states that render nothing, the raw-history offer withheld) | run from `packages/ui` |
| the transcript's own owner | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | 0 | 26 pass / 0 fail on the rebased tip, including the new "a landed target window joins the loaded prefix and never overlaps the accepted window" | run from `packages/ui` |
| both reads over a real Backend + ingress | `node --test packages/ui/src/lib/conversation-api.http.test.mjs` | 0 | 6 pass / 0 fail, including the new "the navigation reads are answered on the Backend's own routes, and a refusal arrives with its code" (page, window with `entry`/`block`, `wrong-scope` crossing the connection as `error.code`, both routes served under `/api/conversations`) | run from `packages/ui` |
| the Web app's own build (the browser scene's host) | `pnpm --filter @hepi/web build` (Vite) | 0 | `✓ built in 1.05s`, third-party notice emitted. The Next refusal the pre-rebase record cited no longer exists: `apps/web` has no `next build` to fail since the Next app was retired on `integration/client-app` | `.dev/verify/hn03-tip/web-build.log` |
| reused seams, unchanged source | `pnpm --filter @hepi/protocol test` · `pnpm --filter @hepi/session test` | 0 · 0 | 67 pass / 0 fail · 57 pass / 0 fail — ticket 01/02's contract tests and `decidePrefix`'s own suite. Neither package was edited by this ticket, so these are the numbers the delivered tree still reports rather than a re-measurement of a baseline | run in this worktree after the selector run |

**One pre-existing failure, recorded rather than excused.** `apps/app`'s two `offline-install` cases fail on this
workstation unless `/usr/sbin` and `/sbin` are on `PATH`: `dpkg` reports *"2 expected programs not found in PATH"*
(`ldconfig`, `start-stop-daemon` — both present at `/usr/sbin`, absent from the agent shell's `PATH`). The selector run
above was made with `PATH="$PATH:/usr/sbin:/sbin"`, and they pass there; a run without it reports 16/18. Cause: this
agent's `PATH`, not `apps/app` and not this ticket — nothing under `apps/app` changed. The `check-docs` exit 1 is the
same 12 links ticket 02's record reported byte-for-byte.
