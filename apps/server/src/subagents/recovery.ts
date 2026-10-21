/**
 * One delegated child's recovery facts, stated **per durable object** (the audit's G2).
 *
 * A child's own `runStatus` stays exactly what it is — one state per conversation, projected from that conversation's
 * facts — and this module is the half a client could not otherwise read: the delegation's own record (which preparation
 * attempt failed, and whether the caller has already asked that failure to be retried), the anchor's live phase, and
 * where the report of that dispatch stands. "Reporter pending" is therefore a statement about **this dispatch's**
 * reporter rather than something flattened into `waiting-report`, and a failed preparation is its own fact.
 *
 * Every value is read from the owners the runtime already has, through the reads it already exposes: the child's own
 * conversation record for its native owner edge, that owner's task record for the dispatch identity it was created
 * under, `DispatchDoc` and `ReportDoc` snapshots, and the one `harness.inspect` the catalogue read already shares. There
 * is no second status store, no new durable kind, no `RecoveryBucket`-style whole-child projection and no aggregate
 * child flag: the fields are the runtime's own values under the runtime's own names, absent exactly when the object
 * states nothing, and nothing is derived from a missing transcript entry or from a parent being busy.
 *
 * A branch a user took from a child is deliberately not read as a delegation (spec D14): its own anchor carries no
 * dispatch identity, so this answers `undefined` instead of projecting somebody else's delegation onto it.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskId, TaskInspection } from "@earendil-works/pi-durable";
import type { ChildRecoveryFacts } from "@hepi/protocol";
import { DispatchDoc, ReportDoc, preparationUnretried, type DispatchRecord, type ReportRecord } from "./host.ts";

/**
 * One child's owning delegation, resolved from the durable objects that hold it — never stored alongside them.
 *
 * `delegating` is kept for the **write** the retry performs, which is addressed to the owner's conversation; it is not
 * put on the wire, because the child's own row already states its creator.
 */
type Delegation = {
  readonly delegating: ConversationId;
  readonly dispatchId: string;
  readonly dispatch: DispatchRecord;
  readonly report: ReportRecord | undefined;
  readonly anchorPhase: string | undefined;
  readonly anchorBlocked: boolean;
  readonly anchorInterrupted: boolean;
  readonly reporterLive: boolean;
  readonly reporterPhase: string | undefined;
  readonly reporterBlocked: boolean;
  readonly reporterInterrupted: boolean;
};

/** The conversation a task owns, and that task's identity — the native edge, read from the record and never copied. */
async function ownerOf(harness: Harness, childId: ConversationId): Promise<{ readonly conversationId: ConversationId; readonly taskId: TaskId } | undefined> {
  const record = await harness.commit((tx) => tx.conversation(childId), BACKGROUND_CONTEXT);
  return record?.owner;
}

/** The live task behind one record id, and the three scheduling facts a reader tells apart. */
function taskFacts(tasks: readonly TaskInspection[], taskId: string | undefined) {
  const task = taskId === undefined ? undefined : tasks.find((candidate) => String(candidate.record.id) === taskId);
  return {
    live: task !== undefined,
    phase: (task?.record.state as { checkpoint?: { phase?: string } } | undefined)?.checkpoint?.phase,
    blocked: task?.state.kind === "blocked",
    interrupted: task?.record.abortReason === "restart",
  };
}

/**
 * Resolve one child's owning delegation.
 *
 * The dispatch identity comes from the **anchor's own input**, which is what created the child: a quick create's anchor
 * names the caller's request id, so the identity a reader gets back is the identity the delegation was made under and
 * the one a retry has to carry. A task that has settled is absent from the runtime's inspection, so its phase is stated
 * as absent rather than as a state nobody read.
 */
