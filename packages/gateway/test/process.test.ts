import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayHostClient, HostTransportError, type ExecuteRequest } from "../src/index.ts";

const TOKEN = "{{SECRET_proc9x2q}}";

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

function client(fetchImpl: typeof fetch): GatewayHostClient {
	return new GatewayHostClient({ gatewayOrigin: "http://127.0.0.1:7042", gatewayToken: TOKEN, fetch: fetchImpl });
}

/** One NDJSON execution answer over the frames the test names. */
function frames(...lines: readonly unknown[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(lines.map((line) => JSON.stringify(line) + "\n").join("")));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

const request: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-1", command: ["bash", "-c", "printf out"] };
const result = { ok: true, gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-1", stdout: "out", stderr: "", exitCode: 0 } as const;

async function rejection(call: Promise<unknown>): Promise<HostTransportError> {
	try {
		await call;
	} catch (error) {
		assert.ok(error instanceof HostTransportError, "expected a HostTransportError, got " + String(error));
		return error;
	}
	throw new Error("the call was expected to fail");
}

test("executes over the shared transport and returns the result frame", async () => {
	const recorder = recording(() => frames({ type: "output", stream: "stdout", text: "out" }, { type: "result", result }));
	const answer = await client(recorder.fetch).process.execute(request);

	assert.deepEqual(answer, result);
	assert.equal(recorder.calls.length, 1);
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/execute");
	assert.equal(recorder.calls[0].init.method, "POST");
	const headers = recorder.calls[0].init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer " + TOKEN);
	assert.equal(headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(String(recorder.calls[0].init.body)), request);
});

test("delivers stderr, clipping facts and a skipped count exactly as the frames carried them", async () => {
	const frameLines = [
		{ type: "output", stream: "stdout", text: "head" },
		{ type: "output", stream: "stderr", text: "tail", skipped: { bytes: 12, lines: 3 } },
		{ type: "result", result: { ...result, stdout: "head", stderr: "tail", truncated: true, spillUnsupported: true } },
	];
	const seen: { stream: string; text: string; skipped?: unknown }[] = [];
	const answer = await client(recording(() => frames(...frameLines)).fetch).process.execute(request, (chunk) => {
		seen.push(chunk);
	});

	assert.deepEqual(seen, [
		{ stream: "stdout", text: "head" },
		{ stream: "stderr", text: "tail", skipped: { bytes: 12, lines: 3 } },
	]);
	assert.equal(answer.ok === true && answer.truncated, true);
	assert.equal(answer.ok === true && answer.spillUnsupported, true);
});

test("a sink that has not settled holds the next frame back", async () => {
	const order: string[] = [];
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const answer = client(recording(() => frames(
		{ type: "output", stream: "stdout", text: "one" },
		{ type: "output", stream: "stdout", text: "two" },
		{ type: "result", result },
	)).fetch).process.execute(request, async (chunk) => {
		order.push("begin:" + chunk.text);
		if (order.length === 1) await held;
		order.push("end:" + chunk.text);
	});

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["begin:one"], "the second frame waited for the first callback to settle");
	release();
	assert.deepEqual(await answer, result);
	assert.deepEqual(order, ["begin:one", "end:one", "begin:two", "end:two"]);
});

test("an answer that ends without a result frame is an unknown outcome and is not sent again", async () => {
	const recorder = recording(() => frames({ type: "output", stream: "stdout", text: "partial" }));
	const seen: string[] = [];
	const answer = await client(recorder.fetch).process.execute(request, (chunk) => {
		seen.push(chunk.text);
	});

	assert.deepEqual(answer, { ok: false, code: "outcome-unknown", callId: "call-1", message: "the gateway response ended without a result" });
	assert.deepEqual(seen, ["partial"], "output before the loss was still delivered");
	assert.equal(recorder.calls.length, 1, "the call was not sent again");
});

test("a body that breaks mid-stream is an unknown outcome, and a malformed frame as well", async () => {
	const broken = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "output", stream: "stdout", text: "partial" }) + "\n"));
					controller.error(new Error("terminated"));
				},
			}),
			{ status: 200, headers: { "content-type": "application/x-ndjson" } },
		);
	const disconnected = await client(recording(broken).fetch).process.execute(request);
	assert.equal(disconnected.ok === false && disconnected.code, "outcome-unknown");
	assert.equal(disconnected.ok === false && disconnected.message, "the gateway response ended before the call settled");

	const malformed = await client(recording(() => frames({ type: "result" })).fetch).process.execute(request);
	assert.equal(malformed.ok === false && malformed.code, "outcome-unknown", "a malformed result is uncertainty, not a thrown fault");
});

