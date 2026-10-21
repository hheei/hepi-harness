/**
 * The navigation outline over a real store and the real route: the same user messages the transcript draws, one
 * anchor each, read from the conversation's **fork-aware committed history** (spec decisions 1–5, 10).
 *
 * Every fixture is written through the runtime's own public transaction seam, exactly as the raw-history read's tests
 * write theirs, and every assertion reads the outline's own answer — its anchors, its ordering cursor, its page
 * bounds, its snapshot and its scope. Nothing here reaches into the module's internals, and no case asks the route to
 * prove an authorization boundary: the ordinary paging, compaction, fork, append and prefix cases are the contract.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, CompactionEntry, ResetEntry, ToolResultEntry, UserEntry, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { ServerEntry } from "@hepi/protocol";
import {
  NAVIGATION_DEFAULT_LIMIT,
  NAVIGATION_MAX_LIMIT,
  NAVIGATION_PAGE_MAX_BYTES,
  NAVIGATION_PREVIEW_MAX_BYTES,
  NAVIGATION_TARGET_DEFAULT_AROUND,
  NAVIGATION_TARGET_MAX_AROUND,
  NAVIGATION_TARGET_MAX_RAW_ENTRIES,
  decodeNavigationAnchor,
  encodeNavigationAnchor,
  parseNavigationPageRequest,
  parseNavigationTargetRequest,
  type NavigationPageRequest,
  type NavigationTargetRequest,
} from "@hepi/protocol/navigation";
import { readNavigationOutline, readNavigationTarget } from "../src/conversation-navigation.ts";
import { openServerHarness } from "../src/harness.ts";
import { rawWindowCap, scopeFromFacts, tokenFromFacts, VISIBLE_WINDOW, type HistoryFacts } from "../src/history-window.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { createBackendServer } from "../src/server.ts";

const directories: string[] = [];
const token = "navigation-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Rig = { readonly harness: Harness; readonly close: () => Promise<void> };

/** A real harness over a native SQLite file, paused so no scheduler runs while a fixture is written. */
async function openStore(label: string): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-navigation-" + label + "-"));
  directories.push(directory);
  const server = await openServerHarness(join(directory, "navigation.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  return { harness: server.harness, close: () => server.close() };
}

async function createConversation(harness: Harness): Promise<Conversation> {
  return await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
}

/** The committed history's two facts, read through the runtime's own scans. */
async function factsOf(harness: Harness, conversationId: ConversationId): Promise<HistoryFacts> {
  const head = await harness.commit(tx => tx.latestHeadMarker(conversationId), BACKGROUND_CONTEXT);
  const newest = await harness.commit(tx => tx.scanEntries({ conversationId, order: "descending" }, 1, undefined), BACKGROUND_CONTEXT);
  return { head: head === undefined ? null : String(head.id), tail: newest.items[0] === undefined ? null : String(newest.items[0]!.id) };
}

/** The identity one conversation's history states, in the two spellings the outline publishes. */
function historyOf(conversation: Conversation, facts: HistoryFacts) {
  const conversationId = String(conversation.id);
  return { conversation, snapshot: tokenFromFacts(conversationId, facts), scope: scopeFromFacts(conversationId, facts), tail: facts.tail };
}

/** One assistant message with the fields the runtime's own assistant entry requires. */
function assistantMessage(text: string) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "faux" as const, provider: "faux", model: "faux-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 0 };
}

