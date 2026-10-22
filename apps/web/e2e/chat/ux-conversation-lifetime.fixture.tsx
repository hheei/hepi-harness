/**
 * The conversation lifetime in a real browser: one chat surface that is re-read rather than rebuilt, one turn whose
 * outcome is recovered by lookup, and one answer that arrives while the conversation is not on screen.
 *
 * The three scenes are the browser half of the ticket's acceptance, and they mount the production `ChatWindow`, the
 * production `CompletionDelivery` registry and the production client. Only the transport is stated here: `fetch`
 * answers the Backend's own routes and the stream is a source this page drives, so what is asserted is what the real
 * components do with those answers.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatWindow } from "@hepi/ui/components/ChatWindow";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { CompletionDelivery } from "@hepi/ui/lib/completion-delivery";
import type { Step } from "@hepi/ui/lib/lifecycle-projection";
import type { AgentEventLike } from "@hepi/ui/lib/agent-event-wire";

const CONVERSATION = "conv-a";

const entry = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text, message: { role, content: [{ type: "text", text }] } });
const state = (overrides: Record<string, unknown> = {}) => ({
  protocol: "hepi.v1", conversationId: CONVERSATION, projectionId: "P-a", revision: 1, run: null, submissions: [], busy: false,
  partial: "", liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] }, queuedItems: [],
  control: { state: "allowed", revision: 0 }, historyRevision: "rev-1", historyHead: "h-1", hasMore: false, oldestEntryId: "1",
  entries: [entry("1", "user", "an earlier question")], failure: null, ...overrides,
});

export type LifetimeGate = {
  /** Requests this page answered, in order, as `METHOD path` — what the surface asked for. */
  readonly requests: string[];
  /** The completion notices this page's one registry reported as a sound. */
  readonly tones: { conversationId: string; answerKey: string }[];
  /** Deliver one event on a conversation's stream, as the Backend states it. */
  emit(conversationId: string, event: unknown): void;
  /** Ask the chat for its explicit reload, the way Settings › General does. */
  reload(): Promise<void>;
  /** Show another conversation, or the fresh composer, without a new chat surface being built for it. */
  show(conversationId: string | null): void;
};

declare global {
  interface Window { __lifetime?: LifetimeGate }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requests: string[] = [];
const tones: { conversationId: string; answerKey: string }[] = [];
/** Submissions whose admission answer never arrived: the browser generated the request id and must never resend it. */
const lost = new Set<string>();
const admissions: string[] = [];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, window.location.origin);
  const path = parsed.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push(method + " " + path + (parsed.search === "" ? "" : parsed.search));
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { requestId?: string } : undefined;

  if (path.endsWith("/state")) return json(state());
  if (path.endsWith("/navigation/around")) return json({ error: "no mountable entry", code: "missing" }, 404);
  if (path.endsWith("/navigation")) return json({ protocol: "hepi.v1", conversationId: CONVERSATION, snapshot: "conv-a|1", scope: "conv-a", order: "oldest-first", anchors: [], hasMore: false, capped: false, bytes: 2 });
  if (path.endsWith("/entries")) return json({ protocol: "hepi.v1", conversationId: CONVERSATION, entries: [], hasMore: false, oldestEntryId: null });
  if (path.endsWith("/commands")) return json({ commands: [] });
  if (path.endsWith("/settings")) return json({ model: null, thinkingLevel: "off" });
  if (path.endsWith("/reload")) return json({ resources: { skills: 1, prompts: 0 } });
  if (path.endsWith("/submissions")) {
    const requestId = parsed.searchParams.get("requestId") ?? "";
    return json({ protocol: "hepi.v1", conversationId: CONVERSATION, submission: {
      protocol: "hepi.v1", conversationId: CONVERSATION, submissionId: "s1", requestId, type: "input", status: "done", entryId: "e2", answerId: "a1",
    } });
  }
  if (path.endsWith("/messages") && method === "POST") {
    const requestId = body?.requestId ?? "";
    admissions.push(requestId);
    // The **first** admission's answer is lost after the Backend committed it: that outcome is unknown, never a
    // rejection, so the surface keeps the turn and resolves it by lookup. Every later admission is answered, which is
    // how a second turn is admitted and left waiting for its own answer.
    if (admissions.length === 1) {
      lost.add(requestId);
      throw new TypeError("Failed to fetch");
    }
    return json({ submissionId: "s2", control: { state: "allowed", revision: 0 } });
  }
  if (path.startsWith("/api/models")) return json({ models: {}, modelList: [] });
  return json({});
};

