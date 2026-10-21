/**
 * Browser fixture for ticket 03c: the conversation-scoped MCP tools inside Settings > Extensions.
 *
 * It mounts the production `ExtensionsConfig` with only its network boundary replaced, so the assertions are about the
 * panel's real mount decision, its real reads and the request bodies it writes. The fixture answers as the backend's
 * seam (03b) does - one conversation's extension selection with its MCP grants inside it, and a listing only when a
 * server is named in `?mcp=` - and records every request, so "discovery is explicit" is checked as an absence rather
 * than inferred from pixels.
 *
 * Two conversations live here and `__ux03c.switchTo(id)` moves the panel between them, because an ordinary switch is
 * the case the panel must get right: an answer about one conversation must never be painted over another's.
 * `__ux03c.setDelay(ms)` holds a listing or a write open so a switch can be made while that answer is still in flight.
 *
 * `?scope=no-workspace` mounts the same conversations with no execution host, which is the state whose limit must be
 * stated before any server's. `?host=offline` keeps the workspace but stops the host answering its configuration read,
 * with 03b's own named refusal, which is the state where a conversation's own grants must stay visible and revocable and
 * its `configured` state must read as unknown rather than as a "no".
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createClient } from "@hepi/ui/client";
import { ExtensionsConfig } from "@hepi/ui/components/ExtensionsConfig";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-mcp-tool-states.fixture.css";

type Recorded = { method: string; url: string; body: unknown };

declare global {
  interface Window {
    __ux03c?: {
      requests: Recorded[];
      switchTo: (conversationId: string) => void;
      setDelay: (ms: number) => void;
      /** How many responses the delay still holds, so a journey can prove an answer is in flight. */
      pending: () => number;
    };
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FIRST = "conversation-1";
const SECOND = "conversation-2";
const noWorkspace = new URLSearchParams(window.location.search).get("scope") === "no-workspace";
const hostOffline = new URLSearchParams(window.location.search).get("host") === "offline";

const INSTALLED = [
  { name: "hepi.mcp", tools: [], sections: [] },
  { name: "coding-tools", tools: ["read"], sections: [] },
];
/** The host's own files, as its read answers them: `docs` is usable, `locked` needs a sign-in. Both are configured. */
const SERVERS = noWorkspace
  ? []
  : [
    { server: "docs", scope: "global", enabled: true, exposure: "direct" },
    { server: "locked", scope: "project", enabled: true, exposure: "direct" },
  ];
const DESCRIPTIONS: Record<string, string> = { search: "Search the docs", translate: "Translate text", fetch: "Fetch a page" };
const grant = (conversationId: string, tool: string) => ({
  gatewayId: "workstation",
  scope: "global" as const,
  server: "docs",
  tool,
  description: DESCRIPTIONS[tool] ?? tool,
  // The host's own argument document, which the panel must never carry into browser state.
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  listedAt: 1_792_400_000_000,
});
/** One server's tools per conversation, named differently so a listing that leaked across conversations would show. */
const LISTINGS: Record<string, unknown> = {
  [FIRST]: { scope: "global", server: "docs", tools: [
    { name: "search", description: "Search the docs", inputSchema: { type: "object" }, exposure: "direct" },
    { name: "fetch", description: "Fetch a page", inputSchema: { type: "object" }, exposure: "direct" },
    { name: "secret", description: "Hidden by the host", exposure: "hidden" },
  ], total: 3, truncated: false, pages: 1, durationMs: 12, listedAt: 1_792_400_000_000 },
  [SECOND]: { scope: "global", server: "docs", tools: [
    { name: "translate", description: "Translate text", inputSchema: { type: "object" }, exposure: "direct" },
    { name: "fetch", description: "Fetch a page", inputSchema: { type: "object" }, exposure: "direct" },
    { name: "summarize", description: "Summarize a page", inputSchema: { type: "object" }, exposure: "direct" },
  ], total: 3, truncated: false, pages: 1, durationMs: 12, listedAt: 1_792_500_000_000 },
};

/** One conversation's own durable state, held the way the backend holds it: a selection and a set of grants. */
type Conversation = { selected: boolean; grants: ReturnType<typeof grant>[] };
const store = new Map<string, Conversation>([
  [FIRST, { selected: true, grants: [grant(FIRST, "search")] }],
  [SECOND, { selected: true, grants: [grant(SECOND, "translate"), grant(SECOND, "fetch")] }],
]);

const toolName = (tool: string) => "mcp__workstation__docs__" + tool;
const seamOf = (conversationId: string) => "/api/conversations/" + conversationId + "/extensions";
const stateOf = (conversationId: string, extra: Record<string, unknown> = {}) => {
  const conversation = store.get(conversationId)!;
  const offered = conversation.selected ? conversation.grants.map((entry) => toolName(entry.tool)) : [];
  return {
    protocol: "hepi.v1",
    conversationId,
    extensions: conversation.selected ? ["hepi.mcp", "coding-tools"] : ["coding-tools"],
    toolNames: offered,
    mcp: {
      conversationId,
      workspaceId: noWorkspace ? "" : "local",
      ...(noWorkspace ? {} : { gatewayId: "workstation" }),
      selected: conversation.selected,
      // An offline host answers the configuration read as the host does: no servers, the seam's own code and
      // words, and `serversKnown: false` - so no surface reads the empty list as "this host configures nothing".
      // An unbound conversation has no host at all, so its configuration read answers nothing for the same reason it
      // answers nothing when the host is away: never read, not "configures none".
      servers: hostOffline || noWorkspace ? [] : SERVERS,
      ...(hostOffline || noWorkspace
        ? {
          serversKnown: false,
          serversRefusal: hostOffline
            ? { code: "gateway_offline", error: "the gateway workstation this conversation's host belongs to is not configured, so its configuration was not read" }
            : { code: "host_unavailable", error: "this conversation is bound to no execution workspace, so no host configuration of it can be read" },
        }
        : { serversKnown: true }),
      grants: conversation.grants,
      offered,
      ...extra,
    },
  };
};

