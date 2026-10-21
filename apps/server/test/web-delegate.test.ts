/**
 * Ticket 12 at the backend seam: the Web's own delegation route, and the real status a child tree reads.
 *
 * Every assertion reads a fact a user can read — the HTTP answer, the catalogue row, the child's own transcript, the
 * committed control — and never an internal structure. The child, its anchor and the reporter are the real native tasks
 * the production composition installs, over a real SQLite file and a real local execution host, with a controlled model
 * (ticket 12, spec D02/D10/D12/D15, A01/A03/A12/A15/A18).
 *
 * One controlled model serves every conversation, so each scripted response is chosen from the transcript it answers.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const TOKEN = "web-delegate-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Row = { id: string; createdBy?: string; displayParentId?: string; displayParentDeleted?: boolean; subagentParentConversationId?: string; workspaceId: string | null; extensions?: readonly string[]; runStatus?: { state: string; reason?: string } };
type State = { entries: { id: string; role: string; text: string; message: { isError?: boolean; toolName?: string } }[]; control: { state: string }; busy: boolean };
type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
};
const hasToolResult = (messages: Transcript, name: string): boolean => messages.some((message) => message.role === "toolResult" && message.toolName === name);

type Fixture = { readonly origin: string; readonly backend: BackendServer; readonly faux: ReturnType<typeof fauxProvider>; readonly root: string; close(): Promise<void> };

/** One backend over a real SQLite store, a real local execution host and a controlled model. */
async function startLocal(t: TestContext, dbPath: string, root: string, home: string, script?: (faux: ReturnType<typeof fauxProvider>) => void): Promise<Fixture> {
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, new LocalFilesystem(workspaces, { identity: { user: "operator", home } }));
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  script?.(faux);
  const backend = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL, workspaces: [binding] });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); });
  return { origin: "http://127.0.0.1:" + serverAddress.port, backend, faux, root, close: async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); } };
}

async function read<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

async function createConversation(fixture: Fixture, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local", ...body }) });
  return (await read<{ conversation: Row }>(response, 201)).conversation;
}

const state = async (fixture: Fixture, id: string): Promise<State> => (await read<State>(await fetch(fixture.origin + "/api/conversations/" + id + "/state", { headers }), 200));

const catalogue = async (fixture: Fixture, query = ""): Promise<{ conversations: Row[] }> => (await read<{ conversations: Row[] }>(await fetch(fixture.origin + "/api/conversations" + query, { headers }), 200));

const rowOf = async (fixture: Fixture, id: string): Promise<Row> => (await catalogue(fixture)).conversations.find((row) => row.id === id)!;

/** Enable delegation for one conversation, the way the capability is turned on for it. */
async function enableSubagents(fixture: Fixture, id: string): Promise<void> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(response, 200)).extensions, ["coding-tools", "hepi-subagents"]);
}

/** Poll a conversation until its transcript carries that answer. */
async function waitForAnswer(fixture: Fixture, id: string, expected: string, deadlineMs = 30_000): Promise<State> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const current = await state(fixture, id);
    if (current.entries.some((entry) => entry.role === "assistant" && entry.text === expected)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no answer " + JSON.stringify(expected) + " in conversation " + id);
}

/** Admit one ordinary message and wait for the answer the script produced for it. */
async function say(fixture: Fixture, id: string, requestId: string, text: string, expected: string): Promise<State> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
  await read<unknown>(response, 202);
  return await waitForAnswer(fixture, id, expected);
}

async function writeDefinition(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", name + ".md"), body);
}

/** One controlled model whose answer is chosen from the transcript it answers. */
function respondWith(fixture: Fixture, decide: (messages: Transcript) => ReturnType<typeof fauxAssistantMessage>): void {
  const respond: FauxResponseFactory = async (transcript) => {
    fixture.faux.setResponses([respond]);
    return decide(transcript.messages as unknown as Transcript);
  };
  fixture.faux.setResponses([respond]);
}

/** One fixture with a real worker definition on the workspace host. */
async function fixtureWithWorker(t: TestContext, prefix: string): Promise<{ fixture: Fixture; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "hepi-web-delegate-" + prefix + "-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  return { fixture, root };
}

