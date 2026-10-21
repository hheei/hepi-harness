import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayRpcServer,
  GatewayWorktrees,
  LocalGateway,
  SshGateway,
  SshWorktreeServer,
  WorkspaceRegistry,
  sshWorkspaceSeed,
  type GitCommandRunner,
  type SshProfile,
  type WorkspaceConfig,
  type WorktreeServer,
} from "../src/index.ts";
import { createFakeSshHost, type FakeSshHost } from "./fake-ssh.ts";

const TOKEN = "worktree-token";

/**
 * One repository on a host, as a first commit leaves it: one branch and one checkout. The host is the in-memory fake
 * in ./fake-ssh.ts, so a create, a removal and git's own refusals are answered from a model of the repository rather
 * than from a git process — and the same model answers the SSH transport, so the local and the remote contract are
 * exercised against one repository, not two machines.
 */
function repository(root = "/srv/repo", branch = "main"): FakeSshHost {
  const fake = createFakeSshHost({ root, user: "builder", home: "/home/builder" });
  fake.initRepository(root, branch);
  return fake;
}

/**
 * A local gateway serving the given workspaces, composed as its entrypoint composes it. \`worktrees\` overrides the
 * worktree surface: \`null\` composes a gateway without one, which is how a host that cannot serve the capability is
 * reached through the public route.
 */
async function startLocalGateway(registry: WorkspaceRegistry, worktrees?: WorktreeServer | null) {
  const server = new GatewayRpcServer(
    new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: [] }),
    undefined,
    undefined,
    undefined,
    undefined,
    worktrees === null ? undefined : worktrees ?? new GatewayWorktrees(registry),
  );
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    registry,
    origin: "http://127.0.0.1:" + address.port,
    close: async () => { await server.close(); },
  };
}

/** One SSH gateway, composed as its entrypoint composes it, over the controlled host's transport. */
async function startSshGateway(workspaces: readonly WorkspaceConfig[], host: FakeSshHost) {
  const registry = new WorkspaceRegistry(workspaces);
  const server = new GatewayRpcServer(
    new SshGateway({ id: "workstation-ssh", token: TOKEN, profiles: [host.profile], allowedCommands: [], runner: host.runner, workspaces: registry }),
    undefined,
    undefined,
    undefined,
    undefined,
    new SshWorktreeServer(registry, { profiles: [host.profile], runner: host.runner }),
  );
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address !== null && typeof address === "object");
  return { registry, origin: "http://127.0.0.1:" + address.port, close: async () => { await server.close(); } };
}

async function rpc(origin: string, body: unknown, token = TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + "/v1/worktrees", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

type Listing = { projectRoot: string; isGit: boolean; isTopLevel: boolean; currentWorktreePath: string | null; worktrees: { path: string; branch: string | null; isMain: boolean }[] };
function listing(result: { body: Record<string, unknown> }): Listing { return result.body.value as Listing; }

test("lists, creates and removes a repository's worktrees through the host's public route", async () => {
  const fake = repository();
  const workspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }]);
  const gateway = await startLocalGateway(workspaces, new GatewayWorktrees(workspaces, fake.git, fake.existingPaths));
  try {
    const listed = await rpc(gateway.origin, { operation: "list", workspaceId: "project" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listing(listed), {
      projectRoot: fake.root,
      isGit: true,
      isTopLevel: true,
      currentWorktreePath: fake.root,
      worktrees: [{ path: fake.root, branch: "main", isMain: true }],
    });

    const worktreePath = fake.root + "-worktrees/feature-one";
    const made = await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "feature/one" });
    assert.deepEqual(made.body, { ok: true, value: { path: worktreePath, branch: "feature/one" } });
    // The checkout is real on the host: the host's own repository reports the branch, and the next listing carries it.
    assert.equal(fake.branchOf(worktreePath), "feature/one");
    const afterCreate = listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" }));
    assert.deepEqual(afterCreate.worktrees.map(entry => [entry.path, entry.branch, entry.isMain]), [
      [fake.root, "main", true],
      [worktreePath, "feature/one", false],
    ]);

    // A second create on the same branch is refused by git itself and leaves the first checkout untouched.
    const again = await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "feature/one" });
    assert.equal(again.body.ok, false);
    assert.equal(again.body.code, "operation_failed");
    assert.equal(fake.branchOf(worktreePath), "feature/one");

    const removed = await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: worktreePath });
    assert.deepEqual(removed.body, { ok: true, value: { removed: worktreePath } });
    assert.equal(fake.exists(worktreePath), false);
    const afterRemove = listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" }));
    assert.deepEqual(afterRemove.worktrees.map(entry => entry.path), [fake.root]);
  } finally {
    await gateway.close();
  }
});

