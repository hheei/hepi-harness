/**
 * Workflow 4: the documentation and entry-point checks, as CLIs, over fixture checkouts.
 *
 * Both answer the same question - does a pointer in this repository still land somewhere - and
 * both are driven here as child processes against a small repository built for the case, so the
 * exit code, the printed line and the JSON report are all read as a caller sees them.
 *
 * What this protects: a link whose file exists but whose heading does not; a guide the index
 * stopped covering; a `node --test a b c` invocation whose second or third file went missing
 * behind the first; and a known-missing entry that has to stay visible without being able to
 * fail the check on its own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, runCli, writeAt } from "./testing/fixture.mjs";
import { checkEntrypoints, exitCodeFor } from "./check-entrypoints.mjs";

const CHECK_DOCS = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));
const CHECK_ENTRYPOINTS = fileURLToPath(new URL("./check-entrypoints.mjs", import.meta.url));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * A documentation tree with one link that resolves, one whose heading does not exist, one
 * whose file is gone, a self-link, a link inside a fenced block, and an uncovered guide.
 */
function docsRepo({ clean = false } = {}) {
  const root = fixtureDir();
  writeAt(root, "docs/README.md", [
    "# Documentation index",
    "",
    "[Guide](guide.md#real-heading)",
    clean ? "[Orphan](orphan.md)" : "[Wrong heading](guide.md#real-hading)",
    clean ? "" : "[Gone](missing.md)",
    "[ADR](adr/0001-x.md)",
    "[Self](#documentation-index)",
    "",
    "```bash",
    "curl http://127.0.0.1/ | [not a link](fenced.md)",
    "```",
    "",
  ].join("\n"));
  writeAt(root, "docs/guide.md", "# Guide\n\n## Real heading\n");
  writeAt(root, "docs/adr/0001-x.md", "# ADR\n\n[back](../README.md)\n");
  writeAt(root, "docs/orphan.md", "# Orphan\n");
  writeAt(root, "README.md", "# root readme\n");
  return root;
}

