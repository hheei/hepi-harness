import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MCP_LIST_MAX_PAGES, MCP_LIST_MAX_RESPONSE_BYTES, MCP_LIST_MAX_TEXT_CHARS, MCP_LIST_MAX_TOOLS } from "@hepi/protocol/gateway";
import type { McpHostRequest } from "@hepi/protocol/gateway";
import { GatewayRpcServer, LocalGateway, McpHostService, MemoryLedger, WorkspaceRegistry, agentDirOf } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { gatewayHttp, type GatewayHttp } from "./gateway-http.ts";

/**
 * The Gateway tool-listing contract, at the seam a caller uses: `POST /v1/mcp` with `operation: "tools"`.
 *
 * Ticket 03's discovery question is one operation on the route ticket 01 built, so what is asserted here is the whole
 * shape of that operation: it names one configured server and may not carry configuration; it is answered by connecting
 * that server the way a test and a call already do, and closes it again; the answer is the server's own names,
 * descriptions and argument schemas, bounded and masked; a project folder is read only where a decision trusts it; and
 * every way a listing can end — a full answer, a cut one, a server that will not start, a caller that went away — is
 * named as what it was.
 *
 * The server is the controlled stdio fixture, so nothing reaches a network, a real provider or a paid call, and no wait
 * is a sleep: every wait is for an answer, or for a file the fixture wrote, or for the process it recorded to exit.
 */

const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/stdio-server.mjs", import.meta.url));
const OAUTH_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/oauth-server.mjs", import.meta.url));
const TOKEN = "gateway-token";
/** The literal secret the fixture is started with, echoed back by its own tools' names and descriptions. */
const SECRET = "listing-literal-secret-value";

type Fixture = {
	readonly base: string;
	readonly home: string;
	readonly agentDir: string;
	readonly folder: string;
	readonly pidFile: string;
	readonly reachedFile: string;
	readonly http: GatewayHttp;
	readonly service: McpHostService;
	readonly call: (body: unknown, token?: string) => Promise<{ status: number; body: any }>;
	readonly configure: (servers: Record<string, unknown>) => Promise<void>;
	readonly close: () => Promise<void>;
};

