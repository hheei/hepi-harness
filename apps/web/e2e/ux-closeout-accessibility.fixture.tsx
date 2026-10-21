/**
 * Ticket 22's missing UX checks, in a real Chromium: the keyboard, the focus an error hands back, a narrow viewport, and
 * a Chinese IME that must not send a half-composed sentence.
 *
 * The surface is the production one — the real `ChatWindow`, with its real composer, its real read-failure panel and its
 * real projection fold — mounted the way both hosts mount it (inside `StrictMode`, an `I18nProvider` and a workbench
 * connection) with only its network boundary replaced. Nothing here is a stub of a component: what the driver presses and
 * what the page then requests are the production component's own decisions.
 *
 * Three scenarios, selected by `?scenario=`, because each one changes what the conversation *is*:
 *
 *   - `idle` (default): a conversation with a turn in it and no run in flight. Enter sends, Shift+Enter does not, and the
 *     send path is reachable with the Tab key alone.
 *   - `running`: the projection states a run, so the composer is in its steering form and Escape stops it.
 *   - `failure`: the first conversation read is refused by a Gateway that could not answer, so the read-failure panel
 *     takes the transcript's place; the panel's Retry is reachable by keyboard and the second read is the one that lands.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatWindow } from "@hepi/ui/components/ChatWindow";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-closeout-accessibility.fixture.css";

type Scenario = "idle" | "running" | "failure";
const scenario = (new URLSearchParams(window.location.search).get("scenario") ?? "idle") as Scenario;

const CONVERSATION = "42";

export interface Gate {
  /** Every submission the composer admitted, in order, with the text it carried. */
  readonly sends: readonly string[];
  /** Stop requests the surface issued. */
  readonly stops: number;
  /** Conversation reads: one per `/state` request the hook made. */
  readonly reads: number;
  /** Whether the failure scenario's first read has been refused yet. */
  readonly refusedOnce: boolean;
  /** Let the failure scenario's next conversation read answer: the reader's own Retry is what calls this. */
  recover(): void;
  /** Every API request the page made, in order, for a driver that has to say which read answered. */
  readonly requests: readonly string[];
  /** What the shell's projection handover last stated: the readiness and the window size the surface is rendering. */
  projection: { ready: string; messages: number } | null;
}

declare global {
  interface Window { __uxCloseout?: Gate }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const userEntry = (id: string, text: string) => ({ id, role: "user", text, message: { role: "user", content: [{ type: "text", text }] } });
const answerEntry = (id: string, text: string) => ({ id, role: "assistant", text, message: { role: "assistant", content: [{ type: "text", text }] } });

const state = () => ({
  protocol: "hepi.v1", conversationId: CONVERSATION, projectionId: "P-1", revision: reads,
  // `activity` is read off `run`: a conversation with a run in flight is the one whose composer steers and whose Escape
  // stops it.
  run: scenario === "running" ? { inputs: [] } : null,
  submissions: [], busy: scenario === "running", partial: "", liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  historyRevision: CONVERSATION + "|2|" + CONVERSATION, historyHead: "2", hasMore: false, oldestEntryId: "1",
  entries: [userEntry("1", "an earlier question"), answerEntry("2", "an earlier answer")],
  failure: null, control: { state: "allowed", revision: 0 },
});

let sends: string[] = [];
let stops = 0;
let reads = 0;
// The failure scenario refuses every read until the reader asks again, so a StrictMode remount cannot make the panel
// disappear on its own: only the panel's own Retry changes what the Gateway answers.
let recovered = false;
const requests: string[] = [];
let projection: { ready: string; messages: number } | null = null;
const gate: Gate = {
  get sends() { return sends; },
  get stops() { return stops; },
  get reads() { return reads; },
  get refusedOnce() { return reads > 0; },
  recover: () => { recovered = true; },
  get requests() { return requests; },
  get projection() { return projection; },
};
window.__uxCloseout = gate;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, window.location.origin).pathname;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
  if (path.startsWith("/api/")) requests.push(method + " " + path + (scenario === "failure" ? " [recovered=" + recovered + "]" : ""));
  if (path === "/api/conversations/" + CONVERSATION + "/state" && method === "GET") {
    reads += 1;
    // A Gateway that could not answer: no status a caller can read as "this conversation is gone".
    if (scenario === "failure" && !recovered) return json({ ok: false, code: "gateway_offline", error: "the Gateway did not answer" }, 503);
    return json(state());
  }
  if (path === "/api/conversations/" + CONVERSATION + "/messages" && method === "POST") {
    sends = [...sends, String(body.text ?? "")];
    return json({ submissionId: "sub-" + sends.length, control: { state: "allowed", revision: 1 }, status: "allowed" });
  }
  if (path === "/api/conversations/" + CONVERSATION + "/stop" && method === "POST") {
    stops += 1;
    return json({ status: "accepted", drain: "idle", control: { state: "allowed", revision: 1 }, receipt: { requestId: body.requestId ?? "", status: "accepted" } });
  }
  if (path.endsWith("/entries")) return json({ protocol: "hepi.v1", conversationId: CONVERSATION, entries: [], hasMore: false, oldestEntryId: null });
  // The rail's own index read, in the contract's shape: this conversation's window states no anchors and no more pages,
  // which is a complete answer rather than an empty body the surface cannot iterate.
  if (path.endsWith("/navigation")) return json({ protocol: "hepi.v1", conversationId: CONVERSATION, snapshot: CONVERSATION + "|2|" + CONVERSATION, scope: CONVERSATION + "|2", anchors: [], hasMore: false, capped: true, bytes: 2 });
  return json({});
};

const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

const session = {
  path: "/workspace/conv-1.jsonl", id: CONVERSATION, cwd: "/workspace", created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z", messageCount: 2, firstMessage: "an earlier question",
};

function Host() {
  const [target, setTarget] = useState<{ sessionId: string; entryId: string } | null>(null);
  return (
    <ChatWindow
      session={session}
      searchTarget={target}
      onSearchTargetHandled={(done) => setTarget((current) => (current === null || current.entryId !== done.entryId ? current : null))}
      onProjectionChange={(_sid, step) => { projection = { ready: step.view.ready, messages: step.view.messages.length }; }}
      newSessionCwd={null}
      newSessionDraftKey={null}
    />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchConnectionProvider value={workbenchConnection(client, { profile: "ux-22", backendId: "ux-22", accountScope: "ux-22" })}>
      <I18nProvider>
        <Host />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  </StrictMode>,
);
