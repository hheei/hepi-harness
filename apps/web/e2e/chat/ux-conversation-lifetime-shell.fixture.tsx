/**
 * The conversation lifetime in the production shell, in a real browser.
 *
 * The sibling `ux-conversation-lifetime` fixture mounts `ChatWindow` with a registry the page states by hand, which is
 * what isolates the chat's own rules. This one mounts the production `AppShell` — the registry, the selection, the
 * Settings panel and the chat's own reload registration — because two of ticket 03's acceptance criteria are the
 * **shell's** rules and cannot be stated from the chat alone:
 *
 * - C4/C1 across a connection switch: the shell's registry belongs to the connection it was built for, so a switch
 *   rebuilds it over the new client instead of leaving the replaced client's watches attached.
 * - C3 exactly-once reload: Settings › General asks the conversation's own reload, and the Backend's route is asked
 *   once however many surfaces wanted it.
 *
 * Only the transport is stated here: `fetch` answers the Backend's own routes, and the stream is a source this page
 * drives. Everything above that is the production tree.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { WorkbenchNavigationProvider } from "@hepi/ui/lib/navigation";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { AppShell } from "@hepi/ui/components/AppShell";

const CONVERSATION = "shell-conv";

export type ShellRequest = { method: string; path: string };

declare global {
  interface Window {
    __lifetimeShell?: {
      requests: ShellRequest[];
      /** Deliver one event on every connection's stream for a conversation, as the Backend states it. */
      emit(conversationId: string, event: unknown): void;
      /** Deliver one event on **one** connection's stream, so which connection the shell reads is what the page proves. */
      emitOn(owner: string, conversationId: string, event: unknown): void;
      /** Every stream the page holds open, named by the connection that owns it. */
      readonly openStreams: string[];
      /** Every stream a connection opened, with the state it is in now. */
      readonly streams: string[];
      /**
       * Replace the connection under the mounted shell.
       *
       * `sameScope` is the case a remount cannot answer: the I18nProvider above the shell is keyed by the connection's
       * **scope**, so a different scope remounts the tree and rebuilds everything in it. A connection that keeps its
       * scope — the same Backend and account under a replaced client — replaces the provider value only, and this same
       * shell renders again inside it.
       */
      replaceConnection(sameScope: boolean): void;
      /** Which connection the shell is inside, as the page states it. */
      readonly scope: string;
    };
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requests: ShellRequest[] = [];

const entry = (id: string, role: "user" | "assistant", text: string) =>
  ({ id, role, text, message: { role, content: [{ type: "text", text }] } });
const snapshotOf = (id: string) => ({
  protocol: "hepi.v1", revision: 1, conversationId: id, projectionId: "P-" + id,
  historyRevision: "rev-1", historyHead: "h-1", hasMore: false, oldestEntryId: null,
  run: null, busy: false, entries: [entry("e1", "user", "an earlier question")], partial: "", toolNames: [], extensions: [],
  liveTools: [], settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  queuedItems: [], control: { state: "allowed", revision: 0 }, failure: null, submissions: [],
});
const row = (id: string) => ({
  id, workspaceId: "local", gatewayId: "workstation", busy: false, revision: 1, messageCount: 1, firstMessage: "the " + id,
  workspace: { gatewayId: "workstation", root: "/srv/one", project: { id: "p-one", name: "ONE", defaultWorkspaceId: "local", displayRoot: "/srv/one" } },
});
const sessionRow = (id: string) => ({
  path: "/sessions/" + id, id, cwd: "/srv/one",
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "the " + id,
});

/** The conversations the shell lists, and the one each connection reads for the same id. */
const CATALOGUE = { conversations: [row(CONVERSATION)], sidebarStateRevision: 1, projectsRevision: 1, sessionListVersion: 1 };
const EMPTY_PAGE = { output: [], details: { tail: "1", offset: 0, limit: 200, outputLines: 0, truncated: false, hasMore: false, entries: [] }, diagnostics: [] };
const OUTLINE = (id: string) => ({
  protocol: "hepi.v1", conversationId: id, snapshot: "s1", scope: "sc1", order: "oldest-first",
  anchors: [], hasMore: false, capped: false, bytes: 0,
});

