import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { ConversationOperationRefusal, createConversationOperations } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { backgroundRegistry, openNativeRig, startBackgroundSleeper } from "./native-input-control-fixtures.ts";

/**
 * Ticket 02's observable behavior: trusted Stop and Continue over the existing conversation HTTP surface, through
 * ConversationOperations into the patched runtime and one real SQLite file.
 *
 * What is asserted is what a caller can observe — the answer status and drain, the committed control state and
 * revision, the durable receipt, the queued text a client reads back, the committed transcript, and the model requests
 * the faux provider itself counted. Nothing asserts on a helper's internals, and the caller's origin is always the
 * host's: the HTTP surface is the user and a model tool would be the agent, never a request body (spec D01, D02, D07,
 * D08, D09).
 */

const directories: string[] = [];
const token = "control-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/**
 * The model gate: while armed, the next provider answer waits until the test releases it, so "the run is in flight" is
 * a real state rather than a race. Releasing disarms it, so a later turn in the same test answers immediately unless
 * the test arms it again.
 */
class Gate {
  #armed = false;
  #entered = false;
  #waiters: (() => void)[] = [];
  arm(): void { this.#armed = true; this.#entered = false; }
  entered(): boolean { return this.#entered; }
  async hold(): Promise<void> {
    this.#entered = true;
    await new Promise<void>(resolve => { this.#waiters.push(resolve); });
  }
  release(): void { this.#armed = false; for (const resolve of this.#waiters.splice(0)) resolve(); }
  get armed(): boolean { return this.#armed; }
}

type Rig = { backend: BackendServer; origin: string; dbPath: string; gate: Gate; requests: () => number };

/** A real backend over a test-owned SQLite file, whose model answers the test can hold. */
async function start(t: TestContext, dbPath?: string): Promise<Rig> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-control-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "control.sqlite");
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
  // A failed assertion must not leave a held answer holding the harness, so cleanup releases first and always.
  t.after(() => { gate.release(); return backend.close(); });
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path, gate, requests: () => faux.state.callCount };
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(created.status, 201, await created.clone().text());
  return (await created.json() as { conversationId: string }).conversationId;
}

const post = (origin: string, id: string, action: string, body?: unknown) =>
  fetch(origin + "/api/conversations/" + id + "/" + action, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const submit = (origin: string, id: string, requestId: string, text: string, whenBusy?: string) =>
  post(origin, id, "messages", { protocol: "hepi.v1", type: "conversation.submit", requestId, text, ...(whenBusy === undefined ? {} : { whenBusy }) });

const stop = (origin: string, id: string, requestId: string, expectedControlRevision?: number) =>
  post(origin, id, "stop", { requestId, ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }) });

const resume = (origin: string, id: string, requestId: string, body: Record<string, unknown> = {}) =>
  post(origin, id, "continue", { requestId, ...body });

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as ServerSnapshot;
}

async function control(origin: string, id: string, requestId?: string): Promise<{ control: ServerSnapshot["control"]; receipt: ControlReceipt | null }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/control" + (requestId === undefined ? "" : "?requestId=" + encodeURIComponent(requestId)), { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { control: ServerSnapshot["control"]; receipt: ControlReceipt | null };
}

type ControlReceipt = { requestId: string; operation: "stop" | "continue"; status: string; reason?: string; revision: number; stopSource?: string; caller?: string; at: number };

/** Poll a real condition on the committed state, so a loaded machine cannot race a fixed sleep. */
async function waitForState(origin: string, id: string, ready: (current: ServerSnapshot) => boolean, what: string): Promise<ServerSnapshot> {
  const deadline = Date.now() + 8000;
  let current = await state(origin, id);
  while (!ready(current)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what + ": " + JSON.stringify({ busy: current.busy, entries: current.entries.length, queued: current.queuedMessages, control: current.control }));
    await new Promise(resolve => setTimeout(resolve, 10));
    current = await state(origin, id);
  }
  return current;
}

