/**
 * Browser fixture for the transcript presentation owners: the notice shelf and the follow-tail viewport.
 *
 * Two presentation behaviours are mounted here, each the production module the workbench mounts:
 *
 * - `NoticeShelf` draws the **facts** a conversation stated. Its clocks (the draw time, the pause while the reader is on
 *   one, the leave animation) are its own, so nothing here fakes a timer: the driver hovers a real toast and reads how
 *   long it stays.
 * - `useTranscriptPresentation` holds the viewport. The driver scrolls the real scrolling element, states whether a run
 *   is busy, and asks the hook what it would offer ("jump to the latest"), which is the surface's own signal.
 *
 * Nothing here reimplements either rule: the fixture states what a conversation would state — notices, new messages —
 * and reads what the presentation decided.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NoticeShelf } from "@hepi/ui/components/NoticeShelf";
import { useTranscriptPresentation } from "@hepi/ui/hooks/useTranscriptPresentation";
import type { NoticeFact } from "@hepi/ui/lib/notice-shelf";

export interface PresentationGate {
  /** State one notice fact, as the conversation's fold or a dropped upload would. */
  stateNotice(message: string): void;
  /** How many facts the conversation still holds. */
  held(): string[];
  /** The transcript grew, as a live turn arriving does. */
  arrive(): void;
  /** Whether a native run is in flight. */
  setBusy(busy: boolean): void;
  /** The viewport's own report: the scroll position, and whether the surface would offer "jump to the latest". */
  viewport(): { scrollTop: number; scrollHeight: number; clientHeight: number; jumping: boolean; promptAnchor: number };
}

declare global {
  interface Window { __presentation?: PresentationGate }
}

const TURN_HEIGHT = 220;

/** One turn of the transcript: tall enough that the list overflows the viewport it is drawn in. */
function Turn({ index, last }: { index: number; last: boolean }) {
  return (
    <div data-turn={index} style={{ height: TURN_HEIGHT, borderTop: "1px solid #ddd" }}>
      turn {index}
      {last ? <span data-last-prompt /> : null}
    </div>
  );
}

function Fixture() {
  const [facts, setFacts] = useState<readonly NoticeFact[]>([]);
  const [turns, setTurns] = useState(6);
  const [busy, setBusy] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attach = (element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  };

  const presentation = useTranscriptPresentation({
    conversationId: "fixture",
    busy,
    ownSends: 0,
    messageCount: turns,
    loading: false,
    scrollElement,
    streamingMessage: null,
    deferInitialScroll: false,
  });

  useEffect(() => {
    window.__presentation = {
      stateNotice(message: string) {
        setFacts((held) => [...held, { id: "notice-" + held.length, message, type: "warning" }]);
      },
      held: () => facts.map((fact) => fact.id),
      arrive: () => setTurns((count) => count + 1),
      setBusy,
      viewport: () => {
        const element = scrollRef.current;
        if (element === null) throw new Error("the transcript is not mounted");
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          jumping: presentation.showScrollToBottom,
          promptAnchor: presentation.promptAnchorActive ? 1 : 0,
        };
      },
    };
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__presentation; };
  }, [facts, presentation]);

  return (
    <>
      <div style={{ position: "relative", height: 200 }}>
        <NoticeShelf
          facts={facts}
          floating
          onRetire={(id) => setFacts((held) => held.filter((fact) => fact.id !== id))}
        />
      </div>
      <div
        ref={attach}
        data-scroll
        style={{ height: 300, overflowY: "auto" }}
      >
        {Array.from({ length: turns }, (_, index) => (
          <Turn key={index} index={index} last={index === turns - 1} />
        ))}
        <div ref={presentation.anchors.spacer} aria-hidden="true" />
      </div>
      <pre id="state">{JSON.stringify({ turns, busy, jumping: presentation.showScrollToBottom })}</pre>
    </>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(<Fixture />);
