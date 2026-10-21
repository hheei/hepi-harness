import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayHostTransport, HostTransportError, terminalCapability, type TerminalEventRequest } from "../src/index.ts";

const TOKEN = "host-token-abc123";
const ORIGIN = "http://127.0.0.1:7042";

type Call = { readonly url: string; readonly init: RequestInit };
type Responder = (call: Call) => Promise<Response> | Response;

/** A fetch that records what the client built and answers from the test. */
function recording(respond: Responder): { readonly calls: Call[]; readonly fetch: typeof fetch } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return await respond(call);
	};
	return { calls, fetch: impl as unknown as typeof fetch };
}

/** A client over a fetch that records calls. */
function terminal(respond: Responder, extra: { readonly timeoutMs?: number } = {}): { readonly calls: Call[]; readonly client: ReturnType<typeof terminalCapability> } {
	const recorder = recording(respond);
	const transport = new GatewayHostTransport({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: recorder.fetch, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });
	return { calls: recorder.calls, client: terminalCapability(transport) };
}

/** The error a call rejected with, asserted to be this package's typed failure. */
async function rejection(call: Promise<unknown>): Promise<HostTransportError> {
	try {
		await call;
	} catch (error) {
		assert.ok(error instanceof HostTransportError, "expected a HostTransportError, got " + String(error));
		return error;
	}
	throw new Error("the call was expected to fail");
}

/** A host answer as the terminal surface writes it. */
function answer(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An event stream carrying the frames the test names, ended as soon as they were written. */
function streamed(frames: readonly string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(encoder.encode(frame));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

test("open posts the session, its workspace and its size to the host's terminal surface", async () => {
	const { calls, client } = terminal(() => answer({ ok: true, id: "t1", workspaceId: "w1", cwd: ".", cols: 80, rows: 24 }));
	const opened = await client.open({ gatewayId: "g1", workspaceId: "w1", cwd: "src", cols: 80, rows: 24, id: "t1" });

	assert.deepEqual(opened, { ok: true, id: "t1", workspaceId: "w1", cwd: ".", cols: 80, rows: 24 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, ORIGIN + "/v1/terminal");
	assert.equal(calls[0].init.method, "POST");
	assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer " + TOKEN);
	assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), { gatewayId: "g1", workspaceId: "w1", cwd: "src", cols: 80, rows: 24, id: "t1" });
});

test("input and resize post one command to the session's own route, with the id encoded as a segment", async () => {
	const { calls, client } = terminal(() => answer({ ok: true }));
	assert.deepEqual(await client.input({ id: "tab/1", data: "ls\r" }), { ok: true });
	assert.deepEqual(await client.resize({ id: "tab/1", cols: 120, rows: 40 }), { ok: true });

	assert.equal(calls[0].url, ORIGIN + "/v1/terminal/tab%2F1/input");
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), { data: "ls\r" });
	assert.equal(calls[1].url, ORIGIN + "/v1/terminal/tab%2F1/resize");
	assert.deepEqual(JSON.parse(String(calls[1].init.body)), { cols: 120, rows: 40 });
	for (const call of calls) assert.equal((call.init.headers as Record<string, string>).authorization, "Bearer " + TOKEN);
});

test("close deletes the session and answers the exit the host saw", async () => {
	const { calls, client } = terminal(() => answer({ ok: true, exit: { type: "exit", exitCode: 0, signal: 0 } }));
	const closed = await client.close({ id: "t1" });

	assert.equal(closed.ok, true);
	assert.equal(calls[0].url, ORIGIN + "/v1/terminal/t1");
	assert.equal(calls[0].init.method, "DELETE");
});

test("a host refusal is the domain answer, not a transport failure", async () => {
	const { client } = terminal(() => answer({ ok: false, code: "unknown_terminal" }));
	assert.deepEqual(await client.input({ id: "gone", data: "x" }), { ok: false, code: "unknown_terminal" });
	assert.deepEqual(await client.close({ id: "gone" }), { ok: false, code: "unknown_terminal" });
});

test("a gateway with no terminal surface answers not_supported rather than a bare 501", async () => {
	const { client } = terminal(() => answer({ ok: false, code: "not_supported" }, 501));
	const opened = await client.open({ gatewayId: "g1", workspaceId: "w1", cols: 80, rows: 24 });
	assert.equal(opened.ok, false);
	assert.equal((opened as { code: string }).code, "not_supported");
});

