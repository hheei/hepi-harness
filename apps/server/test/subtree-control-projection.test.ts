/**
 * Ticket 02's observable behavior: the subtree answer projects **through the session status APIs it already has**.
 *
 * A subtree request states two different things about one child and must never collapse them into one: the durable
 * outcome the request recorded (`stopping`, `already-settled`, `conflict`, `pending`) and what that child is doing
 * **now**. This suite asserts that the current half is the same row `GET /api/conversations` shows — the same
 * `runStatus` projection, the same title, the same revision — read beside the outcome, so a surface can reconcile a
 * drain, a user's own continue, a queued report or a killed process without a second request, and without the record
 * being rewritten to match the present (spec decisions 4/5, ticket 02 acceptance).
 *
 * Every assertion reads a fact a caller can read over HTTP. Nothing here asserts on an internal helper, and nothing
 * here adds a scheduler, a second control path or a capability a route does not already have.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const directories: string[] = [];
const token = "subtree-projection-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The model gate: while armed the next provider answer waits, so `running` and `stopping` are real states. */
class Gate {
  #armed = false;
  #waiters: (() => void)[] = [];
  arm(): void { this.#armed = true; }
  async hold(): Promise<void> { await new Promise<void>(resolve => { this.#waiters.push(resolve); }); }
  release(): void { this.#armed = false; for (const resolve of this.#waiters.splice(0)) resolve(); }
  get armed(): boolean { return this.#armed; }
}

/** One subtree answer as the wire carries it, with this ticket's per-child session row. */
type Answer = {
  requestId: string;
  action: "stop" | "interrupt";
  status: "completed" | "pending";
  scope: string[];
  selected: string[] | null;
  partial: boolean;
  outcomes: Outcome[];
};
type Outcome = {
  conversationId: string;
  status: string;
  reason?: string;
  control: { state: string; revision: number; stopSource?: string };
  /** The child's own catalogue row — the one the session list shows — absent when the child is listed nowhere. */
  session?: Row;
};
type Row = Record<string, unknown> & { id: string; runStatus: { state: string; reason?: string } };
type State = {
  busy: boolean;
  control: { state: string; revision: number };
  entries: { role: string; text: string }[];
  queuedItems: { mode: string; source: { kind: string; childConversationId?: string } }[];
  queuedMessages: { steering: string[]; followUp: string[] };
};

const crashChild = fileURLToPath(new URL("./subtree-control-crash-child.ts", import.meta.url));

async function read<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  assert.equal(response.status, status, body);
  return JSON.parse(body) as T;
}

/** Poll a real condition, so a loaded machine cannot race a fixed sleep. */
async function poll<T>(accept: () => Promise<T | undefined>, description: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await accept();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

// ------------------------------------------------------------------------ the plain HTTP fixture (no execution host)

type Rig = { backend: BackendServer; origin: string; dbPath: string; gate: Gate; close(): Promise<void> };

/** A real backend over a test-owned SQLite file, whose model answer the test can hold. */
async function start(t: TestContext, dbPath?: string): Promise<Rig> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-subtree-projection-")) : undefined;
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
  const close = async (): Promise<void> => { gate.release(); backend.server.closeAllConnections(); await backend.close(); };
  t.after(close);
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path, gate, close };
}

const post = (origin: string, id: string, action: string, body?: unknown) =>
  fetch(origin + "/api/conversations/" + id + "/" + action, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function create(origin: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(body) });
  return (await read<{ conversation: Row }>(response, 201)).conversation;
}

const submit = (origin: string, id: string, requestId: string, text: string) =>
  post(origin, id, "messages", { protocol: "hepi.v1", type: "conversation.submit", requestId, text });

const subtree = async (origin: string, id: string, body: Record<string, unknown>): Promise<Answer> =>
  await read<Answer>(await post(origin, id, "subtree-control", body), 202);

const readSubtree = async (origin: string, id: string, requestId: string): Promise<Answer> =>
  await read<Answer>(await fetch(origin + "/api/conversations/" + id + "/subtree-control?requestId=" + encodeURIComponent(requestId), { headers }), 200);

const state = async (origin: string, id: string): Promise<State> =>
  await read<State>(await fetch(origin + "/api/conversations/" + id + "/state", { headers }), 200);

const catalogue = async (origin: string): Promise<Row[]> =>
  (await read<{ conversations: Row[] }>(await fetch(origin + "/api/conversations", { headers }), 200)).conversations;

/** The session list's own row for one conversation. */
const rowOf = async (origin: string, id: string): Promise<Row> => {
  const row = (await catalogue(origin)).find(candidate => candidate.id === id);
  assert.ok(row !== undefined, id + " is not in the catalogue");
  return row;
};

/** One child's outcome, by id. */
function outcomeOf(answer: Answer, id: string): Outcome {
  const found = answer.outcomes.find(outcome => outcome.conversationId === id);
  assert.ok(found !== undefined, "no outcome for " + id + " in " + JSON.stringify(answer.outcomes));
  return found;
}

/** Wait until one conversation's catalogue row reaches that status, and return the row. */
async function waitForRow(origin: string, id: string, expected: string): Promise<Row> {
  return await poll(async () => {
    const row = (await catalogue(origin)).find(candidate => candidate.id === id);
    return row !== undefined && row.runStatus.state === expected ? row : undefined;
  }, id + " to read " + expected);
}

/** Wait until one child's projected row reaches that status, and return the answer that carried it. */
async function waitForProjectedStatus(origin: string, rootId: string, requestId: string, childId: string, expected: string): Promise<Answer> {
  return await poll(async () => {
    const answer = await readSubtree(origin, rootId, requestId);
    const session = outcomeOf(answer, childId).session;
    return session !== undefined && session.runStatus.state === expected ? answer : undefined;
  }, "the projected row of " + childId + " to read " + expected);
}

// ------------------------------------------------------------- the gateway-backed delegation fixture (real reports)

type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];
const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast(candidate => candidate.role === "user");
  if (message === undefined) return "";
  const content = message.content as { text?: string } | { type: string; text?: string }[];
  return typeof content === "string" ? content : Array.isArray(content) ? (content.find(block => block.type === "text")?.text ?? "") : content.text ?? "";
};
const hasToolResult = (messages: Transcript, name: string): boolean => messages.some(message => message.role === "toolResult" && message.toolName === name);

type DelegateRig = { readonly origin: string; readonly gate: Gate; close(): Promise<void> };

/** One backend with a real local execution host, one worker definition and a controlled model whose answer is held. */
async function startDelegating(t: TestContext): Promise<DelegateRig> {
  const base = await mkdtemp(join(tmpdir(), "hepi-subtree-projection-delegate-"));
  directories.push(base);
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n");

  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, new GatewayFiles(workspaces, { identity: { user: "operator", home } }));
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.server.address();
  assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };

  const gate = new Gate();
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (transcript): Promise<AssistantMessage> => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    if (lastUserText(messages) === "child work") {
      if (gate.armed) await gate.hold();
      return fauxAssistantMessage("child answer");
    }
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent delegated");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-1" })], { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(base, "hepi.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL, workspaces: [binding] });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const close = (): Promise<void> => { gate.release(); backend.server.closeAllConnections(); return Promise.all([backend.close(), gateway.close()]).then(() => undefined); };
  t.after(close);
  return { origin: "http://127.0.0.1:" + address.port, gate, close };
}

const createBound = async (origin: string): Promise<Row> =>
  (await read<{ conversation: Row }>(await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) }), 201)).conversation;

