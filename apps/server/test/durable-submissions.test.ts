import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
const token = "submissions-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Projected = NonNullable<ServerSnapshot["submissions"]>[number];
type Entry = ServerSnapshot["entries"][number];

/**
 * One frame as a client receives it: the event, its own payload, and the state a client holds after folding it.
 *
 * The window is captured **when the frame arrives**, so a frame still waiting in the queue carries the state it was
 * published with rather than the newest one, and a test can compare a frame against the state that frame stated.
 */
type Observed = { readonly event: string; readonly data: unknown; readonly window: HeldWindow<Entry> };

/**
 * One test's own event source: the frames as they arrive, in order, and the state those frames build as a client folds
 * them. A test never asks the backend whether something has happened yet — it waits for the frame that states it, which
 * is the fact a browser acts on, so a wait is the stream's own barrier rather than a delay long enough to be likely.
 */
type EventSource = {
  follow: (match: (frame: Observed) => boolean) => Promise<Observed>;
  close: () => Promise<void>;
};

/**
 * A backend whose model answer is held until released, so "the run is in flight" is a real state a test can observe
 * instead of a race. One switch releases every turn: the factory re-registers itself, so a second turn in the same
 * test is held and released the same way rather than exhausting the scripted response.
 */
async function start(t: TestContext): Promise<{ backend: BackendServer; origin: string; release: () => void; dbPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-submissions-"));
  directories.push(directory);
  const dbPath = join(directory, "submissions.sqlite");
  let releaseResponse!: () => void;
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (): Promise<AssistantMessage> => { faux.setResponses([respond]); await release; return fauxAssistantMessage("answer for the turn"); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  // The switch is released in a test's own cleanup too, so a failed assertion cannot leave a run holding the harness.
  t.after(() => { releaseResponse(); return backend.close(); });
  return { backend, origin: "http://127.0.0.1:" + address.port, release: releaseResponse, dbPath };
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

const submit = (origin: string, id: string, requestId: string, text: string, whenBusy?: "steer" | "followUp") =>
  fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text, ...(whenBusy ? { whenBusy } : {}) }) });

/** The HTTP read of one conversation's state: the route a client without a stream uses, kept as its own assertion. */
async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as ServerSnapshot;
}

const submissionOf = (current: { submissions?: readonly Projected[] }, requestId: string): Projected | undefined =>
  (current.submissions ?? []).find(submission => submission.requestId === requestId);

/**
 * The state that says a turn is over: its answer is committed and no run is in flight. Every wait for a settlement is
 * this frame, so a test is told the turn ended instead of asking whether it has ended yet.
 */
const idle = (frame: Observed): boolean => (frame.event === "state" || frame.event === "snapshot") && !frame.window.busy && frame.window.entries.some(entry => entry.role === "assistant");

/** The state in which a submission has left the outstanding set, stated after its answer landed. */
const cleared = (requestId: string) => (frame: Observed): boolean => idle(frame) && submissionOf(frame.window, requestId) === undefined;

const lookup = async (origin: string, id: string, requestId: string): Promise<{ submission: Projected | null }> => {
  const response = await fetch(origin + "/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent(requestId), { headers });
  assert.equal(response.status, 200);
  return await response.json() as { submission: Projected | null };
};

/**
 * One SSE reader over a conversation's event stream: the frames as they arrive, in order, and the transcript those
 * frames build as a client folds them. Tests read the real text/event-stream the browser reads, so a lifecycle fact is
 * only delivered when a client actually receives it, and a window is only what the client has by then.
 *
 * `follow` is the barrier: it resolves on the frame that satisfies the predicate, folding every frame on the way
 * through the shared reducer a real client uses, so the state a test asserts on is the state the client holds at that
 * frame. Nothing is polled and nothing is slept on, so a wait costs one frame and cannot be satisfied by a delay.
 */
async function openStream(origin: string, id: string): Promise<EventSource> {
  // The connection carries its own bound, so a stream that goes quiet fails the test instead of hanging it; it is a
  // property of the transport, not a deadline the test races.
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  let pending = "";
  const frames: Observed[] = [];
  return {
    async follow(match) {
      while (true) {
        const found = frames.findIndex(match);
        if (found >= 0) return frames.splice(found, 1)[0];
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the event stream ended while a frame was still expected");
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const line = frame.split("\n").find(value => value.startsWith("data: "));
          if (event === undefined || line === undefined) continue;
          const data = JSON.parse(line.slice(6));
          if (event === "snapshot" || event === "state") folder.fold(event, data);
          frames.push({ event, data, window: folder.current() });
        }
      }
    },
    async close() { await reader.cancel(); },
  };
}

