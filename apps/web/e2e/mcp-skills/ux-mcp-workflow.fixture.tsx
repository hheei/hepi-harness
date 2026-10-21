/**
 * Browser fixture for the MCP workflow (ticket 07): the production Settings › MCP panel over a host-shaped seam.
 *
 * It mounts the real `SettingsPanel` with the real `McpConfig`, and replaces only the connection's transport, so what is
 * observed is the panel's own decisions: which requests it makes, in which order, what it shows while one is out, and
 * what it does with an answer that arrives after the section was hidden or the connection was replaced.
 *
 * The seam is the host's own vocabulary — `GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/test`,
 * `POST /api/mcp/sign-in` and the flow reads under it — and the fixture keeps a small host state of its own, so a
 * refused change is the host refusing rather than the fixture replaying an error.
 *
 * Two things exist only to make timing observable, and both are things a real host may do:
 * `?slow=<ms>` holds every answer that long (a slow host, which is when pending states matter), and
 * `flowReadsUntil<step>` advances the sign-in flow once per read, as a flow moves on by itself.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { SettingsPanel } from "@hepi/ui/components/SettingsPanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-mcp-workflow.fixture.css";

type Recorded = { method: string; url: string; body: unknown; at: number };

interface Server {
  name: string;
  scope: "global" | "project";
  enabled: boolean;
  usesOAuth?: boolean;
}

interface FlowState {
  flowId: string;
  phase: "connecting" | "authorize" | "done" | "cancelled" | "expired";
  reads: number;
  endsAfter: number;
}

interface Gate {
  requests: Recorded[];
  setConnection(token: string): void;
  /** The host's own flow state, so a driver can tell a finished flow from one still under way. */
  flow(): FlowState | null;
  polls(): number;
}

declare global {
  interface Window { __uxMcpWorkflow?: Gate }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const params = new URLSearchParams(window.location.search);
const slow = Number(params.get("slow") ?? 0);
const wait = async () => { if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow)); };

const PROJECT = "/workspace/local";
const requests: Recorded[] = [];

/** The host's own configuration, as its files state it: one plain server and one that signs in. */
const host = {
  servers: [
    { name: "docs", scope: "global", enabled: true } as Server,
    { name: "strict", scope: "global", enabled: true } as Server,
    { name: "oauth", scope: "global", enabled: true, usesOAuth: true } as Server,
  ],
  /** The entry a change is refused for: its file does not parse, which the route can only answer, not fix. */
  refused: "strict",
  flow: null as FlowState | null,
  signedIn: false,
  /** The listing's last status per server, as a sign-in's first connection records one. */
  statuses: {} as Record<string, unknown>,
};

const overview = () => ({
  mcp: { available: true },
  codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" },
  files: [
    { scope: "global", path: "/home/me/.pi/agent/mcp.json", exists: true, problems: [] },
    { scope: "project", path: PROJECT + "/.pi/mcp.json", exists: true, problems: [] },
  ],
  servers: host.servers.map((server) => ({
    name: server.name,
    scope: server.scope,
    sourcePath: "/home/me/.pi/agent/mcp.json",
    configKey: server.name + "-key",
    enabled: server.enabled,
    validated: true,
    envNames: [],
    headerNames: [],
    // A sign-in server is an HTTP one: the panel offers Sign in only where a connection would use OAuth.
    ...(server.usesOAuth === true
      ? { transport: "http", url: "https://oauth.example/mcp" }
      : { command: "npx", args: ["-y", server.name] }),
    usesOAuth: server.usesOAuth === true,
    ...(server.usesOAuth === true ? { signedIn: host.signedIn } : {}),
    commandFields: [],
    variableReferences: [],
    masked: false,
    ...(host.statuses[server.name] === undefined ? {} : { status: host.statuses[server.name] }),
  })),
  project: { cwd: PROJECT, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: PROJECT, inherited: false } },
});

const flowInfo = () => host.flow === null ? undefined : {
  flowId: host.flow.flowId,
  scope: "global",
  name: "oauth",
  configKey: "oauth-key",
  phase: host.flow.phase,
  expiresInMs: host.flow.phase === "done" ? 0 : 120_000,
  ...(host.flow.phase === "authorize" ? { authorizationUrl: "https://auth.example/authorize?state=abc", redirectUrl: "http://127.0.0.1:53692/callback" } : {}),
};

