/**
 * The recovery projection as an ordinary, in-memory statement: what one dispatch record and one report record say about
 * themselves, and which of those states offers the retry the delegation seam already supports.
 *
 * The projection is the whole of G2's backend half: `childRecoveryFacts` takes the records the runtime already holds
 * and states one word per object, and `preparationRetryOf` decides — over the record alone — whether a retry is offered
 * or refused by name. Both are pure, so this file needs no store, no socket, no temporary directory and no clock, and it
 * neither duplicates nor replaces the real-stack acceptance cases in `child-recovery.test.ts`: those prove the HTTP
 * read and the write against real anchor, reporter and compaction tasks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { childRecoveryFacts, preparationRetryOf } from "../src/subagents/recovery.ts";
import type { DispatchRecord, ReportRecord } from "../src/subagents/host.ts";

/** One delegation, as the projection reads it: the dispatch and report records plus the live task facts around them. */
type Delegation = Parameters<typeof childRecoveryFacts>[0];

function delegation(overrides: {
  dispatch?: DispatchRecord;
  report?: ReportRecord;
  anchorPhase?: string;
  anchorBlocked?: boolean;
  anchorInterrupted?: boolean;
  reporterLive?: boolean;
  reporterPhase?: string;
  reporterBlocked?: boolean;
  reporterInterrupted?: boolean;
}): Delegation {
  return {
    delegating: 1,
    dispatchId: "parent:attempt-1",
    dispatch: overrides.dispatch ?? { version: 1, dispatchId: "parent:attempt-1", reporterTaskId: "17", preparation: "compact" },
    report: overrides.report,
    anchorPhase: "anchorPhase" in overrides ? overrides.anchorPhase : "prepare",
    anchorBlocked: overrides.anchorBlocked ?? false,
    anchorInterrupted: overrides.anchorInterrupted ?? false,
    reporterLive: overrides.reporterLive ?? false,
    reporterPhase: overrides.reporterPhase,
    reporterBlocked: overrides.reporterBlocked ?? false,
    reporterInterrupted: overrides.reporterInterrupted ?? false,
  } as unknown as Delegation;
}

test("a stated preparation failure is its own fact, and the anchor parked on it is stated beside it", () => {
  const facts = childRecoveryFacts(delegation({
    dispatch: { version: 1, dispatchId: "parent:attempt-1", reporterTaskId: "17", preparation: "compact", preparationFailedTaskId: "41", preparationError: "the summarizer answered no summary", preparationOutcome: "failed" },
  }));
  assert.equal(facts.preparation, "unretried-failure");
  assert.equal(facts.preparationFailedTaskId, "41", "the failed attempt names itself");
  assert.equal(facts.preparationError, "the summarizer answered no summary", "the runtime's own sentence, not one this build wrote");
  assert.equal(facts.anchorPhase, "preparing", "the anchor is the object parked on that failure");
  assert.equal(facts.requestId, "parent:attempt-1", "the dispatch identity is the caller's request identity");
  assert.equal(facts.delivery, undefined, "no reporter report exists, so nothing is claimed about a delivery");
  assert.equal(facts.anchorTaskId, undefined, "a field the record does not state is absent, not defaulted");
});

test("the same failure asked about once is stated as retried, and a dispatch with no preparation states none", () => {
  const retried = childRecoveryFacts(delegation({
    dispatch: { version: 1, dispatchId: "parent:attempt-1", preparation: "compact", preparationFailedTaskId: "41", preparationRetriedTaskId: "41" },
  }));
  assert.equal(retried.preparation, "retried");
  assert.equal(retried.preparationRetriedTaskId, "41");
  // A dispatch whose definition asked for no context preparation states no preparation fact at all.
  assert.equal(childRecoveryFacts(delegation({ dispatch: { version: 1, dispatchId: "d" } })).preparation, undefined);
});

test("a reporter's own phase, a recorded report nobody has admitted, and a report's receipt are three different words", () => {
  // Live: the reporter is waiting on a child that is still running.
  const waiting = childRecoveryFacts(delegation({ reporterLive: true, reporterPhase: "wait" }));
  assert.equal(waiting.delivery, "waiting-child");
  assert.equal(childRecoveryFacts(delegation({ reporterLive: true, reporterPhase: "deliver" })).delivery, "delivering");
  // Settled child, report recorded, delivery not yet admitted: not the same word as a running reporter.
  const recorded = childRecoveryFacts(delegation({ report: { version: 1, submissionStatus: "done", settledAt: 5 } }));
  assert.equal(recorded.delivery, "awaiting-delivery");
  assert.equal(recorded.childSubmissionStatus, "done");
  // The record's own receipt, once it states one.
  assert.equal(childRecoveryFacts(delegation({ report: { version: 1, submissionStatus: "done", delivery: "delivered" } })).delivery, "delivered");
  assert.equal(childRecoveryFacts(delegation({ report: { version: 1, submissionStatus: "unanswered", delivery: "recipient_deleted", answerReason: "removed" } })).delivery, "recipient_deleted");
  // A reporter nobody can take, or one a restart abandoned, states the runtime's answer instead of a phase.
  assert.equal(childRecoveryFacts(delegation({ reporterBlocked: true, reporterLive: true })).delivery, "blocked");
  assert.equal(childRecoveryFacts(delegation({ reporterInterrupted: true, reporterLive: true })).delivery, "interrupted");
  // No reporter at all states nothing.
  assert.equal(childRecoveryFacts(delegation({})).delivery, undefined);
});

test("the anchor's blocked and interrupted states are its own words, never an inferred phase", () => {
  assert.equal(childRecoveryFacts(delegation({ anchorBlocked: true })).anchorPhase, "blocked");
  assert.equal(childRecoveryFacts(delegation({ anchorInterrupted: true })).anchorPhase, "interrupted");
  assert.equal(childRecoveryFacts(delegation({ anchorPhase: "admit" })).anchorPhase, "admitting");
  assert.equal(childRecoveryFacts(delegation({ anchorPhase: "idle" })).anchorPhase, "idle");
  assert.equal(childRecoveryFacts(delegation({ anchorPhase: undefined })).anchorPhase, undefined, "a settled task states no phase rather than a guess");
});

test("only an unretried failure offers a retry, and it offers the failed attempt's own id", () => {
  assert.deepEqual(preparationRetryOf({ version: 1, preparationFailedTaskId: "41" }), { ok: true, failedTaskId: "41" });
  assert.deepEqual(preparationRetryOf({ version: 1, preparationFailedTaskId: "41", preparationRetriedTaskId: "41" }), { ok: false, code: "already_retried" }, "asking twice is asking once");
  assert.deepEqual(preparationRetryOf({ version: 1 }), { ok: false, code: "not_failed" }, "a dispatch that states no failure has nothing to retry");
  assert.deepEqual(preparationRetryOf({ version: 1, preparationRetriedTaskId: "41" }), { ok: false, code: "already_retried" }, "a record that only names a retried attempt has no failure left to offer");
  // A later failure is a different attempt, so the record offers that one and not the one already asked about.
  assert.deepEqual(preparationRetryOf({ version: 1, preparationFailedTaskId: "42", preparationRetriedTaskId: "41" }), { ok: true, failedTaskId: "42" });
});