test("refuses a create with no branch, an unknown root or a root that is not a checkout before writing anything", async () => {
  const fake = repository();
  // A registered directory that is no checkout, and one whose directory is gone: the two halves of the root contract.
  fake.mkdir("/srv/plain");
  fake.writeFile("/srv/plain/note.txt", "not a repository\n");
  const absent = "/srv/absent";
  fake.mkdir(absent);
  const workspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }, { id: "plain", root: "/srv/plain" }, { id: "absent", root: absent }]);
  const gateway = await startLocalGateway(workspaces, new GatewayWorktrees(workspaces, fake.git, fake.existingPaths));
  fake.remove(absent);
  try {
    const before = fake.state();

    // No branch, an empty branch and a blank branch are all refused by the contract, not by git.
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "project" })).body, { ok: false, code: "invalid_request", message: "a branch name is required" });
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "" })).body, { ok: false, code: "invalid_request", message: "a branch name is required" });
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "   " })).body, { ok: false, code: "invalid_request", message: "a branch name is required" });
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "///" })).body, { ok: false, code: "invalid_request", message: "invalid branch name: ///" });
    // An unregistered root is unknown, and a registered directory that is no checkout is not a root to create in.
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "missing", branch: "feat" })).body, { ok: false, code: "unknown_workspace" });
    const notGit = await rpc(gateway.origin, { operation: "create", workspaceId: "plain", branch: "feat" });
    assert.equal(notGit.body.ok, false);
    assert.equal(notGit.body.code, "invalid_root");
    const missing = await rpc(gateway.origin, { operation: "create", workspaceId: "absent", branch: "feat" });
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.code, "invalid_root");

    // Nothing was written on the host: no worktree directory, no new branch, no change to the repository's own state.
    assert.deepEqual(fake.state(), before);
    assert.equal(fake.exists(fake.root + "-worktrees"), false);
    assert.deepEqual(fake.worktreesOf(fake.root).map(entry => entry.path), [fake.root]);
  } finally {
    await gateway.close();
  }
});

test("refuses a dirty worktree without force, removes it with force, and never removes the main checkout", async () => {
  const fake = repository();
  const workspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }]);
  const gateway = await startLocalGateway(workspaces, new GatewayWorktrees(workspaces, fake.git, fake.existingPaths));
  try {
    const worktreePath = fake.root + "-worktrees/dirty";
    assert.equal((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "dirty" })).body.ok, true);
    fake.writeFile(worktreePath + "/uncommitted.txt", "work in progress\n");

    const refused = await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: worktreePath });
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.code, "dirty");
    assert.match(String(refused.body.message), /--force/);
    assert.equal(fake.exists(worktreePath + "/uncommitted.txt"), true);
    assert.equal(listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" })).worktrees.length, 2);

    assert.deepEqual((await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: worktreePath, force: true })).body, { ok: true, value: { removed: worktreePath } });
    assert.equal(fake.exists(worktreePath), false);

    // The main checkout is not removable, and a path that is no worktree of this repository is named as such.
    const main = await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: fake.root });
    assert.equal(main.body.ok, false);
    assert.equal(main.body.code, "main_worktree");
    const stranger = await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: "/srv/elsewhere" });
    assert.equal(stranger.body.ok, false);
    assert.equal(stranger.body.code, "not_a_worktree");
    assert.equal((await rpc(gateway.origin, { operation: "remove", workspaceId: "project" })).body.code, "invalid_request");
    assert.equal(fake.exists(fake.root), true);
  } finally {
    await gateway.close();
  }
});

test("falls back to the inferred project root for a worktree that is already gone", async () => {
  const fake = repository();
  const gone = fake.worktree(fake.root, "gone");
  const workspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }, { id: "vanished", root: gone }]);
  const gateway = await startLocalGateway(workspaces, new GatewayWorktrees(workspaces, fake.git, fake.existingPaths));
  try {
    // The checkout is deleted outside the gateway — a stale session cwd is exactly this case.
    fake.remove(gone);

    const listed = listing(await rpc(gateway.origin, { operation: "list", workspaceId: "vanished" }));
    assert.equal(listed.projectRoot, fake.root);
    assert.equal(listed.isGit, true);
    assert.equal(listed.isTopLevel, true);
    assert.equal(listed.currentWorktreePath, null);
    assert.deepEqual(listed.worktrees.map(entry => entry.path), [fake.root]);

    // A root that is no checkout and follows no convention answers an empty listing rather than failing, whether the
    // directory is there or gone.
    fake.mkdir("/srv/plain");
    const absent = "/srv/absent";
    fake.mkdir(absent);
    const plainWorkspaces = new WorkspaceRegistry([{ id: "plain", root: "/srv/plain" }, { id: "absent", root: absent }]);
    const plain = await startLocalGateway(plainWorkspaces, new GatewayWorktrees(plainWorkspaces, fake.git, fake.existingPaths));
    fake.remove(absent);
    try {
      assert.deepEqual(listing(await rpc(plain.origin, { operation: "list", workspaceId: "plain" })), { projectRoot: "/srv/plain", isGit: false, isTopLevel: false, currentWorktreePath: null, worktrees: [] });
      assert.deepEqual(listing(await rpc(plain.origin, { operation: "list", workspaceId: "absent" })), { projectRoot: absent, isGit: false, isTopLevel: false, currentWorktreePath: null, worktrees: [] });
      assert.deepEqual((await rpc(plain.origin, { operation: "list", workspaceId: "nope" })).body, { ok: false, code: "unknown_workspace" });
    } finally { await plain.close(); }
  } finally {
    await gateway.close();
  }
});

