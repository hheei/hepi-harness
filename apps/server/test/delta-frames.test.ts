import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

/**
 * The stream's incremental frames, asserted at the wire the backend writes.
 *
 * After the baseline a turn costs what the turn produced, not what the transcript holds: an advancing frame carries
 * the entries it appended and the window bookkeeping, and every scalar full. The window is unchanged for the entries
 * it already covered, so it is stated once, at the baseline, and never re-serialized per turn.
 */
const directories: string[] = [];
const token = "delta-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function store(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-delta-" + label + "-"));
  directories.push(directory);
  return join(directory, "delta.sqlite");
}

/**
 * One conversation on the runtime's own write path, and the model registry the backend that serves it must run with:
 * the conversation keeps the reference it was created under, so the backend has to offer that same model for a turn
 * to produce an answer rather than settle as `no_model`.
 */
async function seed(dbPath: string, turns: number): Promise<{ id: string; models: Models }> {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  // The model is chosen at creation, because a conversation keeps the reference it was created with: without one the
  // turn this test submits settles natively as `no_model` and never appends an answer.
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL } }, BACKGROUND_CONTEXT);
  await harness.harness.commit(async (tx) => {
    for (let turn = 0; turn < turns; turn += 1) await tx.appendEntry(UserEntry, created.id, { model: [{ role: "user", content: "user " + turn, timestamp: turn }] });
  }, BACKGROUND_CONTEXT);
  await harness.close();
  return { id: String(created.id), models: harness.models };
}

