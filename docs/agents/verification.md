# Verification and baseline comparison

Before comparing baselines or reporting verification results, read this. It records the mistakes that produced wrong
verification claims in this repository, and the practice that prevents each one.

## Reporting a check

State the command, the source revision it ran against, the actual exit code, and the path to the raw log. "Passed" or
"236 tests" without those is not a result. Report what the log says, not what you expected it to say.

The shipped commands differ in how much of that they carry:

- `pnpm verify:changed`, `pnpm verify --profile=fast|full` and `pnpm test:web:unit` run their steps through the shared
  runner, so each step gets a raw log plus a JSON report naming the command, the SHA, the dirty state and the exit code
  under the git-ignored `.dev/verify/<timestamp>-<label>/`.
- `pnpm compare:tests --base=<SHA>` writes `comparison.json` and a per-side log under the same directory.
- `pnpm check:docs` and `pnpm check:entrypoints` are plain read-only checks: they print their finding and exit non-zero,
  write a report only with `--json=<path>`, and record no SHA — you name the revision you ran them on.
- `pnpm deploy:inspect` and `pnpm deploy:plan` touch nothing; raw probe output on a failure goes to a git-ignored
  `.dev/deploy-inspect/` file and is deliberately kept out of the report.
- Every one of these answers `-h`/`--help` with the flags it really has and refuses an argument it does not understand
  with exit 2, so a typo cannot silently run a workflow.

## Coverage

Follow the [test layout and TypeScript convention](../developer-guide.md#test-layout-and-typescript).
`pnpm typecheck` checks workspace code/tests and the root tooling tests; `pnpm -r typecheck` alone omits root tooling.

Use an explicit, recursive file list. A glob like `*.test.ts` silently misses nested suites, and a directory form
(`node --test src e2e`) may be rejected outright by the installed Node. `pnpm test:web:unit` enumerates the Web suite
and records the list it used, so cite that list rather than a second glob.

## Baselines

A baseline is the pinned revision checked out on its own, not the current tip. Create it with
`git worktree add --detach <dir> <sha>` and run there. `pnpm compare:tests --base=<SHA>` does this itself, into
`.dev/baselines/<sha>`, and installs that worktree's dependencies before running — a missing `node_modules` there
would fail the baseline for a reason unrelated to either revision, so its install exit code is reported and stops the
comparison instead of being assumed.
Each side runs its own `scripts/test-web-unit.mjs`; that revision owns discovery, so a language migration in the
caller cannot change which files a historical revision measures.

The **tip** is pinned the same way: checked out detached at `HEAD` in its own worktree, so the comparison is between two
revisions and never between the tip and the tree you happen to be sitting in. A dirty caller tree is reported —
`comparison.json` records `caller: {sha, dirty, dirtyFiles}` — but it is not evidence about either revision. The run
reads that state and leaves it alone: same `HEAD`, same index, same stash list, same files. `--cleanup` removes both
worktrees when the run is done; the logs and the report stay under the log directory.

`git stash` is **shared across every worktree** of a repository. Stashing, popping, or resetting to obtain a baseline
therefore compares the current tree against itself, and can clobber another worktree's entry. A no-op `git stash push`
creates no owned entry, so it never authorizes touching the stash list; never pop or clear entries you did not create,
and never reset a dirty tree to change what a baseline measures.

## Known failures

A failure that predates your change stays recorded, not excused and not hidden. `pnpm check:entrypoints` reports every
file argument a script names, so a second missing entry file cannot hide behind a first that exists; it prints the
known-missing entries it carries and fails only on a newly missing one, and that list is empty at this revision.

`pnpm check:docs` depends on the checkout it walks. Links into git-ignored evidence (`.dev/verify/…`) and into the
untracked `.pi/` skill store resolve only in a checkout that holds them, so a fresh worktree or baseline reports them
broken while the same commit checked out with its local artifacts reports none. Compare the `BROKEN` set against a
baseline checkout rather than reading a count as a property of the revision, and attribute only the links a change
actually added.
Historical Web failure sets describe their tested source; report the current suite's real exit status. A
user-prioritized cleanup can retire obsolete tests with a recorded functional disposition and replacement seam, but it
does not erase the historical result or implement an undelivered capability.

## Reuse

Reuse a check that already ran against unchanged source. Re-run only when the source changed, a check failed, or the
result is uncertain. A docs-only edit does not require a product suite re-run, and a deployment alone does not start a
new verification cycle. The selector replaces manual package selection and log bookkeeping, not behavioral judgment:
add integration or browser checks when the changed contract needs them.

## Isolation

Each run owns its build output, ports and logs, and cleans up its own processes by PID. A fresh worktree gets its own
build output; never rebuild or disturb the main checkout's. Leaked listeners (for example a fixture
`sshd` whose parent was killed before its cleanup ran) hold ports for later runs: check for them, and kill only the
processes your run owns.

## Published artifacts and copied code

A notice or copyright that must travel with copied code has to be **inside the published artifact** — the emitted
bundle and the packed tarball — not merely in the repository's own `LICENSE`. Verifying "the repo ships the upstream
MIT text" does not establish that the bundle carries the required copyright line; assert the artifact.

## Comparing failure sets

Compare **exact failure names, including nested ones**, not just counts.
`pnpm compare:tests --base=<SHA>` reads both TAP logs, strips only each checkout's own prefix, and reports the names
new on the tip and the names only on the base; the verdict is that name set, so two revisions with the same `# fail`
count and a different failing test are reported as different. A TAP log has both a runner failure counter and a
set of `not ok` names; they differ (a file's own rollup plus its nested child assertion), so neither number alone is the
failure count. Normalizing names by stripping punctuation hides real differences; strip only what is genuinely noise,
such as an absolute workspace prefix. A leaf/file-rollup split inferred from "the name contains a slash" is unreliable,
because real user-API test names contain slashes too.

## What to fix

Apply [review policy](review-policy.md): judge ordinary likelihood and actual user impact. A pre-existing baseline failure
stays recorded, not repaired; a difference is a finding to classify, not a standing invitation to fix everything.
