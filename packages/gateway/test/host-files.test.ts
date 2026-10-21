import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { FileError } from "@earendil-works/pi-durable/env";
import { GatewayHostClient, GatewayHostTransport, HostTransportError, LocalGateway, GatewayRpcServer, filesCapability } from "../src/index.ts";
import { DOWNLOAD_CHUNK_BYTES } from "../src/file-transfer.ts";
import type { FileRequest } from "../src/filesystem.ts";
import { gatewayHttp, type GatewayHttp } from "./gateway-http.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";


/**
 * The files capability, asserted at its own seam: the request the client builds for one host's file surface, and what
 * it hands back.
 *
 * Two things must survive: the bytes. An upload is the caller's own stream forwarded as it arrives, a download is the
 * host's own stream returned unread, and neither is collected by the client — that is what keeps a relay's
 * backpressure and caller-disconnect cancellation working. And the meaning of a lost answer: a file read that never came
 * back is only offline, while a file write whose answer was lost may have run and is never replayed.
 *
 * The host side is in this process. The gateway's own payload routes run unmodified over `gateway-http.ts`'s duplex
 * pair, so no port is bound and no other test's listener can collide with this one, and the workspace below them is a
 * map of bytes (`MemoryFiles`) instead of a directory: a download still streams through the gateway's own reader loop,
 * its backpressure still follows the caller's pace, and the reader it opened is still closed when the caller leaves —
 * with the host's reads as the evidence rather than a file on disk.
 */

const TOKEN = "{{SECRET_file7r2n}}";
const ORIGIN = "http://127.0.0.1:7042";

type Call = { readonly url: string; readonly init: RequestInit };

/** A fetch that records what the client sent and answers from the test. */
function recording(respond: (call: Call) => Promise<Response> | Response): { readonly calls: Call[]; readonly fetch: typeof fetch } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return await respond(call);
	};
	return { calls, fetch: impl as unknown as typeof fetch };
}

function client(fetchImpl: typeof fetch, timeoutMs?: number): GatewayHostClient {
	return new GatewayHostClient({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The typed failure one capability call reported, for the calls that fail through the transport. */
async function rejection(call: Promise<unknown>): Promise<HostTransportError> {
	try {
		await call;
	} catch (error) {
		assert.ok(error instanceof HostTransportError, "expected a HostTransportError, got " + String(error));
		return error;
	}
	throw new Error("the call was expected to fail");
}

/** A body sent as a stream, so the client is exercised the way a browser's upload arrives at the relay. */
function streamedBody(bytes: Buffer, parts = 3): ReadableStream<Uint8Array> {
	const size = Math.ceil(bytes.byteLength / parts);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.byteLength) { controller.close(); return; }
			const end = Math.min(offset + size, bytes.byteLength);
			controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
			offset = end;
		},
	});
}

/** A response that never arrives: what a gateway that accepted the request and then went quiet looks like. */
function unanswered(): (call: Call) => Promise<Response> {
	return async (call) => await new Promise<Response>((_resolve, reject) => {
		const signal = call.init.signal;
		const fail = () => reject(signal?.reason ?? new Error("aborted"));
		if (signal?.aborted) fail();
		else signal?.addEventListener("abort", fail, { once: true });
	});
}

test("the file RPC is one JSON request to /v1/files with the binding's workspace and the host's own result", async () => {
	const recorder = recording(() => jsonResponse({ ok: true, value: ["a.txt", "b.txt"] }));
	const result = await client(recorder.fetch).files.rpc<string[]>({ workspaceId: "ws", method: "listDir", path: "/docs" });

	assert.deepEqual(result, { ok: true, value: ["a.txt", "b.txt"] });
	assert.equal(recorder.calls.length, 1);
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/files");
	assert.equal(recorder.calls[0].init.method, "POST");
	const headers = recorder.calls[0].init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer " + TOKEN);
	assert.equal(headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(String(recorder.calls[0].init.body)), { workspaceId: "ws", method: "listDir", path: "/docs" });
});

