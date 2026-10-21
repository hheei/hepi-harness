# 01 - Backend subtree operation

Status: resolved — delivered on `impl/subtree-control-01` (base `95f9257`) and merged into `integration/client-app` as `506c4ae`. Evidence below.
Blocked by: None

Add authoritative captured descendant scope and idempotent stop/interrupt operation through existing task/control seams. Persist request identity and per-child state; do not mutate history or relations.

Acceptance: nested/tombstoned scope, selective validation, authorization, mixed states, replay and crash-safe commit.

## Implementation record

Branch `impl/subtree-control-01`, base `95f9257` (`integration/client-app`). No UI (tickets 02/03), no pause/resume
redesign, no recovery/fork capability, no deploy.

### Seam

- **`apps/server/src/subtree-control.ts` (new)** — `createSubtreeControl(harness, port)`. The port is the conversation
  seam it belongs to (relations reader, by-id conversation, the removal refusal), so there is no second graph source and
  no second control path. `SubtreeControlDoc` is a conversation-scoped family (`hepi.subtree.control`, `fork: "initial"`)
  keyed by the caller's request id, holding the captured scope, the optional selection, the per-child outcomes and
  `settledAt`.
- **`conversation-operations.ts`** — two new entries on the existing `ConversationOperations` seam
  (`subtreeControl`, `subtreeControlRequest`) plus the two types; it reuses `relations`, the by-id read and
  `assertNotTombstoned`, and adds no control logic of its own.
- **`server.ts`** — `POST /api/conversations/:id/subtree-control` and `GET /api/conversations/:id/subtree-control?requestId=`
  as thin adapters; the caller is the host's own `"user"` statement, never a body field. Both `ConversationOperationRefusal`
  and `SubtreeControlRefusal` map to their own status and code.

### Behavior

- Scope is the transitive `displayParentId` descendant set, walked from the addressed conversation, computed once and
  stored: the first request under a `requestId` captures it, a replay is answered from the capture, and a child created
  afterwards is never implicitly included. The walk crosses tombstoned conversations, so a child under a hidden parent
  is still in scope; it never reads the catalogue.
- A `selected` array is validated against that captured set in the same commit that writes the record; an id outside it
  refuses the whole request `409 outside_subtree` and writes nothing, and an empty array is `400`.
- Each child gets its own durable outcome — `accepted`, `stopping`, `held`, `already-settled`, `refused`, `not-found`,
  `conflict`, `pending` — and its current control state; `partial` states whether any child was not simply controlled.
- `stop` calls each child's own `Conversation.stop` under the request id and the trusted user source; `interrupt` calls
  `Conversation.abort`, which withdraws queued input and sets no hold. Neither touches history, relations or tombstones,
  and the addressed conversation's own control is never changed, so a parent stop stays local.
