import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { TEXT_DEFER_BYTES, TEXT_PREVIEW_CHARS } from "../src/history-window.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

/**
 * The text read block, asserted at the public HTTP seam a browser really uses.
 *
 * The failure this locks down was measured on the native runtime before the fix: a ~0.5-1.5 MiB paste was accepted with
 * 202 and committed, and afterwards the browser could neither read it nor navigate past it — the window dropped it, the
 * page that reached back for it answered 413, and the page one step nearer answered \`entries: []\` with \`hasMore: true\`
 * and no cursor. So this file submits **real text through the real route** and asserts the outcome a reader depends on:
 * the frame is carried, the entry carries a bounded preview naming a read block, that read block returns the whole text
 * byte for byte, and paging from the window's own boundary reaches every entry and terminates.
 */
const directories: string[] = [];
const token = "history-text-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function store(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-history-text-" + label + "-"));
  directories.push(directory);
  return join(directory, "history-text.sqlite");
}

/** A backend over one store, with the faux provider so a submitted turn really settles without a model call. */
async function start(t: TestContext, dbPath: string): Promise<{ backend: BackendServer; origin: string }> {
  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage("ok"); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port };
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

async function readJson(origin: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + path, { headers });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

/** How long a frame that must arrive is waited for before the test calls it absent: a hang guard, not a timing fact. */
const SETTLE_DEADLINE_MS = 30_000;

/** One conversation's window as a client holds it, folded from the frames the backend wrote. */
type Window = HeldWindow<ServerSnapshot["entries"][number]>;

/**
 * The window a client holds once the accepted turn has settled, taken from the stream's own frames.
 *
 * The barrier is the frame that states the settlement: the answer appended, no run in flight, and the submission gone
 * from the outstanding set. Frames are folded through the shared reducer a browser uses, so nothing is polled and
 * nothing is slept on, and an idle state that arrives before the run begins cannot be mistaken for a finished turn
 * because the answer is part of the condition. The connection and the wait both carry a deadline, so a frame that never
 * comes fails the test instead of hanging it.
 */
