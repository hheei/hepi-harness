/**
 * Browser fixture for UX ticket 02 (right-side navigation highlights every
 * visible turn).
 *
 * It mounts the production ChatMinimap next to a scroll container built from the
 * same element contract ChatWindow uses: one ref per message-group anchor
 * (question header) and per committed assistant message, in message order, plus
 * a ref-less streaming tail inside the last turn (exactly like ChatWindow, whose
 * streaming bubble is rendered outside the ref'd list).
 *
 * The layout is deliberately deterministic so a turn's answer is far larger
 * than its question header: three turns of 40px header + 260px answer, then a
 * final turn (40px header + 60px answer + a 200px streaming tail inside the
 * same turn). A header-only turn rectangle therefore cannot pass the driver's
 * checks, and the turn boundaries are exact multiples the driver asserts on.
 *
 * The driver reads rendered DOM only; this file exposes no component internals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMinimap, useMessageRefs } from "@hepi/ui/components/ChatMinimap";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import type { AgentMessage } from "@hepi/ui/lib/types";
import "./ux-visible-turns.fixture.css";

export const TURN_COUNT = 4;
export const HEADER_HEIGHT = 40;
export const ANSWER_HEIGHT = 260;
export const LAST_ANSWER_HEIGHT = 60;
export const INITIAL_STREAM_HEIGHT = 200;

interface FixtureController {
  setStreamHeight(height: number): void;
  setAnswerHeight(index: number, height: number): void;
  scrollTo(top: number): void;
  scrollToBottom(): void;
}

declare global {
  interface Window { __ux02?: FixtureController }
}

function answerHeight(index: number): number {
  return index === TURN_COUNT - 1 ? LAST_ANSWER_HEIGHT : ANSWER_HEIGHT;
}

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [streamHeight, setStreamHeight] = useState(INITIAL_STREAM_HEIGHT);
  const [answerHeights, setAnswerHeights] = useState<number[]>(
    () => Array.from({ length: TURN_COUNT }, (_, index) => answerHeight(index)),
  );
  const messageRefs = useMessageRefs(TURN_COUNT * 2);
  const turns = useMemo(
    () => Array.from({ length: TURN_COUNT }, (_, index) => ({
      index,
      question: "Question " + (index + 1) + " asks for a long answer.",
      answer: "Answer " + (index + 1) + ". " + "Committed answer paragraph. ".repeat(30),
    })),
    [],
  );
  const messages = useMemo<AgentMessage[]>(
    () => turns.flatMap((turn) => ([
      { role: "user", content: turn.question } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: turn.answer }],
        model: "fixture-model",
        provider: "fixture",
      } as AgentMessage,
    ])),
    [turns],
  );
  const streamingMessage = useMemo(() => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Streaming reply that is still growing." }],
    model: "fixture-model",
    provider: "fixture",
  }), []);

  useEffect(() => {
    const controller: FixtureController = {
      setStreamHeight(height) { setStreamHeight(height); },
      setAnswerHeight(index, height) {
        setAnswerHeights((current) => current.map((value, position) => (
          position === index ? height : value
        )));
      },
      scrollTo(top) {
        const element = scrollRef.current;
        if (element) element.scrollTop = top;
      },
      scrollToBottom() {
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      },
    };
    window.__ux02 = controller;
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__ux02; };
  }, []);

  const attach = useCallback((index: number) => (element: HTMLDivElement | null) => {
    messageRefs.current[index] = element;
  }, [messageRefs]);

  return (
    <div className="stage">
      <div className="scroll" ref={scrollRef} data-fixture-scroll>
        <div className="content">
          {turns.map((turn) => (
            <div className="turn" data-fixture-turn={turn.index} key={turn.index}>
              <div className="user" data-fixture-user={turn.index} style={{ height: HEADER_HEIGHT }} ref={attach(turn.index * 2)}>
                {turn.question}
              </div>
              <div className="answer" data-fixture-answer={turn.index} style={{ height: answerHeights[turn.index] }} ref={attach(turn.index * 2 + 1)}>
                {turn.answer}
              </div>
              {turn.index === TURN_COUNT - 1 && (
                <div className="stream" data-fixture-stream style={{ height: streamHeight }}>
                  Streaming reply that is still growing.
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <ChatMinimap
        messages={messages}
        entryIds={messages.map((_, index) => "entry-" + index)}
        streamingMessage={streamingMessage}
        scrollContainer={scrollRef}
        messageRefs={messageRefs}
        onRevealHistory={() => undefined}
        outline={null}
        onJumpAnchor={() => undefined}
        onRequestOutline={() => undefined}
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
