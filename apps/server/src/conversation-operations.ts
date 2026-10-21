import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  defineDocFamily,
  InboxDoc,
  type AgentChange,
  type Conversation,
  type ConversationControlState,
  type ConversationId,
  type ConversationOwnership,
  type ConversationRecord,
  type EntryId,
  type Harness,
  type InboxControlReceipt,
  type InputEntry,
  type TaskId,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { ControlReceipt, ControlStopSource, ConversationConfig, ConversationInfo, ConversationProvenance, ConversationReference, ConversationRelations, ReferenceOutcome, ResolvedReference } from "@hepi/protocol";
import { submitConversationInput, type ConversationInputDraft } from "./conversation-input.ts";
import { createConversationRead, type ConversationReadRequest, type ConversationReadResult } from "./conversation-read.ts";
import { TombstoneDoc } from "./session-tombstone.ts";
import { createSubtreeControl, type SubtreeControlRequest, type SubtreeControlResult } from "./subtree-control.ts";

/**
 * The durable conversation facts hepi owns, and the one creation seam every conversation-creating surface shares.
 *
 * The runtime's own conversation record already states two immutable edges: the fork source a conversation inherited
 * its history from, and the task that owns it. Neither is `createdBy` (an ordinary conversation can ask for another
 * without owning it), and neither is where a conversation is displayed. So this module keeps one conversation-scoped
 * document for the relations hepi owns — creator, display parent, provenance — and one for the structured references a
 * conversation makes to others, while the native edges are projected from the record and never copied here (spec D03).
 *
 * Creation is one commit that answers a stable request identity: a replay of the same request returns the
 * conversation the first one created instead of a second one, and the relations, binding and agent configuration are
 * all written in that same commit. The caller supplies a parsed configuration and explicit identities; nothing here
 * parses an Agent Definition or interprets a context strategy (spec D01).
 */

/** The conversation's execution binding: the workspace it runs in, as the runtime's own conversation-scoped document. */
export const WorkspaceDoc = defineDoc<{ workspaceId?: string }>({ kind: "hepi.workspace", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}) });

/**
 * The hepi-owned relations of one conversation. `fork: "initial"` is what keeps a fork from inheriting them: a copy is
 * a conversation of its own, so its creator and display parent must be its own facts and not its source's.
 */
export const RelationsDoc = defineDoc<ConversationRelations>({ kind: "hepi.conversation.relations", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });

/**
 * The structured references one conversation makes to other conversations (and optionally to one entry of one). They are
 * the referencing conversation's own state, so a fork starts with none and a reference never changes its target.
 */
export const ReferencesDoc = defineDoc<{ references: ConversationReference[] }>({ kind: "hepi.conversation.references", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ references: [] }) });

