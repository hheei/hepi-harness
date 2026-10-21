import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import ignore from "ignore";
import { REMOTE_FILESYSTEM_SCRIPT } from "../src/ssh-filesystem.ts";

/**
 * The helper matches gitignore rules with a port of `node-ignore@7.0.5`, the engine the loader and the local producer
 * use. Two engines are only one grammar if they decide the same way, so this test runs both over a generated corpus of
 * patterns and paths and requires every decision to agree — including the shapes the old reading handed back to the
 * loader: a negation, a bracket class, `?`, a brace, a backslash escape and a `**` inside a pattern.
 *
 * The corpus is generated rather than listed. A fixed list proves the cases someone thought of, and that is exactly
 * what was wrong before: the fallback existed because the reading was incomplete, and a hand-written list would have
 * been written from the same incomplete idea.
 *
 * The helper's side is asked through the shipped source and nothing else: the program is cut at its command dispatch
 * (everything before it is the engine), the corpus travels in on stdin and the decisions come back on stdout, so there
 * is no fixture file to keep in step and no second copy of the engine to test. `python3` is the engine's own runtime —
 * the interpreter the remote host runs the helper with — not a tool the fixture borrows.
 */

/** One pattern atom, covering the grammar and the malformed shapes around it. */
const ATOMS = [
  "a", "b", "ab", "keep", "ignored", "generated", "nested", "vendor", "src",
  "*.md", "*.js", "a*", "*b", "*", "**", "**/", "/", "?", "[ab]", "[!a]", "[a-z]", "{a,b}",
  "a/**", "**/generated", "generated/**", "a/**/b", "**/foo/bar", "!/keep", "\\!x", "\\#y", "#c",
  "", "   ", "a ", "a\\ ", "docs/", "docs", "!docs/", "*.log", "!*.log",
  "foo/bar", "foo/bar/", "a?c", "[", "]", "[a", "a]", "\\*", "x\\*", "**a", "a**", "*a*", "a*b*c",
  "**/**", "a/**/**", "sub/*.md", "sub/**/x.md", "node_modules", "node_modules/", ".hidden", "a.b", "a.b/",
  "!*", "!**", "!\\", "..", "../x", "a/../b", "/abs", "//double", "a//b", "trail/", "/lead", "*/x", "x/*", "**/x/**",
];

/** One root-relative path, as the producers match them: a directory with a trailing slash, a file without. */
const PATHS = [
  "a", "a/", "a/b", "a/b/c", "ab", "ab/", "keep", "keep/", "keep/x.md", "ignored", "ignored/SKILL.md",
  "nested/generated", "nested/generated/SKILL.md", "generated", "generated/x", "vendor/x.md", "src/a.js",
  "docs", "docs/", "docs/x", "foo/bar", "foo/bar/baz", "x.md", "a.js", "a.md", "a/b.md", "top", "top/a",
  ".hidden", "a/.hidden", "a/b/c/d", "sub/x.md", "sub/deep/x.md", "node_modules", "node_modules/x", "a.b",
  "a.b/c", "abs", "lead", "x/y", "a/x", "x.md/y", "a*b", "abc", "ac", "a_c", "deep/a/b/c", "a/keep",
];

/** A deterministic generator: one corpus, the same on every run, without a fixture file to keep in step. */
function corpus(): { patterns: string[]; paths: string[] }[] {
  let state = 777;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const cases: { patterns: string[]; paths: string[] }[] = [];
  for (let index = 0; index < 1500; index += 1) {
    const patterns: string[] = [];
    const count = 1 + Math.floor(next() * 5);
    for (let atom = 0; atom < count; atom += 1) patterns.push(ATOMS[Math.floor(next() * ATOMS.length)]!);
    const paths = PATHS.filter(() => next() < 0.5);
    cases.push({ patterns, paths: paths.length > 0 ? paths : PATHS.slice(0, 6) });
  }
  return cases;
}

/** The helper's own program text up to its command dispatch: the engine, and nothing that reads a request frame. */
const DISPATCH = String.fromCharCode(10, 10) + "root = os.path.realpath(sys.argv[1])";

/** The one program the helper's engine is asked through: its own source, its own `Ignore` surface, one answer per case. */
function driver(engine: string): string {
  return [
    "import json, sys",
    "namespace = {'__name__': 'hepi_engine'}",
    "exec(compile(" + JSON.stringify(engine) + ", 'hepi', 'exec'), namespace)",
    "cases = json.load(sys.stdin)",
    "answers = []",
    "for case in cases:",
    "    matcher = namespace['Ignore']()",
    "    matcher.add(case['patterns'])",
    "    answers.append([matcher.ignores(path) for path in case['paths']])",
    "sys.stdout.write(json.dumps(answers))",
  ].join(String.fromCharCode(10));
}

test("the helper's gitignore engine decides exactly what node-ignore decides", (t) => {
  assert.ok(REMOTE_FILESYSTEM_SCRIPT.includes(DISPATCH), "the helper dispatch moved; this test executes the program before it");
  const engine = REMOTE_FILESYSTEM_SCRIPT.slice(0, REMOTE_FILESYSTEM_SCRIPT.indexOf(DISPATCH));
  const cases = corpus();
  const answers = JSON.parse(execFileSync("python3", ["-c", driver(engine)], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as boolean[][];
  assert.equal(answers.length, cases.length, "the helper answered every pattern set");
  const disagreements: string[] = [];
  let comparisons = 0;
  for (const [index, item] of cases.entries()) {
    const reference = ignore();
    reference.add(item.patterns);
    for (const [position, path] of item.paths.entries()) {
      comparisons += 1;
      const expected = reference.ignores(path);
      const actual = answers[index]![position];
      if (actual !== expected && disagreements.length < 10) {
        disagreements.push(JSON.stringify({ patterns: item.patterns, path, node: expected, helper: actual }));
      }
    }
  }
  assert.deepEqual(disagreements, [], comparisons + " comparisons over " + cases.length + " pattern sets");
  t.diagnostic(comparisons + " decisions agree over " + cases.length + " generated pattern sets");
});
