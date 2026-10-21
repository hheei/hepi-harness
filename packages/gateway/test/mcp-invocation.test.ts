import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayRpcServer, LocalGateway, McpHostService, MemoryLedger, WorkspaceRegistry, agentDirOf } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { gatewayHttp, type GatewayHttp } from "./gateway-http.ts";

/**
 * The Gateway invocation contract, at the seam a caller uses: `POST /v1/mcp` with `operation: "invoke"`.
 *
 * The Backend conversation lifecycle (ticket 02) reaches MCP tools only through this route, so what is asserted here is
 * the contract that lifecycle is written against: a request names one configured server and one of its tools and may
 * not carry configuration; the host reads its own files, resolves its own values and runs the call as its own account;
 * the answer is a bounded, masked result; and every way a call can end — success, a tool failure, a deadline, a caller
 * that went away, a disconnect — is named as what it is, with the server left not running.
 *
 * The server is the controlled stdio fixture, so nothing here reaches a network, a real provider or a paid call, and
 * every wait is for an answer or for a file the fixture wrote — never a sleep used as evidence.
 */

const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/stdio-server.ts", import.meta.url));
const OAUTH_FIXTURE = fileURLToPath(new URL("./fixtures/mcp/oauth-server.ts", import.meta.url));
// The fixture's own export, as a type: the sign-in case states what it gets back instead of `any`.
type StartFakeOAuthServer = typeof import("./fixtures/mcp/oauth-server.ts").startFakeOAuthServer;
const TOKEN = "gateway-token";
/** The literal secret the fixture server is started with, and which its own tools can echo back. */
const SECRET = "invocation-literal-secret-value";

type Fixture = {
	readonly home: string;
	readonly agentDir: string;
	readonly folder: string;
	readonly base: string;
	/** Where the fixture server writes its pid, so a test can assert the process is gone. */
	readonly pidFile: string;
	/** Where the slow tool writes that it was reached, so a deadline or a cancellation has evidence behind it. */
	readonly reachedFile: string;
	readonly http: GatewayHttp;
	readonly service: McpHostService;
	readonly call: (body: unknown, token?: string) => Promise<{ status: number; body: any }>;
	/** Write the configuration the host reads, so a test states the entries it is about. */
	readonly configure: (servers: Record<string, unknown>) => Promise<void>;
	readonly close: () => Promise<void>;
};

/** One gateway serving the MCP surface over this process's HTTP seam, with an account directory of its own. */
async function fixture(): Promise<Fixture> {
	const base = await mkdtemp(join(tmpdir(), "hepi-mcp-invoke-"));
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

/** The fixture server entry every invocation test uses: it starts the controlled stdio server with what the tests read. */
function serverEntry(f: Fixture, extra: Record<string, unknown> = {}, envExtra: Record<string, string> = {}): Record<string, unknown> {
	return {
		command: process.execPath,
		args: [STDIO_FIXTURE],
		env: {
			PI_WEB_FIXTURE_INVOKE_TOOLS: "1",
			PI_WEB_FIXTURE_PID_FILE: f.pidFile,
			PI_WEB_FIXTURE_SLOW_FILE: f.reachedFile,
			FIXTURE_TOKEN: SECRET,
			...envExtra,
		},
		...extra,
	};
}

/** One invocation body, with only what a call may say: no configuration, no command, no credential. */
function invocation(f: Fixture, tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { operation: "invoke", callId: "call-1", conversationId: "conversation-1", scope: "global", server: "fixture", tool, ...extra };
}

/** Whether a pid is still running, as a signal check rather than a guess about the process table. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait until a condition holds, so a test states a fact that has to become true rather than sleeping first. */
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for " + what);
}

/** The pid the fixture server wrote, once it has started. */
async function serverPid(f: Fixture): Promise<number> {
	await until(() => existsSync(f.pidFile), "the fixture server to start");
	return Number(await readFile(f.pidFile, "utf8"));
}

