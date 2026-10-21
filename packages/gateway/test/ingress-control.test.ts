import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LocalFilesystem } from "../src/filesystem.ts";
import { GatewayRpcServer, LocalGateway } from "../src/index.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { createAnswerGate, fauxModels, gatedEchoModels, SERVER_MODEL, type AnswerGate } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";
import { createConversationControl } from "../../session/src/control.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";

/**
 * Conversation control, queue, fork and relations through the client ingress, over real HTTP against a real Backend.
 *
 * These are the public-seam tests for ticket 10: the named domain operations a Web page or an App calls to stop and
 * continue a conversation, to steer and edit its queue, to fork it and to record a relation. The Backend owns every
 * durable fact — the control revision, the receipt, the queued item, the branch, the tombstone — and the client owns
 * only the request it makes and the answer it reads back. A lost answer is therefore never retried: it is resolved by
 * asking the conversation about the request id it was made under, which is the same recovery a pending submission
 * uses.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const workspace = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), "hepi-control-ingress-")); directories.push(directory); return directory; };

const BACKEND_TOKEN = "backend-service-token";
const WEB_LOGIN = "web-login-material";

type Fixture = {
	origin: string;
	backend: BackendServer;
	ingress: ClientIngress;
	cookie: string;
	device: string;
	close(): Promise<void>;
};

/** One real Backend with device credentials, one client ingress in front of it, and one session of each kind. */
async function fixture(): Promise<Fixture> {
	const directory = await workspace();
	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const backend = await createBackendServer({ dbPath: join(directory, "hepi.sqlite"), authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL, deviceCredentials: credentials, buildId: "build-1", backendId: "backend-1", accountScope: "account-1" });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const address = backend.server.address();
	assert.ok(address && typeof address === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN, appOrigins: ["http://app.example"] });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
	assert.equal(issued.status, 201);
	const device = ((await issued.json()) as { token: string }).token;
	return {
		origin,
		backend,
		ingress,
		cookie,
		device,
		close: async () => { await ingress.close(); credentials.close(); await backend.close(); },
	};
}

/** A caller of the client API: the browser's own cookie, or an App's device bearer. The ingress decides which it may do. */
function client(target: Fixture, identity: "web" | "device", conversationId: string) {
	const header: Record<string, string> = identity === "web" ? { cookie: target.cookie } : { authorization: "Bearer " + target.device };
	return createConversationControl({
		conversationId,
		basePath: target.origin + "/api/conversations",
		fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...header } }),
	});
}

/**
 * An origin in front of the ingress that lets a request reach it and then destroys the caller's own connection instead
 * of answering. The operation really runs — the answer is awaited before the socket is dropped — so this is the
 * broken link a client cannot tell from a request that never arrived, which is exactly the state that must never be
 * retried.
 */
async function blackHole(target: string): Promise<{ origin: string; close(): Promise<void> }> {
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const headers = { ...request.headers } as Record<string, string>;
			delete headers.host;
			delete headers.connection;
			delete headers["content-length"];
			await fetch(target + (request.url ?? "/"), { method: request.method, headers, ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }) }).catch(() => undefined);
			request.socket.destroy();
			response.destroy();
		})();
	});
	server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); sockets.clear(); server.closeAllConnections(); server.close(() => resolve()); }),
	};
}


/** Wait on a real condition of the committed state, so a loaded machine cannot race a fixed sleep. */
async function waitForCondition<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const current = await read();
		if (current !== undefined) return current;
		if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

/** The state the ingress forwards, read with the Web session: what a surface shows beside the control it read. */
async function state(target: Fixture, conversationId: string): Promise<{ busy: boolean; control: { state: string; revision: number }; queuedMessages: { steering: string[]; followUp: string[] }; entries: { id: string; role: string; text: string }[] }> {
	const response = await fetch(target.origin + "/api/conversations/" + conversationId + "/state", { headers: { cookie: target.cookie } });
	assert.equal(response.status, 200);
	return await response.json() as never;
}