/** The fields one input admission needs, whichever seam states them. */
type InputRequest = {
  readonly requestId: string;
  readonly content: UserInput;
  readonly entry?: InputEntry;
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

/**
 * The native input draft one admission writes under the caller's **own** request id. That identity is the public one:
 * `GET /api/conversations/:id/submissions?requestId=` answers it, the submission the client's pending turn is matched
 * by carries it, and the native admission answers a request id it already holds with the existing submission instead
 * of admitting a second one. Deriving a second identity for the same input would leave the caller's own id resolving
 * to nothing exactly when its answer was lost, which is when the recovery read is the only thing that can tell it what
 * happened (spec D08, D10).
 */
function inputDraft(request: InputRequest, triggerTurn?: boolean): ConversationInputDraft {
  return {
    type: "input",
    content: request.content,
    ...(request.entry === undefined ? {} : { entry: request.entry }),
    ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
    requestId: request.requestId,
    ...(triggerTurn === undefined ? {} : { triggerTurn }),
  };
}

/**
 * One control receipt as the wire names it. The runtime's own receipt is already this shape, so the projection is a
 * detached copy and never a second mapping: a receipt a caller keeps cannot be mutated by a later commit's overlay.
 */
function projectReceipt(receipt: InboxControlReceipt): ControlReceipt {
  return copyJson(receipt, { omitUndefinedProperties: true }) as ControlReceipt;
}

/** The session-scoped index that answers a creation request identity: which conversation one stable request already created. */
const SpawnRequestDoc = defineDocFamily<{ conversationId?: string }, null>({ kind: "hepi.conversation.spawn-request", version: 1, scope: "session", family: true, initial: () => ({}) });

/** A conversation id on the wire is its numeric string; the runtime's branded id is the number it names. */
const conversationKey = (value: string): ConversationId => Number(value) as ConversationId;

/**
 * Ownership the caller cannot name in advance: a task created **inside** the creating commit, which is what a child
 * conversation's owner has to be. The creator callback runs after this seam's own reads and before the conversation
 * exists, so the owner task, the child record and the caller's own durable dispatch record are one commit: a crash
 * before it commits leaves nothing, and a crash after it commits leaves a child whose owner is already recorded.
 *
 * A callback that reads tables must read before it writes, exactly as the seam itself does; core never learns what the
 * task means, which is what keeps an optional extension's private task definition out of the core (spec D01, D04).
 */
export type ConversationCreatedOwnership = {
  readonly kind: "created-task";
  /** Create the owning task in this commit; returns the task the new conversation is owned by. */
  readonly create: (tx: Tx) => Promise<TaskId>;
  /** Runs after the conversation record exists in the same commit, for the caller's own durable record of it. */
  readonly created?: (tx: Tx, conversation: ConversationRecord) => Promise<void>;
};

/**
 * A fork source the **host** has already resolved: which conversation the new one inherits its history from, and the
 * entry it starts at. The host decides where a branch point is — a user picking an entry, a configuration strategy
 * naming a position — and core only carries the answer into the one native fork call. Nothing here interprets why that
 * entry was chosen, so one creation seam serves every caller and no second fork path can state a different history
 * (spec D01, D14).
 *
 * The entry is a position in the source conversation's own fork-aware history, so a source entry the source did not
 * inherit from its own parent is not one this seam accepts; the source's membership is what the native fork checks.
 */
export type ConversationSpawnSource = {
  /** The conversation the new one inherits from, by its own id. */
  readonly conversationId: string;
  /** The entry the branch starts at, as an id in that conversation's own history. */
  readonly entryId: string;
};

/** One conversation to create, with every identity already resolved by the caller. */
export type ConversationSpawnRequest = {
  /** Stable caller-generated identity; a replay of the same id answers the conversation the first call created. */
  readonly requestId: string;
  /** Explicit native ownership of the new conversation: independent, task-owned, or owned by a task this commit makes. */
  readonly ownership: ConversationOwnership | ConversationCreatedOwnership;
  /**
   * Inherit history from this source instead of starting empty. Omitted means a new conversation; the same commit
   * writes the owner, the relations and the request identity either way, so a fork and a creation are one contract.
   */
  readonly source?: ConversationSpawnSource;
  /** The parsed effective agent configuration to store; the seam applies it and interprets nothing about it. */
  readonly agent?: AgentChange;
  /** The conversation that created this one: an ordinary relation, independent of native task ownership. */
  readonly createdBy?: string;
  /** The conversation this one is displayed under; omitted means it is a conversation of its own. */
  readonly displayParentId?: string;
  /** The execution workspace to bind atomically with the creation. */
  readonly workspaceId?: string;
  /** Where this conversation's configuration and context came from. */
  readonly provenance?: ConversationProvenance;
};

export type ConversationSpawnResult = { readonly conversation: Conversation; readonly conversationId: string; readonly created: boolean };

/** A refusal a caller names by code instead of matching on a message: unknown identity, an invalid reference, or a cycle. */
export class ConversationOperationRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ConversationOperationRefusal";
    this.code = code;
    this.status = status;
  }
}

/**
 * One trusted stop intent, as the host states it. `stopSource` is the authenticated caller's own origin — the HTTP
 * surface is the user, a model tool is the agent — and it is never read from a request body or a model's own claim
 * (spec D02, D07).
 */
export type ConversationStopRequest = {
  readonly requestId: string;
  readonly stopSource: ControlStopSource;
  /** Reject the request when the committed control revision is not this one; a rejection changes no state. */
  readonly expectedControlRevision?: number;
};

/** The answer of one stop intent: the outcome, whether the ordinary scope is already idle, and the durable receipt. */
export type ConversationStopResult = {
  readonly status: "accepted" | "held" | "rejected";
  readonly reason?: "revision_mismatch";
  /** `idle` means the ordinary scope has no live non-background task left; `stopping` means it still drains. */
  readonly drain: "idle" | "stopping";
  readonly control: ConversationControlState;
  readonly receipt: ControlReceipt;
};

/**
 * One trusted resume intent, optionally admitting the user's immediate input in the same commit. The optional input
 * carries no identity of its own: it is admitted under this request's own id, so one request id names one receipt and
 * one submission and a retry after a lost answer reads both back by it.
 */
export type ConversationContinueRequest = {
  readonly requestId: string;
  readonly caller: ControlStopSource;
  readonly expectedControlRevision?: number;
  readonly input?: { readonly content: UserInput; readonly entry?: InputEntry; readonly whenBusy?: "steer" | "followUp" };
};

/** The answer of one resume intent; `stopping` keeps `held` and every queued input, and the caller retries the same id. */
export type ConversationContinueResult = {
  readonly status: "resumed" | "stopping" | "allowed" | "rejected";
  readonly reason?: "revision_mismatch" | "source_locked" | "superseded" | "caller_mismatch";
  readonly control: ConversationControlState;
  readonly receipt: ControlReceipt;
  /** The submission the optional input was admitted as; absent while the resume is still `stopping`. */
  readonly submissionId?: string;
};

