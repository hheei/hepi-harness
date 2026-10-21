import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import type * as shellModule from "../src/shell.ts";

const require = createRequire(import.meta.url);
const { buildSync }: typeof import("esbuild") = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The shell's IPC contract, from the page's side.
 *
 * The Rust half is the commands it registers; this half is the names and arguments the page sends. They are two files in
 * two languages, so a rename in one of them is a first-run App that stores nothing and says nothing — the test states the
 * exact pairs, over the real `invoke` the App ships, rather than a hand-written stand-in.
 *
 * The readiness arguments are asserted as a whole set because a packaged run reads them as its only evidence of what the
 * WebView reached: a surface that names a connection must name the connection the deployment stated with it, and a report
 * made before a read settles must state no connection at all.
 */
/** One command the page sent, as the shell received it. */
type Sent = { readonly command: string; readonly args: Record<string, unknown> };
/**
 * The sandbox one bundle runs in.
 *
 * The bundle is CommonJS over a page's own globals, so the sandbox is the page: its module record, the platform values
 * it needs, and — inside the shell — the internals Tauri puts in the document before any page script runs.
 */
type Sandbox = {
  module: { exports: Record<string, unknown> };
  exports: Record<string, unknown>;
  console: Console;
  Promise: PromiseConstructor;
  Error: ErrorConstructor;
  window?: Sandbox;
  globalThis?: Sandbox;
  __TAURI_INTERNALS__?: { invoke(command: string, args: Record<string, unknown>): Promise<unknown> };
};
function loadShellModule(withShell: boolean) {
  const bundle = buildSync({
    entryPoints: [path.join(appRoot, "src", "shell.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  const calls: Sent[] = [];
  const sandbox: Sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    Promise,
    Error,
  };
  if (withShell) {
    // What Tauri puts in the document before any page script runs.
    sandbox.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
        calls.push({ command, args });
        return command === "app_build" ? { version: "0.1.0", client_revision: "c", shell_revision: "s", target: "x86_64" } : undefined;
      },
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bundle, sandbox);
  // The calls crossed a VM boundary, so they are compared as JSON rather than by prototype identity.
  return { shell: sandbox.module.exports as typeof shellModule, sent: () => calls.map(call => JSON.stringify(call)) };
}

test("the page asks the shell for exactly the commands the shell registers", async () => {
  const { shell, sent } = loadShellModule(true);
  assert.equal(shell.inShell(), true, "a document with the shell's internals is inside the shell");

  const build = await shell.readBuild();
  assert.equal(build.client_revision, "c");

  shell.reportSurface("configure");
  shell.reportConnection({ kind: "refused", reason: "This App's device credential was refused." });
  shell.reportConnection({ kind: "admitted", profile: "workstation", backendId: "backend-a", accountScope: "account-a", client: "device:cred-1" });
  await new Promise(resolve => setImmediate(resolve));

  await shell.configureConnection({ profile: "workstation", origin: "https://gateway.example", token: "device-token" });
  await shell.forgetConnection();

  assert.deepEqual(sent(), [
    JSON.stringify({ command: "app_build", args: {} }),
    // A mount state states no connection: four empty fields and no reason, which is what tells it apart from an answer.
    JSON.stringify({ command: "app_ready", args: { surface: "configure", backend: "", scope: "", client: "", profile: "", reason: "" } }),
    // A refusal states the reason and still no connection: the deployment never admitted one.
    JSON.stringify({ command: "app_ready", args: { surface: "refused", backend: "", scope: "", client: "", profile: "", reason: "This App's device credential was refused." } }),
    // The admitted report is the only one that names a connection, and it names the four facts the descriptor answered.
    JSON.stringify({ command: "app_ready", args: { surface: "workbench", backend: "backend-a", scope: "account-a", client: "device:cred-1", profile: "workstation", reason: "" } }),
    JSON.stringify({ command: "app_configure", args: { profile: "workstation", origin: "https://gateway.example", token: "device-token" } }),
    JSON.stringify({ command: "app_forget", args: {} }),
  ]);
});

test("the bearer never reaches the readiness line", async () => {
  const { shell, sent } = loadShellModule(true);
  shell.reportConnection({ kind: "admitted", profile: "p", backendId: "b", accountScope: "s", client: "device:cred-1" });
  await new Promise(resolve => setImmediate(resolve));
  const [line] = sent();
  const bearer = "device-token-that-must-not-be-reported";
  assert.ok(!line.includes(bearer), "the report names the identity the deployment stated, not the credential");
  assert.ok(!line.includes("token"), "no field of the report is a credential field");
});

test("a page outside the shell reports that it has none, rather than pretending to have stored a connection", async () => {
  const { shell, sent } = loadShellModule(false);
  assert.equal(shell.inShell(), false, "no internals means no shell");
  await assert.rejects(shell.configureConnection({ profile: "p", origin: "https://gateway.example", token: "t" }));
  assert.deepEqual(sent(), [], "nothing was sent");
});