const userTexts = (current: ServerSnapshot): string[] => current.entries.filter(entry => entry.role === "user").map(entry => entry.text);

test("a user stop holds the conversation: the queue-only admission stays queued and only continue consumes it", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-1", "first")).status, 202);
  await waitForState(rig.origin, id, current => current.busy, "the run to reach the provider");
  assert.equal(rig.gate.entered(), true);

  // The stop is answered without waiting for the drain, and it states that the ordinary scope is still draining.
  const stopped = await stop(rig.origin, id, "stop-1");
  assert.equal(stopped.status, 202, await stopped.clone().text());
  const stopBody = await stopped.json() as { status: string; drain: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  assert.equal(stopBody.status, "accepted");
  assert.equal(stopBody.drain, "stopping");
  assert.deepEqual(stopBody.control, { state: "held", revision: 1, stopSource: "user", stoppedAt: stopBody.control.stoppedAt });
  assert.equal(stopBody.receipt.operation, "stop");
  assert.equal(stopBody.receipt.status, "accepted");
  assert.equal((await state(rig.origin, id)).busy, true, "the stop did not wait for the run it marked");

  // A queue-only admission while held lands in the native queue, starts no turn, and leaves the hold in place.
  const queued = await post(rig.origin, id, "busy", { mode: "follow-up", text: "queued while held", requestId: "queued-1" });
  assert.equal(queued.status, 202, await queued.clone().text());
  const held = await state(rig.origin, id);
  assert.deepEqual(held.queuedMessages, { steering: [], followUp: ["queued while held"] });
  assert.deepEqual(held.control, stopBody.control);

  rig.gate.release();
  await waitForState(rig.origin, id, current => !current.busy, "the stopped run to settle");
  // The drain has ended, but nothing was consumed: the held queue is still there and no second request was served.
  const drained = await state(rig.origin, id);
  assert.deepEqual(drained.queuedMessages, { steering: [], followUp: ["queued while held"] });
  assert.deepEqual(userTexts(drained), ["first"]);
  assert.equal(rig.requests(), 1);

  const resumed = await resume(rig.origin, id, "continue-1");
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const resumeBody = await resumed.json() as { status: string; control: ServerSnapshot["control"] };
  assert.equal(resumeBody.status, "resumed");
  assert.equal(resumeBody.control.state, "allowed");
  assert.equal(resumeBody.control.revision, 2);
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 2, "the held queue to be consumed");
  assert.deepEqual(userTexts(settled), ["first", "queued while held"]);
  assert.deepEqual(settled.queuedMessages, { steering: [], followUp: [] });
  assert.equal(rig.requests(), 2);
});

test("an immediate send while the stop drains is a pending intent the same request id finishes", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-1", "first")).status, 202);
  await waitForState(rig.origin, id, current => current.busy, "the run to reach the provider");
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);

  // The user's own dispatch is one of the two ways a hold ends, so it is a resume — but the old scope still drains, so
  // the answer is `stopping`, nothing was admitted, and the hold stands (spec D07, D08).
  const immediate = await submit(rig.origin, id, "immediate-1", "immediate input");
  assert.equal(immediate.status, 202, await immediate.clone().text());
  const first = await immediate.json() as { status: string; submissionId?: string; control: ServerSnapshot["control"] };
  assert.equal(first.status, "stopping");
  assert.equal(first.submissionId, undefined, "nothing is admitted while the old stop drains");
  assert.equal(first.control.state, "held");

  rig.gate.release();
  await waitForState(rig.origin, id, current => !current.busy, "the stopped run to settle");

  // The identical request finishes the intent: the resume clears the hold and admits the input exactly once.
  const retried = await submit(rig.origin, id, "immediate-1", "immediate input");
  const retriedText = await retried.clone().text();
  assert.equal(retried.status, 202, retriedText);
  const second = JSON.parse(retriedText) as { status: string; submissionId?: string; control: ServerSnapshot["control"] };
  assert.equal(second.status, "resumed", retriedText);
  assert.ok(second.submissionId !== undefined, "the resumed input was admitted");
  assert.equal(second.control.state, "allowed");
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 2, "the immediate input to run");
  assert.deepEqual(userTexts(settled), ["first", "immediate input"]);
  assert.equal(rig.requests(), 2);

  // A third identical call is answered from the durable receipts: nothing is admitted again and no run starts.
  const replayed = await submit(rig.origin, id, "immediate-1", "immediate input");
  assert.equal(replayed.status, 202);
  const third = await replayed.json() as { status: string; control: ServerSnapshot["control"] };
  assert.equal(third.status, "resumed");
  assert.equal(third.control.revision, second.control.revision);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rig.requests(), 2);
  assert.deepEqual(userTexts(await state(rig.origin, id)), ["first", "immediate input"]);
});

