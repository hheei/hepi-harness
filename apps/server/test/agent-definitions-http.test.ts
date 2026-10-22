import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GatewayRpcServer, LocalGateway, SshGateway, gatewayEnvironment, type ExecutionHostEnv } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { pythonSshRunner } from "../../../packages/gateway/test/ssh-transport.ts";
import { createAgentDefinitionsHandler, type AgentDefinitionAnswer } from "../src/agent-definitions-http.ts";
import type { AgentDefinitionHost } from "../src/agent-definitions-store.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../../../packages/gateway/src/workspaces.ts";

interface RequestBody { readonly body?: unknown }
type FakeRequest = IncomingMessage & RequestBody;

function call(handler: ReturnType<typeof createAgentDefinitionsHandler>, method: string, path: string, body?: unknown): Promise<AgentDefinitionAnswer | undefined> {
  const request = { method, body } as FakeRequest;
  return handler(request, new URL("http://backend" + path));
}

function handlerFor(host: () => Promise<AgentDefinitionHost> | AgentDefinitionHost) {
  return createAgentDefinitionsHandler({
    readBody: async (request) => (request as FakeRequest).body,
    resolveHost: async () => ({ ok: true, host: await host() }),
  });
}

async function localFixture(t: { after(fn: () => unknown): void }) {
  const base = await mkdtemp(join(tmpdir(), "hepi-agent-defs-"));
  const home = join(base, "home");
  const root = join(base, "workspace");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(root, { recursive: true });
  const workspaces = new WorkspaceRegistry([{ id: "ws", root }]);
  const files = new LocalFilesystem(workspaces, { identity: { user: "operator", home } });
  const gateway = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
    files,
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const env = gatewayEnvironment({ id: "ws", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" }, "/") as ExecutionHostEnv;
  t.after(async () => { await gateway.close(); await rm(base, { recursive: true, force: true }); });
  return { home, root, env, gateway, userDir: join(home, ".pi", "agent", "agents"), projectDir: join(root, ".pi", "agents") };
}

async function sshFixture(t: { after(fn: () => unknown): void }) {
  const base = await mkdtemp(join(tmpdir(), "hepi-agent-defs-ssh-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(root, { recursive: true });
  const { runner } = pythonSshRunner({ user: "remote-operator", home });
  const profiles = [{ id: "prod", host: "build.example", remoteRoot: root }];
  const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const gateway = new GatewayRpcServer({
    gateway: new SshGateway({ id: "workstation", token: "gateway-token", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner }),
    files: new SshFilesystem({ id: "workstation", profiles, workspaces: sshWorkspaces, runner }),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const env = gatewayEnvironment({ id: "remote-prod", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" }, "/") as ExecutionHostEnv;
  t.after(async () => { await gateway.close(); await rm(base, { recursive: true, force: true }); });
  return { home, root, env, userDir: join(home, ".pi", "agent", "agents") };
}

for (const kind of ["local", "ssh"] as const) {
  test(kind + ": a form save writes one whole document to the selected host and a dry run does not", { timeout: 30000 }, async (t) => {
    const fixture = kind === "local" ? await localFixture(t) : await sshFixture(t);
    const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: kind === "local" ? "ws" : "remote-prod", env: fixture.env }));
    const dry = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "reviewer", dryRun: true, fields: { name: "reviewer", description: "Review", tools: ["read", "write"], context: "fresh", instructions: "Review carefully." } });
    assert.equal(dry?.status, 200, JSON.stringify(dry));
    await assert.rejects(readFile(join(fixture.userDir, "reviewer.md"), "utf8"), /ENOENT/, "a dry run writes nothing");
    const saved = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "reviewer", fields: { name: "reviewer", description: "Review", tools: ["read", "write"], context: "fresh", instructions: "Review carefully." } });
    assert.equal(saved?.status, 200, JSON.stringify(saved));
    const onDisk = await readFile(join(fixture.userDir, "reviewer.md"), "utf8");
    assert.match(onDisk, /name: reviewer/);
    assert.match(onDisk, /Review carefully\./);
    const listed = await call(handler, "GET", "/api/agent-definitions");
    assert.equal(listed?.status, 200);
    const body = listed!.body as { definitions: { name: string; scope: string; tools: string[] }[]; capabilities: { tools: string[] } };
    assert.deepEqual(body.definitions.map((item) => item.name), ["reviewer"]);
    assert.equal(body.definitions[0]!.scope, "user");
    assert.deepEqual(body.definitions[0]!.tools, ["read", "write"]);
    // The list states the vocabulary it will accept, so the panel offers exactly what a save here can keep.
    assert.deepEqual(body.capabilities.tools, ["read", "write", "edit", "bash"]);
  });

  test(kind + ": a tool this build does not install is refused on a dry run and on a real save", { timeout: 30000 }, async (t) => {
    const fixture = kind === "local" ? await localFixture(t) : await sshFixture(t);
    const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: kind === "local" ? "ws" : "remote-prod", env: fixture.env }));
    // A definition that names a tool no request can offer would run with a smaller loadout than it states, so both the
    // validation-only path and the write path refuse it with the same reason and the same field.
    const dry = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "searcher", dryRun: true, fields: { name: "searcher", description: "Search", tools: ["read", "grep"] } });
    assert.equal(dry?.status, 400, JSON.stringify(dry));
    assert.equal((dry!.body as { code: string }).code, "unknown_tool");
    assert.equal((dry!.body as { field: string }).field, "tools");
    const saved = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "searcher", fields: { name: "searcher", description: "Search", tools: ["read", "grep"] } });
    assert.equal(saved?.status, 400, JSON.stringify(saved));
    assert.equal((saved!.body as { code: string }).code, "unknown_tool");
    await assert.rejects(readFile(join(fixture.userDir, "searcher.md"), "utf8"), /ENOENT/, "a refused tool set writes nothing");

    // Every name this build does install is accepted, so the refusal is the vocabulary and not the request.
    const accepted = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "searcher", fields: { name: "searcher", description: "Search", tools: ["read", "write", "edit", "bash"] } });
    assert.equal(accepted?.status, 200, JSON.stringify(accepted));
    assert.match(await readFile(join(fixture.userDir, "searcher.md"), "utf8"), /- bash/);
  });
}