async function enableSubagents(origin: string, id: string): Promise<void> {
  const response = await fetch(origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(response, 200)).extensions, ["coding-tools", "hepi-subagents"]);
}

/** Delegate one child over the route the Web uses, and return its conversation id. */
async function delegate(origin: string, parentId: string, requestId: string): Promise<string> {
  const created = await read<{ childConversationId: string; created: boolean }>(
    await fetch(origin + "/api/conversations/" + parentId + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "child work", requestId }) }),
    201,
  );
  assert.equal(created.created, true);
  return created.childConversationId;
}

test("each child's answer carries the session list's own row, and a drain refreshes it without rewriting the outcome", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const running = await create(rig.origin, { displayParentId: root.id });
  const idle = await create(rig.origin, { displayParentId: root.id });
  rig.gate.arm();
  assert.equal((await submit(rig.origin, running.id, "run-1", "long task")).status, 202);
  await waitForRow(rig.origin, running.id, "running");

  const answer = await subtree(rig.origin, root.id, { requestId: "proj-1", action: "stop" });
  // The durable half: the live child was reached and still drains, the other took the hold at once.
  assert.equal(outcomeOf(answer, running.id).status, "stopping");
  assert.equal(outcomeOf(answer, idle.id).status, "accepted");
  assert.equal(answer.status, "completed");
  assert.equal(answer.partial, false);

  // The projected half is the row the session list shows. For the child that settled at once that is the whole row,
  // field for field; for the one still draining the facts that could move while its run is in flight are compared.
  assert.deepEqual(outcomeOf(answer, idle.id).session, await rowOf(rig.origin, idle.id), "the same projection answers both reads");
  const liveRow = await rowOf(rig.origin, running.id);
  const projected = outcomeOf(answer, running.id).session;
  assert.ok(projected !== undefined, "the answer states a row for the child that is draining");
  for (const field of ["id", "busy", "messageCount", "displayParentId", "extensions"] as const) {
    assert.deepEqual(projected[field], liveRow[field], "the row's " + field);
  }
  // Held and not yet drained is the row's own state for a live child the stop reached — read from the same projection
  // the running poll uses, not from a status this operation invented for it.
  assert.equal(projected.runStatus.state, "stopping", "the live child reads as still draining");
  assert.equal(projected.busy, true, "and its run really is in flight");
  assert.equal(outcomeOf(answer, running.id).control.state, "held", "with its hold already committed");

  // Releasing the held answer settles the drain: the read refreshes the status and the recorded outcome stays as it was.
  rig.gate.release();
  const settled = await waitForProjectedStatus(rig.origin, root.id, "proj-1", running.id, "held");
  assert.equal(outcomeOf(settled, running.id).status, "stopping", "the outcome is the request's own durable record");
  assert.equal(outcomeOf(settled, idle.id).status, "accepted");
  assert.deepEqual(outcomeOf(settled, running.id).session, await rowOf(rig.origin, running.id), "and the row is still the catalogue's");
  assert.equal(settled.status, "completed");
  assert.equal(settled.partial, false, "a drained child does not turn the request partial after the fact");
  for (const id of [running.id, idle.id]) {
    assert.equal((await state(rig.origin, id)).control.revision, outcomeOf(settled, id).control.revision, id + " was not controlled twice");
  }
  assert.equal((await state(rig.origin, root.id)).control.state, "allowed", "the addressed conversation stays untouched");
});

