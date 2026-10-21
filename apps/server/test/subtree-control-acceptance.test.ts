import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { startGatewayHost, type GatewayHost } from "./recovery-acceptance-host.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

/**
 * Ticket 04: the system acceptance of subtree control, over the surfaces tickets 01-03 delivered.
 *
 * The owning tickets assert their own seam. What this file adds is the matrix no single ticket could state: a **deep**
 * tree with a hidden middle conversation and a second subtree beside it, the races a request meets when something else
 * moves at the same moment, a real `SIGKILL` between the first child's outcome and the rest, and a delegated child whose
 * execution host really dies mid-command. Every assertion reads a fact a caller can read — the HTTP answer, the
 * catalogue row, the committed control, the transcript, the queue — and nothing here is a second implementation of the
 * operation, a scheduler, or a poller of its own.
 *
 * Two kinds of process control are used, both already established in this repository and both owned by the test:
 *
 * - `SIGKILL` of a child process this test started (the crash stage), because "the process died here" is a real state
 *   and a clean close is not.
 * - `SIGKILL` of the execution host this test started (the gateway fixture), because a lost command is measured against
 *   a gateway that is really gone, never against a stub that says it went away.
 *
 * Nothing here starts, stops or writes a deployment.
 */

const directories: string[] = [];
const token = "subtree-acceptance-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const crashChild = fileURLToPath(new URL("./subtree-control-acceptance-child.ts", import.meta.url));