async function start(t: TestContext, dbPath: string, models: Models, settings?: { compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number } }): Promise<string> {
  const backend: BackendServer = await createBackendServer({ dbPath, authToken: token, models, ...(settings === undefined ? {} : { settings }), defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return "http://127.0.0.1:" + address.port;
}

/** One SSE frame's own event name and parsed payload, as the reader received it. */
type Frame = { event: string; data: Record<string, unknown> };

/** How long a frame that must arrive is waited for before the test calls it absent: a hang guard, not a timing fact. */
const DEADLINE_MS = 10_000;

/**
 * One SSE reader over the wire the backend writes, with the frame itself as the barrier.
 *
 * `until` is re-checked on every parsed frame, so a wait ends on the frame that satisfies it rather than at the next
 * tick of a sleep loop; nothing is polled and nothing is slept on, so a wait cannot be satisfied by a delay. The
 * deadline and the stream ending are both failures here — they mean the frame never came.
 */
function reader(response: Response) {
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const pump = (async () => {
    while (true) {
      const chunk = await stream.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = raw.split("\n").find(line => line.startsWith("event: "))?.slice(7) ?? "";
        const data = raw.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data === undefined) continue;
        frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
      }
      wake();
    }
  })().finally(() => { ended = true; wake(); });
  return {
    frames,
    until(predicate: (frames: Frame[]) => boolean, description: string): Promise<Frame[]> {
      if (predicate(frames)) return Promise.resolve(frames);
      return new Promise<Frame[]>((resolve, reject) => {
        const settle = (): void => {
          if (!ended && !predicate(frames)) return;
          clearTimeout(timer); waiters.delete(settle);
          if (ended && !predicate(frames)) reject(new Error("the stream ended before " + description + "; got " + frames.map(frame => frame.event).join(",")));
          else resolve(frames);
        };
        const timer = setTimeout(() => { waiters.delete(settle); reject(new Error("timed out waiting for " + description + "; got " + frames.map(frame => frame.event).join(","))); }, DEADLINE_MS);
        waiters.add(settle);
      });
    },
    async cancel() { waiters.clear(); await stream.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

const submit = (origin: string, id: string, text: string) => fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", requestId: "req-" + Math.random(), type: "conversation.submit", text }) });

test("after the baseline, an advancing frame carries only what it appended and the window bookkeeping", async (t) => {
  const dbPath = await store("append");
  const seeded = await seed(dbPath, 3);
  const id = seeded.id;
  const origin = await start(t, dbPath, seeded.models);
  const stream = reader(await fetch(origin + "/api/conversations/" + id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  const baseline = stream.frames.find(frame => frame.event === "snapshot")!.data as unknown as ServerSnapshot;
  assert.ok(Array.isArray(baseline.entries), "the baseline is the window itself");

  assert.equal((await submit(origin, id, "one more turn")).status, 202);
  // The turn is over when the answer it produced has been appended: the frames before that are the same advance
  // carrying only the submission transitions, which is the scalar-only case asserted below.
  await stream.until(frames => frames.some(frame => frame.event === "state" && (frame.data.appended as { role: string }[]).some(entry => entry.role === "assistant")), "the answer to be appended");
  await stream.cancel();

  const advancing = stream.frames.filter(frame => frame.event === "state");
  assert.ok(advancing.length > 0, "the turn published at least one frame");
  let previous = baseline.revision;
  for (const frame of advancing) {
    assert.equal(frame.data.baseRevision, previous, "each frame is based on exactly the revision the client holds");
    assert.equal(frame.data.revision, previous + 1, "and advances the revision by exactly one");
    assert.equal("entries" in frame.data, false, "an advancing frame does not re-serialize the window");
    assert.ok(Array.isArray(frame.data.appended), "it states what it appended instead");
    assert.equal(typeof frame.data.oldestEntryId === "string" || frame.data.oldestEntryId === null, true, "and the window's boundary");
    assert.equal(typeof frame.data.hasMore, "boolean", "and whether anything older exists");
    assert.equal(typeof frame.data.busy, "boolean", "with every scalar full");
    assert.equal(typeof frame.data.partial, "string");
    assert.ok("submissions" in frame.data, "including the outstanding submissions");
    // The frame is the snapshot's own scalar set plus the two continuity fields: the runtime's commit vocabulary
    // (a Chord operation, a raw entry record, a live document) is never the wire format, so a new field cannot arrive
    // here without this list changing with it.
    assert.deepEqual(
      Object.keys(frame.data).sort(),
      ["appended", "baseRevision", "busy", "control", "conversationId", "extensions", "failure", "hasMore", "historyHead", "historyRevision", "liveMessage", "liveTools", "oldestEntryId", "partial", "projectionId", "protocol", "queuedItems", "queuedMessages", "resources", "revision", "run", "settings", "submissions", "toolNames"].filter(key => key in frame.data).sort(),
      "an advancing frame carries the snapshot's scalars and the continuity fields, nothing else",
    );
    previous = frame.data.revision as number;
  }
  const appended = advancing.flatMap(frame => frame.data.appended as ServerSnapshot["entries"]);
  const held = new Set(baseline.entries.map(entry => entry.id));
  assert.ok(appended.length > 0, "the turn appended something");
  assert.ok(appended.every(entry => entry !== undefined && typeof entry.id === "string"), "every appended item is an entry: " + JSON.stringify(advancing.map(frame => frame.data.appended)));
  assert.ok(appended.some(entry => entry.role === "assistant"), "the answer this turn produced was appended");
  assert.equal(appended.some(entry => held.has(entry.id)), false, "no entry the client already held is re-sent");
  assert.equal(new Set(appended.map(entry => entry.id)).size, appended.length, "and no entry is appended twice");
  assert.equal(advancing.some(frame => (frame.data.appended as unknown[]).length === 0), true, "a frame that appended nothing still advances the revision");

  // The appended entry is the same projection every other surface serves: one expression, not a second shape.
  const answer = appended.find(entry => entry.role === "assistant")!;
  const read = await fetch(origin + "/api/conversations/" + id + "/entries/" + answer.id, { headers });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json() as { entry: unknown }).entry, answer, "the delta entry is byte-identical to the single-entry read");
});
/**
 * A conversation whose active range already starts at a head marker, seeded before the backend boots: the marker is a
 * committed fact of the view the attachment acquires, and the advancing frames must keep continuing a window that has
 * one. (A head marker that **moves** is the case that ends a loaded window, and it is asserted where the rule lives —
 * `continuationIndex` in `apps/server/test/history-window.test.ts` — because a second writer on the same SQLite file
 * would be a second session rather than an advance this attachment publishes.)
 */
async function seedWithHeadMarker(dbPath: string, turns: number): Promise<{ id: string; models: Models; headId: string }> {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL } }, BACKGROUND_CONTEXT);
  const conversation = created.id as ConversationId;
  await harness.harness.commit(async (tx) => {
    for (let turn = 0; turn < turns; turn += 1) await tx.appendEntry(UserEntry, conversation, { model: [{ role: "user", content: "user " + turn, timestamp: turn }] });
  }, BACKGROUND_CONTEXT);
  const kept = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: conversation }, 200, undefined), BACKGROUND_CONTEXT)).items;
  await harness.harness.commit(tx => tx.appendEntry(CompactionEntry, conversation, { model: [{ role: "user", content: "summary of everything", timestamp: 0 }], data: { reason: "threshold" }, head: kept[1]!.id }), BACKGROUND_CONTEXT);
  const headId = String((await harness.harness.commit(tx => tx.latestHeadMarker(conversation), BACKGROUND_CONTEXT))!.id);
  await harness.close();
  return { id: String(conversation), models: harness.models, headId };
}

