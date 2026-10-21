import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { forkRequestId, forkSettled } = await jiti.import("./fork-attempt.ts");

/**
 * One fork attempt, one request identity.
 *
 * The backend answers a repeated request identity with the branch the first attempt created. A caller that generates
 * a fresh identity per HTTP request therefore turns a retry — a dropped response, a reload — into a second branch,
 * because the two attempts are indistinguishable to the backend. The identity is therefore held by whoever knows the
 * attempts are the same one: it is minted once, reused for every retry of that attempt, and released only once the
 * attempt has been answered or the caller starts a different fork.
 */
test("one fork attempt keeps one request identity across retries and releases it when it settles", () => {
  const attempts = new Map();
  let minted = 0;
  const mint = () => "id-" + (++minted);

  const first = forkRequestId(attempts, "7:41", mint);
  assert.equal(first, "id-1");

  // A retry after a lost answer: the same attempt, so the same identity — this is what the backend dedupes on.
  assert.equal(forkRequestId(attempts, "7:41", mint), first, "a retry reuses the attempt's identity");
  assert.equal(forkRequestId(attempts, "7:41", mint), first, "and keeps reusing it however often it is retried");
  assert.equal(minted, 1, "a retry mints nothing");

  // A different branch point is a different attempt, so it gets its own identity and cannot be answered with the
  // first one's branch.
  assert.equal(forkRequestId(attempts, "7:99", mint), "id-2", "a different fork is a different attempt");
  assert.equal(forkRequestId(attempts, "8:41", mint), "id-3", "another conversation's fork is its own attempt");

  // The answer arrived: the attempt is over, so the next fork of that entry is a new branch rather than a replay.
  forkSettled(attempts, "7:41");
  assert.equal(forkRequestId(attempts, "7:41", mint), "id-4", "a settled attempt does not hold its identity forever");
  // Releasing one attempt leaves the others exactly as they were: a failure elsewhere must not clear a retry.
  assert.equal(forkRequestId(attempts, "7:99", mint), "id-2", "settling one attempt does not disturb another");
});
