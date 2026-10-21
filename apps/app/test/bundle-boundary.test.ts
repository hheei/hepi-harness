import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
// The bundler's own declarations: a build this test needs to read the graph of is typed by the options it states.
const { buildSync }: typeof import("esbuild") = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const uiRoot = path.resolve(appRoot, "..", "..", "packages", "ui", "src");

/**
 * What may not enter the App bundle.
 *
 * The App is a packaged shell: it has no Node, no Next server and no internal credential, so a module that reaches one
 * of those is a dependency the shell cannot satisfy — or, worse, one that would ship a secret. This asserts the boundary
 * the extraction is for, on the real entry the App builds from, rather than on a hand-picked import list that a new
 * import could quietly bypass.
 */
function bundle() {
  const result = buildSync({
    entryPoints: [path.join(appRoot, "src", "main.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    metafile: true,
    outdir: path.join(appRoot, ".bundle-test"),
    // The stylesheets are the bundler's business, not this test's: what is asserted here is the module graph, and Vite
    // resolves Tailwind's own entry through its plugin. A CSS import is therefore left as an import.
    external: ["*.css"],
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
    define: { "process.env.NODE_ENV": "\"production\"" },
  });
  return { inputs: Object.keys(result.metafile.inputs), output: result.outputFiles.map((file: { text: string }) => file.text).join("\n") };
}

test("the App bundle holds no Next module, no Node builtin and no internal credential", () => {
  const { inputs, output } = bundle();
  // Every module the entry really pulls in, by the path the bundler resolved. Type-only imports leave no input, which is
  // why the pi-* packages that supply only types are absent here while their declarations still typecheck.
  const forbidden: readonly (readonly [RegExp, string])[] = [
    [/\bnext\/(dist|server|image|navigation|headers|link)\b/, "Next module"],
    // A Node builtin is only ever reached as the bare specifier `node:fs` or `fs`, never as a package's own file called
    // `path.js` — so the pattern states the resolved module, not any path containing the word.
    [/(^|\/)node:(fs|path|os|stream|module|url|child_process)(\.js)?$/, "Node builtin"],
    [/node_modules\/(fs|path|os|stream|child_process)\//, "Node builtin"],
    [/@earendil-works\/pi-coding-agent\/dist/, "the coding-agent runtime"],
    [/@earendil-works\/pi-agent-core\/dist/, "the agent runtime"],
  ];
  for (const [pattern, label] of forbidden) {
    const hits = inputs.filter((input: string) => pattern.test(input));
    assert.deepEqual(hits, [], label + " must not be bundled into the App: " + hits.join(", "));
  }
  // No credential material reaches the bundle: the App holds a device bearer the shell supplies, and a service token is
  // the ingress's own business.
  for (const name of ["HEPI_AUTH_TOKEN", "HEPI_INGRESS_SERVICE_TOKEN", "HEPI_WEB_LOGIN_TOKEN", "serviceToken"]) {
    assert.equal(output.includes(name), false, name + " must not appear in the App bundle");
  }
});

test("the App bundle states its own history and never a Web-only install surface", () => {
  const { output } = bundle();
  // The App's entry is the only place that knows which history it has. It mounts the hash history — a document loaded
  // from a bundle has no per-address page — and the path-based one is not in its graph at all.
  assert.match(output, /HashRouter/, "the App mounts the hash history its bundle needs");
  assert.equal(/BrowserRouter/.test(output), false, "the App's graph holds no path-based history");
  // A service worker registration in the App would claim an offline behaviour this build does not implement.
  assert.equal(/serviceWorker\.register/.test(output), false, "the App registers no service worker");
});
