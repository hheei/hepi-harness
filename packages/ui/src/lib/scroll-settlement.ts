/**
 * Bringing a scroll target to its alignment, once, without fighting the reader.
 *
 * A windowed transcript mounts a turn on estimated heights and then measures it, so a scroll issued the moment the
 * target appears is computed against geometry that is about to change; the target moves again underneath it and the
 * reader is left looking somewhere else. The answer is to keep bringing the target to its alignment while the
 * geometry settles — but that answer has two failure modes of its own, and both of them are the reason this is a
 * module with a stated end rather than a loop someone wrote inline:
 *
 * 1. **Requiring the whole target to fit.** A block taller than the viewport can never be inside it, so a target that
 *    must be fully contained is never satisfied: a long answer the reader searched for would be scrolled every frame
 *    forever, and the reader could not scroll away from it because each frame would pull them back. Arrival is
 *    therefore **visible and aligned** — the target's start is at the alignment and some of it is on screen — which is
 *    reachable for a target of any height.
 * 2. **Never giving up.** The settlement is finite: it runs for at most {@link SETTLE_MAX_FRAMES} frames, it finishes
 *    early once the target has held its alignment for {@link SETTLE_STABLE_FRAMES} frames, and it abandons itself the
 *    moment the reader scrolls. An abandoned settlement is not a failed one — the target is on screen and the reader
 *    has taken over — so the caller is told which of the two happened rather than being left to guess.
 *
 * "The reader scrolled" is read from the reader's **own input** (a wheel, a touch, a drag of the scrollbar, a scroll
 * key), never from the scroll position changing. That distinction is the whole reason this is stated as an interface:
 * a windowed transcript corrects the scroll position itself when the geometry above the reader changes — a page
 * prepended, a turn above them measured for the first time — and a settlement that treated those corrections as the
 * reader's movement would abandon itself the moment the page it just waited for was measured, leaving the target it
 * was bringing into view wherever the correction put it.
 *
 * One settlement is active per surface at a time: starting another cancels the first, so two navigations cannot take
 * turns scrolling against each other.
 */

/** Where a target's start is placed, in viewport pixels from the container's top. */
export const SETTLE_VIEWPORT_OFFSET = 16;
/** How close to the alignment the target's start must be for it to count as arrived. */
export const SETTLE_TOLERANCE = 8;
/** Consecutive frames the target must hold its alignment before the settlement is done. */
export const SETTLE_STABLE_FRAMES = 5;
/** Frames a settlement may run for, so geometry that never settles cannot scroll forever. */
export const SETTLE_MAX_FRAMES = 240;

/** The geometry a settlement reads. Both boxes are viewport-relative, as `getBoundingClientRect` returns them. */
export interface SettleBox {
  top: number;
  bottom: number;
}

export interface SettleContainer {
  scrollTop: number;
  clientHeight: number;
  getBoundingClientRect(): SettleBox;
}

export interface SettleTargetElement {
  getBoundingClientRect(): SettleBox;
}

/**
 * Whether the target has arrived: it is visible, and its start has been brought to the alignment.
 *
 * Containment is deliberately not required. A target taller than the viewport is *at* its alignment with most of itself
 * below the fold, and that is the only position a reader can be given for it.
 */
export function isSettledOnTarget(
  target: SettleBox,
  container: SettleBox,
  clientHeight: number,
  viewportOffset = SETTLE_VIEWPORT_OFFSET,
  tolerance = SETTLE_TOLERANCE,
): boolean {
  const top = target.top - container.top;
  const bottom = target.bottom - container.top;
  if (bottom <= 0) return false;
  if (top > clientHeight) return false;
  return top <= viewportOffset + tolerance;
}

/**
 * Why a settlement stopped without arriving.
 *
 * The caller's own behaviour differs per reason, which is why they are named rather than collapsed into "abandoned":
 * the reader taking over means the navigation is *over* (they are looking where they chose, and the request must not
 * stay pending — a pending reveal is a permanently mounted turn), while a target that is not mounted means the
 * navigation is merely waiting (the surface's own reveal will bring it, and the settlement can start again).
 */
