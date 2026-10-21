import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, CompactionEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { reduceSseFrame, type SessionState } from "@hepi/session";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

/**
 * The SDK reducer against the **real** backend contract, not a hand-written frame shape.
 *
 * The reducer's whole job is to fold what the server actually publishes, and the fact it folds on is the window's own
 * boundary. A fixture that invents that boundary tests the invention: every read here is an HTTP read of a running
 * backend, and the snapshot the reducer is given is the bytes that backend sent.
 */
const directories: string[] = [];
const token = "reducer-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function store(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-" + label + "-"));
  directories.push(directory);
  return join(directory, "reducer.sqlite");
}

async function seed(dbPath: string, turns: number): Promise<string> {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const id = created.id as ConversationId;
  await harness.harness.commit(async (tx) => {
    for (let turn = 0; turn < turns; turn += 1) {
      await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "user " + turn, timestamp: turn * 2 }] });
      await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage("answer " + turn, { timestamp: turn * 2 + 1 })] });
    }
  }, BACKGROUND_CONTEXT);
  await harness.close();
  return String(id);
}

/**
 * The size of one entry in the marker fixture: large enough that the frame budget holds only a handful of them, so the
 * window's oldest entry moves within a few turns instead of past fifty visible ones.
 */
const BULK = 100_000;
/**
 * One conversation whose active range already starts at a head marker, seeded before the backend boots. A compaction
 * summary is kept **first** by the native view and carries a *newer* id than the entries it heads, which is what makes
 * it the case an id comparison gets wrong: a client folding the stream against a fresh read has to hold the same
 * window, and by id it would keep the marker the window no longer reaches.
 */
async function seedWithHeadMarker(dbPath: string): Promise<{ id: string; headId: string }> {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL } }, BACKGROUND_CONTEXT);
  const conversation = created.id as ConversationId;
  await harness.harness.commit(async (tx) => {
    for (let turn = 0; turn < 3; turn += 1) await tx.appendEntry(UserEntry, conversation, { model: [{ role: "user", content: turn + " " + "u".repeat(BULK), timestamp: turn }] });
  }, BACKGROUND_CONTEXT);
  const kept = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: conversation }, 200, undefined), BACKGROUND_CONTEXT)).items;
  await harness.harness.commit(tx => tx.appendEntry(CompactionEntry, conversation, { model: [{ role: "user", content: "summary of everything", timestamp: 0 }], data: { reason: "threshold" }, head: kept[0]!.id }), BACKGROUND_CONTEXT);
  const headId = String((await harness.harness.commit(tx => tx.latestHeadMarker(conversation), BACKGROUND_CONTEXT))!.id);
  await harness.close();
  return { id: String(conversation), headId };
}

/**
 * How long a frame that must arrive is waited for before the test calls it absent. It is a hang guard, not a timing
 * fact: every wait below settles on bytes the backend wrote.
 */
const DEADLINE_MS = 20_000;

/** One SSE frame as the reader reassembled it across chunk boundaries: its event name and its parsed payload. */
type Frame = { event: string; data: unknown };

/**
 * The conversation stream as the backend wrote it, waited on by **barrier** instead of by poll.
 *
 * `until` is checked the moment a frame is parsed, so a wait ends on the frame that satisfies it rather than on the
 * next tick of a sleep loop; it fails when the stream ends or at the deadline, which is what turns a frame that never
 * arrives into a failure instead of a hang. The frames it hands back are in wire order, which is the order a client
 * folds them in.
 */
type Stream = {
  /** The frames received so far, in wire order. */
  readonly frames: readonly Frame[];
  /** Resolves with the frames received once a received frame satisfies the predicate. */
  until(predicate: (frames: readonly Frame[]) => boolean, description: string): Promise<readonly Frame[]>;
  cancel(): Promise<void>;
};

