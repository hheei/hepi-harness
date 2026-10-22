"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * What a close that took the focused element with it owes the keyboard.
 *
 * A surface that hides or unmounts the thing holding focus strands the reader on `<body>`, where the next Tab starts from
 * the top of the page. Recording *whether* the surface held focus at the moment it was dismissed is the whole rule: at
 * close time `document.activeElement` has already left it — `inert` blurs its contents — so asking then answers
 * "nothing was focused" for exactly the case this exists for. The record is taken on `focusin`, before that happens.
 *
 * The offer is disarmed whenever the surface is shown again, so a later dismissal only returns focus if the reader was
 * really in it. That is what keeps a full-width expansion — which hides the sidebar without the reader closing it — from
 * stealing focus back to a toggle they never used.
 */
export function useFocusReturn(containerSelector: string) {
  const holdsFocusRef = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      holdsFocusRef.current = target !== null && target.closest(containerSelector) !== null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [containerSelector]);

  /**
   * The surface was dismissed (`dismissed`) or shown again (`shown`). A dismissal the reader was part of hands focus to
   * `fallback`; one they were not, and every showing, only clears the offer.
   */
  return useCallback((state: "dismissed" | "shown", fallback: () => HTMLElement | null) => {
    if (state === "shown" || !holdsFocusRef.current) {
      holdsFocusRef.current = false;
      return;
    }
    holdsFocusRef.current = false;
    fallback()?.focus();
  }, []);
}

/** What an open menu or popover owes the page: a pointer down outside it and Escape both dismiss it. */
export function useDismissOnOutsidePointer(
  open: boolean,
  containerRef: { readonly current: HTMLElement | null },
  dismiss: () => void,
): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container !== null && event.composedPath().includes(container)) return;
      dismissRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to the nearest surface that is open: the menu closes, and the run this page's global Escape would
      // stop is left running.
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [containerRef, open]);
}
