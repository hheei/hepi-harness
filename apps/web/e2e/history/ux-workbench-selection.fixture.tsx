/**
 * The workbench selection, in a real browser: what a tab comes back to after a reload.
 *
 * The production shell is mounted whole over one real createClient, whose answers are recorded. What is asserted is what
 * no Node test can hold — the browser's own sessionStorage and localStorage across a real page reload, and what the reader
 * is left looking at afterwards: the conversation or the fresh composer this tab was showing, with its unsent text still in
 * the box. That is the browser half of N1/N2/N7, which the selection's unit tests cannot state.
 *
 * A conversation read is answered here rather than run against a Backend, because the question is which target the page
 * adopts and what its own memories hold — not what a Backend returns.
 */
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { WorkbenchNavigationProvider } from "@hepi/ui/lib/navigation";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { AppShell } from "@hepi/ui/components/AppShell";

export type FixtureRequest = { method: string; path: string };

declare global {
  interface Window { __uxSelectionFixture?: { requests: FixtureRequest[]; failures: string[] } }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requests: FixtureRequest[] = [];
const failures: string[] = [];
/** Conversations this page removed: the catalogue stops listing them, as a Backend's own tombstone does. */
const removed = new Set<string>();
window.__uxSelectionFixture = { requests, failures };

/** Two conversations, one per folder: the reader moves between them and back to a composer. */
const row = (id: string) => ({
  id, workspaceId: "local", gatewayId: "workstation", busy: false, revision: 1, messageCount: 1, firstMessage: "the " + id,
  workspace: { gatewayId: "workstation", root: folderOf(id), project: { id: "p-" + id, name: id.toUpperCase(), defaultWorkspaceId: "local", displayRoot: folderOf(id) } },
});
const sessionRow = (id: string) => ({
  path: "/sessions/" + id, id, cwd: folderOf(id),
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "the " + id,
});
/** This deployment has one project per folder, and the folder is its own root. */
function folderOf(id: string): string { return id === "two" ? "/srv/two" : "/srv/one"; }

const CATALOGUE = { conversations: [row("one"), row("two")], sidebarStateRevision: 1, projectsRevision: 1, sessionListVersion: 1 };

/** One committed conversation as the Backend states it: empty of turns, complete in its lifecycle scalars. */
const snapshotOf = (id: string) => ({
  protocol: "hepi.v1", revision: 1, conversationId: id, projectionId: "P-" + id,
  historyRevision: "rev-1", historyHead: "h-1", hasMore: false, oldestEntryId: null,
  run: null, busy: false, entries: [], partial: "", toolNames: [], extensions: [], liveTools: [],
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  queuedItems: [], control: { state: "allowed", revision: 0 }, failure: null, submissions: [],
});

const PAGE_READ = { output: [], details: { tail: "1", offset: 0, limit: 200, outputLines: 0, truncated: false, hasMore: false, entries: [] }, diagnostics: [] };

/** An empty outline: this conversation has no committed user turn to jump to. */
const OUTLINE = (id: string) => ({
  protocol: "hepi.v1", conversationId: id, snapshot: "s1", scope: "sc1", order: "oldest-first",
  anchors: [], hasMore: false, capped: false, bytes: 0,
});

function answer(path: string, params: URLSearchParams, body: string | null, method?: string): Response {
  if (path === "/api/conversations") {
    if (params.get("running") === "compact") return json({ runningConversationIds: [], sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1 });
    return json({ ...CATALOGUE, conversations: CATALOGUE.conversations.filter((item) => !removed.has(item.id)) });
  }
  if (path.startsWith("/api/conversations/")) {
    // /api/conversations/<id>[/<operation>] — the id is the segment after the collection, not the second split part.
    const parts = path.split("/");
    const id = decodeURIComponent(parts[3] ?? "");
    const operation = parts[4] ?? "";
    if (operation === "state") return json(snapshotOf(id));
    if (operation === "navigation") return json(OUTLINE(id));
    if (operation === "read" || operation === "entries" || operation === "subtree-control") return json(PAGE_READ);
    if (operation === "settings") return json({ model: null, thinkingLevel: "off" });
    if (operation === "commands") return json({ commands: [] });
    if (operation === "submissions") return json({ submission: null });
    if (operation === "") {
      // The conversation's own DELETE is its removal, answered as the removal it is: the row leaves the list this page
      // reads next, so nothing has to pretend the tombstone away.
      if ((method ?? "GET") === "DELETE") { removed.add(id); return json({ removed: true }); }
      return json({ ...sessionRow(id), conversation: { id, cwd: folderOf(id) }, state: snapshotOf(id) });
    }
    // Any other named read of one conversation: its identity and its row in one body.
    return json({ ...sessionRow(id), conversation: { id, cwd: folderOf(id) }, state: snapshotOf(id) });
  }
  if (path === "/api/sidebar-state") return json({ state: { version: 1, revision: 1, sessions: {}, projects: {} } });
  if (path === "/api/projects") return json({ protocol: "hepi.v1", projects: [] });
  if (path === "/api/workspaces") return json({ workspaces: [{ id: "local", gatewayId: "workstation", host: { user: "op", home: "/home/op" }, workspaceRoot: "/srv" }] });
  if (path === "/api/hosts") return json({ protocol: "hepi.v1", hosts: [{ id: "workstation", profiles: [] }] });
  if (path === "/api/host/directories") return json({ path: "/srv", parentPath: null, directories: [], host: { user: "op", home: "/home/op" } });
  if (path === "/api/cwd/validate") {
    const cwd = (body === null ? null : (JSON.parse(body) as { cwd?: string }).cwd) ?? params.get("cwd") ?? "/srv/one";
    return json({ cwd, projectKey: cwd, projectRoot: cwd, displayRoot: cwd });
  }
  if (path.startsWith("/api/models")) return json({ models: [], enabled: [] });
  if (path.startsWith("/api/agent")) return json({ commands: [], definitions: [], agents: [] });
  // The files tab's own reads: this scene never opens it, but the sidebar's refresh after a removal touches the folder it
  // was showing, and a route left unanswered would be reported as a question this page could not answer.
  if (path.startsWith("/api/worktrees")) return json({ worktrees: [], state: "ready" });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: "/srv", parentPath: null });
  if (path.startsWith("/api/git/status")) return json({ branch: null, entries: [], ahead: 0, behind: 0 });
  if (path.startsWith("/api/settings") || path.startsWith("/api/home") || path.startsWith("/api/default-cwd")) return json({});
  failures.push("unanswered " + path);
  return json({ error: "unanswered " + path, code: "not_found" }, 404);
}

const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, window.location.origin);
  requests.push({ method: init?.method ?? "GET", path: parsed.pathname + parsed.search });
  return answer(parsed.pathname, parsed.searchParams, typeof init?.body === "string" ? init.body : null, init?.method);
};

const connection = workbenchConnection(createClient({
  origin: "",
  credential: { kind: "cookie" },
  fetch: connectionFetch,
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
}), connectionIdentityOf("ux-selection", { backend: { id: "b" }, account: { scope: "acct" } }));

// The page's own address is the shell's initial navigation, so a reload asks the same question a deep link does, and the
// shell's write-back is a location this page can really be reloaded at.
const navigation = {
  location: { get search() { return window.location.search; } },
  navigate: (search: string) => { window.history.replaceState({}, "", search === "" ? "/" : search); },
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchNavigationProvider value={navigation}>
    <WorkbenchConnectionProvider value={connection}>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  </WorkbenchNavigationProvider>,
);