/** One gateway serving the MCP surface over this process's HTTP seam, with an account directory of its own. */
async function fixture(): Promise<Fixture> {
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-list-"));
	const home = join(base, "home");
	const folder = join(home, "project");
	await mkdir(folder, { recursive: true });
	const registry = new WorkspaceRegistry([{ id: "local", root: folder }]);
	const gateway = new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	const service = new McpHostService(agentDirOf(home), registry);
	const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, undefined, undefined, undefined, service);
	const http = gatewayHttp(server.server);
	const pidFile = join(base, "server.pid");
	const reachedFile = join(base, "slow.reached");
	return {
		base,
		home,
		agentDir: agentDirOf(home),
		folder,
		pidFile,
		reachedFile,
		http,
		service,
		call: async (body, token = TOKEN) => {
			const response = await http.call({ method: "POST", path: "/v1/mcp", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
			return { status: response.status, body: JSON.parse(response.body.toString("utf8")) as any };
		},
		configure: async (servers) => {
			await mkdir(agentDirOf(home), { recursive: true });
			await writeFile(join(agentDirOf(home), "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
		},
		close: async () => {
			http.close();
			await server.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

/** The fixture server entry a listing reads: the controlled stdio server, with the listing tools on and a secret to echo. */
function serverEntry(f: Fixture, extra: Record<string, unknown> = {}, envExtra: Record<string, string> = {}): Record<string, unknown> {
	return {
		command: process.execPath,
		args: [STDIO_FIXTURE],
		env: {
			PI_WEB_FIXTURE_LIST_TOOLS: "1",
			PI_WEB_FIXTURE_LIST_ECHO: SECRET,
			PI_WEB_FIXTURE_PID_FILE: f.pidFile,
			FIXTURE_TOKEN: SECRET,
			...envExtra,
		},
		...extra,
	};
}

/**
 * One listing, as a caller asks for it: a scope, a folder address and a server name.
 *
 * The extra fields are the ones a test sends to be refused — a configuration key, a missing folder, an unknown scope —
 * so they are spread onto the raw body rather than described by the request type.
 */
function listing(name = "fixture", extra: Record<string, unknown> = {}): McpHostRequest {
	return { operation: "tools", scope: "global", name, ...extra } as McpHostRequest;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** The pid the fixture recorded when its server process started, once it has recorded it. */
async function serverPid(f: Fixture): Promise<number> {
	await until(() => existsSync(f.pidFile), "the fixture server to record its pid");
	return Number((await readFile(f.pidFile, "utf8")).trim());
}

/** The descriptors of an answer, keyed by name, so an assertion reads as the tool it is about. */
function byName(value: any): Record<string, any> {
	return Object.fromEntries((value.tools as any[]).map((tool) => [tool.name, tool]));
}

// ---------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------

test("a listing names one configured server and answers what that server said about its tools", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f), off: serverEntry(f, { enabled: false, toolExposure: { "second-line": "hidden" } }) });
		const answer = await f.call(listing());
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
		const value = answer.body.value;

		// It is the server's own answer: the names it listed, its schema passed through, its read-only claim read as a
		// claim rather than as a fact, and the identity of the server that said it.
		const listed = byName(value);
		assert.deepEqual([value.scope, value.server], ["global", "fixture"], JSON.stringify([value.scope, value.server]));
		assert.deepEqual([value.pages, value.total, value.tools.length], [1, 10, 10], "one page, and every tool the server named");
		assert.equal(value.truncated, false, "a full answer says nothing was left out");
		assert.deepEqual(value.serverInfo, { name: "pi-web-env-fixture", version: "1.0.0" });
		assert.deepEqual(listed.listed.inputSchema, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
		// The server's own description named the value this host resolved for it, so the text a person reads is masked
		// and the schema the server wrote is not: nothing is substituted inside a document.
		assert.equal(listed.listed.description, "Lists •••");
		assert.equal(listed.listed.readOnly, true, "the server's own read-only claim, read as a claim");
		assert.equal("exposure" in listed.listed, false, "an entry that states no exposure states none for a tool either");
		assert.equal(typeof value.durationMs, "number");
		assert.equal(value.listedAt > 0, true);

		// The whole answer carries no more than the caller asked about: no command, no URL, no header name, no value.
		const text = JSON.stringify(value);
		for (const secret of [process.execPath, SECRET, "PI_WEB_FIXTURE_LIST_ECHO"]) assert.equal(text.includes(secret), false, "a listing carries " + secret);

		// A server switched off is not connected to answer a listing about it, and says so as itself.
		const off = await f.call(listing("off"));
		assert.deepEqual([off.body.ok, off.body.code], [false, "server-disabled"], JSON.stringify(off.body));
	} finally {
		await f.close();
	}
});

test("a listing reads every field by type and never takes a server's claim as a fact", async () => {
	const f = await fixture();
	try {
		// The hostile fixture: a numeric description, a title where a description should be, an `annotations` that is a
		// string, a read-only hint that is not the boolean true, a name that is not a name, and names that are
		// Object.prototype members.
		await f.configure({ fixture: serverEntry(f, { exposure: "direct", toolExposure: { "long-description": "hidden" } }, { PI_WEB_FIXTURE_ODD_TOOLS: "1" }) });
		const answer = await f.call(listing());
		assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
		const value = answer.body.value;
		const tools = byName(value);

		// A name the server did not give is not a tool, and the answer says it is incomplete rather than letting one
		// fewer tool look like the server's own count.
		assert.equal(value.truncated, true, "a tool this host cannot name makes the answer incomplete");
		assert.equal(value.total, 10, "every item the server listed is counted, described or not");
		assert.equal(value.tools.length, 9, "the ten named tools, the unnamed one apart");

		// A prototype-named tool is a key in the answer and never a method on it.
		assert.equal(Object.prototype.hasOwnProperty.call(tools, "constructor"), true);
		assert.equal(typeof tools["constructor"], "object", "a tool named constructor is a descriptor, not the constructor");
		assert.equal(typeof tools["toString"], "object");

		// Only a real description is one; a number becomes the server's own title, and nothing becomes nothing.
		assert.equal(tools["numbered"].description, "The title a panel shows instead");
		assert.equal(tools["hinted"].description, "A hint that is not a promise.");
		assert.equal("readOnly" in tools["numbered"], false, "a description of 42 and annotations of a string say nothing about read-only");
		assert.equal("readOnly" in tools["hinted"], false, "readOnlyHint of a string is not the boolean true");
		assert.equal(tools["second-line"].description, "The line a panel shows", "the first non-empty line, not the blank one");
		assert.equal("readOnly" in tools["second-line"], false, "an absent annotation is unknown, not a promise");

		// Text longer than the bound is cut and says it was; a schema longer than its bound is withheld, not sent in
		// pieces, because half of an argument shape invites a call that cannot be validated.
		assert.equal(tools["long-description"].description.length, MCP_LIST_MAX_TEXT_CHARS, "cut to the bound, ellipsis included");
		assert.equal(tools["long-description"].truncated, true);
		assert.equal("inputSchema" in tools["huge-schema"], false, "an over-bound schema is withheld");
		assert.equal(tools["huge-schema"].truncated, true);
		assert.equal(tools["huge-schema"].description, "A schema larger than any host bound.");

		// Exposure is the host's own rule, stated per tool: the entry's own for most, the tool's own mark where it has
		// one, and `hidden` shown rather than silently dropped — a listing that hid a hidden tool would leave a person
		// to learn it from a refusal, and it is the call that refuses, not this read.
		assert.equal(tools["numbered"].exposure, "direct");
		assert.equal("exposureOverridden" in tools["numbered"], false);
		assert.equal(tools["long-description"].exposure, "hidden");
		assert.equal(tools["long-description"].exposureOverridden, true);
		// The same entry and tool: a call is refused what a listing describes.
		const refused = await f.service.execute({ operation: "invoke", callId: "hidden-call", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "long-description", arguments: {} });
		assert.deepEqual([refused.ok, (refused as { code?: string }).code], [false, "not-exposed"], JSON.stringify(refused));
	} finally {
		await f.close();
	}
});

test("a listing masks what a server echoes of the values it was given, and keeps a schema whole", async () => {
	const f = await fixture();
	try {
		// The fixture names one tool after an environment value it was given and puts another in its description. Both
		// are server-authored text, so both are masked exactly as a result block is; the schema is the one field passed
		// through as the server wrote it, because nothing resolves a reference inside a document.
		await f.configure({ fixture: serverEntry(f, {}, { PI_WEB_FIXTURE_LIST_TOOL_NAME: "echo-" + SECRET }) });
		const answer = await f.call(listing());
		const value = answer.body.value;
		assert.equal(JSON.stringify(value).includes(SECRET), false, "no value this host resolved reaches a caller through a name or a description");

		// The name is masked whole, because the whole name is the value plus a prefix the host also added to its own
		// redactor: a caller still sees that one tool is a masked one, and cannot read the value back out of it.
		const masked = (value.tools as any[]).filter((tool) => tool.name === SECRET.replace(/.*/, "•••"));
		assert.equal(masked.length, 1, JSON.stringify((value.tools as any[]).map((tool) => tool.name)));
		assert.equal(masked[0].description, "Lists •••");
		assert.equal(masked[0].readOnly, true, "a masked name is still a descriptor with the server's own fields");
		// A schema is the server's own bytes: no mask of a value it never contained, no re-encoding, the shape a caller
		// can compile.
		assert.deepEqual(masked[0].inputSchema, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
	} finally {
		await f.close();
	}
});

test("a listing reads the pages one request is willing to read and says that it stopped", async () => {
	const f = await fixture();
	try {
		// A server that paginates forever with two tools per page. Following every cursor is what pi-mcp's own client
		// does, up to a thousand pages inside one deadline — right for a client, wrong for a host that bounds what one
		// request may cost while it holds a process it started.
		await f.configure({ fixture: serverEntry(f, {}, { PI_WEB_FIXTURE_PAGE_CURSOR: "endless", PI_WEB_FIXTURE_LIST_TOOLS: "" }) });
		const answer = await f.call(listing());
		assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
		const value = answer.body.value;
		assert.equal(value.pages, MCP_LIST_MAX_PAGES, "the host's own page bound, not the server's patience");
		assert.equal(value.tools.length, MCP_LIST_MAX_PAGES * 2, "two tools per page, for exactly as many pages as one request reads");
		assert.equal(value.total, value.tools.length, "everything read is counted");
		assert.equal(value.truncated, true, "and the answer says there was more");
		const pid = await serverPid(f);
		assert.equal(alive(pid), false, "a listing closes the server it opened");
	} finally {
		await f.close();
	}
});

/**
 * One server, asked twice: once small enough that a host answers it whole, once with three hundred tools whose
 * schemas together pass what one answer may cost. A gateway caps a request body at 1 MiB and sets no total cap of its
 * own on a JSON answer, so a host's own two numbers are the only bound a listing has — and a cut answer has to say
 * that it was cut, because an answer that quietly carried fewer tools would read as the server having fewer.
 */
test("a listing keeps its own bounds the host's, not the document a server chose to write", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		const small = await f.call(listing());
		assert.equal(small.body.value.truncated, false, "a listing under both bounds says nothing was cut");
		assert.equal(small.body.value.tools.length, small.body.value.total);

		await f.configure({ fixture: serverEntry(f, {}, { PI_WEB_FIXTURE_LIST_BULK: "300" }) });
		const big = await f.call(listing());
		assert.equal(big.body.ok, true, JSON.stringify(big.body));
		const value = big.body.value;
		// The fixture answers 310 tools: its four ordinary ones, the six a listing test reads by type, and three
		// hundred whose schemas alone are more than any answer may carry.
		assert.equal(value.total, 310, "every tool the server listed is counted, carried by the answer or not");
		assert.equal(value.tools.length < value.total, true, "and the answer carries fewer than it was given");
		assert.equal(value.truncated, true, "which the answer states, rather than leaving a caller to notice");
		assert.equal(JSON.stringify(value).length <= MCP_LIST_MAX_RESPONSE_BYTES, true, "the answer is a document, not a flood");
		assert.equal(value.tools.length <= MCP_LIST_MAX_TOOLS, true, "and never more tools than one answer may describe");
		// A cut answer is a prefix in the server's own order, never a selection of whatever happened to fit.
		assert.deepEqual(value.tools.slice(0, 2).map((tool: any) => tool.name), ["env_has", "env_get"], "the server's own first tools");
		const carried = value.tools.map((tool: any) => tool.name);
		assert.equal(/^bulk-\d+$/.test(carried[carried.length - 1]), true, carried[carried.length - 1]);
	} finally {
		await f.close();
	}
});

// ---------------------------------------------------------------------------
// who may be asked, and what a request may carry
// ---------------------------------------------------------------------------

test("a listing is authenticated, may not carry configuration, and refuses a server or folder the host does not serve", async () => {
	const f = await fixture();
	const oauth = await startOAuthFixture();
	try {
		await f.configure({
			fixture: serverEntry(f),
			off: serverEntry(f, { enabled: false }),
			broken: { command: "" },
			oauth: { url: oauth.url },
			notAnObject: "just a string",
		});

		// The route is the gateway's authenticated surface: a caller with no valid bearer reaches no host at all.
		const unauthorized = await f.call(listing(), "wrong-token");
		assert.equal(unauthorized.status, 401);

		// A listing names a server and nothing else, checked on the raw body the route read.
		for (const key of ["config", "command", "args", "env", "url", "headers", "auth"]) {
			const carrying = await f.call(listing("fixture", { [key]: { command: "true" } }));
			assert.deepEqual([carrying.body.ok, carrying.body.code], [false, "invalid_request"], key + " is refused: " + JSON.stringify(carrying.body));
			assert.match(carrying.body.message, /not configuration/);
		}
		const unnamed = await f.call({ operation: "tools", scope: "global" });
		assert.deepEqual([unnamed.body.ok, unnamed.body.code], [false, "invalid_request"], "a listing needs a server name");
		const badScope = await f.call({ operation: "tools", scope: "machine", name: "fixture" });
		assert.deepEqual([badScope.body.ok, badScope.body.code], [false, "invalid_request"]);
		// A project listing that names no folder is refused rather than read as this host's own account.
		const noFolder = await f.call(listing("fixture", { scope: "project" }));
		assert.deepEqual([noFolder.body.ok, noFolder.body.code], [false, "invalid_request"]);
		assert.equal(existsSync(f.pidFile), false, "nothing was started for a request that was refused on its shape");

		// The host's own entry answers, or its own refusal does.
		const missing = await f.call(listing("absent"));
		assert.deepEqual([missing.body.ok, missing.body.code], [false, "server-missing"]);
		const invalid = await f.call(listing("broken"));
		assert.deepEqual([invalid.body.ok, invalid.body.code], [false, "server-invalid"]);
		const off = await f.call(listing("off"));
		assert.deepEqual([off.body.ok, off.body.code], [false, "server-disabled"]);
		assert.equal(existsSync(f.pidFile), false, "a switched-off server is not connected to be described");

		// A server that will not start, and one that needs a sign-in, are named without their secret reaching the caller.
		const needsAuth = await f.call(listing("oauth"));
		assert.deepEqual([needsAuth.body.ok, needsAuth.body.code], [false, "needs-auth"], JSON.stringify(needsAuth.body));
		const notAnObject = await f.call(listing("notAnObject"));
		assert.deepEqual([notAnObject.body.ok, notAnObject.body.code], [false, "server-invalid"], JSON.stringify(notAnObject.body));

		// A project folder is the host's own decision: no decision, a recorded refusal, and a folder this host does not
		// serve are three different answers, and none of them reads the folder's file.
		await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
		await mkdir(join(f.folder, ".pi"), { recursive: true });
		await writeFile(join(f.folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projectServer: serverEntry(f) } }, null, 2) + "\n");
		const undecided = await f.call(listing("projectServer", { scope: "project", workspaceId: "local" }));
		assert.deepEqual([undecided.body.ok, undecided.body.code], [false, "not-authorized"], JSON.stringify(undecided.body));
		const elsewhere = await f.call(listing("projectServer", { scope: "project", cwd: join(f.home, "elsewhere") }));
		assert.deepEqual([elsewhere.body.ok, elsewhere.body.code], [false, "not-authorized"], "a folder with no decision is refused by the host");
		const unknownWorkspace = await f.call(listing("projectServer", { scope: "project", workspaceId: "another-host" }));
		assert.deepEqual([unknownWorkspace.body.ok, unknownWorkspace.body.code], [false, "unknown-workspace"]);
		await writeFile(join(f.agentDir, "trust.json"), JSON.stringify({ [f.folder]: false }, null, 2) + "\n");
		const untrusted = await f.call(listing("projectServer", { scope: "project", workspaceId: "local" }));
		assert.deepEqual([untrusted.body.ok, untrusted.body.code], [false, "not-authorized"]);
		assert.match(untrusted.body.message, /recorded as not trusted/);

		// A trusted folder's own file is what is read, so a server only it defines becomes listable.
		await writeFile(join(f.agentDir, "trust.json"), JSON.stringify({ [f.folder]: true }, null, 2) + "\n");
		const project = await f.call(listing("projectServer", { scope: "project", workspaceId: "local" }));
		assert.equal(project.body.ok, true, JSON.stringify(project.body));
		assert.deepEqual([project.body.value.scope, project.body.value.server], ["project", "projectServer"]);
	} finally {
		await oauth.close();
		await f.close();
	}
});

