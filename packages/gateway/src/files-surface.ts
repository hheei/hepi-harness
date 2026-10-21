import { Readable } from "node:stream";
import {
	buildEntriesFromFiles,
	byteServedMime,
	documentPreviewKind,
	fileExtensionOf,
	filterFileEntries,
	parseUploadConflictStrategy,
	servesBytes,
	validateUploadFileNames,
	workspaceRoutingLocation,
	type FileIndexResponse,
	type FileListingEntry,
	type FileListingResponse,
	type FileMetaResponse,
	type FilePreviewResponse,
	type GitFileDiffResponse,
	type GitFileStatus,
	type GitFileStatusKind,
	type GitStatusResponse,
	type UploadBatchResponse,
	type UploadInspectionResponse,
} from "@hepi/protocol/files";
import { MAX_UPLOAD_BATCH_BYTES, UploadTooLargeError, readUploadParts, type UploadBody, type UploadPart, type UploadRequestHeaders } from "./multipart.ts";

/**
 * The browser's file surface: one implementation, whatever entry happens to serve it.
 *
 * A browser speaks a vocabulary of its own — `/api/files/<routing path>?type=…`, `/api/file-index`,
 * `/api/git/status`, `/api/git/diff` — and every fact behind those addresses belongs to the Backend and the execution
 * host: which workspace a routing path names, what may be written into it, the batch bound, the byte range, the
 * conflict rules and the host's own refusals. So this module owns the translation and nothing else. It reads the
 * browser's request, calls the Backend's own routes, and answers in the browser's vocabulary; it holds no file state, no
 * cache and no policy of its own beyond the batch bound the entry hop is the right place to enforce.
 *
 * That is what keeps the surface from existing twice. The client ingress serves it for a Web page or an App, and the
 * Web origin's own handler serves the same implementation while the Next entry is still the deployed one; neither keeps
 * a second copy of listing, preview, upload or Git logic, and neither can disagree with the other about what a browser
 * path means — that parse lives in `@hepi/protocol/files` and is used by both.
 *
 * Two things are deliberately absent. There is no watcher: live file watch answers its own truthful 501, because the
 * capability does not exist and a migration is not a reason to invent one. And there is no buffering: an upload is
 * relayed part by part as it arrives and a download's body is the Backend's own, so a file larger than any JSON request
 * crosses this hop without being held.
 */

/** The Backend's own authenticated API as the hosting process reaches it. */
export type FileSurfaceCall = (path: string, init?: RequestInit) => Promise<Response>;

export type FileSurfaceOptions = {
	readonly call: FileSurfaceCall;
	/** The batch bound one browser upload may carry; absent reads {@link MAX_UPLOAD_BATCH_BYTES}. */
	readonly totalUploadBytes?: number;
};

/** One browser request, as either runtime states it: a `Request`'s parts, or a `node:http` message's. */
export type FileSurfaceRequest = {
	readonly method: string;
	readonly url: URL;
	readonly headers: UploadRequestHeaders;
	/** The body, when the request has one. A GET passes none. */
	readonly body?: UploadBody | null;
	/**
	 * The caller's own cancellation, carried to every Backend call this request makes.
	 *
	 * A download outlives the request that started it: its body is still being read when the caller goes away, so a hop
	 * that did not pass this on would leave the Backend — and behind it the host reader — streaming to nobody.
	 */
	readonly signal?: AbortSignal;
};

const FILE_INDEX_MAX_FILES = 5000;
const WORKSPACE_PREFIX = "/workspace/";

/** The language a viewer highlights this file as. The extension table is the viewer's own choice, not the host's. */
const EXT_LANGUAGE: Readonly<Record<string, string>> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
	c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
	html: "html", htm: "html", css: "css", scss: "css", less: "css",
	json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
	md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
	sql: "sql", graphql: "graphql", gql: "graphql", tf: "hcl", hcl: "hcl", env: "bash", gitignore: "bash", txt: "text",
};

/** The language a text preview is highlighted as, from the file's own name. */
function previewLanguageOf(filePath: string): string {
	const base = (filePath.split("/").pop() ?? "").toLowerCase();
	if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
	if (base === ".env" || base.startsWith(".env.")) return "bash";
	if (base === "makefile" || base === "gnumakefile") return "makefile";
	return EXT_LANGUAGE[fileExtensionOf(filePath)] ?? "text";
}

