import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { ReferenceOutcome, ResolvedReference } from "@hepi/protocol";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  REFERENCE_OUTCOMES,
  mergeReferenceList,
  referenceEntryOptions,
  referenceFollow,
  referenceKey,
  referenceOffers,
  referenceOutcomeKey,
  referenceOutcomeRetryable,
  referenceTargetOpenable,
  referenceWrite,
} = await jiti.import<typeof import("./references.ts")>("./references.ts");

/**
 * What a reference surface is allowed to decide, and what only the Backend may decide.
 *
 * A reference is the Backend owner's record (cross-session references, decisions 1 and 5), so the whole of this module
 * is a *reading* of that owner's answers. The three rules the acceptance turns on are asserted as values rather than as
 * branches inside a component:
 *
 *  - a follow of a stored-but-unresolvable reference opens nothing, because the nearest surviving view is the silent
 *    substitute the spec forbids (decision 6);
 *  - every named outcome maps to its own word, and only `error` offers a retry that can change it;
 *  - a refused creation is refused by the Backend's own name, never reported as success.
 */

const reference = (overrides: Partial<ResolvedReference> = {}): ResolvedReference => ({ conversationId: "77", ...overrides });

test("a resolved reference opens its target, and names the entry only when it has one", () => {
  assert.deepEqual(referenceFollow(reference()), { kind: "open", conversationId: "77" });
  assert.deepEqual(referenceFollow(reference({ entryId: "123", label: "the decision" })), { kind: "open", conversationId: "77", entryId: "123" });
});

test("every unresolvable reference refuses to open, and never lands on a neighbour", () => {
  for (const outcome of REFERENCE_OUTCOMES) {
    const decision = referenceFollow(reference({ entryId: "123", outcome }));
    assert.deepEqual(decision, { kind: "refuse", outcome }, outcome + " refuses to open anything");
  }
});

test("each outcome is its own sentence, and only the read failure offers a retry", () => {
  const keys = REFERENCE_OUTCOMES.map((outcome) => referenceOutcomeKey(outcome));
  assert.equal(new Set(keys).size, REFERENCE_OUTCOMES.length, "no two outcomes share a word a reader distinguishes them by");
  // A retry that cannot change the answer is a control that cannot work: a removed target stays removed, and an entry
  // outside a conversation's history is not in it. Only the failed read left nothing established.
  assert.deepEqual(REFERENCE_OUTCOMES.filter((outcome) => referenceOutcomeRetryable(outcome)), ["error"]);
});

test("a target that is gone offers no view, while a missing entry leaves a conversation behind it", () => {
  // There is nothing behind a conversation that never existed and nothing behind a removed one, so opening it would be
  // a dead control. An entry the target no longer holds is a fact about the entry, not about the conversation.
  assert.equal(referenceTargetOpenable("target-missing"), false);
  assert.equal(referenceTargetOpenable("target-unavailable"), false);
  assert.equal(referenceTargetOpenable("entry-missing"), true);
  assert.equal(referenceTargetOpenable("entry-out-of-scope"), true);
  assert.equal(referenceTargetOpenable("stale"), true);
  assert.equal(referenceTargetOpenable("error"), false);
});

test("the raw-history offer is made only for a link that names an entry", () => {
  // The raw read is addressed by an entry id, so a conversation-only link has nothing there to open: offering it would
  // be a control that opens an empty panel.
  assert.deepEqual(referenceOffers("entry-missing", { entryId: "150" }), { retry: false, openTarget: true, openRaw: true });
  assert.deepEqual(referenceOffers("entry-missing", {}), { retry: false, openTarget: true, openRaw: false });
  // And an outcome with nothing behind it offers nothing at all — including no retry, which could not change it.
  const noTarget: readonly ReferenceOutcome[] = ["target-missing", "target-unavailable"];
  for (const outcome of noTarget) {
    assert.deepEqual(referenceOffers(outcome, { entryId: "150" }), { retry: false, openTarget: false, openRaw: false }, outcome + " offers no control that cannot work");
  }
  assert.deepEqual(referenceOffers("error", { entryId: "150" }), { retry: true, openTarget: false, openRaw: false });
});

test("a refused creation reports the Backend's own name, and never reports success", () => {
  for (const outcome of REFERENCE_OUTCOMES) {
    const refused = referenceWrite({ ok: false, kind: "refused", status: 409, code: outcome, message: "the Backend's sentence", body: {} });
    assert.deepEqual(refused, { ok: false, outcome }, outcome + " is relayed rather than paraphrased");
  }
  // A code this vocabulary does not know, and an answer that never arrived, are both "not established" — the one state
  // whose retry can change it. Neither is a success.
  assert.deepEqual(referenceWrite({ ok: false, kind: "refused", status: 500, code: "frame_too_large", message: "no", body: {} }), { ok: false, outcome: "error" });
  assert.deepEqual(referenceWrite({ ok: false, kind: "unknown", requestId: "r-1", reason: "no answer" }), { ok: false, outcome: "error" });
});

test("a stored creation hands back the owner's list, which is what the surface shows", () => {
  const stored = [reference({ label: "the parent" })];
  assert.deepEqual(referenceWrite({ ok: true, value: { references: stored } }), { ok: true, references: stored });
});

test("the entry options are the anchors the history owner issued, never a guessed identity", () => {
  const options = referenceEntryOptions({
    anchors: [
      { anchor: "coord-1", entryId: "100", cursor: 100, preview: "the first question" },
      { anchor: "coord-2", entryId: "120", cursor: 120, preview: "the second question" },
    ],
  });
  assert.deepEqual(options, [
    { entryId: "100", preview: "the first question" },
    { entryId: "120", preview: "the second question" },
  ]);
});

test("the listed links are the owner's answer, with no identity shown twice", () => {
  const kept = reference({ label: "the parent" });
  const dropped = reference({ entryId: "55", label: "the dropped decision" });
  // A retry and its first answer both landing must not show one link as two: the identity is target plus entry, which is
  // also the Backend's own idempotency key.
  assert.deepEqual(mergeReferenceList([kept], [dropped, dropped]), [kept, dropped]);
  assert.deepEqual(mergeReferenceList([], [kept]), [kept]);
  // An outcome that arrived later replaces the resolved copy beside it, because it is the newer statement about the
  // same link — while the record itself is never rewritten.
  const staleDropped: ResolvedReference = { ...dropped, outcome: "entry-missing" };
  assert.deepEqual(mergeReferenceList([dropped], [staleDropped]), [staleDropped]);
});

test("a reference's key is target plus entry, so a conversation and an entry of it are two links", () => {
  assert.equal(referenceKey(reference()), "77:");
  assert.equal(referenceKey(reference({ entryId: "123" })), "77:123");
  assert.notEqual(referenceKey(reference()), referenceKey(reference({ entryId: "123" })));
});