/** The text of one result, joined, so a test reads what a conversation would record. */
function textOf(body: any): string {
	return (body.value.content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");
}

// ---------------------------------------------------------------------------
// protocol validation and authorization
// ---------------------------------------------------------------------------

test("an invocation names a configured server and tool, and a request that carries configuration is refused", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		// The shape the route checks before anything runs: a call identity, a conversation, a server and a tool.
		const cases: readonly [Record<string, unknown>, string][] = [
			[{ ...invocation(f, "record"), callId: "" }, "a callId"],
			[{ ...invocation(f, "record"), conversationId: undefined }, "a conversationId"],
			[{ ...invocation(f, "record"), server: "" }, "a server"],
			[{ ...invocation(f, "record"), tool: undefined }, "a tool"],
			[{ ...invocation(f, "record"), scope: "workspace" }, 'scope must be "global" or "project"'],
			[{ ...invocation(f, "record"), scope: "project" }, "names the folder it applies to"],
			[{ ...invocation(f, "record"), deadlineMs: 0 }, "deadlineMs must be a positive number"],
			[{ ...invocation(f, "record"), arguments: "note" }, "arguments must be an object"],
		];
		for (const [body, expected] of cases) {
			const answer = await f.call(body);
			assert.equal(answer.body.ok, false, JSON.stringify(body) + " was accepted");
			assert.equal(answer.body.code, "invalid_request", JSON.stringify(answer.body));
			assert.match(answer.body.message, new RegExp(expected));
		}
		const oversized = await f.call({ ...invocation(f, "record"), arguments: { note: "x".repeat(70_000) } });
		assert.equal(oversized.body.code, "arguments-too-large");

		// A request may not become a way to have this host run something: every key a configuration entry has is refused
		// by name, so a caller cannot supply a command, an environment, a URL, a header or a credential.
		for (const key of ["config", "command", "args", "env", "url", "headers", "auth"]) {
			const answer = await f.call({ ...invocation(f, "record"), [key]: key === "config" ? { command: "/bin/sh" } : key === "args" ? ["-c", "true"] : "x" });
			assert.equal(answer.body.ok, false, key + " was accepted");
			assert.equal(answer.body.code, "invalid_request");
			assert.match(answer.body.message, new RegExp(key));
		}
		// Nothing above started a server: no pid was written, so a refused request ran nothing at all.
		assert.equal(existsSync(f.pidFile), false, "a refused invocation started no server");
	} finally {
		await f.close();
	}
});

test("the invocation is authenticated and refuses a server, folder or selection the host does not serve", async () => {
	const f = await fixture();
	try {
		await f.configure({
			fixture: serverEntry(f),
			off: serverEntry(f, { enabled: false }),
			hidden: serverEntry(f, { exposure: "hidden" }),
			hiddenTool: serverEntry(f, { toolExposure: { record: "hidden" } }),
			broken: { command: "" },
		});
		// The route is the gateway's authenticated surface: a caller with no valid bearer reaches no host at all.
		const unauthorized = await f.call(invocation(f, "record"), "wrong-token");
		assert.equal(unauthorized.status, 401);

		const missing = await f.call(invocation(f, "record", { server: "absent" }));
		assert.deepEqual([missing.body.ok, missing.body.code], [false, "server-missing"]);
		const invalid = await f.call(invocation(f, "record", { server: "broken" }));
		assert.deepEqual([invalid.body.ok, invalid.body.code], [false, "server-invalid"]);
		const off = await f.call(invocation(f, "record", { server: "off" }));
		assert.deepEqual([off.body.ok, off.body.code], [false, "server-disabled"]);
		// Configured is not exposed: a server or a tool the host's own configuration hides is not callable here either.
		const hidden = await f.call(invocation(f, "record", { server: "hidden" }));
		assert.deepEqual([hidden.body.ok, hidden.body.code], [false, "not-exposed"]);
		const hiddenTool = await f.call(invocation(f, "record", { server: "hiddenTool" }));
		assert.deepEqual([hiddenTool.body.ok, hiddenTool.body.code], [false, "not-exposed"]);
		// The tool is looked up before it is called: a name the server does not list is refused by name.
		const unknownTool = await f.call(invocation(f, "no_such_tool", { server: "fixture" }));
		assert.deepEqual([unknownTool.body.ok, unknownTool.body.code], [false, "unknown-tool"]);

		// A project scope is answered only for a folder this host serves and a decision trusts. Both gates are the
		// host's own: the folder is resolved from the id it serves, and the entry is read only for a trusted folder.
		await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
		await mkdir(join(f.folder, ".pi"), { recursive: true });
		await writeFile(join(f.folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projectServer: serverEntry(f) } }, null, 2) + "\n");
		// No decision at all: the folder's own entry is not used, whatever the caller says about it.
		const undecided = await f.call(invocation(f, "record", { scope: "project", workspaceId: "local", server: "projectServer" }));
		assert.deepEqual([undecided.body.ok, undecided.body.code], [false, "not-authorized"], JSON.stringify(undecided.body));
		const unknownWorkspace = await f.call(invocation(f, "record", { scope: "project", workspaceId: "another-host", server: "projectServer" }));
		assert.deepEqual([unknownWorkspace.body.ok, unknownWorkspace.body.code], [false, "unknown-workspace"]);
		// A recorded refusal is refused as a refusal, and names the folder whose decision it was.
		await writeFile(join(f.agentDir, "trust.json"), JSON.stringify({ [f.folder]: false }, null, 2) + "\n");
		const untrusted = await f.call(invocation(f, "record", { scope: "project", workspaceId: "local", server: "projectServer" }));
		assert.deepEqual([untrusted.body.ok, untrusted.body.code], [false, "not-authorized"]);
		assert.match(untrusted.body.message, /recorded as not trusted/);
		// A trusted folder's own file is what is read, so a server only it defines is callable and one only the
		// global file defines is not.
		await writeFile(join(f.agentDir, "trust.json"), JSON.stringify({ [f.folder]: true }, null, 2) + "\n");
		const project = await f.call(invocation(f, "record", { scope: "project", workspaceId: "local", server: "projectServer", arguments: { note: "from the project file" } }));
		assert.equal(project.body.ok, true, JSON.stringify(project.body));
		assert.equal(textOf(project.body), JSON.stringify({ recorded: "from the project file" }));
		const elsewhere = await f.call(invocation(f, "record", { scope: "project", cwd: join(f.home, "elsewhere"), server: "projectServer" }));
		assert.deepEqual([elsewhere.body.ok, elsewhere.body.code], [false, "not-authorized"], "a folder with no decision is refused by the host");
	} finally {
		await f.close();
	}
});

