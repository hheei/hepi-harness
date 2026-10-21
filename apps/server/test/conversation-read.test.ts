import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { AssistantEntry, CompactionEntry, UserEntry, type Conversation, type ConversationId, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { READ_MAX_BYTES, READ_MAX_LINES, readConversation, type ConversationReadResult } from "../src/conversation-read.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { createBackendServer } from "../src/server.ts";
import { tombstoneConversation } from "../src/session-tombstone.ts";

/**
 * The bounded raw conversation read, asserted at the public core and HTTP seams over a real SQLite store.
 *
 * Every fixture is written through the runtime's own public transaction seam (`tx.appendEntry`), and every assertion
 * reads the read's own answer — the lines, the block references, the cursor, the diagnostics. Nothing here reaches into
 * the module's internals, and nothing here reads the entry table to check what the read should have said.
 */

const directories: string[] = [];
const token = "conversation-read-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** A tiny but real PNG: the image policy checks the declared mime and the decoded size, not the pixels. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

type Rig = { readonly harness: Harness; readonly close: () => Promise<void> };

/** A real harness over a native SQLite file, paused so no scheduler runs while a fixture is written. */
async function openStore(label: string): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-read-" + label + "-"));
  directories.push(directory);
  const server = await openServerHarness(join(directory, "read.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  return { harness: server.harness, close: () => server.close() };
}

async function createConversation(harness: Harness): Promise<Conversation> {
  return await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
}

/** One assistant message with the fields the runtime's own assistant entry requires. */
function assistantMessage(text: string) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "faux" as const, provider: "faux", model: "faux-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 0 };
}

/** Append one user text entry, returning its id. */
async function appendUser(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/** Append one assistant text entry, returning its id. */
async function appendAssistant(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(AssistantEntry, conversationId, { model: [assistantMessage(text)] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/** The text one page returned, or "" when it returned no text. */
function textOf(read: ConversationReadResult): string {
  const block = read.output[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

/**
 * Read from a cursor (or from the start) to the end of one scope, one page at a time, and join the pages the way the
 * cursors say they join: a cursor that continues inside a line joins the pieces without a line break, and one that
 * starts a line begins a new one.
 */
async function readAll(harness: Harness, conversationId: string, limit: number, cursor?: ConversationReadResult["details"]["next"], scope?: { entryId: string; blockIndex: number }): Promise<{ text: string; pages: number; next?: ConversationReadResult["details"]["next"] }> {
  let text = "";
  let pages = 0;
  let continues = false;
  let next = cursor;
  do {
    const page = await readConversation(harness, { conversationId, limit, ...(scope ?? {}), ...(next === undefined ? {} : { cursor: next }) });
    pages += 1;
    const part = textOf(page);
    if (part.length > 0) text = text.length === 0 ? part : text + (continues ? "" : "\n") + part;
    next = page.details.next;
    continues = next !== undefined && next.charOffset > 0;
  } while (next !== undefined && pages < 200);
  return { text, pages, next };
}

/**
 * A harness whose conversation reads count their scans, so "a continuation starts at its cursor instead of re-walking
 * the history" is observed as the scan it really is. The proxy stands in front of the runtime at its public boundary
 * and changes nothing about what the conversation answers.
 */
function countingHarness(harness: Harness): { harness: Harness; scans: { minEntryId: number | undefined; items: number }[] } {
  const scans: { minEntryId: number | undefined; items: number }[] = [];
  const wrapped = new Proxy(harness, {
    get(target, property, receiver) {
      if (property !== "conversation") return Reflect.get(target, property, receiver) as unknown;
      return async (id: ConversationId, context: never) => {
        const conversation = await target.conversation(id, context);
        if (conversation === undefined) return undefined;
        return new Proxy(conversation, {
          get(inner, innerProperty, innerReceiver) {
            if (innerProperty !== "entries") return Reflect.get(inner, innerProperty, innerReceiver) as unknown;
            return async (query: { minEntryId?: EntryId }, limit: number, cursor: never, innerContext: never) => {
              const page = await inner.entries(query, limit, cursor, innerContext);
              scans.push({ minEntryId: query.minEntryId, items: page.items.length });
              return page;
            };
          },
        });
      };
    },
  });
  return { harness: wrapped as Harness, scans };
}

/**
 * The real backend over one store: the route under test is the one the server actually serves, not a stand-in for it.
 */
async function startBackend(t: TestContext, dbPath: string): Promise<string> {
  const backend = await createBackendServer({ dbPath, authToken: token });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return "http://127.0.0.1:" + address.port;
}

/** One SQLite store under its own directory, so a fixture can be written before the backend opens it. */
async function storePath(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-read-" + label + "-"));
  directories.push(directory);
  return join(directory, "read.sqlite");
}

async function httpRead(origin: string, id: string, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/read?" + query, { headers });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

test("reads the raw history by 1-based text lines, with the range, the blocks and the tail in details", async (t) => {
  const rig = await openStore("lines");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const first = await appendUser(rig.harness, conversation.id, "one\ntwo\nthree");
  const second = await appendAssistant(rig.harness, conversation.id, "answer");
  const id = String(conversation.id);

  const whole = await readConversation(rig.harness, { conversationId: id });
  assert.equal(textOf(whole), "one\ntwo\nthree\nanswer");
  assert.equal(whole.output[0]?.type, "text");
  assert.equal(whole.details.outputLines, 4);
  assert.equal(whole.details.offset, 1, "the first line of the snapshot is line 1");
  assert.equal(whole.details.limit, READ_MAX_LINES);
  assert.equal(whole.details.maxBytes, READ_MAX_BYTES);
  assert.equal(whole.details.hasMore, false);
  assert.equal(whole.details.next, undefined);
  assert.equal(whole.details.truncated, false);
  assert.equal(whole.details.tail, second, "the tail is the snapshot's newest entry");
  assert.equal(whole.details.scope.kind, "history");
  // The range travels in details, not in the body: the text is only the text.
  assert.deepEqual(whole.details.entries.map(entry => [entry.entryId, entry.role]), [[first, "user"], [second, "assistant"]]);
  assert.deepEqual(whole.details.entries[0]?.blocks, [{ blockIndex: 0, type: "text", startLine: 1, endLine: 3 }]);
  assert.deepEqual(whole.details.entries[1]?.blocks, [{ blockIndex: 0, type: "text", startLine: 4, endLine: 4 }]);

  // `offset` is a real text line, so line 2 is the second line of the first entry rather than the second entry.
  const fromTwo = await readConversation(rig.harness, { conversationId: id, offset: 2 });
  assert.equal(textOf(fromTwo), "two\nthree\nanswer");
  assert.equal(fromTwo.details.offset, 2);
  assert.deepEqual(fromTwo.details.entries[0]?.blocks, [{ blockIndex: 0, type: "text", startLine: 2, endLine: 3 }]);

  // An offset past the end is an empty page that says so, not an error and not a wrong page.
  const past = await readConversation(rig.harness, { conversationId: id, offset: 99 });
  assert.deepEqual(past.output, []);
  assert.equal(past.details.hasMore, false);
  assert.equal(past.diagnostics[0]?.code, "end_of_history");
});

test("a continuation advances from its cursor instead of re-walking the history", async (t) => {
  const rig = await openStore("cursor");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  for (let index = 1; index <= 30; index += 1) await appendUser(rig.harness, conversation.id, "line " + index);
  const id = String(conversation.id);
  const counter = countingHarness(rig.harness);

  const first = await readConversation(counter.harness, { conversationId: id, limit: 5 });
  assert.equal(textOf(first), "line 1\nline 2\nline 3\nline 4\nline 5");
  assert.equal(first.details.truncatedBy, "lines");
  assert.equal(first.details.hasMore, true);
  const next = first.details.next;
  assert.ok(next !== undefined);
  assert.equal(next.offset, 6);
  assert.equal(next.blockLine, 0, "the cursor names the line inside its own entry, not only the entry");
  assert.equal(next.version, first.details.version);
  assert.equal(next.tail, first.details.tail);
  assert.match(first.diagnostics[0]?.message ?? "", /continue with the returned cursor/);
  // The first page walked the history from its oldest entry.
  assert.equal(counter.scans[0]?.minEntryId, undefined);
  const firstPageScans = counter.scans.length;

  const second = await readConversation(counter.harness, { conversationId: id, limit: 5, cursor: next });
  assert.equal(textOf(second), "line 6\nline 7\nline 8\nline 9\nline 10");
  assert.equal(second.details.offset, 6);
  assert.equal(second.details.entries[0]?.entryId, next.entryId, "the page's first covered entry is the cursor's own entry");
  // The continuation started at its cursor entry: its first scan is bounded by that entry, not by the history's start.
  const continuation = counter.scans.slice(firstPageScans);
  assert.ok(continuation.length > 0);
  // Every scan the continuation made was bounded at its start: none of them re-walked the history from its oldest entry.
  assert.equal(continuation.every(scan => scan.minEntryId !== undefined), true, "the continuation never scans from the start: " + JSON.stringify(continuation));
  assert.equal(continuation.some(scan => scan.minEntryId === Number(next.entryId)), true, "the continuation scans from the cursor entry");
  assert.ok(continuation.reduce((total, scan) => total + scan.items, 0) < 30, "the continuation did not read the whole history");

  // Walking to the end from that cursor reassembles the history exactly once, with nothing repeated and nothing lost.
  const walked = await readAll(rig.harness, id, 5, next);
  assert.equal(walked.next, undefined, "the walk ended");
  assert.deepEqual(walked.text.split("\n"), Array.from({ length: 25 }, (_, index) => "line " + (index + 6)));
  assert.equal(walked.pages, 5);
});

test("an appended entry does not move the lines a pinned snapshot already mapped", async (t) => {
  const rig = await openStore("tail");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const id = String(conversation.id);
  await appendUser(rig.harness, conversation.id, "first\nsecond");
  const first = await readConversation(rig.harness, { conversationId: id, limit: 1 });
  assert.equal(textOf(first), "first");
  const next = first.details.next;
  assert.ok(next !== undefined);

  // The conversation grows between the two pages.
  await appendAssistant(rig.harness, conversation.id, "third");

  const second = await readConversation(rig.harness, { conversationId: id, limit: 5, cursor: next });
  assert.equal(textOf(second), "second", "the pinned snapshot still holds the line the cursor pointed at");
  assert.equal(second.details.outputLines, 1);
  assert.equal(second.details.tail, next.tail, "the page states the snapshot its mapping belongs to");
  assert.equal(second.details.hasMore, false);
  // A fresh read states the new snapshot, and the appended entry is in it — the pin belongs to the continuation, not
  // to the conversation.
  const fresh = await readConversation(rig.harness, { conversationId: id });
  assert.equal(textOf(fresh), "first\nsecond\nthird");
  assert.notEqual(fresh.details.tail, next.tail);
  // A tail that is not this conversation's entry cannot bound this conversation's read.
  const foreign = await readConversation(rig.harness, { conversationId: id, tail: String(Number(fresh.details.tail) + 500) }).catch(error => error);
  assert.equal((foreign as { code?: string }).code, "not_found");
});

test("a line larger than the byte budget is returned as UTF-8-safe pieces with a usable cursor", async (t) => {
  const rig = await openStore("oversize");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const ascii = "x".repeat(60_000);
  const unicode = "字".repeat(30_000);
  await appendUser(rig.harness, conversation.id, ascii);
  await appendUser(rig.harness, conversation.id, unicode);
  const id = String(conversation.id);

  const first = await readConversation(rig.harness, { conversationId: id });
  const firstText = textOf(first);
  assert.equal(first.details.truncatedBy, "bytes");
  assert.equal(first.details.outputLines, 1);
  assert.ok(first.details.outputBytes <= READ_MAX_BYTES, "the page respects the byte budget: " + first.details.outputBytes);
  assert.equal(firstText.length, READ_MAX_BYTES, "the ASCII line is cut exactly at the budget");
  assert.equal(ascii.startsWith(firstText), true);
  assert.equal(first.diagnostics[0]?.severity, "warn");
  assert.equal(firstText.includes("sed"), false);
  assert.equal(first.diagnostics[0]?.message.includes("sed"), false, "the continuation is a cursor, never a shell hint");
  const next = first.details.next;
  assert.ok(next !== undefined);
  assert.ok(next.charOffset > 0, "the cursor continues inside the line it cut");

  // The rest of that same line follows from the cursor, and the next line comes with it.
  const rest = await readConversation(rig.harness, { conversationId: id, cursor: next });
  const restText = textOf(rest);
  const asciiRest = restText.split("\n")[0];
  assert.equal(firstText + asciiRest, ascii, "the two pieces are the original line, byte for byte");

  // The multi-byte line is cut at a code-point boundary: no replacement character, and no byte budget overflow.
  const unicodePage = await readConversation(rig.harness, { conversationId: id, cursor: rest.details.next });
  const unicodeText = textOf(unicodePage);
  assert.equal(unicodeText.includes("\uFFFD"), false, "the cut never splits a character");
  assert.ok(Buffer.byteLength(unicodeText, "utf8") <= READ_MAX_BYTES);
  assert.equal(unicode.startsWith(unicodeText), true);

  // And the whole history reassembles exactly from the cursor walk, piece by piece.
  const walked = await readAll(rig.harness, id, 2000);
  assert.equal(walked.next, undefined);
  assert.ok(walked.pages >= 4, "the walk took one page per piece: " + walked.pages);
  assert.equal(walked.text, ascii + "\n" + unicode);
});

test("a line longer than several byte budgets advances one piece per page and terminates", async (t) => {
  const rig = await openStore("longline");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const id = String(conversation.id);
  // Positional content, so a page that repeated the piece before it could not be mistaken for the next piece.
  const ascii = Array.from({ length: 17_000 }, (_, index) => String(index % 10_000).padStart(10, "0")).join("");
  const emoji = "🙂".repeat(40_000);
  await appendUser(rig.harness, conversation.id, ascii);
  await appendUser(rig.harness, conversation.id, emoji);

  // A line that needs more than two budgets returns the next piece of that same line on every page: the cursor's
  // character position advances inside the line instead of restarting it, so the walk ends.
  const positions: { entryId: string; blockLine: number; charOffset: number }[] = [];
  let next = (await readConversation(rig.harness, { conversationId: id })).details.next;
  while (next !== undefined && positions.length < 20) {
    positions.push({ entryId: next.entryId, blockLine: next.blockLine, charOffset: next.charOffset });
    const page = await readConversation(rig.harness, { conversationId: id, cursor: next });
    assert.ok(page.details.outputBytes <= READ_MAX_BYTES, "every page respects the budget: " + page.details.outputBytes);
    next = page.details.next;
  }
  assert.equal(next, undefined, "the walk ends instead of repeating the same piece: " + JSON.stringify(positions));
  assert.ok(positions.length >= 6, "the line really spans several budgets: " + positions.length);
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1]!;
    const current = positions[index]!;
    if (previous.entryId === current.entryId && previous.blockLine === current.blockLine) {
      assert.ok(current.charOffset > previous.charOffset, "a piece of a line advances past the piece before it: " + JSON.stringify(positions));
    }
  }

  // The pieces rejoin into the original two lines, exactly, and in a finite number of pages.
  const walked = await readAll(rig.harness, id, READ_MAX_LINES);
  assert.equal(walked.next, undefined);
  assert.equal(walked.text, ascii + "\n" + emoji);
  assert.equal(walked.pages, 8);
});

test("the default page is 2000 lines, and the line limit is what stops it", async (t) => {
  const rig = await openStore("defaults");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const lines = Array.from({ length: 2500 }, (_, index) => "L" + (index + 1));
  await appendUser(rig.harness, conversation.id, lines.join("\n"));
  const id = String(conversation.id);

  const page = await readConversation(rig.harness, { conversationId: id });
  assert.equal(page.details.limit, 2000);
  assert.equal(page.details.outputLines, 2000);
  assert.equal(page.details.truncatedBy, "lines");
  assert.equal(page.details.next?.offset, 2001);
  assert.equal(textOf(page).split("\n").length, 2000);
  assert.equal(textOf(page).split("\n")[1999], "L2000");

  // A caller's own limit is honoured, and so is a smaller one over the same history.
  const small = await readConversation(rig.harness, { conversationId: id, limit: 3 });
  assert.equal(small.details.limit, 3);
  assert.equal(textOf(small), "L1\nL2\nL3");
});

test("one entry, one block and one image are read by their own addressing", async (t) => {
  const rig = await openStore("blocks");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const id = String(conversation.id);
  const textEntry = await appendUser(rig.harness, conversation.id, "alpha\nbeta");
  // A user message that carries an image beside its text, written through the same public seam.
  const imageEntry = await rig.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const imageId = String(imageEntry.id);
  await appendAssistant(rig.harness, conversation.id, "done");

  // Entry-scoped: the lines are numbered inside the entry's own scope.
  const entry = await readConversation(rig.harness, { conversationId: id, entryId: textEntry });
  assert.equal(textOf(entry), "alpha\nbeta");
  assert.equal(entry.details.scope.kind, "entry");
  assert.equal(entry.details.offset, 1);
  assert.equal(entry.details.tail, textEntry);
  assert.deepEqual(entry.details.entries.map(candidate => candidate.entryId), [textEntry]);

  // Block-scoped text: the block index addresses the native content, and the image beside it is listed but not served
  // as text.
  const block = await readConversation(rig.harness, { conversationId: id, entryId: imageId, blockIndex: 0 });
  assert.equal(textOf(block), "look");
  assert.equal(block.details.scope.kind, "block");
  assert.deepEqual(block.details.entries[0]?.blocks, [{ blockIndex: 0, type: "text", startLine: 1, endLine: 1 }, { blockIndex: 1, type: "image", mimeType: "image/png", bytes: Buffer.from(PNG, "base64").byteLength }]);

  // The image block read returns the image itself, with the diagnostics beside it rather than in the body.
  const image = await readConversation(rig.harness, { conversationId: id, entryId: imageId, blockIndex: 1 });
  assert.deepEqual(image.output, [{ type: "image", data: PNG, mimeType: "image/png" }]);
  assert.equal(image.details.outputLines, 0);
  assert.equal(image.details.offset, 0);
  assert.equal(image.diagnostics[0]?.code, "image");
});

test("a block read numbers its own lines and continues a long block from its cursor, over HTTP too", async (t) => {
  const dbPath = await storePath("block-cursor");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  // Positional content, so a repeated piece and the next piece are not the same string.
  const long = Array.from({ length: 12_000 }, (_, index) => String(index).padStart(10, "0")).join("");
  const wide = await seed.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: long, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const wideId = String(wide.id);
  const lines = await appendUser(seed.harness, conversation.id, "alpha\nbeta\ngamma");

  // A block's own lines are the scope, so offset 2 is the block's second line and not the history's.
  const second = await readConversation(seed.harness, { conversationId: id, entryId: lines, blockIndex: 0, offset: 2 });
  assert.equal(second.details.scope.kind, "block");
  assert.equal(second.details.offset, 2);
  assert.equal(textOf(second), "beta\ngamma");

  // A block larger than one page continues from the cursor it handed back rather than starting over.
  const first = await readConversation(seed.harness, { conversationId: id, entryId: wideId, blockIndex: 0 });
  assert.equal(textOf(first).length, READ_MAX_BYTES);
  const cursor = first.details.next;
  assert.ok(cursor !== undefined);
  assert.equal(cursor.entryId, wideId);
  assert.ok(cursor.charOffset > 0);
  const continued = await readConversation(seed.harness, { conversationId: id, entryId: wideId, blockIndex: 0, cursor });
  assert.notEqual(textOf(continued), textOf(first), "the continuation returns the next piece, not the first page again");
  assert.equal(long.startsWith(textOf(first) + textOf(continued)), true);
  const walked = await readAll(seed.harness, id, READ_MAX_LINES, undefined, { entryId: wideId, blockIndex: 0 });
  assert.equal(walked.next, undefined);
  assert.equal(walked.text, long);
  assert.equal(walked.pages, 3);
  await seed.close();

  // The scoped continuation over the real route: the cursor the route returned is the cursor it accepts.
  const origin = await startBackend(t, dbPath);
  const page = await httpRead(origin, id, "entryId=" + wideId + "&blockIndex=0");
  assert.equal(page.status, 200);
  const piece = ((page.body.output as { text: string }[])[0]!).text;
  assert.equal(piece.length, READ_MAX_BYTES);
  const next = (page.body.details as { next: Record<string, unknown> }).next;
  assert.ok(next !== undefined);
  const rest = await httpRead(origin, id, "entryId=" + wideId + "&blockIndex=0&cursor=" + encodeURIComponent(JSON.stringify(next)));
  assert.equal(rest.status, 200);
  const restPiece = ((rest.body.output as { text: string }[])[0]!).text;
  assert.notEqual(restPiece, piece, "the scoped continuation does not repeat the first page");
  const third = await httpRead(origin, id, "entryId=" + wideId + "&blockIndex=0&cursor=" + encodeURIComponent(JSON.stringify((rest.body.details as { next: Record<string, unknown> }).next)));
  assert.equal(third.status, 200);
  assert.equal(piece + restPiece + ((third.body.output as { text: string }[])[0]!).text, long, "the pages rejoin into the block");
});

test("an entry that carries no text line is still in the page's inventory, so its block is addressable", async (t) => {
  const rig = await openStore("inventory");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const id = String(conversation.id);
  const before = await appendUser(rig.harness, conversation.id, "before");
  const image = await rig.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const calling = await rig.harness.commit(tx => tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...assistantMessage("calling"), content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }] }] }), BACKGROUND_CONTEXT);
  const after = await appendAssistant(rig.harness, conversation.id, "after");

  const page = await readConversation(rig.harness, { conversationId: id });
  assert.equal(textOf(page), "before\nafter", "an entry without text contributes no line");
  assert.deepEqual(page.details.entries.map(entry => entry.entryId), [before, String(image.id), String(calling.id), after]);
  const imageEntry = page.details.entries[1]!;
  assert.equal(imageEntry.role, "user");
  assert.deepEqual(imageEntry.blocks, [{ blockIndex: 0, type: "image", mimeType: "image/png", bytes: Buffer.from(PNG, "base64").byteLength }]);
  assert.deepEqual(page.details.entries[2]?.blocks, [{ blockIndex: 0, type: "toolCall", name: "bash" }], "a tool call states no line range because it contributed no line");

  // The inventory is the addressing that works: the block the page listed is the block the read serves.
  const discovered = imageEntry.blocks[0]!;
  const served = await readConversation(rig.harness, { conversationId: id, entryId: imageEntry.entryId, blockIndex: discovered.blockIndex });
  assert.deepEqual(served.output, [{ type: "image", data: PNG, mimeType: "image/png" }]);

  // An image-only entry at the very end of the snapshot is listed too: that is how a caller learns there is an image
  // to read without having been told its id from outside.
  const trailing = await rig.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const end = await readConversation(rig.harness, { conversationId: id });
  assert.equal(end.details.entries.at(-1)?.entryId, String(trailing.id));
  assert.equal(end.details.entries.at(-1)?.blocks[0]?.type, "image");

  // The inventory stays as bounded as the page: a one-line page lists the entries it passed on its way to the line it
  // stopped at, and not the entry its own cursor names next.
  const bounded = await readConversation(rig.harness, { conversationId: id, limit: 1 });
  assert.equal(textOf(bounded), "before");
  assert.deepEqual(bounded.details.entries.map(entry => entry.entryId), [before, String(image.id), String(calling.id)]);
  assert.equal(bounded.details.hasMore, true);
  assert.equal(bounded.details.next?.entryId, after);
});

