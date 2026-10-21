import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { GatewayWorkbench } from "../../../packages/gateway/src/workbench/index.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { streamFolder } from "./stream-window.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";
import { createFakeGitHost, type FakeGitHost } from "./fake-git-host.ts";

const TOKEN = "catalogue-binding-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

/**
 * The catalogue, project binding and host selection, over real HTTP.
 *
 * Ticket 06 owns these facts in the Backend: one read answers everything a session list needs about a conversation —
 * its workspace, the host that workspace is on, its group's display root and whether a removal retained it — beside
 * the sidebar's revision, the project registry's revision and the catalogue's own version. The rows are built from one
 * catalog read, one projects read and one workspaces read, so the cost of assembling a list does not grow with the
 * number of conversations and no per-conversation history is read. A project, workspace and worktree operation keeps
 * the binding it already had: a conversation already bound keeps its folder, its host and its root after a removal.
 *
 * The gateway here is real and holds a real git repository on an in-memory host, so a created checkout is a directory
 * a conversation really runs in.
 */

type Entry = { role: string; text: string; message: { isError?: boolean; toolName?: string } };
type Snapshot = { busy: boolean; workspaceId?: string; entries: Entry[] };
type ProjectFolderBody = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectBody = { id: string; name: string; hostId: string; defaultFolderId: string; folders: ProjectFolderBody[]; host?: { user: string; home: string }; hostError?: string };
type CatalogueWorkspaceBody = {
  gatewayId?: string;
  root?: string;
  retained?: true;
  project?: { id: string; name: string; defaultWorkspaceId: string; displayRoot: string };
};
type CatalogueRow = {
  id: string;
  workspaceId?: string | null;
  gatewayId?: string | null;
  workspace?: CatalogueWorkspaceBody;
  revision?: number;
};
type CatalogueBody = {
  protocol: string;
  sidebarStateRevision: number;
  projectsRevision: number;
  sessionListVersion: number;
  conversations: CatalogueRow[];
  nextCursor?: string;
};

type Fixture = {
  base: string;
  origin: string;
  faux: ReturnType<typeof fauxProvider>;
  store: ProjectStore;
  root: string;
  git: FakeGitHost;
  backend: BackendServer;
  close(): Promise<void>;
};

/** One backend, one real gateway on one repository, and the project store the backend records into. */
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-catalogue-"));
  const root = join(directory, "repo");
  const legacy = join(directory, "legacy");
  await mkdir(root);
  await mkdir(legacy);
  const base = await realpath(directory);
  await writeFile(join(root, "README.md"), "baseline\n");
  const git = createFakeGitHost();
  git.initRepository(root, "main");
  const registry = new WorkspaceRegistry([{ id: "legacy", root: legacy }]);
  const identity = { user: "operator", home: join(base, "home") };
  await mkdir(identity.home);
  const server = new GatewayRpcServer(
    new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }),
    new GatewayWorkbench(registry),
    new LocalFilesystem(registry, { identity }),
    undefined,
    new WorkspaceServer(registry, { identity }),
    new GatewayWorktrees(registry, git.git),
  );
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  const gatewayOrigin = "http://127.0.0.1:" + address.port;
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = createProjectStore({ path: join(base, "projects.sqlite") });
  const backend = await createBackendServer({
    dbPath: join(base, "conversations.sqlite"),
    authToken: TOKEN,
    models,
    workspaces: [{ id: "legacy", gatewayId: "workstation", gatewayOrigin, gatewayToken: "gateway-token" }],
    gateways: [{ gatewayId: "workstation", gatewayOrigin, gatewayToken: "gateway-token" }],
    projects: store,
    defaultModel: SERVER_MODEL,
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.server.address();
  assert.ok(backendAddress && typeof backendAddress === "object");
  return {
    base,
    root,
    git,
    faux,
    store,
    backend,
    origin: "http://127.0.0.1:" + backendAddress.port,
    close: async () => {
      backend.server.closeAllConnections();
      await backend.close();
      server.server.closeAllConnections();
      await server.close();
      store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

const catalogue = async (origin: string, query = ""): Promise<CatalogueBody> => await (await fetch(origin + "/api/conversations" + query, { headers })).json() as CatalogueBody;
const rowOf = (body: CatalogueBody, id: string): CatalogueRow => body.conversations.find(row => row.id === id)!;
const projects = async (origin: string, hostId = "workstation"): Promise<ProjectBody[]> => ((await (await fetch(origin + "/api/projects?hostId=" + encodeURIComponent(hostId), { headers })).json()) as { projects: ProjectBody[] }).projects;

async function createProject(origin: string, name: string, root: string): Promise<ProjectBody> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ hostId: "workstation", name, folders: [{ root, default: true }] }) });
  const body = await response.json() as { project?: ProjectBody; error?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.project!;
}

