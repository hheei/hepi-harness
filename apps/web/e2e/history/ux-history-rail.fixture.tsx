/**
 * Browser fixture for history-navigation ticket 04 (the full-history rail).
 *
 * It mounts the production `ChatMinimap` beside a scroll container built from the same element contract `ChatWindow`
 * uses, and hands it the two sources the rail joins:
 *
 * - a **paged outline** of twelve committed user anchors, which is the conversation's own statement of which nodes exist
 *   and in what order — including the ten the transcript below does not carry;
 * - a **measured transcript** of only the last three of those turns, which is the loaded window.
 *
 * The fixture stands in for the surface that owns the coordinator: `onJumpAnchor` records the one coordinate the rail
 * handed over, then mounts that anchor's turn (what `landWindow` plus the reveal do in production) and scrolls to it.
 * Nothing here calls the rail twice, and the driver asserts the request count, so a rail that paged toward a node fails.
 *
 * The driver reads rendered DOM only; this file exposes no component internals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMinimap, useMessageRefs } from "@hepi/ui/components/ChatMinimap";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import type { AgentMessage } from "@hepi/ui/lib/types";
import type { NavigationFailure, NavigationOutline } from "@hepi/ui/lib/history-navigation";
import "./ux-history-rail.fixture.css";

export const ANCHOR_COUNT = 12;
/** How many anchors the outline's first page states. The rest are behind the rail's own "more". */
export const FIRST_PAGE = 6;
/** The first anchor the transcript carries. Everything before it is unloaded: the window is at the tail. */
export const FIRST_LOADED = 9;
export const HEADER_HEIGHT = 40;
export const ANSWER_HEIGHT = 260;

interface FixtureController {
  scrollTo(top: number): void;
  /** The coordinates the rail handed to the surface, in order. One per click. */
  jumps(): { anchor: string; entryId: string }[];
  /** How many times the rail asked for another outline page. */
  outlineRequests(): number;
  /** Answer the outstanding "more" request with the page it asked for, or fail it. */
  answerOutline(failure?: NavigationFailure): void;
}

declare global {
  interface Window { __rail?: FixtureController }
}

const conversationId = "77";
const scope = conversationId + "|head";
const anchorEntryId = (index: number) => String(1000 + index);

