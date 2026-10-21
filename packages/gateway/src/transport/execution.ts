import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeFrame, validExecuteRequest, type ExecuteFrame, type ExecuteRequest, type ExecuteResult, type OutputChunk } from "../execution.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * The execution family: one call streamed as frames, and the abort that ends one.
 *
 * A call is an NDJSON stream — one output frame per chunk as it arrives, then the single result frame that ends it — so
 * the framing a caller reads is this file's own: the content type and cache header, the encode of a frame, the byte
 * budget that ends a connection nobody is reading, and what a caller that stops listening means. That last one is the
 * family's sharpest rule and no other route shares it: a client that goes away does *not* stop its call. Nothing says
 * whether the command ran, so the ledger keeps the outcome and the stream simply stops writing. An abort is the only
 * thing that ends a running call, and it is a request of its own.
 */

/** The route this family answers, or undefined when the path and method name another family's request. */
export type ExecutionRoute = "execute" | "abort";

/** The execution route this request names: the path and the method together, and nothing else decides it. */
export function executionRoute(target: string, method: string): ExecutionRoute | undefined {
	if (method !== "POST") return undefined;
	if (target === "/v1/execute") return "execute";
	if (target === "/v1/abort") return "abort";
	return undefined;
}

/**
 * What one gateway's ledger offers this family: the call it decides whether to run, and the abort that stops one.
 *
 * The family frames a call; it never decides whether one may run. Admission of an ID, the fingerprint of a repeated
 * request and the journal that outlives the process all stay with the gateway behind this seam.
 */
export type ExecutionCapability = {
	execute(request: ExecuteRequest, onOutput?: (chunk: OutputChunk) => void | Promise<void>): Promise<ExecuteResult>;
	abort(callId: string): boolean;
};

/** How much of its own frames one connection may hold before it is not reading: a frame is never the thing refused. */
const FRAME_BUFFER_BYTES = 1024 * 1024;

/** The execution routes of one gateway, over the capability it borrows. */
export class ExecutionTransport {
	readonly #capability: ExecutionCapability;

	constructor(capability: ExecutionCapability) {
		this.#capability = capability;
	}

	async handle(route: ExecutionRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson(request);
		if (route === "abort") {
			const callId = (body as { callId?: unknown } | undefined)?.callId;
			if (typeof callId !== "string" || !callId.trim()) {
				writeJson(response, 400, { ok: false, code: "invalid_request" });
				return;
			}
			writeJson(response, 200, { ok: this.#capability.abort(callId) });
			return;
		}
		if (!validExecuteRequest(body)) {
			writeJson(response, 400, { ok: false, code: "invalid_request" });
			return;
		}
		await this.#stream(body, response);
	}

	/** Stream one call: output frames as they arrive, then the single result frame that ends the response. */
	async #stream(request: ExecuteRequest, response: ServerResponse): Promise<void> {
		const write = async (frame: ExecuteFrame) => {
			if (response.writableEnded || response.destroyed) return;
			const encoded = encodeFrame(frame);
			if (response.writableLength + Buffer.byteLength(encoded) > FRAME_BUFFER_BYTES) { response.destroy(); return; }
			if (!response.write(encoded)) await new Promise<void>((resolve) => {
				const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
				response.once("drain", done); response.once("close", done);
			});
		};
		response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "transfer-encoding": "chunked" });
		let clientGone = false;
		response.on("close", () => {
			// A client that stops listening does not stop the call: nothing says whether it ran, so the ledger keeps it.
			if (!response.writableEnded) clientGone = true;
		});
		const result = await this.#capability.execute(request, (chunk) => {
			return write({ type: "output", stream: chunk.stream, text: chunk.text, ...(chunk.skipped === undefined ? {} : { skipped: chunk.skipped }) });
		});
		if (!clientGone) await write({ type: "result", result });
		response.end();
	}
}
