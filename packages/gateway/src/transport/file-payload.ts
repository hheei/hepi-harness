import type { IncomingMessage, ServerResponse } from "node:http";
import { DOWNLOAD_CHUNK_BYTES, hostFailure, inspectUpload, openDownload, parseUploadConflict, uploadFile, type Download, type UploadConflict } from "../file-transfer.ts";
import type { GatewayFiles } from "../filesystem.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * One file in, or one file out, as a body.
 *
 * The JSON file RPC caps a request at 1 MiB, so these routes carry the same files as payloads instead: the body is
 * streamed in bounded chunks and the same host filesystem the RPC reads applies the same confinement, conflict rules
 * and 16 MiB ceiling. Everything below is this family's own — the query each route reads, the status one host failure
 * keeps, the atomic staging an upload relies on, the byte-range framing a download answers with, and the closing of
 * the host reader whether the range was served or the caller went away first — so a change to any of it is a change to
 * this file and to its contract checks, not to the transport that admitted the request.
 */

/** The file payload routes: one file in as a body, one file out as a body. */
export type FilePayloadRoute = "upload" | "upload-check" | "bytes";

/** The file payload route this request names, or undefined when it names none of them. */
export function filePayloadRoute(path: string, method: string): FilePayloadRoute | undefined {
	if (path === "/v1/files/upload") return method === "POST" ? "upload" : undefined;
	if (path === "/v1/files/upload-check") return method === "POST" ? "upload-check" : undefined;
	if (path === "/v1/files/bytes") return method === "GET" ? "bytes" : undefined;
	return undefined;
}

/** The HTTP status one file payload failure keeps: the caller reads the host's own code and reason. */
function payloadStatus(code: string): number {
	switch (code) {
		case "invalid_request": return 400;
		case "unknown_workspace": case "unknown_directory": case "not_found": case "not_a_file": return 404;
		case "permission_denied": return 403;
		case "conflict": case "not_replaceable": return 409;
		case "file_too_large": return 413;
		case "invalid_range": return 400;
		case "unsatisfiable_range": return 416;
		case "not_supported": return 501;
		default: return 500;
	}
}

/**
 * Wait until a response can take another write, or until it is over.
 *
 * A caller that goes away mid-body is the state a download spends its time in, and its close may already have fired by
 * the time a write reports backpressure. Checking the state first is what makes this a wait that always ends: a
 * promise waiting for a `close` that already happened is a host reader nobody ever releases.
 */
function drained(response: ServerResponse): Promise<void> {
	if (response.writableEnded || response.destroyed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
		response.once("drain", done);
		response.once("close", done);
	});
}

/** The payload routes of one gateway, over the filesystem capability it borrows. */
export class FilePayloadTransport {
	readonly #files: GatewayFiles | undefined;

	constructor(files: GatewayFiles | undefined) {
		this.#files = files;
	}

	/**
	 * One file in, or one file out, as a body.
	 *
	 * An upload is written to a host-created temporary file and renamed over its target only once the whole body
	 * arrived, so a refused or interrupted upload leaves no partial file; the conflict rules and the 16 MiB ceiling are
	 * the file surface's own. A download is read in bounded chunks through the host's reader handle, and the handle is
	 * closed whether the range was served or the caller went away first.
	 */
	async handle(route: FilePayloadRoute, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const files = this.#files;
		if (files === undefined) { writeJson(response, 404, { ok: false, code: "unknown_workspace", message: "this gateway serves no filesystem" }); return; }
		const workspaceId = url.searchParams.get("workspaceId") ?? "";
		if (workspaceId === "") { writeJson(response, 400, { ok: false, code: "invalid_request", message: "a request names the workspace it is about" }); return; }

		if (route === "upload-check") {
			const body = await readJson(request) as { path?: unknown; names?: unknown } | undefined;
			if (typeof body?.path !== "string" || !Array.isArray(body.names) || body.names.some((name) => typeof name !== "string")) {
				writeJson(response, 400, { ok: false, code: "invalid_request", message: "a check names the directory and the file names" });
				return;
			}
			const inspected = await inspectUpload(files, workspaceId, body.path, body.names as string[]);
			if (!inspected.ok) { writeJson(response, payloadStatus(inspected.error.code), { ok: false, ...hostFailure(inspected.error, body.path) }); return; }
			writeJson(response, 200, { ok: true, value: inspected.value });
			return;
		}

		const path = url.searchParams.get("path") ?? "";
		if (path === "") { writeJson(response, 400, { ok: false, code: "invalid_request", message: "a request names the file it is about" }); return; }

		if (route === "upload") {
			const strategy = parseUploadConflict(url.searchParams.get("conflict"));
			if (strategy === null) { writeJson(response, 400, { ok: false, code: "invalid_request", message: "conflict names one of error, overwrite or skip" }); return; }
			const result = await uploadFile(files, workspaceId, path, strategy, request);
			if (result.ok) { writeJson(response, 200, { ok: true, value: result.value }); return; }
			const conflict = (result as { conflict?: UploadConflict }).conflict;
			// The host's own code and status answer; its words are put in workspace terms, because a failure it found on
			// its own disk would otherwise state where this workspace lives on that host.
			writeJson(response, payloadStatus(result.error.code), { ok: false, ...hostFailure(result.error, path), ...(conflict ?? {}) });
			return;
		}

		const opened = await openDownload(files, workspaceId, path, request.headers.range ?? null);
		if (!opened.ok) { writeJson(response, payloadStatus(opened.error.code), { ok: false, ...hostFailure(opened.error, path) }); return; }
		await this.#stream(files, workspaceId, opened.value, response);
	}

	/** The opened range, written as it is read: one bounded chunk at a time, and the host's reader closed either way. */
	async #stream(files: GatewayFiles, workspaceId: string, download: Download, response: ServerResponse): Promise<void> {
		const partial = download.length !== download.size;
		response.writeHead(partial ? 206 : 200, {
			"content-type": "application/octet-stream",
			"content-length": String(download.length),
			"accept-ranges": "bytes",
			...(partial ? { "content-range": "bytes " + download.offset + "-" + (download.offset + download.length - 1) + "/" + download.size } : {}),
		});
		let gone = false;
		const cancelled = () => { gone = true; };
		response.on("close", cancelled);
		let offset = download.offset;
		let remaining = download.length;
		try {
			while (remaining > 0 && !gone && !response.writableEnded) {
				const read = await files.execute({ workspaceId, method: "reader.read", handle: download.handle, offset, length: Math.min(remaining, DOWNLOAD_CHUNK_BYTES) }) as { ok: true; value: string } | { ok: false; error: { code: string; message: string } };
				// The status and length are already sent, so a host read that fails here ends the body rather than
				// answering something else: the caller reads a short body, never a wrong one.
				if (!read.ok) break;
				const chunk = Buffer.from(read.value, "base64");
				if (chunk.byteLength === 0) break;
				offset += chunk.byteLength;
				remaining -= chunk.byteLength;
				if (!response.write(chunk)) await drained(response);
			}
		} finally {
			response.off("close", cancelled);
			await files.execute({ workspaceId, method: "reader.close", handle: download.handle }).catch(() => undefined);
			if (!response.writableEnded && !response.destroyed) response.end();
		}
	}
}
