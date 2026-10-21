/**
 * Browser fixture for cross-session references ticket 02: create, reload, follow, and every unavailable state.
 *
 * The production `ReferencePanel` is mounted the way the shell mounts it — inside `StrictMode`, an `I18nProvider` and a
 * workbench connection — with only its network boundary replaced. Because the panel reaches the Backend through the
 * connection's own client, the creation it performs is the real write path (`ConversationControl.addReference` →
 * `POST /api/conversations/:id/references`); the fixture stands in for the Backend's answer, not for the client.
 *
 * The shell's own seam is what a follow goes through. `onOpenSession` is wired exactly as `AppShell` wires it: select
 * the named conversation, then hand the entry to `ChatWindow`'s search target, which is the history owner's bounded
 * target coordinator. So "one bounded request, no intervening-history walk" is measured here rather than asserted in
 * prose — an entry follow that paged toward its target would show up as a second read.
 */
import { StrictMode, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatWindow } from "@hepi/ui/components/ChatWindow";
import { ReferencePanel } from "@hepi/ui/components/ReferencePanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-references.fixture.css";

const CURRENT = "42";
const TARGET = "77";
/** An entry of the target's committed history that its transcript window does not carry: a deep reference. */
export const DEEP_ENTRY = "200";
/** The entry the picker offers, from the target's own paged outline. */
export const OUTLINE_ENTRY = "150";
const CURRENT_SNAPSHOT = CURRENT + "|9|120";
const TARGET_SNAPSHOT = TARGET + "|9|210";

/** One reference as the Backend's resolving read states it: the record, plus its outcome when it has one. */
type Reference = { conversationId: string; entryId?: string; label?: string; outcome?: string };

export interface ReferencesGate {
  /** The references the fixture's Backend holds for the current conversation. */
  readonly stored: readonly Reference[];
  /** How many bounded navigation target reads the entry follow issued. */
  readonly navigationReads: number;
  /** How many older-history pages were read while following (must stay 0). */
  readonly olderPages: number;
  /** How many `POST …/references` requests arrived. */
  readonly writes: number;
  /** The conversations the follow handed to the shell, in order. */
  readonly opened: readonly { sessionId: string; entryId?: string }[];
  /** Every request this page made, as path and query — what the follow actually asked for. */
  readonly requests: readonly string[];
  /** Re-mount the panel and the chat exactly as a page reload does: the list must come back from the Backend. */
  reload(): void;
  /** Make the fixture's Backend report one outcome for every stored reference, as a later follow would. */
  resolveAs(outcome: string | null): void;
  /** Refuse the next creation with the named outcome, storing nothing. */
  refuseNext(outcome: string): void;
}

