import type { TurnDescription } from "./chat-turn-model";

/**
 * Which turn a message belongs to, and which message a turn starts at.
 *
 * A turn's key is derived from the entry that anchors it, and a windowed transcript mounts turn subtrees rather than
 * message wrappers, so "the turn containing this entry" and "the entry a turn is anchored on" are questions the
 * transcript asks in several places — saving where the reader was, restoring it, and resolving a minimap jump. They are
 * answered here, once, from the turn descriptions, so no caller re-derives a key by string-building it and no caller
 * assumes a positional correspondence between turns and anchors.
 *
 * The two directions are deliberately different questions:
 *
 * - {@link turnKeyForEntry} answers with the turn *containing* an entry, which is what a saved position needs: the
 *   reader was looking at a message, and the window mounts the turn around it.
 * - {@link turnAnchorEntryId} answers with the entry a turn is *anchored* on, which is what saving a position needs:
 *   the anchor is the identity that survives a prepend, and it exists even for a leading mid-turn segment (which has no
 *   anchor message of its own and starts at its first message instead).
 */

/** The entry a turn is identified by: its anchor, or — for a leading mid-turn segment — its first message. */
export function turnAnchorEntryId(
  turn: TurnDescription,
  entryIds: readonly (string | undefined)[],
): string | null {
  if (turn.anchorEntryId !== null) return turn.anchorEntryId;
  return entryIds[turn.startIndex] ?? null;
}

/** The turn containing an entry, by its key, or null when this window does not hold that entry. */
export function turnKeyForEntry(
  turns: readonly TurnDescription[],
  entryIds: readonly (string | undefined)[],
  entryId: string,
): string | null {
  const index = entryIds.indexOf(entryId);
  if (index < 0) return null;
  for (const turn of turns) {
    if (index >= turn.startIndex && index < turn.endIndex) return turn.key;
  }
  return null;
}

/**
 * The turn anchored on an entry, by its key, or null.
 *
 * A turn's key is `turn-<anchor entry id>`, but the key is read from the description rather than rebuilt: a leading
 * mid-turn segment is keyed on a message index, and a caller that assumed the `turn-` prefix always names an entry
 * would look for a turn that does not exist.
 */
export function turnKeyForAnchorEntry(
  turns: readonly TurnDescription[],
  entryIds: readonly (string | undefined)[],
  entryId: string,
): string | null {
  for (const turn of turns) {
    if (turnAnchorEntryId(turn, entryIds) === entryId) return turn.key;
  }
  return null;
}

/** The turn with this key, or null. */
export function turnByKey(
  turns: readonly TurnDescription[],
  key: string,
): TurnDescription | null {
  return turns.find((turn) => turn.key === key) ?? null;
}