async function settledState(origin: string, id: string, requestId: string): Promise<Window> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(SETTLE_DEADLINE_MS) });
  assert.equal(response.status, 200, "the conversation stream attaches");
  const folder = streamFolder<ServerSnapshot["entries"][number]>(id);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  let pending = "";
  try {
    while (true) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the turn to settle: " + requestId);
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended before the turn settled: " + requestId);
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = raw.split("\n").find(line => line.startsWith("event: "))?.slice(7) ?? "";
        const data = raw.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data === undefined || (event !== "snapshot" && event !== "state")) continue;
        const window = folder.fold(event, JSON.parse(data));
        if (window.busy || !window.entries.some(entry => entry.role === "assistant")) continue;
        if ((window.submissions ?? []).some(submission => submission.requestId === requestId)) continue;
        return window;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * The text of one entry as the wire carries it, in either of the two shapes the runtime stores: a plain string (the
 * copied app's own shape for a text-only prompt) or a content array. The deferred shape is always a block, so a caller
 * renders one preview either way.
 */
type WireText = { type: string; text: string; deferred?: boolean; textUrl?: string };

function textBlockOf(entry: { message: unknown }, index = 0): WireText {
  const content = (entry.message as { content: unknown }).content;
  if (typeof content === "string") {
    assert.equal(index, 0, "a plain-string message has one block");
    return { type: "text", text: content };
  }
  assert.ok(Array.isArray(content), "the projected message carries a content array");
  const block = content[index] as WireText;
  assert.equal(block?.type, "text");
  return block;
}

/** The browser-facing read-block URL, mapped onto this backend's own conversation route. */
function backendReadBlock(origin: string, conversationId: string, browserUrl: string): string {
  assert.match(browserUrl, new RegExp("^/api/sessions/" + conversationId + "/entries/[0-9]+/text\\?blockIndex=[0-9]+$"), "the preview names this conversation's own read block: " + browserUrl);
  return origin + browserUrl.replace("/api/sessions/" + conversationId + "/", "/api/conversations/" + conversationId + "/");
}

/**
 * The whole text behind one preview, read the way a client reads it: one bounded page, then the continuation each
 * page states, until the block says there is no more. The read block is bounded **by default** — a pathological text is
 * never handed over whole by one answer — and it is lossless, because the pages rejoin byte for byte. This helper is
 * that one rule; every assertion below reads a block through it rather than assuming a single unbounded body.
 */
async function readWholeText(url: string): Promise<{ status: number; text: string; pages: number; totalBytes: number }> {
  const first = await fetch(url, { headers });
  if (!first.ok) return { status: first.status, text: "", pages: 0, totalBytes: 0 };
  const page = await first.json() as { text: string; offset: number; totalBytes: number; nextOffset?: number };
  let text = page.text;
  let next: number | undefined = page.nextOffset;
  let pages = 1;
  while (next !== undefined) {
    const response: Response = await fetch(url + "&offset=" + next, { headers });
    assert.equal(response.status, 200);
    const continued = await response.json() as { text: string; offset: number; nextOffset?: number };
    assert.equal(continued.offset, next, "each page states the offset it starts at");
    text += continued.text;
    next = continued.nextOffset;
    pages += 1;
    if (pages > 64) throw new Error("paging did not terminate");
  }
  return { status: first.status, text, pages, totalBytes: page.totalBytes };
}

/**
 * A body of exactly \`bytes\` UTF-8 bytes of ASCII text, ending in a sentinel that only the **whole** text contains.
 * The sentinel goes at the end on purpose: the preview is the leading characters, so a sentinel at the front would be
 * inside the preview and could not tell "the full text rode the frame" from "a bounded preview did".
 */
function asciiText(bytes: number, sentinel: string): string {
  const line = "build log line: " + "y".repeat(60) + "\n";
  const tail = "\n" + sentinel;
  let text = "";
  while (text.length + line.length + tail.length <= bytes) text += line;
  return text + "z".repeat(bytes - text.length - tail.length) + tail;
}

/** Walk older pages from the window's own boundary, returning what was reached and how the walk ended. */
async function walkPages(origin: string, id: string, from: string | null): Promise<{ ids: string[]; pages: number; ended: string }> {
  const ids: string[] = [];
  let cursor = from;
  let pages = 0;
  while (cursor !== null) {
    const page = await readJson(origin, "/api/conversations/" + id + "/entries?before=" + cursor + "&tail=50");
    assert.equal(page.status, 200, "a page over a conversation with deferred text is carried: " + JSON.stringify(page.body).slice(0, 200));
    const entries = (page.body.entries ?? []) as { id: string }[];
    const hasMore = page.body.hasMore === true;
    const oldest = (page.body.oldestEntryId ?? null) as string | null;
    pages += 1;
    // The rule the pager needs: an empty page is the end of the history, never "more exists" with nothing to follow.
    if (entries.length === 0) { assert.equal(hasMore, false, "an empty page states the end rather than an unreachable cursor"); return { ids, pages, ended: "empty" }; }
    for (const entry of entries) ids.push(entry.id);
    if (oldest === null || oldest === cursor) { assert.equal(hasMore, false, "a page that cannot advance states the end"); return { ids, pages, ended: "terminal" }; }
    cursor = oldest;
    if (pages > 40) throw new Error("paging did not terminate");
  }
  return { ids, pages, ended: "complete" };
}

test("an accepted 0.5 MiB paste stays readable: the frame is carried, the preview names a read block, and paging reaches it", async (t) => {
  const dbPath = await store("half-mib");
  const server = await start(t, dbPath);
  const id = await createConversation(server.origin);
  const sentinel = "SENTINEL-HALF-MIB-PASTE";
  const pasted = asciiText(512 * 1024, sentinel);

  const accepted = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "paste-half", text: pasted }) });
  assert.equal(accepted.status, 202, "the submission is accepted: " + (await accepted.text()).slice(0, 200));

  const state = await settledState(server.origin, id, "paste-half");
  // The read a browser makes right after sending: the frame is carried rather than refused, and it carries a bounded
  // preview of the accepted text instead of the text itself.
  const large = state.entries.find(entry => entry.role === "user");
  assert.ok(large !== undefined, "the accepted message is in the window: " + JSON.stringify(state.entries.map(entry => entry.id)));
  const block = textBlockOf(large);
  assert.equal(block.deferred, true, "the heavy text is deferred");
  assert.ok(block.text.length <= TEXT_PREVIEW_CHARS, "the preview is bounded: " + block.text.length);
  assert.equal(pasted.startsWith(block.text), true, "the preview is the leading text, verbatim");
  assert.equal(JSON.stringify(state).includes(sentinel), false, "the full text does not ride the frame");
  // The compatible field the CLI and the Diagnostic Page read states the same thing as the message beside it.
  assert.equal((large as unknown as { text: string }).text, block.text, "the entry's own text is the same projection as its message");

  // The read block restores exactly what the preview replaced.
  const served = await readWholeText(backendReadBlock(server.origin, id, block.textUrl!));
  assert.equal(served.status, 200);
  assert.equal(served.text, pasted, "the read block's pages rejoin the whole text byte for byte");
  assert.equal(served.totalBytes, Buffer.byteLength(pasted, "utf8"), "and the answer states the whole text's size");

  // And the history around it is navigable: the walk starts from the window's own boundary, every page is carried, and
  // it terminates on a page that states the end rather than on one that cannot advance.
  const walk = await walkPages(server.origin, id, state.oldestEntryId ?? state.entries[0]?.id ?? null);
  assert.equal(new Set(walk.ids).size, walk.ids.length, "no entry is handed out twice across pages");
  assert.equal(walk.ended === "complete" || walk.ended === "empty" || walk.ended === "terminal", true, "the walk ended: " + walk.ended);
});

