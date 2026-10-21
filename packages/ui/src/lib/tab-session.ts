/**
 * Per-tab "open session" memory.
 *
 * A browser tab remembers the session it showed last, so a reload restores
 * *this* tab's session instead of `pi-web:last-open-by-workspace` — the
 * workspace-wide memory that every tab of the browser profile shares and that
 * any other tab overwrites when it switches sessions.
 *
 * New session is a selection too: the tab stores the composer cwd so a reload
 * returns to the new-session UI instead of the previous chat. Deleting the
 * current session forgets that id so it cannot come back on refresh.
 *
 * sessionStorage is the only per-tab store the browser offers: it survives
 * reloads and in-app navigations and is never shared with other tabs. A tab
 * that was just opened starts empty and falls back to the workspace memory;
 * there is no stable cross-tab window identity to key a localStorage entry on.
 *
 * Stored in sessionStorage; best-effort (silently ignored when unavailable).
 * Legacy values are a bare session id; current values are a small JSON object.
 */

const STORAGE_KEY = "pi-web:tab-open-session";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type TabOpen =
  | { kind: "session"; sessionId: string }
  | { kind: "new"; cwd: string; draftKey?: string };

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parseTabOpen(raw: string | null): TabOpen | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const record = parsed as { kind?: unknown; sessionId?: unknown; cwd?: unknown; draftKey?: unknown };
      if (record.kind === "session" && typeof record.sessionId === "string" && record.sessionId) {
        return { kind: "session", sessionId: record.sessionId };
      }
      if (record.kind === "new" && typeof record.cwd === "string" && record.cwd.trim()) {
        return {
          kind: "new",
          cwd: record.cwd,
          ...(typeof record.draftKey === "string" && record.draftKey ? { draftKey: record.draftKey } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  return { kind: "session", sessionId: raw };
}

function writeTabOpen(value: TabOpen, storage: StorageLike): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
}

/** What this tab showed last, or null when none is remembered. */
export function getTabOpen(
  storage: StorageLike | null = getBrowserStorage(),
): TabOpen | null {
  if (!storage) return null;
  try {
    return parseTabOpen(storage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setTabOpenSession(
  sessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !sessionId) return;
  try {
    writeTabOpen({ kind: "session", sessionId }, storage);
  } catch {
    // storage unavailable — memory is best-effort
  }
}

/**
 * `draftKey` is the composer's own draft key, because a fresh composer's key is not derivable from the cwd alone: the
 * transient `new:<id>:<cwd>` key distinguishes consecutive composers in one folder, so a reload that rebuilt the key
 * from the cwd would open an empty composer beside the draft the tab was holding. The tab remembers which composer it
 * was showing; restoring that key is what makes the text and images come back.
 */
export function setTabOpenNewSession(
  cwd: string,
  draftKey?: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  const trimmed = cwd.trim();
  if (!storage || !trimmed) return;
  try {
    writeTabOpen({ kind: "new", cwd: trimmed, ...(draftKey ? { draftKey } : {}) }, storage);
  } catch {
    // storage unavailable — memory is best-effort
  }
}

/** Forget this tab's session when it matches `sessionId`. */
export function clearTabOpenSession(
  sessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !sessionId) return;
  try {
    const current = parseTabOpen(storage.getItem(STORAGE_KEY));
    if (current?.kind !== "session" || current.sessionId !== sessionId) return;
    storage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — memory is best-effort
  }
}
