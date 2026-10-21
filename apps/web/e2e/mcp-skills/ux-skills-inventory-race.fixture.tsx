/**
 * Browser fixture for UX ticket 10 (and ticket 12's review): the builtin Skills panel must keep showing the execution
 * target the sidebar shows, whatever order the hosts' inventory answers arrive in.
 *
 * It mounts the production SkillsConfig with the component's real network boundary - window.fetch - replaced by a
 * controlled router. Every inventory answer is held until the driver releases it, so the interleaving is exact rather
 * than timed: an answer for a host the panel has left may arrive before or after the selected host's own, and neither
 * order may publish the wrong host's skills, end the selected host's loading state, or report the wrong host's error.
 *
 * The driver reads rendered DOM only; this file exposes no component internals beyond the pending requests and their
 * release functions, which exist so the driver waits on a real event instead of a duration.
 */
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { SkillsConfig } from "@hepi/ui/components/SkillsConfig";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-skills-inventory-race.fixture.css";

const ALPHA = { id: "alpha", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/work/alpha" };
const BETA = { id: "beta", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/work/beta" };

function skill(name: string) {
  return {
    name,
    directory: name,
    description: name + " description",
    filePath: "/home/operator/.agents/skills/" + name + "/SKILL.md",
    scope: "global" as const,
    disableModelInvocation: false,
    revision: "up-to-date" as const,
  };
}

export interface Held {
  readonly workspaceId: string;
  /** Hand this host's answer to the component. */
  release(): void;
}

export interface Gate {
  /** Every inventory read still held, in the order the panel asked for them. */
  readonly held: Held[];
}

declare global {
  interface Window { __ux10?: Gate }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const gate: Gate = { held: [] };
window.__ux10 = gate;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/workspaces")) return json({ workspaces: [ALPHA, BETA] });
  if (url.startsWith("/api/skill-market/inventory")) {
    const id = new URL(url, window.location.origin).searchParams.get("workspaceId") ?? "";
    const pending = Promise.withResolvers<void>();
    gate.held.push({ workspaceId: id, release: () => pending.resolve() });
    await pending.promise;
    const host = id === "alpha" ? ALPHA.host : BETA.host;
    return json({ workspaceId: id, host, skills: [skill(id + "-skill")] });
  }
  if (url.startsWith("/api/skill-market/skills")) return json({ skills: [], unavailableSources: [] });
  return realFetch(input, init);
};

// The panel reads the host's inventory through the connection, so the fixture states one: a same-origin cookie
// connection, exactly the Web host's, whose requests land on the fetch boundary replaced above.
const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  // No stream is joined here; the factory is stated because the client requires one.
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const identity = { profile: "ux-10", backendId: "ux-10", accountScope: "ux-10" };

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  // The hosts mount the workbench in StrictMode, so this fixture does too: a target the replay's cleanup retired must
  // not be the one the panel goes on reading through.
  <StrictMode>
    <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
      <I18nProvider>
        <SkillsConfig cwd="/workspace/alpha" sessionId="1" onClose={() => undefined} trust={{ requiresTrust: false, trusted: true, decision: true, inherited: false }} />
      </I18nProvider>
    </WorkbenchConnectionProvider>
  </StrictMode>,
);
