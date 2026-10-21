"use client";

import { useEffect, useState, type SyntheticEvent } from "react";
import { getFileName } from "../lib/file/file-paths";
import { useFileBytes, useFileMeta } from "../hooks/useFileBytes";
import { useI18n } from "../hooks/useI18n";
import { formatByteSize as formatSize } from "../lib/byte-size";
import { PreviewToolbar, type FilePreviewIdentity } from "./FilePreviewToolbar";

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * One recording of the workspace, audio or video.
 *
 * The two are the same job — the connection's own address, the browser's own player, the duration the media element
 * reports once it has the metadata — so they are one leaf that states which element it is. What differs is only the
 * frame the player sits in: a recording is a strip across the page, a video takes the room it is given.
 */
export function MediaFilePreview({ filePath, cwd, displayCwd, kind }: FilePreviewIdentity & { kind: "audio" | "video" }) {
  const { t } = useI18n();
  const [duration, setDuration] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bytes = useFileBytes(filePath);
  const meta = useFileMeta(filePath);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";
  const src = bytes.url;
  const size = meta.size;
  const error = bytes.error ?? loadError ?? meta.error;
  useEffect(() => setLoadError(null), [src]);

  const mediaProps = {
    controls: true,
    preload: "metadata",
    src: src ?? undefined,
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => setDuration(event.currentTarget.duration),
    onError: () => setLoadError(t(kind === "audio" ? "files.audioLoadFailed" : "files.videoLoadFailed")),
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <PreviewToolbar
        filePath={filePath}
        cwd={cwd}
        displayCwd={displayCwd}
        facts={<>
          <span>{ext || kind}</span>
          {duration != null && <span>{formatDuration(duration)}</span>}
          {size != null && <span>{formatSize(size)}</span>}
        </>}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
          minHeight: 0,
        }}
      >
        <div style={kind === "audio"
          ? { width: "min(680px, 100%)" }
          : { width: "min(960px, 100%)", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 0 }}
        >
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          {src !== null && (kind === "audio"
            ? <audio {...mediaProps} style={{ width: "100%" }} />
            : <video {...mediaProps} playsInline style={{ maxWidth: "100%", maxHeight: "100%" }} />
          )}
        </div>
      </div>
    </div>
  );
}
