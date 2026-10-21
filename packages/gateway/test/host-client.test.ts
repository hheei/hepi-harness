import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayHostTransport, HostTransportError, HOST_REQUEST_TIMEOUT_MS, type HostTransportRequest } from "../src/index.ts";

const TOKEN = "host-token-abc123";

type Call = { readonly url: string; readonly init: RequestInit };
type Responder = (call: Call) => Promise<Response> | Response;

/** A fetch that records what the transport built and answers from the test. */
function recording(respond: Responder): { readonly calls: Call[]; readonly fetch: typeof fetch } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return await respond(call);
	};
	return { calls, fetch: impl as unknown as typeof fetch };
}

/** A fetch that never answers until its signal aborts, which is how a slow or woken gateway behaves. */
function pending(): typeof fetch {
	return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => reject(signal?.reason ?? new Error("aborted"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail, { once: true });
		});
	}) as unknown as typeof fetch;
}

function transport(fetchImpl: typeof fetch, extra: { readonly timeoutMs?: number; readonly gatewayOrigin?: string } = {}): GatewayHostTransport {
	return new GatewayHostTransport({ gatewayOrigin: extra.gatewayOrigin ?? "http://127.0.0.1:7042", gatewayToken: TOKEN, fetch: fetchImpl, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });
}