test("the Web delegate route creates a child over the same seam the model tool uses, and a replay answers it once", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "create");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, (messages) => (lastUserText(messages) === "child work" ? fauxAssistantMessage("child answer") : fauxAssistantMessage("parent idle")));

  const body = { name: "worker", task: "child work", requestId: "attempt-1" };
  const created = await read<{ childConversationId: string; dispatchId: string; created: boolean; conversation: Row }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify(body) }),
    201,
  );
  assert.equal(created.created, true);
  assert.equal(created.dispatchId, "attempt-1");
  // The child is a real conversation with the relations the catalogue reports, and its own status is projected.
  const child = created.conversation;
  assert.equal(child.createdBy, parent.id);
  assert.equal(child.displayParentId, parent.id);
  assert.equal(child.subagentParentConversationId, parent.id);
  assert.equal(child.workspaceId, "local");
  assert.equal(typeof child.runStatus?.state, "string", JSON.stringify(child));
  await waitForAnswer(fixture, created.childConversationId, "child answer");

  // The same request identity answers the child the first attempt created, and creates nothing.
  const replayed = await read<{ childConversationId: string; created: boolean }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify(body) }),
    200,
  );
  assert.equal(replayed.created, false);
  assert.equal(replayed.childConversationId, created.childConversationId);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 1);
});

test("a quick delegate carries no context policy: the definition decides it, and an unknown definition is refused", async (t) => {
  const { fixture, root } = await fixtureWithWorker(t, "policy");
  await writeDefinition(root, "brancher", "---\nname: brancher\ndescription: brancher\ntools:\n  - read\ncontext: fork\n---\n\nbody\n");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, () => fauxAssistantMessage("parent idle"));

  // The definition says `fork` and this conversation has no history, so the delegation is refused for exactly that
  // reason. A request body that also states `context: fresh` changes nothing: if the route read a context strategy
  // from its caller, this delegation would have succeeded, so the refusal is the proof that it does not (spec D11).
  const overridden = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "brancher", task: "branch work", requestId: "attempt-fork", context: "fresh", strategy: "fresh" }) });
  const refusal = await read<{ code: string; error: string }>(overridden, 400);
  assert.equal(refusal.code, "no_source_entry");
  assert.match(refusal.error, /asks for context preparation fork/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 0);

  // The definition's own strategy is what the child records: `fork` against a conversation that has history.
  await say(fixture, parent.id, "policy-turn-1", "prepare some history", "parent idle");
  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "brancher", task: "branch work", requestId: "attempt-fork-2", context: "fresh" }) }),
    201,
  );
  const info = await read<{ relations: { provenance?: { context?: { strategy?: string } } } }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId, { headers }), 200);
  assert.equal(info.relations.provenance?.context?.strategy, "fork", "the definition decides the context strategy, not the request");

  // An unknown definition is refused with the backend's own code and message, and nothing is created.
  const unknown = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "no-such-agent", task: "x", requestId: "attempt-unknown" }) });
  const unknownRefusal = await read<{ code: string; error: string }>(unknown, 404);
  assert.equal(unknownRefusal.code, "unknown_definition");
  assert.match(unknownRefusal.error, /no agent definition named no-such-agent/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 1, "the refused delegation created nothing");
});

test("a definition this build cannot run is refused, and the refusal is the answer rather than a hidden child", async (t) => {
  const { fixture, root } = await fixtureWithWorker(t, "unusable");
  await writeDefinition(root, "broken", "---\nname: broken\ndescription: broken\ntools:\n  - read\nmcp:\n  - github\n---\n\nbody\n");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, () => fauxAssistantMessage("parent idle"));

  const refused = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "broken", task: "x", requestId: "attempt-broken" }) });
  const refusal = await read<{ code: string; error: string }>(refused, 400);
  assert.equal(refusal.code, "unsupported_capability");
  assert.match(refusal.error, /cannot execute MCP servers/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 0);
});

