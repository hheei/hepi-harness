/**
 * Browser fixture for UX ticket 11: a Project-scope skill operation must land on the folder the project itself names as
 * default, even when the session it was opened from is bound to a different folder of that same project — and it must
 * name no conversation when it does, because no conversation on the sidebar's folder runs where the write lands.
 *
 * It mounts the production SkillsConfig with only its network boundary replaced, so the panel's real state handling,
 * real scope resolution and the real request bodies are what the driver observes. The fixture records the requests it
 * receives, and the driver reads those records: what the panel decided is the assertion, not what a stub was told.
 */
import { createRoot } from "react-dom/client";
import { SkillsConfig } from "@hepi/ui/components/SkillsConfig";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import "./ux-skills-project-target.fixture.css";

// Two folders of one project: the session below is bound to ALPHA, while the project's own default is BETA.
const ALPHA = { id: "alpha", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/work/alpha" };
const BETA = { id: "beta", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/work/beta" };
const PROJECT = {
  id: "project-1",
  name: "Project One",
  hostId: "workstation",
  defaultFolderId: "folder-beta",
  folders: [
    { id: "folder-alpha", workspaceId: "alpha", root: "/work/alpha", cwd: "/workspace/alpha", default: false },
    { id: "folder-beta", workspaceId: "beta", root: "/work/beta", cwd: "/workspace/beta", default: true },
  ],
};

const NOTES = "---\nname: notes\ndescription: Take notes\n---\n# Notes\n";

function skill(name: string) {
  return {
    name,
    directory: name,
    description: name + " description",
    filePath: "/work/alpha/.agents/skills/" + name + "/SKILL.md",
    scope: "project" as const,
    disableModelInvocation: false,
    revision: "unknown" as const,
    // A GitHub-pinned installation: its provenance names the repository and the installed document, which is exactly
    // what an update check asks about, so the panel offers the check this fixture asserts on.
    install: {
      scope: "workspace" as const,
      state: "unchanged" as const,
      source: "github:" + name + "@aaaa1111bbbb2222",
      sourceType: "github",
      ref: "aaaa1111bbbb2222",
      repository: "anthropics/skills",
      documentPath: "skills/" + name + "/SKILL.md",
      path: "/work/alpha/.agents/skills/" + name,
      directory: name,
      files: { "SKILL.md": "0".repeat(64) },
    },
  };
}

// A bundle the host does not already hold, so pressing Install is a first installation rather than an update of the
// skill the inventory lists.
const BUNDLE = {
  id: "journal-bundle",
  name: "journal",
  description: "Keep a journal",
  source: { kind: "github" as const, repository: "anthropics/skills", revision: "aaaa1111bbbb2222", path: "skills/journal/SKILL.md" },
};

export type Recorded = { method: string; url: string; body: unknown };
export interface Gate {
  /** Every request the panel made, in order, so the driver can read the bodies the panel actually sent. */
  requests: Recorded[];
}

declare global {
  interface Window { __ux11?: Gate }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const gate: Gate = { requests: [] };
window.__ux11 = gate;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/")) gate.requests.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  if (url.startsWith("/api/workspaces")) return json({ workspaces: [ALPHA, BETA] });
  if (url.startsWith("/api/projects")) return json({ projects: [PROJECT] });
  if (url.startsWith("/api/skill-market/inventory")) return json({ workspaceId: "alpha", host: ALPHA.host, skills: [skill("notes")] });
  // The one toggle route the panel now uses, on the same host-scoped path as the rest of the market: a directory list
  // and the state to switch them to.
  if (url.startsWith("/api/skill-market/skills") && method === "PATCH") return json({ results: [{ directory: "notes", changed: true }], scope: "workspace", reload: { ok: true } });
  // The library the add pane browses: one bundle, so an installation started from the pane is a real request rather
  // than a disabled button.
  if (url.startsWith("/api/skill-market/skills")) return json({ skills: [BUNDLE], unavailableSources: [] });
  if (url.startsWith("/api/skill-market/install")) return json({ installed: { name: "journal", scope: "workspace", path: "/work/beta/.agents/skills/journal", contentHash: "0".repeat(64), files: ["SKILL.md"] }, reload: { ok: true } });
  if (url.startsWith("/api/skill-market/check")) return json({ state: "up-to-date", currentRevision: "aaaa1111bbbb2222" });
  if (url.startsWith("/api/skill-market/update")) return json({ installed: { name: "notes", scope: "workspace" } });
  if (url.startsWith("/api/skill-market/preview")) return json({ markdown: NOTES, files: [] });
  return realFetch(input, init);
};

// The panel reaches the host through the connection, so the fixture states one: a same-origin cookie connection,
// exactly the Web host's, whose requests land on the fetch boundary replaced above.
const client = createClient({
  origin: "",
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={workbenchConnection(client, { profile: "ux-11", backendId: "ux-11", accountScope: "ux-11" })}>
    <I18nProvider>
      {/* The session is bound to the project's ALPHA folder; the project's own default is BETA. */}
      <SkillsConfig cwd="/workspace/alpha" sessionId="session-on-alpha" onClose={() => undefined} trust={{ requiresTrust: false, trusted: true, decision: true, inherited: false }} />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
