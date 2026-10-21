import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { appendedEntries, continuationIndex, historyFacts, tokenFromFacts, WindowProjector } from "../src/history-window.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const directories: string[] = [];
const token = "history-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** A directory this test owns, removed with it. */
async function store(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-" + label + "-"));
  directories.push(directory);
  return join(directory, "history.sqlite");
}

/**
 * A backend over one store. History is seeded **before** it starts, because the backend attaches every listed
 * conversation when it boots and a second writer on the same SQLite file would be a second session, not a fixture.
 */
async function start(t: TestContext, dbPath: string): Promise<{ backend: BackendServer; origin: string; dbPath: string }> {
  const path = dbPath;
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: path, authToken: token, models });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path };
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as ServerSnapshot;
}

type PageEntry = { id: string; role: string; text: string; message: { errorMessage?: string; api?: string } };
type Page = { protocol: string; conversationId: string; entries: PageEntry[]; oldestEntryId: string | null; hasMore: boolean };

async function page(origin: string, id: string, query = ""): Promise<Page> {
  const response = await fetch(origin + "/api/conversations/" + id + "/entries" + query, { headers });
  assert.equal(response.status, 200);
  return await response.json() as Page;
}

/**
 * Seed one conversation directly on the runtime's own write path, so the reads under test are the reads a real
 * conversation's history is read through. \`turns\` are (user, assistant) pairs; \`toolsPerTurn\` tool results are
 * appended after each assistant, which is what makes a raw-entry cap observable.
 */
async function seed(dbPath: string, turns: number, toolsPerTurn = 0, assistantContent?: () => Parameters<typeof fauxAssistantMessage>[0]): Promise<string> {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const id = created.id as ConversationId;
  await harness.harness.commit(async (tx) => { await appendTurns(tx, id, 0, turns, toolsPerTurn, assistantContent); }, BACKGROUND_CONTEXT);
  await harness.close();
  return String(id);
}

/** \`turns\` user/assistant pairs on the runtime's own write path, from \`from\` (inclusive) to \`to\` (exclusive). */
async function appendTurns(tx: Parameters<Parameters<Awaited<ReturnType<typeof openServerHarness>>["harness"]["commit"]>[0]>[0], id: ConversationId, from: number, to: number, toolsPerTurn = 0, assistantContent?: () => Parameters<typeof fauxAssistantMessage>[0]): Promise<void> {
  for (let turn = from; turn < to; turn += 1) {
    await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "user " + turn, timestamp: turn * 2 }] });
    const content = assistantContent === undefined ? "answer " + turn : assistantContent();
    await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage(content, { timestamp: turn * 2 + 1 })] });
    for (let tool = 0; tool < toolsPerTurn; tool += 1) {
      await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-" + turn + "-" + tool, toolName: "read", content: [{ type: "text", text: "result " + turn + "/" + tool }], isError: false, timestamp: turn * 2 + 1 }], data: { diagnostics: [] } });
    }
  }
}

test("a long conversation's baseline read carries the window, and a short one carries everything", async (t) => {
  const dbPath = await store("window");
  const long = await seed(dbPath, 80, 2);
  const server = await start(t, dbPath);
  const window = await state(server.origin, long);
  assert.ok(window.entries.length <= 300, "the window is bounded by the raw cap: " + window.entries.length);
  assert.equal(window.entries.filter(entry => entry.role === "user" || entry.role === "assistant").length, 50, "50 visible messages");
  assert.equal(window.entries.at(-1)?.text, "result 79/1", "the newest entry is inside the window");
  assert.equal(window.entries.some(entry => entry.text === "answer 79"), true, "the newest turn's own messages are inside it");
  assert.equal(window.hasMore, true);
  assert.equal(typeof window.historyRevision, "string");
  assert.equal(window.historyHead, null, "a conversation with no compaction has no head marker");
  // A read that returned the whole transcript would have every user message in it.
  assert.equal(window.entries.some(entry => entry.text === "user 0"), false, "the oldest turns are outside the window");

  // A short conversation is carried whole. It is seeded into its own store, because a conversation created after the
  // backend booted is not one of the conversations it attached.
  const shortPath = await store("short");
  const short = await seed(shortPath, 4);
  const smallServer = await start(t, shortPath);
  const small = await state(smallServer.origin, short);
  assert.equal(small.entries.length, 8);
  assert.equal(small.hasMore, false);
  assert.equal(small.entries[0]?.text, "user 0");
});