async function createConversation(origin: string, workspaceId?: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
  const body = await response.json() as { conversationId?: string; error?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.conversationId!;
}

async function runTurn(origin: string, conversationId: string, text: string, requestId: string, expected: string): Promise<Snapshot> {
  const path = origin + "/api/conversations/" + conversationId;
  const reader = (await fetch(path + "/events", { headers, signal: AbortSignal.timeout(30000) })).body!.getReader();
  try {
    const submitted = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    assert.equal(submitted.status, 202, await submitted.text());
    const decoder = new TextDecoder();
    let pending = "";
    const stream = streamFolder<Entry>(conversationId);
    let current: Snapshot = { busy: true, entries: [] };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended before the turn settled");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        if (event !== "snapshot" && event !== "state") continue;
        const line = frame.split("\n").find(value => value.startsWith("data: "));
        if (line === undefined) continue;
        current = stream.fold(event, JSON.parse(line.slice(6)));
        if (!current.busy && current.entries.some(entry => entry.role === "assistant" && entry.text === expected)) return current;
      }
    }
  } finally { await reader.cancel(); }
}

const toolResults = (snapshot: Snapshot): Entry[] => snapshot.entries.filter(entry => entry.role === "toolResult");

test("one catalogue read states each conversation's workspace, host, group and retention beside its revisions", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "Repo", app.root);
    const folder = project.folders[0]!;
    const inProject = await createConversation(app.origin, folder.workspaceId);
    const configured = await createConversation(app.origin, "legacy");
    const unbound = await createConversation(app.origin);

    const first = await catalogue(app.origin);
    assert.equal(first.protocol, "hepi.v1");
    // The revisions travel on the same read, so a client comparing them hears of another window's change on its poll.
    assert.equal(typeof first.sidebarStateRevision, "number");
    assert.equal(typeof first.sessionListVersion, "number");
    // One Project was created above, and the registry's revision says so on the same read.
    assert.equal(first.projectsRevision, 1);

    // A conversation bound to a project folder states its own workspace, its host, its recorded root and its group.
    const projectRow = rowOf(first, inProject);
    assert.equal(projectRow.workspaceId, folder.workspaceId);
    assert.equal(projectRow.gatewayId, "workstation");
    assert.deepEqual(projectRow.workspace, {
      gatewayId: "workstation",
      root: app.root,
      project: { id: project.id, name: "Repo", defaultWorkspaceId: folder.workspaceId, displayRoot: app.root },
    });

    // A conversation bound to a configured workspace states its host and nothing else: this deployment holds that
    // workspace as an id and a host, never as a root it did not record.
    const configuredRow = rowOf(first, configured);
    assert.equal(configuredRow.workspaceId, "legacy");
    assert.equal(configuredRow.gatewayId, "workstation");
    assert.deepEqual(configuredRow.workspace, { gatewayId: "workstation" });

    // A conversation bound to nothing claims no workspace, no host and no group.
    const unboundRow = rowOf(first, unbound);
    assert.equal(unboundRow.workspaceId, null);
    assert.equal(unboundRow.gatewayId, null);
    assert.equal(unboundRow.workspace, undefined);

    // The list version moves when a conversation appears, which is what lets another window re-read rather than poll
    // an unchanged number forever.
    const later = await createConversation(app.origin, folder.workspaceId);
    const second = await catalogue(app.origin);
    assert.notEqual(second.sessionListVersion, first.sessionListVersion);
    assert.equal(second.conversations.length, first.conversations.length + 1);
    assert.equal(rowOf(second, later).workspace?.project?.id, project.id);
  } finally {
    await app.close();
  }
});

