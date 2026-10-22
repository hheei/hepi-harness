import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway, SshGateway, SshWorktreeServer, SshWorkspaceServer, WorkspaceRegistry, WorkspaceServer, sshWorkspaceSeed } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { createProjectStore, type ProjectStore } from "../../../apps/server/src/project-store.ts";
import { createFakeGitHost, type FakeGitHost } from "../../../apps/server/test/fake-git-host.ts";
import { createFakeSshHost, type FakeSshHost } from "./fake-ssh.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";

/**
 * The catalogue, Project binding and host selection, through the **client ingress** a Web page or an App reaches.
 *
 * Ticket 06 owns these facts in the Backend and this is the entry a client will really use: a device bearer or a Web
 * cookie reads the catalogue, creates and re-binds a Project, lists and removes a worktree, and resolves a folder to
 * the execution host that really holds it. Two hosts are configured — this machine and an SSH host — and the folder
 * a Project was created on is the one every answer must name, so "the ingress Gateway is not the execution Gateway"
 * is exercised rather than assumed.
 *
 * The SSH host is the in-memory host of ./fake-ssh.ts and the local host answers real git through the in-memory
 * repository of apps/server/test/fake-git-host.ts: what is under test is the Backend's binding and the ingress's
 * transport, not git or ssh.
 */

const BACKEND_TOKEN = "ingress-catalogue-backend-token";
const WEB_LOGIN = "ingress-catalogue-login";
const LOCAL_GATEWAY = "workstation";
const SSH_GATEWAY = "workstation-ssh";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type FolderBody = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectBody = { id: string; name: string; hostId: string; profileId?: string; defaultFolderId: string; folders: FolderBody[]; host?: { user: string; home: string }; hostError?: string };
type WorkspaceBody = { id: string; gatewayId?: string; workspaceRoot?: string; retained?: true; host?: { user: string; home: string }; hostError?: string };
type CatalogueWorkspaceBody = { gatewayId?: string; root?: string; retained?: true; project?: { id: string; name: string; defaultWorkspaceId: string; displayRoot: string } };
type CatalogueRow = { id: string; workspaceId?: string | null; gatewayId?: string | null; workspace?: CatalogueWorkspaceBody; revision?: number };
type CatalogueBody = { protocol: string; sidebarStateRevision: number; projectsRevision: number; sessionListVersion: number; conversations: CatalogueRow[] };
type WorktreeBody = { ok: boolean; code?: string; error?: string; dirty?: boolean; value?: { isGit: boolean; isTopLevel: boolean; currentWorktreePath: string | null; worktrees: { path: string; branch: string | null; isMain: boolean; workspaceId?: string }[] } | { path: string; branch: string; workspaceId: string } | { removed: string } };

type Fixture = {
  origin: string;
  backend: BackendServer;
  ingress: ClientIngress;
  store: ProjectStore;
  local: { origin: string; registry: WorkspaceRegistry };
  ssh: { origin: string; registry: WorkspaceRegistry; host: FakeSshHost };
  localRoot: string;
  remoteRoot: string;
  git: FakeGitHost;
  close(): Promise<void>;
};

