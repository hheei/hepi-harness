import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createEchoFauxProvider, SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { openServerHarness } from "../src/harness.ts";
import { SEARCH_LIMITS, SearchQueryTooLong, searchConversationBodies } from "../src/session-search.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
const token = "search-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The real backend over a real store, with the offline scripted provider: no credential, no paid call. */
async function start(t: TestContext): Promise<{ backend: BackendServer; origin: string; dbPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-search-"));
  directories.push(directory);
  const dbPath = join(directory, "search.sqlite");
  const models = createModels();
  models.setProvider(createEchoFauxProvider().provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  const origin = "http://127.0.0.1:" + address.port;
  return { backend, origin, dbPath };
}

type Row = { id: string; title: string | null; messageCount: number; firstMessage: string };
type Hit = { conversationId: string; entryId: string; blockIndex: number; before: string; match: string; after: string; session: Row };
type Answer = { results: Hit[]; truncated: boolean };

const search = async (origin: string, query: string): Promise<{ status: number; body: Answer & { code?: string; error?: string } }> => {
  const response = await fetch(origin + "/api/search?" + new URLSearchParams({ q: query }), { headers });
  return { status: response.status, body: await response.json() as Answer & { code?: string; error?: string } };
};
async function create(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { conversationId: string }).conversationId;
}
type Entry = { id: string; role: string; text: string };
type Snapshot = { entries: Entry[] };
async function state(origin: string, id: string): Promise<Snapshot> {
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/state", { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as Snapshot;
}

/** One frame as the backend wrote it, and the state a client holds after folding it. */
type Observed = { readonly event: string; readonly window: HeldWindow<Entry> };
/** A hang guard, not a timing fact: the wait below settles on a frame the backend wrote. */
const DEADLINE_MS = 10_000;

/**
 * A conversation's event stream, waited on by **barrier** instead of by poll: `until` resolves on the frame that
 * satisfies the predicate, folded through the shared reducer a real client uses, so the transcript a test reads is the
 * one the backend published. A stream that ends before the frame fails the test instead of hanging it.
 */
