import { decidePrefix, type LoadedPrefix } from "@hepi/session";
import type { SessionData } from "./durable-projection";
import { mergeLandedPrefix } from "./history-navigation";
import type { AgentMessage } from "./types";

/**
 * One conversation's accepted readout: the window the conversation stated, the older pages the reader loaded in front
 * of it, and the pagination claim that window makes.
 *
 * The lifecycle fold (`lifecycle-projection.ts`) decides **whether** a statement is the conversation's current one;
 * this module decides **what the reader sees** once it is. Keeping the two apart is what makes the prefix rule run
 * synchronously with the accepted window instead of in a React effect that catches up with the previous render: a
 * window that moves and the prefix it keeps are one publication, derived answer, because they are one decision.
 *
 * What is deliberately not here:
 *
 * - **The fold.** No revision comparison, no acquisition, no submission ordering: a readout is only ever built from a
 *   statement the fold already accepted (`receiveAccepted`), so there is no second lifecycle authority.
 * - **A copy of the transcript by id.** The previous window a prefix decision is made against is the accepted payload
 *   itself (`data.context`), so nothing keeps a second id→message map of what was on screen.
 * - **Metadata.** Session stats, `snapshotRevision`/`historyHead`, the active leaf and the display model stay on the
 *   accepted payload where the transport stated them; the readout carries that payload, it does not re-derive it.
 * - **Transport continuity.** The stream-local `SessionState` is what a delta is assembled from; it can advance on a
 *   frame the fold refuses, which is why it cannot be the readout.
 */

/** The accepted readout of one conversation: its window payload, the pages in front of it, and the window's own claim. */
export type AcceptedReadout = {
  /** The accepted lifecycle payload, as the transport stated it beside the window. Null before any statement arrived. */
  readonly session: SessionData | null;
  /** The pages the reader paged (or jumped) in, in transcript order, or null when nothing precedes the window. */
  readonly prefix: LoadedPrefix<AgentMessage> | null;
  /** Whether the accepted window states that older history exists — the window's claim, not the prefix's size. */
  readonly hasMore: boolean;
};

/** The window a session payload states: the ids its entries carry, their messages, the head, and its pagination claim. */
export type SessionWindow = {
  readonly entryIds: readonly string[];
  readonly messages: readonly AgentMessage[];
  readonly historyHead: string | null;
  readonly hasMore: boolean;
};

/** A readout with no statement behind it: no window, nothing paged, nothing claimed. */
export function emptyReadout(): AcceptedReadout {
  return { session: null, prefix: null, hasMore: false };
}

/** The window one accepted session payload states. */
export function windowOf(session: SessionData): SessionWindow {
  return {
    entryIds: session.context.entryIds,
    messages: session.context.messages,
    historyHead: session.historyHead ?? null,
    hasMore: session.context.hasMore,
  };
}

/** The readout with the pagination claim a page read stated: whether older history exists behind what is on screen. */
export function claimEarlierHistory(readout: AcceptedReadout, hasMore: boolean): AcceptedReadout {
  return readout.hasMore === hasMore ? readout : { ...readout, hasMore };
}

/** The readout with nothing paged in front: a read that states a fresh window is not extended by older pages. */
export function clearPrefix(readout: AcceptedReadout): AcceptedReadout {
  return readout.prefix === null ? readout : { ...readout, prefix: null };
}

/** A prefix built from what was restored or paged. An empty one is no prefix, rather than an empty page in front. */
export function prefixOf(
  entryIds: readonly string[],
  messages: readonly AgentMessage[],
  historyHead: string | null,
): LoadedPrefix<AgentMessage> | null {
  return entryIds.length === 0 ? null : { entryIds, messages, historyHead };
}

/**
 * Accept one window and decide the prefix in the same step.
 *
 * The rule is the shared `decidePrefix` rule — head marker moved, window became the whole active range, or the reader's
 * pages truncated by id with the entries the window evicted while they were loaded **migrating** into the prefix. What
 * this function adds is only the pair of windows it is decided against: the accepted window before this one, which is
 * the payload the readout already holds, so an entry the window evicted can still be drawn from the message the reader
 * was looking at. Nothing compares renders, refs or effects.
 *
 * A payload for another conversation (or the first one this mount accepts) leaves no prefix behind: the pages belong
 * to the conversation they were paged in.
 */
