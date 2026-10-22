import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayRpcServer, LocalGateway, SshGateway, SshWorkspaceServer, WorkspaceRegistry, WorkspaceServer, sshWorkspaceSeed } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { fauxModels, SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { startRemoteHost } from "./remote-host.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";

const TOKEN = "server-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type GatewayFixture = { id: string; token: string; registry: WorkspaceRegistry; origin: string; close(): Promise<void> };

/** A real local host: execution, files and the workspace surface share one registry, so it reports its own account. */
async function startLocalGateway(options: { id: string; root: string; home: string }): Promise<GatewayFixture> {
  const token = "gateway-token-" + options.id;
  const registry = new WorkspaceRegistry([{ id: "legacy", root: options.root }]);
  const identity = { user: "operator", home: options.home };
  const server = new GatewayRpcServer({
    gateway: new LocalGateway({ id: options.id, token, workspaces: registry, allowedCommands: ["bash"] }),
    files: new LocalFilesystem(registry, { identity }),
    workspaces: new WorkspaceServer(registry, { identity }),
  });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return { id: options.id, token, registry, origin: "http://127.0.0.1:" + address.port, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

/** A real SSH host, composed as ADR 0005's split deployment composes it: every folder it serves lives on the profile. */
async function startSshGateway(options: { id: string; profiles: readonly { id: string; host: string; remoteRoot: string }[]; runner: ReturnType<typeof startRemoteHost>["runner"] }): Promise<GatewayFixture> {
  const token = "gateway-token-" + options.id;
  const registry = new WorkspaceRegistry(sshWorkspaceSeed(options.profiles));
  const server = new GatewayRpcServer({
    gateway: new SshGateway({ id: options.id, token, profiles: options.profiles, allowedCommands: ["bash"], workspaces: registry, runner: options.runner }),
    workspaces: new SshWorkspaceServer(registry, { profiles: options.profiles, runner: options.runner }),
  });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return { id: options.id, token, registry, origin: "http://127.0.0.1:" + address.port, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

type Fixture = { origin: string; store: ProjectStore; backend: BackendServer; close(): Promise<void> };

async function startBackend(options: { dbPath: string; projectsPath: string; gateways: readonly GatewayFixture[] }): Promise<Fixture> {
  const store = createProjectStore({ path: options.projectsPath });
  const gateways = options.gateways.map(fixture => ({ gatewayId: fixture.id, gatewayOrigin: fixture.origin, gatewayToken: fixture.token }));
  // One configured binding on the first host, so the deployment binds a workspace that is not a Project folder.
  const backend = await createBackendServer({ dbPath: options.dbPath, authToken: TOKEN, models: fauxModels(), gateways, workspaces: [{ id: "legacy", ...gateways[0]! }], projects: store, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    store,
    backend,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); store.close(); },
  };
}

type LocalityAnswer = { status: number; body: { local?: boolean; code?: string; error?: string } };

/** The one question an ingress asks about a folder: is this workspace a folder on that gateway's own machine? */
async function locality(origin: string, workspaceId: string, gatewayId: string | undefined): Promise<LocalityAnswer> {
  const query = gatewayId === undefined ? "" : "?gatewayId=" + encodeURIComponent(gatewayId);
  const response = await fetch(origin + "/api/workspaces/" + encodeURIComponent(workspaceId) + "/locality" + query, { headers });
  return { status: response.status, body: await response.json() as never };
}

type ProjectBody = { id: string; folders: { id: string; workspaceId: string; root: string }[]; defaultFolderId: string };
const folderOf = (project: ProjectBody) => project.folders.find(folder => folder.id === project.defaultFolderId)!;

async function createProject(origin: string, hostId: string, root: string, profileId?: string): Promise<ProjectBody> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ hostId, ...(profileId === undefined ? {} : { profileId }), name: "Locality " + root, folders: [{ root, default: true }] }) });
  const body = await response.json() as { project?: ProjectBody; error?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.project!;
}

/**
 * The Backend's own locality verdict for one workspace, at the seam the client ingress asks it through.
 *
 * The verdict is the ingress's folder question and nothing else: whether this workspace is a folder on the machine of
 * the gateway the ingress configured. Every case below is an ordinary deployment fact — a configured binding, a
 * Project folder, a folder a removal retained, a gateway that serves its folders through SSH profiles, a gateway that
 * cannot be reached — and each is answered by the same predicate the ingress used to assemble itself from two listings.
 */