test("a user's own continue of one child is reconciled by the read, not rewritten in the record", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const child = await create(rig.origin, { displayParentId: root.id });
  const sibling = await create(rig.origin, { displayParentId: root.id });
  const answer = await subtree(rig.origin, root.id, { requestId: "proj-2", action: "stop" });
  assert.deepEqual(answer.outcomes.map(outcome => outcome.status), ["accepted", "accepted"]);
  await waitForRow(rig.origin, child.id, "held");

  // A subtree hold is not a lock nobody can lift: the user resumes one child with its own control route.
  rig.gate.arm();
  assert.equal((await post(rig.origin, child.id, "continue", { requestId: "user-resume-1" })).status, 202);
  assert.equal((await submit(rig.origin, child.id, "user-turn-1", "resumed work")).status, 202);
  await waitForRow(rig.origin, child.id, "running");

  const reconciled = await waitForProjectedStatus(rig.origin, root.id, "proj-2", child.id, "running");
  // The record still states what the request did; the row states what the child is now. Neither overwrites the other.
  assert.deepEqual(reconciled.outcomes.map(outcome => outcome.status), answer.outcomes.map(outcome => outcome.status), "the record is not restated from the present");
  assert.equal(outcomeOf(reconciled, child.id).control.state, "allowed", "the read carries the child's own current control");
  assert.equal(outcomeOf(reconciled, sibling.id).control.state, "held", "and the sibling is still held");
  assert.equal(outcomeOf(reconciled, sibling.id).session?.runStatus.state, "held");
  assert.deepEqual(outcomeOf(reconciled, sibling.id).session, await rowOf(rig.origin, sibling.id));
  rig.gate.release();
  const finished = await waitForProjectedStatus(rig.origin, root.id, "proj-2", child.id, "idle");
  assert.equal(outcomeOf(finished, child.id).status, "accepted", "a child that ran again after the stop is still recorded as stopped by the request");
});