test("a replayed stop does not clear the input that arrived after it, and does not abort a later run", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  // An idle stop: the ordinary scope is already idle, so the drain is reported as such.
  const first = await stop(rig.origin, id, "stop-1");
  const firstBody = await first.json() as { status: string; drain: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  assert.equal(firstBody.status, "accepted");
  assert.equal(firstBody.drain, "idle");
  assert.equal(firstBody.control.revision, 1);

  assert.equal((await post(rig.origin, id, "busy", { mode: "follow-up", text: "late report", requestId: "late-1" })).status, 202);

  // The replay is answered from its own receipt: same status, same revision, and the item that arrived afterwards is
  // still queued — a repeated stop is not a second sweep of the queue.
  const replay = await stop(rig.origin, id, "stop-1");
  assert.equal(replay.status, 202, await replay.clone().text());
  const replayBody = await replay.json() as { status: string; drain: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  assert.equal(replayBody.status, "accepted");
  assert.deepEqual(replayBody.control, firstBody.control);
  assert.equal(replayBody.receipt.at, firstBody.receipt.at);
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: ["late report"] });

  assert.equal((await resume(rig.origin, id, "continue-1")).status, 202);
  await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 1, "the held report to run");
  assert.deepEqual(userTexts(await state(rig.origin, id)), ["late report"]);
  assert.equal(rig.requests(), 1);

  // Replaying the stop once more, with a run in flight, must not abort the run that started after the continue.
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-2", "second turn")).status, 202);
  await waitForState(rig.origin, id, current => current.busy, "the second run to reach the provider");
  const again = await stop(rig.origin, id, "stop-1");
  assert.equal(again.status, 202, await again.clone().text());
  assert.equal((await again.json() as { status: string }).status, "accepted");
  rig.gate.release();
  const after = await waitForState(rig.origin, id, current => !current.busy && current.entries.some(entry => entry.role === "assistant" && entry.text.includes("answer 2")), "the second run to answer");
  assert.equal(after.entries.at(-1)?.role, "assistant", "the run the replayed stop did not stop still answered");
  assert.equal(rig.requests(), 2);
});

test("an expected control revision conflict changes no control state", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  const before = await state(rig.origin, id);

  const stale = await stop(rig.origin, id, "stop-2", 0);
  assert.equal(stale.status, 409, await stale.clone().text());
  const staleBody = await stale.json() as { status: string; reason: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  assert.equal(staleBody.status, "rejected");
  assert.equal(staleBody.reason, "revision_mismatch");
  assert.deepEqual(staleBody.control, before.control, "a rejected request does not advance the revision");
  assert.deepEqual((await state(rig.origin, id)).control, before.control);

  const malformed = await stop(rig.origin, id, "stop-3", -1);
  assert.equal(malformed.status, 400);
  const missing = await post(rig.origin, id, "stop", {});
  assert.equal(missing.status, 400);
});