/** One route of the seam, answered the way the host answers it. */
async function answer(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split("?")[0];
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  await wait();
  if (path === "/api/tools/settings" && method === "GET") {
    return json({ isWindows: false, powerShellEnabled: false, codemode: "automatic", codemodeMode: "on", codemodeInlineBudget: "default" });
  }
  if (path === "/api/mcp" && method === "GET") return json(overview());
  if (path === "/api/mcp" && method === "POST") {
    const action = String(body?.action ?? "");
    const name = String(body?.name ?? "");
    if (name === host.refused) {
      // The host's own refusal: its file no longer parses, so nothing was written and the listing still says what it says.
      return json({ error: "the file is not valid JSON", reason: "unparsable", path: "/home/me/.pi/agent/mcp.json" }, 409);
    }
    const server = host.servers.find((entry) => entry.name === name);
    if (server === undefined && action !== "add" && action !== "undo") {
      return json({ error: "no such server", reason: "server-missing" }, 404);
    }
    if (action === "enable" || action === "disable") {
      if (server !== undefined) server.enabled = action === "enable";
      return json(overview());
    }
    if (action === "sign-out") {
      host.signedIn = false;
      return json({ ...overview(), signedOut: { removed: true } });
    }
    return json(overview());
  }
  if (path === "/api/mcp/test" && method === "POST") {
    const name = String(body?.name ?? "");
    const testedAt = Date.now();
    return json({
      configKey: name + "-key",
      name,
      scope: "global",
      result: { state: "connected", testedAt, toolCount: 2, durationMs: 40, tools: [] },
    });
  }
  if (path === "/api/mcp/sign-in" && method === "POST") {
    // The flow moves on by itself: one step per read, ending on the sixth, which is long enough for a person to
    // leave this tab and come back while it runs.
    host.flow = { flowId: "flow-1", phase: "connecting", reads: 0, endsAfter: 6 };
    return json(flowInfo());
  }
  if (path.startsWith("/api/mcp/sign-in/") && method === "GET") {
    if (host.flow === null) return json({ error: "unknown flow", reason: "sign-in-unknown" }, 404);
    host.flow.reads += 1;
    if (host.flow.reads >= host.flow.endsAfter && host.flow.phase !== "done") {
      host.flow.phase = "done";
      host.signedIn = true;
      const flowId = host.flow.flowId;
      // The flow stays readable under its own id once it ended, as the host keeps its outcome for a while.
      host.statuses.oauth = { state: "connected", testedAt: Date.now(), toolCount: 2, durationMs: 10, tools: [], origin: "test" };
      return json({ ...flowInfo(), flowId });
    }
    if (host.flow.phase === "connecting" && host.flow.reads > 0) host.flow.phase = "authorize";
    return json(flowInfo());
  }
  if (path.startsWith("/api/mcp/sign-in/") && method === "DELETE") {
    if (host.flow !== null) host.flow.phase = "cancelled";
    return json(flowInfo());
  }
  return json({ error: "the fixture answers no other route: " + method + " " + path }, 501);
}

/** The connection's own transport: it records the request and answers it, and never reaches the network. */
const transport: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requests.push({
    method: init?.method ?? "GET",
    url,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    at: Date.now(),
  });
  return await answer(url, init);
};

const noSource = () => ({ readyState: 2, onmessage: null, onerror: null, close() {} });

function connectionOf(token: string) {
  const client = createClient({
    origin: "",
    credential: { kind: "bearer", token },
    fetch: transport,
    createSource: noSource,
  });
  return workbenchConnection(client, connectionIdentityOf("profile-mcp", { backend: { id: "backend-mcp" }, account: { scope: token } }));
}

const gate: Gate = {
  requests,
  setConnection: () => undefined,
  flow: () => host.flow,
  polls: () => requests.filter((entry) => entry.method === "GET" && entry.url.includes("/api/mcp/sign-in/")).length,
};
window.__uxMcpWorkflow = gate;

const noop = () => undefined;

function Fixture() {
  const [connection, setConnection] = useState(() => connectionOf("first"));
  gate.setConnection = (token: string) => setConnection(connectionOf(token));
  return (
    <WorkbenchConnectionProvider value={connection}>
      <I18nProvider>
        <SettingsPanel
          cwd={PROJECT}
          displayCwd={PROJECT}
          sessionId={null}
          initialSection="mcp"
          onClose={noop}
          onSessionReloaded={async () => {}}
          quoteSelectionEnabled={false}
          onQuoteSelectionChange={noop}
          projectTrust={{ requiresTrust: true, trusted: true, decision: true, decisionPath: PROJECT, inherited: false }}
        />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(<Fixture />);
export {};
