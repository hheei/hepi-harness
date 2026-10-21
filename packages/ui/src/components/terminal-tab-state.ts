export interface TerminalTab {
  id: string;
  /** The routing cwd this terminal belongs to: what every request for it is resolved against. */
  cwd: string;
  /**
   * The folder this tab's own workspace is, as the host reported it. A tab is named by its own workspace and never by
   * whichever project happens to be selected, so switching projects leaves an open terminal's label alone. Absent
   * until the host has answered once.
   */
  displayCwd?: string;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

export function newTerminalTab(cwd: string, displayCwd?: string): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, cwd, ...(displayCwd ? { displayCwd } : {}) };
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id || existing.cwd === tab.cwd)) {
        tabs.push({ id: tab.id, cwd: tab.cwd, ...(typeof tab.displayCwd === "string" && tab.displayCwd.trim() ? { displayCwd: tab.displayCwd } : {}), restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