test("the depth and concurrency limits refuse a quick delegate by name, and neither becomes a queue entry", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "limits");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  let hold = true;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  respondWith(fixture, () => fauxAssistantMessage("idle"));
  const faux = fixture.faux;
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    if (lastUserText(messages).startsWith("held work")) {
      if (hold) await gate;
      return fauxAssistantMessage("held answer");
    }
    return fauxAssistantMessage("idle");
  };
  faux.setResponses([respond]);

  // Four children at work: the fifth delegation is refused by the concurrency bound, before anything is created.
  const children: string[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const answer = await read<{ childConversationId: string }>(
      await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "held work " + index, requestId: "attempt-" + index }) }),
      201,
    );
    children.push(answer.childConversationId);
  }
  const refused = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "held work 5", requestId: "attempt-5" }) });
  const refusal = await read<{ code: string; error: string }>(refused, 409);
  assert.equal(refusal.code, "children_exceeded");
  assert.match(refusal.error, /children at work; the limit is 4/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 4, "a refused delegation is not a queued child");

  // A child may not delegate in turn: the depth bound refuses it by name too.
  const nested = await read<{ code: string; error: string }>(
    await fetch(fixture.origin + "/api/conversations/" + children[0] + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "grandchild", requestId: "attempt-nested" }) }),
    409,
  );
  assert.equal(nested.code, "depth_exceeded");
  assert.match(nested.error, /may not delegate; the limit is 1/);

  hold = false;
  release();
  for (const child of children) await waitForAnswer(fixture, child, "held answer");
  // The four finished, so the next delegation is admitted: the limit bounds work, not identities.
  await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "held work 6", requestId: "attempt-6" }) }),
    201,
  );
  hold = false;
  await waitForAnswer(fixture, (await catalogue(fixture, "?createdBy=" + parent.id)).conversations.at(-1)!.id, "held answer");
});

test("a user's stop on the target refuses a quick dispatch to it, and the child keeps its identity", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "stop");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, (messages) => (lastUserText(messages) === "first task" ? fauxAssistantMessage("first answer") : fauxAssistantMessage("idle")));
  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "first task", requestId: "attempt-first" }) }),
    201,
  );
  await waitForAnswer(fixture, created.childConversationId, "first answer");
  const before = await read<{ owner?: unknown; config: unknown }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId, { headers }), 200);

  // The user holds the child through the same route the composer uses.
  const stopped = await fetch(fixture.origin + "/api/conversations/" + created.childConversationId + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "stop-child" }) });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  const control = await read<{ control: { state: string; stopSource?: string } }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId + "/control", { headers }), 200);
  assert.equal(control.control.state, "held");
  assert.equal(control.control.stopSource, "user");

  // A dispatch into the held child is refused, and it wrote nothing: the child has no second task and no dispatch record.
  const refused = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "second task", conversationId: created.childConversationId, requestId: "attempt-second" }) });
  const refusal = await read<{ code: string; error: string }>(refused, 409);
  assert.equal(refusal.code, "user_stopped");
  assert.match(refusal.error, /user stop/i);
  const childState = await state(fixture, created.childConversationId);
  assert.equal(childState.entries.filter((entry) => entry.role === "user").length, 1, "a refused dispatch admitted no second task");
  const after = await read<{ owner?: unknown; config: unknown }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId, { headers }), 200);
  assert.deepEqual(after.owner, before.owner, "the child keeps its owner");
  assert.deepEqual(after.config, before.config, "the child keeps its configuration");
});

