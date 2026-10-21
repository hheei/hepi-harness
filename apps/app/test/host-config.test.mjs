import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The App's host configuration, as the workbench receives it.
 *
 * The App is not served from its Gateway, so every conversation read and every stream has to be addressed to the origin
 * the shell was configured with, under the device bearer — never to the document's own origin, which is the bundle. This
 * asserts the configuration the App really states, over the real transport factory, rather than a hand-written shape.
 */
function loadConnectionModule() {
  const bundle = buildSync({
    entryPoints: [path.join(appRoot, "src", "connection.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(appRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  const opened = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    URL,
    Headers,
    AbortController,
    TextDecoder,
    Event: class extends globalThis.Event {},
    MessageEvent: class { constructor(type, init) { this.type = type; this.data = init?.data; } },
    // The stream reader opens its own socket on construction. It is recorded here and left open: what is asserted is the
    // address and the credential it was opened with, not the frames a real Gateway would send.
    fetch: async (url, init) => {
      opened.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(bundle, sandbox);
  return { connection: sandbox.module.exports, opened };
}

test("the App states its configured Gateway and bearer, and its stream is that origin's under that bearer", async () => {
  const { connection, opened } = loadConnectionModule();
  const stated = connection.workbenchConfig({ profile: "workstation", origin: "https://gateway.example", token: "device-token" });

  assert.equal(stated.host.kind, "app");
  assert.equal(stated.host.ingressOrigin, "https://gateway.example", "the App's ingress is the Gateway it was configured with");
  assert.equal(stated.profile, "workstation", "the profile names the connection the scopes key by");
  assert.equal(stated.credential.kind, "bearer", "the credential is the device bearer");
  assert.equal(stated.credential.token, "device-token");

  // The stream: the Gateway's own address under the bearer, not a same-origin path on the bundle.
  const source = stated.createSource(stated.credential, stated.host.ingressOrigin)("conv-1");
  assert.equal(opened.length, 1, "opening the stream is one request");
  assert.equal(opened[0].url, "https://gateway.example/api/conversations/conv-1/events");
  assert.equal(opened[0].authorization, "Bearer device-token");
  source.close();

  // A connection the shell did not configure is refused rather than invented: an empty origin would resolve every
  // request against the bundle, and an empty token would be presented to a Gateway that refuses it.
  assert.throws(() => connection.readConnection(), /no Gateway connection configured/);
});
