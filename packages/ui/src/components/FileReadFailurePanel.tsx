"use client";

import { useI18n } from "../hooks/useI18n";
import { fileReadFailureKey, fileReadFailureRetryable, type FileReadFailure } from "../lib/file-read-failure";

/**
 * What the file viewer shows when its read did not answer.
 *
 * It exists because a failed read used to be the surface's own raw sentence on screen — a host's words, sometimes its
 * path — and nothing else: no statement of which failure it was, and no action that could help. The panel states the
 * cause it classified and offers only the moves that can work: Retry for a host that may answer next time, Reload folder
 * for a file that is no longer there, and Close for a tab the reader is done with.
 *
 * Every sentence it shows is this client's own translation key. The failure's `detail` is never rendered: the reason
 * may name a path on the host, and a browser does not need it to decide what to do.
 */
export function FileReadFailurePanel({
  failure,
  retrying = false,
  onRetry,
  onReloadFolder,
  onClose,
}: {
  failure: FileReadFailure;
  retrying?: boolean;
  onRetry?: () => void;
  /** Reload the directory listing, which is what a file that moved or was deleted needs. */
  onReloadFolder?: () => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const retryable = fileReadFailureRetryable(failure);
  const retry = retryable && onRetry
    ? (
      <button type="button" onClick={onRetry} disabled={retrying} aria-busy={retrying} style={buttonStyle(true)}>
        {retrying ? t("i18n.loading") : t("i18n.retryLoad")}
      </button>
    )
    : null;
  const reload = onReloadFolder && failure.kind === "missing"
    ? <button type="button" onClick={onReloadFolder} disabled={retrying} style={buttonStyle(!retryable)}>{t("files.reloadFolder")}</button>
    : null;
  const close = onClose
    ? <button type="button" onClick={onClose} disabled={retrying} style={buttonStyle(false)}>{t("files.closeTab")}</button>
    : null;

  return (
    <div
      role="status"
      data-file-read-failure={failure.kind}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        textAlign: "center",
        color: "var(--text-muted)",
      }}
    >
      <div style={{ fontSize: 14, color: "var(--text)", maxWidth: 560, overflowWrap: "anywhere" }}>
        {t(fileReadFailureKey(failure))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
        {retry}
        {reload}
        {close}
      </div>
    </div>
  );
}

/** One button in the panel. The retry is the primary action; everything else is the quiet one beside it. */
function buttonStyle(primary: boolean) {
  return {
    minHeight: 32,
    padding: "0 14px",
    border: primary ? "1px solid transparent" : "1px solid var(--border)",
    borderRadius: 6,
    background: primary ? "var(--accent)" : "transparent",
    color: primary ? "#fff" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  } as const;
}