function outlinePage(entryIds: string[], options: { hasMore?: boolean; failure?: NavigationFailure } = {}): NavigationOutline {
  return {
    conversationId,
    snapshot: conversationId + "|head|" + (entryIds.at(-1) ?? "-"),
    scope,
    anchors: entryIds.map((entryId) => ({
      anchor: "coord-" + entryId,
      entryId,
      cursor: Number(entryId),
      preview: "Question " + (Number(entryId) - 1000 + 1) + " from the committed history.",
    })),
    hasMore: options.hasMore === true,
    ...(options.hasMore === true ? { nextCursor: Number(entryIds.at(-1)) } : {}),
    capped: true,
    loading: false,
    failure: options.failure ?? null,
  };
}

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The loaded window: the tail of the conversation, which is what the transcript carries when it opens.
  const [loaded, setLoaded] = useState<number[]>(
    () => Array.from({ length: ANCHOR_COUNT - FIRST_LOADED }, (_, offset) => FIRST_LOADED + offset),
  );
  const [jumps, setJumps] = useState<{ anchor: string; entryId: string }[]>([]);
  const [outlineRequests, setOutlineRequests] = useState(0);
  // The outline the rail reads: the first page only, so the rest of the history is behind the "more" control.
  const [outline, setOutline] = useState<NavigationOutline>(() => outlinePage(
    Array.from({ length: FIRST_PAGE }, (_, index) => anchorEntryId(index)),
    { hasMore: true },
  ));
  const messageRefs = useMessageRefs(loaded.length * 2);

  const messages = useMemo<AgentMessage[]>(
    () => loaded.flatMap((index) => ([
      { role: "user", content: "Question " + (index + 1) + " from the committed history." } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer " + (index + 1) + ". " + "Committed answer paragraph. ".repeat(12) }],
        model: "fixture-model",
        provider: "fixture",
      } as AgentMessage,
    ])),
    [loaded],
  );

  const scrollToEntry = useCallback((entryId: string) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const element = scroll.querySelector<HTMLElement>('[data-fixture-entry="' + entryId + '"]');
    if (!element) return;
    const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTo({ top: Math.max(0, top - scroll.clientHeight * 0.3), behavior: "auto" });
  }, []);

  /**
   * What the surface does with the coordinate the rail hands over.
   *
   * One call is recorded and the anchor's turn is mounted — the same two things `landWindow` and the reveal do — and
   * then the alignment runs. The rail itself issues nothing further, which is what the driver's request count reads.
   */
  const onJumpAnchor = useCallback((anchor: string, entryId: string) => {
    setJumps((current) => [...current, { anchor, entryId }]);
    const index = Number(entryId) - 1000;
    setLoaded((current) => (current.includes(index) ? current : [...current, index].sort((a, b) => a - b)));
    // The target's DOM arrives on the next commit, which is why the alignment is deferred by a frame rather than run
    // here: a scroll issued before the turn exists would land on whatever is under it.
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToEntry(entryId)));
  }, [scrollToEntry]);

  const onRequestOutline = useCallback(() => {
    setOutlineRequests((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller: FixtureController = {
      scrollTo(top) {
        const element = scrollRef.current;
        if (element) element.scrollTop = top;
      },
      jumps: () => jumps,
      outlineRequests: () => outlineRequests,
      answerOutline(failure) {
        // The page that continues the outline, or the named failure that stood in its way. The continuation states the
        // anchors after the ones already listed and ends the outline, which is exactly what a second Backend page is.
        setOutline((current) => {
          if (failure !== undefined) return { ...current, failure, loading: false };
          const listed = new Set(current.anchors.map((anchor) => anchor.entryId));
          const rest = Array.from({ length: ANCHOR_COUNT }, (_, index) => anchorEntryId(index))
            .filter((entryId) => !listed.has(entryId))
            .map((entryId) => ({
              anchor: "coord-" + entryId,
              entryId,
              cursor: Number(entryId),
              preview: "Question " + (Number(entryId) - 1000 + 1) + " from the committed history.",
            }));
          return {
            ...current,
            failure: null,
            loading: false,
            anchors: [...current.anchors, ...rest],
            hasMore: false,
            nextCursor: undefined,
          };
        });
      },
    };
    window.__rail = controller;
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__rail; };
  }, [jumps, outlineRequests]);

  const attach = useCallback((index: number) => (element: HTMLDivElement | null) => {
    messageRefs.current[index] = element;
  }, [messageRefs]);

  return (
    <div className="stage">
      <div className="scroll" ref={scrollRef} data-fixture-scroll>
        <div className="content">
          {loaded.map((index, position) => (
            <div className="turn" data-fixture-turn={index} key={index}>
              <div
                className="user"
                data-fixture-entry={anchorEntryId(index)}
                style={{ height: HEADER_HEIGHT }}
                ref={attach(position * 2)}
              >
                Question {index + 1} from the committed history.
              </div>
              <div className="answer" style={{ height: ANSWER_HEIGHT }} ref={attach(position * 2 + 1)}>
                Answer {index + 1}. Committed answer paragraph.
              </div>
            </div>
          ))}
        </div>
      </div>
      <ChatMinimap
        messages={messages}
        // One entry id per *message*, exactly as ChatWindow passes them: a user message is the anchor, its assistant
        // reply is not, and the rail's measurement walks the two lists in step.
        entryIds={loaded.flatMap((index) => [anchorEntryId(index), undefined])}
        streamingMessage={null}
        scrollContainer={scrollRef}
        messageRefs={messageRefs}
        onRevealHistory={() => undefined}
        outline={outline}
        onJumpAnchor={onJumpAnchor}
        onRequestOutline={onRequestOutline}
      />
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