/**
 * One directory of the host's flat listing, as a tree renders it. The listing reports names only, so a row states no
 * size and no time rather than inventing one.
 */
function listDirectoryEntries(files: readonly string[], relativeDir: string): FileListingEntry[] {
	const prefix = relativeDir === "" ? "" : relativeDir + "/";
	const names = new Map<string, boolean>();
	for (const file of files) {
		if (!file.startsWith(prefix)) continue;
		const rest = file.slice(prefix.length);
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : rest.slice(0, slash);
		if (name !== "" && !names.has(name)) names.set(name, slash !== -1);
	}
	return [...names]
		.map(([name, isDir]) => ({ name, isDir, size: 0, modified: "" }))
		.sort((left, right) => (left.isDir !== right.isDir ? (left.isDir ? -1 : 1) : left.name.localeCompare(right.name)));
}

/** The host's status vocabulary, as the browser's Git view names the same states. */
const STATUS_CODES: Readonly<Record<string, { status: GitFileStatusKind; code: GitFileStatus["code"] }>> = {
	added: { status: "added", code: "A" },
	copied: { status: "renamed", code: "C" },
	deleted: { status: "deleted", code: "D" },
	modified: { status: "modified", code: "M" },
	renamed: { status: "renamed", code: "R" },
	untracked: { status: "untracked", code: "U" },
};

/** One changed file as the host reported it. */
type SurfaceChangedFile = { readonly path: string; readonly previousPath?: string; readonly status: string; readonly staged: boolean };

/** One answer from the host's `changes` operation. */
type SurfaceChanges = { readonly state?: string; readonly files?: SurfaceChangedFile[] };

/** The workbench answer shape, as `POST /api/workbench` states it. */
type WorkbenchAnswer = { ok: true; value: unknown } | { ok: false; code: string };

const JSON_HEADERS = { "content-type": "application/json" } as const;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** A capability this surface does not have, named as the absence it is. */
const unsupported = (message: string): Response => json(501, { error: message, code: "unsupported", accepted: false });

/** The refusal a browser path that names no workspace gets: the surface has nothing to serve there. */
const NOT_A_WORKSPACE = "Only configured /workspace/<id> paths are available";

/** The MIME and range headers a byte answer carries back, as the host stated them. */
const STREAM_HEADERS = ["content-length", "content-range", "accept-ranges"] as const;

/** Whether this request belongs to the surface, decided before anything is read. */
export function isFileSurfacePath(pathname: string): boolean {
	return pathname === "/api/file-index"
		|| pathname === "/api/git/status"
		|| pathname === "/api/git/diff"
		|| pathname === "/api/files"
		|| pathname.startsWith("/api/files/");
}

/** A refusal this hop decided on, carried out of the multipart reader so the request stops where it stands. */
class SurfaceRefusal extends Error {
	readonly response: Response;
	constructor(response: Response) {
		super("the upload was refused");
		this.name = "SurfaceRefusal";
		this.response = response;
	}
}

