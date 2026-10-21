import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { streamFolder, type HeldWindow } from "../../../apps/server/test/stream-window.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { createProjectStore, type ProjectStore } from "../../../apps/server/src/project-store.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { startGateway, type RunningGateway } from "../src/startup.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress, type ClientIngressSettings } from "../src/ingress/index.ts";

/**
 * The conversation slice at the client ingress: a real caller reads a conversation, submits input and keeps receiving
 * the Backend's own facts over `/api`, with a real execution gateway on the other side of the Backend.
 *
 * Everything asserted here is what a browser or an App sees: real HTTP, real SSE bytes, the Backend's own durable
 * records, and a real gateway process for the host the Backend reaches. The ingress is the only surface the caller
 * touches, so the tests below cannot pass by reaching around it.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const workspace = async (): Promise<string> => { const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-chat-"))); directories.push(directory); return directory; };

const BACKEND_TOKEN = "backend-service-token";
const GATEWAY_TOKEN = "execution-token";
const WEB_LOGIN = "web-login-material";

/** One execution gateway on loopback, rooted at a directory this test owns. */
async function executionGateway(gatewayId: string, root: string): Promise<RunningGateway> {
	await mkdir(join(root, ".gateway"), { recursive: true });
	return await startGateway({ mode: "local", gatewayId, token: GATEWAY_TOKEN, workspaceId: "local", workspaceRoot: root, allowedCommands: [], port: 0, databasePath: join(root, ".gateway", "calls.sqlite") });
}

type Fixture = {
	readonly origin: string;
	readonly backend: BackendServer;
	readonly ingress: ClientIngress;
	/** Every request the ingress itself was asked to serve, in order: the fact that says nothing looped back into it. */
	readonly served: string[];
	/** The Backend streams still attached upstream, counted on the Backend's own server, not inside the ingress. */
	upstreamOpen(): number;
	readonly cookie: string;
	readonly projects: ProjectStore;
	close(): Promise<void>;
};

/**
 * One Backend, one client ingress in front of it, and — when the test asks for it — a real execution gateway the Backend
 * reaches. `hosts` names the gateways the Backend may route to; `defaultHostId` is the host this ingress states as the
 * caller's own, which is configuration and never anything a client sent.
 */
async function fixture(options: { hosts?: readonly { gatewayId: string; gatewayOrigin: string; workspaceId?: string }[]; defaultHostId?: string; heartbeatIntervalMs?: number; prepare?: (dbPath: string) => Promise<void> } = {}): Promise<Fixture> {
	const directory = await workspace();
	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const projects = createProjectStore({ path: join(directory, "projects.sqlite") });
	const dbPath = join(directory, "hepi.sqlite");
	await options.prepare?.(dbPath);
	const backend = await createBackendServer({
		dbPath,
		authToken: BACKEND_TOKEN,
		models: fauxModels(),
		defaultModel: SERVER_MODEL,
		deviceCredentials: credentials,
		projects,
		buildId: "build-1",
		backendId: "backend-1",
		accountScope: "account-1",
		...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
		...(options.hosts === undefined ? {} : {
			gateways: options.hosts.map(host => ({ gatewayId: host.gatewayId, gatewayOrigin: host.gatewayOrigin, gatewayToken: GATEWAY_TOKEN })),
			workspaces: options.hosts.map(host => ({ id: host.workspaceId ?? "local", gatewayId: host.gatewayId, gatewayOrigin: host.gatewayOrigin, gatewayToken: GATEWAY_TOKEN })),
		}),
	});
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const settings: ClientIngressSettings = {
		backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
		webLoginToken: WEB_LOGIN,
		...(options.defaultHostId === undefined ? {} : { defaultHostId: options.defaultHostId }),
	};
	const ingress = createClientIngress(settings);
	const served: string[] = [];
	ingress.server.on("request", request => { served.push((request.method ?? "GET") + " " + (request.url ?? "/")); });
	let upstreamStreams = 0;
	backend.server.on("request", (request, response) => {
		if (!(request.url ?? "").includes("/events")) return;
		upstreamStreams += 1;
		response.on("close", () => { upstreamStreams -= 1; });
	});
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const header = login.headers.get("set-cookie") ?? "";
	const cookie = header.split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
	served.length = 0;
	return {
		origin,
		backend,
		ingress,
		served,
		upstreamOpen: () => upstreamStreams,
		cookie,
		projects,
		close: async () => { await ingress.close(); credentials.close(); projects.close(); await backend.close(); },
	};
}

