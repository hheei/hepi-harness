import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The App's half of the native save, from the page's side.
 *
 * The Rust half registers five commands; this half is the names and arguments the page sends. They are two files in two
 * languages, so a rename in one of them is a first-run App that saves nothing and says nothing — the test states the
 * exact pairs, over the real `invoke` the App ships, rather than a hand-written stand-in.
 *
 * The bound is asserted here too, because it is the promise the whole path rests on: a slice that crossed IPC whole
 * would be the ~3 GB peak ticket 04 measured, so the page must hand over bounded byte arrays and never a blob or a
 * stream.
 */
function loadSaveHost(withShell, answers = {}) {
  const bundle = buildSync({
    entryPoints: [path.join(appRoot, "src", "save-host.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  const calls = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    Promise,
    Error,
    Uint8Array,
    Array,
  };
  if (withShell) {
    // What Tauri puts in the document before any page script runs.
    sandbox.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "app_save_choose") return answers.choose === undefined ? { path: "/home/me/notes.md", overwrite: false } : answers.choose;
        if (command === "app_save_begin") return 7;
        if (command === "app_save_append") return 3;
        return undefined;
      },
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bundle, sandbox);
  return { saveHost: sandbox.module.exports, sent: () => calls.map((call) => JSON.stringify(call)) };
}

test("the page asks the shell for exactly the commands the shell registers", async () => {
  const { saveHost, sent } = loadSaveHost(true);
  const host = saveHost.nativeSaveHost();
  assert.notEqual(host, null, "a document with the shell's internals has a save host");

  const destination = await host.chooseDestination("notes.md");
  assert.deepEqual({ ...destination }, { path: "/home/me/notes.md", overwrite: false });

  const handle = await host.begin(destination);
  assert.equal(handle, 7);
  const written = await host.append(handle, new Uint8Array([1, 2, 3]));
  assert.equal(written, 3);
  await host.finish(handle);
  await host.abort(handle);

  assert.deepEqual(sent(), [
    JSON.stringify({ command: "app_save_choose", args: { suggestedName: "notes.md" } }),
    JSON.stringify({ command: "app_save_begin", args: { path: "/home/me/notes.md", overwrite: false } }),
    // The slice crosses IPC as a byte array: a blob or a stream would be the whole file, which is the failure this
    // path exists to avoid.
    JSON.stringify({ command: "app_save_append", args: { handle: 7, chunk: [1, 2, 3] } }),
    JSON.stringify({ command: "app_save_finish", args: { handle: 7 } }),
    JSON.stringify({ command: "app_save_abort", args: { handle: 7 } }),
  ]);
});

test("a cancelled dialog is a null destination, not an error the page shows", async () => {
  // The command answers null for a closed dialog, and the seam keeps that meaning: nothing was opened, nothing is
  // transferred, and a surface says nothing about it.
  const { saveHost } = loadSaveHost(true, { choose: null });
  const destination = await saveHost.nativeSaveHost().chooseDestination("notes.md");
  assert.equal(destination, null);
});

test("every command the page invokes is one the shell registers", () => {
  // Two files in two languages, so a rename in one of them is a save that silently does nothing. The set is compared as a
  // whole rather than one name at a time: a new command on either side that the other does not have is the same defect.
  const source = buildSync({
    entryPoints: [path.join(appRoot, "src", "save-host.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  const invoked = new Set([...source.matchAll(/"app_save_[a-z]+"/g)].map((match) => match[0].slice(1, -1)));
  assert.deepEqual([...invoked].sort(), ["app_save_abort", "app_save_append", "app_save_begin", "app_save_choose", "app_save_finish"]);

  const rust = readFileSync(path.join(appRoot, "src-tauri", "src", "main.rs"), "utf8");
  const handler = /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(rust);
  assert.notEqual(handler, null, "the shell registers a handler list");
  const registered = new Set([...handler[1].matchAll(/save::(app_save_[a-z]+)/g)].map((match) => match[1]));
  assert.deepEqual([...registered].sort(), [...invoked].sort(), "the page and the shell name the same save commands");

  // And each of those names is a \#[tauri::command] the shell really defines, not a registration of nothing.
  const saveSource = readFileSync(path.join(appRoot, "src-tauri", "src", "save.rs"), "utf8");
  for (const command of invoked) {
    assert.match(saveSource, new RegExp("#\\[tauri::command\\]\\s*pub (async )?fn " + command + "\\b"), command + " is defined in save.rs");
  }
});

test("a document outside the shell has no save host at all", () => {
  const { saveHost, sent } = loadSaveHost(false);
  assert.equal(saveHost.nativeSaveHost(), null, "no internals means no shell, and no save it could perform");
  assert.deepEqual(sent(), [], "nothing was sent");
});

test("the save host states no credential and no address of its own", async () => {
  const { saveHost } = loadSaveHost(true);
  const host = saveHost.nativeSaveHost();
  // The source is the contract: a save host that named an origin, a token or a routing path would be a second transport
  // beside the connection's, which is exactly what this seam exists to prevent.
  const source = buildSync({
    entryPoints: [path.join(appRoot, "src", "save-host.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  assert.equal(/authorization|Bearer |token/i.test(source), false, "the save host carries no credential");
  assert.equal(/https?:\/\//.test(source), false, "the save host names no origin");
  assert.equal(/\/api\/files/.test(source), false, "the save host assembles no file address");
  assert.notEqual(host, null);
});
