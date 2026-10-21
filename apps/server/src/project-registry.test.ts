/**
 * The project/workspace registry as its own interface: one precedence order, one publication revision, one place that
 * re-asserts a recorded root on its host.
 *
 * These cases use the real ProjectStore (a temp SQLite file) and a real gateway, so what they observe is what the
 * backend really does: the gateway's own registry is the evidence that a root was registered, and the store's rows are
 * the evidence that a mutation was recorded. Nothing here reaches into the module's private snapshot.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { createProjectRegistry, type ProjectRegistry } from "./project-registry.ts";
import { createProjectStore, type ProjectStore } from "./project-store.ts";

const GATEWAY = "workstation";

/** One real gateway on this machine, serving only the workspace surface these cases need. */
async function startGateway() {
  const registry = new WorkspaceRegistry([]);
  const identity = { user: "operator", home: "/tmp" };
  const server = new GatewayRpcServer(
    new LocalGateway({ id: GATEWAY, token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }),
    undefined,
    undefined,
    undefined,
    new WorkspaceServer(registry, { identity }),
  );
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return {
    registry,
    connection: { gatewayId: GATEWAY, gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" },
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

type Fixture = { base: string; store: ProjectStore; directories: string[]; close(): Promise<void> };

/** A real project store in a temp directory, with a directory per root these cases name. */
async function fixture(): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-registry-")));
  const store = createProjectStore({ path: join(directory, "projects.sqlite") });
  const directories: string[] = [];
  for (const name of ["one", "two", "three", "kept"]) {
    const path = join(directory, name);
    await mkdir(path);
    directories.push(path);
  }
  return {
    base: directory,
    store,
    directories,
    close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

/** One recorded project with two folders, its first folder the default. */
function recordProject(store: ProjectStore, root: string, second?: string) {
  return store.create({
    id: "project-1",
    name: "Repo",
    hostId: GATEWAY,
    defaultFolderId: "folder-1",
    folders: [
      { id: "folder-1", workspaceId: "workspace-1", root },
      ...(second === undefined ? [] : [{ id: "folder-2", workspaceId: "workspace-2", root: second }]),
    ],
    createdAt: "2026-10-21T00:00:00.000Z",
  });
}

const CONFIGURED = { id: "legacy", gatewayId: GATEWAY, gatewayOrigin: "http://127.0.0.1:1", gatewayToken: "gateway-token" };

test("resolution follows configured, then retained, then project folders, and reads nothing from a host", async () => {
  const app = await fixture();
  const host = await startGateway();
  const project = recordProject(app.store, app.directories[0]!, app.directories[1]!);
  const [first, second] = project.folders;
  // A configured workspace that happens to share a Project folder's id: the operator's own statement about an id is
  // the first answer, so the folder is never offered under an id the deployment already serves.
  const registry: ProjectRegistry = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection], projects: app.store });
  try {
    // A configured workspace resolves as configured, and states its host and nothing else.
    assert.deepEqual(registry.resolve("legacy"), { kind: "configured", workspaceId: "legacy", gatewayId: GATEWAY });
    assert.deepEqual(registry.catalogueOf("legacy"), { gatewayId: GATEWAY });
    assert.equal(registry.resolve(first!.workspaceId)?.kind, "project");

    // A non-default folder resolves to its own root and to the group whose display root is the default's.
    assert.deepEqual(registry.catalogueOf(second!.workspaceId), {
      gatewayId: GATEWAY,
      root: app.directories[1],
      project: { id: project.id, name: "Repo", defaultWorkspaceId: first!.workspaceId, displayRoot: app.directories[0] },
    });

    // A retained binding resolves exactly like the folder it came from, and says it was retained.
    const removed = app.store.remove(project.id);
    assert.ok(removed.ok);
    const retained = removed.retained[0]!;
    const afterRemoval = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection], projects: app.store });
    assert.deepEqual(afterRemoval.resolve(retained.workspaceId), { kind: "retained", record: retained, gatewayId: GATEWAY });
    assert.deepEqual(afterRemoval.catalogueOf(retained.workspaceId), { gatewayId: GATEWAY, root: retained.root, retained: true });

    // Nothing resolves for an unknown id or for a conversation bound to no workspace.
    assert.equal(afterRemoval.resolve("no-such-workspace"), undefined);
    assert.equal(afterRemoval.resolve(undefined), undefined);
    assert.equal(afterRemoval.catalogueOf(undefined), undefined);
    assert.equal(afterRemoval.bindingOf("no-such-workspace"), undefined);

    // Resolution is this process's own metadata: not one of these reads reached the host.
    assert.deepEqual(host.registry.ids(), []);
  } finally {
    await host.close();
    await app.close();
  }
});

