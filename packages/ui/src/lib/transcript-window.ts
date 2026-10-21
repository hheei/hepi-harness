"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TurnDescription } from "./chat-turn-model";

/**
 * The transcript's window: which turns are mounted, and how their heights are kept true.
 *
 * Ticket 09 selected this implementation over a virtual-list library, and this module is that decision carried into
 * production. It owns exactly one responsibility — the mounted range — and nothing else: the turn descriptions come
 * from `chat-turn-model`, the scrolling element from `useAgentSession`, the loaded history and its cursors from the
 * hook's own accepted-history facts, and what a turn looks like from the renderer. The window never reads a page of
 * history, never decides what a turn is and never touches scroll position, which is why the search, minimap, prepend
 * and live-tail behaviours keep their own owners.
 *
 * Two rules make it work with dynamic content:
 *
 *   1. **Heights are measured, not estimated once.** Every mounted turn is observed, so an image that finishes
 *      loading, a web font that swaps in, or a process group the reader expands changes the transcript's height and
 *      the window learns about it without the transcript re-rendering.
 *   2. **A measurement and the range it implies are one decision.** Measuring sets the height and then recomputes the
 *      range from the new heights in the same commit, so the spacers, the offsets and the mounted turns always
 *      describe the same geometry. A remembered height that arrives without the range following it is how a window
 *      ends up scrolling against a transcript it no longer matches.
 *
 * A turn's measured height is its box, and the surface's wrapper for each turn is a formatting context
 * (`display: flow-root`), so a turn's own margins are contained in the box that is measured. Without that the margins
 * of the rendered turn collapse out of the wrapper, the measurement is short by exactly that gap, and the error
 * accumulates across a long transcript until the window is scrolling against a height the document does not have.
 */

/** What a window needs to know about the scrolling element, read at one instant. */
export interface WindowViewport {
  scrollTop: number;
  clientHeight: number;
}

export interface WindowRange {
  start: number;
  end: number;
}

export interface TranscriptWindowInput {
  /** The complete turn descriptions, in order. */
  turns: readonly TurnDescription[];
  viewport: WindowViewport;
  /**
   * The turn the surface must include even though it is far outside the viewport, by stable key (a search hit, a
   * minimap jump). It is mounted as its own range, never by spanning the distance to it: the turns in between are
   * exactly the ones a window exists to keep unmounted.
   */
  revealKey?: string | null;
  overscan: number;
  /** Measured heights by turn key. A turn with no measurement yet uses the estimate. */
  heights?: Readonly<Record<string, number>>;
  estimatedTurnHeight?: number;
  /**
   * The transcript fits the viewport, so every turn is mounted. A window must never hide the only content there is;
   * this is a property of the transcript, not of the scroll position.
   */
  mountAll?: boolean;
}

export interface TranscriptWindow {
  /** The ranges to mount, in transcript order, non-overlapping and non-adjacent. */
  ranges: WindowRange[];
  /** Total transcript height from the measured heights plus the estimate for what is unmeasured. */
  totalHeight: number;
  /** The offset of each turn, so the renderer can place a spacer instead of the turns it omits. */
  offsets: number[];
}

export const DEFAULT_OVERSCAN = 4;
export const DEFAULT_ESTIMATED_TURN_HEIGHT = 320;

/** The height a turn is taken to have: its measurement, or the estimate until one exists. */
export function turnHeight(
  key: string,
  heights: Readonly<Record<string, number>> | undefined,
  estimated = DEFAULT_ESTIMATED_TURN_HEIGHT,
): number {
  const measured = heights?.[key];
  return measured !== undefined && measured > 0 ? measured : estimated;
}

/**
 * The ranges a window mounts, from the transcript, the viewport and the measured heights.
 *
 * The contiguous run covers the viewport plus overscan. A reveal adds the named turn as a second range instead of
 * extending the first, because extending is the cost a window exists to avoid. Adjacent or overlapping ranges are
 * merged so the renderer never emits a spacer of zero height between two ranges it mounts.
 */
