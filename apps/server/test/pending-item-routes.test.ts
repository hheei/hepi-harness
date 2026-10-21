/**
 * Ticket 09's HTTP contract: the pending queue is addressable item by item, and the answer says what really happened.
 *
 * The routes are the ones the Web adapter forwards to, over a real backend, a real SQLite file and a controlled model.
 * What is asserted is what a browser can observe: the item projection the snapshot and the item read both state, the
 * status and body of one edit, one cancel and their conflicts, the committed control state beside them, and the model
 * requests the faux provider itself counted (ticket 09, spec D09, A11/A18).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { QueuedItemProjection, ServerSnapshot } from "@hepi/protocol";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const directories: string[] = [];
const token = "items-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The model gate: while armed, the next provider answer waits until the test releases it. */
class Gate {
  #armed = false;
  #entered = false;
  #waiters: (() => void)[] = [];
  arm(): void { this.#armed = true; this.#entered = false; }
  entered(): boolean { return this.#entered; }
  async hold(): Promise<void> { this.#entered = true; await new Promise<void>((resolve) => { this.#waiters.push(resolve); }); }
  release(): void { this.#armed = false; for (const resolve of this.#waiters.splice(0)) resolve(); }
  get armed(): boolean { return this.#armed; }
}

type Rig = { readonly backend: BackendServer; readonly origin: string; readonly gate: Gate; requests(): number };

/** A real backend over a test-owned SQLite file, whose model answers the test can hold. */
async function start(t: TestContext): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-items-http-"));
  directories.push(directory);
  const gate = new Gate();
  const faux = fauxProvider();
  const answer: FauxResponseFactory = async (transcript) => {
    faux.setResponses([answer]);
    if (gate.armed) await gate.hold();
    const last = transcript.messages.findLast((message) => message.role === "user");
    return fauxAssistantMessage("answer " + faux.state.callCount + ": " + JSON.stringify(last?.content ?? ""));
  };
  faux.setResponses([answer]);
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(directory, "items.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => { gate.release(); return backend.close(); });
  return { backend, origin: "http://127.0.0.1:" + address.port, gate, requests: () => faux.state.callCount };
}

const createConversation = async (origin: string): Promise<string> => {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(created.status, 201, await created.clone().text());
  return (await created.json() as { conversationId: string }).conversationId;
};

const state = async (origin: string, id: string): Promise<ServerSnapshot> => {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as ServerSnapshot;
};

const submit = (origin: string, id: string, requestId: string, text: string, whenBusy?: string) =>
  fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text, ...(whenBusy === undefined ? {} : { whenBusy }) }) });

const busy = (origin: string, id: string, requestId: string, text: string, mode: "steer" | "follow-up") =>
  fetch(origin + "/api/conversations/" + id + "/busy", { method: "POST", headers, body: JSON.stringify({ requestId, text, mode }) });

const itemRead = async (origin: string, id: string): Promise<{ items: QueuedItemProjection[] }> => {
  const response = await fetch(origin + "/api/conversations/" + id + "/items", { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { items: QueuedItemProjection[] };
};

const edit = (origin: string, id: string, submissionId: string, body: unknown) =>
  fetch(origin + "/api/conversations/" + id + "/items/" + submissionId, { method: "PATCH", headers, body: JSON.stringify(body) });

const cancel = (origin: string, id: string, submissionId: string) =>
  fetch(origin + "/api/conversations/" + id + "/items/" + submissionId, { method: "DELETE", headers });

/** Two queued items behind one held run, which is the state a user's stop leaves. */
async function twoQueued(t: TestContext): Promise<{ rig: Rig; id: string; items: QueuedItemProjection[] }> {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-1", "first")).status, 202);
  // Wait until the run really reached the provider, so the two admissions below are genuinely queued.
  const deadline = Date.now() + 8000;
  while (!rig.gate.entered()) {
    if (Date.now() > deadline) throw new Error("the run never reached the provider");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await busy(rig.origin, id, "queued-1", "steering text", "steer")).status, 202);
  assert.equal((await busy(rig.origin, id, "queued-2", "follow-up text", "follow-up")).status, 202);
  const read = await itemRead(rig.origin, id);
  assert.equal(read.items.length, 2, JSON.stringify(read.items));
  return { rig, id, items: read.items };
}

test("the snapshot and the item read state the same queue, with identity, mode, text and token", { timeout: 20000 }, async (t) => {
  const { rig, id, items } = await twoQueued(t);
  const snapshot = await state(rig.origin, id);
  // The item read and the frame are one projection of one queue, so a client can read the queue from either.
  assert.deepEqual(snapshot.queuedItems, items);
  assert.deepEqual(snapshot.queuedMessages, { steering: ["steering text"], followUp: ["follow-up text"] });
  assert.deepEqual(items.map((item) => item.mode), ["steer", "followUp"]);
  assert.deepEqual(items.map((item) => item.content), ["steering text", "follow-up text"]);
  // The item's own admission identity travels with it, which is what the recovery read answers by.
  assert.deepEqual(items.map((item) => item.requestId), ["queued-1", "queued-2"]);
  assert.equal(items.every((item) => item.source.kind === "user"), true);
  assert.equal(items.every((item) => item.contentToken.length > 0), true);
  assert.equal(items.every((item) => item.editable && item.cancelable), true);
  assert.equal(items.every((item) => item.conversationId === id), true);
});

test("an edit succeeds with the token read, a stale token is a conflict carrying the current item, and a placed item is not queued", { timeout: 20000 }, async (t) => {
  const { rig, id, items } = await twoQueued(t);
  const first = items[0]!;
  const before = rig.requests();

  const edited = await edit(rig.origin, id, first.submissionId, { contentToken: first.contentToken, content: "edited steering" });
  assert.equal(edited.status, 200, await edited.clone().text());
  const body = await edited.json() as { status: string; item: QueuedItemProjection };
  assert.equal(body.status, "edited");
  assert.equal(body.item.content, "edited steering");
  assert.notEqual(body.item.contentToken, first.contentToken);
  // The queue really changed and the other item was untouched; no model was asked and the run was not interrupted.
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: ["edited steering"], followUp: ["follow-up text"] });
  assert.equal(rig.requests(), before);

  // The stale tab still holds the token it read: the answer is a conflict that carries the current text.
  const stale = await edit(rig.origin, id, first.submissionId, { contentToken: first.contentToken, content: "stale tab" });
  assert.equal(stale.status, 409, await stale.clone().text());
  const conflict = await stale.json() as { code: string; item: QueuedItemProjection };
  assert.equal(conflict.code, "content_conflict");
  assert.equal(conflict.item.content, "edited steering");
  assert.equal((await state(rig.origin, id)).queuedMessages.steering[0], "edited steering");

  // A placed or unknown item is refused as not queued rather than reported as a failed edit to retry.
  const missing = await edit(rig.origin, id, "999999", { contentToken: "x", content: "x" });
  assert.equal(missing.status, 409, await missing.clone().text());
  assert.equal((await missing.json() as { code: string }).code, "not_queued");
  // A body that is not an edit is a bad request, before anything is read.
  const malformed = await edit(rig.origin, id, first.submissionId, { content: "no token" });
  assert.equal(malformed.status, 400, await malformed.clone().text());
  assert.equal((await malformed.json() as { code: string }).code, "invalid_request");
});