test("targets exclude retained bindings, and only preparation re-asserts a recorded root on its host", async () => {
  const app = await fixture();
  const host = await startGateway();
  const project = recordProject(app.store, app.directories[0]!, app.directories[1]!);
  const [first, second] = project.folders;
  const removed = app.store.remove(app.store.create({
    id: "project-2", name: "Gone", hostId: GATEWAY, defaultFolderId: "folder-3",
    folders: [{ id: "folder-3", workspaceId: "workspace-3", root: app.directories[2]! }],
    createdAt: "2026-10-21T00:00:01.000Z",
  }).id);
  assert.ok(removed.ok);
  const retained = removed.retained[0]!;
  const registry = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection], projects: app.store });
  try {
    // A new operation may name the configured workspace and every recorded folder, and never a retained binding.
    assert.deepEqual(registry.targets().map(binding => binding.id), ["legacy", first!.workspaceId, second!.workspaceId]);
    assert.equal(registry.isTarget(first!.workspaceId), true);
    assert.equal(registry.isTarget(retained.workspaceId), false);
    assert.equal(registry.isTarget("no-such-workspace"), false);

    // The listing answers everything a bound conversation can resolve, each retained binding carrying its marker.
    assert.deepEqual(registry.bindings().map(binding => [binding.id, binding.retained]), [
      ["legacy", undefined], [first!.workspaceId, undefined], [second!.workspaceId, undefined], [retained.workspaceId, true],
    ]);

    // Reading a binding reaches no host; preparation registers the root on the project's own host and answers the
    // transport binding the caller reaches it with.
    assert.deepEqual(registry.bindingOf(second!.workspaceId), { id: second!.workspaceId, gatewayId: GATEWAY, gatewayOrigin: host.connection.gatewayOrigin, gatewayToken: "gateway-token" });
    assert.deepEqual(host.registry.ids(), []);
    const prepared = await registry.ensureBinding(second!.workspaceId);
    assert.equal(prepared?.id, second!.workspaceId);
    assert.equal(host.registry.get(second!.workspaceId)?.root, app.directories[1]);

    // A retained root is re-asserted from the record the removal wrote, and keeps the marker that says it is retained.
    const keptBinding = await registry.ensureBinding(retained.workspaceId);
    assert.deepEqual(keptBinding, { id: retained.workspaceId, gatewayId: GATEWAY, gatewayOrigin: host.connection.gatewayOrigin, gatewayToken: "gateway-token", retained: true });
    assert.equal(host.registry.get(retained.workspaceId)?.root, retained.root);

    // A configured workspace needs no registration at all, and an unknown id prepares nothing.
    assert.equal((await registry.ensureBinding("legacy"))?.id, "legacy");
    assert.equal(await registry.ensureBinding("no-such-workspace"), undefined);
    assert.deepEqual([...host.registry.ids()].sort(), [retained.workspaceId, second!.workspaceId].sort());
  } finally {
    await host.close();
    await app.close();
  }
});

test("boot registration replays every recorded folder and every retained root", async () => {
  const app = await fixture();
  const host = await startGateway();
  try {
    const project = recordProject(app.store, app.directories[0]!, app.directories[1]!);
    const gone = app.store.create({ id: "project-2", name: "Gone", hostId: GATEWAY, defaultFolderId: "folder-3", folders: [{ id: "folder-3", workspaceId: "workspace-3", root: app.directories[2]! }], createdAt: "2026-10-21T00:00:01.000Z" });
    const removed = app.store.remove(gone.id);
    assert.ok(removed.ok);
    const registry = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection], projects: app.store });
    assert.deepEqual(host.registry.ids(), []);
    await registry.registerAll();
    // Every folder of a project, not only its default: a conversation may already run in the other one.
    assert.deepEqual([...host.registry.ids()].sort(), [...project.folders.map(folder => folder.workspaceId), removed.retained[0]!.workspaceId].sort());
    assert.equal(host.registry.get(project.folders[1]!.workspaceId)?.root, app.directories[1]);
    assert.equal(host.registry.get(removed.retained[0]!.workspaceId)?.root, removed.retained[0]!.root);
  } finally {
    await host.close();
    await app.close();
  }
});

