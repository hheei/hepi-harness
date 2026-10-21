/**
 * Ticket 06 browser seam: the sidebar, the New Project dialog and the folder picker ask the connection's own origin
 * with the connection's own credential.
 *
 * The surfaces are the production ones — the real `SessionSidebar`, the real `NewProjectDialog` and the real
 * `DirectoryPicker` — mounted behind one real `createClient` whose origin is a configured ingress and whose credential
 * is one device bearer. The client's `fetch` is the connection's own transport (the host's, in a packaged App) and
 * records every URL, method, header and body it is handed, so what the surfaces asked for and which credential they
 * presented is the assertion rather than what a stub was told.
 *
 * The document's own origin serves no client API here, exactly as a packaged App's bundle does. A surface that reached
 * for a relative `fetch` would therefore be visible as a request that never arrived on the configured ingress — which
 * is the failure this ticket exists for.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { WorkbenchConnectionProvider, workbenchConnection } from "@hepi/ui/lib/workbench-scope";
import { createWorkbenchSelection, WorkbenchSelectionProvider } from "@hepi/ui/lib/workbench-selection";
import { DirectoryPicker } from "@hepi/ui/components/DirectoryPicker";
import { NewProjectDialog } from "@hepi/ui/components/NewProjectDialog";
import { SessionSidebar } from "@hepi/ui/components/SessionSidebar";
import { useSessionUiState } from "@hepi/ui/hooks/useSessionUiState";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import "./ux-sidebar-ingress.fixture.css";

/** A configured ingress origin: not the origin this document was loaded from. */
export const INGRESS_ORIGIN = "https://ingress.example:9443";
/** The one device credential this connection presents. */
export const BEARER = "sidebar-ingress-device-bearer";

export type ConnectionRequest = {
  method: string;
  url: string;
  authorization: string | null;
  credentials: string | null;
  body: string | null;
};
export type View = "sidebar" | "directory" | "new-project";

export interface Gate {
  connection: ConnectionRequest[];
  origin: string;
  bearer: string;
  state: () => unknown;
  setView(view: View): void;
}

declare global {
  interface Window { __uxSidebarIngress?: Gate }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const gate: Gate = { connection: [], origin: INGRESS_ORIGIN, bearer: BEARER, state: () => null, setView: () => undefined };
window.__uxSidebarIngress = gate;

const account = { user: "operator", home: "/home/operator" };
const configuredWorkspace = { id: "local", gatewayId: "workstation", host: account, workspaceRoot: "/srv/local" };
const projectFolder = { id: "ws-1", gatewayId: "workstation", host: account, workspaceRoot: "/srv/project" };
const project = {
  id: "project-1",
  name: "Downloads",
  hostId: "workstation",
  defaultFolderId: "folder-1",
  folders: [{ id: "folder-1", workspaceId: "ws-1", root: "/srv/project", cwd: "/workspace/ws-1", default: true }],
};
/** One conversation bound to the Project's default folder: the row the sidebar projects into its group. */
const catalogue = {
  conversations: [{
    id: "conversation-1",
    workspaceId: "ws-1",
    gatewayId: "workstation",
    workspace: { gatewayId: "workstation", root: "/srv/project", project: { id: "project-1", name: "Downloads", defaultWorkspaceId: "ws-1", displayRoot: "/srv/project" } },
    busy: false,
    revision: 1,
    messageCount: 2,
    firstMessage: "hello",
    title: "Project turn",
  }],
  sidebarStateRevision: 3,
  projectsRevision: 1,
  sessionListVersion: 5,
};
const emptyState = { version: 1, revision: 3, sessions: {}, projects: {} };

/** The deployment's answers, as the real routes answer them. An unlisted route is a request the fixture did not expect. */
function answer(url: string, init?: RequestInit): Response {
  const path = url.slice(INGRESS_ORIGIN.length).split("?")[0];
  const method = init?.method ?? "GET";
  if (path === "/api/conversations" && method === "GET") {
    return url.includes("running=compact")
      ? json({ runningConversationIds: [], sessionListVersion: 5, sidebarStateRevision: 3, projectsRevision: 1 })
      : json(catalogue);
  }
  if (path === "/api/projects" && method === "GET") return json({ protocol: "hepi.v1", projects: [project] });
  if (path === "/api/workspaces" && method === "GET") return json({ workspaces: [configuredWorkspace, projectFolder] });
  if (path === "/api/sidebar-state" && method === "GET") return json({ state: emptyState });
  if (path === "/api/sidebar-state" && method === "POST") {
    const request = JSON.parse(String(init?.body ?? "{}"));
    return json({ state: { ...emptyState, revision: 4, sessions: Object.fromEntries((request.ids ?? []).map((id: string) => [id, { pinnedAt: 1 }])) } });
  }
  if (path === "/api/hosts" && method === "GET") return json({ protocol: "hepi.v1", hosts: [{ id: "workstation", profiles: [] }] });
  if (path === "/api/host/directories" && method === "GET") return json({ path: "/home/operator", parentPath: null, directories: [{ name: "projects", path: "/home/operator/projects" }], host: account });
  return json({ error: "the fixture does not answer " + method + " " + path }, 404);
}

/** The connection's own transport: it records the request and answers it, and never reaches the network. */
const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  gate.connection.push({
    method: init?.method ?? "GET",
    url,
    authorization: headers.get("authorization"),
    credentials: init?.credentials ?? null,
    body: typeof init?.body === "string" ? init.body : null,
  });
  return answer(url, init);
};

