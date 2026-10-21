import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

/**
 * Ticket 01's observable behavior: the explicit subtree stop/interrupt operation, over the conversation HTTP surface and
 * the one ConversationOperations seam beneath it.
 *
 * What is asserted is what a caller can observe — the captured scope, each child's own outcome and current control
 * state, the parent's untouched control, the committed transcript and relations, and what a replay or a restart
 * answers. Nothing asserts on a helper's internals, and the caller's origin is always the host's: the HTTP surface is
 * the user, never a request body (spec decisions 1-5).
 */

const directories: string[] = [];
const token = "subtree-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The model gate: while armed, the next provider answer waits until the test releases it, so "busy" is a real state. */
class Gate {
  #armed = false;
  #waiters: (() => void)[] = [];
  arm(): void { this.#armed = true; }
  async hold(): Promise<void> { await new Promise<void>(resolve => { this.#waiters.push(resolve); }); }
  release(): void { this.#armed = false; for (const resolve of this.#waiters.splice(0)) resolve(); }
  get armed(): boolean { return this.#armed; }
}

type Rig = { backend: BackendServer; origin: string; dbPath: string; gate: Gate };

/** A real backend over a test-owned SQLite file, whose model answer the test can hold. */
async function start(t: TestContext, dbPath?: string): Promise<Rig> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-subtree-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "subtree.sqlite");
  const gate = new Gate();
  const faux = fauxProvider();
  const answer: FauxResponseFactory = async (): Promise<AssistantMessage> => {
    faux.setResponses([answer]);
    if (gate.armed) await gate.hold();
    return fauxAssistantMessage("answer " + faux.state.callCount);
  };
  faux.setResponses([answer]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: path, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => { gate.release(); return backend.close(); });
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path, gate };
}

type Row = { id: string; displayParentId?: string; displayParentDeleted?: boolean; createdBy?: string };

async function create(origin: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (await JSON.parse(text) as { conversation: Row }).conversation;
}

const post = (origin: string, id: string, action: string, body?: unknown) =>
  fetch(origin + "/api/conversations/" + id + "/" + action, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const submit = (origin: string, id: string, requestId: string, text: string, whenBusy?: string) =>
  post(origin, id, "messages", { protocol: "hepi.v1", type: "conversation.submit", requestId, text, ...(whenBusy === undefined ? {} : { whenBusy }) });

const subtree = (origin: string, id: string, body: Record<string, unknown>) => post(origin, id, "subtree-control", body);

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as ServerSnapshot;
}

/** One subtree answer as the wire carries it. */
type Answer = {
  requestId: string;
  action: "stop" | "interrupt";
  status: "completed" | "pending";
  scope: string[];
  selected: string[] | null;
  outcomes: { conversationId: string; status: string; reason?: string; control: { state: string; revision: number; stopSource?: string } }[];
  partial: boolean;
};

/** Poll a real condition on committed state, so a loaded machine cannot race a fixed sleep. */
async function waitForState(origin: string, id: string, ready: (current: ServerSnapshot) => boolean, what: string): Promise<ServerSnapshot> {
  const deadline = Date.now() + 8000;
  let current = await state(origin, id);
  while (!ready(current)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what + ": " + JSON.stringify({ busy: current.busy, control: current.control }));
    await new Promise(resolve => setTimeout(resolve, 10));
    current = await state(origin, id);
  }
  return current;
}

const controlOf = (origin: string, id: string) => state(origin, id).then(current => current.control);

/** One nested family: a root, a child beneath it and a grandchild beneath the child. */
async function family(origin: string): Promise<{ root: Row; child: Row; grandchild: Row }> {
  const root = await create(origin);
  const child = await create(origin, { displayParentId: root.id });
  const grandchild = await create(origin, { displayParentId: child.id });
  return { root, child, grandchild };
}

test("stop reaches the whole nested subtree and leaves the addressed conversation and its history alone", async (t) => {
  const rig = await start(t);
  const { root, child, grandchild } = await family(rig.origin);
  // One committed turn on the child, so the transcript is something a cascade could plausibly truncate.
  assert.equal((await submit(rig.origin, child.id, "child-turn", "child work")).status, 202);
  await waitForState(rig.origin, child.id, current => !current.busy && current.entries.length > 0, "the child's answer");
  const before = await state(rig.origin, child.id);
  // The caller's origin is the host's: a body claiming another source changes nothing about who asked.
  const response = await subtree(rig.origin, root.id, { requestId: "sub-1", action: "stop", stopSource: "agent" });
  const text = await response.text();
  assert.equal(response.status, 202, text);
  const answer = JSON.parse(text) as Answer;
  assert.equal(answer.status, "completed");
  assert.equal(answer.partial, false);
  assert.deepEqual(answer.scope, [child.id, grandchild.id], "the captured scope is the transitive descendant set");
  assert.equal(answer.selected, null);
  // Neither child had live work, so each took the hold at once: `accepted` is the drain fact, not a claim that a run
  // was interrupted.
  assert.deepEqual(answer.outcomes.map(outcome => [outcome.conversationId, outcome.status]), [[child.id, "accepted"], [grandchild.id, "accepted"]]);
  // Each child is held by the user's own stop, and the addressed conversation is not: a subtree stop is not a cascade.
  for (const id of [child.id, grandchild.id]) {
    const held = await controlOf(rig.origin, id);
    assert.equal(held.state, "held", id + " is held");
    assert.equal(held.stopSource, "user", id + " records the host's own source");
  }
  const parent = await controlOf(rig.origin, root.id);
  assert.equal(parent.state, "allowed", "the addressed conversation is untouched");
  assert.equal(parent.revision, 0);
  // The transcript, the relations and the catalogue are what they were: this operation reaches control state only.
  const after = await state(rig.origin, child.id);
  assert.deepEqual(after.entries.map(entry => entry.text), before.entries.map(entry => entry.text));
  const info = await (await fetch(rig.origin + "/api/conversations/" + child.id, { headers })).json() as { relations: { displayParentId?: string } };
  assert.equal(info.relations.displayParentId, root.id, "the relation is untouched");
  // The recovery read states the same capture and the same outcomes.
  const read = await (await fetch(rig.origin + "/api/conversations/" + root.id + "/subtree-control?requestId=sub-1", { headers })).json() as Answer;
  assert.deepEqual(read.scope, answer.scope);
  assert.deepEqual(read.outcomes.map(outcome => outcome.status), answer.outcomes.map(outcome => outcome.status));
});

test("a child created after the capture is not swept in by a replay, and the replay changes nothing", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const first = await create(rig.origin, { displayParentId: root.id });
  const answered = await (await subtree(rig.origin, root.id, { requestId: "sub-2", action: "stop" })).json() as Answer;
  assert.deepEqual(answered.scope, [first.id]);
  const revision = (await controlOf(rig.origin, first.id)).revision;
  // A child that arrives afterwards is a conversation of its own for this request: the first request captured the set.
  const later = await create(rig.origin, { displayParentId: root.id });
  const replay = await (await subtree(rig.origin, root.id, { requestId: "sub-2", action: "stop" })).json() as Answer;
  assert.deepEqual(replay.scope, [first.id], "the replay is answered from the captured set");
  assert.equal(replay.status, "completed");
  assert.equal((await controlOf(rig.origin, later.id)).state, "allowed", "a child created later is not implicitly included");
  assert.equal((await controlOf(rig.origin, first.id)).revision, revision, "the replay recorded no second control change");
});

test("a selective request cannot reach a conversation outside the captured subtree", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const child = await create(rig.origin, { displayParentId: root.id });
  const unrelated = await create(rig.origin);
  const refused = await subtree(rig.origin, root.id, { requestId: "sub-3", action: "stop", selected: [unrelated.id] });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as { code: string }).code, "outside_subtree");
  assert.equal((await controlOf(rig.origin, unrelated.id)).state, "allowed", "the unrelated conversation is untouched");
  assert.equal((await controlOf(rig.origin, child.id)).state, "allowed", "a refused request changes nothing at all");
  const empty = await subtree(rig.origin, root.id, { requestId: "sub-4", action: "stop", selected: [] });
  assert.equal(empty.status, 400);
  // A selection inside the capture governs exactly that subset, and the rest of the subtree stays as it was.
  const grandchild = await create(rig.origin, { displayParentId: child.id });
  const selective = await (await subtree(rig.origin, root.id, { requestId: "sub-5", action: "stop", selected: [grandchild.id] })).json() as Answer;
  assert.deepEqual(selective.selected, [grandchild.id]);
  assert.deepEqual(selective.outcomes.map(outcome => outcome.conversationId), [grandchild.id]);
  assert.equal((await controlOf(rig.origin, grandchild.id)).state, "held");
  assert.equal((await controlOf(rig.origin, child.id)).state, "allowed");
});

