# 04 - System recovery acceptance

Status: resolved — G3, G4 and G5 **measured**, no product source changed
Blocked by: 01, 02, 03
Measured at `1873d24`, re-measured on the `c2d9089` integration tip, and re-measured again on the current tip `c070e7e`
merged in — all in `.dev/worktrees/child-recovery-03` on branch `impl/child-recovery-03`. The table's rows 1-14 are the first
tree, 15-23 the second, **24-31 the delivered one**; the code those rows measure is the committed test tree `4666584`.

## What was added

Four new files and one fixture option set, all under `apps/server/test/`, and nothing else:

| Path | Role |
| --- | --- |
| `recovery-acceptance.test.ts` | the four crash assertions, run in the parent test process |
| `recovery-acceptance-child.ts` | the stages: `child-bash` (G3), `mid-generation` (G4), `anchor-legacy`/`anchor-v2` (G5) |
| `recovery-acceptance-host.ts` | starts/kills/restarts a real **gateway process** over its own SQLite journal, plus a transparent request witness and a raw replay call |
| `subagent-anchor-v2.ts` | a version 2 anchor definition with **no** `migrate`, and one with it, to produce the two disagreeing-version stores |
| `subagents-crash-harness.ts` (modified) | two fixture options only: `executionGateway` (commands run on an external gateway process) and provider pacing passthrough |

Method, unchanged from `acceptance-recovery.test.ts` / `acceptance-failure.test.ts`: reach the window with a real process,
end it with `SIGKILL`, reopen the **same** SQLite path through the product's own entrypoint, and compare what the durable
records say with what the surfaces publish. Every reopened store has exactly one owner — the HTTP backend for stores the
backend or a crash stage wrote, the crash harness for stores the harness wrote.

## What was measured, and what it says

### G3 — a delegated child's command whose gateway process dies

The child's `bash` runs on a gateway in **another process**, over its own journal. The kill is triggered by the command's
own effect on the host (a line in `effect.log`), not by a sleep, so the call provably was admitted, dispatched and answered
by nothing. Read after the child settles, from the child's own committed transcript:

- exactly **one** `isError` tool result, matching `/outcome_unknown/u`, `/the command may have run and its outcome is not
  established/u`, `/this call is never replayed/u`, and naming the child's own scoped call ID (`<childId>:…call-hang…`);
- one execution request sent, one only;
- the child continued on that stated outcome ("child settled") and its report reached the parent;
- no ordinary task of either conversation left `running`, and every surviving task is a **background** one;
- after the restart on the same journal, the **identical** request (replayed from the captured wire bytes, not a rebuilt
  fixture) answers `ok: false`, code `outcome-unknown`, the **same** `callId`, the gateway's own message
  `gateway restarted while the call was running`, and the effect file still holds one line: it was not run twice;
- the reopened child, read over HTTP, keeps the relation (`createdBy`, `subagentParentConversationId`, workspace), keeps the
  error text and the spent ID, and both conversations project `{ state: "idle" }` — a lost command is not a failed delegation;
- reopening needed **zero** provider requests.

Recorded limit: this bounds duplicate execution to **one journal owned by one gateway**, which is the claim the ledger can
honestly make (invariant 8). It is not cross-process exactly-once.

### G4 — a process killed while an answer streams

The backend is killed the instant a generation partial is committed, proved by the stage's own reads: a prefix
(`tok-0 tok-1 tok-2…`) present in `live.generation.message`, `busy: true`, no committed answer, exactly one provider request
made. After reopen of the same store:

- the committed partial survives as **exactly one** assistant entry whose `stopReason` is `aborted`, and its text is that
  prefix grown, never shortened or replaced; `partial` is empty (no live text from a dead process);
- the reopened run takes the interrupted turn up **by itself** — nobody re-submits — and asks the catalog **once**, with
  `roles === "user"` and the user's own text `"stream the answer"`;
- both statements stay oldest-first: `[user, assistant(aborted), assistant(resumed)]`. Nothing is overwritten, no duplicate
  answer, and the dead request is not replayed.

**Capability limit found here, and now recorded:** the resumed request is handed the conversation as it stood **before** that
answer began — the retained partial is a fact for readers, not model context. So a generation interrupted mid-answer is
*restated*, not *continued*. Fixing that belongs to upstream generation checkpointing, not to a projection here.

### G5 — a task record whose version this build cannot name

Both cases come from a real delegation admitted by a real anchor task, then killed inside the admission, so the store holds
a non-terminal anchor:

