import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createBackendServer } from "../../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../../apps/server/src/device-credentials.ts";
import { createAnswerGate, fauxModels, gatedEchoModels, SERVER_MODEL } from "../../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE } from "../../../../packages/gateway/src/ingress/index.ts";
import { bearerSource } from "../../../../packages/session/src/browser.ts";

// The workbench's own modules are read the way both hosts read them: through the bundler-style resolution their
// extension-less relative imports were extracted with.
const jiti = createJiti(import.meta.url);
const { createClient } = await jiti.import("../client.ts");
const { createConversationApi, createRequestId } = await jiti.import("./conversation-api.ts");

/**
 * The shared workbench's conversation API at the seam a caller really crosses: real HTTP through the client ingress to
 * a real Backend.
 *
 * The modules under test are the ones the Web page and the App both run — `createClient` and `createConversationApi` —
 * so these cases cannot pass by reaching around them. What they hold is the cutover this ticket makes: the workbench
 * asks the Backend's own `/api/conversations…` vocabulary, under a device bearer, and every one of those answers is a
 * real Backend answer rather than a 404 from a vocabulary only the retired Next BFF ever served.
 *
 * The first case states the failure this ticket exists for, and it is kept as a live assertion because the ingress
 * still forwards `/api/sessions…` and `/api/agent…` unchanged: as long as that is true, a caller on the old vocabulary
 * is answered 404 by the Backend, and the cases below are what prove the workbench no longer asks.
 */

const directories = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const BACKEND_TOKEN = "backend-service-token";
const WEB_LOGIN = "web-login-material";

/** One real Backend, one client ingress in front of it, and one credential of each kind. */
async function fixture(models = fauxModels()) {
  const directory = await mkdtemp(join(tmpdir(), "hepi-workbench-conversation-"));
  directories.push(directory);
  const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
  const backend = await createBackendServer({ dbPath: join(directory, "hepi.sqlite"), authToken: BACKEND_TOKEN, models, defaultModel: SERVER_MODEL, deviceCredentials: credentials, buildId: "build-1", backendId: "backend-1", accountScope: "account-1" });
  await new Promise(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address && typeof address === "object");
  const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN, appOrigins: ["http://app.example"] });
  const served = [];
  // Whether the poll asked for the compact answer: the flag is only visible in the query the caller sent.
  const polled = { compact: false };
  ingress.server.on("request", request => {
    served.push((request.method ?? "GET") + " " + (request.url ?? "/").split("?")[0]);
    if ((request.url ?? "").includes("running=compact")) polled.compact = true;
  });
  await new Promise(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress && typeof ingressAddress === "object");
  const origin = "http://127.0.0.1:" + ingressAddress.port;
  const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
  const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
  assert.equal(issued.status, 201);
  const device = (await issued.json()).token;
  served.length = 0;
  return { origin, backend, ingress, served, polled, cookie, device, close: async () => { await ingress.close(); credentials.close(); await backend.close(); } };
}

/** The App's connection: a device bearer against the ingress, with the stream opened the way the App opens it. */
function appClient(target) {
  return createClient({ origin: target.origin, credential: { kind: "bearer", token: target.device }, createSource: bearerSource(target.origin, target.device) });
}

test("the retired Web BFF vocabulary is what the Backend answers 404 to", async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const headers = { authorization: "Bearer " + target.device };
  // The ingress forwards both unchanged — its only rewrite is the deferred read block — and the Backend's own
  // conversation vocabulary is `/api/conversations…`, so a caller on the Next BFF's paths gets nothing.
  const list = await fetch(target.origin + "/api/sessions", { headers });
  assert.equal(list.status, 404, "the Backend answered a path it does not implement");
  assert.equal((await list.json()).code, "not_found");
  assert.equal((await fetch(target.origin + "/api/agent/anything/events", { headers })).status, 404);
  assert.equal((await fetch(target.origin + "/api/agent/running", { headers })).status, 404);
  // The Backend's own catalogue is the one that answers, which is what makes the cutover a path change and nothing more:
  // same identity, same host, same conversation records.
  assert.equal((await fetch(target.origin + "/api/conversations", { headers })).status, 200);
});

