"use client";

/**
 * Inline glyphs for the per-response token footer.
 *
 * Paths are copied verbatim from lucide-icons/lucide tag `1.54.0` (commit
 * a04f228cd01185e09c188b7227b9600c08c565ec):
 * https://raw.githubusercontent.com/lucide-icons/lucide/1.54.0/icons/arrow-up-from-line.svg
 * https://raw.githubusercontent.com/lucide-icons/lucide/1.54.0/icons/arrow-down-to-line.svg
 * https://raw.githubusercontent.com/lucide-icons/lucide/1.54.0/icons/hard-drive-upload.svg   (cache read)
 * https://raw.githubusercontent.com/lucide-icons/lucide/1.54.0/icons/hard-drive-download.svg (cache write)
 * Lucide's complete ISC license and Feather-derived notice are preserved in
 * ./lucide-icons.LICENSE.
 *
 * One family on one 24 grid at one stroke width, matching the copy button in
 * the same footer row (11px display, strokeWidth 1.8). Up is input and down is
 * output, the direction the aggregate session toolbar already uses; the cached
 * pair keeps that same up/down reading, so the four glyphs are told apart at
 * 11px without a tooltip. The family was compared at real footer size in both
 * themes; see the ticket's evidence.
 */

const GLYPH = {
  width: 11,
  height: 11,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** Input tokens: an arrow entering the model, up per the aggregate toolbar. */
export function TokenInputIcon() {
  return (
    <svg {...GLYPH}>
      <path d="m18 9-6-6-6 6" />
      <path d="M12 3v14" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** Output tokens: an arrow leaving the model, down per the aggregate toolbar. */
export function TokenOutputIcon() {
  return (
    <svg {...GLYPH}>
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </svg>
  );
}

/**
 * Cache-read tokens (lucide `hard-drive-upload`): the drive with an arrow
 * pointing up and away from it, the same up direction as input, because these
 * tokens arrive at the model from the cache.
 */
export function TokenCacheReadIcon() {
  return (
    <svg {...GLYPH}>
      <path d="m16 6-4-4-4 4" />
      <path d="M12 2v8" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 18h.01" />
      <path d="M10 18h.01" />
    </svg>
  );
}

/**
 * Cache-write tokens (lucide `hard-drive-download`): the same drive with an
 * arrow pointing down onto it, the same down direction as output, because these
 * tokens leave the model for the cache.
 */
export function TokenCacheWriteIcon() {
  return (
    <svg {...GLYPH}>
      <path d="M12 2v8" />
      <path d="m16 6-4 4-4-4" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 18h.01" />
      <path d="M10 18h.01" />
    </svg>
  );
}
