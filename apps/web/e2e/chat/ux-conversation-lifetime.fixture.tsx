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
import { useWorkbenchConnection, workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { CompletionDelivery } from "@hepi/ui/lib/completion-delivery";
import type { Step } from "@hepi/ui/lib/lifecycle-projection";
import type { AgentEventLike } from "@hepi/ui/lib/agent-event-wire";
import type { ReloadOutcome } from "@hepi/ui/hooks/useAgentSession";

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
  /** Ask the chat for its explicit reload, the way Settings › General does, and read the outcome it established. */
  reload(): Promise<ReloadOutcome | null>;
  /** Show another conversation, or the fresh composer, without a new chat surface being built for it. */
  show(conversationId: string | null): void;
  /** Replace the connection the shell is inside, as picking another Backend does. */
  switchConnection(): void;
  /** The conversations whose stream this page still has open, as the stream owner states it. */
  readonly openStreams: readonly string[];
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

/**
 * One conversation's stream as this page drives it, per connection: the real owner is the connection's own client, only
 * the socket is stated. Two connections therefore hold two sources for the same conversation id, which is the whole
 * point of the switch case — the replaced connection's source is not the new one's.
 */
const sources = new Map<string, Map<string, { onmessage: ((event: MessageEvent<string>) => void) | null; readyState: number }>>();
const createSource = (owner: string) => (conversationId: string) => {
  const owned = sources.get(owner) ?? new Map();
  sources.set(owner, owned);
  const source = {
    readyState: 1,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() { source.readyState = 2; },
  };
  owned.set(conversationId, source);
  queueMicrotask(() => source.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: conversationId }) } as MessageEvent<string>));
  return source;
};

const client = createClient({ origin: "", credential: { kind: "cookie" }, fetch: window.fetch, createSource: createSource("first") });
const identity = { profile: "ux-lifetime", backendId: "ux-lifetime", accountScope: "ux-lifetime" };
const session = { path: "/workspace/conv-a.jsonl", id: CONVERSATION, cwd: "/workspace", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "an earlier question" };

let reloadRef: { current: (() => Promise<ReloadOutcome>) | null } = { current: null };
let setShown: (conversationId: string | null) => void = () => {};
let switchConnection: () => void = () => {};
/** The connection a switch moves to: another Backend and account, so another client, another scope and another stream. */
const switchedClient = createClient({ origin: "", credential: { kind: "cookie" }, fetch: window.fetch, createSource: createSource("switched") });
const switchedIdentity = { profile: "ux-lifetime", backendId: "ux-lifetime-switched", accountScope: "ux-lifetime-switched" };

const gate: LifetimeGate = {
  get requests() { return requests; },
  get tones() { return tones; },
  emit(conversationId: string, event: unknown) {
    // Both connections' sources hear it: the conversation id is the same on both, and a frame is a frame.
    const source = [...sources.values()].map((owned) => owned.get(conversationId)).find((candidate) => candidate !== undefined);
    if (source === undefined) throw new Error("no stream is open for " + conversationId);
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  },
  async reload() { return await reloadRef.current?.() ?? null; },
  show(conversationId: string | null) { setShown(conversationId); },
  switchConnection() { switchConnection(); },
  get openStreams() {
    // Each open source, named by the connection that owns it: a switch that released its watches leaves nothing of the
    // replaced connection open, and the new one holds its own source for the same conversation.
    return [...sources.entries()].flatMap(([owner, owned]) => [...owned.entries()]
      .filter(([, source]) => source.readyState === 1)
      .map(([conversationId]) => owner + ":" + conversationId));
  },
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
  // The connection this shell is inside. A switch replaces the provider value above it — exactly as the workbench does
  // when the user picks another Backend or profile — and the shell's tree is **not** remounted, so this is the switch
  // case for the shell's own owned values, the completion registry among them.
  const connection = useWorkbenchConnection();
  const reload = useRef<(() => Promise<ReloadOutcome>) | null>(null);
  reloadRef = reload;
  // The registry this shell is showing. It belongs to the connection it was built for, so a switch builds the next one
  // over the new client rather than handing the replaced client's watches a connection they do not describe. The shell
  // states it in state rather than in a ref, because a ref is the value that survives a switch by accident.
  const [delivery, setDelivery] = useState(() => new CompletionDelivery({
    subscribe: (conversationId, listener) => connection.client.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered: (notice) => { tones.push(notice); },
  }));
  // Which connection the registry was built for: the identity is the rule, so the swap happens once per switch.
  const deliveryConnection = useRef(connection);
  if (deliveryConnection.current !== connection) {
    deliveryConnection.current = connection;
    setDelivery((previous) => {
      // The outgoing registry's watches are released with it: nothing of the replaced connection stays attached.
      previous.close();
      return new CompletionDelivery({
        subscribe: (conversationId, listener) => connection.client.subscribe(conversationId, listener),
        lookup: async () => null,
        onAnswered: (notice) => { tones.push(notice); },
      });
    });
  }
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
/**
 * The provider the page states, keyed by the connection exactly as the workbench keys the tree above the shell: a switch
 * replaces the value and re-renders inside it, which is the case the shell's own connection-owned values must answer.
 */
function Page() {
  const [connection, setConnection] = useState(() => workbenchConnection(client, identity));
  switchConnection = () => setConnection(workbenchConnection(switchedClient, switchedIdentity));
  return (
    <WorkbenchConnectionProvider value={connection}>
      <I18nProvider>
        <Host />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