export function createFileSurface(options: FileSurfaceOptions): (request: FileSurfaceRequest) => Promise<Response | null> {
	const totalUploadBytes = options.totalUploadBytes ?? MAX_UPLOAD_BATCH_BYTES;

	/** One workbench operation, as the Backend answers it. A refusal keeps the Backend's own code. */
	async function workbench(workspaceId: string, operation: string, path: string | undefined, signal: AbortSignal | undefined): Promise<WorkbenchAnswer> {
		const response = await options.call("/api/workbench", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ workspaceId, operation, ...(path === undefined ? {} : { path }) }),
			...(signal === undefined ? {} : { signal }),
		});
		try {
			return await response.json() as WorkbenchAnswer;
		} catch {
			return { ok: false, code: "operation_failed" };
		}
	}

	/**
	 * The refusal a workbench operation became, or null when it answered. Each answer states the cause it really has,
	 * because the browser's next move differs for every one of them:
	 *
	 * - a workspace this deployment does not serve is the `404` it has always been;
	 * - a path the host refused keeps the `403` its own confinement decided;
	 * - a path the host does not have is the `404` it is: a file deleted after a tree was listed is missing, not a
	 *   broken host, and the browser's move is to reload the folder rather than to retry the same read;
	 * - a host that could not be reached stays the `503` it says it is, rather than becoming a capability claim;
	 * - a gateway composed without a workbench answers the `501` that names the absence — the only case that answer is
	 *   true, and it is the gateway's own `not_supported` that says so;
	 * - anything else is a workbench that exists and did not complete, which is the `500` it is.
	 *
	 * The last two were one answer until this revision: every other code became "this host is composed without the
	 * workbench surface". That flattening told a person a working deployment cannot do something it can, and the false
	 * claim was the ordinary case — the surface and the host both cache a listing, so opening a file someone deleted
	 * reached the browser as the host's `operation_failed` and used to read as a missing capability. That same deleted
	 * file now has a name of its own, `not_found`, and the two are told apart instead of sharing a `500`. No reason the
	 * host did not give is invented here, and no named cause is dropped.
	 */
	function workbenchRefusal(result: { ok: false; code: string }, what: string): Response | null {
		if (result.code === "unknown_workspace") return json(404, { ok: false, code: "unknown_workspace", error: "no such workspace in this deployment" });
		if (result.code === "path_denied") return json(403, { ok: false, code: "path_denied", error: "the host refused that path" });
		if (result.code === "not_found") return json(404, { ok: false, code: "not_found", error: "the host has no such path, so it cannot answer for " + what });
		if (result.code === "gateway_offline") return json(503, { ok: false, code: "gateway_offline", error: "the host serving this workspace could not be reached for " + what });
		if (result.code === "not_supported") return json(501, { ok: false, code: "not_supported", error: "this host is composed without a workbench, so it serves no " + what });
		return json(500, { ok: false, code: "operation_failed", error: "the host could not answer for " + what });
	}

	/** The flat listing, shared by the tree and the `@` index: one host read, as the Backend's own cache serves it. */
	async function listedFiles(workspaceId: string, signal: AbortSignal | undefined): Promise<string[] | Response> {
		const result = await workbench(workspaceId, "files", undefined, signal);
		if (!result.ok) return workbenchRefusal(result, "a file listing")!;
		if (!Array.isArray(result.value)) return json(502, { error: "The gateway answered the listing with something that is not one" });
		return result.value.filter((item): item is string => typeof item === "string");
	}

	/** The host's changed files, or the refusal; `null` when it is not a Git checkout it can answer for. */
	async function changedFiles(workspaceId: string, signal: AbortSignal | undefined): Promise<SurfaceChangedFile[] | null | Response> {
		const result = await workbench(workspaceId, "changes", undefined, signal);
		if (!result.ok) return workbenchRefusal(result, "changed files")!;
		const value = result.value as SurfaceChanges;
		if (value.state !== "available" || !Array.isArray(value.files)) return null;
		return value.files;
	}

	/**
	 * The bytes of one file, streamed from the Backend with the browser's own range header and the host's own range
	 * answer. Nothing is collected here: the body is the Backend's, passed on as it arrives, which is what lets a file
	 * larger than one JSON request reach the browser at all.
	 */
	async function byteResponse(request: FileSurfaceRequest, routingPath: string, relativePath: string, attachment: boolean): Promise<Response> {
		const range = headerValue(request.headers, "range");
		const response = await options.call("/api/files/bytes?cwd=" + encodeURIComponent(routingPath), {
			method: "GET",
			...(range === undefined ? {} : { headers: { range } }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		if (!response.ok || response.body === null) {
			const body = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string };
			// The host's own code travels with the words, as it does for every other refusal this surface answers: a
			// `413` and a `404` are the same status-less string to a viewer that cannot tell "too big" from "not there".
			return json(response.status, {
				error: body.message ?? body.error ?? "The file could not be read (HTTP " + response.status + ")",
				...(body.code === undefined ? {} : { code: body.code }),
			});
		}
		const headers = new Headers();
		headers.set("content-type", byteServedMime(relativePath) ?? response.headers.get("content-type") ?? "application/octet-stream");
		for (const name of STREAM_HEADERS) {
			const value = response.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		if (attachment) {
			const name = relativePath.split("/").pop() ?? "file";
			headers.set("content-disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(name));
		}
		headers.set("cache-control", "no-cache");
		return new Response(response.body, { status: response.status, headers });
	}

	/** The host's answer about the names an upload asks about, or the refusal the browser reads instead. */
	async function inspectUpload(cwd: string, fileNames: readonly string[], signal: AbortSignal | undefined): Promise<UploadInspectionResponse | Response> {
		const response = await options.call("/api/files/upload-check", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ cwd, fileNames }),
			...(signal === undefined ? {} : { signal }),
		});
		const body = await response.json().catch(() => ({})) as { ok?: boolean; value?: UploadInspectionResponse; message?: string; error?: string };
		if (!response.ok || body.ok !== true || body.value === undefined) {
			return json(response.status === 200 ? 502 : response.status, { error: body.message ?? body.error ?? "The upload check failed (HTTP " + response.status + ")" });
		}
		return { conflicts: body.value.conflicts ?? [], nonReplaceable: body.value.nonReplaceable ?? [] };
	}

	/**
	 * One file's bytes, relayed to the Backend as they arrive.
	 *
	 * The part is read out whatever the host answered: a refusal must not leave the wire half-read, because the next
	 * file is behind this one. The body the Backend receives is a stream rather than a buffer, so no hop on the way holds
	 * a whole file — and this is the hop that must not, because the caller's own reading is what paces it.
	 */
	async function relayPart(part: UploadPart, target: string, strategy: string, signal: AbortSignal | undefined): Promise<Response> {
		try {
			return await options.call("/api/files/upload?cwd=" + encodeURIComponent(target) + "&conflict=" + strategy, {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				// The part is a Node stream, which the runtime's fetch forwards as an async iterable without collecting it.
				body: part.body as unknown as BodyInit,
				// Node's fetch needs the half-duplex hint for a streamed request body.
				duplex: "half",
				...(signal === undefined ? {} : { signal }),
			} as RequestInit & { duplex: "half" });
		} finally {
			// Whatever the host answered, the part is read to its end so the parser can reach the parts behind it.
			await drainPart(part.body);
		}
	}

	/**
	 * One upload: the browser's own rules, applied to the host that holds the directory, one file at a time.
	 *
	 * The body is read as it arrives rather than held, so an upload is bounded by policy instead of by what the process
	 * can hold: each file is relayed to the host while the next is still on the wire. The names are checked as they
	 * arrive, so a name that already exists is refused without being written, and each file travels as its own byte
	 * request, so one failure cannot lose the others — the partial answer the explorer reads as uploaded, skipped and
	 * failed.
	 */
	async function uploadRequest(request: FileSurfaceRequest, routingDirectory: string): Promise<Response> {
		const strategy = parseUploadConflictStrategy(request.url.searchParams.get("conflict"));
		if (strategy === null) return json(400, { error: "Unknown upload conflict strategy" });
		if (workspaceRoutingLocation(routingDirectory) === null) return unsupported(NOT_A_WORKSPACE);
		if (!(headerValue(request.headers, "content-type") ?? "").startsWith("multipart/form-data")) return json(400, { error: "The upload is not a multipart form" });
		if (request.body === undefined || request.body === null) return json(400, { error: "The upload carries no body" });

		const uploaded: string[] = [];
		const skipped: string[] = [];
		const errors: { name: string; error: string }[] = [];
		const take = async (part: UploadPart): Promise<void> => {
			const invalid = validateUploadFileNames([part.fileName]);
			if (invalid !== null) throw new SurfaceRefusal(json(400, { error: invalid }));
			const target = routingDirectory === "/" ? "/" + part.fileName : routingDirectory + "/" + part.fileName;
			if (strategy === "error") {
				const inspected = await inspectUpload(routingDirectory, [part.fileName], request.signal);
				if (inspected instanceof Response) throw new SurfaceRefusal(inspected);
				if (inspected.conflicts.length > 0) throw new SurfaceRefusal(json(409, { error: "Some files already exist", conflicts: inspected.conflicts, nonReplaceable: inspected.nonReplaceable }));
			}
			const response = await relayPart(part, target, strategy, request.signal);
			const body = await response.json().catch(() => ({})) as { ok?: boolean; value?: { skipped?: boolean }; code?: string; message?: string; error?: string; conflicts?: string[]; nonReplaceable?: string[] };
			if (response.ok && body.ok === true) {
				(body.value?.skipped === true ? skipped : uploaded).push(part.fileName);
				return;
			}
			// The host's conflict answer is the explorer's own question: which names exist, and which of them cannot be
			// replaced.
			if (response.status === 409 && body.code === "conflict") {
				throw new SurfaceRefusal(json(409, { error: body.message ?? "Some files already exist", conflicts: body.conflicts ?? [part.fileName], nonReplaceable: body.nonReplaceable ?? [] }));
			}
			errors.push({ name: part.fileName, error: body.message ?? body.error ?? "Upload failed (HTTP " + response.status + ")" });
		};

		try {
			await readUploadParts({ headers: request.headers, body: request.body, totalBytes: totalUploadBytes, take });
		} catch (error) {
			if (error instanceof SurfaceRefusal) return error.response;
			if (error instanceof UploadTooLargeError) return json(413, { error: "The upload is larger than the " + error.limit + " bytes one upload may carry in total" });
			throw error;
		}
		if (uploaded.length === 0 && skipped.length === 0 && errors.length === 0) return json(400, { error: "No files selected" });
		const answer: UploadBatchResponse = { uploaded, skipped, errors };
		return json(errors.length > 0 ? 207 : 200, answer);
	}

	/** The names an upload would meet, answered by the host that holds the directory. */
	async function uploadCheckRequest(request: FileSurfaceRequest, routingDirectory: string): Promise<Response> {
		if (workspaceRoutingLocation(routingDirectory) === null) return unsupported(NOT_A_WORKSPACE);
		const raw = await readJsonBody(request);
		const body = (typeof raw === "object" && raw !== null ? raw : {}) as { fileNames?: unknown };
		const fileNames = Array.isArray(body.fileNames) ? body.fileNames.filter((name): name is string => typeof name === "string") : [];
		const invalid = fileNames.length === 0 ? "No files selected" : validateUploadFileNames(fileNames);
		if (invalid !== null) return json(400, { error: invalid });
		const inspected = await inspectUpload(routingDirectory, fileNames, request.signal);
		if (inspected instanceof Response) return inspected;
		return json(200, inspected);
	}

	/** The text preview, its metadata, or the bytes of a file the browser renders itself. */
	async function readRequest(request: FileSurfaceRequest, routingPath: string, workspaceId: string, relativePath: string, kind: string): Promise<Response> {
		if (relativePath === "") return json(400, { error: "Not a file" });
		// A file the browser renders itself — an image, a recording or a PDF — is served as its own bytes, with the
		// browser's range request passed to the host, because a text preview is not what the viewer asked for.
		if (kind === "read" && servesBytes(relativePath)) return byteResponse(request, routingPath, relativePath, false);
		const result = await workbench(workspaceId, "read", relativePath, request.signal);
		if (!result.ok) return workbenchRefusal(result, "a file preview")!;
		const preview = result.value as { content: string; truncated: boolean; binary: boolean; sizeBytes: number; shownBytes: number };
		const language = previewLanguageOf(relativePath);
		if (kind === "meta") {
			const meta: FileMetaResponse = { size: preview.sizeBytes, language, mime: byteServedMime(relativePath) ?? "text/plain", previewKind: documentPreviewKind(relativePath) };
			return json(200, meta);
		}
		// A binary file whose extension did not name it: the bytes are what the browser can use, not a preview of them.
		if (preview.binary) return byteResponse(request, routingPath, relativePath, false);
		// The host preview is one fixed bound with no offset reads: the whole of it is this chunk, and the answer
		// carries the two numbers a viewer needs to say what the chunk is — how many of the file's bytes it holds, and
		// how many the file has in total — rather than an offset to follow. A caller that asks for a second chunk is
		// named the limit, not handed the first chunk again or a hole.
		const offset = Number(request.url.searchParams.get("offset") ?? "0");
		if (!Number.isInteger(offset) || offset < 0) return json(400, { error: "Invalid offset" });
		if (offset > 0) return unsupported("Additional preview chunks are not available; open the file on the workspace host");
		const answer: FilePreviewResponse = {
			content: preview.content,
			language,
			// The host's own two numbers, carried as it stated them: what this chunk holds, and what the file is.
			size: preview.sizeBytes,
			shownBytes: preview.shownBytes,
			truncated: preview.truncated,
			previewOnly: true,
		};
		return json(200, answer);
	}

	/**
	 * The routing path a browser request names.
	 *
	 * The browser's pathname is percent-encoded and a routing path is not: a file called `my note.md`, one with a
	 * Unicode name, or one with a `%` in it arrives as `%20`, `%E2%80%A6` or `%25`, and the host must be asked for the
	 * name it really has. This is the one point where the URL stops being a URL, so the decode happens exactly once
	 * here; everything behind it — the protocol's own parser, the Backend and the host's confinement — reads a path, and
	 * a path that escapes its workspace is refused there. A path that is not valid encoding names no file, and is
	 * answered as the malformed request it is rather than passed on.
	 */
	function routingPathOf(request: FileSurfaceRequest): string | Response {
		let decoded: string;
		try {
			decoded = decodeURIComponent(request.url.pathname.slice("/api/files/".length));
		} catch {
			return json(400, { error: "The file path is not valid percent-encoding" });
		}
		return "/" + decoded;
	}

	/** One file of a workspace, addressed by the browser's own routing path. */
	async function fileRequest(request: FileSurfaceRequest): Promise<Response> {
		const routingPath = routingPathOf(request);
		if (routingPath instanceof Response) return routingPath;
		const workspace = workspaceRoutingLocation(routingPath);
		if (workspace === null) return unsupported(NOT_A_WORKSPACE);
		const { workspaceId, relativePath } = workspace;
		const kind = request.url.searchParams.get("type") ?? "list";

		if (request.method === "POST") {
			if (kind === "upload") return uploadRequest(request, routingPath);
			if (kind === "upload-check") return uploadCheckRequest(request, routingPath);
			return unsupported("File request type " + kind + " is not connected to the gateway workbench yet");
		}
		if (request.method !== "GET") return unsupported("File request type " + kind + " is not connected to the gateway workbench yet");

		// The two capabilities that do not exist are named as such rather than answered as an empty success: a watcher
		// is not part of this migration, and a DOCX renderer is not this surface's to invent.
		if (kind === "watch") return unsupported("Live file watching is not connected to the gateway workbench yet");
		if (kind === "preview") return unsupported("type=preview is not a request this surface serves: a text preview comes from type=read, and a Word document from its own bytes");
		if (kind === "allow-link") return unsupported("Linked-directory approval is not connected to the gateway workbench yet");

		if (kind === "list") {
			const files = await listedFiles(workspaceId, request.signal);
			if (files instanceof Response) return files;
			const answer: FileListingResponse = { entries: listDirectoryEntries(files, relativePath), path: routingPath };
			return json(200, answer);
		}
		// A download is the file itself, whatever its kind: the bytes come from the host rather than from a text preview,
		// so a file the preview would have truncated still arrives whole.
		if (kind === "download") {
			if (relativePath === "") return json(400, { error: "Not a file" });
			return byteResponse(request, routingPath, relativePath, true);
		}
		if (kind === "read" || kind === "meta") return readRequest(request, routingPath, workspaceId, relativePath, kind);
		return unsupported("File request type " + kind + " is not connected to the gateway workbench yet");
	}

	/** The `@` index: the host's flat listing, ranked here or left to the client when no query is asked. */
	async function fileIndexRequest(request: FileSurfaceRequest): Promise<Response> {
		const workspace = workspaceRoutingLocation(request.url.searchParams.get("cwd") ?? "");
		if (workspace === null) return unsupported(NOT_A_WORKSPACE);
		const files = await listedFiles(workspace.workspaceId, request.signal);
		if (files instanceof Response) return files;
		const query = (request.url.searchParams.get("q") ?? "").slice(0, 500);
		const answer: FileIndexResponse = query === ""
			? { files: files.slice(0, FILE_INDEX_MAX_FILES), truncated: files.length > FILE_INDEX_MAX_FILES }
			: { matches: filterFileEntries(buildEntriesFromFiles(files), query) };
		return json(200, answer);
	}

	/** The changed files of one workspace root, as the browser's Git view names them. */
	async function gitStatusRequest(request: FileSurfaceRequest): Promise<Response> {
		const cwd = request.url.searchParams.get("cwd") ?? "";
		const workspace = workspaceRoutingLocation(cwd);
		if (workspace === null || workspace.relativePath !== "") return unsupported("Only configured /workspace/<id> directories are available");
		const files = await changedFiles(workspace.workspaceId, request.signal);
		if (files instanceof Response) return files;
		if (files === null) {
			const empty: GitStatusResponse = { isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 };
			return json(200, empty);
		}
		const statuses: GitFileStatus[] = files.map((file) => {
			const mapped = STATUS_CODES[file.status] ?? STATUS_CODES.modified!;
			return {
				filePath: WORKSPACE_PREFIX + workspace.workspaceId + "/" + file.path,
				status: mapped.status,
				code: mapped.code,
				indexStatus: file.staged ? mapped.code : " ",
				worktreeStatus: file.staged ? " " : mapped.code,
			};
		});
		const answer: GitStatusResponse = { isGitRepository: true, repositoryRoot: cwd, files: statuses, additions: 0, deletions: 0 };
		return json(200, answer);
	}

	/** One changed file's patch, or the statement that the host has none for it. */
	async function gitDiffRequest(request: FileSurfaceRequest): Promise<Response> {
		const cwd = request.url.searchParams.get("cwd") ?? "";
		const filePath = request.url.searchParams.get("path") ?? "";
		const workspace = workspaceRoutingLocation(cwd);
		const file = workspaceRoutingLocation(filePath);
		if (workspace === null || file === null || file.workspaceId !== workspace.workspaceId || file.relativePath === "") {
			return unsupported("Only files inside a configured /workspace/<id> directory are available");
		}
		const changed = await changedFiles(workspace.workspaceId, request.signal);
		if (changed instanceof Response) return changed;
		const entry = (changed ?? []).find((candidate) => candidate.path === file.relativePath);
		const result = await workbench(workspace.workspaceId, "diff", file.relativePath, request.signal);
		if (!result.ok) return workbenchRefusal(result, "a file diff")!;
		const patch = typeof result.value === "string" ? result.value : "";
		if (patch.trim() === "") return json(200, { supported: false } satisfies GitFileDiffResponse);
		const mapped = entry === undefined ? undefined : (STATUS_CODES[entry.status] ?? STATUS_CODES.modified!).status;
		const answer: GitFileDiffResponse = { supported: true, ...(mapped === undefined ? {} : { status: mapped }), patch };
		return json(200, answer);
	}

	return async (request) => {
		const { pathname } = request.url;
		if (!isFileSurfacePath(pathname)) return null;
		if (pathname === "/api/files" || pathname === "/api/files/") return unsupported("Only configured /workspace/<id> paths are available");
		if (pathname === "/api/file-index") return fileIndexRequest(request);
		if (pathname === "/api/git/status") return gitStatusRequest(request);
		if (pathname === "/api/git/diff") return gitDiffRequest(request);
		return fileRequest(request);
	};
}

/** Read a part to its end when the host stopped before the last byte, so the wire is read out and the next part can be. */
async function drainPart(part: Readable): Promise<void> {
	if (part.readableEnded || part.destroyed) return;
	await new Promise<void>((resolve) => {
		part.on("end", resolve);
		part.on("close", resolve);
		part.on("error", () => resolve());
		part.resume();
	});
}

function headerValue(headers: UploadRequestHeaders, name: string): string | undefined {
	const value = headers[name];
	return Array.isArray(value) ? value.join(", ") : value;
}

/** One bounded JSON request body: a check names a few names, and a body larger than that is not one. */
async function readJsonBody(request: FileSurfaceRequest): Promise<unknown> {
	if (request.body === undefined || request.body === null) return undefined;
	const stream = request.body instanceof Readable ? request.body : Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of stream) {
		bytes += Buffer.byteLength(chunk as Buffer);
		if (bytes > 64 * 1024) { stream.destroy(); return undefined; }
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return undefined;
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