test("a host that cannot serve worktree operations answers a named limit, never a generic failure", async () => {
  const fake = repository();
  // A gateway composed without a worktree surface is one kind of such a host.
  const sole = new WorkspaceRegistry([{ id: "project", root: fake.root }]);
  const bare = await startLocalGateway(sole, null);
  // A host whose git cannot be run is another: the host limit is a fact about the host, not about the request.
  const noGit: GitCommandRunner = async () => ({ stdout: "", stderr: "git: command not found", exitCode: 127 });
  const gitlessWorkspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }]);
  const gitless = await startLocalGateway(gitlessWorkspaces, new GatewayWorktrees(gitlessWorkspaces, noGit, fake.existingPaths));
  try {
    for (const body of [{ operation: "list", workspaceId: "project" }, { operation: "create", workspaceId: "project", branch: "feat" }, { operation: "remove", workspaceId: "project", path: fake.root }]) {
      const answer = await rpc(bare.origin, body);
      assert.equal(answer.status, 200);
      assert.equal(answer.body.ok, false);
      assert.equal(answer.body.code, "not_supported", JSON.stringify(answer.body));
      assert.match(String(answer.body.message), /worktree/);
      const limited = await rpc(gitless.origin, body);
      assert.equal(limited.body.ok, false);
      assert.equal(limited.body.code, "not_supported", JSON.stringify(limited.body));
    }
    // A transport that fails names its own state; it never answers from this machine.
    const unreachable = new GatewayWorktrees(sole, async () => { throw Object.assign(new Error("unreachable"), { code: "unreachable" }); }, fake.existingPaths);
    const result = await unreachable.execute({ operation: "list", workspaceId: "project" });
    assert.deepEqual(result, { ok: false, code: "unreachable", message: "unreachable" });
    assert.equal(fake.exists(fake.root + "-worktrees"), false);
  } finally {
    await bare.close();
    await gitless.close();
  }
});

test("the same worktree contract holds on an SSH host", async () => {
  const fake = repository();
  const profile: SshProfile = fake.profile;
  const gateway = await startSshGateway([{ id: "project", root: fake.root, profileId: profile.id }], fake);
  try {
    const listed = listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" }));
    assert.deepEqual(listed.worktrees.map(entry => [entry.path, entry.branch, entry.isMain]), [[fake.root, "main", true]]);
    assert.equal(listed.projectRoot, fake.root);
    assert.equal(listed.currentWorktreePath, fake.root);
    // The listing is the host's answer, carried over the transport: the git argv ran in the root the gateway resolved.
    assert.ok(fake.requests.some(request => request.command[0] === "git" && request.cwd === fake.root && request.root === fake.root));

    const worktreePath = fake.root + "-worktrees/remote-branch";
    assert.deepEqual((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "remote/branch" })).body, { ok: true, value: { path: worktreePath, branch: "remote/branch" } });
    assert.equal(fake.branchOf(worktreePath), "remote/branch");
    assert.deepEqual(listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" })).worktrees.map(entry => entry.path), [fake.root, worktreePath]);

    // The refusals are the local ones: a missing branch, an unknown workspace and a dirty removal.
    assert.equal((await rpc(gateway.origin, { operation: "create", workspaceId: "project", branch: "  " })).body.code, "invalid_request");
    assert.equal((await rpc(gateway.origin, { operation: "create", workspaceId: "nope", branch: "x" })).body.code, "unknown_workspace");
    fake.writeFile(worktreePath + "/uncommitted.txt", "work in progress\n");
    const refused = await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: worktreePath });
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.code, "dirty", JSON.stringify(refused.body));
    assert.equal(fake.exists(worktreePath + "/uncommitted.txt"), true);
    assert.deepEqual((await rpc(gateway.origin, { operation: "remove", workspaceId: "project", path: worktreePath, force: true })).body, { ok: true, value: { removed: worktreePath } });
    assert.equal(fake.exists(worktreePath), false);
    assert.deepEqual(listing(await rpc(gateway.origin, { operation: "list", workspaceId: "project" })).worktrees.map(entry => entry.path), [fake.root]);
  } finally {
    await gateway.close();
  }
});

