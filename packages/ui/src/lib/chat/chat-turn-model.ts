import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolResultMessage } from "../types";
import {
  countToolCallBlocks,
  getAssistantErrorMessage,
  getDisplayableAssistantBlocks,
  hasAssistantAnswer,
  isAssistantTruncated,
  isMessageGroupAnchor,
  splitFinalAssistantBlocks,
} from "../message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "../turn-written-files";

/**
 * The transcript as data: complete turn descriptions, chosen before any JSX exists.
 *
 * The renderer's job is to turn these descriptions into elements; it is not the place that decides what a turn is,
 * which message answers it, what it wrote or which of its messages carry a navigation ref. Keeping that here means a
 * window can select turns without re-deriving them, and the same description is what a test can assert on.
 *
 * A turn is the segment between two group anchors (a user message, a compaction summary or a subagent notification).
 * The segment before the first anchor is a turn too: the first history page can start mid-turn, and the leading
 * segment is grouped the same way instead of being flattened.
 */

/** A search reveal the surface is locating, as the shell hands it over. */
export interface TurnSearchTarget {
  entryId: string;
  blockIndex?: number;
}

export interface TurnModelInput {
  messages: AgentMessage[];
  entryIds: (string | undefined)[];
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  /** The conversation has work in flight: a run, a staged turn or a live partial. */
  sessionBusy: boolean;
  isStreaming: boolean;
  searchTarget?: TurnSearchTarget | null;
}

/** One message rendered inside a process group. */
export interface ProcessEntry {
  index: number;
  /** The message to render: the final assistant's process blocks are split out of its answer. */
  message: AgentMessage;
  /** The React key of the view, stable across re-renders and remounts. */
  viewKey: string;
}

export type TurnItem =
  | {
    kind: "message";
    key: string;
    viewKey: string;
    index: number;
    message: AgentMessage;
    showTimestamp: boolean;
    /** The navigation/minimap ref this message owns, or null when it carries none. */
    refIndex: number | null;
  }
  | {
    kind: "process";
    key: string;
    toolCallCount: number;
    messageCount: number;
    /** A turn with no final answer shows its process open. */
    defaultExpanded: boolean;
    /** The search target is inside this group, so it must be revealed. */
    reveal: boolean;
    refIndex: number | null;
    entries: ProcessEntry[];
  }
  | {
    kind: "answer";
    key: string;
    viewKey: string;
    index: number;
    message: AssistantMessage;
    showTimestamp: boolean;
    writtenFiles: WrittenFile[];
    recoverTruncation: boolean;
    refIndex: number | null;
  };

export interface TurnDescription {
  /** Stable identity of the turn: its anchor entry id, so it survives re-renders and remounts. */
  key: string;
  /** The message range this description owns, [startIndex, endIndex). */
  startIndex: number;
  endIndex: number;
  /** The anchor message index, or null for a leading segment that begins mid-turn. */
  anchorIndex: number | null;
  anchorEntryId: string | null;
  /** The anchor's navigation ref, or null when the turn has no anchor. */
  anchorRefIndex: number | null;
  /** True while this turn owns the live tail, so its messages render individually. */
  live: boolean;
  items: TurnItem[];
}

export interface TurnModel {
  turns: TurnDescription[];
  /** How many navigation refs the rendered transcript needs. */
  refCount: number;
  /** The message whose element is the scroll target for the newest prompt, or -1. */
  lastUserIndex: number;
  /** The message indices that carry a ref, in message order. */
  refIndexByMessage: Map<number, number>;
}

/**
 * Resolve a search target to the message and block it names, from the window the surface already holds.
 *
 * The rule lives here because both the reveal decision and the scroll-and-highlight effect ask it, and an entry that
 * is not in this window resolves to nothing rather than to a guess.
 */