function answer(path: string, params: URLSearchParams, body: string | null, method: string | undefined): Response {
  if (path === "/api/conversations") {
    if (params.get("running") === "compact") return json({ runningConversationIds: [], sessionListVersion: 1, sidebarStateRevision: 1, projectsRevision: 1 });
    return json(CATALOGUE);
  }
  if (path.startsWith("/api/conversations/")) {
    const parts = path.split("/");
    const id = decodeURIComponent(parts[3] ?? "");
    const operation = parts[4] ?? "";
    if (operation === "state") return json(snapshotOf(id));
    if (operation === "navigation" && parts[5] === "around") return json({ error: "no mountable entry", code: "missing" }, 404);
    if (operation === "navigation") return json(OUTLINE(id));
    if (operation === "entries" || operation === "subtree-control") return json(EMPTY_PAGE);
    if (operation === "settings") return json({ model: null, thinkingLevel: "off" });
    if (operation === "commands") return json({ commands: [] });
    if (operation === "submissions") return json({ submission: null });
    // The reload route this scene is about: the Backend's own answer about the runtime's resources.
    if (operation === "reload") return json({ resources: { skills: 2, prompts: 1 } });
    if (operation === "messages" && (method ?? "GET") === "POST") return json({ submissionId: "s1", control: { state: "allowed", revision: 1 } });
    if (operation === "") return json({ ...sessionRow(id), conversation: { id, cwd: "/srv/one" }, state: snapshotOf(id) });
    return json({ ...sessionRow(id), conversation: { id, cwd: "/srv/one" }, state: snapshotOf(id) });
  }
  if (path === "/api/search") return json({ truncated: false, results: [] });
  if (path === "/api/sidebar-state") return json({ state: { version: 1, revision: 1, sessions: {}, projects: {} } });
  if (path === "/api/projects") return json({ protocol: "hepi.v1", projects: [] });
  if (path === "/api/workspaces") return json({ workspaces: [{ id: "local", gatewayId: "workstation", host: { user: "op", home: "/home/op" }, workspaceRoot: "/srv" }] });
  if (path === "/api/hosts") return json({ protocol: "hepi.v1", hosts: [{ id: "workstation", profiles: [] }] });
  if (path === "/api/host/directories") return json({ path: "/srv", parentPath: null, directories: [], host: { user: "op", home: "/home/op" } });
  if (path === "/api/cwd/validate") {
    const cwd = (body === null ? null : (JSON.parse(body) as { cwd?: string }).cwd) ?? params.get("cwd") ?? "/srv/one";
    return json({ cwd, projectKey: cwd, projectRoot: cwd, displayRoot: cwd });
  }
  // The shell-tool setting this scene toggles, and every other configuration read beside it.
  if (path.startsWith("/api/tools/settings")) {
    if ((method ?? "GET") === "PUT") return json({ isWindows: true, powerShellEnabled: true });
    return json({ isWindows: true, powerShellEnabled: true });
  }
  if (path.startsWith("/api/models")) return json({ models: [], enabled: [] });
  if (path.startsWith("/api/agent")) return json({ commands: [], definitions: [], agents: [] });
  if (path.startsWith("/api/worktrees")) return json({ worktrees: [], state: "ready" });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: "/srv", parentPath: null });
  if (path.startsWith("/api/git/status")) return json({ branch: null, entries: [], ahead: 0, behind: 0 });
  if (path.startsWith("/api/settings") || path.startsWith("/api/home") || path.startsWith("/api/default-cwd")) return json({});
  return json({});
}

/** The Backend's own routes as this page answers them, recorded in order. */
const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, window.location.origin);
  requests.push({ method: init?.method ?? "GET", path: parsed.pathname + parsed.search });
  return answer(parsed.pathname, parsed.searchParams, typeof init?.body === "string" ? init.body : null, init?.method);
};

/**
 * Every stream a connection's client opened, named by the connection that owns it.
 *
 * The owner is in the key because the whole question a switch asks is *which* connection holds the stream: the same
 * conversation id is on both, and a map keyed by the id alone could not tell a replaced source from the one that
 * replaced it. A source that was closed stays here with its state, so "the outgoing one closed" is a fact this page can
 * read rather than an inference from a count.
 */