- **`task_too_old`** — a store written by a build whose anchor definition is version 2, reopened by this build's version 1:
  the catalogue row the user reads is `{ state: "blocked", reason: "task_too_old" }`, on both the first read and a re-read;
- **`migration_failed`** — this build's own version 1 record met by a version 2 definition with no `migrate`: blocked with
  the runtime's reason, its error message matching `/version 2 has no migration from 1/u`, and the record itself untouched
  (still version 1, still non-terminal, still owned by the parent);
- in both, the child conversation, its entries and the dispatch record stay readable, and the same reason is what
  `projectRunStatus` publishes — no silent migration, no guessed state;
- the control on the same store, this build's own definition against this build's record, is **not** blocked: the block is
  caused by the version disagreement alone.

## The G1 conversion is now measured end to end, not only at the unit seam

`red-muted-conversion.log` mutes only the conversion owner (`packages/gateway/src/environment.ts`'s `outcome_unknown:`
rewrite) with the acceptance suite otherwise intact: the child is then handed upstream's generic
`<harness>\n[error] outcome-unknown\n</harness>` and the assertion on `/outcome_unknown/u` fails — the exact mislabeling
ticket 02 fixed, now demonstrated across a real second process rather than at the unit seam.

`red-status-mutation.log` mutes the `blocked` branch of `apps/server/src/subagents/status.ts`: the same G5 case then projects
`{ state: "idle" }` where the runtime states `migration_failed`, which is the drift that branch exists to prevent.

Both mutations were reverted before the green runs; `git diff apps/server/src packages/*/src` is empty for the green log set.

## Commands, exit codes, raw logs

Run at `1873d244289db29e5aaa62118e3dfc1b30ffabb5` in `.dev/worktrees/child-recovery-03`, Node v26.5.1, pnpm 12.4.1,
`pnpm install --frozen-lockfile` exit 0 (linked from the workspace store). Logs under
`.dev/verify/child-recovery-03/` (git-ignored). Row 9's report records `dirty: true` over exactly this ticket's tree —
the four new test files, the fixture option and the four docs — with source SHA `1873d24`; rows 13-14 re-run the acceptance
and fork evidence after the last doc edit, which changed no source.