// ---------------------------------------------------------------------------
// success, tool failure, bounds
// ---------------------------------------------------------------------------

test("a selected tool runs on the host and its result comes back masked and attributed to the call", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		const recorded = await f.call(invocation(f, "record", { arguments: { note: "hello" } }));
		assert.equal(recorded.body.ok, true, JSON.stringify(recorded.body));
		assert.equal(recorded.body.value.callId, "call-1");
		assert.equal(recorded.body.value.server, "fixture");
		assert.equal(recorded.body.value.tool, "record");
		assert.equal(recorded.body.value.isError, false);
		assert.equal(recorded.body.value.truncated, false);
		assert.equal(typeof recorded.body.value.durationMs, "number");
		assert.deepEqual(recorded.body.value.content, [{ type: "text", text: JSON.stringify({ recorded: "hello" }) }]);
		// The answer carries the call's own identity and nothing about the entry that ran it: no command, no env, no value.
		assert.deepEqual(Object.keys(recorded.body.value).sort(), ["callId", "content", "durationMs", "isError", "server", "tool", "truncated"]);
		const pid = await serverPid(f);
		// The server the call started is closed when the call ends, so nothing is left running between calls.
		await until(() => !alive(pid), "the server process to exit");

		// The server's own environment holds the entry's literal secret, and a tool that echoes it back is masked: a
		// result is text a server produced, so it can quote any value the host resolved before connecting.
		const echoed = await f.call(invocation(f, "env_get", { callId: "call-2", arguments: { name: "FIXTURE_TOKEN" } }));
		assert.equal(echoed.body.ok, true, JSON.stringify(echoed.body));
		assert.equal(JSON.stringify(echoed.body).includes(SECRET), false, "the secret is not returned: " + JSON.stringify(echoed.body));
		assert.match(textOf(echoed.body), /•••/);

		// A tool that reports a failure of its own is an answer about the call, not a transport failure.
		const failed = await f.call(invocation(f, "fail", { callId: "call-3" }));
		assert.equal(failed.body.ok, true, JSON.stringify(failed.body));
		assert.equal(failed.body.value.isError, true);
		assert.match(textOf(failed.body), /the tool refused this call/);

		// A result larger than the host's bound is cut to it and says so, rather than being returned whole.
		const big = await f.call(invocation(f, "big", { callId: "call-4", arguments: { bytes: 400_000 } }));
		assert.equal(big.body.ok, true, JSON.stringify({ ...big.body, value: { ...big.body.value, content: "[cut]" } }));
		assert.equal(big.body.value.truncated, true);
		assert.ok(textOf(big.body).length <= 256 * 1024, "the result is within the host bound: " + textOf(big.body).length);
	} finally {
		await f.close();
	}
});

// ---------------------------------------------------------------------------
// deadline, cancellation, disconnect, cleanup
// ---------------------------------------------------------------------------

