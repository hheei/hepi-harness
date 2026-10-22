/**
 * "Ask in new chat" from a selection, in the production shell, in a real browser.
 *
 * The ordinary journey this states: the reader selects a passage of an answer, asks a question about it in a new chat,
 * the fork opens and the question is sent there — once. Then the reader goes to another conversation and comes back,
 * and nothing is sent again.
 *
 * That last step is the whole point of the scene. The shell hands a fresh chat its quoted prompt as a one-shot
 * `initialPrompt`, and the chat tells the shell when it has consumed it. A callback that answers without being called
 * leaves the prompt standing, so a remount of the same conversation — a visit to another conversation and back — sends
 * the reader's question a second time.
 *
 * Only the transport is stated: `fetch` answers the Backend's own routes, and what is asserted is what the production
 * tree does with those answers — the fork route it asked, the message it admitted, and the count of admissions.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { WorkbenchNavigationProvider } from "@hepi/ui/lib/navigation";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { AppShell } from "@hepi/ui/components/AppShell";

const SOURCE = "source";
const FORK = "forked";
const OTHER = "other";

export type QuoteRequest = { method: string; path: string; body: string | null };

declare global {
  interface Window {
    __quoteFixture?: {
      requests: QuoteRequest[];
      /** Every message admission, as the text the composer sent. */
      readonly admissions: string[];
      readonly forks: string[];
    };
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requests: QuoteRequest[] = [];
const admissions: string[] = [];
const forks: string[] = [];

const entry = (id: string, role: "user" | "assistant", text: string) =>
  ({ id, role, text, message: { role, content: [{ type: "text", text }] } });

/** The conversation the reader starts in: one answer with a passage worth selecting. */
const SNAPSHOT = (id: string) => ({
  protocol: "hepi.v1", revision: 1, conversationId: id, projectionId: "P-" + id,
  historyRevision: "rev-1", historyHead: "h-1", hasMore: false, oldestEntryId: null,
  run: null, busy: false,
  entries: id === SOURCE ? [entry("e1", "user", "an earlier question"), entry("e2", "assistant", "A passage worth asking about.")] : [],
  partial: "", toolNames: [], extensions: [], liveTools: [],
  settings: { model: null, thinkingLevel: "off" },
  queuedMessages: { steering: [], followUp: [] }, queuedItems: [],
  control: { state: "allowed", revision: 0 }, failure: null, submissions: [],
});

const row = (id: string) => ({
  id, workspaceId: "local", gatewayId: "workstation", busy: false, revision: 1, messageCount: 2, firstMessage: "the " + id,
  workspace: { gatewayId: "workstation", root: "/srv/one", project: { id: "p-one", name: "ONE", defaultWorkspaceId: "local", displayRoot: "/srv/one" } },
});
const sessionRow = (id: string) => ({
  path: "/sessions/" + id, id, cwd: "/srv/one",
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 2, firstMessage: "the " + id,
});
const EMPTY_PAGE = { output: [], details: { tail: "1", offset: 0, limit: 200, outputLines: 0, truncated: false, hasMore: false, entries: [] }, diagnostics: [] };
const OUTLINE = (id: string) => ({
  protocol: "hepi.v1", conversationId: id, snapshot: "s1", scope: "sc1", order: "oldest-first",
  anchors: [], hasMore: false, capped: false, bytes: 0,
});

/** The conversations the sidebar lists. A fork joins them the way the Backend's own catalogue would list it. */
let catalogue = [row(SOURCE), row(OTHER)];

