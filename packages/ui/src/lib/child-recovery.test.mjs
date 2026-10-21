import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { childRecoveryWords, createReadFence, readChildRecovery, retryChildPreparation, retryablePreparation } = await jiti.import("./child-recovery.ts");

/**
 * One delegated child's recovery facts as the surface reads them, at the seam the surface really crosses.
 *
 * The audit's G2 is that a child's *one* `runStatus` cannot say what a delegation is waiting on, so what is checked here
 * is that the three facts stay three: a failed preparation, a pending report and the anchor's phase are each their own
 * word, and none of them is folded into a single verdict about the child. G6 adds one narrow offer on top of those
 * facts, and it is checked here as the two identities a retry takes — the dispatch identity the read stated and the
 * failed attempt's own task id — plus the fact that nothing else in the answer makes anything retryable.
 */

/** One client whose only answer is what the test states, recording the requests it was asked to make. */
function answering(answer) {
  const calls = [];
  return {
    calls,
    client: {
      request: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
        return await answer();
      },
    },
  };
}

const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** The facts a parked preparation and a live reporter would each state, as the catalog's words. */
const parkedFailure = { requestId: "parent:attempt-1", preparation: "unretried-failure", preparationFailedTaskId: "41", preparationOutcome: "failed", preparationError: "the summarizer answered no summary", anchorPhase: "preparing" };

test("the recovery read is one GET at the child's own address, and a delegation that states no facts is stated as none", async () => {
  const facts = answering(() => json(200, { conversationId: "7", recovery: parkedFailure }));
  assert.deepEqual(await readChildRecovery(facts.client, "7"), { ok: true, facts: parkedFailure });
  assert.deepEqual(facts.calls.map((call) => [call.method, call.url]), [["GET", "/api/conversations/7/recovery"]]);

  const none = answering(() => json(200, { conversationId: "7", recovery: null }));
  assert.deepEqual(await readChildRecovery(none.client, "7"), { ok: true, facts: null }, "an ordinary conversation is a child of no delegation, not a failure");
});

test("a refusal keeps the Backend's own code, and a read that never answered is not reported as a state of the child", async () => {
  const refused = answering(() => json(409, { code: "not_a_delegation", error: "no delegation anchor owns this conversation" }));
  assert.deepEqual(await readChildRecovery(refused.client, "7"), { ok: false, code: "not_a_delegation", message: "no delegation anchor owns this conversation" });

  const lost = answering(() => Promise.reject(new Error("the connection dropped")));
  assert.deepEqual(await readChildRecovery(lost.client, "7"), { ok: false, code: "network_unreachable", message: "the connection dropped" });
});

test("the retry sends the two identities the read stated, and nothing else", async () => {
  const retried = answering(() => json(200, { conversationId: "7", recovery: { ...parkedFailure, preparation: "retried", preparationRetriedTaskId: "41" } }));
  const answer = await retryChildPreparation(retried.client, "7", { requestId: "parent:attempt-1", failedTaskId: "41" });
  assert.equal(answer.ok, true);
  assert.equal(answer.facts.preparation, "retried");
  assert.deepEqual(retried.calls.map((call) => [call.method, call.url, call.body]), [["POST", "/api/conversations/7/recovery", { requestId: "parent:attempt-1", failedTaskId: "41" }]], "same child, same dispatch, the failed attempt's own id");

  // A refusal is the record's own name for why nothing was written — including the one that says this attempt was
  // already asked about, which is an answer and not a reason to ask again.
  const stale = answering(() => json(409, { code: "identity_stale", error: "the record states another attempt" }));
  assert.deepEqual(await retryChildPreparation(stale.client, "7", { requestId: "parent:attempt-1", failedTaskId: "41" }), { ok: false, code: "identity_stale", message: "the record states another attempt" });
  const twice = answering(() => json(409, { code: "already_retried", error: "this attempt was already retried" }));
  assert.deepEqual(await retryChildPreparation(twice.client, "7", { requestId: "parent:attempt-1", failedTaskId: "41" }), { ok: false, code: "already_retried", message: "this attempt was already retried" });
});