- Outcomes are committed **per child, as that child settles** — not collected and written after the last one answers.
  A request with one settled child and one still draining therefore reads that child's own outcome beside the other's
  `pending`, and the same `requestId` resumes with only the children that have no outcome yet. Committing after
  `Promise.all` left every child `pending` for the whole drain, so a retry or a restarted process resumed into a child
  the request had already controlled and aborted work the user had started on it since; `test/subtree-control-progress.test.ts`
  holds the slow child inside its model answer and asserts both halves of that (the mid-flight record, and a retry that
  leaves the settled child's new work alone).
- Remaining limit, recorded rather than claimed closed: `stop` is idempotent under its id because `Conversation.stop`
  records the receipt in the same commit as the abort marks. `interrupt` has no receipt — the native `abort()` commits
  abort marks and no per-request record — so a process killed **between** a child's abort landing and that child's outcome
  commit can still be retried into aborting later work on that child. Closing that window needs an abort receipt committed
  with the marks at the runtime's own seam; this operation cannot write one, and a coordinator-side shadow registry of
  "already aborted" children is not a substitute for it.

### Verification

Source-branch runs (made on `d572428`, the branch's final source commit):

| Check | Command | Revision | Exit | Log |
| --- | --- | --- | --- | --- |
| New public-API suite | `cd apps/server && node --test test/subtree-control.test.ts` | `b036798` | 0 (8/8) | rerun inside the selected-checks log below |
| Crash/resume suite | `cd apps/server && node --test test/subtree-control-crash.test.ts` | `b036798` | 0 (1/1) | same |
| Selected checks | `pnpm verify:changed --base=integration/client-app` | `b036798` (clean) | 1 | `.dev/verify/2026-10-18T08-44-47-017-verify-changed/` |

Delivered source commit: `b036798` on `impl/subtree-control-01` (base `95f9257`); the two commits after it
(`bff3105`, `659948d`) are this ticket record and its own wording, so no source changed and the run above is reused
rather than repeated. The `verify:changed` run was made with a clean tree (`dirty: false` in `verify.json`) and reports
`changed-typecheck` exit 0 and `changed-test` exit 0 —
`pnpm --filter @hepi/server -r test`, 464 tests passing, `# exit code: 0` in `changed-test.log`. Its `check-docs` step
exits 1 on the
**12 broken relative links that already exist at the base revision** — the same 12 names, verified by running
`node scripts/check-docs.mjs` in a detached `95f9257` worktree (`/tmp/subtree-base`, exit 1, 12 broken, identical set
diff). No new broken link and no missing guide is introduced; `docs/chat.md` gains the section the feature needs and
`docs/migration-status.md` records the capability and that it has no UI yet.

### Merge into `integration/client-app`

Fast-forward was not possible: the integration tip `95f9257` is an ancestor of the source tip, so the merge is a
no-conflict `ort` merge commit with the source tip as the second parent.

| Check | Command | Revision | Exit | Log |
| --- | --- | --- | --- | --- |
| Subtree suites | `cd apps/server && node --test test/subtree-control.test.ts test/subtree-control-crash.test.ts` | `506c4ae` | 0 (9/9) | inline |
| Neighbour suites | same command plus `conversation-stop-continue` and `conversation-relations` | `506c4ae` | 0 (33/33) | inline |
| Selected checks | `pnpm verify:changed --base=95f9257` | `506c4ae` (clean) | 1 | `.dev/verify/2026-10-18T09-00-28-855-verify-changed/` |

The merged-tree `verify:changed` run reports `changed-typecheck` exit 0 and `changed-test` exit 0
(`pnpm --filter @hepi/server -r test`, 464 tests passing), and its `check-docs` step exits 1 on the same **12** broken
relative links that exist at the pre-merge integration base: `node scripts/check-docs.mjs` in a detached `95f9257`
worktree reports 12 broken, and the broken-file set diff against the merged tree is empty. Nothing else in the
integration branch changed — the merge adds exactly the 15 files listed above and no conflict resolution was needed.

What the tests assert, at the public seams only:

- nested scope stopped while the addressed conversation and the child's transcript/relations are untouched;
- a child created after the capture is not included by a replay, and the replay records no second control change;
- a selection outside the capture refuses with `outside_subtree` and changes nothing, an empty selection is `400`, and a
  selection inside it governs exactly that subset;
- mixed running/held/idle children answer `stopping` / `held` / `accepted` in one request;
- `interrupt` withdraws the queued input, sets no hold and records no control revision; a parent stop alone does not
  cascade and a later subtree stop still reaches the child;
- a child under a tombstoned display parent is in scope while the removed child itself reports `conflict` /
  `session_deleted`, and addressing the removed conversation is refused;
- a fresh process over the same SQLite file answers the same captured request and records no second control change;
- a real `SIGKILL` inside the capture commit leaves `pending` per-child outcomes that the same request id resumes to
  `accepted` without stopping a child twice.

### Limits recorded

- Authorization is inherited, not re-implemented: `stopSource` is the host's own statement and each child's
  `Conversation.stop` applies the runtime's existing source rule, so an agent-origin request can never downgrade a user
  stop. The record stores the source the capture was made under, so a replay cannot substitute a different caller. No
  `agent_*` tool exposes this operation, so the model's surface is still the five per-conversation tools; the reach a
  subtree request has is exactly the captured display-descendant set and nothing else.
- The operation controls what the display relation says, which is the durable relation this build writes. A conversation
  created by an older build without `displayParentId` is not a descendant of anything.
- Per-child control calls run concurrently and their outcomes commit afterwards in the captured order, so the answer
  states a total order but not a wall-clock one. An `interrupt` waits for its child's ordinary scope to drain, so a
  child whose run ignores the abort signal delays only the answer of its own request.
- Receipt retention is the runtime's: an evicted `requestId` is re-evaluated as a fresh request, which for this
  operation means the capture is re-walked. It is bounded by the same per-conversation retention every control receipt
  already has.
