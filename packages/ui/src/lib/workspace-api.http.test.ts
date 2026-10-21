import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "../../../../packages/gateway/src/index.ts";
import { LocalFilesystem } from "../../../../packages/gateway/src/filesystem.ts";
import { GatewayWorkbench } from "../../../../packages/gateway/src/workbench/index.ts";
import { createClientIngress, WEB_SESSION_COOKIE } from "../../../../packages/gateway/src/ingress/index.ts";
import { createBackendServer } from "../../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../../apps/server/src/device-credentials.ts";
import { createProjectStore } from "../../../../apps/server/src/project-store.ts";
import { createFakeGitHost } from "../../../../apps/server/test/fake-git-host.ts";
import { fauxModels, SERVER_MODEL } from "../../../../apps/server/test/faux-fixture.ts";
import { bearerSource } from "../../../../packages/session/src/browser.ts";

// The workbench's own modules are read the way both hosts read them: through the bundler-style resolution their
// extension-less relative imports were extracted with.
const jiti = createJiti(import.meta.url);
const { createClient } = await jiti.import<typeof import("../client.ts")>("../client.ts");
const { createWorkspaceApi, configuredDefaultCwd, configuredHome, WorkspaceRefusal } = await jiti.import<typeof import("./workspace-api.ts")>("./workspace-api.ts");
type WorkspaceAccount = import("./workspace-api.ts").WorkspaceAccount;
type DirectoryListing = import("./workspace-api.ts").DirectoryListing;
type DirectoryTarget = import("./workspace-api.ts").DirectoryTarget;

/**
 * The workspace, project and worktree API at the seam a caller really crosses: real HTTP through the client ingress to
 * a real Backend and a real gateway.
 *
 * The modules under test are the ones both hosts run — `createClient` and `createWorkspaceApi` — so these cases cannot
 * pass by reaching around them. What they hold is the cutover this ticket makes: the workbench asks the Backend's own
 * `/api/workspaces`, `/api/projects`, `/api/hosts`, `/api/host/directories` and `/api/worktrees` vocabulary, under a
 * device bearer, and never the retired Next BFF's `/api/home`, `/api/default-cwd`, `/api/cwd/browse` and
 * `/api/worktrees?cwd=` paths, which the Backend answers 404.
 *
 * Which computer a request acts on is the deployment's own statement: the ingress here is configured with the default
 * host (`defaultHostId`), exactly as a deployment states `HEPI_INGRESS_DEFAULT_HOST`, so no client names one.
 */

/** Every temporary directory a fixture made, removed once the file's cases are done. */
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** One fixture's running deployment: the addresses, the bearer, and the routes the ingress was asked for. */
type Fixture = {
  readonly directory: string;
  readonly root: string;
  readonly local: string;
  readonly home: string;
  readonly origin: string;
  readonly device: string;
  readonly served: string[];
  close(): Promise<void>;
};

/** A listen that resolves, stated as the promise the server's own callback signature requires. */
const listening = (server: { listen(port: number, host: string, callback: () => void): unknown }): Promise<void> =>
  new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });

const BACKEND_TOKEN = "workspace-api-backend-token";
const WEB_LOGIN = "workspace-api-web-login";
const GATEWAY_TOKEN = "workspace-api-gateway-token";