function answer(path: string, params: URLSearchParams, body: string | null, method: string): Response {
  if (path === "/api/conversations") {
    if (params.get("running") === "compact") return json({ runningConversationIds: [], sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1 });
    return json({ conversations: catalogue, sidebarStateRevision: 1, projectsRevision: 1, sessionListVersion: 1 });
  }
  if (path.startsWith("/api/conversations/")) {
    const parts = path.split("/");
    const id = decodeURIComponent(parts[3] ?? "");
    const operation = parts[4] ?? "";
    if (operation === "state") return json(SNAPSHOT(id));
    if (operation === "navigation" && parts[5] === "around") return json({ error: "no mountable entry", code: "missing" }, 404);
    if (operation === "navigation") return json(OUTLINE(id));
    if (operation === "entries" || operation === "subtree-control") return json(EMPTY_PAGE);
    if (operation === "settings") return json({ model: null, thinkingLevel: "off" });
    if (operation === "commands") return json({ commands: [] });
    if (operation === "submissions") return json({ submission: null });
    // The fork "Ask in new chat" performs: the Backend answers with the conversation it made, and the shell adopts it.
    if (operation === "fork" && method === "POST") {
      forks.push(id);
      catalogue = [...catalogue, row(FORK)];
      return json({ conversationId: FORK, conversation: { id: FORK } });
    }
    if (operation === "messages" && method === "POST") {
      const parsed = body === null ? null : JSON.parse(body) as { text?: string; requestId?: string };
      admissions.push(parsed?.text ?? "");
      return json({ submissionId: "s-" + admissions.length, control: { state: "allowed", revision: 0 } });
    }
    if (operation === "") return json({ ...sessionRow(id), conversation: { id, cwd: "/srv/one" }, state: SNAPSHOT(id) });
    return json({ ...sessionRow(id), conversation: { id, cwd: "/srv/one" }, state: SNAPSHOT(id) });
  }
  if (path === "/api/search") return json({ truncated: false, results: [] });
  if (path === "/api/sidebar-state") return json({ state: { version: 1, revision: 1, sessions: {}, projects: {} } });
  if (path === "/api/projects") return json({ protocol: "hepi.v1", projects: [] });
  if (path === "/api/workspaces") return json({ workspaces: [{ id: "local", gatewayId: "workstation", host: { user: "op", home: "/home/op" }, workspaceRoot: "/srv" }] });
  if (path === "/api/hosts") return json({ protocol: "hepi.v1", hosts: [{ id: "workstation", profiles: [] }] });
  if (path === "/api/host/directories") return json({ path: "/srv", parentPath: null, directories: [], host: { user: "op", home: "/home/op" } });
  if (path === "/api/cwd/validate") {
    const cwd = (body === null ? null : (JSON.parse(body) as { cwd?: string }).cwd) ?? params.get("cwd") ?? "/srv/one";
    return json({ cwd, projectKey: cwd, projectRoot: cwd, displayRoot: cwd });
  }
  if (path === "/api/project-trust") return json({ requiresTrust: false, trusted: false, decision: null, inherited: false });
  if (path.startsWith("/api/tools/settings")) return json({ isWindows: false, powerShellEnabled: false, codemode: "never", codemodeMode: "off", codemodeInlineBudget: "default" });
  if (path.startsWith("/api/models")) return json({ models: [], enabled: [], modelList: [] });
  if (path.startsWith("/api/agent")) return json({ commands: [], definitions: [], agents: [] });
  if (path.startsWith("/api/worktrees")) return json({ worktrees: [], state: "ready" });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: "/srv", parentPath: null });
  if (path.startsWith("/api/git/status")) return json({ branch: null, entries: [], ahead: 0, behind: 0 });
  if (path.startsWith("/api/settings") || path.startsWith("/api/home") || path.startsWith("/api/default-cwd")) return json({});
  return json({});
}

const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, window.location.origin);
  const body = typeof init?.body === "string" ? init.body : null;
  requests.push({ method: (init?.method ?? "GET").toUpperCase(), path: parsed.pathname + parsed.search, body });
  return answer(parsed.pathname, parsed.searchParams, body, (init?.method ?? "GET").toUpperCase());
};

/**
 * The stream the send waits on.
 *
 * A source answers with the Backend's own opening frame once it is attached: a send acquires the stream before it
 * dispatches, so a source that never says it is connected leaves the composer waiting for a conversation it already
 * has. Nothing else is delivered here — this scene is about how many admissions the surface makes, not about frames.
 */
type QuoteSource = { readyState: number; onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; close(): void };
const createSource = (conversationId: string): QuoteSource => {
  const source: QuoteSource = {
    readyState: 1,
    onmessage: null,
    onerror: null,
    close() { source.readyState = 2; },
  };
  queueMicrotask(() => source.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: conversationId }) } as MessageEvent<string>));
  return source;
};

const connection = workbenchConnection(createClient({
  origin: "",
  credential: { kind: "cookie" },
  fetch: connectionFetch,
  createSource,
}), connectionIdentityOf("ux-quote", { backend: { id: "b" }, account: { scope: "acct" } }));

const navigation = {
  location: { get search() { return window.location.search; } },
  navigate: (search: string) => { window.history.replaceState({}, "", search === "" ? "/" : search); },
};

function Fixture() {
  // The quote affordance is a setting the shell reads from storage on mount, as a person who turned it on has it.
  const [ready] = useState(() => {
    try { window.localStorage.setItem("pi-quote-selection-enabled", "true"); } catch { /* storage is best-effort */ }
    return true;
  });
  return (
    <WorkbenchNavigationProvider value={navigation}>
      <WorkbenchConnectionProvider value={connection}>
        <I18nProvider key={connection.scope}>
          {ready ? <AppShell /> : null}
        </I18nProvider>
      </WorkbenchConnectionProvider>
    </WorkbenchNavigationProvider>
  );
}

window.__quoteFixture = {
  requests,
  get admissions() { return admissions; },
  get forks() { return forks; },
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(<Fixture />);