test("a turn in flight is projected as a placed submission, and leaves the projection when it settles", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-placed", "hello")).status, 202);
  // While the run is held, the submission is the durable statement about the turn: it is placed, and it names the
  // committed entry the client is waiting to see an answer for.
  const placedFrame = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-placed" && (frame.data as Projected).status === "placed");
  const placed = placedFrame.data as Projected;
  // The lifecycle frame is announced before the state frame that carries the same submission, so the state is read
  // where it states it: one frame later, not from a delay that hopes it has landed.
  const projected = await stream.follow(frame => (frame.event === "state" || frame.event === "snapshot") && submissionOf(frame.window, "req-placed")?.status === "placed");
  assert.equal(submissionOf(projected.window, "req-placed")?.submissionId, placed.submissionId, "the state frame carries the submission the lifecycle frame stated");
  assert.equal(placed.type, "input");
  assert.equal(placed.conversationId, id);
  assert.ok(placed.entryId !== undefined && placed.entryId !== "");
  assert.equal(placed.reason, undefined, "a placed submission has not failed");
  // The transcript is unchanged by the projection: this is the same state a client always read.
  assert.deepEqual(placed.entryId, (await state(server.origin, id)).entries.find(entry => entry.role === "user")?.id);
  server.release();
  // Settled: its answer is in the transcript, so the projection ends. A client holding it would otherwise show an
  // outstanding turn forever.
  const settled = await stream.follow(cleared("req-placed"));
  assert.equal(submissionOf(settled.window, "req-placed"), undefined);
  await stream.close();
});

test("a queued input is projected as queued, which no entry could tell a client", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-first", "first")).status, 202);
  const queuedResponse = await submit(server.origin, id, "req-queued", "queued text", "followUp");
  assert.equal(queuedResponse.status, 202);
  // A queued input has no entry at all, so the transcript cannot carry it: only the submission record can say it is
  // waiting rather than lost.
  const queued = (await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-queued" && (frame.data as Projected).status === "queued")).data as Projected;
  assert.equal(queued.entryId, undefined, "a queued submission owns no entry yet");
  const listed = await stream.follow(frame => submissionOf(frame.window, "req-queued")?.status === "queued" && (frame.window.queuedMessages?.followUp.length ?? 0) === 1);
  assert.deepEqual(listed.window.queuedMessages, { steering: [], followUp: ["queued text"] }, "the queue the client already read is unchanged");
  server.release();
  await stream.follow(idle);
  await stream.close();
});

test("a recalled submission settles as unanswered instead of staying outstanding", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-run", "run")).status, 202);
  assert.equal((await submit(server.origin, id, "req-recall", "recall me", "followUp")).status, 202);
  await stream.follow(frame => submissionOf(frame.window, "req-recall")?.status === "queued");
  const recalled = await fetch(server.origin + "/api/conversations/" + id + "/recall-queue", { method: "POST", headers });
  assert.equal(recalled.status, 200);
  // Withdrawal is terminal for that submission: it will never be placed, so a projection that kept it pending would
  // keep waiting for a turn the user deliberately took back. The frames after the recall are the ones that state it,
  // so the wait is for a revision the recall itself published rather than for the absence of a row.
  const unanswered = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-recall" && (frame.data as Projected).status === "unanswered");
  const withdrawn = unanswered.window.revision;
  const after = await stream.follow(frame => frame.window.revision > withdrawn && submissionOf(frame.window, "req-recall") === undefined);
  assert.equal(submissionOf(after.window, "req-recall"), undefined);
  server.release();
  await stream.follow(idle);
  await stream.close();
});