export function computeWindowRanges(input: TranscriptWindowInput): TranscriptWindow {
  const { turns, viewport, overscan, heights, estimatedTurnHeight, revealKey, mountAll } = input;
  const offsets: number[] = [];
  let totalHeight = 0;
  for (const turn of turns) {
    offsets.push(totalHeight);
    totalHeight += turnHeight(turn.key, heights, estimatedTurnHeight);
  }
  if (turns.length === 0) return { ranges: [], totalHeight: 0, offsets: [] };
  // A transcript that fits the viewport is mounted whole: a window must never hide the only content there is, and
  // that is a property of the transcript rather than of the scroll position.
  if (mountAll === true || (viewport.clientHeight > 0 && totalHeight <= viewport.clientHeight)) {
    return { ranges: [{ start: 0, end: turns.length }], totalHeight, offsets };
  }

  const clientHeight = Math.max(0, viewport.clientHeight);
  // The scroll position is clamped to what the transcript can actually scroll: a reader at the tail reports the end of
  // the content, and a position past it (a spacer measured before a shrink) must not move the window off the turns
  // that are on screen.
  const maxScrollTop = Math.max(0, totalHeight - clientHeight);
  const viewportTop = Math.min(Math.max(0, viewport.scrollTop), maxScrollTop);
  const viewportBottom = viewportTop + clientHeight;

  // The first turn whose bottom edge is below the viewport's top, and the first whose top edge is below the
  // viewport's bottom: the run between them is what the viewport shows.
  let start = 0;
  while (start < turns.length && offsets[start] + turnHeight(turns[start].key, heights, estimatedTurnHeight) <= viewportTop) {
    start += 1;
  }
  let end = start;
  while (end < turns.length && offsets[end] < viewportBottom) {
    end += 1;
  }
  if (end === start) end = Math.min(turns.length, start + 1);

  const revealIndex = revealKey === null || revealKey === undefined
    ? -1
    : turns.findIndex((turn) => turn.key === revealKey);

  const raw: WindowRange[] = [{
    start: Math.max(0, start - overscan),
    end: Math.min(turns.length, end + overscan),
  }];
  if (revealIndex >= 0 && (revealIndex < raw[0].start || revealIndex >= raw[0].end)) {
    raw.push({ start: revealIndex, end: revealIndex + 1 });
  }

  raw.sort((a, b) => a.start - b.start);
  const ranges: WindowRange[] = [];
  for (const range of raw) {
    const previous = ranges[ranges.length - 1];
    // Adjacent ranges would render a zero-height spacer between them; one range says the same thing.
    if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else ranges.push({ ...range });
  }
  return { ranges, totalHeight, offsets };
}

/**
 * The heights of the turns on screen, kept true while they are mounted.
 *
 * One observer for the whole window rather than one per turn: a resize is a property of the turn being drawn, and a
 * single callback that maps an element back to its key costs one observer and keeps the "measurement then recompute"
 * order in one place. Elements are re-observed as the mounted set changes and dropped when they unmount, so the
 * observer never holds a detached node.
 */