declare global {
  interface Window { __references?: ReferencesGate }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const userEntry = (id: string, text: string) => ({ id, role: "user", text, message: { role: "user", content: [{ type: "text", text }] } });

const catalogue = () => ({
  conversations: [
    { id: CURRENT, workspaceId: "ws-1", title: "the conversation making the link", messageCount: 1, runStatus: { kind: "idle" } },
    { id: TARGET, workspaceId: "ws-1", title: "the target conversation", messageCount: 1, runStatus: { kind: "idle" } },
  ],
  sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1,
});

const stateOf = (id: string) => ({
  protocol: "hepi.v1", conversationId: id, projectionId: "P-" + id, revision: 1, run: null, submissions: [], busy: false,
  partial: "", liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  historyRevision: id === CURRENT ? CURRENT_SNAPSHOT : TARGET_SNAPSHOT, historyHead: "9", hasMore: false, oldestEntryId: "1",
  // The target's window carries one entry only, so a reference to DEEP_ENTRY is a deep follow rather than a local scroll.
  entries: [userEntry(id === CURRENT ? "1" : "210", id === CURRENT ? "a question in the linking conversation" : "a question in the target")],
  failure: null, control: { state: "allowed", revision: 0 },
});

const windowAround = (entryId: string) => ({
  protocol: "hepi.v1", conversationId: TARGET, snapshot: TARGET_SNAPSHOT, scope: TARGET + "|9", order: "oldest-first",
  target: { entryId, anchor: "", present: true, blocks: [0] }, capped: true, trimmed: false,
  entries: [userEntry("199", "context before the referenced entry"), userEntry(entryId, "the referenced entry"), userEntry("201", "its answer")],
  hasOlder: false, hasNewer: false, bytes: 512,
});

const outline = () => ({
  protocol: "hepi.v1", conversationId: TARGET, snapshot: TARGET_SNAPSHOT, scope: TARGET + "|9", order: "oldest-first",
  anchors: [
    { anchor: "coord-150", entryId: OUTLINE_ENTRY, cursor: Number(OUTLINE_ENTRY), preview: "the entry the picker offers" },
  ],
  hasMore: false, capped: true, bytes: 256,
});

let stored: Reference[] = [];
let resolvedAs: string | null = null;
let refuseWith: string | null = null;
let navigationReads = 0;
let olderPages = 0;
let writes = 0;
const opened: { sessionId: string; entryId?: string }[] = [];

/** The stored records as a resolving read states them: an outcome is beside the record, never inside it. */
const resolved = () => stored.map((reference) => resolvedAs === null ? { ...reference } : { ...reference, outcome: resolvedAs });

const realFetch = window.fetch.bind(window);
const requests: string[] = [];
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const resolvedUrl = new URL(url, window.location.origin);
  requests.push(resolvedUrl.pathname + resolvedUrl.search);
  const path = resolvedUrl.pathname;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();

  if (path.endsWith("/references") && method === "POST") {
    writes += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Reference;
    if (refuseWith !== null) {
      // The Backend refuses with the outcome's own code and stores nothing — what ticket 01 delivers, relayed unchanged.
      const refusal = refuseWith;
      refuseWith = null;
      return json({ protocol: "hepi.v1", code: refusal, error: "refused by the fixture for " + refusal }, 409);
    }
    const same = stored.some((candidate) => candidate.conversationId === body.conversationId && (candidate.entryId ?? "") === (body.entryId ?? ""));
    if (!same) stored = [...stored, body];
    return json({ protocol: "hepi.v1", conversationId: CURRENT, references: resolved() }, 201);
  }
  if (path.endsWith("/navigation/around")) {
    navigationReads += 1;
    return json(windowAround(DEEP_ENTRY));
  }
  if (path.endsWith("/navigation")) return json(outline());
  if (path.endsWith("/entries")) {
    olderPages += 1;
    return json({ protocol: "hepi.v1", conversationId: CURRENT, entries: [], hasMore: false, oldestEntryId: null });
  }
  if (path.endsWith("/state")) {
    const id = path.split("/")[3] ?? CURRENT;
    return json(stateOf(id));
  }
  if (path === "/api/conversations") {
    return resolvedUrl.searchParams.get("running") === "compact"
      ? json({ runningConversationIds: [], sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1 })
      : json(catalogue());
  }
  const byId = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (byId) {
    // The by-id read is the conversation's identity *and* its references, which is the one list read the panel makes.
    const id = decodeURIComponent(byId[1]!);
    const row = catalogue().conversations.find((candidate) => candidate.id === id);
    return json({ protocol: "hepi.v1", conversation: row ?? { id }, references: id === CURRENT ? resolved() : [] });
  }
  return json({});
};

const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const identity = { profile: "ux-references", backendId: "ux-references", accountScope: "ux-references" };

const rowOf = (id: string) => ({
  path: "/workspace/conv-" + id + ".jsonl", id, cwd: "/workspace", created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: id === CURRENT ? "a question in the linking conversation" : "a question in the target",
});

function Host() {
  const [sessionId, setSessionId] = useState(CURRENT);
  // The shell's own pending target, in the shape AppShell holds it: created by a navigation and retired by the surface.
  const [target, setTarget] = useState<{ sessionId: string; entryId: string } | null>(null);

  /** Exactly what `AppShell.handleOpenSession` does with the seam: select the conversation, hand the entry over. */
  const onOpenSession = useCallback((nextSessionId: string, entryId?: string) => {
    opened.push({ sessionId: nextSessionId, ...(entryId === undefined ? {} : { entryId }) });
    setSessionId(nextSessionId);
    setTarget(entryId === undefined ? null : { sessionId: nextSessionId, entryId });
  }, []);

  return (
    <div>
      <ReferencePanel sessionId={sessionId} onOpenSession={onOpenSession} />
      <ChatWindow
        key={sessionId}
        session={rowOf(sessionId)}
        searchTarget={target !== null && target.sessionId === sessionId ? target : null}
        onSearchTargetHandled={(done) => { setTarget((current) => (current === null || current.entryId !== done.entryId ? current : null)); }}
        newSessionCwd={null}
        newSessionDraftKey={null}
      />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
let root: Root | null = null;
const mount = () => {
  root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
        <I18nProvider>
          <Host />
        </I18nProvider>
      </WorkbenchConnectionProvider>
    </StrictMode>,
  );
};

window.__references = {
  get stored() { return stored; },
  get navigationReads() { return navigationReads; },
  get olderPages() { return olderPages; },
  get writes() { return writes; },
  get opened() { return opened; },
  get requests() { return requests; },
  // A reload is a fresh mount over the same Backend: the list a reader sees afterwards is the one the Backend holds.
  reload() { root?.unmount(); mount(); },
  resolveAs(outcome) { resolvedAs = outcome; },
  refuseNext(outcome) { refuseWith = outcome; },
};
void realFetch;
mount();
