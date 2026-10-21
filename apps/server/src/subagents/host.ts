/**
 * The host port the optional subagent extension is composed with, and the one durable record the extension owns.
 *
 * The extension is optional: a deployment that never installs it loses only the `agent_*` tools, and the ordinary
 * conversation API is unchanged. What it may use is exactly this port — the core creation seam, the core by-id and read
 * seams, the catalogue projection, the Execution Host's agent definitions and the host's own limits — so the core never
 * learns that a background anchor task or a dispatch record exists (spec D01, D15).
 *
 * The dispatch record is the extension's own durable statement of one delegation: which child conversation one stable
 * caller request created, which anchor task owns it, and the task text the anchor admits. It is written in the **same
 * commit** that creates the child, so a crash cannot leave a child whose dispatch identity is unknown, and a replay of
 * the same caller request answers the child that already exists instead of creating a second one (spec D04, A19).
 */

import { defineDocFamily, type AgentChange, type ConversationControlState, type Extension, type InputEntry, type ModelRef, type UserInput } from "@earendil-works/pi-durable";
import type { ControlReceipt, ConversationInfo } from "@hepi/protocol";
import type { AgentDefinitionEffectiveConfiguration } from "../agent-definitions.ts";
import type { AgentDefinitionSource } from "../agent-definitions-store.ts";
import type { ConversationSendRequest, ConversationSpawnRequest, ConversationSpawnResult, ConversationSpawnSource, ConversationStopRequest } from "../conversation-operations.ts";
import type { ConversationReadRequest, ConversationReadResult } from "../conversation-read.ts";

/** The extension's registered name. A conversation selects it by this name, exactly like any other extension. */
export const SUBAGENT_EXTENSION = "hepi-subagents";

/** The anchor task's registered kind. It is the native owner of a child conversation. */
export const SUBAGENT_ANCHOR_TASK = "hepi.subagent-anchor";

/** The reporter task's registered kind: the recoverable phase that waits a child out and delivers its result. */
export const SUBAGENT_REPORTER_TASK = "hepi.subagent-reporter";

/**
 * The entry kind one delivered report is placed as. It is the application kind spec D05 names, so a report is a
 * structured fact in the recipient's own transcript rather than a user message: the recipient's model reads the same
 * user-shaped message, while every surface that shows why a turn started reads the kind and the data beside it.
 */
export const AGENT_REPORT_ENTRY_KIND = "hepi.agent-report";

/**
 * The limits the host states for delegation, checked before anything is created so an over-limit request refuses
 * instead of queueing hidden work (spec D12). `maxDepth` counts display parents, so `1` means a conversation of its
 * own may delegate and a child may not; the child also does not select this extension, which is the default "a child
 * does not spawn" rule.
 */
export type SubagentLimits = { readonly maxDepth: number; readonly maxConcurrentChildren: number };

/**
 * One delegation, as the extension records it on the conversation that delegated. Every field is an identity or the
 * durable intent, never a copy of the child's state: the configuration lives in the child's own `pi.agent` snapshot and
 * the answer lives in the child's own transcript.
 */
export type DispatchRecord = {
  version: number;
  /** The dispatch's own identity, stable across a retry of the same caller request. */
  dispatchId?: string;
  /** The caller's own request identity this dispatch answers. */
  requestId?: string;
  /** The task text the anchor admits; it is the delegation's durable intent. */
  task?: string;
  /** The child conversation this dispatch created. */
  childConversationId?: string;
  /** The anchor task that owns the child. */
  anchorTaskId?: string;
  /** The reporter task that waits this dispatch out and delivers its result. Created once, in the anchor's admit commit. */
  reporterTaskId?: string;
  /** The stable native request id of the initial submission, so a retry admits it once. */
  submissionRequestId?: string;
  /** The native submission that carried the task text, once the anchor admitted it. */
  submissionId?: string;
  /** The agent definition the child was configured from. */
  definitionName?: string;
  /** The preparation strategy the definition asked for, once the child exists: `fork` or `compact` only. */
  preparation?: "fork" | "compact";
  /**
   * The preparation task whose failure is currently stated. A child whose context could not be prepared is **not**
   * silently run as a fresh one: this id and the reason below are the durable statement of that failure, written by the
   * anchor's own commit, and they are what `agent_get` and the reporting path read instead of a second failure store
   * (spec D11, A14). It is an identity, not a count, so writing it again after a restart states the same failure once.
   */
  preparationFailedTaskId?: string;
  /**
   * The preparation task whose failure the caller asked to retry. Preparation is retryable **under the same dispatch
   * identity**: a replay of the caller's own request names the failed task here, the anchor wakes on the record it is
   * watching and prepares again, and neither a second child nor a second admission is created. Naming a value twice is
   * the same as naming it once, so a replay that is itself replayed cannot ask for two retries of one failure, and the
   * next attempt's own failure is a different id — which is what makes it a new, retryable failure again.
   */
  preparationRetriedTaskId?: string;
  /** Why that preparation attempt failed. It is the reason of a **past** attempt, so a retried delegation keeps it as history. */
  preparationError?: string;
  /** The native outcome that attempt reached: `failed`, `faulted`, `aborted`, or `completed` with no summary. */
  preparationOutcome?: string;
  createdAt?: number;
};

