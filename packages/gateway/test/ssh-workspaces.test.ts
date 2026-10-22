import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayRpcServer, SshGateway, SshWorkspaceServer, WorkspaceRegistry, type SshProfile, type WorkspaceListing, type WorkspaceProfile } from "../src/index.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { SshInstallServer } from "../src/install.ts";
import { createFakeSshHost, type FakeSshHost } from "./fake-ssh.ts";

const TOKEN = "ssh-token";

/**
 * One SSH gateway, composed as its entrypoint composes it: one registry seeded with the profile's own
 * "remote-<profile>" workspace, one owner resolver behind execution, files, installation and the workspace surface, and
 * one controlled host answering every one of them.
 *
 * The host is the in-memory fake in ./fake-ssh.ts: the transport, the helper programs and the remote account are the
 * fake's, while the gateway's own resolution, validation, framing and error mapping are the code under test. Nothing
 * here opens a socket, starts a daemon or reads this machine's filesystem.
 */
async function startSshGateway(host: FakeSshHost, profiles?: readonly SshProfile[]) {
  const list = profiles ?? [host.profile];
  const registry = new WorkspaceRegistry(list.map(profile => ({ id: "remote-" + profile.id, root: profile.remoteRoot, profileId: profile.id })));
  const runner = host.runner;
  const workspaces = new SshWorkspaceServer(registry, { profiles: list, runner });
  const server = new GatewayRpcServer({
    gateway: new SshGateway({ id: "workstation-ssh", token: TOKEN, profiles: list, allowedCommands: ["sh", "node", "bash"], runner, workspaces: registry }),
    files: new SshFilesystem({ id: "workstation-ssh", profiles: list, runner, workspaces: registry }),
    installs: new SshInstallServer({ profiles: list, runner, workspaces: registry }),
    workspaces,
  });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  return { registry, origin: "http://127.0.0.1:" + address.port, close: async () => { await server.close(); } };
}

