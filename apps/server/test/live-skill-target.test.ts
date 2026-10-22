import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createProjectStore, type ProjectStore } from "../src/project-store.ts";
import { createSkillMarket, type MarketFetch } from "../src/skill-repository.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";

const TOKEN = "server-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const NOTES = "---\nname: notes\ndescription: Take notes\n---\n# Notes\n";

const json = async (response: Response): Promise<any> => await response.json();

test("a project registered after boot is an installation target at once", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-live-target-"));
  const home = join(base, "home");
  const legacyRoot = join(base, "legacy");
  const liveRoot = join(base, "live");
  await mkdir(home, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(liveRoot, { recursive: true });

  const registry = new WorkspaceRegistry([{ id: "legacy", root: legacyRoot }]);
  const identity = { user: "operator", home };
  const gateway = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }),
    files: new LocalFilesystem(registry, { identity }),
    installs: new LocalInstallServer(registry, { identity }),
    workspaces: new WorkspaceServer(registry, { identity }),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;

  const market = createSkillMarket({ path: join(base, "market.sqlite"), fetch: (async () => { throw new Error("offline"); }) as MarketFetch });
  const store: ProjectStore = createProjectStore({ path: join(base, "projects.sqlite") });
  const backends: BackendServer[] = [];
  const backend = await createBackendServer({
    dbPath: join(base, "conversations.sqlite"),
    authToken: TOKEN,
    models: createModels(),
    workspaces: [{ id: "legacy", gatewayId: "workstation", gatewayOrigin: origin, gatewayToken: "gateway-token" }],
    gateways: [{ gatewayId: "workstation", gatewayOrigin: origin, gatewayToken: "gateway-token" }],
    projects: store,
    skillMarket: market,
    workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }),
  });
  backends.push(backend);
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  const server = "http://127.0.0.1:" + serverAddress.port;

  t.after(async () => {
    for (const opened of backends) { opened.server.closeAllConnections(); await opened.close(); }
    gateway.server.closeAllConnections(); await gateway.close();
    market.close(); store.close();
    await rm(base, { recursive: true, force: true });
  });

  // The repository holds the bundle before the project exists, so the only thing that changes is the target.
  const published = await fetch(server + "/api/skill-market/bundles", { method: "POST", headers, body: JSON.stringify({ name: "notes", version: "1.0.0", markdown: NOTES }) });
  assert.equal(published.status, 201, await published.text());
  const publishedTwo = await fetch(server + "/api/skill-market/bundles", { method: "POST", headers, body: JSON.stringify({ name: "notes", version: "1.1.0", markdown: NOTES.replace("# Notes", "# Notes v2") }) });
  assert.equal(publishedTwo.status, 201, await publishedTwo.text());

  // A project created through the public endpoint after the backend is already serving. Its folder is registered on the
  // gateway at once, so the execution host itself holds the workspace before any skill request names it.
  const created = await fetch(server + "/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Live", hostId: "workstation", folders: [{ root: liveRoot, default: true }] }) });
  const createdBody = await json(created);
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const workspaceId = createdBody.project.folders[0].workspaceId as string;
  assert.ok(registry.ids().includes(workspaceId), "the gateway registered the new folder");

  // Every skill operation names that freshly registered workspace, in the same running backend: no restart, no
  // conversation, and no boot-time snapshot of the workspace list standing in for the live one.
  const inventory = await fetch(server + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(workspaceId), { headers });
  assert.equal(inventory.status, 200, JSON.stringify(await json(inventory)));

  const installed = await fetch(server + "/api/skill-market/install", { method: "POST", headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId, scope: "workspace" }) });
  const installedBody = await json(installed);
  assert.equal(installed.status, 200, JSON.stringify(installedBody));
  assert.equal(installedBody.installed.name, "notes");

  const listed = await json(await fetch(server + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(workspaceId), { headers }));
  assert.deepEqual(listed.skills.map((skill: { name: string }) => skill.name), ["notes"]);

  const toggled = await fetch(server + "/api/skill-market/skills", { method: "PATCH", headers, body: JSON.stringify({ workspaceId, scope: "workspace", directories: ["notes"], disableModelInvocation: true }) });
  const toggledBody = await json(toggled);
  assert.equal(toggled.status, 200, JSON.stringify(toggledBody));
  assert.deepEqual(toggledBody.results, [{ directory: "notes", changed: true }]);

  const checked = await fetch(server + "/api/skill-market/check?workspaceId=" + encodeURIComponent(workspaceId) + "&scope=workspace&name=notes", { headers });
  assert.equal(checked.status, 200, JSON.stringify(await json(checked)));

  // The switch wrote the document, so the installation really does differ from the bytes that were installed: the
  // state names that, exactly as the built-in smoke asserts for a toggled skill, and the replacement therefore needs
  // the caller's confirmation and the digest set it is replacing.
  const status = await json(await fetch(server + "/api/skill-market/installed?workspaceId=" + encodeURIComponent(workspaceId) + "&scope=workspace&name=notes", { headers }));
  assert.equal(status.skill.state, "locally-modified");

  const updated = await json(await fetch(server + "/api/skill-market/update", { method: "POST", headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", workspaceId, scope: "workspace", confirm: true, files: status.skill.files }) }));
  assert.equal(updated.installed?.version, "1.1.0");

  // The workspace the deployment configured at boot answers exactly as it did; the live lookup adds targets, it does
  // not replace the configured ones.
  const legacy = await fetch(server + "/api/skill-market/inventory?workspaceId=legacy", { headers });
  assert.equal(legacy.status, 200, JSON.stringify(await json(legacy)));
});
