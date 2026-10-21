/**
 * Explicit stop or interrupt over one conversation's **captured** descendant subtree.
 *
 * A parent's own stop stays local: it holds that conversation and nothing beneath it (spec decision 1). Stopping a
 * subtree is therefore a separate, explicit action, and this module is its one seam. It answers four questions the
 * rest of the system must not answer differently:
 *
 * - **Which conversations are in scope?** The set is computed from the durable display relation (`displayParentId`)
 *   the creation seam writes, walked transitively from the addressed conversation. It is deliberately not read from the
 *   catalogue: a surface's listing is a projection that can be stale, hidden or filtered, and a control decision must
 *   not depend on what one client happened to have loaded (spec decision 2). A removed (tombstoned) conversation keeps
 *   its relations, so a child under a hidden parent is still in scope (spec acceptance 1).
 * - **Which set does one request govern?** The first request under a request id captures the descendant ids and stores
 *   them on the addressed conversation. A replay is answered from that stored set, so a child created afterwards is
 *   never implicitly included and never silently stopped by a retry (spec decision 3). A selective request names a
 *   subset of that same captured set, and an id outside it refuses the whole request before anything is written.
 * - **What did each child answer?** Every child gets its own durable outcome and its own current control state. One
 *   child's refusal, removal or already-settled state never turns into a blanket answer for the rest, so a partial
 *   result is visible instead of being flattened (spec decision 4).
 * - **What does the operation change?** Only task and control state, through the runtime's own `stop` and `abort`
 *   contracts. Nothing here appends an entry, rewrites a relation, cascades a tombstone, or claims an external side
 *   effect was rolled back (spec decision 5).
 *
 * The request record is written before the first child is touched and each child's outcome is committed as it settles,
 * so a process that dies mid-way leaves a resumable request: the replay re-reads the captured set and continues with
 * the children that have no recorded outcome yet. Each child's own control call is idempotent under the request id, so
 * resuming cannot stop or interrupt a child twice (spec acceptance 5).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type Conversation, type ConversationControlState, type ConversationId, type Cursor, type Harness, type TaskInspection } from "@earendil-works/pi-durable";
import type { ControlStopSource, ConversationRelations } from "@hepi/protocol";

/** The two explicit actions. There is no hidden escalation from one to the other (spec open detail 1). */
export type SubtreeControlAction = "stop" | "interrupt";

/**
 * One child's outcome. The vocabulary is the user's: `accepted` and `stopping` mean this request reached live work,
 * `already-settled` means there was none, `held` means the child was already held before this request (so the record
 * only advanced its revision), `refused`, `not-found` and `conflict` name the three ways a child cannot be controlled
 * at all, and `pending` is a child of a request that has not reached it yet — the state a resumable request reports.
 */
export type SubtreeChildStatus = "accepted" | "already-settled" | "stopping" | "held" | "refused" | "not-found" | "conflict" | "pending";

/** One child of one request: its durable outcome and the control state it holds now. */
export type SubtreeChildOutcome = {
  readonly conversationId: string;
  readonly status: SubtreeChildStatus;
  /** The runtime's own reason for a refusal, or the refusal code for a conflict. */
  readonly reason?: string;
  readonly control: ConversationControlState;
};

/** The answer of one subtree request: what it governs, what each child said, and whether the set is fully settled. */
export type SubtreeControlResult = {
  readonly requestId: string;
  readonly action: SubtreeControlAction;
  /** `pending` means some child has no recorded outcome yet — the state a replay resumes from. */
  readonly status: "completed" | "pending";
  /** The captured descendant ids this request governs, in discovery order. */
  readonly scope: readonly string[];
  /** The selected subset, or `null` when the request governs the whole captured scope. */
  readonly selected: readonly string[] | null;
  readonly outcomes: readonly SubtreeChildOutcome[];
  /** True when at least one child did not end up simply stopped or already settled. */
  readonly partial: boolean;
};

/** One subtree request, as the host states it. `stopSource` is the trusted caller's own origin, never a body field. */
export type SubtreeControlRequest = {
  readonly requestId: string;
  readonly action: SubtreeControlAction;
  readonly stopSource: ControlStopSource;
  /** A subset of the captured scope; omitted means every captured descendant. */
  readonly selected?: readonly string[];
};

/** One child's committed outcome, as the request record keeps it. */
export type SubtreeOutcomeRecord = {
  status: string;
  reason?: string;
  at: number;
};