/** One real local gateway, one real SSH gateway over a controlled host, one Backend, one client ingress. */
async function fixture(): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-catalogue-")));
  directories.push(directory);
  const localRoot = join(directory, "repo");
  const legacyRoot = join(directory, "legacy");
  const remoteRoot = join(directory, "remote");
  await mkdir(localRoot);
  await mkdir(legacyRoot);
  await mkdir(remoteRoot);
  await mkdir(join(directory, "home"));
  const git = createFakeGitHost();
  git.initRepository(localRoot, "main");

  const localRegistry = new WorkspaceRegistry([{ id: "legacy", root: legacyRoot }]);
  const localIdentity = { user: "operator", home: join(directory, "home") };
  const localServer = new GatewayRpcServer({
    gateway: new LocalGateway({ id: LOCAL_GATEWAY, token: "local-gateway-token", workspaces: localRegistry, allowedCommands: ["bash"] }),
    workbench: new GatewayWorkbench(localRegistry),
    files: new LocalFilesystem(localRegistry, { identity: localIdentity }),
    workspaces: new WorkspaceServer(localRegistry, { identity: localIdentity }),
    worktrees: new GatewayWorktrees(localRegistry, git.git),
  });
  await new Promise<void>(resolve => localServer.server.listen(0, "127.0.0.1", resolve));
  const localAddress = localServer.server.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const host = createFakeSshHost({ root: remoteRoot, user: "builder", home: join(directory, "remote-home") });
  host.initRepository(remoteRoot, "main");
  const sshProfiles = [host.profile];
  const sshRegistry = new WorkspaceRegistry(sshWorkspaceSeed(sshProfiles));
  const sshServer = new GatewayRpcServer({
    gateway: new SshGateway({ id: SSH_GATEWAY, token: "ssh-gateway-token", profiles: sshProfiles, allowedCommands: ["bash"], runner: host.runner, workspaces: sshRegistry }),
    files: new SshFilesystem({ id: SSH_GATEWAY, profiles: sshProfiles, runner: host.runner, workspaces: sshRegistry }),
    workspaces: new SshWorkspaceServer(sshRegistry, { profiles: sshProfiles, runner: host.runner }),
    worktrees: new SshWorktreeServer(sshRegistry, { profiles: sshProfiles, runner: host.runner }),
  });
  await new Promise<void>(resolve => sshServer.server.listen(0, "127.0.0.1", resolve));
  const sshAddress = sshServer.server.address();
  assert.ok(sshAddress && typeof sshAddress === "object");

  const gateways = [
    { gatewayId: LOCAL_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + localAddress.port, gatewayToken: "local-gateway-token" },
    { gatewayId: SSH_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "ssh-gateway-token" },
  ];
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const store = createProjectStore({ path: join(directory, "projects.sqlite") });
  const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
  const backend = await createBackendServer({
    dbPath: join(directory, "conversations.sqlite"),
    authToken: BACKEND_TOKEN,
    models,
    gateways,
    workspaces: [{ id: "legacy", ...gateways[0]! }],
    projects: store,
    deviceCredentials: credentials,
    defaultModel: SERVER_MODEL,
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.server.address();
  assert.ok(backendAddress && typeof backendAddress === "object");
  const ingress = createClientIngress({
    backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
    webLoginToken: WEB_LOGIN,
  });
  await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress && typeof ingressAddress === "object");
  return {
    origin: "http://127.0.0.1:" + ingressAddress.port,
    backend,
    ingress,
    store,
    local: { origin: gateways[0]!.gatewayOrigin, registry: localRegistry },
    ssh: { origin: gateways[1]!.gatewayOrigin, registry: sshRegistry, host },
    localRoot,
    remoteRoot,
    git,
    close: async () => {
      await ingress.close();
      await backend.close();
      credentials.close();
      store.close();
      localServer.server.closeAllConnections();
      await localServer.close();
      sshServer.server.closeAllConnections();
      await sshServer.close();
    },
  };
}

/** The cookie pair a Web login set, as the browser sends it back. */
async function webSession(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the login response set no cookie");
  assert.ok(header.split(";")[0]!.startsWith(WEB_SESSION_COOKIE + "="));
  return header.split(";")[0]!;
}

const json = (headers: Record<string, string>) => ({ ...headers, "content-type": "application/json" });

async function createProject(origin: string, headers: Record<string, string>, body: unknown): Promise<ProjectBody> {
  const response = await fetch(origin + "/api/projects", { method: "POST", headers: json(headers), body: JSON.stringify(body) });
  const answer = await response.json() as { project?: ProjectBody; error?: string };
  assert.equal(response.status, 201, JSON.stringify(answer));
  return answer.project!;
}

async function createConversation(origin: string, headers: Record<string, string>, workspaceId?: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers: json(headers), body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
  const answer = await response.json() as { conversationId?: string; error?: string };
  assert.equal(response.status, 201, JSON.stringify(answer));
  return answer.conversationId!;
}

const catalogue = async (origin: string, headers: Record<string, string>, query = ""): Promise<CatalogueBody> => await (await fetch(origin + "/api/conversations" + query, { headers })).json() as CatalogueBody;
const workspaces = async (origin: string, headers: Record<string, string>): Promise<WorkspaceBody[]> => ((await (await fetch(origin + "/api/workspaces", { headers })).json()) as { workspaces: WorkspaceBody[] }).workspaces;
const projects = async (origin: string, headers: Record<string, string>, hostId: string): Promise<ProjectBody[]> => ((await (await fetch(origin + "/api/projects?hostId=" + encodeURIComponent(hostId), { headers })).json()) as { projects: ProjectBody[] }).projects;

