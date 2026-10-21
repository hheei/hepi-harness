"use client";

import { useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { CodemodeCallList } from "./CodemodeToolView";
import { DeferredText } from "./MessageTextBlocks";
import { PairedDiffResult, SplitFilesView, getResultDiff } from "./MessageDiffView";
import { MessageImage, getMessageImages } from "./MessageImages";
import { applyPatchPreviewToFiles, extractApplyPatchPaths, getApplyPatchInputText, parseApplyPatchInput, applyPatchResultHasFailures } from "../lib/apply-patch";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "../lib/tool-names";
import { isToolCallExpanded, setToolCallExpanded } from "../lib/tool-call-expansion";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "../lib/codemode-view";
import { mcpToolLabel, prettyMcpResultText } from "../lib/mcp-tool-display";
import type { SubagentToolDetails } from "../lib/subagent-tool-details";
import type { SplitDiffFile } from "../lib/patch";
import type { ImageContent, TextContent, ToolCallContent, ToolResultMessage } from "../lib/types";

/**
 * The preview one tool call shows while collapsed: its subject, one line of it.
 *
 * A codemode script shows the code it runs, an apply_patch shows the files it touches, a write shows the file text it
 * wrote instead of its JSON, and every other call shows the first value that names what it did.
 */
function ToolCallPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

const WRITE_VIEW_KEYS = new Set(["path", "file_path", "content"]);

/**
 * A write's file text in place of its JSON. Streamed input is still incomplete
 * JSON, and any other argument (a mode, a title) would vanish from this view,
 * so those calls, and an empty file, keep the generic view.
 */
function getWrittenFileText(block: ToolCallContent): string | null {
  if (block.rawInput !== undefined || !isWriteToolName(block.toolName)) return null;
  const { content } = block.input;
  if (typeof content !== "string" || content === "") return null;
  return Object.keys(block.input).every((key) => WRITE_VIEW_KEYS.has(key)) ? content : null;
}

function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

/**
 * Split diff rows for an apply_patch-style tool call.
 *
 * Prefers parsing the V4A patch document from the call input. The extension's
 * applied result preview contains the complete old/new file with unchanged
 * lines, so it is only used as a fallback when the call input is unavailable.
 * A single call may contain several file operations — each becomes its own
 * file section.
 */
function getApplyPatchFiles(block: ToolCallContent, result?: ToolResultMessage): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  const details = result && !result.isError ? (result as ToolResultMessage & { details?: unknown }).details : undefined;
  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  return null;
}

/** Header label listing the files targeted by an apply_patch call. */
function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(", ").slice(0, 120);
}

/** The images a tool result carries, always visible, independent of the collapsed details. */
function ResultImages({ images, isError }: { images: ImageContent[]; isError: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px",
        background: "var(--bg)",
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
      }}
    >
      {images.map((image, index) => (
        <MessageImage
          key={index}
          image={image}
          loading="lazy"
          style={{
            display: "block",
            maxWidth: "min(100%, 720px)",
            maxHeight: 520,
            borderRadius: 6,
            objectFit: "contain",
            border: "1px solid var(--border)",
          }}
        />
      ))}
    </div>
  );
}

/**
 * The text a tool result produced, beside the call that produced it.
 *
 * A deferred block keeps its own order in the list and expands in place, so a multi-megabyte output is a preview plus
 * an expand control rather than a whole transfer, and an ordinary result keeps the plain preformatted body — which is
 * what a patch's error text and an empty result want.
 */