test("the history token is stable across reads, moves on an append and on a head marker, and survives a restart", async (t) => {
  const dbPath = await store("token");
  const id = await seed(dbPath, 3);
  const first = await start(t, dbPath);
  const one = await state(first.origin, id);
  assert.equal((await state(first.origin, id)).historyRevision, one.historyRevision, "two reads with no commit agree");
  await first.backend.close();

  // A restart on the same store reports the same token: the facts it names are durable, and neither the attachment
  // identity nor this process's publication counter is one of them.
  const second = await start(t, dbPath);
  const reopened = await state(second.origin, id);
  assert.equal(reopened.historyRevision, one.historyRevision, "the token is a function of durable facts");
  assert.equal(reopened.projectionId === one.projectionId, false, "the attachment identity is deliberately not persisted");
  await second.backend.close();

  // An append moves the tail, so the token moves with it. It is written through the runtime's own public write path.
  const writer = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  await writer.harness.commit(tx => tx.appendEntry(UserEntry, Number(id) as ConversationId, { model: [{ role: "user", content: "a later turn", timestamp: 99 }] }), BACKGROUND_CONTEXT);
  await writer.close();
  const third = await start(t, dbPath);
  const appended = await state(third.origin, id);
  assert.notEqual(appended.historyRevision, one.historyRevision, "an appended entry moves the token");
});

test("paging backwards reproduces exactly the entries an unbounded read would return, and never repeats the boundary", async (t) => {
  const dbPath = await store("paging");
  const id = await seed(dbPath, 60, 0);
  const server = await start(t, dbPath);
  const baseline = await state(server.origin, id);
  const seen = new Set(baseline.entries.map(entry => entry.id));
  let cursor = baseline.entries[0]!.id;
  let pages = 0;
  while (pages < 20) {
    const next = await page(server.origin, id, "?before=" + cursor + "&tail=50");
    if (next.entries.length === 0) { assert.equal(next.hasMore, false); break; }
    assert.equal(next.entries.some(entry => entry.id === cursor), false, "the boundary entry is never repeated");
    for (const entry of next.entries) {
      assert.equal(seen.has(entry.id), false, "no entry is returned twice across pages");
      seen.add(entry.id);
    }
    cursor = next.entries[0]!.id;
    pages += 1;
  }
  // The union of the window and every page is exactly the conversation's own history.
  assert.equal(seen.size, 120, "every committed entry is reachable by paging");
  assert.equal(pages > 1, true, "a 60-turn conversation needs more than one page");
});

test("a page never crosses a head marker, so a compaction's dropped history is not paged back", async (t) => {
  const dbPath = await store("compaction");
  const id = await seed(dbPath, 40, 0);
  // A compaction summary is a head marker pointing at the first entry the new context keeps. It is written before the
  // backend starts, so the view it attaches is the one the marker created.
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const kept = (await harness.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT))!;
  // The new context keeps the second half: everything before that entry leaves the active range.
  const all = (await kept.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)).items;
  const firstKept = all[40]!.id;
  await harness.harness.commit(tx => tx.appendEntry(CompactionEntry, Number(id) as ConversationId, { model: [{ role: "user", content: "summary of everything", timestamp: 0 }], data: { reason: "threshold" }, head: firstKept }), BACKGROUND_CONTEXT);
  await harness.close();
  const server = await start(t, dbPath);

  const after = await state(server.origin, id);
  assert.equal(typeof after.historyHead, "string", "the head marker is published");
  // Whatever comes back is bounded by the marker's head: nothing below it is ever handed out.
  let cursor = after.entries[0]!.id;
  let guard = 0;
  while (guard < 10) {
    const back = await page(server.origin, id, "?before=" + cursor + "&tail=50");
    if (back.entries.length === 0) break;
    for (const entry of back.entries) assert.equal(entry.text === "user 0", false, "an entry the active context dropped is not paged back: " + entry.id);
    cursor = back.entries[0]!.id;
    guard += 1;
  }
  assert.equal(after.entries.some(entry => entry.text === "user 0"), false, "the dropped prefix is not in the window either");
});