async function attach(origin: string, id: string): Promise<Stream> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers });
  assert.equal(response.status, 200);
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const pump = (async () => {
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const line = raw.split("\n").find(value => value.startsWith("data: "));
        if (event === undefined || line === undefined) continue;
        frames.push({ event, data: JSON.parse(line.slice(6)) });
        wake();
      }
    }
  })().finally(() => { ended = true; wake(); });
  const until = (predicate: (frames: readonly Frame[]) => boolean, description: string): Promise<readonly Frame[]> => {
    if (predicate(frames)) return Promise.resolve(frames);
    return new Promise<readonly Frame[]>((resolve, reject) => {
      const settle = (): void => {
        if (!ended && !predicate(frames)) return;
        clearTimeout(timer); waiters.delete(settle);
        if (ended && !predicate(frames)) reject(new Error("the stream ended before " + description + "; frames: " + frames.map(frame => frame.event).join(",")));
        else resolve(frames);
      };
      const timer = setTimeout(() => {
        waiters.delete(settle);
        reject(new Error("timed out waiting for " + description + "; frames: " + frames.map(frame => frame.event).join(",")));
      }, DEADLINE_MS);
      waiters.add(settle);
    });
  };
  return {
    frames,
    until,
    async cancel() { waiters.clear(); await body.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

test("a window that moves past a compaction summary drops it, exactly as a fresh read does", async (t) => {
  // The boundary is a **position** in the native order, not an id. The native view keeps a compaction summary **first**
  // while giving it a *newer* id than the entries it heads, so once the window's oldest entry is one of those headed
  // entries, an id comparison puts the summary — the newest id in the state — on the window's side of its own boundary
  // and keeps it forever. A client that just opened the conversation holds the window; the folded stream has to hold
  // exactly that, and both folds are of the backend's own bytes.
  const dbPath = await store("real-head-marker");
  const seeded = await seedWithHeadMarker(dbPath);
  const server = await start(t, dbPath);
  server.reply("a".repeat(BULK));
  const baseline = await state(server.origin, seeded.id);
  assert.equal(baseline.historyHead, seeded.headId, "the window was cut under the head marker");
  assert.equal(baseline.entries[0]!.id, seeded.headId, "the native view keeps the summary first");
  assert.equal(baseline.entries.length < 50, true, "and the whole range fits, so the baseline states no boundary");

  // Every frame the backend writes is folded, in wire order, from a cursor: the stream is the client's whole input, so
  // nothing it published is skipped. A frame published between the baseline and the first turn — the backend's own
  // post-boot advance — is part of that input too, and folding from a cursor makes that fact independent of when the
  // test happened to look.
  let folded: SessionState = { protocol: "hepi.v1", conversationId: seeded.id, revision: 0, entries: [], partial: "", busy: false };
  let foldedUpTo = 0;
  const foldTo = (frames: readonly Frame[], upTo = Number.POSITIVE_INFINITY): void => {
    for (; foldedUpTo < frames.length; foldedUpTo += 1) {
      const frame = frames[foldedUpTo]!;
      if (frame.event !== "state" && frame.event !== "snapshot") continue;
      // A publication newer than the window under comparison belongs to the next one, so the fold stops where the
      // window that was read stops instead of running ahead of it.
      if (((frame.data as { revision?: number }).revision ?? 0) > upTo) continue;
      folded = reduceSseFrame(folded, frame.event, frame.data);
      assert.equal(folded.resyncRequired, false, "a real advancing frame is applied, not resynchronized");
    }
  };

  const stream = await attach(server.origin, seeded.id);
  foldTo(await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline"));
  // Turns until the window has moved past the summary: the summary leaves the range only when the window's own start
  // does, which is the point at which an id comparison would keep it.
  for (let turn = 0; turn < 12 && folded.entries.some(entry => entry.id === seeded.headId); turn += 1) {
    const submitted: Response = await fetch(server.origin + "/api/conversations/" + seeded.id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "marker-" + turn, text: "turn " + turn + " " + "t".repeat(BULK) }) });
    assert.equal(submitted.status, 202);
    // The turn's end is the idle `state` frame that follows it, and that frame is the barrier: the wait settles on the
    // backend's own byte, so what is folded below is everything it wrote up to the end of the turn.
    const frames = await stream.until(current => current.some(frame => frame.event === "state" && (frame.data as { busy: boolean }).busy === false), "the turn finished");
    foldTo(frames);
  }
  // The window the backend then serves is the one the fold must hold, and its revision names the last frame that
  // belongs to that window — so the barrier is that frame, and the fold ends on the same publication the read did.
  const after = await state(server.origin, seeded.id);
  foldTo(await stream.until(current => current.some(frame => frame.event === "state" && (frame.data as { revision: number }).revision >= after.revision), "the frame the window was read at"), after.revision);
  await stream.cancel();
  assert.equal(folded.entries.some(entry => entry.id === seeded.headId), false, "the summary left the window");

  const equivalent = reduceSseFrame({ protocol: "hepi.v1", conversationId: seeded.id, revision: 0, entries: [], partial: "", busy: false }, "snapshot", after);
  assert.deepEqual(folded.entries.map(entry => entry.id), equivalent.entries.map(entry => entry.id), "the folded stream holds exactly the window a fresh read states");
  assert.equal(folded.entries.length, after.entries.length, "and no entry the window dropped, the summary included");
});