type ShellSource = {
  readonly owner: string;
  readonly conversationId: string;
  readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
};
const sources = new Map<string, ShellSource>();
const createSource = (owner: string) => (conversationId: string) => {
  const source: ShellSource = {
    owner,
    conversationId,
    readyState: 1,
    onmessage: null,
    onerror: null,
    close() { source.readyState = 2; },
  };
  sources.set(owner + ":" + conversationId, source);
  queueMicrotask(() => source.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: conversationId }) } as MessageEvent<string>));
  return source;
};

/**
 * The identity the same-scope pair is built from: the same profile, the same Backend and the same account scope, which
 * is what makes two different clients one scope. The scope is the tree's key, so this pair does not remount it — and a
 * pair that differs in any of the three does, which is the other half of the scene.
 */
const SAME_SCOPE = { profile: "ux-shell", backendId: "b", accountScope: "acct" };
const makeConnection = (sourceOwner: string) => workbenchConnection(createClient({
  origin: "",
  credential: { kind: "cookie" },
  fetch: connectionFetch,
  createSource: createSource(sourceOwner),
}), connectionIdentityOf(SAME_SCOPE.profile, { backend: { id: SAME_SCOPE.backendId }, account: { scope: SAME_SCOPE.accountScope } }));

// A distinct client per owner, so which connection's stream a frame belongs to is a fact the page can read.
const connections = {
  first: makeConnection("first"),
  sameScope: makeConnection("replaced"),
};

const navigation = {
  location: { get search() { return window.location.search; } },
  navigate: (search: string) => { window.history.replaceState({}, "", search === "" ? "/" : search); },
};

let replaceConnection: (sameScope: boolean) => void = () => {};

/**
 * The production shell under one connection, which the page can replace.
 *
 * The provider value is replaced without a key change on `sameScope`, which is the case a remount cannot cover: the tree
 * above the shell is keyed by the connection's **scope**, so a different scope remounts everything — and a remount is
 * exactly what made the once-initialized registry look correct. A connection that keeps its scope does not remount.
 */
function Fixture() {
  const [which, setWhich] = useState<"first" | "sameScope" | "otherScope">("first");
  const [replacement, setReplacement] = useState(0);
  const otherScope = workbenchConnection(createClient({
    origin: "",
    credential: { kind: "cookie" },
    fetch: connectionFetch,
    createSource: createSource("ux-shell-other-" + replacement),
  }), connectionIdentityOf("ux-shell-other", { backend: { id: "other" }, account: { scope: "other" } }));
  const connection = which === "first" ? connections.first
    : which === "sameScope" ? connections.sameScope
      : otherScope;
  replaceConnection = (sameScope) => {
    if (sameScope) setWhich((current) => current === "first" ? "sameScope" : "first");
    else { setReplacement((current) => current + 1); setWhich("otherScope"); }
  };
  return (
    <WorkbenchNavigationProvider value={navigation}>
      <WorkbenchConnectionProvider value={connection}>
        <I18nProvider key={connection.scope}>
          <AppShell />
        </I18nProvider>
      </WorkbenchConnectionProvider>
    </WorkbenchNavigationProvider>
  );
}

window.__lifetimeShell = {
  requests,
  emit(conversationId, event) {
    // Every connection's source for this conversation hears it: the id is the same on both, and a frame is a frame.
    for (const source of sources.values()) {
      if (source.conversationId === conversationId) source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    }
  },
  emitOn(owner, conversationId, event) {
    // One connection's source only. A frame delivered this way reaches the shell **through that connection**, so what
    // the page renders afterwards is evidence about which connection the shell is actually reading.
    const source = sources.get(owner + ":" + conversationId);
    if (source === undefined) throw new Error("no stream was opened by " + owner + " for " + conversationId);
    if (source.readyState !== 1) throw new Error(owner + "'s stream for " + conversationId + " is closed");
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  },
  replaceConnection(sameScope) { replaceConnection(sameScope); },
  /** Every stream the page holds open, named by the connection that owns it: "owner:conversationId". */
  get openStreams() {
    return [...sources.values()].filter((source) => source.readyState === 1).map((source) => source.owner + ":" + source.conversationId);
  },
  /** Every stream a connection opened, with the state it is in now. */
  get streams() {
    return [...sources.values()].map((source) => source.owner + ":" + source.conversationId + (source.readyState === 1 ? ":open" : ":closed"));
  },
  get scope() { return "stated-by-the-page"; },
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(<Fixture />);
