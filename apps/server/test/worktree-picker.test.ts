import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { GatewayWorkbench } from "../../../packages/gateway/src/workbench/index.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { streamFolder } from "./stream-window.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";
import { createFakeGitHost, type FakeGitHost } from "./fake-git-host.ts";

const TOKEN = "worktree-picker-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Entry = { role: string; text: string; message: { isError?: boolean; toolName?: string } };
type Snapshot = { busy: boolean; workspaceId?: string; entries: Entry[] };

/**
 * One repository with one commit, on an in-memory host: the host answers the git argv `GatewayWorktrees` runs, so a
 * create, a removal and git's own refusals come from a model of the repository instead of from a git process. The
 * checkouts it makes are real directories, so a conversation created in one still runs its tools there.
 */
async function repository(base: string): Promise<{ root: string; branch: string; host: FakeGitHost }> {
  const root = join(base, "repo");
  await mkdir(root);
  const host = createFakeGitHost();
  host.initRepository(root, "main");
  await writeFile(join(root, "README.md"), "baseline\n");
  return { root, branch: "main", host };
}

/**
 * The three processes a deployment composes, at their public seams: a real local gateway serving one repository on an
 * in-memory git host, the durable backend over its own store, and the backend's own worktree route the Web adapter
 * calls. `serveWorktrees` composes a gateway without the capability, which is how a host that cannot serve worktrees is
 * reached. The only thing replaced is the git binary underneath the gateway's own worktree surface.
 */
async function fixture(options: { serveWorktrees?: boolean; workspaceResources?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "hepi-worktree-picker-"));
  const { root, branch, host } = await repository(base);
  const registry = new WorkspaceRegistry([{ id: "legacy", root: join(base, "legacy") }]);
  await mkdir(join(base, "legacy"));
  const identity = { user: "operator", home: join(base, "home") };
  await mkdir(identity.home);
  const gateway = new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] });
  const server = new GatewayRpcServer({
    gateway,
    workbench: new GatewayWorkbench(registry),
    files: new LocalFilesystem(registry, { identity }),
    workspaces: new WorkspaceServer(registry, { identity }),
    worktrees: options.serveWorktrees === false ? undefined : new GatewayWorktrees(registry, host.git),
  });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = server.server.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const gatewayOrigin = "http://127.0.0.1:" + gatewayAddress.port;

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store: ProjectStore = createProjectStore({ path: join(base, "projects.sqlite") });
  const backend: BackendServer = await createBackendServer({
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
    branch,
    faux,
    store,
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One worktree request through the backend's own route, which is the one the Web adapter calls. */
async function worktrees(origin: string, body: unknown, method = "POST"): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + "/api/worktrees", { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

type ListingValue = { isGit: boolean; isTopLevel: boolean; currentWorktreePath: string | null; worktrees: { path: string; branch: string | null; isMain: boolean; workspaceId?: string }[] };
type ProjectBody = { id: string; defaultFolderId: string; folders: { id: string; workspaceId: string; root: string; default: boolean }[] };

async function createProject(origin: string, name: string, root: string): Promise<ProjectBody> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ hostId: "workstation", name, folders: [{ root, default: true }] }) });
  const body = await response.json() as { project?: ProjectBody; error?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.project!;
}

const projects = async (origin: string): Promise<ProjectBody[]> => ((await (await fetch(origin + "/api/projects?hostId=workstation", { headers })).json()) as { projects: ProjectBody[] }).projects;

const workspaceIds = async (origin: string): Promise<{ id: string; retained?: boolean; workspaceRoot?: string }[]> => ((await (await fetch(origin + "/api/workspaces", { headers })).json()) as { workspaces: { id: string; retained?: boolean; workspaceRoot?: string }[] }).workspaces;

async function createConversation(origin: string, workspaceId: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId }) });
  const body = await response.json() as { conversationId?: string; error?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.conversationId!;
}

