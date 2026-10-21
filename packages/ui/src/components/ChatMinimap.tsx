"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "../lib/markdown";
import { isMessageGroupAnchor, splitFinalAssistantBlocks } from "../lib/message-display";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent, UserMessage } from "../lib/types";
import { buildRailNodes, railPreview, type MeasuredTurn, type RailNode } from "../lib/history-rail";
import { navigationOutcomeKey, type NavigationOutline } from "../lib/history-navigation";
import { useI18n } from "../hooks/useI18n";
import styles from "../styles/ChatMinimap.module.css";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  /**
   * The entry ids of `messages`, in the same order.
   *
   * The minimap groups messages into turns itself, so it knows which message anchors each of its nodes; naming that
   * entry is how it asks the surface for a turn. It is an identity rather than the node's position because the
   * minimap's own turn enumeration and the transcript's turn descriptions are not the same list: a first history page
   * can start mid-turn, and the leading segment is a turn the transcript draws with no anchor message. Counting
   * anchors on both sides would then name a different turn on one of them.
   */
  entryIds: (string | undefined)[];
  /**
   * Ask the surface to put a turn's messages on screen, by the entry the turn is anchored on. A windowed transcript
   * keeps only the turns near the viewport, so a turn the reader navigated to by its minimap node may not be mounted
   * yet; naming it by identity is what lets the caller mount exactly that turn.
   */
  onRevealHistory: (anchorEntryId: string) => void;
  /**
   * The conversation's paged outline of committed user anchors, or null before a page has been answered.
   *
   * It is what makes a node beyond the loaded window renderable at all: the rail is an index over the conversation's
   * history, and this is that history's own statement of it. Without it the rail falls back to the measured transcript,
   * which is exactly the loaded-only behaviour this prop exists to replace.
   */
  outline: NavigationOutline | null;
  /**
   * Jump to a node the transcript does not carry, addressed by the coordinate the outline issued.
   *
   * One call is one bounded target read: the surface that owns the coordinator answers it, and the entry id travels
   * beside the coordinate so the alignment below can name the turn that arrives.
   */
  onJumpAnchor: (anchor: string, entryId: string) => void;
  /**
   * Ask for one further outline page, or for the first page again when the last read failed.
   *
   * A page is requested only when the reader reaches the end of what the rail has listed, so opening a long conversation
   * costs one bounded page rather than a walk over the whole history (spec decision 5).
   */
  onRequestOutline: () => void;
}

const MINIMAP_WIDTH = 36;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
/**
 * The height of the rail's keyboard opener, and where the dot rail therefore begins.
 *
 * The rail used to be reachable by pointing at it alone: every node it lists was a hover target, nothing in it took
 * focus, so a keyboard reader could neither open the outline, nor read a preview, nor ask for the rest of the history.
 * The opener is a real button, and the one offset below is shared by the node layout, the guide line and the hit test,
 * so a pointer's mapping from a pixel to a node stays exactly what it was.
 */
const MINIMAP_OPENER_HEIGHT = 24;
const RAIL_TOP = MINIMAP_PADDING + MINIMAP_OPENER_HEIGHT;
const PREVIEW_HIDE_DELAY = 250;

interface AssistantPreview {
  markdown: string;
  element: HTMLDivElement | null;
}

interface TurnInfo {
  /** The entry this turn is anchored on, which is the identity the surface reveals it by. */
  anchorEntryId: string | null;
  userMessage: UserMessage | CustomMessage;
  assistantPreviews: AssistantPreview[];
  /** Top of the turn's anchor element, in scroll coordinates. */
  scrollTop: number | null;
  /**
   * The turn's own anchor element, as the last measurement saw it.
   *
   * `scrollTop` is a *measurement*, and a windowed transcript unmounts turns as the reader moves away from them: the
   * number stays valid for the geometry it was taken in and points nowhere once the element is gone. Clicking such a
   * node would scroll to a turn that is not in the DOM, land somewhere else and report nothing — the silent no-op
   * history-navigation ticket 05 forbids. The element is kept so the click path can ask whether it is still connected,
   * which is the only fact that distinguishes "measured and on screen somewhere" from "measured once, now unmounted".
   */
  anchorElement: HTMLDivElement | null;
  /** Where the next turn starts (or the content end), in scroll coordinates. */
  bottom: number | null;
  /** Tool calls issued anywhere in this turn's assistant replies. */
  toolCount: number;
}

interface NodeInfo {
  topRatio: number;
  /** The rail node this dot stands for: identity, order and preview, with the measured turn when it is loaded. */
  rail: RailNode<TurnInfo>;
  index: number;
}