test("the catalogue states each conversation's own status: held, running and idle are told apart, and a parent being busy is not a child's status", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "status");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const faux = fixture.faux;
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    if (lastUserText(messages) === "slow work") { await gate; return fauxAssistantMessage("slow answer"); }
    if (lastUserText(messages) === "second work") return fauxAssistantMessage("second answer");
    return fauxAssistantMessage("idle");
  };
  faux.setResponses([respond]);

  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "slow work", requestId: "attempt-slow" }) }),
    201,
  );
  // The child is genuinely working, and its own status says so.
  await waitFor(async () => (await rowOf(fixture, created.childConversationId)).runStatus?.state === "running", "the child to be running");
  assert.equal((await rowOf(fixture, created.childConversationId)).runStatus?.state, "running");
  // The parent is idle: the child's status is its own and is not read off the parent.
  assert.equal((await rowOf(fixture, parent.id)).runStatus?.state, "idle");

  // The user holds the child while it works: the status says stopping, not running and not completed.
  const stopped = await fetch(fixture.origin + "/api/conversations/" + created.childConversationId + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "stop-slow" }) });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  const held = (await rowOf(fixture, created.childConversationId)).runStatus;
  assert.equal(held?.state, "stopping", JSON.stringify(held));

  // Once it has drained, the same hold reads `held` rather than `stopping`, and the child's own control agrees.
  release();
  await waitFor(async () => (await rowOf(fixture, created.childConversationId)).runStatus?.state === "held", "the child to settle into held");
  assert.equal((await rowOf(fixture, created.childConversationId)).runStatus?.state, "held");
  assert.equal((await state(fixture, created.childConversationId)).control.state, "held");

  // The user continues it with one more task, and the child works and then settles: its own status follows its own run
  // while its earlier history stays readable (spec D15, A01).
  await fetch(fixture.origin + "/api/conversations/" + created.childConversationId + "/continue", { method: "POST", headers, body: JSON.stringify({ requestId: "continue-slow", text: "second work" }) });
  await waitForAnswer(fixture, created.childConversationId, "second answer");
  await waitFor(async () => (await rowOf(fixture, created.childConversationId)).runStatus?.state === "idle", "the child to become idle");
  assert.equal((await rowOf(fixture, created.childConversationId)).runStatus?.state, "idle");
  const childState = await state(fixture, created.childConversationId);
  assert.deepEqual(childState.entries.filter((entry) => entry.role === "user").map((entry) => entry.text), ["slow work", "second work"], "the held child kept its earlier task");
  assert.equal(childState.control.state, "allowed");
});

test("the catalogue states a child's own selected extensions, which is what the delegate entry follows", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "capability");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, (messages) => (lastUserText(messages) === "child work" ? fauxAssistantMessage("child answer") : fauxAssistantMessage("idle")));
  assert.deepEqual((await rowOf(fixture, parent.id)).extensions, ["coding-tools", "hepi-subagents"]);

  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "child work", requestId: "attempt-child" }) }),
    201,
  );
  // A child does not delegate in turn, so its own selection does not carry the capability: the entry follows that fact.
  const child = await rowOf(fixture, created.childConversationId);
  assert.equal(child.extensions?.includes("hepi-subagents"), false, JSON.stringify(child.extensions));

  // Turning the capability off for the parent removes it from its own selection, while the child's history and
  // relations stay readable and the generic control keeps working (spec D15, A01).
  const patched = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(patched, 200)).extensions, ["coding-tools"]);
  assert.equal((await rowOf(fixture, parent.id)).extensions?.includes("hepi-subagents"), false);
  assert.equal((await rowOf(fixture, created.childConversationId)).createdBy, parent.id, "the relation survives the capability being turned off");
  const readBack = await read<{ relations: { createdBy?: string } }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId, { headers }), 200);
  assert.equal(readBack.relations.createdBy, parent.id);
  await waitForAnswer(fixture, created.childConversationId, "child answer");
});

/**
 * The Settings panel and the quick create are one document and one validation interface.
 *
 * A definition is saved through `PUT /api/agent-definitions` and read by the quick create through
 * `GET /api/agent-definitions`; the delegation route resolves the same file on the same host. So a definition Settings
 * refused cannot be delegated to, and a definition Settings saved is the one the quick create offers — this asserts
 * that through the product's own routes, on a real host, rather than by comparing two code paths.
 */