async function create(target: Fixture, body: Record<string, unknown> = {}): Promise<string> {
	const response = await fetch(target.origin + "/api/conversations", { method: "POST", headers: { cookie: target.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
	const text = await response.text();
	assert.equal(response.status, 201, text);
	return (JSON.parse(text) as { conversationId: string }).conversationId;
}

test("a stop is answered with its durable receipt, and the control read states the same commit", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		const stopped = await control.stop("stop-1");
		assert.equal(stopped.ok, true, JSON.stringify(stopped));
		if (!stopped.ok) return;
		assert.equal(stopped.value.status, "accepted");
		assert.equal(stopped.value.control.state, "held");
		assert.equal(stopped.value.control.revision, 1);
		assert.equal(stopped.value.receipt.requestId, "stop-1");
		assert.equal(stopped.value.receipt.operation, "stop");

		// The read is the durable record, not the client's memory of the answer it just received.
		const read = await control.control("stop-1");
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.deepEqual(read.value.control, stopped.value.control);
		assert.equal(read.value.receipt?.requestId, "stop-1");
		// A request id this conversation never recorded answers no receipt, which is a statement about that request.
		const unknownId = await control.control("never-sent");
		assert.equal(unknownId.ok, true);
		if (unknownId.ok) assert.equal(unknownId.value.receipt, null);
	} finally {
		await target.close();
	}
});

test("a stop whose answer was lost is unknown, and the same request id reads back what really happened", async () => {
	const target = await fixture();
	const hole = await blackHole(target.origin);
	try {
		const id = await create(target);
		const through = (conversationId: string, basePath: string) => createConversationControl({
			conversationId,
			basePath,
			fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: target.cookie } }),
		});
		const lost = await through(id, hole.origin + "/api/conversations").stop("stop-lost");
		assert.equal(lost.ok, false, JSON.stringify(lost));
		if (lost.ok) return;
		assert.equal(lost.kind, "unknown");
		assert.equal(lost.requestId, "stop-lost");

		// The operation really happened; the answer is what went missing. The request id names the durable receipt.
		const control = client(target, "web", id);
		const recovered = await control.control("stop-lost");
		assert.equal(recovered.ok, true);
		if (!recovered.ok) return;
		assert.equal(recovered.value.receipt?.status, "accepted");
		assert.equal(recovered.value.control.state, "held");
		assert.equal(recovered.value.control.revision, 1);

		// Resolving an unknown outcome is a read. Repeating the same request id is answered from the same receipt and
		// moves nothing: the conversation was held once, not twice.
		const replay = await control.stop("stop-lost");
		assert.equal(replay.ok, true);
		if (!replay.ok) return;
		assert.deepEqual(replay.value.control, recovered.value.control);
		assert.equal((await state(target, id)).control.revision, 1);
	} finally {
		await hole.close();
		await target.close();
	}
});

test("a refusal is a refusal and never an unknown outcome", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		assert.equal((await control.stop("stop-1")).ok, true);
		// A control revision that is not the committed one is refused, and the refusal names itself.
		const stale = await control.stop("stop-2", { expectedControlRevision: 99 });
		assert.equal(stale.ok, false);
		if (!stale.ok) {
			assert.equal(stale.kind, "refused");
			assert.equal(stale.status, 409);
			assert.equal(stale.code, "revision_mismatch");
		}
		// A fork of an entry the conversation does not hold is refused, and it created nothing.
		const forked = await control.fork({ at: "999999", requestId: "fork-1" });
		assert.equal(forked.ok, false);
		if (!forked.ok) {
			assert.equal(forked.kind, "refused");
			assert.equal(forked.code, "unsaved");
		}
		const catalogue = await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } });
		assert.equal(((await catalogue.json()) as { conversations: unknown[] }).conversations.length, 1);
	} finally {
		await target.close();
	}
});

test("an unreachable Backend is an unknown outcome for a write, and nothing is remembered as applied", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		await target.backend.close();
		const stopped = await control.stop("stop-unreachable");
		assert.equal(stopped.ok, false, JSON.stringify(stopped));
		if (!stopped.ok) {
			assert.equal(stopped.kind, "unknown", "an ingress that could not reach the Backend stated an outcome it does not have");
			assert.equal(stopped.requestId, "stop-unreachable");
		}
	} finally {
		await target.ingress.close();
	}
});

test("two clients of one conversation read one authoritative control state", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const web = client(target, "web", id);
		const phone = client(target, "device", id);
		const stopped = await phone.stop("stop-phone");
		assert.equal(stopped.ok, true);
		const seen = await web.control();
		assert.equal(seen.ok, true);
		if (!seen.ok) return;
		assert.equal(seen.value.control.state, "held");
		assert.equal(seen.value.control.stopSource, "user");
		// The same hold rides the frame the conversation publishes, so a surface never infers it from its own action.
		const published = await state(target, id);
		assert.deepEqual(published.control, seen.value.control);
		const resumed = await web.continueRun("continue-web");
		assert.equal(resumed.ok, true);
		if (!resumed.ok) return;
		assert.equal(resumed.value.control.state, "allowed");
		assert.equal(resumed.value.control.revision, seen.value.control.revision + 1);
		const after = await phone.control();
		assert.equal(after.ok, true);
		if (after.ok) assert.deepEqual(after.value.control, resumed.value.control);
	} finally {
		await target.close();
	}
});