/** One input admission, with the caller already resolved by the host. */
export type ConversationSendRequest = {
  readonly requestId: string;
  readonly caller: ControlStopSource;
  readonly content: UserInput;
  readonly entry?: InputEntry;
  readonly whenBusy?: "steer" | "followUp" | "reject";
  /**
   * `false` is the internal queue-only admission: it enqueues and starts no run, and it never resumes a held
   * conversation, because an enqueue is not a user's dispatch (spec D07).
   */
  readonly triggerTurn?: boolean;
  /**
   * Whether a trusted user's input is their **immediate** dispatch, which is one of the two ways a hold ends. A
   * queue-only input — the composer's steer or follow-up on a conversation that is already running — passes `false`
   * and stays queued under the hold (spec D07).
   */
  readonly resume?: boolean;
};

/** The answer of one input admission: the native submission, the control state it was admitted under, and any receipt. */
export type ConversationSendResult = {
  /** The submission this input was admitted as; absent when a held resume has recorded its intent but not admitted it. */
  readonly submissionId?: string;
  readonly control: ConversationControlState;
  /** The control receipt when this admission resumed a held conversation; absent for an ordinary admission. */
  readonly receipt?: ControlReceipt;
  /** The resume outcome when this admission had to resume; absent for an ordinary admission. */
  readonly status?: "resumed" | "stopping" | "allowed" | "rejected";
  readonly reason?: "revision_mismatch" | "source_locked" | "superseded" | "caller_mismatch";
};

/**
 * One automatic report to deliver into a conversation's own native Inbox, with the caller already resolved by the host.
 * It is deliberately not a send: a report is nobody's dispatch, so it never resumes a held conversation and never
 * carries a caller the recipient's control rules would have to judge. Its identity is stable, so a replay after a lost
 * answer reads the submission the first attempt admitted instead of writing a second one (spec D05, A11, A22).
 */
export type ConversationDeliverRequest = {
  readonly requestId: string;
  readonly content: UserInput;
  readonly entry: InputEntry;
  readonly whenBusy?: "steer" | "followUp";
};

/** The answer of one delivery: the native submission it was admitted as, or the reason it was not written at all. */
export type ConversationDeliverResult = {
  readonly submissionId: string;
  readonly status: "queued" | "placed" | "done" | "unanswered";
};

/** The committed control state of one conversation, and the receipt of one control request when it is asked for. */
export type ConversationControlResult = {
  readonly control: ConversationControlState;
  readonly receipt?: ControlReceipt;
};

export type ConversationOperations = {
  /** Create (or, for a known request id, re-answer) one conversation with its relations and binding in one commit. */
  spawn(request: ConversationSpawnRequest): Promise<ConversationSpawnResult>;
  /** The hepi-owned relations of one conversation; empty when it records none. */
  relations(conversationId: string): Promise<ConversationRelations>;
  /**
   * The structured references one conversation makes, each stated with its named outcome when it cannot be followed
   * now; empty when it makes none. This is the read a surface follows a reference from, so an unresolvable one is
   * reported here rather than being dropped or replaced by a nearest neighbour.
   */
  references(conversationId: string): Promise<readonly ResolvedReference[]>;
  /**
   * Save one structured reference on the referencing conversation, idempotently by target plus entry. The target and
   * the optional entry are validated against the target's visible committed fork-aware history first: a reference that
   * could not be followed is refused by name and nothing is stored.
   */
  addReference(conversationId: string, reference: ConversationReference): Promise<readonly ResolvedReference[]>;
  /** One conversation's relations, projected native edges, references and effective configuration; undefined when unknown. */
  get(conversationId: string): Promise<ConversationInfo | undefined>;
  /** One bounded page of one conversation's raw fork-aware history (spec D13); `agent_read` calls this same entry. */
  read(request: ConversationReadRequest): Promise<ConversationReadResult>;
  /**
   * Hold a conversation: persist the trusted stop source, mark the ordinary live tasks for abort and withdraw the
   * inputs queued at this commit point, in one native transaction. A removed conversation is refused.
   */
  stop(conversationId: string, request: ConversationStopRequest): Promise<ConversationStopResult>;
  /**
   * Resume a held conversation, or answer `allowed` when it is not held. The optional input is admitted in the same
   * commit that clears `held`; while the old stop's ordinary scope still drains the answer is `stopping` and nothing
   * is admitted.
   */
  continue(conversationId: string, request: ConversationContinueRequest): Promise<ConversationContinueResult>;
  /**
   * Admit one input under the conversation's own control rule: an ordinary admission, a queue-only enqueue, or — for a
   * trusted user's dispatch on a held conversation — the resume that clears `held` and admits the input atomically.
   */
  send(conversationId: string, request: ConversationSendRequest): Promise<ConversationSendResult>;
  /** The committed control state, plus the durable receipt of one request when its id is given. */
  control(conversationId: string, requestId?: string): Promise<ConversationControlResult>;
  /**
   * Admit one automatic report into a conversation's native Inbox under its own stable identity. A removed
   * conversation is refused, so a delivery that cannot be written is never silently retried against a target the user
   * has hidden (spec D05, A22).
   */
  deliver(conversationId: string, request: ConversationDeliverRequest): Promise<ConversationDeliverResult>;
  /**
   * Stop or interrupt the **captured** descendant subtree of one conversation, or resume the request that captured it.
   * The parent itself is never held, and nothing about history, relations or tombstones changes: this seam reaches only
   * task and control state, one child at a time, each with its own outcome (spec D01-D05).
   */
  subtreeControl(conversationId: string, request: SubtreeControlRequest): Promise<SubtreeControlResult>;
  /** One subtree request's durable record and current per-child state; undefined when that id captured nothing. */
  subtreeControlRequest(conversationId: string, requestId: string): Promise<SubtreeControlResult | undefined>;
};

