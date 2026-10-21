/**
 * The files capability: one host's file surface behind the shared transport.
 *
 * `/v1/files` is JSON RPC and answers a result the caller reads. The payload routes carry one file in or out as a body
 * instead, so their answer is handed back whole — status, headers and an unread body stream — because the caller of a
 * file is a relay that writes it to a browser at the browser's own pace. Nothing here collects a body: an upload is the
 * caller's stream handed to the host as it arrives, and a download is the host's stream handed to the caller, which is
 * what keeps the relay's own backpressure and caller-disconnect cancellation working unchanged.
 *
 * No caller of this capability builds a gateway URL or a bearer header for files, and nothing here is retried: a file
 * write whose answer never arrived is `outcome_unknown`, while a lost read is only offline.
 */

import { FileError, type Result } from "@earendil-works/pi-durable/env";
import type { UploadConflictStrategy } from "./file-transfer.ts";
import type { FileRequest } from "./filesystem.ts";
import { GatewayHostTransport, HostTransportError, type HostRequestPolicy } from "./host-client.ts";

/** One call's own cancellation and bound, for the methods whose answer arrives as data. */
export type FilesCallOptions = { readonly signal?: AbortSignal; readonly timeoutMs?: number };

/** The names a caller asks about in one directory, before it writes any of them. */
export type FilesUploadCheckCall = FilesCallOptions & {
	readonly workspaceId: string;
	/** The directory the names are checked in, inside the workspace. */
	readonly path: string;
	readonly names: readonly string[];
};

/**
 * One file into a workspace. The body is forwarded as it arrives — a stream stays a stream — so a file larger than any
 * JSON request reaches the host whole and no hop holds it.
 */
export type FilesUploadCall = FilesCallOptions & {
	readonly workspaceId: string;
	readonly path: string;
	/** What an existing name means. Absent is the host's own default, which refuses the whole upload. */
	readonly conflict?: UploadConflictStrategy;
	readonly body: BodyInit;
	/** The caller's own content length, when it has one: the host reads the body either way. */
	readonly contentLength?: string | number;
};

/** One file out of a workspace, or the byte range of it the caller asked for. */
export type FilesBytesCall = FilesCallOptions & {
	readonly workspaceId: string;
	readonly path: string;
	/** The caller's own `Range` header value; absent or empty asks for the whole file. */
	readonly range?: string | null;
};

/** The file methods that cannot change anything on the host, so a lost answer to one of them proves nothing ran. */
const READ_ONLY_FILE_METHODS: ReadonlySet<string> = new Set([
	"executionHost",
	"resourceSnapshot",
	"canonicalPath",
	"readTextFile",
	"readBinaryFile",
	"exists",
	"fileInfo",
	"listDir",
	"reader.info",
	"reader.read",
	"reader.scanLines",
]);

/** What losing the answer to this file method would mean: a dispatched write is never replayed. */
function policyOf(method: string): HostRequestPolicy {
	return READ_ONLY_FILE_METHODS.has(method) ? "read-only" : "mutation";
}

/** A workspace path as the host's routes carry it: rooted, and `/` for the workspace root itself. */
function workspacePath(path: string): string {
	if (path === "") return "/";
	if (!path.startsWith("/")) throw new HostTransportError("protocol_error", "a workspace path must be rooted: " + path);
	return path;
}

/** The answer to `/v1/files`, read as the filesystem's own result: a value, or the host's own failure code. */
function decodeFileResult<T>(value: unknown): Result<T, FileError> {
	const answer = value as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } | null;
	if (typeof answer !== "object" || answer === null || typeof answer.ok !== "boolean") throw new Error("not a filesystem answer");
	if (answer.ok) return { ok: true, value: answer.value as T };
	const code = answer.error?.code;
	const message = answer.error?.message;
	if (typeof code !== "string" || typeof message !== "string") throw new Error("a filesystem refusal names its code and its message");
	return { ok: false, error: new FileError(code as FileError["code"], message) };
}