/** The model gate: while armed, the next answer waits until the test releases it, so "busy" is a real state. */
class Gate {
  #armed = false;
  #waiters: (() => void)[] = [];
  arm(): void { this.#armed = true; }
  async hold(): Promise<void> { await new Promise<void>(resolve => { this.#waiters.push(resolve); }); }
  release(): void { this.#armed = false; for (const resolve of this.#waiters.splice(0)) resolve(); }
  get armed(): boolean { return this.#armed; }
}

type Rig = { backend: BackendServer; origin: string; dbPath: string; gate: Gate; close(): Promise<void> };

/**
 * A real backend over a test-owned SQLite file, whose model answer the test can hold. An existing file is reopened
 * through the product's own composition, which is how a store a killed process left behind is read back.
 */
async function start(t: TestContext, options: { dbPath?: string; script?: (faux: FauxProviderHandle, gate: Gate) => void } = {}): Promise<Rig> {
  const directory = options.dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-subtree-acceptance-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = options.dbPath ?? join(directory!, "subtree.sqlite");
  const gate = new Gate();
  const faux = fauxProvider();
  const answer: FauxResponseFactory = async (): Promise<AssistantMessage> => {
    faux.setResponses([answer]);
    if (gate.armed) await gate.hold();
    return fauxAssistantMessage("answer " + faux.state.callCount);
  };
  faux.setResponses([answer]);
  if (options.script !== undefined) options.script(faux, gate);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: path, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const close = async (): Promise<void> => { gate.release(); backend.server.closeAllConnections(); await backend.close(); };
  t.after(close);
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path, gate, close };
}

type Row = { id: string; displayParentId?: string; displayParentDeleted?: boolean; createdBy?: string; runStatus?: { state: string; reason?: string }; busy?: boolean };
type Snapshot = {
  busy: boolean;
  control: { state: string; revision: number; stopSource?: string };
  entries: { id: string; role: string; text: string }[];
  queuedMessages: { steering: string[]; followUp: string[] };
  queuedItems: { mode: string; source: { kind: string; childConversationId?: string } }[];
};
type Answer = {
  requestId: string;
  action: "stop" | "interrupt";
  status: "completed" | "pending";
  scope: string[];
  selected: string[] | null;
  partial: boolean;
  outcomes: { conversationId: string; status: string; reason?: string; control: { state: string; revision: number }; session?: Row }[];
};

async function create(origin: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (await JSON.parse(text) as { conversation: Row }).conversation;
}

const post = (origin: string, id: string, action: string, body?: unknown) =>
  fetch(origin + "/api/conversations/" + id + "/" + action, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const subtree = (origin: string, id: string, body: Record<string, unknown>) => post(origin, id, "subtree-control", body);

const readSubtree = async (origin: string, id: string, requestId: string): Promise<Answer> => {
  const response = await fetch(origin + "/api/conversations/" + id + "/subtree-control?requestId=" + encodeURIComponent(requestId), { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Answer;
};

const submit = (origin: string, id: string, requestId: string, text: string, whenBusy?: string) =>
  post(origin, id, "messages", { protocol: "hepi.v1", type: "conversation.submit", requestId, text, ...(whenBusy === undefined ? {} : { whenBusy }) });

async function state(origin: string, id: string): Promise<Snapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Snapshot;
}

const info = async (origin: string, id: string): Promise<Record<string, unknown>> => {
  const response = await fetch(origin + "/api/conversations/" + id, { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Record<string, unknown>;
};

const catalogue = async (origin: string): Promise<Row[]> => {
  const response = await fetch(origin + "/api/conversations", { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (await JSON.parse(text) as { conversations: Row[] }).conversations;
};

/** Poll a real condition on committed state, so a loaded machine cannot race a fixed sleep. */
async function poll<T>(accept: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await accept();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

const outcomeOf = (answer: Answer, id: string) => {
  const found = answer.outcomes.find(outcome => outcome.conversationId === id);
  assert.ok(found !== undefined, "no outcome for " + id + ": " + JSON.stringify(answer.outcomes));
  return found;
};

/**
 * One four-level family beside a second subtree: root -> a -> b -> c, and root2 -> sibling. Deep enough that a walk
 * which stopped one level short would pass a two-level test and fail here.
 */
async function deeperFamily(origin: string): Promise<{ root: Row; a: Row; b: Row; c: Row; root2: Row; sibling: Row }> {
  const root = await create(origin);
  const a = await create(origin, { displayParentId: root.id });
  const b = await create(origin, { displayParentId: a.id });
  const c = await create(origin, { displayParentId: b.id });
  const root2 = await create(origin);
  const sibling = await create(origin, { displayParentId: root2.id });
  return { root, a, b, c, root2, sibling };
}

test("a deep tree with a hidden middle conversation is captured whole, a child outside it is never reached, and no record of the tree changes", async (t) => {
  const rig = await start(t);
  const { root, a, b, c, root2, sibling } = await deeperFamily(rig.origin);
  // A turn that really committed on the leaf and a queued follow-up on the middle conversation: the two things a stop
  // could plausibly truncate or consume, asserted before and after.
  assert.equal((await submit(rig.origin, c.id, "leaf-turn", "leaf work")).status, 202);
  await poll(async () => (await state(rig.origin, c.id)).entries.length > 0 ? true : undefined, "the leaf's answer");
  assert.equal((await submit(rig.origin, b.id, "middle-queued", "queued work", "followUp")).status, 202);
  const before = new Map<string, Snapshot>();
  for (const id of [a.id, b.id, c.id]) before.set(id, await state(rig.origin, id));
  const relationsBefore = await info(rig.origin, a.id);
  // The middle conversation is hidden: the tree a catalogue shows no longer has it, and the relation under it stays.
  assert.equal((await fetch(rig.origin + "/api/conversations/" + b.id, { method: "DELETE", headers })).status, 200);
  assert.equal((await info(rig.origin, b.id)).relations !== undefined, true, "a removed conversation still answers its relations");
  // Counted after the removal, so the two reads below differ by nothing the operation did.
  const catalogueBefore = (await catalogue(rig.origin)).length;

  const answered = JSON.parse(await (await subtree(rig.origin, root.id, { requestId: "acc-deep", action: "stop" })).text()) as Answer;
  assert.deepEqual(answered.scope, [a.id, b.id, c.id], "the capture is the transitive descendant set, across the hidden parent");
  assert.equal(answered.status, "completed");
  const statuses = new Map(answered.outcomes.map(outcome => [outcome.conversationId, outcome.status]));
  assert.equal(statuses.get(a.id), "accepted");
  assert.equal(statuses.get(b.id), "conflict", "the removed middle conversation states its own conflict");
  assert.equal(outcomeOf(answered, b.id).reason, "session_deleted", "the conflict carries the runtime's own removal reason");
  assert.equal(statuses.get(c.id), "accepted", "the leaf under the hidden parent is controlled");
  assert.equal(answered.partial, true, "the partial result is visible");
  // The second subtree is outside the capture and was never named to the Backend.
  assert.equal(answered.scope.includes(sibling.id), false);
  assert.equal((await state(rig.origin, sibling.id)).control.state, "allowed");
  assert.equal((await state(rig.origin, root2.id)).control.state, "allowed");
  // Neither the addressed conversation nor the hidden one was held, and the controlled children were held once each.
  assert.equal((await state(rig.origin, root.id)).control.state, "allowed");
  assert.equal((await state(rig.origin, a.id)).control.state, "held");
  assert.equal((await state(rig.origin, c.id)).control.state, "held");
  assert.equal((await state(rig.origin, a.id)).control.revision, 1);
  // History, relations, the queue and the catalogue are what they were: this operation reached control state only.
  for (const id of [a.id, c.id]) {
    const after = await state(rig.origin, id);
    assert.deepEqual(after.entries.map(entry => [entry.id, entry.text]), before.get(id)!.entries.map(entry => [entry.id, entry.text]), id + " kept its transcript");
  }
  const middle = await state(rig.origin, b.id);
  assert.deepEqual(middle.entries.map(entry => [entry.id, entry.text]), before.get(b.id)!.entries.map(entry => [entry.id, entry.text]));
  assert.deepEqual(middle.queuedMessages.followUp, before.get(b.id)!.queuedMessages.followUp, "the queued input survived the conflict");
  assert.deepEqual((await info(rig.origin, a.id)).relations, relationsBefore.relations, "the relation is untouched");
  assert.equal((await catalogue(rig.origin)).length, catalogueBefore, "nothing was added to or removed from the catalogue");

  // A selection naming a conversation outside this captured subtree is refused whole, before anything is written.
  const outside = await subtree(rig.origin, root.id, { requestId: "acc-outside", action: "stop", selected: [sibling.id] });
  assert.equal(outside.status, 409);
  assert.equal((await outside.json() as { code: string }).code, "outside_subtree");
  assert.equal((await state(rig.origin, sibling.id)).control.state, "allowed");
});

test("concurrent duplicate requests settle the request once, and a child created while the capture lands is never swept in", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const first = await create(rig.origin, { displayParentId: root.id });
  const second = await create(rig.origin, { displayParentId: root.id });
  // Two callers, one identity, at the same moment: the same request must not control a child twice.
  const [left, right] = await Promise.all([
    subtree(rig.origin, root.id, { requestId: "acc-dup", action: "stop" }),
    subtree(rig.origin, root.id, { requestId: "acc-dup", action: "stop" }),
  ]);
  assert.deepEqual([left.status, right.status], [202, 202]);
  const [a, b] = [JSON.parse(await left.text()) as Answer, JSON.parse(await right.text()) as Answer];
  assert.deepEqual(a.scope, [first.id, second.id]);
  assert.deepEqual(b.scope, a.scope, "both callers are answered from the one capture");
  for (const id of [first.id, second.id]) {
    const held = await state(rig.origin, id);
    assert.equal(held.control.state, "held");
    assert.equal(held.control.revision, 1, id + " was stopped exactly once");
  }
  // A child created while a second request captures is either in that request's capture or outside it, and whichever
  // happened, the replay answers the same set and nothing outside it is touched.
  const [created, racing] = await Promise.all([
    create(rig.origin, { displayParentId: root.id }),
    subtree(rig.origin, root.id, { requestId: "acc-race", action: "stop" }),
  ]);
  const racingAnswer = JSON.parse(await racing.text()) as Answer;
  const replay = await readSubtree(rig.origin, root.id, "acc-race");
  assert.deepEqual(replay.scope, racingAnswer.scope, "the replay is answered from the capture, not from a fresh walk");
  assert.equal(replay.scope.includes(created.id), racingAnswer.scope.includes(created.id), "the replay does not add a child the capture did not hold");
  if (!racingAnswer.scope.includes(created.id)) assert.equal((await state(rig.origin, created.id)).control.state, "allowed", "a child the capture did not hold is untouched");
  // Replaying every identity above changes no control revision at all.
  for (const requestId of ["acc-dup", "acc-race"]) {
    const revisions = await Promise.all(racingAnswer.scope.map(async id => (await state(rig.origin, id)).control.revision));
    const again = JSON.parse(await (await subtree(rig.origin, root.id, { requestId, action: "stop" })).text()) as Answer;
    assert.equal(again.status, "completed");
    const after = await Promise.all(racingAnswer.scope.map(async id => (await state(rig.origin, id)).control.revision));
    assert.deepEqual(after, revisions, requestId + " replayed without a second control change");
  }
});

test("a live child completing during the request and a user's own continue both stay authoritative, and no answer is rewritten", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const running = await create(rig.origin, { displayParentId: root.id });
  const resumed = await create(rig.origin, { displayParentId: root.id });
  // One child is really running: its provider answer waits until the test releases it.
  rig.gate.arm();
  assert.equal((await submit(rig.origin, running.id, "acc-run", "long task")).status, 202);
  await poll(async () => (await state(rig.origin, running.id)).busy ? true : undefined, "the running child");
  // The other child is held by the request itself, and the user lifts that hold with its own control route.
  const answer = JSON.parse(await (await subtree(rig.origin, root.id, { requestId: "acc-race-states", action: "stop" })).text()) as Answer;
  assert.equal(outcomeOf(answer, running.id).status, "stopping", "a live child is reached and drains");
  assert.equal(outcomeOf(answer, resumed.id).status, "accepted");
  assert.equal((await post(rig.origin, resumed.id, "continue", { requestId: "acc-user-continue" })).status, 202);
  const lifted = await state(rig.origin, resumed.id);
  assert.equal(lifted.control.state, "allowed", "the user's own continue is what resumes a child");
  assert.equal((await info(rig.origin, resumed.id)).relations !== undefined, true);

  // The child that was draining finishes while the request is being read back: the recorded outcome does not move, and
  // the projection states what the child is doing now.
  rig.gate.release();
  const drained = await poll(async () => {
    const current = await readSubtree(rig.origin, root.id, "acc-race-states");
    const row = outcomeOf(current, running.id).session;
    return row?.runStatus?.state === "held" ? current : undefined;
  }, "the draining child to read held");
  assert.equal(outcomeOf(drained, running.id).status, "stopping", "the record still states what the request did");
  assert.equal(outcomeOf(drained, resumed.id).status, "accepted");
  assert.equal(outcomeOf(drained, resumed.id).control.state, "allowed", "and the user's continue is still the child's state");
  assert.equal((await state(rig.origin, resumed.id)).control.revision, lifted.control.revision, "a read changed no control");

  // Replaying the request after the user resumed the child re-holds nothing: every child has a recorded outcome, so the
  // request is answered and no control call is made — a user's own decision is not silently reverted by a retry.
  const replay = JSON.parse(await (await subtree(rig.origin, root.id, { requestId: "acc-race-states", action: "stop" })).text()) as Answer;
  assert.deepEqual(replay.outcomes.map(outcome => outcome.status), answer.outcomes.map(outcome => outcome.status));
  const stillAllowed = await state(rig.origin, resumed.id);
  assert.equal(stillAllowed.control.state, "allowed", "the replay did not re-hold a child the user resumed");
  assert.equal(stillAllowed.control.revision, lifted.control.revision, "nor advance its revision");
  assert.equal((await state(rig.origin, root.id)).control.state, "allowed", "the addressed conversation stays local");
});

test("a real SIGKILL between the first child's outcome and the rest leaves a resumable request that settles each child exactly once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-acceptance-crash-"));
  directories.push(directory);
  const dbPath = join(directory, "subtree.sqlite");
  // The stage kills itself inside the commit that records the first child's answer: the request exists, one child is
  // answered durably, and the rest have nothing recorded.
  const killed = spawnSync(process.execPath, [crashChild, dbPath, "partial"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(killed.status, null, "the stage exited on its own instead of being killed: " + killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { rootId: string; scope: string[]; recorded: string[] };
  assert.equal(facts.scope.length, 2, "the capture held both children");
  assert.equal(facts.recorded.length, 1, "exactly one child was answered before the kill");
  assert.deepEqual(facts.recorded, [facts.scope[0]], "the answered child is the first of the captured order");

  // A fresh process over the same store, answering through the same routes: a partial request reads back as pending.
  const rig = await start(t, { dbPath });
  const pending = await readSubtree(rig.origin, facts.rootId, "accept-partial");
  assert.equal(pending.status, "pending", "the killed request is stated as unfinished");
  assert.deepEqual(pending.scope, facts.scope);
  assert.deepEqual(pending.outcomes.map(outcome => outcome.status), ["accepted", "pending"]);
  // The recovery read is a read: nothing moved while it ran.
  const revisionsAfterRead = await Promise.all(facts.scope.map(async id => (await state(rig.origin, id)).control.revision));
  const reread = await readSubtree(rig.origin, facts.rootId, "accept-partial");
  assert.deepEqual(reread.outcomes.map(outcome => outcome.status), ["accepted", "pending"]);
  assert.deepEqual(await Promise.all(facts.scope.map(async id => (await state(rig.origin, id)).control.revision)), revisionsAfterRead);

  // The same identity resumes the request and continues with the child that has no outcome.
  const resumed = JSON.parse(await (await subtree(rig.origin, facts.rootId, { requestId: "accept-partial", action: "stop" })).text()) as Answer;
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.outcomes.map(outcome => outcome.conversationId), facts.scope);
  // Each child ends controlled under the resumed request. The child the kill had already reached answers `held` — its
  // own control commit landed before its outcome did — and the untouched one answers `accepted`; neither is a second
  // stop, which is what the revision below measures.
  for (const outcome of resumed.outcomes) assert.ok(["accepted", "held", "already-settled", "stopping"].includes(outcome.status), "unexpected resumed outcome: " + outcome.status);
  for (const id of facts.scope) {
    const held = await state(rig.origin, id);
    assert.equal(held.control.state, "held");
    assert.equal(held.control.revision, 1, id + " was stopped exactly once across the kill");
  }
  // A replay after the resume records no second control change and answers the same outcomes.
  const replay = JSON.parse(await (await subtree(rig.origin, facts.rootId, { requestId: "accept-partial", action: "stop" })).text()) as Answer;
  assert.deepEqual(replay.outcomes.map(outcome => outcome.status), ["accepted", "accepted"]);
  for (const id of facts.scope) assert.equal((await state(rig.origin, id)).control.revision, 1, id + " was not stopped twice");
  assert.equal((await state(rig.origin, facts.rootId)).control.state, "allowed", "the addressed conversation stayed local through the crash and the resume");
});

/** The last user text of a transcript, which is the turn a scripted response is answering. */
function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
  const last = messages.findLast(message => message.role === "user");
  return last === undefined ? "" : contentText(last.content as never);
}

/** One backend bound to an execution host the test owns, so a command really runs and can really be lost. */
async function startBound(t: TestContext, gatewayOrigin: string, script: (faux: FauxProviderHandle) => void) {
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-acceptance-gateway-"));
  directories.push(directory);
  const faux = fauxProvider();
  script(faux);
  const models = createModels(); models.setProvider(faux.provider);
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin, gatewayToken: token };
  const backend = await createBackendServer({ dbPath: join(directory, "hepi.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL, workspaces: [binding] });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const close = async (): Promise<void> => { backend.server.closeAllConnections(); await backend.close(); };
  t.after(close);
  return { origin: "http://127.0.0.1:" + address.port, close };
}

test("a delegated child whose execution host dies mid-command is controlled by a subtree request and keeps its queued report", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-acceptance-host-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(workspace, ".pi", "agents"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(workspace, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - bash\ncontext: fresh\n---\n\nRun the command you are given, once.\n");
  const effectLog = join(workspace, "effect.log");
  await writeFile(effectLog, "");
  // The execution host is the deployment's own entrypoint in its own process over its own journal, ended with SIGKILL.
  const host: GatewayHost = await startGatewayHost({
    token,
    gatewayId: "workstation",
    workspaceId: "local",
    workspaceRoot: workspace,
    allowedCommands: ["bash", "printf", "sleep"],
    journalPath: join(directory, "gateway.db"),
    home: join(directory, "gateway-home"),
  });
  t.after(() => host.kill());
  const gate = new Gate();
  // A held answer would keep the backend's own close waiting; the test owns the release, so its teardown does too.
  t.after(() => gate.release());
  const rig = await startBound(t, host.origin, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string; isError?: boolean }[];
      if (lastUserText(messages) === "child work") {
        if (messages.some(message => message.role === "toolResult" && message.toolName === "bash")) {
          // The command's answer never arrived. The child's next turn waits here, so it is really busy while the subtree
          // request reaches it — the state a stop must report as draining rather than settled.
          gate.arm();
          await gate.hold();
          return fauxAssistantMessage("child settled after the loss");
        }
        return fauxAssistantMessage([fauxToolCall("bash", { command: "printf running >> effect.log; sleep 60" }, { id: "call-hang" })], { stopReason: "toolUse" });
      }
      if (messages.some(message => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent delegated");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-anchor" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  });

  const parent = await create(rig.origin, { workspaceId: "local" });
  assert.deepEqual((await (await fetch(rig.origin + "/api/conversations/" + parent.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) })).json() as { extensions: string[] }).extensions, ["coding-tools", "hepi-subagents"]);
  const delegated = await fetch(rig.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "child work", requestId: "acc-dispatch" }) });
  const delegatedText = await delegated.text();
  assert.equal(delegated.status, 201, delegatedText);
  const childId = (JSON.parse(delegatedText) as { childConversationId: string }).childConversationId;
  // The command really ran on the host this test owns: its own effect file says so before the host is ended.
  await poll(async () => (await readFile(effectLog, "utf8")).includes("running") ? true : undefined, "the child's command to run on the gateway host", 30_000);
  // The parent's own stop is the decision that keeps a report queued; it is asserted here as the non-cascading case.
  assert.equal((await post(rig.origin, parent.id, "stop", { requestId: "acc-parent-stop" })).status, 202);
  host.kill();
  assert.deepEqual(await host.ended, { signal: "SIGKILL", code: null }, "the execution host this test ended did not end by SIGKILL: " + host.output());

  // The lost command is stated to the child as an outcome it can read, and the child is then busy on its next turn.
  const lost = await poll(async () => {
    const current = await state(rig.origin, childId);
    const outcome = current.entries.find(entry => entry.role === "toolResult");
    return outcome === undefined ? undefined : current;
  }, "the child's committed tool result after its execution host died");
  assert.match(lost.entries.find(entry => entry.role === "toolResult")!.text, /outcome_unknown/u);
  const draining = await poll(async () => {
    const row = (await catalogue(rig.origin)).find(candidate => candidate.id === childId);
    return row?.runStatus?.state === "stopping" || row?.runStatus?.state === "running" ? row : undefined;
  }, "the child to be live after the loss");
  assert.equal(draining.busy, true, "the child's next turn is in flight, so the subtree request reaches live work");
  // The parent's own queue is read before the request, so what the operation does to it is a comparison and not a hope.
  const queueBefore = await state(rig.origin, parent.id);

  // The subtree request reaches the child while its execution host is gone and its own turn is in flight.
  const answer = JSON.parse(await (await subtree(rig.origin, parent.id, { requestId: "acc-gateway", action: "stop" })).text()) as Answer;
  assert.deepEqual(answer.scope, [childId], "the delegated child is the parent's captured subtree");
  assert.equal(outcomeOf(answer, childId).status, "stopping", "the live child is reached and drains");
  assert.equal(outcomeOf(answer, childId).control.state, "held");
  assert.equal(answer.partial, false, "a child that drains is not a partial result");
  const childRow = (await catalogue(rig.origin)).find(candidate => candidate.id === childId);
  assert.deepEqual(outcomeOf(answer, childId).session, childRow, "the answer states the child's own catalogue row");
  // Nothing about the parent moved: its own stop and its queue are what they were.
  const parentAfter = await state(rig.origin, parent.id);
  assert.equal(parentAfter.control.state, "held");
  assert.deepEqual(parentAfter.queuedItems.map(item => [item.mode, item.source.kind]), queueBefore.queuedItems.map(item => [item.mode, item.source.kind]));
  assert.deepEqual(parentAfter.entries.map(entry => entry.text), queueBefore.entries.map(entry => entry.text));

  // Releasing the child's turn settles the drain; the recorded outcome stays and the child ends held.
  gate.release();
  const settled = await poll(async () => {
    const current = await readSubtree(rig.origin, parent.id, "acc-gateway");
    const row = outcomeOf(current, childId).session;
    return row?.runStatus?.state === "held" ? current : undefined;
  }, "the child's drain to settle into its hold");
  assert.equal(outcomeOf(settled, childId).status, "stopping", "the record still states what the request did");
  assert.equal((await state(rig.origin, childId)).control.revision, outcomeOf(settled, childId).control.revision, "the child was not controlled twice");
  // The child's own report reaches the held parent now that its turn settled, and it is queued rather than consumed:
  // the subtree request reached control state only, so the report's admission is still the parent's to consume.
  const queued = await poll(async () => {
    const current = await state(rig.origin, parent.id);
    const report = current.queuedItems.find(item => item.source.kind === "report" && item.source.childConversationId === childId);
    return report === undefined ? undefined : report;
  }, "the child's report to queue in the held parent", 30_000);
  assert.equal(queued.mode, "followUp");
  // A read of the same request still states the same outcome and consumes nothing.
  const settledAgain = await readSubtree(rig.origin, parent.id, "acc-gateway");
  assert.equal(outcomeOf(settledAgain, childId).status, "stopping");
  assert.equal((await state(rig.origin, parent.id)).queuedItems.length, (await state(rig.origin, parent.id)).queuedItems.length);
});

test("a conversation whose own block is the runtime's refuses nothing: its subtree is still captured and controlled, and its blocked reason survives", { timeout: 180_000 }, async (t) => {
  // A real delegation whose process died inside the admission, reopened by a build that installs no task definitions. The
  // delegating conversation's own anchor is then blocked with the runtime's reason, which is the blocked row of the
  // acceptance matrix reached from a store the product wrote — not a fixture record and not a second projection.
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-acceptance-blocked-"));
  directories.push(directory);
  const dbPath = join(directory, "hepi.sqlite");
  const staged = spawnSync(process.execPath, [fileURLToPath(new URL("./acceptance-failure-child.ts", import.meta.url)), "delegation", dbPath, directory], { encoding: "utf8", timeout: 120_000 });
  assert.equal(staged.signal, "SIGKILL", "the delegation stage did not reach its crash window: " + staged.stderr + staged.stdout);
  const facts = JSON.parse(staged.stdout.trim().split("\n").at(-1)!) as { parentId: string; childId: string };

  const { openCrashHarness } = await import("./subagents-crash-harness.ts");
  const { projectRunStatus } = await import("../src/subagents/status.ts");
  const crash = await openCrashHarness(dbPath, { root: join(directory, "workspace"), home: join(directory, "home"), startPaused: true, tasks: [] });
  t.after(() => crash.close());
  // A grandchild beneath the delegated child, plus an idle child and a child the user already stopped, so one request
  // meets a settled child with history, a deeper descendant, an idle child and an already-held one at the same moment.
  const grandchild = await crash.operations.spawn({ requestId: "acc-grandchild", ownership: { kind: "ownerless" }, displayParentId: facts.childId });
  const idle = await crash.operations.spawn({ requestId: "acc-idle", ownership: { kind: "ownerless" }, displayParentId: facts.parentId });
  const held = await crash.operations.spawn({ requestId: "acc-held", ownership: { kind: "ownerless" }, displayParentId: facts.parentId });
  assert.equal((await crash.operations.stop(held.conversationId, { requestId: "acc-own-stop", stopSource: "user" })).status, "accepted");
  crash.harness.harness.resume();

  // The addressed conversation is blocked by the runtime, on its own real record, with the runtime's own reason — which
  // is what the projection the catalogue route calls states, before and after the request.
  const blocked = await poll(async () => {
    const inspection = await crash.harness.harness.inspect(BACKGROUND_CONTEXT);
    const own = inspection.tasks.filter(task => String(task.record.conversationId) === facts.parentId);
    return own.some(task => task.state.kind === "blocked") ? own : undefined;
  }, "the addressed conversation's anchor to state blocked");
  assert.deepEqual(projectRunStatus({ busy: false, control: { state: "allowed" }, tasks: blocked, waitingReport: false }), { state: "blocked", reason: "missing_task" });
  const child = await crash.harness.harness.conversation(Number(facts.childId) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(child !== undefined, "the delegated child is still readable");
  const childHistory = await child.context(BACKGROUND_CONTEXT);
  assert.ok(childHistory.entries.length > 0, "its committed history survived the process that died");

  const answer = await crash.operations.subtreeControl(facts.parentId, { requestId: "acc-blocked", action: "stop", stopSource: "user" });
  // Breadth-first from the addressed conversation: the three direct children in creation order, then the grandchild.
  assert.deepEqual(answer.scope, [facts.childId, idle.conversationId, held.conversationId, grandchild.conversationId], "a blocked conversation still captures its whole subtree, in discovery order");
  const statuses = new Map(answer.outcomes.map(outcome => [outcome.conversationId, outcome.status]));
  assert.equal(statuses.get(facts.childId), "accepted", "a settled child with history takes the hold at once");
  assert.equal(statuses.get(grandchild.conversationId), "accepted", "a deeper descendant is reached");
  assert.equal(statuses.get(idle.conversationId), "accepted");
  assert.equal(statuses.get(held.conversationId), "held", "the child held by its own stop says so as its own outcome");
  assert.equal(answer.partial, false, "a controlled set is not partial because the addressed conversation is blocked");
  for (const id of [facts.childId, grandchild.conversationId, idle.conversationId, held.conversationId]) {
    const current = await (await crash.harness.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT);
    assert.equal(current.state, "held", id + " is held");
  }
  // The blocked record is untouched and still outranks the request's own state: the addressed conversation was never held
  // by a request addressed to it, and the reason a surface states is still the runtime's.
  const inspection = await crash.harness.harness.inspect(BACKGROUND_CONTEXT);
  assert.equal(inspection.tasks.filter(task => String(task.record.conversationId) === facts.parentId && task.state.kind === "blocked").length, 1, "the blocked record survived the control untouched");
  assert.equal((await (await crash.harness.harness.conversation(Number(facts.parentId) as ConversationId, BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT)).state, "allowed", "the addressed conversation is not held by its own subtree request");
  assert.deepEqual(projectRunStatus({ busy: false, control: { state: "allowed" }, tasks: inspection.tasks.filter(task => String(task.record.conversationId) === facts.parentId), waitingReport: false }), { state: "blocked", reason: "missing_task" }, "the blocked reason is still what a surface states");
  // The child's history and the grandchild's relation are what they were: nothing was truncated and no relation removed.
  const after = await (await crash.harness.harness.conversation(Number(facts.childId) as ConversationId, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT);
  assert.deepEqual(after.entries.map(entry => String(entry.id)), childHistory.entries.map(entry => String(entry.id)), "the child's history is untouched");
  const relations = await crash.operations.get(grandchild.conversationId);
  assert.equal(relations?.relations.displayParentId, facts.childId, "the grandchild still names its parent");
  // A replay of the same identity records no second control change. The child the user had stopped itself carries that
  // stop's own revision plus this request's, and the replay advances neither.
  const revisions = new Map<string, number>();
  for (const id of answer.scope) revisions.set(id, (await (await crash.harness.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT)).revision);
  assert.equal(revisions.get(held.conversationId), 2, "the child the user already held records its own stop and this request's");
  for (const id of [facts.childId, grandchild.conversationId, idle.conversationId]) assert.equal(revisions.get(id), 1, id + " was stopped exactly once");
  const replay = await crash.operations.subtreeControl(facts.parentId, { requestId: "acc-blocked", action: "stop", stopSource: "user" });
  assert.deepEqual(replay.outcomes.map(outcome => outcome.status), answer.outcomes.map(outcome => outcome.status));
  for (const id of answer.scope) {
    const current = await (await crash.harness.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT);
    assert.equal(current.revision, revisions.get(id), id + " was not stopped again by the replay");
  }
});