/**
 * Read one conversation's hepi-owned relations without attaching it. The catalogue and an attachment seed from this so a
 * by-id read and a list read cannot state two different creators.
 */
export async function readConversationRelations(harness: Harness, conversationId: string): Promise<ConversationRelations> {
  const stored = await harness.snapshot(RelationsDoc, conversationKey(conversationId), BACKGROUND_CONTEXT);
  return stored === undefined ? {} : { ...stored };
}

/** Read one conversation's stored structured references, whichever surface asks, without resolving them. */
export async function readConversationReferences(harness: Harness, conversationId: string): Promise<readonly ConversationReference[]> {
  const stored = await harness.snapshot(ReferencesDoc, conversationKey(conversationId), BACKGROUND_CONTEXT);
  return stored === undefined ? [] : stored.references;
}

/**
 * Why one target or entry is not resolvable, or `undefined` when it is. It is the one place a reference is judged, so
 * creation (which refuses and stores nothing) and the resolving read (which reports and keeps the record) cannot reach
 * two different verdicts about the same reference.
 *
 * The three facts it reads are the owning seams' own, not a second history implementation:
 *
 * - the target conversation **record**, which is what existence is;
 * - the target's **tombstone**, which is what visibility is. A removed conversation keeps its records, so an existence
 *   check alone would let a reference be created to a target no surface shows;
 * - the target's **visible committed fork-aware history**, through the runtime's membership-checked entry scan — the
 *   same fence a read block, a raw page and a navigation window use. An inherited fork entry is in that history; a
 *   sibling branch's entry is not, even though the global entry table holds it.
 *
 * An entry id that is absent from the store is `entry-missing`; one that exists but is not in this target's history is
 * `entry-out-of-scope`. Telling those apart is what makes a wrong-scope request actionable rather than merely refused.
 */
async function unresolvedReference(harness: Harness, reference: ConversationReference): Promise<ReferenceOutcome | undefined> {
  const conversationId = conversationKey(reference.conversationId);
  if (await harness.conversation(conversationId, BACKGROUND_CONTEXT) === undefined) return "target-missing";
  if (await harness.snapshot(TombstoneDoc, conversationId, BACKGROUND_CONTEXT) !== undefined) return "target-unavailable";
  if (reference.entryId === undefined) return undefined;
  const at = Number(reference.entryId) as EntryId;
  const visible = await harness.commit(tx => tx.scanEntries({ conversationId, minEntryId: at, maxEntryId: at }, 1, undefined), BACKGROUND_CONTEXT);
  if (visible.items.length > 0) return undefined;
  const stored = await harness.commit(tx => tx.entry(at), BACKGROUND_CONTEXT);
  return stored === undefined ? "entry-missing" : "entry-out-of-scope";
}

/**
 * The refusal one unresolvable reference is stated as. The code is the outcome's own name, so a caller renders the
 * named state it already knows instead of translating a message; the status is the one the same condition already has
 * elsewhere — a missing thing is 404, and a thing that exists but cannot be used for this request is 409, exactly as a
 * navigation window answers `missing` and `wrong-scope`.
 */
function referenceRefusal(reference: ConversationReference, outcome: ReferenceOutcome): ConversationOperationRefusal {
  const entry = reference.entryId === undefined ? "" : " entry " + reference.entryId;
  switch (outcome) {
    case "target-missing":
      return new ConversationOperationRefusal(outcome, 404, "the referenced conversation does not exist: " + reference.conversationId);
    case "target-unavailable":
      return new ConversationOperationRefusal(outcome, 409, "the referenced conversation was removed: " + reference.conversationId);
    case "entry-missing":
      return new ConversationOperationRefusal(outcome, 404, "entry " + String(reference.entryId) + " does not exist");
    default:
      return new ConversationOperationRefusal(outcome, 409, "entry" + entry + " is not in the committed history of conversation " + reference.conversationId);
  }
}

/**
 * One stored reference as a resolving read answers it: the record itself, plus the named outcome when it cannot be
 * followed now. The record is never rewritten, dropped or repointed — a removal does not cascade into another
 * conversation's state, and a reference's target never changes — so the only thing this read decides is which named
 * outcome to report beside it.
 */
export async function resolveConversationReferences(harness: Harness, conversationId: string): Promise<readonly ResolvedReference[]> {
  const stored = await readConversationReferences(harness, conversationId);
  const resolved: ResolvedReference[] = [];
  for (const reference of stored) {
    const outcome = await unresolvedReference(harness, reference);
    resolved.push(outcome === undefined ? reference : { ...reference, outcome });
  }
  return resolved;
}

