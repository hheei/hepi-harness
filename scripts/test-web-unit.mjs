/**
 * `test:web:unit` — the Web `*.test.ts` suite, run directly and reported as TAP.
 *
 * `apps/web` declares no `test` script, so `pnpm -r test` never reaches the Web
 * suite and its coverage gap is invisible. This runs it, enumerating the files
 * explicitly (a glob misses nested suites) and keeping the raw TAP log, the file
 * list, the exit code and the failure names.
 *
 * The suite is deliberately not claimed green: the pre-existing baseline failures
 * are reported by name rather than summarized into one number, so a comparison can
 * tell a real regression from the recorded baseline.
 *
 * `--root=<dir>` runs the suite of a checkout other than the one the script lives in, the
 * same convention the other check scripts use; the default is this repository.
 *
 * Usage: node scripts/test-web-unit.mjs [--root=<dir>] [--json=<path>] [--log-dir=<dir>]
 *        [--quiet]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./dev.mjs";
import { isMain, parseCli, runDir, runStep, writeJson } from "./lib/cli.mjs";

const USAGE = `
Usage: node scripts/test-web-unit.mjs [--root=<dir>] [--json=<path>] [--log-dir=<dir>] [--quiet]

  --root=<dir>     run the suite of a checkout other than the one the script lives in
  --json=<path>    write the report as JSON at <path> (default: the run directory)
  --log-dir=<dir>  write the raw log and TAP under <dir> (default: a new .dev/verify run)
  --quiet          keep the suite's own output out of this command's stdout
  -h, --help       print this usage and exit
`;
import { webUnitFiles, webUnitStep } from "./lib/presets.mjs";
import { parseTap } from "./lib/tap.mjs";

/** Run the Web suite and return the files, the step record and the parsed TAP. */
export function testWebUnit({ repoRoot = REPO_ROOT, logDir, echo = true } = {}) {
  const files = webUnitFiles(repoRoot);
  const dir = logDir ?? runDir(repoRoot, "web-unit");
  const record = runStep(webUnitStep(repoRoot, files), { logDir: dir, echo });
  const text = record.stdout + "\n" + record.stderr;
  const tapPath = join(dir, "web-unit.tap");
  writeFileSync(tapPath, text);
  return { files, dir, record, tapPath, text, tap: parseTap(text) };
}

/** The report a caller (or a comparison run) consumes. */
export function webUnitReport(result) {
  return {
    sha: result.record.sha,
    dirty: result.record.dirty,
    dirtyFiles: result.record.dirtyFiles,
    command: result.record.command,
    cwd: result.record.cwd,
    exitCode: result.record.exitCode,
    durationMs: result.record.durationMs,
    fileCount: result.files.length,
    files: result.files,
    summary: result.tap.summary,
    failingNames: result.tap.names,
    rawLog: result.record.logPath,
    tapLog: result.tapPath,
  };
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, {
    usage: USAGE,
    values: ["root", "json", "log-dir"],
    switches: ["quiet"],
  });
  if (exitCode !== undefined) return exitCode;
  const result = testWebUnit({
    repoRoot: flags.root ?? REPO_ROOT,
    logDir: flags["log-dir"],
    echo: flags.quiet !== "true",
  });
  const report = webUnitReport(result);
  console.log("");
  console.log("web unit files: " + report.fileCount + " (" + report.command + ")");
  console.log("TAP: " + JSON.stringify(report.summary) + "; failing names: " + report.failingNames.length);
  for (const name of report.failingNames) console.log("  not ok  " + name);
  const jsonPath = flags.json ?? join(result.dir, "web-unit.json");
  writeJson(jsonPath, report);
  console.log("exit " + report.exitCode + "; report: " + jsonPath);
  return report.exitCode;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
