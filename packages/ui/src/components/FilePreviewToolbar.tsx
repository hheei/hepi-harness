"use client";

import type { CSSProperties, ReactNode } from "react";
import { displayPathUnder } from "../lib/display-path";
import { getRelativeFilePath } from "../lib/file/file-paths";
import { useI18n } from "../hooks/useI18n";
import { FileSaveControl } from "./FileSaveControl";

/** What every preview leaf needs to say which file it is showing, and how a person reads that path. */
export interface FilePreviewIdentity {
  filePath: string;
  cwd?: string;
  /** The folder behind the routing cwd, shown wherever a path is read by a person. */
  displayCwd?: string | null;
}

/**
 * The row a preview that is not a text source states its file in.
 *
 * An image, a recording, a document: each states the same path, its own facts and the same two verbs — this file has no
 * live watcher, and saving it is the host's own path. Those are written once here so no leaf decides them again, and so
 * every leaf keeps the same save control the explorer's row offers.
 */
export function PreviewToolbar({ filePath, cwd, displayCwd, facts, pathStyle }: FilePreviewIdentity & {
  /** This kind's own facts, in the order the row states them. */
  facts?: ReactNode;
  /** A still narrower path cell, for a leaf whose facts need the room. */
  pathStyle?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "4px 16px",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-dim)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", ...pathStyle }} title={displayPathUnder(filePath, cwd, displayCwd)}>
        {getRelativeFilePath(filePath, cwd)}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>{facts}</span>
      <WatchState />
      <FileSaveControl filePath={filePath} />
    </div>
  );
}

/**
 * How a viewer states a file's own liveness.
 *
 * There is no watcher to report: live file watching is not connected to the gateway workbench, so a viewer that said
 * "live" would be saying something no surface answered. What it shows instead is the connection's own statement of
 * that limit, which is what the `501` on the watch route says.
 */
export function WatchState() {
  const { t } = useI18n();
  return (
    <span title={t("files.watchUnavailable")} style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-dim)", flexShrink: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--border)", display: "inline-block" }} />
      {t("files.watchUnavailable")}
    </span>
  );
}