test("a definition Settings refused cannot be delegated to, and one it saved is what the quick create reads", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "shared-validation");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, () => fauxAssistantMessage("idle"));
  const definitions = "/api/agent-definitions?hostId=workstation&workspaceId=local";

  // A tool this build does not install is refused by the same route the Settings panel saves through, and the refusal
  // names the field.
  const refused = await fetch(fixture.origin + "/api/agent-definitions", { method: "PUT", headers, body: JSON.stringify({ hostId: "workstation", workspaceId: "local", scope: "project", name: "broken", fields: { name: "broken", description: "broken", tools: ["read", "grep"] } }) });
  const refusal = await read<{ code: string; field: string }>(refused, 400);
  assert.equal(refusal.code, "unknown_tool");
  assert.equal(refusal.field, "tools");
  // Nothing was written, so the quick create cannot offer it and the delegation cannot resolve it.
  const listed = await read<{ definitions: { name: string }[] }>(await fetch(fixture.origin + definitions, { headers }), 200);
  assert.equal(listed.definitions.some((definition) => definition.name === "broken"), false, JSON.stringify(listed.definitions));
  const unknown = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "broken", task: "x", requestId: "attempt-broken" }) });
  assert.equal(unknown.status, 404);
  assert.equal((await read<{ code: string }>(unknown, 404)).code, "unknown_definition");

  // A definition the same route accepts is offered by the list the quick create reads, and delegating to it really runs
  // the file the user saved.
  const saved = await read<{ definition: { name: string; tools: string[] } }>(
    await fetch(fixture.origin + "/api/agent-definitions", { method: "PUT", headers, body: JSON.stringify({ hostId: "workstation", workspaceId: "local", scope: "project", name: "saved", fields: { name: "saved", description: "Saved through Settings", tools: ["read"], instructions: "Answer briefly." } }) }),
    200,
  );
  assert.equal(saved.definition.name, "saved");
  const after = await read<{ definitions: { name: string; scope: string; tools: string[] }[] }>(await fetch(fixture.origin + definitions, { headers }), 200);
  const offered = after.definitions.find((definition) => definition.name === "saved");
  assert.ok(offered !== undefined, JSON.stringify(after.definitions));
  assert.deepEqual(offered.tools, ["read"]);
  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "saved", task: "child work", requestId: "attempt-saved" }) }),
    201,
  );
  const childInfo = await read<{ relations: { provenance?: { definition?: { name?: string } } } }>(await fetch(fixture.origin + "/api/conversations/" + created.childConversationId, { headers }), 200);
  assert.equal(childInfo.relations.provenance?.definition?.name, "saved", "the child runs the definition Settings saved");
});

/**
 * A whole family's status rides the one catalogue read, not a read per row.
 *
 * The sidebar polls one list. If a child's status needed its own request — or, worse, its own stream — a conversation
 * with four children at work would cost four connections, and a list of twenty would cost twenty. The ticket forbids a
 * permanent per-catalogue-item SSE, so the observable property is asserted directly: **one** list request answers every
 * child's status, and the client makes no second call to learn it.
 */
test("one catalogue read answers every child's status, so no row needs its own read or stream", async (t) => {
  const { fixture } = await fixtureWithWorker(t, "one-read");
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const faux = fixture.faux;
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    if (lastUserText(messages).startsWith("work ")) { await gate; return fauxAssistantMessage("done " + lastUserText(messages)); }
    return fauxAssistantMessage("idle");
  };
  faux.setResponses([respond]);
  const children: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const created = await read<{ childConversationId: string }>(
      await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "work " + index, requestId: "attempt-" + index }) }),
      201,
    );
    children.push(created.childConversationId);
  }
  await waitFor(async () => (await rowOf(fixture, children[0]!)).runStatus?.state === "running", "the children to be working");

  // One request, and every child's own status is in it.
  const listed = await catalogue(fixture);
  const rows = listed.conversations.filter((row) => children.includes(row.id));
  assert.equal(rows.length, 3, JSON.stringify(listed.conversations.map((row) => row.id)));
  assert.deepEqual(rows.map((row) => row.runStatus?.state), ["running", "running", "running"], "every child states its own status in the one list read");
  // The parent is idle in the same answer, which is what makes the projection each row's own rather than the list's.
  assert.equal(listed.conversations.find((row) => row.id === parent.id)?.runStatus?.state, "idle");

  release();
  for (const child of children) await waitForAnswer(fixture, child, "done work " + (children.indexOf(child) + 1));
});

/** Poll a read until a predicate holds, so a child runs on its own schedule. */
async function waitFor(accept: () => Promise<boolean>, description: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await accept()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for " + description);
}
