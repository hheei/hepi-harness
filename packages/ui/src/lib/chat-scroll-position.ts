export type ChatScrollPosition = (
  | { atBottom: true }
  | {
      atBottom: false;
      anchorEntryId: string;
      anchorOffset: number;
      oldestEntryId: string | null;
    }
) & {
  /** Expanded groups are part of the geometry the saved reading position describes. */
  processExpansion?: Readonly<Record<string, boolean>>;
};

export interface ChatScrollAnchorCandidate {
  entryId: string;
  top: number;
  bottom: number;
}

export function findChatScrollAnchor(
  candidates: ChatScrollAnchorCandidate[],
  viewportTop: number,
): (Pick<Extract<ChatScrollPosition, { atBottom: false }>, "anchorEntryId" | "anchorOffset"> & {
  /**
   * Which candidate won, so a caller that needs the winning *element* rather than its entry id does not have to
   * re-derive it. One entry can be on screen more than once — a turn renders its process group and its answer from
   * the same assistant message — and picking "the first candidate with this id" would then name the wrong box.
   */
  anchorIndex: number;
}) | null {
  let index = 0;
  for (let candidate = 0; candidate < candidates.length; candidate += 1) {
    if (candidates[candidate].top > viewportTop) break;
    index = candidate;
  }
  const candidate = candidates[index];
  if (!candidate) return null;
  return {
    anchorEntryId: candidate.entryId,
    anchorOffset: candidate.top - viewportTop,
    anchorIndex: index,
  };
}
