import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayRpcServer, LocalGateway, McpHostService, MemoryLedger, WorkspaceRegistry, WorkspaceServer, agentDirOf, localExecutionHostIdentity } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";

// The seam under test is the Web host service's public surface: `POST /v1/mcp` on a real gateway
// process, with the host's own account directory as its configuration store. The MCP servers it
// starts are controlled local fixtures, so nothing here reaches a network, a real provider or a
// paid call, and nothing waits on a sleep: every wait is for an answer or a file the fixture wrote.

const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/stdio-server.ts", import.meta.url));
const OAUTH_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/oauth-server.ts", import.meta.url));
// The fixture's own export, as a type: the sign-in test states what it gets back instead of `any`.
type StartFakeOAuthServer = typeof import("./fixtures/mcp/oauth-server.ts").startFakeOAuthServer;

type Fixture = {
	readonly home: string;
	readonly agentDir: string;
	/** The gateway's own origin, so a test can tell the service's outbound requests from its own calls. */
	readonly origin: string;
	readonly call: (body: unknown, token?: string) => Promise<{ status: number; body: any }>;
	readonly close: () => Promise<void>;
};

/** One gateway process serving the MCP surface, with an account directory of its own. */
async function fixture(): Promise<Fixture> {
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-"));
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const registry = new WorkspaceRegistry([{ id: "local", root: home }]);
	const gateway = new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, undefined, undefined, undefined, new McpHostService(agentDirOf(home)));
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address && typeof address === "object");
	const origin = "http://127.0.0.1:" + address.port;
	return {
		home,
		agentDir: agentDirOf(home),
		origin,
		call: async (body, token = "gateway-token") => {
			const response = await fetch(origin + "/v1/mcp", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
			return { status: response.status, body: await response.json() as any };
		},
		close: async () => {
			server.server.closeAllConnections();
			await server.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

/** A project folder with a trust decision already recorded, as the pi CLI on the same host would leave it. */
async function projectFolder(home: string, name: string): Promise<string> {
	const folder = join(home, name);
	await mkdir(folder, { recursive: true });
	return folder;
}

/** Records a trust decision the way the pi CLI on the same host would, in the host's own trust store. */
async function recordTrust(home: string, folder: string, decision: boolean): Promise<void> {
	const agentDir = agentDirOf(home);
	await mkdir(agentDir, { recursive: true });
	const path = join(agentDir, "trust.json");
	const existing = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> : {};
	await writeFile(path, JSON.stringify({ ...existing, [folder]: decision }, null, 2) + "\n");
}

const stdioEntry = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [STDIO_FIXTURE], ...extra });

test("the host reads, writes and removes MCP configuration in both scopes, with OAuth state beside it", async () => {
	const f = await fixture();
	try {
		// Empty to begin with: the files are named and reported as absent, and nothing is created by reading.
		const empty = await f.call({ operation: "read" });
		assert.equal(empty.status, 200);
		assert.deepEqual(empty.body, { ok: true, value: { files: [{ scope: "global", path: join(f.agentDir, "mcp.json"), exists: false, problems: [] }], servers: [] } });
		assert.equal(existsSync(join(f.agentDir, "mcp.json")), false, "reading MCP configuration creates nothing");

		// A global server, in the upstream shape, and the answer is the listing after the change.
		const added = await f.call({ operation: "write", scope: "global", name: "fixture", config: stdioEntry({ env: { FIXTURE_TOKEN: "literal-secret-value" }, exposure: "direct" }) });
		assert.equal(added.body.ok, true, JSON.stringify(added.body));
		assert.deepEqual(added.body.value.servers.map((server: any) => [server.name, server.scope, server.transport, server.enabled]), [["fixture", "global", "stdio", true]]);
		// No env value is ever reported, only its name.
		assert.deepEqual(added.body.value.servers[0].envNames, ["FIXTURE_TOKEN"]);
		assert.equal(JSON.stringify(added.body).includes("literal-secret-value"), false, "no literal env value is reported");
		const onDisk = JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8"));
		assert.deepEqual(Object.keys(onDisk.mcpServers), ["fixture"]);
		assert.equal(onDisk.mcpServers.fixture.env.FIXTURE_TOKEN, "literal-secret-value", "the file keeps the value the caller wrote");

		// A project server is refused while the folder has no trust decision, and written once it has one.
		const folder = await projectFolder(f.home, "project");
		const refused = await f.call({ operation: "write", scope: "project", cwd: folder, name: "project-server", config: stdioEntry() });
		assert.deepEqual([refused.body.ok, refused.body.code], [false, "project-untrusted"]);
		assert.equal(existsSync(join(folder, ".pi", "mcp.json")), false, "a refused project write creates no file");
		await recordTrust(f.home, folder, true);
		const accepted = await f.call({ operation: "write", scope: "project", cwd: folder, name: "project-server", config: stdioEntry() });
		assert.equal(accepted.body.ok, true, JSON.stringify(accepted.body));
		assert.deepEqual(accepted.body.value.servers.map((server: any) => [server.name, server.scope]), [["fixture", "global"], ["project-server", "project"]]);
		assert.deepEqual(accepted.body.value.files.map((file: any) => [file.scope, file.exists]), [["global", true], ["project", true]]);

		// A refusal names the folder whose recorded decision is what refused it.
		const untrusted = await projectFolder(f.home, "untrusted");
		await recordTrust(f.home, untrusted, false);
		const denied = await f.call({ operation: "write", scope: "project", cwd: untrusted, name: "nope", config: stdioEntry() });
		assert.deepEqual([denied.body.ok, denied.body.code], [false, "project-untrusted"]);
		assert.match(denied.body.message, new RegExp(untrusted.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")));

		// Removing a server removes it from the file and from the listing; a name the file does not define is refused.
		const removed = await f.call({ operation: "write", scope: "project", cwd: folder, name: "project-server" });
		assert.deepEqual(removed.body.value.servers.map((server: any) => server.name), ["fixture"]);
		const missing = await f.call({ operation: "write", scope: "global", name: "absent" });
		assert.deepEqual([missing.body.ok, missing.body.code], [false, "server-missing"]);

		// OAuth state is read beside the configuration, and a sign-out of a server with no OAuth is refused by name.
		await writeFile(join(f.agentDir, "mcp-auth.json"), JSON.stringify({ "mcp__docs|http://127.0.0.1:1/mcp": { serverUrl: "http://127.0.0.1:1/mcp", tokens: { access_token: "access-value", token_type: "Bearer" } } }, null, 2));
		await f.call({ operation: "write", scope: "global", name: "docs", config: { url: "http://127.0.0.1:1/mcp" } });
		const withAuth = await f.call({ operation: "read" });
		const docs = withAuth.body.value.servers.find((server: any) => server.name === "docs");
		assert.deepEqual([docs.transport, docs.usesOAuth, docs.signedIn], ["http", true, true]);
		assert.equal(JSON.stringify(withAuth.body).includes("access-value"), false, "no stored token is reported");
		const notOAuth = await f.call({ operation: "sign-out", scope: "global", name: "fixture" });
		assert.deepEqual([notOAuth.body.ok, notOAuth.body.code], [false, "sign-in-not-oauth"]);
	} finally {
		await f.close();
	}
});

test("an entry is patched key by key, keeping the value of every key the patch does not name", async () => {
	const f = await fixture();
	try {
		const folder = await projectFolder(f.home, "project");
		await recordTrust(f.home, folder, true);
		await f.call({ operation: "write", scope: "global", name: "fixture", config: stdioEntry({ env: { FIXTURE_TOKEN: "literal-secret-value" }, exposure: "direct" }) });

		// A switch is one patch, and the secret the caller never held stays exactly as it was.
		const off = await f.call({ operation: "patch", scope: "global", name: "fixture", patch: { enabled: false } });
		assert.equal(off.body.ok, true, JSON.stringify(off.body));
		assert.equal(off.body.value.servers[0].enabled, false);
		const onDisk = JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8"));
		assert.equal(onDisk.mcpServers.fixture.env.FIXTURE_TOKEN, "literal-secret-value", "a patch keeps the value it did not name");
		assert.deepEqual([onDisk.mcpServers.fixture.exposure, onDisk.mcpServers.fixture.command], ["direct", process.execPath]);

		// Removing a key is a null value; the listing reports what the entry says now.
		const cleared = await f.call({ operation: "patch", scope: "global", name: "fixture", patch: { exposure: null, enabled: true } });
		assert.equal(cleared.body.value.servers[0].enabled, true);
		assert.equal(cleared.body.value.servers[0].exposure, undefined);
		assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8")).mcpServers.fixture).sort(), ["args", "command", "enabled", "env"]);

		// A patch that would leave an invalid entry is refused and writes nothing.
		const invalid = await f.call({ operation: "patch", scope: "global", name: "fixture", patch: { command: "" } });
		assert.deepEqual([invalid.body.ok, invalid.body.code], [false, "server-invalid"]);
		assert.equal(JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8")).mcpServers.fixture.command, process.execPath);

		// An untrusted project's entry is not patched, and a name the file does not define is refused by name.
		const untrusted = await projectFolder(f.home, "untrusted");
		const refused = await f.call({ operation: "patch", scope: "project", cwd: untrusted, name: "fixture", patch: { enabled: false } });
		assert.deepEqual([refused.body.ok, refused.body.code], [false, "project-untrusted"]);
		const missing = await f.call({ operation: "patch", scope: "global", name: "absent", patch: { enabled: false } });
		assert.deepEqual([missing.body.ok, missing.body.code], [false, "server-missing"]);

		// An entry the file holds as something other than an object has no key to change.
		const file = JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8"));
		file.mcpServers["text-entry"] = "not-an-object";
		await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify(file, null, 2) + "\n");
		const notObject = await f.call({ operation: "patch", scope: "global", name: "text-entry", patch: { enabled: false } });
		assert.deepEqual([notObject.body.ok, notObject.body.code], [false, "entry-not-object"]);

		// The listing reports what an entry says about its exposure, its per-tool exposures and its masking, and
		// never a value: the entry below holds a literal header value and a URL that carries a credential.
		await f.call({ operation: "write", scope: "global", name: "described", config: { url: "https://operator:url-password-value@example.test/mcp", headers: { Authorization: "Bearer literal-header-value" }, exposure: "deferred", toolExposure: { search: "direct", fetch: "hidden" } } });
		const described = (await f.call({ operation: "read" })).body.value.servers.find((server: any) => server.name === "described");
		assert.deepEqual([described.exposure, described.toolExposureCount, described.masked, described.headerNames, described.signedIn, described.oauthStateStored], ["deferred", 2, true, ["Authorization"], false, false]);
		assert.equal(JSON.stringify(described).includes("literal-header-value"), false, "no literal header value is reported");
		assert.equal(JSON.stringify(described).includes("url-password-value"), false, "no URL credential is reported");
		const text = (await f.call({ operation: "read" })).body.value.servers.find((server: any) => server.name === "text-entry");
		assert.deepEqual([text.notAnObject, text.masked, text.exposure, text.toolExposureCount], [true, false, undefined, undefined]);

		// A record the OAuth state holds without tokens (a cancelled sign-in's verifier) is stored but not signed in.
		await writeFile(join(f.agentDir, "mcp-auth.json"), JSON.stringify({ ["mcp__described|https://operator:url-password-value@example.test/mcp"]: { serverUrl: "https://operator:url-password-value@example.test/mcp", codeVerifier: "verifier-value" } }, null, 2));
		const withState = (await f.call({ operation: "read" })).body.value.servers.find((server: any) => server.name === "described");
		assert.deepEqual([withState.signedIn, withState.oauthStateStored], [false, true]);
	} finally {
		await f.close();
	}
});

test("a test action starts the server and reports what it found, and a failure reports a masked reason", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "write", scope: "global", name: "fixture", config: stdioEntry() });
		const tested = await f.call({ operation: "test", scope: "global", name: "fixture" });
		assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
		assert.equal(tested.body.value.state, "connected");
		assert.equal(tested.body.value.toolCount, 4);
		assert.deepEqual(tested.body.value.serverInfo, { name: "pi-web-env-fixture", version: "1.0.0" });
		assert.equal(typeof tested.body.value.durationMs, "number");

		// A server that cannot start reports why, and the value it wrote to stderr is masked.
		const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";
		await f.call({ operation: "write", scope: "global", name: "broken", config: stdioEntry({ env: { BROKEN_TOKEN: secret, PI_WEB_FIXTURE_FAIL: "cannot start: token " + secret } }) });
		const failed = await f.call({ operation: "test", scope: "global", name: "broken" });
		assert.equal(failed.body.ok, true, JSON.stringify(failed.body));
		assert.equal(failed.body.value.state, "failed");
		assert.ok(failed.body.value.stderr.length > 0, "the server's own words are reported");
		assert.equal(JSON.stringify(failed.body).includes(secret), false, "no secret appears in any reported reason");
		assert.match(JSON.stringify(failed.body.value.stderr), /•••/);

		// A server that needs a sign-in says so rather than reporting a connection failure.
		const oauth = await startOAuthFixture();
		try {
			await f.call({ operation: "write", scope: "global", name: "oauth", config: { url: oauth.url } });
			const needsAuth = await f.call({ operation: "test", scope: "global", name: "oauth" });
			assert.equal(needsAuth.body.value.state, "needs-auth", JSON.stringify(needsAuth.body));
		} finally {
			await oauth.close();
		}

		// An entry the validator refuses is refused at write time, so it is never stored; one that reached the
		// file some other way (the pi CLI, a hand edit) is reported by a test with the validator's reason.
		const refusedWrite = await f.call({ operation: "write", scope: "global", name: "bad-url", config: { url: "not-a-url" } });
		assert.deepEqual([refusedWrite.body.ok, refusedWrite.body.code], [false, "server-invalid"]);
		assert.match(refusedWrite.body.message, /url must be an http or https URL/);
		const onDisk = JSON.parse(await readFile(join(f.agentDir, "mcp.json"), "utf8"));
		onDisk.mcpServers["bad-url"] = { url: "not-a-url" };
		await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify(onDisk, null, 2) + "\n");
		const invalid = await f.call({ operation: "test", scope: "global", name: "bad-url" });
		assert.deepEqual([invalid.body.ok, invalid.body.code], [false, "server-invalid"]);
		const listedInvalid = await f.call({ operation: "read" });
		assert.match(listedInvalid.body.value.servers.find((server: any) => server.name === "bad-url").invalidError, /url must be an http or https URL/);
	} finally {
		await f.close();
	}
});

