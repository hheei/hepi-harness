import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { McpHostRequest, McpHostResult } from "../src/mcp/host.ts";
import type { ProviderLoginRequest, ProviderLoginResult } from "@hepi/protocol/gateway";
import { GatewayRpcServer, LocalGateway, MemoryLedger, WorkspaceRegistry } from "../src/index.ts";
import { gatewayHttp, type GatewayHttp, type GatewayRequest } from "./gateway-http.ts";

/**
 * The two lifetimes the remaining families own, over the gateway's ordinary admitted entry.
 *
 * These are the rules that made one global request signal wrong, so they are asserted where a caller meets them: HTTP
 * through the gateway's own routing and credential check, with the capability behind the route stating what it
 * observed. An MCP operation is the caller's — a response that closes before it is written aborts the signal the
 * service was handed. A provider sign-in is not: it outlives the request that carried it, so a caller going away does
 * not end it, and the next admitted request finds the flow the vanished one started. A host that serves neither
 * capability answers each route's own named limit.
 */

const TOKEN = "gateway-token";
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** One request as this deployment's caller makes it: admitted with the gateway's own credential unless stated. */
const post = (path: string, body: unknown, authorized = true): GatewayRequest => ({
	method: "POST",
	path,
	headers: { ...(authorized ? { authorization: "Bearer " + TOKEN } : {}), "content-type": "application/json" },
	body: JSON.stringify(body),
});

const json = (response: { body: Buffer }): unknown => JSON.parse(response.body.toString("utf8"));

/** One gateway over a workspace of its own, serving only the capabilities a test states. */
async function host(capabilities: { mcp?: unknown; logins?: unknown } = {}): Promise<{ http: GatewayHttp; close(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "hepi-transport-lifetimes-"));
	directories.push(root);
	const registry = new WorkspaceRegistry([{ id: "local", root }]);
	const gateway = new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	// The composition names the two capabilities this host serves and passes nothing else, which is a host that serves
	// these two surfaces and no other.
	const server = new GatewayRpcServer({ gateway, mcp: capabilities.mcp as never, providerLogins: capabilities.logins as never, });
	const http = gatewayHttp(server.server);
	return { http, close: async () => { http.close(); await server.close(); } };
}

test("a caller that disconnects ends the MCP operation it started", async () => {
	let reached = (): void => undefined;
	const answered = new Promise<void>((resolve) => { reached = resolve; });
	let aborted = false;
	// A capability that never answers and reports what the route did to its signal: the operation is in flight for as
	// long as the caller holds the connection, so the disconnect is the only thing that can end it here. The composition
	// owner disposes what it borrowed, so this stand-in also states that it has nothing to release.
	const hanging = {
		execute: async (_request: McpHostRequest, signal?: AbortSignal): Promise<McpHostResult> => {
			reached();
			await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
			return { ok: false, code: "cancelled", message: "the caller that asked for this is gone" };
		},
		close: async (): Promise<void> => undefined,
	};
	const h = await host({ mcp: hanging });
	try {
		const exchange = h.http.start(post("/v1/mcp", { operation: "tools" }));
		exchange.write(Buffer.from(JSON.stringify({ operation: "tools" })));
		exchange.end();
		await answered;
		exchange.destroy();
		for (let attempt = 0; attempt < 400 && !aborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(aborted, true, "the operation kept running after the caller that asked for it was gone");
	} finally { await h.close(); }
});

test("a provider sign-in outlives the request that carried it, and the next admitted request finds it", async () => {
	const seen: string[] = [];
	let reached = (): void => undefined;
	let release = (): void => undefined;
	const started = new Promise<void>((resolve) => { reached = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let completed = false;
	const flow: ProviderLoginResult = { ok: true, value: { flowId: "flow-1", providerId: "scripted", phase: "waiting_for_browser", waitingFor: ["browser"], expiresInMs: 60_000 } };
	const logins = {
		execute: async (request: ProviderLoginRequest): Promise<ProviderLoginResult> => {
			seen.push(request.operation);
			// The start is the host's own work: it is held here so the caller can go away in the middle of it, exactly as a
			// person who closed the tab while a browser sign-in was being prepared. Nothing about that connection may end it.
			if (request.operation === "login-start") { reached(); await gate; completed = true; }
			return flow;
		},
		stop: (): void => undefined,
	};
	const h = await host({ logins });
	try {
		const abandoned = h.http.start(post("/v1/providers/login", { operation: "login-start", providerId: "scripted", caller: "device:1" }));
		abandoned.write(Buffer.from(JSON.stringify({ operation: "login-start", providerId: "scripted", caller: "device:1" })));
		abandoned.end();
		await started;
		// The caller is gone with the flow still running: it finishes here, and the flow it started stays readable.
		abandoned.destroy();
		release();
		for (let attempt = 0; attempt < 400 && !completed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(completed, true, "the sign-in was ended by the caller that asked for it rather than by its own lifetime");
		// A later, different connection reads the flow the vanished one started.
		const polled = await h.http.call(post("/v1/providers/login", { operation: "login-poll", flowId: "flow-1", caller: "device:1" }));
		assert.equal(polled.status, 200);
		assert.match(polled.body.toString("utf8"), /"flowId":"flow-1"/);
		assert.deepEqual(seen, ["login-start", "login-poll"]);
	} finally { await h.close(); }
});

test("a host that serves no MCP or provider capability answers each route's own named limit", async () => {
	const h = await host();
	try {
		const mcp = await h.http.call(post("/v1/mcp", { operation: "read" }));
		assert.deepEqual([mcp.status, json(mcp)], [200, { ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" }]);
		const auth = await h.http.call(post("/v1/providers/auth", { operation: "list" }));
		assert.deepEqual(json(auth), { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider-auth capability" });
		const login = await h.http.call(post("/v1/providers/login", { operation: "login-start", providerId: "scripted", caller: "device:1" }));
		assert.deepEqual(json(login), { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider sign-in capability" });
		// The named limit answers an admitted caller; nothing is served without the credential.
		const anonymous = await h.http.call(post("/v1/mcp", { operation: "read" }, false));
		assert.deepEqual([anonymous.status, json(anonymous)], [401, { ok: false, code: "unauthorized" }]);
	} finally { await h.close(); }
});

test("a body that states no operation is the family's own refusal, and an unknown route is not theirs", async () => {
	const h = await host();
	try {
		const unnamed = await h.http.call(post("/v1/mcp", {}));
		assert.deepEqual([unnamed.status, json(unnamed)], [400, { ok: false, code: "invalid_request" }]);
		// A path that names no family is a 404 whether or not the caller held this gateway's credential.
		for (const authorized of [true, false]) {
			const unknown = await h.http.call(post("/v1/nothing", {}, authorized));
			assert.equal(unknown.status, 404, "an unknown route with " + (authorized ? "" : "no ") + "credential");
			assert.equal(unknown.body.length, 0);
		}
		// A route another method owns is not served by a POST, and a POST-only route is not served by a GET.
		assert.equal((await h.http.call({ method: "GET", path: "/v1/mcp", headers: { authorization: "Bearer " + TOKEN } })).status, 404);
	} finally { await h.close(); }
});