test("a lost lifecycle mutation is outcome_unknown and is never sent twice", async () => {
	const { calls, client } = terminal(() => {
		throw new TypeError("fetch failed");
	});
	const error = await rejection(client.open({ gatewayId: "g1", workspaceId: "w1", cols: 80, rows: 24 }));
	assert.equal(error.code, "outcome_unknown");
	assert.equal(calls.length, 1);

	const resize = await rejection(client.resize({ id: "t1", cols: 10, rows: 10 }));
	assert.equal(resize.code, "outcome_unknown");
	assert.equal(calls.length, 2);
});

test("a connection that never opened is offline even for a terminal mutation, because nothing could have run", async () => {
	const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
	const { client } = terminal(() => {
		throw refused;
	});
	const error = await rejection(client.close({ id: "t1" }));
	assert.equal(error.code, "gateway_offline");
});

test("a rejected credential on a lifecycle call keeps its status", async () => {
	const { client } = terminal(() => answer({ ok: false, code: "unauthorized" }, 401));
	const error = await rejection(client.input({ id: "t1", data: "x" }));
	assert.equal(error.code, "unauthorized");
	assert.equal(error.status, 401);
});

test("a success body this capability does not accept is a protocol error, never a silent success", async () => {
	const { client } = terminal(() => answer({ unexpected: true }));
	const error = await rejection(client.open({ gatewayId: "g1", workspaceId: "w1", cols: 80, rows: 24 }));
	assert.equal(error.code, "protocol_error");
});

test("the event stream is handed back unread, with the caller's cursor as the host's reconnect header", async () => {
	const frames = ["id: 7\ndata: {\"type\":\"output\"}\n\n", ":\n\n"];
	const { calls, client } = terminal(() => streamed(frames));
	const response = await client.events({ id: "t1", after: 7 });

	assert.equal(calls[0].url, ORIGIN + "/v1/terminal/t1/events");
	assert.equal(calls[0].init.method, "GET");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer " + TOKEN);
	assert.equal(headers["last-event-id"], "7");
	assert.equal(response.headers.get("content-type"), "text/event-stream");

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let received = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		received += decoder.decode(chunk.value, { stream: true });
	}
	assert.equal(received, frames.join(""));
});

test("an attach with no cursor asks for the tail instead of sending an empty or unusable one", async () => {
	const first = terminal(() => streamed([]));
	await (await first.client.events({ id: "t1" })).body?.cancel();
	assert.equal((first.calls[0].init.headers as Record<string, string>)["last-event-id"], undefined);

	const second = terminal(() => streamed([]));
	await (await second.client.events({ id: "t1", after: "not-a-cursor" })).body?.cancel();
	assert.equal((second.calls[0].init.headers as Record<string, string>)["last-event-id"], undefined);

	const numeric = terminal(() => streamed([]));
	await (await numeric.client.events({ id: "t1", after: "12" })).body?.cancel();
	assert.equal((numeric.calls[0].init.headers as Record<string, string>)["last-event-id"], "12");
});

test("a caller that goes away closes the host stream, which is what releases the session", async () => {
	let aborted = false;
	const pending = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => {
				aborted = true;
				reject(signal?.reason ?? new Error("aborted"));
			};
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail, { once: true });
		});
	}) as unknown as typeof fetch;
	const transport = new GatewayHostTransport({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: pending });
	const client = terminalCapability(transport);
	const caller = new AbortController();
	const call = client.events({ id: "t1", signal: caller.signal });
	caller.abort();
	const error = await rejection(call);
	assert.equal(error.code, "aborted");
	assert.equal(aborted, true);
});

test("a caller that already cancelled is not sent, so no session is attached behind nobody", async () => {
	const { calls, client } = terminal(() => streamed([]));
	const caller = new AbortController();
	caller.abort();
	const error = await rejection(client.events({ id: "t1", signal: caller.signal }));
	assert.equal(error.code, "aborted");
	assert.equal(calls.length, 0);
});

test("the event stream has no request timeout, so a quiet session is not cut off", async () => {
	// The transport would time out at 20s by default and at 20ms here: a stream longer than that is the normal case.
	const quiet = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(init?.signal?.aborted, false, "the request was aborted by the transport's own bound");
		return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch;
	const client = terminalCapability(new GatewayHostTransport({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: quiet, timeoutMs: 20 }));
	const response = await client.events({ id: "t1" });
	assert.equal(response.status, 200);
});

