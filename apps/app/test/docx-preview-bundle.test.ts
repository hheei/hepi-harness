/**
 * The shared Word document preview resolves for a browser build of this shell.
 *
 * `@hepi/ui` declares `mammoth` as a production dependency because it is the package that puts the reader into a shipped
 * chunk; what has to be true for the App is that the reader survives a **browser** bundle, since the preview runs inside
 * this shell's webview with no Node in sight. `mammoth`'s `browser` field is what decides that, and it also decides the
 * input shape (`browser/unzip.js` accepts only `{ arrayBuffer }`, while `lib/unzip.js` reaches for `Buffer`), so an
 * assertion on which of the two files the bundler reached for is the assertion that matters — not that a chunk exists.
 *
 * It is bundled here from `packages/ui/src/lib/docx-preview.ts` with this App's own tsconfig and `platform: browser`, the
 * same settings `vite build` uses. No Rust, no shell: the question is only what the module graph resolves to.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync }: typeof import("esbuild") = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const preview = path.join(repoRoot, "packages", "ui", "src", "lib", "docx-preview.ts");

function browserBundle() {
  return buildSync({
    entryPoints: [preview],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    metafile: true,
    outdir: path.join(appRoot, ".bundle-test"),
    tsconfig: path.join(appRoot, "tsconfig.json"),
    define: { "process.env.NODE_ENV": "\"production\"" },
    logLevel: "silent",
  });
}

test("a browser build of the shared preview resolves mammoth's browser entry, not its Node one", () => {
  const inputs = Object.keys(browserBundle().metafile.inputs);
  const browser = inputs.filter((input: string) => input.includes("mammoth/browser/"));
  const node = inputs.filter((input: string) => /mammoth\/lib\/(unzip|docx\/files)\.js$/.test(input));
  assert.ok(browser.length > 0, "mammoth's browser mapping was not bundled at all: " + inputs.join(", "));
  assert.deepEqual(node, [], "the Node reader would reach for Buffer in a webview that has none: " + node.join(", "));
});

test("the bundled preview imports no Node builtin and no fs path", () => {
  const { outputFiles } = browserBundle();
  const output = outputFiles.map((file: { text: string }) => file.text).join(path.sep);
  for (const forbidden of ["node:fs", "node:buffer", "require(\"fs\")"]) {
    assert.equal(output.includes(forbidden), false, forbidden + " must not reach a webview bundle");
  }
  // The browser entry's own input contract, which is why the preview hands an ArrayBuffer and nothing else.
  assert.match(output, /arrayBuffer/, "the bundled reader lost the input shape the preview depends on");
});
