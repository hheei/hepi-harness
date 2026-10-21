import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayRpcServer, LocalGateway, McpHostService, MemoryLedger, SshGateway, SshWorkspaceServer, WorkspaceRegistry, WorkspaceServer, agentDirOf, sshWorkspaceSeed } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { createFakeSshHost } from "./fake-ssh.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";

/**
 * MCP configuration and project trust through the client ingress, over real HTTP against a real Backend and a real
 * configuration host.
 *
 * This is the public-seam test for ticket 13: the named client operations a Web page or an App calls to read, change
 * and test MCP configuration and to read a folder's trust decision. The configuration, the credentials and every
 * server process belong to the host this origin runs on, so the ingress answers these routes from that host's own
 * `POST /v1/mcp` and never forwards them to the Backend — which is why an answer here is a fact about a file on the
 * host, not about a proxy's memory.
 *
 * The MCP servers the host starts are controlled local fixtures, so nothing here reaches a network, a real provider or
 * a paid call.
 */

const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/stdio-server.mjs", import.meta.url));
/** The fake OAuth-protected server the sign-in runs against, as its own module exports it. */
const OAUTH_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/oauth-server.mjs", import.meta.url));
async function oauthFixture(): Promise<{ url: string; hooks: { beforeCode?: () => Promise<void> }; close: () => Promise<void> }> {
	return (await import(OAUTH_FIXTURE) as { startFakeOAuthServer: () => Promise<any> }).startFakeOAuthServer();
}
async function approveSignIn(page: string): Promise<string> {
	return (await import(OAUTH_FIXTURE) as { approveSignIn: (page: string) => Promise<string> }).approveSignIn(page);
}
const BACKEND_TOKEN = "backend-service-token";
const WEB_LOGIN = "web-login-material";
const GATEWAY_TOKEN = "gateway-token";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const temporary = async (prefix: string): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory; };

type Host = {
	readonly origin: string;
	readonly home: string;
	readonly agentDir: string;
	/** The one folder this host serves, as a workspace id the client addresses it by. */
	readonly folder: string;
	close(): Promise<void>;
};

/** One configuration host: a real gateway serving `POST /v1/mcp` over a registry of one folder. */
async function host(gatewayId = "workstation"): Promise<Host> {
	const base = await temporary("hepi-ingress-mcp-host-");
	const home = join(base, "home");
	const folder = join(home, "project");
	await mkdir(folder, { recursive: true });
	const registry = new WorkspaceRegistry([{ id: "local", root: folder }]);
	const gateway = new LocalGateway({ id: gatewayId, token: GATEWAY_TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	// The workspace surface is what a deployment composes beside MCP, and it is how the Backend learns that this host
	// executes on its own machine: without it the host answers no profile listing at all, which is an unreachable host.
	const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, new WorkspaceServer(registry, { identity: { user: "operator", home } }), undefined, undefined, new McpHostService(agentDirOf(home), registry));
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		home,
		agentDir: agentDirOf(home),
		folder,
		close: async () => { server.server.closeAllConnections(); await server.close(); },
	};
}

/**
 * One configuration host that reaches its folders over SSH, as ADR 0005's split deployment composes it: the gateway
 * executes on the machine a profile names, so the folder it serves is not a folder of the machine this origin runs on.
 */
async function sshHost(gatewayId = "workstation-ssh"): Promise<Host> {
	const base = await temporary("hepi-ingress-mcp-ssh-");
	const home = join(base, "home");
	const folder = join(base, "remote");
	await mkdir(folder, { recursive: true });
	const ssh = createFakeSshHost({ root: folder, user: "builder", home: join(base, "remote-home") });
	const profiles = [ssh.profile];
	const registry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
	const gateway = new SshGateway({ id: gatewayId, token: GATEWAY_TOKEN, profiles, allowedCommands: ["bash"], workspaces: registry, runner: ssh.runner });
	const server = new GatewayRpcServer(gateway, undefined, undefined, undefined, new SshWorkspaceServer(registry, { profiles, runner: ssh.runner }), undefined, undefined, new McpHostService(agentDirOf(home), registry));
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		home,
		agentDir: agentDirOf(home),
		folder,
		close: async () => { server.server.closeAllConnections(); await server.close(); },
	};
}

