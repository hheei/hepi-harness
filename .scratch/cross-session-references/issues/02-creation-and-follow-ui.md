# 02 - Explicit creation and follow UI

Type: implementation
Status: in-review, integrated — delivered on `impl/xref-02-03`: source `c986a56`, and the commits above it are this
record (which changes only Markdown). That branch was cut from this line at `c1299df`, and its source and record are now
**cherry-picked onto the integration line** (`client-app-integration`, branch `main`) as `6191f82` and `42dcbc3`; the
picks were clean (`git range-diff` reports both commits identical) and re-measured on the integrated tree — see
[the integration record](../../../docs/verification.md#cross-conversation-references-how-0203-arrived-on-the-integration-line-2026-10-20).
Not pushed.
Blocked by: 01 (resolved, delivered on `impl/xref-01-target-validation` at `5a963cd`),
[history 03 - navigation jump coordinator](../../history-navigation-research/issues/03-navigation-jump-coordinator.md)
(resolved and integrated into `integration/client-app`; its `useHistoryNavigation` is the coordinator this ticket reuses)
Parent spec: [Cross-conversation references](../spec.md)

## Outcome

A user can create a reference from the conversation they are in, and follow it later to the exact target, with an honest
result when the target or entry is gone.

## Scope

Add a create-reference action to the existing references/history surface with a picker over known conversations and, optionally, their known entries. The default target is the conversation; an entry target is chosen from a stable known entry identity surfaced by that picker, never typed or inferred. An optional label uses the existing field.

Creation and follow call the existing reference owner through the client ingress. Following an entry reference navigates through the history navigation owner's bounded target coordinator: one target request, exact block placement, presentation-only scrolling. No client-side locate loop, no history reconstruction, no copied content.

Failure handling is explicit. `target-missing`, `target-unavailable`, `entry-missing`, `stale`, `cancelled` and `error` each render a named state; a temporary read failure offers retry, and a stale or missing target offers the surviving conversation view or raw history rather than a silent nearest-entry landing. A failed follow never reports success.

## Acceptance

- [x] The create action exists in the ordinary references surface, and conversation-only is the default target.
- [x] An optional entry is chosen from the picker's known entries, and the resulting reference uses the existing record and label fields.
- [x] Creating a reference stores it through the existing owner and it survives reload.
- [x] Following a conversation reference opens that conversation; following an entry reference issues at most one bounded target request and lands on the exact entry.
- [x] Deleted target, tombstoned target, missing entry, stale snapshot, cancelled follow and read error each render a distinct named state, with retry where retry can help.
- [x] No automatic reference is created by dispatch, fork, subagent or model output; fork and tombstone behaviour is unchanged.
- [x] No model tool, new schema, client reference cache or copied history is introduced.
- [x] Focused client tests cover creation, reload, follow and every failure state, with revision, exit code and logs recorded.

## Delivered

Two new files and four extended ones, all in `packages/ui` plus the browser journey that drives them:

| Path | What it owns |
| --- | --- |
| `packages/ui/src/lib/references.ts` (new) | Every decision a reference surface makes, as values: `referenceFollow` (open or refuse, and with which target), `referenceOffers` (which controls an outcome can support), `referenceWrite` (one `addReference` answer as a named state), `referenceEntryOptions` (the picker's entries, from the target's own outline), `mergeReferenceList` (the listed links, never one identity twice) |
| `packages/ui/src/components/ReferencePanel.tsx` (new) | `ReferencePanel` (the connection's API injected) and `ReferenceSurface` (the surface the acceptance renders): the list, the create action, the picker, and each link's named state and offers |
| `packages/ui/src/components/RawHistoryPanel.tsx` | Its own reference list and its own `open` read removed; the panel now places `ReferenceSurface` where that list was, so the links have one owner and creation has a home in the ordinary references surface |
| `packages/ui/src/components/ChatWindow.tsx` | One gate: a locate is not issued until the conversation's accepted `snapshotRevision` is known (see below) |
| `packages/ui/src/lib/i18n/messages/{en,zh-CN,zh-TW}.ts` | The surface's own keys, in all three locales (the locale-key scan reads them from the source) |
| `packages/ui/src/lib/references.test.mjs` (new) | Ten cases over the decisions |
| `apps/web/e2e/ux-references.{fixture.tsx,fixture.css,mjs}` (new) | The browser journey: 43 checks against the production `ReferencePanel` and `ChatWindow`, with only the network boundary replaced |

**Creation.** The action lives in the reference surface inside the Full-history panel. The target selector lists the
catalogue's conversations minus the one making the link and starts empty, so submitting stays disabled until a
conversation is chosen — conversation-only is the default, not a mode. Choosing a target reads that target's own paged
navigation outline and offers its anchors as entries; the label is the record's existing `label`. The write is
`ConversationControl.addReference` → `POST /api/conversations/:id/references`, so the record, its validation and its
idempotency are the owner's (ticket 01's seam, unchanged). A refusal renders the Backend's own outcome name plus "Nothing
was stored"; a write whose answer never arrived renders `error`, whose retry is safe because creation is idempotent by
target plus entry.

**Follow.** `referenceFollow` returns `open` with the target conversation and, when the record names one, the entry; the
surface hands both to the shell's existing open-session seam. In `AppShell` that seam selects the conversation and gives
the entry to `ChatWindow`'s `searchTarget`, which is the same hand-over a deep search hit uses and resolves through
`useHistoryNavigation`: one bounded `GET /api/conversations/:id/navigation/around`, exact block placement,
presentation-only scroll. Nothing in the panel reads a raw page or walks a continuation. A reference with an outcome
returns `refuse` and the follow opens nothing.

**Named states and offers.** `referenceOffers` derives the controls from the outcome, so a control that cannot work
cannot be painted: `target-missing`/`target-unavailable` offer none (nothing is behind them);
`entry-missing`/`entry-out-of-scope`/`stale` offer the surviving conversation and its raw history; only `error`
offers a retry. The raw-history offer is made only when an entry was named, because the raw read is addressed by one.

**The seam fix, and why it is in scope.** An entry follow into a conversation this page already remembers was refused as
`malformed`. The coordinator mints its coordinate from the conversation **and its history scope**, and
`useAgentSession`'s restored view reports `ready` with messages before its read has stated `snapshotRevision` — so
`ChatWindow`'s locate effect fired with no scope to address and the coordinator rejected the coordinate it had just
minted as unreadable. The effect now waits for `sessionData.snapshotRevision` (the existing identity, not a timer). This
is the whole of the change to `ChatWindow`: one gate and one dependency. It is in this ticket because without it a
reference cannot be followed to its entry at all.

### Scope guard, checked in this diff

- No model tool: `agent_reference` does not exist; the model tool surface is unchanged.
- No schema, store or index: the record is still `conversationId`, `entryId?`, `label?`; no client cache of references
  exists — `RawHistoryPanel`'s own list state was *removed*, not duplicated.
- No copied history: the panel holds the Backend's links and nothing of the target's content.
- No automatic references: nothing is created by dispatch, fork, a subagent spawn, model output or a history jump; the
  only writer is the user's submit. Fork and tombstone behaviour is untouched (no file under `apps/server`,
  `packages/session` or `packages/protocol` changed).
