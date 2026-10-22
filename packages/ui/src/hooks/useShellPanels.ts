"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../lib/panel-layout";
import { useResizablePanel } from "./useResizablePanel";

interface UseShellPanelsOptions {
  /** Whether the sidebar is on screen: the right panel's own maximum is what is left beside it. */
  sidebarOpen: boolean;
  /** Whether the file panel is on screen: the sidebar's own maximum is what is left beside it. */
  rightPanelOpen: boolean;
  sidebarLabel: string;
  rightPanelLabel: string;
}

/**
 * The two panels a workbench drags, and the widths they were last left at.
 *
 * What the shell keeps is which panel is open; the widths, the storage keys, the clamping to what the viewport can hold
 * beside the other panel and the chat's own minimum are this binding's. They belong together because the two maximums are
 * each other's input — opening the file panel narrows what the sidebar may be, and the reverse — and because both are the
 * same interaction with two sets of numbers.
 *
 * A panel is clamped again when the other one opens, so a width that fitted a wide window does not push the chat below
 * its minimum on a narrow one. The stored preference is what is clamped, never rewritten to the clamp: widening the
 * window again gives the reader back the width they chose.
 */
export function useShellPanels(options: UseShellPanelsOptions) {
  const { sidebarOpen, rightPanelOpen, sidebarLabel, rightPanelLabel } = options;
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);

  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );

  const sidebar = useResizablePanel({
    ariaLabel: sidebarLabel,
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanel = useResizablePanel({
    ariaLabel: rightPanelLabel,
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });

  const reclampSidebar = sidebar.reclampWidth;
  const reclampRightPanel = rightPanel.reclampWidth;
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebar();
    reclampRightPanel();
  }, [reclampRightPanel, reclampSidebar, rightPanelOpen]);

  return { sidebar, rightPanel };
}
