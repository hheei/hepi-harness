/**
 * Workflow 2: `compare:tests`, against two real commits.
 *
 * The comparison is the one check whose failure mode is a *false pass*: two runs that never
 * started compare equal, and two runs with the same failure count can have different failures.
 * So this file drives the shipped CLI over a real repository with a real base commit and a real
 * tip commit, and reads the logs, the report and the exit code it leaves behind.
 *
 * What this protects: both sides run in their own detached checkout at the revision they name,
 * each keeps its own raw log, a changed failure name is caught even when the counts agree, a side
 * that never ran is an infrastructure failure rather than an identical pass, and the caller's own
 * tree - including its uncommitted edits, its index and its stash - is only ever read.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, runCli, worktreeList, writeAt, type FixtureRepo, type ProcessResult } from "./testing/fixture.ts";

const COMPARE = fileURLToPath(new URL("./compare-tests.mjs", import.meta.url));

/** The counters a TAP log states at its end. */
type TapSummary = Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>;

/** One side of the comparison, as the record states it. */
type SideRecord = {
  readonly sha: string;
  readonly dir: string;
  readonly exitCode: number;
  readonly logPath: string;
  readonly summary: TapSummary;
};

/** Why a side did not run a suite, and where its output went. */
type InfraEntry = {
  readonly side: string;
  readonly reason: string;
  readonly logPath: string;
  readonly exitCode: number;
};

/** The comparison record, which is what a person reads to decide whether a change regressed. */
type ComparisonRecord = {
  readonly caller: { readonly sha: string; readonly dirty: boolean; readonly dirtyFiles: readonly string[] };
  readonly base: SideRecord;
  readonly tip: SideRecord;
  readonly cleanedUp: boolean;
  readonly infra: readonly InfraEntry[];
  readonly newOnTip: readonly string[];
  readonly onlyOnBase: readonly string[];
  readonly identical: boolean;
  readonly comparable: boolean;
};

/** A report file a CLI wrote, read back at the shape its own tests assert on. */
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;


/** One side's record, or a failure naming the side a record dropped. */
function sideOf(record: ComparisonRecord, side: "base" | "tip"): SideRecord {
  return record[side];
}

/** The cwd a raw step log names, which is how a test proves which checkout a side ran in. */
function cwdOf(log: string, label: string): string {
  const match = /^# cwd: (.*)$/m.exec(log);
  assert.ok(match !== null && match[1] !== undefined, label + " states the directory it ran in");
  return match[1];
}

/** A test file that fails once, so a side's failure set is exactly its own name. */
const failingTest = (name: string): string => [
  "import assert from " + JSON.stringify("node:assert/strict") + ";",
  "import { test } from " + JSON.stringify("node:test") + ";",
  "test(" + JSON.stringify(name) + ", () => { assert.equal(1, 2); });",
  "",
].join("\n");

/** The repository the comparison runs over, with its two commits and the tip it ends on. */
type TwoCommitRepo = { root: string; repo: FixtureRepo; base: string; tip: string };

/**
 * Two commits whose Web suite fails exactly once on each side, under a different name: the
 * counts agree and the failures do not.
 */
function twoCommitRepo({ tipBreaksLoading = false, migrateTests = false }: { readonly tipBreaksLoading?: boolean; readonly migrateTests?: boolean } = {}): TwoCommitRepo {
  const root = fixtureDir();
  writeAt(root, ".gitignore", ".dev/\n");
  const writeRunner = (suffix: string): void => {
    writeAt(root, "scripts/test-web-unit.mjs", [
      'import { readdirSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { spawnSync } from "node:child_process";',
      'function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(' + JSON.stringify(suffix) + ') ? [join(dir, entry.name)] : []); }',
      'const files = walk("apps/web").sort();',
      'console.log("# suite files: " + JSON.stringify(files));',
      'const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { stdio: "inherit" });',
      'process.exit(result.status ?? 1);',
      '',
    ].join("\n"));
  };
  const baseSuffix = migrateTests ? ".test.mjs" : ".test.ts";
  writeRunner(baseSuffix);
  writeAt(root, "apps/web/lib/shared" + baseSuffix, "import { test } from " + JSON.stringify("node:test") + ";\ntest(\"a shared passing test\", () => {});\n");
  writeAt(root, "apps/web/lib/regression" + baseSuffix, failingTest("base failure"));
  const repo = initRepo(root);
  const base = repo.commit("base: one failing test");
  if (migrateTests) {
    for (const name of ["shared", "regression"]) renameSync(join(root, "apps/web/lib", name + baseSuffix), join(root, "apps/web/lib", name + ".test.ts"));
    writeRunner(".test.ts");
  }
  writeAt(root, "apps/web/lib/regression.test.ts", tipBreaksLoading ? "import \"no-such-package\";\n" : failingTest("tip failure"));
  const tip = repo.commit("tip: the same count, a different name");
  return { root, repo, base, tip };
}

