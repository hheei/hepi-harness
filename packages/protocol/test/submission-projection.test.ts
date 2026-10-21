import assert from "node:assert/strict";
import test from "node:test";
import { projectSubmission, type SubmissionProjection } from "../src/index.ts";

/** One runtime record as the server adapter holds it: branded numeric ids and an optional request id. */
const record = (extra: Record<string, unknown>) => ({ id: 12, conversationId: 3, type: "input" as const, status: "queued" as const, ...extra });

test("projects every lifecycle stage into the same stable fields", () => {
  assert.deepEqual(projectSubmission(record({ requestId: "req-1" })), {
    protocol: "hepi.v1",
    conversationId: "3",
    submissionId: "12",
    requestId: "req-1",
    type: "input",
    status: "queued",
  });
  // A placed input owns the committed entry a client is waiting on, so the id travels with it.
  assert.deepEqual(projectSubmission(record({ requestId: "req-1", status: "placed", entry: 44 })), {
    protocol: "hepi.v1",
    conversationId: "3",
    submissionId: "12",
    requestId: "req-1",
    type: "input",
    status: "placed",
    entryId: "44",
  });
  // Answered: the entry is the turn and the answer is its own committed entry, which the transcript already carries.
  assert.equal(projectSubmission(record({ status: "done", entry: 44 })).entryId, "44");
  // Terminal without an answer: the reason is a durable fact, not a transport failure, and it is reported as one.
  const unanswered = projectSubmission(record({ status: "unanswered", reason: "recalled" }));
  assert.equal(unanswered.status, "unanswered");
  assert.equal(unanswered.reason, "recalled");
  assert.equal(unanswered.entryId, undefined);
});

test("carries the native answer identity of a terminal input, and no answer anywhere else", () => {
  // The answer is the key a completion notice is grouped by, so it has to be the runtime's own identity for the entry
  // the run committed — the transcript's ids alone cannot tell a client which input an answer settles.
  const answered = projectSubmission(record({ status: "done", entry: 44, answer: 45 }));
  assert.equal(answered.answerId, "45");
  // Absence stays absent: a placed input has no answer yet, a write is never answered, and an unanswered input never
  // gets one. An invented empty identity would be read as a real key.
  assert.equal("answerId" in projectSubmission(record({ status: "placed", entry: 44 })), false);
  assert.equal("answerId" in projectSubmission({ id: 2, conversationId: 1, type: "write", status: "done", entry: 9 }), false);
  assert.equal("answerId" in projectSubmission(record({ status: "unanswered", reason: "recalled" })), false);
});

test("keeps absence absent instead of inventing empty identity", () => {
  // A submission admitted without a host request id has none; it is not projected as an empty string, which a client
  // would then have to treat as an id.
  const bare = projectSubmission(record({}));
  assert.equal("requestId" in bare, false);
  assert.equal("entryId" in bare, false);
  assert.equal("reason" in bare, false);
  // Identity is stringified exactly as committed entry and conversation ids are, so a caller never sees a numeric type
  // where every other protocol field is a string.
  assert.equal(typeof bare.submissionId, "string");
  assert.equal(typeof bare.conversationId, "string");
});

test("a write submission is projected with its own type", () => {
  const write = projectSubmission({ id: 2, conversationId: 1, type: "write", status: "done", entry: 9 });
  assert.equal(write.type, "write");
  assert.equal(write.status, "done");
  assert.equal(write.entryId, "9");
});

test("the projection is strict JSON, so it can cross the wire unchanged", () => {
  const projection: SubmissionProjection = projectSubmission(record({ requestId: "req-1", status: "placed", entry: 44 }));
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
});