async function follow(origin: string, id: string): Promise<{ until(predicate: (frame: Observed) => boolean, description: string): Promise<Observed>; close(): Promise<void> }> {
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/events", { headers });
  assert.equal(response.status, 200);
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  const frames: Observed[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  let pending = "";
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const pump = (async () => {
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const line = raw.split("\n").find((value) => value.startsWith("data: "));
        if (event === undefined || line === undefined) continue;
        const data = JSON.parse(line.slice(6));
        if (event === "snapshot" || event === "state") folder.fold(event, data);
        frames.push({ event, window: folder.current() });
        wake();
      }
    }
  })().finally(() => { ended = true; wake(); });
  return {
    until(predicate, description) {
      return new Promise<Observed>((resolve, reject) => {
        const settle = (): void => {
          const at = frames.findIndex(predicate);
          if (at >= 0) { clearTimeout(timer); waiters.delete(settle); resolve(frames.splice(at, 1)[0]!); return; }
          if (!ended) return;
          clearTimeout(timer); waiters.delete(settle);
          reject(new Error("the stream ended before " + description + "; frames: " + frames.map((frame) => frame.event).join(",")));
        };
        const timer = setTimeout(() => { waiters.delete(settle); reject(new Error("timed out waiting for " + description + "; frames: " + frames.map((frame) => frame.event).join(","))); }, DEADLINE_MS);
        waiters.add(settle);
        settle();
      });
    },
    async close() { waiters.clear(); await body.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

/** One settled turn: the transcript is durable before the search that must find it. */
async function say(origin: string, id: string, requestId: string, text: string): Promise<void> {
  const submit = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
  assert.equal(submit.status, 202, submit.status === 202 ? "" : await submit.text());
  const { submissionId } = await submit.json() as { submissionId: string };
  // The stream is attached after the submit was answered, so its baseline is the state of this turn: the wait is for
  // the frame that states the run ended, not for a delay long enough to be likely.
  const events = await follow(origin, id);
  try {
    await events.until((frame) => !frame.window.busy && (frame.window.submissions ?? []).every((submission) => submission.submissionId !== submissionId), "the turn of " + JSON.stringify(text) + " to settle");
  } finally { await events.close(); }
}

test("a match deep in a conversation's body answers that session and its excerpt, and opening it reaches the entry", async (t) => {
  const server = await start(t);
  const deep = await create(server.origin);
  const other = await create(server.origin);
  await say(server.origin, deep, "turn-1", "the first turn says alpha");
  await say(server.origin, other, "turn-2", "an unrelated turn");
  await say(server.origin, deep, "turn-3", "a later turn holds the needle phrase");
  await say(server.origin, deep, "turn-4", "the last turn says omega");

  const found = await search(server.origin, "  NEEDLE  ");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.results.map(hit => hit.conversationId), [deep], "only the conversation whose body holds the phrase is a result");
  assert.equal(found.body.truncated, false);
  const hit = found.body.results[0];
  assert.equal(hit.match, "needle", "the match is the text as it appears, not the query as it was typed");
  assert.ok(hit.before.includes("later turn holds the"), "the excerpt carries what precedes the match: " + JSON.stringify(hit));
  assert.ok(hit.after.includes("phrase"), "the excerpt carries what follows the match: " + JSON.stringify(hit));
  // The result names the session and the entry it is in, so opening it reaches the turn rather than the session's top.
  assert.equal(hit.session.id, deep);
  assert.equal(hit.session.firstMessage, "the first turn says alpha");
  const transcript = await state(server.origin, deep);
  const entry = transcript.entries.find(item => item.id === hit.entryId);
  assert.equal(entry?.text, "a later turn holds the needle phrase");
  assert.equal(hit.blockIndex, 0);

  // Literal search with offsets in the original text: every regex operator is a character to find.
  await say(server.origin, deep, "turn-5", "operators (a+)+$ and [test].* stay literal");
  assert.equal((await search(server.origin, "(a+)+$")).body.results[0].match, "(a+)+$");
  assert.equal((await search(server.origin, "[test].*")).body.results[0].match, "[test].*");

  // An empty query is an empty answer, not a scan of everything.
  assert.deepEqual((await search(server.origin, "   ")).body.results, []);
});

test("a removed session never appears in results", async (t) => {
  const server = await start(t);
  const removed = await create(server.origin);
  const kept = await create(server.origin);
  await say(server.origin, removed, "turn-1", "a shared phrase in the removed session");
  await say(server.origin, kept, "turn-2", "a shared phrase in the kept session");
  assert.deepEqual((await search(server.origin, "shared phrase")).body.results.map(hit => hit.session.id).sort(), [removed, kept].sort());

  const deletion = await fetch(server.origin + "/api/conversations/" + encodeURIComponent(removed), { method: "DELETE", headers });
  assert.equal(deletion.status, 200);
  // The records are retained, so the phrase is still in the store; the removal is what takes it out of the results.
  assert.ok((await state(server.origin, removed)).entries.some(item => item.text.includes("shared phrase")));
  assert.deepEqual((await search(server.origin, "shared phrase")).body.results.map(hit => hit.session.id), [kept]);
});

test("an over-long query is refused with a readable reason instead of a silent empty result", async (t) => {
  const server = await start(t);
  const id = await create(server.origin);
  await say(server.origin, id, "turn-1", "findable text");

  const refused = await search(server.origin, "x".repeat(SEARCH_LIMITS.maxQueryChars + 1));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "query_too_long");
  assert.match(refused.body.error ?? "", /at most 200 characters/);
  // A refusal is a refusal: it carries no results field at all, so it cannot be read as "searched, found nothing".
  assert.equal(refused.body.results, undefined);
  // The bound itself is the upstream one, and a query at it is answered rather than refused.
  assert.equal((await search(server.origin, "x".repeat(SEARCH_LIMITS.maxQueryChars))).status, 200);
  assert.equal((await search(server.origin, "findable")).status, 200);
});

test("there is no index: an entry appended after a search is found by the next search, with nothing rebuilt", async (t) => {
  const server = await start(t);
  const id = await create(server.origin);
  await say(server.origin, id, "turn-1", "the first turn");
  assert.deepEqual((await search(server.origin, "appended afterwards")).body.results, []);

  await say(server.origin, id, "turn-2", "appended afterwards");
  assert.deepEqual((await search(server.origin, "appended afterwards")).body.results.map(hit => hit.entryId).length, 1);

  // A conversation created after a search is searched too: the candidate list is read per search, not remembered.
  const later = await create(server.origin);
  await say(server.origin, later, "turn-3", "appended afterwards");
  assert.deepEqual((await search(server.origin, "appended afterwards")).body.results.map(hit => hit.session.id).sort(), [id, later].sort());
});

