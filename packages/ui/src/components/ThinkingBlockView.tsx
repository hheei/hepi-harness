"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ThinkingIcon } from "./ThinkingIcon";
import { useI18n } from "../hooks/useI18n";
import { getThinkingPreview } from "../lib/message-display";
import { readResourceText, ResourceReadError, resourceRefusalKey } from "../lib/resource-read";
import { useOptionalResourceReader } from "../lib/workbench-scope";
import { isThinkingExpandedByDefault, THINKING_EXPANDED_EVENT } from "../lib/thinking-expansion-preference";
import { thinkingUrl } from "@hepi/protocol";
import { errorText } from "@hepi/protocol/error-text";
import type { ThinkingContent } from "../lib/types";

/**
 * One thinking block: the bounded preview in place, the whole reasoning on expand.
 *
 * A deferred history thinking block is an address rather than text. It is read through the connection's own reader,
 * following the block's bounded pages, and it is read **when the block is expanded** — never on mount — so opening a
 * conversation costs nothing for the thinking it does not open. The reader drops failures instead of caching them, so
 * collapsing and expanding again is a real retry, and a refusal is named by the reader's own reason.
 *
 * Expansion state is this component's own: a streamed chunk that re-renders the turn does not collapse or refocus a
 * block the reader has open.
 */
export function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const reader = useOptionalResourceReader();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded. The address is the protocol's own read block, read
  // through this connection's reader: the reader follows the block's bounded pages, keeps its bounded cache and drops
  // failures rather than caching them, so collapsing and expanding again is a real retry.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    readResourceText(reader, thinkingUrl(sessionId, entryId, blockIndex))
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ResourceReadError ? tRef.current(resourceRefusalKey(err.reason)) : errorText(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex, reader]);

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0,
      border: "1px solid var(--border)",
      borderRadius: 7,
      padding: "6px 10px",
      background: "var(--bg)",
      fontFamily: "var(--font-mono)",
      fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
      lineHeight: 1.5,
    }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
        title={t("i18n.thinking")}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: expanded ? 14 : "100%",
          flexShrink: expanded ? 0 : 1,
          minWidth: 0,
          minHeight: "1.5em",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <ThinkingIcon active={expanded} />
        {!expanded && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{preview}</ReactMarkdown> : "..."}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: error ? "#f87171" : "var(--text-muted)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
           {loading ? t("i18n.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
        </div>
      )}
      {duration !== undefined && (
        <span style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
      )}
    </div>
  );
}