- No MCP, history-rail or deployment file was touched.

### Tickets' own acceptance, mapped to checks

| Spec sentence | Where it is checked |
| --- | --- |
| create action exists; conversation-only default | `ux-references.mjs` steps 1-2 (the entry selector starts empty, submit is disabled until a target is chosen) |
| entry chosen from the picker's known entries; existing record and label fields | `ux-references.mjs` step 3 (the stored record is `{conversationId, entryId, label}`) and `references.test.mjs` "entry options are the anchors the history owner issued" |
| stores through the owner; survives reload | `ux-references.mjs` steps 2-4 (one write request, the list re-read after a remount, no new write on reload) |
| conversation follow opens the conversation | `ux-references.mjs` step 5 (one open, no target read) |
| entry follow issues at most one bounded target request and lands on the entry | `ux-references.mjs` step 6 (one `/navigation/around` read, zero older-history pages) |
| every unavailable state renders a distinct named state with the offers it can support | `ux-references.mjs` step 7 (all six, each with its own words and its own offers) |
| a failed follow never reports success | `ux-references.mjs` step 7's last case (following an unresolvable link opens nothing) |
| refused creation says so and stores nothing | `ux-references.mjs` step 8 (`target-unavailable` and `entry-out-of-scope`) |
| no second path, no cache, no model tool | the scope guard above plus `references.test.mjs` |

`cancelled` is the one outcome the panel does not paint, because it cannot occur on this seam: it is the coordinator's
name for a follow whose conversation left the screen, and the shell retires the request in that case rather than handing
a state back to a surface that is no longer showing the conversation it belonged to. Recorded here rather than
claimed as covered.

### Evidence

Rows name the revision they were taken at. The source is `c986a56`; the commits above it are this record and change only
Markdown, which no test reads, and the selector was re-run at that branch tip after them with the same four step results
(`verify.json`: `dirty: false`). Logs are in `.dev/verify/xref02/` and the selector's own
`2026-10-20T06-08-47-686-verify-changed/` (untracked, like every run directory in this repo).

