/**
 * The request identity of one delegation attempt, and the shape one delegation answer takes.
 *
 * The backend answers a repeated request identity with the child (or the dispatch) the first attempt made, so a retry
 * after a lost answer is answered with the work that really exists instead of making a second child. That dedupe only
 * works if the retry carries the *same* identity as the attempt it repeats, so the identity belongs to the attempt and
 * is held here — exactly as the fork panel already holds its own (`fork-attempt.ts`).
 *
 * An attempt is named by the conversation it was made from and the definition it named. A second quick create of the
 * same definition from the same conversation is therefore a **new** attempt only once the first one has been answered:
 * until then a retry is the same delegation, and after that the next click is a genuinely new child. The task text is
 * deliberately not part of the key: a user who edits the task while the first attempt is unanswered is retrying that
 * same attempt with different words, and minting a second identity there would create a second child.
 */

import type { SessionInfo } from "./types";

/** One attempt's identity, keyed by the attempt itself. */
export type DelegateAttempts = Map<string, string>;

/**
 * The key one attempt is held under: the conversation that delegates, the definition it named, and the conversation the
 * task is for. The target is part of it because a dispatch to one child and a dispatch to another are two different
 * delegations even under the same definition — sharing an identity between them would answer the second with the first
 * one's child.
 */
export function delegateAttemptKey(conversationId: string, definition: string, targetConversationId = ""): string {
  return conversationId + ":" + definition + ":" + targetConversationId;
}

/** The identity to send for this attempt: the one already in flight, or a fresh one this call mints and keeps. */
export function delegateRequestId(attempts: DelegateAttempts, key: string, mint: () => string): string {
  const held = attempts.get(key);
  if (held !== undefined) return held;
  const created = mint();
  attempts.set(key, created);
  return created;
}

/** The attempt was answered, so its identity has done its work and the next delegation of that definition is new. */
export function delegateSettled(attempts: DelegateAttempts, key: string): void {
  attempts.delete(key);
}

/**
 * One delegation answer, as the backend states it. `created` distinguishes the child this request made from the child
 * a replay answered, which is the only difference a caller can see — and it is why a retry needs no special path.
 */
export type DelegateAnswer = {
  readonly childConversationId: string;
  readonly dispatchId: string;
  readonly requestId: string;
  readonly created: boolean;
  readonly definition?: string;
  readonly displayParentId?: string;
  readonly preparationRetried?: boolean;
  /**
   * The child (or the dispatched conversation) as a **session row**, when the Web origin answered one: the panel opens
   * it in the same ChatWindow from this row, so a quick create does not have to wait for the catalogue to list it.
   */
  readonly session?: SessionInfo;
};

/**
 * One refusal, as the backend names it. The code is what a surface shows beside its own words; the message is the
 * backend's own statement, shown as it arrived so an unreachable host or an over-limit refusal is never paraphrased
 * into a friendlier sentence that hides what happened (spec D12, D15).
 */
export type DelegateRefusal = { readonly code: string; readonly message: string };

/** The answer of one delegation call: the child, or the refusal the backend stated. */
export type DelegateResult =
  | { readonly ok: true; readonly answer: DelegateAnswer }
  | { readonly ok: false; readonly refusal: DelegateRefusal };

/** Read one delegation answer out of an HTTP body, so the adapter and its test read the same fields. */
export function readDelegateAnswer(body: unknown): DelegateAnswer | undefined {
  const value = body as Partial<DelegateAnswer> | null;
  if (value === null || typeof value !== "object") return undefined;
  if (typeof value.childConversationId !== "string" || typeof value.dispatchId !== "string" || typeof value.requestId !== "string") return undefined;
  return {
    childConversationId: value.childConversationId,
    dispatchId: value.dispatchId,
    requestId: value.requestId,
    created: value.created === true,
    ...(typeof value.definition === "string" ? { definition: value.definition } : {}),
    ...(typeof value.displayParentId === "string" ? { displayParentId: value.displayParentId } : {}),
    ...(value.preparationRetried === true ? { preparationRetried: true } : {}),
    ...(value.session === undefined ? {} : { session: value.session }),
  };
}

/** Read one refusal out of an HTTP body, with the backend's own message and no invented fallback wording. */
export function readDelegateRefusal(body: unknown, status: number): DelegateRefusal {
  const value = body as { code?: unknown; error?: unknown; message?: unknown } | null;
  const code = value !== null && typeof value?.code === "string" ? value.code : "delegate_failed";
  const message = value !== null && typeof value?.error === "string" ? value.error
    : value !== null && typeof value?.message === "string" ? value.message
    : "HTTP " + status;
  return { code, message };
}