function getUserPreview(message: UserMessage | CustomMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Tool calls in one assistant message. A reply can both answer and call
 *  tools, so this counts blocks rather than text-less messages. */
export function countToolCalls(message: AgentMessage | Partial<AgentMessage>): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.reduce(
    (total, block) => total + (block.type === "toolCall" ? 1 : 0),
    0,
  );
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function PreviewHeading({
  level,
  children,
  headingIndex,
  onClick,
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  headingIndex: number | null;
  onClick?: (headingIndex: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.heading}
      data-level={level}
      data-preview-heading-index={headingIndex ?? undefined}
      disabled={headingIndex === null || !onClick}
      onClick={(event) => {
        event.stopPropagation();
        if (headingIndex !== null) onClick?.(headingIndex);
      }}
    >
      {children}
    </button>
  );
}

interface PreviewAstNode {
  type?: string;
  depth?: number;
  data?: {
    hProperties?: Record<string, unknown>;
  };
}

function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter((node) => (
      node.type === "heading" && typeof node.depth === "number" && node.depth <= 3
    ));
    if (headings.length > 0) {
      headings.forEach((node, headingIndex) => {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            "data-preview-heading-index": headingIndex,
          },
        };
      });
      tree.children = headings;
      return;
    }
    const firstParagraph = tree.children.find((node) => node.type === "paragraph");
    tree.children = firstParagraph ? [firstParagraph] : [];
  };
}

const previewRemarkPlugins = [
  ...(markdownPreviewRemarkPlugins ?? []),
  remarkPreviewOutline,
];
const previewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];