| # | Command (cwd) | Exit | Result the log states | Log |
| --- | --- | --- | --- | --- |
| 1 | `node --test --test-name-pattern="child's command" test/recovery-acceptance.test.ts` (apps/server, conversion owner muted) | 1 | 1 test, 0 pass, 1 fail — `AssertionError: The input did not match the regular expression /outcome_unknown/u. Input: '<harness>\n[error] outcome-unknown\n</harness>'` | `red-muted-conversion.log` |
| 2 | `node --test --test-name-pattern="migration_failed" test/recovery-acceptance.test.ts` (apps/server, `blocked` branch muted) | 1 | 1 test, 0 pass, 1 fail — `actual: { state: 'idle' }`, `expected: { state: 'blocked', reason: 'migration_failed' }` | `red-status-mutation.log` |
| 3 | `node --test test/recovery-acceptance.test.ts` (apps/server) | 0 | 4 tests, 4 pass, 0 fail (G3 784 ms, G4 455 ms, task_too_old 432 ms, migration_failed 445 ms) | `ticket04-recovery-acceptance.log` |
| 4 | same, re-run to show the crashes are not timing-lucky | 0 | 4 tests, 4 pass, 0 fail | `ticket04-recovery-acceptance-rerun.log` |
| 5 | `node --test test/session-fork.test.ts test/conversation-fork-source.test.ts test/child-fork-crash.test.ts test/conversation-relations.test.ts` (apps/server) — ticket 03's evidence | 0 | 18 tests, 18 pass, 0 fail | `ticket03-fork-evidence.log` |
| 6 | `node --test test/*.test.ts` (packages/gateway) | 0 | 411 tests, 411 pass, 0 fail — the gateway family is untouched by this ticket | `ticket04-gateway-full.log` |
| 7 | `node --test test/*.test.ts` (apps/server) | 0 | 472 tests, 472 pass, 0 fail (468 baseline + the 4 new) | `ticket04-server-full.log` |
| 8 | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` (repo root) | 0 | two `tsc --noEmit` runs, no diagnostics | `ticket04-typecheck.log` |
| 9 | `pnpm verify:changed --base=1873d24` (repo root, at the tested tree) | 1 | `changed-typecheck` 0; `changed-test` **1** on 472 tests / 471 pass / 1 fail: `a text turn still uses the configured provider, endpoint and key`, `SyntaxError: Unexpected end of JSON input`; `check-docs` 1 | `.dev/verify/2026-10-18T18-44-53-162-verify-changed/{verify.json,changed-test.log,check-docs.log}` |
| 10 | `node --test test/*.test.ts` (apps/server, row 9's failing package re-run whole) | 0 | 472 tests, 472 pass, 0 fail | `ticket04-server-full-rerun.log` |
| 11 | `node --test test/provider-config.test.ts` (apps/server) ×3 | 0, 0, 0 | 5 tests, 5 pass every run | `ticket04-provider-config-1.log`, `-2`, `-3` |
| 12 | `node scripts/check-docs.mjs` (repo root, at this tree) | 1 | 375 Markdown files, **12** broken relative links, 0 uncovered guides; all 12 under `.scratch/` and byte-identical (`diff` empty) to the same command run at the detached `1873d24` worktree, which reports 12 over 376 files | `ticket04-check-docs.log`, `base-docs.log`, `base.links.txt`, `03.links.txt` (all retained) |
| 13 | `node --test test/recovery-acceptance.test.ts` (apps/server) and `node --test test/session-fork.test.ts test/conversation-fork-source.test.ts test/child-fork-crash.test.ts test/conversation-relations.test.ts` (apps/server), re-run after the doc edits | 0, 0 | 4 tests, 4 pass, 0 fail; 18 tests, 18 pass, 0 fail — the doc edits changed no source, so the tested tree is the delivered tree | `ticket04-final-acceptance.log`, `ticket03-final-fork.log` |
| 14 | `node scripts/check-docs.mjs` (repo root, after the doc edits) | 1 | 375 files, **12** broken links, `diff` against the `1873d24` baseline list empty | `ticket04-check-docs.log`, `base-docs.log`, `base.links.txt`, `03.links.txt` |

### Re-measured on the latest integration tip before reporting

`integration/client-app` had moved 20 commits past `1873d24` (provider relay ticket 02, SSH workbench ticket 03, subtree
child-session ticket 02, plus integration docs), so it was merged into this branch as `b1676f0` — `git merge --no-ff`,
auto-merged `docs/architecture.md` and `docs/migration-status.md` with **no conflict and no hand resolution**, and
`git diff --exit-code 5c6458e -- <this ticket's five test paths> packages/gateway/src/environment.ts` exits **0**, so the
measured tree carries the acceptance suite and ticket 02's conversion owner verbatim.

| # | Command (cwd) | Exit | Result the log states | Log |
| --- | --- | --- | --- | --- |
| 15 | `pnpm install --frozen-lockfile` (repo root, at `b1676f0`) | 0 | lockfile up to date, resolution skipped, 9 workspace projects | `merged-install.log` |
| 16 | `node --test test/recovery-acceptance.test.ts` (apps/server) | 0 | 4 tests, 4 pass, 0 fail | `merged-recovery-acceptance.log` |
| 17 | `node --test test/session-fork.test.ts test/conversation-fork-source.test.ts test/child-fork-crash.test.ts test/conversation-relations.test.ts` (apps/server) | 0 | 18 tests, 18 pass, 0 fail | `merged-fork-evidence.log` |
| 18 | `node --test test/*.test.ts` (apps/server) | 0 | **477** tests, 477 pass, 0 fail (the tip's 473 plus this ticket's 4; no provider-config flake in this run) | `merged-server-full.log` |
| 19 | `node --test test/*.test.ts` (packages/gateway) | 0 | **438** tests, 438 pass, 0 fail (the tip's own count; the gateway is untouched by this ticket) | `merged-gateway-full.log` |
| 20 | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` (repo root) | 0 | two `tsc --noEmit` runs, no diagnostics | `merged-typecheck.log` |
| 21 | `pnpm verify:changed --base=c2d9089` (repo root, at the merge) | 1 — `check-docs` only | `changed-typecheck` 0, `changed-test` **0** (477/477, 0 fail), `check-docs` 1; `dirty: false`, sha `b1676f0`, scoped to `@hepi/server` only (a test-and-docs change) | `.dev/verify/2026-10-18T18-52-17-426-verify-changed/{verify.json,changed-test.log,changed-typecheck.log,check-docs.log}` |
| 22 | `node scripts/check-docs.mjs` and the same with `--root=.dev/baselines/c2d9089` (a detached worktree of the tip) | 1, 1 | both report 385 Markdown files and **12** broken links; the `diff` of the two sorted lists is empty — this branch adds no broken link and its new links resolve | `merged-check-docs.log`, `merged-base-check-docs.log`, `merged.links.txt`, `merged-base.links.txt` |
| 23 | `pnpm verify:changed --base=integration/client-app` (repo root) | 1 — `check-docs` only | `changed-typecheck` 0, `changed-test` **0** (477 tests, 477 pass, 0 fail), `check-docs` 1 on the same 12 links; `dirty: false`, sha `7fe6774` (a docs-only commit on this branch — every later commit changes Markdown only, so this is the gate run against this branch's tree), packages `[@hepi/server]`, testSelection `full`; `git diff --exit-code integration/client-app..HEAD -- apps/server/src packages` exits 0 | `.dev/verify/2026-10-18T18-57-17-450-verify-changed/{verify.json,changed-test.log,changed-typecheck.log,check-docs.log}` |

Rows 3-12 above are the evidence for the tree as originally cut at `1873d24`; rows 16-22 are the same checks on the
`b1676f0` merge; rows 24-31 are the whole set again on the latest integration tip. **Rows 24-31 are the ones to cite
forward.**

Row 9's single failure is the **already-recorded flake**: `docs/agents/verification.md` notes "an earlier run of this same
revision had one `apps/server` provider-config case fail on an empty stub response body, and the package alone re-ran
286/286 green", and ticket 02's rows 10–12 are the same event at the same seam. Rows 10–11 are the evidence that it is not
this change: the whole package passes twice over, that file alone passes three consecutive times, and the failing case
reaches no route this ticket touches. Nothing in this branch changes a provider-config path — `git diff --name-only 1873d24`
is four new test files, one test fixture option set, and four Markdown documents.

### Re-measured on the latest integration tip (ticket 04 acceptance)

`integration/client-app` moved 8 more commits past `c2d9089` (MCP grant scope, history-navigation 02 and the App
connection/read-recovery work), so it was merged again as merge commit `e505dc6` — `git merge --no-ff`, **no conflict** on
any path this branch touches, and no hand resolution: the merged `docs/architecture.md`, `docs/local-integration.md` and
`docs/migration-status.md` still carry this ticket's sections verbatim (`git diff --stat c070e7e..HEAD` is this ticket's 11
files and nothing else). The tip's own suite grew (server 477 -> 541, gateway 438 -> 481), so the whole-package runs below
are the tip's counts with this ticket's 4 added.

One test-file change came out of the re-run and is committed separately as `4666584`: each of the four tests now removes
its own `mkdtemp` store in `t.after`, the way `acceptance-recovery.test.ts` and `acceptance-failure.test.ts` already do.
Without it every run left four SQLite stores and their workspaces under `/tmp` (115 accumulated here), which is a fixture
leak, not a behaviour change — the assertions are untouched and the suite passes identically before and after.

| # | Command (cwd) | Exit | Result the log states | Log |
| --- | --- | --- | --- | --- |
| 24 | `node --test test/recovery-acceptance.test.ts` (apps/server, on the merged tree) | 0 | 4 tests, 4 pass, 0 fail — G3, G4, `task_too_old`, `migration_failed` | `merged-tip-recovery-acceptance.log` |
| 25 | same, re-run to show the crashes are not timing-lucky | 0 | 4 tests, 4 pass, 0 fail | `merged-tip-recovery-acceptance-rerun.log` |
| 26 | `node --test test/session-fork.test.ts test/conversation-fork-source.test.ts test/child-fork-crash.test.ts test/conversation-relations.test.ts` (apps/server) — ticket 03's evidence | 0 | 18 tests, 18 pass, 0 fail | `merged-tip-fork-evidence.log` |
| 27 | `node --test test/*.test.ts` (apps/server, on the merged tree) | 0 | **541** tests, 541 pass, 0 fail (the tip's 537 plus this ticket's 4) | `merged-tip-server-full.log` |
| 28 | `node --test test/*.test.ts` (packages/gateway, on the merged tree) | 0 | **481** tests, 481 pass, 0 fail — the gateway is untouched by this ticket | `merged-tip-gateway-full.log` |
| 29 | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` (repo root) | 0 | two `tsc --noEmit` runs, no diagnostics | `merged-tip-typecheck.log` |
| 30 | `pnpm verify:changed --base=c070e7e` (repo root) | 1 — `check-docs` only | `changed-typecheck` 0, `changed-test` **0** (541 tests, 541 pass, 0 fail), `check-docs` 1 on the same 12 links; `dirty: false` at a Markdown-only revision of the measured tree, packages `[@hepi/server]`, testSelection `full` | `.dev/verify/2026-10-19T11-25-07-769-verify-changed/{verify.json,changed-test.log,changed-typecheck.log,check-docs.log}` |
| 31 | `node scripts/check-docs.mjs` and the same with `--root=.dev/baselines/c070e7e` | 1, 1 | both report **432** Markdown files and **12** broken links; the `diff` of the two sorted lists is empty — the same 12 pre-existing `.scratch/` links, none in a file this branch adds | `merged-tip-check-docs.log`, `merged-tip-base-docs.log`, `merged-tip.links.txt`, `merged-tip-base.links.txt` |
| 32 | `git log --oneline 1873d24..c070e7e -- apps/server/src/subagents packages/gateway/src/environment.ts packages/gateway/src/execution.ts` (repo root) | 0 | **no commits** — the claim the three guides make ("no source in between touching these paths") is this command's output, not an assumption. Over the same range `apps/server/src/server.ts` does change (MCP tool adaptation, subtree session rows, navigation windows), which is why rows 27-28 re-ran both whole packages rather than only these files | — |

Also checked on the merged tree: `pgrep -f packages/gateway/src/main.ts` is empty after the suite (each stage kills or
closes its own host), and `ls -d /tmp/recovery-03-*` is empty after the cleanup commit, so a run leaves no process and no
store behind. The branch's own diff against `integration/client-app` is 11 files: four new test files, one fixture option
set, and six Markdown documents.

Row 30 ran `dirty: false` and its own report names the revision it ran at. Rows 24-30 measure the tree merged in `e505dc6`,
whose code is the committed test change `4666584`: every commit after `e505dc6` on this branch changes Markdown only, so
`git diff --exit-code e505dc6..HEAD -- apps packages` exits **0** and the later record writes cannot move the measurement.
`git diff --stat c070e7e..HEAD` is this ticket's 11 files and nothing else.

After the wording edits the acceptance suite and ticket 03's fork evidence were run again, with the documentation check
(`delivered-tip-recovery-acceptance.log` 4/4, `delivered-tip-fork-evidence.log` 18/18, `delivered-tip-check-docs.log` 432
files and the same 12 broken links — a **dated** result: those links were git-ignored local `.dev/` evidence, and the
current documentation revision reports 0 broken links, so 12 is this ticket's baseline, not today's). Those runs land on
Markdown-only commits, which is precisely what the code-equality
statement above makes harmless: the fixture and the assertions it measures are the ones `4666584` committed.

## Ticket text discharged

- *identities, checkpoint/outcome, effect counts and visible state* — call ID, dispatch/anchor/reporter task IDs, child and
  parent conversation IDs, one effect line, one tool result, one aborted entry, one provider request, and the catalogue row
  each surface reads, are each asserted above.
- *no unsafe replay, no exactly-once overclaim* — the restarted journal refuses the spent ID and the side effect stays at one
  line; the interrupted generation is not replayed; the wording in `docs/local-integration.md`, `docs/architecture.md` and
  `docs/migration-status.md` states the ledger's scope as one journal and calls the cross-process result conservative safety.
- *no security bypass test* — the allowlist, the token and the ledger identity are used exactly as ticket 01 left them; no
  case reaches a path by widening a permission.
- *no retries, no replay-policy change* — zero product source changed; nothing re-earns a spent identity.
- *power-loss / disk corruption out of scope* — `SIGKILL` is a process end, stated in the suite header and in every doc
  paragraph this ticket added.
- *owning docs synced in the same change* — `docs/architecture.md` (three new measured boundaries under the subagents
  section), `docs/local-integration.md` (the lost-answer paragraph gains its end-to-end evidence), `docs/migration-status.md`
  (G3–G5 moved from "unmeasured" to measured, the G4 capability limit recorded, G2/G6 left open), `GLOSSARY.md` needs no new
  term: every word used here is the runtime's own state or reason name.
- *acceptance report with exact revision, commands, exit codes and logs* — this table.

No integration merge, graph rebuild, deployment or service restart was run; `graphify-out/graph.json` is stale for these new
test files (no node exists for `recovery-acceptance-host.ts`), so every symbol above was confirmed in source and in the
installed `pi-durable` 1.3.0 dist rather than by graph query. Delivered as `impl/child-recovery-03`.
