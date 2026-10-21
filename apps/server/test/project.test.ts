import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { GatewayWorkbench } from "../../../packages/gateway/src/workbench/index.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { streamFolder } from "./stream-window.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";

type Entry = { role: string; text: string; message: { isError?: boolean; toolName?: string } };
type Snapshot = { busy: boolean; workspaceId?: string; entries: Entry[] };

const TOKEN = "server-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

/**
 * A real local gateway whose execution, files, workbench and workspace surfaces share one registry. `port` keeps a
 * restarted gateway on the address the backend already has, which is the case a gateway restart alone creates.
 */
async function startGateway(options: { id: string; legacyRoot: string; home: string; user?: string; port?: number }) {
  const token = "gateway-token-" + options.id;
  const registry = new WorkspaceRegistry([{ id: "legacy", root: options.legacyRoot }]);
  const gateway = new LocalGateway({ id: options.id, token, workspaces: registry, allowedCommands: ["bash"] });
  const identity = { user: options.user ?? "operator", home: options.home };
  // Both surfaces of one host answer for the same account: the filesystem resolves the execution host, and the
  // workspace surface browses that host's directories.
  const server = new GatewayRpcServer(gateway, new GatewayWorkbench(registry), new LocalFilesystem(registry, { identity }), undefined, new WorkspaceServer(registry, { identity }));
  await new Promise<void>(resolve => server.server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return {
    id: options.id,
    token,
    registry,
    identity,
    origin: "http://127.0.0.1:" + address.port,
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

type GatewayFixture = Awaited<ReturnType<typeof startGateway>>;

type BackendFixture = { backend: BackendServer; origin: string; store: ProjectStore; faux: ReturnType<typeof fauxProvider>; close(): Promise<void> };

/**
 * One backend, the gateway connections the deployment configured, and the workspace binding its own default workspace
 * uses. A Web origin is not configured here: it names the gateway it serves on every host-scoped request.
 */
async function startBackend(options: { dbPath: string; projectsPath: string; gateways?: readonly GatewayFixture[]; workspaceGatewayId?: string; bindLegacy?: boolean }): Promise<BackendFixture> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = createProjectStore({ path: options.projectsPath });
  const gateways = (options.gateways ?? []).map(fixture => ({ gatewayId: fixture.id, gatewayOrigin: fixture.origin, gatewayToken: fixture.token }));
  const workspaceGateway = options.workspaceGatewayId ?? gateways[0]?.gatewayId;
  const backend = await createBackendServer({
    dbPath: options.dbPath,
    authToken: TOKEN,
    models,
    ...(workspaceGateway === undefined || options.bindLegacy === false ? {} : { workspaces: [{ id: "legacy", gatewayId: workspaceGateway, gatewayOrigin: gateways.find(item => item.gatewayId === workspaceGateway)!.gatewayOrigin, gatewayToken: gateways.find(item => item.gatewayId === workspaceGateway)!.gatewayToken }] }),
    gateways,
    projects: store,
    defaultModel: SERVER_MODEL,
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address && typeof address === "object");
  return {
    backend,
    store,
    faux,
    origin: "http://127.0.0.1:" + address.port,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); store.close(); },
  };
}

/**
 * Submit one prompt and read the conversation's event stream until the answer that ends the turn settles. The
 * expected answer names the turn, because a conversation that already has a settled turn would otherwise look
 * settled the moment its stream opens.
 */
async function runTurn(origin: string, conversationId: string, text: string, requestId: string, expected: string): Promise<Snapshot> {
  const path = origin + "/api/conversations/" + conversationId;
  const reader = (await fetch(path + "/events", { headers, signal: AbortSignal.timeout(10000) })).body!.getReader();
  try {
    const submitted = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    assert.equal(submitted.status, 202);
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

async function createConversation(origin: string, workspaceId?: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
}

/** The directories the Web origin named for itself sees; no host id is the request a Web origin with no mapping makes. */
async function browse(origin: string, hostId: string | undefined, path?: string): Promise<{ status: number; body: { code?: string; path?: string; host?: { user: string; home: string }; directories?: { name: string; path: string }[] } }> {
  const query = new URLSearchParams();
  if (path !== undefined) query.set("path", path);
  if (hostId !== undefined) query.set("hostId", hostId);
  const response = await fetch(origin + "/api/host/directories" + (query.size === 0 ? "" : "?" + query.toString()), { headers });
  return { status: response.status, body: await response.json() as never };
}

type ProjectFolderBody = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectBody = { id: string; name: string; hostId: string; defaultFolderId: string; folders: ProjectFolderBody[]; host?: { user: string; home: string }; hostError?: string };

/** Create a project with one folder, the shape most tests use. */
async function createProject(origin: string, name: string, root: string, hostId?: string): Promise<{ status: number; body: { project?: ProjectBody; code?: string; error?: string } }> {
  return await createProjectFolders(origin, name, [{ root, default: true }], hostId);
}

async function createProjectFolders(origin: string, name: string, folders: { root: string; default?: boolean }[], hostId?: string): Promise<{ status: number; body: { project?: ProjectBody; code?: string; error?: string } }> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ name, folders, ...(hostId === undefined ? {} : { hostId }) }) });
  return { status: response.status, body: await response.json() as never };
}

/** Name another of a project's own folders the default: the metadata contract ticket 08 defines, with no UI calling it. */
async function setDefaultFolder(origin: string, projectId: string, defaultFolderId: string, hostId?: string): Promise<{ status: number; body: { project?: ProjectBody; code?: string } }> {
  const response = await fetch(origin + "/api/projects/" + encodeURIComponent(projectId), { method: "PATCH", headers, body: JSON.stringify({ defaultFolderId, ...(hostId === undefined ? {} : { hostId }) }) });
  return { status: response.status, body: await response.json() as never };
}

/** Remove one project: metadata only, so a refusal keeps the backend's own code and nothing is unrecorded. */
async function removeProject(origin: string, projectId: string, hostId?: string): Promise<{ status: number; body: { project?: ProjectBody; code?: string; error?: string } }> {
  const response = await fetch(origin + "/api/projects/" + encodeURIComponent(projectId) + (hostId === undefined ? "" : "?hostId=" + encodeURIComponent(hostId)), { method: "DELETE", headers });
  return { status: response.status, body: await response.json() as never };
}

