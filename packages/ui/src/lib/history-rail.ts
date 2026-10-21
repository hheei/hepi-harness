import type { NavigationOutline } from "./history-navigation.ts";

/**
 * The rail's node list: one node per committed user message, across the conversation's whole history, plus the turns
 * the transcript has measured (history-navigation ticket 04).
 *
 * The rail used to be derived from the loaded DOM alone, which made it an index of what happened to be mounted: a
 * conversation longer than its window showed only the turns near the viewport, and a node beyond them did not exist to
 * click. Two sources now answer the same question and this module is the one rule that joins them:
 *
 * - **the paged outline** states the conversation's committed user anchors, oldest first, with a bounded preview each
 *   and the server cursor that orders them (spec decisions 1, 5). It is the rail's authority on *which nodes exist* and
 *   in what order, and it is what makes an unloaded node renderable at all.
 * - **the measured transcript** states where a turn actually is, which is the only source of pixel geometry there is.
 *
 * A node the transcript carries is therefore **loaded** and keeps its measured turn — the local user/assistant/heading
 * jumps are unchanged. A node it does not carry is **unloaded**: it has an identity, a preview and an order, and no
 * position beyond its place in the ordered list. Nothing here invents a height for it, because a rail that claimed to
 * know where an unloaded message sits would be stating geometry it never measured (spec non-goal: no persisted heights,
 * no exact pixel positions for unloaded messages).
 *
 * Two consequences worth stating, because they are the shapes a naive merge gets wrong:
 *
 * - **A loaded turn that is not an anchor is not a node.** The leading assistant-only prefix, a compaction marker and a
 *   subagent report are turns the transcript draws and the outline deliberately does not enumerate (spec decision 10,
 *   and ticket 01's anchor rule). Once an outline exists it is the authority, so such a turn is rendered inside its
 *   surrounding turn and gets no node of its own rather than a fabricated one.
 * - **A loaded turn newer than the newest anchor the outline knows is a node.** The reader's own window sits at the
 *   tail, usually past the last page they paged in, and a turn they just committed is newer than any page read before
 *   it. Dropping those would make the rail's bottom edge lag behind the conversation the reader is looking at; keeping
 *   them is also what lets the node stay put when the outline refreshes, because identity is the entry id on both sides.
 */

/** One rail node: an identity, its order, its bounded preview, and the measured turn when the transcript has it. */
export type RailNode<TTurn> = {
  /** The committed entry this node is anchored on — the rail's identity, never a position. */
  readonly entryId: string;
  /** The opaque coordinate a jump is addressed by. Empty for a node the outline has not listed yet. */
  readonly anchor: string;
  /** The bounded user text the preview shows: the server's own preview, or the measured message's text. */
  readonly preview: string;
  /** The server's ordering value. Orders nodes only; never an identity (spec decision 4). */
  readonly cursor: number;
  /** Whether the transcript carries this entry right now, which is what makes a measured jump possible. */
  readonly loaded: boolean;
  /** The measured turn, for a loaded node. `null` for an unloaded one: it has no geometry, by design. */
  readonly turn: TTurn | null;
};

/** One measured turn, as the rail's geometry owner states it. */
export type MeasuredTurn<TTurn> = {
  /** The entry the turn is anchored on, or `null` for a turn with no committed anchor (a streaming reply). */
  readonly anchorEntryId: string | null;
  /** The user text the transcript is showing for that anchor. */
  readonly preview: string;
  readonly turn: TTurn;
};

/** The entry id as the ordering value the Backend uses, or `null` when it is not one. */
function cursorOf(entryId: string): number | null {
  if (!/^\d+$/.test(entryId)) return null;
  return Number(entryId);
}

/**
 * Join the paged outline and the measured transcript into the rail's ordered node list.
 *
 * The order is the server's cursor and nothing else — never arrival order, never the measured list's own position —
 * because the rail is an index over the conversation's history rather than over the reader's viewport. Nodes whose
 * cursor is unknown (a local turn anchored on an id that is not numeric) sort after the ordered ones in their measured
 * order, which is the transcript's own order.
 */
export function buildRailNodes<TTurn>(input: {
  /** The paged outline, or `null` before a page has been answered. */
  readonly outline: NavigationOutline | null;
  /** Every turn the transcript measured, in transcript order. */
  readonly turns: readonly MeasuredTurn<TTurn>[];
}): RailNode<TTurn>[] {
  const { outline, turns } = input;
  // No outline yet: the rail is exactly what it always was — the turns on screen. This is the state a conversation
  // opens in for the first frame, and the fallback a deployment that answers no page leaves standing.
  if (outline === null) {
    return turns
      .filter((measured) => measured.anchorEntryId !== null)
      .map((measured) => ({
        entryId: measured.anchorEntryId!,
        anchor: "",
        preview: measured.preview,
        cursor: cursorOf(measured.anchorEntryId!) ?? Number.POSITIVE_INFINITY,
        loaded: true,
        turn: measured.turn,
      }));
  }

  const measuredByEntry = new Map<string, MeasuredTurn<TTurn>>();
  for (const measured of turns) {
    if (measured.anchorEntryId !== null) measuredByEntry.set(measured.anchorEntryId, measured);
  }
  const listed = new Set(outline.anchors.map((anchor) => anchor.entryId));
  const newestListed = outline.anchors.reduce((newest, anchor) => Math.max(newest, anchor.cursor), Number.NEGATIVE_INFINITY);

  const nodes: RailNode<TTurn>[] = outline.anchors.map((anchor) => {
    const measured = measuredByEntry.get(anchor.entryId);
    return {
      entryId: anchor.entryId,
      anchor: anchor.anchor,
      // A measured turn's own text is preferred over the page's preview: the reader is looking at the message, and the
      // two are the same committed text truncated at different places. Both are bounded — the server's preview by its
      // own byte rule, the measured one by the rail's preview clamp below.
      preview: measured?.preview ?? anchor.preview,
      cursor: anchor.cursor,
      loaded: measured !== undefined,
      turn: measured?.turn ?? null,
    };
  });

  // A measured turn the outline does not list is a node only when it is *newer* than everything the outline knows: the
  // reader's window sits at the tail, and a turn committed after the last page was read is newer than that page. Older
  // measured turns are the non-anchor turns the outline deliberately does not enumerate, and they stay inside their
  // surrounding turn.
  for (const measured of turns) {
    if (measured.anchorEntryId === null) continue;
    if (listed.has(measured.anchorEntryId)) continue;
    const cursor = cursorOf(measured.anchorEntryId);
    if (cursor === null || cursor <= newestListed) continue;
    nodes.push({
      entryId: measured.anchorEntryId,
      anchor: "",
      preview: measured.preview,
      cursor,
      loaded: true,
      turn: measured.turn,
    });
  }

  // Ordered by the server's cursor. A stable sort, so the appended tail keeps the transcript's own order.
  return nodes.sort((left, right) => left.cursor - right.cursor);
}

/**
 * How much of a preview the rail renders.
 *
 * The server already bounds a preview it issues (240 UTF-8 bytes), and the measured text a loaded node shows is the
 * message the reader can see anyway. This is the rail's own bound rather than a second contract: a preview is a hint
 * about a node, so one node may not push the whole history's text into the DOM.
 */
export const RAIL_PREVIEW_MAX_CHARS = 240;

/** One node's preview, bounded for display. */
export function railPreview(preview: string): string {
  const trimmed = preview.trim();
  return trimmed.length <= RAIL_PREVIEW_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, RAIL_PREVIEW_MAX_CHARS).trimEnd() + "…";
}