test("the control read answers the latest state and one request's own durable receipt", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  const initial = await control(rig.origin, id);
  assert.deepEqual(initial.control, { state: "allowed", revision: 0 });
  assert.equal(initial.receipt, null);

  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  assert.equal((await resume(rig.origin, id, "continue-1")).status, 202);

  // The latest state is the resume, while the earlier stop's receipt still reads back exactly as it was recorded: an
  // older operation's answer can never be read as the current control state.
  const current = await control(rig.origin, id);
  assert.deepEqual(current.control, { state: "allowed", revision: 2 });
  assert.equal(current.receipt, null);
  const stopReceipt = await control(rig.origin, id, "stop-1");
  assert.equal(stopReceipt.receipt?.status, "accepted");
  assert.equal(stopReceipt.receipt?.operation, "stop");
  assert.equal(stopReceipt.receipt?.revision, 1);
  assert.equal(stopReceipt.receipt?.stopSource, "user");
  assert.deepEqual(stopReceipt.control, current.control, "the receipt is returned beside the latest state, never in place of it");
  const continueReceipt = await control(rig.origin, id, "continue-1");
  assert.equal(continueReceipt.receipt?.status, "resumed");
  assert.equal(continueReceipt.receipt?.caller, "user");
  assert.equal((await control(rig.origin, id, "never-sent")).receipt, null);
});

test("an empty continue consumes the held queue and invents no user message", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  assert.equal((await post(rig.origin, id, "busy", { mode: "steer", text: "steer one", requestId: "q-1" })).status, 202);
  assert.equal((await post(rig.origin, id, "busy", { mode: "follow-up", text: "follow one", requestId: "q-2" })).status, 202);

  const resumed = await resume(rig.origin, id, "continue-1");
  const body = await resumed.json() as { status: string; submissionId?: string };
  assert.equal(body.status, "resumed");
  assert.equal(body.submissionId, undefined, "an empty continue admits no input");
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 2, "the held queue to be consumed");
  // Exactly the two queued texts ran, and the resume added no message of its own: the held period's queue is consumed
  // by one final boundary under the configured mode, which places both items in the one run it starts.
  assert.deepEqual(userTexts(settled), ["steer one", "follow one"]);
  assert.equal(rig.requests(), 1);
});

test("a stop withdraws the input queued at its commit point and keeps what arrives later", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-1", "first")).status, 202);
  await waitForState(rig.origin, id, current => current.busy, "the run to reach the provider");
  assert.equal((await post(rig.origin, id, "busy", { mode: "follow-up", text: "queued before the stop", requestId: "before-1" })).status, 202);
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: ["queued before the stop"] });

  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  // The item queued at the commit point was withdrawn with the stop; the one that arrives afterwards is kept.
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: [] });
  assert.equal((await post(rig.origin, id, "busy", { mode: "follow-up", text: "queued after the stop", requestId: "after-1" })).status, 202);
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: ["queued after the stop"] });

  rig.gate.release();
  await waitForState(rig.origin, id, current => !current.busy, "the stopped run to settle");
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: ["queued after the stop"] });
  assert.equal((await resume(rig.origin, id, "continue-1")).status, 202);
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 2, "the late input to run");
  assert.deepEqual(userTexts(settled), ["first", "queued after the stop"]);
});

test("a removed conversation refuses stop, continue and both input routes", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await fetch(rig.origin + "/api/conversations/" + id, { method: "DELETE", headers })).status, 200);

  for (const [name, response] of [
    ["stop", await stop(rig.origin, id, "stop-1")],
    ["continue", await resume(rig.origin, id, "continue-1")],
    ["messages", await submit(rig.origin, id, "msg-1", "hello")],
    ["busy", await post(rig.origin, id, "busy", { mode: "steer", text: "hello", requestId: "busy-1" })],
  ] as const) {
    assert.equal(response.status, 409, name + " answered " + response.status);
    assert.equal((await response.json() as { code: string }).code, "session_deleted", name);
  }
  // The control read of a removed conversation still answers: its records are retained, and the refusal is about
  // acting on it, not about reading what it decided. The removal is itself the conversation's last word on admission —
  // it commits the native `held` the runtime's own admission consults — so the state it reads back is `held`, which is
  // what makes an admission that races the removal still place nothing.
  const read = await control(rig.origin, id);
  assert.equal(read.control.state, "held");
  assert.equal(rig.requests(), 0);
});

