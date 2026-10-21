/**
 * The verification operation's own interface: what a caller can rely on without running a packaged artifact.
 *
 * The packaged journey is the acceptance (NV1–NV4) and needs a prebuilt artifact, an X display and a private Secret
 * Service, so it is not reproduced here. What this file pins is the seam the CLI calls through: importing the module
 * starts nothing, and the report a run hands back counts the assertions it recorded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createAssertions, summarize } from "../scripts/verify-artifacts.operation.mjs";

test("importing the verification operation starts nothing", async () => {
  const module = await import("../scripts/verify-artifacts.operation.mjs");
  assert.equal(typeof module.runArtifactVerification, "function", "the CLI's one call is exported");
  // Reaching this line is the assertion: a module-level artifact lookup, log mkdir, packaged spawn or `process.exit`
  // would have ended or dirtied this test process before it could report.
});

test("a report counts the assertions the run recorded, and names the failures in order", () => {
  const { entries, assert: record } = createAssertions();
  record("first", true, "detail");
  record("second", false, "why it failed");
  record("third", 0, null);
  assert.deepEqual(entries[2], { name: "third", ok: false, detail: "" }, "a missing detail is an empty string, not 'null'");
  assert.deepEqual(summarize(entries), { passed: 1, failed: ["second", "third"] }, "the failure list is names, in run order");
});

test("a recorded detail is bounded, so one runaway value cannot bury the report", () => {
  const { entries, assert: record } = createAssertions();
  record("long", false, "x".repeat(900));
  assert.equal(entries[0].detail.length, 800, "the report keeps 800 characters of a detail");
  record("nested", true, new Error("boom"));
  assert.equal(entries[1].detail, "Error: boom", "any value is stated as its text");
});
