import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { defineExtension, defineTask, UserEntry, type Conversation } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
const token = "fork-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Entry = ServerSnapshot["entries"][number];
/**
 * How long a frame that must arrive is waited for before the test calls it absent. It is a hang guard, not a timing
 * fact: every wait below settles on bytes the backend wrote.
 */
const SETTLE_MS = 5000;

/** One SSE frame as the reader reassembled it, with the window a client holds once the frame is folded. */
type Observed = { event: string; data: Record<string, unknown>; window: HeldWindow<Entry> };
const states = (frame: Observed): boolean => frame.event === "state" || frame.event === "snapshot";

/**
 * One conversation's event stream, waited on by **barrier** instead of by poll.
 *
 * `next` resolves on the frame that satisfies the predicate and consumes every frame before it, folding each through
 * the shared reducer a real client uses, so a wait ends on the frame the backend wrote rather than on the next tick of
 * a sleep loop. The cursor only moves forward, so a frame is never skipped: a fact stated about one turn cannot be
 * satisfied by a frame that arrived before it.
 */
type Stream = { next(predicate: (frame: Observed) => boolean, description: string): Promise<Observed>; close(): Promise<void> };

async function attach(origin: string, id: string): Promise<Stream> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers });
  assert.equal(response.status, 200);
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  const frames: Observed[] = [];
  const waiters = new Set<() => void>();
  let cursor = 0;
  let ended = false;
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const pump = (async () => {
    let pending = "";
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const line = raw.split("\n").find(value => value.startsWith("data: "));
        // A keepalive comment frame carries no event and is not a lifecycle fact.
        if (event === undefined || line === undefined) continue;
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event === "state" || event === "snapshot") folder.fold(event, data);
        frames.push({ event, data, window: folder.current() });
        wake();
      }
    }
  })().finally(() => { ended = true; wake(); });
  const next = (predicate: (frame: Observed) => boolean, description: string): Promise<Observed> =>
    new Promise<Observed>((resolve, reject) => {
      const settle = (): void => {
        for (; cursor < frames.length; cursor += 1) {
          if (!predicate(frames[cursor]!)) continue;
          const found = frames[cursor]!;
          cursor += 1;
          clearTimeout(timer); waiters.delete(settle);
          resolve(found); return;
        }
        if (!ended) return;
        clearTimeout(timer); waiters.delete(settle);
        reject(new Error("the stream ended before " + description + "; frames: " + frames.map(frame => frame.event).join(",")));
      };
      const timer = setTimeout(() => {
        waiters.delete(settle);
        reject(new Error("timed out waiting for " + description + "; frames: " + frames.map(frame => frame.event).join(",")));
      }, SETTLE_MS);
      waiters.add(settle);
      settle();
    });
  return { next, async close() { waiters.clear(); await body.cancel().catch(() => {}); await pump.catch(() => {}); } };
}

/**
 * A backend whose model answer can be held, so "the source's run is in flight while it is forked" is a real state a
 * test observes instead of a race. The gate is off until `gate()` turns it on, and a test's own cleanup releases it,
 * so a failed assertion cannot leave a run holding the harness. `entered` resolves when a held run reaches the provider,
 * so a test waits for that state instead of asking whether it has been reached yet.
 */
async function start(t: TestContext): Promise<{ backend: BackendServer; origin: string; dbPath: string; gate: () => void; release: () => void; entered: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-fork-"));
  directories.push(directory);
  const dbPath = join(directory, "fork.sqlite");
  let releaseResponse!: () => void;
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  let gated = false;
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const faux = fauxProvider();
  const answer: FauxResponseFactory = async (): Promise<AssistantMessage> => {
    faux.setResponses([answer]);
    if (!gated) return fauxAssistantMessage("answer");
    markEntered();
    await release;
    return fauxAssistantMessage("answer");
  };
  faux.setResponses([answer]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => { releaseResponse(); return backend.close(); });
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath, gate: () => { gated = true; }, release: releaseResponse, entered: () => entered };
}

async function create(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
}

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as ServerSnapshot;
}

