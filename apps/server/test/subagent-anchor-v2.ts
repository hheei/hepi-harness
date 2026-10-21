/**
 * The **newer** anchor definitions, kept only so a test can state what a build ahead of this one leaves behind.
 *
 * Ticket 01's audit recorded gap G5: `task_too_old` and `migration_failed` are the runtime's own blocked reasons and
 * the projection handles all three, but only `missing_task` had been measured against a real store. A real store needs
 * a real definition of another version, so this is the counterpart of `subagent-legacy-anchor.ts`: both definitions
 * here register under the same task name at **version 2**, and the only difference between them is whether that build
 * shipped a migration.
 *
 * The version stamped on a stored record is the reserving definition's, so a build one ahead leaves a version 2 record
 * **whether or not** it migrates: `MigratedFutureAnchorTask` can carry a version 1 record forward, and the record it
 * then holds is one this build cannot take back at all. That is what makes both blocked reasons reachable from stores a
 * real delegation wrote, rather than from a hand-made row.
 *
 * Nothing here is a hand-written record or a fixture row: the stores are produced by the real creation seam, the real
 * `agent_spawn` tool and the real storage, with one of these as the definition that reserves the record.
 */
import { defineTask, type ConversationId, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DispatchDoc, SUBAGENT_ANCHOR_TASK } from "../src/subagents/host.ts";

export type FutureAnchorInput = { readonly dispatchId?: string; readonly initialPhase?: "idle"; readonly delegatingConversationId: string };
type FutureAnchorPhase = { phase: "admit" } | { phase: "idle" };

/** The admission a version 2 anchor performs: answer the dispatch the delegation already wrote, and park. No reporter:
 *  the two things measured here are the stored version and what a build that cannot take it says, not the report. */
async function admit(
  task: RunningTask<FutureAnchorInput, { phase: "admit" }, null>,
  runtime: TaskRuntime<FutureAnchorInput, FutureAnchorPhase, null, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegatingConversationId } = task.input;
  if (dispatchId === undefined) throw new Error("a version 2 admission names no dispatch record");
  const delegating = Number(delegatingConversationId) as ConversationId;
  const dispatch = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
  if (dispatch?.childConversationId === undefined) throw new Error("the dispatch record " + dispatchId + " names no child conversation");
  const childId = Number(dispatch.childConversationId) as ConversationId;
  const child = await runtime.conversation(childId, context);
  if (child === undefined) throw new Error("the child conversation " + dispatch.childConversationId + " is missing");
  const requestId = dispatch.submissionRequestId ?? dispatchId;
  const submission = await child.submit({ type: "input", content: [{ type: "text", text: dispatch.task ?? "" }], requestId }, context);
  await runtime.commit(async (tx) => {
    const record = await tx.doc(DispatchDoc, delegating, dispatchId, null);
    record.submissionRequestId = requestId;
    record.submissionId = String(submission.id);
    return { status: "running", checkpoint: { phase: "idle" } };
  }, context);
}

/** The permanent phase: it parks until the invocation is signalled, which is all a parked anchor does. */
async function idle(_task: unknown, runtime: { signal: AbortSignal }): Promise<void> {
  await new Promise<void>((resolve) => { runtime.signal.addEventListener("abort", () => resolve(), { once: true }); });
}

const anchor = {
  name: SUBAGENT_ANCHOR_TASK,
  version: 2,
  initial: (input: FutureAnchorInput) => ({ phase: input.initialPhase === "idle" ? "idle" : "admit" }),
  phases: { admit, idle },
  abort: async (_task: unknown, runtime: { commit(write: () => unknown, context: Context): Promise<unknown> }, context: Context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "anchor_stopped" } }), context);
  },
};

/**
 * The version 2 anchor with **no** migration: meeting a stored version 1 record is the runtime's own refusal, which is
 * how `migration_failed` is reached on a store this build wrote.
 */
export const FutureAnchorTask = defineTask<FutureAnchorInput, FutureAnchorPhase, null>(anchor as never);

/**
 * The same version 2 anchor **with** a migration, so a build ahead can admit a version 1 delegation and keep going.
 *
 * A version 1 anchor record's input and checkpoint are already what this shape needs, which is exactly the case a
 * migration exists for. What matters for the measurement is the version this build then **stamps** on the record — 2 —
 * because that is what a build behind it reads, and nothing in it can take a higher one.
 */
export const MigratedFutureAnchorTask = defineTask<FutureAnchorInput, FutureAnchorPhase, null>({
  ...anchor,
  migrate: (input: FutureAnchorInput, checkpoint: FutureAnchorPhase) => ({ input, checkpoint }),
} as never);