test("a device bearer lists, creates, reads, sends, recovers and follows a conversation on the Backend's own routes", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createConversationApi(client);

  // Create: the request id is the caller's own attempt identity, so a lost answer is answerable rather than repeated.
  const created = await api.create({ requestId: createRequestId() });
  assert.ok(created.conversationId.length > 0);
  const id = created.conversationId;

  // List and the running poll: one catalogue read answers both, with the Backend's own list version.
  const list = await api.list();
  assert.deepEqual(list.sessions.map(row => row.id), [id]);
  assert.equal(list.sessions[0].workspaceBound, false, "a conversation bound to nothing states no folder");
  assert.deepEqual(list.runningSessionIds, []);
  assert.equal(typeof list.sessionListVersion, "number");
  // The poll asks the same route for the compact answer: its revisions are the list's, and it asked for the projection.
  const poll = await api.running();
  assert.equal(poll.sessionListVersion, list.sessionListVersion);
  assert.equal(poll.sessionUiStateRevision, list.sessionUiStateRevision);
  assert.equal(poll.projectsRevision, list.projectsRevision);
  assert.deepEqual(poll.runningSessionIds, list.runningSessionIds);
  assert.equal(target.polled.compact, true, "the poll asked the full catalogue");

  // Read: the conversation read and the state read are one payload, so one request answers both.
  const read = await api.read(id);
  assert.equal(read.conversationId, id);
  assert.equal(read.busy, false);

  // Open: the by-id read is the conversation's identity and its catalogue row, which is what a deep link resolves.
  assert.equal((await api.open(id)).id, id);

  // Send: the admission names the durable submission the request id was made under.
  const requestId = createRequestId();
  const sent = await api.control(id).send(requestId, "hello from the App");
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(typeof sent.value.submissionId, "string");

  // Recovery: the request id the caller generated is what a lost answer is looked up by, and it is never re-sent.
  const record = await api.submission(id, requestId);
  assert.ok(record !== null, "the requestId the caller generated was not found");
  assert.equal(record.requestId, requestId);
  assert.equal(record.submissionId, sent.value.submissionId);

  // History: a bounded page of the entry table, forwarded with the Backend's own cursor semantics.
  assert.ok((await api.historyPage(id, { tail: 1 })).entries.length >= 1);

  // The turn really ran: the conversation's own read states both entries.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await api.read(id);
    if (!state.busy && state.entries.length >= 2) {
      assert.deepEqual(state.entries.map(entry => entry.text), ["hello from the App", "Server reply to: hello from the App"]);
      break;
    }
    if (attempt === 399) assert.fail("the turn never settled");
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  // Control: the named operations are the ones the Backend's own routes answer, under this same bearer.
  assert.equal((await api.control(id).control()).ok, true);
  assert.equal((await api.control(id).items()).ok, true);
  const renamed = await api.control(id).rename("named by the App");
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal((await api.settings(id)).thinkingLevel.length > 0, true);

  // Every request this caller made used the Backend's own vocabulary: the ingress served nothing under the retired Web
  // BFF's paths, so a 404 there cannot be what any of the answers above came from.
  assert.deepEqual(target.served.filter(entry => entry.includes("/api/sessions") || entry.includes("/api/agent")), [], "the workbench still asked the retired Web BFF vocabulary");
  assert.ok(target.served.every(entry => entry.includes(" /api/conversations")), target.served.join(", "));
});

test("a search hit carries the same catalogue row the list states, and an over-long query keeps its refusal", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createConversationApi(client);
  const { conversationId: id } = await api.create({});
  assert.equal((await api.control(id).send(createRequestId(), "a searchable needle")).ok, true);
  await settled(api, id, 2);

  // The hit is the Backend's own bounded body search: the conversation, the entry the match is in and the excerpt
  // around it — and the row beside it is projected exactly as the list projects that same conversation, so a result
  // cannot name a folder or a host the sidebar would show differently.
  const found = await api.search("needle");
  const hit = found.results.find(result => result.session.id === id);
  assert.ok(hit !== undefined, JSON.stringify(found));
  assert.equal(found.truncated, false);
  assert.equal(hit.match, "needle");
  const listed = (await api.list()).sessions.find(row => row.id === id);
  assert.deepEqual(hit.session, listed);
  assert.equal(typeof hit.entryId, "string");

  // The bound is refused with its own name rather than answered as an empty result, on the route the workbench calls.
  await assert.rejects(api.search("x".repeat(201)), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "query_too_long");
    return true;
  });
});

