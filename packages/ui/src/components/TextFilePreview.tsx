"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { getFileDirectory, getRelativeFilePath } from "../lib/file/file-paths";
import { FileSaveControl } from "./FileSaveControl";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import { useI18n } from "../hooks/useI18n";
import { formatByteSize as formatSize } from "../lib/byte-size";
import { classifyFileReadFailure, type FileReadFailure } from "../lib/file/file-read-failure";
import { FileReadFailurePanel } from "./FileReadFailurePanel";
import { FilePreviewLimitNotice } from "./FilePreviewLimitNotice";
import { displayPathUnder } from "../lib/display-path";
import {
  resolveInitialFileDisplayMode,
  type FileViewerDisplayMode as DisplayMode,
  type FileViewerState,
} from "../lib/file/file-viewer-state";
import type { GitFileDiffResponse } from "@hepi/protocol/files";
import { SourceFilePreview } from "./SourceFilePreview";
import { DiffFilePreview } from "./DiffFilePreview";
import { MarkdownFilePreview } from "./MarkdownFilePreview";
import { getSelectedSourceLineRange, type SelectedLineRange } from "./file-source-selection";
import { WatchState } from "./FilePreviewToolbar";

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  source: "Source",
  preview: "Preview",
  diff: "Diff",
};

/** One bounded preview of a text file, as the host stated it. */
interface FileData {
  content: string;
  language: string;
  /** The file's whole size as the host stated it, or null when it stated none. */
  size: number | null;
  /** How many of the file's bytes this answer holds. */
  shownBytes: number;
  truncated: boolean;
}

export interface TextFilePreviewProps {
  filePath: string;
  cwd?: string;
  displayCwd?: string | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  /** Insert this file's relative path into the chat input (@ mention). */
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
  /** Reload the directory listing: what a file that moved or was deleted needs rather than the same read repeated. */
  onReloadFolder?: () => void;
  /** Close this file tab. Offered on a read that failed, so the reader is not left in a dead end. */
  onClose?: () => void;
  initialDisplayMode?: DisplayMode;
  initialState?: FileViewerState;
  onStateChange?: (state: FileViewerState) => void;
}

function MentionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

/**
 * A text file: its bounded bytes, its Git patch, and the three ways a person reads them.
 *
 * The workspace states a text file once — one bounded chunk, one Git patch — and this leaf is where that answer, the
 * mode a person picked for it, and the position they left it at belong. The formats themselves are not decided here:
 * the rendered document, the unified diff and the tokenised source are their own leaves, so a change to how one format
 * reads cannot reach the other two.
 */