/** The retry state of one delegation: which preparation failed, and which failure the caller asked to retry. */
export type PreparationFailureState = {
  readonly preparationFailedTaskId?: string;
  readonly preparationRetriedTaskId?: string;
};

/**
 * Whether the stated preparation failure is still waiting for the caller's retry. This is the one predicate the anchor
 * parks on, `agent_spawn` retries and `agent_get` reports, so a delegation cannot be described as failed by one surface
 * while another considers it healthy — and no surface has to re-derive it from a count.
 */
export function preparationUnretried(record: PreparationFailureState): boolean {
  return record.preparationFailedTaskId !== undefined && record.preparationFailedTaskId !== record.preparationRetriedTaskId;
}

/** The durable identity of one delegation a stable caller request already created. */
export type ExistingDispatch = PreparationFailureState & {
  readonly dispatchId: string;
  readonly childConversationId: string;
  readonly definitionName?: string;
};

/** One delegation of one delegating conversation, keyed by the stable caller request identity. A fork starts with none. */
export const DispatchDoc = defineDocFamily<DispatchRecord, null>({ kind: "hepi.subagent.dispatch", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (): DispatchRecord => ({ version: 1 }) });

/**
 * One automatic report to deliver into a recipient's own native Inbox, as the reporter states it. It carries the
 * stable report identity, the text the recipient's model reads, and the structured entry that names the source, so the
 * recipient's own admission rule — and only that rule — decides what happens next: an allowed idle conversation
 * starts a run, a running one queues at its next boundary, and a held one queues and starts nothing (spec D05).
 */
export type SubagentDeliverRequest = {
  /** The conversation the report is delivered into: the delegating conversation of the dispatch. */
  readonly recipientConversationId: string;
  /** The report's own stable identity, derived from the dispatch, so a replay answers the same submission. */
  readonly requestId: string;
  readonly content: UserInput;
  readonly entry: InputEntry;
  readonly whenBusy?: "steer" | "followUp";
};

/**
 * The answer of one delivery attempt. A removed recipient is terminal: the report is not written and never retried,
 * and the reporter keeps the child's own result as its receipt (spec D05, A22).
 */
export type SubagentDeliverAnswer =
  | { readonly ok: true; readonly submissionId: string; readonly status: string }
  | { readonly ok: false; readonly code: "recipient_deleted" | "not_found"; readonly message: string };

/**
 * The answer of one agent dispatch to an existing conversation.
 *
 * A refusal is the answer, never a queue entry: the target's own committed control is what decided it, so a user's
 * stop refuses the dispatch outright instead of leaving text the child could consume later, and no dispatch record is
 * written for it (spec D02, D07, A09).
 */
export type SubagentSendAnswer =
  | { readonly ok: true; readonly control: ConversationControlState; readonly submissionId?: string; readonly status?: "resumed" | "stopping" | "allowed" | "rejected"; readonly receipt?: ControlReceipt }
  | { readonly ok: false; readonly code: "user_stopped" | "recipient_deleted" | "not_found"; readonly message: string };

/** The answer of one agent stop, through the same atomic control a user's stop uses. */
export type SubagentStopAnswer =
  | { readonly ok: true; readonly status: "accepted" | "held" | "rejected"; readonly reason?: "revision_mismatch"; readonly drain: "idle" | "stopping"; readonly control: ConversationControlState; readonly receipt: ControlReceipt }
  | { readonly ok: false; readonly code: "recipient_deleted" | "not_found"; readonly message: string };