test("only an unretried preparation names a retry, and it names the identities the write takes", () => {
  assert.deepEqual(retryablePreparation(parkedFailure), { requestId: "parent:attempt-1", failedTaskId: "41" });
  // Already asked about: the record says so, and the surface offers nothing that would ask again.
  assert.equal(retryablePreparation({ ...parkedFailure, preparation: "retried" }), null);
  // A live dispatch states no failure at all, and a delegation with no preparation (a `fresh` context) states none either.
  assert.equal(retryablePreparation({ requestId: "r", delivery: "waiting-child", anchorPhase: "idle" }), null);
  assert.equal(retryablePreparation({ requestId: "r", preparation: "unretried-failure" }), null, "a failure that names no attempt cannot be named back to the Backend");
  assert.equal(retryablePreparation(null), null, "a conversation that is no delegation's child offers nothing");
});

/** One deferred answer, resolved by the test: the workflow a surface with two reads in flight really has. */
function deferred() {
  let settle = () => {};
  const answer = new Promise((resolve) => { settle = resolve; });
  return { answer, settle };
}

/** The read a surface performs: take the newest token, ask, and publish only while that token is still newest. */
async function readWithFence(fence, ask) {
  const attempt = fence.begin();
  const answer = await ask;
  return { attempt, published: fence.settled(attempt), answer };
}

test("a superseded read or retry never replaces the newer one, and a released surface publishes nothing", async () => {
  const fence = createReadFence();
  const first = deferred();
  const second = deferred();
  // The reader asks again while the first read is still in flight — a refresh, or a retry over the same facts.
  const earlier = readWithFence(fence, first.answer);
  const later = readWithFence(fence, second.answer);
  // Answers arrive out of order, which is the case the surface has to survive.
  second.settle("newer facts");
  first.settle("stale facts");
  const [stale, fresh] = await Promise.all([earlier, later]);
  assert.equal(stale.published, false, "the superseded read's answer lands nowhere");
  assert.equal(fresh.published, true, "the newest decision the user made is the one on screen");

  // Leaving the child, or the connection being replaced, releases the surface: an answer still in flight is dropped.
  const released = createReadFence();
  const pending = deferred();
  const outstanding = readWithFence(released, pending.answer);
  released.release();
  pending.settle("late facts");
  assert.equal((await outstanding).published, false, "a disposed surface's late answer is never written under the next read's name");

  // A fence with nothing released still accepts its own newest answer, so the rule drops only what it should.
  const quiet = createReadFence();
  assert.equal((await readWithFence(quiet, Promise.resolve("facts"))).published, true);
});

test("each object states its own word, and no object's word becomes a verdict about the child", () => {
  const words = (facts) => childRecoveryWords(facts, (key) => key);
  assert.deepEqual(words(parkedFailure).map((entry) => entry.id), [
    "childRecovery.preparation.unretried-failure",
    "childRecovery.anchor.preparing",
  ], "the preparation's state and the anchor's own phase, in that order");
  assert.match(words(parkedFailure)[0].text, /failed$/, "the runtime's own outcome is stated beside the state it reached");

  // The reporter's fact and the child's: one read, two objects, neither flattened into the other.
  assert.deepEqual(words({ requestId: "r", delivery: "waiting-child", anchorPhase: "idle" }).map((entry) => entry.id), [
    "childRecovery.delivery.waiting-child",
    "childRecovery.anchor.idle",
  ]);
  assert.deepEqual(words({ requestId: "r", delivery: "awaiting-delivery" }).map((entry) => entry.id), ["childRecovery.delivery.awaiting-delivery"], "a recorded report nobody has admitted yet is not the same word as a running reporter");

  // A phase this build has no sentence for is passed through by name: a runtime that grows one is still stated.
  assert.deepEqual(words({ requestId: "r", delivery: "some-new-phase" }), [{ id: "childRecovery.delivery.some-new-phase", text: "some-new-phase" }]);
  assert.deepEqual(words({ requestId: "r" }), [], "a dispatch that states no fact states no word");
});
