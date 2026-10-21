/**
 * Which artifact an acceptance run is allowed to call its own.
 *
 * Ticket 16's open half is that no journey has run against the immutable release directory
 * `scripts/build-client-runtime.mjs` publishes. A run that took `--release=<dir>` and quietly fell back to this
 * checkout's entrypoints when that directory was incomplete would report the checkout as the artifact — the exact
 * mistake the acceptance was meant to stop — so the refusal has to happen where the stack is chosen, before any
 * process starts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveArtifactSources, startAcceptanceStack } from "./acceptance-stack.ts";

test("a run with no release directory states that it measures the checkout", () => {
  assert.deepEqual(resolveArtifactSources(""), { kind: "checkout", releaseDir: null, revision: null });
  assert.deepEqual(resolveArtifactSources(undefined), { kind: "checkout", releaseDir: null, revision: null });
});

test("a published release names the four things a run of it starts", () => {
  const dir = fixtureRelease();
  const source = resolveArtifactSources(dir);
  assert.equal(source.kind, "release");
  assert.equal(source.ingressEntry, join(dir, "ingress.mjs"));
  assert.equal(source.staticDir, join(dir, "web"));
  assert.equal(source.gatewayTarball, join(dir, "gateway/hepi-client-0.1.0.tgz"));
  assert.equal(source.imageTag, "hepi-backend:abcdef1-workstation", "and the Backend image comes from the release's own record");
  assert.equal(source.revision, "abcdef1234567890");
});

test("an incomplete release is refused before the stack starts anything", async () => {
  const dir = fixtureRelease();
  rmSync(join(dir, "web", "index.html"));
  const started = await startAcceptanceStack({ label: "t16-release-refusal-test", releaseDir: dir }).then(
    () => ({ ok: true, message: "" }),
    (error: unknown) => ({ ok: false, message: String(error instanceof Error ? error.message : error) }),
  );
  assert.equal(started.ok, false, "a release with no page must not run as the checkout");
  assert.match(started.message, /web\/index\.html/);
  assert.equal(/did not start/.test(started.message), false, "the refusal is about the release, not a process that failed to boot");
});

test("a driver flag that names nothing is the checkout, not a half-open release", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "hepi-release-missing-")), "release-abcdef1");
  const started = await startAcceptanceStack({ label: "t16-release-absent-test", releaseDir: missing }).then(
    () => ({ ok: true, message: "" }),
    (error: unknown) => ({ ok: false, message: String(error instanceof Error ? error.message : error) }),
  );
  assert.equal(started.ok, false);
  assert.match(started.message, /is not a published release/);
});

function fixtureRelease() {
  const dir = mkdtempSync(join(tmpdir(), "hepi-release-fixture-"));
  mkdirSync(join(dir, "web"), { recursive: true });
  mkdirSync(join(dir, "gateway"), { recursive: true });
  writeFileSync(join(dir, "ingress.mjs"), "// bundle\n");
  writeFileSync(join(dir, "web", "index.html"), "<html></html>\n");
  writeFileSync(join(dir, "gateway", "hepi-client-0.1.0.tgz"), "tarball\n");
  writeFileSync(join(dir, "SOURCE_COMMIT"), "abcdef1234567890\n");
  writeFileSync(join(dir, "provenance.json"), JSON.stringify({ artifactId: "abcdef1", image: { tag: "hepi-backend:abcdef1-workstation" } }) + "\n");
  return dir;
}