async function delegationOf(harness: Harness, childConversationId: string): Promise<Delegation | undefined> {
  const numeric = Number(childConversationId);
  if (!Number.isFinite(numeric)) return undefined;
  const childId = numeric as ConversationId;
  const owner = await ownerOf(harness, childId);
  if (owner === undefined) return undefined;
  const anchor = await harness.commit((tx) => tx.task(owner.taskId), BACKGROUND_CONTEXT);
  const dispatchId = (anchor?.input as { dispatchId?: unknown } | undefined)?.dispatchId;
  if (anchor === undefined || typeof dispatchId !== "string") return undefined;
  const dispatch = await harness.snapshot(DispatchDoc, owner.conversationId, dispatchId, BACKGROUND_CONTEXT);
  if (dispatch === undefined) return undefined;
  const report = await harness.snapshot(ReportDoc, owner.conversationId, dispatchId, BACKGROUND_CONTEXT);
  // The one live-work read a catalogue already shares: neither half here is a second scheduler or a per-row request.
  const tasks = (await harness.inspect(BACKGROUND_CONTEXT)).tasks;
  const anchorFacts = taskFacts(tasks, String(owner.taskId));
  const reporterFacts = taskFacts(tasks, dispatch.reporterTaskId);
  return {
    delegating: owner.conversationId,
    dispatchId,
    dispatch,
    report,
    anchorPhase: anchorFacts.phase,
    anchorBlocked: anchorFacts.blocked,
    anchorInterrupted: anchorFacts.interrupted,
    reporterLive: reporterFacts.live,
    reporterPhase: reporterFacts.phase,
    reporterBlocked: reporterFacts.blocked,
    reporterInterrupted: reporterFacts.interrupted,
  };
}

/**
 * The delegation's facts as one projection.
 *
 * `preparation` is the runtime's own `preparationUnretried` predicate — the one the parked anchor waits on, the one a
 * replayed `agent_spawn` acts on and the one `agent_get` reports — named, so no surface re-derives a failure from two
 * ids and no two surfaces can call one delegation failed and another healthy.
 *
 * `delivery` keeps the reporter's own states apart from what its record states once the child settled:
 * `waiting-child` and `delivering` are the live phases, `awaiting-delivery` is a settled child whose report is recorded
 * but not yet admitted, and the three terminal words are the report's own receipt. A reporter nobody can take or one a
 * restart abandoned states the runtime's answer rather than a phase.
 */
