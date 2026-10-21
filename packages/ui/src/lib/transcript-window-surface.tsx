"use client";

import type { ReactNode } from "react";
import type { TurnDescription } from "./chat-turn-model";
import type { WindowRange } from "./transcript-window";

/**
 * Render only the turns inside the window, keeping the rest of the transcript's height as spacers.
 *
 * The renderer receives one turn at a time and decides nothing about ranges; the caller's `renderTurn` is the
 * production renderer, so this component adds no second way to draw a transcript.
 */
export function TranscriptWindowSurface({
  turns,
  ranges,
  offsets,
  totalHeight,
  observe,
  renderTurn,
}: {
  turns: readonly TurnDescription[];
  ranges: WindowRange[];
  offsets: number[];
  totalHeight: number;
  observe: (key: string, element: HTMLElement | null) => void;
  renderTurn: (turn: TurnDescription) => ReactNode;
}): ReactNode {
  const blocks: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    if (range.start > cursor) {
      blocks.push(
        <div
          key={`window-spacer-${index}`}
          aria-hidden="true"
          data-window-spacer="between"
          style={{ height: Math.max(0, offsets[range.start] - offsets[cursor]) }}
        />,
      );
    }
    for (let position = range.start; position < range.end; position += 1) {
      // A range is an index pair over the transcript it was computed from, and the renderer is handed the transcript it
      // is rendering **now**: a transcript that shrank — a reload that re-baselined the window onto the committed
      // entries while the previous render still held a live turn — is one the stored range names a turn of. Rendering
      // only what the transcript it holds actually contains is what keeps the window a description of the transcript
      // rather than an assumption about it; the layout effect that recomputes the range then settles the geometry
      // before the browser paints.
      const turn = turns[position];
      if (turn === undefined) break;
      blocks.push(
        <div
          key={turn.key}
          // The observer identifies the turn it measured from this attribute: a ResizeObserver callback receives the
          // element, not the key, and reading the key from a closure would mean one observer per turn.
          data-turn-key={turn.key}
          data-window-turn={turn.key}
          ref={(element) => { observe(turn.key, element); }}
          // A formatting context, so the rendered turn's own margins are inside the box this element measures.
          // Otherwise they collapse out of it, every measurement is short by that gap, and the window's spacers are
          // wrong by more and more as the transcript grows.
          style={{ display: "flow-root" }}
        >
          {renderTurn(turn)}
        </div>,
      );
    }
    cursor = range.end;
  }
  if (cursor < turns.length) {
    blocks.push(
      <div
        key="window-spacer-tail"
        aria-hidden="true"
        data-window-spacer="tail"
        style={{ height: Math.max(0, totalHeight - offsets[cursor]) }}
      />,
    );
  }
  return <>{blocks}</>;
}