async function appendUser(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

async function appendAssistant(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(AssistantEntry, conversationId, { model: [assistantMessage(text)] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/** One tool result — the traffic that sits between two anchors and must not become one. */
async function appendToolResult(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(ToolResultEntry, conversationId, { model: [{ role: "toolResult", toolCallId: "call-" + text, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 }], data: { diagnostics: [] } }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/**
 * A user message as an array of text blocks, the shape a multi-part paste arrives in: a block individually under
 * the projection's deferral threshold stays whole, which is how one entry can outgrow a navigation window.
 */
async function appendUserBlocks(harness: Harness, conversationId: ConversationId, blocks: readonly string[]): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: blocks.map(text => ({ type: "text", text })), timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/**
 * One input placed under an application entry kind, the way a submission with its own `entry` places it (a subagent's
 * report reaches the parent this way). Its model message is still a user message.
 */
async function appendAsApplicationEntry(harness: Harness, conversationId: ConversationId, kind: string, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(conversationId, { kind, model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/**
 * A page request as the contract parses it. The route applies the same rule, so a test that names a size or a cursor
 * states what a caller states on the wire rather than what the core's type happens to accept.
 */
function pageRequest(params: { limit?: number; cursor?: number; scope?: string } = {}): NavigationPageRequest {
  const parsed = parseNavigationPageRequest({
    ...(params.limit === undefined ? {} : { limit: String(params.limit) }),
    ...(params.cursor === undefined ? {} : { cursor: String(params.cursor) }),
    ...(params.scope === undefined ? {} : { scope: params.scope }),
  });
  if (!parsed.ok) throw new Error("the test asked for a page the contract refuses: " + parsed.error);
  return parsed.request;
}

/** One page as the core or the route answered it, with the refusals a caller renders by name. */
type PageBody = {
  protocol: string;
  conversationId: string;
  snapshot: string;
  scope: string;
  order: string;
  anchors: { anchor: string; entryId: string; cursor: number; preview: string }[];
  hasMore: boolean;
  nextCursor?: number;
  capped: boolean;
  prefix?: { kind: string; entries?: number; firstEntryId?: string; lastEntryId?: string };
  bytes: number;
  code?: string;
  error?: string;
};

/** A SQLite file in its own directory, so a fixture can be written before the backend opens it. */
async function storeFile(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-navigation-" + label + "-"));
  directories.push(directory);
  return join(directory, "navigation.sqlite");
}

/** The real backend over one store: the route under test is the one a deployment serves. */
async function startBackend(t: TestContext, dbPath: string): Promise<string> {
  const backend = await createBackendServer({ dbPath, authToken: token, models: fauxModels(), defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return "http://127.0.0.1:" + address.port;
}

async function outline(origin: string, id: string, query = ""): Promise<{ status: number; body: PageBody }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/navigation" + query, { headers });
  return { status: response.status, body: await response.json() as PageBody };
}

/** One target window, or the named refusal the route answered with. */
async function target(origin: string, id: string, query: string): Promise<{ status: number; body: TargetBody }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/navigation/around" + query, { headers });
  return { status: response.status, body: await response.json() as TargetBody };
}

/** The window's answer, or the refusal, as the route writes it. */
type TargetBody = {
  protocol: string;
  conversationId: string;
  snapshot: string;
  scope: string;
  order: string;
  target: { entryId: string; anchor: string; present: boolean; blocks: number[]; blockIndex?: number };
  entries: { id: string; role: string; text: string; message: unknown }[];
  hasOlder: boolean;
  hasNewer: boolean;
  trimmed: boolean;
  olderCursor?: number;
  newerCursor?: number;
  bytes: number;
  code?: string;
  error?: string;
  entryId?: string;
};

/** One conversation, created through the route, so the store and the catalogue agree with a real caller. */
async function createThroughRoute(origin: string, requestId: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ requestId }) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
}

/** Send one turn through the route and wait until its answer is committed. */
async function sendTurn(origin: string, id: string, requestId: string, text: string): Promise<void> {
  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
  assert.equal(accepted.status, 202, await accepted.text());
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
    const snapshot = await state.json() as { entries: { role: string; text: string }[]; busy: boolean };
    if (!snapshot.busy && snapshot.entries.some(entry => entry.role === "assistant" && entry.text.includes(text))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("the turn " + requestId + " never settled");
}

test("one anchor per committed user message, oldest first, with tool and assistant traffic stated as nothing", async (t) => {
  const rig = await openStore("outline");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const first = await appendUser(rig.harness, conversation.id, "first prompt");
  const answer = await appendAssistant(rig.harness, conversation.id, "an answer that is not a node");
  const traffic = await appendToolResult(rig.harness, conversation.id, "tool traffic");
  const second = await appendUser(rig.harness, conversation.id, "second prompt");
  const page = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());

  assert.deepEqual(page.anchors.map(anchor => anchor.entryId), [first, second], "only user messages are anchors; " + answer + " and " + traffic + " are not");
  assert.deepEqual(page.anchors.map(anchor => anchor.preview), ["first prompt", "second prompt"]);
  assert.deepEqual(page.anchors.map(anchor => anchor.cursor), [Number(first), Number(second)], "the ordering cursor is the entry's own id, never a list position");
  assert.equal(page.order, "oldest-first");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, undefined, "a page that reached the end states no continuation");
  assert.equal(page.snapshot, String(conversation.id) + "|-" + "|" + second);
  assert.equal(page.scope, String(conversation.id) + "|-");
  assert.deepEqual(page.prefix, { kind: "none" });
  assert.equal(page.bytes <= NAVIGATION_PAGE_MAX_BYTES, true);
});

test("the route serves that page with its stated bounds, and refuses a size it cannot read", async (t) => {
  const dbPath = await storeFile("route");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  // More prompts than a page may carry, so the cap is the answer rather than the conversation being too short for it.
  for (let index = 1; index <= NAVIGATION_MAX_LIMIT + 5; index += 1) await appendUser(seed.harness, conversation.id, "prompt " + index);
  await seed.close();
  const origin = await startBackend(t, dbPath);

  // The default page: the contract's own count, stated as `capped` so a caller can tell a size it asked for from one
  // the deployment imposed, and bounded in bytes whatever the previews hold.
  const page = await outline(origin, id);
  assert.equal(page.status, 200);
  assert.equal(page.body.conversationId, id);
  assert.equal(page.body.anchors.length, NAVIGATION_DEFAULT_LIMIT);
  assert.equal(page.body.capped, true, "the default decided the size");
  assert.equal(page.body.bytes <= NAVIGATION_PAGE_MAX_BYTES, true);
  assert.equal(page.body.hasMore, true);
  assert.deepEqual(page.body.anchors.map(anchor => anchor.preview).slice(0, 2), ["prompt 1", "prompt 2"]);

  const asked = await outline(origin, id, "?limit=2");
  assert.equal(asked.status, 200);
  assert.equal(asked.body.capped, false, "the caller named the size, so the default did not decide it");
  assert.deepEqual(asked.body.anchors.map(anchor => anchor.preview), ["prompt 1", "prompt 2"]);
  assert.equal(asked.body.hasMore, true);
  assert.equal(asked.body.nextCursor, Number(asked.body.anchors.at(-1)!.entryId));

  const overCap = await outline(origin, id, "?limit=100000");
  assert.equal(overCap.body.anchors.length, NAVIGATION_MAX_LIMIT, "a request cannot ask past the cap: it is " + overCap.body.anchors.length);
  assert.equal(overCap.body.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "the cap is not a licence for an unbounded body");

  // A malformed bound is refused, never coerced: a caller must not be handed a page it believes it bounded itself.
  for (const query of ["?limit=0", "?limit=abc", "?cursor=1.5"]) {
    const refused = await outline(origin, id, query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.body.code, "malformed", query);
  }
  const unknown = await outline(origin, "999999");
  assert.equal(unknown.status, 404);
});

test("paging continues from a cursor and visits every anchor exactly once, in order", async (t) => {
  const rig = await openStore("paging");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const ids: string[] = [];
  for (let index = 1; index <= 7; index += 1) {
    // Tool and assistant traffic between prompts is the ordinary shape of an agent turn, and a continuation passes it.
    ids.push(await appendUser(rig.harness, conversation.id, "prompt " + index));
    await appendToolResult(rig.harness, conversation.id, "traffic " + index);
    await appendAssistant(rig.harness, conversation.id, "answer " + index);
  }
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));

  const seen: string[] = [];
  const cursors: (number | undefined)[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = await readNavigationOutline(history, cursor === undefined ? pageRequest({ limit: 3 }) : pageRequest({ limit: 3, cursor }));
    if (cursor !== undefined) assert.equal(page.prefix, undefined, "a continuation never states a range it did not scan");
    seen.push(...page.anchors.map(anchor => anchor.entryId));
    cursors.push(page.nextCursor);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
    assert.notEqual(cursor, undefined, "a page that says more exists hands back the cursor that reaches it");
  }
  assert.deepEqual(seen, ids, "every anchor exactly once, in history order");
  assert.equal(cursors.filter(value => value !== undefined).length, cursors.length - 1, "only the last page states no continuation");
  assert.equal(new Set(cursors).size, cursors.length, "no continuation cursor is ever reused");
});

test("an anchor's coordinate names its conversation, its scope and its entry, and nothing else", async (t) => {
  const rig = await openStore("coordinate");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const entryId = await appendUser(rig.harness, conversation.id, "jump to me");
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));
  const page = await readNavigationOutline(history, pageRequest());
  const decoded = decodeNavigationAnchor(page.anchors[0]!.anchor);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.coordinate, { version: 1, conversationId: String(conversation.id), scope: history.scope, entryId });
});

test("a compaction keeps every committed anchor and retires the pages issued before it", async (t) => {
  const rig = await openStore("compaction");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const dropped = await appendUser(rig.harness, conversation.id, "before the compaction");
  const kept = await appendAssistant(rig.harness, conversation.id, "kept answer");
  const before = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());
  const afterMarker = await appendUser(rig.harness, conversation.id, "after the compaction");
  // The summary itself: a head marker moves the active context, and its model message is a user message.
  const summary = await rig.harness.commit(tx => tx.appendEntry(CompactionEntry, conversation.id, { head: Number(kept) as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  const facts = await factsOf(rig.harness, conversation.id);
  const page = await readNavigationOutline(historyOf(conversation, facts), pageRequest());

  // Decision 2: a compacted user message stays a navigable anchor. Decision 1's identity rule: the summary is a
  // context marker, not a message the user wrote, so it takes no node.
  assert.deepEqual(page.anchors.map(anchor => anchor.entryId), [dropped, afterMarker], "committed anchors survive compaction; the summary does not become an anchor: " + String(summary.id));
  assert.equal(page.anchors[0]!.preview, "before the compaction", "a compacted anchor previews its own committed text, not a projection of the summary");
  // The active range no longer holds `dropped`, so an active-window read could not state it. This one does.
  assert.notEqual(facts.head, null);
  assert.equal(page.scope, String(conversation.id) + "|" + String(summary.id), "the scope names the head marker, so a re-baseline moves it");
  assert.equal(page.snapshot, String(conversation.id) + "|" + String(summary.id) + "|" + String(summary.id), "the snapshot also names the newest committed entry, which is the summary itself");

  // A caller that holds the page issued before the compaction is refused by name, not answered with a nearby anchor.
  const refused = await readNavigationOutline(historyOf(conversation, facts), pageRequest({ scope: before.scope })).catch(error => error);
  assert.equal((refused as { code?: string }).code, "stale-snapshot");
  assert.notEqual(before.scope, page.scope);
  // Every anchor it already holds keeps its identity, because the entry id is the identity and compaction removes none.
  const shared = page.anchors.find(anchor => anchor.entryId === dropped)!;
  assert.notEqual(shared.anchor, before.anchors.find(anchor => anchor.entryId === dropped)!.anchor, "a coordinate is scoped, so a re-baseline issues a fresh one");
});

test("a plain reset also re-baselines the scope and drops nothing from the outline", async (t) => {
  const rig = await openStore("reset");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const first = await appendUser(rig.harness, conversation.id, "prompt before the reset");
  const reset = await rig.harness.commit(tx => tx.appendEntry(ResetEntry, conversation.id, { head: "self" }), BACKGROUND_CONTEXT);
  const second = await appendUser(rig.harness, conversation.id, "prompt after the reset");
  const page = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());
  assert.deepEqual(page.anchors.map(anchor => anchor.entryId), [first, second], "a reset re-baselines the context and takes no anchor away");
  assert.equal(page.scope, String(conversation.id) + "|" + String(reset.id));
  assert.deepEqual(page.prefix, { kind: "none" }, "a reset starts a context and is not a leading range of content the user never wrote");
});

test("a fork inherits its parent's anchors in native order and adds its own at their committed positions", async (t) => {
  const rig = await openStore("fork");
  t.after(() => rig.close());
  const parent = await createConversation(rig.harness);
  const inheritedFirst = await appendUser(rig.harness, parent.id, "inherited one");
  await appendAssistant(rig.harness, parent.id, "an answer both branches share");
  const forkPoint = await appendUser(rig.harness, parent.id, "the turn the fork is taken at");
  const sibling = await appendUser(rig.harness, parent.id, "the parent's own later turn");

  const forked = await parent.fork(Number(forkPoint) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const branchLocal = await appendUser(rig.harness, forked.id, "this branch's own prompt");
  const forkPage = await readNavigationOutline(historyOf(forked, await factsOf(rig.harness, forked.id)), pageRequest());

  assert.deepEqual(forkPage.anchors.map(anchor => anchor.entryId), [inheritedFirst, forkPoint, branchLocal], "inherited anchors keep native history order, and the branch's own follows");
  assert.deepEqual(forkPage.anchors.map(anchor => anchor.preview), ["inherited one", "the turn the fork is taken at", "this branch's own prompt"]);
  assert.equal(forkPage.anchors.some(anchor => anchor.entryId === sibling), false, "a turn the fork did not inherit is not in its outline");
  assert.deepEqual(forkPage.prefix, { kind: "none" });

  // Decision 3: shared entry ids are not a global identity, so the coordinate says which history it was read from.
  assert.equal(forkPage.scope, String(forked.id) + "|-");
  const parentPage = await readNavigationOutline(historyOf(parent, await factsOf(rig.harness, parent.id)), pageRequest());
  assert.notEqual(parentPage.scope, forkPage.scope);
  const decoded = decodeNavigationAnchor(parentPage.anchors[0]!.anchor);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.coordinate.conversationId, String(parent.id));
  assert.equal(decoded.coordinate.entryId, inheritedFirst, "the fork holds the same entry id, so only the coordinate's scope says whose history it was read from");
});

test("an append extends the outline without moving an existing anchor's identity", async (t) => {
  const rig = await openStore("append");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const first = await appendUser(rig.harness, conversation.id, "prompt one");
  const before = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());
  await appendAssistant(rig.harness, conversation.id, "an answer");
  const second = await appendUser(rig.harness, conversation.id, "prompt two");
  const after = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());

  assert.equal(after.anchors.length, before.anchors.length + 1);
  assert.equal(after.anchors[0]!.entryId, first);
  assert.equal(after.anchors[0]!.anchor, before.anchors[0]!.anchor, "an existing anchor keeps its coordinate across an append");
  assert.equal(after.anchors[1]!.entryId, second);
  assert.notEqual(after.snapshot, before.snapshot, "the snapshot does move, which is what tells a caller to extend its pages");
  assert.equal(after.scope, before.scope, "and the scope does not: an append re-baselines nothing");
});

