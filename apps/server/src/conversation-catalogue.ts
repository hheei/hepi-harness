import type { TaskInspection } from "@earendil-works/pi-durable";
import type { CatalogueWorkspace } from "./catalogue-binding.ts";
import type { ConversationRuntime } from "./conversation-attachments.ts";
import type { ProjectRegistry } from "./project-registry.ts";
import { projectRunStatus, type ConversationRunStatus } from "./subagents/status.ts";

/**
 * One conversation as the catalogue lists it: what the session list and the running poll both need, from one read.
 * The fork route answers the row this builds for its new conversation, so the row a caller is handed and the row the
 * next list read shows for the same conversation cannot be two different things. The hepi-owned title is part of the
 * row — the runtime's record has none — and a conversation with no title states the absence explicitly rather than
 * omitting the field, so a caller cannot read a missing field as "not loaded yet".
 *
 * `subagentParentConversationId` is the creator edge of a conversation a task created: a subagent's own conversation,
 * and the conversation whose task owns it. The row reports it rather than leaving a client to guess, because every
 * surface that asks "is this a subagent's?" — the completion sound, the notification, the unread marker, the session
 * tree — otherwise reads a set that is empty by construction. It is reported whether or not the owning conversation is
 * still listed: it is a fact about this conversation, and a client that could not see it would treat a subagent's
 * completion as the user's.
 *
 * It is **not** reported for a conversation the user branched from a child. That branch is task-owned — by its own
 * background anchor, in the source's scope — but its owner is not a delegation: nobody asked for it, so reporting the
 * edge would make a surface read the user's own branch as a subagent's, fold it into the source's family and treat its
 * answer as a silent completion. The branch states its source through `parentConversationId` and its place through
 * `displayParentId`; the native owner stays readable through the by-id read, where it is a fact and not a
 * classification (spec D14).
 *
 * `lastRunEndedAt` is when this conversation's newest finished run ended, from the committed task table. It is the one
 * fact that says a run happened at all: a run that starts and finishes between two polls is never seen as busy, so a
 * client that only compared running flags could not learn it ran, while a client comparing this can. It is reported
 * without a per-poll read — the value is read once when the conversation is attached and kept current from this
 * process's commit stream, exactly as the title and the removal are — and it states no outcome: whether a run answered,
 * aborted or failed is the transcript's and the submission's business, and a marker that said otherwise would be a
 * completion notice the durable facts do not support.
 */
export type CatalogueEntry = {
  id: string;
  workspaceId: string | null;
  gatewayId: string | null;
  /**
   * The binding facts about `workspaceId`, from the same lookup that resolved it: the folder's recorded root, whether a
   * removal retained it, and the Project it is a folder of. Absent for a conversation bound to no workspace, and the
   * `gatewayId` above is kept beside it because every surface that names a host already reads it there.
   */
  workspace?: CatalogueWorkspace;
  busy: boolean;
  /**
   * This conversation's own execution status, projected from facts about **it** — its own run, its own committed
   * control, its own live tasks and whether its delegated result is waiting in its creator's queue. A surface reads
   * this instead of inferring a child's state from a parent's busy flag (spec D15).
   */
  runStatus: ConversationRunStatus;
  /**
   * The extensions this conversation currently selects, from the runtime's own resolution of its stored choice. It is
   * the same list the state frame already publishes, so a surface that has to know whether this conversation may
   * delegate reads it here instead of making a second per-conversation request — and the delegate entry follows the
   * conversation's own selection rather than a deployment-wide guess (spec D15).
   */
  extensions: readonly string[];
  revision: number;
  messageCount: number;
  firstMessage: string;
  title: string | null;
  lastRunEndedAt?: number;
  /**
   * The hepi-owned creator edge: the conversation that asked for this one. It is separate from
   * `subagentParentConversationId` (the native task ownership edge) because an ordinary conversation can create an
   * independent one, and separate from `parentConversationId` (the native fork source).
   */
  createdBy?: string;
  /**
   * The conversation this one is displayed under, from its hepi-owned relations. It is kept even when that parent is
   * tombstoned, with `displayParentDeleted` stating the parent is unavailable, so a child is never promoted to a
   * conversation of its own and its relation stays readable (spec D03).
   */
  displayParentId?: string;
  displayParentDeleted?: boolean;
  /** The native immutable fork source, projected from the conversation record; absent when the conversation is no fork. */
  parentConversationId?: string;
  /** The native task ownership edge, absent for a conversation the user branched (see above). */
  subagentParentConversationId?: string;
};

/** The two per-catalogue facts a status needs, read once for a whole list. */
export type CatalogueFacts = { readonly tasks: ReadonlyMap<string, readonly TaskInspection[]>; readonly waitingReports: ReadonlySet<string> };

/** The facts of a row read on its own, where no list-wide inspection was made. */
export const NO_FACTS: CatalogueFacts = { tasks: new Map(), waitingReports: new Set() };

