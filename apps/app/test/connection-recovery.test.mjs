import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The App's two configuration surfaces: the first run, and the replacement a refused connection opens.
 *
 * The distinction that matters is the one the ticket states — a replacement must not be a deletion. The form is rendered
 * over the connection this machine has, so it starts from the stored profile and origin, it cannot be submitted with the
 * credential that was refused (the field starts empty and is required), and Cancel returns to that connection because
 * nothing was written yet. Asserting the rendered form is asserting the contract a person sees; the write itself is the
 * shell's own command, asserted in shell.test.mjs.
 */
const outfile = path.join(appRoot, ".bundle-test", "configure.cjs");
buildSync({
  entryPoints: [path.join(appRoot, "src", "Configure.tsx")],
  bundle: true,
  outfile,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  // React is the test's own runtime, resolved from this package beside the bundle: what is under test is the App's form,
  // not the renderer.
  external: ["react", "react-dom", "react-dom/server"],
  logLevel: "silent",
  tsconfig: path.join(appRoot, "tsconfig.json"),
});
const { Configure } = require(outfile);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const render = (props) => renderToStaticMarkup(React.createElement(Configure, props));

/** The value a labelled input starts with, read out of the markup rather than assumed. */
function inputValue(html, label) {
  const labelled = html.split("</label>").find(chunk => chunk.includes(label));
  return labelled?.match(/value="([^"]*)"/)?.[1] ?? null;
}

test("a first run offers Connect and nothing to cancel", () => {
  const html = render({ failure: null });
  assert.match(html, /Connect to a Hepi Gateway/);
  assert.match(html, />Connect</);
  assert.doesNotMatch(html, />Cancel</, "a first run has no connection to return to");
  assert.doesNotMatch(html, /Replace connection/);
  assert.equal(inputValue(html, "Profile"), "default");
  assert.equal(inputValue(html, "Gateway address"), "");
  assert.equal(inputValue(html, "Device credential"), "");
});

test("a refused connection opens the form over the stored one, and cancelling keeps it", () => {
  const replacing = { profile: "workstation", origin: "https://gateway.example", token: "device-refused" };
  const html = render({ failure: "This App's device credential was refused.", replacing, onCancel() {} });
  // Rendered markup escapes the apostrophe, so the heading is matched without it.
  assert.match(html, /Replace this App&#x27;s connection/);
  // The stored facts are what the form starts from: a replacement is about the credential, not about retyping an address.
  assert.equal(inputValue(html, "Profile"), "workstation");
  assert.equal(inputValue(html, "Gateway address"), "https://gateway.example");
  // The refused bearer is not carried into the form: it is the value being replaced, and prefilling it would invite
  // submitting the same refusal again.
  assert.equal(inputValue(html, "Device credential"), "");
  assert.doesNotMatch(html, /device-refused/, "the stored bearer is never rendered into the page");
  assert.match(html, />Cancel</, "cancelling is offered beside the submit");
  assert.match(html, />Replace connection</);
  assert.match(html, /stored connection is kept unless you connect/, "the form states that cancelling changes nothing");
  assert.match(html, /role="alert"/, "the refusal is still readable on the form that replaces it");
});

test("the App entry hands the workbench its own two management actions and no others", () => {
  // The workbench offers a step only when a host states it, so this asserts the App is the host that states these two —
  // and that both reach the shell's own commands, which are the only code that can touch the credential store.
  const bundle = buildSync({
    entryPoints: [path.join(appRoot, "src", "main.tsx")],
    bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic",
    external: ["*.css"], logLevel: "silent", tsconfig: path.join(appRoot, "tsconfig.json"),
    define: { "process.env.NODE_ENV": "\"production\"" },
  }).outputFiles.map(file => file.text).join("\n");
  assert.match(bundle, /connectionManagement/, "the App states the host-managed actions");
  assert.match(bundle, /app_forget/, "disconnect is the shell's own forget command");
  assert.match(bundle, /app_configure/, "configure is the shell's own configure command");
  // The App's refusal is not the Web page's: a device bearer is not a cookie, so no sign-in form is what a refused App
  // shows. The shared tree still carries the Web form (it is the same workbench), so the claim is about the App's own
  // host configuration — that the two management actions are stated — rather than about a module being absent.
  assert.doesNotMatch(bundle, /cookie\s*:\s*\{\s*kind:\s*"cookie"/, "the App states no cookie credential");
});
