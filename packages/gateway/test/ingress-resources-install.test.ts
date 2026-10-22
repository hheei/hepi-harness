import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, SshGateway, SshWorktreeServer, SshWorkspaceServer, WorkspaceRegistry, WorkspaceServer, sshWorkspaceSeed } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { LocalInstallServer, SshInstallServer, REMOTE_INSTALL_SCRIPT } from "../src/install.ts";
import { REMOTE_FILESYSTEM_SCRIPT } from "../src/ssh-filesystem-helper.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { GatewayWorktrees } from "../src/worktrees.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { createProjectStore, type ProjectStore } from "../../../apps/server/src/project-store.ts";
import { createSkillMarket, type MarketFetch } from "../../../apps/server/src/skill-repository.ts";
import { createWorkspaceResources } from "../../../apps/server/src/workspace-resources.ts";
import { startRemoteHost } from "../../../apps/server/test/remote-host.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { pythonSshRunner } from "./ssh-transport.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";

/**
 * Skills, installations and agent definitions through the **client ingress**, on both execution hosts a deployment has.
 *
 * The question this file answers is the ticket's own: does a client operation land on the execution host the Backend
 * resolves for that workspace — a Project folder on this machine, and a Project folder on an SSH host — rather than on
 * the host the entry serves by default? The ingress therefore states its own default host (this machine) and the SSH
 * Project's folder is used anyway; a route that let the entry's default override the binding would write into the
 * local account, which every assertion here would see.
 *
 * Both hosts are real. The local gateway runs the production filesystem, installation and workspace surfaces over a
 * temporary account. The SSH gateway's filesystem and installation helpers are the production Python programs, run
 * through the gateway's own runner contract against a real temporary tree, with the helper's account lookup answered as
 * a different login and home; its workspace surface is the in-process host of apps/server/test/remote-host.ts, which
 * registers the same tree. Nothing in the operator's home or workspace is read or written.
 */

const BACKEND_TOKEN = "ingress-resources-backend-token";
const WEB_LOGIN = "ingress-resources-login";
const LOCAL_GATEWAY = "workstation";
const SSH_GATEWAY = "workstation-ssh";
const NOTES = "---\nname: notes\ndescription: Take notes\n---\n# Notes\n";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Fixture = {
	readonly origin: string;
	readonly backend: BackendServer;
	readonly ingress: ClientIngress;
	readonly store: ProjectStore;
	readonly market: ReturnType<typeof createSkillMarket>;
	readonly local: { readonly home: string; readonly root: string; readonly origin: string; readonly registry: WorkspaceRegistry; readonly gateway: GatewayRpcServer };
	readonly ssh: { readonly home: string; readonly root: string; readonly origin: string; readonly registry: WorkspaceRegistry; readonly gateway: GatewayRpcServer; readonly host: ReturnType<typeof startRemoteHost> };
	close(): Promise<void>;
};

