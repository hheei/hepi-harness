import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { NAVIGATION_PREVIEW_MAX_BYTES } from "@hepi/protocol/navigation";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { createProjectStore } from "../../../apps/server/src/project-store.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { startGateway, type RunningGateway } from "../src/startup.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress, type ClientIngressSettings } from "../src/ingress/index.ts";

/**
 * The navigation outline at the client ingress: the Backend's own page, relayed to a real caller unchanged.
 *
 * The ingress is the only surface a Web page or an App reaches, so this test asks the outline through it and compares
 * what a caller sees with what the Backend answers for the same conversation and the same query. The point is what the
 * relay does **not** do: it does not re-page, re-order, rename, re-preview or rebuild a coordinate, and it does not
 * invent a reason for a page the contract refused. Ticket 01 states the Backend owns those facts, and a relay that
 * touched one would hand two surfaces two answers.
 *
 * The ordinary case of an admitted caller reaching a route it is allowed to ask, asserted at the route's public seam.
 * No bypass is designed and no authorization boundary is probed here: the credential and CORS rules are the ingress's
 * own tests, held in the suite beside this one.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const workspace = async (): Promise<string> => { const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-navigation-"))); directories.push(directory); return directory; };

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
	readonly backendOrigin: string;
	readonly backend: BackendServer;
	readonly ingress: ClientIngress;
	/** Every request the ingress itself was asked to serve, in order: the fact that says nothing looped back into it. */
	readonly served: string[];
	readonly cookie: string;
	close(): Promise<void>;
};

/**
 * One Backend with one client ingress in front of it and a real execution gateway for its host. `prepare` writes the
 * store before the Backend opens it, so a fixture's history is committed bytes rather than a stand-in for them.
 */
async function fixture(prepare: (dbPath: string) => Promise<void>): Promise<Fixture> {
	const root = await workspace();
	await mkdir(join(root, "project"), { recursive: true });
	const gateway = await executionGateway("workstation", join(root, "project"));
	const credentials = createDeviceCredentials({ path: join(root, "device-credentials.sqlite") });
	const projects = createProjectStore({ path: join(root, "projects.sqlite") });
	const dbPath = join(root, "hepi.sqlite");
	await prepare(dbPath);
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
		gateways: [{ gatewayId: "workstation", gatewayOrigin: gateway.origin, gatewayToken: GATEWAY_TOKEN }],
		workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin: gateway.origin, gatewayToken: GATEWAY_TOKEN }],
	});
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const settings: ClientIngressSettings = {
		backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
		webLoginToken: WEB_LOGIN,
		defaultHostId: "workstation",
	};
	const ingress = createClientIngress(settings);
	const served: string[] = [];
	ingress.server.on("request", request => { served.push((request.method ?? "GET") + " " + (request.url ?? "/")); });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
	served.length = 0;
	return {
		origin,
		backendOrigin: "http://127.0.0.1:" + backendAddress.port,
		backend,
		ingress,
		served,
		cookie,
		close: async () => { await ingress.close(); await gateway.close(); credentials.close(); projects.close(); await backend.close(); },
	};
}

/**
 * A conversation whose committed history is the ordinary shape of an agent session: three user prompts with tool and
 * assistant traffic between them, so a page's anchors are fewer than the entries it scanned. The second prompt is long
 * enough that its preview has to be capped, which is the fact a relay must not change.
 */
async function seededConversation(dbPath: string): Promise<string> {
	const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
	const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const id = created.id as ConversationId;
	for (let turn = 1; turn <= 3; turn += 1) {
		await harness.harness.commit(async (tx) => {
			await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: turn === 2 ? "a prompt with   squeezed   spacing and " + "a long tail ".repeat(60) : "prompt " + turn, timestamp: 0 }] });
			await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-" + turn, toolName: "read", content: [{ type: "text", text: "tool traffic " + turn }], isError: false, timestamp: turn }], data: { diagnostics: [] } });
			await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage("answer " + turn)] });
		}, BACKGROUND_CONTEXT);
	}
	await harness.close();
	return String(id);
}

/**
 * The same conversation plus a fourth prompt whose text block is past the projection's deferral threshold. This is
 * the shape a window has to carry: a heavy committed block arrives as a preview naming its own read block, and a
 * relay that must not touch it is the thing under test.
 */