/**
 * The files capability of one gateway binding. `rpc` speaks the JSON surface the execution environment uses; the three
 * payload methods return the host's own answer so the caller streams it rather than a copy of it.
 */
export class GatewayFilesCapability {
	readonly #transport: GatewayHostTransport;

	constructor(transport: GatewayHostTransport) {
		this.#transport = transport;
	}

	/**
	 * One filesystem call inside the workspace this capability is bound to. The workspace is the binding's, never a
	 * caller's, so a request can only name paths inside the workspace the host already serves.
	 *
	 * A failure keeps its existing spelling: the host's own `FileError` code for a refusal, and `unknown` for an
	 * answer that never arrived — a dispatched write may have run, and nothing is sent again.
	 */
	async rpc<T>(request: FileRequest, options: FilesCallOptions = {}): Promise<Result<T, FileError>> {
		try {
			return await this.#transport.json<Result<T, FileError>>({
				path: "/v1/files",
				body: request,
				policy: policyOf(request.method),
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				decode: decodeFileResult<T>,
			});
		} catch (error) {
			const cancelled = error instanceof HostTransportError && error.code === "aborted";
			return { ok: false, error: new FileError(cancelled ? "aborted" : "unknown", "gateway unavailable or dispatched filesystem outcome unknown", undefined, error instanceof Error ? error : undefined) };
		}
	}

	/**
	 * Which of these names already exist in a directory, and which of those could not be replaced. It is read-only, so a
	 * lost answer is only offline; the host's own status and refusal body come back for the caller to pass on.
	 */
	async uploadCheck(call: FilesUploadCheckCall): Promise<Response> {
		return await this.#transport.send({
			path: "/v1/files/upload-check",
			method: "POST",
			query: { workspaceId: call.workspaceId },
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: call.workspaceId, path: workspacePath(call.path), names: call.names }),
			policy: "read-only",
			...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
			...(call.signal === undefined ? {} : { signal: call.signal }),
		});
	}

	/**
	 * One file into the workspace as one body.
	 *
	 * The body is handed on unread and half-duplex, which is what Node's fetch needs to forward a stream; the host's
	 * answer — its status and its refusal body included — is returned for the caller to pass on. This is a mutation, so a
	 * connection lost mid-upload is `outcome_unknown` and the body is not sent a second time. No timeout bounds it: the
	 * request is as long as the file takes to arrive.
	 */
	async upload(call: FilesUploadCall): Promise<Response> {
		return await this.#transport.send({
			path: "/v1/files/upload",
			method: "POST",
			query: { workspaceId: call.workspaceId, path: workspacePath(call.path), conflict: call.conflict ?? "error" },
			headers: { "content-type": "application/octet-stream", ...(call.contentLength === undefined ? {} : { "content-length": String(call.contentLength) }) },
			body: call.body,
			duplex: "half",
			policy: "mutation",
			timeoutMs: call.timeoutMs ?? 0,
			...(call.signal === undefined ? {} : { signal: call.signal }),
		});
	}

	/**
	 * One file out of the workspace, or the byte range of it the caller asked for.
	 *
	 * The answer is returned before a byte of it is read: the caller pipes the body, so its own writes pace the host's
	 * reads, and cancelling the body is what ends the host request. A lost answer is offline, because a read changed
	 * nothing on the host.
	 */
	async bytes(call: FilesBytesCall): Promise<Response> {
		const range = call.range ?? null;
		return await this.#transport.send({
			path: "/v1/files/bytes",
			method: "GET",
			query: { workspaceId: call.workspaceId, path: workspacePath(call.path) },
			policy: "read-only",
			...(typeof range === "string" && range.trim() !== "" ? { headers: { range } } : {}),
			timeoutMs: call.timeoutMs ?? 0,
			...(call.signal === undefined ? {} : { signal: call.signal }),
		});
	}
}

/** The files capability of one gateway binding, built over the shared transport. */
export function filesCapability(transport: GatewayHostTransport): GatewayFilesCapability {
	return new GatewayFilesCapability(transport);
}