test("a queued steer and follow-up are one queue, and a lost queue answer is found by its request id", async () => {
	const target = await fixture();
	const hole = await blackHole(target.origin);
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		// A hold is the user's own decision, and a queue-only admission never lifts it.
		assert.equal((await control.stop("stop-1")).ok, true);
		const steered = await control.send("steer-1", "steer this", { whenBusy: "steer", queueOnly: true });
		assert.equal(steered.ok, true, JSON.stringify(steered));
		if (!steered.ok) return;
		assert.ok(steered.value.submissionId !== undefined);
		assert.equal(steered.value.control.state, "held");

		// The answer to one follow-up is dropped by the hop in front of the ingress. It was admitted all the same.
		const through = createConversationControl({
			conversationId: id,
			basePath: hole.origin + "/api/conversations",
			fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: target.cookie } }),
		});
		const lost = await through.send("later-1", "later", { whenBusy: "followUp", queueOnly: true });
		assert.equal(lost.ok, false, JSON.stringify(lost));
		if (!lost.ok) {
			assert.equal(lost.kind, "unknown");
			assert.equal(lost.requestId, "later-1");
		}

		// The queue is the conversation's own, and each item carries the request id it was admitted under: that is what
		// resolves the lost answer without sending the text again.
		const queued = await control.items();
		assert.equal(queued.ok, true, JSON.stringify(queued));
		if (!queued.ok) return;
		assert.deepEqual(queued.value.items.map(item => [item.requestId, item.mode, item.content]), [["steer-1", "steer", "steer this"], ["later-1", "followUp", "later"]]);
		assert.deepEqual((await state(target, id)).queuedMessages, { steering: ["steer this"], followUp: ["later"] });
	} finally {
		await hole.close();
		await target.close();
	}
});

test("one queued item is edited against the token it was read with, cancelled idempotently, and recalled in queue order", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		assert.equal((await control.stop("stop-1")).ok, true);
		const first = await control.send("q-1", "first draft", { whenBusy: "followUp", queueOnly: true });
		const second = await control.send("q-2", "second draft", { whenBusy: "steer", queueOnly: true });
		assert.equal(first.ok && second.ok, true);
		const read = await control.items();
		assert.equal(read.ok, true);
		if (!read.ok) return;
		const [one, two] = read.value.items;
		assert.ok(one !== undefined && two !== undefined);

		// The token the caller read is what an edit is conditional on: the newer text replaces exactly one item.
		const edited = await control.editItem(one.submissionId, { contentToken: one.contentToken, content: "first, edited" });
		assert.equal(edited.ok, true, JSON.stringify(edited));
		if (edited.ok) {
			assert.equal(edited.value.status, "edited");
			assert.equal(edited.value.item?.content, "first, edited");
		}
		// A tab still holding the older text is refused with the current item, and it is a refusal, not an unknown outcome.
		const stale = await control.editItem(one.submissionId, { contentToken: one.contentToken, content: "stale overwrite" });
		assert.equal(stale.ok, false, JSON.stringify(stale));
		if (!stale.ok) {
			assert.equal(stale.kind, "refused");
			assert.equal(stale.code, "content_conflict");
		}

		// A cancel goes through the native abort and is the same outcome when it is asked for twice.
		const cancelled = await control.cancelItem(two.submissionId);
		assert.equal(cancelled.ok, true);
		if (cancelled.ok) assert.equal(cancelled.value.status, "cancelled");
		const again = await control.cancelItem(two.submissionId);
		assert.equal(again.ok, true);
		if (again.ok) assert.equal(again.value.status, "already_cancelled");

		// The recall hands the remaining text back in queue order and leaves the hold where the user put it.
		const recalled = await control.recallQueue();
		assert.equal(recalled.ok, true);
		if (recalled.ok) assert.deepEqual([recalled.value.steering, recalled.value.followUp], [[], ["first, edited"]]);
		const after = await state(target, id);
		assert.deepEqual(after.queuedMessages, { steering: [], followUp: [] });
		assert.equal(after.control.state, "held");
	} finally {
		await target.close();
	}
});