async function seededConversationWithHeavyPrompt(dbPath: string): Promise<string> {
  const id = await seededConversation(dbPath);
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  await harness.harness.commit(tx => tx.appendEntry(UserEntry, Number(id) as ConversationId, { model: [{ role: "user", content: [{ type: "text", text: "z".repeat(80 * 1024) }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  await harness.close();
  return id;
}

/** One outline page, read from either entrance. */
async function page(origin: string, id: string, query: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
	const response = await fetch(origin + "/api/conversations/" + id + "/navigation" + query, { headers });
	const text = await response.text();
	return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

type Anchor = { anchor: string; entryId: string; cursor: number; preview: string };
const anchorsOf = (body: Record<string, unknown>): Anchor[] => body.anchors as Anchor[];

test("the ingress relays the Backend's outline unchanged: cursor, snapshot identity and previews arrive verbatim", { timeout: 40000 }, async (t: TestContext) => {
	let id = "";
	const target = await fixture(async (dbPath) => { id = await seededConversation(dbPath); });
	t.after(() => target.close());
	const caller = { cookie: target.cookie };
	const service = { authorization: "Bearer " + BACKEND_TOKEN };

	const first = await page(target.origin, id, "?limit=2", caller);
	assert.equal(first.status, 200, first.text);
	// The Backend's own bytes for the same read: the same coordinates, ordering cursors, snapshot and scope tokens,
	// capped previews, page size and stated byte count. A relay that re-derived any of them differs here.
	const direct = await page(target.backendOrigin, id, "?limit=2", service);
	assert.equal(direct.status, 200, direct.text);
	assert.equal(first.text, direct.text, "the ingress rewrote the Backend's outline answer");
	assert.deepEqual(anchorsOf(first.body).map(anchor => anchor.entryId), anchorsOf(direct.body).map(anchor => anchor.entryId));
	assert.equal(anchorsOf(first.body).length, 2, JSON.stringify(anchorsOf(first.body).map(anchor => anchor.preview)));
	assert.equal(anchorsOf(first.body)[0]!.preview, "prompt 1");
	assert.equal(anchorsOf(first.body)[1]!.preview.startsWith("a prompt with squeezed spacing and a long tail"), true, "whitespace is collapsed once, by the Backend");
	assert.equal(Buffer.byteLength(anchorsOf(first.body)[1]!.preview, "utf8"), NAVIGATION_PREVIEW_MAX_BYTES, "the contract's cap bounds the preview, and the relay leaves the cut alone");
	assert.equal(first.body.hasMore, true);
	assert.equal(first.body.snapshot, direct.body.snapshot);
	assert.equal(first.body.scope, direct.body.scope);
	const cursor = first.body.nextCursor as number;
	assert.equal(typeof cursor, "number", "a page that says more exists hands the caller the cursor that reaches it");

	// A continuation asked with the relayed cursor is the same anchor the Backend answers with it: the relay serves
	// more than a first page, and what sits between the anchors is the traffic the outline does not enumerate.
	const next = await page(target.origin, id, "?limit=2&cursor=" + cursor, caller);
	const nextDirect = await page(target.backendOrigin, id, "?limit=2&cursor=" + cursor, service);
	assert.equal(next.text, nextDirect.text);
	assert.equal(anchorsOf(next.body).length, 1, "the traffic between anchors is passed over, not invented into a node");
	assert.equal(anchorsOf(next.body)[0]!.preview, "prompt 3");
	assert.equal(next.body.hasMore, false);
	assert.equal(next.body.nextCursor, undefined, "a relayed page that reached the end states no continuation");
	assert.equal(next.body.prefix, undefined, "a relayed continuation gains no prefix the Backend did not state");

	// The Backend's named refusal, with its status: the relay does not answer a page the contract refused.
	const refused = await page(target.origin, id, "?limit=0", caller);
	assert.equal(refused.status, 400);
	assert.equal(refused.body.code, "malformed");

	// Exactly the requests the caller made, forwarded as written: no fan-out, no re-pagination, no second owner.
	assert.deepEqual(target.served, [
		"GET /api/conversations/" + id + "/navigation?limit=2",
		"GET /api/conversations/" + id + "/navigation?limit=2&cursor=" + cursor,
		"GET /api/conversations/" + id + "/navigation?limit=0",
	]);
});

/** One target window, read from either entrance. */
async function windowAround(origin: string, id: string, query: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
	const response = await fetch(origin + "/api/conversations/" + id + "/navigation/around" + query, { headers });
	const text = await response.text();
	return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

type WindowEntry = { id: string; role: string; text: string; message: unknown };
const entriesOf = (body: Record<string, unknown>): WindowEntry[] => body.entries as WindowEntry[];

test("the ingress relays a target window unchanged: identity, target, entries and block URLs arrive verbatim", { timeout: 40000 }, async (t: TestContext) => {
	let id = "";
	const target2 = await fixture(async (dbPath) => { id = await seededConversationWithHeavyPrompt(dbPath); });
	t.after(() => target2.close());
	const caller = { cookie: target2.cookie };
	const service = { authorization: "Bearer " + BACKEND_TOKEN };

	const outlinePage = await page(target2.origin, id, "?limit=4", caller);
	// The jump the rail makes: a middle anchor, so the window has committed history on both sides of it.
	const middle = anchorsOf(outlinePage.body)[2]!;
	const query = "?anchor=" + encodeURIComponent(middle.anchor) + "&before=2&after=2";
	const heavyQuery = "?anchor=" + encodeURIComponent(anchorsOf(outlinePage.body)[3]!.anchor) + "&before=2&after=0";

	// The Backend's own bytes for the same window: the target identity it resolved, the entries it projected, and the
	// size it stated. A relay that re-paged, re-ordered or re-projected any of them differs here.
	const relayed = await windowAround(target2.origin, id, query, caller);
	const direct = await windowAround(target2.backendOrigin, id, query, service);
	assert.equal(relayed.status, 200, relayed.text);
	assert.equal(relayed.text, direct.text, "the ingress rewrote the Backend's target window");
	assert.equal(relayed.body.snapshot, direct.body.snapshot, "the snapshot identity travels as the Backend stated it");
	assert.equal(relayed.body.scope, direct.body.scope);
	assert.deepEqual((relayed.body.target as Record<string, unknown>).anchor, middle.anchor, "the coordinate the caller jumped with is the one the window names back");
	assert.deepEqual(entriesOf(relayed.body).map(entry => entry.id), entriesOf(direct.body).map(entry => entry.id), "native history order, decided once by the Backend");
	assert.equal(relayed.body.bytes, Buffer.byteLength(relayed.text, "utf8"), "the size a caller measures is the size the Backend stated, through the relay");
	assert.equal(relayed.body.hasOlder, true);
	assert.equal(relayed.body.olderCursor, Number(entriesOf(relayed.body)[0]!.id));

	// A heavy block arrives as the deferred shape with its read-block URL untouched, because the relay rewrites no
	// response body: the URL is the Backend's own `/api/sessions/…` spelling, and the caller that follows it is
	// answered by the entry-block route this listener already maps. Asserted against the Backend's bytes above, and
	// here as the string itself, so a relay that "helpfully" re-pathed a block URL would be named.
	const heavyWindow = await windowAround(target2.origin, id, heavyQuery, caller);
	const heavyDirect = await windowAround(target2.backendOrigin, id, heavyQuery, service);
	assert.equal(heavyWindow.status, 200, heavyWindow.text);
	const heavy = entriesOf(heavyWindow.body).find(entry => JSON.stringify(entry.message).includes("textUrl"));
	assert.equal(heavy === undefined, false, "the window carries the conversation's heavy prompt: " + JSON.stringify(entriesOf(heavyWindow.body).map(entry => entry.id)));
	assert.match(JSON.stringify(heavy!.message), /"textUrl":"\/api\/sessions\//, "a deferred block travels with the URL the Backend wrote");
	assert.equal(JSON.stringify(heavy!.message), JSON.stringify((entriesOf(heavyDirect.body).find(entry => JSON.stringify(entry.message).includes("textUrl")) ?? { message: null }).message), "and it is byte-for-byte the Backend's own");

	// The Backend's named refusal, status and all: the relay does not invent an answer for a window it cannot serve.
	const refused = await windowAround(target2.origin, id, "?before=1", caller);
	assert.equal(refused.status, 400);
	assert.equal(refused.body.code, "malformed");

	// Exactly the requests the caller made, forwarded as written: one jump is one window request, with no fan-out over
	// the preceding pages and no second owner of the history a window reads.
	assert.deepEqual(target2.served, [
		"GET /api/conversations/" + id + "/navigation?limit=4",
		"GET /api/conversations/" + id + "/navigation/around" + query,
		"GET /api/conversations/" + id + "/navigation/around" + heavyQuery,
		"GET /api/conversations/" + id + "/navigation/around?before=1",
	]);
});
