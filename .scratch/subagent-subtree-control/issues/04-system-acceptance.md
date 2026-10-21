# 04 - System acceptance

Status: resolved and **integrated** — the system acceptance was delivered on `impl/subtree-control-04`, cut
from `integration/client-app` `96fc976` (which contains tickets 01–03), and landed here as `23cef1a`, a
cherry-pick of that branch’s single commit `7cd4f79` onto `3d15c864` rather than a merge of its older base.
Evidence and commands are in [verification](../../../docs/verification.md#subtree-control-system-acceptance-2026-10-20),
with the pick re-measured on this line at
[how ticket 04 arrived](../../../docs/verification.md#how-subtree-control-ticket-04-arrived-on-this-line-2026-10-20).

Blocked by: 01, 02, 03 — all three integrated. The Web surface exercised is
`packages/ui/src/components/SubtreeControlPanel.tsx` with the client seam `packages/session/src/control.ts`
(`subtreeControl`, `subtreeRequest`); the browser harness `apps/web/e2e/ux-subtree-control.mjs` was extended (68 → 78
checks) rather than re-created, and the new system suite is `apps/server/test/subtree-control-acceptance.test.ts`
with its crash stage `apps/server/test/subtree-control-acceptance-child.ts`.

## The matrix, and where each row is asserted

| Acceptance row | Evidence |
| --- | --- |
| Nested children, including under a hidden/tombstoned display parent | A four-level tree (`root -> a -> b -> c`) beside a second subtree; `b` is removed before the request, the capture still holds `[a, b, c]`, `c` is controlled and `b` reports its own `conflict` / `session_deleted`. `subtree-control.test.ts` covers the tombstoned case alone; this suite adds the depth and the sibling subtree. |
| Selective requests cannot reach outside the authorized subtree | A selection naming the sibling subtree's child is refused whole as `409 outside_subtree` and that child's control stays `allowed`. No request in the suite ever names an id outside the capture. |
| Mixed running / held / stopping / blocked / settled states | Server: one request meeting a live draining child (`stopping`), an idle child (`accepted`), a child already held by its own stop (`held`), and — in the blocked-store test — a conversation whose own anchor is `blocked` by the runtime. Browser: a mixed-matrix request where every child records `accepted` while each child's current row states `blocked`, `interrupted` and `waiting-report`, with the child tree asserted to state the same row per child. |
| Parent stop alone remains non-cascading | The delegated-child test stops the parent before the subtree request; the parent stays `held`, and its child's control is untouched until the subtree request reaches it. `subtree-control.test.ts` also asserts the direct case. |
| Concurrent completion / new child / user control / restart replay deterministic and idempotent | Duplicate concurrent requests under one identity settle each child at revision 1; a child created while a second capture lands is either inside that capture or untouched, and the replay never adds it; a child completes during the request while the recorded outcome stays; a user's own `continue` is not reverted by a replay; a real `SIGKILL` between the first child's outcome and the rest reads back `pending` and resumes under the same id, each child at revision 1. |
| UI shows confirmation, partial failures and final states without losing navigation | Browser harness: the confirmation names the root, the count and every child with its own status; `Escape` cancels and writes nothing; a partial result with a removed child stating no row; the lost-answer read-back and resume; the refusal with the Backend's own code; and navigation still selecting and opening children while sending zero requests. |
| History, relations and queued reports remain intact | The deep-tree test compares transcripts, the queued follow-up and the relation document before and after. The delegated test compares the held parent's transcript and queued items before and after, and asserts the child's report is still queued afterwards. |
| Focused tests, typechecks, verify:changed, browser checks and docs with revision/commands/exit codes | Recorded in [verification](../../../docs/verification.md#subtree-control-system-acceptance-2026-10-20). |

## Process controls used, and why

Two, both already established in this repository and both owned by the test:

- `SIGKILL` of a child process the test started (`subtree-control-acceptance-child.ts`), because "the process died in
  this commit" is a real state and a clean close is not.
- `SIGKILL` of the execution host the test started (`recovery-acceptance-host.ts`: the gateway entrypoint in its own
  process over its own journal), because a lost command is measured against a gateway that is really gone.

Ordinary assertions use no sleeps and no timeouts: every wait polls a committed fact the product publishes. Nothing here
starts, stops or writes a deployment, and no test bypasses a security control — the suites drive the product's own
routes and the runtime's own public seams.

## Not claimed

- No power-loss, disk-full, kill-during-commit or corrupt-journal claim. `SIGKILL` is a process end, and that is the only
  window these tests stand behind.
- No exactly-once claim for an external side effect: the delegated child's killed `bash` call settles as
  `outcome_unknown` and the subtree control never replays it.
- No deployment and no service restart. Each acceptance run owns its temporary SQLite files, ports and processes.