async function rpc(origin: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function post(origin: string, route: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(origin + route, { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return await response.json() as Record<string, unknown>;
}

/** One execution's result frame, from the frames the execute route streams. */
async function execute(origin: string, body: unknown): Promise<{ ok: boolean; exitCode?: number; code?: string }> {
  const response = await fetch(origin + "/v1/execute", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as { type: string; result?: { ok: boolean; exitCode?: number; code?: string } });
  const result = frames.find(frame => frame.type === "result");
  assert.ok(result?.result, JSON.stringify(frames));
  return result.result;
}

/** The host the gateway is configured against, with a few directories on it and one file that is not a directory. */
function host(): FakeSshHost {
  const fake = createFakeSshHost({ root: "/srv/app", user: "builder", home: "/home/builder" });
  fake.mkdir("/srv/projects/alpha");
  fake.mkdir("/srv/projects/beta");
  fake.writeFile("/srv/projects/note.txt", "not a directory");
  return fake;
}

test("the SSH workspace surface names the remote account and browses the remote host's own directories", async () => {
  const fake = host();
  const gateway = await startSshGateway(fake);
  try {
    const profiles = await rpc(gateway.origin, { operation: "profiles" });
    assert.equal(profiles.body.ok, true);
    const listed = profiles.body.value as WorkspaceProfile[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "prod");
    assert.equal(listed[0]!.host, fake.profile.host);
    assert.equal(listed[0]!.root, "/srv/app");
    // The account is the host's own answer, not this machine's process account.
    assert.equal(listed[0]!.user, "builder", JSON.stringify(listed[0]));
    assert.equal(listed[0]!.home, "/home/builder");

    // The listing is the host's own: directory names only, with the account that listed them.
    const browsed = await rpc(gateway.origin, { operation: "browse", profileId: "prod", path: "/srv/projects" });
    assert.equal(browsed.body.ok, true);
    const listing = browsed.body.value as WorkspaceListing;
    assert.equal(listing.path, "/srv/projects");
    assert.deepEqual(listing.directories.map(entry => entry.name), ["alpha", "beta"]);
    assert.deepEqual(listing.host, { user: "builder", home: "/home/builder" });
    assert.equal(listing.parentPath, "/srv");

    // A directory the host does not have, a request with no profile and a profile it does not serve are each named.
    assert.deepEqual(await rpc(gateway.origin, { operation: "browse", profileId: "prod", path: "/srv/absent" }), { status: 200, body: { ok: false, code: "not_found" } });
    assert.deepEqual(await rpc(gateway.origin, { operation: "browse", path: "/srv/projects" }), { status: 200, body: { ok: false, code: "invalid_request" } });
    assert.deepEqual(await rpc(gateway.origin, { operation: "browse", profileId: "nope", path: "/srv/projects" }), { status: 200, body: { ok: false, code: "invalid_request" } });
    // The file beside them is not a directory and is never listed as one.
    assert.equal(listing.directories.some(entry => entry.name === "note.txt"), false);
  } finally {
    await gateway.close();
  }
});

test("a folder registered on the SSH host is served by execution, files and installation at once", async () => {
  const fake = host();
  fake.writeFile("/srv/projects/alpha/remote.txt", "content on the ssh host");
  const gateway = await startSshGateway(fake);
  try {
    const registered = await rpc(gateway.origin, { operation: "register", workspaceId: "project-folder-1", root: "/srv/projects/alpha", profileId: "prod" });
    assert.deepEqual(registered.body, { ok: true, value: { id: "project-folder-1", root: "/srv/projects/alpha", created: true } });
    // Idempotent for the same id and root, a conflict for a different one, and refused when the path is not there.
    assert.equal(((await rpc(gateway.origin, { operation: "register", workspaceId: "project-folder-1", root: "/srv/projects/alpha", profileId: "prod" })).body as { value: { created: boolean } }).value.created, false);
    assert.deepEqual(await rpc(gateway.origin, { operation: "register", workspaceId: "project-folder-1", root: "/srv/app", profileId: "prod" }), { status: 200, body: { ok: false, code: "workspace_conflict" } });
    assert.deepEqual(await rpc(gateway.origin, { operation: "register", workspaceId: "missing-folder", root: "/srv/absent", profileId: "prod" }), { status: 200, body: { ok: false, code: "invalid_root" } });
    assert.deepEqual(await rpc(gateway.origin, { operation: "register", workspaceId: "project-folder-2", root: "/srv/projects/alpha" }), { status: 200, body: { ok: false, code: "invalid_request" } });
    assert.equal(gateway.registry.ids().includes("missing-folder"), false);

    // Execution: the command is dispatched in the registered remote folder, and the legacy remote-<profile> id still
    // resolves to the profile's own root. What the gateway resolves is the assertion; the command itself is this
    // host's to answer, and it runs no shell, so its own exit code comes back unchanged.
    const executed = await execute(gateway.origin, { gatewayId: "workstation-ssh", workspaceId: "project-folder-1", callId: "ssh-folder-1", command: ["sh", "-c", "pwd"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(executed.exitCode, 127);
    assert.deepEqual(fake.requests.at(-1)!.command, ["sh", "-c", "pwd"]);
    assert.equal(fake.requests.at(-1)!.cwd, "/srv/projects/alpha");
    assert.equal(fake.requests.at(-1)!.root, "/srv/projects/alpha");
    const legacy = await execute(gateway.origin, { gatewayId: "workstation-ssh", workspaceId: "remote-prod", callId: "ssh-folder-2", command: ["sh", "-c", "pwd"] });
    assert.equal(legacy.ok, true, JSON.stringify(legacy));
    assert.equal(fake.requests.at(-1)!.cwd, "/srv/app");
    assert.equal(fake.requests.at(-1)!.root, "/srv/app");
    const unknown = await execute(gateway.origin, { gatewayId: "workstation-ssh", workspaceId: "remote-nope", callId: "ssh-folder-3", command: ["sh", "-c", "pwd"] });
    assert.equal(unknown.code, "unknown_workspace");

    // Files: the same registration, no restart.
    const fileBody = await post(gateway.origin, "/v1/files", { workspaceId: "project-folder-1", method: "listDir", path: "/" }) as { ok: boolean; value: { path: string }[] };
    assert.equal(fileBody.ok, true, JSON.stringify(fileBody));
    assert.deepEqual(fileBody.value.map(entry => entry.path), ["/remote.txt"]);

    // Installation: the same registration reaches the install surface, which names the folder rather than refusing the
    // workspace. The directory is absent, which is a fact about the host, not an unknown workspace.
    const installBody = await post(gateway.origin, "/v1/installs", { workspaceId: "project-folder-1", operation: "inspectDirectory", scope: "workspace", directory: "sample" }) as { ok: boolean; error?: { code: string } };
    assert.equal(installBody.ok, false);
    assert.equal(installBody.error!.code, "not_found", JSON.stringify(installBody));
  } finally {
    await gateway.close();
  }
});

test("an SSH host without Python 3 reports that, and never a local directory", async () => {
  const registry = new WorkspaceRegistry([{ id: "remote-prod", root: "/srv/app", profileId: "prod" }]);
  const profiles: SshProfile[] = [{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }];
  // A host whose interpreter is not there answers the shell's own words and exit code, which is what a named limit is.
  const runner = { execute: async () => ({ stdout: "", stderr: "sh: python3: command not found", exitCode: 127 }) };
  const workspaces = new SshWorkspaceServer(registry, { profiles, runner });
  assert.deepEqual(await workspaces.execute({ operation: "browse", profileId: "prod" }), { ok: false, code: "not_supported" });
  assert.deepEqual(await workspaces.execute({ operation: "register", workspaceId: "x", root: "/srv/app", profileId: "prod" }), { ok: false, code: "not_supported" });
  // The configured target is still named, with its own account reported as unavailable rather than substituted.
  const listed = await workspaces.execute({ operation: "profiles" });
  assert.equal(listed.ok, true);
  const profile = (listed as { ok: true; value: readonly WorkspaceProfile[] }).value[0]!;
  assert.equal(profile.id, "prod");
  assert.equal(profile.host, "build.example");
  assert.equal(profile.root, "/srv/app");
  assert.equal(profile.user, undefined);
  assert.ok((profile.error ?? "").length > 0);
  // Nothing was registered from a local answer: the registry still holds exactly its seed.
  assert.deepEqual(registry.ids(), ["remote-prod"]);
});