| check | command | revision | exit | result | log |
| --- | --- | --- | --- | --- | --- |
| Selector over the changed packages and their dependents | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=c1299df` | `c986a56`, re-run at the branch tip | 1 | `changed-typecheck` 0; `changed-test` 0 (ui 354, app 26, gateway 166, server 352 — 898 pass / 0 fail); `web-unit` 0 (14/14); `check-docs` 1 — the **same 12 pre-existing broken links**, 0 guides missing from the index | `.dev/verify/2026-10-20T06-08-47-686-verify-changed/` (`verify.json` names the branch tip's sha, `dirty: false`) |
| The surface's decisions | `node --test packages/ui/src/lib/references.test.mjs` | `c986a56` | 0 | 10 pass / 0 fail | `.dev/verify/xref02/references-unit.log` |
| Whole `@hepi/ui` suite (locale scan included) | `node --test $(find packages/ui/src -name '*.test.mjs' \| sort)` | `c986a56` | 0 | 354 pass / 0 fail | `.dev/verify/xref02/ui-test.log` |
| The history coordinator this ticket reuses, unchanged | `node --test packages/ui/src/lib/history-navigation.test.mjs packages/ui/src/components/NavigationOutcomeBanner.test.mjs packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs` | `c986a56` | 0 | 26 pass / 0 fail | `.dev/verify/xref02/nav-regression.log` |
| Browser: create, reload, follow, every unavailable state | `node apps/web/e2e/ux-references.mjs` | `c986a56` | 0 | `PASS`, 43 checks — the production panel and `ChatWindow` under `StrictMode`; two creations (one write each), a remount reading both back with no new write, a conversation follow with zero target reads, an entry follow with exactly one `/navigation/around` and zero older-history pages, all six outcomes with their own offers, an unresolvable follow opening nothing, two refused creations storing nothing | `.dev/verify/xref02/e2e-references.log` |
| Browser: the Rail's own scene, unchanged | `node apps/web/e2e/ux-history-rail.mjs` | `c986a56` | 0 | `HISTORY-RAIL BROWSER CHECKS PASSED` | `.dev/verify/xref02/e2e-history-rail.log` |
| Browser: ticket 03's failed-hit → Retry → landing, unchanged | `node apps/web/e2e/ux-navigation-retry.mjs` | `c986a56` | 0 | `PASS`, 8/8 — the `ChatWindow` gate added here does not disturb it | `.dev/verify/xref02/e2e-nav-retry.log` |
| Typecheck, ui and web (web runs its app and vite configs) | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | `c986a56` | 0 · 0 | no diagnostics | in the selector's `changed-typecheck` step |
| Whitespace / conflict-marker check | `git diff --check` | `c986a56` | 0 | no output | — |

**The one non-zero exit is `check-docs`, and it is not this change's.** It reports the same twelve broken relative
links every recorded run in this repository reports — ten under `.scratch/design-fixes/host/diagnosis.md` and
`.scratch/architecture-unification/issues/11-integrate-verify.md` pointing at git-ignored `.dev/verify/…` logs, two
under `.scratch/development-audit/` pointing at the ignored `.pi/skills/` tree. None is in a file this change touches,
and the count, paths and bytes are unchanged. The new `docs/chat.md` anchors resolve (0 guides missing from the index).

**No sleeps or timeouts in the tests.** The browser journey waits on rendered selectors and on the counters the fixture
advances when the request each stands for arrives, never on elapsed time; the unit cases are pure values. No bypass or
security-control probe was designed or run, and nothing under `apps/server` authorization was probed: the fixture's
"Backend" is an ordinary response stub behind the client's real request path.

### Remaining limits

- `target-unavailable` is a statement about the stored target, not a live subscription: a target removed *after* a panel
  read is listed again as unavailable on the next read or reload.
- The picker lists the catalogue's conversations, so one hidden from the catalogue is not offered (the same visibility
  rule the sidebar follows). The API still accepts it by id and the Backend validates whatever it is given.
- Entry options are one bounded outline page; a very long target offers the anchors that page states.
- The `error` state and its retry are exercised **here** over the client's real request path against a fixture Backend.
  A real transient outage of the reference routes, and the retry that lands after it, is measured by
  [ticket 03](03-acceptance.md) over the real ingress and Backend (`apps/web/e2e/ux-references-acceptance.mjs`), which
  also runs this ticket's creation, reload and follow journeys end to end.

## Notes

Entry navigation must reuse history ticket 03's coordinator. If that coordinator is unavailable, this ticket stays blocked rather than adding a second navigation path.