test("assembling a list reads the catalogue, the projects and the workspaces once each and no conversation history", { timeout: 60000 }, async () => {
  const app = await fixture();
  const counting = globalThis.fetch;
  try {
    const project = await createProject(app.origin, "Counted", app.root);
    const folder = project.folders[0]!;
    for (const workspaceId of [folder.workspaceId, folder.workspaceId, "legacy", undefined]) await createConversation(app.origin, workspaceId);
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(new URL(target).pathname);
      return await counting(input as never, init);
    }) as typeof fetch;
    const listed = await catalogue(app.origin);
    globalThis.fetch = counting;
    assert.equal(listed.conversations.length, 4);
    // One read of each source, whatever the number of conversations: the rows are a projection of what those reads
    // stated, so the cost of a list does not grow with the catalogue.
    assert.deepEqual([...new Set(seen)].sort(), ["/api/conversations"]);
    assert.equal(seen.filter(path => path === "/api/conversations").length, 1);
    // And nothing per conversation: no state read, no history page, no transcript.
    assert.deepEqual(seen.filter(path => /^\/api\/conversations\/[^/]+/.test(path)), []);
  } finally {
    globalThis.fetch = counting;
    await app.close();
  }
});

test("a project's own mutation advances its revision, and its host's answer is per host, not per project", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    assert.equal((await catalogue(app.origin)).projectsRevision, 0);
    const first = await createProject(app.origin, "First", app.root);
    assert.equal((await catalogue(app.origin)).projectsRevision, 1);
    const secondFolder = join(app.base, "second");
    await mkdir(secondFolder);
    const added = await fetch(app.origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ hostId: "workstation", name: "Second", folders: [{ root: secondFolder, default: true }] }) });
    assert.equal(added.status, 201, await added.text());
    assert.equal((await catalogue(app.origin)).projectsRevision, 2);

    const thirdFolder = join(app.base, "third");
    await mkdir(thirdFolder);
    const withTwo = await fetch(app.origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ hostId: "workstation", name: "Third", folders: [{ root: thirdFolder, default: true }] }) });
    assert.equal(withTwo.status, 201);
    const third = (await withTwo.json() as { project: ProjectBody }).project;
    assert.equal((await catalogue(app.origin)).projectsRevision, 3);

    // The project listing resolves the host's account once per project of the named host, and a project of another
    // host is reported as belonging to that host rather than shown this origin's account.
    const listed = await projects(app.origin, "workstation");
    assert.equal(listed.length, 3);
    assert.ok(listed.every(entry => entry.host?.user === "operator"));
    const elsewhere = await projects(app.origin, "another-host");
    assert.equal(elsewhere.length, 3);
    assert.ok(elsewhere.every(entry => typeof entry.hostError === "string"));

    // A removal is metadata only: the project goes, its revision advances, and the conversation already bound to its
    // folder keeps its workspace, its host, its root and the retained marker.
    const bound = await createConversation(app.origin, first.folders[0]!.workspaceId);
    const removed = await fetch(app.origin + "/api/projects/" + encodeURIComponent(first.id) + "?hostId=workstation", { method: "DELETE", headers });
    assert.equal(removed.status, 200, await removed.text());
    const afterRemoval = await catalogue(app.origin);
    assert.equal(afterRemoval.projectsRevision, 4);
    const retainedRow = rowOf(afterRemoval, bound);
    assert.equal(retainedRow.workspaceId, first.folders[0]!.workspaceId);
    assert.equal(retainedRow.gatewayId, "workstation");
    // The removed folder is no longer a Project's, so it is no group: it keeps its own recorded root and says it was
    // retained, which is what keeps it openable while no picker offers it.
    assert.deepEqual(retainedRow.workspace, { gatewayId: "workstation", root: app.root, retained: true });
    assert.equal((await projects(app.origin)).length, 2);
    assert.equal(third.defaultFolderId, third.folders[0]!.id);
  } finally {
    await app.close();
  }
});

