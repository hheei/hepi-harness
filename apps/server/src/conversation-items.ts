import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { contentText } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type InboxItem,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import { PROTOCOL_VERSION, pendingContentToken, type QueuedItemProjection, type QueuedItemSource } from "@hepi/protocol";
import { AGENT_REPORT_ENTRY_KIND, type ReportPreview } from "./subagents/host.ts";
import { ConversationOperationRefusal } from "./conversation-operations.ts";
import { TombstoneDoc } from "./session-tombstone.ts";

/**
 * The pending queue as items, and the two per-item operations the Web offers on it (spec D09, A11).
 *
 * There is **one** queue and this module owns none of it: the runtime's own `pi.inbox` holds the queued items, the
 * runtime's own `abortSubmission` withdraws one, and this module only projects that queue into the shape a surface can
 * act on and writes one field of one item in one commit. No second queue, no draft store, no held-queue substitute, and
 * no model request: an edit or a cancel changes what the next boundary would place and nothing else.
 *
 * The whole-queue recall keeps its own path in the server (`recall-queue`): a recall means the user wants the text
 * back in the composer, which is a different decision from "this one item should never run", and replacing it with
 * per-item cancellation would lose the text.
 */

/** The queued-input shape of `pi.inbox`; a queued write is not user input and is never projected as an item. */
type QueuedInputItem = Extract<InboxItem, { readonly mode: "steer" | "followUp" }>;

/**
 * One queued item as this deployment projects it: identity, mode, the text the model would read, where it came from,
 * and the token an edit is validated against.
 *
 * The report's own entry data is read from the item's native `entry`, which is what makes a report a **source** rather
 * than a text the surface guesses at: the child conversation, the settled submission, the answer entry and the
 * preview's own truncation facts all travel, so a surface can open the whole answer it only received a cut of.
 */
export function projectQueuedItems(items: readonly InboxItem[], requestIds: ReadonlyMap<string, string> = new Map()): readonly QueuedItemProjection[] {
  return items.flatMap((item): QueuedItemProjection[] => {
    if (item.mode === "write") return [];
    const submissionId = String(item.id);
    const content = contentText(item.content as never);
    const report = reportSource(item);
    const source: QueuedItemSource = report === undefined ? { kind: "user" } : { kind: "report", ...report };
    const requestId = requestIds.get(submissionId);
    return [{
      protocol: PROTOCOL_VERSION,
      // The conversation is filled in by the caller that knows which inbox it read; the projection states identity, not
      // placement, so one expression serves the snapshot, the per-item read and the edit's own answer.
      conversationId: "",
      submissionId,
      ...(requestId === undefined ? {} : { requestId }),
      mode: item.mode,
      content,
      source,
      contentToken: pendingContentToken(content),
      editable: true,
      cancelable: true,
    }];
  });
}

/**
 * The report one queued item was admitted as, from the item's own native entry. Only `hepi.agent-report` entries are
 * read here, and only the fields the reporter writes: an item whose entry is any other kind — including an absent one —
 * is a user's own input, which is the honest answer and not a guess made from its text.
 */
function reportSource(item: QueuedInputItem): Omit<Extract<QueuedItemSource, { kind: "report" }>, "kind"> | undefined {
  const entry = item.entry;
  if (entry === undefined || entry.kind !== AGENT_REPORT_ENTRY_KIND) return undefined;
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const fields = data as Record<string, unknown>;
  const { dispatchId, childConversationId, submissionId, submissionStatus, answerEntryId, answerReason, preview } = fields;
  if (typeof dispatchId !== "string" || typeof childConversationId !== "string" || typeof submissionId !== "string") return undefined;
  if (submissionStatus !== "done" && submissionStatus !== "unanswered") return undefined;
  const cut = typeof preview === "object" && preview !== null ? preview as Record<string, unknown> : undefined;
  if (cut === undefined || typeof cut.bytes !== "number" || typeof cut.maxBytes !== "number" || typeof cut.maxLines !== "number") return undefined;
  return {
    dispatchId,
    childConversationId,
    submissionId,
    submissionStatus,
    ...(typeof answerEntryId === "string" ? { answerEntryId } : {}),
    ...(typeof answerReason === "string" ? { answerReason } : {}),
    preview: {
      bytes: cut.bytes,
      droppedBytes: typeof cut.droppedBytes === "number" ? cut.droppedBytes : 0,
      droppedLines: typeof cut.droppedLines === "number" ? cut.droppedLines : 0,
      sourceTruncated: cut.sourceTruncated === true,
      maxBytes: cut.maxBytes,
      maxLines: cut.maxLines,
    },
  };
}

/** One per-item edit, as the caller states it: which item, which text revision was read, and the new text. */
export type ConversationItemEditRequest = {
  readonly submissionId: string;
  /** The token of the text the caller read. A different token means the item changed under it, which is a conflict. */
  readonly contentToken: string;
  readonly content: string;
};