test("check:docs reports a missing file and a heading that does not exist, with their lines", () => {
  const root = docsRepo();
  const json = join(root, "docs-report.json");
  const result = runCli(CHECK_DOCS, ["--root=" + root, "--json=" + json], { cwd: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Two different ways to land nowhere, each named with the file and the line to fix.
  assert.match(result.stdout, /BROKEN {2}docs\/README\.md:4 {2}-> {2}guide\.md#real-hading \(no heading produces #real-hading\)/);
  assert.match(result.stdout, /BROKEN {2}docs\/README\.md:5 {2}-> {2}missing\.md/);
  assert.match(result.stdout, /UNCOVERED {2}docs\/orphan\.md {2}-> {2}not linked from docs\/README\.md/);
  // The link inside the fenced block is a shell snippet, not a link, and is not reported.
  assert.equal(result.stdout.includes("fenced.md"), false);
  assert.match(result.stdout, /checked 5 Markdown files; 2 broken relative links; 1 guides missing from the index/);
  const report = readJson(json);
  assert.equal(report.files, 5);
  assert.equal(report.ok, false);
  assert.deepEqual(report.broken.map((entry) => [entry.file, entry.line, entry.target]), [
    ["docs/README.md", 4, "guide.md#real-hading"],
    ["docs/README.md", 5, "missing.md"],
  ]);
  assert.equal(report.broken[0].fragment, "real-hading");
  assert.equal(report.broken[0].targetFile, "docs/guide.md");
  assert.deepEqual(report.uncovered, ["docs/orphan.md"]);
});

test("check:docs passes when every link resolves, its heading exists and the index covers the guides", () => {
  const root = docsRepo({ clean: true });
  const result = runCli(CHECK_DOCS, ["--root=" + root], { cwd: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /checked 5 Markdown files; 0 broken relative links; 0 guides missing from the index/);
  assert.equal(result.stdout.includes("BROKEN"), false);
  assert.equal(result.stdout.includes("UNCOVERED"), false);
});

/**
 * A repository whose scripts name several files per invocation: one file missing in the middle,
 * and a glob that is not a file at all.
 */
function entrypointsRepo({ secondFileExists = false } = {}) {
  const root = fixtureDir();
  writeAt(root, "package.json", JSON.stringify({
    name: "fixture-root",
    private: true,
    scripts: {
      "test:multi": "node --test scripts/a.test.mjs scripts/b.test.mjs scripts/c.test.mjs",
      "test:glob": "node --test scripts/*.test.mjs",
      "test:echo": "echo not-a-file",
    },
  }));
  writeAt(root, "scripts/a.test.mjs", "export {};\n");
  if (secondFileExists) writeAt(root, "scripts/b.test.mjs", "export {};\n");
  writeAt(root, "scripts/c.test.mjs", "export {};\n");
  return root;
}

test("check:entrypoints reads every file an invocation names, not just the first", () => {
  const root = entrypointsRepo();
  const json = join(root, "entrypoints-report.json");
  const result = runCli(CHECK_ENTRYPOINTS, ["--root=" + root, "--json=" + json], { cwd: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // The third file argument of the same invocation is the one that is gone: a first-file-only
  // parser would have reported `a.test.mjs`, found it, and said nothing.
  assert.match(result.stdout, /MISSING\s+\. {2}test:multi {2}-> {2}scripts\/b\.test\.mjs/);
  // A glob is not a file and an echo names none, so neither is invented into an entry.
  assert.equal(result.stdout.includes("test:glob"), false);
  assert.equal(result.stdout.includes("test:echo"), false);
  assert.match(result.stdout, /2 entry files present; 0 known-missing \(pre-existing, recorded\); 1 newly missing/);
  const report = readJson(json);
  assert.equal(report.ok, false);
  assert.equal(report.present, 2);
  assert.deepEqual(report.newlyMissing, [{ package: ".", script: "test:multi", target: "scripts/b.test.mjs" }]);
  assert.deepEqual(report.knownMissing, []);
});

test("a known-missing entry stays visible without failing the check, and --strict makes it fatal", () => {
  // The record is empty at this revision: the two entries it carried named the retired Next
  // presentation layer's scripts. The mechanism is driven through its exported function with an
  // explicit record, which is the same filter main applies and what a future entry would travel.
  const root = entrypointsRepo({ secondFileExists: true });
  writeAt(root, "apps/web/package.json", JSON.stringify({
    name: "web",
    scripts: { "test:legacy": "node e2e/legacy.mjs" },
  }));
  const known = [{ package: "apps/web", script: "test:legacy", target: "e2e/legacy.mjs" }];
  const recorded = checkEntrypoints(root, known);
  assert.deepEqual(recorded.knownMissing, known);
  assert.deepEqual(recorded.newlyMissing, []);
  assert.equal(recorded.ok, true, "a recorded entry does not fail the check on its own");
  assert.equal(exitCodeFor(recorded), 0, "a recorded entry does not fail the run either");
  assert.equal(exitCodeFor(recorded, { strict: true }), 1, "--strict makes the record fatal");
  // Without the record the same entry is a new miss: recording it is what separates the two.
  assert.deepEqual(checkEntrypoints(root, []).newlyMissing, known);
  // The CLI carries the repository's own record, which is empty here, so this entry is a new miss for
  // it — and it says so by name instead of dropping the script.
  const unrecorded = runCli(CHECK_ENTRYPOINTS, ["--root=" + root], { cwd: root });
  assert.equal(unrecorded.status, 1, unrecorded.stdout + unrecorded.stderr);
  assert.match(unrecorded.stdout, /MISSING\s+apps\/web\s+test:legacy\s+->\s+e2e\/legacy\.mjs/);
  assert.match(unrecorded.stdout, /3 entry files present; 0 known-missing \(pre-existing, recorded\); 1 newly missing/);
  // And the CLI's own record is empty, so --strict has nothing to make fatal on this repository.
  const strict = runCli(CHECK_ENTRYPOINTS, ["--root=" + root, "--strict"], { cwd: root });
  assert.equal(strict.stdout, unrecorded.stdout, "--strict changes the verdict, never the visibility");
});

test("check:docs skips the relocated upstream skill checkout but checks project agent docs", () => {
  const root = docsRepo({ clean: true });
  writeAt(root, ".pi/skills/skills/example/SKILL.md", "[upstream template](missing.md)\n");
  writeAt(root, ".pi/agents/worker.md", "[broken project pointer](missing.md)\n");
  const result = runCli(CHECK_DOCS, ["--root=" + root], { cwd: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /BROKEN.*\.pi\/agents\/worker.md/);
  assert.doesNotMatch(result.stdout, /BROKEN.*\.pi\/skills/);
});
