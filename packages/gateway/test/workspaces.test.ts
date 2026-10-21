import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry, WorkspaceServer, type WorkspaceListing } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";

const identity = (home: string) => ({ user: "operator", home });

test("a workspace registry validates an existing canonical directory and keeps a used id stable", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-registry-"));
  try {
    const root = join(base, "project");
    await mkdir(root);
    const registry = new WorkspaceRegistry([{ id: "legacy", root: base }]);
    assert.deepEqual(registry.ids(), ["legacy"]);

    const created = await registry.register("project-1", join(root, "."));
    assert.equal(created.ok, true);
    assert.deepEqual(created.ok ? created.value : undefined, { id: "project-1", root: root, created: true });
    assert.deepEqual(registry.list(), [{ id: "legacy", root: base }, { id: "project-1", root }]);

    // A backend replays its bindings on every start, so the same id and root is idempotent, not a second workspace.
    const again = await registry.register("project-1", root);
    assert.deepEqual(again.ok ? again.value : undefined, { id: "project-1", root, created: false });
    assert.equal(registry.list().length, 2);

    const conflict = await registry.register("project-1", base);
    assert.deepEqual(conflict, { ok: false, code: "workspace_conflict" });
    // The seeded root keeps its configured path: a different root for a seeded id is refused the same way.
    assert.deepEqual(await registry.register("legacy", root), { ok: false, code: "workspace_conflict" });
    assert.deepEqual(await registry.register("legacy", join(base, ".")), { ok: true, value: { id: "legacy", root: base, created: false } });

    assert.deepEqual(await registry.register("gone", join(base, "absent")), { ok: false, code: "invalid_root" });
    assert.deepEqual(await registry.register("gone", "relative/path"), { ok: false, code: "invalid_root" });
    const file = join(base, "note.txt");
    await writeFile(file, "text");
    assert.deepEqual(await registry.register("gone", file), { ok: false, code: "invalid_root" });
    assert.deepEqual(await registry.register("../escape", base), { ok: false, code: "invalid_workspace_id" });
    assert.deepEqual(await registry.register("", base), { ok: false, code: "invalid_workspace_id" });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("workspace browsing lists the host's own directories and nothing else", async () => {
  const home = await mkdtemp(join(tmpdir(), "hepi-browse-home-"));
  try {
    await mkdir(join(home, "beta"));
    await mkdir(join(home, "alpha"));
    await mkdir(join(home, "alpha", "nested"));
    await writeFile(join(home, "alpha", "secret.txt"), "secret");
    await symlink(join(home, "beta"), join(home, "linked"));
    const server = new WorkspaceServer(new WorkspaceRegistry(), { identity: identity(home) });

    // No path names the execution account's home, which is where choosing a folder starts.
    const listing = await server.browse();
    assert.equal(listing.ok, true);
    if (!listing.ok) throw new Error("browse was refused");
    const value = listing.value as WorkspaceListing;
    assert.equal(value.path, home);
    assert.equal(value.parentPath, join(home, ".."));
    assert.deepEqual(value.directories.map(entry => entry.name), ["alpha", "beta"]);
    assert.deepEqual(value.host, { user: "operator", home });

    // Directory names only: a file in the directory and a symlink to one are not offered, and no content is read.
    const nested = await server.browse(join(home, "alpha"));
    assert.deepEqual(nested.ok ? (nested.value as WorkspaceListing).directories.map(entry => entry.name) : undefined, ["nested"]);

    assert.deepEqual(await server.browse(join(home, "absent")), { ok: false, code: "not_found" });
    assert.deepEqual(await server.browse(join(home, "alpha", "secret.txt")), { ok: false, code: "not_a_directory" });
    assert.deepEqual(await server.browse("relative"), { ok: false, code: "invalid_request" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the workspace RPC registers a root that execution, files and workbench serve at once", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-workspaces-rpc-"));
  try {
    const legacyRoot = join(base, "legacy");
    const projectRoot = join(base, "project");
    await mkdir(legacyRoot);
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "note.txt"), "project note");
    const registry = new WorkspaceRegistry([{ id: "legacy", root: legacyRoot }]);
    const gateway = new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] });
    const server = new GatewayRpcServer(gateway, new GatewayWorkbench(registry), new LocalFilesystem(registry), undefined, new WorkspaceServer(registry, { identity: identity(base) }));
    await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    const origin = "http://127.0.0.1:" + address.port;
    const call = async (body: unknown, token = "gateway-token") => {
      const response = await fetch(origin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    try {
      assert.equal((await call({ operation: "list" }, "wrong")).status, 401);
      assert.equal((await call({})).status, 400);

      const registered = await call({ operation: "register", workspaceId: "project-1", root: projectRoot });
      assert.deepEqual(registered.body, { ok: true, value: { id: "project-1", root: projectRoot, created: true } });
      const conflict = await call({ operation: "register", workspaceId: "legacy", root: projectRoot });
      assert.deepEqual(conflict.body, { ok: false, code: "workspace_conflict" });

      // The registration is served without a restart by every surface that shares the registry.
      const listed = await call({ operation: "list" });
      assert.deepEqual(listed.body, { ok: true, value: [{ id: "legacy", root: legacyRoot }, { id: "project-1", root: projectRoot }] });
      const files = await fetch(origin + "/v1/files", { method: "POST", headers: { authorization: "Bearer gateway-token", "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "project-1", method: "listDir", path: "/" }) });
      const filesBody = await files.json() as { ok: boolean; value: { path: string }[] };
      assert.equal(filesBody.ok, true);
      assert.deepEqual(filesBody.value.map(entry => entry.path), ["/note.txt"]);
      const workbench = await fetch(origin + "/v1/workbench", { method: "POST", headers: { authorization: "Bearer gateway-token", "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "project-1", operation: "files" }) });
      assert.deepEqual(await workbench.json(), { ok: true, value: ["note.txt"] });
      // The seeded workspace keeps its own root.
      const legacy = await fetch(origin + "/v1/files", { method: "POST", headers: { authorization: "Bearer gateway-token", "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "legacy", method: "listDir", path: "/" }) });
      assert.equal((await legacy.json() as { ok: boolean }).ok, true);

      const browse = await call({ operation: "browse", path: projectRoot });
      assert.equal(browse.body.ok, true);
    } finally { server.server.closeAllConnections(); await server.close(); }
  } finally { await rm(base, { recursive: true, force: true }); }
});