/**
 * Submit and wait for the run to settle, so the transcript the test forks is durable before it forks.
 *
 * The wait is the frame that carries both entries the turn appends, stated idle: the transcript it must extend is read
 * before the turn starts, so a frame from an earlier turn cannot satisfy it and nothing is polled.
 */
async function say(origin: string, id: string, requestId: string, text: string): Promise<ServerSnapshot> {
  const before = await state(origin, id);
  const stream = await attach(origin, id);
  try {
    const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    const submitted = await submit.text();
    assert.equal(submit.status, 202, submitted);
    await stream.next(frame => states(frame) && !frame.window.busy && frame.window.entries.length === before.entries.length + 2, "the turn's answer to be appended");
  } finally {
    await stream.close();
  }
  return await state(origin, id);
}

type Catalogue = { conversations: { id: string; parentConversationId?: string; subagentParentConversationId?: string; messageCount: number; firstMessage: string }[] };
const catalogue = async (origin: string): Promise<Catalogue> => await (await fetch(origin + "/api/conversations", { headers })).json() as Catalogue;

const fork = (origin: string, id: string, body: Record<string, unknown> = {}) =>
  fetch(origin + "/api/conversations/" + id + "/fork", { method: "POST", headers, body: JSON.stringify(body) });

test("forks at a chosen entry: the copy carries the history up to it and the source is unchanged", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const source = await create(server.origin);
  const first = await say(server.origin, source, "turn-1", "first");
  const second = await say(server.origin, source, "turn-2", "second");
  const entryIds = second.entries.map(entry => entry.id);
  assert.equal(entryIds.length, 4, JSON.stringify(second.entries));

  const response = await fork(server.origin, source, { at: entryIds[1] });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text) as { protocol: string; conversationId: string; conversation: { id: string; parentConversationId?: string } };
  assert.equal(body.protocol, "hepi.v1");
  assert.notEqual(body.conversationId, source);
  // The answer carries the copy's catalogue row, from the same read the list is built from.
  assert.equal(body.conversation.id, body.conversationId);
  assert.equal(body.conversation.parentConversationId, source);

  // The copy's history is the source's, read back through the durable API, up to and including the chosen entry.
  const forked = await state(server.origin, body.conversationId);
  const expected = second.entries.filter(entry => Number(entry.id) <= Number(entryIds[1]));
  assert.deepEqual(forked.entries.map(entry => entry.text), expected.map(entry => entry.text));
  assert.deepEqual(forked.entries.map(entry => entry.id), expected.map(entry => entry.id));
  assert.deepEqual(forked.entries.map(entry => entry.role), expected.map(entry => entry.role));
  // The copy continues independently: its own entries are its own, and the source's later turns are not in it.
  assert.equal(forked.entries.length, 2);
  assert.ok(!forked.entries.some(entry => entry.text.includes("second")));

  // The source is unchanged by the fork, read back the same way.
  const after = await state(server.origin, source);
  assert.deepEqual(after.entries, second.entries);

  // The copy is a row of its own in the list, named as a fork, and the source keeps its own row.
  const listed = await catalogue(server.origin);
  const row = listed.conversations.find(item => item.id === body.conversationId);
  assert.ok(row !== undefined, "the copy is in the list");
  assert.equal(row.parentConversationId, source);
  assert.equal(row.firstMessage, "first", "the copy keeps the history it was forked from");
  assert.ok(listed.conversations.some(item => item.id === source && item.parentConversationId === undefined));
});

test("forks the newest committed entry when no fork point is named", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const source = await create(server.origin);
  const answered = await say(server.origin, source, "turn-1", "hello");
  const response = await fork(server.origin, source);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const forked = await state(server.origin, (JSON.parse(text) as { conversationId: string }).conversationId);
  assert.deepEqual(forked.entries.map(entry => entry.text), answered.entries.map(entry => entry.text));
});