test("a block read refuses an index outside the content, a block that carries no text, and an image outside the policy", async (t) => {
  const rig = await openStore("refusals");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const id = String(conversation.id);
  const mixed = await rig.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const entryId = String(mixed.id);
  const called = await rig.harness.commit(tx => tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...assistantMessage("calling"), content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }] }] }), BACKGROUND_CONTEXT);

  const outside = await readConversation(rig.harness, { conversationId: id, entryId, blockIndex: 9 }).catch(error => error);
  assert.equal((outside as { code?: string }).code, "invalid_request");
  const notText = await readConversation(rig.harness, { conversationId: id, entryId: String(called.id), blockIndex: 0 }).catch(error => error);
  assert.equal((notText as { code?: string }).code, "not_found", "a tool call carries no text to serve");
  // An image the one wire policy would refuse is refused here too, rather than served by a second policy.
  const unsupported = await rig.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/tiff" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const overPolicy = await readConversation(rig.harness, { conversationId: id, entryId: String(unsupported.id), blockIndex: 0 }).catch(error => error);
  assert.equal((overPolicy as { code?: string }).code, "image_not_served");
  // A block index without an entry to belong to, and a cursor that names another entry than the read, are bad requests.
  const orphanBlock = await readConversation(rig.harness, { conversationId: id, blockIndex: 0 }).catch(error => error);
  assert.equal((orphanBlock as { code?: string }).code, "invalid_request");
});

