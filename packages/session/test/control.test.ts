import assert from "node:assert/strict";
import test from "node:test";
import { createConversationControl, type OperationResult } from "../src/control.ts";

/**
 * The control seam's own decisions, over a fetch this test supplies.
 *
 * What is decided here is only the difference between an answer the caller has and one it does not: a 4xx is the
 * Backend's refusal with its own status and code, and everything else that produced no readable answer is an unknown
 * outcome carrying the attempt's request id — never a retry, never a refusal. Everything durable (the control, the
 * receipt, the queue, the branch) is the Backend's and is tested at the ingress; this file holds the classification and
 * the route each operation names.
 */

type Recorded = { readonly url: string; readonly method: string; readonly body?: unknown };

/** A client whose one fetch records what it was asked and answers with what the test states. */
function client(answer: () => Promise<Response>): { control: ReturnType<typeof createConversationControl>; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const control = createConversationControl({
		conversationId: "c 1",
		basePath: "http://ingress/api/conversations",
		fetch: async (input, init) => {
			calls.push({ url: input, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
			return await answer();
		},
	});
	return { control, calls };
}

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const unknown = (result: OperationResult<unknown>): Extract<OperationResult<unknown>, { kind: "unknown" }> => {
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.kind, "unknown");
	return result as Extract<OperationResult<unknown>, { kind: "unknown" }>;
};

const refused = (result: OperationResult<unknown>): Extract<OperationResult<unknown>, { kind: "refused" }> => {
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.kind, "refused");
	return result as Extract<OperationResult<unknown>, { kind: "refused" }>;
};

test("a 4xx is the Backend's refusal, named by its code or by the reason its receipt recorded", async () => {
	const byCode = client(() => json(409, { code: "revision_mismatch", error: "the control changed" }));
	const answer = refused(await byCode.control.stop("r1", { expectedControlRevision: 3 }));
	assert.deepEqual([answer.status, answer.code, answer.message], [409, "revision_mismatch", "the control changed"]);
	assert.deepEqual(byCode.calls[0]!.body, { requestId: "r1", expectedControlRevision: 3 });

	// A route that refuses with the receipt's own `reason` is the same refusal under the name it stated, not a second
	// vocabulary the caller has to learn.
	const byReason = client(() => json(409, { reason: "source_locked", message: "the user stopped this conversation" }));
	assert.equal(refused(await byReason.control.stop("r2")).code, "source_locked");
});

test("an answer that never arrived is unknown, carries the attempt's request id, and is not retried", async () => {
	const dropped = client(() => { throw new TypeError("connection reset"); });
	const thrown = unknown(await dropped.control.stop("r1"));
	assert.equal(thrown.requestId, "r1");
	assert.equal(dropped.calls.length, 1);

	// A 5xx came from a hop, not from the Backend's own decision, so it says nothing about whether the write committed.
	const server = client(() => json(503, { error: "backend unreachable" }));
	assert.equal(unknown(await server.control.continueRun("r2")).requestId, "r2");

	// A body this build cannot read is an answer it does not have, and a write's answer may be the only statement that
	// it committed.
	const mangled = client(() => Promise.resolve(new Response("{\"status\":\"acc", { status: 202 })));
	assert.equal(unknown(await mangled.control.fork({ requestId: "r3" })).requestId, "r3");
});

test("a queue-only admission is the composer's steer and never the resuming message route", async () => {
	const queued = client(() => json(202, { submissionId: "s1", control: { held: false, revision: 1 } }));
	await queued.control.send("r1", "a draft", { queueOnly: true, whenBusy: "steer" });
	assert.deepEqual(queued.calls[0], { url: "http://ingress/api/conversations/c%201/busy", method: "POST", body: { requestId: "r1", text: "a draft", mode: "steer" } });

	// An attachment is not dropped because the admission was queued: the queue-only route carries the same text and
	// images an ordinary send does, and the Backend decides what a busy conversation does with them.
	const attached = client(() => json(202, { submissionId: "s3", control: { held: false, revision: 1 } }));
	await attached.control.send("r3", "a draft", { queueOnly: true, whenBusy: "followUp", images: [{ type: "image", data: "AQID", mimeType: "image/png" }] });
	assert.deepEqual(attached.calls[0], { url: "http://ingress/api/conversations/c%201/busy", method: "POST", body: { requestId: "r3", text: "a draft", mode: "follow-up", images: [{ type: "image", data: "AQID", mimeType: "image/png" }] } });

	const immediate = client(() => json(202, { submissionId: "s2", control: { held: false, revision: 2 } }));
	await immediate.control.send("r2", "hello");
	assert.deepEqual(immediate.calls[0], { url: "http://ingress/api/conversations/c%201/messages", method: "POST", body: { protocol: "hepi.v1", type: "conversation.submit", requestId: "r2", text: "hello" } });
});

test("a delegation is read as the identity it answered: the child it created, or the target it addressed", async () => {
	const created = client(() => json(201, { childConversationId: "9", dispatchId: "d1", requestId: "r1", created: true, definition: "reviewer", displayParentId: "2" }));
	const child = await created.control.delegate({ name: "reviewer", task: "look", requestId: "r1" });
	assert.equal(child.ok, true);
	assert.deepEqual(child.ok === true ? [child.value.conversationId, child.value.created, child.value.definition, child.value.displayParentId] : [], ["9", true, "reviewer", "2"]);

	// A dispatch creates nothing, so it names the conversation the task is for and states that it made no child.
	const dispatched = client(() => json(202, { conversationId: "7", dispatchId: "d2", requestId: "r2", submissionId: "s1" }));
	const target = await dispatched.control.delegate({ name: "reviewer", task: "again", requestId: "r2", conversationId: "7" });
	assert.deepEqual(target.ok === true ? [target.value.conversationId, target.value.created, target.value.childConversationId] : [], ["7", false, undefined]);

	// An answer that names no identity at all states nothing about what the write did.
	const silent = client(() => json(201, { dispatchId: "d3" }));
	assert.equal(unknown(await silent.control.delegate({ name: "reviewer", task: "look", requestId: "r3" })).requestId, "r3");
});

test("the control read asks about one request id, and a fork repeats its own attempt identity", async () => {
	const { control, calls } = client(() => json(200, { control: { held: true, revision: 4 }, receipt: null }));
	await control.control("r 1");
	await control.control();
	await control.fork({ at: "12", requestId: "f1" });
	assert.deepEqual(calls.map(call => [call.method, call.url]), [
		["GET", "http://ingress/api/conversations/c%201/control?requestId=r%201"],
		["GET", "http://ingress/api/conversations/c%201/control"],
		["POST", "http://ingress/api/conversations/c%201/fork"],
	]);
	assert.deepEqual(calls[2]!.body, { at: "12", requestId: "f1" });
});
