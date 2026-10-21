import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { ProjectRouting } from "./project-routing.ts";
import type { SessionInfo } from "./types.ts";

const jiti = createJiti(import.meta.url);
const { folderRoutingPath, projectGroup, projectGroupKey, projectGroupOfPath, routingPathForRoot } = await jiti.import<typeof import("./project-routing.ts")>("./project-routing.ts");
const { workspaceRoutingLocation: routingLocation, UNBOUND_CWD } = await jiti.import<typeof import("@hepi/protocol/files")>("@hepi/protocol/files");
const { getRecentProjects } = await jiti.import<typeof import("./project-groups.ts")>("./project-groups.ts");

const project: ProjectRouting = {
  id: "p-1", name: "Chosen Project", hostId: "workstation", defaultFolderId: "f-2",
  folders: [
    { id: "f-1", workspaceId: "alpha", root: "/home/op/alpha", cwd: "/home/op/alpha", default: false },
    { id: "f-2", workspaceId: "beta", root: "/home/op/beta", cwd: "/home/op/beta", default: true },
  ],
};

/** A listed session as the catalogue serves one; only the fields these routing cases read are stated. */
const listed = (session: Pick<SessionInfo, "id" | "cwd"> & Partial<SessionInfo>): SessionInfo => ({
  path: "", created: "", modified: "2026-01-01T00:00:00Z", messageCount: 0, firstMessage: "", ...session,
});

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
  // A default folder the project no longer holds falls back to the first folder it does hold.
  const reassigned = projectGroup({ ...project, defaultFolderId: "gone" });
  assert.ok(reassigned, "a project with a folder still groups");
  assert.equal(reassigned.defaultCwd, folderRoutingPath("alpha"));
  const retained = projectGroup({ ...project, folders: project.folders.map(folder => ({ ...folder, retained: true })) });
  assert.ok(retained, "a retained project still groups");
  assert.equal(retained.retained, true);
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
    listed({ id: "1", cwd: UNBOUND_CWD }),
    listed({ id: "2", cwd: "/workspace/alpha", projectRoot: "/workspace/alpha", projectKey: "/workspace/alpha" }),
  ]);
  assert.deepEqual(recent.map(project => project.root), ["/workspace/alpha"]);
});