test("an assistant-only prefix is stated as a range, and a leading application-kind input keeps its node", async (t) => {
  const rig = await openStore("prefix");
  t.after(() => rig.close());

  // A history that opens with output the user never wrote: the rail gets no node for it, and the range is named by the
  // entries it holds rather than by a positional id.
  const leading = await createConversation(rig.harness);
  const greeting = await appendAssistant(rig.harness, leading.id, "a greeting with no prompt behind it");
  const firstPrompt = await appendUser(rig.harness, leading.id, "the first real prompt");
  const page = await readNavigationOutline(historyOf(leading, await factsOf(rig.harness, leading.id)), pageRequest());
  assert.deepEqual(page.anchors.map(anchor => anchor.entryId), [firstPrompt]);
  assert.deepEqual(page.prefix, { kind: "non-user", entries: 1, firstEntryId: greeting, lastEntryId: greeting });

  // A wider leading run of tool traffic, and an input placed under an application kind (a subagent's report), which is
  // the user message the transcript shows and so keeps its node instead of becoming a prefix.
  const reported = await createConversation(rig.harness);
  const traffic = await appendToolResult(rig.harness, reported.id, "traffic before any prompt");
  const second = await appendToolResult(rig.harness, reported.id, "more traffic");
  const report = await appendAsApplicationEntry(rig.harness, reported.id, "hepi.agent-report", "a child's report");
  const reportPage = await readNavigationOutline(historyOf(reported, await factsOf(rig.harness, reported.id)), pageRequest());
  assert.deepEqual(reportPage.anchors.map(anchor => anchor.entryId), [report], "an application-kind user input is still a user message");
  assert.deepEqual(reportPage.prefix, { kind: "non-user", entries: 2, firstEntryId: traffic, lastEntryId: second });

  // A conversation with nothing at all answers an empty outline and no fabricated anchor.
  const empty = await createConversation(rig.harness);
  const emptyPage = await readNavigationOutline(historyOf(empty, await factsOf(rig.harness, empty.id)), pageRequest());
  assert.deepEqual(emptyPage.anchors, []);
  assert.equal(emptyPage.snapshot, String(empty.id) + "|-|-");
  assert.deepEqual(emptyPage.prefix, { kind: "none" });
});