test("a queued item the conversation has already placed is refused as not queued, and the refusal says so", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		const admitted = await control.send("q-1", "run this", { whenBusy: "followUp" });
		assert.equal(admitted.ok, true, JSON.stringify(admitted));
		if (!admitted.ok) return;
		assert.ok(admitted.value.submissionId !== undefined);
		// The input ran: it is no longer a queued item, so editing it is a conflict rather than a write to history.
		const edited = await control.editItem(admitted.value.submissionId, { contentToken: "anything", content: "too late" });
		assert.equal(edited.ok, false);
		if (!edited.ok) {
			assert.equal(edited.kind, "refused");
			assert.equal(edited.code, "not_queued");
		}
	} finally {
		await target.close();
	}
});

test("a fork keeps its provenance and its branch point, and a lost answer is resolved by the attempt's own identity", async () => {
	const target = await fixture();
	const hole = await blackHole(target.origin);
	try {
		const parent = await create(target);
		const control = client(target, "web", parent);
		const answered = await control.send("turn-1", "the branch point");
		assert.equal(answered.ok, true, JSON.stringify(answered));
		const current = await state(target, parent);
		const entryIds = current.entries.map(entry => entry.id);
		assert.ok(entryIds.length >= 2, JSON.stringify(current.entries));

		// The branch point is one entry of the source's own history, and the copy inherits exactly up to it.
		const branch = await control.fork({ at: entryIds[1], requestId: "fork-1" });
		assert.equal(branch.ok, true, JSON.stringify(branch));
		if (!branch.ok) return;
		assert.notEqual(branch.value.conversationId, parent);
		const copy = await state(target, branch.value.conversationId);
		assert.deepEqual(copy.entries.map(entry => entry.id), entryIds.slice(0, 2));

		// Its provenance is its own: the native fork source, the catalogue row's parent, and no relation the source held.
		const info = await client(target, "web", branch.value.conversationId).info();
		assert.equal(info.ok, true, JSON.stringify(info));
		if (!info.ok) return;
		assert.deepEqual(info.value.forkSource, { conversationId: parent, at: entryIds[1] });
		assert.equal(info.value.relations.displayParentId, undefined, "a branch of an ordinary conversation is not displayed under it");
		const catalogue = await (await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } })).json() as { conversations: { id: string; parentConversationId?: string; createdBy?: string }[] };
		const row = catalogue.conversations.find(candidate => candidate.id === branch.value.conversationId);
		assert.equal(row?.parentConversationId, parent);
		assert.equal(row?.createdBy, undefined);
		// The source is untouched by the copy.
		assert.deepEqual((await state(target, parent)).entries, current.entries);

		// The same attempt identity answers the branch the first attempt made, and creates no second copy.
		const replay = await control.fork({ at: entryIds[1], requestId: "fork-1" });
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.value.conversationId, branch.value.conversationId);
		const after = await (await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } })).json() as { conversations: unknown[] };
		assert.equal(after.conversations.length, 2, "a replayed fork made a second copy");

		// A fork whose answer is lost is the same state a lost stop is in: the attempt's identity is what finds it, and
		// the retry that carries it is answered with the branch that already exists.
		const lostThrough = createConversationControl({
			conversationId: parent,
			basePath: hole.origin + "/api/conversations",
			fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: target.cookie } }),
		});
		const lost = await lostThrough.fork({ at: entryIds[1], requestId: "fork-lost" });
		assert.equal(lost.ok, false, JSON.stringify(lost));
		if (!lost.ok) {
			assert.equal(lost.kind, "unknown");
			assert.equal(lost.requestId, "fork-lost");
		}
		const found = await control.fork({ at: entryIds[1], requestId: "fork-lost" });
		assert.equal(found.ok, true, JSON.stringify(found));
		if (!found.ok) return;
		assert.deepEqual((await state(target, found.value.conversationId)).entries.map(entry => entry.id), entryIds.slice(0, 2));
		const settled = await (await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } })).json() as { conversations: unknown[] };
		assert.equal(settled.conversations.length, 3, "the lost fork was made once and found by its identity");
	} finally {
		await hole.close();
		await target.close();
	}
});

