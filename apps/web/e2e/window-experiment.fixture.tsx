/**
 * Ticket 09 experiment fixture: can a long transcript mount only the turns near the viewport while keeping the
 * behaviours the chat already has?
 *
 * This is a prototype, not production. It answers one question — which window implementation a long conversation should
 * use — with real browser measurements, and it records the interface production will need. The production chat keeps its
 * current renderer until ticket 10 adopts the winner, so nothing here is imported by the app.
 *
 * Turns are described by the production turn model (`lib/chat-turn-model.ts`, ticket 08) and drawn by the production
 * `MessageView`, so the heights measured are the heights the real transcript produces: markdown, images, collapsed and
 * expanded process groups and a growing streaming tail. Only the windowing itself is under test.
 *
 * Two candidates are mounted behind one interface (`WindowAdapter`), given the same turns, viewport, overscan and ref
 * contract:
 *   - `platform`: measured-height windowing built from ResizeObserver and spacer elements.
 *   - `tanstack`: `@tanstack/react-virtual` 3.14.19's dynamic measurement (MIT).
 *
 * The ref contract is the one production `ChatMinimap` reads: one array entry per turn anchor and per assistant message,
 * in message order, `null` for anything not mounted.
 *
 * `revealKey` is the interface a windowed transcript needs and the current renderer does not: a turn that is not
 * mounted cannot be scrolled to, so the surface must be able to say *which turn* it needs and have the window include
 * it. The minimap's own `onRevealHistory(turnIndex)` and the search path both go through it here, which is what makes
 * their measurements evidence about the production interface rather than about this fixture.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createRoot } from "react-dom/client";
import { MessageView } from "@hepi/ui/components/MessageView";
import { ChatMinimap, useMessageRefs } from "@hepi/ui/components/ChatMinimap";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { buildTurnModel, type TurnDescription, type TurnItem } from "@hepi/ui/lib/chat-turn-model";
import { useTranscriptWindow } from "@hepi/ui/lib/transcript-window";
import { TranscriptWindowSurface } from "@hepi/ui/lib/transcript-window-surface";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@hepi/ui/lib/types";

const OVERSCAN = 4;
const ESTIMATED_TURN_HEIGHT = 320;

export interface WindowAdapterProps {
  turns: TurnDescription[];
  renderTurn: (turn: TurnDescription) => ReactNode;
  overscan: number;
  /**
   * The scrolling element itself, not a ref to it: React commits a child's layout effects before the parent's ref is
   * attached, so a ref read from a child's own mount effect is still null.
   */
  scrollElement: HTMLDivElement | null;
  /** A turn the surface needs on screen even though it is far outside the viewport. */
  revealKey: string | null;
  /** Reports how many turns are currently mounted, for the driver's own accounting. */
  onMounted: (count: number) => void;
}

export interface WindowAdapter {
  name: string;
  Component: (props: WindowAdapterProps) => ReactNode;
}

/**
 * The slices a window must mount: the contiguous run covering the viewport plus overscan, and — when a turn is being
 * revealed — that turn alone. A reveal must not span the distance between the viewport and its target: the turns in
 * between are exactly the ones a window exists to keep unmounted.
 */
function windowSlices(
  turns: TurnDescription[],
  heights: Record<string, number>,
  viewportTop: number,
  viewportBottom: number,
  clientHeight: number,
  overscan: number,
  revealIndex: number,
): Array<{ start: number; end: number }> {
  const heightOf = (turn: TurnDescription) => heights[turn.key] ?? ESTIMATED_TURN_HEIGHT;
  // A transcript that fits the viewport is mounted whole: a window must never hide the only content there is.
  const totalHeight = turns.reduce((sum, turn) => sum + heightOf(turn), 0);
  if (totalHeight <= clientHeight) return [{ start: 0, end: turns.length }];

  let start = 0;
  let offset = 0;
  while (start < turns.length && offset + heightOf(turns[start]) < viewportTop) {
    offset += heightOf(turns[start]);
    start += 1;
  }
  let end = start;
  while (end < turns.length && offset < viewportBottom) {
    offset += heightOf(turns[end]);
    end += 1;
  }
  const range = {
    start: Math.max(0, start - overscan),
    end: Math.min(turns.length, Math.max(end + overscan, start + 1)),
  };
  const slices = [range];
  if (revealIndex >= 0 && (revealIndex < range.start || revealIndex >= range.end)) {
    slices.push({ start: revealIndex, end: revealIndex + 1 });
    slices.sort((a, b) => a.start - b.start);
  }
  return slices;
}