test("a gateway that serves no MCP answers the named limit, and no other setting is affected", async () => {
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-list-none-"));
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const registry = new WorkspaceRegistry([{ id: "local", root: home }]);
	const gateway = new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	// The eighth capability is the MCP host service: without it the route still answers, and answers with its own limit.
	const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, undefined, undefined, undefined, undefined);
	const http = gatewayHttp(server.server);
	try {
		const response = await http.call({ method: "POST", path: "/v1/mcp", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(listing()) });
		const body = JSON.parse(response.body.toString("utf8")) as any;
		assert.deepEqual([response.status, body.ok, body.code], [200, false, "mcp_unavailable"], JSON.stringify(body));
	} finally {
		http.close();
		await server.close();
		await rm(base, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// how a listing ends
// ---------------------------------------------------------------------------

test("a caller that disconnects ends the listing, and the server it opened exits", async () => {
	const f = await fixture();
	try {
		// The slow tool is what keeps the answer out: a listing that never finishes is a request whose caller left, and
		// the route aborts the operation it started when the response closes.
		await f.configure({ fixture: serverEntry(f, {}, { PI_WEB_FIXTURE_LIST_TOOLS: "", PI_WEB_FIXTURE_SLOW_FILE: f.reachedFile }) });
		const exchange = f.http.start({ method: "POST", path: "/v1/mcp", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" } });
		exchange.write(Buffer.from(JSON.stringify(listing("fixture", { name: "fixture" }))));
		exchange.end();
		const pid = await serverPid(f);
		exchange.destroy();
		await until(() => !alive(pid), "the server a listing opened to exit after the caller disconnected");
	} finally {
		await f.close();
	}
});

test("stopping the service ends a listing still running and waits for the connection it opened", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f, {}, { PI_WEB_FIXTURE_LIST_TOOLS: "", PI_WEB_FIXTURE_LIST_DELAY_MS: "3000", PI_WEB_FIXTURE_SLOW_FILE: f.reachedFile }) });
		const running = f.service.execute(listing());
		await until(() => existsSync(f.reachedFile), "the listing to reach the server");
		const pid = await serverPid(f);
		await f.service.close();
		const answer: any = await running;
		assert.deepEqual([answer.ok, answer.code], [false, "cancelled"], JSON.stringify(answer));
		assert.match(answer.message, /stopped/);
		await until(() => !alive(pid), "the server process to exit when the service stops");
	} finally {
		await f.close();
	}
});

/** The fake OAuth-protected MCP server, as its own module exports it. Nothing leaves the machine. */
async function startOAuthFixture(): Promise<{ url: string; close: () => Promise<void> }> {
	const module = await import(OAUTH_FIXTURE) as { startFakeOAuthServer: () => Promise<any> };
	return module.startFakeOAuthServer();
}