test("a reference is the referencing conversation's own state and changes nothing about its target", async () => {
	const target = await fixture();
	try {
		const source = await create(target);
		const other = await create(target);
		const control = client(target, "web", source);
		const answered = await control.send("turn-1", "referenced");
		assert.equal(answered.ok, true);
		const entryId = (await state(target, other)).entries.at(-1)?.id;

		const added = await control.addReference({ conversationId: other, label: "the other one", ...(entryId === undefined ? {} : { entryId }) });
		assert.equal(added.ok, true, JSON.stringify(added));
		if (!added.ok) return;
		assert.deepEqual(added.value.references, [{ conversationId: other, label: "the other one", ...(entryId === undefined ? {} : { entryId }) }]);
		// The same target is idempotent: a second reference to it is the same reference.
		const again = await control.addReference({ conversationId: other, label: "the other one", ...(entryId === undefined ? {} : { entryId }) });
		assert.equal(again.ok, true);
		if (again.ok) assert.deepEqual(again.value.references, added.value.references);

		// The target gained no relation and no display parent from being referenced.
		const targetInfo = await client(target, "web", other).info();
		assert.equal(targetInfo.ok, true);
		if (targetInfo.ok) {
			assert.deepEqual(targetInfo.value.references, []);
			assert.equal(targetInfo.value.relations.createdBy, undefined);
			assert.equal(targetInfo.value.relations.displayParentId, undefined);
		}
		// An unknown target is refused by the named outcome a follow reports, relayed unchanged, and it copied nothing.
		const unknown = await control.addReference({ conversationId: "999999", label: "nowhere" });
		assert.equal(unknown.ok, false);
		if (!unknown.ok) {
			assert.equal(unknown.kind, "refused");
			assert.equal(unknown.code, "target-missing");
		}
		const stillOne = await control.info();
		assert.equal(stillOne.ok, true);
		if (stillOne.ok) assert.equal(stillOne.value.references.length, 1);
	} finally {
		await target.close();
	}
});

test("a removed conversation leaves the catalogue, keeps its records readable and refuses every control write", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		assert.equal((await control.send("turn-1", "before the removal")).ok, true);
		const removed = await control.remove();
		assert.equal(removed.ok, true, JSON.stringify(removed));
		if (removed.ok) assert.equal(removed.value.removed, true);

		// It is out of the catalogue it was removed from, and its records still read back: the removal is a tombstone.
		const catalogue = await (await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } })).json() as { conversations: { id: string }[] };
		assert.deepEqual(catalogue.conversations, []);
		const read = await control.info();
		assert.equal(read.ok, true);
		assert.deepEqual((await state(target, id)).entries.map(entry => entry.text), ["before the removal", "Server reply to: before the removal"]);

		// Every write that would govern a conversation nobody can see is refused with the reason the caller reads.
		for (const answer of [await control.stop("stop-1"), await control.continueRun("continue-1"), await control.send("turn-2", "after"), await control.send("q-1", "queued", { whenBusy: "followUp", queueOnly: true })]) {
			assert.equal(answer.ok, false, JSON.stringify(answer));
			if (!answer.ok) {
				assert.equal(answer.kind, "refused");
				assert.equal(answer.code, "session_deleted");
			}
		}
	} finally {
		await target.close();
	}
});

/**
 * One ingress in front of a Backend that has a real execution host, so a delegation resolves a real Agent Definition on
 * a real workspace. The definition's own document decides the child's configuration and its context strategy.
 */
async function workspaceFixture(prefix: string): Promise<Fixture> {
	const base = await mkdtemp(join(tmpdir(), prefix));
	directories.push(base);
	const root = join(base, "workspace");
	const home = join(base, "home");
	await mkdir(join(root, ".pi", "agents"), { recursive: true });
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n");
	const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
	const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, new LocalFilesystem(workspaces, { identity: { user: "operator", home } }));
	await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
	const gatewayAddress = gateway.server.address();
	assert.ok(gatewayAddress && typeof gatewayAddress === "object");
	const credentials = createDeviceCredentials({ path: join(base, "device-credentials.sqlite") });
	const backend = await createBackendServer({
		dbPath: join(base, "hepi.sqlite"), authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL,
		deviceCredentials: credentials,
		workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" }],
	});
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const target: Fixture = {
		origin: "http://127.0.0.1:" + ingressAddress.port,
		backend,
		ingress,
		cookie: "",
		device: "",
		close: async () => { await ingress.close(); credentials.close(); await backend.close(); gateway.server.closeAllConnections(); await gateway.close(); },
	};
	const login = await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: target.origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	target.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	return target;
}

/** Create a conversation bound to the fixture's one workspace, with delegation selected so it may delegate at all. */
async function delegating(target: Fixture): Promise<string> {
	const response = await fetch(target.origin + "/api/conversations", { method: "POST", headers: { cookie: target.cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "local" }) });
	const text = await response.text();
	assert.equal(response.status, 201, text);
	const id = (JSON.parse(text) as { conversationId: string }).conversationId;
	// Delegation is a capability the conversation selects, exactly as the model's own delegating tool requires.
	const enabled = await fetch(target.origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers: { cookie: target.cookie, "content-type": "application/json" }, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
	assert.equal(enabled.status, 200, await enabled.text());
	return id;
}

