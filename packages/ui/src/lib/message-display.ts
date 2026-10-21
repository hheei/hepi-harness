import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  CustomMessage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  UserMessage,
} from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  // A background subagent completion starts a new displayed turn, same as a
  // user message or compaction summary. Other custom messages stay inside the turn.
  return message.role === "user"
    || (message.role === "custom" && (
      message.customType === "compaction"
      || message.customType === "pi-web:subagent-notification"
    ));
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

/** Text, an image, or a tool call is an answer. Thinking alone is not. */
export function hasAssistantAnswer(message: AssistantMessage): boolean {
  return (message.content ?? []).some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return block.type === "image" || block.type === "toolCall";
  });
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/** When this message was written, as the surface names it: a time today, a date otherwise. */
export function formatMessageTime(ts?: number): string | null {
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

/**
 * The configured display name of the model that answered, falling back to `provider/model`.
 *
 * A configured name may be keyed `provider:model` or by the bare id the response names, and a response model can carry
 * a vendor prefix, so the match accepts a suffix as well as an exact id.
 */
export function getModelDisplayName(
  provider: string,
  responseModel: string,
  modelNames?: Record<string, string>,
): string {
  const normalizedProvider = provider.toLowerCase();
  const normalizedResponse = responseModel.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse)?.name
    ?? configured.find((model) => normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
    ?? `${provider}/${responseModel}`;
}

/** The whole text of a message's own content, in order. */
export function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