test("the caller is the host's: an agent cannot resume a user stop, and a queue-only input never does", { timeout: 20000 }, async (t) => {
  // The core seam over a real harness and the faux model, so the resume's consumption of the held queue is observed as
  // committed transcript rather than as a flag.
  const rig = await openNativeRig(t);
  {
    const operations = createConversationOperations(rig.harness);
    const id = String(rig.conversation.id);

    // Hold the conversation with the user's own stop, then let both callers try to admit input and to resume.
    const stopped = await operations.stop(id, { requestId: "stop-1", stopSource: "user" });
    assert.equal(stopped.status, "accepted");
    assert.equal(stopped.drain, "idle");

    // An agent's dispatch is refused before anything is admitted: the refusal is the answer, not a queued item.
    await assert.rejects(operations.send(id, { requestId: "agent-1", caller: "agent", content: "agent input" }), (error: unknown) => error instanceof ConversationOperationRefusal && error.code === "source_locked");
    // A queue-only admission is not a dispatch, so it is admitted as a queued item under the same hold, for either
    // caller: this is the shape a framework report or a staged composer draft arrives in.
    const queued = await operations.send(id, { requestId: "queued-1", caller: "agent", resume: false, content: "queued report" });
    assert.ok(queued.submissionId !== undefined);
    assert.equal(queued.control.state, "held");
    const userQueueOnly = await operations.send(id, { requestId: "queued-2", caller: "user", resume: false, content: "staged draft" });
    assert.equal(userQueueOnly.control.state, "held");
    const held = await operations.control(id);
    assert.deepEqual(held.control, { state: "held", revision: 1, stopSource: "user", stoppedAt: held.control.stoppedAt });

    // The model's own resume is refused too, and the hold is untouched.
    const refused = await operations.continue(id, { requestId: "agent-resume", caller: "agent" });
    assert.equal(refused.status, "rejected");
    assert.equal(refused.reason, "source_locked");
    assert.equal(refused.control.state, "held");
    assert.equal(refused.control.revision, 1);
    assert.equal((await operations.control(id)).control.revision, 1);

    // The user's explicit resume is the one that clears it, and the held period's queue is then consumed under the
    // configured mode: the default follow-up mode is one at a time, so each queued item gets its own run and both run
    // in queue order.
    const resumed = await operations.continue(id, { requestId: "continue-1", caller: "user" });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.control.state, "allowed");
    await rig.harness.waitForIdle(BACKGROUND_CONTEXT);
    const texts = async (): Promise<string[]> => {
      const context = await rig.conversation.context(BACKGROUND_CONTEXT);
      return context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join(""));
    };
    // Poll the committed transcript rather than the idle flag: with one-at-a-time consumption the next run starts as
    // the previous one ends, so "idle" is not a moment this test can rely on observing.
    const deadline = Date.now() + 8000;
    while ((await texts()).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await texts(), ["queued report", "staged draft"]);
    assert.equal(rig.requests(), 2, "each queued item was consumed by its own run under the configured mode");
  }
});

test("a stop leaves a background task of the same conversation running", { timeout: 20000 }, async (t) => {
  const rig = await openNativeRig(t, { registry: backgroundRegistry(), holdRequests: [1] });
  const operations = createConversationOperations(rig.harness);
  const id = String(rig.conversation.id);

  const sleeper = await startBackgroundSleeper(rig.conversation, 3000);
  await rig.conversation.submit({ type: "input", content: [{ type: "text", text: "foreground work" }], requestId: "fg-1" }, BACKGROUND_CONTEXT);
  const stopped = await operations.stop(id, { requestId: "stop-1", stopSource: "user" });
  assert.equal(stopped.status, "accepted");
  // The ordinary run is still in flight, so the drain is not over; the background task is outside that scope.
  assert.equal(stopped.drain, "stopping");

  rig.release();
  await rig.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const settled = await rig.harness.waitForTask(sleeper, BACKGROUND_CONTEXT);
  assert.equal(settled.state.outcome.status, "completed", "the background task ran to its own end");
  // The hold is still in place after the ordinary scope drained, and only the user's resume clears it.
  assert.equal((await operations.control(id)).control.state, "held");
  const resumed = await operations.continue(id, { requestId: "continue-1", caller: "user" });
  assert.equal(resumed.status, "resumed");
});