test("mixed child states answer their own outcome instead of one blanket status", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const running = await create(rig.origin, { displayParentId: root.id });
  const idle = await create(rig.origin, { displayParentId: root.id });
  const alreadyHeld = await create(rig.origin, { displayParentId: root.id });
  // One child is really running: its provider answer is held until the test releases it.
  rig.gate.arm();
  assert.equal((await submit(rig.origin, running.id, "run-1", "long task")).status, 202);
  await waitForState(rig.origin, running.id, current => current.busy, "the running child");
  // One child is held by its own earlier stop, which is the state a second request must not pretend to reach.
  assert.equal((await post(rig.origin, alreadyHeld.id, "stop", { requestId: "own-stop" })).status, 202);
  const heldRevision = (await controlOf(rig.origin, alreadyHeld.id)).revision;
  const answer = await (await subtree(rig.origin, root.id, { requestId: "sub-6", action: "stop" })).json() as Answer;
  const statuses = new Map(answer.outcomes.map(outcome => [outcome.conversationId, outcome.status]));
  assert.equal(statuses.get(running.id), "stopping", "a live child is reached and drains");
  assert.equal(statuses.get(idle.id), "accepted", "a child with no live work takes the hold at once");
  assert.equal(statuses.get(alreadyHeld.id), "held", "an already-held child keeps its hold");
  assert.equal(answer.partial, false);
  assert.equal((await controlOf(rig.origin, alreadyHeld.id)).revision, heldRevision + 1, "the record advanced once, not twice");
  // The stop reached the live child: releasing its answer settles the run and leaves the child held.
  rig.gate.release();
  await waitForState(rig.origin, running.id, current => !current.busy, "the running child's drain");
  assert.equal((await controlOf(rig.origin, running.id)).state, "held");
  assert.equal((await controlOf(rig.origin, root.id)).state, "allowed");
});

