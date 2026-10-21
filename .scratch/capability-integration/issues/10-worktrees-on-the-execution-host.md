# 10: Worktree list, create and remove on the execution host

**What to build:** The execution host gains the worktree operations the Web UI already has controls for: list the
worktrees of a registered root, create one on a chosen branch, and remove one, with the upstream contract's semantics —
a create requires an existing root and a branch, and a dirty removal is refused unless force is asked for.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Against a real git repository on the gateway: list the worktrees, create one on a branch, see it in the
list, remove it, and be refused when removing a dirty one without force.

**Stories:** 59, 60, 61, 62, 63, 64, 65, 66

**Seam:** the execution host's public contracts, asserted on the local gateway and on the isolated localhost SSH
gateway. The SSH half is skipped only when the fixture is genuinely unavailable on the runner, and the skip is
reported rather than hidden.

- [x] The host surface lists the worktrees of a registered root, and creating one answers the created worktree.
- [x] A create with a missing or unregistered root, or with no branch, is refused before anything is written on the
      host (assert no directory was created and no git state changed).
- [x] Removing a worktree removes it from the host and from the next listing.
- [x] Removing a dirty worktree without force is refused as a distinct, readable dirty outcome, and the same removal
      with force succeeds.
- [x] A listing for a worktree that no longer exists falls back to the inferred Project root instead of failing.
- [x] A host that cannot serve worktree operations answers a named limit rather than a generic failure.
- [x] Every case above is asserted on a local gateway and on the isolated localhost SSH gateway.

**Context:** [Spec](../spec.md) decisions 26, 27, 28; stories 59–66. The gateway's workbench surface is read-only
today, so these are new host operations, not adapter wiring.

## What was built

The host operation is new, as the ticket says: `POST /v1/worktrees` on the gateway, with `GatewayWorktrees` running git
on this machine and `SshWorktreeServer` running the same git argv through the existing `SshRunner`, so both hosts apply
one set of rules (`packages/gateway/src/worktrees.ts`). The semantics are pi-web's, whose `lib/worktree.ts` and route
`apps/web/lib/worktree.ts` already carries verbatim:

| Request | Answer |
| --- | --- |
| `{ operation: "list", workspaceId }` | `{ projectRoot, isGit, isTopLevel, currentWorktreePath, worktrees: [{ path, branch, isMain }] }` |
| `{ operation: "create", workspaceId, branch }` | `{ path, branch }` |
| `{ operation: "remove", workspaceId, path, force? }` | `{ removed }` |

- A create is refused before anything is written: an unknown id is `unknown_workspace`, a registered directory that is
  no checkout is `invalid_root`, a missing or blank branch is `invalid_request`, and an unusable branch name (only
  separators) is `invalid_request`. The test asserts git's own view of the repository and its parent directory are
  unchanged after each refusal.
- A remove of the main checkout is `main_worktree`; of a path that is no worktree of this repository,
  `not_a_worktree`. A removal git refuses for uncommitted work answers `dirty` with git's own message, and
  `force: true` is a separate request that succeeds — the distinction the ticket asks for.
- A listing for a root whose checkout is already gone falls back to the repository the `-worktrees` convention names
  and reports that repository as the project root, so a stale entry does not fail. Prunable entries, and any listed path
  that is not a directory on the host, are left out.
- A host that cannot serve the capability answers `not_supported` with its own name — a gateway composed without a
  worktree surface, and a host without git, both do. A transport failure names its own state (`unreachable`,
  `outcome_unknown`) and never answers from the gateway machine's own repository.
- The runner is given the directory the gateway itself resolved, never a request-supplied one, so the SSH transport's
  workspace confinement is not weakened by this capability. A worktree necessarily lives outside the workspace, which is
  why the gateway's own resolution is what is passed.

Verification (`impl/capability-10`, base `76e75f7`): `pnpm --filter @hepi/gateway typecheck` exit 0;
`pnpm test:gateway` 88 pass / 0 fail (8 new cases in `packages/gateway/test/worktrees.test.ts`);
`pnpm test:server` 167 pass / 0 fail. The SSH half runs against a real localhost `sshd` (isolated fixture) and is
skipped, with the skip reported, only when that fixture is unavailable. Every wait is an observable state; no sleeps.

## Review notes

- **Recorded: the create path runs two extra git reads before `git worktree add`.** Upstream does the same (an
  existence check for the branch and for the remote tip); here each is a separate call, so a create on an SSH host costs
  one more round trip than the minimum. Trigger: none in ordinary use — a create is a rare, user-initiated action.
  Impact: a fraction of a second. Revisit if worktree creation is ever measured as slow on a remote host.
- **Recorded: two creates racing on one branch.** Both can pass the pre-checks and the second `git worktree add` fails
  with git's own message, answered as `operation_failed`. Trigger: two clients creating the same branch at the same
  moment. Impact: the loser sees a readable git refusal and the winner's checkout is untouched. Revisit if a user reports
  a confusing failure from a concurrent create.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