type Deployment = {
	readonly origin: string;
	readonly host: Host;
	readonly cookie: string;
	readonly device: string;
	/** One admitted call, as the browser (its cookie) or the App (its device bearer) makes it. */
	call(identity: "web" | "device", path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
	close(): Promise<void>;
};

/**
 * One real Backend with device credentials, one client ingress in front of it, and the configuration host it serves.
 * `mcp` states whether that ingress is configured with a host service at all; absent is a deployment that serves no
 * MCP, which is a legitimate deployment and answers a named limit.
 *
 * `binding` is the Backend's own fact about workspace `local`: which gateway it says that workspace is on. It
 * defaults to the configuration host under the gateway id the ingress is told, so a folder-scoped request is verified
 * against a binding that agrees with it — and a test that states another gateway is the collision this surface has to
 * refuse.
 */
async function deployment(options: { host?: Host; serveMcp?: boolean; revocationCheckIntervalMs?: number; mcpGatewayId?: string; binding?: { readonly gatewayId: string; readonly origin: string }; workspaceId?: string } = {}): Promise<Deployment> {
	const directory = await temporary("hepi-ingress-mcp-");
	const configurationHost = options.host ?? await host();
	const binding = options.binding ?? { gatewayId: "workstation", origin: configurationHost.origin };
	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const backend: BackendServer = await createBackendServer({ dbPath: join(directory, "hepi.sqlite"), authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL, deviceCredentials: credentials, buildId: "build-1", backendId: "backend-1", accountScope: "account-1", workspaces: [{ id: options.workspaceId ?? "local", gatewayId: binding.gatewayId, gatewayOrigin: binding.origin, gatewayToken: GATEWAY_TOKEN }], gateways: [{ gatewayId: binding.gatewayId, gatewayOrigin: binding.origin, gatewayToken: GATEWAY_TOKEN }] });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const ingress: ClientIngress = createClientIngress({
		backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
		webLoginToken: WEB_LOGIN,
		appOrigins: ["http://app.example"],
		...(options.serveMcp === false ? {} : { mcp: { origin: configurationHost.origin, token: GATEWAY_TOKEN, gatewayId: options.mcpGatewayId ?? "workstation" } }),
		...(options.revocationCheckIntervalMs === undefined ? {} : { revocationCheckIntervalMs: options.revocationCheckIntervalMs }),
	});
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
	assert.equal(issued.status, 201);
	const device = ((await issued.json()) as { token: string }).token;
	return {
		origin,
		host: configurationHost,
		cookie,
		device,
		call: async (identity, path, init = {}) => {
			const headers: Record<string, string> = identity === "web" ? { cookie } : { authorization: "Bearer " + device };
			if (init.body !== undefined) { headers["content-type"] = "application/json"; headers.origin = origin; }
			else if (init.method !== undefined && init.method !== "GET") headers.origin = origin;
			const response = await fetch(origin + path, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
			return { status: response.status, body: await response.json() as any };
		},
		close: async () => { await ingress.close(); credentials.close(); await backend.close(); if (options.host === undefined) await configurationHost.close(); },
	};
}

/** The global entry an add writes, as the panel's own paste pane sends it. */
const addBody = (name: string) => ({ action: "add", scope: "global", text: JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [STDIO_FIXTURE] } } }) });

