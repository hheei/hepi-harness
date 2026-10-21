import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { TombstoneDoc } from "../src/session-tombstone.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
const token = "delete-token";
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
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/events", { headers });
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
 * A backend whose model answer can be held, so "deleting a session that is currently running" is a real state a test
 * observes rather than a race. The gate is off until `gate()` turns it on and the test's own cleanup releases it, so a
 * failed assertion cannot leave a run holding the harness. `entered` resolves when a held run reaches the provider, so
 * a test waits for that state instead of asking whether it has been reached yet.
 */
async function start(t: TestContext, dbPath?: string): Promise<{ backend: BackendServer; origin: string; dbPath: string; gate: () => void; release: () => void; entered: () => Promise<void> }> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-delete-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "delete.sqlite");
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
  const backend = await createBackendServer({ dbPath: path, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => { releaseResponse(); return backend.close(); });
  const origin = "http://127.0.0.1:" + address.port;
  // A fresh backend lists nothing: the runtime's own root conversation is a framework record it never projects, so
  // every catalogue row these tests read is one they created.
  const listed = (await (await fetch(origin + "/api/conversations", { headers })).json()) as { conversations: { id: string }[] };
  assert.deepEqual(listed.conversations, [], "only the sessions these tests create are listed");
  return { backend, origin, dbPath: path, gate: () => { gated = true; }, release: releaseResponse, entered: () => entered };
}

type CatalogueRow = { id: string; title: string | null; parentConversationId?: string; messageCount: number; firstMessage: string };
type SidebarState = { version: number; revision: number; sessions: Record<string, { pinnedAt?: number; archivedAt?: number; unreadAt?: number }> };

const catalogue = async (origin: string): Promise<CatalogueRow[]> =>
  ((await (await fetch(origin + "/api/conversations", { headers })).json()) as { conversations: CatalogueRow[] }).conversations;
/** The catalogue rows of the sessions a test created. */
const listedSessions = async (server: { origin: string }): Promise<CatalogueRow[]> => catalogue(server.origin);
const sidebarState = async (origin: string): Promise<SidebarState> =>
  ((await (await fetch(origin + "/api/sidebar-state", { headers })).json()) as { state: SidebarState }).state;
const sidebarWrite = (origin: string, body: unknown) => fetch(origin + "/api/sidebar-state", { method: "POST", headers, body: JSON.stringify(body) });
const remove = (origin: string, id: string) => fetch(origin + "/api/conversations/" + encodeURIComponent(id), { method: "DELETE", headers });
async function create(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { conversationId: string }).conversationId;
}
async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/state", { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as ServerSnapshot;
}
/**
 * Submit and wait for the run to settle, so the transcript read back after a removal is durable before it.
 *
 * The wait is the frame that carries both entries the turn appends, stated idle: the transcript it must extend is read
 * before the turn starts, so a frame from an earlier turn cannot satisfy it and nothing is polled.
 */
async function say(origin: string, id: string, requestId: string, text: string): Promise<ServerSnapshot> {
  const before = await state(origin, id);
  const stream = await attach(origin, id);
  try {
    const submit = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    assert.equal(submit.status, 202, await submit.text());
    await stream.next(frame => states(frame) && !frame.window.busy && frame.window.entries.length === before.entries.length + 2, "the turn's answer to be appended");
  } finally {
    await stream.close();
  }
  return state(origin, id);
}
async function fork(origin: string, id: string): Promise<string> {
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/fork", { method: "POST", headers, body: "{}" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { conversationId: string }).conversationId;
}

test("a removal takes the session out of the catalogue and clears its own sidebar entries in the same operation", async (t) => {
  const server = await start(t);
  const removed = await create(server.origin);
  const kept = await create(server.origin);
  const answered = await say(server.origin, removed, "turn-1", "hello");
  await say(server.origin, kept, "turn-2", "other");
  // A pin, an archive and an unread marker of its own, so the removal has entries to clear.
  assert.equal((await sidebarWrite(server.origin, { action: "set", ids: [removed], pinned: true })).status, 200);
  assert.equal((await sidebarWrite(server.origin, { action: "set-unread", ids: [removed], unread: true })).status, 200);
  // The session that is not removed keeps an entry of its own, so the clear is asserted to be about this session.
  assert.equal((await sidebarWrite(server.origin, { action: "set", ids: [kept], pinned: true })).status, 200);
  const before = await sidebarState(server.origin);
  assert.deepEqual(Object.keys(before.sessions).sort(), [removed, kept].sort(), "each session's own entries are in the document");

  const response = await remove(server.origin, removed);
  const answer = await response.text();
  assert.equal(response.status, 200, answer);
  assert.deepEqual(JSON.parse(answer), { protocol: "hepi.v1", conversationId: removed, removed: true });

  // Out of the catalogue, and the session that was not removed is untouched. Two independent reads are what two open
  // windows each make, so both agree the session is gone.
  const [one, two] = await Promise.all([listedSessions(server), listedSessions(server)]);
  assert.deepEqual(one.map(row => row.id), [kept]);
  assert.deepEqual(two, one);

  // Its own pin, archive and unread entries are gone with it; no orphan entry is left in the sidebar document.
  const after = await sidebarState(server.origin);
  assert.equal(after.sessions[removed], undefined, "the removed session's own entries are gone");
  assert.deepEqual(Object.keys(after.sessions), [kept], "no orphan entry remains in the sidebar document");
  assert.ok(after.revision > before.revision, "the removal is a changing write of the shared document");

  // The records are retained: the transcript reads back through the durable API exactly as it was.
  const retained = await state(server.origin, removed);
  assert.deepEqual(retained.entries, answered.entries);
  assert.equal(retained.entries.length, 2);
});

