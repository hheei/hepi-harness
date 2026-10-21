/**
 * The durable anchor task: the native owner of one delegated child conversation, and the one place the child's initial
 * task is admitted.
 *
 * The anchor is a **conversation-owned background task** of the delegating conversation. That placement is what makes
 * the child survive the parent's stop: ordinary traversal never enters a background task, so a stop of the delegating
 * conversation marks neither the anchor nor the child beneath it, while the anchor still names the conversation that
 * owns the delegation (spec D04, D07).
 *
 * The anchor is a *permanent* identity, not one dispatch's bookkeeping: it stays in an idle phase for the life of the
 * child so a later dispatch to the same child is a new submission under the same owner, and it is never settled by a
 * child's result. Its `admit` phase is what makes the initial admission recoverable — the task text and the stable
 * submission request id are already durable in the dispatch record, so a process that died between the creating commit
 * and the admission resumes the phase and admits the same submission once, instead of losing the delegation or making a
 * second one (spec D04, A19).
 *
 * The same anchor owns a conversation a **user** branched from another one. That child has no delegation to admit — its
 * history came from the position the user picked, not from a task text — but it still needs an independent native owner
 * inside the source conversation's background scope, so the anchor starts in the permanent idle phase and admits
 * nothing (spec D14).
 *
 * The anchor also creates the **reporter** of the admission it just made: the recoverable task that waits the child's
 * whole submission out and delivers its terminal result to the recipient. It is created by name from the runtime's own
 * registry, which is the same authority that resolves this anchor by name, so the anchor holds no reference to the
 * reporter's composition and a recovered anchor finds the definition the same way a fresh one does (spec D04, D05).
 */

import { CompactionTask, defineTask, type CompactionResult, type ConversationId, type RunningTask, type Task, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DispatchDoc, preparationUnretried, SUBAGENT_ANCHOR_TASK, SUBAGENT_REPORTER_TASK, type DispatchRecord } from "./host.ts";
import type { SubagentReporterInput, SubagentReporterPhase, SubagentReportResult } from "./reporter.ts";

/**
 * What one anchor needs: the conversation whose background scope owns it, and — for a delegation — the dispatch record
 * it admits. A fork anchor names no dispatch, because there is nothing to admit: the phase it starts in is the whole
 * difference, and both shapes are one task kind, one owner and one scope.
 */
export type SubagentAnchorInput =
  | { readonly dispatchId: string; readonly initialPhase?: never; readonly delegatingConversationId: string; readonly preparation?: "compact" }
  | { readonly initialPhase: "idle"; readonly dispatchId?: never; readonly preparation?: never; readonly delegatingConversationId: string };

/**
 * The anchor's phases. `prepare` is entered only by a delegation whose definition asked for `compact`, and it is what
 * makes the preparation recoverable: the compaction task it creates is durable, so a process that died while the
 * summary was being written resumes here and reads that task's own outcome instead of compacting a second time
 * (spec D11, A14).
 */
type SubagentAnchorPhase =
  /** Driving one preparation attempt: `compaction` is the attempt's own task, absent until the first run creates it. */
  | { phase: "prepare"; compaction?: TaskId<CompactionResult> }
  | { phase: "admit" }
  | { phase: "idle" };

/**
 * Whether the caller has asked to retry the preparation failure of one attempt. A retry names the failed attempt's own
 * task id, so asking twice is asking once and the next attempt's failure is a different id — which is what makes it a
 * fresh, retryable failure rather than the same one being retried forever.
 */
function retryAsked(record: DispatchRecord, compaction: TaskId<CompactionResult>): boolean {
  return record.preparationRetriedTaskId === String(compaction);
}

/** The child one delegation owns, and the record that states it, resolved the one way all three phases resolve it. */
async function resolveDelegation(
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  input: SubagentAnchorInput,
  context: Context,
): Promise<{ readonly delegating: ConversationId; readonly dispatchId: string; readonly childId: ConversationId; readonly record: DispatchRecord }> {
  const { dispatchId, delegatingConversationId } = input;
  if (dispatchId === undefined) throw new Error("a preparing anchor names no dispatch record; only a delegation prepares or admits");
  const delegating = Number(delegatingConversationId) as ConversationId;
  const record = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
  if (record === undefined) throw new Error("the dispatch record " + dispatchId + " is missing; the delegation cannot be resumed");
  if (record.childConversationId === undefined) throw new Error("the dispatch record " + dispatchId + " names no child conversation");
  return { delegating, dispatchId, childId: Number(record.childConversationId) as ConversationId, record };
}

