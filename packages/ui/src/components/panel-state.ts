import { displayPathUnder } from "../lib/display-path";
import { getFileName } from "../lib/file/file-paths";
import type { FileViewerState } from "../lib/file/file-viewer-state";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { newTerminalTab, type TerminalTab } from "./terminal-tab-state";
import type { Tab } from "./TabBar";

/**
 * What the workbench's file panel shows: the file tabs, the terminal tabs, and which one is on screen.
 *
 * This is the one statement of the panel's tab policy, and every transition below is a function of it — the shell keeps
 * the value in state and renders it, and it decides nothing about tabs itself. That is what makes the rules traceable in
 * one place instead of being spread over a mount effect, a close handler and a project-change cleanup:
 *
 * - **A file tab belongs to the project it was opened under.** A cross-project selection clears the file tabs, because a
 *   path is absolute and the previous project's paths would linger under a folder they do not belong to. A same-project
 *   worktree move and a resolved identity are not transitions, and neither is the page's own restore.
 * - **A terminal tab belongs to the page.** Its workspace is the folder its own shell runs in — the host reports it and
 *   it is never rewritten from the current selection — so switching projects leaves the tab, its label and its shell
 *   alone.
 * - **Closing is a request the tab's own surface completes.** A terminal tab is marked `closing` and the panel that owns
 *   the widget reports when it is done; a restart replaces the tab in place with one of the same workspace, and the
 *   active tab falls back to the nearest remaining one.
 */
export interface PanelState {
  readonly fileTabs: readonly Tab[];
  readonly terminalTabs: readonly TerminalTab[];
  /** The tab on screen, or `null` while the panel has none. */
  readonly activeTabId: string | null;
}

/** The panel with nothing in it. */
export const EMPTY_PANEL: PanelState = { fileTabs: [], terminalTabs: [], activeTabId: null };

/** Whether the panel has nothing left to show, which is when its own surface closes it. */
export function panelIsEmpty(state: PanelState): boolean {
  return state.fileTabs.length === 0 && state.terminalTabs.length === 0;
}

/** What a file tab is opened with, as the caller that asked for it states it. */
export interface OpenFilePanelInput {
  readonly fileName: string;
  readonly filePath: string;
  readonly modeHint?: "diff";
  readonly page?: number;
  readonly sourceSessionId?: string | null;
}

/**
 * Show `filePath`, keeping the tab it already had.
 *
 * The tab is keyed by absolute path, so reopening a file the panel already holds restores its scroll and display mode
 * instead of mounting a second reader; the per-tab state is the one `file-tab-state` keeps, including its revision fence
 * against a viewer state arriving for a mode that has since changed.
 */
export function openFilePanelTab(state: PanelState, input: OpenFilePanelInput): PanelState {
  const tabId = `file:${input.filePath}`;
  const fileTabs = openFileTab([...state.fileTabs], {
    fileName: input.fileName,
    filePath: input.filePath,
    modeHint: input.modeHint,
    page: input.page,
    sourceSessionId: input.sourceSessionId,
    tabId,
  });
  return { ...state, fileTabs, activeTabId: tabId };
}

/**
 * Show the terminal of `cwd`, opening it if the page has none.
 *
 * A workspace has at most one terminal tab: asking for the same folder again focuses the shell it already runs rather
 * than starting a second one. A new tab takes `displayCwd` — the folder the host reported for the workspace it was
 * opened in — as its own name from the start, so its label is right before the host has answered and stays right after a
 * project switch.
 */
export function openTerminalPanelTab(state: PanelState, cwd: string, displayCwd?: string | null): PanelState {
  const existing = state.terminalTabs.find((tab) => tab.cwd === cwd);
  if (existing !== undefined) return { ...state, activeTabId: existing.id };
  const tab = newTerminalTab(cwd, displayCwd ?? undefined);
  return { ...state, terminalTabs: [...state.terminalTabs, tab], activeTabId: tab.id };
}

/** The reader asked this terminal to start over: its own surface completes that, and reports back as a close does. */
export function restartTerminalTab(state: PanelState, tabId: string): PanelState {
  if (!state.terminalTabs.some((tab) => tab.id === tabId && !tab.closing)) return state;
  return { ...state, terminalTabs: state.terminalTabs.map((tab) => (tab.id === tabId ? { ...tab, closing: "restart" as const } : tab)) };
}