const requests: Recorded[] = [];
let delayMs = 0;
let pending = 0;
/** Hold a listing or a write open, so a journey can switch conversations while that one answer is still in flight. */
const inFlight = async (): Promise<void> => {
  if (delayMs === 0) return;
  pending += 1;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  pending -= 1;
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (!url.startsWith("/api/")) return realFetch(input, init);
  requests.push({ method, url, body });
  if (url === "/api/extensions" && method === "GET") {
    return json({
      protocol: "hepi.v1",
      installed: INSTALLED.map((extension) => ({ ...extension, enabled: true })),
      default: ["hepi.mcp", "coding-tools"],
      failures: [],
    });
  }
  const conversationId = url.split("/")[3] ?? "";
  // Both halves of 03b's seam reach the backend on the same route: the block's grants and the extension switch above it
  // are two fields of one conversation's selection.
  const seam = seamOf(conversationId);
  // One vocabulary, the Backend's own: the panel asks `/api/conversations/:id/…` for the state read and for both halves of
  // 03b's seam (the extension switch above the block and the block's own grants), so this fixture answers exactly that.
  const onSeam = (path: string) => url === path || url.startsWith(path + "?");
  const statePath = "/api/conversations/" + conversationId + "/state";
  if (!onSeam(seam) && url !== statePath) {
    return json({ error: "the fixture answers no other route" }, 501);
  }
  const conversation = store.get(conversationId);
  if (conversation === undefined) return json({ error: "no such conversation" }, 404);
  if (method === "GET" && url === statePath) {
    return json({ sessionId: conversationId, extensions: conversation.selected ? ["hepi.mcp", "coding-tools"] : ["coding-tools"] });
  }
  if (method === "GET" && onSeam(seam)) {
    const server = (url.split("?")[1] ?? "").replace("mcp=", "");
    if (server === "") return json(stateOf(conversationId));
    if (hostOffline) {
      // A listing connects a server, which a host that is not answering cannot do: the refusal is the host's own code.
      return json({ protocol: "hepi.v1", code: "gateway_offline", error: "the gateway workstation this conversation's host belongs to is not configured, so this server cannot be listed" }, 503);
    }
    await inFlight();
    if (server === "locked") {
      // A named refusal, not an empty list: the host has the server but not the sign-in its tools need.
      return json({ code: "needs-auth", error: "the locked server needs a sign-in" }, 409);
    }
    return json(stateOf(conversationId, { listed: LISTINGS[conversationId] }));
  }
  if (method === "PATCH" && url === seam) {
    const mcp = body?.mcp as { server: string; tools: string[] } | undefined;
    if (mcp === undefined) {
      // The extension switch above the MCP block writes this conversation's whole selection.
      const extensions = (body?.extensions ?? []) as string[];
      conversation.selected = extensions.includes("hepi.mcp");
      return json({ protocol: "hepi.v1", conversationId, extensions, toolNames: [] });
    }
    await inFlight();
    if (hostOffline) {
      // A revocation asks a host nothing, so it must work here; a grant asks the host what it holds and cannot.
      if (mcp.tools.length > 0) {
        return json({ protocol: "hepi.v1", code: "gateway_offline", error: "the gateway workstation this conversation's host belongs to is not configured, so nothing can be granted from it" }, 503);
      }
      // A revocation is the backend taking an offer away: it names no host, so it is stored and answered here.
      conversation.grants = [];
      return json(stateOf(conversationId));
    }
    if (mcp.server === "locked") return json({ code: "not_listed", error: "the host lists no tool of locked" }, 409);
    conversation.grants = mcp.tools.map((tool) => grant(conversationId, tool));
    // A grant's answer carries the fresh listing the backend needed to write the descriptors.
    return json(stateOf(conversationId, { listed: LISTINGS[conversationId] }));
  }
  return json({ error: "the fixture answers no other method" }, 501);
};

function Panel() {
  const [conversationId, setConversationId] = useState(FIRST);
  window.__ux03c = {
    requests,
    switchTo: (next: string) => setConversationId(next),
    setDelay: (ms: number) => { delayMs = ms; },
    pending: () => pending,
  };
  return <ExtensionsConfig sessionId={conversationId} onClose={() => undefined} onOpenSection={() => undefined} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
// The panel asks its routes through the connection it is mounted under, as it does in the workbench. This fixture's
// connection is a Web page's own: no stated origin, the browser's cookie, and the fixture's replaced `window.fetch`.
const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={workbenchConnection(client, { profile: "ux-03c", backendId: "ux-03c", accountScope: "ux-03c" })}>
    <I18nProvider>
      <Panel />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