export function resolveSearchTarget(
  messages: AgentMessage[],
  entryIds: (string | undefined)[],
  target?: TurnSearchTarget | null,
): { message: AgentMessage | undefined; block: AssistantContentBlock | undefined } {
  if (!target) return { message: undefined, block: undefined };
  const message = messages[entryIds.indexOf(target.entryId)];
  if (message?.role !== "assistant") return { message, block: undefined };
  const block = target.blockIndex === undefined
    ? message.content.find((candidate) => candidate.type === "text")
    : message.content[target.blockIndex];
  return { message, block };
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

/**
 * Which assistant messages show their own timestamp: the last reply before the next user message, in one reverse pass
 * rather than a lookahead per message.
 */
function showTimestampByIndex(messages: AgentMessage[], isStreaming: boolean): boolean[] {
  const show = new Array<boolean>(messages.length).fill(false);
  let assistantSeen = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index].role;
    if (role === "user") { assistantSeen = false; continue; }
    if (role !== "assistant") continue;
    show[index] = !assistantSeen;
    assistantSeen = true;
  }
  // The streaming tail owns the live timestamp instead.
  const last = messages.length - 1;
  if (isStreaming && last >= 0 && messages[last]?.role === "assistant") show[last] = false;
  return show;
}

export function buildTurnModel(input: TurnModelInput): TurnModel {
  const { messages, entryIds, sessionBusy, isStreaming } = input;
  const showTimestamp = showTimestampByIndex(messages, isStreaming);
  const { block: searchBlock } = resolveSearchTarget(messages, entryIds, input.searchTarget);

  const refIndexByMessage = new Map<number, number>();
  let refCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isMessageGroupAnchor(message) || message.role === "assistant") refIndexByMessage.set(index, refCount++);
  }

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") { lastUserIndex = index; break; }
  }
  let lastAnchorIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isMessageGroupAnchor(messages[index])) { lastAnchorIndex = index; break; }
  }

  const turns: TurnDescription[] = [];
  for (let index = 0; index < messages.length;) {
    const hasAnchor = isMessageGroupAnchor(messages[index]);
    // The first history page starts at a fixed entry count, so a turn longer than
    // that page begins without its anchor. Group the leading segment anyway
    // instead of flattening the whole turn.
    const userIdx = hasAnchor ? index : -1;
    const groupStartIdx = index;
    let endIdx = index + 1;
    while (endIdx < messages.length && !isMessageGroupAnchor(messages[endIdx])) endIdx += 1;

    const anchorEntryId = entryIds[groupStartIdx] ?? null;
    const turnKey = `turn-${anchorEntryId ?? groupStartIdx}`;
    const turn: TurnDescription = {
      key: turnKey,
      startIndex: groupStartIdx,
      endIndex: endIdx,
      anchorIndex: hasAnchor ? groupStartIdx : null,
      anchorEntryId: hasAnchor ? anchorEntryId : null,
      anchorRefIndex: hasAnchor ? refIndexByMessage.get(groupStartIdx) ?? null : null,
      live: false,
      items: [],
    };

    const flat = (live: boolean) => {
      turn.live = live;
      for (let memberIdx = groupStartIdx; memberIdx < endIdx; memberIdx += 1) {
        const messageKey = entryIds[memberIdx] ?? memberIdx;
        turn.items.push({
          kind: "message",
          key: `message-${messageKey}`,
          viewKey: `message-view-${messageKey}`,
          index: memberIdx,
          message: messages[memberIdx],
          showTimestamp: showTimestamp[memberIdx],
          refIndex: refIndexByMessage.get(memberIdx) ?? null,
        });
      }
      turns.push(turn);
      index = endIdx;
    };

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    if (finalAssistantIdx === -1) { flat(false); continue; }

    // Anchor for live-tail detection. A compaction summary or subagent
    // completion can sit after the last user message and own the
    // still-streaming segment. lastUserIndex stays the scroll target.
    const isLiveTail = (sessionBusy || isStreaming) && endIdx === messages.length && userIdx === lastAnchorIndex;
    if (isLiveTail) { flat(true); continue; }

    if (hasAnchor) {
      const messageKey = entryIds[groupStartIdx] ?? groupStartIdx;
      turn.items.push({
        kind: "message",
        key: `message-${messageKey}`,
        viewKey: `message-view-${messageKey}`,
        index: groupStartIdx,
        message: messages[groupStartIdx],
        showTimestamp: showTimestamp[groupStartIdx],
        refIndex: refIndexByMessage.get(groupStartIdx) ?? null,
      });
    }

    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant) || isAssistantTruncated(finalAssistant)
      ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
      : null;

    const finalProcessEnd = finalAssistant.content.indexOf(finalSplit.answerBlocks[0]);
    // Keep the original prefix so deferred thinking retains its stored block indices.
    const finalProcessBlocks = finalAssistant.content.slice(0, finalProcessEnd < 0 ? undefined : finalProcessEnd);

    const entries: ProcessEntry[] = [];
    let processToolCount = 0;
    let processRefIndex: number | null = null;
    let revealProcess = false;

    for (let processIdx = userIdx + 1; processIdx <= finalAssistantIdx; processIdx += 1) {
      const processMessage = messages[processIdx];
      const processViewKey = `process-view-${entryIds[processIdx] ?? processIdx}`;
      if (processMessage.role === "custom") {
        revealProcess ||= Boolean(input.searchTarget && input.searchTarget.entryId === entryIds[processIdx]);
        entries.push({ index: processIdx, message: processMessage, viewKey: processViewKey });
        continue;
      }
      if (processMessage.role !== "assistant") continue;
      const message = processIdx === finalAssistantIdx
        ? withAssistantBlocks(processMessage, finalProcessBlocks, { omitUsage: Boolean(finalAnswerMessage) })
        : processMessage;
      const blocks = getDisplayableAssistantBlocks(message);
      if (blocks.length === 0) continue;
      processRefIndex ??= refIndexByMessage.get(processIdx) ?? null;
      processToolCount += countToolCallBlocks(blocks);
      revealProcess ||= Boolean(
        input.searchTarget
        && entryIds[processIdx] === input.searchTarget.entryId
        && (!searchBlock || blocks.includes(searchBlock)),
      );
      entries.push({ index: processIdx, message, viewKey: processViewKey });
    }

    if (entries.length > 0) {
      turn.items.push({
        kind: "process",
        key: `process-group-${anchorEntryId ?? groupStartIdx}`,
        toolCallCount: processToolCount,
        messageCount: entries.length,
        defaultExpanded: !finalAnswerMessage,
        reveal: revealProcess,
        refIndex: processRefIndex,
        entries,
      });
    }

    if (finalAnswerMessage) {
      // Each tool call is stored as its own assistant entry, so the
      // final answer alone carries no record of what the turn wrote.
      // Gather the turn's assistant blocks and derive the file list
      // from the write/edit calls among them.
      const turnContent: AssistantContentBlock[] = [];
      for (let memberIdx = userIdx + 1; memberIdx <= finalAssistantIdx; memberIdx += 1) {
        const message = messages[memberIdx];
        if (message?.role === "assistant") {
          for (const block of (message as AssistantMessage).content ?? []) turnContent.push(block);
        }
      }
      const messageKey = entryIds[finalAssistantIdx] ?? finalAssistantIdx;
      turn.items.push({
        kind: "answer",
        key: `message-${messageKey}`,
        viewKey: `message-view-${messageKey}`,
        index: finalAssistantIdx,
        message: finalAnswerMessage,
        showTimestamp: showTimestamp[finalAssistantIdx],
        writtenFiles: extractTurnWrittenFiles(turnContent, input.toolResults, input.cwd),
        recoverTruncation: endIdx === messages.length && !isStreaming && !hasAssistantAnswer(finalAnswerMessage),
        refIndex: refIndexByMessage.get(finalAssistantIdx) ?? null,
      });
    }

    for (let memberIdx = finalAssistantIdx + 1; memberIdx < endIdx; memberIdx += 1) {
      const messageKey = entryIds[memberIdx] ?? memberIdx;
      turn.items.push({
        kind: "message",
        key: `message-${messageKey}`,
        viewKey: `message-view-${messageKey}`,
        index: memberIdx,
        message: messages[memberIdx],
        showTimestamp: showTimestamp[memberIdx],
        refIndex: refIndexByMessage.get(memberIdx) ?? null,
      });
    }

    turns.push(turn);
    index = endIdx;
  }

  return { turns, refCount, lastUserIndex, refIndexByMessage };
}