async function start(t: TestContext, dbPath: string): Promise<{ origin: string; reply: (text: string) => void }> {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("ok")]);
  const backend: BackendServer = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  // The faux provider hands out a queued reply once; a reply that re-arms itself answers every turn with the same
  // size, which is what lets a few turns fill the frame budget.
  const reply = (text: string): void => {
    const answer = async () => { faux.setResponses([answer]); return fauxAssistantMessage(text); };
    faux.setResponses([answer]);
  };
  return { origin: "http://127.0.0.1:" + address.port, reply };
}

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as ServerSnapshot;
}

/** The reducer's own state type, over entries the backend published; the wire entries carry more than the reducer reads. */
function heldFrom(conversationId: string, entries: ServerSnapshot["entries"]): SessionState {
  return { protocol: "hepi.v1", conversationId, revision: 0, entries: entries as unknown as SessionState["entries"], partial: "", busy: false };
}

test("the real window snapshot folds into a session that already paged history behind it", async (t) => {
  const dbPath = await store("real-window");
  const id = await seed(dbPath, 60);
  const server = await start(t, dbPath);
  const snapshot = await state(server.origin, id);
  assert.equal(snapshot.hasMore, true, "the backend states the window is not the whole transcript");
  assert.equal(snapshot.oldestEntryId, snapshot.entries[0]!.id, "and names its own first entry");

  const older = await (await fetch(server.origin + "/api/conversations/" + id + "/entries?before=" + snapshot.entries[0]!.id + "&tail=50", { headers })).json() as { entries: ServerSnapshot["entries"] };
  const held = heldFrom(id, [...older.entries, ...snapshot.entries]);
  const merged = reduceSseFrame(held, "snapshot", snapshot);
  assert.equal(merged.entries.length, held.entries.length, "the loaded prefix survives the bounded snapshot");
  assert.equal(merged.entries[0]!.id, older.entries[0]!.id, "and is still ahead of the window");
  assert.equal(new Set(merged.entries.map(entry => entry.id)).size, merged.entries.length, "no entry is duplicated across the boundary");
  assert.equal(merged.hasMore, true, "the window's own facts reach the caller");
  assert.equal(merged.oldestEntryId, snapshot.oldestEntryId);
});

