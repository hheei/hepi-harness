"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_PANEL, panelIsEmpty, type PanelState } from "../components/panel-state";
import { restoreTerminalTabs, TERMINAL_TABS_KEY } from "../components/terminal-tab-state";

/**
 * The file panel: the tabs it holds, and whether it is on screen.
 *
 * Both are the panel's own, and they are kept together because they are one memory — a reader who had a panel open with
 * two terminals comes back to exactly that. They live in `sessionStorage` because that is the lifetime they have: a
 * reload keeps them, a new tab does not. The restore is an effect rather than a state initializer because the storage
 * does not exist on the server, and reading it during the first render would make the client tree differ from the HTML
 * it hydrated.
 *
 * The panel closes itself when the last tab leaves, and that rule is applied in one place: every transition the panel's
 * own surface reports goes through `apply`, so a closed tab, a finished terminal and a project change all end the same
 * way instead of each handler deciding for itself.
 *
 * A transition is a function of the panel as it stands **now**, not of the value the render that mounted the widget saw.
 * A terminal's own surface reports after its shell is gone, and by then another tab may have opened or this one may
 * already have been closed; a transition computed from a stale value would put back what the reader removed.
 */
export function useWorkspacePanel(): {
  readonly panel: PanelState;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly apply: (transition: (state: PanelState) => PanelState) => void;
} {
  const [panel, setPanel] = useState<PanelState>(EMPTY_PANEL);
  const [open, setOpenState] = useState(false);
  // A transition reported after a commit reads the panel as it stands now, not as the render that mounted the widget
  // saw it: a terminal's own surface reports when its shell is gone, and another tab may have opened since.
  const current = useRef(panel);
  const restored = useRef(false);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);

  const apply = useCallback((transition: (state: PanelState) => PanelState) => {
    const next = transition(current.current);
    if (next === current.current) return;
    current.current = next;
    setPanel(next);
    if (panelIsEmpty(next)) setOpenState(false);
  }, []);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      apply((state) => ({
        ...state,
        terminalTabs: saved.tabs,
        ...(saved.activeId === null ? {} : { activeTabId: saved.activeId }),
      }));
      if (saved.activeId !== null && saved.open) setOpenState(true);
    } catch {
      // Storage is optional: a page that cannot read it starts with the panel it had.
    }
    restored.current = true;
  }, [apply]);

  useEffect(() => {
    if (!restored.current) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        // A tab's own workspace travels with it, so a restored tab is named by its folder rather than by whichever
        // project happens to be selected when the page loads.
        tabs: panel.terminalTabs
          .filter((tab) => !tab.closing)
          .map(({ id, cwd, displayCwd }) => ({ id, cwd, ...(displayCwd === undefined ? {} : { displayCwd }) })),
        activeId: panel.activeTabId,
        open,
      }));
    } catch {
      // Storage is optional.
    }
  }, [open, panel.activeTabId, panel.terminalTabs]);

  return { panel, open, setOpen, apply };
}