test("interrupt withdraws queued work and sets no hold, and a parent stop alone never cascades", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const child = await create(rig.origin, { displayParentId: root.id });
  // One child is really running and has one queued input behind it: exactly what an interrupt withdraws.
  rig.gate.arm();
  assert.equal((await submit(rig.origin, child.id, "run-1", "long task")).status, 202);
  await waitForState(rig.origin, child.id, current => current.busy, "the running child");
  assert.equal((await submit(rig.origin, child.id, "queued-1", "queued task", "followUp")).status, 202);
  // The interrupt waits for the child's own scope to drain, so the held model answer is released while it waits — but
  // only once the abort's own commit has landed, which is what withdrawing the queued input proves. Waiting for that
  // fact instead of a fixed sleep is what keeps this a real state rather than a race.
  const interrupting = subtree(rig.origin, root.id, { requestId: "sub-7", action: "interrupt" });
  await waitForState(rig.origin, child.id, current => current.queuedMessages.followUp.length === 0, "the interrupt's withdrawal");
  rig.gate.release();
  const answer = await (await interrupting).json() as Answer;
  assert.equal(answer.action, "interrupt");
  assert.deepEqual(answer.outcomes.map(outcome => [outcome.conversationId, outcome.status]), [[child.id, "accepted"]]);
  // The native abort withdrew the queued input and set no hold: an interrupt is not a stop.
  const settled = await state(rig.origin, child.id);
  assert.deepEqual(settled.queuedMessages.followUp, []);
  assert.deepEqual(settled.queuedMessages.steering, []);
  assert.equal((await controlOf(rig.origin, child.id)).state, "allowed", "an interrupt is not a stop");
  assert.equal((await controlOf(rig.origin, child.id)).revision, 0, "an interrupt records no control change");
  // The parent's own stop stays local, which is the decision the subtree operation exists beside.
  assert.equal((await post(rig.origin, root.id, "stop", { requestId: "parent-stop" })).status, 202);
  assert.equal((await controlOf(rig.origin, root.id)).state, "held");
  assert.equal((await controlOf(rig.origin, child.id)).state, "allowed", "a parent stop never cascades");
  // A later subtree stop still reaches the child, so the local parent stop did not take it out of scope.
  const stopped = await (await subtree(rig.origin, root.id, { requestId: "sub-7b", action: "stop" })).json() as Answer;
  assert.deepEqual(stopped.outcomes.map(outcome => [outcome.conversationId, outcome.status]), [[child.id, "accepted"]]);
  assert.equal((await controlOf(rig.origin, child.id)).state, "held");
});