test("the client API reads, writes and tests MCP configuration on the configuration host", async () => {
	const d = await deployment();
	try {
		// Nothing is configured yet: the files are named and reported absent, and reading creates nothing.
		const empty = await d.call("web", "/api/mcp");
		assert.equal(empty.status, 200);
		assert.deepEqual(empty.body.files, [{ scope: "global", path: join(d.host.agentDir, "mcp.json"), exists: false, problems: [] }]);
		assert.deepEqual(empty.body.servers, []);

		// One add, as the panel sends it: the pasted text is read here and written to the host's own file.
		const added = await d.call("web", "/api/mcp", { method: "POST", body: addBody("fixture") });
		assert.equal(added.status, 200);
		assert.deepEqual(added.body.added, { scope: "global", name: "fixture", path: join(d.host.agentDir, "mcp.json") });
		assert.equal(added.body.servers.length, 1);
		assert.equal(added.body.servers[0].name, "fixture");
		const written = JSON.parse(await readFile(join(d.host.agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
		assert.deepEqual(written.mcpServers.fixture, { command: process.execPath, args: [STDIO_FIXTURE] });

		// One test, as the App asks for it: the host starts the server and reports what it found.
		const tested = await d.call("device", "/api/mcp/test", { method: "POST", body: { scope: "global", name: "fixture" } });
		assert.equal(tested.status, 200);
		assert.equal(tested.body.result.state, "connected");
		assert.equal(tested.body.result.toolCount, 4);

		// The listing after it carries the test's answer, which is the one fact this surface keeps of its own.
		const listed = await d.call("web", "/api/mcp");
		assert.equal(listed.body.servers[0].status.origin, "test");
		assert.equal(listed.body.servers[0].status.state, "connected");

		// A request the panel could not have sent is refused by the surface's own guard, before the host is asked.
		const exposure = await d.call("web", "/api/mcp", { method: "POST", body: { action: "set-exposure", name: "fixture", exposure: "sometimes" } });
		assert.equal(exposure.status, 400);
		assert.equal(exposure.body.reason, "invalid-request");
		const unknown = await d.call("web", "/api/mcp/nonsense");
		assert.equal(unknown.status, 400);
	} finally { await d.close(); }
});

test("a project folder is read on the host that owns it, and a folder this origin does not serve is refused", async () => {
	const d = await deployment();
	try {
		await mkdir(join(d.host.folder, ".pi"), { recursive: true });
		await writeFile(join(d.host.folder, ".pi/mcp.json"), JSON.stringify({ mcpServers: { "project-fixture": { command: process.execPath, args: [STDIO_FIXTURE] } } }, null, 2) + "\n");

		const listing = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(listing.status, 200);
		assert.equal(listing.body.project.cwd, "/workspace/local");
		assert.deepEqual(listing.body.servers.map((server: any) => [server.scope, server.name]), [["project", "project-fixture"]]);
		// The folder's trust is unrecorded, so the project scope is not offered as trusted and the file is named as it is.
		assert.equal(listing.body.project.trust.trusted, false);
		assert.equal(listing.body.project.trust.requiresTrust, true);

		// A workspace the Backend does not bind to this origin's host is refused before any host is asked, so a name
		// that resolves on this machine is never read as if it were this machine's folder.
		const foreign = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/other-host"));
		assert.equal(foreign.status, 403);
		assert.deepEqual(foreign.body, { error: "This origin serves no such folder", reason: "cwd-denied" });

		// A cwd that is not the routing vocabulary names no folder here at all.
		const nonsense = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/srv/somewhere"));
		assert.equal(nonsense.status, 403);
		assert.equal(nonsense.body.reason, "cwd-denied");

		// The sentinel that means "no folder" leaves the global configuration alone, as it does everywhere else.
		const unbound = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/durable"));
		assert.equal(unbound.status, 200);
		assert.deepEqual(unbound.body.servers, []);
		assert.equal(unbound.body.project, undefined);
	} finally { await d.close(); }
});

test("a folder's trust decision is read from the host that owns the folder", async () => {
	const d = await deployment();
	try {
		await mkdir(join(d.host.folder, ".pi"), { recursive: true });
		await writeFile(join(d.host.folder, ".pi/mcp.json"), JSON.stringify({ mcpServers: { "project-fixture": { command: process.execPath, args: [STDIO_FIXTURE] } } }, null, 2) + "\n");
		await mkdir(d.host.agentDir, { recursive: true });
		await writeFile(join(d.host.agentDir, "trust.json"), JSON.stringify({ [d.host.folder]: true }, null, 2) + "\n");

		const trust = await d.call("web", "/api/project-trust?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(trust.status, 200);
		assert.equal(trust.body.trusted, true);
		assert.equal(trust.body.decision, true);
		assert.equal(trust.body.requiresTrust, true);
		assert.equal(trust.body.mcpFile.path, join(d.host.folder, ".pi/mcp.json"));
		assert.deepEqual(trust.body.mcpServers.map((server: any) => server.name), ["project-fixture"]);

		// Only the read is this route's job: recording a decision asks a person, on the host that owns the folder.
		const write = await d.call("web", "/api/project-trust?cwd=" + encodeURIComponent("/workspace/local"), { method: "POST", body: { decision: true } });
		assert.equal(write.status, 405);
		assert.equal(await (await fetch(d.origin + "/v1/mcp", { method: "POST", headers: { authorization: "Bearer " + GATEWAY_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ operation: "read" }) })).status, 404);
	} finally { await d.close(); }
});

test("an origin with no MCP host service answers a named limit and keeps serving everything else", async () => {
	const d = await deployment({ serveMcp: false });
	try {
		const listed = await d.call("web", "/api/mcp");
		assert.equal(listed.status, 503);
		assert.equal(listed.body.code, "mcp_unavailable");
		assert.match(listed.body.error, /HEPI_INGRESS_MCP_GATEWAY_URL/);
		assert.equal(listed.body.reason, undefined);

		const trust = await d.call("web", "/api/project-trust?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(trust.status, 503);
		assert.equal(trust.body.code, "mcp_unavailable");

		// The named limit is not the whole surface: every other client route still answers.
		const descriptor = await d.call("web", "/api/descriptor");
		assert.equal(descriptor.status, 200);

		// And no identity is admitted for it either: the limit is what a caller that was admitted is told.
		const anonymous = await fetch(d.origin + "/api/mcp");
		assert.equal(anonymous.status, 401);
	} finally { await d.close(); }
});

test("a revoked device credential ends an MCP operation that is in flight", async () => {
	// A host service that never answers: the operation is in flight for as long as the ingress lets it be.
	const seen: string[] = [];
	const hanging: Server = createServer((request, response) => { seen.push(request.url ?? ""); void response; });
	await new Promise<void>(resolve => hanging.listen(0, "127.0.0.1", resolve));
	const address = hanging.address();
	assert.ok(address && typeof address === "object");
	const d = await deployment({ host: { origin: "http://127.0.0.1:" + address.port, home: "", agentDir: "", folder: "", close: async () => undefined }, revocationCheckIntervalMs: 25 });
	try {
		const issued = await fetch(d.origin + "/api/device-credentials", { headers: { cookie: d.cookie } });
		const id = ((await issued.json()) as { credentials: { id: string; label: string }[] }).credentials.find(credential => credential.label === "phone")!.id;
		const started = d.call("device", "/api/mcp");
		// The revocation lands while the host call is out, and the ingress ends the call instead of waiting it out.
		const revoked = await fetch(d.origin + "/api/device-credentials/" + encodeURIComponent(id), { method: "DELETE", headers: { cookie: d.cookie, origin: d.origin } });
		assert.equal(revoked.status, 200);
		const answered = await started;
		assert.equal(answered.status, 503);
		assert.equal(answered.body.code, "mcp_unreachable");
		assert.deepEqual(seen, ["/v1/mcp"]);

		// The next request is refused by the identity check, as a revoked credential is on every other route.
		const afterwards = await d.call("device", "/api/mcp");
		assert.equal(afterwards.status, 401);
	} finally {
		await d.close();
		hanging.closeAllConnections();
		await new Promise<void>(resolve => hanging.close(() => resolve()));
	}
});

test("a workspace the Backend binds to another gateway is refused, even when this host serves the same id", async () => {
	// Two hosts, each with a folder it calls `local`: the configuration host is the one this origin reaches, and the
	// Backend binds that workspace id to a different gateway. A registry is a list of names, so the configuration host
	// would happily answer about its own `local` — which is exactly the folder that must not be touched.
	const execution = await host("execution");
	const configuration = await host("configuration");
	const d = await deployment({ host: configuration, mcpGatewayId: "configuration", binding: { gatewayId: "execution", origin: execution.origin } });
	try {
		for (const target of [execution, configuration]) {
			await mkdir(join(target.folder, ".pi"), { recursive: true });
			await writeFile(join(target.folder, ".pi/mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [STDIO_FIXTURE] } } }, null, 2) + "\n");
			await mkdir(target.agentDir, { recursive: true });
			await writeFile(join(target.agentDir, "trust.json"), JSON.stringify({ [target.folder]: true }, null, 2) + "\n");
		}
		const before = await readFile(join(configuration.folder, ".pi/mcp.json"), "utf8");

		// The binding names another gateway, so neither the listing nor the trust read nor a change is answered here.
		const listing = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(listing.status, 403);
		assert.equal(listing.body.reason, "cwd-denied");
		const trust = await d.call("web", "/api/project-trust?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(trust.status, 403);
		const changed = await d.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/local"), { method: "POST", body: { action: "disable", scope: "project", name: "fixture" } });
		assert.equal(changed.status, 403);

		// Nothing was read and nothing was written: the configuration host's own folder is exactly as it was.
		assert.equal(await readFile(join(configuration.folder, ".pi/mcp.json"), "utf8"), before);
		assert.equal(JSON.parse(before).mcpServers.fixture.enabled, undefined);
	} finally {
		await d.close();
		await configuration.close();
		await execution.close();
	}
});

test("a gateway that executes over SSH profiles serves no folder of its own, and an unreachable host is not this machine", async () => {
	// ADR 0005's split deployment: the configured host reaches its folders through an SSH profile, so a folder the
	// Backend binds to that gateway lives on another machine. The id alone would resolve — the host's own registry
	// holds it — and it must not be served here.
	const ssh = await sshHost();
	const workspaceId = "remote-prod";
	const remote = await deployment({ host: ssh, mcpGatewayId: "workstation-ssh", binding: { gatewayId: "workstation-ssh", origin: ssh.origin }, workspaceId });
	try {
		const listing = await remote.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/" + workspaceId));
		assert.equal(listing.status, 403);
		assert.deepEqual(listing.body, { error: "This origin serves no such folder", reason: "cwd-denied" });
		const trust = await remote.call("web", "/api/project-trust?cwd=" + encodeURIComponent("/workspace/" + workspaceId));
		assert.equal(trust.status, 403);
		assert.equal(trust.body.reason, "cwd-denied");
	} finally {
		await remote.close();
		await ssh.close();
	}

	// A host the Backend cannot ask reports an empty profile list beside its error. That is "nothing was asked", not
	// "asked, and this host serves its own machine": the folder is refused rather than read from here.
	const offline = await host();
	const local = await deployment({ host: offline });
	let stopped = false;
	try {
		assert.equal((await local.call("web", "/api/mcp")).status, 200, "the global configuration is not a folder question");
		await offline.close();
		stopped = true;
		const refused = await local.call("web", "/api/mcp?cwd=" + encodeURIComponent("/workspace/local"));
		assert.equal(refused.status, 403);
		assert.equal(refused.body.reason, "cwd-denied");
	} finally {
		await local.close();
		if (!stopped) await offline.close();
	}
});

test("an App's declared origin writes with its own bearer, while a cross-origin cookie write stays refused", async () => {
	const d = await deployment();
	try {
		const headers = { authorization: "Bearer " + d.device, origin: "http://app.example", "content-type": "application/json" };
		const read = await fetch(d.origin + "/api/mcp", { headers });
		assert.equal(read.status, 200);
		await read.body?.cancel();

		// The bearer is presented deliberately by the App, from the origin this deployment declared for it.
		const write = await fetch(d.origin + "/api/mcp", { method: "POST", headers, body: JSON.stringify(addBody("app-fixture")) });
		assert.equal(write.status, 200);
		assert.equal(((await write.json()) as { added: { name: string } }).added.name, "app-fixture");

		// A cookie is presented by the browser on its own, so its writes stay same-origin: a declared App origin is
		// still not this session's origin, and it cannot make the browser write with a cookie it does not own.
		const crossOriginCookie = await fetch(d.origin + "/api/mcp", { method: "POST", headers: { cookie: d.cookie, origin: "http://app.example", "content-type": "application/json" }, body: JSON.stringify(addBody("cookie-fixture")) });
		assert.equal(crossOriginCookie.status, 403);
		assert.deepEqual(await crossOriginCookie.json(), { error: "origin denied" });

		// The same write from this origin's own page is this session's own write, and it works.
		const sameOrigin = await d.call("web", "/api/mcp", { method: "POST", body: addBody("cookie-fixture") });
		assert.equal(sameOrigin.status, 200);
	} finally { await d.close(); }
});

test("a client that disconnects ends the host call it started", async () => {
	const seen: string[] = [];
	let closed = false;
	const hanging: Server = createServer((request, response) => {
		seen.push(request.url ?? "");
		response.on("close", () => { closed = true; });
	});
	await new Promise<void>(resolve => hanging.listen(0, "127.0.0.1", resolve));
	const address = hanging.address();
	assert.ok(address && typeof address === "object");
	const d = await deployment({ host: { origin: "http://127.0.0.1:" + address.port, home: "", agentDir: "", folder: "", close: async () => undefined } });
	try {
		const controller = new AbortController();
		const pending = fetch(d.origin + "/api/mcp", { headers: { cookie: d.cookie }, signal: controller.signal }).catch(() => undefined);
		for (let attempt = 0; attempt < 200 && seen.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.deepEqual(seen, ["/v1/mcp"]);

		// The caller stops listening; the call that was in flight on the host is ended with it rather than left running.
		controller.abort();
		await pending;
		for (let attempt = 0; attempt < 200 && !closed; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.equal(closed, true, "the host call must end when the client that asked for it is gone");
	} finally {
		await d.close();
		hanging.closeAllConnections();
		await new Promise<void>(resolve => hanging.close(() => resolve()));
	}
});

test("a revoked credential ends a sign-in before the host stores it", async () => {
	const oauth = await oauthFixture();
	const d = await deployment({ revocationCheckIntervalMs: 25 });
	let release = (): void => undefined;
	try {
		let reachedExchange = false;
		const gate = new Promise<void>(resolve => { release = resolve; });
		// The exchange is held open after the code checked out: the provider has not answered yet, and the caller is
		// revoked while the host is in the middle of it.
		oauth.hooks.beforeCode = async () => { reachedExchange = true; await gate; };

		const added = await d.call("web", "/api/mcp", { method: "POST", body: { action: "add", scope: "global", text: JSON.stringify({ mcpServers: { oauth: { url: oauth.url } } }) } });
		assert.equal(added.status, 200);
		const started = await d.call("device", "/api/mcp/sign-in", { method: "POST", body: { scope: "global", name: "oauth" } });
		assert.equal(started.status, 200);
		assert.equal(started.body.phase, "authorize");
		const redirected = await approveSignIn(started.body.authorizationUrl);
		const pasted = d.call("device", "/api/mcp/sign-in/" + started.body.flowId, { method: "POST", body: { redirectUrl: redirected } });
		for (let attempt = 0; attempt < 200 && !reachedExchange; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(reachedExchange, "the host reached the token exchange");

		const devices = await d.call("web", "/api/device-credentials");
		const id = devices.body.credentials.find((credential: { label: string }) => credential.label === "phone").id;
		assert.equal((await d.call("web", "/api/device-credentials/" + id, { method: "DELETE" })).status, 200);

		const ended = await pasted;
		assert.equal(ended.status, 503);
		assert.equal(ended.body.code, "mcp_unreachable");

		// Let the exchange finish: whatever the provider did with it, this host stores no credential for the caller it
		// revoked — and it does not claim the exchange was undone, only that nothing was written here.
		release();
		await new Promise(resolve => setTimeout(resolve, 300));
		const path = join(d.host.agentDir, "mcp-auth.json");
		const stored = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as Record<string, { tokens?: { access_token?: string } }> : {};
		assert.equal(Object.values(stored).some(record => record.tokens?.access_token !== undefined), false, "no credential may be stored for a revoked caller");
	} finally {
		release();
		await new Promise(resolve => setTimeout(resolve, 100));
		await d.close();
		await oauth.close();
	}
});
