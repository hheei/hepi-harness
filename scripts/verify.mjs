/**
 * `verify --profile=fast|full|changed` — the repository's own gates, run in one place and
 * reported with the evidence a result needs.
 *
 * Every step's record keeps the command, the SHA and dirty state it ran under, the
 * exit code and duration, and the raw log path, so "passed" is never reported
 * without them (docs/agents/verification.md).
 *
 * `fast` is typecheck and the workspace test run — the gate that must stay green.
 * `full` adds the Web unit suite, which is deliberately **not** claimed green: its
 * pre-existing baseline failures are reported by name.
 * `changed` selects checks from Git paths and transitive workspace dependents.
 *
 * Only these gates run. Nothing here calls a paid provider, starts a browser driver,
 * or touches a deployment.
 *
 * `--root=<dir>` verifies a checkout other than the one the script lives in, the same
 * convention the other check scripts use; the default is this repository.
 *
 * Usage: node scripts/verify.mjs [--profile=fast|full|changed] [--root=<dir>] [--json=<path>]
 *        [--log-dir=<dir>] [--quiet] [--base=<ref>] [--dry-run] [--test-file=<path>]...
 */
import { join } from "node:path";
import { REPO_ROOT } from "./dev.mjs";
import { gitState, isMain, parseCli, printSummary, runDir, runStep, writeJson } from "./lib/cli.mjs";
import { changedChecks } from "./lib/changed-checks.mjs";
import { PROFILES, profileSteps } from "./lib/presets.mjs";
import { parseTap } from "./lib/tap.mjs";

const USAGE = `
Usage: node scripts/verify.mjs [--profile=fast|full|changed] [--root=<dir>] [--json=<path>]
       [--log-dir=<dir>] [--quiet] [--base=<ref>] [--dry-run] [--test-file=<path>]...

  --profile=<name>  which gates to run: ${PROFILES.join(", ")} (default: fast)
  --root=<dir>      verify a checkout other than the one the script lives in
  --json=<path>     write the report as JSON at <path> (default: the run directory)
  --log-dir=<dir>   write the per-step logs under <dir> (default: a new .dev/verify run)
  --quiet           keep each step's own output out of this command's stdout
  --base=<ref>      changed profile: include commits since merge-base with <ref> (default: HEAD edits)
  --test-file=<p>   changed profile: run only this test file; repeat for several files
  --dry-run         print selected commands without running checks or writing reports
  -h, --help        print this usage and exit
`;

/**
 * Run a list of steps in one log directory, keeping each record and the TAP summary
 * of its output. Exported so a test can drive the runner with fixture steps instead
 * of the real gates.
 */
export function runProfile(steps, { logDir, echo = true } = {}) {
  const records = steps.map((step) => runStep(step, { logDir, env: process.env, echo }));
  const details = records.map((record) => ({
    ...record,
    summary: parseTap(record.stdout + "\n" + record.stderr).summary,
  }));
  return { steps: details, failed: details.filter((record) => record.exitCode !== 0) };
}

/** Run one profile and return the per-step records plus the overall verdict. */
export function verify({ profile = "fast", repoRoot = REPO_ROOT, logDir, echo = true, base, testFiles = [] } = {}) {
  const selection = profile === "changed" ? changedChecks(repoRoot, base, { testFiles }) : undefined;
  const state = gitState(repoRoot);
  const dir = logDir ?? runDir(repoRoot, "verify-" + profile);
  const { steps, failed } = runProfile(selection?.steps ?? profileSteps(profile, repoRoot), { logDir: dir, echo });
  return { profile, dir, state, selection, steps, failed, ok: failed.length === 0 };
}

/** The report a result is summarized into: per-step evidence, plus the overall verdict. */
export function verifyReport(result) {
  return {
    profile: result.profile,
    sha: result.state.sha,
    dirty: result.state.dirty,
    dirtyFiles: result.state.dirtyFiles,
    selection: result.selection,
    ok: result.ok,
    logDir: result.dir,
    steps: result.steps.map((step) => ({
      name: step.name,
      command: step.command,
      cwd: step.cwd,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      summary: step.summary,
      logPath: step.logPath,
    })),
  };
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, {
    usage: USAGE,
    values: ["profile", "root", "json", "log-dir", "base"],
    switches: ["quiet", "dry-run"],
    multi: ["test-file"],
  });
  if (exitCode !== undefined) return exitCode;
  const profile = flags.profile ?? "fast";
  if (!PROFILES.includes(profile)) {
    console.error("unknown --profile=" + profile + "; known: " + PROFILES.join(", "));
    return 2;
  }
  if (flags.base !== undefined && profile !== "changed") {
    console.error("--base requires --profile=changed");
    return 2;
  }
  if (flags["test-file"].length > 0 && profile !== "changed") {
    console.error("--test-file requires --profile=changed");
    return 2;
  }
  const root = flags.root ?? REPO_ROOT;
  if (flags["dry-run"] === "true") {
    try {
      const selection = profile === "changed" ? changedChecks(root, flags.base, { testFiles: flags["test-file"] }) : undefined;
      const steps = selection?.steps ?? profileSteps(profile, root);
      if (selection) console.log(JSON.stringify({ ...selection, steps: undefined }, null, 2));
      for (const step of steps) console.log(step.name + ": " + [step.command, ...step.args].join(" "));
      if (steps.length === 0) console.log("No checks selected; no executable changes detected.");
      if (selection !== undefined) console.log("tests: " + selection.testSelection.mode + " (" + selection.testSelection.reason + ")");
      return 0;
    } catch (error) {
      console.error(error.message);
      return 2;
    }
  }
  let result;
  try {
    result = verify({
      profile,
      repoRoot: root,
      base: flags.base,
      testFiles: flags["test-file"],
      logDir: flags["log-dir"],
      echo: flags.quiet !== "true",
    });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (result.steps.length === 0) console.log("No checks selected; no executable changes detected. sha " + result.state.sha);
  if (result.selection !== undefined) {
    console.log("tests: " + result.selection.testSelection.mode + " (" + result.selection.testSelection.reason + ")"
      + (result.selection.testSelection.files.length === 0 ? "" : " " + result.selection.testSelection.files.join(" ")));
  }
  const failedSteps = printSummary("verify --profile=" + profile, result.steps, result.dir);
  const report = verifyReport(result);
  const jsonPath = flags.json ?? join(result.dir, "verify.json");
  writeJson(jsonPath, report);
  console.log("  report: " + jsonPath);
  return failedSteps === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
