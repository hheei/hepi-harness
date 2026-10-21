/**
 * Ticket 01's audit, pinned as read-only assertions on the claims the capability matrix rests on.
 *
 * The audit is a document; these are the three facts in it that a later edit could silently falsify without any other
 * test noticing, so they are asserted against the real definitions rather than quoted from them:
 *
 * 1. **Which operations declare themselves replay-safe.** A tool's replay policy is what decides whether a restart
 *    reruns it or reports it interrupted. The delegation tools declare "safe" (their rerun resolves to the child and
 *    submission the first attempt made); no installed coding tool declares anything, so write/edit/bash keep the
 *    runtime's "unsafe" default and are never replayed.
 * 2. **The status projection maps every inspected task state to exactly one recovery bucket.** Blocked, interrupted,
 *    stopping, held, running, waiting-report and idle are separate statements, and interruption is never inferred from
 *    an absent answer.
 * 3. **The durable identity the report delivery keys on is derived, not minted per attempt.** A report's recipient
 *    identity is the dispatch id plus a fixed suffix, so a rerun of the delivery resolves to the same submission.
 *
 * Nothing here starts a runtime, writes a store or changes behavior: the first part reads the installed definitions, the
 * second projects facts the runtime already publishes, the third compares the identity the reporter computes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskInspection } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { reportRequestId } from "../src/subagents/reporter.ts";
import { projectRunStatus } from "../src/subagents/status.ts";

/** One live task record shaped the way the runtime states it, for the projection only. */
function task(overrides: { background?: boolean; abortReason?: "restart" } = {}): TaskInspection {
  return {
    record: {
      conversationId: 1,
      background: overrides.background ?? false,
      ...(overrides.abortReason === undefined ? {} : { abortReason: overrides.abortReason }),
    },
    state: { kind: "running" },
  } as unknown as TaskInspection;
}

/** One task the current registry cannot take, with the runtime's own reason. */
function blockedTask(reason: "missing_task" | "task_too_old" | "migration_failed"): TaskInspection {
  return { record: { conversationId: 1, background: false }, state: { kind: "blocked", reason } } as unknown as TaskInspection;
}

test("the installed coding tools declare no replay policy, so a restart reports them interrupted instead of rerunning", () => {
  const coding = (CodingTools.tools ?? []).map(tool => ({ name: tool.name, replay: (tool as { replay?: "safe" | "unsafe" }).replay }));
  // The names are the tool set this deployment installs into a conversation that has an execution workspace.
  assert.deepEqual(coding.map(tool => tool.name).sort(), ["bash", "edit", "read", "write"]);
  // No declaration is the runtime's "unsafe" default: these tools mutate the workspace, so the audit's
  // "interrupted unsafe tool" row is what they reach after a crash, and nothing replays them.
  assert.deepEqual(coding.filter(tool => tool.replay !== undefined), [], JSON.stringify(coding));
});

test("the status projection states one recovery bucket per inspected task state, and never infers interruption", () => {
  const idle = { busy: false, control: { state: "allowed" as const }, waitingReport: false };
  // A live task of the conversation's ordinary scope is running work, and a background task never is: a child's
  // permanent anchor and a reporter live for the child's lifetime, so counting them would show every child as running.
  assert.deepEqual(projectRunStatus({ ...idle, tasks: [task()] }), { state: "running" });
  assert.deepEqual(projectRunStatus({ ...idle, tasks: [task({ background: true })] }), { state: "idle" });
  // A task no definition can take is stated with the runtime's own reason, which is the audit's "blocked" row.
  for (const reason of ["missing_task", "task_too_old", "migration_failed"] as const) {
    assert.deepEqual(projectRunStatus({ ...idle, tasks: [blockedTask(reason)] }), { state: "blocked", reason });
  }
  // An abandoned task is the audit's "interrupted" row, and its reason is the runtime's own mark: not an absent
  // answer, a disconnected client or an idle parent.
  assert.deepEqual(projectRunStatus({ ...idle, tasks: [task({ abortReason: "restart" })] }), { state: "interrupted", reason: "restart" });
  // A stop that has not drained is stopping; one that has is held.
  assert.deepEqual(projectRunStatus({ ...idle, control: { state: "held" }, tasks: [task()] }), { state: "stopping" });
  assert.deepEqual(projectRunStatus({ ...idle, control: { state: "held" }, tasks: [] }), { state: "held" });
  // A settled child whose result is still queued in its recipient states that as its own fact.
  assert.deepEqual(projectRunStatus({ ...idle, waitingReport: true, tasks: [] }), { state: "waiting-report" });
  assert.deepEqual(projectRunStatus({ ...idle, tasks: [] }), { state: "idle" });
  // The order is the audit's: a state in which nothing happens on its own outranks the work and the queue.
  assert.deepEqual(projectRunStatus({ busy: true, control: { state: "held" }, waitingReport: true, tasks: [blockedTask("missing_task")] }), { state: "blocked", reason: "missing_task" });
});

test("a report's recipient identity is derived from the dispatch, so a rerun of the delivery resolves to one submission", () => {
  // The reporter admits the report under this id in the recipient, and a rerun computes the same one: the report's own
  // stable identity rather than a second one minted to make an uncertain delivery look settled.
  assert.equal(reportRequestId("7:call-1"), "7:call-1:report");
  assert.equal(reportRequestId("7:call-1"), reportRequestId("7:call-1"));
  // Two dispatches of one conversation never share a report identity, and a report is not the child's own admission.
  assert.notEqual(reportRequestId("7:call-1"), reportRequestId("7:call-2"));
});