export function childRecoveryFacts(delegation: Delegation): ChildRecoveryFacts {
  const { dispatch, report } = delegation;
  const delivery: ChildRecoveryFacts["delivery"] = report?.delivery !== undefined
    ? report.delivery
    : report?.submissionStatus !== undefined
      ? "awaiting-delivery"
      : delegation.reporterBlocked
        ? "blocked"
        : delegation.reporterInterrupted
          ? "interrupted"
          : delegation.reporterLive
            ? delegation.reporterPhase === "deliver" ? "delivering" : "waiting-child"
            : undefined;
  return {
    // One identity, stated once: on this seam the dispatch id **is** the caller's request id (spec D04), and the
    // reader addressed the child it is looking at, so the parent's own conversation id is the row's relation and not a
    // fact this projection has to repeat.
    requestId: delegation.dispatchId,
    ...(dispatch.definitionName === undefined ? {} : { definition: dispatch.definitionName }),
    ...(dispatch.anchorTaskId === undefined ? {} : { anchorTaskId: dispatch.anchorTaskId }),
    ...(dispatch.reporterTaskId === undefined ? {} : { reporterTaskId: dispatch.reporterTaskId }),
    ...(dispatch.preparation === undefined ? {} : { preparationStrategy: dispatch.preparation }),
    ...(preparationUnretried(dispatch)
      ? { preparation: "unretried-failure" as const }
      : dispatch.preparationRetriedTaskId === undefined ? {} : { preparation: "retried" as const }),
    ...(dispatch.preparationFailedTaskId === undefined ? {} : { preparationFailedTaskId: dispatch.preparationFailedTaskId }),
    ...(dispatch.preparationRetriedTaskId === undefined ? {} : { preparationRetriedTaskId: dispatch.preparationRetriedTaskId }),
    ...(dispatch.preparationError === undefined ? {} : { preparationError: dispatch.preparationError }),
    ...(dispatch.preparationOutcome === undefined ? {} : { preparationOutcome: dispatch.preparationOutcome }),
    ...(delegation.anchorBlocked
      ? { anchorPhase: "blocked" as const }
      : delegation.anchorInterrupted
        ? { anchorPhase: "interrupted" as const }
        : delegation.anchorPhase === undefined
          ? {}
          : { anchorPhase: delegation.anchorPhase === "prepare" ? "preparing" as const : delegation.anchorPhase === "admit" ? "admitting" as const : "idle" as const }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(report?.submissionStatus === undefined ? {} : { childSubmissionStatus: report.submissionStatus }),
    ...(report?.answerReason === undefined ? {} : { childSubmissionReason: report.answerReason }),
  };
}

/** One delegated child's recovery facts, or `undefined` when this conversation is no delegation's child. */
export async function childRecovery(harness: Harness, childConversationId: string): Promise<ChildRecoveryFacts | undefined> {
  const delegation = await delegationOf(harness, childConversationId);
  return delegation === undefined ? undefined : childRecoveryFacts(delegation);
}

/** Why one child's preparation cannot be retried, named so a surface states the refusal rather than paraphrasing it. */
export type PreparationRetryRefusal = "not_a_delegation" | "not_failed" | "already_retried";

/**
 * Whether one dispatch's record states a preparation retry to offer, and the failed attempt it names.
 *
 * The rule is the one `delegate()` applies to a replayed request (spec D11, A14), and it is stated here once, over the
 * record itself, so it holds whichever reader asks: a stated failure the caller has not asked about is retryable, asking
 * twice is asking once, and a record that states no failure has nothing to retry.
 */
export function preparationRetryOf(dispatch: DispatchRecord): { readonly ok: true; readonly failedTaskId: string } | { readonly ok: false; readonly code: PreparationRetryRefusal } {
  if (preparationUnretried(dispatch)) {
    return dispatch.preparationFailedTaskId === undefined
      ? { ok: false, code: "not_failed" }
      : { ok: true, failedTaskId: dispatch.preparationFailedTaskId };
  }
  return dispatch.preparationRetriedTaskId === undefined ? { ok: false, code: "not_failed" } : { ok: false, code: "already_retried" };
}

/**
 * The retry the delegation seam **already** supports, resolved for one child: the existing dispatch/request identity
 * plus the failed attempt's own task id — the two values `retryPreparation` takes (the audit's G6).
 *
 * The rule is the one `delegate()` applies to a replayed request (spec D11, A14): a stated failure the caller has not
 * asked about is retryable, asking twice is asking once, and the next attempt's failure is a different id. Nothing here
 * decides that a retry should happen, schedules one, waits on one or aborts anything: it answers whether this child is
 * in that state and names the identities the write uses, so the control cannot mint a fresh dispatch or reach a
 * different attempt than the one the reader was shown.
 */
export async function preparationRetryTarget(
  harness: Harness,
  childConversationId: string,
): Promise<{ readonly ok: true; readonly delegatingConversationId: string; readonly requestId: string; readonly failedTaskId: string } | { readonly ok: false; readonly code: PreparationRetryRefusal; readonly message: string }> {
  const delegation = await delegationOf(harness, childConversationId);
  // Only a conversation this process holds is reachable here — every conversation route refuses an unknown id before
  // its action runs — so the refusal this can state is about the relation, not the id.
  if (delegation === undefined) {
    return { ok: false, code: "not_a_delegation", message: "conversation " + childConversationId + " is owned by no delegation anchor, so it has no preparation to retry" };
  }
  const retry = preparationRetryOf(delegation.dispatch);
  if (!retry.ok) {
    return {
      ok: false,
      code: retry.code,
      message: retry.code === "already_retried"
        ? "the failed preparation of conversation " + childConversationId + " has already been asked to retry"
        : "the preparation of conversation " + childConversationId + " stated no failure waiting for a retry",
    };
  }
  return { ok: true, delegatingConversationId: String(delegation.delegating), requestId: delegation.dispatchId, failedTaskId: retry.failedTaskId };
}