test("a created checkout is a conversation target, and a removed one keeps its binding for the conversation already there", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "Checkouts", app.root);
    const main = project.folders[0]!;
    const created = await fetch(app.origin + "/api/worktrees", { method: "POST", headers, body: JSON.stringify({ workspaceId: main.workspaceId, operation: "create", branch: "feature/two" }) });
    const createdBody = await created.json() as { ok?: boolean; value?: { path: string; branch: string; workspaceId: string }; error?: string };
    assert.equal(created.status, 200, JSON.stringify(createdBody));
    const checkout = createdBody.value!;

    // The new checkout is a folder of the project, so a conversation created in it runs its tools there.
    const conversationId = await createConversation(app.origin, checkout.workspaceId);
    app.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("checkout turn done"),
    ]);
    const turn = await runTurn(app.origin, conversationId, "where am I", "checkout-turn-1", "checkout turn done");
    assert.equal(turn.workspaceId, checkout.workspaceId);
    assert.ok(toolResults(turn).some(entry => entry.text.includes(checkout.path)), JSON.stringify(toolResults(turn).map(entry => entry.text)));

    // The catalogue states the checkout's own folder and the project's group, whose display root is still the default.
    // (The row carries the conversation's own id, not the one the create route answered with, so the two are compared.)
    const listed = (await catalogue(app.origin)).conversations;
    const row = listed.find(candidate => candidate.workspaceId === checkout.workspaceId)!;
    assert.ok(row !== undefined, "no catalogue row names the created checkout: " + JSON.stringify(listed.map(candidate => candidate.workspaceId)));
    const checkoutConversationId = row.id;
    assert.equal(row.workspace?.project?.id, project.id);
    assert.equal(row.workspace?.project?.displayRoot, app.root);
    assert.equal(row.workspace?.root, checkout.path);
    assert.equal(row.workspace?.retained, undefined);

    // Removing the checkout keeps the conversation's binding: same workspace, same host, same root, retained.
    // The checkout holds the work the conversation just did, so git refuses the removal without `force` — which is the
    // host's own rule, not a limit of the removal.
    const removed = await fetch(app.origin + "/api/worktrees", { method: "POST", headers, body: JSON.stringify({ workspaceId: main.workspaceId, operation: "remove", path: checkout.path, force: true }) });
    assert.equal(removed.status, 200, await removed.text());
    const afterRemoval = rowOf(await catalogue(app.origin), checkoutConversationId);
    assert.equal(afterRemoval.workspaceId, checkout.workspaceId);
    assert.equal(afterRemoval.gatewayId, "workstation");
    assert.deepEqual(afterRemoval.workspace, { gatewayId: "workstation", root: checkout.path, retained: true });
  } finally {
    await app.close();
  }
});

test("the list version describes the whole catalogue, not one page of it", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "Paged", app.root);
    const folder = project.folders[0]!;
    for (const workspaceId of [folder.workspaceId, "legacy", undefined]) await createConversation(app.origin, workspaceId);
    const whole = await catalogue(app.origin);
    assert.equal(whole.conversations.length, 3);
    // A page is a window onto the list, so its version is the list's version: a client that pages must not read a
    // changed number as "the list changed" and re-read what it already holds.
    const firstPage = await catalogue(app.origin, "?limit=2");
    assert.equal(firstPage.conversations.length, 2);
    assert.equal(firstPage.sessionListVersion, whole.sessionListVersion);
    assert.equal(typeof firstPage.nextCursor, "string");
    const secondPage = await catalogue(app.origin, "?limit=2&cursor=" + encodeURIComponent(firstPage.nextCursor!));
    assert.equal(secondPage.conversations.length, 1);
    assert.equal(secondPage.sessionListVersion, whole.sessionListVersion);
    assert.deepEqual([...firstPage.conversations, ...secondPage.conversations].map(row => row.id), whole.conversations.map(row => row.id));
    // A relation filter narrows the list, and the version describes the list that filter produced.
    const filtered = await catalogue(app.origin, "?workspaceId=legacy");
    assert.deepEqual(filtered.conversations.map(row => row.workspaceId), ["legacy"]);
    assert.notEqual(filtered.sessionListVersion, whole.sessionListVersion);
  } finally {
    await app.close();
  }
});