const logDirOf = (root: string): string => join(root, ".dev", "compare");

/** Run the comparison CLI the way the repository documents it, against the fixture checkout. */
function compare(root: string, base: string, extra: readonly string[] = []): ProcessResult {
  return runCli(
    COMPARE,
    ["--root=" + root, "--base=" + base, "--no-install", "--log-dir=" + logDirOf(root), "--quiet", ...extra],
    { cwd: root, timeoutMs: 180000 },
  );
}

test("a failure that changed name is caught even though both sides fail the same number", () => {
  const { root, base } = twoCommitRepo({ migrateTests: true });
  const result = compare(root, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAILURE SETS DIFFER/);
  assert.match(result.stdout, /\+ tip failure/);
  assert.match(result.stdout, /- base failure/);
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  assert.equal(record.comparable, true);
  assert.equal(record.identical, false);
  assert.deepEqual(record.newOnTip, ["tip failure"]);
  assert.deepEqual(record.onlyOnBase, ["base failure"]);
  // The counts agree, which is exactly why a count is not the verdict.
  assert.equal(sideOf(record, "base").summary.fail, 1);
  assert.equal(sideOf(record, "tip").summary.fail, 1);
  assert.match(readFileSync(record.base.logPath, "utf8"), /# suite files: .*shared\.test\.mjs/);
  assert.match(readFileSync(record.tip.logPath, "utf8"), /# suite files: .*shared\.test\.ts/);
  assert.equal(readFileSync(join(logDirOf(root), "failures-new-on-tip.txt"), "utf8"), "tip failure\n");
});

test("each side is its own detached checkout, and its raw log names that checkout and that commit", () => {
  const { root, base, tip } = twoCommitRepo();
  assert.equal(compare(root, base).status, 1);
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  assert.equal(sideOf(record, "base").sha, base);
  assert.equal(sideOf(record, "tip").sha, tip);
  assert.notEqual(sideOf(record, "base").dir, root);
  assert.notEqual(sideOf(record, "tip").dir, root);
  assert.notEqual(sideOf(record, "base").dir, sideOf(record, "tip").dir);
  const checkouts = worktreeList(root);
  for (const side of ["base", "tip"] as const) {
    const entry = checkouts.find((checkout) => checkout.path === sideOf(record, side).dir);
    assert.ok(entry !== undefined, side + " must be a worktree git knows about");
    assert.equal(entry.detached, true, side + " must be detached, not on a branch");
    assert.equal(entry.head, sideOf(record, side).sha);
  }
  // Two logs, not one: a shared path would have left only the side that ran last.
  assert.notEqual(sideOf(record, "base").logPath, sideOf(record, "tip").logPath);
  for (const side of ["base", "tip"] as const) {
    const log = readFileSync(sideOf(record, side).logPath, "utf8");
    // The log names the checkout running its own suite entrypoint and the commit
    // that checkout holds, so the two logs are distinguishable evidence rather than two files
    // with the same name.
    const cwd = cwdOf(log, side + " log");
    assert.equal(cwd, sideOf(record, side).dir);
    assert.match(log, new RegExp("# sha: " + sideOf(record, side).sha));
    assert.match(log, /# dirty: false/);
  }
  assert.match(readFileSync(sideOf(record, "base").logPath, "utf8"), /base failure/);
  assert.match(readFileSync(sideOf(record, "tip").logPath, "utf8"), /tip failure/);
  assert.equal(readFileSync(sideOf(record, "base").logPath, "utf8").includes("tip failure"), false);
});

test("the caller's dirty tree is reported, and neither side measures it", () => {
  const { root, repo, base, tip } = twoCommitRepo();
  writeAt(root, "uncommitted.txt", "work in progress\n");
  writeAt(root, "staged.txt", "staged but not committed\n");
  repo.raw("add", "staged.txt");
  const headBefore = repo.raw("rev-parse", "HEAD").trim();
  const statusBefore = repo.raw("status", "--porcelain");
  const result = compare(root, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /caller tree is dirty \(staged\.txt, uncommitted\.txt\)/);
  assert.match(result.stdout, new RegExp("the tip is " + tip));
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  assert.equal(record.caller.sha, tip);
  assert.equal(record.caller.dirty, true);
  assert.deepEqual([...record.caller.dirtyFiles].sort(), ["staged.txt", "uncommitted.txt"]);
  // The tip evidence is the commit: an uncommitted edit is not evidence about a revision.
  assert.equal(sideOf(record, "tip").sha, tip);
  const tipLog = readFileSync(sideOf(record, "tip").logPath, "utf8");
  assert.match(tipLog, new RegExp("# sha: " + tip));
  assert.match(tipLog, /# dirty: false/);
  // Reading the caller's state must not change it, in the index or anywhere else.
  assert.equal(repo.raw("rev-parse", "HEAD").trim(), headBefore);
  assert.equal(repo.raw("status", "--porcelain"), statusBefore);
  assert.equal(repo.raw("stash", "list").trim(), "", "no stash entry may be created");
  assert.equal(readFileSync(join(root, "uncommitted.txt"), "utf8"), "work in progress\n");
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "staged but not committed\n");
});

test("a side that never ran a test is an infrastructure failure, never an identical pass", () => {
  const { root, base } = twoCommitRepo({ tipBreaksLoading: true });
  const result = compare(root, base);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stdout.includes("identical failure set"), false, "an unstarted run must not read as identical");
  assert.match(result.stderr, /comparison could not run \(infra\)/);
  assert.match(result.stderr, /failed to load its test files/);
  assert.match(result.stderr, /first output: /);
  assert.match(result.stderr, /log: /);
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  assert.equal(record.comparable, false);
  assert.equal(record.identical, false);
  assert.ok(record.infra.length >= 1, "the record names the side that did not run");
  for (const entry of record.infra) {
    assert.ok(entry.side === "base" || entry.side === "tip");
    assert.ok(existsSync(entry.logPath));
    assert.equal(typeof entry.exitCode, "number");
    assert.match(entry.reason, /did not run a suite|no test ran/);
  }
});

test("a reused baseline that is no longer the commit is refused, not measured", () => {
  const { root, base } = twoCommitRepo();
  assert.equal(compare(root, base).status, 1);
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  writeAt(sideOf(record, "base").dir, "not-part-of-the-baseline.txt", "someone edited the checkout\n");
  const result = compare(root, base);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /comparison could not run \(worktree\)/);
  assert.match(result.stderr, /is dirty/);
});

test("--cleanup removes both worktrees and keeps the evidence", () => {
  const { root, base } = twoCommitRepo();
  const result = compare(root, base, ["--cleanup"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /worktrees removed: /);
  const record = readJson<ComparisonRecord>(join(logDirOf(root), "comparison.json"));
  assert.equal(record.cleanedUp, true);
  const paths = worktreeList(root).map((checkout) => checkout.path);
  for (const side of ["base", "tip"] as const) {
    assert.equal(existsSync(sideOf(record, side).dir), false, side + " worktree must be gone");
    assert.equal(paths.includes(sideOf(record, side).dir), false, side + " must be deregistered from git");
    // The log and the report live outside the worktree, so the evidence survives the cleanup.
    assert.ok(existsSync(sideOf(record, side).logPath));
  }
  assert.ok(existsSync(join(logDirOf(root), "comparison.json")));
});

test("an unknown revision exits 2 and creates no checkout", () => {
  const { root } = twoCommitRepo();
  const result = compare(root, "no-such-revision");
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown revision: no-such-revision/);
  assert.equal(existsSync(join(root, ".dev", "baselines", "no-such-revision")), false);
});

test("a missing --base is a usage error, not a silent comparison", () => {
  const { root } = twoCommitRepo();
  const result = runCli(COMPARE, ["--root=" + root], { cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--base=<SHA> is required/);
});