test("a removed child keeps its conflict outcome and states no row, while its sibling's row stays truthful", async (t) => {
  const rig = await start(t);
  const root = await create(rig.origin);
  const hidden = await create(rig.origin, { displayParentId: root.id });
  const leaf = await create(rig.origin, { displayParentId: hidden.id });
  assert.equal((await fetch(rig.origin + "/api/conversations/" + hidden.id, { method: "DELETE", headers })).status, 200);

  const answer = await subtree(rig.origin, root.id, { requestId: "proj-3", action: "stop" });
  assert.deepEqual(answer.scope, [hidden.id, leaf.id], "the capture crossed the hidden parent");
  assert.equal(outcomeOf(answer, hidden.id).status, "conflict");
  assert.equal(outcomeOf(answer, hidden.id).reason, "session_deleted");
  assert.equal(outcomeOf(answer, hidden.id).session, undefined, "a conversation listed nowhere states no row");
  assert.equal(answer.partial, true, "the partial result is visible rather than flattened");
  assert.deepEqual(outcomeOf(answer, leaf.id).session, await rowOf(rig.origin, leaf.id), "the sibling's row is the catalogue's");
  assert.equal(outcomeOf(answer, leaf.id).session?.runStatus.state, "held");

  // A recovery read of the same request answers the same facts, and the removed conversation is still named nowhere.
  const reread = await readSubtree(rig.origin, root.id, "proj-3");
  assert.equal(outcomeOf(reread, hidden.id).session, undefined);
  assert.deepEqual(reread.outcomes.map(outcome => outcome.status), answer.outcomes.map(outcome => outcome.status));
  assert.equal(reread.partial, true);
});