/** Measured-height windowing on the platform alone: remembered heights, two spacers, no library. */
function PrototypeWindow({ turns, renderTurn, overscan, scrollElement, revealKey, onMounted }: WindowAdapterProps) {
  const [, setVersion] = useState(0);
  const heightsRef = useRef<Record<string, number>>({});
  const [slices, setSlices] = useState<Array<{ start: number; end: number }>>([{ start: 0, end: 0 }]);

  const measure = useCallback((key: string, element: HTMLDivElement | null) => {
    if (!element) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0 && heightsRef.current[key] !== height) {
      heightsRef.current[key] = height;
      setVersion((previous) => previous + 1);
    }
  }, []);

  const recompute = useCallback(() => {
    const scroll = scrollElement;
    if (!scroll) return;
    const revealIndex = revealKey === null ? -1 : turns.findIndex((turn) => turn.key === revealKey);
    const next = windowSlices(
      turns,
      heightsRef.current,
      scroll.scrollTop,
      scroll.scrollTop + scroll.clientHeight,
      scroll.clientHeight,
      overscan,
      revealIndex,
    );
    setSlices((previous) => (
      previous.length === next.length
      && previous.every((slice, index) => slice.start === next[index].start && slice.end === next[index].end)
        ? previous
        : next
    ));
  }, [overscan, revealKey, scrollElement, turns]);

  useLayoutEffect(() => {
    const scroll = scrollElement;
    if (!scroll) return;
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(scroll);
    const onScroll = () => recompute();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [recompute, scrollElement]);

  useLayoutEffect(() => { recompute(); }, [recompute, turns.length]);

  const mountedCount = slices.reduce((sum, slice) => sum + (slice.end - slice.start), 0);
  useEffect(() => { onMounted(mountedCount); }, [mountedCount, onMounted]);

  const offsetOf = (index: number) => {
    let total = 0;
    for (let position = 0; position < index; position += 1) {
      total += heightsRef.current[turns[position].key] ?? ESTIMATED_TURN_HEIGHT;
    }
    return total;
  };

  let cursor = 0;
  const blocks: ReactNode[] = [];
  for (const [index, slice] of slices.entries()) {
    if (slice.start > cursor) {
      blocks.push(<div key={`spacer-${index}`} style={{ height: offsetOf(slice.start) - offsetOf(cursor) }} data-window-spacer="between" />);
    }
    for (const turn of turns.slice(slice.start, slice.end)) {
      blocks.push(
        <div key={turn.key} ref={(element) => { measure(turn.key, element); }} data-window-turn={turn.key}>
          {renderTurn(turn)}
        </div>,
      );
    }
    cursor = slice.end;
  }
  if (cursor < turns.length) {
    blocks.push(<div key="spacer-tail" style={{ height: offsetOf(turns.length) - offsetOf(cursor) }} data-window-spacer="tail" />);
  }

  return (
    <div data-window="platform" data-window-range={slices.map((slice) => `${slice.start}-${slice.end}`).join(",")} style={{ position: "relative" }}>
      {blocks}
    </div>
  );
}

