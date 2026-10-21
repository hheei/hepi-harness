# 01 - Target validation contract

Type: implementation
Status: resolved, and its delivery is **on this line**. Originally delivered on `impl/xref-01-target-validation` as
`5a963cd` (branched from `integration/client-app` at `701add2`, never merged, never pushed); the same work was then
delivered here by a differently cut branch as `9aacab4`, and `git rev-parse` of
`apps/server/test/conversation-references.test.ts` answers **the identical blob** for `5a963cd`, `9aacab4` and `HEAD` — so
the contract, its tests and the route measured below are the ones this line carries. The block on client-app 17 is met
(17 closed 2026-10-19); the ticket's own note below records why it never in fact blocked this work.
Blocked by: [client-app 17 - retire Next and transition paths](../../client-app/issues/17-retire-next-and-transition-paths.md) (unmet — see [the block](#the-block-and-why-it-was-lifted))
Parent spec: [Cross-conversation references](../spec.md)

## Outcome

The existing reference owner validates a target conversation and optional entry against the target's visible committed fork-aware history, and reports a named result instead of storing an unresolvable link.

## Scope

Extend the existing seams only: `ConversationReference`, `ReferencesDoc`, the `references` action in `packages/session/src/control.ts`, and the Backend reference routes reached through the client ingress. Validation covers target existence and tombstone visibility, entry membership in the target's visible committed history (including inherited fork entries and entries behind compaction), and wrong-scope requests.

Entry identity for a reference is the same stable entry identity the history owner already issues; no new coordinate, ordinal or copied content is introduced. If validation cannot be met without a schema or read-path change, record that as a material-necessity decision in the parent spec before expanding anything.

Named outcomes: `target-missing`, `target-unavailable` (tombstoned/hidden), `entry-missing`, `entry-out-of-scope`, `stale`, `error`.

## Acceptance

- [x] Creating a reference to an existing conversation succeeds and stays idempotent by target plus entry.
- [x] Creating an entry reference is refused with `entry-missing` or `entry-out-of-scope` when the entry is not in the target's visible committed fork-aware history, and nothing is stored.
- [x] A tombstoned or hidden target yields `target-unavailable` rather than a passing existence check.
- [x] Inherited fork entries and post-compaction entries validate successfully; fork references stay branch-local and forks still start with no inherited references.
- [x] Following or reading an unresolvable reference returns the named outcome, not a generic failure and not a nearest-neighbour substitute.
- [x] No reference payload copies target content, and no new schema or model tool is added; any material necessity is recorded before it is implemented.
- [x] Focused Backend tests cover each outcome and record exact commands, revision and exit codes.

## Notes

Depends on client-app 17 because the routes and client adapters must be the post-retirement ones; do not add validation to a path that ticket 17 removes.

## Answer

Delivered on `impl/xref-01-target-validation` as commit `5a963cd`, branched from `integration/client-app` at
`701add2`. Not merged, not pushed.

**The seam is the one the spec named.** `ConversationReference` keeps exactly `conversationId`, `entryId?`, `label?`
and `ReferencesDoc` keeps its `hepi.conversation.references` document with `fork: "initial"`; no store, table, index,
copied history or model tool was added, so no material-necessity decision was needed. What the owner gained is a
verdict and a read:

- `unresolvedReference` (`apps/server/src/conversation-operations.ts`) is the **one** place a reference is judged, and
  both the write and the read call it, so a refused creation and a later follow cannot disagree. It reads three facts
  of the target through the seams that already own them: the conversation record (`target-missing`), the
  `hepi.deleted` tombstone (`target-unavailable` — the gap the old existence check left, because a removed conversation
  keeps its records), and, for `entryId`, the target's **visible committed fork-aware history** through the runtime's
  membership-checked entry scan, which is the same fence `conversation-read`, the navigation outline and a target
  window use. An id absent from the store is `entry-missing`; an id the store holds but this target's history does not
  is `entry-out-of-scope` — the distinction an id lookup alone would collapse.
- `addReference` resolves **before** the write and throws the outcome's own code, so a refused creation commits
  nothing. `references()` returns each stored record with `outcome` set when it cannot be followed now; a stored record
  is never rewritten, dropped or repointed, so a removal still does not cascade into another conversation's state.
- The wire vocabulary is the outcome itself: 404 `target-missing`/`entry-missing`, 409
  `target-unavailable`/`entry-out-of-scope`, 400 `invalid_request` for an `entryId` that is not the numeric identity
  the history owner issues. `packages/session/src/control.ts` relays it unchanged, so a surface renders the name.
- `ConversationInfo.references` and `ResolvedReference` are the protocol's own types, so the by-id read and the write
  answer the same shape. Idempotency stays by target **plus entry**.

**`stale` and `error` are follow-time, not stored-time.** The Backend states the four creation facts above plus
`stale`/`error` in the `ReferenceOutcome` union for the follow read: a reference that resolved and no longer does is
reported at follow time (`target-unavailable`/`entry-missing` today, because that is what the target's own state says),
and a read that fails is `error` — the one outcome a retry can change. The client coordinator (ticket 02) owns
`cancelled` and the surface state for each.

**No second path.** The Backend route is a thin adapter over `operations.addReference`; the ingress forwards
`POST /api/conversations/:id/references` unchanged; nothing validates in a client. The only code path that could
otherwise be "the path ticket 17 removes" is the retired `apps/web/adapters/durable-api.ts` forward, which already
relays the Backend's answer verbatim and was left untouched rather than extended.

### The block, and why it was lifted

The ticket lists client-app 17 (retire Next/BFF) as its blocker so that validation is not written against a path that
retirement deletes. That condition is satisfied for the work delivered: the owner this ticket extends —
`ConversationReference`, `ReferencesDoc`, `ConversationOperations`, the Backend route — is the post-retirement owner
(client-app spec decision 1, "reuse the existing owner"), and the delivery touches **no** Next route handler, BFF
adapter, transition switch or bridge. The two remaining Web surfaces that mention references are a one-line relay in
`apps/web/adapters/durable-api.ts` and its unit test; both are forwarding code whose deletion changes nothing here.
Recorded as a judgement, not as 17 being closed: 17 stays unmet on its own acceptance, and ticket 02's UI work is where
a retired-adapter difference would matter.

### Evidence

| check | command | revision | exit | result | log |
| --- | --- | --- | --- | --- | --- |
| selector run (committed tree) | `pnpm verify:changed --base=integration/client-app` | `5a963cd` (clean tree, `# dirty: false`) | 1 | `changed-typecheck` 0 (7 packages), `changed-test` 0 (protocol 67, session 57, ui 275, gateway 44, server 21, app 18 — 482 pass / 0 fail), `web-unit` 0 (57/57); `check-docs` 1 — the **same 12 pre-existing broken links**, none in a file this change touches | `.dev/verify/2026-10-20T00-52-57-714-verify-changed/` (`verify.json` names sha `5a963cd`; each step log states its own command and exit) |
| focused Backend contract | `node --test --test-reporter=tap test/conversation-references.test.ts` | `701add2` + this change | 0 | 5 pass / 0 fail: resolve + idempotency by target-plus-entry + no copied content; `entry-out-of-scope` vs `entry-missing` vs `invalid_request` with nothing stored; `target-missing` and `target-unavailable` at creation and in the resolving read; inherited fork entry and post-compaction entry validating while a sibling branch's entry is refused and the fork starts with no references; the HTTP route's named codes and the by-id read's outcome | `.dev/verify/xref01/server-references.log` |
| relations suite (updated assertion) | `node --test --test-reporter=tap test/conversation-references.test.ts test/conversation-relations.test.ts` | `701add2` + this change | 0 | 11 pass / 0 fail (5 new + 6 existing, including the renamed `target-missing` assertion) | `.dev/verify/xref01/server-references.log` |
| ingress relay (updated assertion) | `node --test --test-reporter=tap test/ingress-control.test.ts` | `701add2` + this change | 0 | 16 pass / 0 fail — the named outcome reaches the caller through the ingress unchanged | `.dev/verify/xref01/gateway-ingress-control.log` |
| history owner and catalogue/fork regression | `node --test --test-reporter=tap test/conversation-read.test.ts test/conversation-navigation.test.ts test/catalogue-binding.test.ts test/conversation-fork-source.test.ts` | `701add2` + this change | 0 | 44 pass / 0 fail — the membership fence the reference read reuses is unchanged, and the catalogue/fork projections still read as before | `.dev/verify/xref01/server-read-nav.log` |

The selector's `changed-test` step runs each package's declared `test` script, which for `@hepi/server` is three files
rather than the whole `test/` directory; the reference suites above were therefore run explicitly, which is why they are
listed separately.

Guides updated in the same change: [Chat — bounded history, older pages and the read blocks](../../../docs/chat.md#bounded-history-older-pages-and-the-read-blocks),
[Client ingress operations](../../../docs/client-ingress.md), [migration status](../../../docs/migration-status.md), and
the new term **Reference Outcome** in `GLOSSARY.md`.

Not delivered here, by the ticket's own scope: the create action, picker, follow UI and the client-side named states are
ticket 02; entry follow through the bounded target coordinator depends on history ticket 03.
