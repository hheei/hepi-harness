# 01 - Historical anchor contract

Status: resolved (delivered on `impl/history-navigation-01-next` — implementation `d5f14d9`, merged onto the then-tip `68ce3ca` at `0051cb2`, contract/evidence `1f5f173` — and **integrated into `integration/client-app` at `1f5f173`** (fast-forward, sole merger). Not pushed)
Blocked by: None

Define and test Backend-owned navigation snapshot identity and paged user-message anchors over fork-aware committed history. Compaction must not remove anchors; forks must include inherited anchors in scope. Decide whether anchor previews come from raw user blocks or a bounded projected form. Define wrong-scope, stale-snapshot, and assistant-only-prefix outcomes.

The contract is exposed on Backend and relayed unchanged through the client ingress to Web/App; no BFF derives, filters or re-pages anchors.

Acceptance: bounded ordered pages; user messages only; stable opaque coordinates; no duplicate cursor; compaction and fork fixtures; no unbounded response; protocol/backend tests record exact limits; ingress relay preserves cursor, snapshot identity and previews verbatim.

## Answer

Delivered on branch `impl/history-navigation-01-next`, implementation commit `d5f4d9`-series: feat(navigation) commit
`d5f14d9`, merged with the then-tip `integration/client-app` (`68ce3ca`) at `0051cb2`, which is the SHA every check below
ran against. Not merged into `integration/client-app`, not pushed.

**The contract.** `GET /api/conversations/:id/navigation?limit=&cursor=&scope` answers one bounded page of
**Navigation Anchors** over the conversation's fork-aware committed history — the runtime's own
`Conversation.entries()` membership-checked scan, not the active window — so compaction removes no anchor, a fork
enumerates the anchors it inherited in native order, and a sibling branch's later turn is absent. Per anchor: the entry
id, the ordering cursor (the entry id as a number, exclusive, the rule `conversation-read` already applies), an opaque
coordinate, and a preview of at most 240 UTF-8 bytes read from the raw committed user text (whitespace collapsed once,
cut on code-point boundaries by the existing `cutAtByteBudget`). Declared bounds, no unbounded answer: `limit` default
100, max 200, and the assembled page is measured against 64 KiB and states its own `bytes`; a page the budget shortened
says `hasMore` with a continuation cursor, a finished page states no continuation at all.

**Snapshot identity, split in two because it answers two questions.** `snapshot` is the window's existing
`historyRevision` token (`tokenFromFacts`, newest head marker **and** newest committed entry), so a rail can compare a
page with the transcript it holds. `scope` — the **History Scope** — is that token's head-marker part alone
(`scopeFromFacts`, `apps/server/src/history-window.ts`), is what every coordinate is stamped with, and is what the
required behaviours turn on: an append moves `snapshot` and leaves `scope` alone (an existing anchor's coordinate keeps
addressing it), a compaction or reset moves `head` and therefore the scope, which is already the event that ends a
loaded window.

**Named outcomes, held apart because a caller renders them apart.** `malformed` (400) for a `limit`/`cursor`/`scope` the
contract cannot read — refused rather than coerced, so no caller is handed a page it believes it bounded itself;
`wrong-scope` (409) for a scope belonging to another conversation; `stale-snapshot` (409) for a scope this conversation
no longer has. Spec item 9's `missing` is a target-read outcome and arrives with ticket 02's `/navigation/around`; an
outline page has no target to be missing.

**Outline Prefix.** The range before the first anchor is stated as a fact of the page that scanned it: `none`, or
`non-user` with the entries it holds. No synthetic anchor, no positional id, and a continuation states no prefix it did
not scan.

**Preview decision (the item the ticket left open): raw committed user text, not a bounded projected form.** The
deferred history-window projection would answer with a preview of a preview and would need the active window, which is
exactly what a compacted anchor no longer has. Raw text survives compaction and needs no second projection.

**One projection, one owner.** The contract lives once in `@hepi/protocol/navigation`
(`packages/protocol/src/navigation.ts`, re-exported from the protocol index and published as the `./navigation`
subpath): bounds, coordinate encode/decode, the preview rule, the page assembler, the named refusals, and ticket 02's
`NavigationTargetWindow`. The Backend route is a thin adapter over the scan
(`apps/server/src/conversation-navigation.ts`, wired in `apps/server/src/server.ts`). The client ingress forwards it as
written — verified by comparing the caller's bytes with the Backend's for the same query, not by a claim. No second
runtime, no BFF derivation, no unbounded wire index.