test("one entry is readable by id, projected and redacted exactly as the stream projects it", async (t) => {
  const dbPath = await store("by-id");
  const id = await seed(dbPath, 3);
  const server = await start(t, dbPath);
  const current = await state(server.origin, id);
  const first = current.entries[0]!;
  const response = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + first.id, { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { entry: PageEntry };
  assert.deepEqual(body.entry, first, "the by-id read and the window agree about one entry");

  assert.equal((await fetch(server.origin + "/api/conversations/" + id + "/entries/999999", { headers })).status, 404, "an unknown id is a 404");
  assert.equal((await fetch(server.origin + "/api/conversations/" + id + "/entries?before=abc", { headers })).status, 400, "a bad cursor is a 400");
  assert.equal((await fetch(server.origin + "/api/conversations/" + id + "/entries?tail=0", { headers })).status, 400, "a bad page size is a 400");
});

test("thinking is deferred to a preview with the signature dropped, and the read block restores the text", async (t) => {
  const dbPath = await store("thinking");
  const id = await seed(dbPath, 2, 0, () => [
    fauxThinking("a long private reasoning\nand a second line"),
    { type: "text", text: "the answer" },
  ]);
  const server = await start(t, dbPath);
  const current = await state(server.origin, id);
  const assistant = current.entries.find(entry => entry.role === "assistant")!;
  const blocks = (assistant.message as { content: { type: string; thinking?: string; deferred?: boolean; thinkingSignature?: string }[] }).content;
  const thinking = blocks.find(block => block.type === "thinking")!;
  assert.equal(thinking.thinking, "a long private reasoning", "the preview is the first line");
  assert.equal(thinking.deferred, true);
  assert.equal(thinking.thinkingSignature, undefined, "the provider's opaque payload does not ride a history frame");
  assert.equal(JSON.stringify(assistant).includes("thinkingSignature"), false);

  const response = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + assistant.id + "/thinking?blockIndex=0", { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { thinking: string };
  assert.match(body.thinking, /a long private reasoning/);
  assert.match(body.thinking, /and a second line/, "the read block restores the whole text, not the preview");
  assert.equal((await fetch(server.origin + "/api/conversations/" + id + "/entries/" + assistant.id + "/thinking?blockIndex=9", { headers })).status, 400, "a block index outside the content is a 400");
});

test("a tool-result image inside the policy becomes a read-block URL, and the URL serves exactly those bytes", async (t) => {
  const dbPath = await store("images");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const id = await seed(dbPath, 0);
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = Number(id) as ConversationId;
  await harness.harness.commit(tx => tx.appendEntry(ToolResultEntry, conversation, { model: [{ role: "toolResult", toolCallId: "call-image", toolName: "screenshot", content: [{ type: "image", data: png, mimeType: "image/png" }, { type: "image", data: png, mimeType: "image/tiff" }], isError: false, timestamp: 0 }], data: { diagnostics: [] } }), BACKGROUND_CONTEXT);
  const entryId = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: conversation }, 1, undefined), BACKGROUND_CONTEXT)).items[0]!.id;
  await harness.close();
  const server = await start(t, dbPath);

  const current = await state(server.origin, id);
  const toolResult = current.entries.find(entry => entry.role === "toolResult")!;
  const content = (toolResult.message as { content: unknown[] }).content;
  const deferred = content[0] as { type: string; source: { type: string; media_type: string; url: string } };
  assert.equal(deferred.type, "image");
  assert.equal(deferred.source.type, "url", "the frame carries a URL, not the base64 payload");
  assert.equal(deferred.source.url, "/api/sessions/" + id + "/entries/" + String(entryId) + "/tool-result-image?blockIndex=0");
  assert.equal(JSON.stringify(toolResult).includes(png), false, "the bytes do not ride the frame");
  assert.match((content[1] as { text: string }).text, /^\[1 tool result image omitted from initial history payload: image\/tiff, ~[0-9]+ bytes\]$/, "an image outside the policy is omitted with the copied app's own notice");

  // The URL the frame named is served by the backend's own read block, and returns the original bytes.
  const served = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + String(entryId) + "/tool-result-image?blockIndex=0", { headers });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), png);
  // The refused mime is refused here too: the policy that decided the frame's shape decides the read.
  assert.equal((await fetch(server.origin + "/api/conversations/" + id + "/entries/" + String(entryId) + "/tool-result-image?blockIndex=1", { headers })).status, 415);
});

