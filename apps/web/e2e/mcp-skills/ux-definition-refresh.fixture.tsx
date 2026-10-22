/**
 * Browser fixture for ticket 08: a Settings write that the open conversation has to pick up asks that conversation to
 * re-read its resources — and reports what the conversation established, not what the panel hoped.
 *
 * It mounts the production `AgentsConfig` and the production `SettingsPanel` General section under one connection, with
 * only the network boundary replaced. The connection's own `refreshes` registry is where a real chat publishes its
 * reload, so this fixture publishes one the driver scripts: what the panel asked for, for which conversation, and what
 * it then displayed, are all assertions about the panel's real decisions rather than about a stub.
 *
 * `?outcome=reloaded|failed` scripts the conversation's answer; `?session=none` mounts the panels with no conversation
 * open, which is the state where nothing can be re-read.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { AgentsConfig } from "@hepi/ui/components/AgentsConfig";
import { SettingsPanel } from "@hepi/ui/components/SettingsPanel";
import { ExtensionsConfig } from "@hepi/ui/components/ExtensionsConfig";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-definition-refresh.fixture.css";

type Recorded = { method: string; url: string; body: unknown };

declare global {
  interface Window {
    __ux08?: {
      requests: Recorded[];
      /** Every conversation refresh the panels asked for, in order. */
      refreshes: string[];
      /** The views the driver switches between, so one page covers the panels a settings write reaches. */
      setView(view: "agents" | "general" | "extensions"): void;
      /** Switch the conversation the panels are open for, as the workbench does when the reader picks another one. */
      setSession(id: string | null): void;
      /** Every conversation-extension write the fixture is still holding, in the order the panel sent them. */
      held: { conversationId: string; release(): void }[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const outcome = params.get("outcome") === "failed" ? "failed" : params.get("outcome") === "superseded" ? "superseded" : "reloaded";
const sessionId = params.get("session") === "none" ? null : "session-1";
const WORKSPACE = { id: "alpha", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/work/alpha" };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One definition as the host holds it. */
const definition = {
  name: "reviewer",
  description: "Reads a change",
  tools: ["read", "write"],
  context: "fresh",
  enabled: true,
  instructions: "# Reviewer",
  scope: "user",
  hostId: "workstation",
  workspaceId: "alpha",
  path: "/home/operator/.pi/agents/reviewer.md",
  effective: true,
  issues: [],
  raw: "---\nname: reviewer\n---\n# Reviewer\n",
};

const requests: Recorded[] = [];
const refreshes: string[] = [];
const held: { conversationId: string; release(): void }[] = [];
window.__ux08 = { requests, refreshes, held, setView: () => undefined, setSession: () => undefined };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (url.startsWith("/api/")) requests.push({ method, url, body });
  if (url.startsWith("/api/workspaces")) return json({ workspaces: [WORKSPACE] });
  if (url.startsWith("/api/projects")) return json({ projects: [] });
  if (url.startsWith("/api/agent-definitions/document")) return json({ definition });
  if (url.startsWith("/api/agent-definitions") && method === "GET") return json({ hostId: "workstation", workspaceId: "alpha", definitions: [definition], shadowed: [] });
  if (url.startsWith("/api/agent-definitions") && method === "PUT") return json({ definition });
  if (url === "/api/tools/settings" && method === "GET") return json({ isWindows: true, powerShellEnabled: false });
  if (url === "/api/tools/settings" && method === "PUT") return json({ isWindows: true, powerShellEnabled: true });
  if (url === "/api/extensions" && method === "GET") return json({ protocol: "hepi.v1", installed: [{ name: "coding-tools", tools: [], sections: [], enabled: true }], default: ["coding-tools"], failures: [] });
  if (url.startsWith("/api/conversations/") && url.endsWith("/state") && method === "GET") {
    // Each conversation holds its own selection, so an answer written under another one is visible as the wrong state.
    const id = decodeURIComponent(url.slice("/api/conversations/".length, -"/state".length));
    return json({ sessionId: id, extensions: id === "session-1" ? ["coding-tools"] : [] });
  }
  if (url.startsWith("/api/conversations/") && url.endsWith("/extensions") && method === "PATCH") {
    const id = decodeURIComponent(url.slice("/api/conversations/".length, -"/extensions".length));
    // Held until the driver releases it, so the answer's arrival relative to a conversation switch is exact.
    const pending = Promise.withResolvers<void>();
    held.push({ conversationId: id, release: () => pending.resolve() });
    await pending.promise;
    return json({ protocol: "hepi.v1", conversationId: id, extensions: (body as { extensions: string[] }).extensions, toolNames: [] });
  }
  if (url.startsWith("/api/web-auth")) return json({ enabled: false });
  return realFetch(input, init);
};

const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const connection = workbenchConnection(client, { profile: "ux-08", backendId: "ux-08", accountScope: "ux-08" });
// The conversation's own reload, as the chat that owns it publishes it: one operation per conversation, reporting what
// its read established.
const chatOutcome = outcome === "failed"
  ? { status: "failed", message: "Reload failed: the Backend refused the read" } as const
  : outcome === "superseded"
    ? { status: "superseded" } as const
    : { status: "reloaded", message: "Reloaded 2 skills and 1 prompts" } as const;
if (sessionId !== null) {
  connection.refreshes.hold(sessionId, async () => {
    refreshes.push(sessionId);
    return chatOutcome;
  });
}

function Fixture() {
  const [view, setView] = useState<"agents" | "general" | "extensions">("agents");
  const [open, setOpen] = useState<string | null>(sessionId);
  window.__ux08!.setView = setView;
  window.__ux08!.setSession = (id) => {
    // The chat of the conversation being opened publishes its own refresh, exactly as the real one does.
    if (id !== null) connection.refreshes.hold(id, async () => { refreshes.push(id); return chatOutcome; });
    setOpen(id);
  };
  if (view === "extensions") {
    return <ExtensionsConfig embedded sessionId={open} onClose={() => undefined} />;
  }
  return view === "agents" ? (
    <AgentsConfig cwd="/workspace/alpha" displayCwd="/home/operator/alpha" sessionId={open} onClose={() => undefined} />
  ) : (
    <SettingsPanel cwd="/workspace/alpha" displayCwd="/home/operator/alpha" sessionId={open} initialSection="general" onClose={() => undefined} quoteSelectionEnabled={false} onQuoteSelectionChange={() => undefined} />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={connection}>
    <I18nProvider>
      <Fixture />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