/**
 * The extension's own durable record of one automatic report, keyed by the dispatch it reports. It is what makes the
 * delivery recoverable and what preserves the source result when the recipient is gone: the wait phase writes the
 * terminal status and the answer reference, and the deliver phase writes the delivery outcome. A fork starts with
 * none, because a fork is a session of its own and its dispatches are its own (spec D05, A19, A22).
 */
/**
 * The bounded preview one delivered report states about its own cut: how much of the child's answer travelled, how much
 * was left out, and the fixed budget it was cut to. It travels inside the report entry's own data, so a surface that
 * only sees the queued item can state the truncation and name the source without re-reading the child.
 */
export type ReportPreview = {
  readonly bytes: number;
  readonly droppedBytes: number;
  readonly droppedLines: number;
  readonly sourceTruncated: boolean;
  readonly maxBytes: number;
  readonly maxLines: number;
};

export type ReportRecord = {
  version: number;
  /** The dispatch this report belongs to; also the document's key. */
  dispatchId?: string;
  /** The child conversation whose submission this report states. */
  childConversationId?: string;
  /** The child submission that settled, and the terminal status it settled as. */
  submissionId?: string;
  submissionStatus?: "done" | "unanswered";
  /** The answer entry a `done` settlement named; the source reference a reader resolves through the core read. */
  answerEntryId?: string;
  /** The reason an `unanswered` settlement stated, such as `aborted`. */
  answerReason?: string;
  /** When the child submission settled, as the reporter's own clock stated it. */
  settledAt?: number;
  /** The submission the report was admitted as in the recipient; the identity a replay answers. */
  deliveredSubmissionId?: string;
  /** How the delivery ended: written, or terminal because the recipient was gone. */
  delivery?: "delivered" | "recipient_deleted" | "recipient_missing";
  deliveredAt?: number;
};

/** One report per dispatch, on the delegating conversation. A fork starts with none. */
export const ReportDoc = defineDocFamily<ReportRecord, null>({ kind: "hepi.subagent.report", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (): ReportRecord => ({ version: 1 }) });

/** One definition the host resolved on the Execution Host the delegating conversation runs on. */
export type ResolvedSubagentDefinition = {
  readonly name: string;
  readonly description: string;
  readonly effective: AgentDefinitionEffectiveConfiguration;
  readonly source: AgentDefinitionSource;
};

/** The answer of one definition lookup. A refusal names its reason so the tool refuses with the host's own code. */
export type SubagentDefinitionAnswer =
  | { readonly ok: true; readonly definition: ResolvedSubagentDefinition }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The relation filters and page one listing read accepts; the same fields the catalogue route filters on. */