/** Resolve when the invocation is signalled; a permanent idle phase returns only because its task was stopped. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
}

async function admit(
  task: RunningTask<SubagentAnchorInput, { phase: "admit" }, null>,
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegating, childId, record: dispatch } = await resolveDelegation(runtime, task.input, context);
  const child = await runtime.conversation(childId, context);
  if (child === undefined) throw new Error("the child conversation " + dispatch.childConversationId + " of dispatch " + dispatchId + " is missing");
  // The request id is the dispatch's own, so a phase that runs twice — after a crash, or after a restart that rewound a
  // running task — is answered with the submission the first admission made instead of a second turn.
  const requestId = dispatch.submissionRequestId ?? dispatchId;
  const submission = await child.submit({ type: "input", content: [{ type: "text", text: dispatch.task ?? "" }], requestId }, context);
  await runtime.commit(async (tx) => {
    // The document is read before the reporter task is created, so this commit's only table write comes last.
    const record = await tx.doc(DispatchDoc, delegating, dispatchId, null);
    record.submissionRequestId = requestId;
    record.submissionId = String(submission.id);
    // The reporter is created **after** the admission, in the same commit that records the submission it will wait on,
    // so the child has exactly one reporter from the moment its admission is durable. The committed dispatch record
    // decides whether one already exists: a phase that re-runs after a crash sees its own `reporterTaskId` and creates
    // nothing, and a phase that died before this commit created none. Its placement is the delegating conversation's own
    // background scope, so a user stop of that conversation leaves the report running (spec D04, D05, D07, A19).
    if (record.reporterTaskId === undefined) {
      const created = await tx.createTask(reporterDefinition(runtime), { dispatchId, delegatingConversationId: task.input.delegatingConversationId }, { ownership: { kind: "conversation" }, conversationId: delegating, background: true });
      record.reporterTaskId = String(created);
    }
    return { status: "running", checkpoint: { phase: "idle" } };
  }, context);
}

/**
 * State one preparation attempt's failure and wait until the caller asks to retry it.
 *
 * A failure is **stated**, never silently turned into a fresh child, and it is **retryable under the same dispatch
 * identity**: the anchor commits the failure and then watches its own dispatch record, so the retry is a durable write
 * the caller makes and a restart resumes this same parking instead of deciding again. No timer, no second store and no
 * automatic re-run: a delegation whose preparation failed stays exactly as it is until a caller asks again.
 *
 * The failure is committed with the **failed attempt's own task id**, which is also what a retry names — so the two
 * fields that describe a failure are one identity compared to another, a restart that re-states the same failure writes
 * the same value, and a retry of one failure can never be mistaken for a retry of the next.
 */
async function parkFailed(
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  delegating: ConversationId,
  dispatchId: string,
  compaction: TaskId<CompactionResult>,
  reason: string,
  outcome: string,
  context: Context,
): Promise<void> {
  // State the failure only if this attempt's failure is not stated yet. The record is the one place the retry is
  // written, so re-writing the fields this phase already wrote — which a restart does on every resume — would be a
  // needless second writer of a document another writer is using to hand the retry over.
  const stated = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
  if (stated?.preparationFailedTaskId !== String(compaction)) {
    await runtime.commit(async (tx) => {
      const record = await tx.doc(DispatchDoc, delegating, dispatchId, null);
      record.preparationFailedTaskId = String(compaction);
      record.preparationError = reason;
      record.preparationOutcome = outcome;
      // The checkpoint already names this attempt, so stating the failure moves nothing: waiting is what the phase is
      // doing, and the attempt the retry starts is what moves it.
      return undefined;
    }, context);
  }
  await waitForRetry(runtime, delegating, dispatchId, compaction, context);
  await runtime.commit(async (tx) => {
    const record = await tx.doc(DispatchDoc, delegating, dispatchId, null);
    // The stated failure is cleared as the retry begins: the attempt that follows either succeeds or states a failure
    // of its own, so nothing ever reads a stale reason as the current state of the delegation. Forgetting the failed
    // attempt is what makes the phase prepare again instead of reading the same failure and parking on it a second
    // time; if the process dies here, the resume creates exactly one new attempt.
    record.preparationFailedTaskId = undefined;
    record.preparationError = undefined;
    record.preparationOutcome = undefined;
    return { status: "running", checkpoint: { phase: "prepare" } };
  }, context);
}

/** How long a parking anchor waits before re-reading its own record when it could not acquire a watch. */
const RETRY_POLL_MS = 250;

/**
 * Wait until the caller asks to retry this attempt's failure.
 *
 * Nothing wakes a task on a document write, so the anchor watches **its own dispatch record**: the retry the caller
 * commits is delivered to the listener, and any other write is waited through. The state is re-read before and after
 * every watch, so the decision is always the durable record's and never a callback's, and an interrupted watch costs one
 * extra read instead of a missed retry.
 */
