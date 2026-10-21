# Review notes — full-history conversation navigation

Date: 2026-10-19. Source baseline: `integration/client-app` at `1f5f173` (ticket 01, integrated from
`impl/history-navigation-01-next`: implementation `d5f14d9`, worker-side merge onto the then-tip `68ce3ca` at `0051cb2`,
contract/evidence commit `1f5f173`). Reviewer 57 reported no material finding; the row below is its one recorded
observation, assessed non-blocking and **deliberately not fixed in this merge**. Read-only source review plus the
reviewer's public assembler call — no runtime, browser or deployment claim.

## Findings

| ID | Trigger / source evidence | Normal-use impact | Disposition / revisit |
| --- | --- | --- | --- |
| N1 | `packages/protocol/src/navigation.ts:328-329` — the page byte budget is measured against the candidate **before** the field that reports it is added: `candidate` is built as `Omit<NavigationOutlinePage, "bytes">`, then `bytes = utf8Bytes(JSON.stringify(candidate))`, then `return { ...candidate, bytes }` puts that number into the object serialized to the wire (`apps/server/src/conversation-navigation.ts:196` returns `page.body` unchanged; the client ingress relays it verbatim). A page admitted at exactly the ceiling therefore ships slightly larger than it states. Reviewer repro against the public assembler — 200 anchors, each at the full `NAVIGATION_PREVIEW_MAX_BYTES` = 240, `hasMore: false` — logs `{"anchors":200,"previewMax":240,"remaining":0,"stated":65536,"actual":65550,"max":65536}`: 65,536 stated against 65,550 on the wire, **14 bytes over the declared 64 KiB `NAVIGATION_PAGE_MAX_BYTES`** (`navigation.ts:41`), the excess being the width of the `,"bytes":65536` field itself. Output retained at `/tmp/history-navigation-ticket01-assembler-review.log`. The loop is otherwise sound: it shrinks from the tail, never drops the last anchor to fit, and `hasMore`/`nextCursor` still agree with the returned body. | Not reached in ordinary use. The rail asks `limit` default 100 / max 200; a page at the ceiling needs 200 committed user messages each carrying a >=240-byte preview and appears only by paging to the end of a long conversation — at 100 anchors the same shape is near 32 KiB, twice inside the budget. The overflow is 14 bytes, and every reader of the stated size treats it as an observation, not a transport cap: `apps/server/test/conversation-navigation.test.ts:187,207,220` assert `bytes <= NAVIGATION_PAGE_MAX_BYTES` on the **self-stated** number, which stays true, so no existing check depends on the wire matching it. No client allocates from `bytes`, no proxy is set at 64 KiB for this route, and nothing refuses a page whose real size exceeds its stated size. Real consequence if it ever mattered: the one field the ticket comment calls "visible rather than guessed" is off by its own width at the boundary. | **recorded, not fixed.** Reviewer 57 judged it immaterial; this is an integration merge, and changing the measurement would alter a contract `0051cb2` was verified against. Options for the owner: measure with the field included (serialize once, reuse the length), state the bound as the body budget and reserve the field width, or document `bytes` as "the page body size excluding this field". Trigger that makes it material: a consumer enforcing 64 KiB on received bytes, `limit` raised above 200, or an LB/proxy byte cap on `/navigation`. Revisit in **ticket 02** — it adds the target-window byte/count limits and so a second instance of the same measurement pattern; settle the rule once there, or in ticket 05 acceptance where byte limits are asserted end to end. |

The row above is the finding as recorded at ticket 01's merge. **N1 was fixed at ticket 02**, at the owning abstraction, and is closed: see [N1 closed by ticket 02](#n1-closed-by-ticket-02-2026-10-19) below.
`recorded, not fixed` is the disposition for findings that have not been closed by their revisit condition; it is not a standing invitation to re-measure a size a navigation read now reports exactly.

## Notes
## N1 closed by ticket 02 (2026-10-19)

**Disposition: fixed at the owning abstraction, not per caller.** Ticket 02 delivers the second navigation read that
states a size, so the measurement was settled once rather than repeated: `navigationSerializedBytes(body)` in
`packages/protocol/src/navigation.ts` returns the response's UTF-8 size **including** the `bytes` field that reports it.
That field's width (`,"bytes":N`) is fixed-point on the number it states, so the helper iterates at most twice and its
result equals `JSON.stringify({ ...body, bytes: result })` exactly. `buildNavigationPage` and the new
`buildNavigationTargetWindow` both use it, so a page and a window cannot state two rules for one bound.

**Behaviour changed where the finding actually bit.** The reviewer's ceiling shape — 200 anchors at the full 240-byte
preview — now assembles to **187 anchors, `stated 65393 == wire 65393 ≤ 65536`, `hasMore: true` with the continuation
cursor** that reaches what the budget dropped (before: `stated 65536`, `actual 65550`). The page budget admits one fewer
anchor because the field that reports the size is now counted inside it; nothing else about the loop moved — it still
shrinks from the tail, never drops its last anchor, and keeps `hasMore`/`nextCursor` in step with the body.

**Closed at the public seams, not by assertion of intent.** `packages/protocol/test/navigation.test.ts` compares the
stated size with `JSON.stringify` of the built page and of a built window;
`apps/server/test/conversation-navigation.test.ts` compares it with the bytes the route actually returned;
`packages/gateway/test/ingress-navigation.test.ts` compares it with the bytes a caller receives **through the relay**.
The rule for both reads is recorded in [migration status](../../docs/migration-status.md). Ticket 05 inherits a byte
rule already asserted end to end rather than one to re-check there.