/** The folder the host itself reported for a terminal tab: its own workspace, which names it from then on. */
export function terminalWorkspaceKnown(state: PanelState, tabId: string, displayCwd: string): PanelState {
  if (!state.terminalTabs.some((tab) => tab.id === tabId && tab.displayCwd !== displayCwd)) return state;
  return {
    ...state,
    terminalTabs: state.terminalTabs.map((tab) => (tab.id === tabId && tab.displayCwd !== displayCwd ? { ...tab, displayCwd } : tab)),
  };
}

/** What closing a tab asked for: a file or a terminal tab went away, or a terminal asked its own surface to stop. */
export interface PanelClose {
  readonly state: PanelState;
  /** Whether the panel has nothing left to show, which closes it. */
  readonly empty: boolean;
}

/**
 * Close the tab `tabId`.
 *
 * A terminal tab is not removed here: closing its shell is the panel's own request, so the tab is marked and the widget
 * reports when it is gone (`terminalPanelClosed`). A file tab is removed at once, and the tab on screen falls back to the
 * nearest remaining one — the last file tab, then the last terminal, because a file tab is what the reader was reading.
 */
export function closePanelTab(state: PanelState, tabId: string): PanelClose {
  if (state.terminalTabs.some((tab) => tab.id === tabId)) {
    const terminalTabs = state.terminalTabs.map((tab) => (tab.id === tabId && !tab.closing ? { ...tab, closing: "close" as const } : tab));
    return { state: { ...state, terminalTabs }, empty: false };
  }
  const fileTabs = state.fileTabs.filter((tab) => tab.id !== tabId);
  const activeTabId = state.activeTabId !== tabId
    ? state.activeTabId
    : fileTabs.at(-1)?.id ?? state.terminalTabs.at(-1)?.id ?? null;
  const next = { ...state, fileTabs, activeTabId };
  return { state: next, empty: panelIsEmpty(next) };
}

/**
 * A terminal tab's own surface reported that it is gone.
 *
 * `restart` replaces the tab in place with a fresh shell of the same workspace, so the reader keeps the tab they asked to
 * restart and it takes its place in the bar where the old one was. A plain close removes it. Either way the tab on screen
 * falls back the way a closed file tab does.
 */
export function terminalPanelClosed(state: PanelState, tabId: string, reason: "close" | "restart"): PanelClose {
  const closed = state.terminalTabs.find((tab) => tab.id === tabId);
  const replacement = reason === "restart" && closed !== undefined ? newTerminalTab(closed.cwd) : null;
  const remaining = state.terminalTabs.filter((tab) => tab.id !== tabId);
  const terminalTabs = state.terminalTabs.flatMap((tab) => (tab.id !== tabId ? [tab] : replacement === null ? [] : [replacement]));
  const activeTabId = state.activeTabId !== tabId
    ? state.activeTabId
    : replacement?.id ?? remaining.at(-1)?.id ?? state.fileTabs.at(-1)?.id ?? null;
  const next = { ...state, terminalTabs, activeTabId };
  return { state: next, empty: replacement === null && panelIsEmpty(next) };
}

/**
 * The accepted project changed: the file tabs go, the terminal tabs stay.
 *
 * The panel is only closed when the tab on screen was one of the file tabs — a terminal the reader is watching keeps the
 * panel, and its shell keeps running, because neither belongs to the project that moved.
 */
export function panelsAfterProjectTransition(state: PanelState): PanelState {
  const open = state.activeTabId;
  const keepActive = open !== null && !open.startsWith("file:") && state.terminalTabs.some((tab) => tab.id === open);
  return { ...state, fileTabs: [], activeTabId: keepActive ? open : null };
}

/** The viewer state of a file tab, fenced by the revision that asked for it. */
export function savePanelViewerState(
  state: PanelState,
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): PanelState {
  const fileTabs = saveFileViewerState([...state.fileTabs], tabId, viewerRevision, viewerState);
  return fileTabs === state.fileTabs ? state : { ...state, fileTabs };
}

/** The tabs the panel's bar renders: the file tabs first, then the terminals, each named by its own workspace. */
export function panelTabs(state: PanelState): Tab[] {
  return [
    ...state.fileTabs,
    ...state.terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(displayPathUnder(tab.cwd, tab.cwd, tab.displayCwd)) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
  ];
}

/** The file tab on screen, or `null` when the active tab is a terminal or nothing is open. */
export function activeFilePanelTab(state: PanelState): Tab | null {
  return state.fileTabs.find((tab) => tab.id === state.activeTabId) ?? null;
}