const identity = connectionIdentityOf("profile-sidebar", { backend: { id: "backend-1" }, account: { scope: "acct" } });
// One client, one connection: the sidebar, the folder picker, the dialogs, the shared sidebar document and the file
// surface all read and write through the same admission, which is what the driver's request log asserts.
const connection = workbenchConnection(createClient({
  origin: INGRESS_ORIGIN,
  credential: { kind: "bearer", token: BEARER },
  fetch: connectionFetch,
  // No stream is joined here; the factory is stated because the client requires one.
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
}), identity);

const noop = () => undefined;

/** The one selection the sidebar reads: this fixture opens no conversation and remembers nothing. */
const selection = createWorkbenchSelection({
  drafts: connection.drafts,
  conversation: { open: async () => { throw new Error("the fixture opens no conversation"); }, list: async () => ({ sessions: [] }) },
  validateCwd: async (path) => ({ cwd: path }),
  navigate: () => undefined,
  query: () => new URLSearchParams(),
});

/** The sidebar's own shared document, read through the production hook so the pin write is the hook's own request. */
function SidebarStateProbe() {
  const uiState = useSessionUiState();
  gate.state = () => uiState.state;
  return (
    <button
      type="button"
      className="fixture-pin"
      onClick={() => { void uiState.apply({ action: "set", ids: ["conversation-1"], pinned: true }); }}
    >
      pin
    </button>
  );
}

function Fixture() {
  const [view, setView] = useState<View>("sidebar");
  gate.setView = setView;
  return (
    <>
      <button type="button" className="fixture-view-sidebar" onClick={() => setView("sidebar")}>sidebar</button>
      <button type="button" className="fixture-view-directory" onClick={() => setView("directory")}>directory</button>
      <button type="button" className="fixture-view-new-project" onClick={() => setView("new-project")}>new project</button>
      {view === "sidebar" && (
        <div style={{ height: 600, display: "flex" }}>
          <SessionSidebar />
          <SidebarStateProbe />
        </div>
      )}
      {view === "directory" && <DirectoryPicker onCancel={noop} onSelect={noop} initialPath="/home/operator" />}
      {view === "new-project" && <NewProjectDialog onCancel={noop} onCreated={noop} />}
    </>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={connection}>
    <WorkbenchSelectionProvider value={selection}>
      <I18nProvider>
        <Fixture />
      </I18nProvider>
    </WorkbenchSelectionProvider>
  </WorkbenchConnectionProvider>,
);
