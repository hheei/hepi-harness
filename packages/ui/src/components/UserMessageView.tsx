"use client";

import { useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { MessageImage } from "./MessageImages";
import { DeferredText, SafeMarkdownBody } from "./MessageTextBlocks";
import { useI18n } from "../hooks/useI18n";
import { copyText } from "../lib/clipboard";
import { isDeferredTextBlock, loadTextBlockOriginals } from "../lib/deferred-text";
import { useOptionalResourceReader } from "../lib/workbench-scope";
import { skillExpansionToCommand } from "../lib/slash-display";
import type { ImageContent, TextContent, UserMessage } from "../lib/types";

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

/**
 * The prompt the reader typed, with every deferred block read through the shared cache first.
 *
 * A copy and an edit both need the message itself rather than the previews the frame carried, and a prompt can hold
 * several text blocks beside its attachments, so one read answers for all of them and the caller is handed the
 * originals in order. It is a load on an explicit user action — never on mount — and a failure rejects so the caller
 * refuses instead of acting on a preview.
 */
export function useWholePrompt(message: UserMessage) {
  const reader = useOptionalResourceReader();
  const [resolvedTexts, setResolvedTexts] = useState<Map<number, string>>(new Map());
  /**
   * The prompt's own text blocks, in order. A text-only prompt is stored as a plain string and is the one block; a
   * prompt that carries an attachment is an array, and a heavy text block inside it arrives as a preview naming the read
   * block that restores it.
   */
  const textBlocks: TextContent[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content.filter((b): b is TextContent => b.type === "text");
  /** Whether some block is still showing the preview the frame carried rather than the text it stands for. */
  const hasUnreadText = textBlocks.some((block, index) => !resolvedTexts.has(index) && isDeferredTextBlock(block));

  const readWholePrompt = (): Promise<string[]> => {
    if (!hasUnreadText) return Promise.resolve(textBlocks.map((block) => block.text));
    return loadTextBlockOriginals(reader, textBlocks).then((texts) => {
      setResolvedTexts(new Map(texts.map((text, index) => [index, text])));
      return texts;
    });
  };

  /** The text of one block, resolved once read, with the line endings the session file keeps. */
  const textAt = (index: number): string => (resolvedTexts.get(index) ?? textBlocks[index].text).replace(/\r\n?/g, "\n");

  /** Records the whole text an expanded block is now showing, so the bubble and a copy agree with it. */
  const resolveText = (index: number, text: string) => {
    setResolvedTexts((previous) => new Map(previous).set(index, text));
  };

  return { textBlocks, readWholePrompt, textAt, resolveText };
}

/**
 * One user message: the prompt's own bubble, its attachments, the actions that need the whole message, and the fork.
 *
 * A prompt that arrives as a `/skill:…` expansion is shown as its compact command with the arguments beside it, so the
 * surface shows what the reader typed. A copy is an explicit request for the message, so it reads what the preview
 * replaced — the clipboard gets the **original**, never a preview — and a failed read or a refused clipboard write
 * leaves the previous contents alone and says so.
 */
export function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
}) {
  const { t } = useI18n();
  const { textBlocks, readWholePrompt, textAt, resolveText } = useWholePrompt(message);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const content = textBlocks.map((_, index) => textAt(index)).join("\n");

  /**
   * A copy is an explicit request for the message, so it reads what the preview replaced — and it copies the
   * **original**, never a preview: a clipboard holding a truncated prompt is a silent lie about what the user wrote.
   * A failed read or a refused clipboard write leaves the previous clipboard contents alone and says so.
   */
  const copyContent = () => {
    setCopyError(false);
    readWholePrompt()
      .then((texts) => {
        const whole = texts.map((text) => text.replace(/\r\n?/g, "\n")).join("\n");
        return copyText(skillExpansionToCommand(whole) ?? whole);
      })
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopyError(true));
  };

  const imageBlocks: ImageContent[] =
    typeof message.content === "string" ? [] : message.content.filter((b): b is ImageContent => b.type === "image");

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => (
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}; pi-ai's on-disk format uses flat
        // {data, mimeType}. A deferred history image is the url shape and is read through this connection's reader.
        <MessageImage
          key={i}
          image={img}
          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
        />
      ))}
    </div>
  );

  return (
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {textBlocks.map((block, index) => isDeferredTextBlock(block)
            ? <DeferredText key={index} block={block} className="markdown-user-message" markdown keepLineBreaks cwd={cwd} onOpenFile={onOpenFile} onResolve={(text) => resolveText(index, text)} />
            : textAt(index) !== "" && <SafeMarkdownBody key={index} className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{textAt(index)}</SafeMarkdownBody>)}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        gap: 6, marginTop: 3,
      }}>
        <div style={{
          display: "flex", gap: 3,
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transition: "opacity 0.12s",
        }}>
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
              transition: "color 0.12s",
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
        </div>
        {canFork && (
          <div style={{
            display: "flex", gap: 3,
            opacity: (hovered || forking) ? 1 : 0,
            pointerEvents: (hovered || forking) ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={() => { onFork!(entryId!); }}
              disabled={forking}
              title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: forking ? "var(--accent)" : "var(--text-dim)",
                cursor: forking ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {forking ? t("i18n.creating") : t("i18n.newSession")}
            </button>
          </div>
        )}
        {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
      </div>
    </div>
  );
}

/** The prompt's own text with every deferred block restored, so an edit acts on the message itself. */
export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

/** When this message was written, as the surface names it: a time today, a date otherwise. */
export function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}