/** One real local gateway, one real SSH gateway over real helpers, one Backend, one client ingress stating its default host. */
async function fixture(): Promise<Fixture> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-resources-")));
	directories.push(base);
	const localHome = join(base, "local-home");
	const localRoot = join(base, "local-repo", "app");
	const remoteHome = join(base, "remote-home");
	const remoteRoot = join(base, "remote-repo", "app");
	for (const path of [localHome, localRoot, remoteHome, remoteRoot]) await mkdir(path, { recursive: true });
	await mkdir(join(localHome, ".pi", "agent"), { recursive: true });
	await mkdir(join(remoteHome, ".pi", "agent"), { recursive: true });

	const localRegistry = new WorkspaceRegistry([{ id: "legacy", root: localRoot }]);
	const localIdentity = { user: "operator", home: localHome };
	const localGateway = new GatewayRpcServer({
		gateway: new LocalGateway({ id: LOCAL_GATEWAY, token: "local-token", workspaces: localRegistry, allowedCommands: ["bash"] }),
		files: new LocalFilesystem(localRegistry, { identity: localIdentity }),
		installs: new LocalInstallServer(localRegistry, { identity: localIdentity }),
		workspaces: new WorkspaceServer(localRegistry, { identity: localIdentity }),
	});
	await new Promise<void>(resolve => localGateway.server.listen(0, "127.0.0.1", resolve));
	const localAddress = localGateway.server.address();
	assert.ok(localAddress && typeof localAddress === "object");

	// The SSH host: its workspace surface and shell are the in-process host, its file and installation helpers are the
	// production Python programs run through the gateway's own runner contract against the same tree.
	const host = startRemoteHost({ root: remoteRoot, user: "builder", home: remoteHome, host: "builder@fake-host" });
	const profiles = [host.profile("prod", remoteRoot)];
	const sshRegistry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
	const files = pythonSshRunner({ user: "builder", home: remoteHome }, REMOTE_FILESYSTEM_SCRIPT);
	const installs = pythonSshRunner({ user: "builder", home: remoteHome }, REMOTE_INSTALL_SCRIPT);
	const sshGateway = new GatewayRpcServer({
		gateway: new SshGateway({ id: SSH_GATEWAY, token: "ssh-token", profiles, allowedCommands: ["bash"], runner: host.runner, workspaces: sshRegistry }),
		files: new SshFilesystem({ id: SSH_GATEWAY, profiles, runner: files.runner, workspaces: sshRegistry }),
		installs: new SshInstallServer({ profiles, runner: installs.runner, workspaces: sshRegistry }),
		workspaces: new SshWorkspaceServer(sshRegistry, { profiles, runner: host.runner }),
		worktrees: new SshWorktreeServer(sshRegistry, { profiles, runner: host.runner }),
	});
	await new Promise<void>(resolve => sshGateway.server.listen(0, "127.0.0.1", resolve));
	const sshAddress = sshGateway.server.address();
	assert.ok(sshAddress && typeof sshAddress === "object");

	const gateways = [
		{ gatewayId: LOCAL_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + localAddress.port, gatewayToken: "local-token" },
		{ gatewayId: SSH_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "ssh-token" },
	];
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const store = createProjectStore({ path: join(base, "projects.sqlite") });
	const credentials = createDeviceCredentials({ path: join(base, "device-credentials.sqlite") });
	const market = createSkillMarket({ path: join(base, "market.sqlite"), fetch: (async () => { throw new Error("offline"); }) as MarketFetch });
	const backend = await createBackendServer({
		dbPath: join(base, "conversations.sqlite"),
		authToken: BACKEND_TOKEN,
		models,
		gateways,
		workspaces: [{ id: "legacy", ...gateways[0]! }],
		projects: store,
		deviceCredentials: credentials,
		skillMarket: market,
		workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }),
		defaultModel: SERVER_MODEL,
	});
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	// The ingress states this machine as the host it serves, which is exactly what must not override a Project's own
	// binding: the SSH Project's folder is on the SSH host, and every operation below has to land there.
	const ingress = createClientIngress({
		backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
		webLoginToken: WEB_LOGIN,
		defaultHostId: LOCAL_GATEWAY,
	});
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	return {
		origin: "http://127.0.0.1:" + ingressAddress.port,
		backend,
		ingress,
		store,
		market,
		local: { home: localHome, root: localRoot, origin: gateways[0]!.gatewayOrigin, registry: localRegistry, gateway: localGateway },
		ssh: { home: remoteHome, root: remoteRoot, origin: gateways[1]!.gatewayOrigin, registry: sshRegistry, gateway: sshGateway, host },
		close: async () => {
			await ingress.close();
			credentials.close();
			backend.server.closeAllConnections();
			await backend.close();
			localGateway.server.closeAllConnections();
			await localGateway.close();
			sshGateway.server.closeAllConnections();
			await sshGateway.close();
			store.close();
			market.close();
		},
	};
}

const json = (headers: Record<string, string>) => ({ ...headers, "content-type": "application/json" });