/** One real gateway on a real repository, one real Backend, one client ingress in front of both, one device bearer. */
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-workbench-workspace-")));
  directories.push(directory);
  const root = join(directory, "repo");
  const local = join(directory, "local");
  const home = join(directory, "home");
  await mkdir(root);
  await mkdir(local);
  await mkdir(home);
  await writeFile(join(root, "README.md"), "baseline\n");
  const git = createFakeGitHost();
  git.initRepository(root, "main");
  const registry = new WorkspaceRegistry([{ id: "local", root: local }]);
  const identity = { user: "operator", home };
  const gateway = new GatewayRpcServer(
    new LocalGateway({ id: "workstation", token: GATEWAY_TOKEN, workspaces: registry, allowedCommands: ["bash"] }),
    new GatewayWorkbench(registry),
    new LocalFilesystem(registry, { identity }),
    undefined,
    new WorkspaceServer(registry, { identity }),
    new GatewayWorktrees(registry, git.git),
  );
  await listening(gateway.server);
  const gatewayAddress = gateway.server.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const gatewayOrigin = "http://127.0.0.1:" + gatewayAddress.port;

  const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
  const store = createProjectStore({ path: join(directory, "projects.sqlite") });
  const backend = await createBackendServer({
    dbPath: join(directory, "conversations.sqlite"),
    authToken: BACKEND_TOKEN,
    models: fauxModels(),
    defaultModel: SERVER_MODEL,
    deviceCredentials: credentials,
    buildId: "build-1",
    backendId: "backend-1",
    accountScope: "account-1",
    workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin, gatewayToken: GATEWAY_TOKEN }],
    gateways: [{ gatewayId: "workstation", gatewayOrigin, gatewayToken: GATEWAY_TOKEN }],
    projects: store,
  });
  await listening(backend.server);
  const backendAddress = backend.server.address();
  assert.ok(backendAddress && typeof backendAddress === "object");
  const ingress = createClientIngress({
    backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
    webLoginToken: WEB_LOGIN,
    appOrigins: ["http://app.example"],
    // The deployment's own statement of which computer this origin's callers are served from.
    defaultHostId: "workstation",
  });
  const served: string[] = [];
  ingress.server.on("request", request => { served.push((request.method ?? "GET") + " " + (request.url ?? "/").split("?")[0]); });
  await listening(ingress.server);
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress && typeof ingressAddress === "object");
  const origin = "http://127.0.0.1:" + ingressAddress.port;

  const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
  const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
  assert.equal(issued.status, 201);
  const device = (await issued.json()).token;
  served.length = 0;
  return {
    directory, root, local, home, origin, device, served,
    close: async () => { await ingress.close(); credentials.close(); await backend.close(); store.close(); gateway.server.closeAllConnections(); await gateway.close(); },
  };
}

/** The App's connection: a device bearer against the ingress, with the stream opened the way the App opens it. */
function appClient(target: Pick<Fixture, "origin" | "device">) {
  return createClient({ origin: target.origin, credential: { kind: "bearer", token: target.device }, createSource: bearerSource(target.origin, target.device) });
}

test("a device bearer reads the deployment's workspaces, projects and home on its own stated host", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createWorkspaceApi(client.request);

  // Create a Project on the host the deployment stated: the request names no host, and the folder must already exist.
  const project = await api.createProject({ name: "Repo", folders: [{ root: target.root, default: true }] });
  assert.equal(project.name, "Repo");
  assert.equal(project.hostId, "workstation");
  const folder = project.folders[0];
  assert.equal(folder.root, target.root);
  assert.equal(folder.default, true);

  const workspaces = await api.workspaces();
  const configuredWorkspace = workspaces.find(workspace => workspace.id === "local");
  assert.ok(configuredWorkspace, "the configured workspace is listed");
  assert.ok(configuredWorkspace.host, "the configured workspace reported its host");
  assert.equal(configuredWorkspace.host.user, "operator");
  assert.equal(configuredWorkspace.host.home, target.home);
  assert.equal(configuredWorkspace.workspaceRoot, target.local);
  assert.ok(workspaces.some(workspace => workspace.id === folder.workspaceId), "the Project's folder is listed as a workspace");

  const listed = await api.projects();
  assert.deepEqual(listed.map(item => item.name), ["Repo"]);
  // The account shown is the one the Project's own host reported, resolved by the Backend rather than by this side.
  assert.equal((listed[0] as { host?: WorkspaceAccount }).host?.user, "operator");

  // The home the paths show as ~ and "use default directory" are derived from those two listings: the retired
  // `/api/home` and `/api/default-cwd` routes are not asked at all.
  assert.equal(configuredHome(workspaces, listed), target.home);
  assert.equal(configuredDefaultCwd(workspaces, listed), "/workspace/local");
  assert.ok(target.served.includes("GET /api/workspaces"), target.served.join(", "));
  assert.ok(target.served.includes("GET /api/projects"), target.served.join(", "));
  assert.deepEqual(target.served.filter(entry => entry.includes("/api/home") || entry.includes("/api/default-cwd") || entry.includes("/api/cwd/") || entry.includes("ui-state")), []);

  // The retired vocabulary really is what the Backend answers 404 to, which is why the paths above had to change.
  const headers = { authorization: "Bearer " + target.device };
  assert.equal((await fetch(target.origin + "/api/home", { headers })).status, 404);
  assert.equal((await fetch(target.origin + "/api/default-cwd", { method: "POST", headers })).status, 404);
  assert.equal((await fetch(target.origin + "/api/cwd/browse?path=" + encodeURIComponent(target.home), { headers })).status, 404);
  assert.equal((await fetch(target.origin + "/api/worktrees?cwd=" + encodeURIComponent(folder.cwd), { headers })).status, 404);
});