test("a lost stop answer is recovered from the durable receipt after a real process restart", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-control-restart-"));
  directories.push(directory);
  const dbPath = join(directory, "restart.sqlite");

  const first = await start(t, dbPath);
  const id = await createConversation(first.origin);
  first.gate.arm();
  assert.equal((await submit(first.origin, id, "run-1", "first")).status, 202);
  await waitForState(first.origin, id, current => current.busy, "the run to reach the provider");
  const stopped = await stop(first.origin, id, "stop-1");
  assert.equal(stopped.status, 202);
  const stoppedBody = await stopped.json() as { drain: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  first.gate.release();
  await waitForState(first.origin, id, current => !current.busy, "the stopped run to settle");
  await first.backend.close();

  // A real restart over the same SQLite file: the hold, its revision, its trusted source and its receipt all survive.
  const second = await start(t, dbPath);
  const recovered = await control(second.origin, id, "stop-1");
  assert.deepEqual(recovered.control, stoppedBody.control, "the committed stop survived the restart");
  assert.equal(recovered.control.state, "held");
  assert.equal(recovered.control.stopSource, "user");
  assert.equal(recovered.receipt?.status, "accepted");
  assert.equal(recovered.receipt?.at, stoppedBody.receipt.at, "the receipt is the same record, not a new decision");
  assert.equal((await state(second.origin, id)).queuedMessages.followUp.length, 0);

  // The restart alone served no model request, and the resume retried with its own id clears the hold once.
  const before = second.requests();
  const resumed = await resume(second.origin, id, "continue-1");
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const resumedBody = await resumed.json() as { status: string; control: ServerSnapshot["control"] };
  assert.equal(resumedBody.status, "resumed");
  assert.equal(resumedBody.control.revision, stoppedBody.control.revision + 1);
  const replay = await resume(second.origin, id, "continue-1");
  assert.equal(replay.status, 202);
  assert.deepEqual((await replay.json() as { control: ServerSnapshot["control"] }).control, resumedBody.control);
  assert.equal(second.requests(), before, "neither the restart nor the replayed resume started a run");
  assert.deepEqual(userTexts(await state(second.origin, id)), ["first"]);
});

test("continue on a conversation that is not held answers allowed and starts no run", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  const response = await resume(rig.origin, id, "continue-1");
  assert.equal(response.status, 202, await response.clone().text());
  const body = await response.json() as { status: string; control: ServerSnapshot["control"]; receipt: ControlReceipt };
  assert.equal(body.status, "allowed");
  assert.equal(body.control.state, "allowed");
  assert.equal(body.receipt.status, "allowed");
  assert.equal(body.receipt.operation, "continue");
  assert.equal(rig.requests(), 0);
  assert.deepEqual(userTexts(await state(rig.origin, id)), []);
});

test("a resume with text admits it in the same commit that clears the hold", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  const response = await resume(rig.origin, id, "continue-1", { text: "resume with input" });
  assert.equal(response.status, 202, await response.clone().text());
  const body = await response.json() as { status: string; submissionId?: string; control: ServerSnapshot["control"] };
  assert.equal(body.status, "resumed");
  assert.ok(body.submissionId !== undefined, "the resume's input was admitted by the same commit");
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 1, "the resume input to run");
  assert.deepEqual(userTexts(settled), ["resume with input"]);
  assert.equal(rig.requests(), 1);
  // A retry of the identical resume is answered from its receipt: the input is not admitted a second time.
  const retry = await resume(rig.origin, id, "continue-1", { text: "resume with input" });
  assert.equal(retry.status, 202);
  assert.deepEqual((await retry.json() as { control: ServerSnapshot["control"] }).control, body.control);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rig.requests(), 1);
  assert.deepEqual(userTexts(await state(rig.origin, id)), ["resume with input"]);
});