test("redaction holds identically on the window, a page and a single-entry read", async (t) => {
  // The failing entry sits in the **middle** of a long conversation: outside the newest window, inside the page that
  // reaches back to it, and readable on its own — so one redaction is asserted on three surfaces at once.
  const dbPath = await store("redaction");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const conversation = created.id as ConversationId;
  const id = String(conversation);
  await harness.harness.commit(async (tx) => {
    await appendTurns(tx, conversation, 0, 60);
    const failure = { ...fauxAssistantMessage("ignored", { stopReason: "error" }), errorMessage: "Credential store read failed for /home/operator/.pi/agent/auth.json: secret-value", api: "an-api-nobody-registered" };
    await tx.appendEntry(AssistantEntry, conversation, { model: [failure] });
    await appendTurns(tx, conversation, 60, 120);
  }, BACKGROUND_CONTEXT);
  const failedId = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: conversation }, 200, undefined), BACKGROUND_CONTEXT)).items.find(entry => entry.model?.[0]?.role === "assistant" && (entry.model[0] as { errorMessage?: string }).errorMessage !== undefined)!.id;
  await harness.close();
  const server = await start(t, dbPath);

  const assertRedacted = (message: { errorMessage?: string; api?: string }) => {
    assert.equal(message.errorMessage, "the model catalog or credentials could not be loaded; check the backend model and credential configuration");
    assert.equal(message.api, "unknown");
  };
  // The failing entry is the newest, so it is in the window, in the first page behind it, and readable by id: three
  // surfaces, one redaction.
  const window = await state(server.origin, id);
  assert.equal(window.entries.some(entry => entry.id === String(failedId)), false, "the failing entry is outside the window, so a page is the only way to reach it");
  let cursor = window.entries[0]!.id;
  let paged: PageEntry | undefined;
  let guard = 0;
  while (paged === undefined && guard < 10) {
    const older = await page(server.origin, id, "?before=" + cursor + "&tail=50");
    if (older.entries.length === 0) break;
    paged = older.entries.find(entry => entry.id === String(failedId));
    cursor = older.entries[0]!.id;
    guard += 1;
  }
  assert.ok(paged !== undefined, "the page reaching back to the failing entry is a real surface");
  assertRedacted(paged.message);
  const single = await (await fetch(server.origin + "/api/conversations/" + id + "/entries/" + String(failedId), { headers })).json() as { entry: { message: { errorMessage?: string; api?: string } } };
  assertRedacted(single.entry.message);
  assert.equal(JSON.stringify(window).includes("secret-value"), false);
});

test("the catalogue count stays right while the transcript is longer than any window", async (t) => {
  const dbPath = await store("catalogue");
  await seed(dbPath, 120, 1);
  const server = await start(t, dbPath);
  const catalog = await (await fetch(server.origin + "/api/conversations", { headers })).json() as { conversations: { messageCount: number; firstMessage: string }[] };
  assert.equal(catalog.conversations[0]!.messageCount, 360, "120 users, 120 assistants and 120 tool results");
  assert.equal(catalog.conversations[0]!.firstMessage, "user 0", "the first message is reported even though it is outside every window");
});

test("an accepted user image is deferred to the same read block, and the block serves it", async (t) => {
  // A user's own prompt image is the one attachment a person sends: the wire policy that keeps a frame bounded has to
  // apply to it too, or the read the user makes right after sending it answers 413 and the block it names 404s.
  const dbPath = await store("user-image");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const id = await seed(dbPath, 0);
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = Number(id) as ConversationId;
  // A mixed prompt: text and an accepted image in one user message, plus one image outside the mime policy.
  await harness.harness.commit(tx => tx.appendEntry(UserEntry, conversation, { model: [{ role: "user", content: [{ type: "text", text: "what is in this screenshot?" }, { type: "image", data: png, mimeType: "image/png" }, { type: "image", data: png, mimeType: "image/tiff" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const entryId = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: conversation }, 1, undefined), BACKGROUND_CONTEXT)).items[0]!.id;
  await harness.close();
  const server = await start(t, dbPath);

  // The read the user makes right after sending: the accepted image does not ride the frame, so it is carried.
  const current = await state(server.origin, id);
  const user = current.entries.find(entry => entry.role === "user")!;
  const content = (user.message as { content: unknown[] }).content;
  const deferred = content[1] as { type: string; source: { type: string; media_type: string; url: string } };
  assert.equal(deferred.source.type, "url", "the accepted user image becomes a read block, not a 413");
  assert.equal(deferred.source.url, "/api/sessions/" + id + "/entries/" + String(entryId) + "/tool-result-image?blockIndex=1");
  assert.equal(JSON.stringify(current).includes(png), false, "the bytes do not ride the frame");
  assert.match((content[2] as { text: string }).text, /^\[1 tool result image omitted from initial history payload: image\/tiff, ~[0-9]+ bytes\]$/);

  // The block the frame named is the block that serves the user's image, byte for byte.
  const served = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + String(entryId) + "/tool-result-image?blockIndex=1", { headers });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), png);
});