test("a refused credential is unauthorized and a refused request is an unknown outcome, never a retry", async () => {
	const unauthorized = await client(recording(() => new Response(JSON.stringify({ ok: false, code: "unauthorized" }), { status: 401 })).fetch).process.execute(request);
	assert.deepEqual(unauthorized, { ok: false, code: "unauthorized", callId: "call-1" });

	const recorder = recording(() => new Response(JSON.stringify({ ok: false, code: "invalid_request" }), { status: 400 }));
	const refused = await client(recorder.fetch).process.execute(request);
	assert.equal(refused.ok === false && refused.code, "outcome-unknown");
	assert.equal(recorder.calls.length, 1);
});

test("a connection that never opened is offline, and a lost connection mid-call is an unknown outcome", async () => {
	const offline = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
	const refused = await client(recording(() => { throw offline; }).fetch).process.execute(request);
	assert.deepEqual(refused, { ok: false, code: "gateway_offline", callId: "call-1" });

	const lost = await client(recording(() => { throw new TypeError("fetch failed"); }).fetch).process.execute(request);
	assert.deepEqual(lost, { ok: false, code: "outcome-unknown", callId: "call-1" });
});

test("the caller's own cancellation is reported as aborted, and nothing is sent after it", async () => {
	const caller = new AbortController();
	const pending = (async (_input: string | URL | Request, init?: RequestInit) => {
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => reject(signal?.reason ?? new Error("aborted"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail, { once: true });
		});
	}) as unknown as typeof fetch;
	const call = client(pending).process.execute(request, undefined, { signal: caller.signal });
	caller.abort();
	const cancelled = await call;
	assert.equal(cancelled.ok === false && cancelled.code, "aborted");

	const recorder = recording(() => frames({ type: "result", result }));
	const given = new AbortController();
	given.abort();
	const answer = await client(recorder.fetch).process.execute(request, undefined, { signal: given.signal });
	assert.equal(answer.ok === false && answer.code, "aborted");
	assert.equal(recorder.calls.length, 0, "a call the caller gave up on is not sent");
});

test("an abort reports the gateway's answer and keeps its five second bound", async () => {
	const recorder = recording(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
	assert.deepEqual(await client(recorder.fetch).process.abort("call-7"), { ok: true });
	assert.equal(recorder.calls[0].url, "http://127.0.0.1:7042/v1/abort");
	assert.deepEqual(JSON.parse(String(recorder.calls[0].init.body)), { callId: "call-7" });
	assert.equal((recorder.calls[0].init.headers as Record<string, string>).authorization, "Bearer " + TOKEN);

	const refused = recording(() => new Response(JSON.stringify({ ok: false }), { status: 200 }));
	assert.deepEqual(await client(refused.fetch).process.abort("call-8"), { ok: false }, "a refusal is a definitive answer");

	const pending = (async (_input: string | URL | Request, init?: RequestInit) =>
		await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => reject(signal?.reason ?? new Error("aborted"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail, { once: true });
		})) as unknown as typeof fetch;
	assert.equal((await rejection(client(pending).process.abort("call-9", { timeoutMs: 10 }))).code, "timeout");
});

test("an abort the gateway refuses for a status throws, and an answer that names no outcome is a protocol error", async () => {
	const recorder = recording(() => new Response(JSON.stringify({ ok: false, code: "unknown_call" }), { status: 409, headers: { "content-type": "application/json" } }));
	const refused = await rejection(client(recorder.fetch).process.abort("call-1"));
	assert.equal(refused.code, "operation_failed");
	assert.equal(refused.status, 409);
	assert.equal(refused.gatewayCode, "unknown_call");
	assert.equal(recorder.calls.length, 1, "an unknown abort is not attempted twice");

	const silent = await rejection(client(recording(() => new Response(JSON.stringify({}), { status: 200 })).fetch).process.abort("call-1"));
	assert.equal(silent.code, "protocol_error");
});

test("a lost abort answer is unknown, and carries no further attempt", async () => {
	const recorder = recording(() => { throw new TypeError("fetch failed"); });
	const error = await rejection(client(recorder.fetch).process.abort("call-1"));
	assert.equal(error.code, "outcome_unknown");
	assert.equal(recorder.calls.length, 1);
});
