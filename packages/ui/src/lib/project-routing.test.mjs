import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { folderRoutingPath, projectGroup, projectGroupKey, projectGroupOfPath, routingLocation, routingPathForRoot, UNBOUND_CWD } = await jiti.import("./project-routing.ts");
const { getRecentProjects } = await jiti.import("./project-groups.ts");
const project = {
  id: "p-1", name: "Chosen Project", hostId: "workstation", defaultFolderId: "f-2",
  folders: [
    { id: "f-1", workspaceId: "alpha", root: "/home/op/alpha", default: false },
    { id: "f-2", workspaceId: "beta", root: "/home/op/beta", default: true },
  ],
};

test("project grouping separates display roots from workspace identity and respects retention", () => {
  const group = projectGroup(project);
  assert.deepEqual(group, {
    key: projectGroupKey("p-1"), name: "Chosen Project", retained: false,
    defaultCwd: folderRoutingPath("beta"), displayRoot: "/home/op/beta",
  });
  for (const folder of project.folders) {
    assert.deepEqual(projectGroupOfPath([project], folderRoutingPath(folder.workspaceId)), group);
  }
  assert.equal(projectGroupOfPath([project], "/workspace/unknown"), null);
  assert.equal(projectGroup({ ...project, folders: [] }), null);
  assert.equal(projectGroup({ ...project, defaultFolderId: "gone" }).defaultCwd, folderRoutingPath("alpha"));
  assert.equal(projectGroup({ ...project, folders: project.folders.map(folder => ({ ...folder, retained: true })) }).retained, true);
});

test("routing requires declared roots and excludes unbound sessions from recent projects", () => {
  assert.deepEqual(routingLocation("/workspace/alpha/src/app.ts"), { workspaceId: "alpha", relativePath: "src/app.ts" });
  for (const path of ["/workspace/", "/workspace", UNBOUND_CWD, "/home/op/alpha"]) {
    assert.equal(routingLocation(path), null, path);
  }
  const locations = [{ workspaceId: "alpha", root: "/home/op/alpha" }];
  assert.equal(routingPathForRoot(locations, "/home/op/alpha/"), folderRoutingPath("alpha"));
  for (const path of ["/home/op/alpha/nested", "/home/op/alphaX"]) {
    assert.equal(routingPathForRoot(locations, path), null);
  }
  const recent = getRecentProjects([
    { id: "1", cwd: UNBOUND_CWD },
    { id: "2", cwd: "/workspace/alpha", projectRoot: "/workspace/alpha", projectKey: "/workspace/alpha" },
  ]);
  assert.deepEqual(recent.map(project => project.root), ["/workspace/alpha"]);
});