test("a window that starts at a head marker is continued by the advancing frames, not restated", async (t) => {
  const dbPath = await store("head-marker");
  const seeded = await seedWithHeadMarker(dbPath, 4);
  const origin = await start(t, dbPath, seeded.models);
  const stream = reader(await fetch(origin + "/api/conversations/" + seeded.id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  const baseline = stream.frames.find(frame => frame.event === "snapshot")!.data as unknown as ServerSnapshot;
  assert.equal(baseline.historyHead, seeded.headId, "the baseline states the head marker the window was cut under");
  assert.equal(baseline.entries[0]!.id, seeded.headId, "and the native view keeps the marker first");

  assert.equal((await submit(origin, seeded.id, "one more turn")).status, 202);
  await stream.until(frames => frames.some(frame => frame.event === "state" && (frame.data.appended as { role: string }[]).some(entry => entry.role === "assistant")), "the answer to be appended");
  await stream.cancel();

  const advancing = stream.frames.filter(frame => frame.event === "state");
  let previous = baseline.revision;
  for (const frame of advancing) {
    assert.equal(frame.data.baseRevision, previous, "a window with a head marker is still continued, not restated");
    assert.equal("entries" in frame.data, false, "so the frame carries what it appended rather than the window");
    previous = frame.data.revision as number;
  }
  // The marker is part of the window the baseline stated, so it is never re-appended by a later frame.
  const appended = advancing.flatMap(frame => frame.data.appended as ServerSnapshot["entries"]);
  assert.equal(appended.some(entry => entry.id === seeded.headId), false, "the head marker the client already holds is not re-sent");
  assert.equal(appended.some(entry => entry.role === "assistant"), true, "and the answer this turn produced is");
});
test("redaction holds on an appended entry exactly as it does on the baseline", async (t) => {
  const dbPath = await store("redaction");
  const seeded = await seed(dbPath, 2);
  // A credential failure the runtime copies into the assistant entry: the message quotes the operator's own
  // auth.json, so it is the one value that must not reach a frame — on the baseline, on a page, or on the entry this
  // turn appends.
  const secret = "Credential store read failed for /home/operator/.pi/agent/auth.json: SECRET-delta-value";
  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage("", { stopReason: "error", errorMessage: secret }); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const origin = await start(t, dbPath, models);
  const stream = reader(await fetch(origin + "/api/conversations/" + seeded.id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  assert.equal((await submit(origin, seeded.id, "one more turn")).status, 202);
  await stream.until(frames => frames.some(frame => frame.event === "state" && (frame.data.appended as { role: string }[]).some(entry => entry.role === "assistant")), "the failing answer to be appended");
  await stream.cancel();

  const appended = stream.frames.filter(frame => frame.event === "state").flatMap(frame => frame.data.appended as ServerSnapshot["entries"]);
  const answer = appended.find(entry => entry.role === "assistant")!;
  assert.equal(JSON.stringify(stream.frames).includes("SECRET-delta-value"), false, "the credential value does not ride any frame");
  assert.match((answer.message as { errorMessage?: string }).errorMessage ?? "", /could not be loaded/, "the appended entry carries the redacted message");
  // One expression projects the baseline, a page and the append, so the three agree entry for entry.
  const read = await (await fetch(origin + "/api/conversations/" + seeded.id + "/entries/" + answer.id, { headers })).json() as { entry: { message: unknown } };
  assert.deepEqual(read.entry.message, answer.message, "the appended entry is the same projection the single-entry read serves");
  const window = await (await fetch(origin + "/api/conversations/" + seeded.id + "/state", { headers })).json() as ServerSnapshot;
  assert.deepEqual(window.entries.find(entry => entry.id === answer.id)?.message, answer.message, "and the one the window serves");
});
/**
 * A conversation whose own compaction policy fires on the next turn: the summary is a head marker, and a head marker is
 * the one event that ends a loaded window. The trigger is the runtime's real threshold policy, not a test hook — the
 * test states the policy the backend is configured with and lets the runtime decide.
 */
test("a compaction that moves the head marker re-baselines the window instead of continuing it", async (t) => {
  const dbPath = await store("compaction");
  const seeded = await seed(dbPath, 4);
  const origin = await start(t, dbPath, seeded.models, { compaction: { enabled: true, reserveTokens: 128000, keepRecentTokens: 0, backgroundTokens: 0 } });
  const stream = reader(await fetch(origin + "/api/conversations/" + seeded.id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  const baseline = stream.frames.find(frame => frame.event === "snapshot")!.data as unknown as ServerSnapshot;
  assert.equal(baseline.historyHead, null, "a conversation with no compaction has no head marker");

  assert.equal((await submit(origin, seeded.id, "one more turn")).status, 202);
  // The head marker is the barrier: the frame that carries it is the re-baseline, and no sleep is involved.
  await stream.until(frames => frames.some(frame => frame.event === "state" && frame.data.historyHead !== null), "the compaction's head marker");
  // The turn keeps publishing after the marker, and the barrier is the same one the other cases use: the run is over.
  await stream.until(frames => frames.some(frame => frame.event === "state" && frame.data.historyHead !== null && frame.data.busy === false), "the turn to finish");
  await stream.cancel();

  const advancing = stream.frames.filter(frame => frame.event === "state");
  const rebaseline = advancing.find(frame => frame.data.historyHead !== null)!;
  assert.equal(stream.frames.filter(frame => frame.event === "state" && frame.data.historyHead === null).length > 0, true, "the ordinary appends came first");
  assert.ok(Array.isArray(rebaseline.data.entries), "the frame that moved the head marker carries the whole window");
  assert.equal("appended" in rebaseline.data, false, "and is not an append: a truncation and an append are never one frame");
  assert.equal("baseRevision" in rebaseline.data, false, "so it continues no revision");
  // Every frame before it was an ordinary continuation, and every frame after it continues the re-baseline.
  for (const frame of advancing.slice(0, advancing.indexOf(rebaseline))) assert.equal(typeof frame.data.baseRevision, "number", "the frames before the marker were appends");
  const after = advancing.slice(advancing.indexOf(rebaseline) + 1);
  assert.ok(after.length > 0, "the turn kept publishing after the compaction");
  for (const frame of after) {
    assert.equal(typeof frame.data.baseRevision, "number", "the frames after the marker continue it again: " + JSON.stringify(frame.data.baseRevision));
    assert.equal("entries" in frame.data, false, "and none of them restates the window");
  }
});

test("an advancing frame carries the window's own trim, and it is the trim the client prunes to", async (t) => {
  // A conversation long enough that the window is at its visible cap when the turn arrives: the frame that appends must
  // state the window's new oldest id, because a frame that appends carries no window for a client to read it off.
  const dbPath = await store("trim");
  const seeded = await seed(dbPath, 60);
  const origin = await start(t, dbPath, seeded.models);
  const stream = reader(await fetch(origin + "/api/conversations/" + seeded.id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  const baseline = stream.frames.find(frame => frame.event === "snapshot")!.data as unknown as ServerSnapshot;
  assert.equal(baseline.hasMore, true, "the window is not the whole transcript");
  assert.equal(baseline.oldestEntryId, baseline.entries[0]!.id, "and it states its own first entry");

  assert.equal((await submit(origin, seeded.id, "one more turn")).status, 202);
  await stream.until(frames => frames.some(frame => frame.event === "state" && (frame.data.appended as unknown[]).length > 0), "the appended entry");
  // Fold against the window as it stands once the turn is over, so the comparison is with one window and not with a
  // later one the run kept moving.
  await stream.until(frames => frames.some(frame => frame.event === "state" && frame.data.busy === false), "the turn to finish");
  await stream.cancel();

  const advancing = stream.frames.filter(frame => frame.event === "state");
  const appended = advancing.flatMap(frame => frame.data.appended as ServerSnapshot["entries"]);
  // Fold the stream the way a client does: the baseline window, then what each frame appended, pruned to the frame's own
  // boundary. The result is the server's window — which is the contract the trim exists to state.
  const held = new Map(baseline.entries.map(entry => [entry.id, entry]));
  let boundary: string | null = baseline.oldestEntryId;
  for (const frame of advancing) {
    for (const entry of frame.data.appended as ServerSnapshot["entries"]) held.set(entry.id, entry);
    boundary = frame.data.oldestEntryId as string | null;
    if (boundary !== null) for (const id of [...held.keys()]) if (Number(id) < Number(boundary)) held.delete(id);
  }
  assert.ok(boundary !== null, "the turn moved the window forward");
  const read = await (await fetch(origin + "/api/conversations/" + seeded.id + "/state", { headers })).json() as ServerSnapshot;
  assert.deepEqual([...held.keys()], read.entries.map(entry => entry.id), "the folded window is exactly the server's window");
  assert.equal(boundary, read.oldestEntryId, "and the boundary the frames stated is the one the window has");
  assert.ok(appended.length > 0, "the turn appended entries");
  assert.equal(appended.every(entry => held.has(entry.id)), true, "every appended entry is inside the window the trim kept");
});

/**
 * The same named refusal, on the delta path, for the content the design records as a limit: a structured tool call's
 * input has no read block of its own, so a turn that appends one ships it whole or states that it could not. (A large
 * **text** output is no longer such a case — it is deferred to a preview behind a read block, asserted in
 * `history-text.test.ts`.) What must hold either way is that the refusal is **named** — the reason, the entry and its
 * size — that the stream stays open rather than being destroyed by the transport guard, and that the entry is still
 * readable by id. The delta path is where this is easiest to get wrong: the frame the clients are refused is the one
 * that carries the appended entry, not the window.
 */
test("an advance whose appended entry cannot be carried states the refusal, keeps the stream, and leaves the entry readable", async (t) => {
  const dbPath = await store("oversize-append");
  const seeded = await seed(dbPath, 2);
  // A turn whose own answer is a tool call carrying a structured input past the frame bound: the runtime really runs
  // it and the entry really lands, and no deferral policy applies to a tool call's input, so the frame that would carry
  // it cannot be shrunk. The input is the smallest that clears both bounds the test states — `FRAME_LIMIT_BYTES`
  // (1 MiB - 64 KiB), which is what makes the refusal happen, and the "over 1 MiB" size the refusal reports — so the
  // fixture is a boundary case rather than a payload four times the size of the one it is testing.
  const huge = "build log line: ".repeat(65_600);
  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/build.log", content: huge })); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const origin = await start(t, dbPath, models);
  const stream = reader(await fetch(origin + "/api/conversations/" + seeded.id + "/events", { headers }));
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline");
  const baseline = stream.frames.find(frame => frame.event === "snapshot")!.data as unknown as ServerSnapshot;
  assert.equal(baseline.revision, 0, "the baseline is inside the guard, so the conversation opens normally");
  assert.equal((await submit(origin, seeded.id, "one more turn")).status, 202);

  await stream.until(frames => frames.some(frame => frame.event === "state_oversize"), "the named refusal");
  const refusal = stream.frames.find(frame => frame.event === "state_oversize")!.data as { reason: string; entryId: string; bytes: number };
  assert.equal(refusal.reason, "frame_too_large", "the refusal names the reason");
  assert.ok(refusal.bytes > 1024 * 1024, "and states the size it could not carry: " + refusal.bytes);
  assert.equal(typeof refusal.entryId, "string", "and names the entry");

  // The stream is still open: a later commit publishes on the same connection rather than the transport destroying it
  // and the client reconnecting to the same refusal forever.
  const afterRefusal = stream.frames.length;
  assert.equal((await submit(origin, seeded.id, "and another turn")).status, 202);
  await stream.until(frames => frames.length > afterRefusal, "a frame after the refusal on the same connection");
  assert.equal(stream.frames.slice(afterRefusal).some(frame => frame.event === "submission" || frame.event === "state" || frame.event === "state_oversize"), true, "the connection was not destroyed by the refusal: " + stream.frames.slice(afterRefusal).map(frame => frame.event).join(","));

  // And the entry the frame could not carry is served whole by the by-id read.
  const entry = await (await fetch(origin + "/api/conversations/" + seeded.id + "/entries/" + refusal.entryId, { headers })).json() as { entry: { message: { content: { type: string; arguments?: { content?: string }; input?: { content?: string } }[] } } };
  const call = entry.entry.message.content[0]!;
  assert.equal(call.type, "toolCall");
  // The runtime's own field is `arguments`; a normalized copy uses `input`. Either way the point is the same: the
  // entry is served whole rather than truncated to something a frame could carry.
  assert.equal(((call.arguments ?? call.input)!.content!).length, huge.length, "the whole entry is still readable, not truncated");
  await stream.cancel();
});
