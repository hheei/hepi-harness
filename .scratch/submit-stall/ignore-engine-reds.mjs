/**
 * Degrade the helper's gitignore engine one capability at a time and report which test notices. Each mutation is the
 * shape the old reading had: a negation ignored, a mid-pattern globstar read as a literal, an ending that does not
 * anchor the directory boundary, a bracket class dropped. The parity test must fail on each of them, and the snapshot
 * tests must fail on the ones that change what crosses the wire.
 *
 * Run: node .scratch/submit-stall/ignore-engine-reds.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const file = "packages/gateway/src/ssh-filesystem.ts";
const marker = "export const REMOTE_FILESYSTEM_SCRIPT = ";

const MUTATIONS = [
  ["negation ignored", "    if body.startswith('!'):", "    if False:"],
  ["mid-pattern globstar literal", "    return '(?:\\\\/[^\\\\/]+)*' if match.start() + 6 < len(match.string) else '\\\\/.+'", "    return match.group(0)"],
  ["ending does not anchor a directory", "    return text + '$' if _TEST_TRAILING_SLASH.search(text) else text + '(?=$|\\\\/$)'", "    return text + '$' if _TEST_TRAILING_SLASH.search(text) else text + '(?=$|\\\\/)'"],
  ["bracket class dropped", "    if close == ']' and len(end_escape) % 2 == 0:", "    if False:"],
  ["parent traversal dropped", "        parent = self._t('/'.join(slices) + '/', slices, check_unignored)", "        parent = False"],
];

function withScript(mutate) {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(marker) + marker.length;
  let end = start + 1;
  while (source[end] !== '"' || source[end - 1] === "\\") end += 1;
  const program = JSON.parse(source.slice(start, end + 1));
  const mutated = mutate(program);
  writeFileSync(file, source.slice(0, start) + JSON.stringify(mutated) + source.slice(end + 1));
}

function run(command) {
  try {
    execFileSync("bash", ["-lc", command], { stdio: "pipe" });
    return "pass";
  } catch {
    return "FAIL";
  }
}

let proven = 0;
for (const [label, from, to] of MUTATIONS) {
  let applied = false;
  withScript((program) => {
    if (!program.includes(from)) return program;
    applied = true;
    return program.replace(from, to);
  });
  if (!applied) { console.log(label + ": ANCHOR MISSING (the engine moved; fix this script)"); continue; }
  const parity = run("node --test packages/gateway/test/ignore-parity.test.ts");
  const snapshot = run("node --test packages/gateway/test/resource-snapshot.test.ts");
  execFileSync("git", ["checkout", file]);
  if (parity === "FAIL") proven += 1;
  console.log(label.padEnd(36) + " parity=" + parity.padEnd(5) + " snapshot=" + snapshot);
}
console.log(proven + " of " + MUTATIONS.length + " mutations are caught by the parity test");