export function TextFilePreview({
  filePath,
  cwd,
  displayCwd,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  onReloadFolder,
  onClose,
  initialDisplayMode,
  initialState,
  onStateChange,
}: TextFilePreviewProps) {
  const { t } = useI18n();
  // The file and its Git patch both belong to this connection.
  const { files } = useWorkbenchConnection();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [gitDiffResolved, setGitDiffResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  /** Why this file could not be read, classified at the seam that threw it — never the surface's own words. */
  const [failure, setFailure] = useState<FileReadFailure | null>(null);
  const requestedInitialDisplayMode = resolveInitialFileDisplayMode(initialState, initialDisplayMode);
  const initialWrapLines = initialState?.wrapLines ?? false;
  const initialScrollTop = initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialState?.scrollLeft ?? 0;
  const [displayMode, setDisplayMode] = useState<DisplayMode>(requestedInitialDisplayMode);
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const contentRequestRef = useRef(0);
  const gitDiffRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const autoDiffAppliedRef = useRef(false);
  const defaultPreviewEligibleRef = useRef(
    initialState === undefined && initialDisplayMode === undefined,
  );
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
  });
  const onStateChangeRef = useRef(onStateChange);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  onStateChangeRef.current = onStateChange;

  const updateDisplayMode = useCallback((nextDisplayMode: DisplayMode) => {
    viewerStateRef.current.displayMode = nextDisplayMode;
    setDisplayMode(nextDisplayMode);
  }, []);

  const toggleWrapLines = useCallback(() => {
    setWrapLines((current) => {
      const next = !current;
      viewerStateRef.current.wrapLines = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const nextState: FileViewerState = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
    };

    viewerStateRef.current = nextState;
    scrollRestorePendingRef.current = true;
    autoDiffAppliedRef.current = false;
    setDisplayMode(requestedInitialDisplayMode);
    setWrapLines(initialWrapLines);

    return () => {
      onStateChangeRef.current?.({ ...viewerStateRef.current });
    };
  }, [
    filePath,
    requestedInitialDisplayMode,
    initialWrapLines,
    initialScrollTop,
    initialScrollLeft,
  ]);

  // One bounded chunk, read once. The host preview is fixed and the surface serves no continuation, so there is no
  // offset to ask for and nothing accumulates: the answer is the whole of what this viewer shows, and a second chunk
  // would be the first chunk again.
  const fetchContent = useCallback((filePath: string) => {
    const requestId = ++contentRequestRef.current;
    return files.read(filePath)
      .then((d: FileData) => {
        if (requestId !== contentRequestRef.current) return null;
        setFailure(null);
        setData(d);
        return d;
      })
      .catch((e: unknown) => {
        if (requestId !== contentRequestRef.current) return null;
        // The cause is classified here, where the read was thrown, so the panel above states the failure it was and
        // the surface's own sentence — which may name a path on the host — stays in the log.
        setData(null);
        setFailure(classifyFileReadFailure(e));
        return null;
      });
  }, [files]);

  const retryRead = useCallback(() => {
    setRetrying(true);
    fetchContent(filePath).finally(() => setRetrying(false));
  }, [fetchContent, filePath]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      setGitDiffResolved(true);
      return;
    }

    try {
      const next = await files.diff(cwd, targetPath);
      if (requestId !== gitDiffRequestRef.current) return;
      setGitDiff(next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (requestId === gitDiffRequestRef.current) setGitDiff(null);
    } finally {
      if (requestId === gitDiffRequestRef.current) {
        setGitDiffLoading(false);
        setGitDiffResolved(true);
      }
    }
  }, [cwd, files]);

  // Load the file when its identity changes. Nothing keeps it in step afterwards: the gateway's file surface answers
  // `501` for a watch, so the header states the absent watcher instead of a viewer that would claim to be live.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailure(null);
    setData(null);
    setGitDiff(null);
    setGitDiffResolved(false);

    fetchContent(filePath).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [filePath, fetchContent]);

  useEffect(() => {
    void fetchGitDiff(filePath);
  }, [fetchGitDiff, filePath, gitRefreshKey]);

  useEffect(() => {
    // HTML gets the same rendered-first treatment as markdown: a generated page
    // is usually more useful viewed than read as source. Both have a preview
    // mode already; the source tab stays one click away. A restored choice or
    // explicit mode hint always wins over this default.
    if (
      defaultPreviewEligibleRef.current
      && !data?.truncated
      && (data?.language === "markdown" || data?.language === "html")
    ) {
      defaultPreviewEligibleRef.current = false;
      updateDisplayMode("preview");
    }
  }, [data?.language, data?.truncated, updateDisplayMode]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const isDeletedDiff = hasGitDiff && gitDiff.status === "deleted";

  useEffect(() => {
    if (gitDiffResolved && !hasGitDiff && displayMode === "diff") updateDisplayMode("source");
  }, [displayMode, gitDiffResolved, hasGitDiff, updateDisplayMode]);

  // Wait for the git request before restoring diff mode so the unresolved
  // placeholder cannot immediately demote it back to source.
  useEffect(() => {
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && !autoDiffAppliedRef.current) {
      autoDiffAppliedRef.current = true;
      updateDisplayMode("diff");
    }
  }, [requestedInitialDisplayMode, hasGitDiff, updateDisplayMode]);

  const viewerContent = data?.content ?? "";
  const sourceLines = useMemo(() => viewerContent.split("\n"), [viewerContent]);
  const language = data?.language ?? "text";
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  const hasPreview = !data?.truncated && (isHtml || isMarkdown);
  const effectiveDisplayMode = isDeletedDiff ? "diff" : displayMode;

  useEffect(() => {
    const updateSelectedLineRange = () => {
      const root = contentRef.current;
      setSelectedLineRange((current) => {
        const next = onMentionLines && displayMode === "source" && root
          ? getSelectedSourceLineRange(root, window.getSelection())
          : null;
        // Skip no-op updates: selectionchange fires continuously while dragging,
        // and a fresh-but-equal range object would re-render the whole viewer.
        if (current === null && next === null) return current;
        if (current && next && current.startLine === next.startLine && current.endLine === next.endLine) return current;
        return next;
      });
    };

    updateSelectedLineRange();
    if (!onMentionLines || displayMode !== "source") return;

    document.addEventListener("selectionchange", updateSelectedLineRange);
    return () => document.removeEventListener("selectionchange", updateSelectedLineRange);
  }, [data?.content, displayMode, onMentionLines]);

  const mentionLineRange = useCallback((lineRange: SelectedLineRange | null) => {
    if (!onMentionLines || !lineRange) return;
    onMentionLines(
      getRelativeFilePath(filePath, cwd),
      lineRange.startLine,
      lineRange.endLine,
    );
  }, [cwd, filePath, onMentionLines]);

  useEffect(() => {
    if (!onMentionLines || displayMode !== "source") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const root = contentRef.current;
      const lineRange = root ? getSelectedSourceLineRange(root, window.getSelection()) : null;
      if (!lineRange) return;

      event.preventDefault();
      mentionLineRange(lineRange);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayMode, mentionLineRange, onMentionLines]);

  useEffect(() => {
    if (!scrollRestorePendingRef.current || loading) return;
    if (failure && !isDeletedDiff) return;
    if (requestedInitialDisplayMode === "diff" && !gitDiffResolved) return;
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && displayMode !== "diff") return;

    const content = contentRef.current;
    if (!content) return;

    content.scrollTop = viewerStateRef.current.scrollTop;
    content.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
  }, [
    data?.content,
    displayMode,
    failure,
    gitDiffResolved,
    hasGitDiff,
    isDeletedDiff,
    loading,
    requestedInitialDisplayMode,
  ]);

  if (loading || (requestedInitialDisplayMode === "diff" && gitDiffLoading && !data)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("i18n.loading")}
      </div>
    );
  }

  if (failure && !isDeletedDiff) {
    return (
      <FileReadFailurePanel
        failure={failure}
        retrying={retrying}
        onRetry={retryRead}
        onReloadFolder={onReloadFolder}
        onClose={onClose}
      />
    );
  }

  if (!data && !isDeletedDiff) return null;

  const displayModes: DisplayMode[] = isDeletedDiff
    ? ["diff"]
    : [
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  // A host that stated no whole size is said so: the shown bytes are not the file's size, and a header that reported
  // them as one would be the same false completion the truncation notice exists to remove.
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : data!.size === null
      ? `${language} · ${sourceLines.length} lines · ${t("files.sizeUnknown")}`
      : `${language} · ${sourceLines.length} lines · ${formatSize(data!.size)}`;

  return (
    <div className="file-viewer-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={displayPathUnder(filePath, cwd, displayCwd)}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        {!isDeletedDiff && <WatchState />}

        <div className="file-viewer-controls">
          {displayModes.length > 1 && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {displayModes.map((mode) => {
                const active = effectiveDisplayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateDisplayMode(mode)}
                    title={mode === "diff" ? t("i18n.compareHead") : undefined}
                    aria-pressed={active}
                    className="file-viewer-mode-button"
                    style={{
                      background: active ? "var(--bg-selected)" : "transparent",
                      color: active ? "var(--text)" : "var(--text-muted)",
                    }}
                  >
                    {DISPLAY_MODE_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          )}

          <div className="file-viewer-actions">
            {(onAtMention || onMentionLines) && (
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  // Mention selected lines when a range is active (and line
                  // mention is wired up); otherwise fall back to a whole-file
                  // @mention. Same button, behavior follows the selection.
                  if (selectedLineRange && onMentionLines) {
                    mentionLineRange(selectedLineRange);
                  } else {
                    onAtMention?.(getRelativeFilePath(filePath, cwd), false);
                  }
                }}
                title={
                  selectedLineRange && onMentionLines
                    ? `${t("i18n.mentionSelectedLines")} (L${selectedLineRange.startLine}${selectedLineRange.startLine !== selectedLineRange.endLine ? `-L${selectedLineRange.endLine}` : ""})`
                    : t("files.insertPath")
                }
                aria-label={t("files.mention")}
                disabled={!onAtMention && !onMentionLines}
                className="file-viewer-icon-button"
              >
                <MentionIcon />
              </button>
            )}
            {effectiveDisplayMode === "source" && (
              <button
                type="button"
                onClick={toggleWrapLines}
                title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-pressed={wrapLines}
                className="file-viewer-icon-button"
                style={{
                  background: wrapLines ? "var(--bg-selected)" : "transparent",
                  color: wrapLines ? "var(--text)" : "var(--text-muted)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                  <path d="m16 16-2 2 2 2" />
                  <path d="M3 18h7" />
                </svg>
              </button>
            )}
          </div>

          {!isDeletedDiff && <FileSaveControl filePath={filePath} />}
        </div>
      </div>

      {data?.truncated && <FilePreviewLimitNotice shownBytes={data.shownBytes} size={data.size} />}

      {/* Content area */}
      <div
        ref={contentRef}
        className="file-viewer-content"
        onScroll={(event) => {
          viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
          viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        style={{ flex: 1, overflow: "auto", background: "var(--bg)", paddingBottom: data?.truncated ? 48 : undefined }}
      >
        {effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffFilePreview patch={gitDiff.patch!} />
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          <iframe
            srcDoc={viewerContent}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title={t("i18n.htmlPreview")}
          />
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <MarkdownFilePreview
            content={viewerContent}
            directory={getFileDirectory(filePath)}
            cwd={cwd}
            onOpenFile={onOpenFile}
          />
        ) : (
          <SourceFilePreview content={viewerContent} language={language} wrapLines={wrapLines} />
        )}
      </div>
    </div>
  );
}