test("project definitions override user definitions and both remain visible", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  for (const scope of ["user", "project"] as const) {
    const answer = await call(handler, "PUT", "/api/agent-definitions", { scope, name: "reviewer", fields: { name: "reviewer", description: scope, context: "fresh", instructions: scope + " body" } });
    assert.equal(answer?.status, 200, JSON.stringify(answer));
  }
  const listed = await call(handler, "GET", "/api/agent-definitions");
  const body = listed!.body as { definitions: { scope: string; description: string }[]; shadowed: { scope: string }[] };
  assert.deepEqual(body.definitions.map((item) => item.scope), ["project"]);
  assert.equal(body.definitions[0]!.description, "project");
  assert.deepEqual(body.shadowed.map((item) => item.scope), ["user"]);
});

test("a save preserves unknown frontmatter and an unedited body", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  await mkdir(fixture.userDir, { recursive: true });
  await writeFile(join(fixture.userDir, "reviewer.md"), "---\nname: reviewer\ndescription: Old\ncustom_field: kept\n---\n\nOld body.\n");
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  const saved = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "reviewer", fields: { description: "New" } });
  assert.equal(saved?.status, 200, JSON.stringify(saved));
  const onDisk = await readFile(join(fixture.userDir, "reviewer.md"), "utf8");
  assert.match(onDisk, /custom_field: kept/);
  assert.match(onDisk, /New/);
  assert.match(onDisk, /Old body\./, "the body the form did not send is untouched");
});

test("a raw document names itself, so the file follows its frontmatter name", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  const saved = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "ignored", document: "---\nname: from-frontmatter\ndescription: Raw\n---\nraw body\n" });
  assert.equal(saved?.status, 200, JSON.stringify(saved));
  assert.equal((saved!.body as { definition: { name: string } }).definition.name, "from-frontmatter");
  assert.match(await readFile(join(fixture.userDir, "from-frontmatter.md"), "utf8"), /raw body/);
  await assert.rejects(readFile(join(fixture.userDir, "ignored.md"), "utf8"), /ENOENT/);
});

test("an unsupported capability is refused and no file is written", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  const answer = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "sneaky", document: "---\nname: sneaky\nmcp_servers:\n  - one\n---\nbody\n" });
  assert.equal(answer?.status, 400, JSON.stringify(answer));
  assert.equal((answer!.body as { code: string }).code, "unsupported_capability");
  await assert.rejects(readFile(join(fixture.userDir, "sneaky.md"), "utf8"), /ENOENT/);
});

test("a definition can be read raw and deleted", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "helper", fields: { name: "helper", context: "fork", instructions: "Help." } });
  const one = await call(handler, "GET", "/api/agent-definitions/document?scope=user&name=helper");
  assert.equal(one?.status, 200);
  assert.match((one!.body as { definition: { raw: string } }).definition.raw, /context: fork/);
  const removed = await call(handler, "DELETE", "/api/agent-definitions?scope=user&name=helper");
  assert.equal(removed?.status, 200);
  await assert.rejects(readFile(join(fixture.userDir, "helper.md"), "utf8"), /ENOENT/);
});

test("an unreachable host fails clearly instead of falling back to a local directory", { timeout: 30000 }, async (t) => {
  const fixture = await localFixture(t);
  await mkdir(fixture.userDir, { recursive: true });
  await writeFile(join(fixture.userDir, "reviewer.md"), "---\nname: reviewer\n---\nbody\n");
  const handler = handlerFor(() => ({ gatewayId: "workstation", workspaceId: "ws", env: fixture.env }));
  await fixture.gateway.close();
  const listed = await call(handler, "GET", "/api/agent-definitions");
  assert.equal(listed?.status, 503, JSON.stringify(listed));
  assert.match((listed!.body as { error: string }).error, /could not be reached/);
  const saved = await call(handler, "PUT", "/api/agent-definitions", { scope: "user", name: "other", fields: { name: "other" } });
  assert.equal(saved?.status, 503, JSON.stringify(saved));
});
