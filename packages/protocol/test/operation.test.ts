import assert from "node:assert/strict";
import test from "node:test";
import type { OperationState } from "../src/index.ts";

test("exposes every explicit operation outcome state", () => {
  const states: OperationState[] = ["queued", "dispatched", "running", "completed", "failed", "interrupted", "outcome-unknown"];
  assert.deepEqual(states, ["queued", "dispatched", "running", "completed", "failed", "interrupted", "outcome-unknown"]);
});