test("the Backend reaches the internal execution listener, and the ingress is never the host it routes through", async (t: TestContext) => {
	const root = await workspace();
	await mkdir(join(root, "project"), { recursive: true });
	const gateway = await executionGateway("workstation", join(root, "project"));
	t.after(() => gateway.close());
	const target = await fixture({ hosts: [{ gatewayId: "workstation", gatewayOrigin: gateway.origin }], defaultHostId: "workstation" });
	t.after(() => target.close());
	const listed = await fetch(target.origin + "/api/workspaces", { headers: { cookie: target.cookie } });
	assert.equal(listed.status, 200);
	const body = await listed.json() as { workspaces: { id: string; gatewayId: string; host?: { user: string; home: string }; workspaceRoot?: string; hostError?: string }[] };
	assert.deepEqual(body.workspaces.map(workspace => [workspace.id, workspace.gatewayId, workspace.hostError ?? null]), [["local", "workstation", null]], "the Backend did not answer with the execution host's own facts");
	assert.equal(body.workspaces[0]!.workspaceRoot, join(root, "project"));
	assert.ok((body.workspaces[0]!.host?.home ?? "").length > 0);
	assert.deepEqual(target.served, ["GET /api/workspaces"], "the ingress served something other than the one client request");

	// The listener the Backend reached is the internal one: it accepts the execution credential and nothing a client
	// holds. The same route the Backend called is refused to the client's own cookie and to the ingress's service
	// credential, which is what keeps the two directions of this deployment from being interchangeable.
	const internal = await fetch(gateway.origin + "/v1/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
	assert.equal(internal.status, 401);
	const withCookie = await fetch(gateway.origin + "/v1/workspaces", { method: "POST", headers: { cookie: target.cookie, "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
	assert.equal(withCookie.status, 401, "a client cookie reached the execution listener");
	const withService = await fetch(gateway.origin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer " + BACKEND_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
	assert.equal(withService.status, 401, "the ingress service credential reached the execution listener");
	const withExecution = await fetch(gateway.origin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer " + GATEWAY_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
	assert.equal(withExecution.status, 200, "the execution credential the Backend holds did not reach the listener");
});

test("the ingress states the host this origin serves, and a client cannot state another", async (t: TestContext) => {
	const root = await workspace();
	await mkdir(join(root, "near"), { recursive: true });
	await mkdir(join(root, "far"), { recursive: true });
	const near = await executionGateway("workstation", join(root, "near"));
	t.after(() => near.close());
	const far = await executionGateway("elsewhere", join(root, "far"));
	t.after(() => far.close());
	const target = await fixture({
		hosts: [{ gatewayId: "workstation", gatewayOrigin: near.origin }, { gatewayId: "elsewhere", gatewayOrigin: far.origin }],
		defaultHostId: "workstation",
	});
	t.after(() => target.close());
	// A host-scoped read a browser makes without naming a host is answered: the host is the ingress's own configuration,
	// so the page needs no knowledge of which gateway serves it.
	const browsed = await fetch(target.origin + "/api/host/directories", { headers: { cookie: target.cookie } });
	assert.equal(browsed.status, 200);
	// No path named, so the host answers with its own execution account's home: the fact the test compares against is
	// the one the host reports, not a path this checkout happens to live under.
	assert.equal((await browsed.json() as { path: string }).path, await realpath(homedir()));
	// A project recorded on the other host is reported as belonging to that host, which is what a caller served from
	// this origin sees. A client that sends its own default-host header is answered for this origin's host instead of
	// the one it named, because which computer a caller is served from is the deployment's fact and not a request's.
	const created = await fetch(target.origin + "/api/projects", { method: "POST", headers: { cookie: target.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "far project", hostId: "elsewhere", folders: [{ root: join(root, "far"), default: true }] }) });
	assert.equal(created.status, 201, await created.text());
	const listed = await fetch(target.origin + "/api/projects", { headers: { cookie: target.cookie, "x-hepi-default-host": "elsewhere" } });
	assert.equal(listed.status, 200);
	const projects = (await listed.json() as { projects: { name: string; hostError?: string }[] }).projects;
	assert.equal(projects.length, 1);
	assert.match(projects[0]!.hostError ?? "", /elsewhere/, "a client-stated host replaced the ingress's own");
	// Nothing the Backend did came back through the ingress: the execution host is the gateway the Backend was
	// configured with, and this listener served only the requests the client made of it.
	assert.deepEqual(target.served.filter(entry => entry.includes("/v1/")), [], "an internal execution route reached the client listener");
	assert.deepEqual(target.served, [
		"GET /api/host/directories",
		"POST /api/projects",
		"GET /api/projects",
	]);
});

test("a deployment that states no default host answers the Backend's own configuration refusal", async (t: TestContext) => {
	const target = await fixture();
	t.after(() => target.close());
	const browsed = await fetch(target.origin + "/api/host/directories", { headers: { cookie: target.cookie } });
	assert.equal(browsed.status, 409);
	assert.equal((await browsed.json() as { code: string }).code, "configuration_required");
});

/**
 * A conversation whose newest entry carries content no deferral policy can shrink: a structured tool call with a
 * multi-megabyte input. The window shrinks until only that entry remains, and the entry itself is never split.
 */
async function oversizedConversation(dbPath: string): Promise<{ id: string; entryId: string }> {
	const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
	const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const id = created.id as ConversationId;
	await harness.harness.commit(async (tx) => {
		await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "run the build", timestamp: 0 }] });
		await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/build.log", content: "build log line: ".repeat(110_000) }), { timestamp: 1 })] });
	}, BACKGROUND_CONTEXT);
	const entryId = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: id }, 1, undefined), BACKGROUND_CONTEXT)).items[0]!.id;
	await harness.close();
	return { id: String(id), entryId: String(entryId) };
}