function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.["data-preview-heading-index"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export const AssistantOutline = memo(function AssistantOutline({
  markdown,
  onHeadingClick,
  onAnswerClick,
}: {
  markdown: string;
  onHeadingClick?: (headingIndex: number) => void;
  onAnswerClick?: () => void;
}) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  if (!markdown) return null;
  return (
    <div className={styles.outline}>
      <ReactMarkdown
        remarkPlugins={previewRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={{
          h1: ({ children, node }) => <PreviewHeading level={1} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h2: ({ children, node }) => <PreviewHeading level={2} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h3: ({ children, node }) => <PreviewHeading level={3} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h4: () => null,
          h5: () => null,
          h6: () => null,
          p: ({ children }) => (
            <button
              type="button"
              className={styles.paragraph}
              onClick={onAnswerClick}
            >
              {children}
            </button>
          ),
          blockquote: () => null,
          ul: () => null,
          ol: () => null,
          pre: () => null,
          table: () => null,
          hr: () => null,
          a: ({ children }) => <>{children}</>,
          code: ({ children }) => <>{children}</>,
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

/** One assistant preview: its two handlers are built from stable props, which is what keeps `AssistantOutline` memoized. */
const PreviewAnswer = memo(function PreviewAnswer({
  node,
  assistantIndex,
  markdown,
  onScrollToAssistant,
  onScrollToHeading,
}: {
  node: NodeInfo;
  assistantIndex: number;
  markdown: string;
  onScrollToAssistant: (node: NodeInfo, assistantIndex: number) => void;
  onScrollToHeading: (node: NodeInfo, assistantIndex: number, headingIndex: number) => void;
}) {
  const { t } = useI18n();
  const locateLabel = t("chatMinimap.locateAssistant");
  const onAnswerClick = useCallback(
    () => onScrollToAssistant(node, assistantIndex),
    [node, assistantIndex, onScrollToAssistant],
  );
  const onHeadingClick = useCallback(
    (headingIndex: number) => onScrollToHeading(node, assistantIndex, headingIndex),
    [node, assistantIndex, onScrollToHeading],
  );
  return (
    <div className={styles.assistant}>
      <button
        type="button"
        className={styles.assistantJump}
        data-minimap-preview-assistant={`${node.index}-${assistantIndex}`}
        onClick={onAnswerClick}
        aria-label={locateLabel}
        title={locateLabel}
      >
        A
      </button>
      <AssistantOutline
        markdown={markdown}
        onAnswerClick={onAnswerClick}
        onHeadingClick={onHeadingClick}
      />
    </div>
  );
});

/** One row of the rail's preview list: memoized on stable props so a pointer move re-renders only the rows whose located state changed. */
const PreviewRow = memo(function PreviewRow({
  node,
  isLocated,
  previewItemRefs,
  onScrollToNode,
  onScrollToAssistant,
  onScrollToHeading,
}: {
  node: NodeInfo;
  isLocated: boolean;
  previewItemRefs: RefObject<Map<number, HTMLDivElement>>;
  onScrollToNode: (node: NodeInfo, behavior: ScrollBehavior) => void;
  onScrollToAssistant: (node: NodeInfo, assistantIndex: number) => void;
  onScrollToHeading: (node: NodeInfo, assistantIndex: number, headingIndex: number) => void;
}) {
  // `t` is stable while the locale is, so translating in the row re-renders it on a language change only.
  const { t } = useI18n();
  const toolCount = node.rail.turn?.toolCount ?? 0;
  const toolCallsLabel = toolCount > 0 ? t("chatMinimap.toolCalls", { count: toolCount }) : null;
  return (
    <div
      ref={(element) => {
        if (element) previewItemRefs.current.set(node.index, element);
        else previewItemRefs.current.delete(node.index);
      }}
      className={styles.turn}
      data-minimap-preview-index={node.index}
      data-minimap-preview-entry={node.rail.entryId}
      data-minimap-preview-loaded={node.rail.loaded ? "" : undefined}
      data-located={isLocated ? "true" : undefined}
    >
      <span className={styles.number}>
        <span aria-hidden="true">
          {String(node.index + 1).padStart(2, "0")}
        </span>
        {toolCount > 0 && (
          <span
            className={styles.toolBadge}
            role="img"
            title={toolCallsLabel ?? undefined}
            aria-label={toolCallsLabel ?? undefined}
          >
            {toolCount > 99 ? "99+" : toolCount}
          </span>
        )}
      </span>
      <div className={styles.content}>
        <button
          type="button"
          className={styles.user}
          data-minimap-preview-user={node.index}
          // An unloaded node's preview is the server's own bounded text, and clicking it asks for the one bounded
          // target window that carries the message. Nothing here pages toward it.
          onClick={() => onScrollToNode(node, "smooth")}
        >
          <span className={styles.userText}>
            {railPreview(node.rail.preview)}
          </span>
        </button>

        {(node.rail.turn?.assistantPreviews ?? []).map((assistant, assistantIndex) => (
          <PreviewAnswer
            key={assistantIndex}
            node={node}
            assistantIndex={assistantIndex}
            markdown={assistant.markdown}
            onScrollToAssistant={onScrollToAssistant}
            onScrollToHeading={onScrollToHeading}
          />
        ))}
      </div>
    </div>
  );
});

function createTurnNodes(rails: RailNode<TurnInfo>[]): NodeInfo[] {
  return rails.map((rail, index) => ({
    topRatio: 0,
    rail,
    index,
  }));
}

interface NodeLayout {
  nodes: NodeInfo[];
  gap: number;
  fillsHeight: boolean;
}

function layoutNodes(allNodes: NodeInfo[], minimapHeight: number): NodeLayout {
  if (allNodes.length === 0) {
    return { nodes: [], gap: MAX_NODE_GAP, fillsHeight: false };
  }

  const height = Math.max(1, minimapHeight);
  const usableHeight = Math.max(0, height - RAIL_TOP - MINIMAP_PADDING);
  if (allNodes.length === 1) {
    return {
      nodes: [{ ...allNodes[0], topRatio: RAIL_TOP / height }],
      gap: MAX_NODE_GAP,
      fillsHeight: false,
    };
  }

  const naturalGap = usableHeight / (allNodes.length - 1);
  const gap = Math.min(MAX_NODE_GAP, naturalGap);
  return {
    nodes: allNodes.map((node, index) => ({
      ...node,
      topRatio: (RAIL_TOP + index * gap) / height,
    })),
    gap,
    fillsHeight: naturalGap <= MAX_NODE_GAP,
  };
}

export function ChatMinimap({
  messages,
  entryIds,
  streamingMessage,
  scrollContainer,
  messageRefs,
  onRevealHistory,
  outline,
  onJumpAnchor,
  onRequestOutline,
}: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  /**
   * The turns the transcript measured, in its own order. This is the only measured state the rail keeps: the node list
   * is *derived* from it plus the outline on every render, so a page arriving changes which nodes exist without waiting
   * for the next measurement — and a measurement never renumbers a node the reader is looking at.
   */
  const [measuredTurns, setMeasuredTurns] = useState<MeasuredTurn<TurnInfo>[]>([]);
  const [visibleIndices, setVisibleIndices] = useState<number[]>([]);
  /**
   * The navigation focus, held by **entry id** rather than by node position.
   *
   * A node's position is not stable: an outline page arriving in front of the list, or the tail of the transcript
   * growing past it, renumbers every node below the insertion. A focus kept by position would then sit on a different
   * message than the one the reader chose, so the identity is the entry and the index is derived per render.
   */
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [minimapHovered, setMinimapHovered] = useState(false);
  /**
   * Whether the reader opened the list with the keyboard rather than by pointing at the rail.
   *
   * A hover-opened list may close when the pointer leaves, because the pointer is the thing that opened it. A list opened
   * from the rail's own button is the reader's *focus*: leaving it with the pointer is not a reason to take away the
   * control they are tabbing through, so this holds it open until Escape, a second activation, or focus leaving the rail
   * entirely.
   */
  const [railPinned, setRailPinned] = useState(false);
  /** The pinned state as the pointer's own hide timer sees it, which runs outside the render that changed it. */
  const railPinnedRef = useRef(false);
  /** The row the opening asked for, taken once the list has rendered. */
  const focusRailRowRef = useRef<"first" | "last" | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeLayoutRef = useRef<NodeLayout>({
    nodes: [],
    gap: MAX_NODE_GAP,
    fillsHeight: false,
  });
  /** The rail's own list of preview rows, whose end is what asks for the next outline page. */
  const previewListRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A navigation waiting for the turn it names to be mounted. The turn is held **by identity**, not by the node's
   * position: the reveal the surface performs can change which turns exist in its own list, so an index recorded here
   * could name a different turn by the time the measurement runs.
   */
  const pendingNavigationRef = useRef<{
    anchorEntryId: string;
    target: "user" | "assistant" | "heading";
    assistantIndex?: number;
    headingIndex?: number;
  } | null>(null);
  /**
   * How many re-aims the pending alignment has spent, so a window that never settles cannot hold it forever.
   *
   * An alignment is not one scroll. A revealed turn is mounted at an *estimated* height and the transcript replaces its
   * spacers with real measurements afterwards, which moves everything below them: the single scroll a click used to
   * issue was computed against the estimate and left the target hundreds of pixels above the viewport, with nothing
   * named and nothing retried — the silent no-op ticket 05 forbids. Each measurement the surface takes therefore
   * re-aims at the target until it is actually on screen, and this counter is the bound on that.
   */
  const pendingNavigationAttemptsRef = useRef(0);
  /** The paged outline the rail is an index over. Read by the measurement timer, so it is held in a ref. */
  const outlineRef = useRef(outline);
  outlineRef.current = outline;

  /**
   * Whether the rail owes the reader a page: a continuation it has not read, or a read that failed.
   *
   * A failed page is a state between the reader and the rest of the history rather than the end of it, so it is offered
   * the same control as a continuation — reaching for it again is the retry.
   */
  const owesOutlinePage = outline !== null && !outline.loading && (outline.hasMore || outline.failure !== null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage],
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;
  // The entry ids are read by the measurement callback, which runs on a timer and must see the current ones.
  const entryIdsRef = useRef(entryIds);
  entryIdsRef.current = entryIds;

  /**
   * The rail's nodes: the conversation's committed anchors joined with the transcript's measurements.
   *
   * Derived rather than stored, because the two sources change independently — a page arrives, a turn is measured, the
   * tail grows — and a stored list would be stale in exactly the case this ticket is about (an outline page that adds
   * nodes the transcript never mounted). The join itself is `buildRailNodes`'s rule, stated and tested on its own.
   */
  const allNodes = useMemo(
    () => createTurnNodes(buildRailNodes({ outline, turns: measuredTurns })),
    [measuredTurns, outline],
  );
  const allNodesRef = useRef<NodeInfo[]>(allNodes);
  allNodesRef.current = allNodes;

  const nodeLayout = useMemo(
    () => layoutNodes(allNodes, minimapHeight),
    [allNodes, minimapHeight],
  );
  const { nodes: positionedNodes, gap: nodeGap } = nodeLayout;
  nodeLayoutRef.current = nodeLayout;

  /** Navigation focus: set by click/drag/keyboard and kept until the next one. */
  const focusNode = useCallback((entryId: string) => {
    setFocusedEntryId(entryId);
  }, []);

  /**
   * Every turn whose span intersects the viewport is highlighted, including a
   * turn still on screen only through a clipped top or bottom edge. Which turns
   * are highlighted follows the scroll position; the navigation focus does not.
   */
  const syncVisibleTurns = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const viewportTop = scrollEl.scrollTop;
    const viewportBottom = viewportTop + scrollEl.clientHeight;
    const nextVisible: number[] = [];
    for (const node of nextNodes) {
      // Only a node the transcript measured can be "on screen": an unloaded node has no geometry to compare against,
      // and inventing a position for it is exactly the claim this ticket removes (spec non-goals).
      const turn = node.rail.turn;
      if (turn === null || turn.scrollTop === null || turn.bottom === null) continue;
      if (turn.scrollTop < viewportBottom && turn.bottom > viewportTop) nextVisible.push(node.index);
    }
    setVisibleIndices((previous) => (
      previous.length === nextVisible.length
      && previous.every((index, position) => index === nextVisible[position])
        ? previous
        : nextVisible
    ));
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    const currentNodes = allNodesRef.current;
    setVisible(scrollable > 20);
    syncVisibleTurns(scrollEl, currentNodes);
  }, [scrollContainer, syncVisibleTurns]);

  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      const minimapEl = containerRef.current;
      if (!scrollEl || !minimapEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      const turns: TurnInfo[] = [];
      let refIndex = 0;
      let currentTurn: TurnInfo | null = null;
      let messageIndex = -1;

      for (const message of allMessagesRef.current) {
        messageIndex += 1;
        const isAnchor = isMessageGroupAnchor(message);
        if (!isAnchor && message.role !== "assistant") continue;
        const element = refs?.[refIndex];
        refIndex++;

        if (isAnchor) {
          currentTurn = null;
          const elementRect = element?.getBoundingClientRect();
          currentTurn = {
            anchorEntryId: entryIdsRef.current[messageIndex] ?? null,
            userMessage: message as UserMessage | CustomMessage,
            assistantPreviews: [],
            scrollTop: elementRect
              ? elementRect.top - containerRect.top + scrollEl.scrollTop
              : null,
            anchorElement: element ?? null,
            bottom: null,
            toolCount: 0,
          };
          turns.push(currentTurn);
          continue;
        }

        if (!currentTurn) continue;
        currentTurn.toolCount += countToolCalls(message);
        const answerMarkdown = getAssistantAnswerMarkdown(message);
        if (answerMarkdown) {
          currentTurn.assistantPreviews.push({
            markdown: answerMarkdown,
            element,
          });
        }
      }

      // A turn extends to the start of the next one; the last turn owns the
      // rest of the content, including a streaming reply that has no ref yet.
      turns.forEach((turn, index) => {
        turn.bottom = turns[index + 1]?.scrollTop ?? scrollEl.scrollHeight;
      });

      // Only the measurement is stored; the node list is derived from it and the outline on every render, so this
      // states what the transcript's geometry is and nothing about which nodes exist.
      const measured: MeasuredTurn<TurnInfo>[] = turns
        .filter((turn): turn is TurnInfo & { anchorEntryId: string } => turn.anchorEntryId !== null)
        .map((turn) => ({
          anchorEntryId: turn.anchorEntryId,
          preview: getUserPreview(turn.userMessage),
          turn,
        }));
      // The pending alignment below is resolved against the nodes this measurement produces, which is the same join the
      // render performs — read here rather than from the previous render's list, which a page may have changed.
      const nextNodes = createTurnNodes(buildRailNodes({ outline: outlineRef.current, turns: measured }));
      setMinimapHeight(minimapEl.clientHeight);
      setMeasuredTurns(measured);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
      syncVisibleTurns(scrollEl, nextNodes);

      const pendingNavigation = pendingNavigationRef.current;
      // The turn is found by the entry it is anchored on, which is the only identity that survives the reveal: the
      // node's position can move under it when an outline page arrives, and a rail node always has an entry.
      const pendingNode = pendingNavigation === null
        ? null
        : nextNodes.find((node) => node.rail.entryId === pendingNavigation.anchorEntryId) ?? null;
      const pendingTurn = pendingNode?.rail.turn ?? null;
      if (pendingNavigation && pendingNode && pendingTurn) {
        const assistant = pendingNavigation.assistantIndex === undefined
          ? null
          : pendingTurn.assistantPreviews[pendingNavigation.assistantIndex];
        // A user target is aligned from the element that is in the DOM *now*, for the same reason the click path is:
        // \`scrollTop\` is this measurement's snapshot, and the reveal that produced the turn rewrote the geometry below it
        // once the measured turn replaced its estimate. The measurement is the fallback for a turn whose element this
        // frame cannot read.
        const anchorRect = pendingNavigation.target === "user"
          ? pendingTurn.anchorElement?.getBoundingClientRect() ?? null
          : null;
        let targetTop: number | null = anchorRect === null
          ? pendingTurn.scrollTop
          : anchorRect.top - containerRect.top + scrollEl.scrollTop;
        if (pendingNavigation.target === "assistant") {
          const assistantRect = assistant?.element?.getBoundingClientRect();
          targetTop = assistantRect
            ? assistantRect.top - containerRect.top + scrollEl.scrollTop
            : null;
        } else if (pendingNavigation.target === "heading") {
          const heading = (
            pendingNavigation.headingIndex === undefined
              ? null
              : assistant?.element
                ?.querySelectorAll<HTMLElement>("h1, h2, h3")
                .item(pendingNavigation.headingIndex)
          );
          const headingRect = heading?.getBoundingClientRect();
          targetTop = headingRect
            ? headingRect.top - containerRect.top + scrollEl.scrollTop
            : null;
        }
        if (targetTop === null) return;
        const targetOffset = scrollEl.clientHeight * 0.3;
        const desired = Math.max(0, targetTop - targetOffset);
        // The alignment is finished when the container is already where the target needs it. Until then it is *still
        // pending*, which is what makes the next measurement (the one that replaced the estimate) re-aim instead of
        // leaving the reader beside the turn they asked for. A bounded number of attempts keeps a geometry that never
        // settles from holding the viewport for good; the reveal stays mounted either way.
        const settled = Math.abs(scrollEl.scrollTop - desired) < 8;
        if (settled) {
          pendingNavigationRef.current = null;
          pendingNavigationAttemptsRef.current = 0;
        } else if (pendingNavigationAttemptsRef.current >= 12) {
          pendingNavigationRef.current = null;
          pendingNavigationAttemptsRef.current = 0;
        } else {
          pendingNavigationAttemptsRef.current += 1;
        }
        focusNode(pendingNode.rail.entryId);
        scrollEl.scrollTo({ top: desired, behavior: settled ? "auto" : "smooth" });
      }
    }, 150);
  }, [focusNode, messageRefs, scrollContainer, syncVisibleTurns]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updateScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateScroll);
  }, [scrollContainer, updateScroll]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      measureNodes();
      updateScroll();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [measureNodes, scrollContainer, updateScroll]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      measureNodes();
      updateScroll();
    }, 50);
    return () => clearTimeout(timeout);
  }, [messages.length, measureNodes, updateScroll]);

  /**
   * Bring one rail node's user message on screen.
   *
   * Two behaviours, because there are two kinds of node and they are answered by different owners:
   *
   * - **loaded** — the transcript carries the turn, so this is the local measured jump it always was: one scroll to a
   *   box that was measured a moment ago, or a reveal when the turn is loaded but not mounted.
   * - **unloaded** — there is no box to scroll to and no reveal that can produce one, because the entry is not in the
   *   transcript at all. The node is handed to the surface as the coordinate the outline issued, which resolves it
   *   through the one bounded target read (history-navigation ticket 03). This component never pages toward it: a
   *   single hand-off, one read, and the surface's own alignment once the target's DOM exists.
   */
  const scrollToNode = useCallback((node: NodeInfo, behavior: ScrollBehavior) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    focusNode(node.rail.entryId);
    const turn = node.rail.turn;
    if (turn === null) {
      if (node.rail.anchor !== "") onJumpAnchor(node.rail.anchor, node.rail.entryId);
      return;
    }
    // A measured turn that is no longer mounted is the same case as one that was never measured: there is no box to
    // scroll to, so the surface is asked to mount it and the alignment below runs once it exists. Reading `scrollTop`
    // alone made an unmounted turn look navigable and turned the click into a scroll to a stale offset.
    if (turn.scrollTop === null || turn.anchorElement?.isConnected !== true) {
      pendingNavigationRef.current = { anchorEntryId: node.rail.entryId, target: "user" };
      pendingNavigationAttemptsRef.current = 0;
      onRevealHistory(node.rail.entryId);
      return;
    }
    // The offset is read from the element **now**, exactly as the assistant and heading jumps beside this one do, and
    // the measurement is only the fallback for a turn whose element this frame cannot read.
    //
    // A stored offset is a snapshot of a scroll coordinate, and the window rewrites its own geometry after the
    // measurement: an estimated spacer becomes a measured turn, everything below it moves, and the turn the reader
    // clicked is somewhere else than the coordinate says. Scrolling to the stored value then lands beside the target and
    // reports nothing — the silent no-op this ticket's acceptance forbids, and the state the ticket 05 journey found.
    const containerRect = scrollEl.getBoundingClientRect();
    const anchorRect = turn.anchorElement.getBoundingClientRect();
    const liveTop = anchorRect.top - containerRect.top + scrollEl.scrollTop;
    const targetTop = Math.max(
      0,
      liveTop - scrollEl.clientHeight * 0.3,
    );
    scrollEl.scrollTo({ top: targetTop, behavior });
  }, [focusNode, onJumpAnchor, onRevealHistory, scrollContainer]);

  const scrollToAssistant = useCallback((node: NodeInfo, assistantIndex: number) => {
    const scrollEl = scrollContainer.current;
    const turn = node.rail.turn;
    if (!scrollEl || turn === null) return;
    const assistantElement = turn.assistantPreviews[assistantIndex]?.element;
    if (!assistantElement) {
      pendingNavigationRef.current = { anchorEntryId: node.rail.entryId, target: "assistant", assistantIndex };
      pendingNavigationAttemptsRef.current = 0;
      onRevealHistory(node.rail.entryId);
      return;
    }
    const containerRect = scrollEl.getBoundingClientRect();
    const assistantRect = assistantElement.getBoundingClientRect();
    const targetTop = (
      assistantRect.top
      - containerRect.top
      + scrollEl.scrollTop
      - scrollEl.clientHeight * 0.3
    );
    focusNode(node.rail.entryId);
    scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [focusNode, onRevealHistory, scrollContainer]);

  const findNearestNode = useCallback((ratio: number): NodeInfo | null => {
    const { nodes, gap, fillsHeight } = nodeLayoutRef.current;
    const height = containerRef.current?.clientHeight ?? 0;
    if (nodes.length === 0 || height <= 0) return null;

    const pointerY = Math.max(0, Math.min(height, ratio * height));
    const firstNodeY = nodes[0].topRatio * height;
    const rawIndex = gap > 0 ? Math.round((pointerY - firstNodeY) / gap) : 0;
    const nodeIndex = Math.max(0, Math.min(nodes.length - 1, rawIndex));
    const nearestNode = nodes[nodeIndex];

    if (!fillsHeight) {
      const nodeY = nearestNode.topRatio * height;
      const hitRadius = Math.max(10, gap / 2);
      if (Math.abs(pointerY - nodeY) > hitRadius) return null;
    }
    return nearestNode;
  }, []);

  const scrollToHeading = useCallback((
    node: NodeInfo,
    assistantIndex: number,
    headingIndex: number,
  ) => {
    const scrollEl = scrollContainer.current;
    const turn = node.rail.turn;
    if (!scrollEl || turn === null) return;
    const answerElement = turn.assistantPreviews[assistantIndex]?.element;
    if (!answerElement) {
      pendingNavigationRef.current = {
        anchorEntryId: node.rail.entryId,
        target: "heading",
        assistantIndex,
        headingIndex,
      };
      pendingNavigationAttemptsRef.current = 0;
      onRevealHistory(node.rail.entryId);
      return;
    }
    const heading = answerElement.querySelectorAll<HTMLElement>("h1, h2, h3").item(headingIndex);
    if (!heading) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const targetTop = (
      headingRect.top
      - containerRect.top
      + scrollEl.scrollTop
      - scrollEl.clientHeight * 0.3
    );
    focusNode(node.rail.entryId);
    scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [focusNode, onRevealHistory, scrollContainer]);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  /** Whether the list is open, by pointer or by keyboard. */
  const previewOpen = minimapHovered || railPinned;

  const showPreview = useCallback(() => {
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide]);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      // A list the reader pinned from the keyboard stays open: leaving it with the pointer is not their way out.
      setMinimapHovered((current) => (railPinnedRef.current ? current : false));
      setMouseYRatio(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  /**
   * Open or close the rail list from the keyboard.
   *
   * Activation is the opener button and nothing else: the rail is not a widget with a role of its own, because what
   * it opens is a list of ordinary buttons a reader tabs through. Closing returns the focus to the opener, so the next
   * Tab continues where the reader was instead of dropping them at the top of the page.
   */
  const toggleRail = useCallback((open: boolean) => {
    cancelPreviewHide();
    railPinnedRef.current = open;
    setRailPinned(open);
    setMinimapHovered(open);
    if (open) {
      // The rows exist only once this state has committed, so the focus is taken by the effect below: asking for the
      // first row here would aim at nothing and leave the reader on the opener with a list they cannot get into.
      focusRailRowRef.current = "first";
      return;
    }
    focusRailRowRef.current = null;
    setMouseYRatio(null);
    openerRef.current?.focus();
  }, [cancelPreviewHide]);

  useEffect(() => {
    const wanted = focusRailRowRef.current;
    if (wanted === null || !previewOpen) return;
    focusRailRowRef.current = null;
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-minimap-preview-user]") ?? []);
    const target = wanted === "last" ? rows.at(-1) : rows[0];
    if (target !== undefined) target.focus();
    else openerRef.current?.focus();
  }, [previewOpen]);

  /**
   * The rail closes when focus leaves it for something outside the rail.
   *
   * This is the keyboard equivalent of moving the pointer away, and it is what stops a pinned list from holding a
   * column of off-screen buttons in the tab order of a conversation the reader has moved on from.
   */
  useEffect(() => {
    if (!railPinned) return;
    const rail = containerRef.current;
    if (rail === null) return;
    const onFocusOut = (event: FocusEvent) => {
      if (rail.contains(event.relatedTarget as Node | null)) return;
      railPinnedRef.current = false;
      setRailPinned(false);
      setMinimapHovered(false);
    };
    rail.addEventListener("focusout", onFocusOut);
    return () => rail.removeEventListener("focusout", onFocusOut);
  }, [railPinned]);

  /**
   * Arrow keys move the rail's focus between listed turns.
   *
   * The list is a scrollable column of rows taller than the viewport, and Tab alone would have the reader step
   * through every assistant answer and heading of a turn before reaching the next one. Up and Down therefore walk the
   * turn rows in the order the outline states them — the same ordered list the pointer reads — and focusing a row is
   * what scrolls it into view. Nothing here scrolls the transcript: a key moves focus, only an activation navigates.
   */
  const handleRailKeys = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!previewOpen) return;
      event.preventDefault();
      toggleRail(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rail = containerRef.current;
    if (rail === null) return;
    const rows = Array.from(rail.querySelectorAll<HTMLElement>("[data-minimap-preview-user]"));
    if (rows.length === 0) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const position = focused === null ? -1 : rows.indexOf(focused);
    const step = event.key === "ArrowDown" ? 1 : -1;
    // From the opener, Down enters the list at its first row and Up at its last. The continuation control at the end
    // of the list is reached by tabbing from the last row, because it is not a turn.
    // From the opener — which is not one of the rows — Down enters the list at its first row and Up at its last.
    // The continuation control at the end of the list is reached by tabbing from the last row, because it is not
    // a turn either.
    const at = position === -1 ? (step > 0 ? 0 : rows.length - 1) : position + step;
    const next = rows[Math.max(0, Math.min(rows.length - 1, at))];
    event.preventDefault();
    if (next !== undefined) next.focus();
  }, [previewOpen, toggleRail]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  /**
   * Ask for the next outline page when the reader reaches the end of the list.
   *
   * The request is one page and nothing else - each answer is decided by the page's own hasMore, and nothing counts a
   * page against a total. Two things are deliberately excluded: a request while a page is in flight (the state already
   * de-duplicates an anchor, but a repeated arrow would still spend a read), and any request for a node the reader has
   * not reached. The rail pages its own list; it never pages a transcript.
   */
  const requestMoreOutline = useCallback(() => {
    const held = outlineRef.current;
    if (held === null || held.loading) return;
    if (!held.hasMore && held.failure === null) return;
    onRequestOutline();
  }, [onRequestOutline]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    showPreview();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setMouseYRatio(pointerRatio);
    const jumpToPointer = (clientY: number, behavior: ScrollBehavior) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const node = findNearestNode(ratio);
      if (node) {
        scrollToNode(node, behavior);
      }
    };

    jumpToPointer(event.clientY, "smooth");
    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      jumpToPointer(moveEvent.clientY, "auto");
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [findNearestNode, scrollToNode, showPreview, visible]);

  const nearestNode = mouseYRatio === null ? null : findNearestNode(mouseYRatio);
  const nearestNodeIndex = nearestNode?.index ?? null;

  useEffect(() => {
    if (!minimapHovered || nearestNodeIndex === null) return;
    const previewBox = previewListRef.current;
    const previewItem = previewItemRefs.current.get(nearestNodeIndex);
    if (!previewBox || !previewItem) return;
    const targetTop = previewItem.offsetTop
      - (previewBox.clientHeight - previewItem.offsetHeight) / 2;
    previewBox.scrollTop = Math.max(0, targetTop);
  }, [allNodes, minimapHovered, nearestNodeIndex]);

  if (!visible) return null;

  const lastNodeTop = positionedNodes.length > 0
    ? positionedNodes[positionedNodes.length - 1].topRatio * minimapHeight
    : RAIL_TOP;
  const railHeight = Math.max(1, lastNodeTop - RAIL_TOP);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewHide}
      onKeyDown={handleRailKeys}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMouseYRatio((event.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "pointer",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      {/* The keyboard's way into the rail. It is a button, not a hover region: with the list closed there is nothing
          in the rail to focus, and a reader who tabs past the transcript would otherwise pass the whole history by.
          Its label states what it opens rather than what it is, because "minimap" describes a picture, and what the
          reader is opening is the conversation's own index of committed messages. */}
      <button
        type="button"
        ref={openerRef}
        className={styles.opener}
        data-minimap-opener=""
        aria-expanded={previewOpen}
        aria-controls="hepi-minimap-preview"
        title={t(previewOpen ? "chatMinimap.close" : "chatMinimap.open")}
        aria-label={t(previewOpen ? "chatMinimap.close" : "chatMinimap.open")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => toggleRail(!railPinned)}
      >
        <span aria-hidden="true">{"≡"}</span>
      </button>

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: RAIL_TOP,
          height: railHeight,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {positionedNodes.map((node) => {
        const isNearest = minimapHovered && nearestNode?.index === node.index;
        const isVisibleTurn = visibleIndices.includes(node.index);
        const isFocused = focusedEntryId === node.rail.entryId;

        return (
          <div
            key={node.rail.entryId}
            data-minimap-node-index={node.index}
            data-minimap-node-entry={node.rail.entryId}
            // Which of the two kinds of node this is, stated in the DOM: a *loaded* node is one the transcript measured
            // and is therefore on screen somewhere, and an *unloaded* one is a committed anchor the rail knows about and
            // the transcript does not carry. It is the attribute a browser journey reads instead of guessing from the
            // dot's shade, and it is why an unloaded node can never claim to be visible.
            data-minimap-node-loaded={node.rail.loaded ? "" : undefined}
            data-minimap-node-visible={isVisibleTurn ? "" : undefined}
            data-minimap-node-focused={isFocused ? "" : undefined}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: Math.max(1, nodeGap),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: node.rail.loaded ? 2 : 999,
                // An unloaded node is drawn hollow, because that is what it is: the rail knows it exists and where it
                // sits in the conversation's order, and knows nothing about how tall it is. Filling it like a measured
                // node would be the claim this ticket removes.
                background: node.rail.loaded
                  ? (isVisibleTurn ? "rgba(128,128,128,0.42)" : "rgba(128,128,128,0.16)")
                  : "transparent",
                border: `1.5px solid ${isVisibleTurn ? "rgba(128,128,128,0.95)" : "rgba(128,128,128,0.58)"}`,
                boxShadow: isFocused ? "0 0 0 2px var(--bg-panel)" : "none",
                transition: "transform 0.1s, background 0.1s",
                transform: isNearest ? "scale(1.25)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      {previewOpen && allNodes.length > 0 && (
        <div
          ref={previewListRef}
          className={styles.preview}
          id="hepi-minimap-preview"
          data-minimap-preview-box=""
          onMouseEnter={showPreview}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseMove={(event) => event.stopPropagation()}
        >
          {allNodes.map((node) => (
            <PreviewRow
              key={node.index}
              node={node}
              isLocated={nearestNodeIndex === node.index}
              previewItemRefs={previewItemRefs}
              onScrollToNode={scrollToNode}
              onScrollToAssistant={scrollToAssistant}
              onScrollToHeading={scrollToHeading}
            />
          ))}

          {/* The rest of the history, or the failure that stood between the reader and it.
              A page is read when the reader asks for it and never by being seen: an automatic load on visibility would
              walk every page of a long conversation the moment the rail opened, which is the unbounded read the spec
              forbids. So this is one control, and one read per activation. A failed continuation is named here rather
              than left as a list that simply ends, and the same control is its retry. */}
          {owesOutlinePage && (
            <div
              className={styles.turn}
              data-minimap-outline-more=""
              data-minimap-outline-failure={outline.failure ?? undefined}
              role={outline.failure === null ? undefined : "status"}
              aria-live={outline.failure === null ? undefined : "polite"}
            >
              <span className={styles.number} aria-hidden="true">{outline.failure === null ? "···" : "!"}</span>
              <div className={styles.content}>
                <button
                  type="button"
                  className={styles.user}
                  data-minimap-outline-request=""
                  onClick={requestMoreOutline}
                >
                  <span className={styles.userText}>
                    {outline.failure === null
                      ? t("chatMinimap.moreAnchors")
                      : t(navigationOutcomeKey(outline.failure))}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
