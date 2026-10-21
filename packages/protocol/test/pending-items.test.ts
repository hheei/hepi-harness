import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingContentToken, projectQueuedItem, type QueuedItemFacts } from "../src/index.ts";

/**
 * Ticket 09's wire contract for the pending queue: one item projection that carries the identity, the mode, the text,
 * the source and the edit condition a surface needs, and one deterministic content token an edit is validated against.
 *
 * The projection is declared structurally here exactly as `projectSubmission` is, so this package keeps no dependency
 * on the runtime that stores the item and a runtime upgrade changes the adapter, not the wire.
 */

const facts = (overrides: Partial<QueuedItemFacts> = {}): QueuedItemFacts => ({
  submissionId: "41",
  mode: "followUp",
  content: "queued text",
  ...overrides,
});

test("a user item projects its identity, mode, text and the token of that text", () => {
  const item = projectQueuedItem(facts({ requestId: "req-1" }));
  assert.equal(item.submissionId, "41");
  assert.equal(item.mode, "followUp");
  assert.equal(item.content, "queued text");
  assert.equal(item.requestId, "req-1");
  assert.deepEqual(item.source, { kind: "user" });
  assert.equal(item.contentToken, pendingContentToken("queued text"));
  // A queued native input is both editable and cancelable; the control state is stated beside it, not inferred.
  assert.equal(item.editable, true);
  assert.equal(item.cancelable, true);
});

test("the content token is deterministic and moves with the text it names", () => {
  assert.equal(pendingContentToken("a"), pendingContentToken("a"));
  assert.notEqual(pendingContentToken("a"), pendingContentToken("b"));
  assert.notEqual(pendingContentToken("ab"), pendingContentToken("ba"));
  // Length travels with the digest, so two texts of different length are never the same token.
  assert.notEqual(pendingContentToken("x"), pendingContentToken("xx"));
  assert.match(pendingContentToken("queued text"), /^[0-9a-f-]+$/);
});

test("a report item carries its automatic source and source references", () => {
  const item = projectQueuedItem(facts({
    content: "The delegated child 9 finished",
    report: {
      dispatchId: "7:call-1",
      childConversationId: "9",
      submissionId: "12",
      submissionStatus: "done",
      answerEntryId: "13",
      preview: { bytes: 20, droppedBytes: 0, droppedLines: 0, sourceTruncated: false, maxBytes: 8192, maxLines: 400 },
    },
  }));
  assert.equal(item.source.kind, "report");
  if (item.source.kind !== "report") return;
  assert.equal(item.source.dispatchId, "7:call-1");
  assert.equal(item.source.childConversationId, "9");
  assert.equal(item.source.submissionStatus, "done");
  assert.equal(item.source.answerEntryId, "13");
  assert.equal(item.source.preview.maxBytes, 8192);
  // A report is a queued input like any other: the user decides about it item by item.
  assert.equal(item.editable, true);
  assert.equal(item.cancelable, true);
});

test("an unanswered report states its reason instead of an answer entry", () => {
  const item = projectQueuedItem(facts({
    report: {
      dispatchId: "7:call-1",
      childConversationId: "9",
      submissionId: "12",
      submissionStatus: "unanswered",
      answerReason: "aborted",
      preview: { bytes: 0, droppedBytes: 0, droppedLines: 0, sourceTruncated: false, maxBytes: 8192, maxLines: 400 },
    },
  }));
  if (item.source.kind !== "report") throw new Error("expected a report source");
  assert.equal(item.source.answerEntryId, undefined);
  assert.equal(item.source.answerReason, "aborted");
});