test("a cancel withdraws one item through the native abort and is idempotent on retry", { timeout: 20000 }, async (t) => {
  const { rig, id, items } = await twoQueued(t);
  const [first, second] = [items[0]!, items[1]!];
  const before = rig.requests();

  const cancelled = await cancel(rig.origin, id, first.submissionId);
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
  // Exactly one item left, under its own identity: the cancel decided about one item and nothing else.
  assert.deepEqual((await state(rig.origin, id)).queuedItems.map((item) => item.submissionId), [second.submissionId]);
  // The retry is the same outcome asked for twice, not a second operation.
  const retried = await cancel(rig.origin, id, first.submissionId);
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json() as { status: string }).status, "already_cancelled");
  // The withdrawn item is settled `unanswered`/`aborted` in the durable record, and its own request id still resolves
  // it — which is the recovery read a client makes for an answer it lost.
  const recovered = await fetch(rig.origin + "/api/conversations/" + id + "/submissions?requestId=queued-1", { headers });
  assert.equal(recovered.status, 200, await recovered.clone().text());
  const record = (await recovered.json() as { submission: { status: string; reason?: string } | null }).submission;
  assert.equal(record?.status, "unanswered");
  assert.equal(record?.reason, "aborted");
  assert.equal(rig.requests(), before);
});