/**
 * One conversation stream as a caller reads it: the frames in arrival order, the bytes exactly as the wire delivered
 * them, and the window those frames build when folded by the **shared reducer a real client uses**.
 */
type Stream = {
	/** The next frame whose name matches, in order, without skipping over a later one. */
	next(name: string): Promise<{ event: string; data: string }>;
	/** The window as the frames received so far state it, folded by `@hepi/session`'s own reducer. */
	window(): HeldWindow<{ role: string; text?: string }>;
	/** The raw bytes received so far, exactly as the wire delivered them. */
	raw(): string;
	/** Cancel the caller's read, the way a browser tab closing does. */
	cancel(): Promise<void>;
};

async function openStream(origin: string, id: string, headers: Record<string, string>, query = ""): Promise<Stream> {
	const response = await fetch(origin + "/api/conversations/" + id + "/events" + query, { headers, signal: AbortSignal.timeout(15000) });
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	let pending = "";
	const frames: { event: string; data: string }[] = [];
	const folder = streamFolder<{ role: string; text?: string }>(id);
	// The caller reads as the bytes arrive, in the background: that is what a browser does, and it is the only way a
	// keepalive or an incremental frame can be observed before the stream ends.
	let arrived: (() => void) | null = null;
	let ended = false;
	const pump = async (): Promise<void> => {
		for (;;) {
			const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
			if (chunk.done) { ended = true; arrived?.(); return; }
			const text = decoder.decode(chunk.value, { stream: true });
			raw += text;
			pending += text;
			let boundary: number;
			while ((boundary = pending.indexOf("\n\n")) >= 0) {
				const frame = pending.slice(0, boundary);
				pending = pending.slice(boundary + 2);
				const event = /^event: (.*)$/m.exec(frame)?.[1];
				const line = frame.split("\n").find(value => value.startsWith("data: "));
				if (event === undefined || line === undefined) continue;
				const data = line.slice(6);
				if (event === "snapshot" || event === "state") folder.fold(event, JSON.parse(data));
				frames.push({ event, data });
			}
			arrived?.();
		}
	};
	void pump();
	return {
		raw: () => raw,
		window: () => folder.current(),
		async next(name) {
			for (;;) {
				const found = frames.findIndex(frame => frame.event === name);
				if (found >= 0) return frames.splice(found, 1)[0]!;
				if (ended) throw new Error("the stream ended before a " + name + " frame arrived");
				await new Promise<void>(resolve => { arrived = resolve; });
			}
		},
		async cancel() { await reader.cancel().catch(() => undefined); },
	};
}

