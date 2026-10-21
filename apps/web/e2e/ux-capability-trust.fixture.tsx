/**
 * Browser fixture for the honest capability three-state and the read-only project trust surface.
 *
 * It mounts the production `ModelsConfig` (whose provider detail asks its own route before offering model import) and
 * the production `SettingsPanel` (which no longer offers a push control at all) plus the production
 * `ProjectTrustDialog`, with only their network boundary — `window.fetch` — replaced by a controlled router. The driver
 * reads rendered DOM and the recorded requests: what the production surfaces decided is the assertion, not what a stub
 * was told.
 *
 * Three answers are available for the model-import capability, one per state the helper distinguishes:
 *   - `served`      — the route answers 200: the control is offered;
 *   - `unsupported` — 501 with `code: "unsupported"`: the deployment says it serves none, so the control is not
 *                      offered and the limit is named;
 *   - `unknown`     — the request never arrives: nothing about the deployment can be read off that, so the surface
 *                      says it could not confirm and still offers no control whose request it cannot vouch for.
 *
 * The trust dialog is the production one over a controlled `GET /api/project-trust`: it must list what the folder's
 * `.pi/mcp.json` declares, say where the decision is recorded, and offer exactly one control — Close.
 */
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { ModelsConfig } from "@hepi/ui/components/ModelsConfig";
import { ProjectTrustDialog } from "@hepi/ui/components/ProjectTrustDialog";
import { SettingsPanel } from "@hepi/ui/components/SettingsPanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import "./ux-capability-trust.fixture.css";

const CWD = "/workspace/local";
const PROJECT_FILE = "/workspace/local/.pi/mcp.json";

export type CapabilityAnswer = "served" | "unsupported" | "unknown";

export type Recorded = { method: string; url: string };

export interface Gate {
  /** Every request the surfaces made, in order, so the driver can assert on the real calls. */
  requests: Recorded[];
  /** Set by the dialog's own Close, so the driver sees the real control work. */
  trustDialogClosed: boolean;
  setCapabilityAnswer(answer: CapabilityAnswer): void;
  openTrustDialog(): void;
}

declare global {
  interface Window { __uxCapabilityTrust?: Gate }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const gate: Gate = {
  requests: [],
  trustDialogClosed: false,
  setCapabilityAnswer: () => undefined,
  openTrustDialog: () => undefined,
};

const projectListing = {
  requiresTrust: true,
  trusted: false,
  decision: null,
  inherited: false,
  mcpFile: { scope: "project" as const, path: PROJECT_FILE, exists: true, problems: [] },
  mcpServers: [{
    name: "repo",
    scope: "project" as const,
    sourcePath: PROJECT_FILE,
    configKey: "fixture-key",
    enabled: true,
    validated: true,
    transport: "stdio" as const,
    command: "npx",
    args: ["-y", "repo-server"],
    envNames: [],
    headerNames: [],
    usesOAuth: false,
    commandFields: [],
    variableReferences: [],
    masked: false,
  }],
};

/** One custom provider, so the panel opens its detail and asks that provider's own model-import route. */
const modelsConfig = { providers: { local: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "fixture-model" }] } } };

const enabledModels = {
  allEnabled: true,
  patterns: null,
  stalePatterns: [],
  enabledTotal: 1,
  availableTotal: 1,
  providers: [{ id: "local", name: "local", enabled: true, models: [] }],
  scope: "global" as const,
  settingsPath: "~/.pi/agent/settings.json",
  editable: true,
};

/** The answer the next read of the model-import capability gets; the driver sets it through the gate. */
let capabilityAnswer: CapabilityAnswer = "served";

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const requested = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // The panels reach their routes through the connection client, which resolves a path against the origin the fixture
  // was served from; the driver asserts on the route, so the origin is stripped here and nowhere else.
  const url = requested.startsWith(window.location.origin) ? requested.slice(window.location.origin.length) : requested;
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/")) gate.requests.push({ method, url });
  // The capability's own route, answered as the driver chose: a real 200, a real unsupported reply, or nothing at all.
  if (url.startsWith("/api/models-config/discover")) {
    if (capabilityAnswer === "unknown") throw new TypeError("fetch failed");
    if (capabilityAnswer === "unsupported") return json({ error: "This deployment does not serve model import.", code: "unsupported" }, 501);
    return json({ models: [{ id: "upstream-model", name: "Upstream model" }] });
  }
  if (url.startsWith("/api/models-config")) return json(modelsConfig);
  if (url.startsWith("/api/models/enabled")) return json(enabledModels);
  if (url.startsWith("/api/auth/providers")) return json({ oauthProviders: [], apiKeyProviders: [] });
  if (url.startsWith("/api/project-trust")) return json(projectListing);
  if (url.startsWith("/api/web-auth")) return json({ enabled: false });
  if (url.startsWith("/api/tools/settings")) {
    return json({ isWindows: false, powerShellEnabled: false, codemode: "never", codemodeMode: "off", codemodeInlineBudget: "default" });
  }
  return realFetch(requested, init);
};

function Fixture() {
  const [settingsKey, setSettingsKey] = useState(0);
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);

  // The gate hands the driver the two actions it needs, and both go through the real component state. A new answer
  // remounts the panel, which is what a reload does: the capability is asked once per mount and never retried.
  gate.setCapabilityAnswer = (answer) => { capabilityAnswer = answer; setSettingsKey((key) => key + 1); };
  gate.openTrustDialog = () => setTrustDialogOpen(true);

  const close = useCallback(() => {
    gate.trustDialogClosed = true;
    setTrustDialogOpen(false);
  }, []);

  return (
    <>
      {/* Keyed so a new answer remounts the panels: the capability is asked once per mount, which is what a reload does. */}
      <ModelsConfig key={settingsKey} onClose={() => undefined} />
      <SettingsPanel
        key={"settings-" + settingsKey}
        cwd={CWD}
        displayCwd={CWD}
        sessionId={null}
        initialSection="general"
        onClose={() => undefined}
        onSessionReloaded={() => undefined}
        quoteSelectionEnabled={false}
        onQuoteSelectionChange={() => undefined}
        projectTrust={{ requiresTrust: true, trusted: false, decision: null, inherited: false }}
      />
      {trustDialogOpen && <ProjectTrustDialog cwd={CWD} onClose={close} />}
    </>
  );
}

window.__uxCapabilityTrust = gate;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");

// The panels read their connection from the tree they are mounted in. This fixture's connection is a real client over
// the fixture's own origin; it joins no stream, because nothing here is about the transport.
const client = createClient({
  origin: window.location.origin,
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

createRoot(rootElement).render(
  <I18nProvider>
    <WorkbenchConnectionProvider value={workbenchConnection(client, { profile: "fixture", backendId: "fixture", accountScope: "fixture" })}>
      <Fixture />
    </WorkbenchConnectionProvider>
  </I18nProvider>,
);
