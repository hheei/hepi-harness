/**
 * Browser seam for review 160's two UI P2 findings, on the production components: the raw-history block read race, and
 * the closed sidebar that kept its buttons reachable from a keyboard.
 *
 * Only the network boundary is replaced. The panel's reads are its own, and the shell — its toggle, its inert subtree,
 * its focus handling — is mounted whole over a connection that answers the routes it reads on mount.
 *
 * The block reads are held until the driver releases them, because the fence is only observable as an ordering: two
 * reads in flight, the second answering first, then the first answering. A session change and a connection replacement
 * under the same session id are both offered, because the panel must retire either.
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { WorkbenchNavigationProvider } from "@hepi/ui/lib/navigation";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { RawHistoryPanel } from "@hepi/ui/components/RawHistoryPanel";
import { AppShell } from "@hepi/ui/components/AppShell";
import "./ux-raw-history-sidebar-focus.fixture.css";

export type View = "raw" | "shell";

/** One held block read: the connection it went out on, and the handles that answer it. */
type PendingBlock = { connection: number; entryId: string; blockIndex: number; release(text: string): void; fail(message: string): void };

export interface Gate {
  readonly blocks: PendingBlock[];
  readonly requests: string[];
  setView(view: View): void;
  /** Show a different conversation: what the shell does when the reader opens another session. */
  setSession(sessionId: string): void;
  /** Replace the connection under the same session id and the same mount: what a profile switch does. */
  replaceConnection(): void;
}

declare global {
  interface Window { __rawSidebarGate?: Gate }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const blocks: PendingBlock[] = [];
const requests: string[] = [];

/** Two text blocks on one entry: the smallest inventory that can be opened out of order. */
const inventory = {
  tail: "1", offset: 0, limit: 200, outputLines: 0, truncated: false, hasMore: false,
  entries: [{ entryId: "1", kind: "message", role: "user", blocks: [{ blockIndex: 0, type: "text" }, { blockIndex: 1, type: "text" }] }],
};

const catalogue = {
  conversations: [{
    id: "7", workspaceId: "local", gatewayId: "workstation",
    workspace: { gatewayId: "workstation", root: "/srv/local", project: { id: "p1", name: "Local", defaultWorkspaceId: "local", displayRoot: "/srv/local" } },
    busy: false, revision: 1, messageCount: 1, firstMessage: "hello", title: "A conversation",
  }],
  sidebarStateRevision: 1, projectsRevision: 1, sessionListVersion: 1,
};

function answerShellRoute(path: string): Response {
  if (path === "/api/conversations") return json(catalogue);
  if (path === "/api/sidebar-state") return json({ state: { version: 1, revision: 1, sessions: {}, projects: {} } });
  if (path === "/api/projects") return json({ protocol: "hepi.v1", projects: [] });
  if (path === "/api/workspaces") return json({ workspaces: [] });
  if (path === "/api/hosts") return json({ protocol: "hepi.v1", hosts: [{ id: "workstation", profiles: [] }] });
  return json({});
}

/** The connection under test, by index: the second is a replacement whose answers must not be confused with the first's. */
const makeFetch = (issuedOn: number): typeof fetch => async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, window.location.origin).pathname;
  requests.push((init?.method ?? "GET") + " " + path);
  const params = new URL(url, window.location.origin).searchParams;
  if (path.endsWith("/read")) {
    if (params.has("blockIndex")) {
      const entryId = params.get("entryId") ?? "";
      const blockIndex = Number(params.get("blockIndex"));
      return await new Promise<Response>((resolve) => {
        blocks.push({
          connection: issuedOn,
          entryId,
          blockIndex,
          release: (text) => resolve(json({ output: [{ type: "text", text }], details: { ...inventory, entries: [] }, diagnostics: [] })),
          fail: (message) => resolve(json({ error: message }, 500)),
        });
      });
    }
    // The page read differs by connection so "the replaced client answered" is observable, not assumed.
    return json({ output: [{ type: "text", text: "PAGE FROM CONNECTION " + issuedOn }], details: inventory, diagnostics: [] });
  }
  // The poll asks the compact read; the list still asks the rows.
  if (path === "/api/conversations" && params.get("running") === "compact") {
    return json({ runningConversationIds: [], sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1 });
  }
  return answerShellRoute(path);
};

const buildConnection = (index: number) => workbenchConnection(createClient({
  origin: "",
  credential: { kind: "cookie" },
  fetch: makeFetch(index),
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
}), connectionIdentityOf("ux-raw-sidebar", { backend: { id: "b" + index }, account: { scope: "acct" } }));

const gate: Gate = { blocks, requests, setView: () => undefined, setSession: () => undefined, replaceConnection: () => undefined };
window.__rawSidebarGate = gate;

// The search string is the page's own: the shell reads its initial navigation from it, and the closed-sidebar scene
// opens this page at `?sidebar=collapsed`.
const navigation = { location: { search: window.location.search }, navigate: () => undefined };

function Fixture() {
  const [view, setView] = useState<View>("raw");
  const [sessionId, setSessionId] = useState("1");
  // A connection replacement changes this value only: the same session id, the same mounted panel, no remount key.
  const [connectionIndex, setConnectionIndex] = useState(0);
  gate.setView = setView;
  gate.setSession = setSessionId;
  gate.replaceConnection = () => setConnectionIndex((index) => index + 1);
  // One connection per index, built once: a new object every render would be a new connection every render, which is
  // neither what a switch does nor an ordering this scene could read anything about.
  const connection = useMemo(() => buildConnection(connectionIndex), [connectionIndex]);
  return (
    <WorkbenchConnectionProvider value={connection}>
      <button type="button" id="view-raw" onClick={() => setView("raw")}>raw</button>
      <button type="button" id="view-shell" onClick={() => setView("shell")}>shell</button>
      {view === "raw" && (
        <div style={{ height: 600, overflow: "auto" }}>
          <RawHistoryPanel sessionId={sessionId} />
        </div>
      )}
      {view === "shell" && (
        <div style={{ height: "100vh" }}>
          <AppShell />
        </div>
      )}
    </WorkbenchConnectionProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchNavigationProvider value={navigation}>
      <I18nProvider>
        <Fixture />
      </I18nProvider>
    </WorkbenchNavigationProvider>
  </StrictMode>,
);