test("a delegation names its definition and its target, keeps the child's provenance, and a lost answer is one child", { timeout: 60_000 }, async (t) => {
	const target = await workspaceFixture("hepi-delegate-ingress-");
	const hole = await blackHole(target.origin);
	try {
		const parentId = await delegating(target);
		const control = client(target, "web", parentId);

		const created = await control.delegate({ name: "worker", task: "child work", requestId: "attempt-1" });
		assert.equal(created.ok, true, JSON.stringify(created));
		if (!created.ok) return;
		assert.equal(created.value.created, true);
		// A quick create states the child twice — as the conversation the task is for, and as the child this made — and
		// the two agree, which is what lets one answer shape serve a create and a dispatch.
		assert.equal(created.value.childConversationId, created.value.conversationId);
		assert.notEqual(created.value.conversationId, parentId);

		// The child's provenance names the definition and its host, and its creator and its place are its own relations.
		const child = await client(target, "web", created.value.conversationId).info();
		assert.equal(child.ok, true, JSON.stringify(child));
		if (!child.ok) return;
		assert.deepEqual(child.value.relations.provenance?.definition, { hostId: "workstation", scope: "project", name: "worker" });
		assert.equal(child.value.relations.createdBy, parentId);
		assert.equal(child.value.relations.displayParentId, parentId);
		assert.equal(child.value.owner?.conversationId, parentId);

		// The same attempt identity answers the child the first attempt made, and creates no second one.
		const replay = await control.delegate({ name: "worker", task: "child work", requestId: "attempt-1" });
		assert.equal(replay.ok, true, JSON.stringify(replay));
		if (!replay.ok) return;
		assert.equal(replay.value.created, false);
		assert.equal(replay.value.conversationId, created.value.conversationId);
		assert.equal(replay.value.childConversationId, created.value.childConversationId);

		// A delegation whose answer was lost is the same state as any other lost write: the attempt identity finds it.
		const through = createConversationControl({
			conversationId: parentId,
			basePath: hole.origin + "/api/conversations",
			fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: target.cookie } }),
		});
		const lost = await through.delegate({ name: "worker", task: "second task", requestId: "attempt-lost" });
		assert.equal(lost.ok, false, JSON.stringify(lost));
		if (!lost.ok) {
			assert.equal(lost.kind, "unknown");
			assert.equal(lost.requestId, "attempt-lost");
		}
		const found = await control.delegate({ name: "worker", task: "second task", requestId: "attempt-lost" });
		assert.equal(found.ok, true, JSON.stringify(found));
		if (!found.ok) return;
		assert.equal(found.value.created, false, "the retry of a lost delegation created a second child");
		const children = await (await fetch(target.origin + "/api/conversations?createdBy=" + parentId, { headers: { cookie: target.cookie } })).json() as { conversations: { id: string }[] };
		assert.equal(children.conversations.length, 2, JSON.stringify(children.conversations));
	} finally {
		await hole.close();
		await target.close();
	}
});