export function useTurnHeights(): {
  heights: Record<string, number>;
  /** Attach a mounted turn's element; `null` on unmount. */
  observe: (key: string, element: HTMLElement | null) => void;
  /** The measurement epoch: bumped when a height changes, for callers that recompute from heights. */
  revision: number;
} {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [revision, setRevision] = useState(0);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  // The heights are also read synchronously by the observer callback, which runs outside React's render: a ref keeps
  // the callback from needing the state it is about to set.
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const ensureObserver = useCallback(() => {
    if (observerRef.current !== null || typeof ResizeObserver === "undefined") return observerRef.current;
    observerRef.current = new ResizeObserver((entries) => {
      let changed = false;
      const next = { ...heightsRef.current };
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.turnKey;
        if (key === undefined) continue;
        // A collapsed-to-zero turn is unmounting, not becoming invisible; keeping its last real height is what stops
        // the spacer under it from jumping when it comes back.
        const height = (entry.target as HTMLElement).getBoundingClientRect().height;
        if (height <= 0) continue;
        const rounded = Math.round(height);
        if (next[key] === rounded) continue;
        next[key] = rounded;
        changed = true;
      }
      if (!changed) return;
      heightsRef.current = next;
      setHeights(next);
      setRevision((previous) => previous + 1);
    });
    return observerRef.current;
  }, []);

  const observe = useCallback((key: string, element: HTMLElement | null) => {
    const observer = ensureObserver();
    const previous = elementsRef.current.get(key);
    if (previous === element) return;
    if (previous !== undefined) {
      observer?.unobserve(previous);
      elementsRef.current.delete(key);
    }
    if (element === null) return;
    elementsRef.current.set(key, element);
    observer?.observe(element);
    // The first measurement of a newly mounted turn is taken here: the observer only reports *changes*, and a turn
    // mounted at its final height would otherwise keep the estimate until something moved.
    const height = element.getBoundingClientRect().height;
    if (height <= 0) return;
    const rounded = Math.round(height);
    if (heightsRef.current[key] === rounded) return;
    const next = { ...heightsRef.current, [key]: rounded };
    heightsRef.current = next;
    setHeights(next);
    setRevision((previousRevision) => previousRevision + 1);
  }, [ensureObserver]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementsRef.current.clear();
  }, []);

  return { heights, observe, revision };
}

/**
 * Where the reader ends up after the transcript's geometry above them changed.
 *
 * Two things move the turns on screen without the reader asking: a page of older history is inserted in front of the
 * transcript, and a turn above the reader gets taller (an image finished decoding, a web font swapped in, a process
 * group was expanded). Both are the same question — the turns below moved down by a known amount, and the reader
 * should not be dragged with them — so both are answered by the same rule.
 *
 * The anchor is the turn containing the viewport's top edge, found by **key** rather than by index: inserting turns in
 * front renumbers every index, and the reader's turn must still be the one that is meant. The adjustment is that
 * turn's own change of offset. A turn that grows *at or below* the anchor does not move the anchor, so nothing is
 * adjusted there, and the live tail's growth is left to the tail-follow behaviour that owns it.
 *
 * A transcript whose anchor is no longer present (a compaction re-baselined it, a branch switch replaced it) is not
 * adjusted at all: guessing there would move the reader somewhere the surface never chose.
 */
export function anchorScrollAdjustment(input: {
  previousTurns: readonly { key: string }[];
  previousOffsets: readonly number[];
  nextTurns: readonly { key: string }[];
  nextOffsets: readonly number[];
  scrollTop: number;
}): number {
  const { previousTurns, previousOffsets, nextTurns, nextOffsets, scrollTop } = input;
  if (previousTurns.length === 0 || nextTurns.length === 0) return scrollTop;
  // The turn the viewport's top edge is inside: the last one that starts at or above it.
  let anchorKey: string | null = null;
  for (let index = 0; index < previousTurns.length; index += 1) {
    if (previousOffsets[index] <= scrollTop) anchorKey = previousTurns[index].key;
    else break;
  }
  if (anchorKey === null) anchorKey = previousTurns[0].key;
  const nextIndex = nextTurns.findIndex((turn) => turn.key === anchorKey);
  const previousIndex = previousTurns.findIndex((turn) => turn.key === anchorKey);
  if (nextIndex < 0 || previousIndex < 0) return scrollTop;
  const delta = nextOffsets[nextIndex] - previousOffsets[previousIndex];
  return scrollTop + delta;
}

/** The reader is at the transcript's end, within the tolerance the live-follow behaviour itself uses. */
function atTranscriptEnd(element: HTMLElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
}

