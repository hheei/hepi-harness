/**
 * The running poll's compact answer at the seam a caller crosses: real HTTP against a real Backend, on in-memory storage.
 *
 * The compact read must state exactly what the full catalogue states for the same facts and none of the rows; the list
 * read must stay the list read, and a page bound beside the flag is refused by name. Storage is `:memory:` and every
 * barrier is the model really answering, so nothing here waits on a clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const TOKEN = "catalogue-running-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type FullCatalogue = {
  protocol: string;
  sidebarStateRevision: number;
  projectsRevision: number;
  sessionListVersion: number;
  conversations: { id: string; busy: boolean; revision: number; firstMessage: string; title: string | null }[];
};
type CompactCatalogue = {
  protocol: string;
  sidebarStateRevision: number;
  projectsRevision: number;
  sessionListVersion: number;
  runningConversationIds: string[];
  conversations?: unknown;
};

/** The provider whose answer a test holds, so "a run is in flight" is a state the test creates. */
function heldModels() {
  const held: (() => void)[] = [];
  let entered: (() => void) | undefined;
  const enteredOnce = new Promise<void>((resolve) => { entered = resolve; });
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    entered?.();
    await new Promise<void>((resolve) => { held.push(resolve); });
    const text = transcript.messages.findLast((message) => message.role === "user");
    return fauxAssistantMessage("reply to " + (text === undefined ? "" : contentText(text.content)));
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, entered: enteredOnce, release: () => { for (const resolve of held.splice(0)) resolve(); } };
}

type Fixture = { origin: string; backend: BackendServer; close(): Promise<void> };

/** One Backend over in-memory storage. */
async function fixture(models: ReturnType<typeof heldModels>["models"]): Promise<Fixture> {
  const backend = await createBackendServer({ dbPath: ":memory:", authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address && typeof address === "object");
  return { origin: "http://127.0.0.1:" + address.port, backend, close: async () => { backend.server.closeAllConnections(); await backend.close(); } };
}

const create = async (origin: string): Promise<string> => {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
};

/** Admit one turn, waiting for the model to be entered when this must make the run observably in flight. */
async function send(origin: string, id: string, requestId: string, wait = false, entered?: Promise<void>): Promise<void> {
  const response = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "turn " + requestId }) });
  assert.equal(response.status, 202, await response.text());
  if (wait) await entered;
}

const full = async (origin: string, query = ""): Promise<FullCatalogue> => await (await fetch(origin + "/api/conversations" + query, { headers })).json() as FullCatalogue;
const compact = async (origin: string, query = "?running=compact"): Promise<CompactCatalogue> => await (await fetch(origin + "/api/conversations" + query, { headers })).json() as CompactCatalogue;

test("the compact poll states the same running set and revisions the full catalogue states, without the rows", async (t) => {
  const held = heldModels();
  const server = await fixture(held.models);
  t.after(async () => { held.release(); await server.close(); });

  const running = await create(server.origin);
  const idle = await create(server.origin);
  await send(server.origin, running, "compact-run", true, held.entered);

  const listed = await full(server.origin);
  const polled = await compact(server.origin);

  // One question, two answers: the same identities, the same list version and the same revisions. A client that
  // polled and then listed must not see the list disagree.
  assert.deepEqual(polled.runningConversationIds, listed.conversations.filter((row) => row.busy).map((row) => row.id));
  assert.deepEqual(polled.runningConversationIds, [running]);
  assert.equal(polled.sessionListVersion, listed.sessionListVersion);
  assert.equal(polled.sidebarStateRevision, listed.sidebarStateRevision);
  assert.equal(polled.projectsRevision, listed.projectsRevision);
  assert.equal(polled.protocol, listed.protocol);

  // The rows are what the poll does not carry, and they are still what the list does: the list read is unchanged.
  assert.equal("conversations" in polled, false, "the compact answer carried the rows it exists to leave out");
  assert.deepEqual(listed.conversations.map((row) => row.id).sort(), [idle, running].sort());
  // The idle conversation is listed and is not named as running.
  assert.equal(listed.conversations.some((row) => row.id === idle && row.busy), false);
  assert.deepEqual((await compact(server.origin)).runningConversationIds, [running]);
});

test("the compact poll is materially smaller than the full catalogue it replaces, and both keep the same list version", async (t) => {
  const held = heldModels();
  const server = await fixture(held.models);
  t.after(async () => { held.release(); await server.close(); });

  // Rows carrying the fields the list renders, because that content is the bytes the poll was paying for: two of
  // them run, the rest are idle, which is the ordinary shape of a session list.
  const ids: string[] = [];
  for (let index = 0; index < 12; index += 1) ids.push(await create(server.origin));
  const first = ids[0];
  const second = ids[1];
  assert.ok(first !== undefined && second !== undefined);
  await send(server.origin, first, "bytes-1", true, held.entered);
  await send(server.origin, second, "bytes-2");

  const listedBody = await (await fetch(server.origin + "/api/conversations", { headers })).text();
  const polledBody = await (await fetch(server.origin + "/api/conversations?running=compact", { headers })).text();
  const listedBytes = Buffer.byteLength(listedBody);
  const polledBytes = Buffer.byteLength(polledBody);

  // A floor rather than a constant: the poll's size is set by how many conversations run, the list's by how many exist.
  assert.ok(polledBytes < listedBytes, "the compact answer was not smaller: " + polledBytes + " vs " + listedBytes);
  assert.ok(polledBytes * 10 <= listedBytes, "the compact answer was not an order of magnitude smaller: " + polledBytes + " vs " + listedBytes);
  assert.deepEqual((JSON.parse(polledBody) as CompactCatalogue).runningConversationIds, [first, second]);
  assert.equal((JSON.parse(polledBody) as CompactCatalogue).sessionListVersion, (JSON.parse(listedBody) as FullCatalogue).sessionListVersion);
});

test("the list read is unchanged, and a compact poll cannot be combined with paging", async (t) => {
  const held = heldModels();
  const server = await fixture(held.models);
  t.after(async () => { held.release(); await server.close(); });
  const id = await create(server.origin);
  // One conversation really in flight, so a compact read that dropped the filter would name it for every caller.
  await send(server.origin, id, "filter-run", true, held.entered);
  const other = await create(server.origin);

  // The list keeps its own contract: rows, and the paging a filtered relation read asks for.
  const page = await full(server.origin, "?limit=1");
  assert.equal(page.conversations.length, 1);
  assert.deepEqual(page.conversations.map((row) => row.id), [id]);

  // A caller that asked for a window must not be handed ids the window excludes.
  for (const query of ["?running=compact&limit=1", "?running=compact&cursor=" + id]) {
    const refused = await fetch(server.origin + "/api/conversations" + query, { headers });
    assert.equal(refused.status, 400, query);
    assert.equal((await refused.json() as { code: string }).code, "invalid_request", query);
  }

  // The relation filters still select: another conversation's creator selects nothing, though one is running.
  assert.deepEqual((await compact(server.origin, "?running=compact&createdBy=" + other)).runningConversationIds, []);
  assert.deepEqual((await compact(server.origin)).runningConversationIds, [id]);
  assert.deepEqual((await full(server.origin, "?createdBy=" + other)).conversations, []);
});