async function waitForRetry(
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  delegating: ConversationId,
  dispatchId: string,
  compaction: TaskId<CompactionResult>,
  context: Context,
): Promise<void> {
  for (;;) {
    context.abortSignal?.throwIfAborted();
    const current = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
    if (current !== undefined && retryAsked(current, compaction)) return;
    const watch = await runtime.watchDoc(DispatchDoc, delegating, dispatchId, context);
    if (watch === undefined) {
      // No watch, so the record is polled instead: slower, but the same durable answer, and a deployment that cannot
      // watch documents still retries rather than parking forever.
      await runtime.sleep(runtime.now() + RETRY_POLL_MS, context);
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { void watch.stop(); };
      context.abortSignal?.addEventListener("abort", onAbort, { once: true });
      watch.start(async (value) => {
        if (value !== null && retryAsked(value, compaction)) await watch.stop();
      });
      // A write that landed between the read above and this acquisition is in the watch's own initial revision and is
      // never delivered to the listener, so the acquired value is checked too. Later writes are the listener's.
      const acquired = watch.value;
      if (acquired !== null && acquired !== undefined && retryAsked(acquired, compaction)) void watch.stop();
      void watch.closed.then(async (end) => {
        context.abortSignal?.removeEventListener("abort", onAbort);
        if (end.reason === "listener_error") { reject(end.error); return; }
        // A watch that ended without the retry — retired, or a session that closed — is re-read after a pause rather
        // than spun on, so a record that cannot be watched still parks instead of burning the scheduler.
        const settled = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context).catch(() => undefined);
        if (settled === undefined || !retryAsked(settled, compaction)) await runtime.sleep(runtime.now() + RETRY_POLL_MS, context).catch(() => undefined);
        resolve();
      });
    });
  }
}

/**
 * The one place a child's preparation is driven, and the one place its failure is stated.
 *
 * The compaction is a **conversation-owned background task of the child**, created in the anchor's own commit. A task a
 * task owns has to live in its owner's conversation, so the child — not the delegating conversation — is the only place
 * a preparation of the child can run. Background placement keeps it out of the child's ordinary idle and abort scope,
 * which belongs to the child's own work rather than to its preparation. The child is idle — nothing but this anchor can
 * see it, and this anchor is not admitting its task yet — so the summary the task places is the whole of the child's
 * model context when the task text arrives.
 *
 * Only a preparation that **failed** is a failure. A compaction that found nothing worth compacting is a completed
 * preparation of a context that was already short enough, so the anchor proceeds; the summary is not required for the
 * strategy to have been executed.
 *
 * A failure is **stated**, never silently turned into a fresh child, and it needs no new bookkeeping to be stated: the
 * anchor records the failure and the reason on the dispatch record it already owns, so `agent_get` reads one durable
 * field instead of a second failure store, and it then **waits for the caller's retry** rather than settling. The child
 * keeps its identity and its owner and admits nothing; a replay of the caller's request identity answers that child
 * rather than creating a second one, and a replay after a failure is what asks for the next attempt (spec D11, D16, A14).
 */
async function prepare(
  task: RunningTask<SubagentAnchorInput, { phase: "prepare"; compaction?: TaskId<CompactionResult> }, null>,
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegating, childId } = await resolveDelegation(runtime, task.input, context);
  const child = await runtime.conversation(childId, context);
  if (child === undefined) throw new Error("the child conversation " + String(childId) + " of dispatch " + dispatchId + " is missing");
  // The task named by the checkpoint is the one this phase created before it was interrupted, or the one whose failure
  // the caller has just asked to retry; only a first run — and a retry — creates one.
  const attempted = task.state.checkpoint.compaction;
  if (attempted !== undefined) {
    // Read from the task's own durable record, so a restart reads the outcome of the compaction that already ran
    // instead of compacting the child a second time.
    const [outcome] = await runtime.outcomes([attempted], context);
    if (outcome.status === "completed") {
      // A compaction that found nothing to compact is a completed preparation too: the strategy ran, and its answer is
      // that this context needed no summary, so the task text is admitted next (spec D11, A14).
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "admit" } }), context);
      return;
    }
    const reason = outcome.status === "failed" ? outcome.error.message : "context preparation ended " + outcome.status;
    // State the failure and wait for the caller's retry. The phase then falls through to a **new** attempt, so the
    // preparation is retried under the same dispatch identity and over the same child: no second child, no second
    // admission, and no fallback to a fresh context (spec D11, A14).
    await parkFailed(runtime, delegating, dispatchId, attempted, reason, outcome.status, context);
  }
  await runtime.commit(async (tx) => {
    const created = await tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" }, conversationId: childId, background: true });
    return { status: "waiting", checkpoint: { phase: "prepare", compaction: created }, on: [created], policy: "allSettled" };
  }, context);
}