test("the result bound is reported as truncation, and the search stays within it", { timeout: 60000 }, async (t) => {
  const server = await start(t);
  const ids: string[] = [];
  for (let index = 0; index < SEARCH_LIMITS.maxResults + 1; index += 1) {
    const id = await create(server.origin);
    await say(server.origin, id, "turn-" + index, "a phrase every session holds");
    ids.push(id);
  }
  const found = await search(server.origin, "a phrase every session holds");
  assert.equal(found.status, 200);
  assert.equal(found.body.results.length, SEARCH_LIMITS.maxResults, "the result count is bounded");
  assert.equal(found.body.truncated, true, "hitting the bound is reported rather than passed off as the whole answer");
  // Newest first, as upstream reads its files: the conversation that was not reached is the oldest.
  assert.equal(found.body.results.some(hit => hit.session.id === ids[0]), false);
  assert.deepEqual(found.body.results.map(hit => hit.session.id), [...ids].slice(1).reverse());
});

/**
 * The reading half, and the bounds, are exercised against the runtime itself: the module is the seam that reads a
 * conversation's entries, and a bound is only a bound if the caller is told it was hit.
 */
async function seeded(t: TestContext, texts: readonly (readonly string[])[]): Promise<{ harness: Awaited<ReturnType<typeof openServerHarness>>; conversations: Conversation[] }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-search-seed-"));
  directories.push(directory);
  const harness = await openServerHarness(join(directory, "seed.sqlite"), undefined, fauxModels(), undefined, { startPaused: true });
  t.after(() => harness.close());
  const conversations: Conversation[] = [];
  for (const conversationTexts of texts) {
    const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const id = created.id as ConversationId;
    for (const [index, text] of conversationTexts.entries()) {
      // Entries are appended through the runtime's own public write path, so the read under test is the same one a
      // conversation's own history is read through.
      const user = index % 2 === 0;
      await harness.harness.commit(tx => tx.appendEntry(user ? UserEntry : AssistantEntry, id, { model: [user ? { role: "user", content: text, timestamp: 0 } : fauxAssistantMessage(text)] }), BACKGROUND_CONTEXT);
    }
    const conversation = await harness.harness.conversation(id, BACKGROUND_CONTEXT);
    assert.ok(conversation !== undefined);
    conversations.push(conversation);
  }
  return { harness, conversations };
}

test("reads whole bodies through the runtime's paginated entry reads, one result per conversation, newest first", async (t) => {
  const { conversations } = await seeded(t, [
    ["older: no match here", "older: the needle"],
    ["newer: the needle", "newer: no match"],
  ]);
  const found = await searchConversationBodies(conversations, "needle");
  assert.deepEqual(found.results.map(hit => hit.conversationId), conversations.map(item => String(item.id)).reverse());
  // One result per conversation: the second conversation mentions the needle twice and is not listed twice.
  assert.equal(found.results.length, 2);
  assert.equal(found.truncated, false);
  const newest = found.results[0];
  assert.equal(newest.match, "needle");
  assert.equal(newest.before, "newer: the ");
  assert.equal(newest.after, "");
  assert.equal((await searchConversationBodies(conversations, "  ")).results.length, 0);
});

