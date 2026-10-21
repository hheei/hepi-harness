import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

/**
 * What identifies a connection, as the one value the connection's lifetime depends on.
 *
 * The rule exists because a host states its configuration as an object literal with inline functions, so its identity
 * changes on every render. A lifetime keyed on that object disposes and rebuilds the connection per keystroke, and a
 * surface sends through a client that was already replaced. What must hold:
 *
 *   1. two configurations that describe the same connection are the same key, however fresh the object;
 *   2. a different host, ingress origin, profile or credential is a different key;
 *   3. a reissued device bearer is a different connection even against the same Gateway and profile;
 *   4. the parts cannot be re-split: an origin containing the separator cannot impersonate another connection.
 */
const bundle = buildSync({
  entryPoints: [path.join(import.meta.dirname, "connection-lifetime.ts")],
  bundle: true, write: false, platform: "neutral", format: "cjs", logLevel: "silent",
  tsconfig: path.join(import.meta.dirname, "..", "..", "tsconfig.json"),
}).outputFiles[0].text;
const module = { exports: {} };
new Function("module", "exports", bundle)(module, module.exports);
const { connectionKeyOf } = module.exports;

const web = (overrides = {}) => ({ host: { kind: "web", ingressOrigin: "" }, profile: "https://web.example", credential: { kind: "cookie" }, ...overrides });
const app = (overrides = {}) => ({ host: { kind: "app", ingressOrigin: "https://gateway.example" }, profile: "workstation", credential: { kind: "bearer", token: "device-a" }, ...overrides });

test("a fresh object describing the same connection is the same key", () => {
  assert.equal(connectionKeyOf(web()), connectionKeyOf(web()));
  assert.equal(connectionKeyOf(app()), connectionKeyOf(app()));
  // The functions a host writes inline are not part of the identity: a key computed from two fresh objects agrees even
  // when each carries its own closures.
  const withFunctions = (extra) => ({ ...app(), ...extra });
  assert.equal(
    connectionKeyOf(withFunctions({ fetch: () => {}, createSource: () => {} })),
    connectionKeyOf(withFunctions({ fetch: () => {}, createSource: () => {} })),
  );
});

test("each stated part of a connection changes the key", () => {
  const base = connectionKeyOf(app());
  assert.notEqual(connectionKeyOf(app({ host: { kind: "app", ingressOrigin: "https://other.example" } })), base, "a different Gateway");
  assert.notEqual(connectionKeyOf(app({ profile: "laptop" })), base, "a different profile");
  assert.notEqual(connectionKeyOf(app({ credential: { kind: "bearer", token: "device-b" } })), base, "a reissued bearer");
  assert.notEqual(connectionKeyOf(app({ host: { kind: "web", ingressOrigin: "https://gateway.example" } })), base, "a different host kind");
  assert.notEqual(connectionKeyOf(web({ credential: { kind: "bearer", token: "device-a" } })), connectionKeyOf(web()), "a cookie page is not a bearer client");
});

test("the parts cannot be re-split into another connection", () => {
  // An origin that contains the separator must not produce the key of a connection whose profile starts with what
  // follows it.
  const smuggled = connectionKeyOf({ host: { kind: "app", ingressOrigin: "https://gateway.example|workstation" }, profile: "x", credential: { kind: "cookie" } });
  const honest = connectionKeyOf({ host: { kind: "app", ingressOrigin: "https://gateway.example" }, profile: "workstation", credential: { kind: "cookie" } });
  assert.notEqual(smuggled, honest);
});