/**
 * The durable record of one subtree request, on the conversation it was addressed to. `fork: "initial"` keeps a fork
 * from inheriting another conversation's control requests: they are that conversation's own history of decisions.
 */
export type SubtreeControlRecord = {
  version: number;
  requestId?: string;
  action?: SubtreeControlAction;
  stopSource?: ControlStopSource;
  /** The captured descendant set, fixed by the first request and never widened. */
  scope?: string[];
  /** The selected subset of that set, or absent when the whole scope was requested. */
  selected?: string[];
  /** Per-child outcomes, keyed by conversation id. */
  outcomes?: Record<string, SubtreeOutcomeRecord>;
  /** When every child of the captured set had an outcome. */
  settledAt?: number;
};

/** One subtree request per conversation, keyed by the caller's stable request identity. */
export const SubtreeControlDoc = defineDocFamily<SubtreeControlRecord, null>({
  kind: "hepi.subtree.control",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: (): SubtreeControlRecord => ({ version: 1 }),
});

/** A conversation id on the wire is its numeric string; the runtime's branded id is the number it names. */
const conversationKey = (value: string): ConversationId => Number(value) as ConversationId;

/** What this operation needs from the conversation seam it belongs to, so it reads relations one way only. */
export type SubtreeControlPort = {
  /** One conversation's hepi-owned relations, read through the seam's own reader. */
  readonly relations: (conversationId: string) => Promise<ConversationRelations>;
  /** One attached conversation, or undefined when the id names none. */
  readonly conversation: (conversationId: string) => Promise<Conversation | undefined>;
  /** Refuse a removed conversation the way every other control write refuses it. */
  readonly refuseRemoved: (conversationId: string) => Promise<void>;
};

/** The statuses that mean a child ended up controlled, which is what makes a request non-partial. */
const CONTROLLED: ReadonlySet<SubtreeChildStatus> = new Set(["accepted", "already-settled", "stopping", "held"]);

/** Whether a live task belongs to a conversation's own ordinary scope, which is what these actions reach. */
function ordinary(task: TaskInspection): boolean {
  return !task.record.background;
}

/**
 * The transitive descendants of one conversation, from the durable display relation. The walk crosses a tombstoned
 * conversation rather than stopping at it, because a hidden middle conversation is still a parent (spec acceptance 1),
 * and it is bounded by the set of ids it has already visited so a malformed cycle cannot hang a request.
 */
async function collectScope(harness: Harness, port: SubtreeControlPort, rootId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 200, cursor), BACKGROUND_CONTEXT);
    for (const record of page.items) ids.push(String(record.id));
    cursor = page.next;
  } while (cursor !== undefined);
  const children = new Map<string, string[]>();
  for (const id of ids) {
    if (id === rootId) continue;
    const parent = (await port.relations(id)).displayParentId;
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [id]);
    else siblings.push(id);
  }
  // Breadth-first from the addressed conversation, so the captured order is deterministic: the scan is ascending by id
  // and each level is appended in that order, which is what makes a replay's stored scope comparable with a fresh walk.
  const scope: string[] = [];
  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      scope.push(child);
      queue.push(child);
    }
  }
  return scope;
}

/** The conversations with live ordinary work, from the one inspection read a whole request shares. */
async function liveConversations(harness: Harness): Promise<ReadonlySet<string>> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return new Set(inspection.tasks.filter(ordinary).map((task) => String(task.record.conversationId)));
}

/** One child's current committed control state; a child that has none yet reads as the runtime's own default. */
async function currentControl(port: SubtreeControlPort, conversationId: string): Promise<ConversationControlState> {
  const conversation = await port.conversation(conversationId);
  if (conversation === undefined) return { state: "allowed", revision: 0 };
  return await conversation.control(BACKGROUND_CONTEXT);
}

/**
 * Control one captured child through the runtime's own contract. A child that refuses or cannot be controlled answers
 * its own outcome instead of failing the whole request: a removed child is a conflict because its removal already
 * holds it, and a refusal is the runtime's own reason.
 */
