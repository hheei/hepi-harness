"use client";

import { DOCX_PREVIEW_MAX_BYTES, fileExtensionOf as getFileExt } from "@hepi/protocol/files";
import { getFileName } from "../lib/file/file-paths";
import { useFileBytes, useFileMeta } from "../hooks/useFileBytes";
import { useDocxPreview } from "../hooks/useDocxPreview";
import { useI18n } from "../hooks/useI18n";
import { formatByteSize as formatSize } from "../lib/byte-size";
import { PreviewToolbar, type FilePreviewIdentity } from "./FilePreviewToolbar";

/**
 * One document of the workspace: a PDF framed by the browser, or a Word document read here.
 *
 * The size the surface reports decides first. The docx preview bound is checked against that number, so an over-bound
 * document is refused without its bytes ever being asked for — asking anyway and cancelling mid-download would put a
 * document this client has already decided not to preview on the wire, which is the one thing a bound should prevent.
 * Only once the answer is under the bound does the connection resolve an address, and the docx read then parses that
 * same address rather than fetching the document a second time.
 */
export function DocumentFilePreview({ filePath, cwd, displayCwd, initialPage }: FilePreviewIdentity & {
  /** PDF page to open on first render (`#page=N` from a markdown link). */
  initialPage?: number;
}) {
  const { t } = useI18n();
  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const isDocx = ext === "docx";
  const meta = useFileMeta(filePath);
  const oversize = isDocx && meta.size !== null && meta.size > DOCX_PREVIEW_MAX_BYTES;
  const docxRequested = isDocx && meta.size !== null && meta.error === null && !oversize;
  const bytes = useFileBytes(isPdf || docxRequested ? filePath : null);
  // The address this viewer already resolved is what the preview reads: a docx must not fetch its bytes a second time.
  const docx = useDocxPreview(docxRequested ? bytes.url : null);
  const pageFragment = isPdf && initialPage && initialPage > 0 ? `#page=${initialPage}` : "";
  const previewUrl = bytes.url === null ? null : bytes.url + pageFragment;
  // Every state a document can be in is stated as itself: over the bound, unreadable, containing no text, or still
  // arriving. A PDF keeps the browser frame; a docx is never framed, so its markup has no route to this page. The viewer
  // is reached only for the kinds the protocol names (pdf, docx), so those branches are the whole set.
  const error = isPdf
    ? bytes.error ?? meta.error
    : oversize
      ? t("files.docxPreviewOversize", { max: formatSize(DOCX_PREVIEW_MAX_BYTES) })
      : meta.error ?? bytes.error ?? (docx.answer === null ? null : docx.answer.ok === false ? docx.answer.message : docx.answer.paragraphs.length === 0 ? t("files.docxPreviewEmpty") : null);
  const size = meta.size;
  const showDocx = isDocx && docx.answer?.ok === true && docx.answer.paragraphs.length > 0;
  const docxPending = isDocx && !oversize && !showDocx && error === null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <PreviewToolbar
        filePath={filePath}
        cwd={cwd}
        displayCwd={displayCwd}
        pathStyle={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        facts={<>
          <span>{isPdf ? "pdf" : ext}</span>
          {size != null && <span>{formatSize(size)}</span>}
          {showDocx && <span title={t("files.docxPreviewLimit", { max: formatSize(DOCX_PREVIEW_MAX_BYTES) })}>{t("files.docxPreviewBadge")}</span>}
        </>}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg-panel)" }}>
        {showDocx ? (
          /* The document's text, in text nodes. Never its markup: a file from another machine has no way to reach this
             page as HTML, a frame or a script, so nothing it carries can execute here. */
          <div className="docx-file-preview" style={{ padding: "24px 32px", maxWidth: "52em", fontSize: 14, lineHeight: 1.6, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {docx.answer !== null && docx.answer.ok === true ? docx.answer.paragraphs.map((paragraph, index) => (
              <p key={index} style={{ margin: "0 0 12px" }}>{paragraph}</p>
            )) : null}
          </div>
        ) : docxPending ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
            {t("i18n.loading")}
          </div>
        ) : error || previewUrl === null ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            src={previewUrl}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
          />
        )}
      </div>
    </div>
  );
}