test("a live run in the source keeps running while it is forked", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const source = await create(server.origin);
  await say(server.origin, source, "settled", "settled turn");
  const entryIds = (await state(server.origin, source)).entries.map(entry => entry.id);
  const retained = (await state(server.origin, source)).entries.length;

  // The conversation's own stream is attached before the run starts, so the frames that state the run's lifecycle are
  // what this test waits on rather than a sleep that hopes to have outlived them.
  const stream = await attach(server.origin, source);
  t.after(() => stream.close());
  // The source is busy inside its answer, so the fork happens while a run is genuinely in flight.
  server.gate();
  const inFlight = fetch(server.origin + "/api/conversations/" + source + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "in-flight", text: "while forking" }) });
  const submit = await inFlight;
  assert.equal(submit.status, 202);
  await server.entered();
  await stream.next(frame => states(frame) && frame.window.busy, "the run to be in flight");
  assert.equal((await state(server.origin, source)).busy, true);

  const response = await fork(server.origin, source, { at: entryIds[1] });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const forkedId = (JSON.parse(text) as { conversationId: string }).conversationId;
  // The fork is not busy: the run it forked around belongs to the source, and the copy inherits no live state.
  assert.equal((await state(server.origin, forkedId)).busy, false);

  // Releasing the gate lets the source's own run finish, undisturbed: the barrier is the idle frame that carries the
  // two entries it appends.
  server.release();
  await stream.next(frame => states(frame) && !frame.window.busy && frame.window.entries.length === retained + 2, "the source's run to settle");
  const settled = await state(server.origin, source);
  assert.equal(settled.entries.at(-1)?.text, "answer");
  assert.equal(settled.entries.length, retained + 2, JSON.stringify(settled.entries));
});

test("a fork of a missing, unsaved or empty session is refused with a reason and creates nothing", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const empty = await create(server.origin);
  const source = await create(server.origin);
  const answered = await say(server.origin, source, "turn-1", "hello");
  const before = (await catalogue(server.origin)).conversations.length;

  // Missing: no such conversation, answered as not found with the code the sidebar names in the user's language.
  const missing = await fork(server.origin, "999999");
  assert.equal(missing.status, 404);
  const missingBody = await missing.json() as { code: string; error: string };
  assert.equal(missingBody.code, "not_found");
  assert.equal(typeof missingBody.error, "string");

  // Unsaved: the client names a fork point the durable conversation has not committed.
  const unsaved = await fork(server.origin, source, { at: String(Number(answered.entries.at(-1)!.id) + 1000) });
  assert.equal(unsaved.status, 409);
  const unsavedBody = await unsaved.json() as { code: string; error: string };
  assert.equal(unsavedBody.code, "unsaved");
  assert.match(unsavedBody.error, /has not been saved/);

  // A malformed fork point is the same refusal, not a crash.
  const malformed = await fork(server.origin, source, { at: "not-an-entry" });
  assert.equal(malformed.status, 409);
  assert.equal((await malformed.json() as { code: string }).code, "unsaved");

  // Empty: the conversation holds no user or assistant message yet, so there is nothing to continue from.
  const nothing = await fork(server.origin, empty);
  assert.equal(nothing.status, 409);
  const emptyBody = await nothing.json() as { code: string; error: string };
  assert.equal(emptyBody.code, "empty");
  assert.match(emptyBody.error, /Nothing to fork/);

  // Nothing was created by any refusal, and the sources are still exactly what they were.
  assert.equal((await catalogue(server.origin)).conversations.length, before);
  assert.deepEqual((await state(server.origin, source)).entries, answered.entries);
});