test("a delegation to an existing conversation keeps that conversation's own identity and gives it one more task", { timeout: 60_000 }, async () => {
	const target = await workspaceFixture("hepi-dispatch-ingress-");
	try {
		const delegatingId = await delegating(target);
		const recipient = await create(target, { workspaceId: "local" });
		const control = client(target, "web", delegatingId);

		// A dispatch names a conversation that already exists, so it creates nothing: the target keeps its id, its
		// history and its own relations, and only one more task is admitted to it.
		const dispatched = await control.delegate({ name: "worker", conversationId: recipient, task: "the next task", requestId: "dispatch-1" });
		assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
		if (!dispatched.ok) return;
		// The answer names the conversation the task is for — the target — and states that this request created nothing,
		// so a caller is never left to read a dispatch as a child it made.
		assert.equal(dispatched.value.conversationId, recipient, "a dispatch addressed a conversation other than the one it named");
		assert.equal(dispatched.value.childConversationId, undefined, "a dispatch reported a child it did not create");
		assert.equal(dispatched.value.created, false);
		assert.equal(dispatched.value.dispatchId, "dispatch-1");
		assert.ok(dispatched.value.submissionId !== undefined, "a dispatch admitted no task");
		const after = await waitForCondition(async () => {
			const current = await state(target, recipient);
			return current.entries.filter(entry => entry.role === "user").length === 1 ? current : undefined;
		}, "the dispatched task to be admitted");
		assert.deepEqual(after.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["the next task"]);
		// The target's relations are its own: being given a task is not being created by, or displayed under, the caller.
		const info = await client(target, "web", recipient).info();
		assert.equal(info.ok, true, JSON.stringify(info));
		if (!info.ok) return;
		assert.equal(info.value.relations.createdBy, undefined);
		assert.equal(info.value.relations.displayParentId, undefined);
		assert.equal(info.value.owner, undefined);
		// Nothing was created: the catalogue is the two conversations the test made.
		const catalogue = await (await fetch(target.origin + "/api/conversations", { headers: { cookie: target.cookie } })).json() as { conversations: { id: string }[] };
		assert.deepEqual(catalogue.conversations.map(row => row.id).sort(), [delegatingId, recipient].sort());

		// The same attempt identity answers the dispatch the first attempt made, and admits no second task.
		const replay = await control.delegate({ name: "worker", conversationId: recipient, task: "the next task", requestId: "dispatch-1" });
		assert.equal(replay.ok, true, JSON.stringify(replay));
		if (!replay.ok) return;
		assert.equal(replay.value.conversationId, recipient);
		assert.equal(replay.value.submissionId, dispatched.value.submissionId, "a replayed dispatch named a different admission");
		assert.equal((await state(target, recipient)).entries.filter(entry => entry.role === "user").length, 1, "a replayed dispatch admitted the task twice");

		// A target that does not exist is refused by name and admits nothing anywhere; a conversation addressing itself
		// is refused for the same reason, because it would make the caller its own delegated child.
		const unknown = await control.delegate({ name: "worker", conversationId: "999999", task: "nowhere", requestId: "dispatch-unknown" });
		assert.equal(unknown.ok, false, JSON.stringify(unknown));
		if (!unknown.ok) {
			assert.equal(unknown.kind, "refused");
			assert.equal(unknown.code, "not_found");
		}
		const self = await control.delegate({ name: "worker", conversationId: delegatingId, task: "myself", requestId: "dispatch-self" });
		assert.equal(self.ok, false, JSON.stringify(self));
		if (!self.ok) {
			assert.equal(self.kind, "refused");
			assert.equal(self.code, "self_dispatch");
		}
		assert.deepEqual((await state(target, recipient)).entries, after.entries, "a refused dispatch admitted a task");
	} finally {
		await target.close();
	}
});

test("a continue while the old stop still drains answers stopping, and the same intent finishes with a new request id", { timeout: 30_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "hepi-control-drain-"));
	directories.push(base);
	const gate: AnswerGate = createAnswerGate();
	const credentials = createDeviceCredentials({ path: join(base, "device-credentials.sqlite") });
	const backend = await createBackendServer({ dbPath: join(base, "hepi.sqlite"), authToken: BACKEND_TOKEN, models: gatedEchoModels(gate), defaultModel: SERVER_MODEL, deviceCredentials: credentials });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const address = backend.server.address();
	assert.ok(address && typeof address === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const target: Fixture = {
		origin: "http://127.0.0.1:" + ingressAddress.port,
		backend,
		ingress,
		cookie: "",
		device: "",
		close: async () => { gate.release(); await ingress.close(); credentials.close(); await backend.close(); },
	};
	try {
		const login = await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: target.origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
		target.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
		const id = await create(target);
		const control = client(target, "web", id);

		// The run is really in flight: the model answer is held, so "the stop still drains" is a state and not a race.
		gate.arm();
		assert.equal((await control.send("run-1", "first")).ok, true);
		await waitForCondition(async () => (await state(target, id)).busy, "the run to reach the model");
		const stopped = await control.stop("stop-1");
		assert.equal(stopped.ok, true, JSON.stringify(stopped));
		if (!stopped.ok) return;
		assert.equal(stopped.value.drain, "stopping");

		// A queue-only steer stays queued under the hold, and the resume that arrives too early admits nothing.
		assert.equal((await control.send("steer-1", "queued while held", { whenBusy: "steer", queueOnly: true })).ok, true);
		const early = await control.continueRun("continue-early");
		assert.equal(early.ok, true, JSON.stringify(early));
		if (!early.ok) return;
		assert.equal(early.value.status, "stopping");
		assert.equal(early.value.control.state, "held");
		assert.equal(early.value.submissionId, undefined, "a resume that has not run admitted an input");

		gate.release();
		await waitForCondition(async () => !(await state(target, id)).busy, "the stopped run to settle");
		const held = await state(target, id);
		assert.deepEqual(held.queuedMessages, { steering: ["queued while held"], followUp: [] }, "the stopped drain consumed the held queue");

		// The retry is a new intent with a new request id, and it consumes exactly the queue that was kept.
		const resumed = await control.continueRun("continue-2");
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		if (!resumed.ok) return;
		assert.equal(resumed.value.status, "resumed");
		assert.equal(resumed.value.control.state, "allowed");
		const settled = await waitForCondition(async () => {
			const current = await state(target, id);
			return !current.busy && current.entries.filter(entry => entry.role === "user").length === 2 ? current : undefined;
		}, "the held queue to be consumed");
		assert.deepEqual(settled.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["first", "queued while held"]);
		assert.deepEqual(settled.queuedMessages, { steering: [], followUp: [] });
	} finally {
		await target.close();
	}
});