test("a refused file RPC keeps the host's own code and message, and is not an unknown outcome", async () => {
	const recorder = recording(() => jsonResponse({ ok: false, error: { code: "not_found", message: "no such file" } }));
	const result = await client(recorder.fetch).files.rpc<unknown>({ workspaceId: "ws", method: "readTextFile", path: "/absent.txt" });

	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.error instanceof FileError);
	assert.ok(!result.ok && result.error.code === "not_found");
	assert.ok(!result.ok && result.error.message === "no such file");
	// A definitive refusal is not uncertainty, so the write is never retried and is not reported as unknown.
	assert.equal(recorder.calls.length, 1);
});

test("a lost file write is unknown while a lost file read is only offline, and neither is replayed", async () => {
	const lost = () => { throw new TypeError("fetch failed"); };
	const written = await client(recording(lost).fetch).files.rpc<unknown>({ workspaceId: "ws", method: "writeFile", path: "/a.txt", content: "a" });
	assert.equal(written.ok, false);
	assert.ok(!written.ok && written.error.code === "unknown");

	const read = await client(recording(lost).fetch).files.rpc<unknown>({ workspaceId: "ws", method: "readTextFile", path: "/a.txt" });
	assert.equal(read.ok, false);
	assert.ok(!read.ok && read.error.code === "unknown", "the domain keeps its own spelling of a lost answer");

	// The transport still classifies the two differently, which is what the policy is built on.
	const recorder = recording(lost);
	assert.equal((await rejection(client(recorder.fetch).files.bytes({ workspaceId: "ws", path: "/a.txt" }))).code, "gateway_offline");
	assert.equal(recorder.calls.length, 1);
});

test("a gateway that never answers is the timeout, and the request is not sent a second time", async () => {
	const recorder = recording(unanswered());
	const error = await rejection(client(recorder.fetch, 10).files.uploadCheck({ workspaceId: "ws", path: "/", names: ["a.txt"] }));
	assert.equal(error.code, "timeout");
	assert.equal(recorder.calls.length, 1);
});

test("a caller cancellation keeps its own spelling, and is never the timeout", async () => {
	const recorder = recording(unanswered());
	const caller = new AbortController();
	const result = client(recorder.fetch, 10).files.rpc<unknown>({ workspaceId: "ws", method: "writeFile", path: "/a.txt", content: "a" }, { signal: caller.signal });
	caller.abort();
	const cancelled = await result;
	assert.equal(cancelled.ok, false);
	assert.ok(!cancelled.ok && cancelled.error.code === "aborted");
});

test("an upload forwards the caller's stream half-duplex, with the route's query and content length, and reads no body", async () => {
	const content = Buffer.alloc(2 * 1024 * 1024 + 17, 5);
	const recorder = recording(() => jsonResponse({ ok: true, value: { path: "/big.bin", size: content.byteLength, skipped: false } }));
	const client_ = client(recorder.fetch);
	const body = streamedBody(content);
	const response = await client_.files.upload({ workspaceId: "ws", path: "/big.bin", body, contentLength: content.byteLength });

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, value: { path: "/big.bin", size: content.byteLength, skipped: false } });
	assert.equal(recorder.calls.length, 1);
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/files/upload?workspaceId=ws&path=%2Fbig.bin&conflict=error");
	// The stream itself is forwarded: the client never reads it, so nothing of the file is held here.
	assert.equal(recorder.calls[0].init.body, body);
	assert.equal((recorder.calls[0].init as { duplex?: string }).duplex, "half");
	const headers = recorder.calls[0].init.headers as Record<string, string>;
	assert.equal(headers["content-type"], "application/octet-stream");
	assert.equal(headers["content-length"], String(content.byteLength));
	assert.equal(headers.authorization, "Bearer " + TOKEN);
});

test("an upload names the conflict strategy it was given, and no timeout bounds the body", async () => {
	const recorder = recording(() => jsonResponse({ ok: true, value: { path: "/notes.txt", size: 8, skipped: true } }));
	await client(recorder.fetch).files.upload({ workspaceId: "ws", path: "/notes.txt", conflict: "skip", body: new Blob([new Uint8Array(Buffer.from("replacement"))]) });
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/files/upload?workspaceId=ws&path=%2Fnotes.txt&conflict=skip");
});

