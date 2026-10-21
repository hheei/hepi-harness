# 03 - Explicit continuation fork

Status: resolved — **evidence-based decision, no implementation and no new spec**
Blocked by: 01
Measured at `1873d24` (`integration/client-app`, the tree ticket 04 is measured on).

## What the ticket asked

Use the audit evidence to decide whether a **distinct user-controlled fork workflow** is needed when a task cannot safely
resume — and only if it is warranted, write a separate behavior spec. Implementation was never authorized here.

## Decision

**No. Recovery does not need a fork workflow, and the fork the ticket describes already exists.**

Two independent reasons, both from evidence rather than preference:

1. **The recovery mechanism is already correct without a fork.** When a child cannot safely resume, the runtime does not
   need a new conversation: the anchor and its dispatch record are durable and state their own reason. An interrupted
   **unsafe** tool call is claimed once and never rerun (spec principle 2), so the child's tool task settles with the
   execution error the harness produced; an interrupted model request resumes from the checkpoint as a fresh request; a
   task whose version the build cannot name is blocked with the runtime's reason. In every case the conversation, its
   history and the parent's dispatch record stay inspectable. The spec's own wording matches this state: *"a failed child
   is still a running conversation that holds recoverable tasks — not a flag."* A fork would not change any of these
   outcomes; it would only move the user to a copy.
2. **A fork for "the task cannot resume" is a recovery-triggered fork wearing a user action, which this spec forbids.**
   Spec out-of-scope: *"automatic fork-on-failure"* and *"does not authorize automatic child forks"*; principle 6: *"Fork is
   a user branch, not recovery replay."* The ticket's phrasing — fork *when a task cannot safely resume* — describes a
   workflow whose trigger is a runtime failure state. Making a UI button the trigger does not make it a user branch
   decision: the product would be recommending abandonment of the conversation whose tasks the runtime just declared
   non-resumable, and the alternative the spec prefers is that the user reads the stated reason and chooses.

The **general** case — a user who wants to branch from an established position, whatever moved them to it — is not a gap:
it is delivered behavior, and it is already `SIGKILL`-tested.

## Evidence for that delivered behavior

| Requirement in the ticket | Measured by | Case |
| --- | --- | --- |
| distinct user-controlled workflow | `apps/server/test/session-fork.test.ts` | `forks at a chosen entry: the copy carries the history up to it and the source is unchanged`; `a fork of a task-owned child gets its own background anchor, not the child's task and not an ownerless copy`; `a fork of a missing, unsaved or empty session is refused with a reason and creates nothing` |
| native source position | `apps/server/test/conversation-fork-source.test.ts` | `a fork inherits the source's history at the named entry, with its own owner, relations and request identity`; `an entry that is not in the source's own history is refused, and nothing is created` |
| as-of configuration | both files | `the branch keeps the source position's configuration and an explicit override replaces it`; `the branch starts from the configuration in force at its entry, and an explicit override replaces a field` |
| execution binding, provenance | `conversation-fork-source.test.ts`, `conversation-relations.test.ts` | the creation seam writes owner, relations, workspace and request identity in one commit; `HTTP create/get/catalogue/reference distinguish creator, display parent, fork source and owner` |
| non-inheritance of running tasks / queue / control | `session-fork.test.ts` | `a live run in the source keeps running while it is forked` (the branch is **not busy**, and the source's run settles undisturbed); `a fork of a task-owned child gets its own background anchor, not the child's task and not an ownerless copy` (the branch's own state is `control: allowed` with `{ steering: [], followUp: [] }`, and it gets its **own** anchor); `the fork is the runtime's own, so its conversation-scoped documents follow the fork semantics` — `RelationsDoc`/`ReferencesDoc` declare `fork: "initial"`, so a branch starts with none |
| no implied effect rollback | `apps/server/test/child-fork-crash.test.ts` | `a real SIGKILL between the branch's commit and its answer still answers the same branch on replay` — the branch is created once under the request identity; nothing about the source's effects is restated |

All 18 cases pass at `1873d24`, at the `c2d9089` integration tip and on the delivered tree:
`.dev/verify/child-recovery-03/ticket03-fork-evidence.log`, `merged-fork-evidence.log` and
`delivered-tip-fork-evidence.log` — each 18 tests, 18 pass, 0 fail.

The user-initiated surface is the one that exists today: the HTTP fork route (`POST /api/conversations/:id/fork`, optional
entry) and `ConversationOperations.forkConversation`/`session-fork`, with the source's own fork-aware membership check as the
only position rule. Nothing auto-submits the old intent, because no recovery path calls fork at all.

## What a "fork because recovery failed" workflow would actually cost

Recorded so the decision can be revisited on evidence rather than re-argued:

- it needs a **new trigger vocabulary** (which blocked/interrupted states offer a fork), and that vocabulary is exactly the
  per-object recovery projection gap **G2** the audit called a product decision — a fork button would be the first consumer
  of a projection this line deliberately did not build;
- it needs a product answer to a question the spec refuses to answer here: what the user is told the fork *undoes*. The
  source conversation stays running with its tasks; a branch does not resolve a non-resumable child, so the control would
  advertise abandonment;
- it duplicates **G6**'s real need: what a user who wants to try again wants is a **retry** of the preparation (replay of the
  delegation request identity), not a fresh conversation with no context. G6 stays a recorded product decision.

If a user request ever supplies the evidence — "I could not continue this child, I needed a branch" — then the right next step
is a **separate behavior spec** for that control, written against G2/G6 together, not a change to recovery. That spec is
not this ticket: G2/G6 were approved by the user after it closed and are stated as pending work in
[ticket 02](02-projection-gaps.md#approved-pending-work-2026-10-20), with no fork anywhere in them.

## Commands, exit codes, logs

Run at `1873d24` in `.dev/worktrees/child-recovery-03`, Node v26.5.1, pnpm 12.4.1 (deps already linked for ticket 04's run).

| # | Command (cwd) | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| 1 | `node --test test/session-fork.test.ts test/conversation-fork-source.test.ts test/child-fork-crash.test.ts test/conversation-relations.test.ts` (apps/server) | 0 | 18 tests, 18 pass, 0 fail | `.dev/verify/child-recovery-03/ticket03-fork-evidence.log` |

No product source changed for this ticket — this file, `docs/migration-status.md` and `docs/architecture.md` are the whole
change, and the ticket 04 acceptance files land on the same branch. No integration merge, graph rebuild, deployment or
service restart; delivered as `impl/child-recovery-03`.
