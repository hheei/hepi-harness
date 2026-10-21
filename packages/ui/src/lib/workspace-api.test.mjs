import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

// The workbench's own modules are read the way both hosts read them: through the bundler-style resolution their
// extension-less relative imports were extracted with.
const jiti = createJiti(import.meta.url);
const {
  createWorkspaceApi,
  configuredDefaultCwd,
  configuredHome,
  configuredWorkspaces,
  workspaceIdentity,
  WorkspaceRefusal,
  WORKTREE_LIMIT_CODES,
} = await jiti.import("./workspace-api.ts");
const { projectGroupKey, UNBOUND_CWD } = await jiti.import("./project-routing.ts");

/**
 * The workspace, project and worktree API as a caller crosses it: one named operation, one Backend route, and the
 * host the deployment stated rather than one this side invents.
 *
 * The transport is a plain function here, because what these cases hold is the request each named operation makes and
 * the answer each one projects — not the connection underneath, which `workspace-api.http.test.mjs` crosses for real.
 */

/** A transport that records what it was asked and answers from the listed routes. */
function transport(routes) {
  const seen = [];
  const request = async (path, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, path, body });
    const key = method + " " + path;
    const answer = routes[key] ?? routes[path];
    if (answer === undefined) throw new Error("the test transport does not answer " + key);
    const [status, payload] = Array.isArray(answer) ? answer : [200, answer];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { seen, request };
}

const configured = { id: "local", gatewayId: "workstation", host: { user: "operator", home: "/home/operator" }, workspaceRoot: "/srv/local" };
const retained = { id: "kept", gatewayId: "workstation", retained: true, workspaceRoot: "/srv/kept" };
const project = {
  id: "project-1",
  name: "Downloads",
  hostId: "workstation",
  defaultFolderId: "folder-1",
  folders: [
    { id: "folder-1", workspaceId: "ws-1", root: "/srv/project", cwd: "/workspace/ws-1", default: true },
    { id: "folder-2", workspaceId: "ws-2", root: "/srv/project-extra", cwd: "/workspace/ws-2", default: false },
  ],
};

test("a local read names no host, and only an explicitly remote target does", async () => {
  const { seen, request } = transport({
    "GET /api/workspaces": { workspaces: [configured] },
    "GET /api/projects": { protocol: "hepi.v1", projects: [project] },
    "GET /api/host/directories": { path: "/srv/local", parentPath: null, directories: [], host: configured.host },
    "GET /api/host/directories?path=%2Fhome%2Foperator&hostId=ssh-1&profileId=staging": { path: "/home/operator", parentPath: null, directories: [], host: { user: "remote", home: "/home/remote" } },
  });
  const api = createWorkspaceApi(request);

  assert.deepEqual(await api.workspaces(), [configured]);
  assert.deepEqual((await api.projects()).map(item => item.id), ["project-1"]);
  // No client names the computer it is served from: the ingress states the deployment's default host, so a local
  // browse carries no hostId and cannot substitute another computer for the one it was admitted to.
  assert.equal((await api.browse()).host.home, "/home/operator");
  // A remote target is the one case a caller names a computer, and it names the gateway and profile the Backend listed.
  assert.equal((await api.browse({ hostId: "ssh-1", profileId: "staging" }, "/home/operator")).host.user, "remote");

  assert.deepEqual(seen.map(entry => entry.method + " " + entry.path), [
    "GET /api/workspaces",
    "GET /api/projects",
    "GET /api/host/directories",
    "GET /api/host/directories?path=%2Fhome%2Foperator&hostId=ssh-1&profileId=staging",
  ]);
});

test("the worktree operation is one route with an operation field, and its refusals keep their own names", async () => {
  const { seen, request } = transport({
    "POST /api/worktrees": (() => {
      // One route answers all three operations; the body decides which, so the transport reads it.
      let list = true;
      return { ok: true, value: { isGit: true, isTopLevel: true, currentWorktreePath: "/srv/project", worktrees: [{ path: "/srv/project", branch: "main", isMain: true, workspaceId: "ws-1" }] } };
    })(),
  });
  const api = createWorkspaceApi(request);

  const listing = await api.listWorktrees("ws-1");
  assert.equal(listing.isTopLevel, true);
  assert.equal(listing.worktrees[0].workspaceId, "ws-1");
  assert.deepEqual(seen[0], { method: "POST", path: "/api/worktrees", body: { workspaceId: "ws-1", operation: "list" } });

  const { seen: created, request: createRequest } = transport({ "POST /api/worktrees": { ok: true, value: { path: "/srv/branch", branch: "feat", workspaceId: "ws-9" } } });
  assert.deepEqual(await createWorkspaceApi(createRequest).createWorktree("ws-1", "feat"), { path: "/srv/branch", branch: "feat", workspaceId: "ws-9" });
  assert.deepEqual(created[0].body, { workspaceId: "ws-1", operation: "create", branch: "feat" });

  const { seen: removed, request: removeRequest } = transport({ "POST /api/worktrees": { ok: true, value: { removed: "/srv/branch" } } });
  await createWorkspaceApi(removeRequest).removeWorktree("ws-1", "/srv/branch", true);
  assert.deepEqual(removed[0].body, { workspaceId: "ws-1", operation: "remove", path: "/srv/branch", force: true });
});