/** `@tanstack/react-virtual`'s dynamic measurement, behind the same interface. */
function TanStackWindow({ turns, renderTurn, overscan, scrollElement, revealKey, onMounted }: WindowAdapterProps) {
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    overscan,
    getItemKey: (index: number) => turns[index].key,
  });
  const items = virtualizer.getVirtualItems();
  useEffect(() => { onMounted(items.length); }, [items.length, onMounted]);

  const revealIndex = revealKey === null ? -1 : turns.findIndex((turn) => turn.key === revealKey);
  useEffect(() => {
    if (revealIndex >= 0) virtualizer.scrollToIndex(revealIndex, { align: "start" });
  }, [revealIndex, virtualizer]);

  return (
    <div data-window="tanstack" data-window-range={`${items[0]?.index ?? 0}-${items.at(-1)?.index ?? 0}`} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {items.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-window-turn={turns[item.index].key}
          ref={(element) => { virtualizer.measureElement(element); }}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
        >
          {renderTurn(turns[item.index])}
        </div>
      ))}
    </div>
  );
}

/**
 * The **production** window (ticket 10's `lib/transcript-window.ts`), behind the same interface. It is the same
 * module the chat renders with, so this candidate's measurements are evidence about what ships rather than about a
 * prototype that resembles it.
 */
function ProductionWindow({ turns, renderTurn, overscan, scrollElement, revealKey, onMounted }: WindowAdapterProps) {
  const window = useTranscriptWindow({ turns, scrollElement, revealKey, overscan });
  const mountedCount = window.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  useEffect(() => { onMounted(mountedCount); }, [mountedCount, onMounted]);

  return (
    <div
      data-window="production"
      data-window-range={window.ranges.map((range) => `${range.start}-${range.end}`).join(",")}
      style={{ position: "relative" }}
    >
      <TranscriptWindowSurface
        turns={turns}
        ranges={window.ranges}
        offsets={window.offsets}
        totalHeight={window.totalHeight}
        observe={window.observe}
        renderTurn={renderTurn}
      />
    </div>
  );
}

export const ADAPTERS: WindowAdapter[] = [
  { name: "production", Component: ProductionWindow },
  { name: "platform", Component: PrototypeWindow },
  { name: "tanstack", Component: TanStackWindow },
];

/* ---------------------------------------------------------------- fixture conversation */

const IMAGE_DATA = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iIzMzNiIvPjwvc3ZnPg==";