async function worktree(origin: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: WorktreeBody }> {
  const response = await fetch(origin + "/api/worktrees", { method: "POST", headers: json(headers), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as WorktreeBody };
}

test("a device bearer reads the catalogue, binds Projects on both hosts and re-binds a folder through the ingress", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const issued = await fetch(app.origin + "/api/device-credentials", { method: "POST", headers: json({ origin: app.origin, cookie }), body: JSON.stringify({ label: "laptop" }) });
    assert.equal(issued.status, 201);
    const device = await issued.json() as { token: string };
    // Every catalogue answer below is read with the device bearer, which is the identity an App holds.
    const bearer = { authorization: "Bearer " + device.token };

    // One Project on this machine and one on the SSH host: the two hosts a client has to tell apart.
    const local = await createProject(app.origin, bearer, { hostId: LOCAL_GATEWAY, name: "Local", folders: [{ root: app.localRoot, default: true }] });
    const remote = await createProject(app.origin, bearer, { hostId: SSH_GATEWAY, profileId: app.ssh.host.profile.id, name: "Remote", folders: [{ root: app.remoteRoot, default: true }] });
    assert.equal(local.hostId, LOCAL_GATEWAY);
    assert.equal(remote.hostId, SSH_GATEWAY);
    assert.equal(remote.profileId, app.ssh.host.profile.id);
    // A remote Project records the opaque folder id the SSH host registered, and nothing on the local host.
    assert.ok(app.ssh.registry.get(remote.folders[0]!.workspaceId) !== undefined, "the SSH host did not register the remote folder");
    assert.equal(app.local.registry.get(remote.folders[0]!.workspaceId), undefined, "a remote folder was registered on the local host");

    const localConversation = await createConversation(app.origin, bearer, local.folders[0]!.workspaceId);
    const remoteConversation = await createConversation(app.origin, bearer, remote.folders[0]!.workspaceId);
    const configuredConversation = await createConversation(app.origin, bearer, "legacy");
    const unbound = await createConversation(app.origin, bearer);

    // One catalogue read states each conversation's workspace, its host, its recorded root and its group.
    const listed = await catalogue(app.origin, bearer);
    assert.equal(listed.protocol, "hepi.v1");
    assert.equal(listed.projectsRevision, 2);
    assert.equal(typeof listed.sessionListVersion, "number");
    const row = (id: string): CatalogueRow => listed.conversations.find(candidate => candidate.id === id)!;
    assert.deepEqual(row(localConversation).workspace, { gatewayId: LOCAL_GATEWAY, root: local.folders[0]!.root, project: { id: local.id, name: "Local", defaultWorkspaceId: local.folders[0]!.workspaceId, displayRoot: local.folders[0]!.root } });
    // The remote conversation names the SSH host, not the host this ingress is served beside.
    assert.equal(row(remoteConversation).gatewayId, SSH_GATEWAY);
    assert.equal(row(remoteConversation).workspace?.root, await realpath(app.remoteRoot));
    assert.equal(row(remoteConversation).workspace?.project?.id, remote.id);
    // A configured workspace states its host and nothing it did not record; a conversation bound to nothing states none.
    assert.deepEqual(row(configuredConversation).workspace, { gatewayId: LOCAL_GATEWAY });
    assert.equal(row(unbound).workspaceId, null);
    assert.equal(row(unbound).workspace, undefined);

    // The host listing answers the account each host itself reports, through the same entry.
    const listedProjects = await projects(app.origin, bearer, SSH_GATEWAY);
    assert.equal(listedProjects.find(entry => entry.id === remote.id)?.host?.user, "builder");
    assert.equal(listedProjects.find(entry => entry.id === local.id)?.hostError !== undefined, true, "another host's Project was answered with this host's account");

    // A worktree on each host: the checkout is created on the host the Project is on, and is a conversation target.
    const localCheckout = await worktree(app.origin, bearer, { workspaceId: local.folders[0]!.workspaceId, operation: "create", branch: "feature/local" });
    assert.equal(localCheckout.status, 200, JSON.stringify(localCheckout.body));
    const localMade = localCheckout.body.value as { path: string; workspaceId: string };
    assert.equal(localMade.path, app.localRoot + "-worktrees/feature-local");
    const remoteCheckout = await worktree(app.origin, bearer, { workspaceId: remote.folders[0]!.workspaceId, operation: "create", branch: "feature/remote" });
    assert.equal(remoteCheckout.status, 200, JSON.stringify(remoteCheckout.body));
    const remoteMade = remoteCheckout.body.value as { path: string; workspaceId: string };
    assert.equal(remoteMade.path, (await realpath(app.remoteRoot)) + "-worktrees/feature-remote");
    // The remote checkout exists on the SSH host, and this machine's filesystem does not have it.
    assert.equal(app.ssh.host.exists(remoteMade.path), true);
    // Each created checkout is a folder of its own Project, so a new conversation can bind it.
    const remoteProject = (await projects(app.origin, bearer, SSH_GATEWAY)).find(entry => entry.id === remote.id)!;
    assert.deepEqual(remoteProject.folders.map(folder => folder.workspaceId), [remote.folders[0]!.workspaceId, remoteMade.workspaceId]);
    assert.equal(remoteProject.defaultFolderId, remote.folders[0]!.id, "creating a checkout moved the Project's default");

    // Removing the remote checkout keeps the conversation already bound to it resolvable, and never offers it back.
    const boundInCheckout = await createConversation(app.origin, bearer, remoteMade.workspaceId);
    const removed = await worktree(app.origin, bearer, { workspaceId: remote.folders[0]!.workspaceId, operation: "remove", path: remoteMade.path, force: true });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(app.ssh.host.exists(remoteMade.path), false);
    const afterCheckoutRemoval = await catalogue(app.origin, bearer);
    // Three more accepted mutations: each created checkout was recorded as a folder of its Project, and the
    // removed checkout's folder was unlinked. One revision each — not one per retained binding, not one per read.
    assert.equal(afterCheckoutRemoval.projectsRevision, listed.projectsRevision + 3);
    const afterRemoval = afterCheckoutRemoval.conversations.find(candidate => candidate.id === boundInCheckout)!;
    assert.equal(afterRemoval.workspaceId, remoteMade.workspaceId);
    assert.equal(afterRemoval.gatewayId, SSH_GATEWAY);
    assert.deepEqual(afterRemoval.workspace, { gatewayId: SSH_GATEWAY, root: remoteMade.path, retained: true });
    const offered = await workspaces(app.origin, bearer);
    assert.equal(offered.find(entry => entry.id === remoteMade.workspaceId)?.retained, true);

    // Removing the Project is metadata only: the conversation bound to its folder keeps its host and its root.
    const stillBound = await createConversation(app.origin, bearer, remote.folders[0]!.workspaceId);
    const deleted = await fetch(app.origin + "/api/projects/" + encodeURIComponent(remote.id) + "?hostId=" + encodeURIComponent(SSH_GATEWAY), { method: "DELETE", headers: bearer });
    assert.equal(deleted.status, 200, await deleted.text());
    const afterProjectRemoval = await catalogue(app.origin, bearer);
    // The Project removal is the fourth accepted mutation since that first read: one revision for the removal
    // itself, however many folders it retained — a retained binding keeps a bound conversation resolvable, it is
    // not a separate publication.
    assert.equal(afterProjectRemoval.projectsRevision, listed.projectsRevision + 4);
    const kept = afterProjectRemoval.conversations.find(candidate => candidate.id === stillBound)!;
    assert.equal(kept.workspaceId, remote.folders[0]!.workspaceId);
    assert.equal(kept.gatewayId, SSH_GATEWAY);
    assert.deepEqual(kept.workspace, { gatewayId: SSH_GATEWAY, root: remote.folders[0]!.root, retained: true });
    assert.deepEqual((await projects(app.origin, bearer, SSH_GATEWAY)).filter(entry => entry.hostId === SSH_GATEWAY), [], "the removed Project is still listed for its host");

    // The folder a removal retained is still the folder a new conversation is refused, and a Project folder is not.
    const refused = await fetch(app.origin + "/api/conversations", { method: "POST", headers: json(bearer), body: JSON.stringify({ workspaceId: remote.folders[0]!.workspaceId }) });
    assert.equal(refused.status, 400, "a retained binding was offered as a target for a new conversation");
  } finally {
    await app.close();
  }
});