test("a page of full-cap previews is bounded by bytes, and one huge message cannot make it unbounded", async (t) => {
  const rig = await openStore("budget");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  // The worst case the cap allows: every anchor's preview is exactly the maximum, in multibyte text.
  const long = "字".repeat(NAVIGATION_PREVIEW_MAX_BYTES);
  for (let index = 0; index < NAVIGATION_MAX_LIMIT; index += 1) await appendUser(rig.harness, conversation.id, long + " " + index);
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));

  const page = await readNavigationOutline(history, pageRequest({ limit: NAVIGATION_MAX_LIMIT }));
  assert.equal(page.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "a page never outgrows its budget: " + page.bytes);
  assert.equal(page.anchors.length < NAVIGATION_MAX_LIMIT, true, "the byte budget, not the count, cut it short: " + page.anchors.length);
  assert.equal(page.hasMore, true, "a page the budget shortened says more exists");
  assert.equal(page.nextCursor, page.anchors.at(-1)!.cursor, "and hands back the cursor that reaches what it dropped");

  const byDefault = await readNavigationOutline(history, pageRequest());
  assert.equal(byDefault.anchors.length <= NAVIGATION_DEFAULT_LIMIT, true);
  assert.equal(Buffer.byteLength(byDefault.anchors[0]!.preview, "utf8"), NAVIGATION_PREVIEW_MAX_BYTES, "one oversized prompt is capped, so a message's size cannot bound a page out");
});

test("a scope from another conversation is refused as the wrong-scope it is", async (t) => {
  const dbPath = await storeFile("scope");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const source = await createConversation(seed.harness);
  await appendUser(seed.harness, source.id, "a prompt in the seeded conversation");
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const first = await createThroughRoute(origin, "scope-first");
  const second = await createThroughRoute(origin, "scope-second");
  const page = await outline(origin, first);
  assert.equal(page.status, 200);
  assert.equal(page.body.scope, first + "|-");

  // Two named refusals, because a caller renders them differently: this one is the caller addressing the wrong
  // history, and a re-baseline of the right one is `stale-snapshot` (asserted above at the core seam).
  const crossed = await outline(origin, second, "?scope=" + encodeURIComponent(page.body.scope));
  assert.equal(crossed.status, 409);
  assert.equal(crossed.body.code, "wrong-scope");
});

test("a turn committed while a caller pages extends the outline and moves no anchor", { timeout: 60000 }, async (t) => {
  const dbPath = await storeFile("live");
  const origin = await startBackend(t, dbPath);
  const id = await createThroughRoute(origin, "live-conversation");
  await sendTurn(origin, id, "live-one", "first thing to say");
  await sendTurn(origin, id, "live-two", "second thing to say");

  const first = await outline(origin, id, "?limit=1");
  assert.deepEqual(first.body.anchors.map(anchor => anchor.preview), ["first thing to say"]);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextCursor, Number(first.body.anchors[0]!.entryId));
  const boundary = first.body.nextCursor!;
  const snapshot = first.body.snapshot;
  const heldAnchor = first.body.anchors[0]!.anchor;

  // The ordinary case the spec names: the conversation grows while a rail is paging. The anchor already held keeps its
  // identity, the continuation is the anchor that follows it in history order, and the new turn is a newer one.
  await sendTurn(origin, id, "live-three", "third thing to say");
  const continued = await outline(origin, id, "?limit=1&cursor=" + boundary);
  assert.deepEqual(continued.body.anchors.map(anchor => anchor.preview), ["second thing to say"], "a continued page is the next anchor, not the turn that arrived last");
  assert.notEqual(continued.body.snapshot, snapshot, "the page states the snapshot it actually read");
  assert.equal(continued.body.scope, first.body.scope, "and the scope did not move, because an append re-baselines nothing");

  const whole = await outline(origin, id);
  assert.deepEqual(whole.body.anchors.map(anchor => anchor.preview), ["first thing to say", "second thing to say", "third thing to say"], "the model's answers are not anchors: " + JSON.stringify(whole.body.anchors));
  const reRead = await outline(origin, id, "?limit=1");
  assert.equal(reRead.body.anchors[0]!.anchor, heldAnchor, "one anchor is one identity, however many pages and turns reach it");
});

/**
 * The bounded target window: one anchor's committed history around it, from the same record and the same identities
 * the outline page uses (spec decisions 6, 8, 9, and ticket 02's acceptance list).
 *
 * The fixtures keep the outline's shape — real harnesses, real commits, the route's own HTTP answers — and add the one
 * thing the outline never needed: the transcript's own projection, handed in the way `server.ts` hands it. Every
 * assertion reads the window's own answer (its entries, its target, its two boundary cursors, its stated size), and
 * nothing here asks the read to prove an authorization boundary.
 */

/** The projection at the core seam: the same roles the route's own expression carries, without the deferral. */
function projectAsEntry(): (entry: EntryRecord) => ServerEntry<unknown> | undefined {
  return (entry) => {
    const message = entry.model?.[0];
    if (message === undefined || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) return undefined;
    return { id: String(entry.id), role: message.role, text: contentText(message.content), message };
  };
}

/** A target request as the contract parses it, so a test states what a caller states on the wire. */
function targetRequest(params: { anchor: string; before?: number; after?: number; snapshot?: string; entry?: string; block?: number }): NavigationTargetRequest {
  const parsed = parseNavigationTargetRequest({
    anchor: params.anchor,
    ...(params.before === undefined ? {} : { before: String(params.before) }),
    ...(params.after === undefined ? {} : { after: String(params.after) }),
    ...(params.snapshot === undefined ? {} : { snapshot: params.snapshot }),
    ...(params.entry === undefined ? {} : { entry: params.entry }),
    ...(params.block === undefined ? {} : { block: String(params.block) }),
  });
  if (!parsed.ok) throw new Error("the test asked for a window the contract refuses: " + parsed.error);
  return parsed.request;
}

