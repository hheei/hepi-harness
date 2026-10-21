/**
 * The durable reporter task: the recoverable phase that waits one delegation's whole Submission out and delivers its
 * terminal result into the recipient's own native Inbox.
 *
 * It is a **conversation-owned background task** of the delegating conversation, created by the anchor in the same
 * commit that records the admitted submission. That placement is what makes a user stop of the delegating conversation
 * leave the report running — ordinary traversal never enters a background task — while the reporter still names the
 * conversation whose inbox the report belongs in (spec D05, D07).
 *
 * Nothing here holds an in-memory handover: the wait reacquires the child's submission through the native admission by
 * the dispatch's own stable request id, which a duplicate request id answers with the submission the anchor already
 * admitted, and it waits on that submission's durable settlement. A process that died anywhere in the phase resumes it
 * from its checkpoint and re-does the same two steps against the same identities, so a crash cannot lose a report or
 * make a second one (spec D04, D05, A19).
 *
 * Delivery is one native admission and nothing else. The recipient's own committed state decides the outcome — an
 * allowed idle conversation starts a run, a running one queues the report at its next boundary, a held one queues it and
 * starts nothing — so no control rule is restated here and an automatic report never clears a user's stop (spec D05,
 * D07). Only the final answer or the terminal reason travels, bounded by a fixed preview rule, with the source
 * conversation and answer entry named so the full text stays readable through the core read (spec D05).
 */

