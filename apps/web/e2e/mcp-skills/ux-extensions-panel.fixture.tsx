/**
 * Browser fixture for ticket 15: the extensions panel must show exactly the installed durable extensions, enable and
 * disable them as the backend's global default or as the open conversation's own selection, write a bulk toggle as one
 * request, and offer nothing it cannot do — no install, no update, no check and no generic per-extension editor.
 *
 * It mounts the production ExtensionsConfig with only its network boundary replaced, so the panel's real state
 * handling, its real scope resolution and the real request bodies are what the driver observes. The fixture records
 * every request it receives and answers as the backend does, so what the panel decided is the assertion.
 *
 * `?session=none` mounts the panel with no conversation open, which is the state a deployment with no session has.
 */
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { ExtensionsConfig } from "@hepi/ui/components/ExtensionsConfig";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-extensions-panel.fixture.css";

type Recorded = { method: string; url: string; body: unknown };

declare global {
  interface Window {
    __ux15?: {
      requests: Recorded[];
      /** Every section the panel asked Settings to open, which is how an extension's own surface is reached. */
      openedSections: string[];
    };
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const requests: Recorded[] = [];
const openedSections: string[] = [];
window.__ux15 = { requests, openedSections };

/** The installed set and the selections, as the backend answers them; the fixture keeps them in memory. */
const installed = [
  { name: "coding-tools", tools: ["read", "write", "edit", "bash"], sections: [] },
  { name: "workspace-resources", tools: [], sections: ["resources"] },
];
/** The deployment's default: both extensions, which is what a new conversation would materialize. */
let defaultSelection = ["coding-tools", "workspace-resources"];
/** The open conversation's own selection, which differs: it was overridden after it was created. */
let conversationSelection = ["coding-tools"];
const failures: { name: string; message: string }[] = [];

const inventory = () => ({
  protocol: "hepi.v1",
  installed: installed.map((extension) => ({ ...extension, enabled: defaultSelection.includes(extension.name) })),
  default: defaultSelection,
  failures,
});
const unknown = (names: readonly string[]) => names.filter((name) => !installed.some((extension) => extension.name === name));

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (url.startsWith("/api/")) requests.push({ method, url, body });
  if (url === "/api/extensions" && method === "GET") return json(inventory());
  if (url === "/api/extensions" && method === "POST") {
    const names = body.extensions as string[];
    const missing = unknown(names);
    if (missing.length > 0) return json({ code: "unknown_extension", error: "no installed extension is named " + missing.join(", ") }, 400);
    defaultSelection = names;
    return json(inventory());
  }
  // The conversation scope asks the Backend's own vocabulary, which is the only one this deployment serves: a panel on
  // the retired `/api/sessions/…` spelling asks for a conversation the Backend has never heard of, so the fixture answers
  // exactly the route the panel must send.
  if (url.startsWith("/api/conversations/") && url.endsWith("/state") && method === "GET") {
    const id = decodeURIComponent(url.slice("/api/conversations/".length, -"/state".length));
    return json({ sessionId: id, extensions: conversationSelection });
  }
  if (url.startsWith("/api/conversations/") && url.endsWith("/extensions") && method === "PATCH") {
    const names = body.extensions as string[];
    const missing = unknown(names);
    if (missing.length > 0) return json({ code: "unknown_extension", error: "no installed extension is named " + missing.join(", ") }, 400);
    conversationSelection = names;
    return json({ protocol: "hepi.v1", conversationId: "session-1", extensions: conversationSelection, toolNames: [] });
  }
  return realFetch(input, init);
};

const sessionId = new URLSearchParams(window.location.search).get("session") === "none" ? null : "session-1";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
// The panel reads and writes through the connection it is mounted under, as it does in the workbench. This fixture's
// connection is a Web page's own: no stated origin, the browser's cookie, and the fixture's replaced `window.fetch` as
// the transport, so every request the driver records is one the panel really made.
const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={workbenchConnection(client, { profile: "ux-15", backendId: "ux-15", accountScope: "ux-15" })}>
    <I18nProvider>
      <ExtensionsConfig
        sessionId={sessionId}
        onClose={() => undefined}
        onOpenSection={(section) => openedSections.push(section)}
      />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