test("sign-in and sign-out change the host's OAuth state against the controlled fake", async () => {
	const f = await fixture();
	const oauth = await startOAuthFixture();
	try {
		await f.call({ operation: "write", scope: "global", name: "oauth", config: { url: oauth.url } });
		const started = await f.call({ operation: "sign-in", scope: "global", name: "oauth" });
		assert.equal(started.body.ok, true, JSON.stringify(started.body));
		const flow = started.body.value;
		assert.equal(flow.phase, "authorize");
		assert.ok(flow.authorizationUrl.startsWith(oauth.origin + "/authorize"), "the fake's own sign-in page is offered");
		assert.ok(flow.expiresInMs > 0);
		// The flow reports where to sign in and how long it waits, and nothing else: no client registration,
		// no PKCE verifier, no state and no token reaches a caller.
		assert.deepEqual(Object.keys(flow).sort(), ["authorizationUrl", "expiresInMs", "flowId", "name", "phase", "redirectUrl", "scope"]);

		// The user approves at the fake's page and pastes back the address the browser was sent to.
		const redirected = await approve(flow.authorizationUrl);
		const pasted = await f.call({ operation: "sign-in-paste", flowId: flow.flowId, redirectUrl: redirected });
		assert.equal(pasted.body.ok, true, JSON.stringify(pasted.body));
		assert.equal(pasted.body.value.phase, "done", JSON.stringify(pasted.body.value));
		assert.equal(pasted.body.value.result.state, "connected");
		assert.deepEqual(pasted.body.value.result.serverInfo, { name: "oauth-fixture", version: "1.0.0" });

		// The host's own OAuth state now holds the tokens the fake issued, and no token is reported to a caller.
		const auth = JSON.parse(await readFile(join(f.agentDir, "mcp-auth.json"), "utf8"));
		const stored = Object.values(auth)[0] as any;
		assert.ok(oauth.issued.access.has(stored.tokens.access_token), "the stored access token is the one the fake issued");
		assert.equal(JSON.stringify(pasted.body).includes(stored.tokens.access_token), false, "no token is reported");

		// A second server's sign-in adds its own record and keeps the first one: the file is merged, not replaced.
		await f.call({ operation: "write", scope: "global", name: "oauth-two", config: { url: oauth.url } });
		const secondStarted = await f.call({ operation: "sign-in", scope: "global", name: "oauth-two" });
		const secondPasted = await f.call({ operation: "sign-in-paste", flowId: secondStarted.body.value.flowId, redirectUrl: await approve(secondStarted.body.value.authorizationUrl) });
		assert.equal(secondPasted.body.value.phase, "done", JSON.stringify(secondPasted.body.value));
		const merged = JSON.parse(await readFile(join(f.agentDir, "mcp-auth.json"), "utf8"));
		assert.deepEqual(Object.keys(merged).sort(), ["mcp__oauth|" + oauth.url, "mcp__oauth_two|" + oauth.url].sort(), "a second sign-in keeps the record the first one stored");

		// Sign-in is idempotent for a server that already holds tokens, and the listing says it is signed in.
		const again = await f.call({ operation: "sign-in", scope: "global", name: "oauth" });
		assert.equal(again.body.value.alreadySignedIn, true);
		const listed = await f.call({ operation: "read" });
		assert.equal(listed.body.value.servers.find((server: any) => server.name === "oauth").signedIn, true);

		// Sign-out removes exactly that server's credentials, and the listing says so.
		const signedOut = await f.call({ operation: "sign-out", scope: "global", name: "oauth" });
		assert.deepEqual(signedOut.body.value, { scope: "global", name: "oauth", removed: true });
		const afterSignOut = await f.call({ operation: "read" });
		assert.equal(afterSignOut.body.value.servers.find((server: any) => server.name === "oauth").signedIn, false);
		const secondSignOut = await f.call({ operation: "sign-out", scope: "global", name: "oauth" });
		assert.deepEqual(secondSignOut.body.value, { scope: "global", name: "oauth", removed: false });
		assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.agentDir, "mcp-auth.json"), "utf8"))), ["mcp__oauth_two|" + oauth.url], "signing out one server leaves the other's record");

		// A pasted address that is not this sign-in's is refused and the flow keeps waiting.
		const restarted = await f.call({ operation: "sign-in", scope: "global", name: "oauth" });
		const wrongState = await f.call({ operation: "sign-in-paste", flowId: restarted.body.value.flowId, redirectUrl: "http://127.0.0.1/callback?code=x&state=not-this-one" });
		assert.deepEqual([wrongState.body.ok, wrongState.body.code], [false, "redirect-state-mismatch"]);
		assert.equal(wrongState.body.flow.phase, "authorize", "the flow keeps waiting after a refused paste");
		const cancelled = await f.call({ operation: "sign-in-cancel", flowId: restarted.body.value.flowId });
		assert.equal(cancelled.body.value.phase, "cancelled");
		assert.equal(cancelled.body.value.expiresInMs, 0);
	} finally {
		await oauth.close();
		await f.close();
	}
});

