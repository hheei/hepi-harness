# 02 - Bounded target window

Status: resolved and **integrated** into `integration/client-app` at `5e64cb9` (implementation `ff30a88`, the review corrections at `225007f`, the two documentation records at `5e64cb9`). Ticket 03 branched from it at that SHA.
Blocked by: [01](./01-historical-anchor-contract.md) (resolved and integrated — its `## Answer` settles the coordinate and target-window contract this ticket consumes)

Carried in from 01's review: [N1](../review-notes.md) — the outline page states a byte count that excludes its own `bytes`
field, 14 bytes low at the ceiling. This ticket adds the target-window byte/count limits and so the second use of that
measurement; settle the rule once, here, rather than repeating it.

Add a bounded Backend target read around a user anchor from the same snapshot as the outline. Preserve user text for compacted anchors, inherited fork entries, redaction and byte limits. Return target placement metadata, exact block identity when the target is a search hit, and explicit `stale`/`missing`/`out-of-scope` outcomes. The client ingress relays the route to Backend unchanged; Web and App call it through that ingress, and no BFF layer reconstructs, filters or re-pages history.

Acceptance: compacted anchor, inherited anchor, append during request, wrong scope, stale snapshot, missing entry, oversized entry, and target-window byte/count limits. No response contains the full history. Ingress relay returns the Backend body and status without rewriting target identity.

## Answer