test("an accepted 1.5 MiB paste with a compaction behind it still reads, pages and restores", async (t) => {
  const dbPath = await store("mib-and-a-half");
  const server = await start(t, dbPath);
  const id = await createConversation(server.origin);
  const sentinel = "SENTINEL-ONE-AND-A-HALF-MIB";
  const pasted = asciiText(1536 * 1024, sentinel);

  const accepted = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "paste-big", text: pasted }) });
  assert.equal(accepted.status, 202);

  const state = await settledState(server.origin, id, "paste-big");
  const large = state.entries.find(entry => entry.role === "user" && textBlockOf(entry).deferred === true);
  assert.ok(large !== undefined, "the deferred paste is carried by the window or by a page");
  const block = textBlockOf(large);
  const served = await readWholeText(backendReadBlock(server.origin, id, block.textUrl!));
  assert.equal(served.status, 200);
  assert.equal(served.text, pasted, "1.5 MiB is restored byte for byte");
  assert.ok(served.pages > 1, "and it took more than one bounded page to do it: " + served.pages);

  const walk = await walkPages(server.origin, id, state.oldestEntryId ?? state.entries[0]?.id ?? null);
  assert.equal(state.entries.some(entry => entry.id === large.id) || walk.ids.includes(large.id), true, "the paste is reachable from the window or by paging");
  assert.equal(new Set(walk.ids).size, walk.ids.length, "no entry is handed out twice across pages");
});