/** Unlink one folder from a project: the folder's own operation, with the replacement named when its default goes. */
async function unlinkFolder(origin: string, projectId: string, folderId: string, hostId?: string, replacementDefaultId?: string): Promise<{ status: number; body: { project?: ProjectBody | null; removedFolderId?: string; code?: string; error?: string } }> {
  const query = new URLSearchParams();
  if (hostId !== undefined) query.set("hostId", hostId);
  if (replacementDefaultId !== undefined) query.set("defaultFolderId", replacementDefaultId);
  const response = await fetch(origin + "/api/projects/" + encodeURIComponent(projectId) + "/folders/" + encodeURIComponent(folderId) + (query.size === 0 ? "" : "?" + query.toString()), { method: "DELETE", headers });
  return { status: response.status, body: await response.json() as never };
}

/** The workspaces the backend lists for binding, with the marker a removal leaves on a retained one. */
async function listWorkspaces(origin: string): Promise<{ status: number; body: { workspaces: { id: string; gatewayId: string; retained?: boolean; workspaceRoot?: string }[] } }> {
  const response = await fetch(origin + "/api/workspaces", { headers });
  return { status: response.status, body: await response.json() as never };
}

async function listProjects(origin: string, hostId?: string): Promise<{ status: number; body: { projects: ProjectBody[] } }> {
  const response = await fetch(origin + "/api/projects" + (hostId === undefined ? "" : "?hostId=" + encodeURIComponent(hostId)), { headers });
  return { status: response.status, body: await response.json() as never };
}

/** The folder a new conversation of that project binds, or the folder at one root. */
const defaultFolderOf = (project: ProjectBody): ProjectFolderBody => project.folders.find(folder => folder.id === project.defaultFolderId)!;
const folderAt = (project: ProjectBody, root: string): ProjectFolderBody => project.folders.find(folder => folder.root === root)!;

const toolResults = (snapshot: Snapshot): Entry[] => snapshot.entries.filter(entry => entry.role === "toolResult");

test("a project created on the Web host binds one folder and its conversations execute there", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the chosen folder");
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  const { origin } = fixture;
  try {
    // The Web host's own directories, listed by the gateway that Web origin named for itself.
    const listing = await browse(origin, "workstation", base);
    assert.equal(listing.status, 200);
    assert.equal(listing.body.path, base);
    assert.deepEqual(listing.body.host, { user: "operator", home: base });
    assert.deepEqual(listing.body.directories!.map(entry => entry.name), ["chosen", "legacy"]);

    // A project records identity, display name and the chosen folder — and creates no directory.
    const created = await createProject(origin, "Chosen Project", chosenRoot, "workstation");
    assert.equal(created.status, 201);
    const project = created.body.project!;
    assert.equal(project.name, "Chosen Project");
    assert.equal(project.hostId, "workstation");
    assert.equal(project.folders.length, 1);
    const chosen = defaultFolderOf(project);
    assert.equal(chosen.root, chosenRoot);
    assert.equal(chosen.cwd, "/workspace/" + chosen.workspaceId);
    assert.equal(chosen.default, true);
    // The workspace id is opaque: neither the path nor the project's display identity.
    assert.notEqual(chosen.workspaceId, chosenRoot);
    assert.notEqual(chosen.workspaceId, project.id);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", chosen.workspaceId].sort());

    const listed = await listProjects(origin, "workstation");
    assert.deepEqual(listed.body.projects.map(item => item.id), [project.id]);
    assert.deepEqual(listed.body.projects[0]?.host, { user: "operator", home: base });

    // A conversation on that project runs its tools in the chosen folder: bash writes and reports where it ran, and
    // read returns a file that exists only there.
    const conversationId = await createConversation(origin, chosen.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf project-marker > marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("project turn done"),
    ]);
    const turn = await runTurn(origin, conversationId, "work in the project", "project-turn-1", "project turn done");
    assert.equal(turn.workspaceId, chosen.workspaceId);
    const results = toolResults(turn);
    assert.equal(results.length, 3);
    assert.ok(results.every(entry => entry.message.isError !== true), JSON.stringify(results.map(entry => entry.text)));
    assert.equal(results[1]!.text.trim(), chosenRoot);
    assert.equal(results[2]!.text, "note in the chosen folder");
    assert.equal(await readFile(join(chosenRoot, "marker.txt"), "utf8"), "project-marker");
    assert.equal(existsSync(join(legacyRoot, "marker.txt")), false);

    // An existing workspace keeps its own root, and a conversation bound to it keeps its binding: creating a project
    // never retargets another conversation.
    const legacyConversation = await createConversation(origin, "legacy");
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("legacy turn done"),
    ]);
    const legacyTurn = await runTurn(origin, legacyConversation, "work in the legacy workspace", "legacy-turn-1", "legacy turn done");
    assert.equal(legacyTurn.workspaceId, "legacy");
    const legacyResults = toolResults(legacyTurn);
    assert.equal(legacyResults[0]!.text.trim(), legacyRoot);
    assert.equal(legacyResults[1]!.message.isError, true);
    const state = await (await fetch(origin + "/api/conversations/" + conversationId + "/state", { headers })).json() as Snapshot;
    assert.equal(state.workspaceId, chosen.workspaceId);

    // A folder that does not exist is refused, and nothing is created or recorded.
    const missing = join(base, "not-there");
    const refused = await createProject(origin, "Missing", missing, "workstation");
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_root");
    assert.equal(existsSync(missing), false);
    assert.equal((await listProjects(origin, "workstation")).body.projects.length, 1);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a restarted backend recovers its projects and a restarted gateway is re-registered", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-restart-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  const dbPath = join(base, "conversations.sqlite");
  const projectsPath = join(base, "projects.sqlite");
  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  let fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
  try {
    const project = (await createProject(fixture.origin, "Recovered", chosenRoot, "workstation")).body.project!;
    const recoveredFolder = defaultFolderOf(project);
    const conversationId = await createConversation(fixture.origin, recoveredFolder.workspaceId);
    await fixture.close();

    // The gateway restarted too, so it serves nothing but the workspace its own environment seeded: the backend's
    // replay of its recorded projects is what makes the folder available again.
    await gateway.close();
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
    assert.deepEqual(gateway.registry.ids(), ["legacy"]);

    fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
    const listed = await listProjects(fixture.origin, "workstation");
    assert.equal(listed.body.projects.length, 1);
    assert.equal(listed.body.projects[0]!.name, "Recovered");
    assert.equal(listed.body.projects[0]!.defaultFolderId, project.defaultFolderId);
    assert.equal(defaultFolderOf(listed.body.projects[0]!).workspaceId, recoveredFolder.workspaceId);
    assert.equal(folderAt(listed.body.projects[0]!, chosenRoot).root, chosenRoot);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", recoveredFolder.workspaceId].sort());

    // The conversation recorded before the restart keeps its binding and executes in the same folder.
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("after restart"),
    ]);
    const turn = await runTurn(fixture.origin, conversationId, "still there?", "restart-turn-1", "after restart");
    assert.equal(turn.workspaceId, recoveredFolder.workspaceId);
    assert.equal(toolResults(turn)[0]!.text.trim(), chosenRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a conversation already bound to a project keeps executing after the gateway alone restarts", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-gateway-restart-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the chosen folder");
  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  try {
    const project = (await createProject(fixture.origin, "Restarted Host", chosenRoot, "workstation")).body.project!;
    const boundFolder = defaultFolderOf(project);
    const conversationId = await createConversation(fixture.origin, boundFolder.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf project-marker > marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("first turn done"),
    ]);
    const first = await runTurn(fixture.origin, conversationId, "write the marker", "gateway-restart-1", "first turn done");
    assert.ok(toolResults(first)[0]!.message.isError !== true, toolResults(first)[0]!.text);
    assert.equal(await readFile(join(chosenRoot, "marker.txt"), "utf8"), "project-marker");

    // Only the gateway restarts, on the address the backend already has. The backend keeps running and the
    // conversation stays bound to the same workspace id, so nothing here creates a conversation: the next request of
    // that conversation is what has to restore the root.
    const origin = gateway.origin;
    const port = Number(new URL(origin).port);
    await gateway.close();
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base, port });
    assert.equal(gateway.origin, origin);
    assert.deepEqual(gateway.registry.ids(), ["legacy"]);

    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("second turn done"),
    ]);
    const second = await runTurn(fixture.origin, conversationId, "read the marker", "gateway-restart-2", "second turn done");
    assert.equal(second.workspaceId, boundFolder.workspaceId);
    // The transcript keeps the first turn, so the two answers of the second turn are its last two tool results.
    const results = toolResults(second).slice(-2);
    assert.equal(results.length, 2, JSON.stringify(second.entries.map(entry => [entry.role, entry.text.slice(0, 200)])));
    assert.ok(results.every(entry => entry.message.isError !== true), JSON.stringify(results.map(entry => entry.text)));
    assert.equal(results[0]!.text, "project-marker");
    assert.equal(results[1]!.text.trim(), chosenRoot);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", boundFolder.workspaceId].sort());
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * A deployment with no configured workspace is an ordinary zero-config start: the runtime file resolves no binding and
 * nothing executes. That must not be decided once at boot. A project registered afterwards is an ordinary target, and
 * the tools it needs have to be there for its conversation in the same process — the boot-time emptiness of the
 * workspace list cannot stand in for it. The environment factory is therefore always installed, and it is the live
 * binding lookup that answers, so this proves the registered tools and the env they ran with by reading a marker only
 * the chosen folder holds, through the real gateway.
 */