/**
 * Reject a hierarchy that would point at the conversation being created, or at a conversation already displayed beneath
 * it. Creation cannot form such a chain today — a new conversation has no descendants — so the guard is the invariant
 * the one relations writer keeps, not a check the ordinary path can fail: a later relations write through this seam
 * inherits it instead of restating the rule.
 */
async function assertHierarchyAcyclic(tx: Tx, conversationId: ConversationId, parentId: ConversationId): Promise<void> {
  const seen = new Set<string>();
  let cursor: ConversationId | undefined = parentId;
  while (cursor !== undefined) {
    if (String(cursor) === String(conversationId)) {
      throw new ConversationOperationRefusal("hierarchy_cycle", 409, "a conversation cannot be displayed beneath itself");
    }
    if (seen.has(String(cursor))) return;
    seen.add(String(cursor));
    const parent: ConversationRelations = await tx.doc(RelationsDoc, cursor);
    cursor = parent.displayParentId === undefined ? undefined : conversationKey(parent.displayParentId);
  }
}

/** Write the hepi-owned relations of one conversation inside an open commit. Absent fields change nothing. */
async function writeRelations(tx: Tx, conversationId: ConversationId, input: ConversationRelations): Promise<void> {
  if (input.createdBy === undefined && input.displayParentId === undefined && input.provenance === undefined) return;
  if (input.displayParentId !== undefined) await assertHierarchyAcyclic(tx, conversationId, conversationKey(input.displayParentId));
  const relations = await tx.doc(RelationsDoc, conversationId);
  if (input.createdBy !== undefined) relations.createdBy = input.createdBy;
  if (input.displayParentId !== undefined) relations.displayParentId = input.displayParentId;
  if (input.provenance !== undefined) relations.provenance = copyJson(input.provenance, { omitUndefinedProperties: true }) as ConversationProvenance;
}

/** The credential-free projection of one conversation's resolved agent configuration. */
function projectConfig(agent: Awaited<ReturnType<Conversation["agent"]>>): ConversationConfig {
  return {
    model: agent.model ?? null,
    thinkingLevel: agent.thinkingLevel,
    extensions: agent.extensions.map((extension) => extension.name),
    tools: agent.tools.map((tool) => tool.name),
    ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
    ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
  };
}