/** Submit one prompt and read the stream until the answer that ends the turn settles. */
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
    while (true) {
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
        // The stream states its window once and appends after it, so a frame is folded the way a client folds it
        // rather than every frame being read as a whole transcript.
        current = stream.fold(event, JSON.parse(line.slice(6)));
        if (!current.busy && current.entries.some(entry => entry.role === "assistant" && entry.text === expected)) return current;
      }
    }
  } finally { await reader.cancel(); }
}

test("the picker's list, create and remove are the host's own answers, and a created checkout is a target", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "App", app.root);
    const main = project.folders[0]!;
    // The list is the host's: the main checkout is marked, and it is addressed by the workspace the project records.
    const listed = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const value = listed.body.value as ListingValue;
    assert.equal(value.isGit, true);
    assert.equal(value.isTopLevel, true);
    assert.equal(value.currentWorktreePath, app.root);
    assert.deepEqual(value.worktrees, [{ path: app.root, branch: app.branch, isMain: true, workspaceId: main.workspaceId }]);

    // Creating one records it as a folder of the project, so the created checkout is a conversation target.
    const created = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "create", branch: "feature/one" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const made = created.body.value as { path: string; branch: string; workspaceId: string };
    assert.equal(made.branch, "feature/one");
    assert.equal(existsSync(made.path), true);
    assert.equal(made.path, app.root + "-worktrees/feature-one");
    const afterCreate = (await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" })).body.value as ListingValue;
    assert.deepEqual(afterCreate.worktrees.map(entry => [entry.path, entry.branch, entry.isMain, entry.workspaceId]), [
      [app.root, app.branch, true, main.workspaceId],
      [made.path, "feature/one", false, made.workspaceId],
    ]);
    const recorded = (await projects(app.origin))[0]!;
    assert.equal(recorded.folders.length, 2, "the created checkout is a folder of the project");
    assert.equal(recorded.folders.find(folder => folder.workspaceId === made.workspaceId)?.root, made.path);
    assert.equal(recorded.defaultFolderId, main.id, "the project's default is untouched");

    // A conversation created in the created checkout runs its tools there: the target is real, not a label.
    const conversation = await createConversation(app.origin, made.workspaceId);
    app.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("worktree turn done"),
    ]);
    const turn = await runTurn(app.origin, conversation, "where am I", "in-worktree", "worktree turn done");
    assert.equal(turn.workspaceId, made.workspaceId);
    assert.match(JSON.stringify(turn.entries), new RegExp(made.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // A bad create answers the backend's own reason and leaves the list exactly as it was.
    const before = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" });
    const refused = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "create", branch: "   " });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "invalid_request");
    assert.match(String(refused.body.error), /branch/);
    assert.deepEqual((await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" })).body, before.body);

    // A dirty checkout is refused under its own name, and force is a separate request that succeeds.
    await writeFile(join(made.path, "uncommitted.txt"), "work in progress\n");
    const dirty = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "remove", path: made.path });
    assert.equal(dirty.status, 409, JSON.stringify(dirty.body));
    assert.equal(dirty.body.code, "dirty");
    assert.equal(dirty.body.dirty, true);
    assert.equal(existsSync(join(made.path, "uncommitted.txt")), true, "a refused removal left the checkout alone");
    assert.equal((await projects(app.origin))[0]!.folders.length, 2, "and left the project's folders alone");

    const forced = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "remove", path: made.path, force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.deepEqual(forced.body.value, { removed: made.path });
    assert.equal(existsSync(made.path), false);
    const afterRemove = (await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" })).body.value as ListingValue;
    assert.deepEqual(afterRemove.worktrees.map(entry => entry.path), [app.root]);
    // The folder record goes with the checkout, and the binding is retained: a conversation already bound to that
    // checkout keeps running there while the checkout is no longer a target.
    const remaining = (await projects(app.origin))[0]!;
    assert.deepEqual(remaining.folders.map(folder => folder.workspaceId), [main.workspaceId]);
    assert.equal((await workspaceIds(app.origin)).find(workspace => workspace.id === made.workspaceId)?.retained, true);
    app.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf retained-marker" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("retained turn done"),
    ]);
    const kept = await runTurn(app.origin, conversation, "again", "after-removal", "retained turn done");
    assert.equal(kept.workspaceId, made.workspaceId);
    assert.match(JSON.stringify(kept.entries), /retained-marker/);
  } finally { await app.close(); }
});