test("a held send keeps the caller's own request id, so its lost answer is recovered by that id", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  rig.gate.arm();
  assert.equal((await submit(rig.origin, id, "run-1", "first")).status, 202);
  await waitForState(rig.origin, id, current => current.busy, "the run to reach the provider");
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);

  // The send that a held conversation turns into a resume: the drain is still running, so nothing is admitted yet and
  // the answer carries no submission id. The caller drops that answer here, exactly as a broken connection drops it.
  assert.equal((await submit(rig.origin, id, "immediate-1", "immediate input")).status, 202);
  rig.gate.release();
  await waitForState(rig.origin, id, current => !current.busy, "the stopped run to settle");

  // The retry is the same request id, and it answers the submission that id names. The model is held again so the
  // admitted turn stays in flight and the outstanding-submission projection can be read while it is pending.
  rig.gate.arm();
  const retried = await submit(rig.origin, id, "immediate-1", "immediate input");
  assert.equal(retried.status, 202, await retried.clone().text());
  const body = await retried.json() as { status: string; submissionId?: string };
  assert.equal(body.status, "resumed");
  assert.ok(body.submissionId !== undefined, "the resumed input was admitted under the caller's own id");

  // Recovery: the surface's own pending-turn read asks the conversation about the request id it generated, and it is
  // that id — not a second identity the caller never chose — that answers the submission it made.
  const lookup = await fetch(rig.origin + "/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent("immediate-1"), { headers });
  assert.equal(lookup.status, 200, await lookup.clone().text());
  const found = await lookup.json() as { submission: { submissionId: string; requestId?: string } | null };
  assert.ok(found.submission !== null, "the request id the client sent still resolves after a real admission");
  assert.equal(found.submission.submissionId, body.submissionId);
  assert.equal(found.submission.requestId, "immediate-1", "the submission carries the caller's request id, not a derived one");
  // The outstanding-submission projection a reconnecting client folds its pending turn by names the same identity: it
  // is read while the turn is in flight, because a settled submission is no longer outstanding.
  const running = await waitForState(rig.origin, id, current => current.submissions.some(entry => entry.requestId === "immediate-1"), "the pending submission to be projected");
  assert.equal(running.submissions.some(entry => (entry.requestId ?? "").endsWith(":input")), false, "no derived identity reaches the wire");
  rig.gate.release();
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 2, "the immediate input to run");
  assert.deepEqual(userTexts(settled), ["first", "immediate input"]);
  assert.equal(rig.requests(), 2);
});

test("a resume whose request id already names a submission consumes the held queue instead of stranding it", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  // One input is admitted under the id a later resume will carry. The native admission answers a known request id with
  // the existing submission and runs no boundary, so a resume that handed this id to the admission would clear the
  // hold while leaving the held queue where it was.
  assert.equal((await post(rig.origin, id, "busy", { mode: "follow-up", text: "queued under the hold", requestId: "same-1" })).status, 202);
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: ["queued under the hold"] });

  const resumed = await resume(rig.origin, id, "same-1", { text: "already admitted" });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const body = await resumed.json() as { status: string; submissionId?: string };
  assert.equal(body.status, "resumed");
  const named = await fetch(rig.origin + "/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent("same-1"), { headers });
  assert.equal(body.submissionId, ((await named.json()) as { submission: { submissionId: string } }).submission.submissionId, "the resume answers the submission that id already names");
  // The hold is gone and the queue it held was consumed: the one message runs, and no second copy of the resume text
  // was admitted.
  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 1, "the held queue to be consumed");
  assert.deepEqual(userTexts(settled), ["queued under the hold"]);
  assert.deepEqual(settled.queuedMessages, { steering: [], followUp: [] });
  assert.equal(rig.requests(), 1);
});

