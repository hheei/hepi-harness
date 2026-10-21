/**
 * Baseline comparison: run the same suite at two pinned revisions - the base and the tip's
 * own HEAD - and compare the two TAP logs by exact failure name.
 *
 * Both sides run in their **own detached worktree**, so the caller's tree is only ever read
 * and neither side is judged against something it did not check out. That matters twice over:
 *
 * - the tip is the commit, not the caller's working copy. A run in the caller's dirty tree
 *   would be reported against a revision whose bytes it did not measure.
 * - `git stash` is shared by every worktree of a repository, so obtaining a baseline by
 *   stashing compares the tree against itself and can clobber another worktree's entry.
 *   Nothing here stashes, resets or writes to a caller's tree.
 *
 * Each side keeps its own log directory (`base/`, `tip/`), because two runs writing one
 * `<step>.log` would leave only one of them behind.
 *
 * The caller's own tree is *reported* and never measured: its SHA and dirty state are recorded
 * beside the comparison so an operator knows what the run did not cover, while the tip evidence
 * stays the pinned commit the tip worktree holds.
 *
 * A side that never ran is **not** a pass. If a checkout produced no TAP output, or failed to
 * start - a fresh worktree missing its dependencies is the common shape - the result is an
 * infrastructure failure and is reported as one, never as an "identical failure set", which is
 * what an empty-versus-empty comparison would otherwise look like.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baselineDir, ensureBaselineWorktree, removeBaselineWorktree, resolveRevision } from "./baseline.mjs";
import { gitOutput, gitState, runStep, writeJson } from "./cli.mjs";
import { compareTap, parseTap } from "./tap.mjs";

/**
 * Dependencies a worktree needs before its suite can run.
 *
 * A fresh worktree has no `node_modules`, so the suite would fail for a reason that has
 * nothing to do with either revision. `pnpm install --frozen-lockfile` fills them in from the
 * shared store; it writes only inside that directory, and its own exit code is reported rather
 * than assumed.
 */
export function ensureBaselineDependencies(dir, { install = true, marker, logDir, echo = false } = {}) {
  if (!install) return { ok: true, skipped: true, dir };
  if (existsSync(join(dir, marker))) return { ok: true, skipped: true, dir };
  const record = runStep(
    { name: "baseline-install", command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: dir },
    { logDir, env: process.env, echo },
  );
  return { ok: record.exitCode === 0, skipped: false, dir, record };
}

/** Run `suiteStep(dir)` in `dir` and return its TAP text, exit code and log path. */
export function runSuite(dir, suiteStep, { logDir, echo = true }) {
  const record = runStep(suiteStep(dir), { logDir, env: process.env, echo });
  const text = record.stdout + (record.stderr === "" ? "" : "\n" + record.stderr);
  return { text, record, exitCode: record.exitCode, logPath: record.logPath, dir };
}

/** Messages a runner prints when it failed to start rather than reported a test result. */
const STARTUP_FAILURE = [
  "Cannot find module",
  "Cannot find package",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "command not found",
  "ENOENT",
];

/** A failure name that is just a file: that file failed to load, no test in it ran. */
const FILE_ONLY_NAME = /\.(mjs|cjs|js|ts|tsx)(:\d+)?$/;

/**
 * Whether a side's output is a real test run.
 *
 * Three shapes mean it is not, and all three are ordinary in a worktree that was never
 * installed:
 * - no TAP at all (the runner died before printing anything);
 * - a TAP plan that ran zero tests;
 * - a run whose every failure is a bare test *file* and whose output names a startup error:
 *   the module failed to load, so nothing inside it was measured, and comparing that against
 *   the other side would compare two different sets of unrun tests.
 */
export function tapRun(text) {
  const { summary, names } = parseTap(text);
  const declared = /^TAP version \d+/m.test(text) || Object.keys(summary).length > 0;
  const startupFailure = STARTUP_FAILURE.find((line) => text.includes(line)) ?? null;
  const fileOnly = names.length > 0 && names.every((name) => FILE_ONLY_NAME.test(name));
  if (!declared) return { ran: false, startupFailure, reason: "produced no TAP output, so it did not run a suite" };
  if ((summary.tests ?? 0) === 0 && summary.fail === undefined) {
    return { ran: false, startupFailure, reason: "reported no tests, so it did not run a suite" };
  }
  if (startupFailure !== null && fileOnly) {
    return { ran: false, startupFailure, reason: "failed to load its test files (" + startupFailure + "), so no test ran" };
  }
  return { ran: true, startupFailure: null };
}

/** Describe a side that produced no test run, with the smallest useful evidence. */
function infraDetail(side, run) {
  const { ran, startupFailure, reason } = tapRun(run.text);
  if (ran) return null;
  const firstOutputLine = run.text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "(no output)";
  return {
    side,
    dir: run.dir,
    exitCode: run.exitCode,
    startupFailure: startupFailure ?? null,
    firstOutputLine,
    logPath: run.logPath,
    reason,
  };
}