test("a folder a Project records is addressed on its own host, not the host the ingress serves", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const remote = await createProject(app.origin, { cookie }, { hostId: SSH_GATEWAY, profileId: app.ssh.host.profile.id, name: "Remote", folders: [{ root: app.remoteRoot, default: true }] });
    const folder = remote.folders[0]!;
    // The routing address a client sends is the folder's, and the answer names the root that folder really has.
    const browsed = await fetch(app.origin + "/api/host/directories?hostId=" + encodeURIComponent(SSH_GATEWAY) + "&profileId=" + encodeURIComponent(app.ssh.host.profile.id) + "&path=" + encodeURIComponent(app.remoteRoot), { headers: { cookie } });
    const identity = await browsed.json() as { path: string; host: { user: string } };
    assert.equal(browsed.status, 200, JSON.stringify(identity));
    assert.equal(identity.path, await realpath(app.remoteRoot));
    assert.equal(identity.host.user, "builder");
    // The worktree list of that folder is the SSH host's own answer: the ingress forwards the workspace the client
    // named, and the Backend resolves it to the host that recorded it, never to the host this ingress runs beside.
    const listed = await worktree(app.origin, { cookie }, { workspaceId: folder.workspaceId, operation: "list" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const value = listed.body.value as { isGit: boolean; isTopLevel: boolean; currentWorktreePath: string | null; worktrees: { path: string; workspaceId?: string }[] };
    assert.equal(value.currentWorktreePath, await realpath(app.remoteRoot));
    assert.deepEqual(value.worktrees.map(entry => [entry.path, entry.workspaceId]), [[await realpath(app.remoteRoot), folder.workspaceId]]);
  } finally {
    await app.close();
  }
});
