/**
 * `check:entrypoints` — every `node <file>` a package's scripts name actually exists.
 *
 * A script whose entry file is absent fails for whoever runs it; nothing in the
 * repository notices today, so `test:e2e` and `test:terminal` have been broken
 * without any check turning red. This reports them and never hides one.
 *
 * Two categories are kept apart, because they call for different actions:
 *
 * - **known-missing** (`KNOWN_MISSING`) are the entry files already absent at this
 *   revision. They are printed on every run and never silenced, but they do not
 *   fail the command: repairing them is separate work. `--strict` makes them fatal
 *   for the run that wants that. The list is empty today: the two entries it carried
 *   (`apps/web`'s `test:e2e` and `test:terminal`) were retired with the Next
 *   presentation layer, so no manifest names a file that does not exist. The
 *   mechanism stays for the next one, rather than being removed and re-invented.
 * - **newly missing** are any other absent entry file. They always fail the
 *   command, so a script added without its file cannot slip in.
 *
 * `--root=<dir>` checks a checkout other than the one the script lives in, the same
 * convention the other check scripts use; the default is this repository.
 *
 * Usage: node scripts/check-entrypoints.mjs [--root=<dir>] [--strict] [--json=<path>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./dev.mjs";
import { scriptEntrypoints } from "./lib/discovery.mjs";
import { isMain, parseCli, writeJson } from "./lib/cli.mjs";

const USAGE = `
Usage: node scripts/check-entrypoints.mjs [--root=<dir>] [--strict] [--json=<path>]

  --root=<dir>    check a checkout other than the one the script lives in
  --strict        make the recorded pre-existing missing entries fatal for this run
  --json=<path>   write the report as JSON at <path>
  -h, --help      print this usage and exit
`;

/**
 * Entry files already absent before this check existed, recorded rather than
 * deleted. Adding an entry here does not hide it — the run prints it under
 * *known-missing* every time.
 *
 * Empty since the Next presentation layer was retired: the two scripts it named
 * (`test:e2e` -> `e2e/run.mjs`, `test:terminal` -> `e2e/terminal.mjs`) are gone from
 * `apps/web/package.json`, so there is nothing left to record.
 */
export const KNOWN_MISSING = [];

/** Every package directory that has a manifest: the root plus each workspace package. */
export function packageDirs(root) {
  const dirs = [root];
  for (const group of ["apps", "packages"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, "package.json"))) dirs.push(join(base, entry.name));
    }
  }
  return dirs;
}

/** Compare every declared entry against the filesystem. */
export function checkEntrypoints(root = REPO_ROOT, known = KNOWN_MISSING) {
  const missing = [];
  const present = [];
  for (const dir of packageDirs(root)) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const relative = dir === root ? "." : dir.slice(root.length + 1);
    for (const entry of scriptEntrypoints(dir, manifest)) {
      const record = { package: relative, script: entry.script, target: entry.target };
      (entry.exists ? present : missing).push(record);
    }
  }
  const isKnown = (record) =>
    known.some((k) => k.package === record.package && k.script === record.script && k.target === record.target);
  const knownMissing = missing.filter(isKnown);
  const newlyMissing = missing.filter((record) => !isKnown(record));
  return { present: present.length, knownMissing, newlyMissing, ok: newlyMissing.length === 0 };
}

/**
 * The verdict, separated from the printing so the record's two rules can be driven directly: a new
 * miss always fails, a recorded one never fails on its own, and `--strict` is what makes the record
 * fatal for a run that wants that.
 */
export function exitCodeFor(result, { strict = false } = {}) {
  if (!result.ok) return 1;
  if (strict && result.knownMissing.length > 0) return 1;
  return 0;
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["root", "json"], switches: ["strict"] });
  if (exitCode !== undefined) return exitCode;
  const result = checkEntrypoints(flags.root ?? REPO_ROOT);
  for (const record of result.knownMissing) {
    console.log("KNOWN-MISSING  " + record.package + "  " + record.script + "  ->  " + record.target);
  }
  for (const record of result.newlyMissing) {
    console.log("MISSING        " + record.package + "  " + record.script + "  ->  " + record.target);
  }
  console.log(
    result.present + " entry files present; " +
    result.knownMissing.length + " known-missing (pre-existing, recorded); " +
    result.newlyMissing.length + " newly missing",
  );
  if (flags.json) writeJson(flags.json, result);
  return exitCodeFor(result, { strict: flags.strict === "true" });
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