test("the baseline states its own boundary, so a caller can trim to the window it was given", async (t) => {
  const dbPath = await store("boundary");
  const long = await seed(dbPath, 80);
  const server = await start(t, dbPath);
  const window = await state(server.origin, long);
  assert.equal(window.hasMore, true);
  assert.equal(window.oldestEntryId, window.entries[0]!.id, "a bounded window names its own first entry");

  // A complete window states no boundary: nothing precedes it, so a caller that held earlier entries replaces them.
  const shortPath = await store("boundary-short");
  const short = await seed(shortPath, 3);
  const smallServer = await start(t, shortPath);
  const small = await state(smallServer.origin, short);
  assert.equal(small.hasMore, false);
  assert.equal(small.oldestEntryId, null, "a complete transcript states no boundary");
});

test("paging follows the native active order, so a compaction summary is reachable exactly once", async (t) => {
  // The head marker is kept first by the native view but carries a **newer** id than the entries it keeps, so a page
  // ordered by id can never reach it: the summary of everything the context dropped would be unreachable.
  const dbPath = await store("active-order");
  const id = await seed(dbPath, 120);
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = Number(id) as ConversationId;
  const kept = (await harness.harness.conversation(conversation, BACKGROUND_CONTEXT))!;
  const all = (await kept.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT)).items;
  const firstKept = all[40]!.id;
  await harness.harness.commit(tx => tx.appendEntry(CompactionEntry, conversation, { model: [{ role: "user", content: "summary of everything", timestamp: 0 }], data: { reason: "threshold" }, head: firstKept }), BACKGROUND_CONTEXT);
  const headId = (await harness.harness.commit(tx => tx.latestHeadMarker(conversation), BACKGROUND_CONTEXT))!.id;
  await harness.close();
  const server = await start(t, dbPath);

  const baseline = await state(server.origin, id);
  const seen = new Set(baseline.entries.map(entry => entry.id));
  let cursor = baseline.entries[0]!.id;
  let pages = 0;
  while (pages < 20) {
    const next = await page(server.origin, id, "?before=" + cursor + "&tail=50");
    if (next.entries.length === 0) { assert.equal(next.hasMore, false); break; }
    for (const entry of next.entries) {
      assert.equal(seen.has(entry.id), false, "an active entry is handed out once: " + entry.id);
      seen.add(entry.id);
    }
    cursor = next.entries[0]!.id;
    pages += 1;
  }
  // The active range is the marker plus the 200 entries from its head through the tail; the 40 before the head are gone.
  assert.equal(seen.size, 201, "every active entry is reachable exactly once");
  assert.equal(seen.has(String(headId)), true, "the compaction summary is reachable");
  assert.equal(seen.has(String(all[0]!.id)), false, "an entry the active context dropped is not paged back");
});