test("a replay of an ordinary send after a later stop never re-admits the message", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await submit(rig.origin, id, "msg-1", "ordinary message")).status, 202);
  await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 1, "the ordinary turn to run");

  // A stop, then the same request id again: the message it names is already committed, so the retry answers that
  // submission and adds no second copy under any identity, and the hold it did not resume stands.
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  const replay = await submit(rig.origin, id, "msg-1", "ordinary message");
  assert.equal(replay.status, 202, await replay.clone().text());
  const body = await replay.json() as { status?: string; control: ServerSnapshot["control"] };
  assert.equal(body.status, undefined, "an ordinary admission records no resume answer to replay");
  assert.equal(body.control.state, "held", "the replay did not resume the hold it was not asked to clear");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rig.requests(), 1);
  assert.deepEqual(userTexts(await state(rig.origin, id)), ["ordinary message"]);
  assert.deepEqual((await state(rig.origin, id)).queuedMessages, { steering: [], followUp: [] });
});

test("a continue and a send racing on one hold answer coherently and admit the message once", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);

  // Two surfaces act on the same hold at once: the tab's Continue and a send that resumes it. Whichever reaches the
  // control commit first clears it, and the outcome is the same either way: one submission, one run, and both answers
  // naming what really happened. This states the invariant rather than forcing the window — the commit that clears the
  // hold is one native transaction, so the interleave is rare and was not reproduced in forty concurrent attempts; the
  // `allowed` arm the send keeps is what answers it when it does happen, without dropping the message.
  const [continued, sent] = await Promise.all([
    resume(rig.origin, id, "continue-1"),
    submit(rig.origin, id, "immediate-1", "raced message"),
  ]);
  assert.equal(continued.status, 202, await continued.clone().text());
  assert.equal(sent.status, 202, await sent.clone().text());
  const sentBody = await sent.json() as { status?: string; submissionId?: string };
  assert.ok(sentBody.submissionId !== undefined, "the send answered the submission it made: " + JSON.stringify(sentBody));

  const settled = await waitForState(rig.origin, id, current => !current.busy && userTexts(current).length === 1, "the raced message to run");
  assert.deepEqual(userTexts(settled), ["raced message"]);
  assert.equal(rig.requests(), 1);
  const lookup = await fetch(rig.origin + "/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent("immediate-1"), { headers });
  assert.equal(((await lookup.json()) as { submission: { submissionId: string } | null }).submission?.submissionId, sentBody.submissionId);
});
test("the state frame states the control beside the queue it governs", { timeout: 20000 }, async (t) => {
  const rig = await start(t);
  const id = await createConversation(rig.origin);
  const initial = await state(rig.origin, id);
  assert.deepEqual(initial.control, { state: "allowed", revision: 0 });
  assert.deepEqual(initial.queuedMessages, { steering: [], followUp: [] });

  assert.equal((await stop(rig.origin, id, "stop-1")).status, 202);
  assert.equal((await post(rig.origin, id, "busy", { mode: "steer", text: "held steer", requestId: "q-1" })).status, 202);
  const held = await state(rig.origin, id);
  assert.equal(held.control.state, "held");
  assert.equal(held.control.stopSource, "user");
  assert.deepEqual(held.queuedMessages, { steering: ["held steer"], followUp: [] });
  // The hold rides the stream's own baseline frame too, so a client that connects while held learns it from the frame
  // it is handed rather than from a second request.
  const stream = await fetch(rig.origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(1500) });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let baseline: ServerSnapshot | undefined;
  while (baseline === undefined) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    let boundary: number;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
      if (dataLine === undefined || !frame.startsWith("event: snapshot")) continue;
      baseline = JSON.parse(dataLine.slice(6)) as ServerSnapshot;
    }
  }
  await reader.cancel().catch(() => {});
  assert.ok(baseline !== undefined, "the stream stated its baseline");
  assert.deepEqual(baseline.control, held.control);
  assert.deepEqual(baseline.queuedMessages, held.queuedMessages);
});