/** One conversation's stream as this page drives it: the real owner is the connection, only the socket is stated. */
const sources = new Map<string, { onmessage: ((event: MessageEvent<string>) => void) | null; readyState: number }>();
const createSource = (conversationId: string) => {
  const source = {
    readyState: 1,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() { source.readyState = 2; },
  };
  sources.set(conversationId, source);
  queueMicrotask(() => source.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: conversationId }) } as MessageEvent<string>));
  return source;
};

const client = createClient({ origin: "", credential: { kind: "cookie" }, fetch: window.fetch, createSource });
const identity = { profile: "ux-lifetime", backendId: "ux-lifetime", accountScope: "ux-lifetime" };
const session = { path: "/workspace/conv-a.jsonl", id: CONVERSATION, cwd: "/workspace", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "an earlier question" };

let reloadRef: { current: (() => Promise<void>) | null } = { current: null };
let setShown: (conversationId: string | null) => void = () => {};

const gate: LifetimeGate = {
  get requests() { return requests; },
  get tones() { return tones; },
  emit(conversationId: string, event: unknown) {
    const source = sources.get(conversationId);
    if (source === undefined) throw new Error("no stream is open for " + conversationId);
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  },
  async reload() { await reloadRef.current?.(); },
  show(conversationId: string | null) { setShown(conversationId); },
};
window.__lifetime = gate;

/**
 * The host, as the shell states it: the page's one completion registry, the conversation it shows, and the chat's own
 * handover seams. A conversation left with work in flight keeps its stream because the registry holds the projection the
 * surface handed over, and the answer it folds while that conversation is off screen is the one that sounds — once.
 */
function Host() {
  const [shown, setShownState] = useState<string | null>(CONVERSATION);
  setShown = setShownState;
  const reload = useRef<(() => Promise<void>) | null>(null);
  reloadRef = reload;
  const delivery = useMemo(() => new CompletionDelivery({
    subscribe: (conversationId, listener) => client.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered: (notice) => { tones.push(notice); },
  }), []);
  useEffect(() => () => delivery.close(), [delivery]);
  // The conversation on screen owns its frames; every other watch folds its own. Stated during render, as the shell does,
  // so a switch has joined the stream before the surface it replaces leaves it.
  delivery.select(shown);
  const subscribeAgentEvents = useCallback((conversationId: string, listener: (event: AgentEventLike) => void) => delivery.subscribe(conversationId, listener), [delivery]);
  const onProjectionChange = useCallback((conversationId: string, step: Step) => delivery.handover(conversationId, step), [delivery]);
  const onLiveSettlement = useCallback((notice: { conversationId: string; answerKey: string }) => {
    if (!delivery.settle(notice)) return false;
    tones.push(notice);
    return true;
  }, [delivery]);

  return (
    <div>
      <button type="button" data-fixture-show="conversation" onClick={() => setShownState(CONVERSATION)}>conversation</button>
      <button type="button" data-fixture-show="composer" onClick={() => setShownState(null)}>composer</button>
      <ChatWindow
        key={shown ?? "composer"}
        session={shown === null ? null : session}
        newSessionCwd={shown === null ? "/workspace" : null}
        newSessionDraftKey={shown === null ? "new:fixture:/workspace" : null}
        subscribeAgentEvents={subscribeAgentEvents}
        onProjectionChange={onProjectionChange}
        onLiveSettlement={onLiveSettlement}
        onConversationReloadChange={(fn) => { reload.current = fn; }}
      />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
      <I18nProvider>
        <Host />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  </StrictMode>,
);
