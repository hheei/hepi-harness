/**
 * Ticket 05's public seam: the backend's own HTTP server, its own routes, and a real execution host behind it.
 *
 * The definition routes are exercised through `createBackendServer` — the composition a deployment runs — so this
 * covers the wiring (host resolution, workspace binding, status and reason), not only the handler factory. Both hosts
 * are real gateway processes reached over HTTP: a local gateway serving a temporary account, and an SSH gateway whose
 * account and root live on a *different* host directory, so a definition that reached the backend's own account
 * instead of the workspace's host would be written somewhere this test can see and fail.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { GatewayRpcServer, LocalGateway, SshGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { pythonSshRunner } from "../../../packages/gateway/test/ssh-transport.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../../../packages/gateway/src/workspaces.ts";

const TOKEN = "agent-definitions-route-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const profile = { id: "prod", host: "build.example" };

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "hepi-agent-definitions-route-"));
  const localHome = join(base, "local-home");
  const localRoot = join(base, "local-root");
  const remoteHome = join(base, "remote-home");
  const remoteRoot = join(base, "remote-repo", "app");
  await mkdir(join(localHome, ".pi", "agent"), { recursive: true });
  await mkdir(localRoot, { recursive: true });
  await mkdir(join(remoteHome, ".pi", "agent"), { recursive: true });
  await mkdir(remoteRoot, { recursive: true });

  const localWorkspaces = new WorkspaceRegistry([{ id: "local", root: localRoot }]);
  const local = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: localWorkspaces, allowedCommands: ["bash"] }),
    files: new LocalFilesystem(localWorkspaces, { identity: { user: "operator", home: localHome } }),
  });
  await new Promise<void>((resolve) => local.server.listen(0, "127.0.0.1", resolve));

  const { runner } = pythonSshRunner({ user: "remote-operator", home: remoteHome });
  const profiles = [{ ...profile, remoteRoot }];
  const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const ssh = new GatewayRpcServer({
    gateway: new SshGateway({ id: "ssh-prod", token: "gateway-token", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner }),
    files: new SshFilesystem({ id: "ssh-prod", profiles, workspaces: sshWorkspaces, runner }),
  });
  await new Promise<void>((resolve) => ssh.server.listen(0, "127.0.0.1", resolve));

  const addressOf = (server: GatewayRpcServer) => {
    const address = server.server.address();
    assert.ok(address !== null && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  };
  const gateways = [
    { gatewayId: "workstation", gatewayOrigin: addressOf(local), gatewayToken: "gateway-token" },
    { gatewayId: "ssh-prod", gatewayOrigin: addressOf(ssh), gatewayToken: "gateway-token" },
  ];
  const models = createModels();
  let backend: BackendServer | undefined;
  return {
    base, localHome, localRoot, remoteHome, remoteRoot, gateways, models, local, ssh,
    get backend(): BackendServer { assert.ok(backend !== undefined); return backend; },
    async start() {
      backend = await createBackendServer({
        dbPath: join(base, "conversations.sqlite"),
        authToken: TOKEN,
        models,
        workspaces: [
          { id: "local", gatewayId: "workstation", gatewayOrigin: gateways[0]!.gatewayOrigin, gatewayToken: "gateway-token" },
          { id: "remote-prod", gatewayId: "ssh-prod", gatewayOrigin: gateways[1]!.gatewayOrigin, gatewayToken: "gateway-token" },
        ],
        gateways,
      });
      await new Promise<void>((resolve) => backend!.server.listen(0, "127.0.0.1", resolve));
      const address = backend!.server.address();
      assert.ok(address !== null && typeof address === "object");
      return "http://127.0.0.1:" + address.port;
    },
    async close() {
      backend?.server.closeAllConnections();
      await backend?.close();
      local.server.closeAllConnections();
      await local.close();
      ssh.server.closeAllConnections();
      await ssh.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const call = (origin: string, method: string, path: string, body?: unknown) =>
  fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("the definition route reads and writes the workspace's own host, not the backend's account", { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await f.start();

  const empty = await call(origin, "GET", "/api/agent-definitions?hostId=ssh-prod&workspaceId=remote-prod");
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json() as { definitions: unknown[] }).definitions, []);

  const dry = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "user", name: "reviewer", dryRun: true, fields: { name: "reviewer", description: "Review", tools: ["read", "write"], context: "fresh", instructions: "Review carefully." } });
  assert.equal(dry.status, 200, JSON.stringify(await dry.clone().json()));
  await assert.rejects(readFile(join(f.remoteHome, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /ENOENT/, "a dry run writes no file on the host");

  const saved = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "user", name: "reviewer", fields: { name: "reviewer", description: "Review", tools: ["read", "write"], context: "fresh", instructions: "Review carefully." } });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const onHost = await readFile(join(f.remoteHome, ".pi", "agent", "agents", "reviewer.md"), "utf8");
  assert.match(onHost, /name: reviewer/);
  assert.match(onHost, /Review carefully\./);
  await assert.rejects(readFile(join(f.localHome, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /ENOENT/, "the definition did not land in the backend's own account");

  const document = await call(origin, "GET", "/api/agent-definitions/document?hostId=ssh-prod&workspaceId=remote-prod&scope=user&name=reviewer");
  assert.equal(document.status, 200);
  const view = (await document.json() as { definition: { name: string; scope: string; tools: string[]; hostId: string; path: string } }).definition;
  assert.equal(view.scope, "user");
  assert.equal(view.hostId, "ssh-prod");
  assert.deepEqual(view.tools, ["read", "write"]);
  assert.equal(view.path, join(f.remoteHome, ".pi", "agent", "agents", "reviewer.md"));

  const removed = await call(origin, "DELETE", "/api/agent-definitions?hostId=ssh-prod&workspaceId=remote-prod&scope=user&name=reviewer");
  assert.equal(removed.status, 200);
  await assert.rejects(readFile(join(f.remoteHome, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /ENOENT/);
});

test("the route keeps project over user, preserves unknown frontmatter and refuses an unsupported capability", { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await f.start();
  const save = (scope: string, name: string, fields: Record<string, unknown>) =>
    call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope, name, fields });

  assert.equal((await save("user", "reviewer", { name: "reviewer", description: "user copy", context: "fresh" })).status, 200);
  assert.equal((await save("project", "reviewer", { name: "reviewer", description: "project copy", context: "fork" })).status, 200);

  const listed = await call(origin, "GET", "/api/agent-definitions?hostId=ssh-prod&workspaceId=remote-prod");
  const body = await listed.json() as { definitions: { scope: string; description: string }[]; shadowed: { scope: string }[] };
  assert.equal(body.definitions.length, 1);
  assert.equal(body.definitions[0]!.scope, "project");
  assert.equal(body.definitions[0]!.description, "project copy");
  assert.deepEqual(body.shadowed.map((item) => item.scope), ["user"]);

  // A raw document carries a field this build does not manage: a later form save keeps it.
  const raw = "---\nname: reviewer\ndescription: project copy\ncontext: fork\nmodel: magpie/deepseek-v4.1-flash\nx-extension-note: keep me\n---\nOriginal body.\n";
  const written = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "project", name: "reviewer", document: raw });
  assert.equal(written.status, 200, JSON.stringify(await written.clone().json()));
  assert.equal((await save("project", "reviewer", { name: "reviewer", description: "edited by form", context: "fork" })).status, 200);
  const afterForm = await readFile(join(f.remoteRoot, ".pi", "agents", "reviewer.md"), "utf8");
  assert.match(afterForm, /x-extension-note: keep me/);
  assert.match(afterForm, /Original body\./);
  assert.match(afterForm, /description: edited by form/);

  const unsupported = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "project", name: "reviewer", fields: { name: "reviewer", tools: ["mcp:github"] } });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json() as { code: string }).code, "unsupported_capability");

  // A tool this build does not install is the same refusal over the mounted route, and nothing reaches the host.
  const absent = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "project", name: "searcher", fields: { name: "searcher", tools: ["grep"] } });
  assert.equal(absent.status, 400);
  assert.equal((await absent.json() as { code: string }).code, "unknown_tool");
  await assert.rejects(readFile(join(f.remoteRoot, ".pi", "agents", "searcher.md"), "utf8"), /ENOENT/, "a refused tool set wrote nothing on the host");
});

test("a host the deployment does not serve and an unbound workspace are named refusals", { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await f.start();

  const wrongHost = await call(origin, "GET", "/api/agent-definitions?hostId=workstation&workspaceId=remote-prod");
  assert.equal(wrongHost.status, 409);
  assert.equal((await wrongHost.json() as { code: string }).code, "wrong_host");

  const unbound = await call(origin, "GET", "/api/agent-definitions?hostId=ssh-prod&workspaceId=nope");
  assert.equal(unbound.status, 404);
  assert.equal((await unbound.json() as { code: string }).code, "unknown_workspace");

  const noWorkspace = await call(origin, "GET", "/api/agent-definitions?hostId=ssh-prod");
  assert.equal(noWorkspace.status, 400);
});

test("an unreachable host fails as a 503 and writes nothing anywhere", { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await f.start();
  f.ssh.server.closeAllConnections();
  await f.ssh.close();

  const answer = await call(origin, "PUT", "/api/agent-definitions", { hostId: "ssh-prod", workspaceId: "remote-prod", scope: "user", name: "reviewer", fields: { name: "reviewer", context: "fresh" } });
  assert.equal(answer.status, 503);
  assert.equal((await answer.json() as { code: string }).code, "host_unreachable");
  await assert.rejects(readFile(join(f.remoteHome, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(f.localHome, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /ENOENT/);
});