**Ticket 02's shape, settled here (implementation deferred).** A target window reuses the Backend's existing projected
entry shape (`ServerEntry`, the one expression the stream, the state read and an older page already share) over the
fork-aware committed history — not raw `conversation-read` text lines, not a new projection — so committed user text
survives compaction, an oversized entry is restored by the read-block family its own deferred preview names, fork
visibility stays the runtime's membership rule, and a landed window mounts through the transcript's existing renderer.
Placement is stated **by identity**: the target entry id plus a search hit's native `blockIndex`, never an offset,
ordinal or pixel. See `NavigationTargetWindow` / `NavigationTargetBlock`.

### Evidence

| check | command | exit | result | log |
| --- | --- | --- | --- | --- |
| selector run (post-merge, tree clean) | `pnpm verify:changed --base=integration/client-app` | 1 | `changed-typecheck` 0 (7 packages), `changed-test` 0 (app 12, gateway 480, protocol 63, server 509, session 57, ui 264 — 1385 pass / 0 fail), `web-unit` 0 (52/52); `check-docs` 1 — the **same 12 pre-existing broken links**, the byte-identical set the base worktree at `68ce3ca` reports | `.dev/verify/2026-10-19T06-23-15-391-verify-changed/` (`verify.json` names sha `0051cb2`, each per-step log states `# dirty: false`) |
| protocol contract | `node --test --test-reporter=tap packages/protocol/test/navigation.test.ts` | 0 | 9 pass / 0 fail (ordering + self-stated size, byte-budget shortening, `hasMore`/cursor pair, coordinate round-trip and the three decode refusals, malformed request bounds, exact preview caps incl. a code-point cut at 240 bytes) | `.dev/verify/hn01-focused/protocol-navigation.log` |
| Backend outline over real harnesses + HTTP route | `node --test --test-reporter=tap apps/server/test/conversation-navigation.test.ts` | 0 | 12 pass / 0 fail (one anchor per committed user message with tool/assistant traffic stated as nothing, no duplicate or repeated cursor across whole-outline paging, coordinate names only conversation+scope+entry, compaction keeps every anchor and retires earlier pages, `pi.reset` marks no anchor, fork inherits anchors in native order, append moves no anchor's identity, a turn committed mid-page, assistant-only prefix, byte budget, `wrong-scope`/`stale-snapshot`/`malformed`) | `.dev/verify/hn01-focused/server-navigation.log` |
| ingress relay | `node --test --test-reporter=tap packages/gateway/test/ingress-navigation.test.ts` | 0 | 1 pass / 0 fail: the caller's bytes equal the Backend's for `?limit=2` and for the relayed continuation cursor; capped preview stays at 240 bytes; continuation states no `hasMore`/cursor/prefix the Backend did not; `limit=0` arrives as the Backend's 400 `malformed`; the listener served exactly the three requests the caller made | `.dev/verify/hn01-focused/ingress-navigation.log` |

Guides updated in the same change: [Chat — the full-history navigation outline](../../../docs/chat.md#the-full-history-navigation-outline),
[Client ingress relay](../../../docs/client-ingress.md), [migration status](../../../docs/migration-status.md), and the
new terms in `GLOSSARY.md` (**Navigation Anchor**, **History Scope**, **Outline Prefix**).

Not delivered here, by the ticket's own scope: the bounded target read (`/navigation/around`) is ticket 02, and is now
delivered — see [ticket 02](./02-bounded-target-window.md). What remains undelivered is the surface: the rail, the jump
coordinator and the browser acceptance are tickets 03–05, so no client reads the outline or the window yet.

## Review outcome (2026-10-19)

Reviewer 57 found no material defect. Its one recorded observation — the page byte budget excludes its own `bytes` field,
so a page at the ceiling ships 14 bytes over the size it states — is assessed non-blocking, **not fixed here**, and carried
with trigger, impact and revisit condition in [review notes N1](../review-notes.md). It is ticket 02's to settle, because 02
adds the second instance of the same measurement.