async function controlChild(
  port: SubtreeControlPort,
  action: SubtreeControlAction,
  conversationId: string,
  requestId: string,
  stopSource: ControlStopSource,
  live: ReadonlySet<string>,
): Promise<{ status: SubtreeChildStatus; reason?: string }> {
  const conversation = await port.conversation(conversationId);
  if (conversation === undefined) return { status: "not-found" };
  try {
    // The removal is the conversation's last word on admission, so a subtree request cannot govern a conversation the
    // user has already hidden. It is reported as this child's own conflict and not as a failure of the others.
    await port.refuseRemoved(conversationId);
    if (action === "interrupt") {
      // The native abort: withdraw the queued inputs, mark the ordinary scope and wait for it. It sets no hold, so a
      // child that was allowed stays allowed — an interrupt is not a stop (spec open detail 1).
      await conversation.abort(BACKGROUND_CONTEXT);
      return { status: live.has(conversationId) ? "accepted" : "already-settled" };
    }
    const stopped = await conversation.stop({ requestId, stopSource }, BACKGROUND_CONTEXT);
    if (stopped.status === "rejected") return { status: "refused", reason: stopped.reason ?? "rejected" };
    // A child that was already held was not reached by this request's abort marks: its record advanced by one revision
    // and nothing else about it changed, which is what `held` says rather than `accepted`.
    if (stopped.status === "held") return { status: "held" };
    // A newly held child with live ordinary work is still draining; one with none took the hold at once.
    return { status: stopped.drain === "stopping" ? "stopping" : "accepted" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return { status: "conflict", reason: code };
    throw error;
  }
}

/** The refusal one request states, in the shape the HTTP surface already answers control refusals with. */
export class SubtreeControlRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SubtreeControlRefusal";
    this.code = code;
    this.status = status;
  }
}