/**
 * The answer of one edit. `content_conflict` carries the **current** item, so the stale tab is handed the newer
 * decision instead of being told only that it lost; `not_queued` is the placed or settled item, which is a conflict
 * and not a failure to retry (spec D09, A11).
 */
export type ConversationItemEditResult =
  | { readonly status: "edited"; readonly item: QueuedItemProjection }
  | { readonly status: "content_conflict"; readonly item: QueuedItemProjection }
  | { readonly status: "not_queued" };

/**
 * The answer of one cancel. `cancelled` and `already_cancelled` are both successes: a retry after a lost answer must
 * read the same outcome, and a user who cancelled twice asked for the same thing twice (spec D09, A11).
 */
export type ConversationItemCancelResult =
  | { readonly status: "cancelled" | "already_cancelled" }
  | { readonly status: "placed" };

/** The per-item operations over one harness: one projection read, one conditional edit, one native cancel. */
export type ConversationItemOperations = {
  items(conversationId: string): Promise<readonly QueuedItemProjection[]>;
  edit(conversationId: string, request: ConversationItemEditRequest): Promise<ConversationItemEditResult>;
  cancel(conversationId: string, submissionId: string): Promise<ConversationItemCancelResult>;
};

/** The content one edit produces: the new text, with the item's own image blocks kept in the order they were queued. */
function editedContent(previous: UserInput, text: string): UserInput {
  if (typeof previous === "string") return text;
  const images = previous.filter((block) => block.type === "image");
  if (images.length === 0) return text;
  return [...(text.trim() === "" ? [] : [{ type: "text" as const, text }]), ...images];
}

/**
 * Open the per-item operations over one harness.
 *
 * Both operations resolve the conversation through the same by-id rule every other operation uses, refuse a removed
 * conversation the same way, and never touch the control record: a hold is the user's decision and an edit to a queued
 * item is not a decision to continue, so `held` survives both (spec D07, D09).
 */
export function createConversationItemOperations(harness: Harness): ConversationItemOperations {
  const requireConversation = async (conversationId: string): Promise<Conversation> => {
    const conversation = await harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new ConversationOperationRefusal("not_found", 404, "no conversation with id " + conversationId);
    return conversation;
  };
  const assertNotTombstoned = async (conversationId: string): Promise<void> => {
    if (await harness.snapshot(TombstoneDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT) !== undefined) {
      throw new ConversationOperationRefusal("session_deleted", 409, "This session was deleted. Start a new session to continue.");
    }
  };
  /**
   * The conversation's queued items, read in one commit. The request id of each item is read in the same commit, so an
   * item's own admission identity travels with it and a caller can resolve the submission it is looking at by the id it
   * already holds — the same identity the recovery read answers.
   */
  const readItems = async (conversation: Conversation): Promise<readonly QueuedItemProjection[]> => {
    // The outstanding submissions are read through the runtime's own inspection, which is the same read a reconnecting
    // client's frame is built from: an item's own admission request id is taken from the record the frame already
    // states, so the identity a caller resolves a submission by travels with the item it belongs to (spec D08, D09).
    const requestIds = new Map<string, string>();
    for (const record of (await harness.inspect(BACKGROUND_CONTEXT)).submissions) {
      if (record.conversationId === conversation.id && record.requestId !== undefined) requestIds.set(String(record.id), record.requestId);
    }
    return conversation.commit(async (tx) => {
      // Copied **inside** the commit: a document draft is not readable once its overlay settled.
      const items = copyJson([...(await tx.doc(InboxDoc, conversation.id)).items]) as InboxItem[];
      return projectQueuedItems(items, requestIds).map((item) => ({ ...item, conversationId: String(conversation.id) }));
    }, BACKGROUND_CONTEXT);
  };
  return {
    items: (conversationId) => requireConversation(conversationId).then(readItems),
    async edit(conversationId, request) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      if (typeof request.contentToken !== "string" || request.contentToken === "") {
        throw new ConversationOperationRefusal("invalid_request", 400, "contentToken is required: an edit names the text revision it read");
      }
      if (typeof request.content !== "string") throw new ConversationOperationRefusal("invalid_request", 400, "content must be a string");
      const outcome = await conversation.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const index = inbox.items.findIndex((candidate) => String(candidate.id) === request.submissionId);
        const stored = index < 0 ? undefined : inbox.items[index];
        // A write is not user input: it has no text to edit and is not the item this operation addresses.
        if (stored === undefined || stored.mode === "write") return { status: "not_queued" as const };
        const current = pendingContentToken(contentText(stored.content as never));
        // The token is checked **inside** the commit that writes, so two tabs cannot both pass the check and let the
        // later one overwrite the earlier one's decision: the comparison and the write are one transaction (D09, A11).
        if (current !== request.contentToken) return { status: "content_conflict" as const, item: projectQueuedItems([stored])[0]! };
        stored.content = copyJson(editedContent(stored.content as never, request.content), { omitUndefinedProperties: true }) as QueuedInputItem["content"];
        return { status: "edited" as const, item: projectQueuedItems([stored])[0]! };
      }, BACKGROUND_CONTEXT);
      return outcome.status === "not_queued" ? outcome : { status: outcome.status, item: { ...outcome.item, conversationId } };
    },
    async cancel(conversationId, submissionId) {
      const conversation = await requireConversation(conversationId);
      await assertNotTombstoned(conversationId);
      // The native operation and nothing else: it settles the queued input `unanswered` and removes its inbox item in
      // one commit, which is what makes a retry idempotent and keeps the item's original request id readable.
      const outcome = await harness.abortSubmission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT, conversation.id);
      if (outcome === "aborted") return { status: "cancelled" };
      if (outcome === "already_placed") return { status: "placed" };
      if (outcome === "not_found") throw new ConversationOperationRefusal("not_found", 404, "no queued item with submission id " + submissionId);
      // `settled`: the item is no longer queued. An earlier cancel is the same outcome asked for twice; anything else —
      // a placed input that was answered, or a recall — is a conflict, because this operation did not decide it.
      const record = await (await harness.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
      const cancelled = record !== undefined && record.status === "unanswered" && record.reason === "aborted";
      return cancelled ? { status: "already_cancelled" } : { status: "placed" };
    },
  };
}

