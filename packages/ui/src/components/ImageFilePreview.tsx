"use client";

import { useEffect, useState } from "react";
import { getFileName } from "../lib/file/file-paths";
import { useFileBytes, useFileMeta } from "../hooks/useFileBytes";
import { useI18n } from "../hooks/useI18n";
import { formatByteSize as formatSize } from "../lib/byte-size";
import { PreviewToolbar, type FilePreviewIdentity } from "./FilePreviewToolbar";

/**
 * One image of the workspace.
 *
 * The bytes come from the connection, not from an address this viewer assembled: a cookie host's element carries the
 * credential by itself, and an App's connection reads them into a lease it can revoke. Nothing here reads the file a
 * second time — {@link useFileBytes} is the one read, and the size beside it is the same answer's.
 */
export function ImageFilePreview({ filePath, cwd, displayCwd }: FilePreviewIdentity) {
  const { t } = useI18n();
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bytes = useFileBytes(filePath);
  const meta = useFileMeta(filePath);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";
  const src = bytes.url;
  const error = bytes.error ?? loadError ?? meta.error;
  const formatSizeStr = meta.size != null ? formatSize(meta.size) : null;
  // A failure belongs to the address it failed for: the next file, or the lease that replaced an address, is a
  // different one and starts with its own answer rather than the previous one's error.
  useEffect(() => setLoadError(null), [src]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <PreviewToolbar
        filePath={filePath}
        cwd={cwd}
        displayCwd={displayCwd}
        facts={<>
          <span>{ext || "image"}</span>
          {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
          {formatSizeStr && <span>{formatSizeStr}</span>}
        </>}
      />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : src === null ? null : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setLoadError(t("files.imageLoadFailed"))}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}
