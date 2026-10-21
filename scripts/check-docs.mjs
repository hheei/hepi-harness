/**
 * `check:docs` — every relative Markdown link resolves, its fragment names a real heading,
 * and the documentation index covers the guides beside it. Read-only: it never edits a
 * document, and it never rewrites a measurement to make a check pass.
 *
 * A missing target, a fragment that no heading produces, and a guide the index stopped
 * linking to are three different ways for a reader to land nowhere, so all three are
 * reported with the file, the line and the target.
 *
 * `--root=<dir>` checks a checkout other than the one the script lives in, the same
 * convention the other check scripts use; the default is this repository.
 *
 * Usage: node scripts/check-docs.mjs [--root=<dir>] [--json=<path>]
 */
import { REPO_ROOT } from "./dev.mjs";
import { brokenLinks, markdownFiles, uncoveredGuides } from "./lib/discovery.mjs";
import { isMain, parseCli, writeJson } from "./lib/cli.mjs";

const USAGE = `
Usage: node scripts/check-docs.mjs [--root=<dir>] [--json=<path>]

  --root=<dir>    check a checkout other than the one the script lives in
  --json=<path>   write the report as JSON at <path>
  -h, --help      print this usage and exit
`;

export function checkDocs(root = REPO_ROOT) {
  const files = markdownFiles(root);
  const broken = brokenLinks(root, files);
  const uncovered = uncoveredGuides(root);
  return { files: files.length, broken, uncovered, ok: broken.length === 0 && uncovered.length === 0 };
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["root", "json"] });
  if (exitCode !== undefined) return exitCode;
  const result = checkDocs(flags.root ?? REPO_ROOT);
  for (const miss of result.broken) {
    const detail = miss.fragment === undefined ? miss.target : miss.target + " (no heading produces #" + miss.fragment + ")";
    console.log("BROKEN  " + miss.file + ":" + miss.line + "  ->  " + detail);
  }
  for (const file of result.uncovered) {
    console.log("UNCOVERED  " + file + "  ->  not linked from docs/README.md");
  }
  console.log(
    "checked " + result.files + " Markdown files; " + result.broken.length + " broken relative links; " +
    result.uncovered.length + " guides missing from the index",
  );
  if (flags.json) writeJson(flags.json, result);
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