/** Open the subtree operation over one harness and the conversation seam it belongs to. */
export function createSubtreeControl(harness: Harness, port: SubtreeControlPort) {
  const readRecord = (rootId: string, requestId: string) => harness.snapshot(SubtreeControlDoc, conversationKey(rootId), requestId, BACKGROUND_CONTEXT);

  /** The children one request governs: the selected subset, or the whole captured set. */
  function governed(scope: readonly string[], selected: readonly string[] | null): readonly string[] {
    return selected ?? scope;
  }

  /** Whether every child this request governs has a recorded outcome, which is what makes it resumable or complete. */
  function complete(record: SubtreeControlRecord, scope: readonly string[], selected: readonly string[] | null): boolean {
    return governed(scope, selected).every((id) => record.outcomes?.[id] !== undefined);
  }

  /** Project one stored record and the children's current state as the answer of the request it states. */
  async function project(record: SubtreeControlRecord, scope: readonly string[], selected: readonly string[] | null): Promise<SubtreeControlResult> {
    const outcomes: SubtreeChildOutcome[] = [];
    for (const conversationId of governed(scope, selected)) {
      const stored = record.outcomes?.[conversationId];
      outcomes.push({
        conversationId,
        // A child this request has not reached yet states that, instead of borrowing a status that would claim an attempt
        // was made and failed.
        status: (stored?.status ?? "pending") as SubtreeChildStatus,
        ...(stored?.reason === undefined ? {} : { reason: stored.reason }),
        control: await currentControl(port, conversationId),
      });
    }
    return {
      requestId: record.requestId ?? "",
      action: record.action ?? "stop",
      status: complete(record, scope, selected) ? "completed" : "pending",
      scope,
      selected,
      outcomes,
      partial: outcomes.some((outcome) => !CONTROLLED.has(outcome.status)),
    };
  }

  /** The durable record of one request, for a caller reading back a request whose answer it lost. */
  async function request(conversationId: string, requestId: string): Promise<SubtreeControlResult | undefined> {
    const conversation = await port.conversation(conversationId);
    if (conversation === undefined) throw new SubtreeControlRefusal("not_found", 404, "no conversation with id " + conversationId);
    const record = await readRecord(conversationId, requestId);
    if (record === undefined || record.scope === undefined) return undefined;
    return project(record, record.scope, record.selected ?? null);
  }

  /**
   * Stop or interrupt every captured descendant of one conversation, or resume a request that already captured them.
   *
   * The capture, the selection check and the record write are one commit, so a request either exists with its full
   * scope or does not exist at all. Each child's outcome is then committed as it settles, which is what makes a
   * process that dies mid-way resumable instead of having to re-derive a scope that may have grown since.
   */
  async function subtreeControl(conversationId: string, control: SubtreeControlRequest): Promise<SubtreeControlResult> {
    if (typeof control.requestId !== "string" || control.requestId.trim() === "") {
      throw new SubtreeControlRefusal("invalid_request", 400, "requestId is required");
    }
    if (control.action !== "stop" && control.action !== "interrupt") {
      throw new SubtreeControlRefusal("invalid_request", 400, "action must be stop or interrupt");
    }
    const conversation = await port.conversation(conversationId);
    if (conversation === undefined) throw new SubtreeControlRefusal("not_found", 404, "no conversation with id " + conversationId);
    // The addressed conversation is the one the request governs, so it must be one the user can still see.
    await port.refuseRemoved(conversationId);
    let record = await readRecord(conversationId, control.requestId);
    if (record === undefined || record.scope === undefined) {
      const scope = await collectScope(harness, port, conversationId);
      if (control.selected !== undefined) {
        if (!Array.isArray(control.selected) || control.selected.length === 0) {
          throw new SubtreeControlRefusal("invalid_request", 400, "selected must name at least one conversation; omit it to control the whole subtree");
        }
        const inScope = new Set(scope);
        const outside = control.selected.filter((id) => typeof id !== "string" || !inScope.has(id));
        // A selection is validated against the captured set and never against the request body's own claim, so a caller
        // cannot reach a conversation outside the addressed subtree by naming it (spec acceptance 2).
        if (outside.length > 0) {
          throw new SubtreeControlRefusal("outside_subtree", 409, "these conversations are not in the captured subtree of " + conversationId + ": " + outside.join(", "));
        }
      }
      await harness.commit(async (tx) => {
        const draft = await tx.doc(SubtreeControlDoc, conversation.id, control.requestId, null);
        // A concurrent request that captured first keeps its set: the first request under an identity governs it.
        if (draft.scope !== undefined) return;
        draft.requestId = control.requestId;
        draft.action = control.action;
        draft.stopSource = control.stopSource;
        draft.scope = [...scope];
        draft.selected = control.selected === undefined ? undefined : [...control.selected];
        draft.outcomes = {};
      }, BACKGROUND_CONTEXT);
      // The capture is read back as a committed value: a document draft is not readable once its overlay settled, so the
      // record this operation works from is the stored one, never the draft the commit just wrote.
      record = await readRecord(conversationId, control.requestId);
      if (record === undefined || record.scope === undefined) throw new Error("the subtree request that was just captured is not readable");
    }
    const captured: SubtreeControlRecord = record;
    const action = captured.action ?? control.action;
    const scope = captured.scope ?? [];
    const selected = captured.selected ?? null;
    const stopSource = captured.stopSource ?? control.stopSource;
    // A child that already has a recorded outcome is not touched again, which is what makes a resumed request resume:
    // the children it already controlled keep their answer and only the rest are still to do.
    const targets = governed(scope, selected).filter((id) => captured.outcomes?.[id] === undefined);
    // One inspection read answers "did this child have live work at capture" for every child of this request, which is
    // the fact that separates `accepted` from `already-settled`; a child reached by an abort mark still drains after it.
    const live = await liveConversations(harness);
    // The children are controlled concurrently — each child's own runtime contract is independent of its siblings, and an
    // interrupt waits for its child's scope to drain, so doing that one child at a time would make one slow child hold up
    // every child after it. Each outcome is committed **as that child settles**, not after all of them have: the record is
    // the only thing a reader of a request in flight has, so a child that is already done must be durable while its
    // slower sibling still drains. Waiting would leave every child `pending` until the last one answered, which is what
    // a replay or a restarted process resumes from — and that would reach a child this request already controlled.
    await Promise.all(targets.map(async (childId) => {
      const outcome = await controlChild(port, action, childId, control.requestId, stopSource, live);
      const committed: SubtreeOutcomeRecord = { status: outcome.status, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), at: Date.now() };
      await harness.commit(async (tx) => {
        const draft = await tx.doc(SubtreeControlDoc, conversation.id, control.requestId, null);
        draft.outcomes = { ...(draft.outcomes ?? {}), [childId]: committed };
      }, BACKGROUND_CONTEXT);
    }));
    // The answer is projected from the stored record, so a child's committed outcome — not this call's own view of it —
    // is what a caller reads, and a resumed request reports the children it controlled in an earlier attempt the same way.
    const stored = await readRecord(conversationId, control.requestId);
    if (stored === undefined) throw new Error("the subtree request that was just answered is not readable");
    if (stored.settledAt === undefined && complete(stored, scope, selected)) {
      await harness.commit(async (tx) => {
        (await tx.doc(SubtreeControlDoc, conversation.id, control.requestId, null)).settledAt = Date.now();
      }, BACKGROUND_CONTEXT);
    }
    return project(stored, scope, selected);
  }

  return { subtreeControl, subtreeControlRequest: request };
}
