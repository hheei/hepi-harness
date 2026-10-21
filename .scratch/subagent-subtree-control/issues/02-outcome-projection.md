# 02 - Outcome projection

Status: resolved and **integrated** — implemented on `impl/subtree-control-02`, merged into `integration/client-app`as
`2cc7d0d` (final integrated tip of this batch `bbd0d59`). The integration record is below, then the branch's own.
Blocked by: 01 (resolved)

Project operation and child task/control state through existing session status APIs. Reconcile completion, user control, restart, Gateway interruption and partial failures without aggregate-state lies.

Acceptance: exact per-item outcomes, race refresh, no duplicate operation, preserved reports/queues.

## Merge into `integration/client-app`

Status: resolved — implemented on `impl/subtree-control-02` (source `4b45f60`, gates at `a4487a3`), merged into
`integration/client-app` as `2cc7d0d` (`--no-ff`, `ort`, parents `afbe2e9` + `0b96176`). No conflict, no hand resolution.

The branch merges the integration tip `1873d24` at `2df33af`, so nothing was lost on either side; `git merge-tree
--write-tree` previewed clean before the merge. Two paths overlap and both auto-merged: `docs/chat.md` (this ticket's
subtree paragraphs at ~162-194 against the cutover's draft-store sentence at ~666) and `docs/migration-status.md` (~179
here, ~42/~574/~640/~701 there). `apps/server/src/server.ts` is this branch's alone among the code paths — the two other
serial merges of this batch touched only `packages/gateway/src/{index.ts,workbench/*,ingress/*}` — and `packages/gateway/
src/index.ts` was left untouched by choice, which is why gateway kept 411 until the SSH half arrived.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Whole server family on the merged tree (5 projection cases, incl. the SIGKILL recovery case) | `node --test apps/server/test/subtree-control-projection.test.ts apps/server/test/execution-scope.test.ts` | merged tip `bbd0d59` | 0 (7/7) | `.dev/verify/merge-client-app-12/seam-server.log` |
| Whole server suite | `pnpm verify:changed --base=1873d24` (`changed-test` → `@hepi/server -r test`) | `2cc7d0d` → tip `bbd0d59` (`dirty: false`) | 0 | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/changed-test.log` |
| Typecheck (app, server, web, gateway, ui) | `pnpm verify:changed --base=1873d24` (`changed-typecheck`) | `bbd0d59` | 0 | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/changed-typecheck.log` |

Row 10's own `473/473` for `pnpm --filter @hepi/server -r test` is **confirmed unchanged on the merged tree**: `changed-test`
reports server **473** at `bbd0d59`, with the MCP/recovery work and the two other merges of this batch present. Nothing
about this ticket's projection needed re-deriving — the files are byte-identical to `0b96176`
(`git diff --exit-code 0b96176 -- apps/server` exits 0 at the merged tip; the only later additions are the web relay
tickets' provider/ingress paths). `check-docs` at the merged tip exits 1 on the same 12 pre-existing links (385 files,
`.dev/verify/merge-client-app-12/broken-merged.txt` diffs empty against the `80608d6` baseline).

No build on `remote-host`, no deployment, no push, no graph rebuild (the coordinator runs the integrated batch). Ticket 03
(Web control) is unblocked by this merge; ticket 04's system acceptance is the remaining gap, and the
`docs/migration-status.md` line naming ticket 03 as the remaining UI gap is now accurate.

## Implementation record

Branch `impl/subtree-control-02`, base the integration tip (`b51926b`, then the ticket's own merge of `1873d24`). No UI (ticket
03), no new route, no scheduler, no polling loop, no change to what `stop`/`interrupt` do.

### Seam

- **`apps/server/src/server.ts`** — one projection, `subtreeAnswer`, mounted on the two subtree routes it belongs to. It
  reads the facts the catalogue already reads (`catalogueFacts`: one `harness.inspect` plus the queue facts this process
  already holds) and attaches each child's own `catalogueEntry` as `outcome.session`. The operation module,
  `ConversationOperations` and the capture/outcome commit are untouched: the durable record stays the record, and the
  projection is an answer, not a second state path.
