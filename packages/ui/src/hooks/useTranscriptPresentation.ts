import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CHAT_SCROLL_REATTACH_TOLERANCE,
  CHAT_SCROLL_TAIL_TOLERANCE,
  getLiveFollowAttached,
  getPromptAnchorSpacerHeight,
  shouldShowScrollToLatest,
} from "../lib/chat/chat-lazy-load";

/**
 * The transcript's presentation: where the reader is, what follows the live tail, and where the reader's own prompt
 * sits — and nothing about what the transcript contains.
 *
 * It is a module of its own because the two halves of "the transcript" were mixed: the conversation session decided
 * what the surface shows, and then reached into the DOM to scroll it, hold a countdown, and re-measure a spacer. What
 * lives here instead is the presentation half, and all of it is DOM:
 *
 * - **the viewport** — the scrolling element, whether the reader is following its tail, how tall the content is, and
 *   the scroll it is asked to perform. A live turn that arrives does not pull a reader who has scrolled back, and one
 *   who returns to the tail is re-attached within the tolerance the tail itself uses (acceptance C6).
 * - **the reader's own prompt** — the box the surface follows when *this* reader sends a turn, and the spacer that
 *   keeps that prompt at the top of the viewport while its answer streams in.
 * - **the scroll-intent debt** — "the reader's own turn was just staged, follow it" and "the surface asked for this
 *   element, place it". Both are decisions about the viewport, and both are taken here rather than in the session.
 *
 * What it deliberately does not own: which pages of history are loaded (the conversation's readout), which turns are
 * mounted (the window), and where a restored reading position or a search hit lands (the surface, through
 * {@link TranscriptPresentation.scrollTo}). Every scroll it performs states itself to the window through
 * `adoptScrollPosition`, so the window treats a placement this module made as the baseline instead of correcting it a
 * second time by the same geometry correction.
 */
export type TranscriptPresentation = {
  /** Whether the reader is away from the tail far enough that "jump to the latest" should be offered. */
  readonly showScrollToBottom: boolean;
  /** Whether the surface owes the reader's prompt its place at the top of the viewport while a run is live. */
  readonly promptAnchorActive: boolean;
  /**
   * The transcript's own boxes, as callback refs.
   *
   * `content` is the box the mounted turns live in, `spacer` the element after them that gives the reader's prompt
   * room above the fold, and `lastPrompt` the box of the reader's own latest turn. They are attached by whoever renders
   * them; the measurements they feed are this module's.
   */
  readonly anchors: {
    readonly spacer: (element: HTMLDivElement | null) => void;
    readonly lastPrompt: (element: HTMLDivElement | null) => void;
  };
  /** Place one mounted element at the viewport's top. A placement the surface asked for, never a follow. */
  scrollTo(element: HTMLElement, viewportOffset?: number): void;
  /** Move to the transcript's end: the reader's own "latest", or the position a conversation opens at. */
  scrollToBottom(behavior?: ScrollBehavior): void;
  /** Put the reader's own latest prompt at the top of the viewport - the prompt-anchor adjustment. */
  scrollToLastPrompt(): void;
};

export type TranscriptPresentationInput = {
  /** The conversation on screen, or null for a fresh composer. */
  readonly conversationId: string | null;
  /** Whether a native run is in flight. The tail re-attaches itself only while work is arriving. */
  readonly busy: boolean;
  /** How many turns this surface itself has sent: a send is what owes the reader's own prompt its place. */
  readonly ownSends: number;
  /** Messages the transcript holds now. Growth is what a follow moves on. */
  readonly messageCount: number;
  /** Messages are still being read: the viewport is not listened to while the transcript has no content. */
  readonly loading: boolean;
  /** The transcript's scrolling element, or null before it is mounted (a read failure has none). */
  readonly scrollElement: HTMLDivElement | null;
  /** The streaming message, whose growth re-measures the prompt anchor's spacer. */
  readonly streamingMessage: unknown;
  /** Open at the reader's saved position instead of the live tail, so the first transcript change does not follow. */
  readonly deferInitialScroll: boolean;
  /** The window's own "the caller moved the reader" signal, applied before every placement this module performs. */
  readonly adoptScrollPosition?: () => void;
};