test("a child under a tombstoned display parent is still in scope, and the removed child reports its own conflict", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const middle = await create(rig.origin, { displayParentId: root.id });
  const leaf = await create(rig.origin, { displayParentId: middle.id });
  // The middle conversation is removed, so the tree the catalogue shows no longer has it; the relation and the child stay.
  assert.equal((await fetch(rig.origin + "/api/conversations/" + middle.id, { method: "DELETE", headers })).status, 200);
  const answer = await (await subtree(rig.origin, root.id, { requestId: "sub-8", action: "stop" })).json() as Answer;
  assert.deepEqual(answer.scope, [middle.id, leaf.id], "the walk crosses the hidden middle conversation");
  const statuses = new Map(answer.outcomes.map(outcome => [outcome.conversationId, outcome.status]));
  assert.equal(statuses.get(middle.id), "conflict", "a removed child already holds and is reported as its own conflict");
  assert.equal(statuses.get(leaf.id), "accepted", "the child under the hidden parent is controlled");
  assert.equal(answer.partial, true, "a partial result is visible rather than flattened");
  assert.equal((await controlOf(rig.origin, leaf.id)).state, "held");
  // A removed conversation cannot be addressed at all, the same way every other control write refuses it.
  const addressed = await subtree(rig.origin, middle.id, { requestId: "sub-9", action: "stop" });
  assert.equal(addressed.status, 409);
  assert.equal((await addressed.json() as { code: string }).code, "session_deleted");
});

test("a restarted backend answers the same captured request without stopping a child twice", async (t) => {
  const first = await start(t);
  const root = await create(first.origin);
  const child = await create(first.origin, { displayParentId: root.id });
  const answered = await (await subtree(first.origin, root.id, { requestId: "sub-10", action: "stop" })).json() as Answer;
  assert.deepEqual(answered.scope, [child.id]);
  const revision = (await controlOf(first.origin, child.id)).revision;
  // The same file, a fresh process: the capture and the per-child outcome are store state, not a live invocation.
  await first.backend.close();
  const second = await start(t, first.dbPath);
  const replay = await (await subtree(second.origin, root.id, { requestId: "sub-10", action: "stop" })).json() as Answer;
  assert.deepEqual(replay.scope, [child.id], "the captured set survived the restart");
  assert.equal(replay.status, "completed");
  assert.deepEqual(replay.outcomes.map(outcome => [outcome.conversationId, outcome.status]), [[child.id, "accepted"]], "the recorded outcome is read back, not re-derived");
  assert.equal((await controlOf(second.origin, child.id)).revision, revision, "the replay recorded no second control change");
  // A second child arrives after the restart and is still outside the capture.
  const later = await create(second.origin, { displayParentId: root.id });
  const third = await (await subtree(second.origin, root.id, { requestId: "sub-10", action: "stop" })).json() as Answer;
  assert.deepEqual(third.scope, [child.id]);
  assert.equal((await controlOf(second.origin, later.id)).state, "allowed");
});

test("an unknown request id reads back as no record, and an empty subtree is a completed no-op", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const missing = await fetch(rig.origin + "/api/conversations/" + root.id + "/subtree-control?requestId=nothing", { headers });
  assert.equal(missing.status, 404);
  const empty = await (await subtree(rig.origin, root.id, { requestId: "sub-11", action: "stop" })).json() as Answer;
  assert.deepEqual(empty.scope, []);
  assert.deepEqual(empty.outcomes, []);
  assert.equal(empty.status, "completed");
  assert.equal(empty.partial, false);
  assert.equal((await controlOf(rig.origin, root.id)).state, "allowed");
});