test("a fork of a task-owned child gets its own background anchor, not the child's task and not an ownerless copy", { timeout: 20000 }, async (t) => {
  // A subagent's conversation is owned by the task that created it. The fixture writes that owned record through the
  // durable API itself, with a holder task standing in for the child's own anchor, so the branch's owner is a fact
  // this test reads rather than one the delegation path happens to produce.
  const directory = await mkdtemp(join(tmpdir(), "hepi-fork-owned-"));
  directories.push(directory);
  const dbPath = join(directory, "owned.sqlite");
  const Holder = defineTask<{ note: string }, { phase: "done" }, null>({
    name: "test.fork-holder",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: async () => { throw new Error("a holder task never runs"); } },
    abort: async () => { throw new Error("a holder task never aborts"); },
  });
  const writer = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true, resourceExtension: defineExtension({ name: "test.fork-holder", tasks: [Holder] }) });
  const owner = await writer.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const taskId = await owner.commit(tx => tx.createTask(Holder, { note: "owner" }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
  const child = await writer.harness.createConversation({ ownership: { kind: "task", taskId: taskId as TaskId } }, BACKGROUND_CONTEXT);
  const inherited = await writer.harness.commit(tx => tx.appendEntry(UserEntry, child.id, { model: [{ role: "user", content: "subagent turn", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  await writer.close();

  const backend = await createBackendServer({ dbPath, authToken: token, models: fauxModels(), defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(() => backend.close());

  const childId = String(child.id);
  const before = (await catalogue(origin)).conversations.length;
  const at = (await state(origin, childId)).entries.at(-1)!.id;
  const response = await fork(origin, childId, { at, requestId: "branch-of-child" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text) as { conversationId: string; conversation: { id: string; parentConversationId?: string; createdBy?: string; displayParentId?: string; displayParentDeleted?: boolean; subagentParentConversationId?: string } };
  // The branch inherits the child's history at the named entry and keeps the child as its display parent and its fork
  // source; it is not promoted to a conversation of its own and the child is not rewritten.
  assert.equal(body.conversation.parentConversationId, childId);
  assert.equal(body.conversation.createdBy, childId);
  assert.equal(body.conversation.displayParentId, childId);
  // The row omits the flag while the parent is live and states it when the parent is hidden; the by-id read is where
  // the flag is a boolean either way.
  assert.equal(body.conversation.displayParentDeleted, undefined);
  assert.deepEqual((await state(origin, body.conversationId)).entries.map(entry => entry.id), [String(inherited.id)]);

  // Its owner is its own background anchor on the child: not the child's holder task, and not an ownerless copy.
  const info = await (await fetch(origin + "/api/conversations/" + body.conversationId, { headers })).json() as { owner?: { conversationId: string; taskId: string }; displayParentDeleted: boolean };
  assert.equal(info.displayParentDeleted, false);
  assert.equal(info.owner?.conversationId, childId);
  assert.notEqual(info.owner?.taskId, String(taskId), "the branch does not reuse the child's own task");
  // The branch is not reported as a subagent's: nobody delegated it, so a surface must not fold it into the child's
  // family or treat its answer as a silent completion. Its source and its place are the fork facts it does report.
  assert.equal(body.conversation.subagentParentConversationId, undefined);
  // Independent initial state: allowed, idle and with nothing carried over from the child.
  const branchState = await state(origin, body.conversationId) as unknown as { busy: boolean; control: { state: string }; queuedMessages: { steering: unknown[]; followUp: unknown[] } };
  assert.equal(branchState.busy, false);
  assert.equal(branchState.control.state, "allowed");
  assert.deepEqual(branchState.queuedMessages, { steering: [], followUp: [] });
  // The child keeps its own row and its own owner; the branch is a row of its own, displayed under it.
  const rows = (await catalogue(origin)).conversations;
  assert.equal(rows.length, before + 1);
  assert.equal(rows.find(item => item.id === childId)?.subagentParentConversationId, String(owner.id));
  assert.equal(rows.find(item => item.id === String(owner.id))?.subagentParentConversationId, undefined, "a conversation the user started reports no creator task");

  // A retry of the same request identity answers the same branch instead of making a second one.
  const replay = await fork(origin, childId, { at, requestId: "branch-of-child" });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json() as { conversationId: string }).conversationId, body.conversationId);
  assert.equal((await catalogue(origin)).conversations.length, before + 1);
});

test("a branch starts from the configuration in force at its entry, and an explicit override replaces a field", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const source = await create(server.origin);
  // The source is configured before the fork point, and changed after it: the branch inherits the position's snapshot,
  // which is what makes "the configuration this branch was taken under" a fact rather than a re-resolution (spec D14).
  const configured = await fetch(server.origin + "/api/conversations/" + source + "/settings", { method: "PATCH", headers, body: JSON.stringify({ thinkingLevel: "high" }) });
  assert.equal(configured.status, 200, await configured.text());
  const answered = await say(server.origin, source, "turn-1", "hello");
  const at = answered.entries.at(-1)!.id;
  await fetch(server.origin + "/api/conversations/" + source + "/settings", { method: "PATCH", headers, body: JSON.stringify({ thinkingLevel: "off" }) });

  const settingsOf = async (id: string) => await (await fetch(server.origin + "/api/conversations/" + id + "/settings", { headers })).json() as { thinkingLevel: string; model: { provider: string; modelId: string } | null };

  const response = await fork(server.origin, source, { at });
  assert.equal(response.status, 201, await response.clone().text());
  const branchId = (await response.json() as { conversationId: string }).conversationId;
  assert.equal((await settingsOf(branchId)).thinkingLevel, "high", "the branch keeps the level in force at the fork entry");

  // An explicit override is applied on top of that copy, in the same commit, and it is validated before the fork.
  const overridden = await fork(server.origin, source, { at, thinkingLevel: "low" });
  assert.equal(overridden.status, 201, await overridden.clone().text());
  const overriddenId = (await overridden.json() as { conversationId: string }).conversationId;
  assert.equal((await settingsOf(overriddenId)).thinkingLevel, "low");
  assert.equal((await settingsOf(branchId)).thinkingLevel, "high", "another branch's override does not move this one");

  // A configuration this backend would refuse on the settings route is refused here too, before anything is created.
  const before = (await catalogue(server.origin)).conversations.length;
  const badLevel = await fork(server.origin, source, { at, thinkingLevel: "turbo" });
  assert.equal(badLevel.status, 400);
  assert.equal((await badLevel.json() as { code: string }).code, "invalid_thinking_level");
  const badModel = await fork(server.origin, source, { at, model: { provider: "nope", modelId: "nope" } });
  assert.equal(badModel.status, 400);
  assert.equal((await badModel.json() as { code: string }).code, "unknown_model");
  assert.equal((await catalogue(server.origin)).conversations.length, before, "a refused fork creates nothing");
});

test("the fork is the runtime's own, so its conversation-scoped documents follow the fork semantics", { timeout: 20000 }, async (t) => {
  // The execution workspace is a conversation-scoped document the runtime forks with the conversation. Its declared
  // semantics are `fork: "current"`, so the copy must carry the source's binding without anything here writing it:
  // a second, hepi-side copy of the binding would be the defect this asserts against.
  const root = await mkdtemp(join(tmpdir(), "hepi-fork-docs-"));
  directories.push(root);
  const { GatewayRpcServer, LocalGateway, WorkspaceRegistry } = await import("@hepi/gateway");
  const gateway = new GatewayRpcServer(
    new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: new WorkspaceRegistry([{ id: "local", root }]), allowedCommands: ["bash"] }),
  );
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.server.address();
  assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };
  const backend = await createBackendServer({ dbPath: join(root, "docs.sqlite"), authToken: token, models: fauxModels(), defaultModel: SERVER_MODEL, workspaces: [binding] });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  const origin = "http://127.0.0.1:" + serverAddress.port;
  t.after(async () => { await backend.close(); await gateway.close(); });

  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  assert.equal(created.status, 201);
  const source = (await created.json() as { conversationId: string }).conversationId;
  await say(origin, source, "turn-1", "bound turn");
  const entryId = (await state(origin, source)).entries[0]!.id;

  const response = await fork(origin, source, { at: entryId });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const forkedId = (JSON.parse(text) as { conversationId: string }).conversationId;
  // The copy carries the source's execution workspace, and it is reported in the same catalogue field the list uses.
  assert.equal((await state(origin, forkedId)).workspaceId, "local");
  const row = (await catalogue(origin)).conversations.find(item => item.id === forkedId);
  assert.equal(row?.parentConversationId, source);
  assert.equal((await catalogue(origin)).conversations.find(item => item.id === forkedId) !== undefined, true);
});
