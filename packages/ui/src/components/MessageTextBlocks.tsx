"use client";

import { useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "../hooks/useI18n";
import { isDeferredTextBlock, loadDeferredText } from "../lib/deferred-text";
import { ResourceReadError, resourceRefusalKey } from "../lib/resource-read";
import { useOptionalResourceReader } from "../lib/workbench-scope";
import type { TextContent } from "../lib/types";

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
export function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * A deferred history text: the bounded preview in place, and the whole text only after an explicit expand.
 *
 * The full body renders as plain preformatted text rather than through the markdown pipeline, for the same reason
 * `SafeMarkdownBody` refuses an oversized message: a multi-megabyte body is a document to read, not markdown to parse.
 *
 * Nothing here fetches on mount, on reconnect or on scroll — `loadDeferredText` runs from the expand control only.
 * `onResolve` reports the text the reader is now looking at, so a copy or edit action uses what the surface is really
 * showing and reads it through the connection's own reader instead of fetching the block a second time.
 */
export function DeferredText({ block, className, markdown, keepLineBreaks, cwd, onOpenFile, onResolve }: {
  block: TextContent & { textUrl: string };
  className?: string;
  markdown?: boolean;
  keepLineBreaks?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onResolve?: (text: string) => void;
}) {
  const { t } = useI18n();
  const reader = useOptionalResourceReader();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textUrl = block.textUrl;

  const load = () => {
    setLoading(true);
    setError(null);
    loadDeferredText(reader, textUrl)
      .then((value) => { setContent(value); setLoading(false); onResolve?.(value); })
      .catch((loadError) => {
        // A refusal is named rather than shown as an empty failure: the reader says which one it was, and the surface
        // says that out loud instead of "something went wrong".
        setError(loadError instanceof ResourceReadError ? t(resourceRefusalKey(loadError.reason)) : loadError instanceof Error ? loadError.message : String(loadError));
        setLoading(false);
      });
  };

  const toggle = () => {
    if (expanded && content !== null) { setExpanded(false); return; }
    setExpanded(true);
    if (content === null) load();
  };

  const state = loading ? "loading" : error !== null ? "error" : expanded && content !== null ? "expanded" : "preview";
  return (
    <div data-deferred-text={textUrl} data-deferred-state={state} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {expanded && content !== null ? (
        <div style={{ maxHeight: 480, overflow: "auto" }}>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono)",
              fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
              lineHeight: 1.5,
              color: "var(--text-muted)",
            }}
          >
            {content}
          </pre>
        </div>
      ) : markdown ? (
        <MarkdownBody className={className} keepLineBreaks={keepLineBreaks} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</MarkdownBody>
      ) : (
        <SafeMarkdownBody className={className} keepLineBreaks={keepLineBreaks} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title={error !== null ? t("i18n.retryLoad") : expanded ? t("i18n.hideFullText") : t("i18n.showFullText")}
        style={{
          alignSelf: "flex-start",
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 8px",
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: 5,
          color: error !== null ? "#f87171" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        {loading
          ? t("i18n.loadingText")
          : error !== null
            ? `${error} — ${t("i18n.retryLoad")}`
            : expanded ? t("i18n.hideFullText") : t("i18n.showFullText")}
      </button>
    </div>
  );
}

/**
 * One answer text block: the live partial renders as markdown, a deferred history block renders its preview and
 * reads the rest only when the reader asks.
 *
 * The live partial is never deferred, so a streaming answer keeps this exact path and pays nothing for the policy.
 */
export function TextBlock({ block, isStreaming, cwd, onOpenFile, onResolve }: {
  block: TextContent;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onResolve?: (text: string) => void;
}) {
  if (isDeferredTextBlock(block)) return <DeferredText block={block} cwd={cwd} onOpenFile={onOpenFile} onResolve={onResolve} />;
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}