test("a call past its deadline ends as an unknown outcome, and the server it started is not left running", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		const started = Date.now();
		const timedOut = await f.call(invocation(f, "slow", { deadlineMs: 300, arguments: { ms: 5_000 } }));
		assert.deepEqual([timedOut.body.ok, timedOut.body.code], [false, "timeout"], JSON.stringify(timedOut.body));
		// The answer says the side effect is unknown rather than absent, because the server was reached.
		assert.match(timedOut.body.message, /may have acted/);
		assert.ok(Date.now() - started < 5_000, "the deadline ended the call, not the tool");
		assert.equal(existsSync(f.reachedFile), true, "the tool had been reached when the deadline passed");
		const pid = await serverPid(f);
		await until(() => !alive(pid), "the server process to exit after the deadline");
	} finally {
		await f.close();
	}
});

test("a caller that cancels ends the call it started and leaves no server behind", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		// The caller's own cancellation, as a revoked credential or a closed socket hands one in.
		const controller = new AbortController();
		const call = f.service.execute({ operation: "invoke", callId: "call-cancel", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "slow", arguments: { ms: 5_000 }, deadlineMs: 10_000 }, controller.signal);
		await until(() => existsSync(f.reachedFile), "the tool to be reached");
		const pid = await serverPid(f);
		controller.abort();
		const answer = await call;
		assert.deepEqual([answer.ok, (answer as { code?: string }).code], [false, "cancelled"]);
		assert.match((answer as { message: string }).message, /may have acted/);
		await until(() => !alive(pid), "the server process to exit after the caller left");
	} finally {
		await f.close();
	}
});

test("a caller that cancels while a `!command` value is still resolving starts no server at all", async () => {
	const f = await fixture();
	const marker = join(f.base, "value-resolving");
	const valuePid = join(f.base, "value.pid");
	try {
		// One value resolved by running a command on this host, and deliberately slow: it announces that it has begun,
		// records its own pid, and stays alive for eight seconds. The `$$` is the pid the host's own command holds, and
		// `exec` keeps that same pid for the wait, so a cancellation that reaches the command ends this very process.
		const entry = serverEntry(f, {}, { SLOW_TOKEN: `!echo $$ > ${valuePid}; touch ${marker}; exec sleep 8` });
		await f.configure({ fixture: entry });

		// The cancellation lands inside the window before the abort listener exists: resolution has begun, no
		// transport has been built, so nothing here could close a process yet.
		const controller = new AbortController();
		const call = f.service.execute({ operation: "invoke", callId: "call-resolve", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "record", arguments: { note: "x" } }, controller.signal);
		await until(() => existsSync(marker), "the entry's value command to be running");
		controller.abort();

		const answer = await call;
		assert.deepEqual([answer.ok, (answer as { code?: string }).code], [false, "cancelled"], JSON.stringify(answer));
		// It is named as what it is: this host refused the attempt before it started anything, so unlike a call that
		// was cancelled mid-tool there is no unknown outcome, and no server process was ever spawned.
		assert.match((answer as { message: string }).message, /no server was started/);
		assert.equal((answer as { message: string }).message.includes("may have acted"), false, "a call that definitely did not run does not report an unknown outcome");
		assert.equal(existsSync(f.pidFile), false, "a cancellation during value resolution started no MCP server");
		// The value command itself is ended by the same abort, so the cancellation leaves no process of this host's.
		const valueProcess = Number(await readFile(valuePid, "utf8"));
		await until(() => !alive(valueProcess), "the value command to exit with the cancellation", 5_000);
	} finally {
		await f.close();
	}
});

test("a caller already gone is refused before any value command runs", async () => {
	const f = await fixture();
	const marker = join(f.base, "value-resolving");
	try {
		await f.configure({ fixture: serverEntry(f, {}, { SLOW_TOKEN: `!touch ${marker}; echo value` }) });
		const answer = await f.service.execute({ operation: "invoke", callId: "call-gone", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "record" }, AbortSignal.abort());
		assert.deepEqual([answer.ok, (answer as { code?: string }).code], [false, "cancelled"], JSON.stringify(answer));
		assert.equal(existsSync(marker), false, "a caller that is already gone has no value command run for it");
		assert.equal(existsSync(f.pidFile), false, "a refused attempt started no MCP server");
	} finally {
		await f.close();
	}
});