test("an interrupt leaves a queued report queued and still states it as the child's own status", async (t) => {
  const rig = await startDelegating(t);
  const parent = await createBound(rig.origin);
  await enableSubagents(rig.origin, parent.id);
  rig.gate.arm();
  const childId = await delegate(rig.origin, parent.id, "dispatch-1");
  // The delegating conversation is held while the child still works, so the child's report arrives late and stays queued.
  assert.equal((await post(rig.origin, parent.id, "stop", { requestId: "parent-stop" })).status, 202);
  rig.gate.release();

  const queued = await poll(async () => {
    const current = await state(rig.origin, parent.id);
    const report = current.queuedItems.find(item => item.source.kind === "report" && item.source.childConversationId === childId);
    return report === undefined ? undefined : { report, current };
  }, "the child's report to queue in the held parent");
  assert.equal(queued.report.mode, "followUp");
  await waitForRow(rig.origin, childId, "waiting-report");

  const answer = await subtree(rig.origin, parent.id, { requestId: "proj-4", action: "interrupt" });
  assert.deepEqual(answer.scope, [childId], "the delegated child is in the parent's captured subtree");
  const outcome = outcomeOf(answer, childId);
  assert.equal(outcome.status, "already-settled", "the child had no live work left when the request reached it");
  assert.equal(outcome.control.state, "allowed", "an interrupt sets no hold");
  // The child's own status is its waiting report, not `idle` and not a state borrowed from the held parent.
  assert.equal(outcome.session?.runStatus.state, "waiting-report");
  assert.deepEqual(outcome.session, await rowOf(rig.origin, childId), "the row is the catalogue's own");

  const after = await state(rig.origin, parent.id);
  assert.deepEqual(after.queuedItems.map(item => [item.mode, item.source.kind]), queued.current.queuedItems.map(item => [item.mode, item.source.kind]), "the queued report survived the operation");
  assert.deepEqual(after.entries.map(entry => entry.text), queued.current.entries.map(entry => entry.text), "nothing was appended by the control");

  // A recovery read refreshes what is true now and consumes nothing.
  const reread = await readSubtree(rig.origin, parent.id, "proj-4");
  assert.equal(outcomeOf(reread, childId).status, "already-settled", "the outcome stays what the request recorded");
  assert.equal(outcomeOf(reread, childId).session?.runStatus.state, "waiting-report");
  const replay = await subtree(rig.origin, parent.id, { requestId: "proj-4", action: "interrupt" });
  assert.deepEqual(replay.outcomes.map(entry => [entry.conversationId, entry.status]), [[childId, "already-settled"]], "the replay is answered from the capture");
  assert.equal((await state(rig.origin, parent.id)).queuedItems.length, after.queuedItems.length, "and the replay consumed nothing");
  assert.equal((await state(rig.origin, parent.id)).control.revision, after.control.revision, "and the replay recorded no second control change");
});

test("a request a SIGKILL left mid-way reads back with every child's real row and controls nothing until it resumes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-projection-kill-"));
  directories.push(directory);
  const dbPath = join(directory, "subtree.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, "capture"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const captured = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { rootId: string; scope: string[]; outcomes: number };
  assert.equal(captured.scope.length, 2);
  assert.equal(captured.outcomes, 0);

  // A fresh process over the same store, answering through the same routes: the capture is store state, the rows are live.
  const rig = await start(t, dbPath);
  const pending = await readSubtree(rig.origin, captured.rootId, "crash-request");
  assert.equal(pending.status, "pending", "the killed request reads back as pending, not as a finished one");
  assert.deepEqual(pending.scope, captured.scope);
  assert.deepEqual(pending.outcomes.map(outcome => outcome.status), ["pending", "pending"]);
  for (const outcome of pending.outcomes) {
    assert.equal(outcome.control.state, "allowed", outcome.conversationId + " was never controlled");
    assert.deepEqual(outcome.session, await rowOf(rig.origin, outcome.conversationId), "a not-yet-reached child still states its real row");
    assert.equal(outcome.session?.runStatus.state, "idle");
  }

  // The recovery read itself changed nothing.
  for (const id of captured.scope) assert.equal((await state(rig.origin, id)).control.state, "allowed", "the read controlled nothing");

  // The same identity resumes the request, and its answer carries the settled rows.
  const resumed = await subtree(rig.origin, captured.rootId, { requestId: "crash-request", action: "stop" });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.outcomes.map(outcome => outcome.status), ["accepted", "accepted"]);
  for (const outcome of resumed.outcomes) await waitForRow(rig.origin, outcome.conversationId, "held");
  const fresh = await readSubtree(rig.origin, captured.rootId, "crash-request");
  for (const outcome of fresh.outcomes) {
    assert.equal(outcome.status, "accepted");
    assert.deepEqual(outcome.session, await rowOf(rig.origin, outcome.conversationId));
  }

  // A replay of the resumed request records no second control change.
  const replay = await subtree(rig.origin, captured.rootId, { requestId: "crash-request", action: "stop" });
  for (const outcome of replay.outcomes) {
    assert.equal(outcome.status, "accepted");
    assert.equal((await state(rig.origin, outcome.conversationId)).control.revision, 1, outcome.conversationId + " was stopped exactly once");
  }
  await rig.close();
});