test("an SSH host whose configured root is a removed worktree still lists the project it belongs to", async () => {
  const fake = repository("/srv/base/repo");
  const repo = fake.root;
  const seed = fake.worktree(repo, "seed");
  // The profile's own configured root is the linked worktree, which is a normal configuration; the project's main
  // checkout is registered beside it, as a folder picked from this host would be.
  const profile: SshProfile = { ...fake.profile, remoteRoot: seed };
  const gateway = await startSshGateway([{ id: "remote-prod", root: seed, profileId: profile.id }, { id: "main", root: repo, profileId: profile.id }], fake);
  try {
    assert.deepEqual(listing(await rpc(gateway.origin, { operation: "list", workspaceId: "remote-prod" })).worktrees.map(entry => entry.path), [repo, seed]);
    assert.deepEqual((await rpc(gateway.origin, { operation: "remove", workspaceId: "main", path: seed })).body, { ok: true, value: { removed: seed } });
    assert.equal(fake.exists(seed), false);

    // The main checkout is still there, so listing it is an ordinary request and not a transport failure.
    const main = await rpc(gateway.origin, { operation: "list", workspaceId: "main" });
    assert.equal(main.status, 200, JSON.stringify(main.body));
    assert.deepEqual(main.body, {
      ok: true,
      value: { projectRoot: repo, isGit: true, isTopLevel: true, currentWorktreePath: repo, worktrees: [{ path: repo, branch: "main", isMain: true }] },
    });
    // The removed worktree's own workspace falls back to the repository it belongs to, exactly as it does locally.
    const fallback = await rpc(gateway.origin, { operation: "list", workspaceId: "remote-prod" });
    assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
    assert.deepEqual(fallback.body, {
      ok: true,
      value: { projectRoot: repo, isGit: true, isTopLevel: true, currentWorktreePath: null, worktrees: [{ path: repo, branch: "main", isMain: true }] },
    });
  } finally {
    await gateway.close();
  }
});

test("an unreachable SSH host reports its own state instead of answering from this machine", async () => {
  const fake = repository();
  const profile: SshProfile = { id: "prod", host: "build.example", remoteRoot: fake.root };
  const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const unreachable = new SshWorktreeServer(registry, { profiles: [profile], runner: { execute: async () => { throw Object.assign(new Error("unreachable"), { code: "unreachable" }); } } });
  assert.deepEqual(await unreachable.execute({ operation: "list", workspaceId: "remote-prod" }), { ok: false, code: "unreachable", message: "unreachable" });
  // A host without git answers the named limit, and never a listing from this machine.
  const noGit = new SshWorktreeServer(registry, { profiles: [profile], runner: { execute: async () => ({ stdout: "", stderr: "git: command not found", exitCode: 127 }) } });
  assert.deepEqual(await noGit.execute({ operation: "create", workspaceId: "remote-prod", branch: "feat" }), { ok: false, code: "not_supported", message: "this host cannot serve worktree operations" });
  // A connection that carried a command and then lost its answer says nothing about whether git ran, so the answer is
  // the transport's own unknown outcome — never this machine's own repository.
  const lost = new SshWorktreeServer(registry, { profiles: [profile], runner: { execute: async () => { throw Object.assign(new Error("ssh outcome unknown"), { code: "outcome_unknown" }); } } });
  const result = await lost.execute({ operation: "list", workspaceId: "remote-prod" });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "outcome_unknown", JSON.stringify(result));
  assert.equal(fake.exists(fake.root + "-worktrees"), false);
  assert.deepEqual(fake.worktreesOf(fake.root).map(entry => entry.path), [fake.root]);
});

test("the worktree surface is authenticated and refuses an unknown operation", async () => {
  const fake = repository();
  const workspaces = new WorkspaceRegistry([{ id: "project", root: fake.root }]);
  const gateway = await startLocalGateway(workspaces, new GatewayWorktrees(workspaces, fake.git, fake.existingPaths));
  try {
    assert.equal((await rpc(gateway.origin, { operation: "list", workspaceId: "project" }, "wrong-token")).status, 401);
    assert.deepEqual((await rpc(gateway.origin, { operation: "prune", workspaceId: "project" })).body, { ok: false, code: "invalid_request", message: "unknown worktree operation" });
    assert.deepEqual((await rpc(gateway.origin, { operation: "list" })).body, { ok: false, code: "invalid_request", message: "a workspace is required" });
    const wrongMethod = await fetch(gateway.origin + "/v1/worktrees", { method: "GET" });
    assert.equal(wrongMethod.status, 404);
  } finally {
    await gateway.close();
  }
});