export type SubagentListRequest = {
  readonly createdBy?: string;
  readonly displayParentId?: string;
  readonly ownerConversationId?: string;
  readonly workspaceId?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

/** One conversation as a listing states it: the relation edges and whether a run is in flight. */
export type SubagentConversationRow = {
  readonly conversationId: string;
  readonly createdBy?: string;
  readonly displayParentId?: string;
  readonly displayParentDeleted?: boolean;
  readonly ownerConversationId?: string;
  readonly workspaceId?: string;
  readonly title?: string;
  readonly busy: boolean;
};

export type SubagentListAnswer =
  | { readonly ok: true; readonly conversations: readonly SubagentConversationRow[]; readonly nextCursor?: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Everything the extension is allowed to reach. The host is built from the same objects the HTTP surfaces use — the one
 * creation seam, the one read seam and the one catalogue projection — so a model tool and a browser request cannot
 * disagree about a conversation's identity or its history.
 */
export type SubagentHost = {
  /** The one creation seam, with the ownership variant that creates the anchor task in the same commit. */
  spawn(request: ConversationSpawnRequest): Promise<ConversationSpawnResult>;
  /**
   * One atomic commit on the harness. It is the seam a caller with no commit of its own uses — the Web's delegation
   * route — so a browser dispatch writes its dispatch record and its reporter in the same kind of commit a model tool
   * writes them in, and neither is a second writer.
   */
  commit<T>(change: (tx: import("@earendil-works/pi-durable").Tx) => T | Promise<T>): Promise<T>;
  /** One conversation's relations, projected native edges, references and credential-free configuration. */
  get(conversationId: string): Promise<ConversationInfo | undefined>;
  /** The core bounded raw read; `agent_read` adds nothing to it and never re-implements membership. */
  read(request: ConversationReadRequest): Promise<ConversationReadResult>;
  /**
   * Admit one automatic report into a recipient's own native Inbox under the report's stable identity. The core seam
   * applies the recipient's own admission rule and refuses a removed conversation, so a report wakes an idle
   * recipient, queues on a running or held one, and terminates on a removed one.
   */
  deliver(request: SubagentDeliverRequest): Promise<SubagentDeliverAnswer>;
  /**
   * Admit one input into an existing conversation under the caller's own **trusted** identity, applying that
   * conversation's own control rule. It is how `agent_send` gives a child another task: the target is a conversation
   * of its own, so its committed control decides — a user's stop refuses the dispatch outright, a hold this agent
   * recorded is resumed by this agent's explicit intent, and a running child queues the task at its next boundary
   * (spec D02, D07, A09).
   */
  send(conversationId: string, request: ConversationSendRequest): Promise<SubagentSendAnswer>;
  /**
   * Hold one conversation under a trusted stop source, through the same atomic control a user's stop uses. An agent
   * stop never downgrades a user stop, and a user stop is only cleared by the user (spec D02, D07).
   */
  stop(conversationId: string, request: ConversationStopRequest): Promise<SubagentStopAnswer>;
  /** The catalogue projection, filtered and paged by the same relation fields the HTTP route uses. */
  list(request: SubagentListRequest): Promise<SubagentListAnswer>;
  /** The execution workspace one conversation is bound to; the child inherits exactly this binding. */
  workspace(conversationId: string): Promise<string | undefined>;
  /**
   * The position a `fork` or `compact` preparation starts from: the delegating conversation itself, at its newest
   * visible entry, resolved **now** and carried into the creating commit. A definition decides *that* preparation
   * happens; the host decides *where*, once, so a message appended afterwards cannot move the branch point
   * (spec D11, A13).
   */
  sourcePosition(conversationId: string): Promise<ConversationSpawnSource | undefined>;
  /**
   * The delegations of one conversation that are still work, which is what the concurrency limit bounds: a child whose
   * anchor has not admitted its initial input yet, or whose own conversation has live work. A finished delegation is
   * not counted — its conversation and its permanent anchor stay for the life of the child (spec D12).
   */
  activeChildren(conversationId: string): Promise<number>;
  /**
   * The delegation one stable caller request identity already created on this conversation, if any. A replay of that
   * request is answered with the child the first attempt created, so a recovery never has to re-satisfy the
   * preconditions a fresh creation checks (spec D04, A19).
   */
  existingDispatch(conversationId: string, requestId: string): Promise<ExistingDispatch | undefined>;
  /**
   * One delegation's own durable record, for a caller asking what a dispatch is doing. It is the extension's own
   * document, not a copy of the child's state: the answer states the preparation the definition asked for and, when
   * preparation failed, the reason it failed (spec D11, A14).
   */
  dispatch(conversationId: string, requestId: string): Promise<DispatchRecord | undefined>;
  /**
   * Ask a delegation whose preparation failed to prepare again, under the **same** dispatch identity. The write names
   * the failed attempt's own task, so the anchor parked on that failure wakes and prepares once more; nothing else about
   * the delegation changes, and asking twice is asking once (spec D11, A14).
   */
  retryPreparation(conversationId: string, requestId: string, failedTaskId: string): Promise<void>;
  /**
   * Resolve the model a definition names, in the deployment's own catalog. `null` is the definition naming no model,
   * which the caller answers with the deployment default; an unknown reference is a refusal at spawn rather than a
   * child that fails its first request natively.
   */
  resolveModel(text: string): { readonly ok: true; readonly model: ModelRef | null } | { readonly ok: false; readonly code: string; readonly message: string };
  /** The thinking level a definition names, or undefined when this runtime has no such level. */
  resolveThinkingLevel(text: string): AgentChange["thinkingLevel"] | undefined;
  /**
   * Resolve one agent definition on the Execution Host the delegating conversation runs on. An unreachable host is a
   * refusal, never a fallback to another machine (spec D10).
   */
  resolveDefinition(request: { readonly workspaceId: string | undefined; readonly name: string }): Promise<SubagentDefinitionAnswer>;
  /**
   * The extensions a child of this workspace selects: the host's own materialized selection, without this extension, so
   * a child really has the tools its definition names and does not delegate in turn by default (spec D11, D12).
   */
  childExtensions(workspaceId: string | undefined): Promise<readonly Extension[]>;
  /** The deployment's default model and thinking level, used when a definition names none. */
  readonly defaultModel: ModelRef | undefined;
  readonly defaultThinkingLevel: NonNullable<AgentChange["thinkingLevel"]> | undefined;
  readonly limits: SubagentLimits;
};