export interface TranscriptWindowState {
  ranges: WindowRange[];
  offsets: number[];
  totalHeight: number;
  /** Attach a mounted turn's element; `null` on unmount. */
  observe: (key: string, element: HTMLElement | null) => void;
  /**
   * The reveal is no longer doing anything: the turn it named is inside the range the viewport alone would mount, so
   * holding it as a separate range adds nothing. The caller clears its reveal request when this turns true, which is
   * what keeps a reveal a *request* rather than a permanent extra mount.
   */
  revealSettled: boolean;
  /**
   * Tell the window that **the caller** has just set the scroll position, so the next recompute adopts it as the
   * baseline instead of correcting it.
   *
   * The two are otherwise indistinguishable and both happen at once: a caller restoring a reading position scrolls to
   * a position it computed from the geometry that is on screen *now*, while the window still holds the geometry from
   * before the transcript changed and applies the prepend correction for it. The reader's turn is then moved twice —
   * once by the caller's own scroll and once by a correction for a change the caller had already accounted for — and
   * lands away from the position that was asked for.
   *
   * It is a method rather than a prop because it has to arrive **before the scroll it describes is handled**: the
   * element's own `scroll` event recomputes the window, and that happens before React re-renders with any new prop, so
   * a state-based signal is always read one step too late and the correction lands anyway.
   */
  adoptScrollPosition: () => void;
}

/**
 * The window: which turns are mounted, from the transcript, the scrolling element and the measured heights.
 *
 * Measurement, the anchor and the range are **one decision taken in one place**, and that is the point of this hook
 * rather than a set of pieces the caller assembles. The order matters and is not recoverable from outside:
 *
 *   1. The heights of what is mounted are read.
 *   2. If the geometry above the reader changed — a page inserted in front, a turn above them grown — the scroll
 *      position is corrected *first*, so the reader's turn is still the turn at the top of the viewport.
 *   3. The range is computed from the corrected position.
 *
 * Doing (3) before (2) is the bug this shape exists to prevent: the range would be chosen for a scroll position the
 * reader is about to leave, and the turn the anchor names would be unmounted by the very render that was supposed to
 * hold it in place. The correction is applied to the element and the range is computed from what the element now
 * reports, so the turns that are mounted are always the turns the corrected position shows.
 *
 * A reader at the transcript's end is not anchored: following the live tail is that behaviour's decision, and an
 * adjustment there would fight it.
 */