/** Open the creation and relation operations over one harness. */
export function createConversationOperations(harness: Harness): ConversationOperations {
  const relations = (conversationId: string) => readConversationRelations(harness, conversationId);
  const references = (conversationId: string) => resolveConversationReferences(harness, conversationId);
  const read = createConversationRead(harness).read;
  /**
   * The conversation one control or admission request addresses, resolved the way every other by-id operation resolves
   * it: an unknown id is a refusal a caller names by code rather than a thrown lookup.
   */
  const requireConversation = async (conversationId: string): Promise<Conversation> => {
    const conversation = await harness.conversation(conversationKey(conversationId), BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new ConversationOperationRefusal("not_found", 404, "no conversation with id " + conversationId);
    return conversation;
  };
  /**
   * A removed conversation keeps its records but is out of every surface, so a control request on it is refused for the
   * same reason a new turn is: the decision would govern a conversation the user cannot see (spec D09, A22). The
   * tombstone is read before the control commit so the refusal writes nothing.
   */
  const assertNotTombstoned = async (conversationId: string): Promise<void> => {
    const tombstone = await harness.snapshot(TombstoneDoc, conversationKey(conversationId), BACKGROUND_CONTEXT);
    if (tombstone !== undefined) throw new ConversationOperationRefusal("session_deleted", 409, "This session was deleted. Start a new session to continue.");
  };
  /**
   * The subtree seam owns the whole operation — capture, selection validation, per-child outcome — and reads the
   * relations, the attached conversation and the removal rule from this seam, so there is no second graph source and no
   * second control path (spec D02, D03).
   */
  const subtreeControl = createSubtreeControl(harness, {
    relations,
    conversation: async (conversationId) => harness.conversation(conversationKey(conversationId), BACKGROUND_CONTEXT),
    refuseRemoved: assertNotTombstoned,
  });

  return {
    async spawn(request) {
      if (typeof request.requestId !== "string" || request.requestId.trim() === "") {
        throw new ConversationOperationRefusal("invalid_request", 400, "requestId is required");
      }
      const outcome = await harness.commit(async (tx) => {
        // Every table read happens before the first write: inside one transaction a table read after a write throws, so
        // the referenced conversations are confirmed here and the request identity is answered from its document next.
        if (request.createdBy !== undefined && await tx.conversation(conversationKey(request.createdBy)) === undefined) {
          throw new ConversationOperationRefusal("unknown_creator", 400, "createdBy names no conversation: " + request.createdBy);
        }
        if (request.displayParentId !== undefined && await tx.conversation(conversationKey(request.displayParentId)) === undefined) {
          throw new ConversationOperationRefusal("unknown_display_parent", 400, "displayParentId names no conversation: " + request.displayParentId);
        }
        // The fork source is confirmed the same way, and by the same rule every other by-id read uses: the entry has to
        // be visible **from the source conversation**, which is a native bounded range read of exactly that one id.
        // Entry ids are inherited, so an id that belongs to some other conversation is not a branch point here even
        // though the global entry table holds it (spec D13, A16).
        let forkAt: EntryId | undefined;
        if (request.source !== undefined) {
          if (typeof request.source.conversationId !== "string" || request.source.conversationId.trim() === "" || !/^[0-9]+$/.test(request.source.entryId)) {
            throw new ConversationOperationRefusal("invalid_request", 400, "source needs a conversationId and a numeric entryId");
          }
          if (await tx.conversation(conversationKey(request.source.conversationId)) === undefined) {
            throw new ConversationOperationRefusal("unknown_source", 404, "source names no conversation: " + request.source.conversationId);
          }
          const at = Number(request.source.entryId) as EntryId;
          const visible = await tx.scanEntries({ conversationId: conversationKey(request.source.conversationId), minEntryId: at, maxEntryId: at }, 1);
          if (visible.items.length === 0) {
            throw new ConversationOperationRefusal("unknown_source_entry", 404, "entry " + request.source.entryId + " is not in the history of conversation " + request.source.conversationId);
          }
          forkAt = at;
        }
        const answered = await tx.doc(SpawnRequestDoc, request.requestId, null);
        if (answered.conversationId !== undefined) return { conversationId: answered.conversationId, created: false };
        // The owner task is created here, in the one commit that also creates the conversation it owns: every table read
        // this seam makes is already behind it, so the callback's own reads still precede its write.
        const ownership: ConversationOwnership = request.ownership.kind === "created-task"
          ? { kind: "task", taskId: await request.ownership.create(tx) }
          : request.ownership;
        // One creation, two native shapes: a fork copies the source's history and its `asOf` documents — the agent
        // configuration at the fork entry, which is why a user fork starts from the source position's own snapshot —
        // while a plain creation starts empty. The owner task, the relations and the request identity are written the
        // same way after either, so a fork inherits nothing of the relations and nothing of the run state (spec D14).
        const record = forkAt === undefined
          ? await tx.createConversation({ ownership })
          : await tx.forkConversation(conversationKey(request.source!.conversationId), forkAt, { ownership });
        if (request.agent !== undefined) await configure(tx, record.id, request.agent);
        if (request.workspaceId !== undefined) (await tx.doc(WorkspaceDoc, record.id)).workspaceId = request.workspaceId;
        await writeRelations(tx, record.id, {
          ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
          ...(request.displayParentId === undefined ? {} : { displayParentId: request.displayParentId }),
          ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
        });
        if (request.ownership.kind === "created-task" && request.ownership.created !== undefined) await request.ownership.created(tx, record);
        answered.conversationId = String(record.id);
        return { conversationId: String(record.id), created: true };
      }, BACKGROUND_CONTEXT);
      const conversation = await harness.conversation(conversationKey(outcome.conversationId), BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("the conversation that was just created is not readable");
      return { conversation, conversationId: outcome.conversationId, created: outcome.created };
    },

    relations,

    references,

    read,

    async addReference(conversationId, reference) {
      if (typeof reference.conversationId !== "string" || reference.conversationId.trim() === "") {
        throw new ConversationOperationRefusal("invalid_request", 400, "a reference needs a target conversationId");
      }
      // An entry is addressed by the identity the history owner issues, which is a numeric string: a coordinate, an
      // ordinal in another spelling or free text is refused as a malformed request rather than looked up as one.
      if (reference.entryId !== undefined && !/^[0-9]+$/.test(reference.entryId)) {
        throw new ConversationOperationRefusal("invalid_request", 400, "entryId must be the entry id the history owner issues");
      }
      // The target and the optional entry are resolved **before** the write, through the one seam that judges a
      // reference, so a request that cannot be followed is refused by name and this commit stores nothing: a link the
      // user would discover as broken later is not a link this owner keeps (cross-session references, decision 5).
      const outcome = await unresolvedReference(harness, reference);
      if (outcome !== undefined) throw referenceRefusal(reference, outcome);
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ReferencesDoc, conversationKey(conversationId));
        const sameTarget = doc.references.some((candidate) => candidate.conversationId === reference.conversationId && (candidate.entryId ?? "") === (reference.entryId ?? ""));
        if (!sameTarget) doc.references.push(copyJson(reference, { omitUndefinedProperties: true }) as ConversationReference);
      }, BACKGROUND_CONTEXT);
      return references(conversationId);
    },

    async stop(conversationId, request) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      const result = await conversation.stop({
        requestId: request.requestId,
        stopSource: request.stopSource,
        ...(request.expectedControlRevision === undefined ? {} : { expectedControlRevision: request.expectedControlRevision }),
      }, BACKGROUND_CONTEXT);
      return {
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        drain: result.drain,
        control: result.control,
        receipt: projectReceipt(result.receipt),
      };
    },

    async continue(conversationId, request) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      // A request id that already names a submission is not an admission: the input it carried was admitted by an
      // earlier attempt, so the resume is asked for the queue and not for a second copy. Without this the native
      // admission would answer the known id early and run no boundary, leaving the held queue where it was while the
      // control record said the conversation had resumed.
      const admitted = await conversation.commit(tx => tx.submissionByRequest(conversation.id, request.requestId), BACKGROUND_CONTEXT);
      const input = request.input === undefined || admitted !== undefined ? undefined : { ...request.input, requestId: request.requestId };
      const result = await conversation.continue({
        requestId: request.requestId,
        caller: request.caller,
        ...(request.expectedControlRevision === undefined ? {} : { expectedControlRevision: request.expectedControlRevision }),
        ...(input === undefined ? {} : { input }),
      }, BACKGROUND_CONTEXT);
      // The optional input is admitted in the same commit that clears `held`, under this resume's own request id, so
      // the submission is read back by the one identity the caller already knows: a retry that lost the answer reads
      // its own receipt and its own submission, and a resume still `stopping` admitted nothing and reports none
      // (spec D08).
      const submissionId = request.input === undefined
        ? undefined
        : (admitted ?? await conversation.commit(tx => tx.submissionByRequest(conversation.id, request.requestId), BACKGROUND_CONTEXT))?.id;
      return {
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        control: result.control,
        receipt: projectReceipt(result.receipt),
        ...(submissionId === undefined ? {} : { submissionId: String(submissionId) }),
      };
    },

    async send(conversationId, request) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      // A queue-only enqueue is not a dispatch: it never resumes a held conversation, and it is what the framework's
      // own report path and the composer's staged draft both use. It is an admission of its own, so it is decided
      // before any control read.
      if (request.triggerTurn === false) {
        const submissionId = await submitConversationInput(conversation, inputDraft(request, false), BACKGROUND_CONTEXT);
        return { submissionId: String(submissionId), control: await conversation.control(BACKGROUND_CONTEXT) };
      }
      // A dispatch whose own request id already names a submission is answered with it, and with the control receipt
      // when this id also recorded one: the request id names the message, so a retry after a lost answer reads back the
      // submission it made and the resume answer it got, instead of being admitted as a second message. A plain
      // admission that recorded no receipt (an ordinary message on an allowed conversation) answers the submission
      // alone, which is the contract it always had.
      // The receipt is copied **inside** the commit: a document draft cannot be read once its overlay settled, so a
      // value handed out of the commit has to be a detached copy made while the overlay is still live.
      const answered = await conversation.commit(async (tx) => {
        const submission = await tx.submissionByRequest(conversation.id, request.requestId);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const receipt = inbox.control?.receipts.find((candidate: InboxControlReceipt) => candidate.operation === "continue" && candidate.requestId === request.requestId);
        return { submissionId: submission === undefined ? undefined : submission.id, receipt: receipt === undefined ? undefined : projectReceipt(receipt) };
      }, BACKGROUND_CONTEXT);
      if (answered.submissionId !== undefined) {
        return {
          submissionId: String(answered.submissionId),
          control: await conversation.control(BACKGROUND_CONTEXT),
          ...(answered.receipt === undefined ? {} : { status: answered.receipt.status as ConversationSendResult["status"], ...(answered.receipt.reason === undefined ? {} : { reason: answered.receipt.reason }), receipt: answered.receipt }),
        };
      }
      if ((await conversation.control(BACKGROUND_CONTEXT)).state === "allowed") {
        const submissionId = await submitConversationInput(conversation, inputDraft(request), BACKGROUND_CONTEXT);
        return { submissionId: String(submissionId), control: await conversation.control(BACKGROUND_CONTEXT) };
      }
      // Held, and this is a queue-only admission for any caller: the composer's steer or follow-up is a draft, not the
      // user's decision to continue, so it stays queued under the hold.
      if (request.resume === false) {
        const submissionId = await submitConversationInput(conversation, inputDraft(request, false), BACKGROUND_CONTEXT);
        return { submissionId: String(submissionId), control: await conversation.control(BACKGROUND_CONTEXT) };
      }
      // Held, and this is a dispatch: the conversation's own committed control decides who may clear the hold, and the
      // request's **trusted** caller is what the native rule judges. A trusted user's send clears a user stop; an agent's
      // send clears only a stop an agent recorded, because the native rule refuses a user's stop to any other caller with
      // `source_locked`. The model can therefore resume its own stop and can never override the user's (spec D02, D07,
      // A09). The refusal below is the answer, not a queue entry the model could consume later.
      const resumed = await conversation.continue({
        requestId: request.requestId,
        caller: request.caller,
        // The input is admitted under the send's own request id, so the submission this dispatch makes is the one
        // `GET /:id/submissions?requestId=` answers and a retry reads back instead of making a second copy.
        input: {
          content: request.content,
          ...(request.entry === undefined ? {} : { entry: request.entry }),
          ...(request.whenBusy === "steer" || request.whenBusy === "followUp" ? { whenBusy: request.whenBusy } : {}),
          requestId: request.requestId,
        },
      }, BACKGROUND_CONTEXT);
      if (resumed.status === "rejected") {
        // The refusal names the user's own stop when that is what decided it, because that is the answer the model has
        // to read: the hold is the user's and the model cannot clear it (spec D07, A09).
        const reason = resumed.reason ?? "source_locked";
        throw new ConversationOperationRefusal(
          reason,
          409,
          reason === "source_locked"
            ? "this conversation is held by a user stop; a user's stop is only cleared by the user"
            : "the resume was refused: " + reason,
        );
      }
      // `allowed` means the hold was already gone when this commit ran — a concurrent explicit continue ended it
      // between the read above and here — so that commit admitted no input of ours and this dispatch still owes the
      // message. Admitting it now is what keeps a two-tab continue and send from dropping the send.
      if (resumed.status === "allowed") {
        const submissionId = await submitConversationInput(conversation, inputDraft(request), BACKGROUND_CONTEXT);
        return { control: resumed.control, status: resumed.status, receipt: projectReceipt(resumed.receipt), submissionId: String(submissionId) };
      }
      // While the old stop's ordinary scope still drains the runtime records the intent and admits nothing, so the
      // answer is `stopping` with the hold and every queued input intact, and the caller retries the same request id:
      // the text is never admitted twice and never silently dropped (spec D08). A resume that did run admitted the
      // input under this same id, so it reads back as the submission the caller's own request id already names.
      const submission = resumed.status === "resumed" ? await conversation.commit(tx => tx.submissionByRequest(conversation.id, request.requestId), BACKGROUND_CONTEXT) : undefined;
      return { control: resumed.control, status: resumed.status, receipt: projectReceipt(resumed.receipt), ...(submission === undefined ? {} : { submissionId: String(submission.id) }) };
    },

    async control(conversationId, requestId) {
      const conversation = await requireConversation(conversationId);
      const control = await conversation.control(BACKGROUND_CONTEXT);
      if (requestId === undefined) return { control };
      // One receipt is one durable answer to one request id; the record holds both operations, so a caller that lost
      // the response reads back what really happened instead of asking the operation to happen again.
      // The receipt is copied **inside** the commit: a document draft is not readable once its overlay settled, so a
      // value handed out of the commit has to be a detached copy made while the overlay is still live.
      const receipt = await conversation.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const stored = inbox.control?.receipts.find((candidate: InboxControlReceipt) => candidate.requestId === requestId);
        return stored === undefined ? undefined : projectReceipt(stored);
      }, BACKGROUND_CONTEXT);
      return { control, ...(receipt === undefined ? {} : { receipt }) };
    },

    async deliver(conversationId, request) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      // A report is admitted through the runtime's own admission and nothing else, so the recipient's committed state
      // decides the outcome: allowed and idle places the entry and starts a run, running queues it at the next
      // boundary, and held queues it and starts nothing. No hold is cleared here — an automatic report is not a user's
      // decision to continue (spec D05, D07).
      const submission = await conversation.submit({
        type: "input",
        content: request.content,
        entry: request.entry,
        ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
        requestId: request.requestId,
      }, BACKGROUND_CONTEXT);
      // The status is read back so a reporter records what really happened, and so a replay answers the record the
      // first attempt made — including one a user already cancelled, which this read reports and never revives.
      const record = await submission.status(BACKGROUND_CONTEXT);
      return { submissionId: String(submission.id), status: record.status };
    },

    async subtreeControl(conversationId, request) {
      return subtreeControl.subtreeControl(conversationId, request);
    },

    async subtreeControlRequest(conversationId, requestId) {
      if (typeof requestId !== "string" || requestId.trim() === "") {
        throw new ConversationOperationRefusal("invalid_request", 400, "requestId is required");
      }
      return subtreeControl.subtreeControlRequest(conversationId, requestId);
    },

    async get(conversationId) {
      const record = await harness.commit((tx) => tx.conversation(conversationKey(conversationId)), BACKGROUND_CONTEXT);
      if (record === undefined) return undefined;
      const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
      if (conversation === undefined) return undefined;
      const stored = await relations(conversationId);
      const displayParentId = stored.displayParentId;
      const displayParentDeleted = displayParentId === undefined
        ? false
        : await harness.snapshot(TombstoneDoc, conversationKey(displayParentId), BACKGROUND_CONTEXT) !== undefined;
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      return {
        conversationId,
        relations: stored,
        ...(record.parent === undefined ? {} : { forkSource: { conversationId: String(record.parent.conversationId), at: String(record.parent.at) } }),
        ...(record.owner === undefined ? {} : { owner: { conversationId: String(record.owner.conversationId), taskId: String(record.owner.taskId) } }),
        references: await references(conversationId),
        config: projectConfig(agent),
        displayParentDeleted,
      };
    },
  };
}
