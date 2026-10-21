import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayHostClient, parseUploadConflict, type GatewayFilesCapability } from "@hepi/gateway";
import { routingLocation } from "./routing-location.ts";

/**
 * The browser's file routes on the backend: the one place a browser's upload or download reaches the execution host.
 *
 * A browser names a routing cwd and nothing else; this relay resolves it to the workspace binding every other
 * host-facing route uses — a project folder, a retained binding and a configured workspace all reach the host that
 * really owns them — and forwards to that host's file payload routes. The bytes travel as a body rather than inside a
 * JSON request, which is what lets a file larger than the workbench proxy's own JSON body limit arrive whole.
 *
 * Nothing is stored here and no second file API exists: the host owns every rule about what may be written, which is
 * why a refusal keeps the host's status, code and reason instead of being flattened into a generic failure.
 */

/** One workspace as the host that owns it is reached: its id, the connection and the gateway that serves it. */
export type FileRelayBinding = { readonly id: string; readonly gatewayId: string; readonly gatewayOrigin: string; readonly gatewayToken: string };

export type FileRelayOptions = {
	/** The binding one workspace id resolves to, or undefined when this deployment serves no such workspace. */
	readonly binding: (workspaceId: string) => Promise<FileRelayBinding | undefined>;
	/** The backend's own bounded body reader, so this route adds no second limit to the ones the server already has. */
	readonly readBody: (request: IncomingMessage) => Promise<unknown>;
};

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/**
 * Wait until a response can take another write, or until it is over.
 *
 * A caller that goes away mid-download is the state this loop spends its time in, and its close may already have fired
 * by the time a write reports backpressure. Checking the state first is what makes this a wait that always ends.
 */
function drained(response: ServerResponse): Promise<void> {
	if (response.writableEnded || response.destroyed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
		response.once("drain", done);
		response.once("close", done);
	});
}

/** The headers a streamed answer carries back: the host's own, and nothing invented here. */
const STREAM_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"] as const;

/**
 * The file routes this relay answers. It returns true when the request was one of them, so the caller's own routing is
 * untouched by every other path.
 */