test("a caller that disconnects mid-call ends the call, and the server it started exits", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		// A connection that goes away while the host is still running the tool: what a browser or a Backend process
		// does when it is revoked or restarted. The route aborts its own operation on the response closing.
		const exchange = f.http.start({ method: "POST", path: "/v1/mcp", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" } });
		exchange.write(Buffer.from(JSON.stringify(invocation(f, "slow", { deadlineMs: 30_000, arguments: { ms: 5_000 } }))));
		exchange.end();
		await until(() => existsSync(f.reachedFile), "the tool to be reached");
		const pid = await serverPid(f);
		exchange.destroy();
		await until(() => !alive(pid), "the server process to exit after the caller disconnected");
	} finally {
		await f.close();
	}
});

test("one call identity is not run twice, and the host bounds how many calls it runs at once", async () => {
	const f = await fixture();
	try {
		await f.configure({ fixture: serverEntry(f) });
		const first = f.service.execute({ operation: "invoke", callId: "call-twice", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "slow", arguments: { ms: 300 }, deadlineMs: 4_000 });
		await until(() => existsSync(f.reachedFile), "the first call to be reached");
		const repeated = await f.service.execute({ operation: "invoke", callId: "call-twice", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "slow", arguments: { ms: 300 } });
		assert.deepEqual([repeated.ok, (repeated as { code?: string }).code], [false, "busy"]);
		assert.equal((await first).ok, true, "the call already running is the one that ran");

		// The host's own bound: a call over it is refused rather than queued, so a caller learns it is at the limit now.
		// Each admitted call is registered before it awaits anything, so the count is this host's own.
		const admitted = Array.from({ length: 8 }, (_, index) => f.service.execute({ operation: "invoke", callId: "fill-" + index, conversationId: "conversation-" + index, scope: "global", server: "fixture", tool: "slow", arguments: { ms: 300 }, deadlineMs: 4_000 }));
		const over = await f.service.execute({ operation: "invoke", callId: "over", conversationId: "over", scope: "global", server: "fixture", tool: "record" });
		assert.deepEqual([over.ok, (over as { code?: string }).code], [false, "busy"]);
		const settled = await Promise.all(admitted);
		assert.ok(settled.every((answer) => answer.ok), "the calls that were admitted all ran: " + JSON.stringify(settled.filter((answer) => !answer.ok)));
	} finally {
		await f.close();
	}
});

test("a server that needs a sign-in, or will not start, is named without returning its secret or leaving it running", async () => {
	const f = await fixture();
	const oauth = await startOAuthFixture();
	try {
		await f.configure({
			fixture: serverEntry(f),
			// The failure text is the server's own words; the literal secret is in the environment beside it, so the
			// answer can be checked for the words *and* for the secret never appearing in them.
			broken: serverEntry(f, { env: { PI_WEB_FIXTURE_FAIL: "cannot start: this entry is not usable", FIXTURE_TOKEN: SECRET } }),
			oauth: { url: oauth.url },
		});
		const needsAuth = await f.call(invocation(f, "whoami", { server: "oauth" }));
		assert.deepEqual([needsAuth.body.ok, needsAuth.body.code], [false, "needs-auth"], JSON.stringify(needsAuth.body));

		// A server that will not start answers with its own masked words, and its process is gone.
		const failed = await f.call(invocation(f, "record", { server: "broken" }));
		assert.deepEqual([failed.body.ok, failed.body.code], [false, "operation_failed"], JSON.stringify(failed.body));
		assert.equal(JSON.stringify(failed.body).includes(SECRET), false, "the server's secret is masked in its own failure");
		// The server's own stderr is reported with the failure — it is the useful part — and it is masked, because a
		// server that refuses to start can quote any value the host resolved for it.
		assert.match(failed.body.message, /•••/);

		// Stopping the service ends a call still running and waits for it, so a stopping host leaves nothing running.
		const running = f.service.execute({ operation: "invoke", callId: "call-stop", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "slow", arguments: { ms: 5_000 }, deadlineMs: 30_000 });
		await until(() => existsSync(f.reachedFile), "the tool to be reached");
		const pid = await serverPid(f);
		await f.service.close();
		assert.equal((await running).ok, false, "a call the stopping service ended does not report a result");
		await until(() => !alive(pid), "the server process to exit when the service stops");
	} finally {
		await oauth.close();
		await f.close();
	}
});

/** The fake OAuth-protected MCP server, as its own module exports it. Nothing leaves the machine. */
async function startOAuthFixture(): Promise<{ url: string; close: () => Promise<void> }> {
	const module = await import(OAUTH_FIXTURE) as { startFakeOAuthServer: StartFakeOAuthServer };
	return module.startFakeOAuthServer();
}