test("a caller reads, creates, sends and follows one conversation through the ingress, in the Backend's own frames", { timeout: 30000 }, async (t: TestContext) => {
	const target = await fixture();
	t.after(() => target.close());
	const headers = { cookie: target.cookie, "content-type": "application/json" };

	// Creating a conversation through the ingress answers the Backend's own row and identity.
	const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId: "create-1" }) });
	assert.equal(created.status, 201);
	const row = await created.json() as { protocol: string; conversationId: string; conversation: { id: string; revision: number } };
	assert.equal(row.protocol, "hepi.v1");
	assert.equal(row.conversation.id, row.conversationId);
	const id = row.conversationId;

	// Reading it back is the same durable fact, not a second projection.
	const read = await fetch(target.origin + "/api/conversations/" + id, { headers });
	assert.equal(read.status, 200);
	assert.equal((await read.json() as { conversation: { id: string } }).conversation.id, id);

	// The stream's baseline is the native `snapshot` frame, carrying the window the HTTP read answers.
	const stream = await openStream(target.origin, id, headers);
	t.after(() => stream.cancel());
	const snapshot = JSON.parse((await stream.next("snapshot")).data) as { conversationId: string; protocol: string; revision: number; entries: unknown[]; projectionId: string };
	assert.equal(snapshot.conversationId, id);
	assert.equal(snapshot.protocol, "hepi.v1");
	assert.deepEqual(snapshot.entries, []);
	assert.ok(snapshot.projectionId.length > 0, "the snapshot did not state the projection identity");

	// A submission is admitted by the Backend and its lifecycle arrives on the same stream.
	const submitted = await fetch(target.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId: id, requestId: "req-1", text: "hello through the ingress" }) });
	assert.equal(submitted.status, 202);
	const admitted = await submitted.json() as { requestId: string; submissionId: string; control: unknown };
	assert.equal(admitted.requestId, "req-1");
	assert.ok(admitted.submissionId.length > 0);

	const lifecycle = JSON.parse((await stream.next("submission")).data) as { requestId: string; status: string; conversationId: string };
	assert.equal(lifecycle.requestId, "req-1");
	assert.equal(lifecycle.conversationId, id);

	// The turn settles into the same durable transcript the state read answers.
	for (;;) {
		await stream.next("state");
		const held = stream.window();
		if (!held.busy && held.entries.length >= 2) break;
	}
	assert.deepEqual(stream.window().entries.map(entry => entry.role), ["user", "assistant"]);
	const state = await fetch(target.origin + "/api/conversations/" + id + "/state", { headers });
	assert.equal(state.status, 200);
	const snapshotOfState = await state.json() as { entries: { role: string; text?: string }[]; busy: boolean };
	assert.deepEqual(snapshotOfState.entries.map(entry => entry.text), ["hello through the ingress", "Server reply to: hello through the ingress"]);
	assert.equal(snapshotOfState.busy, false);

	// A resync request against a revision the caller no longer holds is answered with the named marker, not silently.
	const resync = await openStream(target.origin, id, headers, "?after=1");
	t.after(() => resync.cancel());
	await resync.next("snapshot");
	const marker = JSON.parse((await resync.next("resync_required")).data) as { conversationId: string; revision: number };
	assert.equal(marker.conversationId, id);
	assert.ok(marker.revision > 1);
});