test("without a ProjectStore the configured workspaces still resolve, prepare and list, and no mutation is recorded", async () => {
  const host = await startGateway();
  const registry = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection] });
  try {
    assert.deepEqual(registry.resolve("legacy"), { kind: "configured", workspaceId: "legacy", gatewayId: GATEWAY });
    assert.deepEqual(registry.targets().map(binding => binding.id), ["legacy"]);
    assert.deepEqual(registry.bindings().map(binding => binding.id), ["legacy"]);
    assert.equal((await registry.ensureBinding("legacy"))?.id, "legacy");
    assert.deepEqual(registry.projects(), []);
    assert.deepEqual(registry.retained(), []);
    assert.equal(registry.canRecord(), false);
    // A project operation without a store answers its current unavailable outcome instead of writing anything.
    assert.equal(registry.setDefault("project-1", "folder-1"), undefined);
    assert.equal(registry.unlink("project-1", "folder-1"), undefined);
    assert.equal(registry.remove("project-1"), undefined);
    assert.equal(registry.addFolder("project-1", { id: "folder-1", workspaceId: "workspace-1", root: "/tmp" }, "2026-10-21T00:00:00.000Z"), undefined);
    assert.equal(registry.create({ id: "p", name: "n", hostId: GATEWAY, defaultFolderId: "f", folders: [{ id: "f", workspaceId: "w", root: "/tmp" }], createdAt: "2026-10-21T00:00:00.000Z" }), undefined);
    assert.equal(registry.revision(), 0);
  } finally {
    await host.close();
  }
});

test("the publication revision advances once per accepted mutation and never for a read or a refusal", async () => {
  const app = await fixture();
  const host = await startGateway();
  const registry = createProjectRegistry({ workspaces: [CONFIGURED], gateways: [host.connection], projects: app.store });
  try {
    assert.equal(registry.revision(), 0);
    // A read states what the registry holds and moves nothing.
    registry.resolve("legacy");
    registry.projects();
    registry.targets();
    assert.equal(registry.revision(), 0);

    const created = registry.create({
      id: "project-1", name: "Repo", hostId: GATEWAY, defaultFolderId: "folder-1",
      folders: [{ id: "folder-1", workspaceId: "workspace-1", root: app.directories[0]! }, { id: "folder-2", workspaceId: "workspace-2", root: app.directories[1]! }],
      createdAt: "2026-10-21T00:00:00.000Z",
    })!;
    assert.equal(registry.revision(), 1);
    assert.deepEqual(registry.projects().map(project => project.id), [created.id]);

    assert.equal(registry.setDefault(created.id, "folder-2")?.ok, true);
    assert.equal(registry.revision(), 2);
    // A refusal changes neither the snapshot nor the revision.
    assert.equal(registry.setDefault(created.id, "folder-9")?.ok, false);
    assert.equal(registry.revision(), 2);

    const added = registry.addFolder(created.id, { id: "folder-3", workspaceId: "workspace-3", root: app.directories[2]! }, "2026-10-21T00:00:02.000Z");
    assert.ok(added?.ok);
    assert.equal(registry.revision(), 3);

    const unlinked = registry.unlink(created.id, "folder-1")!;
    assert.ok(unlinked.ok);
    assert.equal(registry.revision(), 4);
    // The unlinked folder is retained from here on, and it is still not a target.
    assert.equal(registry.resolve("workspace-1")?.kind, "retained");
    assert.equal(registry.isTarget("workspace-1"), false);

    assert.equal(registry.remove(created.id)?.ok, true);
    assert.equal(registry.revision(), 5);
    assert.deepEqual(registry.projects(), []);
  } finally {
    await host.close();
    await app.close();
  }
});
