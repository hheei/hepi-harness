/**
 * Which conversations a run-end fact turns into an unread marker.
 *
 * A marker needs one fact and no more: that a run ended. The backend states it on the catalogue row
 * (`lastRunEndedAt`), read from the run's own durable receipt, so a run that started and finished between two polls is
 * still a fact the sidebar receives. The poll's `busy` edge could never say that — absence only reports a run that was
 * *seen* running — which is why such a run used to leave nothing behind at all, neither a sound nor a marker.
 *
 * The rule is a diff against what this window has already been told, per conversation:
 *
 * - The window's first listing is history: it records what it saw and marks nothing, so opening the page cannot turn
 *   every old run into news.
 * - After that, a conversation stating an end this window has not recorded is a run that ended while the window was
 *   watching, and it is a marker — whether the window ever saw it running or not.
 * - A run in flight states no end yet. A conversation running again is still marked for the end it already had: the
 *   answer arrived, and a later run does not retract it.
 * - The conversation on screen is never marked, and neither is a subagent's: its completion is not the user's to hear.
 *
 * Nothing here decides *how* a run ended. A marker says a run happened; whether it answered, aborted or failed is the
 * transcript's and the submission's business. This rule only ever produces a marker, never a completion notice.
 */
export interface RunMarkSession {
  id: string;
  /** When this conversation's newest run ended, as the catalogue states it; absent while it has finished none. */
  lastRunEndedAt?: number;
}

export interface RunMarkOptions {
  /** The conversation the user is looking at: its own surface is showing the run, so it is never news. */
  selectedSessionId: string | null;
  subagentIds: ReadonlySet<string>;
  /**
   * True while the window has not yet taken a listing as its baseline. It stays true across an empty listing, because a
   * page that has read nothing yet has been told nothing: a window with no conversations is not a window whose history
   * is known, and consuming the seed there would make the first real listing look like a page full of fresh runs.
   */
  seeding: boolean;
}

export interface RunMarkResult {
  /** What this window has been told, one entry per conversation that has ever stated an end. */
  seen: Map<string, number>;
  /** The conversations whose run ended since the last call, in the order given. */
  completed: string[];
}

/**
 * Pure. `seen` is not mutated; the returned map is the caller's next state. `sessions` may name an id more than once
 * (a family lists its members), and the last statement for an id wins exactly as the catalogue's own last read does.
 */
export function advanceRunMarks(
  seen: ReadonlyMap<string, number>,
  sessions: readonly RunMarkSession[],
  options: RunMarkOptions,
): RunMarkResult {
  const next = new Map(seen);
  const completed: string[] = [];
  const marked = new Set<string>();
  for (const session of sessions) {
    const endedAt = session.lastRunEndedAt;
    if (endedAt === undefined || !Number.isFinite(endedAt)) continue;
    const previous = next.get(session.id);
    // An end this window has already recorded, or an older one, says nothing new. The value only moves forward, so a
    // listing that repeats a row is not an event.
    if (previous !== undefined && endedAt <= previous) continue;
    next.set(session.id, endedAt);
    if (options.seeding) continue;
    if (session.id === options.selectedSessionId || options.subagentIds.has(session.id)) continue;
    // A conversation this window has never been told about is still a run that ended unobserved, so it is a marker: the
    // only thing it is not is a baseline, and a baseline is what the window's own first listing supplies.
    if (marked.has(session.id)) continue;
    marked.add(session.id);
    completed.push(session.id);
  }
  return { seen: next, completed };
}