/** The ordinary shape of an agent session: a prompt, tool traffic, an answer, repeated. */
async function seededTurns(harness: Harness, conversationId: ConversationId, prompts: number): Promise<string[]> {
  const users: string[] = [];
  for (let index = 1; index <= prompts; index += 1) {
    users.push(await appendUser(harness, conversationId, "prompt " + index));
    await appendToolResult(harness, conversationId, "traffic " + index);
    await appendAssistant(harness, conversationId, "answer " + index);
  }
  return users;
}

test("a target window carries the anchor's turn with committed context on both sides, in native history order", async (t) => {
  const rig = await openStore("target");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const users = await seededTurns(rig.harness, conversation.id, 3);
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));
  const reader = { ...history, project: projectAsEntry() };
  const middle = (await readNavigationOutline(history, pageRequest())).anchors[1]!;

  const window = await readNavigationTarget(reader, targetRequest({ anchor: middle.anchor, before: 2, after: 2 }));
  assert.equal(window.conversationId, String(conversation.id));
  assert.equal(window.snapshot, history.snapshot, "the window states the identity the page it was jumped from stated");
  assert.equal(window.scope, history.scope);
  assert.equal(window.order, "oldest-first");
  assert.equal(window.target.entryId, middle.entryId);
  assert.equal(window.target.present, true, "the turn the caller jumped for is inside the bytes returned");
  assert.deepEqual(window.target.blocks, [0], "a text prompt is block 0, the addressing every read block uses");
  assert.deepEqual(decodeNavigationAnchor(window.target.anchor), { ok: true, coordinate: { version: 1, conversationId: String(conversation.id), scope: history.scope, entryId: middle.entryId } }, "the read re-issues the coordinate over the identity it holds");

  const ids = window.entries.map(entry => entry.id);
  assert.deepEqual(ids, ids.slice().sort((a, b) => Number(a) - Number(b)), "native history order, oldest first");
  assert.equal(ids.length, 5, "two messages before, the target, two after: " + JSON.stringify(ids));
  assert.equal(ids.indexOf(middle.entryId), 2, "and the target sits between them rather than at an edge");
  assert.deepEqual(window.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["prompt 2"]);
  assert.equal(window.hasOlder, true);
  assert.equal(window.hasNewer, true);
  assert.equal(window.olderCursor, Number(ids[0]), "the boundary to continue older from is the oldest entry it carries");
  assert.equal(window.newerCursor, Number(ids.at(-1)!), "and the newer boundary is the newest one");
  assert.equal(window.capped, false, "the caller named both counts");
  assert.equal(window.trimmed, true);
  assert.equal(Number(window.olderCursor) > Number(users[0]), true, "the first prompt lies behind the window, reachable from that cursor");
});

test("the counts a caller names are the counts it gets, and a bound is stated rather than silently applied", async (t) => {
  const rig = await openStore("target-bounds");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  await seededTurns(rig.harness, conversation.id, 6);
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));
  const reader = { ...history, project: projectAsEntry() };
  const anchor = (await readNavigationOutline(history, pageRequest())).anchors[3]!;

  // Zero on one side is a real request: a caller that wants the target and what follows it, and nothing before.
  const forward = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, before: 0, after: 1 }));
  assert.equal(forward.entries.length, 2, "the target plus one newer message");
  assert.equal(forward.entries[0]!.id, anchor.entryId);
  assert.equal(forward.hasOlder, true, "committed history does lie behind it, even though none of it was carried");
  assert.equal(forward.olderCursor, Number(anchor.entryId), "so the boundary to continue older from is the target's own entry, exclusive");
  assert.equal(forward.trimmed, true, "the count the caller named left committed history out, and the window says so rather than calling itself whole");

  // Both sides at zero: the target alone, and the two neighbours it does not carry stated as the truth about them.
  const bare = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, before: 0, after: 0 }));
  assert.deepEqual(bare.entries.map(entry => entry.id), [anchor.entryId], "the target and nothing else");
  assert.equal(bare.hasOlder && bare.hasNewer, true, "committed history lies on both sides: " + JSON.stringify({ hasOlder: bare.hasOlder, hasNewer: bare.hasNewer }));
  assert.equal(bare.trimmed, true);

  // And a target at the true edge of its history states the honest `false`, so the flag is not simply always true.
  const firstAnchor = (await readNavigationOutline(history, pageRequest())).anchors[0]!;
  const opening = await readNavigationTarget(reader, targetRequest({ anchor: firstAnchor.anchor, before: 0, after: 1 }));
  assert.equal(opening.hasOlder, false, "nothing precedes the conversation's first turn");
  assert.equal(opening.olderCursor, undefined, "and a window with nothing behind it states no boundary to page from");

  // The default, when no count is named, is the contract's own number and says so.
  const byDefault = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor }));
  assert.equal(byDefault.capped, true, "the default decided both counts");
  assert.equal(byDefault.entries.length <= 2 * NAVIGATION_TARGET_DEFAULT_AROUND + 1, true);

  // Past the cap the read answers a bounded window, not a refusal and not an unbounded one.
  const asked = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, before: NAVIGATION_TARGET_MAX_AROUND + 100, after: NAVIGATION_TARGET_MAX_AROUND + 100 }));
  assert.equal(asked.entries.length <= 2 * NAVIGATION_TARGET_MAX_AROUND + 1, true, "the cap bounds the window: " + asked.entries.length);
  assert.equal(asked.capped, false, "`capped` keeps its page meaning: the caller, not the default, set the size");
  assert.equal(asked.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "and no request makes a window outgrow its budget");

  // The raw-entry cap behind the count: a long span of traffic the transcript does not mount cannot turn "50
  // messages" into a read of the whole history. The walk stops, says more exists, and hands back the boundary it
  // reached rather than pretending the window is what was asked for.
  const crowded = await createConversation(rig.harness);
  await rig.harness.commit(async (tx) => {
    // The context a caller would want, then a long span of bookkeeping the projection answers nothing for, then the
    // turn the caller jumps from — so reaching that context means walking the traffic first.
    for (let index = 0; index < 60; index += 1) await tx.appendEntry(UserEntry, crowded.id, { model: [{ role: "user", content: "older prompt " + index, timestamp: 0 }] });
    for (let index = 0; index < 400; index += 1) await tx.appendEntry(crowded.id, { kind: "hepi.diagnostics", model: [{ role: "system", content: "noise " + index, timestamp: 0 }] });
  }, BACKGROUND_CONTEXT);
  const anchorId = await appendUser(rig.harness, crowded.id, "the turn jumped from");
  const crowdedHistory = historyOf(crowded, await factsOf(rig.harness, crowded.id));
  const crowdedAnchor = (await readNavigationOutline(crowdedHistory, pageRequest())).anchors.find(entry => entry.entryId === anchorId)!;
  const capped = await readNavigationTarget({ ...crowdedHistory, project: projectAsEntry() }, targetRequest({ anchor: crowdedAnchor.anchor, before: NAVIGATION_TARGET_MAX_AROUND, after: 0 }));
  assert.equal(capped.entries.length, 1, "the walk reached no message inside its read budget, so only the target is carried: " + capped.entries.length);
  assert.equal(capped.hasOlder, true, "and it says the older context it could not reach is there");
  assert.equal(capped.olderCursor, Number(anchorId), "naming the boundary a continuation would page from");
});