test("a project created on a zero-config deployment executes its tools without a restart", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-late-env-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "late-marker.txt"), "written by the chosen folder");
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  // No configured workspace at all: the deployment starts with nothing bound, exactly as a zero-config start does.
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway], bindLegacy: false });
  const { origin } = fixture;
  try {
    const project = (await createProject(origin, "Late", chosenRoot, "workstation")).body.project!;
    const folder = defaultFolderOf(project);
    assert.ok(gateway.registry.ids().includes(folder.workspaceId), "the gateway registered the folder the project chose");

    const conversationId = await createConversation(origin, folder.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "late-marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("late env turn done"),
    ]);
    const turn = await runTurn(origin, conversationId, "read the marker", "late-env-1", "late env turn done");
    assert.equal(turn.workspaceId, folder.workspaceId);
    // The tool really ran, in the project's folder, over the real gateway: the read marker is the evidence, not a
    // fabricated environment object.
    const results = toolResults(turn);
    assert.equal(results.length, 1);
    assert.ok(results[0]!.message.isError !== true, results[0]!.text);
    assert.equal(results[0]!.text, "written by the chosen folder");

    // The factory answers for one request, so a conversation bound to no workspace still resolves nothing: it reaches
    // no host and cannot be redirected to the project that does have one.
    const unbound = await createConversation(origin);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf redirected > unbound.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("unbound turn done"),
    ]);
    const unboundTurn = await runTurn(origin, unbound, "run in no workspace", "late-env-unbound", "unbound turn done");
    const unboundResults = toolResults(unboundTurn);
    assert.equal(unboundResults.length, 1);
    assert.equal(unboundResults[0]!.message.isError, true, unboundResults[0]!.text);
    assert.equal(existsSync(join(chosenRoot, "unbound.txt")), false);
    assert.equal(existsSync(join(legacyRoot, "unbound.txt")), false);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("an unreachable Web host is reported on its own project and does not brick the backend", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-offline-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  try {
    const project = (await createProject(fixture.origin, "Offline", chosenRoot, "workstation")).body.project!;
    await gateway.close();

    const listed = await listProjects(fixture.origin, "workstation");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.projects.length, 1);
    assert.equal(defaultFolderOf(listed.body.projects[0]!).workspaceId, defaultFolderOf(project).workspaceId);
    assert.equal(defaultFolderOf(listed.body.projects[0]!).root, chosenRoot);
    assert.equal(listed.body.projects[0]!.host, undefined);
    assert.ok((listed.body.projects[0]!.hostError ?? "").length > 0);

    // The rest of the backend keeps working: a conversation without a workspace is unaffected, and a new project
    // reports the offline host instead of being recorded.
    const created = await createConversation(fixture.origin);
    fixture.faux.setResponses([fauxAssistantMessage("no workspace needed")]);
    const turn = await runTurn(fixture.origin, created, "hello", "offline-turn-1", "no workspace needed");
    assert.equal(turn.entries.at(-1)!.text, "no workspace needed");

    const refused = await createProject(fixture.origin, "Second", chosenRoot, "workstation");
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "gateway_offline");
    assert.equal((await browse(fixture.origin, "workstation")).status, 503);
    assert.equal((await listProjects(fixture.origin, "workstation")).body.projects.length, 1);
  } finally {
    await fixture.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a Web origin with no host mapping, or one this deployment does not have, is a configuration error", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-unconfigured-")));
  const legacyRoot = join(base, "legacy");
  await mkdir(legacyRoot);
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  try {
    // A Web origin that sends no host id at all is the same refusal as one naming a gateway this deployment does not
    // configure: neither can be turned into a guessed host, and the backend's own account is never substituted.
    for (const hostId of [undefined, "", "somewhere-else"]) {
      const browseResult = await browse(fixture.origin, hostId);
      assert.equal(browseResult.status, 409, JSON.stringify(hostId));
      assert.equal(browseResult.body.code, "configuration_required");
      const created = await createProject(fixture.origin, "Nope", base, hostId);
      assert.equal(created.status, 409);
      assert.equal(created.body.code, "configuration_required");
    }
    assert.equal((await listProjects(fixture.origin, "workstation")).body.projects.length, 0);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("two Web origins on one backend each use only the local gateway they named", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-two-origins-")));
  const legacyRoot = join(base, "legacy");
  const firstRoot = join(base, "first-host-folder");
  const secondRoot = join(base, "second-host-folder");
  const firstHome = join(base, "first-home");
  const secondHome = join(base, "second-home");
  await mkdir(legacyRoot);
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await mkdir(firstHome);
  await mkdir(secondHome);
  await writeFile(join(secondRoot, "note.txt"), "note on the second host");
  const first = await startGateway({ id: "web-one", legacyRoot, home: firstHome, user: "alice" });
  const second = await startGateway({ id: "web-two", legacyRoot, home: secondHome, user: "bob" });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [first, second], workspaceGatewayId: "web-one" });
  try {
    // Each Web origin browses its own host: the account that lists the directories is that host's, and neither is the
    // backend's own account nor the other Web origin's host.
    const fromFirst = await browse(fixture.origin, "web-one");
    assert.equal(fromFirst.status, 200);
    assert.deepEqual(fromFirst.body.host, { user: "alice", home: firstHome });
    const fromSecond = await browse(fixture.origin, "web-two");
    assert.equal(fromSecond.status, 200);
    assert.deepEqual(fromSecond.body.host, { user: "bob", home: secondHome });

    // A project is created on the host its Web origin named, and only that gateway receives the registration.
    const created = await createProject(fixture.origin, "Second Host Project", secondRoot, "web-two");
    assert.equal(created.status, 201);
    const project = created.body.project!;
    assert.equal(project.hostId, "web-two");
    assert.deepEqual(second.registry.ids().includes(defaultFolderOf(project).workspaceId), true);
    assert.deepEqual(first.registry.ids(), ["legacy"]);

    // Both origins see the project's metadata, but only the origin serving that host sees its account.
    const secondView = await listProjects(fixture.origin, "web-two");
    assert.deepEqual(secondView.body.projects[0]?.host, { user: "bob", home: secondHome });
    const firstView = await listProjects(fixture.origin, "web-one");
    assert.equal(firstView.body.projects.length, 1);
    assert.equal(firstView.body.projects[0]!.hostId, "web-two");
    assert.equal(firstView.body.projects[0]!.host, undefined);
    assert.ok((firstView.body.projects[0]!.hostError ?? "").includes("web-two"));

    // Its conversation runs its tools on the second host, in the folder chosen there.
    const conversationId = await createConversation(fixture.origin, defaultFolderOf(project).workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("second host turn done"),
    ]);
    const turn = await runTurn(fixture.origin, conversationId, "work there", "two-origins-1", "second host turn done");
    const results = toolResults(turn);
    assert.equal(results[0]!.text.trim(), secondRoot);
    assert.equal(results[1]!.text, "note on the second host");
    assert.equal(existsSync(join(firstRoot, "note.txt")), false);
  } finally {
    await fixture.close();
    await first.close();
    await second.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a project holds several folders of one computer and exactly one default", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-folders-")));
  const legacyRoot = join(base, "legacy");
  const firstRoot = join(base, "alpha");
  const secondRoot = join(base, "beta");
  await mkdir(legacyRoot);
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(join(firstRoot, "first.txt"), "in alpha");
  await writeFile(join(secondRoot, "second.txt"), "in beta");
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  const { origin } = fixture;
  try {
    // Two existing folders of this one computer, the second named the default. Nothing is created on disk.
    const created = await createProjectFolders(origin, "Two Folders", [{ root: firstRoot }, { root: secondRoot, default: true }], "workstation");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project!;
    assert.equal(project.folders.length, 2);
    assert.equal(defaultFolderOf(project).root, secondRoot);
    assert.equal(folderAt(project, firstRoot).default, false);
    // Each folder carries its own opaque workspace id, and both are registered on the one host.
    const first = folderAt(project, firstRoot);
    const second = folderAt(project, secondRoot);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", first.workspaceId, second.workspaceId].sort());

    // A new conversation binds the default folder only: its tools run there, and the other folder stays metadata —
    // not a tool root, and not injected anywhere. A read of the extra folder's own file is an ordinary refusal.
    const conversationId = await createConversation(origin, second.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "first.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("default folder turn done"),
    ]);
    const turn = await runTurn(origin, conversationId, "work in the default folder", "folders-turn-1", "default folder turn done");
    assert.equal(turn.workspaceId, second.workspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text.trim(), secondRoot);
    assert.equal(results[1]!.message.isError, true, "the extra folder is not a tool root");
    assert.equal(existsSync(join(firstRoot, "marker.txt")), false);

    // A conversation bound to the extra folder keeps running there: a folder's binding is its own, whatever the
    // project's default is.
    const firstConversation = await createConversation(origin, first.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf alpha-marker > marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("first folder turn done"),
    ]);
    const firstTurn = await runTurn(origin, firstConversation, "work in the extra folder", "folders-turn-2", "first folder turn done");
    assert.equal(firstTurn.workspaceId, first.workspaceId);
    assert.equal(toolResults(firstTurn)[1]!.text.trim(), firstRoot);
    assert.equal(await readFile(join(firstRoot, "marker.txt"), "utf8"), "alpha-marker");

    // Naming the other folder the default is metadata: new conversations bind it from then on, and the conversation
    // already bound to it is untouched. This is the ticket's contract, with no default-editing UI.
    const changed = await setDefaultFolder(origin, project.id, first.id, "workstation");
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.project!.defaultFolderId, first.id);
    assert.equal(folderAt(changed.body.project!, firstRoot).default, true);

    const afterChange = (await listProjects(origin, "workstation")).body.projects[0]!;
    assert.equal(afterChange.defaultFolderId, first.id);
    const newConversation = await createConversation(origin, defaultFolderOf(afterChange).workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("new default turn done"),
    ]);
    const newTurn = await runTurn(origin, newConversation, "work in the new default", "folders-turn-3", "new default turn done");
    assert.equal(newTurn.workspaceId, first.workspaceId);
    assert.equal(toolResults(newTurn).at(-1)!.text.trim(), firstRoot);

    // The conversation bound to the OLD default still runs in its own folder after the change.
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "second.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("old default turn done"),
    ]);
    const oldTurn = await runTurn(origin, conversationId, "still my own folder?", "folders-turn-4", "old default turn done");
    assert.equal(oldTurn.workspaceId, second.workspaceId, "an existing conversation never changes its binding");
    const oldResults = toolResults(oldTurn).slice(-2);
    assert.equal(oldResults[0]!.text, "in beta");
    assert.equal(oldResults[1]!.text.trim(), secondRoot);

    // Refusals: no default, two defaults, the same folder twice, and a folder that does not exist. Nothing is recorded.
    const noDefault = await createProjectFolders(origin, "No Default", [{ root: firstRoot }], "workstation");
    assert.equal(noDefault.status, 400);
    assert.equal(noDefault.body.code, "invalid_request");
    const twoDefaults = await createProjectFolders(origin, "Two Defaults", [{ root: firstRoot, default: true }, { root: secondRoot, default: true }], "workstation");
    assert.equal(twoDefaults.status, 400);
    const twice = await createProjectFolders(origin, "Twice", [{ root: firstRoot, default: true }, { root: firstRoot }], "workstation");
    assert.equal(twice.status, 400);
    const missingRoot = await createProjectFolders(origin, "Missing", [{ root: join(base, "not-there"), default: true }], "workstation");
    assert.equal(missingRoot.status, 400);
    assert.equal(missingRoot.body.code, "invalid_root");
    assert.equal(existsSync(join(base, "not-there")), false);
    // A folder of another project, or one that does not belong to this project, cannot become its default.
    const foreign = await setDefaultFolder(origin, project.id, "not-a-folder-of-this-project", "workstation");
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.code, "unknown_folder");
    const unknownProject = await setDefaultFolder(origin, "no-such-project", first.id, "workstation");
    assert.equal(unknownProject.status, 404);
    assert.equal((await listProjects(origin, "workstation")).body.projects.length, 1);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("every folder of a project stays resolvable across a backend and gateway restart", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-folders-restart-")));
  const legacyRoot = join(base, "legacy");
  const firstRoot = join(base, "alpha");
  const secondRoot = join(base, "beta");
  await mkdir(legacyRoot);
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(join(firstRoot, "first.txt"), "in alpha");
  const dbPath = join(base, "conversations.sqlite");
  const projectsPath = join(base, "projects.sqlite");
  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  let fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
  try {
    const project = (await createProjectFolders(fixture.origin, "Both Folders", [{ root: firstRoot, default: true }, { root: secondRoot }], "workstation")).body.project!;
    const first = folderAt(project, firstRoot);
    const second = folderAt(project, secondRoot);
    const boundToExtra = await createConversation(fixture.origin, second.workspaceId);
    await fixture.close();
    await gateway.close();
    // The restarted gateway serves nothing but its own seeded workspace: the replay of every recorded folder is what
    // has to put both of them back, not only the project's default.
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
    assert.deepEqual(gateway.registry.ids(), ["legacy"]);
    fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
    const restarted = (await listProjects(fixture.origin, "workstation")).body.projects[0]!;
    assert.equal(restarted.folders.length, 2);
    assert.equal(defaultFolderOf(restarted).root, firstRoot);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", first.workspaceId, second.workspaceId].sort());

    // The conversation bound to the project's *non-default* folder still executes there after the restart.
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("extra folder after restart"),
    ]);
    const turn = await runTurn(fixture.origin, boundToExtra, "still there?", "folders-restart-1", "extra folder after restart");
    assert.equal(turn.workspaceId, second.workspaceId);
    assert.equal(toolResults(turn)[0]!.text.trim(), secondRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a single-folder project database migrates in place and keeps its folder binding", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-migration-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the migrated folder");
  const dbPath = join(base, "conversations.sqlite");
  const projectsPath = join(base, "projects.sqlite");
  const legacyWorkspaceId = "legacy-single-folder-workspace";
  // The released single-folder schema and a row, exactly as the version that wrote them: one root and one workspace id
  // per project, with UNIQUE on the workspace id. Writing the fixture is setup, never the assertion.
  const legacy = new DatabaseSync(projectsPath);
  legacy.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT NOT NULL, workspace_id TEXT NOT NULL UNIQUE, root TEXT NOT NULL, created_at TEXT NOT NULL)");
  legacy.prepare("INSERT INTO projects (id, name, host_id, workspace_id, root, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("legacy-project", "Legacy Project", "workstation", legacyWorkspaceId, chosenRoot, "2026-01-01T00:00:00.000Z");
  legacy.close();

  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  let fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
  try {
    // Read through the public metadata API: the project, its folder, and the workspace id it already had.
    const listed = (await listProjects(fixture.origin, "workstation")).body.projects;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "legacy-project");
    assert.equal(listed[0]!.name, "Legacy Project");
    assert.equal(listed[0]!.folders.length, 1);
    const migrated = defaultFolderOf(listed[0]!);
    assert.equal(migrated.workspaceId, legacyWorkspaceId);
    assert.equal(migrated.root, chosenRoot);
    assert.equal(migrated.default, true);

    // The binding recorded before the migration still resolves: a conversation created against the old workspace id
    // runs in the old folder, and so does it after a restart.
    const conversationId = await createConversation(fixture.origin, legacyWorkspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("migrated turn done"),
    ]);
    const turn = await runTurn(fixture.origin, conversationId, "work in the migrated project", "migration-turn-1", "migrated turn done");
    assert.equal(turn.workspaceId, legacyWorkspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text, "note in the migrated folder");
    assert.equal(results[1]!.text.trim(), chosenRoot);

    await fixture.close();
    await gateway.close();
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
    fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
    const again = (await listProjects(fixture.origin, "workstation")).body.projects[0]!;
    assert.deepEqual(again.folders.map(folder => [folder.workspaceId, folder.root, folder.default]), [[legacyWorkspaceId, chosenRoot, true]]);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("migrated restart turn done"),
    ]);
    const restarted = await runTurn(fixture.origin, conversationId, "and after a restart?", "migration-turn-2", "migrated restart turn done");
    assert.equal(restarted.workspaceId, legacyWorkspaceId);
    assert.equal(toolResults(restarted).at(-1)!.text.trim(), chosenRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Ticket 07's whole contract at the backend's own public seam: removing a Project removes metadata only, and the
 * conversation bound to one of its folders keeps its execution environment through the binding the removal retained.
 * Everything here is read back through the public project, workspace and conversation answers; the directory and a
 * file inside it are compared byte for byte afterwards, so "no directory was touched" is asserted rather than assumed.
 */
test("removing a project keeps its directory byte-identical and its bound conversation running", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-removal-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the chosen folder");
  const before = await readFile(join(chosenRoot, "note.txt"));
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  const { origin } = fixture;
  try {
    const project = (await createProject(origin, "Doomed", chosenRoot, "workstation")).body.project!;
    const folder = defaultFolderOf(project);
    // Bound before the removal, and already proven to run there, so what the removal has to preserve is a real
    // execution environment rather than a workspace id that merely resolves.
    const conversationId = await createConversation(origin, folder.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("before removal"),
    ]);
    const first = await runTurn(origin, conversationId, "read it", "removal-turn-1", "before removal");
    assert.equal(toolResults(first)[0]!.text, "note in the chosen folder");

    // The removal is answered as success and names the project that went. Nothing refuses it because a conversation
    // is bound, and no bound-conversation count is computed or returned.
    const removed = await removeProject(origin, project.id, "workstation");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.project!.id, project.id);
    assert.equal(removed.body.project!.folders.length, 1);
    assert.equal(JSON.stringify(removed.body).includes("bound"), false, "no bound-conversation count is reported");

    // The project left the project list, and the directory and the file inside it are byte-identical.
    assert.deepEqual((await listProjects(origin, "workstation")).body.projects, []);
    assert.deepEqual(await readFile(join(chosenRoot, "note.txt")), before);
    assert.deepEqual((await readdir(chosenRoot)).sort(), ["note.txt"]);
    assert.equal(existsSync(join(chosenRoot, "marker.txt")), false);

    // The retained binding is what the workspace list reports, marked so it is never a target, and it names the
    // folder's own workspace id and root on the host the project was on.
    const listed = (await listWorkspaces(origin)).body.workspaces.find(workspace => workspace.id === folder.workspaceId);
    assert.ok(listed, "the retained binding stays in the workspace list so a bound conversation resolves its root");
    assert.equal(listed!.retained, true);
    assert.equal(listed!.gatewayId, "workstation");
    assert.equal(listed!.workspaceRoot, chosenRoot);

    // The conversation bound before the removal still resolves its execution environment and runs a workspace tool.
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf kept-marker > marker.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("after removal"),
    ]);
    const second = await runTurn(origin, conversationId, "still mine?", "removal-turn-2", "after removal");
    assert.equal(second.workspaceId, folder.workspaceId);
    const results = toolResults(second).slice(-3);
    assert.ok(results.every(entry => entry.message.isError !== true), JSON.stringify(results.map(entry => entry.text)));
    assert.equal(results[0]!.text.trim(), chosenRoot);
    assert.equal(results[1]!.text, "note in the chosen folder");
    assert.equal(await readFile(join(chosenRoot, "marker.txt"), "utf8"), "kept-marker");
    assert.equal(existsSync(join(legacyRoot, "marker.txt")), false);

    // A retained workspace id is never a target for a new conversation: the backend refuses to bind one, so no
    // conversation can be created against a folder that is no longer a Project folder.
    const refused = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: folder.workspaceId }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json() as { error: string }).error, "unknown workspace");

    // Re-adding the same directory mints a new workspace id. The retained id is not reused, and the host keeps
    // serving both: the removed root under the id it had, and the new folder under its own.
    const readded = (await createProject(origin, "Re-added", chosenRoot, "workstation")).body.project!;
    const newFolder = defaultFolderOf(readded);
    assert.notEqual(newFolder.workspaceId, folder.workspaceId);
    assert.equal(newFolder.root, chosenRoot);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", folder.workspaceId, newFolder.workspaceId].sort());
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("still the removed folder"),
    ]);
    const third = await runTurn(origin, conversationId, "where am I?", "removal-turn-3", "still the removed folder");
    assert.equal(third.workspaceId, folder.workspaceId);
    assert.equal(toolResults(third).at(-1)!.text.trim(), chosenRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Ticket 08's contract at the backend's own public seam: a folder has an unlink of its own, the Project's default is
 * never removed on its own, and the last folder's removal takes the Project with it in one transaction. Every unlink
 * writes the same retained binding a Project removal does, so a conversation bound to the unlinked folder keeps its
 * execution environment, and the unlinked folder is never a target again.
 */
test("unlinking a folder keeps the project's default valid and retains the folder's binding", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-unlink-")));
  const legacyRoot = join(base, "legacy");
  const alphaRoot = join(base, "alpha");
  const betaRoot = join(base, "beta");
  const gammaRoot = join(base, "gamma");
  await mkdir(legacyRoot);
  for (const root of [alphaRoot, betaRoot, gammaRoot]) await mkdir(root);
  await writeFile(join(betaRoot, "beta.txt"), "in beta");
  await writeFile(join(alphaRoot, "alpha.txt"), "in alpha");
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  // A second configured host, so an origin that does not serve the project's host is refused as such rather than as an
  // unnamed one.
  const other = await startGateway({ id: "elsewhere", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway, other] });
  const { origin } = fixture;
  try {
    const created = await createProjectFolders(origin, "Three Folders", [{ root: alphaRoot, default: true }, { root: betaRoot }, { root: gammaRoot }], "workstation");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project!;
    const alpha = folderAt(project, alphaRoot);
    const beta = folderAt(project, betaRoot);
    const gamma = folderAt(project, gammaRoot);
    // Bound to the folder that is about to be unlinked, and already proven to run there.
    const conversationId = await createConversation(origin, beta.workspaceId);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "beta.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("before unlink"),
    ]);
    assert.equal(toolResults(await runTurn(origin, conversationId, "read it", "unlink-turn-1", "before unlink"))[0]!.text, "in beta");

    // Unlinking a non-default folder leaves the project's default alone: it is the folder's own operation, not a
    // default change, and the project still lists its other folders.
    const unlinked = await unlinkFolder(origin, project.id, beta.id, "workstation");
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.equal(unlinked.body.removedFolderId, beta.id);
    const afterUnlink = unlinked.body.project!;
    assert.deepEqual(afterUnlink.folders.map(folder => folder.root).sort(), [alphaRoot, gammaRoot].sort());
    assert.equal(afterUnlink.defaultFolderId, alpha.id);
    assert.equal(defaultFolderOf(afterUnlink).root, alphaRoot);
    // The directory and its file are untouched, and the project list agrees with the answer.
    assert.deepEqual((await readdir(betaRoot)).sort(), ["beta.txt"]);
    assert.equal(await readFile(join(betaRoot, "beta.txt"), "utf8"), "in beta");
    const listed = (await listProjects(origin, "workstation")).body.projects[0]!;
    assert.deepEqual(listed.folders.map(folder => folder.root).sort(), [alphaRoot, gammaRoot].sort());
    assert.equal(listed.defaultFolderId, alpha.id);
    // A replacement is only meaningful for the default folder: naming one while unlinking another would otherwise read
    // as a default change that never happened.
    const unexpectedReplacement = await unlinkFolder(origin, project.id, gamma.id, "workstation", alpha.id);
    assert.equal(unexpectedReplacement.status, 400);
    assert.equal(unexpectedReplacement.body.code, "unexpected_replacement");
    assert.deepEqual((await listProjects(origin, "workstation")).body.projects[0]!.folders.map(folder => folder.root).sort(), [alphaRoot, gammaRoot].sort());

    // The unlink wrote the same retained binding a project removal writes: the workspace id, host id and root.
    const kept = fixture.store.retained().find(record => record.workspaceId === beta.workspaceId);
    assert.ok(kept, "the unlinked folder's binding is retained");
    assert.equal(kept!.hostId, "workstation");
    assert.equal(kept!.profileId, undefined);
    assert.equal(kept!.root, betaRoot);

    // The retained binding stays resolvable for the conversation that holds it, and is never a target again.
    const workspaces = (await listWorkspaces(origin)).body.workspaces;
    const retainedBeta = workspaces.find(workspace => workspace.id === beta.workspaceId);
    assert.equal(retainedBeta?.retained, true);
    assert.equal(retainedBeta?.workspaceRoot, betaRoot);
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "beta.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("after unlink"),
    ]);
    const after = await runTurn(origin, conversationId, "still mine?", "unlink-turn-2", "after unlink");
    assert.equal(after.workspaceId, beta.workspaceId);
    const afterResults = toolResults(after).slice(-2);
    assert.equal(afterResults[0]!.text, "in beta");
    assert.equal(afterResults[1]!.text.trim(), betaRoot);
    const refused = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: beta.workspaceId }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json() as { error: string }).error, "unknown workspace");

    // Removing the default is refused unless the replacement is named in the same call, and nothing is removed.
    const noReplacement = await unlinkFolder(origin, project.id, alpha.id, "workstation");
    assert.equal(noReplacement.status, 400, JSON.stringify(noReplacement.body));
    assert.equal(noReplacement.body.code, "default_replacement_required");
    assert.ok((noReplacement.body.error ?? "").length > 0, "the refusal is readable");
    assert.deepEqual((await listProjects(origin, "workstation")).body.projects[0]!.folders.map(folder => folder.root).sort(), [alphaRoot, gammaRoot].sort());
    // A replacement that is not another folder of this project is refused too, and still nothing is removed.
    const foreignReplacement = await unlinkFolder(origin, project.id, alpha.id, "workstation", beta.id);
    assert.equal(foreignReplacement.status, 400);
    assert.equal(foreignReplacement.body.code, "unknown_folder");
    assert.equal((await listProjects(origin, "workstation")).body.projects[0]!.defaultFolderId, alpha.id);

    // The same request naming a folder of that project succeeds and leaves the named folder the default.
    const replaced = await unlinkFolder(origin, project.id, alpha.id, "workstation", gamma.id);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.removedFolderId, alpha.id);
    assert.equal(replaced.body.project!.defaultFolderId, gamma.id);
    assert.deepEqual(replaced.body.project!.folders.map(folder => folder.root), [gammaRoot]);
    assert.equal(folderAt(replaced.body.project!, gammaRoot).default, true);
    assert.deepEqual((await readdir(alphaRoot)).sort(), ["alpha.txt"]);
    assert.equal(fixture.store.retained().find(record => record.workspaceId === alpha.workspaceId)?.root, alphaRoot);

    // An origin that does not serve the project's host, a folder that is not this project's, and a project that does
    // not exist are each refused with the backend's own code, and nothing changes.
    const wrongHost = await unlinkFolder(origin, project.id, gamma.id, "elsewhere");
    assert.equal(wrongHost.status, 409);
    assert.equal(wrongHost.body.code, "wrong_host");
    const foreignFolder = await unlinkFolder(origin, project.id, "not-a-folder-of-this-project", "workstation");
    assert.equal(foreignFolder.status, 400);
    assert.equal(foreignFolder.body.code, "unknown_folder");
    const unknownProject = await unlinkFolder(origin, "no-such-project", gamma.id, "workstation");
    assert.equal(unknownProject.status, 404);
    assert.equal(unknownProject.body.code, "unknown_project");
    assert.equal((await listProjects(origin, "workstation")).body.projects[0]!.defaultFolderId, gamma.id);

    // The last folder's removal removes the project in the same transaction: the answer names no project, and no
    // read ever returns an empty one.
    const last = await unlinkFolder(origin, project.id, gamma.id, "workstation");
    assert.equal(last.status, 200, JSON.stringify(last.body));
    assert.equal(last.body.removedFolderId, gamma.id);
    assert.equal(last.body.project, null, "the project went with its last folder");
    assert.deepEqual((await listProjects(origin, "workstation")).body.projects, []);
    assert.equal((await unlinkFolder(origin, project.id, gamma.id, "workstation")).body.code, "unknown_project");
    assert.deepEqual(fixture.store.retained().map(record => record.root).sort(), [alphaRoot, betaRoot, gammaRoot].sort());
    assert.deepEqual((await readdir(gammaRoot)), []);
  } finally {
    await fixture.close();
    await gateway.close();
    await other.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a project's last folder removes the project and its binding is what comes back after a restart", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-unlink-last-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the unlinked folder");
  const dbPath = join(base, "conversations.sqlite");
  const projectsPath = join(base, "projects.sqlite");
  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  let fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
  try {
    const project = (await createProject(fixture.origin, "Only Folder", chosenRoot, "workstation")).body.project!;
    const folder = defaultFolderOf(project);
    const conversationId = await createConversation(fixture.origin, folder.workspaceId);
    const removed = await unlinkFolder(fixture.origin, project.id, folder.id, "workstation");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.project, null);
    assert.deepEqual((await listProjects(fixture.origin, "workstation")).body.projects, []);
    assert.deepEqual((await readdir(chosenRoot)).sort(), ["note.txt"]);
    await fixture.close();
    await gateway.close();

    // The restarted gateway serves nothing but its own seeded workspace, so the retained record the unlink wrote is
    // what puts the unlinked root back: the project that used to is gone.
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
    assert.deepEqual(gateway.registry.ids(), ["legacy"]);
    fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
    assert.deepEqual((await listProjects(fixture.origin, "workstation")).body.projects, []);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", folder.workspaceId].sort());
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("unlinked folder after restart"),
    ]);
    const turn = await runTurn(fixture.origin, conversationId, "still there?", "unlink-restart-1", "unlinked folder after restart");
    assert.equal(turn.workspaceId, folder.workspaceId);
    assert.equal(toolResults(turn)[0]!.text, "note in the unlinked folder");
    assert.equal(toolResults(turn)[1]!.text.trim(), chosenRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a removed project's retained root is re-registered after the gateway restarts", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-removal-restart-")));
  const legacyRoot = join(base, "legacy");
  const chosenRoot = join(base, "chosen");
  await mkdir(legacyRoot);
  await mkdir(chosenRoot);
  await writeFile(join(chosenRoot, "note.txt"), "note in the removed folder");
  const dbPath = join(base, "conversations.sqlite");
  const projectsPath = join(base, "projects.sqlite");
  let gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  let fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
  try {
    const project = (await createProject(fixture.origin, "Doomed", chosenRoot, "workstation")).body.project!;
    const folder = defaultFolderOf(project);
    const conversationId = await createConversation(fixture.origin, folder.workspaceId);
    assert.equal((await removeProject(fixture.origin, project.id, "workstation")).status, 200);
    await fixture.close();
    await gateway.close();

    // Nothing is unregistered on the host: the restarted gateway serves nothing but its own seeded workspace, and the
    // retained record is what re-registers the removed root — the project that used to is gone.
    gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
    assert.deepEqual(gateway.registry.ids(), ["legacy"]);
    fixture = await startBackend({ dbPath, projectsPath, gateways: [gateway] });
    const listed = (await listWorkspaces(fixture.origin)).body.workspaces.find(workspace => workspace.id === folder.workspaceId);
    assert.equal(listed?.retained, true);
    assert.equal(listed?.workspaceRoot, chosenRoot);
    assert.deepEqual([...gateway.registry.ids()].sort(), ["legacy", folder.workspaceId].sort());
    assert.deepEqual((await listProjects(fixture.origin, "workstation")).body.projects, []);

    // The conversation still resolves its display root and runs its tools, after the removal and the restart.
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("retained after restart"),
    ]);
    const turn = await runTurn(fixture.origin, conversationId, "still there?", "removal-restart-1", "retained after restart");
    assert.equal(turn.workspaceId, folder.workspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text, "note in the removed folder");
    assert.equal(results[1]!.text.trim(), chosenRoot);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a project removal is metadata only for every folder, and unknown or wrong-host removals change nothing", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-project-removal-multi-")));
  const legacyRoot = join(base, "legacy");
  const firstRoot = join(base, "alpha");
  const secondRoot = join(base, "beta");
  await mkdir(legacyRoot);
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(join(firstRoot, "first.txt"), "in alpha");
  await writeFile(join(secondRoot, "second.txt"), "in beta");
  const gateway = await startGateway({ id: "workstation", legacyRoot, home: base });
  const other = await startGateway({ id: "elsewhere", legacyRoot, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway, other] });
  const { origin } = fixture;
  try {
    const project = (await createProjectFolders(origin, "Both", [{ root: firstRoot, default: true }, { root: secondRoot }], "workstation")).body.project!;
    const first = folderAt(project, firstRoot);
    const second = folderAt(project, secondRoot);
    const boundToExtra = await createConversation(origin, second.workspaceId);

    // A removal this Web origin does not serve, and one of a project that does not exist: both change nothing.
    const wrongHost = await removeProject(origin, project.id, "elsewhere");
    assert.equal(wrongHost.status, 409);
    assert.equal(wrongHost.body.code, "wrong_host");
    const unknown = await removeProject(origin, "no-such-project", "workstation");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_project");
    assert.equal((await listProjects(origin, "workstation")).body.projects.length, 1);

    // Every folder's binding is retained, not only the default's, and the conversation bound to the extra folder
    // keeps running in it.
    const removed = await removeProject(origin, project.id, "workstation");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const workspaces = (await listWorkspaces(origin)).body.workspaces;
    for (const folder of [first, second]) {
      const kept = workspaces.find(workspace => workspace.id === folder.workspaceId);
      assert.equal(kept?.retained, true, "folder " + folder.workspaceId + " is retained");
      assert.equal(kept?.workspaceRoot, folder.root);
    }
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "second.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("extra folder after removal"),
    ]);
    const turn = await runTurn(origin, boundToExtra, "still mine?", "removal-multi-1", "extra folder after removal");
    assert.equal(turn.workspaceId, second.workspaceId);
    assert.equal(toolResults(turn)[0]!.text, "in beta");
    assert.equal(toolResults(turn)[1]!.text.trim(), secondRoot);
    assert.deepEqual((await readdir(firstRoot)).sort(), ["first.txt"]);
    assert.deepEqual((await readdir(secondRoot)).sort(), ["second.txt"]);
  } finally {
    await fixture.close();
    await gateway.close();
    await other.close();
    await rm(base, { recursive: true, force: true });
  }
});