export type SettlementAbandonReason =
  /** The reader scrolled: their position stands and the navigation is finished. */
  | "reader"
  /** The target left the window, or never appeared: the navigation is still waiting for it. */
  | "unmounted"
  /** The geometry never settled within the frame budget: the navigation is finished where it got to. */
  | "timeout";

export interface ScrollSettlementHandle {
  /**
   * Stop the settlement. It is not an error to cancel one: a navigation that is replaced, or a surface that unmounts,
   * cancels the settlement it started.
   */
  cancel(): void;
}

export interface ScrollSettlementOptions {
  container: SettleContainer;
  /** The element to settle on, re-read every frame: the window may unmount and remount it. */
  target: () => SettleTargetElement | null;
  /** Bring the target to its alignment. The caller owns *how* the scroll happens. */
  scrollTo: (element: SettleTargetElement) => void;
  /** The target held its alignment for long enough: the navigation is complete. */
  onSettled: () => void;
  /** The settlement stopped without arriving, for the reason given. */
  onAbandoned: (reason: SettlementAbandonReason) => void;
  viewportOffset?: number;
  /**
   * Report the reader's own scrolling gestures, and return a function that stops reporting them. Only the reader's
   * input counts: the surface's own scroll corrections are not the reader taking over.
   */
  onReaderIntent?: (listener: () => void) => () => void;
  /** Injected for tests; the browser's own frame scheduling by default. */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  maxFrames?: number;
  stableFrames?: number;
}

/**
 * Settle a scroll target, reporting whether it arrived.
 *
 * Each frame: the reader's own movement is checked first (a scroll position that changed without this settlement
 * writing it means they have taken over, and the settlement stops rather than pulling them back), then the target's
 * alignment is measured, and the scroll is issued only while it is not yet aligned.
 */
export function startScrollSettlement(options: ScrollSettlementOptions): ScrollSettlementHandle {
  const {
    container,
    target,
    scrollTo,
    onSettled,
    onAbandoned,
    viewportOffset = SETTLE_VIEWPORT_OFFSET,
    onReaderIntent,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
    maxFrames = SETTLE_MAX_FRAMES,
    stableFrames = SETTLE_STABLE_FRAMES,
  } = options;

  let frame = 0;
  let stable = 0;
  let done = false;
  /** Frames this settlement may still run for, so geometry that never settles cannot scroll forever. */
  let remaining = maxFrames;
  let unsubscribe: (() => void) | null = null;

  const stop = (arrived: boolean, reason: SettlementAbandonReason = "unmounted") => {
    if (done) return;
    done = true;
    cancelFrame(frame);
    unsubscribe?.();
    unsubscribe = null;
    if (arrived) onSettled();
    else onAbandoned(reason);
  };

  // The reader's own gesture ends the settlement. It is subscribed before the first frame, so a gesture that arrives
  // between two frames is never missed.
  unsubscribe = onReaderIntent?.(() => stop(false, "reader")) ?? null;

  const step = () => {
    if (done) return;
    frame = 0;
    const element = target();
    if (element === null) {
      // The target is not mounted (the window moved). This is not an arrival, and not a reason to scroll anywhere:
      // the caller's own reveal keeps asking for it, and a settlement can be started again when it appears.
      stop(false, "unmounted");
      return;
    }
    if (isSettledOnTarget(element.getBoundingClientRect(), container.getBoundingClientRect(), container.clientHeight, viewportOffset)) {
      stable += 1;
      if (stable >= stableFrames) {
        stop(true);
        return;
      }
    } else {
      stable = 0;
      scrollTo(element);
    }
    remaining -= 1;
    if (remaining <= 0) {
      stop(false, "timeout");
      return;
    }
    frame = requestFrame(step);
  };

  frame = requestFrame(step);
  return { cancel: () => stop(false, "unmounted") };
}