import type { Context } from "@earendil-works/chord";
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
import {
  defineTask,
  type ConversationId,
  type RunningTask,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { AGENT_REPORT_ENTRY_KIND, DispatchDoc, ReportDoc, SUBAGENT_REPORTER_TASK, type SubagentHost } from "./host.ts";

/** What one reporter needs: which dispatch record it reports, and the conversation that record lives on. */
export type SubagentReporterInput = { readonly dispatchId: string; readonly delegatingConversationId: string };

/** The reporter's two phases: wait the child's whole submission out once, then deliver its result once. */
export type SubagentReporterPhase = { phase: "wait" } | { phase: "deliver" };

/** The durable receipt one finished reporter leaves: the child identity, its terminal status and what the delivery did. */
export type SubagentReportResult = {
  readonly dispatchId: string;
  readonly childConversationId: string;
  readonly submissionId: string;
  readonly submissionStatus: "done" | "unanswered";
  readonly delivery: "delivered" | "recipient_deleted" | "recipient_missing";
  readonly deliveredSubmissionId?: string;
  readonly answerEntryId?: string;
};

/** The fixed preview rule: a head cut of the child's own final answer, never a model-written summary. */
export const REPORT_PREVIEW_BYTES = 8 * 1024;
export const REPORT_PREVIEW_LINES = 400;

/** The report's own stable identity in the recipient: one dispatch, one report, however often a phase re-runs. */
export function reportRequestId(dispatchId: string): string {
  return dispatchId + ":report";
}

/** The bounded preview of one child answer, read through the core bounded read and cut by the fixed preview rule. */
type Preview = { readonly text: string; readonly droppedBytes: number; readonly droppedLines: number; readonly sourceTruncated: boolean; readonly bytes: number };

/**
 * Read the text of one answer entry and cut it to the preview budget.
 *
 * The entry read states the entry's own block inventory, so only the **text** blocks are read: a thinking block or a
 * tool call beside the answer is not carried into the recipient, which is what "the final answer, not the process"
 * means in practice. The read is the core bounded read (`agent_read` calls the same one), so the preview and a later
 * manual read cannot disagree about the same entry, and the full text stays reachable by the identity the report names.
 */
async function preview(host: SubagentHost, conversationId: string, entryId: string): Promise<Preview> {
  const entry = await host.read({ conversationId, entryId, limit: 2000 });
  const inventory = entry.details.entries.find((candidate) => candidate.entryId === entryId);
  const textBlocks = (inventory?.blocks ?? []).filter((block) => block.type === "text").map((block) => block.blockIndex);
  const parts: string[] = [];
  let sourceTruncated = entry.details.truncated;
  for (const blockIndex of textBlocks) {
    const block = await host.read({ conversationId, entryId, blockIndex, limit: 2000 });
    sourceTruncated = sourceTruncated || block.details.truncated;
    for (const part of block.output) if (part.type === "text") parts.push(part.text);
  }
  const bounded = boundOutput(parts.join("\n\n"), { maxBytes: REPORT_PREVIEW_BYTES, maxLines: REPORT_PREVIEW_LINES, retain: "head" });
  return { text: bounded.text, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines, sourceTruncated, bytes: utf8ByteLength(bounded.text) };
}

/** The one statement a delivery makes about its own truncation, so a reader is never left guessing about the cut. */
function truncationNotice(preview: Preview, childConversationId: string, answerEntryId: string | undefined): string {
  const cut = preview.droppedBytes > 0 || preview.droppedLines > 0 || preview.sourceTruncated;
  if (!cut) return "";
  const source = answerEntryId === undefined
    ? "conversation " + childConversationId
    : "conversation " + childConversationId + " entry " + answerEntryId;
  const dropped = [];
  if (preview.droppedBytes > 0) dropped.push(preview.droppedBytes + " byte(s)");
  if (preview.droppedLines > 0) dropped.push(preview.droppedLines + " line(s)");
  return "\n\n[the child's answer was cut to the " + REPORT_PREVIEW_BYTES + "-byte report preview" + (dropped.length === 0 ? "" : "; " + dropped.join(" and ") + " were left out") + ". Read the whole source with agent_read on " + source + ".]";
}

/** Wait the whole submission out once, then hand over to the delivery phase. */
async function wait(
  task: RunningTask<SubagentReporterInput, { phase: "wait" }, SubagentReportResult>,
  runtime: TaskRuntime<SubagentReporterInput, SubagentReporterPhase, SubagentReportResult, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegatingConversationId } = task.input;
  const delegating = Number(delegatingConversationId) as ConversationId;
  const dispatch = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
  if (dispatch?.childConversationId === undefined) throw new Error("the dispatch record " + dispatchId + " names no child conversation; the report cannot be resumed");
  const childId = Number(dispatch.childConversationId) as ConversationId;
  const child = await runtime.conversation(childId, context);
  if (child === undefined) throw new Error("the child conversation " + dispatch.childConversationId + " of dispatch " + dispatchId + " is missing");
  // The dispatch's own request id, so this is the anchor's admission and never a second turn: the native admission
  // answers a known request id with the submission that already exists.
  const requestId = dispatch.submissionRequestId ?? dispatchId;
  const submission = await child.submit({ type: "input", content: [{ type: "text", text: dispatch.task ?? "" }], requestId }, context);
  // The whole submission, not the first generation: a tool round hands the run over and leaves this input placed, so
  // only the run's own settlement — an answer, or an abort, a reset or a failure that ends it — resolves this wait.
  const settled = await submission.wait(context);
  await runtime.commit(async (tx) => {
    const report = await tx.doc(ReportDoc, delegating, dispatchId, null);
    report.version = 1;
    report.dispatchId = dispatchId;
    report.childConversationId = String(childId);
    report.submissionId = String(settled.id);
    report.submissionStatus = settled.status;
    if (settled.status === "done") report.answerEntryId = String(settled.answer);
    else report.answerReason = settled.reason;
    report.settledAt = runtime.now();
    return { status: "running", checkpoint: { phase: "deliver" } };
  }, context);
}