/** One per-item HTTP request, as the route answers it: the status the route writes and the body it writes with it. */
export type ConversationItemAnswer = { readonly status: number; readonly body: unknown };

/**
 * The per-item HTTP adapter: a thin translation of one request into one operation, exactly as the raw-history route is
 * a thin translation of one read.
 *
 * Route contract (the backend's own, before the Web adapter's `/api/sessions/:id/...` mapping):
 * - `GET    /api/conversations/:id/items` — the conversation's queued items, as the snapshot states them.
 * - `PATCH  /api/conversations/:id/items/:submissionId` body `{ contentToken, content }` — edit one queued item.
 *   200 `{ status: "edited", item }`; 409 `content_conflict` with the current `item`; 409 `not_queued` for a placed
 *   or settled item; 400 `invalid_request` for a body that is not an edit.
 * - `DELETE /api/conversations/:id/items/:submissionId` — cancel one queued item through the native abort.
 *   200 `{ status: "cancelled" | "already_cancelled" }`; 409 `item_placed`; 404 `not_found`.
 */
export async function handleConversationItems(
  operations: ConversationItemOperations,
  conversationId: string,
  action: "list" | "edit" | "cancel",
  submissionId: string | undefined,
  body: unknown,
): Promise<ConversationItemAnswer> {
  try {
    if (action === "list") return { status: 200, body: { protocol: PROTOCOL_VERSION, conversationId, items: await operations.items(conversationId) } };
    if (submissionId === undefined || submissionId.trim() === "") {
      return { status: 400, body: { protocol: PROTOCOL_VERSION, conversationId, code: "invalid_request", error: "a submission id is required" } };
    }
    if (action === "edit") {
      const fields = typeof body === "object" && body !== null ? body as { contentToken?: unknown; content?: unknown } : undefined;
      if (fields === undefined || typeof fields.contentToken !== "string" || typeof fields.content !== "string") {
        return { status: 400, body: { protocol: PROTOCOL_VERSION, conversationId, code: "invalid_request", error: "contentToken and content are required" } };
      }
      const outcome = await operations.edit(conversationId, { submissionId, contentToken: fields.contentToken, content: fields.content });
      if (outcome.status === "edited") return { status: 200, body: { protocol: PROTOCOL_VERSION, conversationId, status: "edited", item: outcome.item } };
      if (outcome.status === "content_conflict") {
        // The current item travels with the conflict, which is what lets a stale tab show what the newer decision was
        // instead of only being refused (spec D09, A11).
        return { status: 409, body: { protocol: PROTOCOL_VERSION, conversationId, code: "content_conflict", error: "this item changed since you read it; the current text is beside this answer", item: outcome.item } };
      }
      return { status: 409, body: { protocol: PROTOCOL_VERSION, conversationId, code: "not_queued", error: "this item is no longer queued: it was placed or settled, so it cannot be edited" } };
    }
    const outcome = await operations.cancel(conversationId, submissionId);
    if (outcome.status === "placed") return { status: 409, body: { protocol: PROTOCOL_VERSION, conversationId, code: "item_placed", error: "this item was already placed, so it can no longer be cancelled" } };
    return { status: 200, body: { protocol: PROTOCOL_VERSION, conversationId, status: outcome.status } };
  } catch (error) {
    if (!(error instanceof ConversationOperationRefusal)) throw error;
    return { status: error.status, body: { protocol: PROTOCOL_VERSION, conversationId, code: error.code, error: error.message } };
  }
}
