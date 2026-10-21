import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, runCli, writeAt, type FixtureRepo, type ProcessResult } from "./testing/fixture.ts";

const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));

/** The counters a TAP log states at its end; a step that runs no suite states none. */
type TapSummary = Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>;

/** One step of a changed-profile report. */
type ChangedStep = {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly summary: TapSummary;
  readonly logPath: string;
};

/** What the selector decided to run, and why - the part of the report a narrowing claim rests on. */
type TestSelection = {
  readonly mode: string;
  readonly reason: string;
  readonly files: readonly string[];
};

/** The report a changed run writes: the revision, the selection and every step's evidence. */
type ChangedReport = {
  readonly sha: string;
  readonly dirty: boolean;
  readonly ok: boolean;
  readonly steps: readonly ChangedStep[];
  readonly selection: {
    readonly packages: readonly string[];
    readonly ignoredFiles: readonly string[];
    readonly testSelection: TestSelection;
  };
};

/** A report file a CLI wrote, read back at the shape its own tests assert on. */
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;


/** The path the run named on its own report line, which is how a test finds the report it reads. */
function reportPath(result: ProcessResult): string {
  const match = /report: (.+)/.exec(result.stdout);
  assert.ok(match !== null && match[1] !== undefined, "the run names its report: " + result.stdout + result.stderr);
  return match[1];
}

/**
 * A workspace whose packages have both gates, plus the two root typecheck seams this repository
 * declares: `typecheck` for the workspace and `typecheck:scripts` for the tooling config.
 *
 * The scripts the changed profile runs are copies of the shipped ones, because a fixture that
 * called this repository's own would measure the wrong checkout.
 */