test("a project-scoped test and sign-in read the folder's own file, not the global one", async () => {
	const f = await fixture();
	const oauth = await startOAuthFixture();
	try {
		const folder = await projectFolder(f.home, "project");
		await recordTrust(f.home, folder, true);
		// A stdio server defined only in the project's file: a test that read the global file instead
		// would report server-missing, so the outcome is what proves which file the folder's scope reads.
		await f.call({ operation: "write", scope: "project", cwd: folder, name: "project-fixture", config: stdioEntry() });
		const tested = await f.call({ operation: "test", scope: "project", cwd: folder, name: "project-fixture" });
		assert.equal(tested.body.value.state, "connected", JSON.stringify(tested.body));
		assert.equal(tested.body.value.toolCount, 4);

		// The same holds for a sign-in: the entry, and the server it connects to afterwards, come from the
		// folder's file, so a project server's flow is not silently read from the global configuration.
		await f.call({ operation: "write", scope: "project", cwd: folder, name: "project-oauth", config: { url: oauth.url } });
		const started = await f.call({ operation: "sign-in", scope: "project", cwd: folder, name: "project-oauth" });
		assert.equal(started.body.ok, true, JSON.stringify(started.body));
		const approved = await approve(started.body.value.authorizationUrl);
		const signedIn = await f.call({ operation: "sign-in-paste", flowId: started.body.value.flowId, redirectUrl: approved });
		assert.equal(signedIn.body.value.phase, "done", JSON.stringify(signedIn.body.value));
		assert.equal(signedIn.body.value.result.state, "connected");
		assert.deepEqual(signedIn.body.value.result.serverInfo, { name: "oauth-fixture", version: "1.0.0" });
	} finally {
		await oauth.close();
		await f.close();
	}
});