test("a refused upload is the host's own answer, so its status and body reach the caller to pass on", async () => {
	const recorder = recording(() => jsonResponse({ ok: false, code: "conflict", message: "the file already exists", conflicts: ["/notes.txt"], nonReplaceable: [] }, 409));
	const response = await client(recorder.fetch).files.upload({ workspaceId: "ws", path: "/notes.txt", body: new Blob([new Uint8Array(Buffer.from("x"))]) });
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { ok: false, code: "conflict", message: "the file already exists", conflicts: ["/notes.txt"], nonReplaceable: [] });
	assert.equal(recorder.calls.length, 1);
});

test("an upload whose connection is lost is outcome_unknown, and the body is never sent again", async () => {
	const recorder = recording(() => { throw new TypeError("fetch failed"); });
	const error = await rejection(client(recorder.fetch).files.upload({ workspaceId: "ws", path: "/a.bin", body: new Blob([new Uint8Array(Buffer.from("x"))]) }));
	assert.equal(error.code, "outcome_unknown");
	assert.equal(recorder.calls.length, 1);
});

test("an upload-check is a JSON body of the names, read-only so a lost answer is only offline", async () => {
	const recorder = recording(() => jsonResponse({ ok: true, value: { conflicts: ["notes.txt"], nonReplaceable: [] } }));
	const response = await client(recorder.fetch).files.uploadCheck({ workspaceId: "ws", path: "/docs", names: ["notes.txt"] });

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, value: { conflicts: ["notes.txt"], nonReplaceable: [] } });
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/files/upload-check?workspaceId=ws");
	assert.deepEqual(JSON.parse(String(recorder.calls[0].init.body)), { workspaceId: "ws", path: "/docs", names: ["notes.txt"] });

	const offline = await rejection(client(recording(() => { throw new TypeError("fetch failed"); }).fetch).files.uploadCheck({ workspaceId: "ws", path: "/", names: ["a"] }));
	assert.equal(offline.code, "gateway_offline");
});

test("a ranged download asks for the range and hands the host's headers and unread body straight back", async () => {
	const recorder = recording(() => new Response("cdef", { status: 206, headers: { "content-type": "application/octet-stream", "content-range": "bytes 2-5/20", "accept-ranges": "bytes", "content-length": "4" } }));
	const response = await client(recorder.fetch).files.bytes({ workspaceId: "ws", path: "/blob.bin", range: "bytes=2-5" });

	assert.equal(response.status, 206);
	assert.equal(response.headers.get("content-range"), "bytes 2-5/20");
	assert.equal(response.headers.get("accept-ranges"), "bytes");
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/files/bytes?workspaceId=ws&path=%2Fblob.bin");
	assert.equal((recorder.calls[0].init.headers as Record<string, string>).range, "bytes=2-5");
	// The body is the host's, unread: reading it here would collect a file the caller is streaming.
	assert.equal(await response.text(), "cdef");
});

test("a whole-file download sends no range header, so the host serves the whole file", async () => {
	const recorder = recording(() => new Response("blob", { status: 200, headers: { "content-type": "application/octet-stream" } }));
	await client(recorder.fetch).files.bytes({ workspaceId: "ws", path: "/blob.bin" });
	assert.equal((recorder.calls[0].init.headers as Record<string, string>).range, undefined);
});

test("a download cancelled by its caller ends the host request it opened", async () => {
	const recorder = recording(() => new Response("blob", { status: 200 }));
	const caller = new AbortController();
	caller.abort();
	const error = await rejection(client(recorder.fetch).files.bytes({ workspaceId: "ws", path: "/blob.bin", signal: caller.signal }));
	assert.equal(error.code, "aborted");
	assert.equal(recorder.calls.length, 0, "a download the caller already gave up on is not asked for");
});

test("no file call builds its own bearer header: the transport's is the only one sent", async () => {
	const recorder = recording(() => jsonResponse({ ok: true, value: { conflicts: [], nonReplaceable: [] } }));
	const capability = filesCapability(new GatewayHostTransport({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: recorder.fetch }));
	await capability.uploadCheck({ workspaceId: "ws", path: "/", names: ["a"] });
	const headers = recorder.calls[0].init.headers as Record<string, string>;
	assert.deepEqual(Object.keys(headers).filter((name) => name.toLowerCase().includes("authorization")), ["authorization"]);
	assert.equal(headers.authorization, "Bearer " + TOKEN);
});

