import { copyJson, type Context } from "@earendil-works/chord";
import {
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type InboxItem,
  type InputSubmissionDraft,
  type SubmissionId,
} from "@earendil-works/pi-durable";

/**
 * A native input draft plus this adapter's own admission switch.
 *
 * `triggerTurn` (default `true`) is this adapter's field, not the runtime's. `true` submits through the runtime exactly
 * as `Conversation.submit()` does. `false` only enqueues: it writes the same queued submission and `pi.inbox` item the
 * runtime writes for a busy conversation, in one commit, and starts no run. The item then waits for the next native
 * boundary — a later submit, or a running generation's boundary — so `false` delays a turn rather than holding it
 * against those boundaries permanently.
 */
export type ConversationInputDraft = InputSubmissionDraft & { readonly triggerTurn?: boolean };

/** The queued-input shape of `pi.inbox`; this adapter never produces the write variant. */
type QueuedInputItem = Extract<InboxItem, { readonly mode: "steer" | "followUp" }>;

/**
 * Reject a custom input entry the way the runtime's own admission does: the kind must be a non-empty string outside the
 * reserved `pi.` prefix. The check lives here because this adapter's enqueue path writes the entry itself and never
 * reaches the runtime's admission, so an untyped caller's mistake must fail before anything is committed.
 */
function checkInputEntry(entry: InputSubmissionDraft["entry"]): void {
  if (entry === undefined) return;
  const { kind } = entry;
  if (typeof kind !== "string" || kind.length === 0 || kind.startsWith("pi.")) {
    throw new TypeError(`An input entry's kind must be a non-empty string not starting with "pi.", got ${String(kind)}`);
  }
}

/**
 * Submit one user input under this adapter's `triggerTurn` switch, returning the native submission ID.
 *
 * `true` (the default) is a straight delegation to `Conversation.submit()`: the runtime decides whether the input is
 * placed and runs, queued behind a busy conversation, or refused by `whenBusy: "reject"`. `false` admits the input as a
 * queued native submission plus a `pi.inbox` item in one commit and starts no run; the input keeps its content, its
 * optional `entry` metadata, and its steer/follow-up mode, and is placed by whichever native boundary comes next. A
 * known `requestId` is answered before any read or write, so a replay or a retry after a cancel returns the existing
 * submission instead of admitting a second one or overwriting the settled record.
 */
export async function submitConversationInput(
  conversation: Conversation,
  input: ConversationInputDraft,
  context: Context,
): Promise<SubmissionId> {
  if (input.triggerTurn ?? true) {
    const { triggerTurn: _triggerTurn, ...draft } = input;
    const receipt = await conversation.submit(draft, context);
    return receipt.id;
  }
  // Only the enqueue path below writes the entry itself, so only it needs the check; the delegated path is exactly the
  // native admission, which validates its own input.
  checkInputEntry(input.entry);
  return conversation.commit(async (tx) => {
    // A known request ID is answered first: before any read that could decide otherwise, and before any write.
    if (input.requestId !== undefined) {
      const existing = await tx.submissionByRequest(conversation.id, input.requestId);
      if (existing !== undefined) {
        if (existing.type !== "input") {
          throw new Error(`Request ${input.requestId} already identifies a submission of type ${existing.type}`);
        }
        return existing.id;
      }
    }
    // Table reads precede the commit's first write. `LiveDoc` is read only to keep the native busy refusal for
    // `whenBusy: "reject"`; a steer or follow-up queues whether or not the conversation is busy.
    const live = await tx.doc(LiveDoc, conversation.id);
    if (live.run !== undefined && input.whenBusy === "reject") throw new ConversationBusy(conversation.id);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const requestId = input.requestId === undefined ? {} : { requestId: input.requestId };
    const { id } = await tx.createSubmission({ conversationId: conversation.id, ...requestId, type: "input", status: "queued" });
    const mode = input.whenBusy === "steer" ? "steer" : "followUp";
    const entry = input.entry === undefined
      ? {}
      : { entry: copyJson(input.entry.data === undefined ? { kind: input.entry.kind } : { kind: input.entry.kind, data: input.entry.data }, { omitUndefinedProperties: true }) as QueuedInputItem["entry"] };
    const item: QueuedInputItem = {
      id,
      mode,
      content: copyJson(input.content, { omitUndefinedProperties: true }) as QueuedInputItem["content"],
      ...entry,
    };
    inbox.items.push(item);
    return id;
  }, context);
}
