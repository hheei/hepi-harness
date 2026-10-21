import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, InboxDoc, type ConversationId, type Session } from "@earendil-works/pi-durable";
import { applySidebarStateTx } from "./sidebar-state.ts";

// Records are retained because pi-durable 1.1.0 has no conversation deletion; this hides the
// conversation from the catalogue. Replace with the upstream deletion primitive when it exists.

/**
 * One conversation's removal, as hepi-owned state: a conversation-scoped document whose presence is the whole fact.
 * It is written through the same durable document path as every other hepi document — no store is edited directly, and
 * nothing is deleted from it — so the conversation's entries, records and conversation-scoped documents keep reading
 * back through the durable API after the removal, and a restart keeps the removal too.
 *
 * The operation is an ordinary removal to a caller. A live run is left to settle into those retained records rather
 * than being stopped or waited for, and a new turn on a removed conversation is refused with a reason.
 *
 * `fork: "initial"` is what keeps a copy out of it: a conversation forked from a removed source is a session of its
 * own and must stay listed, while `hepi.title` and the execution workspace keep following the source as they do.
 */
export const TombstoneDoc = defineDoc<{ deletedAt?: number }>({
  kind: "hepi.deleted",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

/**
 * Removes one conversation from the catalogue and clears the given ids' own pin, archive and unread entries in the
 * same commit, so a removal can never leave an orphan entry in the shared sidebar document. The ids are the removed
 * session's own family: a conversation forked from it, or owned by a task of it, is a session of its own and keeps
 * its entries.
 *
 * The clear reuses the shared rules' `restore` action, whose contract is exactly "write these flags back to these
 * values" with null meaning absent, so the removal adds no second rule to the sidebar document.
 *
 * **The removal is also the conversation's last word on admission**, and it is written here, in this one commit,
 * because this is where the decision belongs: the removal commits the native `held` control the runtime's own
 * admission already consults (`isHeld`, read from the conversation's `pi.inbox`). A caller that checks the tombstone
 * and then admits in a *later* commit is therefore still safe — the two facts are one commit, so an admission that
 * commits after the removal necessarily reads `held`, queues, places nothing and starts no run. That is the whole
 * linearization: no admission is repeated, no caller re-checks anything, and the native queue, the control revision
 * and the runtime's own admission rules are untouched. A deleted conversation is never continued, so a queue it holds
 * is never consumed. A removal of a conversation whose inbox was never materialized writes the same default control
 * the runtime's own document definition starts from.
 */
export async function tombstoneConversation(session: Session, conversationId: ConversationId, ids: readonly string[], now: number): Promise<void> {
  await session.commit(async (tx) => {
    (await tx.doc(TombstoneDoc, conversationId)).deletedAt = now;
    const inbox = await tx.doc(InboxDoc, conversationId);
    // The default is the runtime's own: an inbox that has never been held admits until a trusted stop holds it. Only
    // `state` changes, so a conversation with recorded control keeps its revision and its receipts.
    inbox.control = { ...(inbox.control ?? { state: "allowed" as const, revision: 0, receipts: [] }), state: "held" as const };
    const cleared = ids.map(id => ({ id, pinnedAt: null, archivedAt: null, unreadAt: null }));
    if (cleared.length > 0) await applySidebarStateTx(tx, { action: "restore", entries: cleared }, now);
  }, BACKGROUND_CONTEXT);
}
