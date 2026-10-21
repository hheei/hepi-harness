# 03: Session delete

**What to build:** Deleting a session removes it from the catalogue and from search, as an ordinary removal the user is
not told anything further about. The runtime has no conversation or entry deletion, so the records are retained and the
removal is a hepi-owned tombstone written through the durable document path — never a direct database deletion.

**Blocked by:** 01: Shared sidebar state

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Delete a session from the sidebar and watch it leave the list without a reload; the session's own
records still read back through the durable API, and its pin and archive entries are gone.

**Stories:** 27, 28, 29, 30, 31, 32

**Seam:** browser → existing Web adapter → durable backend, with the real store.

- [x] A deleted session leaves the catalogue and the sidebar without a page reload, and is absent from search results.
- [x] The conversation's own entries and records still read back through the durable API after the delete, proving no
      direct database deletion happened.
- [x] The tombstone is written through the same durable document path as other hepi state, and its owning seam carries
      a comment recording that the records are retained because the runtime lacks a deletion primitive and that the
      code should be replaced when that primitive exists.
- [x] Deleting a session clears its pin and archive entries in the same operation, so no orphan entry remains in the
      sidebar document.
- [x] Deleting a session that is currently running is answered as success and does not block on the run; the session
      refuses a new turn with a readable reason afterwards.
- [x] Deleting a session that has children leaves every child listed and openable, deletes no child, and leaves no
      surface reporting a parent that is gone.
- [x] A failed deletion says what failed, and deleting an unknown session is refused with a readable reason.
- [x] Two windows of one backend agree after the delete.

**Context:** [Spec](../spec.md) decisions 9, 10, 11, 6; stories 27–32. The tombstone is what the shared sidebar
document's entry cleanup depends on, which is why ticket 01 blocks this one.

## What was built

- `apps/server/src/session-tombstone.ts` — the owning seam. `TombstoneDoc` is a conversation-scoped durable document
  (`hepi.deleted`, `history: "latest"`, `fork: "initial"`) whose presence is the whole fact; the module carries the
  specification's retention comment verbatim, and `tombstoneConversation` writes it and clears the given ids' pin,
  archive and unread entries in the same commit. `fork: "initial"` is what keeps a copy out of a removed source's
  tombstone while `hepi.title` and the execution workspace keep following it.
- `apps/server/src/sidebar-state.ts` — the write is split so another hepi operation can clear entries inside its own
  commit: `applySidebarStateTx(tx, request, now)` is the transaction form and `writeSidebarState` is the same call
  under one commit. The clear reuses the shared rules' `restore` action, so the removal adds no second rule.
- `apps/server/src/server.ts` — `DELETE /api/conversations/:id` (the upstream route's meaning, honoured through the
  durable document path); the catalogue filters removed conversations; the tombstone is kept current from the same
  commit stream the title uses, so a catalogue read costs no per-conversation request; `POST …/messages` on a removed
  conversation is refused with `code: "session_deleted"`; and a fork reports no parent once its source is removed, so
  no surface names a conversation that is gone.
- `apps/web/adapters/durable-api.ts` — `DELETE /api/sessions/<id>` forwards to that operation and passes its status
  and reason through.
- `apps/web/components/SessionSidebar.tsx` — the removal goes through the existing adapter seam, drops the row without
  a page reload, re-reads the shared sidebar state (its entries were cleared with it), and reports a refusal as a
  failed removal that leaves the row where it is. `sidebar.deleteFailed` is added to all three locale packages.
- Nothing is deleted from any store: the runtime has no deletion primitive, and no direct database statement is
  written for this operation.

## Verification

Commands, revisions and logs, all on `impl/session-delete-03` over integration `76e75f7`:

- `pnpm --filter @hepi/server typecheck`, `pnpm --filter @hepi/web typecheck` — exit 0.
- `pnpm verify --profile=fast` — exit 0, PASS/PASS (workspace typecheck and workspace tests, 173 server tests);
  log `.dev/verify/2026-10-11T14-41-42-982-verify-fast/`.
- `node --test apps/server/test/session-delete.test.ts` — 6 pass, 0 fail.
- `node --test apps/web/adapters/session-delete.test.mjs` — 3 pass, 0 fail.
- `node --test components/SessionSidebar.test.mjs lib/sidebar-actions.test.mjs adapters/durable-api.test.mjs
  lib/i18n/registry.test.mjs` — 64 pass, 0 fail.
- `pnpm test:web:unit` — 23 failures, the recorded pre-existing baseline, with no new name.
- `node apps/web/e2e/ux-session-delete.mjs` — pass, 30 checks: production Next build, real backend over a real SQLite
  store, real local gateway, two real browser windows and the sidebar's own row menu and delete confirmation.
- `node scripts/check-docs.mjs` — exit 0, 130 Markdown files; `node scripts/check-entrypoints.mjs` — exit 0, 0 newly
  missing.

The acceptance list, checked one by one:

- Leaves the catalogue and the sidebar without a page reload, and is absent from search results: yes — the row is
  asserted detached in the removing window and, with no other signal, in a second window on its own poll; the catalogue
  read the search reads from no longer lists it (search itself is ticket 05, which reads this catalogue).
- The records still read back through the durable API: yes — the transcript is compared entry by entry after the
  removal, in the backend suite and in the driver, and the tombstone itself is read back through `snapshot()`.
- Written through the durable document path, with the required comment at the owning seam: yes —
  `apps/server/src/session-tombstone.ts` carries the comment verbatim and the test asserts it, and the seam contains
  no direct store statement.
- Pin and archive entries cleared in the same operation: yes — one commit writes the tombstone and applies the shared
  rules' `restore`; the backend suite and the driver both read the document back and find no entry for the removed id
  and none left over.
- Deleting a running session is answered as success without blocking, and a new turn is refused with a reason: yes —
  the backend suite holds a real run inside its provider response and asserts the answer arrives while the run is still
  busy, that the run then settles into the retained records, and that `session_deleted` is the refusal; the driver
  asserts the same against a held model endpoint.
- Children stay listed and openable, none deleted, no parent reported: yes — a fork's row stays, reads back with its
  own entries, still accepts a turn, and the catalogue reports no parent for it once the source is removed.
- A failed deletion says what failed and an unknown session is refused: yes — the sidebar shows
  `sidebar.deleteFailed` with the backend's reason and leaves the row, and `not_found` is asserted at both seams.
- Two windows agree: yes — the second window drops the row on the poll it already makes and reads the cleared entries
  from the backend.

## Review notes

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | The catalogue keeps a removed conversation in this process's map for the life of the process, and the tombstone watch is one subscription per conversation, exactly as the title watch already was. Nothing prunes either. | The map already held every conversation; the removal adds one boolean per entry, so ordinary use sees no effect. | `record` | A deployment is shown to hold an unbounded number of removed conversations, or the per-conversation subscription count is shown to matter. |
| 2 | A conversation forked from a removed source keeps the source's entry as its `parent`, and the catalogue stops reporting the relation while the source is removed. Re-forking the child reports no origin either. | The relation is display metadata; the copy's own history and rows are unaffected, and a removed source is not shown anywhere. | `record` | A user needs the ancestry of a fork whose source was removed. |
| 3 | A removed conversation's own conversation-scoped documents (`hepi.title`, the execution workspace) are retained with the records, so a later re-creation of the same id would inherit them. Ids are never reused by the runtime. | Not reachable in ordinary use: durable conversation ids are never reused. | `record` | Conversation ids are ever reused, or a removed conversation is ever resurrected. |

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