/**
 * One workspace served in this process: the two file surfaces the host gateway implements — the JSON RPC and the three
 * payload routes — over a map of bytes.
 *
 * The gateway's own payload code is what answers a download here: it opens a `Download` through this filesystem, reads
 * it in bounded chunks, waits for the caller's connection to drain, and closes the reader it opened on every way out.
 * Only the host filesystem below that code is memory, so what is asserted is the gateway's streaming and its cleanup,
 * with the reads it performed as the evidence.
 */
class MemoryFiles {
	/** Every file the workspace holds, by rooted path. */
	readonly bytes = new Map<string, Buffer>();
	/** The reads the gateway performed on an open reader, in order, so a stream is asserted as reads. */
	readonly reads: { path: string; offset: number; length: number }[] = [];
	/** The reader handles still open, which a download that ended must leave empty. */
	readonly open = new Map<string, string>();
	readonly #directories = new Set<string>(["/"]);
	readonly #closedWaiters: (() => void)[] = [];
	#handles = 0;

	/** Resolves once every reader this workspace handed out has been closed. */
	async closedAll(): Promise<void> {
		if (this.open.size === 0) return;
		await new Promise<void>((resolve) => { this.#closedWaiters.push(resolve); });
	}

	#remember(path: string): void {
		for (let parent = path.slice(0, path.lastIndexOf("/")) || "/"; parent !== "/"; parent = parent.slice(0, parent.lastIndexOf("/")) || "/") this.#directories.add(parent);
	}

	#close(handle: string): void {
		this.open.delete(handle);
		if (this.open.size === 0) for (const waiter of this.#closedWaiters.splice(0)) waiter();
	}

	async execute(request: FileRequest): Promise<unknown> {
		const path = request.path ?? "";
		const content = this.bytes.get(path);
		switch (request.method) {
			case "fileInfo":
				if (content !== undefined) return { ok: true, value: { path, kind: "file", size: content.byteLength, modified: 0 } };
				return this.#directories.has(path) ? { ok: true, value: { path, kind: "directory", size: 0, modified: 0 } } : { ok: false, error: { code: "not_found", message: "no such file: " + path } };
			case "readTextFile":
				return content === undefined ? { ok: false, error: { code: "not_found", message: "no such file: " + path } } : { ok: true, value: content.toString("utf8") };
			case "writeFile":
				this.bytes.set(path, Buffer.from(request.content ?? "", request.encoding === "base64" ? "base64" : "utf8"));
				this.#remember(path);
				return { ok: true, value: undefined };
			case "appendFile": {
				const appended = Buffer.from(request.content ?? "", request.encoding === "base64" ? "base64" : "utf8");
				this.bytes.set(path, Buffer.concat([content ?? Buffer.alloc(0), appended]));
				return { ok: true, value: undefined };
			}
			case "createTempFile": {
				const staged = "/" + (request.prefix ?? "") + (++this.#handles) + (request.suffix ?? "");
				this.bytes.set(staged, Buffer.alloc(0));
				this.#remember(staged);
				return { ok: true, value: staged };
			}
			case "renameFile": {
				if (content === undefined) return { ok: false, error: { code: "not_found", message: "no such file: " + path } };
				const destination = request.destinationPath ?? "";
				this.bytes.set(destination, content);
				this.bytes.delete(path);
				this.#remember(destination);
				return { ok: true, value: undefined };
			}
			case "remove":
				this.bytes.delete(path);
				return { ok: true, value: undefined };
			case "openBinaryReader": {
				if (content === undefined) return { ok: false, error: { code: "not_found", message: "no such file: " + path } };
				const handle = "reader-" + (++this.#handles);
				this.open.set(handle, path);
				return { ok: true, value: handle };
			}
			case "reader.read": {
				const opened = this.open.get(request.handle ?? "");
				const read = opened === undefined ? undefined : this.bytes.get(opened);
				if (opened === undefined || read === undefined) return { ok: false, error: { code: "invalid", message: "unknown or expired reader" } };
				const offset = request.offset ?? 0;
				const length = request.length ?? 0;
				this.reads.push({ path: opened, offset, length });
				return { ok: true, value: read.subarray(offset, offset + length).toString("base64") };
			}
			case "reader.close":
				this.#close(request.handle ?? "");
				return { ok: true, value: undefined };
			default:
				return { ok: false, error: { code: "invalid", message: "this memory workspace does not serve " + request.method } };
		}
	}

	async close(): Promise<void> {
		for (const handle of [...this.open.keys()]) this.#close(handle);
	}
}

/** One in-process gateway: its own routes over `gateway-http.ts`, and the workspace that answers them. */
type Host = { readonly files: MemoryFiles; readonly http: GatewayHttp; close(): Promise<void> };

async function host(): Promise<Host> {
	const files = new MemoryFiles();
	const gateway = new LocalGateway({ id: "gateway-1", token: TOKEN, workspaces: new WorkspaceRegistry([{ id: "ws", root: "/workspace" }]), allowedCommands: [] });
	const server = new GatewayRpcServer(gateway, undefined, files);
	const http = gatewayHttp(server.server);
	return {
		files,
		http,
		close: async () => {
			// The connections this fixture opened end first, so nothing of a cancelled download outlives the test.
			http.close();
			await server.close();
		},
	};
}

/** A request's headers as the gateway reads them: one string per name. */
function headersOf(headers: Headers): Record<string, string> {
	const flattened: Record<string, string> = {};
	headers.forEach((value, name) => { flattened[name] = value; });
	return flattened;
}

/**
 * The client's own fetch, answered by one in-process gateway through the shared `gateway-http.ts` seam.
 *
 * The request is built exactly as the client built it — method, headers, body — and handed to the server's own parsing
 * over a duplex pair, so the transport below the routes is this process's memory and the routes are the deployed ones.
 * A download is taken through `http.stream`, which resolves at the answer's head and hands back the server's own
 * response stream: a caller that has read nothing has not had the file read for it, its own pace is what paces the
 * gateway's reads, and cancelling the body is what ends the host request. `http.call` collects a body instead, so
 * using it here would collect every file the relay is supposed to stream.
 */
function served(host: Host): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
		const request = new Request(String(input), init);
		// An upload is forwarded as the stream it is: the client never reads the body it handed over, and this seam does
		// not collect it either, so the host reads it while the caller is still producing it.
		const answered = await host.http.stream({
			method: init?.method === "GET" ? "GET" : "POST",
			path: request.url.slice(ORIGIN.length),
			headers: headersOf(request.headers),
			...(request.body === null ? {} : { body: Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]) as AsyncIterable<Uint8Array> }),
		});
		return new Response(Readable.toWeb(answered.body) as ReadableStream<Uint8Array>, { status: answered.status, headers: answered.headers });
	}) as unknown as typeof fetch;
}