/**
 * Compare a revision against the current tree's HEAD.
 *
 * Returns everything a result needs: both revisions, both exit codes, both TAP summaries, the
 * failure names new on the tip and the names only on the base, and both raw logs. `newOnTip`
 * is what a change must be judged by - a count that matches across two revisions does not mean
 * the same tests failed.
 *
 * `cleanup` removes both worktrees once the suites have run. The logs live in `logDir`, outside
 * the worktrees, so the evidence survives it.
 */
export function compareBaseline({
  repoRoot,
  base,
  suiteStep,
  logDir,
  baseDir,
  tipDir,
  install = true,
  installMarker = "node_modules",
  cleanup = false,
  echo = true,
}) {
  // Resolve the revision before creating anything: a branch name or a short SHA is a request,
  // and each worktree has to hold the commit it names, not the spelling.
  const sha = resolveRevision(repoRoot, base);
  if (sha === undefined) {
    return { ok: false, stage: "revision", detail: "unknown revision: " + base, base };
  }
  // The caller's tree is read, never measured: whatever is uncommitted here is outside the
  // comparison, and saying so is the difference between a narrow result and a wrong one.
  const caller = gitState(repoRoot);
  const tipSha = gitOutput(repoRoot, ["rev-parse", "HEAD"]).trim();
  if (tipSha === "") {
    return { ok: false, stage: "revision", detail: "the tip checkout has no commit to compare", base };
  }

  const resolvedBaseDir = baseDir ?? baselineDir(repoRoot, sha);
  const resolvedTipDir = tipDir ?? baselineDir(repoRoot, tipSha);
  const worktree = ensureBaselineWorktree(repoRoot, sha, resolvedBaseDir);
  if (!worktree.ok) {
    return { ok: false, stage: "worktree", detail: worktree.detail, baseDir: worktree.dir, base, sha };
  }
  const tipWorktree = ensureBaselineWorktree(repoRoot, tipSha, resolvedTipDir);
  if (!tipWorktree.ok) {
    return { ok: false, stage: "worktree", detail: tipWorktree.detail, tipDir: tipWorktree.dir, base, sha, tipSha };
  }

  for (const [side, dir] of [["base", worktree.dir], ["tip", tipWorktree.dir]]) {
    const dependencies = ensureBaselineDependencies(dir, { install, marker: installMarker, logDir: join(logDir, side), echo });
    if (!dependencies.ok) {
      return {
        ok: false,
        stage: "dependencies",
        side,
        detail: "pnpm install failed in the " + side + " worktree (exit " + dependencies.record.exitCode + ")",
        logPath: dependencies.record.logPath,
        baseDir: worktree.dir,
        tipDir: tipWorktree.dir,
        base,
        sha,
        tipSha,
      };
    }
  }

  // One log directory per side: two runs writing one step log would keep only the last, and the
  // discarded side's evidence is exactly what a comparison has to show.
  const baseline = runSuite(worktree.dir, suiteStep, { logDir: join(logDir, "base"), echo });
  const tip = runSuite(tipWorktree.dir, suiteStep, { logDir: join(logDir, "tip"), echo });

  const infra = [infraDetail("base", baseline), infraDetail("tip", tip)].filter(Boolean);
  const comparison = infra.length === 0
    ? compareTap(baseline.text, tip.text, {
        // Only each checkout's own directory is stripped, so a genuine difference in a test
        // name survives normalization.
        basePrefixes: [worktree.dir],
        tipPrefixes: [tipWorktree.dir],
      })
    : null;

  const cleaned = cleanup
    ? [removeBaselineWorktree(repoRoot, worktree.dir), removeBaselineWorktree(repoRoot, tipWorktree.dir)]
    : [];

  const record = {
    caller: { sha: caller.sha, dirty: caller.dirty, dirtyFiles: caller.dirtyFiles, comparedTipSha: tipSha },
    base: { sha, dir: worktree.dir, exitCode: baseline.exitCode, logPath: baseline.logPath, ...(comparison?.base ?? {}) },
    tip: { sha: tipSha, dir: tipWorktree.dir, exitCode: tip.exitCode, logPath: tip.logPath, ...(comparison?.tip ?? {}) },
    cleanedUp: cleanup,
    infra,
    newOnTip: comparison?.newOnTip ?? [],
    onlyOnBase: comparison?.onlyOnBase ?? [],
    identical: comparison?.identical ?? false,
    comparable: comparison !== null,
  };
  writeJson(join(logDir, "comparison.json"), record);
  writeFileSync(join(logDir, "failures-new-on-tip.txt"), record.newOnTip.join("\n") + (record.newOnTip.length ? "\n" : ""));
  writeFileSync(join(logDir, "failures-only-on-base.txt"), record.onlyOnBase.join("\n") + (record.onlyOnBase.length ? "\n" : ""));

  const common = { base, sha, tipSha, baseDir: worktree.dir, tipDir: tipWorktree.dir, caller, cleaned, cleanedUp: cleanup, tip, baseline, logDir };
  if (comparison === null) {
    return { ...common, ok: false, stage: "infra", detail: infra.map((entry) => entry.side + " " + entry.reason).join("; "), infra };
  }
  return { ...common, ok: true, comparison };
}