test("the window's read bound is the loaded window's own, stated once per side", async () => {
  // The contract cannot import the server, so it declares its raw-entry bound as a number; this is the seam that
  // keeps the two from drifting apart into two different ideas of "how much history one read may walk".
  assert.equal(NAVIGATION_TARGET_MAX_RAW_ENTRIES, rawWindowCap(VISIBLE_WINDOW), "a target window reads no wider than the window the transcript keeps: " + NAVIGATION_TARGET_MAX_RAW_ENTRIES);
});

test("a compacted anchor's window carries its committed text, and a coordinate from before the compaction is stale", async (t) => {
  const rig = await openStore("target-compaction");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const dropped = await appendUser(rig.harness, conversation.id, "the prompt the context dropped");
  const kept = await appendAssistant(rig.harness, conversation.id, "an answer the compaction kept");
  const before = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());
  await appendUser(rig.harness, conversation.id, "a later prompt");
  const summary = await rig.harness.commit(tx => tx.appendEntry(CompactionEntry, conversation.id, { head: Number(kept) as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));
  const reader = { ...history, project: projectAsEntry() };

  // Decision 2 at the target read: the entry below the head marker is still committed, still readable, and projected
  // from its own record. An active-window read could not produce this entry at all.
  const fresh = (await readNavigationOutline(history, pageRequest())).anchors.find(anchor => anchor.entryId === dropped)!;
  const window = await readNavigationTarget(reader, targetRequest({ anchor: fresh.anchor, before: 0, after: 3 }));
  assert.equal(window.target.entryId, dropped);
  assert.equal(window.entries[0]!.text, "the prompt the context dropped", "the committed prompt, not a summary of it");
  assert.equal(window.entries.some(entry => entry.id === String(summary.id)), true, "the marker's own entry is part of the committed history a window reads");

  // A caller holding the page issued before the compaction is refused by name; no nearby window is guessed for it.
  const refused = await readNavigationTarget(reader, targetRequest({ anchor: before.anchors[0]!.anchor })).catch(error => error);
  assert.equal((refused as { code?: string }).code, "stale-snapshot");
});

test("a fork reads an inherited anchor's window, and a sibling's entry is named missing rather than absent", async (t) => {
  const rig = await openStore("target-fork");
  t.after(() => rig.close());
  const parent = await createConversation(rig.harness);
  const inherited = await appendUser(rig.harness, parent.id, "a prompt both branches hold");
  await appendAssistant(rig.harness, parent.id, "an answer both branches hold");
  const forkPoint = await appendUser(rig.harness, parent.id, "the turn the fork is taken at");
  const sibling = await appendUser(rig.harness, parent.id, "the parent's own later turn");
  const forked = await parent.fork(Number(forkPoint) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  await appendUser(rig.harness, forked.id, "this branch's own prompt");
  const forkHistory = historyOf(forked, await factsOf(rig.harness, forked.id));
  const reader = { ...forkHistory, project: projectAsEntry() };

  // The inherited entry has the same id in both conversations, so only a scoped coordinate says whose history it was
  // read from — and the fork's own read answers it, carrying the prefix it inherited.
  const inheritedAnchor = (await readNavigationOutline(forkHistory, pageRequest())).anchors.find(anchor => anchor.entryId === inherited)!;
  const window = await readNavigationTarget(reader, targetRequest({ anchor: inheritedAnchor.anchor, before: 0, after: 2 }));
  assert.deepEqual(window.entries.map(entry => entry.text), ["a prompt both branches hold", "an answer both branches hold", "the turn the fork is taken at"]);
  assert.deepEqual(window.entries.map(entry => entry.id), [inherited, window.entries[1]!.id, forkPoint], "inherited entries, in native order, no sibling traffic");
  assert.equal(window.scope, String(forked.id) + "|-", "and the window's identity is the fork's own, not its parent's");

  // The sibling turn exists in the store and is not in this conversation's history. A lookup by id alone would have
  // answered it; the membership-checked scan names it `missing` instead, which is what a caller renders as a failure.
  const refused = await readNavigationTarget(reader, targetRequest({ anchor: encodeNavigationAnchor({ version: 1, conversationId: String(forked.id), scope: forkHistory.scope, entryId: sibling }) })).catch(error => error);
  assert.equal((refused as { code?: string }).code, "missing");

  // The same entry, addressed with its own conversation's coordinate, is readable there.
  const parentHistory = historyOf(parent, await factsOf(rig.harness, parent.id));
  const siblingAnchor = (await readNavigationOutline(parentHistory, pageRequest())).anchors.find(anchor => anchor.entryId === sibling)!;
  const inParent = await readNavigationTarget({ ...parentHistory, project: projectAsEntry() }, targetRequest({ anchor: siblingAnchor.anchor, before: 3, after: 0 }));
  assert.equal(inParent.target.entryId, sibling);
  assert.deepEqual(inParent.entries.map(entry => entry.id), [inherited, inParent.entries[1]!.id, forkPoint, sibling], "the parent's window reads its own history, which holds the shared prefix");
});

test("a window asked against the snapshot its page stated is not moved by a turn committed while it was read", async (t) => {
  const rig = await openStore("target-append");
  t.after(() => rig.close());
  const conversation = await createConversation(rig.harness);
  const users = await seededTurns(rig.harness, conversation.id, 3);
  const before = await readNavigationOutline(historyOf(conversation, await factsOf(rig.harness, conversation.id)), pageRequest());
  const anchor = before.anchors[1]!;
  const pinned = before.snapshot;

  // The ordinary race the spec names: the conversation grows while a rail is paging. The outline extends (ticket 01),
  // and the window a caller asked for stays the window it was addressed to.
  const newest = await appendUser(rig.harness, conversation.id, "a prompt committed afterwards");
  const history = historyOf(conversation, await factsOf(rig.harness, conversation.id));
  const reader = { ...history, project: projectAsEntry() };
  assert.notEqual(history.snapshot, pinned, "the snapshot moved, so an unpinned read would show the new turn");
  assert.equal(history.scope, before.scope, "and the scope did not, because an append re-baselines nothing");

  const window = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, before: 2, after: 2, snapshot: pinned }));
  assert.equal(window.entries.some(entry => entry.id === newest), false, "the window is bounded at the snapshot the caller named");
  assert.equal(window.snapshot, pinned, "and it states that snapshot, not the one the history has now: the identity names the bytes it read");
  assert.equal(window.scope, before.scope);
  assert.equal(window.target.anchor, anchor.anchor, "the same coordinate addresses the same entry, and the read hands it back");

  // The pinned tail is also where "newer" ends: a target that sits at the snapshot's own end has nothing ahead of it
  // **in the history it was read against**, however much the conversation has grown since.
  const tailAnchor = before.anchors.at(-1)!;
  const atPin = await readNavigationTarget(reader, targetRequest({ anchor: tailAnchor.anchor, before: 1, after: 5, snapshot: pinned }));
  assert.equal(atPin.snapshot, pinned, "the pin, stated back");
  assert.equal(atPin.entries.some(entry => entry.id === newest), false, "the turn committed after the pin is outside this window");
  assert.equal(atPin.hasNewer, false, "and the window does not claim history ahead of the pin it read");
  assert.equal(atPin.newerCursor, undefined);
  assert.equal(atPin.hasOlder, true, "while the context behind the target is carried and named");

  // Read unpinned against the same anchor, the newer turn is reachable: nothing moved, the outline grew.
  const open = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, before: 0, after: 6 }));
  assert.equal(open.entries.some(entry => entry.id === newest), true);
  assert.equal(open.entries.some(entry => entry.id === users[0]), false, "an entry ahead of the target is never carried behind it");

  // A snapshot from another conversation is the caller addressing the wrong history, named as such.
  const crossed = await readNavigationTarget(reader, targetRequest({ anchor: anchor.anchor, snapshot: "9999|-|" + users[0] })).catch(error => error);
  assert.equal((crossed as { code?: string }).code, "wrong-scope");

  // And a window cannot be asked for a turn that postdates the snapshot it claims to be read from: the entry exists
  // in this history, just not in the one the caller named, so it is the stale answer rather than a window that
  // silently ends short of the turn the caller jumped to.
  const newestAnchor = (await readNavigationOutline(history, pageRequest())).anchors.at(-1)!;
  assert.equal(newestAnchor.entryId, newest, "the appended turn is the outline's newest anchor");
  const ahead = await readNavigationTarget(reader, targetRequest({ anchor: newestAnchor.anchor, snapshot: pinned })).catch(error => error);
  assert.equal((ahead as { code?: string }).code, "stale-snapshot");
});