test("a file travels through the gateway's payload routes and back byte-exact", async () => {
	const host_ = await host();
	try {
		const client_ = client(served(host_));
		const content = Buffer.alloc(1024 * 1024 + 3, 9);
		const uploaded = await client_.files.upload({ workspaceId: "ws", path: "/payload.bin", body: streamedBody(content), contentLength: content.byteLength });
		assert.equal(uploaded.status, 200);
		assert.deepEqual(await uploaded.json(), { ok: true, value: { path: "/payload.bin", size: content.byteLength, skipped: false } });
		assert.deepEqual(host_.files.bytes.get("/payload.bin"), content);

		const downloaded = await client_.files.bytes({ workspaceId: "ws", path: "/payload.bin" });
		assert.equal(downloaded.status, 200);
		assert.equal(downloaded.headers.get("content-length"), String(content.byteLength));
		assert.equal(downloaded.headers.get("accept-ranges"), "bytes");
		assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);

		const ranged = await client_.files.bytes({ workspaceId: "ws", path: "/payload.bin", range: "bytes=10-19" });
		assert.equal(ranged.status, 206);
		assert.equal(ranged.headers.get("content-range"), "bytes 10-19/" + content.byteLength);
		assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), content.subarray(10, 20));
		// Every reader the gateway opened for those downloads is closed again, so a served range leaves nothing behind.
		assert.equal(host_.files.open.size, 0);
	} finally { await host_.close(); }
});

