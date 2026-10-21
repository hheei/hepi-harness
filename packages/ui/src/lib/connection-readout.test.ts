import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

/**
 * What a host may state about the connection its own descriptor read settled on.
 *
 * The rule exists because a packaged App's readiness line used to be printed from the branch that found a *stored*
 * connection: a shell whose ingress refused the bearer reported `workbench`, and a native check reading that line would
 * have believed a WebView that never reached a Backend. Nothing may be stated until the read decides it, and what is
 * stated must be the deployment's answer rather than the install's guess. These are asserted over the real module the
 * workbench calls, so a host cannot state a different rule for the same read.
 */
const bundle = buildSync({
  entryPoints: [path.join(import.meta.dirname, "connection-readout.ts")],
  bundle: true, write: false, platform: "neutral", format: "cjs", logLevel: "silent",
  tsconfig: path.join(import.meta.dirname, "..", "..", "tsconfig.json"),
}).outputFiles[0].text;
/** The bundled module as the source states it, so the case reads the real signatures. */
const module: { exports: typeof import("./connection-readout.ts") } = { exports: {} as typeof import("./connection-readout.ts") };
new Function("module", "exports", bundle)(module, module.exports);
const { readoutOf } = module.exports;

type ConnectionReadout = import("./connection-readout.ts").ConnectionReadout;

/** The readout a case states its read produced. */
function statedOf(readout: ConnectionReadout | null): ConnectionReadout {
  assert.ok(readout !== null, "the read stated a connection");
  return readout;
}

/** The admitted readout, asserted so the facts it states are readable. */
function admittedOf(readout: ConnectionReadout | null): Extract<ConnectionReadout, { kind: "admitted" }> {
  const stated = statedOf(readout);
  assert.equal(stated.kind, "admitted");
  return stated as Extract<ConnectionReadout, { kind: "admitted" }>;
}

/** The refused readout, asserted so the reason it states is readable. */
function refusedOf(readout: ConnectionReadout | null): Extract<ConnectionReadout, { kind: "refused" }> {
  const stated = statedOf(readout);
  assert.equal(stated.kind, "refused");
  return stated as Extract<ConnectionReadout, { kind: "refused" }>;
}

const identity = { profile: "workstation", backendId: "backend-a", accountScope: "account-a" };

test("an admitted read states the four facts the deployment confirmed, and no credential", () => {
  const readout = admittedOf(readoutOf({ identity, admission: { kind: "admitted" }, client: { kind: "device", id: "cred-1" } }));
  assert.deepEqual(readout, { kind: "admitted", profile: "workstation", backendId: "backend-a", accountScope: "account-a", client: "device:cred-1" });
  // The bearer is never part of what a host reports: the identity the server named is, and it is what a check compares.
  assert.ok(!JSON.stringify(readout).includes("token"), "the readout carries no credential material");
});

test("a Web session's admitted read is stated as the identity the ingress gave it", () => {
  const readout = admittedOf(readoutOf({ identity, admission: { kind: "admitted" }, client: { kind: "web" } }));
  assert.equal(readout.client, "web");
});

test("a descriptor that stated no client is stated as none, not as a guessed one", () => {
  // An unknown or absent `client` is an answer this readout may not invent: `device:` with no id, or `web`, would both
  // make a check believe it had seen an identity it had not.
  assert.equal(admittedOf(readoutOf({ identity, admission: { kind: "admitted" } })).client, "");
  assert.equal(admittedOf(readoutOf({ identity, admission: { kind: "admitted" }, client: { kind: "device" } })).client, "");
});

test("a refused read states the reason the workbench itself shows", () => {
  const admission: import("./web-session-gate.ts").Admission = { kind: "refused", state: "credential", reason: "This App's device credential was refused. Configure the connection again in the Hepi shell." };
  const readout = refusedOf(readoutOf({ identity: null, admission }));
  assert.deepEqual(readout, { kind: "refused", reason: admission.reason });
});

test("a sign-in gate is a refusal, never an admitted connection", () => {
  // A page sitting on the deployment's login form has not been admitted. Reported as workbench, that state would look
  // exactly like a connected App to a run that can only read the shell's stdout.
  const readout = refusedOf(readoutOf({ identity: null, admission: { kind: "sign-in" } }));
  assert.equal(readout.kind, "refused");
  assert.match(readout.reason, /Web login/);
});

test("nothing is stated while the read is in flight", () => {
  // The two empty states a mount passes through before its first answer: no descriptor and no gate decision. A host that
  // reported a surface here would be reporting a connection it had not read.
  assert.equal(readoutOf({ identity: null, admission: null }), null);
});

test("a settled identity outranks an earlier refusal", () => {
  // A re-read that succeeds after a failed attempt is the connection this page has, and the identity is what says so:
  // keeping the older refusal as the statement would report a connection the deployment has since admitted.
  const readout = admittedOf(readoutOf({ identity, admission: { kind: "refused", state: "credential", reason: "stale" } }));
  assert.equal(readout.kind, "admitted");
});