test("a host that refuses the stream is a classified failure, never a response with nothing to read", async () => {
	const { client } = terminal(() => answer({ ok: false, code: "unknown_terminal" }, 404));
	const error = await rejection(client.events({ id: "gone" }));
	assert.equal(error.code, "operation_failed");
	assert.equal(error.status, 404);
	assert.equal(error.gatewayCode, "unknown_terminal");

	const bodiless = terminal(() => new Response(null, { status: 200 }));
	const empty = await rejection(bodiless.client.events({ id: "t1" }));
	assert.equal(empty.code, "protocol_error");
	assert.equal(empty.status, 200);
});

test("describe reads one session's own route, and its refusal is the domain answer", async () => {
	const live = terminal(() => answer({ ok: true, id: "t1", workspaceId: "w1", cwd: ".", cols: 80, rows: 24, exited: false }));
	const described = await live.client.describe({ id: "t1" });
	assert.deepEqual(described, { ok: true, id: "t1", workspaceId: "w1", cwd: ".", cols: 80, rows: 24, exited: false });
	assert.equal(live.calls[0].url, ORIGIN + "/v1/terminal/t1");
	assert.equal(live.calls[0].init.method, "GET");
	assert.equal((live.calls[0].init.headers as Record<string, string>).authorization, "Bearer " + TOKEN);

	const gone = terminal(() => answer({ ok: false, code: "unknown_terminal" }));
	assert.deepEqual(await gone.client.describe({ id: "gone" }), { ok: false, code: "unknown_terminal" });
});

test("the page's tabs of one host are one request, with each tab's own cursor", async () => {
	const { calls, client } = terminal(() => streamed(["id: a:1\n\n"]));
	const response = await client.fanIn({ tabs: [{ id: "a", after: 1 }, { id: "b" }, { id: "c:odd", after: 9 }] });
	assert.equal(response.status, 200);
	assert.equal(calls.length, 1, "one client serves one host, so its tabs are one request");
	// A tab with no cursor names its own id and an empty cursor, which asks the host for that session's retained tail.
	assert.equal(calls[0].url, ORIGIN + "/v1/terminal/events?tabs=" + encodeURIComponent("a:1,b:,c%3Aodd:9"));
	assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer " + TOKEN);
	await response.body?.cancel();
});

test("a page stream that names no tab is refused here rather than sent as an empty request", async () => {
	const { calls, client } = terminal(() => streamed([]));
	assert.equal((await rejection(client.fanIn({ tabs: [] }))).code, "protocol_error");
	assert.equal(calls.length, 0);
});

test("one client serves one host: an event request is one request, never a merge of bindings", async () => {
	const { calls, client } = terminal(() => streamed(["id: 1\n\n"]));
	await (await client.events({ id: "a", after: 1 })).body?.cancel();
	await (await client.events({ id: "b", after: 2 })).body?.cancel();
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, ORIGIN + "/v1/terminal/a/events");
	assert.equal(calls[1].url, ORIGIN + "/v1/terminal/b/events");
	assert.equal((calls[0].init.headers as Record<string, string>)["last-event-id"], "1");
	assert.equal((calls[1].init.headers as Record<string, string>)["last-event-id"], "2");
});

test("no terminal failure names the gateway token", async () => {
	const errors = [
		await rejection(terminal(() => answer({ ok: false, code: "unauthorized" }, 401)).client.open({ gatewayId: "g1", workspaceId: "w1", cols: 80, rows: 24 })),
		await rejection(terminal(() => { throw new TypeError("fetch failed"); }).client.input({ id: "t1", data: "x" })),
		await rejection(terminal(() => answer({ ok: false, code: "unknown_terminal" }, 404)).client.events({ id: "t1" })),
	];
	for (const error of errors) {
		assert.ok(!error.message.includes(TOKEN), "the message leaked the token: " + error.message);
		assert.ok(!String(error.stack).includes(TOKEN), "the stack leaked the token");
	}
});

test("an empty session id is refused here rather than sent as a route of its own", async () => {
	const { calls, client } = terminal(() => answer({ ok: true }));
	const error = await rejection(client.input({ id: "", data: "x" }));
	assert.equal(error.code, "protocol_error");
	assert.equal(calls.length, 0);

	const noId: TerminalEventRequest = { id: "" };
	assert.equal((await rejection(client.events(noId))).code, "protocol_error");
	assert.equal(calls.length, 0);
});
