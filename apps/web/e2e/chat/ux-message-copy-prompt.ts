/**
 * The prompt the copy seam is driven with, as the fixture renders it and the driver reads it.
 *
 * The preview is a truncation of the whole text, so a copy that wrote the preview is distinguishable from one that
 * wrote the original by its own contents rather than by a length.
 */
export const WHOLE_TEXT = "the whole prompt, restored from its read block";
export const INLINE_TEXT = "an inline tail block";
export const PREVIEW_TEXT = "the whole prompt…";
/** What a copy of the whole prompt writes: every text block, in the order the prompt holds them. */
export const COPIED_TEXT = WHOLE_TEXT + "\n" + INLINE_TEXT;
