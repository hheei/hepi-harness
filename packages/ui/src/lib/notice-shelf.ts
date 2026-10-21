/**
 * The notice shelf's rules, and nothing else.
 *
 * A notice **fact** — an id, a sentence and a kind — is stated by the conversation session and by the surface that
 * uploads a dropped file. How many of those are drawn, how long each stays, and which one is already playing its exit
 * animation is **presentation**. That split is why this module exists: the session hook keeps the facts (and is the one
 * owner of whether a fact still exists) while a local presentation owner holds every timer, so a connection handed over
 * in the background carries no clock for a toast nobody is drawing (spec R3/R4, acceptance C7).
 *
 * The rules are pure so the shelf's behaviour can be stated without a browser.
 */

/** The kind of sentence a notice states, which is what its dot is coloured by. */
export type NoticeType = "info" | "success" | "warning" | "error";

/** One notice fact: what the conversation or a surface stated, with no presentation attached. */
export type NoticeFact = { readonly id: string; readonly message: string; readonly type: NoticeType };

/** The most notices the shelf draws at once. Anything beyond waits in the facts list and is drawn as room is made. */
export const NOTICE_MAX_VISIBLE = 5;
/** How long one notice is drawn before it starts leaving. */
export const NOTICE_VISIBLE_MS = 5000;
/** How long the leave animation runs before the notice is dropped. */
export const NOTICE_EXIT_ANIMATION_MS = 180;

/**
 * What the shelf draws for the facts it holds: the oldest {@link NOTICE_MAX_VISIBLE} of them, in the order they were
 * stated.
 *
 * `overCapacity` is the shelf being asked to draw more than it shows: the oldest drawn notice has to leave for the ones
 * waiting behind it to appear, which is the same retirement a notice's own expiry performs and is therefore decided here
 * rather than by a second queue.
 */
export function shelfOf(
  facts: readonly NoticeFact[],
  maxVisible: number = NOTICE_MAX_VISIBLE,
): { readonly visible: readonly NoticeFact[]; readonly overCapacity: boolean } {
  return { visible: facts.slice(0, maxVisible), overCapacity: facts.length > maxVisible };
}

/**
 * The time a countdown has left after some of it elapsed: a pause keeps the remainder rather than restarting the
 * notice's full duration, which is what makes a hovered or focused notice resume where it stopped (acceptance C7).
 */
export function remainingAfter(remainingMs: number, startedAt: number | null, now: number): number {
  if (startedAt === null) return remainingMs;
  return Math.max(0, remainingMs - (now - startedAt));
}
