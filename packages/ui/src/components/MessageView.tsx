"use client";

import { memo } from "react";
import { AssistantMessageView } from "./AssistantMessageView";
import { BashExecutionView } from "./BashExecutionView";
import { CompactionMessageView, CustomMessageView } from "./CustomMessageView";
import { UserMessageView } from "./UserMessageView";
import type { WrittenFile } from "../lib/turn-written-files";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ToolResultMessage,
  UserMessage,
} from "../lib/types";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

/**
 * One entry of the transcript, dispatched to the presentation owner for its role.
 *
 * This is the whole of the entry's identity: the role decides which view renders, and the comparator below decides
 * whether the entry re-renders at all. The presentation itself lives with each role — the answer in
 * `AssistantMessageView`, the prompt in `UserMessageView`, an extension message in `CustomMessageView`, a local
 * command in `BashExecutionView` — so a change to one role's surface does not touch the others.
 *
 * A `toolResult` renders nothing on its own: the saved-message path splits a turn into separate entries, and a result
 * is shown paired under the call that produced it.
 */
export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, onOpenSession, entryId, searchBlock, onFork, forking, showTimestamp, prevTimestamp, sessionId, writtenFiles }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSession === next.onOpenSession
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId
    && prev.writtenFiles === next.writtenFiles;
});