test("a stream whose baseline cannot be carried states state_oversize instead of a frame no client can hold", { timeout: 20000 }, async (t: TestContext) => {
	const prepared: { id?: string } = {};
	const target = await fixture({ prepare: async (dbPath) => { prepared.id = (await oversizedConversation(dbPath)).id; } });
	t.after(() => target.close());
	const headers = { cookie: target.cookie };
	const id = prepared.id!;
	const stream = await openStream(target.origin, id, headers);
	t.after(() => stream.cancel());
	const oversize = JSON.parse((await stream.next("state_oversize")).data) as { reason: string; conversationId: string; entryId: string | null; bytes: number | null };
	assert.equal(oversize.reason, "frame_too_large");
	assert.equal(oversize.conversationId, id);
	assert.ok((oversize.bytes ?? 0) > 0);
	// The same refusal reaches the HTTP read, in the Backend's own shape, so a caller without a stream is told why.
	const state = await fetch(target.origin + "/api/conversations/" + id + "/state", { headers });
	assert.equal(state.status, 413);
	const refused = await state.json() as { reason: string; conversationId: string };
	assert.equal(refused.reason, "frame_too_large");
	assert.equal(refused.conversationId, id);
});

test("a submission whose answer the caller never read is settled by its requestId, not sent again", { timeout: 30000 }, async (t: TestContext) => {
	const target = await fixture();
	t.after(() => target.close());
	const headers = { cookie: target.cookie, "content-type": "application/json" };
	const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId: "create-lost" }) });
	assert.equal(created.status, 201);
	const id = (await created.json() as { conversationId: string }).conversationId;

	// The write is admitted and its answer is dropped on the floor: the caller's connection ends without reading the
	// body, which is exactly what a lost answer is. The Backend's admission already happened, so this is the unknown
	// outcome the requestId exists for.
	const lost = await fetch(target.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId: id, requestId: "req-lost", text: "sent once" }) });
	assert.equal(lost.status, 202);
	await lost.body?.cancel();

	// The lookup is the durable record itself, so the caller learns what happened without re-sending anything.
	const found = await fetch(target.origin + "/api/conversations/" + id + "/submissions?requestId=req-lost", { headers });
	assert.equal(found.status, 200);
	const record = (await found.json() as { submission: { requestId: string; submissionId: string; status: string } | null }).submission;
	assert.ok(record !== null, "the requestId the caller generated was not found after a lost answer");
	assert.equal(record.requestId, "req-lost");
	assert.ok(record.submissionId.length > 0);

	// Repeating the same request id converges on that one submission instead of placing a second turn.
	const repeated = await fetch(target.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId: id, requestId: "req-lost", text: "sent once" }) });
	assert.equal(repeated.status, 202);
	assert.equal((await repeated.json() as { submissionId: string }).submissionId, record.submissionId, "the retry created a second submission");

	// One conversation and one user entry: nothing was duplicated by the recovery.
	for (;;) {
		const state = await (await fetch(target.origin + "/api/conversations/" + id + "/state", { headers })).json() as { busy: boolean; entries: { role: string; text?: string }[] };
		if (state.busy || state.entries.length < 2) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
		assert.deepEqual(state.entries.map(entry => entry.text), ["sent once", "Server reply to: sent once"], "the recovery duplicated or lost the turn");
		break;
	}
	const catalogue = await (await fetch(target.origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] };
	assert.deepEqual(catalogue.conversations.map(entry => entry.id), [id], "a lost answer created a second conversation");
	// Creating with the same request id is the same conversation, which is what makes a lost creation answerable too.
	const again = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId: "create-lost" }) });
	assert.equal(again.status, 201);
	assert.equal((await again.json() as { conversationId: string }).conversationId, id);
});