test("the recovery lookup answers the durable record, and never invents one", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-recover", "recover me")).status, 202);
  const placed = (await lookup(server.origin, id, "req-recover")).submission;
  assert.ok(placed !== null);
  assert.equal(placed.requestId, "req-recover");
  assert.equal(placed.status, "placed");
  assert.ok(placed.entryId !== undefined);
  // An id this conversation never admitted is answered as absent, which is a statement about the request rather than a
  // failed lookup: the client learns the submission does not exist instead of guessing.
  assert.equal((await lookup(server.origin, id, "req-nonexistent")).submission, null);
  const blank = await fetch(server.origin + "/api/conversations/" + id + "/submissions?requestId=", { headers });
  assert.equal(blank.status, 400);
  server.release();
  await stream.follow(idle);
  // Once answered, the same lookup reports the terminal record, which is what a client hydrates from.
  const done = (await lookup(server.origin, id, "req-recover")).submission;
  assert.ok(done !== null);
  assert.equal(done.status, "done");
  assert.ok(done.entryId !== undefined);
  await stream.close();
});

test("the event stream carries the submission projection beside the state it already sent", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-stream", "streamed")).status, 202);
  // Every state frame carries the same state projection it always was, with the submission set added rather than
  // replacing anything: a client that ignores the new field reads exactly what it read before.
  const wellFormed = (frame: Observed): HeldWindow<Entry> => {
    const held = frame.window;
    assert.equal(held.protocol, "hepi.v1");
    assert.equal(held.conversationId, id);
    assert.equal(typeof held.revision, "number");
    assert.ok(Array.isArray(held.entries) && Array.isArray(held.liveTools));
    assert.ok(Array.isArray(held.submissions), "every state frame carries the submission set");
    return held;
  };
  let seen = await stream.follow(frame => frame.event === "snapshot" || frame.event === "state");
  while (submissionOf(wellFormed(seen), "req-stream")?.status !== "placed") {
    seen = await stream.follow(frame => frame.event === "snapshot" || frame.event === "state");
  }
  server.release();
  await stream.follow(idle);
  await stream.close();
});

test("two clients read one submission set, and a second client sees a turn it never sent", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-shared", "shared turn")).status, 202);
  await stream.follow(frame => submissionOf(frame.window, "req-shared")?.status === "placed");
  // The projection is conversation state, not a reply to the sender: a client that never submitted reads the same
  // outstanding submission and can tell the turn is committed rather than missing.
  const other = await state(server.origin, id);
  const observed = submissionOf(other, "req-shared");
  assert.ok(observed !== undefined);
  assert.equal(observed.status, "placed");
  assert.deepEqual(other.entries.map(entry => entry.role), ["user"]);
  server.release();
  await stream.follow(idle);
  await stream.close();
});

test("a settled submission is delivered as a terminal frame, so a client that waits never has to infer it", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-terminal", "answered turn")).status, 202);
  // An idle conversation places the turn in the commit that admits it, so the first thing a client following it is told
  // is that it owns an entry — the intermediate state it cannot read out of the entries themselves.
  const placed = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-terminal" && (frame.data as Projected).status === "placed");
  assert.ok((placed.data as Projected).entryId !== undefined, "a placed submission names the entry it owns");
  server.release();
  // The terminal fact itself is delivered. A client that only watched the state frames would have seen the submission
  // silently leave the outstanding set, which is absence rather than a fact; here it is told what happened.
  const done = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-terminal" && (frame.data as Projected).status === "done");
  const projection = done.data as Projected;
  assert.equal(projection.submissionId, (placed.data as Projected).submissionId, "the terminal frame names the submission it was admitted as");
  assert.ok(projection.entryId !== undefined, "the answered submission names the entry that owns it");
  assert.equal(projection.reason, undefined, "an answered submission has no failure reason");
  await stream.follow(cleared("req-terminal"));
  await stream.close();
});

