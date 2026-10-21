import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, SshGateway, SshWorkspaceServer, WorkspaceRegistry, WorkspaceServer, sshWorkspaceSeed, type SshRunner } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { SshInstallServer } from "../../../packages/gateway/src/install.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { startRemoteHost } from "./remote-host.ts";
import { streamFolder } from "./stream-window.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";

const TOKEN = "server-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Entry = { role: string; text: string; message: { isError?: boolean } };
type Snapshot = { busy: boolean; workspaceId?: string; entries: Entry[] };
type ProjectFolderBody = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectBody = { id: string; name: string; hostId: string; profileId?: string; defaultFolderId: string; folders: ProjectFolderBody[]; host?: { user: string; home: string }; hostError?: string };

type SshProfileBody = { id: string; host: string; remoteRoot: string; port?: number; identityFile?: string; knownHostsFile?: string };

/**
 * One SSH gateway, composed as its entrypoint composes it: one shared registry seeded from the profiles, one owner
 * resolver behind execution, files, installation and the workspace surface, and the host's own transport.
 */
async function startSshGateway(options: { id: string; profiles: readonly SshProfileBody[]; runner: SshRunner; port?: number }) {
  const token = "gateway-token-" + options.id;
  const registry = new WorkspaceRegistry(sshWorkspaceSeed(options.profiles));
  const runner = options.runner;
  const server = new GatewayRpcServer(
    new SshGateway({ id: options.id, token, profiles: options.profiles, allowedCommands: ["bash", "sh"], runner, workspaces: registry }),
    undefined,
    new SshFilesystem({ id: options.id, profiles: options.profiles, runner, workspaces: registry }),
    new SshInstallServer({ profiles: options.profiles, runner, workspaces: registry }),
    new SshWorkspaceServer(registry, { profiles: options.profiles, runner }),
  );
  await new Promise<void>(resolve => server.server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return {
    id: options.id,
    token,
    registry,
    origin: "http://127.0.0.1:" + address.port,
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

/** A real local gateway, so a project on this machine and a project on the SSH host can be compared in one backend. */
async function startLocalGateway(options: { id: string; root: string; home: string }) {
  const token = "gateway-token-" + options.id;
  const registry = new WorkspaceRegistry([{ id: "legacy", root: options.root }]);
  const identity = { user: "operator", home: options.home };
  const server = new GatewayRpcServer(new LocalGateway({ id: options.id, token, workspaces: registry, allowedCommands: ["bash", "sh"] }), undefined, new LocalFilesystem(registry, { identity }), undefined, new WorkspaceServer(registry, { identity }));
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return { id: options.id, token, registry, origin: "http://127.0.0.1:" + address.port, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

type GatewayFixture = { id: string; token: string; registry: WorkspaceRegistry; origin: string; close(): Promise<void> };
type BackendFixture = { backend: BackendServer; origin: string; store: ProjectStore; faux: ReturnType<typeof fauxProvider>; close(): Promise<void> };

async function startBackend(options: { dbPath: string; projectsPath: string; gateways: readonly GatewayFixture[] }): Promise<BackendFixture> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = createProjectStore({ path: options.projectsPath });
  const gateways = options.gateways.map(fixture => ({ gatewayId: fixture.id, gatewayOrigin: fixture.origin, gatewayToken: fixture.token }));
  // A binding of the first gateway is configured so the backend opens its harness with an execution environment: that
  // is what installs the coding tools, and the conversation's own workspace decides where they run.
  const first = options.gateways[0]!;
  const backend = await createBackendServer({ dbPath: options.dbPath, authToken: TOKEN, models, gateways, projects: store, workspaces: [{ id: first.id === "workstation" ? "legacy" : "remote-prod", ...gateways[0]! }], defaultModel: SERVER_MODEL });
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

async function createProject(origin: string, body: { name: string; folders: { root: string; default?: boolean }[]; hostId?: string; profileId?: string }): Promise<{ status: number; body: { project?: ProjectBody; code?: string; error?: string } }> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as never };
}

async function listProjects(origin: string, hostId?: string): Promise<{ status: number; body: { projects: ProjectBody[] } }> {
  const response = await fetch(origin + "/api/projects" + (hostId === undefined ? "" : "?hostId=" + encodeURIComponent(hostId)), { headers });
  return { status: response.status, body: await response.json() as never };
}

const defaultFolderOf = (project: ProjectBody): ProjectFolderBody => project.folders.find(folder => folder.id === project.defaultFolderId)!;

async function createConversation(origin: string, workspaceId?: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
}

async function runTurn(origin: string, conversationId: string, text: string, requestId: string, expected: string): Promise<Snapshot> {
  const path = origin + "/api/conversations/" + conversationId;
  const reader = (await fetch(path + "/events", { headers, signal: AbortSignal.timeout(20000) })).body!.getReader();
  try {
    assert.equal((await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) })).status, 202);
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

const toolResults = (snapshot: Snapshot): Entry[] => snapshot.entries.filter(entry => entry.role === "toolResult");

test("a remote project is created on the SSH host, executes there, and leaves the local host alone", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-project-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  // The same relative path on both computers, with different content: which one a tool reads is the proof of where it ran.
  const remoteFolder = join(host.root, "alpha");
  const localRoot = join(base, "local");
  const localFolder = join(localRoot, "alpha");
  await mkdir(remoteFolder, { recursive: true });
  await mkdir(localFolder, { recursive: true });
  await writeFile(join(remoteFolder, "note.txt"), "note on the SSH host");
  await writeFile(join(localFolder, "note.txt"), "note on the local host");
  // A file that exists only beside the backend process: a tool that ran there instead of on the host would read it.
  const decoy = join(base, "backend-decoy.txt");
  await writeFile(decoy, "backend decoy");

  const ssh = await startSshGateway({ id: "workstation-ssh", profiles: [host.profile("prod", host.root)], runner: host.runner });
  const local = await startLocalGateway({ id: "workstation", root: localRoot, home: base });
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [local, ssh] });
  try {
    // The configured targets, with the account the SSH host itself reports. No credential crosses this answer.
    const hosts = await (await fetch(backend.origin + "/api/hosts", { headers })).json() as { hosts: { id: string; profiles: { id: string; host: string; root: string; user?: string }[] }[] };
    const remoteHost = hosts.hosts.find(host => host.id === "workstation-ssh")!;
    assert.equal(remoteHost.profiles.length, 1);
    assert.equal(remoteHost.profiles[0]!.id, "prod");
    assert.equal(remoteHost.profiles[0]!.host, host.host);
    assert.equal(remoteHost.profiles[0]!.user, host.user);
    assert.equal(hosts.hosts.find(entry => entry.id === "workstation")!.profiles.length, 0);

    // The remote host's own directories, listed by the remote host.
    const listing = await (await fetch(backend.origin + "/api/host/directories?hostId=workstation-ssh&profileId=prod&path=" + encodeURIComponent(host.root), { headers })).json() as { path: string; directories: { name: string }[]; host: { user: string } };
    assert.equal(listing.path, await realpath(host.root));
    assert.deepEqual(listing.directories.map(entry => entry.name), ["alpha"]);
    assert.equal(listing.host.user, host.user);

    // The remote project records the profile and opaque folder ids; nothing is created on either host.
    const created = await createProject(backend.origin, { name: "Remote Project", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: remoteFolder, default: true }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project!;
    assert.equal(project.hostId, "workstation-ssh");
    assert.equal(project.profileId, "prod");
    const folder = defaultFolderOf(project);
    assert.equal(folder.root, await realpath(remoteFolder));
    assert.notEqual(folder.workspaceId, remoteFolder);
    // The registration landed on the SSH gateway under an opaque id, and nothing was registered on the local one.
    assert.deepEqual([...ssh.registry.ids()].sort(), ["remote-prod", folder.workspaceId].sort());
    assert.deepEqual([...local.registry.ids()], ["legacy"]);

    // A conversation on that folder runs its tools on the SSH host: same-named files resolve to the remote one, and
    // the path that exists only beside the backend process is not reachable.
    const conversationId = await createConversation(backend.origin, folder.workspaceId);
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: decoy })], { stopReason: "toolUse" }),
      fauxAssistantMessage("remote turn done"),
    ]);
    const turn = await runTurn(backend.origin, conversationId, "work on the remote project", "remote-turn-1", "remote turn done");
    assert.equal(turn.workspaceId, folder.workspaceId);
    const results = toolResults(turn);
    assert.equal(results.length, 3, JSON.stringify(results.map(entry => entry.text)));
    // The SSH transport cannot serve a spill path, so the bash result carries that note after its output.
    assert.equal(results[0]!.text.split("\n")[0], await realpath(remoteFolder));
    assert.equal(results[1]!.text, "note on the SSH host");
    assert.equal(results[2]!.message.isError, true);
    // The turn's own commands went to the host's transport: the shell ran there, not in the backend's process.
    assert.ok(host.commands.some(command => command.includes("pwd")), JSON.stringify(host.commands.map(command => command.slice(0, 60))));

    // The local project of the same shape reads its own file: neither host answered for the other.
    const localProject = (await createProject(backend.origin, { name: "Local Project", hostId: "workstation", folders: [{ root: localFolder, default: true }] })).body.project!;
    assert.equal(localProject.profileId, undefined);
    const localConversation = await createConversation(backend.origin, defaultFolderOf(localProject).workspaceId);
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("local turn done"),
    ]);
    const localTurn = await runTurn(backend.origin, localConversation, "work locally", "local-turn-1", "local turn done");
    assert.equal(toolResults(localTurn)[0]!.text, "note on the local host");
  } finally {
    await backend.close();
    await local.close();
    await ssh.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a remote conversation keeps executing after the SSH gateway alone restarts", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-restart-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const folder = join(host.root, "chosen");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "note.txt"), "remote note");
  const profile = host.profile("prod", host.root);
  let ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner });
  const port = Number(new URL(ssh.origin).port);
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [ssh] });
  try {
    const project = (await createProject(backend.origin, { name: "Restarted Remote", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: folder, default: true }] })).body.project!;
    const workspaceId = defaultFolderOf(project).workspaceId;
    const conversationId = await createConversation(backend.origin, workspaceId);

    // The gateway restarts bare: its registry holds nothing but the profile's own seeded workspace again, and the
    // backend and the browser stay up.
    await ssh.close();
    ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner, port });
    assert.deepEqual(ssh.registry.ids(), ["remote-prod"]);

    // No new conversation: the existing one re-registers its folder and executes on the remote host again.
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("after the ssh restart"),
    ]);
    const turn = await runTurn(backend.origin, conversationId, "still there?", "ssh-restart-1", "after the ssh restart");
    assert.equal(turn.workspaceId, workspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text.split("\n")[0], await realpath(folder));
    assert.equal(results[1]!.text, "remote note");
    assert.deepEqual([...ssh.registry.ids()].sort(), ["remote-prod", workspaceId].sort());
  } finally {
    await backend.close();
    await ssh.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("the chosen remote profile is the one that runs, and another profile's folder is not touched", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-two-profiles-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const first = join(host.root, "first");
  const second = join(host.root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "note.txt"), "first profile note");
  await writeFile(join(second, "note.txt"), "second profile note");
  // Two configured profiles of the same gateway, each with its own root on the host.
  const ssh = await startSshGateway({ id: "workstation-ssh", profiles: [host.profile("prod", first), host.profile("staging", second)], runner: host.runner });
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [ssh] });
  try {
    const hosts = await (await fetch(backend.origin + "/api/hosts", { headers })).json() as { hosts: { id: string; profiles: { id: string; root: string }[] }[] };
    assert.deepEqual(hosts.hosts[0]!.profiles.map(profile => profile.id), ["prod", "staging"]);

    const project = (await createProject(backend.origin, { name: "Staging Project", hostId: "workstation-ssh", profileId: "staging", folders: [{ root: second, default: true }] })).body.project!;
    assert.equal(project.profileId, "staging");
    // A profile the gateway does not serve is refused, and nothing is recorded.
    const refused = await createProject(backend.origin, { name: "Nope", hostId: "workstation-ssh", profileId: "absent", folders: [{ root: first, default: true }] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "unknown_profile");
    assert.equal((await listProjects(backend.origin, "workstation-ssh")).body.projects.length, 1);

    // The conversation bound to the staging folder reads the staging file, not the prod one.
    const conversationId = await createConversation(backend.origin, defaultFolderOf(project).workspaceId);
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("staging turn done"),
    ]);
    const turn = await runTurn(backend.origin, conversationId, "work on staging", "staging-turn-1", "staging turn done");
    const results = toolResults(turn);
    assert.equal(results[0]!.text.split("\n")[0], await realpath(second));
    assert.equal(results[1]!.text, "second profile note");
    // The prod profile's own seeded workspace still resolves to its own root: neither profile answered for the other.
    const prodBinding = { gatewayId: "workstation-ssh", gatewayOrigin: ssh.origin, gatewayToken: ssh.token, id: "remote-prod" };
    const prodFiles = await fetch(prodBinding.gatewayOrigin + "/v1/files", { method: "POST", headers: { authorization: "Bearer " + prodBinding.gatewayToken, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "remote-prod", method: "readTextFile", path: "note.txt" }) });
    assert.deepEqual(await prodFiles.json(), { ok: true, value: "first profile note" });
  } finally {
    await backend.close();
    await ssh.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("an unreachable remote host is reported on its own project and never falls back to a local directory", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-offline-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const folder = join(host.root, "chosen");
  await mkdir(folder, { recursive: true });
  const ssh = await startSshGateway({ id: "workstation-ssh", profiles: [host.profile("prod", host.root)], runner: host.runner });
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [ssh] });
  try {
    const project = (await createProject(backend.origin, { name: "Offline Remote", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: folder, default: true }] })).body.project!;
    await ssh.close();

    // The project's metadata survives, its account cannot be resolved, and creating or browsing reports the offline
    // host instead of quietly answering with this machine's own directories.
    const listed = await listProjects(backend.origin, "workstation-ssh");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.projects.length, 1);
    assert.equal(defaultFolderOf(listed.body.projects[0]!).root, await realpath(folder));
    assert.equal(listed.body.projects[0]!.host, undefined);
    assert.ok((listed.body.projects[0]!.hostError ?? "").length > 0);
    const browse = await fetch(backend.origin + "/api/host/directories?hostId=workstation-ssh&profileId=prod", { headers });
    assert.equal(browse.status, 503);
    assert.equal((await browse.json() as { code: string }).code, "gateway_offline");
    const refused = await createProject(backend.origin, { name: "Second", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: folder, default: true }] });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "gateway_offline");
    assert.equal((await listProjects(backend.origin, "workstation-ssh")).body.projects.length, 1);
    // The rest of the backend keeps working: a conversation without a workspace is unaffected.
    const plain = await createConversation(backend.origin);
    backend.faux.setResponses([fauxAssistantMessage("no workspace needed")]);
    const turn = await runTurn(backend.origin, plain, "hello", "offline-ssh-1", "no workspace needed");
    assert.equal(turn.entries.at(-1)!.text, "no workspace needed");
  } finally {
    await backend.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Unlinking one folder of a remote Project is metadata only, and the profile id the unlink retains is what puts that
 * folder's root back on its own host after the SSH gateway alone restarts — a conversation bound to the unlinked
 * folder keeps executing there, and the folder is never a target for a new conversation again.
 */
test("an unlinked remote folder's binding survives the SSH gateway restarting", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-unlink-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const keptFolder = join(host.root, "kept");
  const unlinkedFolder = join(host.root, "unlinked");
  await mkdir(keptFolder, { recursive: true });
  await mkdir(unlinkedFolder, { recursive: true });
  await writeFile(join(keptFolder, "kept.txt"), "kept on the SSH host");
  await writeFile(join(unlinkedFolder, "note.txt"), "note in the unlinked remote folder");
  const profile = host.profile("prod", host.root);
  let ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner });
  const port = Number(new URL(ssh.origin).port);
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [ssh] });
  try {
    const created = await createProject(backend.origin, { name: "Two Remote Folders", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: keptFolder, default: true }, { root: unlinkedFolder }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project!;
    const canonicalUnlinked = await realpath(unlinkedFolder);
    const canonicalKept = await realpath(keptFolder);
    const unlinked = project.folders.find(folder => folder.root === canonicalUnlinked)!;
    const conversationId = await createConversation(backend.origin, unlinked.workspaceId);

    // Unlinking the non-default remote folder leaves the project's default alone and touches neither directory.
    const removed = await fetch(backend.origin + "/api/projects/" + encodeURIComponent(project.id) + "/folders/" + encodeURIComponent(unlinked.id) + "?hostId=workstation-ssh", { method: "DELETE", headers });
    assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()));
    const answer = await removed.json() as { project: ProjectBody; removedFolderId: string };
    assert.equal(answer.removedFolderId, unlinked.id);
    assert.deepEqual(answer.project.folders.map(folder => folder.root), [canonicalKept]);
    assert.equal(answer.project.defaultFolderId, project.defaultFolderId);
    assert.deepEqual((await listProjects(backend.origin, "workstation-ssh")).body.projects[0]!.folders.map(folder => folder.root), [canonicalKept]);

    // The gateway restarts bare, so the retained record's profile id is the only thing that can put the unlinked
    // remote root back: neither the project nor the profile's own configured root would serve it.
    await ssh.close();
    ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner, port });
    assert.deepEqual(ssh.registry.ids(), ["remote-prod"]);
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("unlinked remote turn done"),
    ]);
    const turn = await runTurn(backend.origin, conversationId, "still remote?", "ssh-unlink-1", "unlinked remote turn done");
    assert.equal(turn.workspaceId, unlinked.workspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text.split("\n")[0], canonicalUnlinked);
    assert.equal(results[1]!.text, "note in the unlinked remote folder");
    assert.deepEqual([...ssh.registry.ids()].sort(), ["remote-prod", unlinked.workspaceId].sort());
    const listed = await (await fetch(backend.origin + "/api/workspaces", { headers })).json() as { workspaces: { id: string; retained?: boolean; workspaceRoot?: string }[] };
    const kept = listed.workspaces.find(workspace => workspace.id === unlinked.workspaceId);
    assert.equal(kept?.retained, true);
    assert.equal(kept?.workspaceRoot, canonicalUnlinked);
    // The unlinked folder is never a target again.
    const refused = await fetch(backend.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: unlinked.workspaceId }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json() as { error: string }).error, "unknown workspace");
  } finally {
    await backend.close();
    await ssh.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * A remote Project's removal is metadata only too, and the profile id it retained is what puts the root back on that
 * host after the SSH gateway alone restarts: a local project's record cannot name the account or the transport.
 */
test("a removed remote project's conversation keeps executing on the SSH host", { timeout: 120000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-removal-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const folder = join(host.root, "chosen");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "note.txt"), "note on the SSH host");
  const profile = host.profile("prod", host.root);
  let ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner });
  const port = Number(new URL(ssh.origin).port);
  const backend = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [ssh] });
  try {
    const project = (await createProject(backend.origin, { name: "Doomed Remote", hostId: "workstation-ssh", profileId: "prod", folders: [{ root: folder, default: true }] })).body.project!;
    const workspaceId = defaultFolderOf(project).workspaceId;
    const conversationId = await createConversation(backend.origin, workspaceId);
    const removed = await fetch(backend.origin + "/api/projects/" + encodeURIComponent(project.id) + "?hostId=workstation-ssh", { method: "DELETE", headers });
    assert.equal(removed.status, 200, JSON.stringify(await removed.json()));
    assert.equal((await listProjects(backend.origin, "workstation-ssh")).body.projects.length, 0);

    // The gateway restarts bare. The retained record still names the profile, so it is that host's own root — not a
    // local directory and not the profile's configured root — that comes back.
    await ssh.close();
    ssh = await startSshGateway({ id: "workstation-ssh", profiles: [profile], runner: host.runner, port });
    assert.deepEqual(ssh.registry.ids(), ["remote-prod"]);
    backend.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("remote removal turn done"),
    ]);
    const turn = await runTurn(backend.origin, conversationId, "still remote?", "ssh-removal-1", "remote removal turn done");
    assert.equal(turn.workspaceId, workspaceId);
    const results = toolResults(turn);
    assert.equal(results[0]!.text.split("\n")[0], await realpath(folder));
    assert.equal(results[1]!.text, "note on the SSH host");
    assert.deepEqual([...ssh.registry.ids()].sort(), ["remote-prod", workspaceId].sort());
    const listed = await (await fetch(backend.origin + "/api/workspaces", { headers })).json() as { workspaces: { id: string; retained?: boolean; workspaceRoot?: string }[] };
    const kept = listed.workspaces.find(workspace => workspace.id === workspaceId);
    assert.equal(kept?.retained, true);
    assert.equal(kept?.workspaceRoot, await realpath(folder));
  } finally {
    await backend.close();
    await ssh.close();
    await rm(base, { recursive: true, force: true });
  }
});