test("the conversation event stream follows the same connection, on the Backend's own address", { timeout: 60000 }, async (t) => {
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createConversationApi(client);
  const { conversationId: id } = await api.create({});

  const frames = [];
  const subscription = client.subscribe(id, event => { frames.push(event); });
  t.after(() => subscription.release());
  // The handshake is the baseline frame: the App's stream is open on the ingress under its device bearer, which is the
  // fact a 404 on `/api/agent/:id/events` used to deny it.
  await subscription.ready();
  const baseline = frames.find(frame => frame.type === "frame");
  assert.ok(baseline !== undefined, "no baseline frame arrived");
  assert.equal(baseline.event, "snapshot");
  assert.equal(baseline.data.conversationId, id);

  // A turn's own frames arrive on the same attachment, so the surface that sent it is reading the conversation it wrote
  // to rather than a second stream.
  assert.equal((await api.control(id).send(createRequestId(), "streamed")).ok, true);
  for (let attempt = 0; attempt < 400 && !frames.some(frame => frame.type === "submission"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(frames.some(frame => frame.type === "submission"), "the submission frame did not reach the caller");
  assert.deepEqual(target.served.filter(entry => entry.includes("/api/agent")), []);
});
/**
 * One attached image, as the composer states it: the protocol's own native block, base64 and media type.
 *
 * It is a real 1x1 PNG rather than a marker, so what the conversation committed can be read back as the image the user
 * attached.
 */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const attachedImage = { type: "image", data: TINY_PNG, mimeType: "image/png" };

/** The image blocks one committed entry carries, as the Backend's own projection states them. */
const imagesOf = (entry) => (Array.isArray(entry.message.content) ? entry.message.content.filter(block => block.type === "image") : []);

/** Wait for a conversation to settle with at least `entries` committed entries, and answer its last read. */
async function settled(api, id, entries) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await api.read(id);
    if (!state.busy && state.entries.length >= entries) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("the conversation never settled");
}

test("the navigation reads are answered on the Backend's own routes, and a refusal arrives with its code", { timeout: 60000 }, async (t) => {
  // The seam the navigation coordinator stands on: it names an outcome by the `code` the thrown error carries, so the
  // boundary that matters is that a real refusal crosses `createConversationApi` with that code still on it. A page and
  // a window read are checked at the same time, because a window is only addressable by a coordinate a page issued.
  const target = await fixture();
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => client.dispose());
  const api = createConversationApi(client);

  const { conversationId } = await api.create({});
  await api.control(conversationId).send(createRequestId(), "the first turn");
  await settled(api, conversationId, 2);
  const second = await api.control(conversationId).send(createRequestId(), "the turn the rail will jump to");
  assert.equal(second.ok, true, JSON.stringify(second));
  await settled(api, conversationId, 4);

  // One bounded outline page, read the way the rail reads it: no limit, so the contract's default applies.
  const page = await api.navigationOutline(conversationId);
  assert.equal(page.conversationId, conversationId);
  assert.deepEqual(page.anchors.map(anchor => anchor.preview), ["the first turn", "the turn the rail will jump to"], "one anchor per committed user message, in history order");
  assert.equal(page.prefix.kind === "scanned" || page.prefix.kind === "none", true, "the page states what it scanned behind the window");

  // The window one of those coordinates addresses, through the same query shape the coordinator builds: the anchor the
  // page issued and the snapshot the page stated, so the read is pinned where the rail was read.
  const jump = page.anchors[1];
  assert.ok(jump !== undefined, "the page states the anchor the rail would jump for");
  const window = await api.navigationTarget(conversationId, "?anchor=" + encodeURIComponent(jump.anchor) + "&snapshot=" + encodeURIComponent(page.snapshot) + "&entry=" + jump.entryId + "&block=0");
  assert.equal(window.target.present, true, "the target the coordinate names is carried by the window");
  assert.equal(window.target.entryId, jump.entryId);
  assert.equal(window.target.blockIndex, 0, "and the search hit's exact block is checked and answered, not ignored");
  assert.equal(window.snapshot, page.snapshot, "the window states the identity it was read against");
  assert.deepEqual(window.entries.map(entry => entry.text), [
    "the first turn", "Server reply to: the first turn", "the turn the rail will jump to", "Server reply to: the turn the rail will jump to",
  ], "the window is the committed history around the target, in native order, with the default context each side");
  assert.equal(window.hasOlder, false, "at this conversation's first turn nothing lies older, and the window says so");
  assert.equal(window.hasNewer, false, "nor past its last entry");

  // An entry of another conversation is refused by name, and the name survives the connection's error. The second
  // conversation has to hold a real entry for its coordinate to name one, so the jump is made over a history the
  // Backend actually issued rather than a hand-written address.
  const foreign = await api.create({});
  await api.control(foreign.conversationId).send(createRequestId(), "a turn of another conversation");
  await settled(api, foreign.conversationId, 2);
  const stolen = await api.navigationOutline(foreign.conversationId);
  assert.equal(stolen.anchors.length, 1, "the other conversation's outline states its own entry");
  const stolenAnchor = stolen.anchors[0];
  assert.ok(stolenAnchor !== undefined);
  let refusal;
  try {
    await api.navigationTarget(conversationId, "?anchor=" + encodeURIComponent(stolenAnchor.anchor));
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof Error, "a coordinate of another conversation is refused, not answered");
  assert.equal(refusal.code, "wrong-scope", "the refusal crosses this seam with the code the coordinator renders");

  // Every navigation request used the Backend's own vocabulary under this bearer.
  assert.ok(target.served.includes("GET /api/conversations/" + conversationId + "/navigation"), target.served.join(", "));
  assert.ok(target.served.includes("GET /api/conversations/" + conversationId + "/navigation/around"), target.served.join(", "));
});

