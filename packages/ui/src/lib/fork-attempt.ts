/**
 * The request identity of one fork attempt.
 *
 * The backend answers a repeated request identity with the branch the first attempt created, so a retry after a lost
 * answer — a dropped response, a reload — is answered with the branch that really exists instead of making a second
 * one. That dedupe only works if the retry carries the *same* identity as the attempt it repeats, so the identity
 * cannot be minted per HTTP request: it belongs to the attempt, and the attempt is held here.
 *
 * An attempt is named by its source conversation and its branch point. It keeps its identity across every retry, and
 * it is released once it has been answered — the next fork of that entry is then a new branch, not a replay. A failed
 * attempt is deliberately *not* released: that failure is exactly what the user retries.
 */

/** A fork attempt's identity, keyed by the attempt itself: `<conversationId>:<entryId>`. */
export type ForkAttempts = Map<string, string>;

/** The key one attempt is held under: the same conversation and branch point is the same attempt. */
export function forkAttemptKey(conversationId: string, entryId: string): string {
  return conversationId + ":" + entryId;
}

/**
 * The identity to send for this attempt: the one already in flight, or a fresh one this call mints and keeps.
 * `mint` is injected so a caller can state where identities come from rather than this module reaching for one.
 */
export function forkRequestId(attempts: ForkAttempts, key: string, mint: () => string): string {
  const held = attempts.get(key);
  if (held !== undefined) return held;
  const created = mint();
  attempts.set(key, created);
  return created;
}

/** The attempt was answered, so its identity has done its work and the next fork of that entry is a new branch. */
export function forkSettled(attempts: ForkAttempts, key: string): void {
  attempts.delete(key);
}