## Ticket 03 review at the rebased tip (2026-10-20)

Reviewed on `impl/history-navigation-03-tip` (rebased onto `integration/client-app` at `4a54277`). One finding, fixed here;
one observation, recorded.

| ID | Trigger / evidence | Normal-use impact | Disposition |
| --- | --- | --- | --- |
| N4 | `packages/ui/src/hooks/useAgentSession.ts:1064` — `loadContext`'s `onReadFailure` option has **no production caller**. Its one consumer was `ChatWindow`'s search-locate loop, which this ticket deleted; the remaining `loadContext` callers (the position restore at `ChatWindow.tsx:712` and the sentinel at `:816`) pass no `onReadFailure`. Only `useAgentSession.lifecycle.test.mjs:1084` still calls it. | None in ordinary use: the option is inert, not wrong — a page that fails in the sentinel path still answers `undefined`, and the sentinel's own failure path is unchanged. The cost is a seam documented as "what a navigation has to report" whose navigation no longer exists, and a lifecycle test asserting a contract nothing uses. | **Not removed here; the two guides corrected.** Deleting the option is a change to the session hook's public return surface taken on a ticket whose scope is the coordinator, and the seam is a true statement about the read rather than a bug: a page that failed is not a page that is absent. `docs/chat.md` and `docs/migration-status.md` now say the channel has no consumer since ticket 03 replaced the locate path, instead of describing a locate that no longer exists. Revisit if the read failure reaches a surface again, or delete it with the next change to that hook's options. |
| N5 | Rebase conflict resolution on `docs/migration-status.md` dropped the ticket-21 "Read and navigation failure recovery" section the integration line had added directly above the navigation section. | A current guide would have lost a delivered capability's own record — the failure this ticket's own brief names as the thing to avoid ("update the owning guide"). | **Fixed**: restored byte-identical to `4a54277` apart from the one sentence the rebase made false. Caught by diffing the rebase against its base rather than by reading the merged file. |

## Checked and not found

- No second runtime or BFF derivation: the outline is declared once in `@hepi/protocol/navigation`, the Backend route is an
  adapter over the runtime own membership-checked `Conversation.entries()` scan, and the ingress test compares the caller
  bytes against the Backend rather than asserting a relay by claim.
- Ticket 02 target-window shape is stated in ticket 01 `## Answer` but nothing is served until ticket 02 delivers the route:
  `NavigationTargetWindow` is a contract, not an endpoint, so there is no dead wire surface.
- Compaction, fork inheritance, append during a page, and wrong-scope / stale-snapshot / malformed outcomes are covered by
  `apps/server/test/conversation-navigation.test.ts` (12) and `packages/protocol/test/navigation.test.ts` (9). No bypass or
  security-control probe was designed or run.

## Reviewer 63's two P2 findings at `2a95fc4` — fixed (2026-10-19)

Reported against the delivered tree with a real-harness repro
(`/tmp/history-navigation-02-review-2a95fc4.log`, exit 0); both are ordinary-use contract failures at the target read's
own seam, so both were fixed there rather than recorded.

| ID | Trigger / evidence | Normal-use impact | Disposition |
| --- | --- | --- | --- |
| N2 | `readNavigationTarget` pinned its scan at the caller's `snapshot` but stamped the window with `reader.snapshot` — the conversation's **current** token. Repro: requested `7\|-|15`, response `7\|-|16` while the entries were bounded at 15. | A window naming a history newer than the one it returned: `snapshot` cannot prove which entries a caller received, which is its one job, and a caller comparing it with its page sees a turn that is not in the window. Any append between the outline page and the jump reproduces it — the race the pin exists for. | **Fixed at the read.** The window now stamps the snapshot its pin describes, built by the history owner's own `tokenFromFacts` from the same head fact the scope carries (`snapshotOfPin` in `apps/server/src/conversation-navigation.ts`). Contract doc states the field describes the history the bytes were read against. Regression: the pinned-append test asserts `window.snapshot === pinned`, and a target at the pin states `hasNewer: false` with no `newerCursor` while the turn committed after the pin stays outside. |
| N3 | `scanSide` returned `{ items: [], more: false }` as soon as `wanted === 0`, so `before=0&after=0` reported `hasOlder: false, hasNewer: false, trimmed: false` over committed neighbours on both sides. | A window claiming to be whole when committed history lies immediately behind and ahead of it, and stating no boundary cursor, so a caller that trusts the flags stops paging at a target that is at neither end. `before=0` is a real request — land on this turn, no context — not an empty history. | **Fixed at the read.** With a zero count `scanSide` still walks to the first mountable entry on that side — one entry of read, no collection — and answers `more` from what the history holds, bounded by the same raw-entry cap: the flag answers "does committed history lie this way", not "did this read carry any". `trimmed` follows the two flags, so it is true there too. The test that asserted `false` now asserts `true` with `olderCursor` at the target, plus a zero/zero window and the honest `hasOlder: false` at the conversation's first turn. `NavigationTargetWindow.hasNewer`'s doc was reworded to state the rule for both flags. |

Fixed on `impl/history-navigation-02-next` at `225007f`; the reviewer's two shapes re-run against the fix report
`requested 7|-|18, response 7|-|18, current 7|-|19` and `zero context: hasOlder true, hasNewer true, trimmed true,
olderCursor/newerCursor 15`, with the first turn still `hasOlder: false`.