/**
 * Give a delegation recorded before the reporter existed its reporter, once.
 *
 * A v1 database can hold an explicit dispatch whose anchor already admitted — its checkpoint is the permanent `idle`
 * phase and its record names the child submission — but which predates the reporter, so nothing would ever wait that
 * submission out. The idle phase is the only place that state is reachable, and the dispatch record's own
 * `reporterTaskId` is what makes this idempotent: a record that already names one is left alone, and a record that
 * names none gets exactly one, whatever invocation reaches it first. Nothing is admitted, resubmitted or created
 * besides that task: the child keeps its conversation, its identity and the submission its own anchor admitted, and the
 * reporter reacquires that same submission by the dispatch's stable request id.
 *
 * A **user fork**'s anchor names no dispatch, so it owns no delegation and recovers nothing, exactly as it admits
 * nothing.
 */
async function recoverReporter(
  task: RunningTask<SubagentAnchorInput, { phase: "idle" }, null>,
  runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>,
  context: Context,
): Promise<void> {
  const { dispatchId, delegatingConversationId } = task.input;
  if (dispatchId === undefined) return;
  const delegating = Number(delegatingConversationId) as ConversationId;
  const dispatch = await runtime.snapshot(DispatchDoc, delegating, dispatchId, context);
  if (dispatch === undefined || dispatch.reporterTaskId !== undefined) return;
  await runtime.commit(async (tx) => {
    // The record is read before the task is created, so this commit's only table write comes last; the re-read inside
    // the commit is what decides, so two invocations cannot both create one.
    const record = await tx.doc(DispatchDoc, delegating, dispatchId, null);
    if (record.reporterTaskId !== undefined) return undefined;
    const created = await tx.createTask(reporterDefinition(runtime), { dispatchId, delegatingConversationId }, { ownership: { kind: "conversation" }, conversationId: delegating, background: true });
    record.reporterTaskId = String(created);
    // The phase stays `idle`: recovering a reporter is not progress through the anchor's own lifecycle.
    return undefined;
  }, context);
}

/**
 * The reporter definition this runtime holds, resolved by its registered name.
 *
 * The registry is the definition authority every task is resolved through, so an anchor created by one composition and
 * recovered by a later process reaches the same definition; an install that registered the anchor without its reporter
 * is refused loudly here instead of committing an admission whose report could never be delivered.
 */
function reporterDefinition(runtime: TaskRuntime<SubagentAnchorInput, SubagentAnchorPhase, null, object>): Task<SubagentReporterInput, SubagentReporterPhase, SubagentReportResult, object> {
  const found = runtime.registry.task(SUBAGENT_REPORTER_TASK) as Task<SubagentReporterInput, SubagentReporterPhase, SubagentReportResult, object> | undefined;
  if (found === undefined) throw new Error("the reporter task " + SUBAGENT_REPORTER_TASK + " is not registered; the delegation cannot report its result");
  return found;
}

/**
 * Create the native owner of a conversation a **user** branched from another one. The branch has no delegation to admit,
 * so its anchor starts in the permanent idle phase and owns nothing but the branch; the caller writes it in the commit
 * that creates the branch, so the branch's owner exists exactly when the branch does. The anchor belongs to the
 * conversation the branch was taken from, which is the background scope that keeps the branch out of its source's stop
 * (spec D14).
 */
export function createForkAnchor(tx: Tx, conversationId: ConversationId): Promise<TaskId> {
  return tx.createTask(SubagentAnchorTask, { initialPhase: "idle", delegatingConversationId: String(conversationId) }, { ownership: { kind: "conversation" }, conversationId, background: true });
}

export const SubagentAnchorTask = defineTask<SubagentAnchorInput, SubagentAnchorPhase, null>({
  name: SUBAGENT_ANCHOR_TASK,
  version: 1,
  // The input states the starting phase, so one task kind serves a delegation's recoverable preparation and admission,
  // and a user fork's permanent owner. A record written before these fields existed carries neither and is an ordinary
  // delegation, which is why no stored input or checkpoint of ticket 06 needs migrating.
  initial: (input) => ({ phase: input.initialPhase === "idle" ? "idle" : input.preparation === "compact" ? "prepare" : "admit" }),
  phases: {
    prepare,
    admit,
    // A permanent anchor: the phase returns only when the invocation is signalled, which happens when the anchor itself
    // is stopped or the Harness closes. It commits no progress, so it never faults and never settles. Recovering a
    // reporter for a delegation that predates it happens here, before the phase parks (spec D04, A19).
    idle: async (task, runtime, context) => { await recoverReporter(task, runtime, context); await waitForAbort(runtime.signal); },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "anchor_stopped" } }), context);
  },
});