See the evidence table below; the behaviour, the bounds and the outcomes are recorded for the owner in
[Chat](../../../docs/chat.md#the-full-history-navigation-outline) and in
[migration status](../../../docs/migration-status.md).

**Acceptance, item by item.**

| ticket requirement | where it is answered | how it is proven |
| --- | --- | --- |
| compacted anchor | `apps/server/src/conversation-navigation.ts` reads the entry table, not the active range | `conversation-navigation.test.ts` — "a compacted anchor's window carries its committed text…" asserts the dropped prompt's own text and the pre-compaction coordinate refused `stale-snapshot` |
| inherited anchor | the same membership-checked scan, conversation-scoped | "a fork reads an inherited anchor's window, and a sibling's entry is named `missing` rather than absent" — the fork's window carries the shared prefix in native order, the parent's own later turn answers 404 |
| append during request | `snapshot` pins the read's newest end (`pinnedTail`) | "a window asked against the snapshot its page stated is not moved by a turn committed while it was read" — the pinned window excludes the new turn, an unpinned read reaches it, the anchor's coordinate is unchanged |
| wrong scope | coordinate and snapshot both carry the conversation | route-level assertions in "the route answers a coordinate the contract cannot read…", plus `wrong-scope` on a foreign snapshot |
| stale snapshot | head-marker scope moved, snapshot tail gone, or anchor ahead of the pin | the compaction case, the "no longer holds" case, and the anchor-ahead-of-pinned-snapshot case, all named |
| missing entry | `visibleEntry` from `conversation-read.ts` (exported; the one fence) | 404 `missing` for an unknown id and for a sibling branch's committed entry |
| oversized entry | the assemblers never drop the target | 413 `frame_too_large` with `entryId` and `bytes` for an entry that alone exceeds the budget, and that entry still served whole by `GET …/entries/:entryId`; a block past the projection's threshold arrives deferred and is restored by its `textUrl` |
| byte/count limits | default 10 and max 50 per side, `NAVIGATION_TARGET_MAX_RAW_ENTRIES` for the walk, `NAVIGATION_PAGE_MAX_BYTES` for the response | protocol test for the request bounds and the budget trim; server test for `before=0`, the cap over 400 bookkeeping entries, and `rawWindowCap(VISIBLE_WINDOW)` equality; `capped`/`trimmed`/`hasOlder`/`olderCursor` state which bound cut |
| no full history | one read around one target | the ingress test asserts the listener served exactly the requests the caller made — one jump, one window request, no fan-out over preceding pages |
| relay returns the Backend body and status, identity unrewritten | no ingress source change | `packages/gateway/test/ingress-navigation.test.ts` compares the caller's bytes with the Backend's for a window, checks the re-issued target coordinate and the deferred block URL arrive verbatim, and answers the Backend's 400 for a refused window |
| N1, the shared size rule | `navigationSerializedBytes` counts the `bytes` field itself; both assemblers use it | stated size equals `JSON.stringify` at the protocol seam, the route's own response bytes at the Backend, and the relayed text at the ingress. The reviewer's ceiling shape is now 187 anchors at 65,393 stated and 65,393 shipped, with the cursor that reaches what the budget dropped |
| redaction | the projection is handed in, not re-run | "a window carries the transcript's own redaction of a credential failure, and no unregistered api" |
| exact block identity for a search hit | `target.blocks`, `target.blockIndex`, and `entry`/`anchor` must agree | route-level checks: a valid block echoes back, a block the entry does not carry and a mismatched `entry` are refused `malformed` |

**Deliberate limits, recorded rather than guessed.** `missing` exists only for a target read — an outline page has no
target to be missing. Spec item 9's `cancelled`, `deferred-busy` and read `error` need a client that can abandon a jump
or switch a conversation, so they belong to ticket 03. There is no anchor index, no count field and no O(1) random
access: a window walks outward from its target within the read budget and states what it could not reach. No surface
asks for a window until tickets 03–05.

### Reviewer 63's corrections (2026-10-19, reported at `2a95fc4`)

Two material P2 findings against the delivered tree, both fixed at the read itself rather than at its callers — see
[the findings and their disposition](../review-notes.md#reviewer-63s-two-p2-findings-at-2a95fc4--fixed-2026-10-19):

- **The window stated an identity it did not read.** It pinned its scan at the caller's `snapshot` and stamped
  `reader.snapshot` — the conversation's current token — so a committed turn appeared in the identity while staying out
  of the entries. It now stamps the snapshot its pin describes, built by the history owner's own `tokenFromFacts` from
  the same head fact the scope carries, and `snapshot` is documented as the history the bytes were read against.
- **A zero count claimed an empty history.** `before=0&after=0` reported `hasOlder`, `hasNewer` and `trimmed` all
  `false` with committed neighbours on both sides and no boundary cursor. The two flags now answer "does committed
  history lie that way in the history this window was read against": the side walk still stops at the first mountable
  entry when the count is zero, bounded by the same raw-entry cap, so the flags and `trimmed` are true there while the
  honest `false` still holds at the conversation's first turn.

Regression coverage sits beside the tests that already covered those paths: the pinned-append test asserts
`window.snapshot === pinned` plus `hasNewer: false` with no `newerCursor` for a target at the pin while a turn was
committed after it, and the bounds test asserts `before=0` → `hasOlder: true` with `olderCursor` at the target, a
zero/zero window stating both sides and `trimmed: true`, and `hasOlder: false` at the first turn. Fix commit
`225007f`; the reviewer's two shapes re-run against it report `requested 7|-|18, response 7|-|18, current 7|-|19` and
`zero context: hasOlder true, hasNewer true, trimmed true, olderCursor/newerCursor 15`, first turn still
`hasOlder: false`.

### Evidence

| check | command | exit | result | log |
| --- | --- | --- | --- | --- |
| selector run (post-merge, clean tree) | `pnpm verify:changed --base=integration/client-app` | 1 | `changed-typecheck` 0 (7 packages); `changed-test` 0 — app 18, gateway 481, protocol 67, server 520, session 57, ui 264 = **1407 pass / 0 fail**; `web-unit` 0 (56/56); `check-docs` 1 — the **same 12 pre-existing broken links**, byte-identical to the list the base worktree reports at `00528fc` | `.dev/verify/2026-10-19T08-06-28-524-verify-changed/` — sha `e881f81`, `# dirty: false` in each per-step log; the only change after that run is this table's wording. An earlier run at `e20b776` (`.dev/verify/2026-10-19T07-56-31-841-verify-changed/`) reports the same counts and the same broken-link set |
| protocol contract | `node --test --test-reporter=tap packages/protocol/test/navigation.test.ts` | 0 | 13 pass / 0 fail (4 new: shared size, window bounds, budget trim that never drops the target, target-request bounds refused before history is read) | `.dev/verify/hn02-focused/protocol-navigation.log` |
| Backend reads over real harnesses + the real route | `node --test --test-reporter=tap apps/server/test/conversation-navigation.test.ts` | 0 | 23 pass / 0 fail (ticket 01's 12 unchanged, 11 new) | `.dev/verify/hn02-focused/server-navigation.log` |
| ingress relay | `node --test --test-reporter=tap packages/gateway/test/ingress-navigation.test.ts` | 0 | 2 pass / 0 fail (the outline relay test unchanged, the window relay test new) | `.dev/verify/hn02-focused/ingress-navigation.log` |
| reused seams | `node --test --test-reporter=tap apps/server/test/conversation-read.test.ts` · `apps/server/test/history-window.test.ts` | 0 · 0 | 12 pass / 0 fail · 17 pass / 0 fail | `.dev/verify/hn02-focused/conversation-read.log`, `.dev/verify/hn02-focused/history-window.log` |


### Integration into `integration/client-app` (2026-10-20)

Ticket 02's status above said "not merged into `integration/client-app`". That statement was **stale, not a gap**: the
branch reached the integration tip through an ordinary merge of the integration line into an unrelated effort's branch,
so no commit of its own says so. `git merge-base --is-ancestor 5e64cb9 701add2` is true — `c070e7e` ("Merge
integration/client-app (5e64cb9) into fix/mcp-grants-owner-next") is the merge that carried it, and every tip since is a
descendant. Nothing was re-implemented, cherry-picked or fixed here: the tip's `packages/protocol/src/navigation.ts`,
`apps/server/src/conversation-navigation.ts`, `apps/server/src/conversation-read.ts` and the three navigation test files
are **byte-identical** to `5e64cb9` (`git diff --stat 5e64cb9 701add2` over those paths is empty), so the delivered tree is
the reviewed tree.

**The one file the integration line moved is the route host, and it did not move the route.** `apps/server/src/server.ts`
gained the MCP grant work (`a40f251`) after the merge; the `navigation/around` registration and its `projectEntry`
projection are unchanged in it. The two efforts meet only as adjacent route registrations, which is why the route reads the
same projection the stream does at the tip.

**Re-verified at the tip, not inherited from `e881f81`.** Source is identical, but the surrounding line is not, so the
navigation suites were re-run here (`.dev/verify/hn02-integration/`, all exit 0):

| check | command | result |
| --- | --- | --- |
| protocol contract | `node --test --test-reporter=tap packages/protocol/test/navigation.test.ts` | 13 pass / 0 fail |
| Backend reads + the real route | `node --test --test-reporter=tap apps/server/test/conversation-navigation.test.ts` | 23 pass / 0 fail |
| ingress relay | `node --test --test-reporter=tap packages/gateway/test/ingress-navigation.test.ts` | 2 pass / 0 fail |
| reused seams | `node --test --test-reporter=tap apps/server/test/conversation-read.test.ts` · `apps/server/test/history-window.test.ts` | 12 / 17 pass, 0 fail |
| whole server acceptance suite | `pnpm --filter @hepi/server test:acceptance` | 544 pass / 0 fail |
| whole gateway acceptance suite | `pnpm --filter @hepi/gateway test:acceptance` | 491 pass / 0 fail |
| selector run at the tip | `pnpm verify:changed --base=00528fc` (the integration line, not only this branch's edits) | `changed-typecheck` 0 (7 packages), `changed-test` 0 (app 18, gateway 44, protocol 67, server 21, session 57, ui 275), `web-unit` 57/57, `check-docs` 1 — the same 12 pre-existing broken links |

`check-docs` stays at exit 1 for the twelve links ticket 01's integration already recorded (nine
`.scratch/design-fixes/host/diagnosis.md` targets under `.dev/verify`, one `.scratch/architecture-unification` log,
two `.scratch/development-audit` skill paths); none is a navigation link, and this record adds none.

**What this does not claim.** No client surface reads the window: tickets 03–05 remain open, so the rail and the jump
coordinator are still undelivered and the loaded-history minimap behaves as before. No push, no deploy, no build on
`remote-host`; no bypass or security-control probe was designed or run. The integration edit is this record plus the status
lines in this ticket and the effort README — planning and documentation only, no executable change.
