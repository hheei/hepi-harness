"use client";

import { useI18n } from "../hooks/useI18n";
import { formatByteSize as formatSize } from "../lib/byte-size";

/**
 * What a bounded text preview says about itself.
 *
 * The host serves one chunk and no continuation, so the honest statement is two numbers: how many of the file's bytes
 * this answer holds, and how many the file has. The bar the viewer used to draw read its own delivered size as the
 * file's end, which made every truncated preview look complete; and the "Load more" beside it asked for an offset the
 * surface does not serve. Neither is drawn here — the notice states the bound and stops, and a total the host could not
 * state is said as unknown rather than filled in with the shown bytes.
 */
export function FilePreviewLimitNotice({ shownBytes, size }: { shownBytes: number; size: number | null }) {
  const { t } = useI18n();
  const shown = formatSize(shownBytes);
  return (
    <div
      role="status"
      data-preview-truncated="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "5px 8px",
        borderTop: "1px solid var(--border)",
        color: "var(--text-dim)",
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      <span>{size === null ? t("files.previewShownUnknownTotal", { shown }) : t("files.previewShown", { shown, size: formatSize(size) })}</span>
    </div>
  );
}