test("compact-before entries, an inherited fork prefix and a tombstoned parent all stay readable, and membership is exact", async (t) => {
  const rig = await openStore("history");
  t.after(() => rig.close());
  const parent = await createConversation(rig.harness);
  const parentId = String(parent.id);
  const dropped = await appendUser(rig.harness, parent.id, "before the compaction");
  const kept = await appendAssistant(rig.harness, parent.id, "kept answer");
  // A compaction summary: the active context starts at the entry it names, which is the entry that used to hide
  // everything before it from every read that followed the active range.
  const summary = await rig.harness.commit(tx => tx.appendEntry(CompactionEntry, parent.id, { head: Number(kept) as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  const summaryId = String(summary.id);

  const full = await readConversation(rig.harness, { conversationId: parentId });
  assert.equal(textOf(full).startsWith("before the compaction\nkept answer"), true, "the raw history is not the active context: " + textOf(full));
  assert.deepEqual(full.details.entries.map(entry => entry.entryId), [dropped, kept, summaryId]);

  // A fork inherits the prefix it was taken from, and reads it as its own history.
  const forked = await parent.fork(Number(summaryId) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const forkedId = String(forked.id);
  const inherited = await readConversation(rig.harness, { conversationId: forkedId });
  assert.equal(textOf(inherited), textOf(full));
  // Its own entries are its own, and the parent's later turns are not in it.
  await appendUser(rig.harness, parent.id, "after the fork");
  const forkedAgain = await readConversation(rig.harness, { conversationId: forkedId });
  assert.equal(textOf(forkedAgain), textOf(inherited));

  // A tombstoned parent is hidden from the catalogue, and the fork's inherited entries still read.
  await tombstoneConversation(rig.harness, parent.id, [parentId], Date.now());
  const afterTombstone = await readConversation(rig.harness, { conversationId: forkedId });
  assert.equal(textOf(afterTombstone), textOf(inherited));

  // Membership: an entry of the parent is not readable through a conversation that did not inherit it, and an entry
  // id from another conversation cannot be reached by naming it.
  const other = await createConversation(rig.harness);
  const otherId = String(other.id);
  const otherEntry = await appendUser(rig.harness, other.id, "another conversation's line");
  const crossed = await readConversation(rig.harness, { conversationId: forkedId, entryId: otherEntry }).catch(error => error);
  assert.equal((crossed as { code?: string }).code, "not_found");
  const crossedBlock = await readConversation(rig.harness, { conversationId: otherId, entryId: otherEntry, blockIndex: 0 });
  assert.equal(textOf(crossedBlock), "another conversation's line");
  const unknown = await readConversation(rig.harness, { conversationId: "999999" }).catch(error => error);
  assert.equal((unknown as { code?: string }).code, "not_found");
});

test("the backend route answers the same core read, and a refusal is a code and a status", async (t) => {
  const dbPath = await storePath("http");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  for (let index = 1; index <= 4; index += 1) await appendUser(seed.harness, conversation.id, "row " + index);
  const imageEntry = await seed.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const imageId = String(imageEntry.id);
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const page = await httpRead(origin, id, "offset=2&limit=2");
  assert.equal(page.status, 200);
  assert.equal(page.body.protocol, "hepi.v1");
  assert.deepEqual(page.body.output, [{ type: "text", text: "row 2\nrow 3" }]);
  const details = page.body.details as { offset: number; limit: number; hasMore: boolean; next: Record<string, unknown> };
  assert.equal(details.offset, 2);
  assert.equal(details.limit, 2);
  assert.equal(details.hasMore, true);

  // The continuation the route returned is the continuation the route accepts, round-tripped as JSON.
  const continued = await httpRead(origin, id, "limit=2&cursor=" + encodeURIComponent(JSON.stringify(details.next)));
  assert.equal(continued.status, 200);
  assert.deepEqual(continued.body.output, [{ type: "text", text: "row 4" }]);

  // Refusals keep the core's own codes.
  const badLimit = await httpRead(origin, id, "limit=0");
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.body.code, "invalid_request");
  const badCursor = await httpRead(origin, id, "cursor=not-json");
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.code, "invalid_request");
  const staleCursor = await httpRead(origin, id, "cursor=" + encodeURIComponent(JSON.stringify({ ...details.next, version: 99 })));
  assert.equal(staleCursor.status, 409);
  assert.equal(staleCursor.body.code, "version_mismatch");
  const unknownEntry = await httpRead(origin, id, "entryId=999999");
  assert.equal(unknownEntry.status, 404);
  assert.equal(unknownEntry.body.code, "not_found");

  // A block read over HTTP answers the image as the core does.
  const image = await httpRead(origin, id, "entryId=" + imageId + "&blockIndex=0");
  assert.equal(image.status, 200);
  assert.deepEqual(image.body.output, [{ type: "image", data: PNG, mimeType: "image/png" }]);

  // The route sits behind the same token as every other conversation route.
  const unauthorized = await fetch(origin + "/api/conversations/" + id + "/read");
  assert.equal(unauthorized.status, 401);
});
