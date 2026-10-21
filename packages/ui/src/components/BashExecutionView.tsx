"use client";

import { ToolCallBlock } from "./ToolCallBlockView";
import { useI18n } from "../hooks/useI18n";
import type { BashExecutionMessage, ToolCallContent, ToolResultMessage } from "../lib/types";

/**
 * A command the reader ran themselves, shown exactly as an agent-run `bash` call is.
 *
 * The surface synthesizes the tool call and result pair the transcript already knows how to render, so a local command
 * and an agent command have one presentation instead of two that drift. A command still running has no result yet.
 */
export function BashExecutionView({ message }: { message: BashExecutionMessage }) {
  const { t } = useI18n();
  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const displayOutput = message.output;

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && (
        // The complete output is a temp file on the execution host, outside every workspace root this connection can
        // read, so there is nothing here to fetch. Saying that is the whole answer; a request to a route that does not
        // exist would only look like a failure of the page.
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1, color: "var(--text-dim)" }}>
          {t("chat.bashFullOutputOnHost")}
        </div>
      )}
    </div>
  );
}