test("a configured workspace on this machine's own gateway is local", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-locality-local-")));
  const root = join(base, "legacy");
  await mkdir(root);
  const gateway = await startLocalGateway({ id: "workstation", root, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  try {
    // A configured binding and a Project folder are both this host's own folders, so both are local.
    const configured = await locality(fixture.origin, "legacy", "workstation");
    assert.equal(configured.status, 200);
    assert.deepEqual(configured.body, { local: true });
    const project = await createProject(fixture.origin, "workstation", root);
    const folder = folderOf(project);
    assert.deepEqual((await locality(fixture.origin, folder.workspaceId, "workstation")).body, { local: true });

    // The verdict is about the pair, not the workspace alone: another gateway's name is not this folder's machine,
    // and a workspace this deployment does not bind is nobody's folder.
    assert.deepEqual((await locality(fixture.origin, "legacy", "elsewhere")).body, { local: false });
    assert.deepEqual((await locality(fixture.origin, folder.workspaceId, "elsewhere")).body, { local: false });
    assert.deepEqual((await locality(fixture.origin, "unknown-workspace", "workstation")).body, { local: false });

    // A caller that names no gateway at all asks an incomplete question, which is a refusal rather than a verdict.
    const unnamed = await locality(fixture.origin, "legacy", undefined);
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, "invalid_request");

    // The listing this decision reads keeps its own shape: the retained marker and the host account are unchanged.
    const listed = await (await fetch(fixture.origin + "/api/workspaces", { headers })).json() as { workspaces: { id: string; gatewayId: string; workspaceRoot?: string }[] };
    assert.deepEqual(listed.workspaces.map(workspace => [workspace.id, workspace.gatewayId]), [["legacy", "workstation"], [folder.workspaceId, "workstation"]]);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a folder a removal retained keeps its binding and stays local on its own gateway", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-locality-retained-")));
  const root = join(base, "legacy");
  const chosen = join(base, "chosen");
  await mkdir(root);
  await mkdir(chosen);
  const gateway = await startLocalGateway({ id: "workstation", root, home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [gateway] });
  try {
    const project = await createProject(fixture.origin, "workstation", chosen);
    const folder = folderOf(project);
    const removed = await fetch(fixture.origin + "/api/projects/" + encodeURIComponent(project.id) + "?hostId=workstation", { method: "DELETE", headers });
    assert.equal(removed.status, 200, await removed.text());
    assert.ok(fixture.store.retained().some(record => record.workspaceId === folder.workspaceId), "the removal retained the binding");

    // Membership, not eligibility: a conversation bound before the removal still resolves its folder here, so the
    // locality verdict keeps answering for it while the workspace list keeps its retained marker.
    assert.deepEqual((await locality(fixture.origin, folder.workspaceId, "workstation")).body, { local: true });
    const listed = await (await fetch(fixture.origin + "/api/workspaces", { headers })).json() as { workspaces: { id: string; retained?: true; workspaceRoot?: string }[] };
    const kept = listed.workspaces.find(workspace => workspace.id === folder.workspaceId);
    assert.equal(kept?.retained, true);
    assert.equal(kept?.workspaceRoot, chosen);
  } finally {
    await fixture.close();
    await gateway.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a gateway that executes through SSH profiles serves no folder of its own, and an unreachable host is not a verdict", { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-locality-ssh-")));
  const host = startRemoteHost({ root: join(base, "remote") });
  const remoteFolder = join(host.root, "alpha");
  await mkdir(remoteFolder, { recursive: true });
  const ssh = await startSshGateway({ id: "workstation-ssh", profiles: [host.profile("prod", host.root)], runner: host.runner });
  const local = await startLocalGateway({ id: "workstation", root: join(base, "local"), home: base });
  const fixture = await startBackend({ dbPath: join(base, "conversations.sqlite"), projectsPath: join(base, "projects.sqlite"), gateways: [local, ssh] });
  try {
    // The workspace really is bound to that gateway — the listing says so — and it is still not a folder on the
    // machine this deployment's own host serves: an SSH gateway's folders live on another computer (ADR 0005).
    const project = await createProject(fixture.origin, "workstation-ssh", remoteFolder, "prod");
    const folder = folderOf(project);
    assert.deepEqual((await locality(fixture.origin, folder.workspaceId, "workstation-ssh")).body, { local: false });
    assert.deepEqual((await locality(fixture.origin, folder.workspaceId, "workstation")).body, { local: false });

    // The host listing keeps stating those profiles: the verdict reads them, it does not remove them.
    const hosts = await (await fetch(fixture.origin + "/api/hosts", { headers })).json() as { hosts: { id: string; profiles: { id: string }[]; error?: string }[] };
    assert.deepEqual(hosts.hosts.find(entry => entry.id === "workstation-ssh")!.profiles.map(profile => profile.id), ["prod"]);
    assert.deepEqual(hosts.hosts.find(entry => entry.id === "workstation")!.profiles, []);
    assert.deepEqual((await locality(fixture.origin, "legacy", "workstation")).body, { local: true });

    // A host the deployment cannot ask is a failed query, not a positive answer and not a fabricated verdict: the
    // caller keeps the safe non-success it already handled, and the ingress reads it as "not local".
    await ssh.close();
    const unreachable = await locality(fixture.origin, folder.workspaceId, "workstation-ssh");
    assert.equal(unreachable.status, 503);
    assert.equal(unreachable.body.code, "gateway_offline");
    assert.equal(unreachable.body.local, undefined);
  } finally {
    await fixture.close();
    await local.close();
    await rm(base, { recursive: true, force: true });
  }
});