test("a gateway host that serves no MCP answers a named limit, and the rest of the surface keeps working", async () => {
	// An SSH gateway serves execution and files on a remote host; MCP belongs to the Web host's own account,
	// so the MCP operation is absent rather than silently answered with the remote host's files.
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-none-"));
	try {
		const registry = new WorkspaceRegistry([{ id: "local", root: base }]);
		const gateway = new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
		const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, new WorkspaceServer(registry, { identity: { user: "operator", home: base } }));
		await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
		const address = server.server.address();
		assert.ok(address && typeof address === "object");
		const origin = "http://127.0.0.1:" + address.port;
		const post = async (path: string, body: unknown) => (await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer gateway-token", "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; code?: string; message?: string }>;
		try {
			assert.deepEqual(await post("/v1/mcp", { operation: "read" }), { ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" });
			// The neighbouring capabilities answer as they always did.
			assert.equal((await post("/v1/files", { workspaceId: "local", method: "listDir", path: "/" })).ok, true);
			assert.equal((await post("/v1/workspaces", { operation: "list" })).ok, true);
			assert.equal((await post("/v1/execute", { gatewayId: "workstation", workspaceId: "local", callId: "call-1", command: ["bash", "-c", "true"] })).ok, undefined, "the streaming execute surface still answers frames");
		} finally {
			server.server.closeAllConnections();
			await server.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("no MCP secret is sent to the durable backend, because the host service talks to nothing else", async () => {
	const f = await fixture();
	const oauth = await startOAuthFixture();
	// Every outbound request the host service makes is recorded, so "nothing reaches the backend" is an
	// observation rather than a claim about the code: the service is the only thing running that fetches.
	const requested: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		requested.push(String(input instanceof Request ? input.url : input));
		return realFetch(input as never, init);
	}) as typeof fetch;
	try {
		const secret = "{{BACKEND_LEAK_CANARY_7f31}}";
		await f.call({ operation: "write", scope: "global", name: "leaky", config: stdioEntry({ env: { LEAK_TOKEN: secret, PI_WEB_FIXTURE_FAIL: "failed with " + secret } }) });
		const tested = await f.call({ operation: "test", scope: "global", name: "leaky" });
		await f.call({ operation: "write", scope: "global", name: "oauth", config: { url: oauth.url, headers: { "X-Api-Key": secret } } });
		const started = await f.call({ operation: "sign-in", scope: "global", name: "oauth" });
		const approved = await approve(started.body.value.authorizationUrl);
		const signedIn = await f.call({ operation: "sign-in-paste", flowId: started.body.value.flowId, redirectUrl: approved });
		const signedOut = await f.call({ operation: "sign-out", scope: "global", name: "oauth" });
		const read = await f.call({ operation: "read" });

		// The whole cycle's answers are what any transport carries, and none of them holds the secret.
		for (const answer of [tested, started, signedIn, signedOut, read]) {
			assert.equal(JSON.stringify(answer.body).includes(secret), false, "no answer carries the secret: " + JSON.stringify(answer.body).slice(0, 200));
		}
		// The only place anything was sent is the MCP server the caller configured: the fake's own origin.
		assert.ok(requested.length > 0, "the cycle made requests");
		// This test's own calls to the gateway are not the service's traffic, so they are not counted.
		const outbound = requested.filter((url) => !url.startsWith(f.origin));
		assert.ok(outbound.length > 0, "the service made outbound requests");
		for (const url of outbound) {
			assert.ok(url.startsWith(oauth.origin), "every outbound request went to the configured server: " + url);
		}
		assert.equal(requested.some((url) => /:8787|:18787|\/api\/conversations/.test(url)), false, "nothing was sent to the durable backend");
	} finally {
		globalThis.fetch = realFetch;
		await oauth.close();
		await f.close();
	}
});

test("the MCP surface is authenticated and refuses an unknown operation", async () => {
	const f = await fixture();
	try {
		const unauthorized = await f.call({ operation: "read" }, "wrong-token");
		assert.equal(unauthorized.status, 401);
		const unknown = await f.call({ operation: "publish" });
		assert.deepEqual([unknown.body.ok, unknown.body.code], [false, "invalid_request"]);
		const malformed = await fetch("http://127.0.0.1:1/v1/mcp", { method: "POST" }).catch(() => undefined);
		assert.equal(malformed, undefined, "a request to no gateway reaches none");
	} finally {
		await f.close();
	}
});

// ---------------------------------------------------------------- the controlled fixtures

/** The fake OAuth-protected MCP server the sign-in runs against, as its own module exports it. */
async function startOAuthFixture(): Promise<{ url: string; origin: string; issued: { access: Set<string> }; close: () => Promise<void> }> {
	const module = await import(OAUTH_FIXTURE) as { startFakeOAuthServer: StartFakeOAuthServer };
	return module.startFakeOAuthServer();
}

/** Open the fake's sign-in page and return the address the browser is redirected to, as a person would paste it. */
async function approve(authorizationUrl: string): Promise<string> {
	const response = await fetch(authorizationUrl, { redirect: "manual" });
	assert.equal(response.status, 302, "the fake approves at once");
	const location = response.headers.get("location");
	assert.ok(location, "the fake redirects back");
	return location;
}

test("the host's MCP service runs as the execution account, not this process's own agent directory", async () => {
	// The service is constructed with the account directory it owns, so a host with its own account can
	// never read or write another process's configuration. Nothing here reads `process.env` to decide it.
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-account-"));
	try {
		const home = join(base, "home");
		await mkdir(home, { recursive: true });
		assert.equal(agentDirOf(home), join(home, ".pi", "agent"));
		assert.equal(agentDirOf(localExecutionHostIdentity().home), join(localExecutionHostIdentity().home, ".pi", "agent"));
		const service = new McpHostService(agentDirOf(home));
		const read = await service.execute({ operation: "read" });
		assert.equal(read.ok, true);
		assert.deepEqual((read as { value: { files: { path: string }[] } }).value.files.map((file) => file.path), [join(home, ".pi", "agent", "mcp.json")]);
		await service.close();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