/** Deliver the settled result into the recipient once, then settle the reporter with its own receipt. */
async function deliver(
  task: RunningTask<SubagentReporterInput, { phase: "deliver" }, SubagentReportResult>,
  runtime: TaskRuntime<SubagentReporterInput, SubagentReporterPhase, SubagentReportResult, object>,
  context: Context,
  host: SubagentHost,
): Promise<void> {
  const { dispatchId, delegatingConversationId } = task.input;
  const delegating = Number(delegatingConversationId) as ConversationId;
  const report = await runtime.snapshot(ReportDoc, delegating, dispatchId, context);
  if (report?.childConversationId === undefined || report.submissionId === undefined || report.submissionStatus === undefined) {
    throw new Error("the report record " + dispatchId + " has no settled child submission; the delivery cannot be resumed");
  }
  const childConversationId = report.childConversationId;
  const answerEntryId = report.answerEntryId;
  // The text the recipient's model reads: the child's own final answer, or the terminal reason when there is no answer.
  const body = report.submissionStatus === "done" && answerEntryId !== undefined
    ? await preview(host, childConversationId, answerEntryId)
    : { text: "The delegated work ended without an answer (reason: " + (report.answerReason ?? "unknown") + ").", droppedBytes: 0, droppedLines: 0, sourceTruncated: false, bytes: 0 };
  const text = "The delegated child " + childConversationId + " (dispatch " + dispatchId + ") finished with status " + report.submissionStatus + ".\n\n" + body.text + truncationNotice(body, childConversationId, answerEntryId);
  const delivered = await host.deliver({
    recipientConversationId: delegatingConversationId,
    requestId: reportRequestId(dispatchId),
    content: [{ type: "text", text }],
    entry: {
      kind: AGENT_REPORT_ENTRY_KIND,
      data: {
        dispatchId,
        childConversationId,
        submissionId: report.submissionId,
        submissionStatus: report.submissionStatus,
        ...(answerEntryId === undefined ? {} : { answerEntryId }),
        ...(report.answerReason === undefined ? {} : { answerReason: report.answerReason }),
        preview: { bytes: body.bytes, droppedBytes: body.droppedBytes, droppedLines: body.droppedLines, sourceTruncated: body.sourceTruncated, maxBytes: REPORT_PREVIEW_BYTES, maxLines: REPORT_PREVIEW_LINES },
      },
    },
    // A report is a follow-up: on a running recipient it waits for the next boundary instead of interrupting a tool,
    // and on a held one it queues without starting anything.
    whenBusy: "followUp",
  });
  const delivery = delivered.ok ? "delivered" as const : delivered.code === "recipient_deleted" ? "recipient_deleted" as const : "recipient_missing" as const;
  const result: SubagentReportResult = {
    dispatchId,
    childConversationId,
    submissionId: report.submissionId,
    submissionStatus: report.submissionStatus,
    delivery,
    ...(delivered.ok ? { deliveredSubmissionId: delivered.submissionId } : {}),
    ...(answerEntryId === undefined ? {} : { answerEntryId }),
  };
  await runtime.commit(async (tx) => {
    const record = await tx.doc(ReportDoc, delegating, dispatchId, null);
    record.delivery = delivery;
    if (delivered.ok) record.deliveredSubmissionId = delivered.submissionId;
    record.deliveredAt = runtime.now();
    // A removed recipient is a terminal decision, not a failure to retry: the source result stays in this record and in
    // the reporter's own outcome (spec D05, A22).
    return { status: "terminal", outcome: { status: "completed", result } };
  }, context);
}

/** Build the reporter over the host port the composition supplies. */
export function createSubagentReporterTask(host: SubagentHost) {
  return defineTask<SubagentReporterInput, SubagentReporterPhase, SubagentReportResult>({
    name: SUBAGENT_REPORTER_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait,
      deliver: (task, runtime, context) => deliver(task, runtime, context, host),
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "reporter_stopped" } }), context);
    },
  });
}

/** The reporter's own task definition, as the anchor names it when it creates one. */
export type SubagentReporterTask = ReturnType<typeof createSubagentReporterTask>;