test("an attached image reaches the conversation on an ordinary send and on a steer into a run in flight", { timeout: 60000 }, async (t) => {
  // The gate is what makes "busy" a state the test creates rather than a race it hopes to win, so the steer is really
  // queued against a run in flight — the one path where an attachment used to be dropped between the composer and the
  // wire.
  const gate = createAnswerGate();
  const target = await fixture(gatedEchoModels(gate));
  t.after(() => target.close());
  const client = appClient(target);
  t.after(() => { gate.release(); client.dispose(); });
  const api = createConversationApi(client);

  // An ordinary send carries the image as the protocol's own content beside its text.
  const { conversationId: idle } = await api.create({});
  assert.equal((await api.control(idle).send(createRequestId(), "an idle image", { images: [attachedImage] })).ok, true);
  const first = await settled(api, idle, 2);
  const sent = first.entries.find(entry => entry.role === "user");
  assert.deepEqual(imagesOf(sent).length, 1, "an ordinary send committed no image: " + JSON.stringify(sent.message.content));
  assert.equal(sent.text, "an idle image");

  // A steer into a run in flight is queued rather than committed, and it is admitted with the same content.
  gate.arm();
  const { conversationId: id } = await api.create({});
  assert.equal((await api.control(id).send(createRequestId(), "first turn")).ok, true);
  for (let attempt = 0; attempt < 400 && !gate.entered; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gate.entered, true, "the run never entered the model");
  assert.equal((await api.read(id)).busy, true);
  const steered = await api.control(id).send(createRequestId(), "a steered image", { queueOnly: true, whenBusy: "steer", images: [attachedImage] });
  assert.equal(steered.ok, true, JSON.stringify(steered));
  gate.release();
  const queued = await settled(api, id, 4);
  const placed = queued.entries.find(entry => entry.role === "user" && entry.text === "a steered image");
  assert.ok(placed !== undefined, "the steered turn was never placed: " + JSON.stringify(queued.entries.map(entry => entry.text)));
  assert.equal(imagesOf(placed).length, 1, "the steered image was dropped between the composer and the conversation: " + JSON.stringify(placed.message.content));
  // The bytes are the ones the user attached, behind the read block the projection defers them to.
  assert.equal(placed.message.content.some(block => typeof block.source?.url === "string" && block.source.url.includes("/entries/")), true, JSON.stringify(placed.message.content));
});
