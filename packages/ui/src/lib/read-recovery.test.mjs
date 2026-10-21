import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  classifyReadFailure, readFailureKey, readFailureRetryable,
} = await jiti.import("./read-recovery.ts");

/** A thrown read, as the conversation client throws it: a message, and whatever the connection stated beside it. */
function thrown(properties, message = "read failed") {
  return Object.assign(new Error(message), properties);
}

/**
 * The four states a read can end in, and the reason each one is not the others.
 *
 * The point of the classification is what the surface may offer. A read that never answered can answer, so Retry is the
 * honest step. A conversation the Backend says is gone, or a read it refused, will answer the same way however many
 * times it is asked, so offering Retry would be a button that cannot work — the surface offers the way back instead.
 * The abort case is the one that is not a failure at all: the surface itself cancelled the read, so there is nothing to
 * tell a reader and nothing to recover from.
 */
test("a failed read is classified by what the Backend actually stated", () => {
  const cases = [
    ["a read that never answered", new TypeError("Failed to fetch"), "unreachable", true],
    ["a Backend that failed to answer", thrown({ status: 503 }), "unreachable", true],
    ["a row the Backend says is gone", thrown({ status: 404 }), "missing", false],
    ["a named not-found", thrown({ code: "not_found" }), "missing", false],
    ["a credential the Backend rejected", thrown({ status: 401 }), "refused", false],
    ["a projection the Backend refused", thrown({ status: 413, code: "frame_too_large" }), "refused", false],
    ["a read the surface aborted", thrown({ name: "AbortError" }), "cancelled", false],
    ["a fetch that honoured an abort", thrown({ name: "DOMException", code: "ABORT_ERR" }), "cancelled", false],
  ];
  for (const [label, error, kind, retryable] of cases) {
    const failure = classifyReadFailure(error);
    assert.equal(failure.kind, kind, label);
    assert.equal(readFailureRetryable(failure), retryable, label + " retryability");
    // Every kind names a sentence the surfaces translate; a kind without one would render its own key.
    assert.match(readFailureKey(failure), /^chat\.read/, label);
  }
});

/**
 * An abort outranks the status it would otherwise have had.
 *
 * A fetch aborted mid-flight can still carry the status of a response that had begun to arrive, and the surface that
 * aborted it must not report that status: the reader moved on, and the read they left is not a state of the conversation
 * they are now in.
 */
test("an abort is the caller's intent, whatever status the read would have had", () => {
  assert.equal(classifyReadFailure(thrown({ name: "AbortError", status: 404 })).kind, "cancelled");
  assert.equal(classifyReadFailure(thrown({ name: "AbortError", status: 500 })).kind, "cancelled");
});

/**
 * The raw reason is carried for the log and never for the screen.
 *
 * A thrown read can carry the Backend's own diagnostics — an entry id, a byte count, an upstream message — and the panel
 * renders a sentence this build authored. The classification therefore keeps the detail beside the kind rather than in
 * it, which is what makes "the failure state carries no sensitive diagnostic" a property of the value and not a
 * convention each surface has to remember.
 */
test("the diagnostic travels beside the kind, never as the thing a surface shows", () => {
  const failure = classifyReadFailure(thrown({ status: 413 }, "frame_too_large: entry 77, 1922295 bytes"));
  assert.equal(failure.kind, "refused");
  assert.equal(failure.detail, "frame_too_large: entry 77, 1922295 bytes");
  assert.equal(readFailureKey(failure), "chat.readRefused");
  // The key is a fixed name per kind: two different refusals are the same sentence, and neither leaks its own text.
  assert.equal(readFailureKey(classifyReadFailure(thrown({ status: 400 }, "bad request"))), "chat.readRefused");
});

/** A failure with nothing thrown beside it still classifies, and states no detail it does not have. */
test("a failure with no message is still classified", () => {
  assert.deepEqual(classifyReadFailure(undefined), { kind: "unreachable" });
  assert.deepEqual(classifyReadFailure({}), { kind: "unreachable" });
  assert.deepEqual(classifyReadFailure({ name: "AbortError" }), { kind: "cancelled" });
});