export function useTranscriptPresentation(input: TranscriptPresentationInput): TranscriptPresentation {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  /**
   * Whether the reader has been placed at all.
   *
   * It starts **true** when the surface is deferring to a saved position: that position is about to put the reader
   * somewhere they were, and a scroll to the tail here would be the one thing restoring must not do. Every other open
   * starts false, so the first transcript that arrives places its reader at the live end (acceptance C6).
   */
  const initialScrollDoneRef = useRef(input.deferInitialScroll);
  const lastPromptRef = useRef<HTMLDivElement | null>(null);
  const pendingPromptScrollRef = useRef(false);
  /**
   * Whether the reader is following the live edge.
   *
   * It starts at the tail for a conversation opened fresh, because that is where such a reader is. It starts **false**
   * when the surface is deferring the initial scroll to restore a saved position, and that is not a detail: "following
   * the tail" is a fact about where the reader actually is, and a restore is about to put them somewhere else. A
   * default of true means the first transcript change follows the tail — a jump away from the position being restored,
   * which is the one thing restoring must not do. The scroll handler below establishes the real attachment from the
   * position as soon as there is one.
   */
  const isNearBottomRef = useRef(!input.deferInitialScroll);
  const previousScrollTopRef = useRef(0);
  /** A frame a follow scheduled, so a scroll this module decided does not cascade into another one. */
  const liveFollowFrameRef = useRef<number | null>(null);

  const spacerRef = useRef<HTMLDivElement | null>(null);
  const spacerHeightRef = useRef(0);
  const spacerMeasureFrameRef = useRef<number | null>(null);
  const spacerAdjustedRef = useRef(false);
  const spacerUpdateRef = useRef<(() => void) | null>(null);

  const adoptScrollPosition = input.adoptScrollPosition;
  const container = input.scrollElement;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (container === null) return;
    // Scroll the chat container itself instead of scrolling a sentinel element into view: that propagates to every
    // scrollable ancestor, and on mobile the keyboard-shifted document layer visibly jumps the whole app while
    // streaming content follows the tail.
    container.scrollTo({ top: container.scrollHeight, behavior });
    previousScrollTopRef.current = container.scrollTop;
  }, [container]);

  const scrollTo = useCallback((element: HTMLElement, viewportOffset = 16) => {
    if (container === null) return;
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    // A placement is this surface's own decision about the viewport, so it is stated to the window as the baseline the
    // next geometry comparison starts from rather than corrected afterwards.
    adoptScrollPosition?.();
    initialScrollDoneRef.current = true;
    pendingPromptScrollRef.current = false;
    isNearBottomRef.current = false;
    setPromptAnchorActive(false);
    container.scrollTo({
      top: element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - viewportOffset,
      behavior: "instant",
    });
    previousScrollTopRef.current = container.scrollTop;
  }, [adoptScrollPosition, container]);

  const scrollToLastPrompt = useCallback(() => {
    const prompt = lastPromptRef.current;
    if (container === null || prompt === null) return;
    const promptTop = prompt.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const target = Math.min(Math.max(0, promptTop - 16), maxScrollTop);
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    isNearBottomRef.current = true;
    previousScrollTopRef.current = target;
    container.scrollTo({ top: target, behavior: "auto" });
  }, [container]);

  // The reader's own scrolling, read from the element: following the tail is a fact about the position, and returning
  // to it re-attaches.
  useEffect(() => {
    if (container === null) return;
    previousScrollTopRef.current = container.scrollTop;
    const onChange = () => {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const wasAttached = isNearBottomRef.current;
      const isAttached = getLiveFollowAttached(
        wasAttached,
        previousScrollTopRef.current,
        scrollTop,
        clientHeight,
        scrollHeight,
        input.busy ? CHAT_SCROLL_REATTACH_TOLERANCE : CHAT_SCROLL_TAIL_TOLERANCE,
      );
      isNearBottomRef.current = isAttached;
      previousScrollTopRef.current = scrollTop;
      const shouldShow = shouldShowScrollToLatest(scrollTop, clientHeight, scrollHeight);
      setShowScrollToBottom((previous) => (previous === shouldShow ? previous : shouldShow));
      if (!wasAttached && isAttached && input.busy) {
        scrollToBottom("auto");
      } else if (!isAttached && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    };
    container.addEventListener("scroll", onChange, { passive: true });
    return () => container.removeEventListener("scroll", onChange);
  }, [container, input.busy, input.loading, input.messageCount, scrollToBottom]);

  // A send of this reader's own is what the viewport owes: the prompt it staged is followed once the transcript holds
  // it, which is the turn the reader is waiting to watch. The counter is the conversation's own statement that a turn
  // was staged; the debt it creates is the viewport's.
  const ownSendsRef = useRef(input.ownSends);
  useEffect(() => {
    if (input.ownSends === ownSendsRef.current) return;
    ownSendsRef.current = input.ownSends;
    pendingPromptScrollRef.current = true;
    setPromptAnchorActive(true);
  }, [input.ownSends]);

  // The run's own end retires the prompt anchor: there is no arriving answer left for it to hold a place for.
  useEffect(() => {
    if (!input.busy) setPromptAnchorActive(false);
  }, [input.busy]);

  useLayoutEffect(() => {
    // Nothing is placed before there is a transcript to place: a read failure has no scrolling element, and marking the
    // placement done against it would leave the reader of the recovered transcript at its top.
    if (container === null || input.messageCount === 0) return;
    if (pendingPromptScrollRef.current) {
      pendingPromptScrollRef.current = false;
      initialScrollDoneRef.current = true;
      scrollToLastPrompt();
    } else if (!initialScrollDoneRef.current) {
      // The reader has not been placed yet: a conversation opens at its live end, which is where its reader is.
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
    } else if (!input.busy && isNearBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [container, input.busy, input.messageCount, scrollToBottom, scrollToLastPrompt]);

  /**
   * The prompt anchor: a spacer after the transcript that gives the reader's own prompt room to sit at the top of the
   * viewport while its answer streams in, so the answer grows below the prompt instead of pushing it off screen.
   *
   * It is measured from the three boxes it is about — the viewport, the content and the prompt — and re-measured when
   * any of them changes size, because a streaming answer changes the height the spacer has to make up.
   */
  useLayoutEffect(() => {
    const spacer = spacerRef.current;
    const prompt = lastPromptRef.current;
    if (!input.busy || !promptAnchorActive || container === null || prompt === null || spacer === null) {
      spacerUpdateRef.current = null;
      spacerHeightRef.current = 0;
      spacerAdjustedRef.current = false;
      if (spacer !== null) spacer.style.height = "";
      return;
    }

    let disposed = false;
    const update = () => {
      if (disposed || lastPromptRef.current !== prompt || spacerRef.current !== spacer) return;
      const containerTop = container.getBoundingClientRect().top;
      const promptTop = prompt.getBoundingClientRect().top - containerTop + container.scrollTop;
      const targetTop = Math.max(0, promptTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top - containerTop + container.scrollTop;
      const nextHeight = getPromptAnchorSpacerHeight(targetTop, contentEnd, container.clientHeight);

      const isInitialMeasurement = !spacerAdjustedRef.current;
      const needsInitialAdjustment = isInitialMeasurement && nextHeight > 0;
      if (isInitialMeasurement) spacerAdjustedRef.current = true;
      if (nextHeight === spacerHeightRef.current) return;

      spacerHeightRef.current = nextHeight;
      spacer.style.height = nextHeight > 0 ? nextHeight + "px" : "";
      if (needsInitialAdjustment) scrollToLastPrompt();
    };

    spacerUpdateRef.current = update;
    const measureOnFrame = () => {
      if (disposed || spacerMeasureFrameRef.current !== null) return;
      spacerMeasureFrameRef.current = requestAnimationFrame(() => {
        spacerMeasureFrameRef.current = null;
        update();
      });
    };

    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOnFrame);
    observer?.observe(container);
    observer?.observe(prompt);
    return () => {
      disposed = true;
      if (spacerUpdateRef.current === update) spacerUpdateRef.current = null;
      observer?.disconnect();
      if (spacerMeasureFrameRef.current !== null) {
        cancelAnimationFrame(spacerMeasureFrameRef.current);
        spacerMeasureFrameRef.current = null;
      }
    };
  }, [container, input.busy, input.messageCount, promptAnchorActive, scrollToLastPrompt]);

  // A streaming chunk is the transcript growing without a new message: the spacer's height is re-measured from it.
  useLayoutEffect(() => {
    spacerUpdateRef.current?.();
  }, [input.streamingMessage]);

  const anchorsRef = useRef({
    spacer: (element: HTMLDivElement | null) => { spacerRef.current = element; },
    lastPrompt: (element: HTMLDivElement | null) => { lastPromptRef.current = element; },
  });

  const anchors = anchorsRef.current;
  // The surface reads this every render, so its identity follows only the two facts it renders. Everything that moves
  // the viewport is a stable callback, which is what lets an effect depend on the scroll it performs rather than on the
  // whole object: a fresh identity per render would restart a settlement's own scroll on every geometry change.
  return useMemo(
    () => ({ showScrollToBottom, promptAnchorActive, anchors, scrollTo, scrollToBottom, scrollToLastPrompt }),
    [anchors, promptAnchorActive, scrollTo, scrollToBottom, scrollToLastPrompt, showScrollToBottom],
  );
}