test("a recalled submission is delivered as unanswered with its reason, never as a silent disappearance", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-run2", "run")).status, 202);
  assert.equal((await submit(server.origin, id, "req-recall2", "recall me", "followUp")).status, 202);
  await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-recall2" && (frame.data as Projected).status === "queued");
  const recalled = await fetch(server.origin + "/api/conversations/" + id + "/recall-queue", { method: "POST", headers });
  assert.equal(recalled.status, 200);
  const unanswered = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-recall2" && (frame.data as Projected).status === "unanswered");
  // The reason is the durable one, so a client can say the turn was taken back rather than guessing from a missing row.
  assert.equal((unanswered.data as Projected).reason, "recalled");
  const withdrawn = unanswered.window.revision;
  const after = await stream.follow(frame => frame.window.revision > withdrawn && submissionOf(frame.window, "req-recall2") === undefined);
  assert.equal(submissionOf(after.window, "req-recall2"), undefined);
  await stream.close();
  server.release();
});

test("a reconnect re-reads the outstanding set instead of replaying terminal history", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-reconnect", "reconnect turn")).status, 202);
  await stream.follow(frame => submissionOf(frame.window, "req-reconnect")?.status === "placed");
  server.release();
  await stream.follow(cleared("req-reconnect"));
  await stream.close();
  // A client that connects now was never told anything, so the frame it opens with is the authoritative answer for the
  // whole conversation: the settled turn is absent from the outstanding set, and the lookup is where it learns more.
  const reconnected = await openStream(server.origin, id);
  const snapshotFrame = await reconnected.follow(frame => frame.event === "snapshot");
  assert.deepEqual((snapshotFrame.data as ServerSnapshot).submissions, [], "a settled submission is not replayed as outstanding");
  await reconnected.close();
  const late = (await lookup(server.origin, id, "req-reconnect")).submission;
  assert.ok(late !== null);
  assert.equal(late.status, "done", "the durable record is where a late client learns the outcome");
});

test("a terminal frame is delivered once and never replayed to a second client", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const first = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-once", "one turn")).status, 202);
  await first.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-once" && (frame.data as Projected).status === "placed");
  server.release();
  await first.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-once" && (frame.data as Projected).status === "done");
  // The settlement is stated by the state frame that leaves it out, so the second client is opened against a
  // conversation that has already published it rather than against one still about to.
  await first.follow(cleared("req-once"));
  await first.close();
  // A client that was not there when it settled is told the truth about the conversation rather than a replay of the
  // past: the terminal fact is not buffered, so memory does not grow with finished turns.
  const second = await openStream(server.origin, id);
  const frame = await second.follow(candidate => candidate.event === "snapshot");
  assert.deepEqual((frame.data as ServerSnapshot).submissions, []);
  await second.close();
});

test("the terminal frame carries the answer identity a notice is keyed by, and names its conversation", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-answer", "answered turn")).status, 202);
  server.release();
  const done = await stream.follow(frame => frame.event === "submission" && (frame.data as Projected).requestId === "req-answer" && (frame.data as Projected).status === "done");
  const projection = done.data as Projected;
  assert.equal(projection.conversationId, id, "a lifecycle frame names the conversation it belongs to");
  assert.equal(projection.type, "input");
  assert.equal(projection.reason, undefined, "an answered submission has no failure reason");
  assert.ok(projection.answerId !== undefined && projection.answerId !== "", "the terminal input carries its native answer identity");
  // The frame is not a snapshot and is not discarded by one: the settled submission has left the outstanding set, so
  // the frame is the only place its outcome is stated, and it survives a state snapshot that already shows the answer.
  // The window is stated once and appended to after it, so the frames are folded the way a client folds them: the
  // answer this turn produced is read out of the window the stream has built by then.
  const settled = await stream.follow(frame => (frame.event === "state" || frame.event === "snapshot") && frame.window.entries.some(entry => entry.role === "assistant"));
  assert.equal(projection.answerId, settled.window.entries.find(entry => entry.role === "assistant")?.id, "the answer identity is the committed answer entry");
  await stream.follow(idle);
  await stream.close();
});

test("a snapshot states the native run's inputs, and null when there is no run", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  // No run is null, not an empty input list: a run with no inputs is still a run, and reading the two alike would make
  // activity an inference rather than a fact.
  assert.equal((await state(server.origin, id)).run, null);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-run-inputs", "held turn")).status, 202);
  const busy = await stream.follow(frame => frame.window.run !== null && submissionOf(frame.window, "req-run-inputs")?.status === "placed");
  const placed = submissionOf(busy.window, "req-run-inputs");
  assert.ok(placed !== undefined);
  assert.deepEqual(busy.window.run?.inputs, [placed.submissionId], "the run names the submissions it will settle");
  assert.equal(busy.window.busy, true, "the run's presence is the activity the snapshot states");
  server.release();
  const settled = await stream.follow(frame => idle(frame) && frame.window.run === null);
  assert.equal(settled.window.run, null, "the run's absence is stated as null, never as an empty input list");
  await stream.close();
});

