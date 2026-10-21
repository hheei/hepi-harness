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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, runCli, worktreeList, writeAt } from "./testing/fixture.mjs";

const COMPARE = fileURLToPath(new URL("./compare-tests.mjs", import.meta.url));

const failingTest = (name) => [
  "import assert from " + JSON.stringify("node:assert/strict") + ";",
  "import { test } from " + JSON.stringify("node:test") + ";",
  "test(" + JSON.stringify(name) + ", () => { assert.equal(1, 2); });",
  "",
].join("\n");

/**
 * Two commits whose Web suite fails exactly once on each side, under a different name: the
 * counts agree and the failures do not.
 */
function twoCommitRepo({ tipBreaksLoading = false } = {}) {
  const root = fixtureDir();
  writeAt(root, ".gitignore", ".dev/\n");
  writeAt(root, "apps/web/lib/shared.test.mjs", "import { test } from " + JSON.stringify("node:test") + ";\ntest(\"a shared passing test\", () => {});\n");
  writeAt(root, "apps/web/lib/regression.test.mjs", failingTest("base failure"));
  const repo = initRepo(root);
  const base = repo.commit("base: one failing test");
  writeAt(root, "apps/web/lib/regression.test.mjs", tipBreaksLoading ? "import \"no-such-package\";\n" : failingTest("tip failure"));
  const tip = repo.commit("tip: the same count, a different name");
  return { root, repo, base, tip };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const logDirOf = (root) => join(root, ".dev", "compare");

function compare(root, base, extra = []) {
  return runCli(
    COMPARE,
    ["--root=" + root, "--base=" + base, "--no-install", "--log-dir=" + logDirOf(root), "--quiet", ...extra],
    { cwd: root, timeoutMs: 180000 },
  );
}

test("a failure that changed name is caught even though both sides fail the same number", () => {
  const { root, base } = twoCommitRepo();
  const result = compare(root, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAILURE SETS DIFFER/);
  assert.match(result.stdout, /\+ tip failure/);
  assert.match(result.stdout, /- base failure/);
  const record = readJson(join(logDirOf(root), "comparison.json"));
  assert.equal(record.comparable, true);
  assert.equal(record.identical, false);
  assert.deepEqual(record.newOnTip, ["tip failure"]);
  assert.deepEqual(record.onlyOnBase, ["base failure"]);
  // The counts agree, which is exactly why a count is not the verdict.
  assert.equal(record.base.summary.fail, 1);
  assert.equal(record.tip.summary.fail, 1);
  assert.equal(readFileSync(join(logDirOf(root), "failures-new-on-tip.txt"), "utf8"), "tip failure\n");
});

test("each side is its own detached checkout, and its raw log names that checkout and that commit", () => {
  const { root, base, tip } = twoCommitRepo();
  assert.equal(compare(root, base).status, 1);
  const record = readJson(join(logDirOf(root), "comparison.json"));
  assert.equal(record.base.sha, base);
  assert.equal(record.tip.sha, tip);
  assert.notEqual(record.base.dir, root);
  assert.notEqual(record.tip.dir, root);
  assert.notEqual(record.base.dir, record.tip.dir);
  const checkouts = worktreeList(root);
  for (const side of ["base", "tip"]) {
    const entry = checkouts.find((checkout) => checkout.path === record[side].dir);
    assert.ok(entry, side + " must be a worktree git knows about");
    assert.equal(entry.detached, true, side + " must be detached, not on a branch");
    assert.equal(entry.head, record[side].sha);
  }
  // Two logs, not one: a shared path would have left only the side that ran last.
  assert.notEqual(record.base.logPath, record.tip.logPath);
  for (const side of ["base", "tip"]) {
    const log = readFileSync(record[side].logPath, "utf8");
    // The log names the checkout it ran in - its own worktree, under apps/web - and the commit
    // that checkout holds, so the two logs are distinguishable evidence rather than two files
    // with the same name.
    const cwd = /^# cwd: (.*)$/m.exec(log)[1];
    assert.ok(cwd.startsWith(record[side].dir + "/"), side + " log cwd " + cwd + " is not inside " + record[side].dir);
    assert.ok(cwd.endsWith(join("apps", "web")));
    assert.match(log, new RegExp("# sha: " + record[side].sha));
    assert.match(log, /# dirty: false/);
  }
  assert.match(readFileSync(record.base.logPath, "utf8"), /base failure/);
  assert.match(readFileSync(record.tip.logPath, "utf8"), /tip failure/);
  assert.equal(readFileSync(record.base.logPath, "utf8").includes("tip failure"), false);
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
  const record = readJson(join(logDirOf(root), "comparison.json"));
  assert.equal(record.caller.sha, tip);
  assert.equal(record.caller.dirty, true);
  assert.deepEqual([...record.caller.dirtyFiles].sort(), ["staged.txt", "uncommitted.txt"]);
  // The tip evidence is the commit: an uncommitted edit is not evidence about a revision.
  assert.equal(record.tip.sha, tip);
  const tipLog = readFileSync(record.tip.logPath, "utf8");
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
  const record = readJson(join(logDirOf(root), "comparison.json"));
  assert.equal(record.comparable, false);
  assert.equal(record.identical, false);
  assert.ok(record.infra.length >= 1);
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
  const record = readJson(join(logDirOf(root), "comparison.json"));
  writeAt(record.base.dir, "not-part-of-the-baseline.txt", "someone edited the checkout\n");
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
  const record = readJson(join(logDirOf(root), "comparison.json"));
  assert.equal(record.cleanedUp, true);
  const paths = worktreeList(root).map((checkout) => checkout.path);
  for (const side of ["base", "tip"]) {
    assert.equal(existsSync(record[side].dir), false, side + " worktree must be gone");
    assert.equal(paths.includes(record[side].dir), false, side + " must be deregistered from git");
    // The log and the report live outside the worktree, so the evidence survives the cleanup.
    assert.ok(existsSync(record[side].logPath));
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