function workspace(): { root: string; repo: FixtureRepo; sha: string } {
  const root = fixtureDir();
  writeAt(root, ".gitignore", ".dev/\nnode_modules/\npnpm-lock.yaml\n");
  writeAt(root, "package.json", JSON.stringify({
    name: "fixture",
    private: true,
    scripts: { "typecheck:scripts": "node -e " + JSON.stringify("process.stdout.write('script typecheck ok')") },
  }));
  writeAt(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  for (const [dir, name, dependencies] of [
    ["packages/protocol", "@hepi/protocol", {}],
    ["apps/server", "@hepi/server", { "@hepi/protocol": "workspace:*" }],
    ["apps/web", "@hepi/web", { "@hepi/protocol": "workspace:*" }],
    ["packages/client", "@hepi/client", { "@hepi/server": "workspace:*" }],
  ] as const) {
    writeAt(root, dir + "/package.json", JSON.stringify({ name, dependencies, scripts: {
      typecheck: "node --check src.mjs",
      ...(dir === "apps/web" ? {} : { test: "node --test ok.test.ts" }),
    } }));
    writeAt(root, dir + "/src.mjs", "export const value = 1;\n");
    writeAt(root, dir + "/ok.test.ts", "import { test } from 'node:test'; test('fixture passes', () => {});\n");
  }
  for (const name of ["check-docs", "check-entrypoints"]) {
    writeAt(root, "scripts/" + name + ".mjs", readFileSync(new URL("./" + name + ".mjs", import.meta.url), "utf8"));
  }
  writeAt(root, "scripts/dev.mjs", readFileSync(new URL("./dev.mjs", import.meta.url), "utf8"));
  for (const name of ["cli", "discovery"]) {
    writeAt(root, "scripts/lib/" + name + ".mjs", readFileSync(new URL("./lib/" + name + ".mjs", import.meta.url), "utf8"));
  }
  writeAt(root, "docs/README.md", "# Guides\n");
  const repo = initRepo(root);
  return { root, repo, sha: repo.commit("fixture workspace") };
}

function run(root: string, args: readonly string[] = []): ProcessResult {
  return runCli(VERIFY, ["--profile=changed", "--root=" + root, "--quiet", ...args], { cwd: root });
}

function plan(root: string, args: readonly string[] = []): string {
  const result = run(root, ["--dry-run", ...args]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test("docs-only changes run the real link checker without workspace gates and keep evidence", () => {
  const { root, sha } = workspace();
  writeAt(root, "docs/README.md", "# Guides\n[missing](missing.md)\n");
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  assert.equal(report.sha, sha);
  assert.equal(report.dirty, true);
  assert.deepEqual(report.steps.map((step) => step.name), ["check-docs"]);
  assert.match(readFileSync(report.steps[0].logPath, "utf8"), /BROKEN.*missing.md/);
});

test("shared-package edit includes direct and transitive consumers and the Web unit suite", () => {
  const { root } = workspace();
  writeAt(root, "packages/protocol/src.mjs", "export const value = 2;\n");
  const output = plan(root);
  for (const name of ["@hepi/protocol", "@hepi/server", "@hepi/client", "@hepi/web"]) assert.ok(output.includes("--filter " + name), name);
  assert.match(output, /web-unit: .*ok\.test\.ts/);
});

test("server edit executes only server and dependent client gates and propagates a test failure", () => {
  const { root } = workspace();
  writeAt(root, "apps/server/src.mjs", "export const value = 2;\n");
  writeAt(root, "apps/server/ok.test.ts", "import { test } from 'node:test'; test('changed failure', () => { throw Error('failure'); });\n");
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  assert.deepEqual(report.selection.packages, ["@hepi/client", "@hepi/server"]);
  assert.deepEqual(report.steps.map((step) => step.name), ["changed-typecheck", "changed-test"]);
  assert.equal(report.selection.testSelection.mode, "full");
  assert.match(readFileSync(report.steps[1].logPath, "utf8"), /changed failure/);
});

test("base includes committed branch changes, staged deletions and untracked files with spaces", () => {
  const { root, repo, sha } = workspace();
  writeAt(root, "apps/server/src.mjs", "export const value = 2;\n");
  repo.commit("server change");
  repo.raw("rm", "packages/client/src.mjs");
  writeAt(root, "apps/web/new file.mjs", "export {};\n");
  const output = plan(root, ["--base=" + sha]);
  for (const file of ["apps/server/src.mjs", "packages/client/src.mjs", "apps/web/new file.mjs"]) assert.ok(output.includes(file), file);
  assert.match(output, /web-unit:/);
});

test("unknown configuration falls back to full gates plus scripts and repository checks", () => {
  const { root } = workspace();
  writeAt(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n# changed\n");
  const output = plan(root);
  for (const step of ["workspace-typecheck", "workspace-tests", "web-unit", "script-tests", "check-entrypoints", "check-docs"]) assert.ok(output.includes(step + ":"), step);
  assert.match(output, /"fallbackFiles": \[\s*"pnpm-workspace\.yaml"/);
  assert.equal(existsSync(join(root, ".dev")), false);
});

test("script edit selects tooling tests and repository checks without workspace gates", () => {
  const { root } = workspace();
  writeAt(root, "scripts/example.test.ts", "import { test } from 'node:test'; test('example', () => {});\n");
  const output = plan(root);
  // A tooling change is typechecked against its own config, which is the gate the repository
  // declares for it, and its tests run beside the repository checks the edit can break.
  assert.match(output, /script-typecheck: pnpm typecheck:scripts/);
  assert.match(output, /script-tests: .*example\.test\.ts/);
  assert.match(output, /check-entrypoints:/);
  assert.match(output, /check-docs:/);
  assert.doesNotMatch(output, /changed-typecheck:|workspace-typecheck:/);
});

test("clean tree and scratch-only changes explicitly report no checks while preserving revision", () => {
  const { root, sha } = workspace();
  writeAt(root, ".scratch/task/notes.md", "# Notes\n");
  const output = plan(root);
  assert.match(output, /No checks selected/);
  assert.equal(existsSync(join(root, ".dev")), false);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  assert.equal(report.sha, sha);
  assert.deepEqual(report.steps, []);
  assert.deepEqual(report.selection.ignoredFiles, [".scratch/task/notes.md"]);
});

test("invalid base fails before writing artifacts or running checks", () => {
  const { root } = workspace();
  const result = run(root, ["--base=missing-ref"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot select changed checks/);
  assert.equal(existsSync(join(root, ".dev")), false);
});

test("relocated skill checkout changes stay outside product verification", () => {
  const { root } = workspace();
  writeAt(root, ".pi/skills/README.md", "# Upstream skill store\n");
  const output = plan(root);
  assert.match(output, /No checks selected/);
  assert.match(output, /\.pi\/skills\/README\.md/);
});

test("explicit --test-file runs only the named files, in their package, and records why", () => {
  const { root } = workspace();
  writeAt(root, "apps/server/other.test.ts", "import { test } from 'node:test'; test('sibling must not run', () => {});\n");
  const result = run(root, ["--test-file=apps/server/ok.test.ts", "--test-file=packages/protocol/ok.test.ts"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  assert.deepEqual(report.selection.testSelection, {
    mode: "explicit",
    reason: "explicit --test-file selection",
    files: ["apps/server/ok.test.ts", "packages/protocol/ok.test.ts"],
  });
  // One step per package, each in its own directory, naming only the requested files.
  const testSteps = report.steps.filter((step) => step.name.startsWith("changed-test-"));
  assert.deepEqual(testSteps.map((step) => step.name), ["changed-test-apps-server", "changed-test-packages-protocol"]);
  assert.deepEqual(testSteps.map((step) => step.cwd), [join(root, "apps", "server"), join(root, "packages", "protocol")]);
  for (const step of testSteps) {
    assert.match(step.command, /--test --test-reporter=tap \.\/ok\.test\.ts$/);
    assert.doesNotMatch(step.command, /other\.test\.ts/);
  }
  assert.equal(testSteps[0].summary.tests, 1);
  // Typecheck stays package-granular: the whole server and its dependents, not the file.
  const typecheck = report.steps.find((step) => step.name === "changed-typecheck");
  assert.ok(typecheck !== undefined, "the run typechecks the file's package");
  assert.match(typecheck.command, /--filter @hepi\/server/);
  assert.match(typecheck.command, /-r typecheck$/);
  assert.doesNotMatch(typecheck.command, /ok\.test\.ts/);
  // The packages' own `test` scripts are replaced, not supplemented: no `pnpm -r test` step.
  assert.deepEqual(report.steps.filter((step) => step.name === "changed-test"), []);
  assert.match(result.stdout, /tests: explicit \(explicit --test-file selection\)/);
});

test("--test-file runs a package that declares no test script, and its failure propagates", () => {
  // apps/web declares typecheck but no `test` script; its suite is enumerated by webUnitFiles.
  const { root } = workspace();
  writeAt(root, "apps/web/ok.test.ts", "import { test } from 'node:test'; test('web focused', () => {});\n");
  const passing = run(root, ["--test-file=apps/web/ok.test.ts"]);
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  const passReport = readJson<ChangedReport>(reportPath(passing));
  const [passStep] = passReport.steps.filter((step) => step.name.startsWith("changed-test-"));
  assert.ok(passStep !== undefined, "the named file runs as its own step");
  assert.equal(passStep.name, "changed-test-apps-web");
  assert.equal(passStep.cwd, join(root, "apps", "web"));
  assert.equal(passStep.summary.tests, 1);
  assert.equal(passReport.steps.filter((step) => step.name === "changed-test").length, 0);
  assert.equal(passReport.steps.filter((step) => step.name === "web-unit").length, 0);
  writeAt(root, "apps/web/ok.test.ts", "import { test } from 'node:test'; test('web focused failure', () => { throw Error('boom'); });\n");
  const failing = run(root, ["--test-file=apps/web/ok.test.ts"]);
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  const failReport = readJson<ChangedReport>(reportPath(failing));
  const failed = failReport.steps.find((step) => step.exitCode !== 0);
  assert.ok(failed !== undefined, "the report names the failing step");
  assert.equal(failed.name, "changed-test-apps-web");
  assert.match(readFileSync(failed.logPath, "utf8"), /web focused failure/);
});

test("an automatic test-only change in a package without a test script still runs its tests", () => {
  const { root } = workspace();
  writeAt(root, "apps/web/ok.test.ts", "import { test } from 'node:test'; test('web narrowed', () => {});\n");
  const output = plan(root);
  assert.match(output, /"mode": "changed-tests"/);
  assert.match(output, /changed-test-apps-web: .*--test --test-reporter=tap --test-timeout=60000 \.\/ok\.test\.ts/);
  assert.doesNotMatch(output, /changed-test: /);
  assert.doesNotMatch(output, /web-unit:/);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  const [step] = report.steps.filter((candidate) => candidate.name.startsWith("changed-test-"));
  assert.ok(step !== undefined, "the narrowed step ran");
  assert.equal(step.name, "changed-test-apps-web");
  assert.equal(step.summary.tests, 1);
});

test("a test-only change narrows its own package suite without running dependents' suites", () => {
  const { root } = workspace();
  writeAt(root, "packages/protocol/ok.test.ts", "import { test } from 'node:test'; test('narrowed', () => {});\n");
  const output = plan(root);
  assert.match(output, /"mode": "changed-tests"/);
  assert.match(output, /"reason": "every changed file in a workspace package is a test file"/);
  assert.match(output, /changed-test-packages-protocol: .*\/ok\.test\.ts/);
  // The protocol test cannot change server, client or Web behaviour, so those suites are not run.
  assert.doesNotMatch(output, /changed-test: /);
  assert.doesNotMatch(output, /web-unit:/);
  // Typecheck keeps every dependent package even though only a test file changed.
  const typecheck = output.split("\n").find((line) => line.startsWith("changed-typecheck:"));
  assert.ok(typecheck !== undefined, "the run typechecks the changed package");
  for (const name of ["@hepi/protocol", "@hepi/server", "@hepi/client", "@hepi/web"]) assert.ok(typecheck.includes(name), name);
});

test("a source edit keeps every dependent suite and reports the full fallback reason", () => {
  const { root } = workspace();
  writeAt(root, "apps/server/src.mjs", "export const value = 2;\n");
  const output = plan(root);
  assert.match(output, /"mode": "full"/);
  assert.match(output, /changed source in @hepi\/client, @hepi\/server/);
  assert.match(output, /changed-test: .*--filter @hepi\/server --filter @hepi\/client -r test/);
});

test("a deleted test file keeps the package suite instead of narrowing to nothing", () => {
  const { root, repo } = workspace();
  repo.raw("rm", "apps/server/ok.test.ts");
  const output = plan(root);
  assert.match(output, /"mode": "full"/);
  assert.match(output, /deleted test files: apps\/server\/ok\.test\.ts/);
  assert.match(output, /changed-test: .*@hepi\/server/);
});

test("an unusable --test-file is refused before any check runs", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["--test-file=apps/server/src.mjs", /not a test file/],
    ["--test-file=apps/server/missing.test.ts", /does not exist/],
    ["--test-file=docs/notes.test.ts", /not inside a workspace package/],
    ["--test-file=scripts/missing.test.ts", /does not exist/],
  ];
  for (const [flag, message] of cases) {
    const { root } = workspace();
    const result = run(root, [flag]);
    assert.equal(result.status, 2, flag + ": " + result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.equal(existsSync(join(root, ".dev")), false, flag + " wrote artifacts");
  }
});

test("--test-file is a changed-profile flag, and a value-less one is refused", () => {
  const { root } = workspace();
  const wrongProfile = runCli(VERIFY, ["--profile=fast", "--root=" + root, "--test-file=apps/server/ok.test.ts"], { cwd: root });
  assert.equal(wrongProfile.status, 2);
  assert.match(wrongProfile.stderr, /--test-file requires --profile=changed/);
  const missingValue = run(root, ["--test-file"]);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--test-file needs a value/);
  assert.equal(existsSync(join(root, ".dev")), false);
});

test("explicit --test-file accepts a scripts test, running it alone in the scripts group", () => {
  const { root } = workspace();
  writeAt(root, "scripts/example.test.ts", "import { test } from 'node:test'; test('tooling focused', () => {});\n");
  writeAt(root, "scripts/other.test.ts", "import { test } from 'node:test'; test('sibling must not run', () => {});\n");
  const output = plan(root, ["--test-file=scripts/example.test.ts"]);
  assert.match(output, /"mode": "explicit"/);
  assert.match(output, /"files": \[\s*"scripts\/example\.test\.ts"/);
  // The named file replaces the whole tooling suite: no `script-tests` step over every file.
  assert.match(output, /changed-test-scripts: .*--test-timeout=120000 \.\/example\.test\.ts$/m);
  assert.doesNotMatch(output, /script-tests:/);
  assert.match(output, /check-entrypoints:/);
  assert.match(output, /check-docs:/);
  assert.doesNotMatch(output, /changed-typecheck:|changed-test:/);
  const result = run(root, ["--test-file=scripts/example.test.ts"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  assert.deepEqual(report.selection.testSelection, {
    mode: "explicit",
    reason: "explicit --test-file selection",
    files: ["scripts/example.test.ts"],
  });
  const step = report.steps.find((candidate) => candidate.name === "changed-test-scripts");
  assert.ok(step !== undefined, "the named tooling test runs in the scripts group");
  assert.equal(step.cwd, join(root, "scripts"));
  assert.match(step.command, /--test --test-reporter=tap --test-timeout=120000 \.\/example\.test\.ts$/);
  assert.doesNotMatch(step.command, /other\.test\.ts/);
  assert.equal(step.summary.tests, 1);
  // A tooling change is typechecked against its own config beside the repository checks the
  // edit can break, and the named file replaces the whole tooling suite.
  assert.deepEqual(report.steps.map((candidate) => candidate.name), ["changed-test-scripts", "script-typecheck", "check-entrypoints", "check-docs"]);
});

test("a scripts test failure propagates, and a non-test scripts file is refused", () => {
  const { root } = workspace();
  writeAt(root, "scripts/example.test.ts", "import { test } from 'node:test'; test('tooling focused failure', () => { throw Error('boom'); });\n");
  const result = run(root, ["--test-file=scripts/example.test.ts"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  const failing = report.steps.find((step) => step.exitCode !== 0);
  assert.ok(failing !== undefined, "the report names the failing step");
  assert.equal(failing.name, "changed-test-scripts");
  assert.match(readFileSync(failing.logPath, "utf8"), /tooling focused failure/);
  writeAt(root, "scripts/example.mjs", "export {};\n");
  const refused = run(root, ["--test-file=scripts/example.mjs"]);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /scripts\/example\.mjs is not a test file/);
});

test("a scripts test edit keeps the tooling suite, its checks and no workspace gates", () => {
  const { root } = workspace();
  writeAt(root, "scripts/example.test.ts", "import { test } from 'node:test'; test('tooling changed', () => {});\n");
  const output = plan(root);
  assert.match(output, /script-typecheck: pnpm typecheck:scripts/);
  assert.match(output, /script-tests: .*example\.test\.ts/);
  assert.match(output, /check-entrypoints:/);
  assert.match(output, /check-docs:/);
  assert.doesNotMatch(output, /changed-test-scripts:/);
});

test("a focused run that fails still names the failing test in its own log", () => {
  const { root } = workspace();
  writeAt(root, "apps/server/ok.test.ts", "import { test } from 'node:test'; test('focused failure', () => { throw Error('boom'); });\n");
  const result = run(root, ["--test-file=apps/server/ok.test.ts"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = readJson<ChangedReport>(reportPath(result));
  const failing = report.steps.find((step) => step.exitCode !== 0);
  assert.ok(failing !== undefined, "the report names the failing step");
  assert.equal(failing.name, "changed-test-apps-server");
  assert.match(readFileSync(failing.logPath, "utf8"), /focused failure/);
});
