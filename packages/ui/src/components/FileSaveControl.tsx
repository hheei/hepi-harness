"use client";

import { getFileName } from "../lib/file-paths";
import { savePathOf } from "../lib/file-save";
import { useFileDownload, useFileSave } from "../hooks/useFileBytes";
import { useI18n } from "../hooks/useI18n";

/**
 * The control that saves one file, on whichever path this host has.
 *
 * A Web page's control is an anchor: the browser navigates, streams the file to disk under its own name, and the page
 * never holds the bytes. A packaged App has no such path — its document is a bundle on `tauri://localhost`, so a
 * navigation would ask the shell for a file it does not serve and no element of it can present the device bearer. Its
 * control is therefore a button, and what it starts is the shell's own save: a destination picker, then the file written
 * in bounded slices by the shell while the connection reads it.
 *
 * One component for both, because the two are the same control to a person: "save this file". What differs is the path,
 * and {@link savePathOf} is the one place that decides it. A host with neither — a fixture mounted with no shell and no
 * browser download — states the named absence instead of a button that would collect the file into memory.
 */
export function FileSaveControl({ filePath, compact = false }: { filePath: string; compact?: boolean }) {
  const { t } = useI18n();
  const download = useFileDownload(filePath);
  const save = useFileSave(filePath, getFileName(filePath));
  const path = savePathOf(download, save.host);

  // The browser's own path: nothing is read here, and the bytes stream with whatever range the navigation asks for.
  if (path.kind === "navigation") {
    return (
      <a
        href={path.url}
        download={getFileName(filePath)}
        onClick={(event) => event.stopPropagation()}
        title={compact ? t("files.download") : t("i18n.downloadFile")}
        aria-label={t("i18n.downloadFile")}
        className={compact ? undefined : "file-viewer-icon-button"}
        style={compact ? COMPACT_STYLE : undefined}
      >
        <SaveIcon />
      </a>
    );
  }

  // The App's own path: the shell writes the file, the connection reads it.
  if (path.kind === "native") {
    const busy = save.state.kind === "saving";
    const label = busy ? t("files.saving", { size: formatBytes(save.state.bytes) }) : t("files.download");
    const failed = save.state.kind === "failed";
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          // A second click while a save is in flight cancels it rather than opening a second destination for the same
          // bytes; the shell removes the partial file, which is what makes the cancellation honest.
          if (busy) save.cancel();
          else void save.save();
        }}
        title={failed ? save.state.reason : label}
        aria-label={failed ? save.state.reason : label}
        aria-busy={busy}
        className={compact ? undefined : "file-viewer-icon-button"}
        style={{ ...(compact ? COMPACT_STYLE : {}), ...(failed ? { color: "#f87171" } : {}) }}
      >
        <SaveIcon />
      </button>
    );
  }

  // Neither path: this host has no save at all, and saying so is the honest control.
  return (
    <span
      className={compact ? undefined : "file-viewer-icon-button"}
      role="img"
      title={path.reason}
      aria-label={path.reason}
      style={{ ...(compact ? COMPACT_STYLE : {}), opacity: 0.45, cursor: "not-allowed" }}
    >
      <SaveIcon />
    </span>
  );
}

/** The explorer row's own shape: an absolutely placed control inside a row that is also a click target. */
const COMPACT_STYLE = {
  position: "absolute",
  right: 4,
  top: "50%",
  transform: "translateY(-50%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "0 5px",
  height: 20,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
  textDecoration: "none",
} as const;

/** A byte count as a surface states it while a save is in flight. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function SaveIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