function PairedResult({ text, isEmpty, isError, textBlocks }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
  /** The result's own text blocks, so a deferred one renders its preview and expands in place instead of shipping whole. */
  textBlocks?: TextContent[];
}) {
  const { t } = useI18n();
  // Only when the result really carries a deferred block: an ordinary result keeps the plain preformatted body, which is
  // also what a patch's error text and an empty result want. The blocks keep the result's own order — an inline block
  // between two previews stays between them — so what a reader sees is the output the tool produced.
  const blocks = textBlocks ?? [];
  const hasDeferred = blocks.some((block) => block.deferred === true);
  const bodyStyle = {
    borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
    background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
  } as const;
  if (blocks.some((block) => block.deferred === true)) {
    return (
      <div style={{ ...bodyStyle, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {blocks.map((block, index) => (block.deferred === true
          ? <DeferredText key={index} block={block as TextContent & { textUrl: string }} />
          : (
            <pre
              key={index}
              style={{
                margin: 0,
                color: isError ? "#f87171" : "var(--text-muted)",
                fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
                lineHeight: 1.5,
                overflow: "auto",
                maxHeight: 400,
                background: "var(--bg)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {block.text}
            </pre>
          )))}
      </div>
    );
  }
  return (
    <div style={bodyStyle}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

/**
 * One tool call: its header, its input while streaming or when no richer view exists, and its result.
 *
 * The expanded state is this component's own and is persisted per call id, so a streamed chunk that re-renders the
 * turn never collapses a call the reader opened. A paired result is only shown while expanded.
 */
export function ToolCallBlock({ block, result, duration, onOpenSession }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenSession?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));
  const toggleExpanded = () => {
    const next = !expanded;
    setToolCallExpanded(block.toolCallId, next);
    setExpanded(next);
  };
  const inputStr = getWrittenFileText(block) ?? getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName)
    ? summarizeApplyPatchInput(block)
    : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  // The result's text blocks, in order. A heavy one is deferred: it renders its preview here and reads the rest only
  // when the reader asks, so a multi-megabyte tool output costs nothing to open — and it is the same block the read
  // block restores, not a copy of the fetch logic.
  const resultTextBlocks = resultContent.filter((b): b is TextContent => b.type === "text");
  const joinedResultText = result
    ? resultTextBlocks.map((b) => b.text).join("\n")
    : null;
  const resultText = mcpLabel && joinedResultText !== null ? prettyMcpResultText(joinedResultText) : joinedResultText;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          onClick={toggleExpanded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flex: 1,
            minWidth: 0,
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
          }}
        >
          <span
            title={mcpLabel ? block.toolName : undefined}
            style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}
          >
            {mcpLabel ? (
              <>
                <span style={{ fontWeight: 500, opacity: 0.75 }}>{mcpLabel.server}/</span>
                {mcpLabel.tool}
              </>
            ) : block.toolName}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {isStreamingInput
              ? t("chat.generatingToolInput")
              : (patchLabel ?? (codemode ? codemodeScriptPreview(codemode.code) : ToolCallPreview(block)))}
          </span>
          {codemodeCallCount > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {codemodeCallCount === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count: codemodeCallCount })}
            </span>
          )}
          {duration !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
          )}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {subagent && onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(subagent.sessionId)}
            title={t("subagent.open")}
            aria-label={t("subagent.open")}
            style={{ width: 32, display: "grid", placeItems: "center", border: "none", borderLeft: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
          </button>
        )}
      </div>

      {/* ── Expanded: input args (only when no richer view exists); a codemode script in place of its JSON ── */}
      {expanded && (isStreamingInput || !isEditTool) && !patchFiles && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {codemode ? codemode.code.replace(/\r/g, "").trimEnd() : inputStr}
        </pre>
      )}

      {/* ── Expanded: the calls a codemode script made ── */}
      {expanded && codemode && (
        <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} isError={isError} />
      )}

      {/* ── Result images — always visible, independent of the collapsed details ── */}
      {resultImages.length > 0 && <ResultImages images={resultImages} isError={isError} />}

      {/* ── Expanded: applied-patch split diff ── */}
      {expanded && patchFiles && (
        <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", background: "var(--bg)" }}>
          <SplitFilesView files={patchFiles} />
        </div>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && patchFiles && isError && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
          textBlocks={resultTextBlocks}
        />
      )}
      {expanded && result && !patchFiles && !codemodeRunning && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (!resultIsEmpty || resultImages.length === 0) && (
          <PairedResult
            text={resultText ?? ""}
            isEmpty={resultIsEmpty}
            isError={isError}
            textBlocks={resultTextBlocks}
          />
        )
      )}
    </div>
  );
}
