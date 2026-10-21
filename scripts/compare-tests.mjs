/**
 * `compare:tests --base=<SHA>` — run the Web unit suite at the base revision and at the
 * current HEAD, each in its own detached worktree, then compare the two TAP logs by
 * **exact failure name**.
 *
 * Both sides are real checkouts of their own revision: the base from the SHA you name, the
 * tip from the repository's own HEAD. Nothing runs in a caller's working tree, so an
 * uncommitted edit cannot be measured as if it were the revision in the report, and nothing
 * stashes or resets (`git stash` is shared by every worktree, so it would compare the tree
 * against itself and could clobber another worktree's entry).
 *
 * Names are normalized only by stripping each checkout's own prefix, so a genuine difference
 * survives. Test counts are reported but never used as the verdict: a file's rollup and its
 * nested assertion are separate `not ok` names, so a matching `# fail` count can still hide a
 * changed failure set.
 *
 * A side that never started is an **infrastructure failure**, not a pass: a fresh worktree
 * missing its dependencies produces no TAP at all, and comparing empty against empty must not
 * read as "identical". Exit codes: 0 identical failure set, 1 the sets differ, 2 usage or an
 * unknown revision, 3 the comparison could not run (a side did not produce a test run).
 *
 * No paid provider call, browser driver or deployment is involved; the suite here is the unit
 * suite.
 *
 * `--root=<dir>` compares a checkout other than the one the script lives in, the same
 * convention `deploy:inspect` and `deploy:plan` use; the default is this repository.
 *
 * `--cleanup` removes both worktrees after the run; the logs and the report live outside them,
 * so the evidence is kept either way. The caller's own dirty state is printed and recorded: it
 * is not part of either side.
 *
 * Usage: node scripts/compare-tests.mjs --base=<SHA> [--root=<dir>] [--no-install] [--cleanup]
 *        [--suite=web-unit] [--log-dir=<dir>] [--json=<path>]
 */
import { REPO_ROOT } from "./dev.mjs";
import { join } from "node:path";
import { isMain, parseCli, runDir, writeJson } from "./lib/cli.mjs";
import { compareBaseline } from "./lib/compare.mjs";

/** The suites this command can compare. Each is a step factory taking a checkout dir. */
export const SUITES = {
  "web-unit": (dir) => ({
    name: "web-unit", command: process.execPath,
    args: [join(dir, "scripts", "test-web-unit.mjs")], cwd: dir,
  }),
};

const USAGE = `
Usage: node scripts/compare-tests.mjs --base=<SHA> [--root=<dir>] [--no-install] [--cleanup]
       [--suite=${Object.keys(SUITES).join("|")}] [--log-dir=<dir>] [--json=<path>] [--quiet]

  --base=<SHA>      the revision to compare the tip against (required)
  --root=<dir>      compare a checkout other than the one the script lives in
  --suite=<name>    which suite to compare (default: web-unit)
  --no-install      do not install dependencies in the baseline worktree
  --cleanup         remove both worktrees after the run; the logs are kept
  --log-dir=<dir>   write the per-side logs under <dir> (default: a new .dev/verify run)
  --json=<path>     write the comparison record as JSON at <path>
  --quiet           keep each side's own output out of this command's stdout
  -h, --help        print this usage and exit
`;

export function compareTests({
  repoRoot = REPO_ROOT,
  base,
  suite = "web-unit",
  logDir,
  install = true,
  cleanup = false,
  echo = true,
} = {}) {
  if (!base) return { ok: false, stage: "arguments", detail: "--base=<SHA> is required" };
  const factory = SUITES[suite];
  if (!factory) {
    return { ok: false, stage: "arguments", detail: "unknown --suite=" + suite + "; known: " + Object.keys(SUITES).join(", ") };
  }
  const dir = logDir ?? runDir(repoRoot, "compare-tests");
  return compareBaseline({
    repoRoot,
    base,
    suiteStep: factory,
    logDir: dir,
    install,
    cleanup,
    echo,
  });
}

/** A side that produced no test run, printed with its field, exit code and log. */
function printInfra(infra) {
  for (const entry of infra) {
    console.error("side " + entry.side + " (" + entry.dir + ") " + entry.reason + ": exit=" + entry.exitCode);
    console.error("  first output: " + entry.firstOutputLine);
    console.error("  log: " + entry.logPath);
  }
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, {
    usage: USAGE,
    values: ["base", "root", "suite", "log-dir", "json"],
    switches: ["no-install", "cleanup", "quiet"],
  });
  if (exitCode !== undefined) return exitCode;
  const result = compareTests({
    repoRoot: flags.root,
    base: flags.base,
    suite: flags.suite ?? "web-unit",
    logDir: flags["log-dir"],
    install: flags["no-install"] !== "true",
    cleanup: flags.cleanup === "true",
    echo: flags.quiet !== "true",
  });

  if (flags.json) writeJson(flags.json, result);

  // Distinct exit codes, so a caller can tell a usage mistake from a comparison that could
  // not run from a real difference in the failure sets.
  if (!result.ok && (result.stage === "arguments" || result.stage === "revision")) {
    console.error(result.detail);
    return 2;
  }
  if (!result.ok) {
    console.error("comparison could not run (" + result.stage + "): " + result.detail);
    if (result.logPath) console.error("log: " + result.logPath);
    // An infrastructure failure is never reported as an identical failure set.
    if (result.infra) printInfra(result.infra);
    return 3;
  }

  console.log("");
  console.log("base " + result.sha + "  exit=" + result.baseline.exitCode + "  " + JSON.stringify(result.comparison.base.summary));
  console.log("tip  " + result.tipSha + "  exit=" + result.tip.exitCode + "  " + JSON.stringify(result.comparison.tip.summary));
  console.log("failure names: base " + result.comparison.base.uniqueNotOkNames +
    ", tip " + result.comparison.tip.uniqueNotOkNames);
  console.log("new on tip: " + result.comparison.newOnTip.length);
  for (const name of result.comparison.newOnTip) console.log("  + " + name);
  console.log("only on base: " + result.comparison.onlyOnBase.length);
  for (const name of result.comparison.onlyOnBase) console.log("  - " + name);
  console.log(result.comparison.identical ? "identical failure set" : "FAILURE SETS DIFFER");
  console.log("logs: base " + result.baseline.logPath + ", tip " + result.tip.logPath);
  // Said out loud, so nobody reads a result as covering edits it never saw. The tip side is
  // still the commit: an uncommitted edit is not evidence about a revision.
  if (result.caller.dirty) {
    console.log("caller tree is dirty (" + result.caller.dirtyFiles.join(", ") + "); neither side measured it - the tip is " + result.tipSha);
  }
  if (result.cleanedUp) console.log("worktrees removed: " + result.cleaned.map((entry) => entry.dir).join(", "));
  return result.comparison.identical ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
