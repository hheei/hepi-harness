/**
 * Workflow 1: the verify runner and the Web unit runner, as CLIs, against a real checkout.
 *
 * Both runners do the same job - run a suite, keep the log, the JSON, the exit code and the SHA
 * the run happened on - so they are one workflow and one file. Everything here goes through the
 * shipped CLI as a child process in a real temporary pnpm workspace; no helper is called to
 * produce the answer the test then compares against.
 *
 * What this protects: a result that cannot be trusted because it lost its log, reported a SHA it
 * did not measure, hid a dirty tree, or silently ran fewer test files than it claimed. The Web
 * suite is enumerated by Node rather than by a shell glob, so a nested file has to be in the list
 * literally - a glob would drop it and say nothing.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, runCli, writeAt } from "./testing/fixture.mjs";

const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const WEB = fileURLToPath(new URL("./test-web-unit.mjs", import.meta.url));

/** A real pnpm workspace: a root manifest, one package with both gates, and a Web suite. */
function fixtureWorkspace({ workspaceTest = "passes" } = {}) {
  const root = fixtureDir();
  // pnpm writes a lockfile and a store link on the first recursive run; both are the
  // fixture's own build output, not a change to the revision under test.
  writeAt(root, ".gitignore", ".dev/\npnpm-lock.yaml\nnode_modules/\n");
  writeAt(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  writeAt(root, "package.json", JSON.stringify({ name: "fixture-root", private: true }));
  writeAt(root, "packages/x/package.json", JSON.stringify({
    name: "@fixture/x",
    version: "1.0.0",
    scripts: {
      typecheck: "node -e " + JSON.stringify("process.stdout.write('typecheck ok')"),
      test: "node --test --test-reporter=tap ./t.test.mjs",
    },
  }));
  writeAt(root, "packages/x/t.test.mjs", workspaceTest === "passes"
    ? "import { test } from " + JSON.stringify("node:test") + ";\ntest(\"fixture workspace test\", () => {});\n"
    : "import assert from " + JSON.stringify("node:assert/strict") + ";\nimport { test } from " + JSON.stringify("node:test") + ";\ntest(\"fixture workspace test\", () => { assert.equal(1, 2); });\n");
  writeAt(root, "apps/web/lib/passing.test.mjs", "import { test } from " + JSON.stringify("node:test") + ";\ntest(\"fixture web test\", () => {});\n");
  writeAt(root, "apps/web/lib/nested/failing.test.mjs", "import assert from " + JSON.stringify("node:assert/strict") + ";\nimport { test } from " + JSON.stringify("node:test") + ";\ntest(\"fails on purpose\", () => { assert.equal(1, 2); });\n");
  const repo = initRepo(root);
  return { root, repo, sha: repo.commit("fixture workspace") };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("verify runs the fixture workspace and keeps its log, report, exit code and SHA in agreement", () => {
  const { root, sha } = fixtureWorkspace();
  const json = join(root, "verify.json");
  const result = runCli(VERIFY, ["--profile=fast", "--root=" + root, "--json=" + json, "--quiet"], { cwd: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson(json);
  assert.equal(report.profile, "fast");
  assert.equal(report.ok, true);
  assert.equal(report.sha, sha);
  assert.equal(report.dirty, false);
  assert.deepEqual(report.dirtyFiles, []);
  assert.deepEqual(report.steps.map((step) => step.name), ["workspace-typecheck", "workspace-tests"]);
  for (const step of report.steps) {
    assert.equal(step.exitCode, 0);
    assert.ok(existsSync(step.logPath), step.name + " must leave a raw log");
    const log = readFileSync(step.logPath, "utf8");
    // The log carries the same four facts the report does, so neither can be read alone.
    assert.match(log, new RegExp("# sha: " + sha));
    assert.match(log, /# dirty: false/);
    assert.match(log, /# exit code: 0/);
    assert.match(log, new RegExp("# command: " + step.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(report.steps[0].command, /^pnpm -r typecheck$/);
  assert.ok(report.logDir.startsWith(root));
});

test("full adds the Web suite on top of fast, and names every Web file literally", () => {
  const { root, sha } = fixtureWorkspace();
  const fastResult = runCli(VERIFY, ["--profile=fast", "--root=" + root, "--json=" + join(root, "fast.json"), "--quiet"], { cwd: root });
  assert.equal(fastResult.status, 0, fastResult.stderr);
  const fullResult = runCli(VERIFY, ["--profile=full", "--root=" + root, "--json=" + join(root, "full.json"), "--quiet"], { cwd: root });
  assert.equal(fullResult.status, 1, "the fixture Web suite fails on purpose");
  const fastNames = readJson(join(root, "fast.json")).steps.map((step) => step.name);
  const full = readJson(join(root, "full.json"));
  const fullNames = full.steps.map((step) => step.name);
  // full is a superset, so choosing it never weakens what fast already guarantees.
  assert.deepEqual(fullNames.slice(0, fastNames.length), fastNames);
  assert.equal(fullNames[fullNames.length - 1], "web-unit");
  const web = full.steps[full.steps.length - 1];
  assert.equal(web.exitCode, 1);
  assert.equal(full.sha, sha);
  for (const file of ["./lib/nested/failing.test.mjs", "./lib/passing.test.mjs"]) {
    assert.ok(web.command.includes(file), file + " must appear in the command literally");
  }
  assert.equal(/[*?[\]]/.test(web.command), false, "the file list is literal, never a glob");
  assert.ok(web.cwd.endsWith(join("apps", "web")));
  assert.equal(web.summary.tests, 2);
  assert.equal(web.summary.fail, 1);
});

test("a failing workspace test fails the profile, and the log says which test", () => {
  const { root } = fixtureWorkspace({ workspaceTest: "fails" });
  const json = join(root, "verify.json");
  const result = runCli(VERIFY, ["--profile=fast", "--root=" + root, "--json=" + json, "--quiet"], { cwd: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = readJson(json);
  assert.equal(report.ok, false);
  const failing = report.steps.find((step) => step.exitCode !== 0);
  assert.equal(failing.name, "workspace-tests");
  assert.match(readFileSync(failing.logPath, "utf8"), /not ok/);
});

test("a dirty tree is reported beside the SHA it measured, not hidden", () => {
  const { root, sha } = fixtureWorkspace();
  writeAt(root, "uncommitted.txt", "work in progress\n");
  const json = join(root, "verify.json");
  const result = runCli(VERIFY, ["--profile=fast", "--root=" + root, "--json=" + json], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const report = readJson(json);
  assert.equal(report.dirty, true);
  assert.deepEqual(report.dirtyFiles, ["uncommitted.txt"]);
  // The SHA is still the commit that was checked out: the edit is reported, not folded in.
  assert.equal(report.sha, sha);
  assert.match(result.stdout, /dirty tree/);
  assert.match(result.stdout, new RegExp(sha));
});

test("an unknown profile is refused before anything runs", () => {
  const { root } = fixtureWorkspace();
  const result = runCli(VERIFY, ["--profile=quick", "--root=" + root], { cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --profile=quick/);
  assert.match(result.stderr, /known: fast, full/);
  assert.equal(existsSync(join(root, ".dev", "verify")), false, "a refused profile must run nothing");
});

test("test:web:unit keeps the literal file list, the raw TAP and the JSON report in agreement", () => {
  const { root, sha } = fixtureWorkspace();
  const json = join(root, "web.json");
  const result = runCli(WEB, ["--root=" + root, "--json=" + json], { cwd: root });
  assert.equal(result.status, 1, "the fixture Web suite fails on purpose");
  const report = readJson(json);
  assert.deepEqual(report.files, ["./lib/nested/failing.test.mjs", "./lib/passing.test.mjs"]);
  assert.equal(report.files.some((file) => /[*?[\]]/.test(file)), false);
  assert.equal(report.sha, sha);
  assert.equal(report.dirty, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.summary.tests, 2);
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 1);
  assert.deepEqual(report.failingNames, ["fails on purpose"]);
  // Two artifacts, not one: the raw log a person reads and the TAP a comparison parses.
  assert.notEqual(report.rawLog, report.tapLog);
  assert.ok(existsSync(report.rawLog));
  assert.ok(existsSync(report.tapLog));
  const raw = readFileSync(report.rawLog, "utf8");
  assert.match(raw, /# exit code: 1/);
  assert.match(raw, new RegExp("# sha: " + sha));
  assert.match(raw, new RegExp("# cwd: .*" + join("apps", "web").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readFileSync(report.tapLog, "utf8"), /not ok 1 - fails on purpose/);
  // The printed summary is the report, so a person reading the terminal sees the same facts.
  assert.match(result.stdout, /web unit files: 2/);
  assert.match(result.stdout, /not ok {2}fails on purpose/);
  assert.match(result.stdout, /exit 1; report: /);
});