test("a host that cannot serve worktrees answers its own named limit and the rest of the project keeps working", { timeout: 60000 }, async () => {
  const app = await fixture({ serveWorktrees: false });
  try {
    const project = await createProject(app.origin, "App", app.root);
    const main = project.folders[0]!;
    const listed = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "list" });
    assert.equal(listed.status, 501, JSON.stringify(listed.body));
    assert.equal(listed.body.code, "not_supported");
    assert.match(String(listed.body.error), /worktree/);
    const created = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "create", branch: "nope" });
    assert.equal(created.status, 501);
    assert.equal(created.body.code, "not_supported");
    assert.equal(existsSync(app.root + "-worktrees"), false, "a host limit wrote nothing");
    // The project itself is untouched: its folders still list, and its conversation still runs.
    assert.deepEqual((await projects(app.origin))[0]!.folders.map(folder => folder.workspaceId), [main.workspaceId]);
    const conversation = await createConversation(app.origin, main.workspaceId);
    app.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf still-here" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("project turn done"),
    ]);
    const turn = await runTurn(app.origin, conversation, "still there?", "host-limit", "project turn done");
    assert.match(JSON.stringify(turn.entries), /still-here/);
  } finally { await app.close(); }
});

test("a checkout whose directory is gone falls back to the project root instead of breaking the list", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "App", app.root);
    const main = project.folders[0]!;
    const created = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "create", branch: "gone" });
    const made = created.body.value as { path: string; workspaceId: string };
    // The checkout disappears without git being told (the user deleted the directory, or another tool did).
    await rm(made.path, { recursive: true, force: true });
    const listed = await worktrees(app.origin, { workspaceId: made.workspaceId, operation: "list" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const value = listed.body.value as ListingValue;
    assert.equal(value.isTopLevel, true);
    assert.deepEqual(value.worktrees.map(entry => entry.path), [app.root], "the vanished checkout is not listed");
    assert.equal(value.currentWorktreePath, null, "and nothing claims to be the current one");
  } finally { await app.close(); }
});

test("an unregistered workspace is refused before git is asked anything", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    // A configured workspace is served like a project folder: the route is the host's capability, not a project's.
    // Its own directory is no checkout, so the host answers upstream's empty listing rather than a failure.
    const configured = await worktrees(app.origin, { workspaceId: "legacy", operation: "list" });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal((configured.body.value as ListingValue).isGit, false);
    assert.deepEqual((configured.body.value as ListingValue).worktrees, []);
    const listed = await worktrees(app.origin, { workspaceId: "no-such-workspace", operation: "list" });
    assert.equal(listed.status, 404, JSON.stringify(listed.body));
    assert.equal(listed.body.code, "unknown_workspace");
    const created = await worktrees(app.origin, { workspaceId: "no-such-workspace", operation: "create", branch: "feat" });
    assert.equal(created.status, 404);
    assert.equal(existsSync(app.root + "-worktrees"), false);
    const unknown = await worktrees(app.origin, { workspaceId: (await createProject(app.origin, "App", app.root)).folders[0]!.workspaceId, operation: "prune" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "invalid_request");
  } finally { await app.close(); }
});

test("a checkout that is the project's default or its only folder is refused before git removes it", { timeout: 60000 }, async () => {
  const app = await fixture();
  try {
    const project = await createProject(app.origin, "App", app.root);
    const main = project.folders[0]!;
    const only = await worktrees(app.origin, { workspaceId: main.workspaceId, operation: "remove", path: app.root });
    assert.equal(only.status, 409, JSON.stringify(only.body));
    assert.equal(only.body.code, "default_folder");
    assert.equal(existsSync(app.root), true, "the repository is untouched");
    assert.deepEqual((await projects(app.origin))[0]!.folders.map(folder => folder.workspaceId), [main.workspaceId]);
  } finally { await app.close(); }
});