function refusal(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** The error a call rejected with, asserted to be this transport's own typed failure. */
async function rejection(call: Promise<unknown>): Promise<HostTransportError> {
	try {
		await call;
	} catch (error) {
		assert.ok(error instanceof HostTransportError, "expected a HostTransportError, got " + String(error));
		return error;
	}
	throw new Error("the call was expected to fail");
}

test("sends the bearer token on every request and keeps the capability's own headers", async () => {
	const recorder = recording(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
	const client = transport(recorder.fetch);
	const answer = await client.json({ path: "/v1/workbench", body: { operation: "read" }, headers: { accept: "application/json" }, decode: (value) => value as { ok: boolean } });

	assert.deepEqual(answer, { ok: true });
	assert.equal(recorder.calls.length, 1);
	const headers = recorder.calls[0].init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer " + TOKEN);
	assert.equal(headers["content-type"], "application/json");
	assert.equal(headers.accept, "application/json");
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/workbench");
	assert.equal(recorder.calls[0].init.body, JSON.stringify({ operation: "read" }));
});

test("joins origin and route without doubling a slash, and refuses a route that is itself a URL", async () => {
	const recorder = recording(() => new Response("{}", { status: 200 }));
	const client = transport(recorder.fetch, { gatewayOrigin: "http://127.0.0.1:7042/" });

	assert.equal(client.url("/v1/files"), "http://127.0.0.1:7042/v1/files");
	assert.equal(client.url("/v1/files", { workspaceId: "w1", absent: undefined, cursor: 3 }), "http://127.0.0.1:7042/v1/files?workspaceId=w1&cursor=3");
	assert.equal((await rejection(Promise.resolve().then(() => client.url("v1/files")))).code, "protocol_error");
	assert.equal((await rejection(Promise.resolve().then(() => client.url("https://elsewhere.example/v1/files")))).code, "protocol_error");
	assert.equal((await rejection(Promise.resolve().then(() => client.url("//elsewhere.example/v1/files")))).code, "protocol_error");
	assert.equal((await rejection(Promise.resolve().then(() => client.url("/v1/files?workspaceId=w2")))).code, "protocol_error");
	assert.equal(recorder.calls.length, 0);
});

test("a caller abort is reported as cancelled, never as the timeout that would also have fired", async () => {
	const client = transport(pending(), { timeoutMs: 50 });
	const caller = new AbortController();
	const call = client.json({ path: "/v1/execute", body: { callId: "c1" }, signal: caller.signal, decode: (value) => value });
	caller.abort();
	const error = await rejection(call);
	assert.equal(error.code, "aborted");
	assert.notEqual(error.code, "timeout");
});

test("a call the caller already gave up on is not sent at all", async () => {
	const recorder = recording(() => new Response("{}", { status: 200 }));
	const caller = new AbortController();
	caller.abort();
	const error = await rejection(transport(recorder.fetch).json({ path: "/v1/execute", body: {}, signal: caller.signal, decode: (value) => value }));
	assert.equal(error.code, "aborted");
	assert.equal(recorder.calls.length, 0);
});

test("a gateway that never answers is a timeout", async () => {
	const error = await rejection(transport(pending(), { timeoutMs: 10 }).json({ path: "/v1/worktrees", body: {}, decode: (value) => value }));
	assert.equal(error.code, "timeout");
});

test("the default request timeout is the documented one", () => {
	assert.equal(HOST_REQUEST_TIMEOUT_MS, 20_000);
});

test("a refused credential is unauthorized, and a definitive refusal is not an unknown outcome", async () => {
	const unauthorized = await rejection(transport(recording(() => refusal(401, JSON.stringify({ ok: false, code: "unauthorized" }))).fetch).json({ path: "/v1/files", body: {}, decode: (value) => value }));
	assert.equal(unauthorized.code, "unauthorized");
	assert.equal(unauthorized.status, 401);

	const refusalTransport = transport(recording(() => refusal(409, JSON.stringify({ ok: false, code: "conflict" }))).fetch);
	const refused = await rejection(refusalTransport.json({ path: "/v1/worktrees", body: { operation: "remove" }, decode: (value) => value }));
	assert.equal(refused.code, "operation_failed");
	assert.equal(refused.status, 409);
	assert.equal(refused.gatewayCode, "conflict");
	assert.notEqual(refused.code, "outcome_unknown");
});

test("a success body that is malformed, empty or unacceptable is a protocol error, not an empty value", async () => {
	const malformed = await rejection(transport(recording(() => new Response("{not json", { status: 200 })).fetch).json({ path: "/v1/mcp", body: {}, decode: (value) => value }));
	assert.equal(malformed.code, "protocol_error");

	const empty = await rejection(transport(recording(() => new Response("", { status: 200 })).fetch).json({ path: "/v1/installs", body: {}, decode: (value) => value }));
	assert.equal(empty.code, "protocol_error");

	const wrong = await rejection(
		transport(recording(() => new Response(JSON.stringify({ ok: "yes" }), { status: 200 })).fetch).json({
			path: "/v1/workspaces",
			body: {},
			decode: (value) => {
				if (typeof (value as { ok?: unknown }).ok !== "boolean") throw new Error("not an answer");
				return value;
			},
		}),
	);
	assert.equal(wrong.code, "protocol_error");
});

test("a lost mutation is outcome_unknown while a lost read is only offline", async () => {
	const mutation = await rejection(transport(recording(() => { throw new TypeError("fetch failed"); }).fetch).json({ path: "/v1/execute", body: {}, decode: (value) => value }));
	assert.equal(mutation.code, "outcome_unknown");

	const read = await rejection(transport(recording(() => { throw new TypeError("fetch failed"); }).fetch).json({ path: "/v1/workbench", method: "GET", body: undefined, decode: (value) => value }));
	assert.equal(read.code, "gateway_offline");

	const explicitRead = await rejection(transport(recording(() => { throw new TypeError("fetch failed"); }).fetch).json({ path: "/v1/mcp", body: {}, policy: "read-only", decode: (value) => value }));
	assert.equal(explicitRead.code, "gateway_offline");
});

test("a connection that never opened is offline even for a mutation, because nothing could have run", async () => {
	const cause = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
	const error = await rejection(transport(recording(() => { throw cause; }).fetch).json({ path: "/v1/execute", body: {}, decode: (value) => value }));
	assert.equal(error.code, "gateway_offline");
});

test("a body that ends after the headers leaves a mutation unknown", async () => {
	const broken = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("terminated"));
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	const error = await rejection(transport(recording(broken).fetch).json({ path: "/v1/files", body: {}, decode: (value) => value }));
	assert.equal(error.code, "outcome_unknown");
});

test("no failed request is retried", async () => {
	const recorder = recording(() => { throw new TypeError("fetch failed"); });
	await rejection(transport(recorder.fetch).json({ path: "/v1/execute", body: {}, decode: (value) => value }));
	assert.equal(recorder.calls.length, 1);
});

test("no error text carries the gateway token", async () => {
	const token = TOKEN;
	const failures: HostTransportRequest[] = [{ path: "/v1/execute", body: "{}" }, { path: "/v1/worktrees", body: "{}" }];
	const refusesToken = (call: Call) => {
		assert.equal((call.init.headers as Record<string, string>).authorization, "Bearer " + token);
		return refusal(401, JSON.stringify({ ok: false, code: "unauthorized" }));
	};
	const errors = [
		await rejection(transport(recording(refusesToken).fetch).json({ path: "/v1/execute", body: {}, decode: (value) => value })),
		await rejection(transport(pending(), { timeoutMs: 10 }).json({ path: "/v1/worktrees", body: {}, decode: (value) => value })),
		await rejection(transport(recording(() => { throw new TypeError("fetch failed"); }).fetch).json({ path: "/v1/execute", body: {}, decode: (value) => value })),
	];
	for (const error of errors) {
		assert.ok(!error.message.includes(token), "the message leaked the token: " + error.message);
		assert.ok(!String(error.stack).includes(token), "the stack leaked the token");
		for (const request of failures) assert.ok(!error.message.includes(String(request.body)), "the message leaked the request body");
	}
});

test("a stream-capable request forwards the body and hands back the response without collecting it", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("payload"));
			controller.close();
		},
	});
	const recorder = recording(() => new Response("streamed", { status: 200, headers: { "content-type": "application/octet-stream" } }));
	const response = await transport(recorder.fetch).send({ path: "/v1/files/bytes", body, headers: { "content-type": "application/octet-stream" }, policy: "read-only" });

	assert.equal(recorder.calls[0].init.body, body);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "application/octet-stream");
	assert.equal(await response.text(), "streamed");
});

test("a non-success answer is returned to a streaming caller, which owns the status", async () => {
	const response = await transport(recording(() => refusal(404, JSON.stringify({ ok: false, code: "not_found" }))).fetch).send({ path: "/v1/files", method: "POST", body: "{}", policy: "read-only" });
	assert.equal(response.status, 404);
	assert.equal(((await response.json()) as { code: string }).code, "not_found");
});
