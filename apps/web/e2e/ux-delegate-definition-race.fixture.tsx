/**
 * Browser fixture for ticket 12's review: the quick delegate's definition selector must keep showing the folder the
 * conversation is on, even when the previous folder's definition read answers afterwards.
 *
 * The panel is mounted the way both hosts mount it — inside StrictMode and a connection — and its network boundary is
 * replaced. The first folder's definition read is held until the driver releases it, so the driver can move the
 * conversation to a second folder, wait for that folder's definitions, and then let the old read answer. A panel that
 * publishes the old read's refusal hides the selector behind an error for a folder that loaded perfectly well.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { QuickDelegatePanel } from "@hepi/ui/components/QuickDelegatePanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-skills-inventory-race.fixture.css";

const HOST = { user: "operator", home: "/home/operator" };

function definition(name: string, scope: "project" | "user") {
  return {
    name,
    description: name + " does work",
    scope,
    enabled: true,
    context: "fresh",
    issues: [],
    hostId: "workstation",
    workspaceId: "alpha",
    path: "/work/alpha/.pi/agents/" + name + ".md",
    raw: "---\nname: " + name + "\n---\n",
    instructions: "Do the work.",
    tools: ["read"],
    effective: true,
  };
}

export interface Gate {
  /** The held read for the first folder, once the panel has asked for it. */
  readonly alphaHeld: boolean;
  releaseAlpha(): void;
  /** Move the conversation to the second folder, as switching session or project does. */
  switchToBeta(): void;
}

declare global {
  interface Window { __ux13?: Gate }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let release: () => void = () => undefined;
const held = new Promise<void>((resolve) => { release = resolve; });

const gate: Gate = {
  get alphaHeld() { return heldAlpha; },
  releaseAlpha: () => { release(); },
  switchToBeta: () => { setCwd?.("/workspace/beta"); },
};
let heldAlpha = false;
let setCwd: ((cwd: string) => void) | null = null;
window.__ux13 = gate;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/agent-definitions")) {
    const workspaceId = new URL(url, window.location.origin).searchParams.get("workspaceId");
    if (workspaceId === "alpha") {
      heldAlpha = true;
      await held;
      return json({ hostId: "workstation", workspaceId: "alpha", definitions: [definition("alpha-agent", "project")], shadowed: [] });
    }
    return json({ hostId: "workstation", workspaceId: "beta", definitions: [definition("beta-agent", "project")], shadowed: [] });
  }
  return realFetch(input, init);
};

const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const identity = { profile: "ux-13", backendId: "ux-13", accountScope: "ux-13" };

function Host() {
  const [cwd, set] = useState("/workspace/alpha");
  setCwd = set;
  return (
    <QuickDelegatePanel
      sessionId="session-1"
      cwd={cwd}
      canDelegate
      isChild={false}
      existingChildren={[]}
      onOpenChild={() => undefined}
    />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
      <I18nProvider>
        <Host />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  </StrictMode>,
);