- The projected half is the **same** projection the session list and the running poll publish — asserted field for field
  against `GET /api/conversations`, not paraphrased into a subtree-specific status.

### Behavior

- Each outcome states two facts about one child and neither rewrites the other: `status` (with its `reason`) is what the
  request recorded when it reached that child, `control` is the child's committed control now, and `session` is what the
  child is doing now in the vocabulary the rest of the product already uses.
- **Race refresh, no aggregate lie.** A child the stop reached reads `stopping` while it drains; once its run settles the
  same request id reads `stopping` over `session.runStatus.state: "held"`. A child the user resumed on its own through
  its own control route reads the request's `accepted` over `"running"`, then `"idle"` when that turn finishes — its
  recorded outcome never restated from the present. A child the request never reached (`pending`) still states its real
  row.
- **Restart and partial failure.** A request a real SIGKILL left mid-way reads back `pending` with both children's live
  rows and their control `allowed`, and the same id resumes it; the recovery read itself controls nothing and records no
  control change. A removed child keeps its `conflict`/`session_deleted` outcome and states **no** `session` — a
  conversation the catalogue does not list gets no row a surface could never show — while its sibling's row stays
  truthful and `partial` stays `true`.
- **Reports and queues preserved.** A delegated child with a real report queued in its held creator reads
  `waiting-report` — not `idle`, and not borrowed from the parent's state — across the operation, a replay and a recovery
  read, with the queued item, the transcript and the creator's control revision unchanged.
- Nothing new polls: the row is read on the same request that answers the operation.

### Verification

Made on the branch tip `a4487a3` — the feature commit `4b45f60` (`impl/subtree-control-02`), its merge of
`integration/client-app@1873d24` (`2df33af`) and these records; clean tree, `dirty: false` in `verify.json`:

| Check | Command | Revision | Exit | Log |
| --- | --- | --- | --- | --- |
| New projection suite (5 tests) + ticket 01 suites (9 tests) | `cd apps/server && node --test test/subtree-control-projection.test.ts test/subtree-control.test.ts test/subtree-control-crash.test.ts` | `a4487a3` | 0 (14/14) | `changed-test-apps-server.log` |
| Selected checks | `pnpm verify:changed --base=integration/client-app --test-file=apps/server/test/subtree-control-projection.test.ts --test-file=apps/server/test/subtree-control.test.ts --test-file=apps/server/test/subtree-control-crash.test.ts` | `a4487a3` | 1 (see below) | `.dev/verify/2026-10-18T13-12-28-153-verify-changed/` |
| Whole server suite | `pnpm --filter @hepi/server -r test` | `2df33af` | 0 (473/473) | direct run |
| Typecheck | `cd apps/server && pnpm typecheck` | `a4487a3` | 0 | `changed-typecheck.log` |

`verify:changed` reports `changed-typecheck` exit 0 and `changed-test-apps-server` exit 0 (14 `ok` lines,
`# exit code: 0` in `changed-test-apps-server.log`). Its `check-docs` step exits 1 on **12 pre-existing broken relative links** in
`.scratch/architecture-unification`, `.scratch/design-fixes` and `.scratch/development-audit` documents pointing at
untracked `.dev/verify` artifacts and skill paths; `docs/chat.md`, `docs/migration-status.md` and this record are not
among them and the same 12 failures are on the base (recorded for ticket 01 in
[01-backend-operation.md](01-backend-operation.md)). No browser or Gateway change is involved: the projection is backend
answer shape, and the row it attaches is the one the existing running poll already consumes.

The new suite is `apps/server/test/subtree-control-projection.test.ts`. It drives the real HTTP surface over a
test-owned SQLite file, with one fixture on a real local Gateway host so the delegated child, its anchor, its reporter
and its queued report are the production ones, and it reuses ticket 01's `subtree-control-crash-child.ts` to obtain a
genuinely SIGKILL'd request rather than a simulated one.

### Docs

`docs/chat.md#subtree-stop-and-interrupt` states the per-child session row, the reconciliation rule and the
no-row-for-an-unlisted-child rule; `docs/migration-status.md` now names ticket 03 as the remaining (UI) gap and states
that the backend answer carries each child's current session row.