test("an oversized target is refused by name and stays readable through its own entry route", { timeout: 60000 }, async (t) => {
  const dbPath = await storeFile("target-oversize");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  await seededTurns(seed.harness, conversation.id, 1);
  // A prompt of two large parts: each block is under the projection's own deferral threshold, so each arrives whole and
  // the entry as a whole is bigger than a navigation window's budget. This is the case the ticket names, and the answer
  // must be a size a caller can act on rather than a window that lost the turn it was asked for.
  const fat = await appendUserBlocks(seed.harness, conversation.id, ["x".repeat(60_000), "y".repeat(60_000)]);
  await seededTurns(seed.harness, conversation.id, 1);
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const page = await outline(origin, id, "?limit=200");
  const anchor = page.body.anchors.find(entry => entry.entryId === fat);
  assert.ok(anchor, "a multi-part paste is still an anchor: " + JSON.stringify(page.body.anchors.map(entry => entry.preview)));

  const refused = await target(origin, id, "?anchor=" + encodeURIComponent(anchor!.anchor) + "&before=0&after=0");
  assert.equal(refused.status, 413, JSON.stringify(refused.body).slice(0, 200));
  assert.equal(refused.body.code, "frame_too_large");
  assert.equal(refused.body.entryId, fat, "the refusal names the entry that could not be carried");
  assert.equal(refused.body.bytes > NAVIGATION_PAGE_MAX_BYTES, true, "and the size it could not carry: " + refused.body.bytes);

  // The named refusal is the whole cost of the bound: the entry is not lost and not silently truncated.
  const whole = await fetch(origin + "/api/conversations/" + id + "/entries/" + fat, { headers });
  assert.equal(whole.status, 200, "the transcript's own single-entry read still serves it");
  const firstBlock = await fetch(origin + "/api/conversations/" + id + "/entries/" + fat + "/text?blockIndex=0", { headers });
  assert.equal(firstBlock.status, 200, "and each block is addressed on its own");
});

test("a heavy prompt arrives as the deferred shape its read block restores, inside the stated size", { timeout: 60000 }, async (t) => {
  const dbPath = await storeFile("target-heavy");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  await seededTurns(seed.harness, conversation.id, 1);
  // One block well past the projection's deferral threshold: the window carries the preview and the URL, exactly as the
  // stream and an older page would, so a heavy entry never makes a response unbounded.
  const heavy = await appendUserBlocks(seed.harness, conversation.id, ["字".repeat(40_000)]);
  await seededTurns(seed.harness, conversation.id, 1);
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const page = await outline(origin, id, "?limit=200");
  const anchor = page.body.anchors.find(entry => entry.entryId === heavy)!;
  assert.ok(anchor, "a heavy prompt keeps its anchor, with a capped preview: " + anchor.preview.length);

  const window = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&before=2&after=2");
  assert.equal(window.status, 200, JSON.stringify(window.body).slice(0, 200));
  assert.equal(window.body.bytes, Buffer.byteLength(JSON.stringify(window.body), "utf8"), "a window's `bytes` is the response's size, its own field included");
  assert.equal(window.body.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "and within the budget it states: " + window.body.bytes);
  assert.equal(window.body.target.entryId, heavy);
  const carried = window.body.entries.find(entry => entry.id === heavy)!;
  assert.equal(JSON.stringify(carried.message).includes("textUrl"), true, "the heavy block names the read block that restores it");
  assert.equal(JSON.stringify(carried.message).includes("字".repeat(40_000)), false, "the whole text is not inlined into the window");
  const restored = await fetch(origin + "/api/conversations/" + id + "/entries/" + heavy + "/text", { headers });
  assert.equal(restored.status, 200, "and that read block serves the text the window deferred");
});