test("two clients racing on one hold answer coherently, and the loser's refusal changes nothing", async () => {
	const target = await fixture();
	try {
		const id = await create(target);
		const web = client(target, "web", id);
		const phone = client(target, "device", id);
		// Both read revision 0 and both act on it: one commit wins, the other is refused by the revision it named.
		const [first, second] = await Promise.all([web.stop("stop-web", { expectedControlRevision: 0 }), phone.stop("stop-phone", { expectedControlRevision: 0 })]);
		const accepted = [first, second].filter(answer => answer.ok);
		const refused = [first, second].filter(answer => !answer.ok);
		assert.equal(accepted.length, 1, JSON.stringify([first, second]));
		assert.equal(refused.length, 1, JSON.stringify([first, second]));
		const loser = refused[0]!;
		if (loser.ok) return;
		assert.equal(loser.kind, "refused");
		assert.equal(loser.code, "revision_mismatch");
		// The winner's commit is the one the conversation holds, and the loser left no receipt of its own.
		const winner = accepted[0]!;
		if (!winner.ok) return;
		const current = await state(target, id);
		assert.deepEqual(current.control, winner.value.control);
		assert.equal(current.control.revision, 1);
		// The refusal is a durable answer too: the loser's own request id reads back the refusal it got, and the
		// conversation's revision is the winner's — a refused request never advances it.
		const loserRequestId = winner.value.receipt.requestId === "stop-web" ? "stop-phone" : "stop-web";
		const looked = await web.control(loserRequestId);
		assert.equal(looked.ok, true);
		if (looked.ok) {
			assert.equal(looked.value.receipt?.status, "rejected");
			assert.equal(looked.value.receipt?.reason, "revision_mismatch");
			assert.equal(looked.value.control.revision, winner.value.control.revision);
		}
	} finally {
		await target.close();
	}
});

test("a submitted message whose answer was lost is unknown and is resolved by its request id, never resent", async () => {
	const target = await fixture();
	const hole = await blackHole(target.origin);
	try {
		const id = await create(target);
		const control = client(target, "web", id);
		const through = createConversationControl({
			conversationId: id,
			basePath: hole.origin + "/api/conversations",
			fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: target.cookie } }),
		});
		const lost = await through.send("turn-lost", "the message that was admitted");
		assert.equal(lost.ok, false, JSON.stringify(lost));
		if (!lost.ok) {
			assert.equal(lost.kind, "unknown");
			assert.equal(lost.requestId, "turn-lost");
		}

		// The conversation admitted it: the request id answers the submission, and the transcript carries the message once.
		const lookup = await fetch(target.origin + "/api/conversations/" + id + "/submissions?requestId=turn-lost", { headers: { cookie: target.cookie } });
		assert.equal(lookup.status, 200);
		const found = await lookup.json() as { submission: { submissionId: string; requestId: string; status: string } | null };
		assert.equal(found.submission?.requestId, "turn-lost");
		assert.equal(found.submission?.status, "done");
		const settled = await waitForCondition(async () => {
			const current = await state(target, id);
			return current.entries.filter(entry => entry.role === "user").length === 1 && !current.busy ? current : undefined;
		}, "the admitted turn to settle");
		assert.deepEqual(settled.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["the message that was admitted"]);

		// Asking again is the resolution: the same request id is answered with the same submission, and the text was
		// never sent a second time — the retry below would be the only way to duplicate it, and it is not made here.
		const again = await fetch(target.origin + "/api/conversations/" + id + "/submissions?requestId=turn-lost", { headers: { cookie: target.cookie } });
		assert.deepEqual(await again.json(), found);
	} finally {
		await hole.close();
		await target.close();
	}
});