export type ConversationCatalogueOptions = {
  /** The registry one row's workspace facts are resolved through. No host I/O: a row costs no round trip. */
  readonly registry: ProjectRegistry;
  /** The runtime's own inspection, which is the only statement of what is running. */
  readonly inspect: () => Promise<{ readonly tasks: readonly TaskInspection[] }>;
  /** Every attached conversation this process holds, for the waiting reports their snapshots state. */
  readonly conversations: () => Iterable<ConversationRuntime>;
  /** The attached conversation one id names, for the relations a row reports. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
};

export type ConversationCatalogue = {
  /** The facts a whole list shares: one inspection, and the waiting reports of the snapshots this process holds. */
  facts(): Promise<CatalogueFacts>;
  /** One conversation's row, from the snapshot it already published. */
  entry(item: ConversationRuntime, facts?: CatalogueFacts): CatalogueEntry;
};

/**
 * The catalogue row every session list, running poll and fork answer is built from.
 *
 * It is a projection and nothing else: the conversation's own published snapshot is the one read, the registry answers
 * the workspace facts, and the runtime's inspection answers the live tasks — so a list costs one pass over this
 * process's attachments rather than a request per conversation, and the row a caller is handed after a fork is the row
 * the next list read shows for the same conversation.
 */
export function createConversationCatalogue(options: ConversationCatalogueOptions): ConversationCatalogue {
  const facts = async (): Promise<CatalogueFacts> => {
    const inspection = await options.inspect();
    const tasks = new Map<string, TaskInspection[]>();
    for (const task of inspection.tasks) {
      const id = String(task.record.conversationId);
      const list = tasks.get(id);
      if (list === undefined) tasks.set(id, [task]);
      else list.push(task);
    }
    const waitingReports = new Set<string>();
    for (const item of options.conversations()) {
      if (item.deletedAt() !== undefined) continue;
      for (const queued of item.snapshot().queuedItems) {
        if (queued.source.kind === "report") waitingReports.add(queued.source.childConversationId);
      }
    }
    return { tasks, waitingReports };
  };
  const entry = (item: ConversationRuntime, shared: CatalogueFacts = NO_FACTS): CatalogueEntry => {
    const current = item.snapshot();
    const workspace = options.registry.catalogueOf(current.workspaceId);
    const stats = item.catalogueStats();
    // A fork is told apart from its source by this relation, so it is reported only while the source is still listed:
    // a removed source leaves a row that reports no parent, which is what keeps a removed conversation from being
    // named by a surface after it is gone. The immutable record keeps the ancestry either way.
    const parent = item.parentConversationId === undefined ? undefined : options.conversation(item.parentConversationId);
    const parentConversationId = parent === undefined || parent.deletedAt() !== undefined ? undefined : item.parentConversationId;
    const lastRunEndedAt = item.lastRunEndedAt();
    // The display parent is stated even while it is tombstoned — unlike the fork source above — because a hidden parent
    // is a fact about the relation, not a reason to erase it: the child keeps its place and is not promoted, and a
    // surface that could not see the edge would show an independent conversation.
    const relations = item.relations();
    const displayParentId = relations.displayParentId;
    const displayParentDeleted = displayParentId !== undefined && options.conversation(displayParentId)?.deletedAt() !== undefined;
    return {
      id: String(item.conversation.id),
      workspaceId: current.workspaceId ?? null,
      // One resolution answers both fields: the row's `gatewayId` and its `workspace` facts are two statements about
      // the same binding, so a row that resolved it twice could state two different ones.
      gatewayId: workspace?.gatewayId ?? null,
      ...(workspace === undefined ? {} : { workspace }),
      busy: current.busy,
      extensions: current.extensions,
      runStatus: projectRunStatus({
        busy: current.busy,
        control: current.control,
        tasks: shared.tasks.get(String(item.conversation.id)) ?? [],
        waitingReport: shared.waitingReports.has(String(item.conversation.id)),
      }),
      revision: current.revision,
      messageCount: stats.count,
      firstMessage: stats.firstMessage,
      title: item.title() ?? null,
      ...(lastRunEndedAt === undefined ? {} : { lastRunEndedAt }),
      ...(parentConversationId === undefined ? {} : { parentConversationId }),
      ...(relations.createdBy === undefined ? {} : { createdBy: relations.createdBy }),
      ...(displayParentId === undefined ? {} : { displayParentId }),
      ...(displayParentDeleted ? { displayParentDeleted: true } : {}),
      // A user branch is a conversation of its own that happens to be task-owned by its own anchor, so its owner edge
      // is not the delegation edge the catalogue reports; a delegated child — whose provenance is the agent that asked
      // for it — keeps reporting its creator (spec D14).
      ...(item.subagentParentConversationId === undefined || relations.provenance?.origin === "user" ? {} : { subagentParentConversationId: item.subagentParentConversationId }),
    };
  };
  return { facts, entry };
}