test("both transports carry one complete lifecycle payload under one projection identity", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  const opened = (await stream.follow(frame => frame.event === "snapshot")).data as ServerSnapshot;
  assert.equal(typeof opened.projectionId, "string");
  assert.ok(opened.projectionId.length > 0);
  assert.equal(/^[0-9]+$/.test(opened.projectionId), false, "the identity is opaque, so no two identities have a numerical order");
  assert.deepEqual(await state(server.origin, id), opened, "the HTTP read and the stream state are the same complete payload for one conversation");
  // With a turn in flight, both transports carry the same lifecycle payload: a client reads the entries, the
  // outstanding submissions, the run's inputs and the identity from one read, without joining unrelated requests.
  assert.equal((await submit(server.origin, id, "req-both", "held turn")).status, 202);
  await stream.follow(frame => submissionOf(frame.window, "req-both")?.status === "placed");
  let frame = await stream.follow(candidate => (candidate.event === "state" || candidate.event === "snapshot") && candidate.window.run !== null);
  let revision = frame.window.revision;
  let read = await state(server.origin, id);
  // The HTTP read answers the attachment's current state, which is the last revision it published, and the stream
  // delivers every revision it publishes. So a read that is ahead of the frames folded so far is caught up by reading
  // on — the revision that read answered at is a frame that will arrive — and the two transports are compared at one
  // revision instead of raced against each other.
  while (read.revision > frame.window.revision) {
    const target = read.revision;
    frame = await stream.follow(candidate => (candidate.event === "state" || candidate.event === "snapshot") && candidate.window.revision === target);
    assert.ok(frame.window.revision >= revision, "one identity publishes a monotone revision, so an older state is never the one served");
    revision = frame.window.revision;
    read = await state(server.origin, id);
  }
  assert.ok(frame.window.run !== null, "the run in flight reached the stream");
  assert.equal(frame.window.revision, read.revision);
  // The stream states its window once and appends after it, so the lifecycle payload the two transports agree about is
  // the one a client holds after folding those frames — the same comparison the pair of identities exists for.
  assert.deepEqual(read, { ...frame.window, projectionId: read.projectionId, historyRevision: read.historyRevision, historyHead: read.historyHead }, "both transports carry the same lifecycle payload while the run is in flight");
  server.release();
  await stream.follow(idle);
  await stream.close();
});

test("a restarted backend mints a new projection identity and starts its revision again", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const stream = await openStream(server.origin, id);
  assert.equal((await submit(server.origin, id, "req-restart", "before the restart")).status, 202);
  server.release();
  await stream.follow(idle);
  await stream.close();
  const before = await state(server.origin, id);
  assert.ok(before.revision > 0, "the attachment published at least one state before the restart");
  await server.backend.close();
  // The same store, a new attachment: the identity is minted per attachment rather than persisted, so a restarted
  // backend is a different projection whose revision means nothing against the old one's.
  const restarted = await createBackendServer({ dbPath: server.dbPath, authToken: token, models: createModels(), defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => restarted.server.listen(0, "127.0.0.1", resolve));
  t.after(() => restarted.close());
  const address = restarted.server.address();
  assert.ok(address !== null && typeof address === "object");
  const after = await state("http://127.0.0.1:" + address.port, id);
  assert.notEqual(after.projectionId, before.projectionId, "a new attachment is a new identity");
  assert.equal(/^[0-9]+$/.test(after.projectionId), false, "the identity is opaque");
  assert.ok(after.revision < before.revision, "the new identity's revision starts again, so identities have no numerical order");
  assert.deepEqual(after.entries.map(entry => entry.role), ["user", "assistant"], "the restarted read still carries the whole transcript");
  assert.deepEqual(after.submissions, []);
});