/** One turn's messages: a question, a tool call with its result, and an answer of varying length. */
function turnMessages(index: number): AgentMessage[] {
  const paragraphs = 1 + (index % 5);
  const huge = index > 0 && index % 97 === 0;
  const answer = Array.from({ length: paragraphs }, (_, position) => (
    `Paragraph ${position + 1} of answer ${index}. ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(huge ? 400 : 3)
  )).join("\n\n");
  const answerBlocks: AssistantMessage["content"] = [{ type: "text", text: answer }];
  if (index % 11 === 0) {
    answerBlocks.push({ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: IMAGE_DATA } });
  }
  return [
    { role: "user", content: `Question ${index}: what does file-${index}.ts do?\n\n` + "Context line. ".repeat(4) },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: `call-${index}`, toolName: "read", input: { path: `/src/file-${index}.ts` } }], model: "fixture", provider: "fixture" },
    { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: `contents of file-${index}.ts`.repeat(huge ? 2000 : 4) }] },
    { role: "assistant", content: answerBlocks, model: "fixture", provider: "fixture" },
  ] as AgentMessage[];
}

interface ExperimentController {
  setAdapter(name: string): void;
  setMessageCount(count: number): void;
  scrollToRatio(ratio: number): void;
  scrollToTail(): void;
  /** Set the process group of the turn with this key, wherever it is in the transcript. */
  setProcessExpanded(key: string, expanded: boolean): void;
  isProcessExpanded(key: string): boolean;
  /** Reveal by identity, the way search does: the surface names the turn, the window includes it. */
  searchTurn(index: number): void;
  revealRequests(): number[];
  setStreaming(streaming: boolean): void;
  growStream(characters: number): void;
  /** Grow one mounted turn's answer without re-rendering it from the top: an async image or font swap, in miniature. */
  growTurn(key: string, characters: number): void;
  /** Insert `count` turns in front of the transcript, the way a page of older history is prepended. */
  prependTurns(count: number): void;
  turnCount(): number;
  /** The turn keys in transcript order, so a check can name the last turn without guessing at its key. */
  turnKeys(): string[];
  metrics(): {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    mounted: number;
    /** Every element in the document, including the surface's own chrome (the minimap). */
    domNodes: number;
    /** Elements inside the window container: the transcript's mounted turns plus its spacers. */
    windowDom: number;
    /** Elements inside the minimap: one node per turn, so it grows with the transcript, not with the window. */
    minimapDom: number;
    /** Elements inside each mounted turn's own subtree. */
    perTurnDom: number[];
    /** Elements inside the mounted turns only: what the window bounds, without the minimap or the spacers. */
    mountedHistoryDom: number;
  };
}

declare global {
  interface Window { __experiment?: ExperimentController }
}

function Fixture() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [adapterName, setAdapterName] = useState("production");
  const [messageCount, setMessageCount] = useState(200);
  /**
   * A page of older history in front of the transcript. `offset` makes the prepended turns distinct from the ones
   * already there (a real page has different content, and reusing keys would hide a prepend bug behind React's reuse).
   */
  const [prepended, setPrepended] = useState<{ offset: number; count: number }>({ offset: 0, count: 0 });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [searchEntry, setSearchEntry] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [streamTail, setStreamTail] = useState("Streaming answer that keeps growing. ".repeat(4));
  const [mounted, setMounted] = useState(0);
  const mountedRef = useRef(0);
  const revealRequestsRef = useRef<number[]>([]);
  /**
   * Each turn's own default expansion (a turn with no final answer starts open), so a toggle inverts what the reader is
   * looking at rather than assuming a collapsed default. It is a ref because a toggle must read it without re-rendering.
   */
  const defaultExpansionRef = useRef<Record<string, boolean>>({});
  const isExpanded = (key: string) => expandedRef.current[key] ?? defaultExpansionRef.current[key] ?? false;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const onMounted = useCallback((count: number) => { mountedRef.current = count; setMounted(count); }, []);

  // Entry ids are stable identities, not positions: a page prepended in front of the transcript must not rename the
  // turns already on screen, or the window's reveal and prepend anchors (which are keys, not indices) would lose the
  // turn the reader is looking at.
  const { messages, entryIds } = useMemo(() => {
    const built: AgentMessage[] = [];
    const ids: string[] = [];
    const append = (prefix: string, turnIndex: number) => {
      const messages = turnMessages(turnIndex);
      for (const [position, message] of messages.entries()) {
        built.push(message);
        // The id names the turn and the message inside it, never the message's position in the transcript: prepending
        // a page must not rename the turns already on screen, or the window's key-based reveal and prepend anchors
        // would lose the turn the reader is looking at.
        ids.push(`${prefix}${turnIndex}-${position}`);
      }
    };
    for (let index = 0; index < prepended.count; index += 1) append("p", prepended.offset + index);
    for (let index = 0; index < messageCount; index += 1) append("e", index);
    return { messages: built, entryIds: ids };
  }, [messageCount, prepended]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") map.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
    }
    return map;
  }, [messages]);

  const turnModel = useMemo(() => buildTurnModel({
    messages,
    entryIds,
    toolResults,
    cwd: "/repo",
    sessionBusy: streaming,
    isStreaming: streaming,
  }), [messages, entryIds, toolResults, streaming]);
  const messageRefs = useMessageRefs(turnModel.refCount);

  /**
   * A reveal request: the surface names the entry a turn is anchored on and the window is asked to include that turn.
   *
   * The identity is resolved through the turn descriptions rather than used as an index, because the minimap's own
   * turn enumeration and the transcript's turn list are not the same: the transcript draws a leading mid-turn segment
   * as a turn that has no anchor message, so a positional index from the minimap can name a different turn.
   */
  const revealTurnByAnchor = useCallback((anchorEntryId: string) => {
    const turn = turnModel.turns.find((candidate) => (
      (candidate.anchorEntryId ?? entryIds[candidate.startIndex]) === anchorEntryId
    ));
    if (!turn) return;
    revealRequestsRef.current.push(turnModel.turns.indexOf(turn));
    setRevealKey(turn.key);
    const answer = turn.items.find((item) => item.kind === "answer");
    if (answer) setSearchEntry(entryIds[answer.index]);
  }, [entryIds, turnModel.turns]);

  /** The driver's own control surface: it names a turn position, which is resolved to the turn's identity here. */
  const revealTurnIndex = useCallback((index: number) => {
    const turn = turnModel.turns[index];
    if (!turn) return;
    revealTurnByAnchor(turn.anchorEntryId ?? entryIds[turn.startIndex] ?? "");
  }, [entryIds, revealTurnByAnchor, turnModel.turns]);

  // Once the revealed turn is mounted, bring it to the viewport and clear the request: the window is a viewport
  // again, and the turn stays mounted only as long as the reader is near it.
  useEffect(() => {
    if (revealKey === null || !scrollElement) return;
    const element = scrollElement.querySelector<HTMLElement>(`[data-window-turn="${revealKey}"]`);
    if (!element) return;
    const top = element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
    scrollElement.scrollTo({ top: Math.max(0, top - scrollElement.clientHeight * 0.3), behavior: "instant" });
    setRevealKey(null);
  }, [revealKey, scrollElement]);

  const renderTurn = useCallback((turn: TurnDescription) => (
    <div data-fixture-turn={turn.key} style={{ marginBottom: 18 }}>
      {turn.items.map((item: TurnItem) => {
        if (item.kind === "process") {
          defaultExpansionRef.current[turn.key] = item.defaultExpanded;
          const isOpen = expanded[turn.key] ?? item.defaultExpanded;
          return (
            <div key={item.key} data-fixture-process={turn.key}>
              <button
                type="button"
                data-fixture-process-toggle={turn.key}
                aria-expanded={isOpen}
                onClick={() => setExpanded((previous) => ({ ...previous, [turn.key]: !isOpen }))}
              >
                {item.messageCount} messages · {item.toolCallCount} tool calls
              </button>
              {isOpen && (
                <div>
                  {item.entries.map((entry) => (
                    <MessageView key={entry.viewKey} message={entry.message} toolResults={toolResults} cwd="/repo" sessionId="experiment" />
                  ))}
                </div>
              )}
            </div>
          );
        }
        const refIndex = item.refIndex;
        return (
          <div key={item.key} ref={refIndex === null ? undefined : (element) => { messageRefs.current[refIndex] = element; }} data-fixture-item={item.key}>
            <MessageView
              message={item.message}
              toolResults={toolResults}
              cwd="/repo"
              sessionId="experiment"
              searchBlock={searchEntry === entryIds[item.index] ? (item.message as AssistantMessage).content?.find((block) => block.type === "text") : undefined}
            />
          </div>
        );
      })}
    </div>
  ), [entryIds, expanded, messageRefs, searchEntry, toolResults]);

  const Adapter = (ADAPTERS.find((adapter) => adapter.name === adapterName) ?? ADAPTERS[0]).Component;

  useEffect(() => {
    const controller: ExperimentController = {
      setAdapter: (name) => setAdapterName(name),
      setMessageCount: (count) => setMessageCount(count),
      scrollToRatio: (ratio) => {
        const scroll = scrollRef.current;
        if (scroll) scroll.scrollTo({ top: (scroll.scrollHeight - scroll.clientHeight) * ratio, behavior: "instant" });
      },
      scrollToTail: () => {
        const scroll = scrollRef.current;
        if (scroll) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
      },
      setProcessExpanded: (key, value) => setExpanded((previous) => ({ ...previous, [key]: value })),
      isProcessExpanded: isExpanded,
      searchTurn: (index) => revealTurnIndex(index),
      revealRequests: () => revealRequestsRef.current,
      setStreaming,
      growStream: (characters) => setStreamTail((previous) => previous + "x".repeat(characters)),
      // Growth that React never renders: a node is appended to the mounted turn directly, which is what an image
      // finishing decode or a web font swapping in looks like to the window. Only an observer on the turn node can
      // see it — a measurement taken in the turn's React ref would never run again.
      growTurn: (key, pixels) => {
        const turn = document.querySelector(`[data-window-turn="${CSS.escape(key)}"]`);
        if (!turn) return;
        const growth = document.createElement("div");
        growth.dataset.fixtureGrowth = key;
        growth.style.height = `${pixels}px`;
        growth.style.background = "rgba(0,0,0,0.03)";
        turn.appendChild(growth);
      },
      prependTurns: (count) => setPrepended((previous) => ({ offset: previous.offset + 1000, count: previous.count + count })),
      turnCount: () => turnModel.turns.length,
      turnKeys: () => turnModel.turns.map((turn) => turn.key),
      metrics: () => {
        const scroll = scrollRef.current;
        const windowRoot = document.querySelector("[data-window]");
        const minimapRoot = document.querySelector("[data-fixture-minimap]");
        const count = (root: Element | null) => (root === null ? 0 : root.querySelectorAll("*").length + 1);
        const turnRoots = Array.from(document.querySelectorAll("[data-window-turn]"));
        return {
          scrollTop: scroll?.scrollTop ?? 0,
          clientHeight: scroll?.clientHeight ?? 0,
          scrollHeight: scroll?.scrollHeight ?? 0,
          mounted: mountedRef.current,
          domNodes: document.querySelectorAll("*").length,
          windowDom: count(windowRoot),
          minimapDom: count(minimapRoot),
          perTurnDom: turnRoots.map((root) => root.querySelectorAll("*").length + 1),
          // What the window bounds: the mounted turns' own subtrees, with the minimap and the spacers left out.
          mountedHistoryDom: turnRoots.reduce((sum, root) => sum + root.querySelectorAll("*").length + 1, 0),
        };
      },
    };
    window.__experiment = controller;
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__experiment; };
  }, [expanded, revealTurnIndex, turnModel.turns.length]);

  const lastTurn = turnModel.turns.at(-1);
  return (
    <div style={{ display: "flex", height: "100vh", minHeight: 0 }}>
      <div
        ref={(element) => { scrollRef.current = element; setScrollElement(element); }}
        data-fixture-scroll
        // The production scroll container turns the browser's own scroll anchoring off, because the window corrects
        // the position itself. The fixture mirrors it, or the two authorities would disagree here and not in the app.
        style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "16px", overflowAnchor: "none" }}
      >
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <Adapter
            turns={turnModel.turns}
            renderTurn={renderTurn}
            overscan={OVERSCAN}
            scrollElement={scrollElement}
            revealKey={revealKey}
            onMounted={onMounted}
          />
          {streaming && lastTurn && (
            <div data-fixture-stream>
              <MessageView
                message={{ role: "assistant", content: [{ type: "text", text: streamTail }], model: "fixture", provider: "fixture" } as AgentMessage}
                toolResults={toolResults}
                cwd="/repo"
                isStreaming
                sessionId="experiment"
              />
            </div>
          )}
        </div>
      </div>
      <div data-fixture-minimap>
        <ChatMinimap
          messages={messages}
          entryIds={entryIds}
          streamingMessage={null}
          scrollContainer={scrollRef}
          messageRefs={messageRefs}
          onRevealHistory={revealTurnByAnchor}
          outline={null}
          onJumpAnchor={() => undefined}
          onRequestOutline={() => undefined}
        />
      </div>
      <div data-fixture-state style={{ display: "none" }}>{JSON.stringify({ adapterName, mounted, revealKey })}</div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
