/**
 * Browser fixture for ticket 03's review: a deep search hit that fails, then lands on retry.
 *
 * The real `ChatWindow` is mounted the way both hosts mount it — inside `StrictMode`, an `I18nProvider` and a workbench
 * connection — with only its network boundary replaced. The first navigation read refuses the target as `missing`; the
 * reader then presses Retry, and the second read answers the entry's own bounded window.
 *
 * What this exists to hold is request ownership across that retry: a failure is a state the reader may act on, so the
 * shell's pending target has to survive it. A surface that retires the target when the failure is shown leaves the
 * retry's landing with no request to align, and the entry it just mounted is never scrolled to — the bug this fixture
 * reproduces in a browser rather than in a unit.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatWindow } from "@hepi/ui/components/ChatWindow";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-navigation-retry.fixture.css";

// The contract's own id vocabulary: a conversation is addressed by its decimal id, and a coordinate naming anything
// else is `malformed` before any history is consulted.
const CONVERSATION = "42";
const TARGET = "100";
const SNAPSHOT = CONVERSATION + "|9|120";

// The wire's own message shape: a user message states its content as blocks, which is what the projection reads.
const userEntry = (id: string, text: string) => ({ id, role: "user", text, message: { role: "user", content: [{ type: "text", text }] } });
const answerEntry = (id: string, text: string) => ({ id, role: "assistant", text, message: { role: "assistant", content: [{ type: "text", text }] } });

export interface Gate {
  /** How many times the surface retired the shell's target, which a failure must not do. */
  readonly handled: number;
  /** Navigation reads the surface has issued, in order. */
  readonly reads: number;
  /** Older-history page reads, which a settlement must not trigger. */
  readonly olderPages: number;
  retry(): void;
}

declare global {
  interface Window { __gate?: Gate }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const state = () => ({
  protocol: "hepi.v1", conversationId: CONVERSATION, projectionId: "P-1", revision: 1, run: null, submissions: [], busy: false,
  partial: "", liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  historyRevision: SNAPSHOT, historyHead: "9", hasMore: false, oldestEntryId: "1",
  // The transcript the reader opens: the target is *not* here, which is what makes the hit a deep one.
  entries: [userEntry("1", "an earlier question")],
  failure: null, control: { state: "allowed", revision: 0 },
});

const windowOf = (entryId: string) => ({
  protocol: "hepi.v1", conversationId: CONVERSATION, snapshot: SNAPSHOT, scope: CONVERSATION + "|9", order: "oldest-first",
  target: { entryId, anchor: "", present: true, blocks: [0] }, capped: true, trimmed: false,
  entries: [userEntry("98", "context before"), userEntry(entryId, "the matched turn"), answerEntry("101", "its answer")],
  hasOlder: false, hasNewer: false, bytes: 512,
});

let reads = 0;
let olderPages = 0;
let handled = 0;
const gate: Gate = {
  get handled() { return handled; },
  get reads() { return reads; },
  get olderPages() { return olderPages; },
  retry: () => { document.querySelector<HTMLButtonElement>("[data-navigation-retry]")?.click(); },
};
window.__gate = gate;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, window.location.origin).pathname;
  if (path.endsWith("/navigation/around")) {
    reads += 1;
    // The first attempt is refused the way a target the window cannot carry is; the retry answers it.
    if (reads === 1) return json({ protocol: "hepi.v1", conversationId: CONVERSATION, code: "missing", error: "no entry" }, 404);
    return json(windowOf(TARGET));
  }
  if (path.endsWith("/navigation")) {
    return json({ protocol: "hepi.v1", conversationId: CONVERSATION, snapshot: SNAPSHOT, scope: CONVERSATION + "|9", anchors: [], hasMore: false, capped: true, bytes: 2 });
  }
  if (path.endsWith("/entries")) {
    olderPages += 1;
    return json({ protocol: "hepi.v1", conversationId: CONVERSATION, entries: [], hasMore: false, oldestEntryId: null });
  }
  if (path.endsWith("/state")) return json(state());
  return json({});
};

const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const identity = { profile: "ux-nav-retry", backendId: "ux-nav-retry", accountScope: "ux-nav-retry" };

const session = {
  path: "/workspace/conv-1.jsonl", id: CONVERSATION, cwd: "/workspace", created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "an earlier question",
};

function Host() {
  // The shell's own request, in the shape AppShell holds it: the entry it wants, retired only when the surface says the
  // reader is done with it.
  const [target, setTarget] = useState<{ sessionId: string; entryId: string } | null>({ sessionId: CONVERSATION, entryId: TARGET });
  return (
    <ChatWindow
      session={session}
      searchTarget={target}
      onSearchTargetHandled={(done) => {
        handled += 1;
        setTarget((current) => (current === null || current.entryId !== done.entryId ? current : null));
      }}
      newSessionCwd={null}
      newSessionDraftKey={null}
    />
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
