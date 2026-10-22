/**
 * The composer's editor primitives: the text and caret operations that must stay native.
 *
 * These are the rules a textarea already knows and a React-controlled component can break — inserting at the caret
 * without a full re-assignment (so the browser's own undo stack still holds the edit), replacing a token the completion
 * menus own, and measuring how much room an upward menu has. They are ordinary DOM functions with no React in them, so
 * the behaviour a browser performs can be stated in one place and exercised without mounting the composer.
 */

const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

// Plain replacement for when execCommand is unavailable or refuses: no undo
// entry, but the mention still lands and React's onChange still fires.
function setTextareaRange(textarea: HTMLTextAreaElement, start: number, end: number, text: string): void {
  textarea.setRangeText(text, start, end, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Replace [start, end) with `text` as native edits so the textarea's own
// undo/redo history records them. With a collapsed caret inside the range the
// typed prefix is deleted and the tail forward-deleted, so undo returns to
// what the user had typed.
export function replaceTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  cursorOffset = text.length,
): void {
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  textarea.focus();

  if (selectionStart === selectionEnd && start <= selectionStart && end >= selectionEnd) {
    const finalLength = textarea.value.length - (end - start) + text.length;
    for (let edits = selectionStart - start; edits > 0 && textarea.selectionStart > start; edits--) {
      if (!document.execCommand("delete")) break;
    }
    if (document.execCommand("insertText", false, text)) {
      for (let edits = end - selectionEnd; edits > 0 && textarea.value.length > finalLength; edits--) {
        if (!document.execCommand("forwardDelete")) break;
      }
    } else {
      // Whatever prefix the deletes left is still in [start, caret); the tail is untouched.
      setTextareaRange(textarea, start, textarea.selectionStart + (end - selectionEnd), text);
    }
  } else {
    textarea.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) setTextareaRange(textarea, start, end, text);
  }

  if (cursorOffset !== text.length) {
    textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
  }
}

/**
 * Turn the labels of a pasted HTML fragment into markdown links, in the plain text the paste also carried.
 *
 * `occurrence` is which of the same label's appearances this link is, because a label is often not unique and only the
 * n-th one is the anchor the reader copied.
 */
export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

/**
 * Keep an upward menu inside the space its anchor can actually show: the composer sits at the bottom of a viewport that
 * a mobile keyboard, a drawer or a scrolled panel can crop, so the cap is measured, not assumed, and re-measured when
 * any of those move.
 */
export function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}