test("a host's own refusal keeps its code, and a dirty checkout says so", async () => {
  const dirty = createWorkspaceApi(transport({ "POST /api/worktrees": [409, { ok: false, code: "dirty", dirty: true, error: "the checkout has uncommitted work" }] }).request);
  await assert.rejects(dirty.removeWorktree("ws-1", "/srv/branch", false), (error) => {
    assert.ok(error instanceof WorkspaceRefusal);
    assert.equal(error.code, "dirty");
    assert.equal(error.dirty, true);
    assert.equal(error.status, 409);
    return true;
  });

  // A host limit is a named outcome rather than a failure, which is what the picker shows where the list would be.
  const limited = createWorkspaceApi(transport({ "POST /api/worktrees": [501, { ok: false, code: "not_supported", error: "this host cannot serve worktree operations" }] }).request);
  await assert.rejects(limited.listWorktrees("ws-1"), (error) => {
    assert.ok(error instanceof WorkspaceRefusal);
    assert.equal(error.code, "not_supported");
    assert.ok(WORKTREE_LIMIT_CODES.has(error.code));
    assert.equal(error.message, "this host cannot serve worktree operations");
    return true;
  });
});

test("home and the default directory are derived from the workspaces and projects the Backend publishes", () => {
  const workspaces = [configured, retained, { id: "ws-1", gatewayId: "workstation", workspaceRoot: "/srv/project" }];
  // A Project folder is a Project location rather than a configured workspace, and a retained binding is never offered
  // back: both the home answer and "use default directory" come from real configured workspaces only.
  assert.deepEqual(configuredWorkspaces(workspaces, [project]).map(workspace => workspace.id), ["local"]);
  assert.equal(configuredHome(workspaces, [project]), "/home/operator");
  assert.equal(configuredDefaultCwd(workspaces, [project]), "/workspace/local");
  // Nothing configured at all: the sentinel, which is no directory on any host.
  assert.equal(configuredHome([retained], [project]), "");
  assert.equal(configuredDefaultCwd([retained], [project]), UNBOUND_CWD);
});

test("a path's identity is its Project group, or its own root as its host reported it", () => {
  const workspaces = [configured, { id: "ws-1", gatewayId: "workstation", workspaceRoot: "/srv/project" }];
  assert.deepEqual(workspaceIdentity(workspaces, [project], "/workspace/ws-1"), {
    root: "/workspace/ws-1",
    key: projectGroupKey("project-1"),
    displayRoot: "/srv/project",
    retained: false,
  });
  // A configured workspace is its own group, addressed and shown by the root its host reported — never by the
  // /workspace/<id> the browser reaches it by.
  assert.deepEqual(workspaceIdentity(workspaces, [project], "/workspace/local"), {
    root: "/workspace/local",
    key: "/workspace/local",
    displayRoot: "/srv/local",
    retained: false,
  });
  // A path no listing states is its own root, exactly as it is addressed.
  assert.deepEqual(workspaceIdentity(workspaces, [project], "/workspace/unknown"), {
    root: "/workspace/unknown",
    key: "/workspace/unknown",
    displayRoot: "/workspace/unknown",
    retained: false,
  });
});

test("project creation, removal and one folder's unlink state the folders and the target they were given", async () => {
  const { seen, request } = transport({
    "POST /api/projects": [201, { project }],
    "DELETE /api/projects/project-1": { project },
    "DELETE /api/projects/project-1/folders/folder-2?defaultFolderId=folder-1": { project: null, removedFolderId: "folder-2" },
  });
  const api = createWorkspaceApi(request);

  // The folders are the choice the user made, and the target is the one the Backend itself listed — never guessed here.
  assert.equal((await api.createProject({ name: "Downloads", folders: [{ root: "/srv/project", default: true }], target: { hostId: "ssh-1", profileId: "staging" } })).id, "project-1");
  assert.deepEqual(seen[0].body, { name: "Downloads", folders: [{ root: "/srv/project", default: true }], hostId: "ssh-1", profileId: "staging" });
  // A local Project names no host: the Backend acts on the host it recorded for the Project.
  assert.equal((await api.removeProject("project-1")).id, "project-1");
  assert.equal(seen[1].path, "/api/projects/project-1");
  // The replacement default a default folder's removal chose rides on the same call, so no Project is left without one.
  assert.deepEqual(await api.unlinkFolder("project-1", "folder-2", "folder-1"), { project: null, removedFolderId: "folder-2" });
});

test("a refusal is thrown with the Backend's own status and reason", async () => {
  const api = createWorkspaceApi(transport({ "GET /api/projects": [409, { code: "configuration_required", error: "this Web origin serves no such host" }] }).request);
  await assert.rejects(api.projects(), (error) => {
    assert.ok(error instanceof WorkspaceRefusal);
    assert.equal(error.status, 409);
    assert.equal(error.code, "configuration_required");
    assert.equal(error.message, "this Web origin serves no such host");
    return true;
  });
});