test("a host's own directories are browsed with the account it reported, and a remote target must be one it lists", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createWorkspaceApi(client.request);
  await mkdir(join(target.home, "projects"));

  const listing: DirectoryListing = await api.browse();
  assert.equal(listing.path, target.home);
  assert.equal(listing.host?.user, "operator");
  assert.deepEqual(listing.directories?.map(entry => entry.name), ["projects"]);

  const hosts = await api.hosts();
  assert.deepEqual(hosts.map(host => host.id), ["workstation"]);
  // A local gateway serves no remote profile, so there is no remote target to name; naming one anyway is the host's
  // own refusal rather than a silent fallback to this computer.
  await assert.rejects(api.browse({ hostId: "workstation", profileId: "staging" } satisfies DirectoryTarget), (error: unknown) => {
    assert.ok(error instanceof WorkspaceRefusal);
    if (!(error instanceof WorkspaceRefusal)) return false;
    assert.equal(error.status, 400);
    return true;
  });
  assert.ok(target.served.includes("GET /api/host/directories"), target.served.join(", "));
  assert.deepEqual(target.served.filter(entry => entry.includes("/api/cwd/")), []);
});

test("a checkout is created, listed and removed through the Backend's one worktree route, and its folder record follows", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createWorkspaceApi(client.request);
  const project = await api.createProject({ name: "Repo", folders: [{ root: target.root, default: true }] });
  const mainWorkspaceId = project.folders[0].workspaceId;

  const before = await api.listWorktrees(mainWorkspaceId);
  assert.equal(before.isGit, true);
  assert.equal(before.isTopLevel, true);
  assert.deepEqual(before.worktrees.map(entry => entry.path), [target.root]);
  assert.equal(before.worktrees[0].workspaceId, mainWorkspaceId);

  const created = await api.createWorktree(mainWorkspaceId, "feature");
  assert.ok(created.path.startsWith(target.root + "/") || created.path.includes("feature"), created.path);
  assert.ok(created.workspaceId, "the created checkout is recorded as a conversation target");

  const after = await api.listWorktrees(mainWorkspaceId);
  assert.deepEqual(after.worktrees.map(entry => entry.path).sort(), [created.path, target.root].sort());
  assert.equal((await api.projects())[0].folders.length, 2, "the created checkout is recorded as a folder of the project");

  // The operation is addressed by the project's own workspace, as the sidebar addresses it: the checkout's path is
  // the target, not a second workspace to resolve a host from.
  await api.removeWorktree(mainWorkspaceId, created.path, true);
  assert.equal((await api.projects())[0].folders.length, 1, "the removed checkout's folder record went with it");
  // The removed checkout's binding is retained: a conversation already bound there keeps running while it is no longer
  // a target for a new one.
  assert.equal((await api.workspaces()).find(workspace => workspace.id === created.workspaceId)?.retained, true);

  // Every worktree request was the Backend's one route with an operation, and never the retired `?cwd=` listing.
  assert.ok(target.served.includes("POST /api/worktrees"), target.served.join(", "));
  assert.deepEqual(target.served.filter(entry => entry.startsWith("GET /api/worktrees")), []);
});

test("the sidebar document is one Backend route, read and written under the same bearer", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());

  const read = await client.request("/api/sidebar-state", { cache: "no-store" });
  assert.equal(read.status, 200);
  const state = (await read.json()).state;
  assert.deepEqual(state.sessions, {});

  const write = await client.request("/api/sidebar-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "set", ids: ["session-1"], pinned: true }),
  });
  assert.equal(write.status, 200);
  const written = (await write.json()).state;
  assert.ok(typeof written.sessions["session-1"].pinnedAt === "number", "the write answers the state after it");

  // A second window of the same Backend reads the same document, which is what makes a pin shared rather than local.
  const second = await client.request("/api/sidebar-state", { cache: "no-store" });
  assert.ok(typeof (await second.json()).state.sessions["session-1"].pinnedAt === "number");
  assert.deepEqual(target.served.filter(entry => entry.includes("ui-state")), []);
});