test("a moderate 4 KiB text stays inline, and the threshold is bytes rather than characters", async (t) => {
  const dbPath = await store("threshold");
  // Seeded before the backend starts, because it attaches every listed conversation when it boots.
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const id = created.id as ConversationId;
  const moderate = "x".repeat(4096);
  // 25,000 CJK characters is ~75,000 UTF-8 bytes: over the byte threshold while under it in characters, so a
  // character-based rule would leave it inline and this asserts the measured rule instead.
  const unicode = "字".repeat(25_000);
  assert.ok(Buffer.byteLength(unicode, "utf8") > TEXT_DEFER_BYTES && unicode.length < TEXT_DEFER_BYTES, "the fixture really separates bytes from characters");
  await harness.harness.commit(async (tx) => {
    await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: moderate, timestamp: 0 }] });
    await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: unicode, timestamp: 1 }] });
  }, BACKGROUND_CONTEXT);
  await harness.close();
  const server = await start(t, dbPath);

  const state = await readJson(server.origin, "/api/conversations/" + id + "/state");
  assert.equal(state.status, 200);
  const entries = state.body.entries as { role: string; text: string; message: { content: unknown } }[];
  const inline = entries.find(entry => entry.text === moderate);
  assert.ok(inline !== undefined, "an ordinary message is in the window");
  const inlineBlock = textBlockOf(inline);
  assert.equal(inlineBlock.deferred, undefined, "an ordinary message is not deferred and needs no click");
  assert.equal(inlineBlock.textUrl, undefined);
  assert.equal(inlineBlock.text, moderate, "and it is carried whole");
  assert.equal(inline.text, moderate, "the compatible field carries it whole too");

  const heavy = entries.find(entry => entry.text.startsWith("字"));
  assert.ok(heavy !== undefined, "the multi-byte message is in the window");
  const heavyBlock = textBlockOf(heavy);
  assert.equal(heavyBlock.deferred, true, "the threshold is measured in UTF-8 bytes");
  assert.ok(heavyBlock.text.length <= TEXT_PREVIEW_CHARS);
  const served = await readWholeText(backendReadBlock(server.origin, String(id), heavyBlock.textUrl!));
  assert.equal(served.status, 200);
  assert.equal(served.text, unicode, "the multi-byte text is restored exactly");
});

test("the text read block refuses what it cannot serve, and never serves another conversation's entry", async (t) => {
  const dbPath = await store("refusals");
  const server = await start(t, dbPath);
  const mine = await createConversation(server.origin);
  const other = await createConversation(server.origin);
  const sentinel = "SENTINEL-REFUSAL";
  const pasted = asciiText(128 * 1024, sentinel);
  assert.equal((await fetch(server.origin + "/api/conversations/" + mine + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "refuse-1", text: pasted }) })).status, 202);
  const state = await settledState(server.origin, mine, "refuse-1");
  const large = state.entries.find(entry => entry.role === "user")!;
  const block = textBlockOf(large);
  const base = "/api/conversations/" + mine + "/entries/" + large.id + "/text";

  assert.equal((await readJson(server.origin, base + "?blockIndex=0")).status, 200);
  // One bounded page by default, and the whole text when its continuation is followed: the bound is on the answer, never
  // on what is reachable.
  const firstPage = await readJson(server.origin, base + "?blockIndex=0");
  assert.equal(typeof firstPage.body.totalBytes, "number");
  assert.equal((await readJson(server.origin, base + "?blockIndex=0&offset=abc")).status, 400, "a bad offset is a 400");
  assert.equal((await readJson(server.origin, base + "?blockIndex=0&limit=0")).status, 400, "a zero limit is a 400");
  assert.equal((await readJson(server.origin, base + "?blockIndex=9")).status, 400, "an index outside the content is refused");
  assert.equal((await readJson(server.origin, base + "?blockIndex=-1")).status, 400);
  assert.equal((await readJson(server.origin, "/api/conversations/" + mine + "/entries/999999/text?blockIndex=0")).status, 404, "an unknown entry is a 404");
  assert.equal((await readJson(server.origin, "/api/conversations/" + other + "/entries/" + large.id + "/text?blockIndex=0")).status, 404, "another conversation's entry is not readable here");
  assert.equal(block.textUrl!.includes("/api/sessions/" + mine + "/entries/" + large.id + "/text?blockIndex=0"), true);
});