export function createFileRelay(options: FileRelayOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
	/** One workspace binding for a cwd the caller named, or the refusal the caller reads. */
	const bound = async (cwd: string | null, response: ServerResponse): Promise<{ binding: FileRelayBinding; relativePath: string } | null> => {
		const location = cwd === null ? null : routingLocation(cwd);
		if (location === null) { json(response, 501, { ok: false, code: "not_supported", message: "a file request names the workspace it is about" }); return null; }
		const binding = await options.binding(location.workspaceId);
		if (binding === undefined) { json(response, 404, { ok: false, code: "unknown_workspace" }); return null; }
		return { binding, relativePath: location.relativePath };
	};

	/**
	 * The caller's own connection, as cancellation.
	 *
	 * `aborted` is the request the client gave up on, and the response's `close` before it was ended is the caller that
	 * went away mid-answer — the state a download spends its time in. An incoming request's own `close` is deliberately
	 * not watched: Node fires it as soon as a request body has been read to the end, which is every completed upload, so
	 * it says nothing about whether the caller is still there.
	 */
	const callerGone = (message: IncomingMessage, response: ServerResponse): { signal: AbortSignal; release: () => void } => {
		const abort = new AbortController();
		const cancelled = () => abort.abort();
		const closed = () => { if (!response.writableEnded) cancelled(); };
		message.on("aborted", cancelled);
		response.on("close", closed);
		return { signal: abort.signal, release: () => { message.off("aborted", cancelled); response.off("close", closed); } };
	};

	/** The files capability of one resolved binding: the host's payload routes, over the one shared transport. */
	const filesOf = (binding: FileRelayBinding): GatewayFilesCapability => new GatewayHostClient({ gatewayOrigin: binding.gatewayOrigin, gatewayToken: binding.gatewayToken }).files;

	/**
	 * One request to a host's file payload surface. It is opened for this caller alone, so it carries that caller's own
	 * connection as its cancellation: a caller that goes away while its download is quiet, or while its upload is still
	 * being written, must not leave a host request running with nobody to read it.
	 *
	 * The answer is the host's whole response — status, headers and an unread body — so nothing here collects a file.
	 * A call that produced no answer at all is the only thing this route answers itself: a caller that is already gone
	 * has nobody to answer, and a response whose headers were sent cannot state a new status.
	 */
	const forward = async (call: () => Promise<Response>, response: ServerResponse, signal: AbortSignal): Promise<Response | null> => {
		try {
			return await call();
		} catch {
			if (!signal.aborted && !response.headersSent) json(response, 503, { ok: false, code: "gateway_offline" });
			return null;
		}
	};

	return async (message, response, url) => {
		const path = url.pathname;
		if (path !== "/api/files/upload" && path !== "/api/files/upload-check" && path !== "/api/files/bytes") return false;

		const caller = callerGone(message, response);
		const abort = { signal: caller.signal };
		try {
			if (path === "/api/files/upload-check") {
				if (message.method !== "POST") { json(response, 405, { ok: false, code: "invalid_request" }); return true; }
				const body = await options.readBody(message) as { cwd?: unknown; fileNames?: unknown } | undefined;
				const target = await bound(typeof body?.cwd === "string" ? body.cwd : null, response);
				if (target === null || abort.signal.aborted) return true;
				if (!Array.isArray(body?.fileNames) || body.fileNames.some((name) => typeof name !== "string")) { json(response, 400, { ok: false, code: "invalid_request", message: "a check names the file names it asks about" }); return true; }
				const upstream = await forward(() => filesOf(target.binding).uploadCheck({
					workspaceId: target.binding.id,
					path: target.relativePath === "" ? "/" : "/" + target.relativePath,
					names: body.fileNames as string[],
					signal: abort.signal,
				}), response, abort.signal);
				if (upstream !== null) json(response, upstream.status, await upstream.json().catch(() => ({ ok: false, code: "operation_failed" })));
				return true;
			}

			if (path === "/api/files/upload") {
				if (message.method !== "POST") { json(response, 405, { ok: false, code: "invalid_request" }); return true; }
				const target = await bound(url.searchParams.get("cwd"), response);
				if (target === null || target.relativePath === "" || abort.signal.aborted) {
					if (target !== null) json(response, 400, { ok: false, code: "invalid_request", message: "an upload names one file" });
					return true;
				}
				// The strategy is the file surface's own vocabulary, so it is read the way the host reads it: a name this
				// surface does not serve is refused with the status and code the host would answer, before a byte is sent.
				const conflict = parseUploadConflict(url.searchParams.get("conflict"));
				if (conflict === null) { json(response, 400, { ok: false, code: "invalid_request", message: "conflict names one of error, overwrite or skip" }); return true; }
				// The body is the caller's own stream, handed to the host as it arrives: nothing buffers a whole file here.
				const upstream = await forward(() => filesOf(target.binding).upload({
					workspaceId: target.binding.id,
					path: "/" + target.relativePath,
					conflict,
					body: message as unknown as BodyInit,
					...(typeof message.headers["content-length"] === "string" ? { contentLength: message.headers["content-length"] } : {}),
					signal: abort.signal,
				}), response, abort.signal);
				if (upstream !== null) json(response, upstream.status, await upstream.json().catch(() => ({ ok: false, code: "operation_failed" })));
				return true;
			}

			if (message.method !== "GET") { json(response, 405, { ok: false, code: "invalid_request" }); return true; }
			const target = await bound(url.searchParams.get("cwd"), response);
			if (target === null || target.relativePath === "" || abort.signal.aborted) {
				if (target !== null) json(response, 400, { ok: false, code: "invalid_request", message: "a download names one file" });
				return true;
			}
			const range = message.headers.range;
			const upstream = await forward(() => filesOf(target.binding).bytes({
				workspaceId: target.binding.id,
				path: "/" + target.relativePath,
				range: typeof range === "string" ? range : null,
				signal: abort.signal,
			}), response, abort.signal);
			if (upstream === null) return true;
			if (!upstream.ok || upstream.body === null) {
				json(response, upstream.status, await upstream.json().catch(() => ({ ok: false, code: "operation_failed" })));
				return true;
			}
			const headers: Record<string, string> = {};
			for (const name of STREAM_HEADERS) { const value = upstream.headers.get(name); if (value !== null) headers[name] = value; }
			response.writeHead(upstream.status, headers);
			const reader = upstream.body.getReader();
			try {
				while (!abort.signal.aborted) {
					const chunk = await reader.read();
					if (chunk.done) break;
					// The caller's socket is the pace: a write that reports backpressure waits for the socket, and a caller
					// that went away during that wait ends it instead of being waited for.
					if (response.writableEnded || response.destroyed) break;
					if (!response.write(chunk.value)) await drained(response);
				}
			} catch {
				// The host stream ended or was cancelled with the caller: the response is closed below either way.
			} finally {
				await reader.cancel().catch(() => {});
				if (!response.writableEnded && !response.destroyed) response.end();
			}
			return true;
		} finally {
			caller.release();
		}
	};
}