test("a complete window from the backend replaces, so a short conversation is exact", async (t) => {
  const dbPath = await store("real-complete");
  const id = await seed(dbPath, 3);
  const server = await start(t, dbPath);
  const snapshot = await state(server.origin, id);
  assert.equal(snapshot.hasMore, false);
  assert.equal(snapshot.oldestEntryId, null, "a complete transcript states no boundary");
  const stale = heldFrom(id, [{ id: "1", role: "user", text: "an entry the transcript no longer holds" }] as unknown as ServerSnapshot["entries"]);
  const merged = reduceSseFrame(stale, "snapshot", snapshot);
  assert.deepEqual(merged.entries.map(entry => entry.id), snapshot.entries.map(entry => entry.id));
});

/**
 * The delta stream against the **real** backend, folded with the shared reducer a client uses.
 *
 * The reducer's delta path is one rule, and the fact it folds on is the frame's own continuity: a frame that appends
 * states the revision it continues, the entries it produced, and the window's new boundary. Folding a real turn's
 * frames therefore has to produce the same state as folding the backend's own window afterwards — over the tail window
 * and over every scalar — and that equality is what an append-only design without the window trim fails.
 */
test("folding a real turn's advancing frames equals folding the window the backend then serves", async (t) => {
  const dbPath = await store("real-delta");
  const id = await seed(dbPath, 60);
  const server = await start(t, dbPath);
  const baseline = await state(server.origin, id);
  assert.equal(baseline.hasMore, true, "the conversation is longer than the window");

  const stream = await attach(server.origin, id);
  await stream.until(frames => frames.some(frame => frame.event === "snapshot"), "the baseline arrived");

  const submitted = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "reducer-delta", text: "one more turn" }) });
  assert.equal(submitted.status, 202);
  await stream.until(current => current.some(frame => frame.event === "state" && (frame.data as { busy: boolean }).busy === false), "the turn finished");
  // The turn's own end is not the end of the turn's *publications*: a settlement frame follows it. The window the
  // backend then serves is the whole of what the turn produced, and its revision names the last frame that belongs to
  // it — so that frame is the barrier, and the fold below covers exactly the frames the comparison is about.
  const after = await state(server.origin, id);
  const frames = await stream.until(current => current.some(frame => frame.event === "state" && (frame.data as { revision: number }).revision >= after.revision), "the frame the window was read at");
  await stream.cancel();

  // Folded the way a client folds: the baseline window, then what each advancing frame appended. The comparison is
  // against the same baseline — folding the later window onto an empty state would compare two different starting
  // points, and the window's own boundary is exactly the fact that makes them the same starting point.
  const opened = reduceSseFrame({ protocol: "hepi.v1", conversationId: id, revision: 0, entries: [], partial: "", busy: false }, "snapshot", frames.find(frame => frame.event === "snapshot")!.data);
  let folded = opened;
  let advanced = 0;
  for (const frame of frames) {
    if (frame.event !== "state") continue;
    // The comparison is against the window that was read, so a publication newer than it is not part of this fold.
    if ((frame.data as { revision: number }).revision > after.revision) continue;
    const before = folded;
    folded = reduceSseFrame(folded, "state", frame.data);
    assert.equal(folded.resyncRequired, false, "a real advancing frame is applied, not resynchronized");
    if (folded.revision > before.revision) advanced += 1;
  }
  assert.ok(advanced > 0, "the turn advanced the stream");
  assert.ok(frames.some(frame => frame.event === "state" && (frame.data as { appended: unknown[] }).appended.length === 0), "and at least one frame appended nothing");

  // The equivalent snapshot fold: the window the backend serves once the turn is over, folded onto the same baseline.
  const equivalent = reduceSseFrame(opened, "snapshot", after);
  const scalars = (state: SessionState) => ({ revision: state.revision, busy: state.busy, partial: state.partial, oldestEntryId: state.oldestEntryId, hasMore: state.hasMore });
  assert.deepEqual(folded.entries.map(entry => entry.id), equivalent.entries.map(entry => entry.id), "the delta fold and the snapshot fold hold the same transcript");
  assert.deepEqual(scalars(folded), scalars(equivalent), "and state the same window and run scalars");
  assert.equal(folded.revision, after.revision, "the delta fold ends at the revision the window was read at");
});