export function useTranscriptWindow({
  turns,
  scrollElement,
  revealKey,
  overscan = DEFAULT_OVERSCAN,
  estimatedTurnHeight = DEFAULT_ESTIMATED_TURN_HEIGHT,
}: {
  turns: readonly TurnDescription[];
  scrollElement: HTMLElement | null;
  /** A turn the surface must include even though it is far outside the viewport, by stable key. */
  revealKey?: string | null;
  overscan?: number;
  estimatedTurnHeight?: number;
}): TranscriptWindowState {
  const { heights, observe, revision } = useTurnHeights();
  const [layout, setLayout] = useState<Omit<TranscriptWindowState, "observe" | "revealSettled" | "adoptScrollPosition">>(() => ({
    ranges: [{ start: 0, end: 0 }],
    offsets: [],
    totalHeight: 0,
  }));
  const [revealSettled, setRevealSettled] = useState(false);
  // The geometry the last computed range was built from, so a later change can be measured against it.
  const previousRef = useRef<{ turns: readonly TurnDescription[]; offsets: readonly number[] } | null>(null);
  /** Set by {@link TranscriptWindowState.adoptScrollPosition}, and consumed by the recompute it precedes. */
  const adoptRef = useRef(false);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;
  /**
   * A scroll position to apply once the new spacers are in the DOM.
   *
   * It cannot be set where it is computed: the spacers that give the transcript its new height are committed by the
   * render this decision causes, and until they are, the browser clamps the position to the *old* height. The
   * correction is therefore recorded here and applied by the layout effect below, which runs after that commit.
   */
  const pendingScrollTopRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    if (scrollElement === null) return;
    const previous = previousRef.current;
    const measured = heightsRef.current;
    const clientHeight = scrollElement.clientHeight;
    const scrollTop = scrollElement.scrollTop;
    const next = computeWindowRanges({
      turns,
      viewport: { scrollTop, clientHeight },
      overscan,
      heights: measured,
      estimatedTurnHeight,
      revealKey,
    });
    // The geometry above the reader changed (a page inserted in front, a turn above them grown): the position the
    // range must describe is the corrected one, not the one the element still reports.
    let target = scrollTop;
    // The caller has just placed the reader itself: its position was computed from the geometry on screen now, so it
    // is already correct and the prepend correction would move it a second time.
    const adopting = adoptRef.current;
    adoptRef.current = false;
    if (!adopting && previous !== null && !atTranscriptEnd(scrollElement)) {
      target = anchorScrollAdjustment({
        previousTurns: previous.turns,
        previousOffsets: previous.offsets,
        nextTurns: turns,
        nextOffsets: next.offsets,
        scrollTop,
      });
    }
    const settled = target === scrollTop ? next : computeWindowRanges({
      turns,
      viewport: { scrollTop: target, clientHeight },
      overscan,
      heights: measured,
      estimatedTurnHeight,
      revealKey,
    });
    if (target !== scrollTop) pendingScrollTopRef.current = target;
    // An adopted position is a **new baseline**, not a correction to apply. The geometry that produced the caller's
    // position is what the next recompute must be measured against — otherwise the next one (the transcript growing as
    // the restore's own pages land) compares the new layout to a layout from before the caller moved the reader, and
    // "the turn at the viewport's top" is then a different turn entirely, moving the reader by the whole distance
    // between them. Clearing the baseline makes that recompute establish geometry instead of correcting it.
    previousRef.current = adopting ? null : { turns, offsets: settled.offsets };
    setLayout((current) => (
      current.totalHeight === settled.totalHeight
        && current.ranges.length === settled.ranges.length
        && current.ranges.every((range, index) => range.start === settled.ranges[index].start && range.end === settled.ranges[index].end)
        && current.offsets.length === settled.offsets.length
        && current.offsets.every((offset, index) => offset === settled.offsets[index])
        ? current
        : { ranges: settled.ranges, offsets: settled.offsets, totalHeight: settled.totalHeight }
    ));
    // The reveal has done its work once the viewport alone would mount the turn: the caller can drop the request, and
    // the turn stays mounted because the reader is now looking at it.
    if (revealKey !== null && revealKey !== undefined) {
      const viewportOnly = computeWindowRanges({
        turns,
        viewport: { scrollTop: target, clientHeight },
        overscan,
        heights: measured,
        estimatedTurnHeight,
      });
      const revealIndex = turns.findIndex((turn) => turn.key === revealKey);
      setRevealSettled(revealIndex >= 0 && viewportOnly.ranges.some(
        (range) => revealIndex >= range.start && revealIndex < range.end,
      ));
    } else {
      setRevealSettled(false);
    }
  }, [estimatedTurnHeight, overscan, revealKey, scrollElement, turns]);

  /** A caller's new position supersedes corrections queued against the previous position. */
  const adoptScrollPosition = useCallback(() => {
    pendingScrollTopRef.current = null;
    adoptRef.current = true;
  }, []);

  // Apply the correction after the spacers it depends on are in the DOM.
  useLayoutEffect(() => {
    const pending = pendingScrollTopRef.current;
    if (pending === null || scrollElement === null) return;
    pendingScrollTopRef.current = null;
    if (scrollElement.scrollTop !== pending) scrollElement.scrollTop = pending;
  }, [layout, scrollElement]);

  // The first geometry, every measurement, and every new transcript: recompute in a layout effect so the range is
  // settled before the browser paints.
  useLayoutEffect(() => { recompute(); }, [recompute, revision]);

  // Scrolling is the reader's own movement, so it is never corrected — only the range follows it.
  useEffect(() => {
    if (scrollElement === null) return;
    const onScroll = () => recompute();
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    observer?.observe(scrollElement);
    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [recompute, scrollElement]);

  return {
    ranges: layout.ranges,
    offsets: layout.offsets,
    totalHeight: layout.totalHeight,
    observe,
    revealSettled,
    adoptScrollPosition,
  };
}