export function acceptSession(previous: AcceptedReadout, session: SessionData): AcceptedReadout {
  const sameConversation = previous.session !== null && previous.session.sessionId === session.sessionId;
  const window = windowOf(session);
  const before = sameConversation ? windowOf(previous.session!) : null;
  const held = sameConversation ? previous.prefix : null;
  if (before === null || held === null) return { session, prefix: null, hasMore: window.hasMore };
  const decided = decidePrefix(held, {
    entryIds: window.entryIds,
    previousEntryIds: before.entryIds,
    historyHead: window.historyHead,
    hasMore: window.hasMore,
  }, (id) => {
    const at = before.entryIds.indexOf(id);
    return at < 0 ? undefined : before.messages[at];
  });
  return { session, prefix: decided, hasMore: window.hasMore };
}

/**
 * Put one page of older history in front of the prefix.
 *
 * A page states the context it was read in, so a page for another conversation (or for a conversation this readout no
 * longer holds) starts the prefix rather than extending another one's.
 */
export function prependOlderPage(
  readout: AcceptedReadout,
  page: {
    readonly sessionId: string;
    readonly entryIds: readonly string[];
    readonly messages: readonly AgentMessage[];
    readonly historyHead: string | null;
    readonly hasMore: boolean;
  },
): AcceptedReadout {
  const base = readout.session !== null && readout.session.sessionId === page.sessionId ? readout.prefix : null;
  return {
    ...readout,
    // The page's own claim replaces the window's: reaching the start of history is a fact only a page read establishes.
    hasMore: page.hasMore,
    prefix: {
      entryIds: [...page.entryIds, ...(base?.entryIds ?? [])],
      messages: [...page.messages, ...(base?.messages ?? [])],
      historyHead: page.historyHead,
    },
  };
}

/**
 * Land one bounded navigation window in front of the accepted window.
 *
 * A landing is history the projection's own window does not carry, so it joins the reader's prefix through the same
 * rule a paged entry does: ordered by the ids the Backend issued, never twice, and never an entry the accepted window
 * is authoritative for. A landing that crossed a head marker — or that belongs to another conversation — is not
 * merged: it describes a history this readout has left. `null` means the readout is unchanged.
 */
export function landHistory(
  readout: AcceptedReadout,
  landing: {
    readonly sessionId: string;
    readonly entryIds: readonly string[];
    readonly messages: readonly AgentMessage[];
    readonly windowEntryIds: readonly string[];
  },
): AcceptedReadout | null {
  const window = readout.session;
  // A landing is history of the conversation this readout holds, read under the head marker it holds. The head's one
  // owner is the accepted window: a jump that crossed a compaction is a landing for a history this readout has left, and
  // `acceptSession` has already retired the prefix it belonged to. A landing for another conversation contributes
  // nothing.
  if (window === null || window.sessionId !== landing.sessionId) return null;
  const head = window.historyHead ?? null;
  const prefix = readout.prefix;
  const merged = mergeLandedPrefix(
    prefix === null ? null : { entryIds: prefix.entryIds, messages: prefix.messages },
    { entryIds: landing.entryIds, messages: landing.messages },
    landing.windowEntryIds,
  );
  if (merged.entryIds.length === 0) return null;
  // A landing this readout already holds — a repeated jump, or one the window covers — states nothing new.
  const unchanged = prefix !== null && merged.entryIds.length === prefix.entryIds.length && merged.entryIds.every((id, index) => id === prefix.entryIds[index]);
  if (unchanged) return null;
  return { ...readout, prefix: { entryIds: merged.entryIds, messages: merged.messages, historyHead: head } };
}

/** What the transcript shows: the prefix that still precedes the window, then the window itself. */
export type VisibleTranscript = {
  readonly entryIds: string[];
  readonly messages: AgentMessage[];
  /** The paging cursor: the oldest entry on screen, or null when the transcript is empty. */
  readonly cursor: string | null;
};

/**
 * The visible transcript, from the readout and the window the projection holds.
 *
 * The prefix is drawn in front of the window only while it still precedes it: a prefix that overlaps the window fails
 * here, because the window is authoritative for everything it covers and prepending an entry it carries would draw it
 * twice. Whether the prefix *is* what the reader loaded was decided when the window was accepted (`acceptSession`);
 * this derivation never re-decides it, so a render cannot invent history.
 */
export function transcriptOf(
  prefix: LoadedPrefix<AgentMessage> | null,
  window: { readonly entryIds: readonly string[]; readonly messages: readonly AgentMessage[] },
): VisibleTranscript {
  const applies = prefix !== null && prefix.entryIds.length > 0 && !prefix.entryIds.some((id) => window.entryIds.includes(id));
  const entryIds = applies ? [...prefix!.entryIds, ...window.entryIds] : [...window.entryIds];
  const messages = applies ? [...prefix!.messages, ...window.messages] : [...window.messages];
  return { entryIds, messages, cursor: entryIds[0] ?? null };
}
