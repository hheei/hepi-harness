import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

const uiRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
/** The two reads a connection descriptor can answer: admitted, or failed with the status the deployment stated. */
type ReadAnswer = { readonly kind: "ok" } | { readonly kind: "failed"; readonly status?: number };
const ok: ReadAnswer = { kind: "ok" };
const failed = (status?: number): ReadAnswer => status === undefined ? { kind: "failed" } : { kind: "failed", status };

/**
 * Which surface a failed connection read is, on the host that failed it.
 *
 * The rule is one decision with four inputs and it lives in one function, so the page cannot disagree with itself: a
 * Web page whose descriptor read was refused for want of its cookie is the deployment asking for its login material,
 * an App whose bearer was refused is a credential the shell must be given again, and a deployment that gates its page
 * but configured no login material is a configuration to report rather than a form that can only fail.
 */
function load() {
  const bundle = buildSync({
    entryPoints: [path.join(uiRoot, "src", "lib", "web-session-gate.ts")],
    bundle: true,
    write: false,
    platform: "neutral",
    format: "cjs",
    logLevel: "silent",
    tsconfig: path.join(uiRoot, "tsconfig.json"),
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", bundle)(module, module.exports);
  return module.exports;
}

const { admissionOf } = load() as typeof import("./web-session-gate.ts");
type Admission = ReturnType<typeof admissionOf>;

/** The refusal an admission states: a case that reached this point is about that refusal, not about its presence. */
function refusalOf(admission: Admission): Extract<Admission, { kind: "refused" }> {
  assert.equal(admission.kind, "refused", "the admission is a refusal");
  assert.ok(admission.kind === "refused");
  return admission;
}

test("an admitted connection is the tree, not a gate", () => {
  assert.deepEqual(admissionOf({ credential: "cookie", read: ok }), { kind: "admitted" });
  assert.deepEqual(admissionOf({ credential: "bearer", read: ok }), { kind: "admitted" });
});

test("a refused cookie read on a deployment with a login is the sign-in surface", () => {
  assert.deepEqual(admissionOf({ credential: "cookie", read: failed(401), loginEnabled: true }), { kind: "sign-in" });
  // Before the deployment's own answer arrives, the form is still the surface that can make progress: it is the same
  // form a configured deployment shows, and an unconfigured one replaces it with the refusal below.
  assert.deepEqual(admissionOf({ credential: "cookie", read: failed(401) }), { kind: "sign-in" });
});

test("a refused bearer is never a form a page could fill", () => {
  assert.match(refusalOf(admissionOf({ credential: "bearer", read: failed(401), loginEnabled: true })).reason, /credential/i);
});

test("a refusal states which kind it is, because the two kinds have different next steps", () => {
  // A deployment that answered and did not admit this caller: only a different credential changes that, so the surface
  // offers the host's connection management rather than a retry that would fail identically.
  for (const status of [401, 403]) {
    assert.equal(refusalOf(admissionOf({ credential: "bearer", read: failed(status), loginEnabled: true })).state, "credential", "status " + status);
    assert.equal(refusalOf(admissionOf({ credential: "cookie", read: failed(status), loginEnabled: false })).state, "credential", "status " + status);
  }
  // A deployment that never answered is the other kind: repeating the read is the only step that can change it, and
  // offering a credential form there would invite a person to replace a connection that was fine.
  for (const status of [undefined, 404, 500, 502, 503]) {
    assert.equal(refusalOf(admissionOf({ credential: "bearer", read: failed(status), loginEnabled: true })).state, "unreachable", "status " + String(status));
    assert.equal(refusalOf(admissionOf({ credential: "cookie", read: failed(status), loginEnabled: true })).state, "unreachable", "status " + String(status));
  }
});

test("a gated deployment with no login material is refused with that reason", () => {
  assert.match(refusalOf(admissionOf({ credential: "cookie", read: failed(401), loginEnabled: false })).reason, /no login/i);
});

test("a failure that is not a refusal is reported as it is", () => {
  for (const status of [500, 502, 404]) {
    assert.equal(refusalOf(admissionOf({ credential: "cookie", read: failed(status), loginEnabled: true })).state, "unreachable", "status " + status);
  }
  // A transport that never got an answer is a failure too: a gate that read it as success would render a workbench over
  // a connection that does not exist.
  assert.match(refusalOf(admissionOf({ credential: "cookie", read: failed(undefined), loginEnabled: true })).reason, /could not be reached/i);
});
