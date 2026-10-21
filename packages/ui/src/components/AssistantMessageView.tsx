"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageUsage } from "./MessageUsage";
import { TextBlock } from "./MessageTextBlocks";
import { ThinkingBlock } from "./ThinkingBlockView";
import { ToolCallBlock } from "./ToolCallBlockView";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import { copyText } from "../lib/clipboard";
import { loadTextBlockOriginals } from "../lib/deferred-text";
import {
  formatMessageTime,
  getAssistantErrorMessage,
  getModelDisplayName,
  hasAssistantAnswer,
  isAssistantTruncated,
  isEmptyThinkingBlock,
} from "../lib/message-display";
import { estimateUpdatedTokens, getTokenEstimateText, type TokenEstimateCacheEntry } from "../lib/token-estimate";
import { computeTps, pushTpsSample, type TpsSample } from "../lib/tps";
import { useOptionalResourceReader } from "../lib/workbench-scope";
import { useI18n } from "../hooks/useI18n";
import type { WrittenFile } from "../lib/turn-written-files";
import type {
  AssistantContentBlock,
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
} from "../lib/types";

/** One answer block, dispatched to the presentation owner for its type. */
function BlockView({ block, searchTarget, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, onOpenSession, sessionId, entryId, blockIndex, onResolve }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void; onOpenSession?: (sessionId: string) => void; sessionId?: string; entryId?: string; blockIndex: number; onResolve?: (text: string) => void }) {
  if (block.type === "text") {
    return <div data-message-text data-search-target={searchTarget || undefined}><TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} onResolve={onResolve} /></div>;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenSession={onOpenSession} />;
  }
  return null;
}

/** The live token estimate and output rate, beside the model that is writing. */
function StreamingMetrics({ tokens, tps }: { tokens: number; tps: number | null }) {
  const { t } = useI18n();
  const est = Math.round(tokens);
  if (est <= 0) return null;
  // The rate badge is coloured by band so a slow generation is visible at a glance.
  const background = tps === null ? null : tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
      <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
        </svg>
        {est}
      </span>
      {tps !== null && background !== null && (
        <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background, color: "#fff", fontSize: 11, fontWeight: 400 }}>
          {tps.toFixed(1)} t/s
        </span>
      )}
    </span>
  );
}

/**
 * One answer: the model that wrote it, its blocks in order, its failures, the files it wrote, and its footer.
 *
 * The block list is the message's own content minus empty thinking, each block keyed by its original index, so a
 * streamed chunk re-renders only the block that grew and a deferred block keeps the index the surface addresses it by.
 * Everything expensive is local to this message: the token estimate is charged per appended suffix, thinking and tool
 * durations are finalised as the next block starts, and the output rate is a sliding window over those estimates.
 */
export function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  onOpenSession,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
}) {
  const { t } = useI18n();
  const reader = useOptionalResourceReader();
  const time = showTimestamp ? formatMessageTime(message.timestamp) : null;
  const blockItems = useMemo(() => (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming })), [message.content, isStreaming]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const truncated = isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  /**
   * The full text of a deferred block once the reader has asked for it, by the block index the surface addresses it by.
   * A copy reads the same map, so an expanded block is copied from what is on screen and is never fetched again.
   */
  const [resolvedTexts, setResolvedTexts] = useState<Map<number, string>>(new Map());
  const tpsSamplesRef = useRef<TpsSample[]>([]);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of blockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [blockItems, isStreaming]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  // The text blocks in order, each with the index the surface addresses it by, so a resolved full text replaces the
  // preview it belongs to and nothing else.
  const textParts = useMemo(() => blockItems
    .filter((item): item is { block: TextContent; originalIndex: number } => item.block.type === "text")
    .map(({ block, originalIndex }) => ({ block, originalIndex })), [blockItems]);
  const textContent = textParts.map(({ block, originalIndex }) => resolvedTexts.get(originalIndex) ?? block.text).join("\n");

  /**
   * A copy is an explicit request for the answer, so a block still showing its preview is read here — and the clipboard
   * gets the **original** text, never a preview: a copy that silently wrote a truncated answer would be a lie about
   * what the model said. The read goes through the same cache the expand control uses, so a block already expanded (or
   * already read by this handler) is not fetched twice, and a failure leaves the previous clipboard contents alone.
   */
  const copyContent = () => {
    setCopyError(false);
    loadTextBlockOriginals(reader, textParts.map(({ block }) => block))
      .then((texts) => {
        setResolvedTexts(new Map(texts.map((text, index) => [textParts[index].originalIndex, text])));
        return copyText(texts.join("\n"));
      })
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopyError(true));
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      tpsSamplesRef.current = [];
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      // Rate over a sliding window, not a cumulative mean. A mean divides the
      // whole token count by the time since the first sample, so content
      // already present when sampling begins (a snapshot adopted mid-stream, or
      // the first tick's worth) is charged to a denominator that excludes it:
      // the first reading ran several times high and then decayed. Two samples
      // inside the window cancel that head start out.
      tpsSamplesRef.current = pushTpsSample(tpsSamplesRef.current, { at: now, tokens });
      setTps(computeTps(tpsSamplesRef.current));
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError && !truncated) return null;

  return (
    <div
      data-message-role="assistant"
      data-entry-id={entryId}
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{getModelDisplayName(message.provider, message.model, modelNames)}</span>
        )}
        {isStreaming && <StreamingMetrics tokens={estimatedTokens} tps={tps} />}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} searchTarget={block === searchBlock} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} onResolve={(text) => setResolvedTexts((previous) => new Map(previous).set(originalIndex, text))} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {truncated && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(234,179,8,0.3)",
            borderRadius: 6,
            background: "rgba(234,179,8,0.07)",
            color: "#ca8a04",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {t(unansweredTruncation ? "chat.truncatedWithoutAnswer" : "chat.truncatedByOutputLimit")}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <MessageUsage usage={message.usage} />
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            data-copy-state={copyError ? "failed" : copied ? "copied" : "idle"}
             title={copyError ? t("i18n.copyFailed") : t("i18n.copyMessage")}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copyError ? "#f87171" : copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied && !copyError) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied && !copyError) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
             {copyError ? t("i18n.copyFailed") : copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}
