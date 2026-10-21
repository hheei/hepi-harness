# Submit stall: integration merge

**Status: executed.** `integration/chat-lifecycle` was `44c485f`; the resources slice merged as `3a571cb` and the
Web slice as `0f9f5ab`. The commands, exit codes and log paths of the combined validation are in
[`spec.md`](spec.md#integrated-record). This file is kept as the plan the merge followed.

## What merges

| Half | Branch | Tip | Owns |
| --- | --- | --- | --- |
| Resources (slice 1) | `impl/submit-stall-snapshot` | `a715a0a` (carries the reviewed `9060e17`) | `packages/gateway` snapshot producer, the helper's ignore engine, `apps/server/src/workspace-resources.ts`, the server and gateway resource tests, `docs/upstream-sources.md`, this record |
| UI (slice 2) | `impl/submit-stall-ui` | `7a71932` | `apps/web` turn staging and preparation status |

Base: `integration/chat-lifecycle` at `44c485f` (the product `f603a48` tip).

## The merge is conflict-free (probed)

`git merge-tree --write-tree --name-only <resources> 7a71932` exits 0 with no conflict list, and a real probe merge
confirms it: `probe/submit-stall-merge` is `44c485f` + `c275372` + `7a71932` as `a658916`, both merges clean
with no conflicted path. The probe runs in the working worktree so it reuses the installed dependencies; the branch is
kept so the heavy combined run does not have to redo it, and it must be re-cut if either tip moves.

Combined tree at the probe: `pnpm -r typecheck` exit 0, `pnpm -r test` exit 0 (9 + 47 + 3 + 140 + 244 tests,
0 failures). Logs `/tmp/probe-tc.log`, `/tmp/probe-test.log`.

## Sequence once cleared

    cd .dev/worktrees/chat-lifecycle-integration
    git merge --no-ff impl/submit-stall-snapshot   # resources
    git merge --no-ff impl/submit-stall-ui         # UI
    pnpm graphify update .                         # or ~/.local/bin/graphify update .

Then the combined verification, on that merged revision only:

    pnpm verify --profile=fast                                  # typecheck + workspace tests
    pnpm --filter @hepi/web build
    node apps/web/e2e/chat-lifecycle-foreground.mjs              # browser, 55 checks
    node apps/web/e2e/ux-submission-recovery.mjs                 # recovery, 31 checks
    node --test apps/server/test/resource-snapshot.test.ts \
               apps/server/test/workspace-resources.test.ts \
               packages/gateway/test/resource-snapshot.test.ts \
               packages/gateway/test/ignore-parity.test.ts        # real resource cases, local and real sshd

Record the revision, each command's exit code and its log path in `docs/verification.md` under the resources
section, and update the migration entry if the counts move.

## Not in this merge

- No deployment, no image build, no publish. `docs/README.md` keeps its "no later deployment has been recorded"
  statement until a deployment actually happens.
- The ~300 s idle SSE teardown (`BodyTimeoutError`) recorded in `diagnosis.md` is a separate finding and is not
  touched by either half.
- The reported sustained multi-second stall is neither reproduced nor claimed fixed.
