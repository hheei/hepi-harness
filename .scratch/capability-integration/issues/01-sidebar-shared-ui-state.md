# 01: Shared sidebar state

**What to build:** Pins, archive, project order and the unread and running markers become one hepi session-scoped
document per backend, read and written through the backend so two windows of one backend see the same sidebar. The
client keeps applying the change optimistically and the backend applies the same rules; a refused change leaves the
sidebar exactly as it was.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Pin a session and archive another in one browser window, open a second window of the same backend and
see the same sidebar; reload and restart the backend and the arrangement is still there.

**Stories:** 1–20

**Seam:** browser → existing Web adapter → durable backend, with the real store; the shared rules also carry pure-rule
unit coverage, following the existing pure-rule suites.

- [ ] Pins, archive, project order and the unread markers survive a reload and a backend restart, read back from the
      backend rather than from browser storage.
- [ ] Two windows of one backend agree: a change made in one is visible in the other without a page reload.
- [ ] The answer to a write is the state after the change, and the client applies the same rules optimistically, so an
      optimistic change and the confirmed change cannot diverge.
- [ ] Pinning an archived session restores it, and archiving a pinned session unpins it: no session is ever in both
      bands, and a bulk pin or archive applies to every selected session as one intent.
- [ ] A bulk archive can be undone as one action.
- [ ] A refused write (an unknown action, a malformed request, a payload over the documented limit) leaves the state
      exactly as it was and reports the reason the backend gave.
- [ ] An entry for a session or project that is no longer shown is harmless and is kept, so a returning project takes
      its old place.
- [ ] The document is versioned and a document of another version is not read as this one.
- [ ] The running indicator still comes from the catalogue the shell already polls; no extra per-session request is
      added.

**Context:** [Spec](../spec.md) decisions 1–7; stories 1–20. [Design notes](../design-notes.md) record that the
upstream file-backed state is replaced by a hepi document. Read
[the breakdown](../ticket-breakdown.md#dispatch-order) before choosing work.

## What was built

- `packages/protocol/src/sidebar-state.ts` — the pure rules, the request/response shapes and the document's limits, in
  one place both sides import. `test/sidebar-state.test.ts` covers the rules directly (the pure-rule suite this ticket
  asks for), including the unread marker, the version rule, the two order budgets and the input-never-mutated rule.
- `apps/server/src/sidebar-state.ts` — the durable session-scoped document (`hepi.sidebar-state`), its read and its
  one-change-per-request write. The write applies the shared rules, bumps the revision only when something changed, and
  answers the state after the change.
- `apps/server/src/server.ts` — `GET`/`POST /api/sidebar-state`, with the content-type, body-size and parse refusals
  and the reason the caller can act on; the catalogue read carries the document's revision.
- `apps/web/adapters/durable-api.ts` — `/api/sessions/ui-state` reads and writes that document through the existing
  Web adapter seam, forwarding the body and the backend's own answer with its status; the session list and the running
  poll carry `sessionUiStateRevision`.
- `apps/web/components/SessionSidebar.tsx`, `hooks/useSessionUiState.ts`, `lib/session-tree.ts`,
  `components/SessionTree.tsx`, `hooks/useGroupDrag.ts` — the rules now come from `@hepi/protocol`, the unread marker
  is written through the same optimistic path as a pin, and the browser-storage copy of it is gone.
- `apps/web/lib/session-ui-state*.ts` (and their tests) were deleted: they were the upstream file-backed half, replaced
  by the document. `apps/web/vendor/pi-web/lib/` keeps the pinned upstream copies.

## Verification

Commands, revisions and logs are in the ticket's handoff; the short version, all on `impl/sidebar-shared-state-01`:

- `pnpm --filter @hepi/protocol test` / `typecheck` — pass.
- `pnpm --filter @hepi/server test` / `typecheck` — pass, including `apps/server/test/sidebar-state.test.ts`
  (real store, real restart, refusals, version rule).
- `pnpm --filter @hepi/web typecheck`, `pnpm --filter @hepi/web build` — pass.
- `pnpm test:web:unit` — 23 failures, the recorded pre-existing baseline, with no new name.
- `node apps/web/e2e/ux-sidebar-shared-state.mjs` — pass: two windows agree, archive/unpin and Undo, reload, backend
  restart, no unread key in browser storage, no page error.
- `node scripts/check-docs.mjs` — pass, 130 Markdown files.

The acceptance list, checked one by one:

- Pins, archive, project order and the unread marker survive a reload and a backend restart, read back from the
  backend: yes — `apps/server/test/sidebar-state.test.ts` restarts the backend on the same store, and the driver
  reloads the page and restarts the backend process.
- Two windows of one backend agree without a page reload: yes — the driver opens a second window and waits for its
  own poll to show the first window's pin.
- The answer to a write is the state after the change and both sides apply the same rules: yes — one shared function,
  applied optimistically by the client and by the backend to commit.
- Pinning an archived session restores it; archiving a pinned session unpins it; a bulk pin or archive is one intent:
  yes — the pure suite covers the band rule, the driver covers archive-then-Undo, the backend suite covers a bulk
  archive and its undo.
- A bulk archive can be undone as one action: yes — the undo snapshot carries every flag and `restore` writes them
  back in one request per chunk.
- A refused write leaves the state exactly as it was and reports the reason: yes — the backend suite asserts the state
  is unchanged after every refusal and that the reason is the machine-readable one.
- An entry for a session or project that is no longer shown is harmless and is kept: yes — asserted at the backend seam
  and in the pure suite.
- The document is versioned and another version is not read as this one: yes — the value carries its own version, the
  backend suite writes a version-2 value through the document and reads it as empty, and the pure suite covers
  `normalizeSessionUiState`'s version rule.
- The running indicator still comes from the catalogue and no per-session request is added: yes — the adapter's own
  suite asserts the running poll asks for no conversation state, and the document's revision rides on that same read.

## Review notes

Ticket 01's own recorded findings are rows 10–12 of [the review notes](../review-notes.md). Findings recorded here follow [review policy](../../../docs/agents/review-policy.md): a `record` disposition
does not reopen this ticket or add a blocking edge.
