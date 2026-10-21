const STORAGE_KEY = "pi-response-usage-visible";

const listeners = new Set<() => void>();

/** Response-footer token statistics stay visible unless this browser turned them off. */
export function isResponseUsageVisible(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Notifies already-mounted response footers; returns the unsubscribe function. */
export function subscribeResponseUsageVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setResponseUsageVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Best-effort browser preference persistence.
  }
  listeners.forEach((listener) => listener());
}