async function webSession(origin: string): Promise<string> {
	const response = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(response.status, 200);
	return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** One Project on each host, created through the client entry, and the folder ids every operation below names. */
async function projects(app: Fixture, headers: Record<string, string>): Promise<{ local: string; remote: string; remoteId: string }> {
	const create = async (body: unknown): Promise<{ id: string; folders: { workspaceId: string; root: string }[] }> => {
		const response = await fetch(app.origin + "/api/projects", { method: "POST", headers: json(headers), body: JSON.stringify(body) });
		const text = await response.text();
		assert.equal(response.status, 201, text);
		return (JSON.parse(text) as { project: { id: string; folders: { workspaceId: string; root: string }[] } }).project;
	};
	const local = await create({ hostId: LOCAL_GATEWAY, name: "Local", folders: [{ root: app.local.root, default: true }] });
	const remote = await create({ hostId: SSH_GATEWAY, profileId: "prod", name: "Remote", folders: [{ root: app.ssh.root, default: true }] });
	return { local: local.folders[0]!.workspaceId, remote: remote.folders[0]!.workspaceId, remoteId: remote.id };
}

async function publish(app: Fixture, headers: Record<string, string>, version: string, markdown = NOTES): Promise<void> {
	const response = await fetch(app.origin + "/api/skill-market/bundles", { method: "POST", headers: json(headers), body: JSON.stringify({ name: "notes", version, markdown }) });
	assert.equal(response.status, 201, await response.text());
}

const exists = async (path: string): Promise<boolean> => await stat(path).then(() => true, () => false);

test("the selected host's skills are read and written there, on this machine and on the SSH host", { timeout: 120000 }, async () => {
	const app = await fixture();
	try {
		const cookie = await webSession(app.origin);
		const issued = await fetch(app.origin + "/api/device-credentials", { method: "POST", headers: json({ origin: app.origin, cookie }), body: JSON.stringify({ label: "app" }) });
		const device = await issued.json() as { token: string };
		const bearer = { authorization: "Bearer " + device.token };
		const { local, remote } = await projects(app, bearer);
		await publish(app, bearer, "1.0.0");

		// A global installation on the SSH Project's folder: the host that receives it is the SSH host's, so the file is
		// under the remote account's home and the local account's home is untouched.
		const installed = await fetch(app.origin + "/api/skill-market/install", { method: "POST", headers: json(bearer), body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: remote, scope: "global" }) });
		const installedBody = await installed.json() as { installed?: { path: string }; error?: unknown };
		assert.equal(installed.status, 200, JSON.stringify(installedBody));
		assert.equal(installedBody.installed!.path, join(app.ssh.home, ".agents", "skills", "notes"));
		assert.equal(await readFile(join(app.ssh.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
		assert.equal(await exists(join(app.local.home, ".agents", "skills", "notes")), false, "a remote installation was written into this machine's account");

		// The inventory of each host reports that host's own account and that host's own content, through the same entry.
		const inventoryOf = async (workspaceId: string): Promise<{ workspaceId: string; host: { user: string; home: string }; skills: { directory: string; install?: { scope: string; state: string; files: Record<string, string> } }[] }> => {
			const response = await fetch(app.origin + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(workspaceId), { headers: bearer });
			const text = await response.text();
			assert.equal(response.status, 200, text);
			return JSON.parse(text) as never;
		};
		const remoteInventory = await inventoryOf(remote);
		assert.equal(remoteInventory.host.user, "builder", "the inventory named the entry's account instead of the host's");
		assert.equal(remoteInventory.host.home, await realpath(app.ssh.home));
		assert.deepEqual(remoteInventory.skills.map(skill => skill.directory), ["notes"]);
		assert.equal(remoteInventory.skills[0]!.install?.scope, "global");
		assert.equal(remoteInventory.skills[0]!.install?.state, "unchanged");
		const localInventory = await inventoryOf(local);
		assert.equal(localInventory.host.user, "operator");
		assert.deepEqual(localInventory.skills, [], "the local host reported the remote host's installation");

		// The same bundle at the project scope of the local Project folder lands inside that folder, not in an account.
		const scoped = await fetch(app.origin + "/api/skill-market/install", { method: "POST", headers: json(bearer), body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: local, scope: "workspace" }) });
		assert.equal(scoped.status, 200, await scoped.text());
		assert.equal(await readFile(join(app.local.root, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
		assert.equal(await exists(join(app.local.home, ".agents", "skills", "notes")), false, "a project installation was written into the account");

		// A switch writes the document on the host the folder is on. The remote document is edited; the local copy is not.
		const toggled = await fetch(app.origin + "/api/skill-market/skills", { method: "PATCH", headers: json(bearer), body: JSON.stringify({ directories: ["notes"], disableModelInvocation: true, scope: "global", workspaceId: remote }) });
		const toggleBody = await toggled.json() as { results: { directory: string; changed?: boolean; error?: unknown }[] };
		assert.equal(toggled.status, 200, JSON.stringify(toggleBody));
		assert.deepEqual(toggleBody.results, [{ directory: "notes", changed: true }]);
		assert.match(await readFile(join(app.ssh.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), /disable-model-invocation:\s*true/);
		assert.doesNotMatch(await readFile(join(app.local.root, ".agents", "skills", "notes", "SKILL.md"), "utf8"), /disable-model-invocation/);
		// The host's own discovery is what the next read reports, so the switch is visible where it was made.
		const afterToggle = await inventoryOf(remote);
		assert.equal(afterToggle.skills[0]!.install?.state, "locally-modified", "the host's baseline was not compared with the document it now holds");
	} finally {
		await app.close();
	}
});

test("a replacement is pinned to the snapshot the caller inspected, and a stale confirmation is refused on the host", { timeout: 120000 }, async () => {
	const app = await fixture();
	try {
		const cookie = await webSession(app.origin);
		const { remote } = await projects(app, { cookie });
		await publish(app, { cookie }, "1.0.0");
		await publish(app, { cookie }, "1.1.0", NOTES.replace("# Notes", "# Notes v2"));
		const installed = await fetch(app.origin + "/api/skill-market/install", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: remote, scope: "global" }) });
		assert.equal(installed.status, 200, await installed.text());
		// The digest set the panel inspects, which is the snapshot a replacement is pinned to.
		const status = await fetch(app.origin + "/api/skill-market/installed?workspaceId=" + encodeURIComponent(remote) + "&name=notes&scope=global", { headers: { cookie } });
		const body = await status.json() as { skill?: { files: Record<string, string> }; error?: { code?: string; message?: string } };
		assert.equal(status.status, 200, JSON.stringify(body));
		const files = body.skill!.files;

		// An edit on the host, after the caller looked: the update names the digest set it saw, so the host refuses and the
		// edit stays. That is the existing conflict semantics, kept by the entry rather than re-decided there.
		const edited = "---\nname: notes\ndescription: Take notes\n---\n# Edited on the host\n";
		await fetch(app.origin + "/api/skill-market/update", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", workspaceId: remote, scope: "global", files }) }).then(async response => {
			assert.equal(response.status, 200, await response.text());
		});
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(app.ssh.home, ".agents", "skills", "notes", "SKILL.md"), edited);
		const stale = await fetch(app.origin + "/api/skill-market/update", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", workspaceId: remote, scope: "global", files, confirm: true }) });
		const staleBody = await stale.json() as { error?: { code?: string }; state?: string };
		assert.equal(stale.status, 409, JSON.stringify(staleBody));
		assert.equal(staleBody.error?.code, "conflict");
		assert.equal(await readFile(join(app.ssh.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), edited, "the edit was discarded by a stale confirmation");

		// A confirmation the caller did not give is refused before anything is written, and names the state it saw.
		const unconfirmed = await fetch(app.origin + "/api/skill-market/update", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", workspaceId: remote, scope: "global" }) });
		const unconfirmedBody = await unconfirmed.json() as { error?: { code?: string }; state?: string };
		assert.equal(unconfirmed.status, 409);
		assert.equal(unconfirmedBody.error?.code, "confirmation_required");
		assert.equal(unconfirmedBody.state, "locally-modified");
	} finally {
		await app.close();
	}
});

test("an unknown target, an unreachable host and a host without the capability keep their own answers", { timeout: 120000 }, async () => {
	const app = await fixture();
	try {
		const cookie = await webSession(app.origin);
		const { remote } = await projects(app, { cookie });
		await publish(app, { cookie }, "1.0.0");
		const unknown = await fetch(app.origin + "/api/skill-market/inventory?workspaceId=nope", { headers: { cookie } });
		const unknownBody = await unknown.json() as { error?: { code?: string; message?: string } };
		assert.equal(unknown.status, 404);
		// The installer's own word for a workspace this deployment does not bind; the entry does not rename it.
		assert.equal(unknownBody.error?.code, "not_found");
		assert.match(unknownBody.error?.message ?? "", /unknown workspace/);
		// A retained binding is not a target, and the entry does not offer one either.
		assert.equal((await fetch(app.origin + "/api/skill-market/install", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.0.0", scope: "global" }) })).status, 404, "an installation with no workspace named reached a host");

		// The SSH host goes away: the inventory says so instead of reporting an empty host, and the installation reports
		// the host's own unknown outcome rather than a fabricated success.
		app.ssh.gateway.server.closeAllConnections();
		await app.ssh.gateway.close();
		const unreachable = await fetch(app.origin + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(remote), { headers: { cookie } });
		const unreachableBody = await unreachable.json() as { error?: { code?: string; message?: string } };
		assert.equal(unreachable.status, 502, JSON.stringify(unreachableBody));
		assert.equal(unreachableBody.error?.code, "unreachable_host");
		assert.ok((unreachableBody.error?.message ?? "").length > 0, "an unreachable host was reported without a reason");
		// A write the host never received is the host's own refusal, never a fabricated installation: the directory it
		// would publish into is the host's, and a host that cannot be reached says so.
		const failedInstall = await fetch(app.origin + "/api/skill-market/install", { method: "POST", headers: json({ cookie }), body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: remote, scope: "global" }) });
		const failedBody = await failedInstall.json() as { error?: { code?: string; message?: string }; installed?: unknown };
		assert.equal(failedBody.installed, undefined, "an installation against an unreachable host claimed a result: " + JSON.stringify(failedBody));
		assert.ok(failedInstall.status >= 400, "an installation against an unreachable host answered " + failedInstall.status);
		// The request was dispatched and the host's answer never came back, which is an unknown outcome rather than a
		// failure to send: the entry reports the host's own word for it and replays nothing.
		assert.equal(failedBody.error?.code, "outcome_unknown", "the host's own unknown outcome: " + JSON.stringify(failedBody));
	} finally {
		await app.close();
	}
});

test("agent definitions are read, validated, saved and removed on the folder's own host", { timeout: 120000 }, async () => {
	const app = await fixture();
	try {
		const cookie = await webSession(app.origin);
		const { local, remote } = await projects(app, { cookie });
		const query = (workspaceId: string, extra = "") => "/api/agent-definitions?workspaceId=" + encodeURIComponent(workspaceId) + extra;

		const empty = await fetch(app.origin + query(remote), { headers: { cookie } });
		const emptyBody = await empty.json() as { hostId: string; definitions: unknown[]; capabilities: { tools: string[] } };
		assert.equal(empty.status, 200, JSON.stringify(emptyBody));
		assert.equal(emptyBody.hostId, SSH_GATEWAY, "the definition set named the entry's host instead of the folder's");
		assert.deepEqual(emptyBody.definitions, []);
		assert.deepEqual(emptyBody.capabilities.tools, ["read", "write", "edit", "bash"]);

		// A dry run validates and writes nothing on any host.
		const dry = await fetch(app.origin + "/api/agent-definitions", { method: "PUT", headers: json({ cookie }), body: JSON.stringify({ workspaceId: remote, scope: "project", name: "reviewer", dryRun: true, fields: { name: "reviewer", description: "Review", tools: ["read"], context: "fresh", instructions: "Review carefully." } }) });
		assert.equal(dry.status, 200, await dry.text());
		assert.equal(await exists(join(app.ssh.root, ".pi", "agents", "reviewer.md")), false, "a dry run wrote a document");

		const saved = await fetch(app.origin + "/api/agent-definitions", { method: "PUT", headers: json({ cookie }), body: JSON.stringify({ workspaceId: remote, scope: "project", name: "reviewer", fields: { name: "reviewer", description: "Review", tools: ["read"], context: "fresh", instructions: "Review carefully." } }) });
		const savedBody = await saved.json() as { definition: { path: string; hostId: string } };
		assert.equal(saved.status, 200, JSON.stringify(savedBody));
		assert.equal(savedBody.definition.hostId, SSH_GATEWAY);
		assert.equal(savedBody.definition.path, join(app.ssh.root, ".pi", "agents", "reviewer.md"));
		assert.equal(await exists(join(app.ssh.root, ".pi", "agents", "reviewer.md")), true);
		assert.equal(await exists(join(app.local.root, ".pi", "agents", "reviewer.md")), false, "a remote definition was written into this machine's folder");

		// The same name on this machine's own folder is a different document on a different host.
		const localSave = await fetch(app.origin + "/api/agent-definitions", { method: "PUT", headers: json({ cookie }), body: JSON.stringify({ workspaceId: local, scope: "user", name: "reviewer", fields: { name: "reviewer", description: "Local review", tools: ["read"], context: "fresh", instructions: "Local." } }) });
		assert.equal(localSave.status, 200, await localSave.text());
		assert.equal(await exists(join(app.local.home, ".pi", "agent", "agents", "reviewer.md")), true);
		assert.equal(await exists(join(app.ssh.home, ".pi", "agent", "agents", "reviewer.md")), false);

		// The remote list reports its own document, and a capability this build cannot execute is refused with its field.
		const listed = await fetch(app.origin + query(remote), { headers: { cookie } });
		const listedBody = await listed.json() as { definitions: { name: string; instructions: string }[] };
		assert.deepEqual(listedBody.definitions.map(definition => definition.name), ["reviewer"]);
		assert.equal(listedBody.definitions[0]!.instructions, "Review carefully.");
		const unsupported = await fetch(app.origin + "/api/agent-definitions", { method: "PUT", headers: json({ cookie }), body: JSON.stringify({ workspaceId: remote, scope: "project", name: "reviewer", fields: { name: "reviewer", tools: ["mcp:github"] } }) });
		const unsupportedBody = await unsupported.json() as { code?: string; field?: string };
		assert.equal(unsupported.status, 400, JSON.stringify(unsupportedBody));
		assert.equal(unsupportedBody.code, "unsupported_capability");
		assert.equal(unsupportedBody.field, "tools");

		// Removal is the host's, and a folder this deployment does not bind is refused before anything is read.
		const removed = await fetch(app.origin + query(remote, "&scope=project&name=reviewer"), { method: "DELETE", headers: { cookie } });
		assert.equal(removed.status, 200, await removed.text());
		assert.equal(await exists(join(app.ssh.root, ".pi", "agents", "reviewer.md")), false);
		const unbound = await fetch(app.origin + query("nope"), { headers: { cookie } });
		const unboundBody = await unbound.json() as { code?: string };
		assert.equal(unbound.status, 404);
		assert.equal(unboundBody.code, "unknown_workspace");
	} finally {
		await app.close();
	}
});

test("the entry admits the cookie and the device bearer for these operations and refuses an undeclared origin", { timeout: 120000 }, async () => {
	const app = await fixture();
	try {
		const cookie = await webSession(app.origin);
		const { remote } = await projects(app, { cookie });
		// A browser cannot make this call cross-origin with the session cookie: the ingress refuses the origin outright.
		const crossOrigin = await fetch(app.origin + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(remote), { headers: { cookie, origin: "http://unknown.example" } });
		assert.equal(crossOrigin.status, 403);
		// No credential at all is a refusal, and it never reaches the host.
		const anonymous = await fetch(app.origin + "/api/skill-market/inventory?workspaceId=" + encodeURIComponent(remote));
		assert.equal(anonymous.status, 401);
		// The internal execution surface is not served here at all.
		assert.equal((await fetch(app.origin + "/v1/installs", { method: "POST", headers: json({ cookie }), body: "{}" })).status, 404);
	} finally {
		await app.close();
	}
});