test("a download streams in the gateway's own chunks, and the caller's pace is what paces the host's reads", async () => {
	const host_ = await host();
	try {
		// Eight host reads, so a gateway that collected the file before answering would have made them all already.
		const content = Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 8, 3);
		await host_.files.execute({ workspaceId: "ws", method: "writeFile", path: "/big.bin", content: content.toString("base64"), encoding: "base64" });
		const response = await client(served(host_)).files.bytes({ workspaceId: "ws", path: "/big.bin" });
		assert.equal(response.status, 200);
		// The answer arrived before the body did: a caller that has not read a byte has not had the file read for it.
		assert.equal(host_.files.reads.length < 8, true, "the whole file was read before the caller read any of it");
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
		assert.equal(host_.files.reads.length, 8, "the file was read once, in bounded chunks");
		assert.equal(host_.files.reads.every((read) => read.length <= DOWNLOAD_CHUNK_BYTES), true);
		assert.equal(host_.files.reads.map((read) => read.offset).join(","), [0, 1, 2, 3, 4, 5, 6, 7].map((index) => index * DOWNLOAD_CHUNK_BYTES).join(","));
	} finally { await host_.close(); }
});

test("a caller that goes away mid-download ends the gateway's reads and closes the reader it opened", async () => {
	const host_ = await host();
	try {
		await host_.files.execute({ workspaceId: "ws", method: "writeFile", path: "/big.bin", content: Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 8, 3).toString("base64"), encoding: "base64" });
		// The caller's own connection, so walking away is ending it rather than cancelling a reader above it: that is the
		// disconnect the gateway's response sees.
		const stream = await host_.http.stream({ method: "GET", path: "/v1/files/bytes?workspaceId=ws&path=%2Fbig.bin", headers: { authorization: "Bearer " + TOKEN } });
		assert.equal(stream.status, 200);
		await new Promise<void>((resolve) => { stream.body.once("data", () => resolve()); });
		// A caller that goes away ends the connection it was reading: the gateway's own response closes with it.
		stream.body.destroy();
		await host_.files.closedAll();
		// The gateway's own body ended with the caller's disconnect, and the reader it opened went with it: the wait is
		// for the close it performs, not for a deadline to pass.
		assert.equal(host_.files.open.size, 0, "the download outlived the caller that opened it");
		assert.equal(host_.files.reads.length < 8, true, "the gateway kept reading a body nobody was reading");
	} finally { await host_.close(); }
});

test("the upload check over the gateway reports the name that is already there", async () => {
	const host_ = await host();
	try {
		await host_.files.execute({ workspaceId: "ws", method: "writeFile", path: "/notes.txt", content: "original" });
		const response = await client(served(host_)).files.uploadCheck({ workspaceId: "ws", path: "/", names: ["notes.txt", "other.txt"] });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, value: { conflicts: ["notes.txt"], nonReplaceable: [] } });
	} finally { await host_.close(); }
});

test("a file RPC over the gateway changes the host, and a refused one keeps the host's own answer", async () => {
	const host_ = await host();
	try {
		const client_ = client(served(host_));
		assert.deepEqual(await client_.files.rpc<void>({ workspaceId: "ws", method: "writeFile", path: "/notes.txt", content: "hello" }), { ok: true, value: undefined });
		assert.equal(host_.files.bytes.get("/notes.txt")?.toString("utf8"), "hello");
		assert.deepEqual(await client_.files.rpc<string>({ workspaceId: "ws", method: "readTextFile", path: "/notes.txt" }), { ok: true, value: "hello" });
		// A refused file RPC is the host's own refusal, not an unknown outcome: the gateway's token is what it checks.
		const gone = new GatewayHostClient({ gatewayOrigin: ORIGIN, gatewayToken: "wrong-token", fetch: served(host_) });
		const refused = await gone.files.rpc<unknown>({ workspaceId: "ws", method: "readTextFile", path: "/notes.txt" });
		assert.equal(refused.ok, false);
	} finally { await host_.close(); }
});