test("the stream reaches the caller as it is written, with its own status, headers, heartbeat and disconnect", { timeout: 30000 }, async (t: TestContext) => {
	const target = await fixture({ heartbeatIntervalMs: 40 });
	t.after(() => target.close());
	const headers = { cookie: target.cookie, "content-type": "application/json" };
	const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId: "stream-1" }) });
	const id = (await created.json() as { conversationId: string }).conversationId;

	// What the Backend writes for this conversation, read from the Backend itself: the ingress must hand a caller the
	// same bytes, so a frame is never decoded and re-encoded on the way through.
	const direct = await fetch("http://127.0.0.1:" + (target.backend.server.address() as { port: number }).port + "/api/conversations/" + id + "/events", { headers: { authorization: "Bearer " + BACKEND_TOKEN, "content-type": "application/json", "x-hepi-client": JSON.stringify({ kind: "web" }) } });
	assert.equal(direct.status, 200);
	const directFrame = await firstFrame(direct.body!);

	const stream = await openStream(target.origin, id, headers);
	t.after(() => stream.cancel());
	// Status and headers are the Backend's own answer, carried rather than replaced.
	const response = await fetch(target.origin + "/api/conversations/" + id + "/events", { headers });
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.equal(response.headers.get("cache-control"), "no-cache");
	await response.body?.cancel();

	// The baseline frame is byte-for-byte what the Backend wrote: same event line, same JSON spelling, same separators.
	const frame = await stream.next("snapshot");
	assert.equal("event: snapshot\ndata: " + frame.data + "\n\n", directFrame, "the ingress did not pass the frame through unchanged");
	assert.doesNotMatch(stream.raw(), /\r\n/, "the ingress rewrote the frame's line endings");

	// A frame arrives while the turn is still in flight, so the stream is not collected and delivered at the end.
	assert.equal((await fetch(target.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId: id, requestId: "stream-req", text: "incremental" }) })).status, 202);
	const lifecycle = await stream.next("submission");
	assert.match(lifecycle.data, /"requestId":"stream-req"/);
	// It arrived while the turn was still running: the answer had not been committed yet, so this frame was written and
	// forwarded as the turn happened rather than collected and delivered at the end.
	assert.ok(!stream.window().entries.some(entry => entry.role === "assistant"), "the lifecycle frame arrived only after the turn had settled");

	// The keepalive comment frame the Backend writes on an idle stream survives the ingress: a decoding hop would have
	// dropped it as "not an event", and an idle connection through this listener would then be torn down by its own hop.
	await waitFor(() => stream.raw().includes(":\n\n"), "the keepalive comment frame did not reach the caller");
	await stream.cancel();
});

test("a caller that goes away ends the Backend's stream, so the ingress holds nothing open behind it", { timeout: 30000 }, async (t: TestContext) => {
	const root = await workspace();
	await mkdir(join(root, "project"), { recursive: true });
	const gateway = await executionGateway("workstation", join(root, "project"));
	t.after(() => gateway.close());
	const target = await fixture({ hosts: [{ gatewayId: "workstation", gatewayOrigin: gateway.origin }], defaultHostId: "workstation" });
	t.after(() => target.close());
	const headers = { cookie: target.cookie, "content-type": "application/json" };
	const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId: "cancel-1" }) });
	const id = (await created.json() as { conversationId: string }).conversationId;

	const stream = await openStream(target.origin, id, headers);
	await stream.next("snapshot");
	assert.equal(target.upstreamOpen(), 1, "the ingress did not open exactly one upstream stream");
	await stream.cancel();
	// Cancellation is not only local: the connection the ingress opened to the Backend ends with the caller's read, so
	// no attached stream outlives the client that asked for it.
	await waitFor(() => target.upstreamOpen() === 0, "the ingress kept the Backend's stream open after its caller left");
	// The conversation itself is untouched, and the next caller reads it normally.
	const again = await openStream(target.origin, id, headers);
	t.after(() => again.cancel());
	assert.equal((JSON.parse((await again.next("snapshot")).data) as { conversationId: string }).conversationId, id);
});

/** The first complete frame a stream wrote, exactly as its bytes were. */
async function firstFrame(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error("the stream ended before a frame was written");
		pending += decoder.decode(chunk.value, { stream: true });
		const boundary = pending.indexOf("\n\n");
		if (boundary >= 0) { await reader.cancel(); return pending.slice(0, boundary + 2); }
	}
}

/** A barrier for a fact that arrives on its own: it polls the caller's own observation, never the implementation. */
async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(message);
}