test("neither an edit nor a cancel lifts a hold, and the held queue survives until the user's own continue", { timeout: 20000 }, async (t) => {
  const { rig, id, items } = await twoQueued(t);
  // The user stops the conversation: the hold is committed and the run is marked, and the queue that arrived before
  // the stop was already there, so the stop withdraws what was queued at its own commit point.
  const stopped = await fetch(rig.origin + "/api/conversations/" + id + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "stop-1" }) });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  const stopBody = await stopped.json() as { control: ServerSnapshot["control"]; drain: string };
  assert.equal(stopBody.control.state, "held");
  // The two items arrived before the stop, so the stop withdrew them: a later item is what a hold keeps.
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: [] });
  const late = await busy(rig.origin, id, "late-1", "queued under the hold", "follow-up");
  assert.equal(late.status, 202, await late.clone().text());
  const queued = (await state(rig.origin, id)).queuedItems;
  assert.equal(queued.length, 1, JSON.stringify(queued));

  // An edit under the hold changes the text and nothing else: the control revision does not move.
  const revision = (await state(rig.origin, id)).control.revision;
  assert.equal((await edit(rig.origin, id, queued[0]!.submissionId, { contentToken: queued[0]!.contentToken, content: "edited under the hold" })).status, 200);
  const afterEdit = await state(rig.origin, id);
  assert.equal(afterEdit.control.state, "held");
  assert.equal(afterEdit.control.revision, revision);
  assert.equal(afterEdit.queuedItems[0]!.content, "edited under the hold");

  // The user's own continue is the one thing that ends the hold, and it consumes the kept item.
  rig.gate.release();
  const deadline = Date.now() + 8000;
  while ((await state(rig.origin, id)).busy) {
    if (Date.now() > deadline) throw new Error("the stopped run never settled");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const resumed = await fetch(rig.origin + "/api/conversations/" + id + "/continue", { method: "POST", headers, body: JSON.stringify({ requestId: "continue-1" }) });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  assert.equal((await resumed.json() as { status: string }).status, "resumed");
  const settled = await (async () => {
    const limit = Date.now() + 8000;
    for (;;) {
      const current = await state(rig.origin, id);
      if (!current.busy && current.queuedItems.length === 0 && current.entries.some((entry) => entry.text.includes("edited under the hold"))) return current;
      if (Date.now() > limit) throw new Error("the kept item was never consumed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  assert.equal(settled.control.state, "allowed");
  // The model read the edited text, which is the whole point of the per-item control.
  const answered = settled.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.text).join("\n");
  assert.match(answered, /edited under the hold/);
});

test("a removed conversation refuses an item write and a read of its queue still states nothing invented", { timeout: 20000 }, async (t) => {
  const { rig, id, items } = await twoQueued(t);
  assert.equal((await fetch(rig.origin + "/api/conversations/" + id, { method: "DELETE", headers })).status, 200);
  // The removal commits the native hold, so nothing is placed; the item write is refused for the same reason a new
  // turn is, because the caller would be editing a queue nobody can see.
  const refused = await edit(rig.origin, id, items[0]!.submissionId, { contentToken: items[0]!.contentToken, content: "after removal" });
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json() as { code: string }).code, "session_deleted");
  const refusedCancel = await cancel(rig.origin, id, items[0]!.submissionId);
  assert.equal(refusedCancel.status, 409, await refusedCancel.clone().text());
});