test("the removal is a durable document that survives a backend restart, and the records survive with it", async (t) => {
  const first = await start(t);
  const removed = await create(first.origin);
  const answered = await say(first.origin, removed, "turn-1", "retained turn");
  assert.equal((await remove(first.origin, removed)).status, 200);
  await first.backend.close();

  // A fresh process over the same store: the conversation is still absent from the catalogue, its entries still read
  // back, and the tombstone is readable as the document it is through the durable API rather than as a deletion.
  const second = await start(t, first.dbPath);
  assert.deepEqual(await listedSessions(second), [], "the removed session is absent from the restarted catalogue");
  assert.deepEqual((await state(second.origin, removed)).entries, answered.entries);

  const reader = await openServerHarness(second.dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  try {
    const tombstone = await reader.harness.snapshot(TombstoneDoc, Number(removed) as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(typeof tombstone?.deletedAt, "number");
  } finally {
    await reader.close();
  }
});

test("a removal while a run is in flight is answered without waiting for it, and a new turn is refused with a reason", { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const removed = await create(server.origin);
  await say(server.origin, removed, "settled", "settled turn");
  const retained = await state(server.origin, removed);

  // The conversation's own stream is attached before the run starts, so the frames that state the run's lifecycle are
  // what this test waits on rather than a sleep that hopes to have outlived them.
  const stream = await attach(server.origin, removed);
  t.after(() => stream.close());
  server.gate();
  const inFlight = await fetch(server.origin + "/api/conversations/" + removed + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "in-flight", text: "while removed" }) });
  assert.equal(inFlight.status, 202);
  await server.entered();
  await stream.next(frame => states(frame) && frame.window.busy, "the run to be in flight");
  assert.equal((await state(server.origin, removed)).busy, true);

  // The answer does not wait for the run: the removal is complete while the run is still inside its provider response.
  const response = await remove(server.origin, removed);
  assert.equal(response.status, 200, await response.text());
  assert.equal((await state(server.origin, removed)).busy, true, "the live run was not stopped or waited for");
  assert.deepEqual(await listedSessions(server), []);

  // A new turn on the removed session is refused with the reason the caller reads, and nothing is admitted.
  const refused = await fetch(server.origin + "/api/conversations/" + removed + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "after-removal", text: "again" }) });
  assert.equal(refused.status, 409);
  const refusal = (await refused.json()) as { code: string; message: string; accepted: boolean };
  assert.equal(refusal.code, "session_deleted");
  assert.equal(refusal.accepted, false);
  assert.match(refusal.message, /was deleted/);

  // The run already in flight finishes into the retained records, undisturbed: the barrier is the idle frame that
  // carries the two entries it appends.
  server.release();
  await stream.next(frame => states(frame) && !frame.window.busy && frame.window.entries.length === retained.entries.length + 2, "the run in flight to settle");
  const settled = await state(server.origin, removed);
  assert.equal(settled.entries.length, retained.entries.length + 2);
  assert.equal(settled.entries.at(-1)?.text, "answer");
});

test("a session's child stays listed and openable, and no row reports a parent that is gone", async (t) => {
  const server = await start(t);
  const source = await create(server.origin);
  await say(server.origin, source, "turn-1", "hello");
  const child = await fork(server.origin, source);
  const childEntries = (await state(server.origin, child)).entries;

  assert.equal((await remove(server.origin, source)).status, 200);

  const rows = await listedSessions(server);
  assert.deepEqual(rows.map(row => row.id), [child], "the child is still listed and the source is not");
  assert.equal(rows[0].parentConversationId, undefined, "no surface reports a parent that is gone");
  // Openable, with its own records intact: a fork is a session of its own and the removal deletes no child.
  assert.deepEqual((await state(server.origin, child)).entries, childEntries);
  const childResponse = await fetch(server.origin + "/api/conversations/" + child + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "child-turn", text: "still mine" }) });
  assert.equal(childResponse.status, 202, await childResponse.text());
});

test("removing an unknown session is refused with a readable reason and changes nothing", async (t) => {
  const server = await start(t);
  const kept = await create(server.origin);
  const before = await sidebarState(server.origin);

  const response = await remove(server.origin, "999999");
  assert.equal(response.status, 404);
  const refusal = (await response.json()) as { code: string; error: string };
  assert.equal(refusal.code, "not_found");
  assert.match(refusal.error, /not found/);

  // The refusal created nothing and changed nothing: the catalogue and the shared sidebar document are as they were.
  assert.deepEqual((await listedSessions(server)).map(row => row.id), [kept]);
  assert.deepEqual(await sidebarState(server.origin), before);
});

test("the tombstone is written through the durable document path and its seam records why the records are retained", async () => {
  const seam = await readFile(new URL("../src/session-tombstone.ts", import.meta.url), "utf8");
  // The comment the specification requires verbatim, at the seam that writes and reads the tombstone.
  assert.match(seam, /\/\/ Records are retained because pi-durable 1\.1\.0 has no conversation deletion; this hides the\n\/\/ conversation from the catalogue\. Replace with the upstream deletion primitive when it exists\./);
  // No direct store editing: the removal is a document write through the durable API.
  assert.doesNotMatch(seam, /DELETE FROM|DROP TABLE|unlink|rmSync|openNodeSqliteStorage|new Database/);
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /import \{ tombstoneConversation, TombstoneDoc \} from "\.\/session-tombstone\.ts";/);
  assert.doesNotMatch(server, /DELETE FROM|DROP TABLE/);
});