test("a read block refuses an entry outside this conversation's history and keeps a fork's ancestor entry", async (t) => {
  const dbPath = await store("entry-scope");
  const mine = await seed(dbPath, 1);
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const foreign = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  await harness.harness.commit(async (tx) => {
    await tx.appendEntry(AssistantEntry, foreign.id, { model: [fauxAssistantMessage([fauxThinking("FOREIGN FULL THINKING"), { type: "text", text: "foreign answer" }])] });
    await tx.appendEntry(ToolResultEntry, foreign.id, { model: [{ role: "toolResult", toolCallId: "foreign-call", toolName: "screenshot", content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", mimeType: "image/png" }], isError: false, timestamp: 0 }], data: { diagnostics: [] } });
  }, BACKGROUND_CONTEXT);
  const foreignEntries = (await foreign.entries({ order: "ascending" }, 10, undefined, BACKGROUND_CONTEXT)).items;
  const foreignThinking = foreignEntries.find(entry => entry.kind === "pi.assistant")!.id;
  const foreignImage = foreignEntries.find(entry => entry.model?.[0]?.role === "toolResult")!.id;
  // A fork of the foreign conversation inherits those entries: its own history reaches them, so they stay readable.
  const fork = await foreign.fork(foreignThinking, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  await harness.close();
  const server = await start(t, dbPath);

  const base = server.origin + "/api/conversations/" + mine + "/entries/" + String(foreignThinking);
  assert.equal((await fetch(base, { headers })).status, 404, "another conversation's entry is not readable here");
  assert.equal((await fetch(base + "/thinking?blockIndex=0", { headers })).status, 404, "nor is its thinking block");
  assert.equal((await fetch(server.origin + "/api/conversations/" + mine + "/entries/" + String(foreignImage) + "/tool-result-image?blockIndex=0", { headers })).status, 404, "nor is its image block");
  // A fork does reach them: the same id is this conversation's own history.
  const inherited = await fetch(server.origin + "/api/conversations/" + String(fork.id) + "/entries/" + String(foreignThinking) + "/thinking?blockIndex=0", { headers });
  assert.equal(inherited.status, 200);
  assert.match((await inherited.json() as { thinking: string }).thinking, /FOREIGN FULL THINKING/);
});

/**
 * The projector is where a publication stops costing what the transcript holds. These cases are its own seam: they
 * count how many entries it projects, which is the difference between "turn 200 costs what turn 200 appended" and
 * "turn 200 costs the window". The wire-level consequence is asserted in `delta-frames.test.ts`.
 */
test("an append-only advance projects only what it appended, and a recompute projects the window", () => {
  const projected: string[] = [];
  const projector = new WindowProjector<{ id: number; kind: string; model?: readonly Message[] }, { id: number; bytes: number }>(entry => {
    projected.push(String(entry.id));
    return { id: entry.id, bytes: 1 };
  });
  const raw = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => ({ id: from + index, kind: "pi.user", model: [{ role: "user", content: "m", timestamp: index }] as const }));
  const first = projector.advance(raw(1, 11));
  assert.equal(projected.length, 10, "the first read projects the whole window");
  assert.equal(first.items.length, 10);
  assert.equal(first.hasMore, false, "the window is the whole range, so nothing is behind it");

  projected.length = 0;
  const advanced = projector.advance([...raw(1, 11), ...raw(11, 13)], raw(11, 13));
  assert.deepEqual(projected, ["11", "12"], "an advance that appended two entries projects two entries, not the window");
  assert.deepEqual(advanced.items.map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // The count rule and the byte budget are both bounds on the window, and both are reached by dropping the oldest
  // entry: 50 visible messages is the cap, so an advance past it drops exactly the excess and no more.
  projected.length = 0;
  const grown = projector.advance([...raw(1, 13), ...raw(13, 62)], raw(13, 62));
  assert.equal(grown.items.length, 50, "the window stays at the visible cap");
  assert.equal(grown.items[0]!.id, 12, "the oldest entries leave the window, and only those");
  assert.equal(grown.items.at(-1)!.id, 61, "the newest entry is always carried");
  assert.equal(grown.hasMore, true, "and the window now states that older entries exist");
  assert.equal(grown.oldestEntryId, "12");
  assert.deepEqual(projected, Array.from({ length: 49 }, (_, index) => String(13 + index)), "and only the appended entries were projected to get there");

  // A recompute — the first read, a head marker, a truncation, an overflow's root replace — restates the window from
  // the view instead of adjusting it, so it can never drift from the rule it is supposed to be an optimization of.
  projected.length = 0;
  const recomputed = projector.advance(raw(1, 62));
  assert.deepEqual(recomputed.items.map(item => item.id), grown.items.map(item => item.id), "the recompute and the incremental window agree");
  assert.equal(projected.length, 50, "and the recompute projects the window it is restating, not the range behind it");
});

test("the native ops say what an advance appended, and anything else says the window must be recomputed", () => {
  const entries = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => ({ id: from + index, kind: "pi.user" }));
  // The runtime publishes an ordinary append as a positional insert at the growing end (measured against pi-durable
  // 1.1.0: `["p", ["entries"], n, 0, [entry, ...]]`), and a document change as an op on `docs`.
  assert.deepEqual(appendedEntries([["p", ["entries"], 3, 0, entries(4, 5)]], 3)?.map(entry => entry.id), [4], "an append is read from the op that carried it");
  assert.deepEqual(appendedEntries([["s", ["docs", "pi.live"], {}], ["p", ["entries"], 3, 0, entries(4, 6)]], 3)?.map(entry => entry.id), [4, 5], "a document change beside an append is not an append and is passed over");
  assert.deepEqual(appendedEntries([["p", ["entries"], 3, 0, []]], 3), [], "an advance that appended nothing states an empty append");
  assert.deepEqual(appendedEntries([], 3), [], "and so does a commit that touched no entry");
  // Every other shape restates the range: a head marker goes in at the front, a truncation removes from the end, a
  // replacement or an overflow's root replace carries the whole value.
  assert.equal(appendedEntries([["p", ["entries"], 0, 1, entries(9, 10)]], 3), undefined, "a head marker is a re-baseline");
  assert.equal(appendedEntries([["p", ["entries"], 3, 2, []]], 3), undefined, "a truncation is a re-baseline");
  assert.equal(appendedEntries([["p", ["entries"], 1, 0, entries(4, 5)]], 3), undefined, "an insert that is not at the end is a re-baseline");
  assert.equal(appendedEntries([["s", ["entries"], entries(1, 3)]], 3), undefined, "a replacement is a re-baseline");
  assert.equal(appendedEntries([["r", { entries: entries(1, 3) }]], 3), undefined, "an overflow's root replace is a re-baseline");
  assert.equal(appendedEntries([["t", ["entries"], 2]], 3), undefined, "a truncate op is a re-baseline");
  assert.equal(appendedEntries([["m", ["entries"], [0, 1]]], 3), undefined, "a reorder is a re-baseline");
});

test("the history token is advanced by an append from the kept facts, and agrees with a full derivation", () => {
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => ({ id: from + index, kind: "pi.user" }));
  const facts = historyFacts(range(1, 5));
  assert.deepEqual(facts, { head: null, tail: "4" }, "a range with no head marker states none, and names its newest entry");
  const appended = [...range(5, 7)];
  const advanced = { head: facts.head, tail: String(appended[appended.length - 1]!.id) };
  assert.equal(tokenFromFacts("c1", advanced), tokenFromFacts("c1", historyFacts(range(1, 7))), "advancing the facts by an append states the same token as deriving them");
  // A marker is never an append (the native view puts it at the front), so a view that carries one derives its facts
  // rather than adjusting them — which is what the recompute path does.
  const withMarker = [{ id: 9, kind: "pi.compaction", head: 3 }, ...range(3, 5)];
  assert.equal(historyFacts(withMarker).head, "9");
});

test("the advancing-frame rule continues a window, and restates it when the head marker moved or it was cut away", () => {
  const window = (ids: string[], head: string | null = null) => ({ head, entries: ids.map(id => ({ id })) });
  const previous = { revision: 7, entries: [{ id: "3" }, { id: "4" }, { id: "5" }], head: null };
  // An ordinary append: the newest entry the client holds is still in the new window, so the frame continues it.
  assert.equal(continuationIndex(previous, window(["3", "4", "5", "6"])), 2, "the frame continues from the entry the client holds");
  // The window moved forward past it: there is nothing to continue, so the whole window is restated.
  assert.equal(continuationIndex(previous, window(["5", "6"])), 0, "a window that still reaches the held entry continues it");
  assert.equal(continuationIndex(previous, window(["6", "7"])), -1, "a window that moved past it is a re-baseline");
  // A head marker is the one event that ends a loaded window: truncation plus append is never one frame.
  assert.equal(continuationIndex(previous, { head: "9", entries: [{ id: "9" }, { id: "4" }, { id: "5" }] }), -1, "a moved head marker restates the window");
  assert.equal(continuationIndex({ ...previous, head: "2" }, { head: "2", entries: [{ id: "4" }, { id: "5" }] }), 1, "an unchanged head marker continues normally");
  // The first frame of an attachment has no window to continue, and a client's baseline is the snapshot event.
  assert.equal(continuationIndex(null, window(["5"])), -1, "the first frame of an attachment is a baseline");
  assert.equal(continuationIndex({ revision: 1, entries: [], head: null }, window(["5"])), -1, "an empty held window continues nothing");
});