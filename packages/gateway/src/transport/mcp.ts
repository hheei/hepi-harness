import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpHostRequest, McpHostResult } from "../mcp/host.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * The MCP family: this host's own configuration, servers and sign-ins, on one route.
 *
 * MCP belongs to the account this gateway runs as, so its operation reads and writes that account's files and may start
 * a server or a browser exchange. Two rules are therefore this file's own. The operation ends when the caller that asked
 * for it does: a response that closes before it is written aborts the signal the service was handed, so no server keeps
 * starting and nothing keeps being written for a client that is gone. And a host that serves no MCP answers its named
 * limit — `mcp_unavailable` — rather than a generic refusal, so every other setting on this gateway keeps working.
 */

/** The route this family answers, or undefined when the path and method name another family's request. */
export type McpRoute = "mcp";

/** The MCP route this request names: the path and the method together. */
export function mcpRoute(target: string, method: string): McpRoute | undefined {
	return method === "POST" && target === "/v1/mcp" ? "mcp" : undefined;
}

/**
 * What this family needs of the MCP capability: one operation, and the caller's own abort.
 *
 * Stated as the operation rather than as the service class, because the lifetime rule below is about a signal a service
 * honours, not about which class it is: the host's own service satisfies it, and so does a test's stand-in.
 */
export type McpCapability = { execute(request: McpHostRequest, signal?: AbortSignal): Promise<McpHostResult> };

/** The MCP routes of one gateway, over the capability it borrows and may not have. */
export class McpTransport {
	readonly #service: McpCapability | undefined;

	constructor(service: McpCapability | undefined) {
		this.#service = service;
	}

	async handle(_route: McpRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson(request);
		if (!body || typeof body !== "object" || typeof (body as { operation?: unknown }).operation !== "string") {
			writeJson(response, 400, { ok: false, code: "invalid_request" });
			return;
		}
		// A caller that goes away ends the operation it asked for: the ingress aborts its own call on a revoked credential
		// or a disconnected client, and this is where that reaches the work it started — a server being started, or a
		// sign-in mid-exchange — so nothing keeps running, and nothing keeps writing, after the caller that asked is gone.
		const controller = new AbortController();
		response.on("close", () => { if (!response.writableEnded) controller.abort(); });
		const result: McpHostResult = this.#service === undefined
			? { ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" }
			: await this.#service.execute(body as McpHostRequest, controller.signal);
		writeJson(response, 200, result);
	}
}