test("searches user and assistant text only, and keeps Unicode offsets correct", async (t) => {
  const { harness, conversations } = await seeded(t, [["中文 NEEDLE 中文"]]);
  const id = conversations[0].id as ConversationId;
  // A tool result and a compaction summary are not what a user remembers writing or reading, so they are not searched.
  await harness.harness.commit(async (tx) => {
    await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "needle from a tool" }], timestamp: 0, isError: false }], data: { diagnostics: [] } });
    await tx.appendEntry(CompactionEntry, id, { model: [{ role: "user", content: "a compaction summary holding needle", timestamp: 0 }], data: { reason: "threshold" } });
  }, BACKGROUND_CONTEXT);
  const reloaded = await harness.harness.conversation(id, BACKGROUND_CONTEXT);
  assert.ok(reloaded !== undefined);

  const found = await searchConversationBodies([reloaded], "needle");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].match, "NEEDLE");
  assert.equal(found.results[0].before, "中文 ");
  assert.equal(found.results[0].after, " 中文");
  assert.equal((await searchConversationBodies([reloaded], "tool")).results.length, 0, "a tool result's text is not searched");
  // The compaction summary is a user-role message in the runtime, but it is a compaction entry and is left out, as
  // upstream leaves its own compaction lines out.
  assert.equal((await searchConversationBodies([reloaded], "compaction summary")).results.length, 0);
});

test("every upstream bound is applied, and hitting one is reported as truncation", async (t) => {
  const { conversations } = await seeded(t, [["needle one"], ["needle two"], ["needle three"]]);
  const limits = { ...SEARCH_LIMITS, maxResults: 2, maxConversations: 2 };
  const bounded = await searchConversationBodies(conversations, "needle", { limits });
  assert.equal(bounded.results.length, 2);
  assert.equal(bounded.truncated, true);

  // The wall-clock budget, without waiting for it: the clock is the caller's, as the skill repository's cache clock is.
  let calls = 0;
  const expired = await searchConversationBodies(conversations, "needle", { now: () => (calls++ === 0 ? 0 : SEARCH_LIMITS.timeBudgetMs + 1) });
  assert.deepEqual(expired, { results: [], truncated: true });

  // An entry past the per-entry cap is not searched, the caller is told so, and the next entry is still searched.
  const capped = await searchConversationBodies(conversations, "needle", { limits: { ...SEARCH_LIMITS, maxEntryChars: 4 } });
  assert.deepEqual(capped, { results: [], truncated: true });

  // The per-conversation text bound is the same statement about a conversation that is too large to read.
  const byteBounded = await searchConversationBodies(conversations, "needle", { limits: { ...SEARCH_LIMITS, maxConversationBytes: 1 } });
  assert.deepEqual(byteBounded, { results: [], truncated: true });

  await assert.rejects(searchConversationBodies(conversations, "x".repeat(SEARCH_LIMITS.maxQueryChars + 1)), SearchQueryTooLong);
});

test("the matcher, the limits and the response shape are the upstream ones", async () => {
  const upstream = await readFile(new URL("../../../packages/gateway/vendor/pi-web/session-search.ts", import.meta.url), "utf8");
  const upstreamNumber = (name: string): number => {
    const match = upstream.match(new RegExp("const " + name + " = ([0-9 *]+);"));
    assert.ok(match, name + " is not in the vendored upstream matcher");
    return Number(new Function("return " + match[1])());
  };
  assert.equal(SEARCH_LIMITS.maxConversations, upstreamNumber("MAX_FILES"));
  assert.equal(SEARCH_LIMITS.maxResults, upstreamNumber("MAX_RESULTS"));
  assert.equal(SEARCH_LIMITS.maxConversationBytes, upstreamNumber("MAX_FILE_BYTES"));
  assert.equal(SEARCH_LIMITS.maxEntryChars, upstreamNumber("MAX_LINE_CHARS"));
  assert.equal(SEARCH_LIMITS.timeBudgetMs, upstreamNumber("TIME_BUDGET_MS"));
  // Upstream refuses the query at the route and again in the matcher; both say 200 characters.
  assert.match(upstream, /needle\.length > 200\) throw new RangeError\("Search query exceeds 200 characters"\)/);
  assert.equal(SEARCH_LIMITS.maxQueryChars, 200);
  assert.match(upstream, /interface SessionSearchResponse \{\s*results: SessionSearchResult\[\];\s*truncated: boolean;\s*\}/);

  // The reading half is the runtime's own paginated reads and nothing else: no file, no store and no index.
  const seam = await readFile(new URL("../src/session-search.ts", import.meta.url), "utf8");
  assert.match(seam, /conversation\.entries\(\{ order: "ascending" \}, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT\)/);
  assert.doesNotMatch(seam, /createReadStream|readFileSync|openNodeSqliteStorage|new Database|scanEntries\(|SELECT /);
});
