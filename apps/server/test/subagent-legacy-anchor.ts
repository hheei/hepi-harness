/**
 * The **historical** anchor definition, verbatim from the commit before ticket 07 (`1e10e8c`), kept only so a test can
 * produce a **real** baseline database: the durable state an installation that already ran the pre-reporter anchor
 * holds. It is not a fake record and not a hand-written fixture row — the baseline is created by running the real
 * `agent_spawn` tool, the real creation seam, the real child conversation and the real storage against this one task
 * definition, which is the only thing a version 1 database differs in.
 *
 * It registers under the same task name as the current anchor, so the real extension's tool and the real dispatch
 * record are unchanged; only the definition that reserves the record is the older one.
 */
import { defineTask, type ConversationId, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DispatchDoc, SUBAGENT_ANCHOR_TASK } from "../src/subagents/host.ts";

export type LegacyAnchorInput = { readonly dispatchId: string; readonly delegatingConversationId: string };
type LegacyAnchorPhase = { phase: "admit" } | { phase: "idle" };

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
}

async function admit(
  task: RunningTask<LegacyAnchorInput, { phase: "admit" }, null>,
  runtime: TaskRuntime<LegacyAnchorInput, LegacyAnchorPhase, null, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegatingConversationId } = task.input;
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

/** The pre-07 anchor: it admits the initial submission and then stays idle, and it creates no reporter. */
export const LegacyAnchorTask = defineTask<LegacyAnchorInput, LegacyAnchorPhase, null>({
  name: SUBAGENT_ANCHOR_TASK,
  version: 1,
  initial: () => ({ phase: "admit" }),
  phases: {
    admit,
    idle: async (_task, runtime) => { await waitForAbort(runtime.signal); },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "anchor_stopped" } }), context);
  },
});
