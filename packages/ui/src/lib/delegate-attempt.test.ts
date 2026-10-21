import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { delegateAttemptKey, delegateRequestId, delegateSettled, readDelegateAnswer, readDelegateRefusal } = await jiti.import<typeof import("./delegate-attempt.ts")>("./delegate-attempt.ts");

/**
 * One delegation attempt, one request identity.
 *
 * The backend answers a repeated request identity with the child (or the dispatch) the first attempt made. A caller that
 * mints a fresh identity per HTTP request turns a retry — a dropped response, a reload — into a second child, because
 * the two attempts are indistinguishable to the backend. So the identity belongs to the attempt: minted once, reused for
 * every retry of it, released only once the attempt has been answered.
 */
test("one delegation attempt keeps one request identity across retries and releases it when it settles", () => {
  const attempts = new Map();
  let minted = 0;
  const mint = () => "id-" + (++minted);

  const key = delegateAttemptKey("7", "worker");
  const first = delegateRequestId(attempts, key, mint);
  assert.equal(first, "id-1");

  // A retry after a lost answer is the same attempt, so it carries the same identity — that is the whole dedupe.
  assert.equal(delegateRequestId(attempts, key, mint), first, "a retry reuses the attempt's identity");
  assert.equal(delegateRequestId(attempts, key, mint), first, "and keeps reusing it however often it is retried");
  assert.equal(minted, 1, "a retry mints nothing");

  // Editing the task while the attempt is unanswered is still that attempt: the key names the conversation, the
  // definition and the target, never the words, so a second identity cannot be minted for the same child.
  assert.equal(delegateRequestId(attempts, delegateAttemptKey("7", "worker"), mint), first, "a reworded retry is the same attempt");

  // Another definition is another delegation, and so is another target: neither may be answered with the first child.
  assert.equal(delegateRequestId(attempts, delegateAttemptKey("7", "reviewer"), mint), "id-2", "another definition is another attempt");
  assert.equal(delegateRequestId(attempts, delegateAttemptKey("7", "worker", "41"), mint), "id-3", "delegating again to one child is its own attempt");
  assert.equal(delegateAttemptKey("7", "worker", "41"), "7:worker:41", "the target is part of the attempt's identity");

  // The answer arrived: the attempt is over, so the next delegation of that definition is a genuinely new child.
  delegateSettled(attempts, key);
  assert.equal(delegateRequestId(attempts, key, mint), "id-4", "a settled attempt does not hold its identity forever");
  // Settling one attempt leaves the others as they were: a failure elsewhere must not clear a retry in flight.
  assert.equal(delegateRequestId(attempts, delegateAttemptKey("7", "reviewer"), mint), "id-2", "settling one attempt does not disturb another");
});

/** The answer is read from the fields the backend states, and nothing is invented for a field it did not. */
test("a delegation answer is read from the backend's own fields", () => {
  const answer = readDelegateAnswer({ childConversationId: "41", dispatchId: "call-1", requestId: "attempt-1", created: true, definition: "worker" });
  assert.deepEqual(answer, { childConversationId: "41", dispatchId: "call-1", requestId: "attempt-1", created: true, definition: "worker" });
  // A replay is the same shape with `created: false`, which is the only difference a caller can see.
  assert.equal(readDelegateAnswer({ childConversationId: "41", dispatchId: "call-1", requestId: "attempt-1", created: false })?.created, false);
  // An answer without the identities a caller acts on is not an answer, and a body that is not one reads as none.
  assert.equal(readDelegateAnswer({ childConversationId: "41" }), undefined);
  assert.equal(readDelegateAnswer(null), undefined);
  assert.equal(readDelegateAnswer("nonsense"), undefined);
});

/** A refusal keeps the backend's own code and message, so an over-limit request and an unreachable host stay distinct. */
test("a refusal keeps the backend's own code and words", () => {
  assert.deepEqual(
    readDelegateRefusal({ code: "children_exceeded", error: "this conversation already has 4 children at work; the limit is 4" }, 409),
    { code: "children_exceeded", message: "this conversation already has 4 children at work; the limit is 4" },
  );
  assert.deepEqual(readDelegateRefusal({ code: "host_unreachable", message: "the execution host could not be reached" }, 400), { code: "host_unreachable", message: "the execution host could not be reached" });
  // A body this build does not recognise is still stated as a failure with its status rather than as a success.
  assert.deepEqual(readDelegateRefusal(undefined, 502), { code: "delegate_failed", message: "HTTP 502" });
});