test("a window carries the transcript's own redaction of a credential failure, and no unregistered api", { timeout: 60000 }, async (t) => {
  // The one projection expression is also the one redaction, so a target window must not become a fourth surface that
  // leaks what the stream, the state read and an older page already replace. The ticket names "redaction" as a fact a
  // target read must preserve; this asserts it at the window's own route, against the entry the failure is in.
  const dbPath = await storeFile("target-redaction");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  const secret = "Credential store read failed for /home/operator/.pi/agent/auth.json: secret-value";
  await appendUser(seed.harness, conversation.id, "the prompt before the failure");
  const failed = await seed.harness.commit(tx => tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...fauxAssistantMessage("ignored", { stopReason: "error" }), errorMessage: secret, api: "an-api-nobody-registered" }] }), BACKGROUND_CONTEXT);
  const newer = await appendUser(seed.harness, conversation.id, "the prompt after the failure");
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const page = await outline(origin, id);
  const anchor = page.body.anchors.find(entry => entry.entryId === newer)!;
  const window = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&before=1&after=0");
  assert.equal(window.status, 200, JSON.stringify(window.body).slice(0, 200));
  const carried = window.body.entries.find(entry => entry.id === String(failed.id));
  assert.ok(carried, "the failing entry is committed history, so the window can carry it: " + JSON.stringify(window.body.entries.map(entry => entry.id)));
  const message = carried!.message as { errorMessage?: string; api?: string };
  assert.equal(message.errorMessage, "the model catalog or credentials could not be loaded; check the backend model and credential configuration", "the same replacement every other surface states");
  assert.equal(message.api, "unknown", "an unregistered api id is not echoed to a client from a window either");
  assert.equal(JSON.stringify(window.body).includes("secret-value"), false, "the failure's own text never reaches the wire");
});
test("the route answers a coordinate the contract cannot read, and never lands on a nearby entry", { timeout: 60000 }, async (t) => {
  const dbPath = await storeFile("target-route");
  const seed = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const conversation = await createConversation(seed.harness);
  const id = String(conversation.id);
  const users = await seededTurns(seed.harness, conversation.id, 2);
  const other = await createConversation(seed.harness);
  const foreign = await appendUser(seed.harness, other.id, "a prompt of another conversation");
  await seed.close();
  const origin = await startBackend(t, dbPath);

  const page = await outline(origin, id);
  const anchor = page.body.anchors[0]!;

  // The happy path, through the route the surfaces actually call.
  const window = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&before=1&after=1");
  assert.equal(window.status, 200, JSON.stringify(window.body).slice(0, 200));
  assert.equal(window.body.entries[0]!.id, users[0]);
  assert.equal(window.body.target.blockIndex, undefined, "a plain jump states no block, because none was named");

  // Named refusals with their statuses, because a caller renders each one differently and none of them is a guess.
  const missing = await target(origin, id, "?anchor=" + encodeURIComponent(encodeNavigationAnchor({ version: 1, conversationId: id, scope: page.body.scope, entryId: "888888" })));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "missing");

  const borrowed = await target(origin, id, "?anchor=" + encodeURIComponent(encodeNavigationAnchor({ version: 1, conversationId: id, scope: page.body.scope, entryId: foreign })));
  assert.equal(borrowed.status, 404, "an entry of another conversation is not in this history: " + JSON.stringify(borrowed.body));
  assert.equal(borrowed.body.code, "missing");

  for (const query of ["", "?anchor=nav1.Zm9v", "?anchor=" + encodeURIComponent(anchor.anchor) + "&after=1.5", "?anchor=" + encodeURIComponent(anchor.anchor) + "&before=-1"]) {
    const refused = await target(origin, id, query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.body.code, "malformed", query);
  }
  const unknown = await target(origin, "999999", "?anchor=" + encodeURIComponent(anchor.anchor));
  assert.equal(unknown.status, 404, "a conversation this deployment does not hold is answered by the route's own rule");

  // A coordinate whose scope is not this conversation's is refused before any entry is read, by the name that says why.
  const crossed = await target(origin, id, "?anchor=" + encodeURIComponent(encodeNavigationAnchor({ version: 1, conversationId: id, scope: other.id + "|-", entryId: users[0] })));
  assert.equal(crossed.status, 409);
  assert.equal(crossed.body.code, "stale-snapshot", "the scope says whose history it was read from, and this conversation's is another one");
  const foreignScope = await target(origin, id, "?anchor=" + encodeURIComponent(encodeNavigationAnchor({ version: 1, conversationId: String(other.id), scope: other.id + "|-", entryId: foreign })));
  assert.equal(foreignScope.status, 409, "addressing this route with another conversation's coordinate");
  assert.equal(foreignScope.body.code, "wrong-scope");

  // A search hit's block: echoed back when the entry carries it, refused when it does not, and never a position.
  const withBlock = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&entry=" + users[0] + "&block=0");
  assert.equal(withBlock.status, 200, JSON.stringify(withBlock.body).slice(0, 200));
  assert.equal(withBlock.body.target.blockIndex, 0, "placement is stated by identity: the entry and its native block index");
  const badBlock = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&block=7");
  assert.equal(badBlock.status, 400);
  assert.equal(badBlock.body.code, "malformed");
  const mismatched = await target(origin, id, "?anchor=" + encodeURIComponent(anchor.anchor) + "&entry=" + users[1]);
  assert.equal(mismatched.status, 400, "one window cannot claim a block of an entry it is not around");
  assert.equal(mismatched.body.code, "malformed");
});

test("a window over a real streamed conversation lands the turn the rail would jump to", { timeout: 60000 }, async (t) => {
  const dbPath = await storeFile("target-live");
  const origin = await startBackend(t, dbPath);
  const id = await createThroughRoute(origin, "target-live");
  await sendTurn(origin, id, "live-one", "the first thing asked");
  await sendTurn(origin, id, "live-two", "the second thing asked");
  await sendTurn(origin, id, "live-three", "the third thing asked");

  const page = await outline(origin, id);
  assert.deepEqual(page.body.anchors.map(anchor => anchor.preview), ["the first thing asked", "the second thing asked", "the third thing asked"]);
  const window = await target(origin, id, "?anchor=" + encodeURIComponent(page.body.anchors[1]!.anchor) + "&before=1&after=1");
  assert.equal(window.status, 200, JSON.stringify(window.body).slice(0, 200));
  // The turn, its answer and the neighbours — the shape the transcript mounts, from a run that really executed.
  assert.equal(window.body.entries.some(entry => entry.role === "user" && entry.text === "the second thing asked"), true);
  assert.equal(window.body.entries.some(entry => entry.role === "assistant" && entry.text.includes("the second thing asked")), true, "a real run's answer sits beside its prompt");
  assert.equal(window.body.hasOlder, true, "the first turn lies behind this window and is named as reachable");
  assert.equal(window.body.olderCursor, Number(window.body.entries[0]!.id));
  assert.equal(window.body.bytes, Buffer.byteLength(JSON.stringify(window.body), "utf8"), "the size the route states is the size the caller receives");

  // One identity, spelled by its owner once: the window's scope is the state route's own history token's head part, so
  // a caller can prove the two reads came from the same history without either of them re-deriving it.
  const state = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  const snapshot = await state.json() as { historyRevision: string };
  assert.equal(snapshot.historyRevision.split("|").slice(0, 2).join("|"), window.body.scope);
  assert.equal(window.body.snapshot, snapshot.historyRevision, "and the window is pinned where the transcript is");
});
