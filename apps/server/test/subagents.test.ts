/**
 * Ticket 06 observable behavior, driven through real model tool calls over a real backend, a real local or SSH
 * execution host and a controlled model.
 *
 * Every assertion reads a fact a user or the parent model can read — the catalogue row, the by-id read, the child own
 * transcript, the HTTP routes — and never a helper internal structure. The child is a real durable conversation with a
 * real anchor task; nothing here substitutes a fake child record for one (ticket 06, spec A02/A03/A13/A15/A19).
 *
 * One controlled model serves every conversation in a fixture, so each scripted response is chosen from the transcript
 * it answers rather than from a fixed queue: a child's task text, a parent's tool result, and the delegating turn are
 * distinguishable, and two conversations running at once cannot consume each other's script.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { GatewayRpcServer, LocalGateway, SshGateway } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { pythonSshRunner } from "../../../packages/gateway/test/ssh-transport.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { DispatchDoc, ReportDoc, SUBAGENT_ANCHOR_TASK } from "../src/subagents/host.ts";
import { openCrashHarness, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../../../packages/gateway/src/workspaces.ts";

const TOKEN = "subagents-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const crashChild = fileURLToPath(new URL("./subagents-crash-child.ts", import.meta.url));

type Row = { id: string; createdBy?: string; displayParentId?: string; displayParentDeleted?: boolean; parentConversationId?: string; subagentParentConversationId?: string; workspaceId: string | null };
type State = { extensions: string[]; toolNames: string[]; busy: boolean; control: { state: string }; queuedMessages: { steering: unknown[]; followUp: unknown[] }; entries: { id: string; role: string; text: string; message: { isError?: boolean; toolName?: string } }[] };
type Info = { conversation: Row; relations: { createdBy?: string; displayParentId?: string; provenance?: { origin?: string; definition?: { hostId: string; scope: string; name: string }; context?: { strategy: string } } }; displayParentDeleted?: boolean; owner?: { conversationId: string; taskId: string }; config: { model: { provider: string; modelId: string } | null; tools: string[]; extensions: string[]; thinkingLevel: string; instructions?: string; cwd?: string } };

type Fixture = {
  readonly origin: string;
  readonly backend: BackendServer;
  readonly dbPath: string;
  readonly root: string;
  readonly home: string;
  readonly faux: ReturnType<typeof fauxProvider>;
  close(): Promise<void>;
};

/** A definition document on the execution host, written where the host itself keeps project definitions. */
async function writeDefinition(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", name + ".md"), body);
}

/** The user text of a transcript, which is what one scripted response is chosen from. */
function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
}

/** One answer read once: the status asserted against its own text, then that text parsed. */
async function read<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

/**
 * A backend over a real SQLite store, a real local execution host and a controlled model.
 *
 * `script` runs before the backend opens, which is what lets a recovery test answer work the backend resumes at boot:
 * a script installed afterwards would arrive after the recovered run already asked the provider.
 */
async function startLocal(t: { after(fn: () => unknown): void }, dbPath: string, root: string, home: string, script?: (faux: ReturnType<typeof fauxProvider>) => void): Promise<Fixture> {
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, new GatewayFiles(workspaces, { identity: { user: "operator", home } }));
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  script?.(faux);
  // This fixture supplies its own catalog, so it also states the model a conversation starts with: production
  // registers no scripted provider and manufactures no default.
  const backend = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL, workspaces: [binding] });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); });
  return {
    origin: "http://127.0.0.1:" + serverAddress.port,
    backend,
    dbPath,
    root,
    home,
    faux,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); },
  };
}

async function createConversation(fixture: Fixture, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local", ...body }) });
  return (await read<{ conversation: Row }>(response, 201)).conversation;
}

/** Enable delegation for one conversation, the way a user turns the capability on. */
async function enableSubagents(fixture: Fixture, id: string, extensions: readonly string[] = ["coding-tools", "hepi-subagents"]): Promise<void> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions }) });
  assert.deepEqual((await read<{ extensions: string[] }>(response, 200)).extensions, extensions);
}

const state = async (fixture: Fixture, id: string): Promise<State> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as State;
};

const info = async (fixture: Fixture, id: string): Promise<Info> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id, { headers });
  assert.equal(response.status, 200);
  return await response.json() as Info;
};

/** The durable submission one stable request id was admitted as, read from the recovery route a client uses. */
const childSubmission = async (fixture: Fixture, id: string, requestId: string): Promise<{ status: string; entryId?: string } | null> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent(requestId), { headers });
  assert.equal(response.status, 200);
  return (await response.json() as { submission: { status: string; entryId?: string } | null }).submission;
};

const catalogue = async (fixture: Fixture, query = ""): Promise<{ conversations: Row[] }> => {
  const response = await fetch(fixture.origin + "/api/conversations" + query, { headers });
  assert.equal(response.status, 200);
  return await response.json() as { conversations: Row[] };
};

/** Admit one message and wait until the transcript carries the assistant answer the script produced. */
async function turn(fixture: Fixture, id: string, requestId: string, expected: string, deadlineMs = 30_000): Promise<State> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "delegate this" }) });
  await read<unknown>(response, 202);
  return await waitForAnswer(fixture, id, expected, deadlineMs);
}

/** Admit one message carrying its own text, so a script can tell two parent turns apart. */
async function say(fixture: Fixture, id: string, requestId: string, text: string, expected: string, deadlineMs = 30_000): Promise<State> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
  await read<unknown>(response, 202);
  return await waitForAnswer(fixture, id, expected, deadlineMs);
}

/** Poll one conversation until its transcript carries that answer; a child runs on its own schedule. */
async function waitForAnswer(fixture: Fixture, id: string, expected: string, deadlineMs = 30_000): Promise<State> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const current = await state(fixture, id);
    if (current.entries.some((entry) => entry.role === "assistant" && entry.text === expected)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no answer " + JSON.stringify(expected) + " in conversation " + id);
}

/** The child conversation one delegating conversation created, read from the catalogue the browser reads. */
async function childOf(fixture: Fixture, parentId: string): Promise<Row> {
  const listed = await catalogue(fixture, "?createdBy=" + parentId);
  assert.equal(listed.conversations.length, 1, JSON.stringify(listed.conversations));
  return listed.conversations[0]!;
}

/** The facts one crash stage states before it dies, as its own last line of output. */
type CrashFacts = { mode: "commit" | "receipt"; parentId: string; childId: string; callId: string; checkpoint: string; admissionDurable: boolean; toolResultCommitted: boolean; anchorTaskId?: string; submissionId?: string; submissionStatus?: string };

/** One conversation's committed entries, read from the recovered store rather than from a running backend. */
const entriesOf = (crash: CrashHarness, id: string): Promise<readonly EntryRecord[]> =>
  crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "ascending" }, 200, undefined), BACKGROUND_CONTEXT).then((page) => page.items);

/** How many tool results of one call the delegating conversation had committed, which is the receipt question. */
const parentToolResults = async (crash: CrashHarness, parentId: string): Promise<number> =>
  (await entriesOf(crash, parentId)).filter((entry) => entry.kind === "pi.tool-result").length;

/** Poll the recovered store until one conversation's committed entries satisfy a predicate. */
async function waitForEntries(crash: CrashHarness, id: string, accept: (entries: readonly EntryRecord[]) => boolean, description: string, deadlineMs = 30_000): Promise<readonly EntryRecord[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const entries = await entriesOf(crash, id);
    if (accept(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no " + description + " in conversation " + id);
}

const waitForChildAnswer = (crash: CrashHarness, id: string, expected: string): Promise<readonly EntryRecord[]> =>
  waitForEntries(crash, id, (entries) => entries.some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? "").includes(expected)), "answer " + expected);

const waitForParentAnswer = (crash: CrashHarness, id: string, expected: string): Promise<readonly EntryRecord[]> =>
  waitForEntries(crash, id, (entries) => entries.some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? "").includes(expected)), "answer " + expected);

/** The message of one scripted response: the transcript it answers decides which one it is. */
type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

/** Whether this transcript already carries a result of one tool call, which tells one round from the next. */
function hasToolResult(messages: Transcript, name: string): boolean {
  return messages.some((message) => message.role === "toolResult" && message.toolName === name);
}

/**
 * Whether this transcript already carries a result of one tool call that **names a particular conversation**.
 *
 * A conversation can be addressed more than once in one test — a refused dispatch, then a successful one — so a
 * transcript that only counted results of a tool name would answer the second turn from the first one's result and the
 * call under test would never run.
 */
function hasNamedResult(messages: Transcript, name: string, conversationId: string): boolean {
  return messages.some((message) => message.role === "toolResult" && message.toolName === name && JSON.stringify(message.content ?? "").includes(conversationId));
}

/**
 * Install one scripted response that re-registers itself, so every conversation of the fixture keeps being answered
 * and each answer is chosen from the transcript it answers rather than from a fixed queue: a child, a parent and a
 * nested conversation running at once cannot consume each other's script.
 */
function respondWith(fixture: Fixture, decide: (messages: Transcript) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>): void {
  const respond: FauxResponseFactory = async (transcript) => {
    fixture.faux.setResponses([respond]);
    return decide(transcript.messages as unknown as Transcript);
  };
  fixture.faux.setResponses([respond]);
}

test("a model tool call creates a durable child, the parent keeps working, and get/read answer from the core state", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-happy-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "researcher", "---\nname: researcher\ndescription: research\nmodel: faux/faux-1\nthinking: low\ntools:\n  - read\n  - bash\ncontext: fresh\n---\n\nYou research one question and answer it briefly.\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  let phase: "spawn" | "read" = "spawn";
  let childId = "";
  respondWith(fixture, (messages) => {
    // The child is answered from its own task text, whatever else is running.
    if (lastUserText(messages) === "summarize the ticket") return fauxAssistantMessage("child answer: summarized");
    if (phase === "spawn") {
      if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent done, child runs on its own");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "researcher", task: "summarize the ticket" })], { stopReason: "toolUse" });
    }
    if (hasToolResult(messages, "agent_read")) return fauxAssistantMessage("read the child");
    if (hasToolResult(messages, "agent_get")) return fauxAssistantMessage([fauxToolCall("agent_read", { conversationId: childId, limit: 20 })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxToolCall("agent_get", { conversationId: childId })], { stopReason: "toolUse" });
  });

  // The parent delegates and keeps going: one tool call, one answer, and the child exists before the tool returned.
  const parentState = await turn(fixture, parent.id, "parent-turn-1", "parent done, child runs on its own");
  const spawnResult = parentState.entries.find((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.notEqual(spawnResult?.message.isError, true, spawnResult?.text);
  assert.match(spawnResult?.text ?? "", /runs on its own/);

  // The child is a real conversation: its creator, display parent and native owner are three separate edges.
  const child = await childOf(fixture, parent.id);
  childId = child.id;
  assert.equal(child.createdBy, parent.id);
  assert.equal(child.displayParentId, parent.id);
  assert.equal(child.subagentParentConversationId, parent.id);
  assert.equal(child.workspaceId, "local");
  const childInfo = await info(fixture, child.id);
  assert.equal(childInfo.owner?.conversationId, parent.id, "the anchor task belongs to the delegating conversation");
  assert.deepEqual(childInfo.relations.provenance?.definition, { hostId: "workstation", scope: "project", name: "researcher" });
  assert.equal(childInfo.relations.provenance?.context?.strategy, "fresh");
  // The configuration is the definition own snapshot, with no part of the parent agent left in it.
  assert.deepEqual(childInfo.config.model, { provider: "faux", modelId: "faux-1" });
  assert.equal(childInfo.config.thinkingLevel, "low");
  assert.deepEqual([...childInfo.config.tools].sort(), ["bash", "read"]);
  assert.deepEqual(childInfo.config.extensions, ["coding-tools"]);
  assert.match(childInfo.config.instructions ?? "", /research one question/);
  assert.equal(childInfo.config.cwd, "/");
  // The child does not delegate in turn: the extension is not among the ones it selects.
  assert.deepEqual((await state(fixture, child.id)).extensions, ["coding-tools"]);

  // The child really executed the task the parent gave it, with its own model.
  const childState = await waitForAnswer(fixture, child.id, "child answer: summarized");
  assert.equal(childState.entries.some((entry) => entry.role === "user" && entry.text.includes("summarize the ticket")), true, JSON.stringify(childState.entries));

  // agent_get and agent_read are the core seams: a second turn asks for the child identity and its raw history.
  phase = "read";
  const readState = await turn(fixture, parent.id, "parent-turn-2", "read the child");
  const got = readState.entries.find((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_get");
  assert.notEqual(got?.message.isError, true, got?.text);
  assert.match(got?.text ?? "", new RegExp(child.id));
  assert.match(got?.text ?? "", /researcher/);
  const read = readState.entries.find((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_read");
  assert.notEqual(read?.message.isError, true, read?.text);
  assert.match(read?.text ?? "", /summarize the ticket/);

  // The HTTP read route answers the same history from the same operation.
  const http = await fetch(fixture.origin + "/api/conversations/" + child.id + "/read?limit=50", { headers });
  assert.equal(http.status, 200, await http.text());
});

test("an unknown definition, an unavailable tool, an unknown context strategy and a model override are all refused before anything is created", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-refusals-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "fine", "---\nname: fine\ndescription: fine\ntools:\n  - read\n---\n\nbody\n");
  await writeDefinition(root, "needs-grep", "---\nname: needs-grep\ndescription: needs grep\ntools:\n  - grep\n---\n\nbody\n");
  // A strategy this build does not have. `fresh`, `fork` and `compact` are all executable now — ticket 10 wires the
  // last two through the creation seam — so the refused case is a name outside the vocabulary rather than a real one.
  await writeDefinition(root, "needs-context", "---\nname: needs-context\ndescription: needs context\ncontext: rewind\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  const before = (await catalogue(fixture)).conversations.length;

  respondWith(fixture, (messages) => {
    if (messages.filter((message) => message.role === "toolResult").length >= 4) return fauxAssistantMessage("done");
    return fauxAssistantMessage([
      fauxToolCall("agent_spawn", { name: "no-such-definition", task: "x" }),
      fauxToolCall("agent_spawn", { name: "needs-grep", task: "x" }),
      fauxToolCall("agent_spawn", { name: "needs-context", task: "x" }),
      // A model cannot hand the tool host configuration: a policy, plugin or source override is not an argument at all.
      fauxToolCall("agent_spawn", { name: "fine", task: "x", model: "other/model", context: "fork" }),
    ], { stopReason: "toolUse" });
  });
  const settled = await turn(fixture, parent.id, "parent-refusals", "done");
  const results = settled.entries.filter((entry) => entry.role === "toolResult").map((entry) => ({ text: entry.text, isError: entry.message.isError === true }));
  assert.equal(results.length, 4, JSON.stringify(results));
  // The round's results are not guaranteed in call order, so each expected refusal is looked for by its own reason.
  const refusalOf = (pattern: RegExp): { text: string; isError: boolean } => {
    const found = results.find((result) => pattern.test(result.text));
    assert.ok(found !== undefined, "no refusal matched " + String(pattern) + " in " + JSON.stringify(results));
    return found;
  };
  assert.equal(refusalOf(/no agent definition named no-such-definition/).isError, true);
  // The definition vocabulary names grep, but the installed coding tools do not offer it: either the definition layer
  // refuses the name or this seam refuses the missing tool, and both answers name it.
  assert.equal(refusalOf(/grep/).isError, true);
  assert.equal(refusalOf(/context must be one of/).isError, true);
  assert.equal(refusalOf(/host configuration the model does not set/).isError, true);
  // A refused spawn created nothing: no child, no anchor, no submission.
  assert.equal((await catalogue(fixture)).conversations.length, before);
});

test("a child does not delegate in turn, and a conversation one level down is refused by the depth limit", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-depth-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, (messages) => {
    if (lastUserText(messages) === "child work") return fauxAssistantMessage("child answer");
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("delegation settled");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" })], { stopReason: "toolUse" });
  });
  await turn(fixture, parent.id, "depth-turn-1", "delegation settled");
  const child = await childOf(fixture, parent.id);
  // The child was created without the delegation extension, so its model is never offered agent_spawn at all.
  assert.equal((await state(fixture, child.id)).toolNames.includes("agent_spawn"), false);
  await waitForAnswer(fixture, child.id, "child answer");

  // A conversation that is itself displayed beneath another one is at depth 1, and the host limit is 1.
  const nested = await createConversation(fixture, { createdBy: parent.id, displayParentId: child.id });
  await enableSubagents(fixture, nested.id);
  const settled = await turn(fixture, nested.id, "depth-turn-2", "delegation settled");
  const refused = settled.entries.find((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.equal(refused?.message.isError, true, refused?.text);
  assert.match(refused?.text ?? "", /may not delegate; the limit is 1/);
  assert.equal((await catalogue(fixture, "?createdBy=" + nested.id)).conversations.length, 0);
});

test("a user stop of the delegating conversation leaves the child and its anchor running", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-stop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "slow", "---\nname: slow\ndescription: slow\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  respondWith(fixture, (messages) => {
    if (lastUserText(messages) === "long child work") return fauxAssistantMessage("child answer");
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent done");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "slow", task: "long child work" })], { stopReason: "toolUse" });
  });
  await turn(fixture, parent.id, "stop-turn-1", "parent done");
  const child = await childOf(fixture, parent.id);

  const stopped = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "stop-parent" }) });
  assert.equal((await read<{ control: { state: string } }>(stopped, 202)).control.state, "held");
  // The child is beneath a background anchor, so the parent stop never reaches it: it answers on its own.
  const childState = await waitForAnswer(fixture, child.id, "child answer");
  assert.equal(childState.entries.some((entry) => entry.role === "assistant" && entry.text === "child answer"), true);
  // The child keeps its identity and its owner after the parent was held.
  const after = await info(fixture, child.id);
  assert.equal(after.owner?.conversationId, parent.id);
  assert.equal(after.relations.createdBy, parent.id);
  // The parent is still held: the child's result did not resume it.
  const control = await read<{ control: { state: string } }>(await fetch(fixture.origin + "/api/conversations/" + parent.id + "/control", { headers }), 200);
  assert.equal(control.control.state, "held");
});

test("the definition is resolved on the conversation SSH execution host and the child inherits that binding", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-ssh-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remoteHome = join(base, "remote-home");
  const remoteRoot = join(base, "remote-repo", "app");
  await mkdir(join(remoteHome, ".pi", "agent", "agents"), { recursive: true });
  await mkdir(join(remoteRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(remoteRoot, ".pi", "agents", "remote-only.md"), "---\nname: remote-only\ndescription: remote\ntools:\n  - read\n---\n\nremote body\n");
  const { runner } = pythonSshRunner({ user: "remote-operator", home: remoteHome });
  const profiles = [{ id: "prod", host: "build.example", remoteRoot }];
  const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const ssh = new GatewayRpcServer(new SshGateway({ id: "ssh-prod", token: "gateway-token", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner }), undefined, new SshFilesystem({ id: "ssh-prod", profiles, workspaces: sshWorkspaces, runner }));
  await new Promise<void>((resolve) => ssh.server.listen(0, "127.0.0.1", resolve));
  const sshAddress = ssh.server.address();
  assert.ok(sshAddress !== null && typeof sshAddress === "object");
  t.after(async () => { ssh.server.closeAllConnections(); await ssh.close(); });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const dbPath = join(base, "hepi.sqlite");
  const backend = await createBackendServer({
    dbPath,
    authToken: TOKEN,
    models,
    defaultModel: SERVER_MODEL,
    // The SSH gateway seeds one workspace per profile, named `remote-<profileId>`; that is the id a conversation binds.
    workspaces: [{ id: "remote-prod", gatewayId: "ssh-prod", gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "gateway-token" }],
    gateways: [{ gatewayId: "ssh-prod", gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "gateway-token" }],
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); });
  const fixture: Fixture = { origin: "http://127.0.0.1:" + serverAddress.port, backend, dbPath, root: remoteRoot, home: remoteHome, faux, close: async () => { backend.server.closeAllConnections(); await backend.close(); } };

  const response = await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "remote-prod" }) });
  const created = (await read<{ conversation: Row }>(response, 201)).conversation;
  await enableSubagents(fixture, created.id);
  respondWith(fixture, (messages) => {
    if (lastUserText(messages) === "remote work") return fauxAssistantMessage("remote child answer");
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent done");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "remote-only", task: "remote work" })], { stopReason: "toolUse" });
  });
  await turn(fixture, created.id, "ssh-turn-1", "parent done");
  const child = await childOf(fixture, created.id);
  assert.equal(child.workspaceId, "remote-prod");
  const childInfo = await info(fixture, child.id);
  // The definition was read on the SSH host and the provenance names it; nothing fell back to this machine.
  assert.deepEqual(childInfo.relations.provenance?.definition, { hostId: "ssh-prod", scope: "project", name: "remote-only" });
  const answered = await waitForAnswer(fixture, child.id, "remote child answer");
  assert.equal(answered.entries.some((entry) => entry.role === "assistant" && entry.text === "remote child answer"), true);
});

/**
 * One recovery window, driven end to end. A real child process composes the real backend pieces through public seams,
 * delegates once through a real model tool call, and SIGKILLs itself at a **named** checkpoint that the fixture pins at
 * the seam which really separates the two states:
 *
 * - `commit`: inside the commit publication that carries the child conversation. The child, its anchor task and the
 *   dispatch record are durable; the anchor's `admit` phase is a later microtask, so the child's initial admission is
 *   not. The stage reads that fact back from the store before it dies.
 * - `receipt`: inside the `agent_spawn` wrapper, after the child's admission is durable and before the tool returns.
 *   The `pi.tool` task that called the tool is still running, so no tool result for the call is committed.
 *
 * Holding the child's model request open pins neither window by itself; it only keeps a child *answer* out of both. Each
 * stage prints the facts it read at its own kill point, and this process reopens the same SQLite **paused**, reads the
 * recovered native state before anything is scheduled, and only then resumes.
 */
for (const mode of ["commit", "receipt"] as const) {
  test("a real SIGKILL in the " + mode + " window keeps one child, one anchor and one admission, and the interrupted call replays once", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "hepi-subagents-crash-" + mode + "-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "workspace");
    const home = join(base, "home");
    await mkdir(root, { recursive: true });
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
    const dbPath = join(base, "hepi.sqlite");
    const killed = spawnSync(process.execPath, [crashChild, dbPath, root, home, mode], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
    const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as CrashFacts;
    assert.equal(facts.mode, mode);
    // The stage's own reading of its kill point, not an inference: the window is only claimed when it was really held.
    assert.equal(facts.toolResultCommitted, false, "no tool result existed at the kill point");
    assert.equal(facts.admissionDurable, mode === "receipt", "the child's initial admission is durable exactly in the receipt window");

    // Reopen the same SQLite paused, so the recovered state is read before any task is scheduled.
    const crash = await openCrashHarness(dbPath, {
      root,
      home,
      startPaused: true,
      script: (faux) => {
        const respond: FauxResponseFactory = async (transcript) => {
          faux.setResponses([respond]);
          const messages = transcript.messages as unknown as Transcript;
          return lastUserText(messages) === "crash work" ? fauxAssistantMessage("child answer") : fauxAssistantMessage("parent done");
        };
        faux.setResponses([respond]);
      },
    });
    t.after(() => crash.close());

    // The recovered facts, read before scheduling resumes. Exactly one child owns to the parent's anchor, and the
    // recovered work is the same delegation the stage created: same child, same dispatch record, same call identity.
    const children = await crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(facts.parentId) as ConversationId }, 100, undefined), BACKGROUND_CONTEXT);
    assert.equal(children.items.length, 1, JSON.stringify(children.items));
    assert.equal(String(children.items[0]!.id), facts.childId);
    const dispatch = await crash.harness.harness.snapshot(DispatchDoc, Number(facts.parentId) as ConversationId, facts.parentId + ":" + facts.callId, BACKGROUND_CONTEXT);
    assert.equal(dispatch?.childConversationId, facts.childId);
    assert.equal(dispatch?.submissionRequestId, facts.parentId + ":" + facts.callId);
    const admission = await crash.harness.harness.commit((tx) => tx.submissionByRequest(Number(facts.childId) as ConversationId, facts.parentId + ":" + facts.callId), BACKGROUND_CONTEXT);
    assert.equal(admission !== undefined, mode === "receipt", "the admission survived exactly where it was durable");
    // The anchor is live either way: it has not admitted the child yet in the commit window, and it is idle afterwards.
    const recovered = await crash.harness.harness.inspect(BACKGROUND_CONTEXT);
    const anchors = recovered.tasks.filter((task) => task.record.kind === SUBAGENT_ANCHOR_TASK);
    assert.equal(anchors.length, 1, JSON.stringify(recovered.tasks.map((task) => task.record.kind)));
    // The anchor is live and its definition resolves after the reopen: a blocked anchor would mean the extension's task
    // registration did not survive, which is what makes the child's admission unrecoverable.
    assert.notEqual(anchors[0]!.state.kind, "blocked", JSON.stringify(anchors[0]!.state));
    // The interrupted call is live work, not a settled receipt: the calling task had committed its intent and nothing
    // else, which is what makes the rerun reachable.
    const toolTasks = recovered.tasks.filter((task) => task.record.kind === "pi.tool");
    assert.equal(toolTasks.length, 1, JSON.stringify(recovered.tasks.map((task) => task.record.kind)));
    assert.equal(await parentToolResults(crash, facts.parentId), 0, "the parent had no agent_spawn result at the kill point");

    crash.harness.harness.resume();

    // The child runs its one task and is answered once, whether its admission survived or the anchor made it now.
    const answered = await waitForChildAnswer(crash, facts.childId, "child answer");
    assert.equal(answered.filter((entry) => entry.kind === "pi.user").length, 1, JSON.stringify(answered.map((entry) => entry.kind)));
    assert.equal(answered.filter((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? "").includes("child answer")).length, 1);

    // The interrupted call replays exactly once: the parent ends with one agent_spawn result, and it is the answer of
    // the delegation this call already created — no second child, no second submission, no second dispatch.
    const parentDone = await waitForParentAnswer(crash, facts.parentId, "parent done");
    const results = parentDone.filter((entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model ?? "").includes("agent_spawn"));
    assert.equal(results.length, 1, JSON.stringify(parentDone.map((entry) => entry.kind)));
    assert.match(JSON.stringify(results[0]!.model ?? ""), /already created by this call/);
    const after = await crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(facts.parentId) as ConversationId }, 100, undefined), BACKGROUND_CONTEXT);
    assert.equal(after.items.length, 1, "the replay created no second child");
    const admittedOnce = await crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(facts.childId) as ConversationId }, 200, undefined), BACKGROUND_CONTEXT);
    assert.equal(admittedOnce.items.filter((entry) => entry.kind === "pi.user").length, 1, "the replay admitted no second submission");

    // The recovered state is also the state the HTTP surfaces answer from, so the same facts are read once more through
    // the backend a client talks to: the catalogue lists the one child, and the recovery route answers the admission by
    // the caller's own request identity instead of the client resending anything.
    await crash.close();
    const fixture = await startLocal(t, dbPath, root, home, (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as unknown as Transcript;
        return lastUserText(messages) === "crash work" ? fauxAssistantMessage("child answer") : fauxAssistantMessage("parent done");
      };
      faux.setResponses([respond]);
    });
    const listed = await catalogue(fixture, "?createdBy=" + facts.parentId);
    assert.equal(listed.conversations.length, 1, JSON.stringify(listed.conversations));
    assert.equal(listed.conversations[0]!.id, facts.childId);
    assert.equal((await info(fixture, facts.childId)).owner?.conversationId, facts.parentId);
    const admitted = await childSubmission(fixture, facts.childId, facts.parentId + ":" + facts.callId);
    assert.notEqual(admitted, null, "the admission the recovery route answers by request identity");
    assert.equal(admitted?.entryId === undefined, false, "the admission owns its own user entry");
  });
}

test("a conversation bound to no execution workspace refuses delegation with a named reason", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-unbound-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const response = await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  const unbound = (await read<{ conversation: Row }>(response, 201)).conversation;
  // A conversation bound to nothing cannot run a coding tool at all, so only delegation is turned on for it.
  await enableSubagents(fixture, unbound.id, ["hepi-subagents"]);
  respondWith(fixture, (messages) => (hasToolResult(messages, "agent_spawn")
    ? fauxAssistantMessage("done")
    : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "x" })], { stopReason: "toolUse" })));
  const settled = await turn(fixture, unbound.id, "unbound-turn", "done");
  const refused = settled.entries.find((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.equal(refused?.message.isError, true, refused?.text);
  assert.match(refused?.text ?? "", /bound to no execution workspace/);
});
/**
 * The concurrency limit bounds **work**, not identities. A delegation that finished keeps its child conversation and its
 * permanent anchor for the life of that child, so counting non-terminal anchors would count every child that ever ran
 * and refuse the next delegation forever — the failure this test drives through the real model tool seam.
 */
test("the child limit bounds delegations still at work, so finished children never block a new one", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-capacity-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  // What the next parent turn should delegate, and whether the children it creates hold or answer at once. The gate is
  // what makes four delegations provably *at work* rather than merely created. A child's request is told apart by its
  // own task text, so the parent and its children never consume each other's script, and every parent answer carries
  // the number of its own turn so a wait can never be satisfied by the previous turn's answer.
  let holdChildren = true;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tasks = ["hold-1", "hold-2", "hold-3", "hold-4", "hold-5", "quick"];
  let parentTurns = 0;
  respondWith(fixture, async (messages) => {
    const task = lastUserText(messages);
    // A finished child now reports itself into this conversation, and that report wakes a turn of its own. The turn is
    // answered and nothing is delegated from it: this test counts the delegations *this script* asked for, and a
    // report-woken turn is not one of them (ticket 07).
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw a report");
    if (task.startsWith("hold")) {
      if (!holdChildren) return fauxAssistantMessage("held child answer");
      await gate;
      return fauxAssistantMessage("held child answer");
    }
    if (task === "quick") return fauxAssistantMessage("quick child answer");
    parentTurns += 1;
    if (parentTurns % 2 === 0) return fauxAssistantMessage("parent done " + parentTurns / 2);
    const planned = tasks[(parentTurns - 1) / 2] ?? "quick";
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: planned })], { stopReason: "toolUse" });
  });

  // Four delegations, one per turn, so each creating commit is visible to the next capacity read. The limit is 4.
  for (let index = 1; index <= 4; index += 1) {
    const settled = await turn(fixture, parent.id, "capacity-turn-" + index, "parent done " + index);
    const result = settled.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
    assert.notEqual(result?.message.isError, true, result?.text);
  }
  const held = await catalogue(fixture, "?createdBy=" + parent.id);
  assert.equal(held.conversations.length, 4, JSON.stringify(held.conversations));

  // A fifth delegation is refused while those four are still work: nothing is created and nothing is queued.
  const refused = await turn(fixture, parent.id, "capacity-turn-5", "parent done 5");
  const refusal = refused.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.equal(refusal?.message.isError, true, refusal?.text);
  assert.match(refusal?.text ?? "", /children at work; the limit is 4/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 4);

  // The four finish. Their conversations and anchors stay, and the next delegation is admitted anyway, because the
  // count is of delegations still at work.
  holdChildren = false;
  release?.();
  for (const child of held.conversations) await waitForAnswer(fixture, child.id, "held child answer");
  const admitted = await turn(fixture, parent.id, "capacity-turn-6", "parent done 6");
  const created = admitted.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.notEqual(created?.message.isError, true, created?.text);
  const after = await catalogue(fixture, "?createdBy=" + parent.id);
  assert.equal(after.conversations.length, 5, JSON.stringify(after.conversations));
  // Every child keeps its owner: the finished delegations still own the children they created.
  for (const child of after.conversations) {
    const childInfo = await info(fixture, child.id);
    assert.equal(childInfo.owner?.conversationId, parent.id);
  }
});

/**
 * A replay of one delegation request is answered from the durable dispatch **first**. The request may already have
 * created a child — an interrupted delegation, or a definition edited after the fact — and re-checking the definition,
 * the tool set or the capacity before reaching that record is what would refuse work that is already done.
 */
test("a replay of an already-created delegation is answered from the durable record, not re-checked against current state", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-replay-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  const REPLAY_CALL = "call-replay";
  let hold = true;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Four delegations then one replay of the first: the replay carries the very call id the first delegation used.
  const callIds = [REPLAY_CALL, "call-2", "call-3", "call-4", REPLAY_CALL];
  let parentTurns = 0;
  respondWith(fixture, async (messages) => {
    if (lastUserText(messages) === "hold") {
      if (!hold) return fauxAssistantMessage("held child answer");
      await gate;
      return fauxAssistantMessage("held child answer");
    }
    parentTurns += 1;
    if (parentTurns % 2 === 0) return fauxAssistantMessage("parent done " + parentTurns / 2);
    const callId = callIds[(parentTurns - 1) / 2] ?? "call-extra";
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "hold" }, { id: callId })], { stopReason: "toolUse" });
  });

  const first = await turn(fixture, parent.id, "replay-turn-1", "parent done 1");
  const firstResult = first.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.notEqual(firstResult?.message.isError, true, firstResult?.text);
  const children = await catalogue(fixture, "?createdBy=" + parent.id);
  assert.equal(children.conversations.length, 1, JSON.stringify(children.conversations));
  const childId = children.conversations[0]!.id;
  assert.match(firstResult?.text ?? "", new RegExp(childId));

  // Three more delegations fill the limit, so a fourth creation would be refused on capacity alone.
  for (let index = 2; index <= 4; index += 1) {
    const settled = await turn(fixture, parent.id, "replay-turn-" + index, "parent done " + index);
    const result = settled.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
    assert.notEqual(result?.message.isError, true, result?.text);
  }
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 4);

  // And the definition the first delegation used is gone, so a fresh resolution would refuse it as unknown.
  await rm(join(root, ".pi", "agents", "worker.md"));

  // The replay still answers the child the first attempt created: no second child, no capacity refusal, no definition
  // lookup, and the parent's tool result is a success.
  const replayed = await turn(fixture, parent.id, "replay-turn-5", "parent done 5");
  const replayResult = replayed.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.notEqual(replayResult?.message.isError, true, replayResult?.text);
  assert.match(replayResult?.text ?? "", new RegExp(childId));
  assert.match(replayResult?.text ?? "", /already created by this call/);
  assert.equal((await catalogue(fixture, "?createdBy=" + parent.id)).conversations.length, 4, "the replay created no second child");

  // The child still runs its one admitted task once.
  hold = false;
  release?.();
  const answered = await waitForAnswer(fixture, childId, "held child answer");
  assert.equal(answered.entries.filter((entry) => entry.role === "user").length, 1, JSON.stringify(answered.entries));
});

/**
 * The global opt-in, end to end through the real model tool seam: a deployment that selects the optional extension as
 * its default really offers a new conversation the delegation tool, and the child that conversation then creates still
 * does not select it. The child exclusion is the default "a child does not delegate in turn" rule (spec D11, D12).
 */
test("a global default that turns delegation on reaches a new conversation and still not its child", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-optin-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);

  // The deployment's own default, written the way an operator writes it. No per-conversation override follows.
  const written = await fetch(fixture.origin + "/api/extensions", { method: "POST", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  const stored = await read<{ default: string[] }>(written, 200);
  assert.deepEqual(stored.default, ["coding-tools", "hepi-subagents"]);

  const parent = await createConversation(fixture);
  const parentState = await state(fixture, parent.id);
  assert.deepEqual(parentState.extensions.sort(), ["coding-tools", "hepi-subagents"]);
  assert.equal(parentState.toolNames.includes("agent_spawn"), true, JSON.stringify(parentState.toolNames));

  respondWith(fixture, (messages) => {
    if (lastUserText(messages) === "default work") return fauxAssistantMessage("child answer");
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent done");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "default work" })], { stopReason: "toolUse" });
  });
  const settled = await turn(fixture, parent.id, "optin-turn", "parent done");
  const result = settled.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
  assert.notEqual(result?.message.isError, true, result?.text);
  const child = await childOf(fixture, parent.id);
  // The child inherits the workspace binding and the tools the definition names, and not the delegation tool: the
  // default is materialized for a new conversation, never copied into the child's own configuration.
  assert.deepEqual((await state(fixture, child.id)).extensions, ["coding-tools"]);
  assert.equal((await state(fixture, child.id)).toolNames.includes("agent_spawn"), false);
  assert.deepEqual((await info(fixture, child.id)).config.extensions, ["coding-tools"]);
});

/**
 * Ticket 08: an explicit send to a child that already exists.
 *
 * The child keeps its own conversation — its id, its history, its creator, its display parent and its native owner —
 * and each explicit send is a dispatch of its own with its own admission receipt, so a second task is a second
 * delegation of the same worker rather than a new one. The result of each send goes to the conversation that made it.
 */
test("a second explicit send reuses the same child and each send reports to its own sender", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-send-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  // The tool set this ticket fixes, stated before anything runs: five agent_* tools and no conversation_*.
  const offered = (await state(fixture, parent.id)).toolNames;
  assert.deepEqual([...offered].filter((name) => name.startsWith("agent_")).sort(), ["agent_get", "agent_read", "agent_send", "agent_spawn", "agent_stop"]);
  assert.equal(offered.some((name) => name.startsWith("conversation_")), false, JSON.stringify(offered));

  let childId = "";
  let reports = 0;
  respondWith(fixture, (messages) => {
    const task = lastUserText(messages);
    if (task === "first task") return fauxAssistantMessage("child answer one");
    if (task === "second task") return fauxAssistantMessage("child answer two");
    // A report-woken turn: the automatic delivery is what starts it, and this test counts them.
    if (task.startsWith("The delegated child ")) { reports += 1; return fauxAssistantMessage("parent saw report " + reports); }
    if (task === "delegate now") return hasToolResult(messages, "agent_spawn")
      ? fauxAssistantMessage("delegated")
      : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "first task" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    if (task === "send again") return hasToolResult(messages, "agent_send")
      ? fauxAssistantMessage("sent")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task" }, { id: "call-send" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("parent idle");
  });

  // The first delegation, driven by a real model tool call.
  await say(fixture, parent.id, "send-turn-1", "delegate now", "delegated");
  const child = await childOf(fixture, parent.id);
  childId = child.id;
  await waitForAnswer(fixture, child.id, "child answer one");
  // The first dispatch's report arrives before the second send, so each report is counted deterministically.
  await waitForAnswer(fixture, parent.id, "parent saw report 1");
  const before = await info(fixture, child.id);

  // The second explicit send: the same child, a dispatch of its own.
  await say(fixture, parent.id, "send-turn-2", "send again", "sent");
  const sent = await state(fixture, parent.id);
  const sentResult = sent.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.notEqual(sentResult?.message.isError, true, sentResult?.text);
  assert.match(sentResult?.text ?? "", new RegExp(childId), "the send answers the same child it addressed");

  // No new child was created, and the child's own identity is untouched by the second dispatch.
  const children = await catalogue(fixture, "?createdBy=" + parent.id);
  assert.equal(children.conversations.length, 1, JSON.stringify(children.conversations));
  const after = await info(fixture, child.id);
  assert.equal(after.relations.createdBy, before.relations.createdBy);
  assert.equal(after.relations.displayParentId, before.relations.displayParentId);
  assert.deepEqual(after.owner, before.owner);
  assert.deepEqual(after.config, before.config);

  // The child really ran the second task in its own history, beside the first.
  const childState = await waitForAnswer(fixture, child.id, "child answer two");
  const childTexts = childState.entries.filter((entry) => entry.role === "user").map((entry) => entry.text);
  assert.deepEqual(childTexts, ["first task", "second task"], JSON.stringify(childState.entries));

  // Each explicit send is its own dispatch with its own admission receipt, and the second reports to its sender.
  assert.notEqual(await childSubmission(fixture, child.id, parent.id + ":call-spawn"), null);
  assert.notEqual(await childSubmission(fixture, child.id, parent.id + ":call-send"), null);
  await waitForAnswer(fixture, parent.id, "parent saw report 2");
});

/**
 * A branch of a child conversation is a conversation of its own, and the anchor that owns it is **not** work: it is the
 * branch's native owner, in the permanent idle phase, for the life of the branch. Counting it as a delegation at work
 * would spend the child limit on every branch a user takes, which is what this drives through the real fork route and
 * the real model tool seam (spec D12, D14, A17).
 */
test("a branch of a child is its own owner and is not a delegation still at work", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-branch-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  // The children the parent delegates: the first answers at once, so it is a *finished* delegation whose anchor stays;
  // the rest hold, so "at work" is a state this fixture provably reaches rather than a race.
  let hold = true;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let parentTurns = 0;
  const tasks = ["first", "hold-1", "hold-2", "hold-3", "hold-4"];
  respondWith(fixture, async (messages) => {
    const task = lastUserText(messages);
    // The finished child reports itself into this conversation, and that report wakes a turn of its own. The turn is
    // answered and delegates nothing: this test counts the delegations *this script* asked for, and a report-woken
    // turn is not one of them — without this the report would be read as the next task and spend a second child slot
    // (ticket 07).
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw a report");
    if (task === "first") return fauxAssistantMessage("child answer");
    if (task.startsWith("hold")) {
      if (!hold) return fauxAssistantMessage("held child answer");
      await gate;
      return fauxAssistantMessage("held child answer");
    }
    parentTurns += 1;
    if (parentTurns % 2 === 0) return fauxAssistantMessage("parent done " + parentTurns / 2);
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: tasks[(parentTurns - 1) / 2] ?? "first" })], { stopReason: "toolUse" });
  });

  try {
    await turn(fixture, parent.id, "branch-turn-1", "parent done 1");
    const child = await childOf(fixture, parent.id);
    const childInfo = await info(fixture, child.id);
    await waitForAnswer(fixture, child.id, "child answer");

    // The user branches the child at its own newest entry, through the route the sidebar and the transcript both use.
    const at = (await state(fixture, child.id)).entries.at(-1)!.id;
    const response = await fetch(fixture.origin + "/api/conversations/" + child.id + "/fork", { method: "POST", headers, body: JSON.stringify({ at, requestId: "branch-1" }) });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const branch = JSON.parse(text) as { conversationId: string; conversation: Row };

    // The branch is displayed under the child it was taken from, and its native owner is its own background anchor on
    // that child: not the child's own task, not the parent's, and not an ownerless conversation.
    assert.equal(branch.conversation.displayParentId, child.id);
    assert.equal(branch.conversation.parentConversationId, child.id, "the branch inherits the child's history");
    // The catalogue does not report the branch as a subagent's: its owner is its own anchor, but nobody delegated it,
    // so a surface must not fold the user's branch into the child's family (its native owner is read by id below).
    assert.equal(branch.conversation.subagentParentConversationId, undefined);
    const branchInfo = await info(fixture, branch.conversationId);
    assert.equal(branchInfo.relations?.createdBy, child.id);
    assert.equal(branchInfo.owner?.conversationId, child.id);
    assert.notEqual(branchInfo.owner?.taskId, childInfo.owner?.taskId, "the branch does not reuse the child's anchor");
    assert.equal(branchInfo.displayParentDeleted, false);
    // Independent initial run state: idle, allowed, and with nothing queued from the child it was taken from.
    const branchState = await state(fixture, branch.conversationId);
    assert.equal(branchState.busy, false);
    assert.equal(branchState.control.state, "allowed");
    assert.deepEqual(branchState.queuedMessages, { steering: [], followUp: [] });

    // A replay of the same request identity answers the branch the first attempt created and branches nothing again.
    const replay = await fetch(fixture.origin + "/api/conversations/" + child.id + "/fork", { method: "POST", headers, body: JSON.stringify({ at, requestId: "branch-1" }) });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as { conversationId: string }).conversationId, branch.conversationId);
    assert.equal((await catalogue(fixture, "?displayParentId=" + child.id)).conversations.length, 1);

    // Three delegations hold, so three children are provably at work and the limit of four is one short of full. The
    // branch's idle anchor is its owner, not work, so the fourth delegation is admitted; counting it would refuse here.
    for (let index = 1; index <= 3; index += 1) {
      const settled = await turn(fixture, parent.id, "branch-hold-" + index, "parent done " + (index + 1));
      const result = settled.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
      assert.notEqual(result?.message.isError, true, result?.text);
    }
    const admitted = await turn(fixture, parent.id, "branch-hold-4", "parent done 5");
    const created = admitted.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_spawn");
    assert.notEqual(created?.message.isError, true, created?.text);
  } finally {
    hold = false;
    release?.();
  }
});

/**
 * Ticket 08: another conversation gives a child a task, and gets that report itself.
 *
 * The child belongs to whoever created it. A second conversation that sends it a task creates a **dispatch of its own**
 * and nothing else: the child keeps its id, its history, its creator, its display parent, its native owner and its
 * configuration, and the report of that dispatch goes to the conversation that asked for it — never to the child's
 * creator, which is what "each dispatch reports to its own sender" means (spec D02, D03, A02, A05).
 */
test("another conversation can give a child a task and gets that report itself, without changing the child", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-borrow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  const other = await createConversation(fixture);
  await enableSubagents(fixture, other.id);

  let childId = "";
  respondWith(fixture, (messages) => {
    const task = lastUserText(messages);
    if (task === "first task") return fauxAssistantMessage("child answer one");
    if (task === "second task") return fauxAssistantMessage("child answer two");
    // Whichever conversation a report wakes answers the same way; each is asserted in its own transcript below.
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("saw a report");
    if (task === "delegate now") return hasToolResult(messages, "agent_spawn")
      ? fauxAssistantMessage("delegated")
      : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "first task" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    if (task === "borrow the child") return hasToolResult(messages, "agent_send")
      ? fauxAssistantMessage("borrowed")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task" }, { id: "call-send" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("idle");
  });

  // The child is created by the parent, and its own first report arrives before the second conversation acts.
  await say(fixture, parent.id, "borrow-turn-1", "delegate now", "delegated");
  const child = await childOf(fixture, parent.id);
  childId = child.id;
  await waitForAnswer(fixture, child.id, "child answer one");
  await waitForAnswer(fixture, parent.id, "saw a report");
  const before = await info(fixture, child.id);

  // The second conversation dispatches the same child: a real model tool call, addressed by conversation id.
  await say(fixture, other.id, "borrow-turn-2", "borrow the child", "borrowed");
  const sent = await state(fixture, other.id);
  const sentResult = sent.entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.notEqual(sentResult?.message.isError, true, sentResult?.text);
  assert.match(sentResult?.text ?? "", new RegExp(childId), "the send answers the child it addressed");

  // The child ran the second task in its own history, and its own identity is untouched by the borrowed dispatch.
  const childState = await waitForAnswer(fixture, child.id, "child answer two");
  assert.deepEqual(childState.entries.filter((entry) => entry.role === "user").map((entry) => entry.text), ["first task", "second task"], JSON.stringify(childState.entries));
  const children = await catalogue(fixture, "?createdBy=" + parent.id);
  assert.equal(children.conversations.length, 1, JSON.stringify(children.conversations));
  const after = await info(fixture, child.id);
  assert.equal(after.relations.createdBy, before.relations.createdBy);
  assert.equal(after.relations.displayParentId, before.relations.displayParentId);
  assert.deepEqual(after.owner, before.owner);
  assert.deepEqual(after.config, before.config);

  // Each dispatch is its own admission on the child, and the borrowed one reports to the conversation that asked.
  assert.notEqual(await childSubmission(fixture, child.id, parent.id + ":call-spawn"), null);
  assert.notEqual(await childSubmission(fixture, child.id, other.id + ":call-send"), null);
  const woken = await waitForAnswer(fixture, other.id, "saw a report");
  const reports = woken.entries.filter((entry) => entry.role === "user" && entry.text.startsWith("The delegated child "));
  assert.equal(reports.length, 1, JSON.stringify(woken.entries.map((entry) => entry.text)));
  assert.match(reports[0]!.text, new RegExp(childId), "the report names the child the borrower dispatched");
});

/**
 * Ticket 08: a user's stop is the user's.
 *
 * The model may stop work and may resume a stop **it** recorded, but it can never clear the user's: an agent dispatch
 * into a user-held conversation is refused before anything is created, a second agent stop does not downgrade the
 * recorded source, and only the user's own resume lets the model continue (spec D07, A09).
 */
test("a user stop refuses a model dispatch, is never downgraded, and the user's own resume lets the model continue", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-userstop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  const parentId = parent.id;

  let childId = "";
  respondWith(fixture, (messages) => {
    const task = lastUserText(messages);
    if (task === "first task") return fauxAssistantMessage("child answer one");
    if (task === "second task") return fauxAssistantMessage("child answer two");
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("saw a report");
    if (task === "delegate now") return hasToolResult(messages, "agent_spawn")
      ? fauxAssistantMessage("delegated")
      : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "first task" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    if (task === "try the child") return hasToolResult(messages, "agent_send")
      ? fauxAssistantMessage("tried")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task" }, { id: "call-refused" })], { stopReason: "toolUse" });
    if (task === "look for the dispatch") return hasToolResult(messages, "agent_get")
      ? fauxAssistantMessage("looked")
      : fauxAssistantMessage([fauxToolCall("agent_get", { conversationId: parentId, requestId: parentId + ":call-refused" }, { id: "call-get" })], { stopReason: "toolUse" });
    if (task === "stop the child") return hasNamedResult(messages, "agent_stop", childId)
      ? fauxAssistantMessage("stopped")
      : fauxAssistantMessage([fauxToolCall("agent_stop", { conversationId: childId }, { id: "call-stop" })], { stopReason: "toolUse" });
    if (task === "send now") return hasNamedResult(messages, "agent_send", childId)
      ? fauxAssistantMessage("sent now")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task" }, { id: "call-send" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("idle");
  });

  await say(fixture, parent.id, "userstop-turn-1", "delegate now", "delegated");
  const child = await childOf(fixture, parent.id);
  childId = child.id;
  await waitForAnswer(fixture, child.id, "child answer one");
  await waitForAnswer(fixture, parent.id, "saw a report");

  // The user holds the child, through the same route the UI uses.
  const stopped = await fetch(fixture.origin + "/api/conversations/" + child.id + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "stop-child" }) });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  assert.equal((await stopped.json() as { control: { stopSource?: string } }).control.stopSource, "user");

  // The model's dispatch is refused with the user's stop as the reason, and it created nothing: no submission on the
  // child, and no dispatch record the recovery read could answer.
  await say(fixture, parent.id, "userstop-turn-2", "try the child", "tried");
  const refused = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.equal(refused?.message.isError, true, refused?.text);
  assert.match(refused?.text ?? "", /user stop/i, refused?.text);
  assert.equal(await childSubmission(fixture, child.id, parent.id + ":call-refused"), null, "a refused dispatch admitted nothing");
  await say(fixture, parent.id, "userstop-turn-3", "look for the dispatch", "looked");
  const looked = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_get");
  assert.equal(looked?.message.isError, true, looked?.text);
  assert.match(looked?.text ?? "", /no delegation/i, looked?.text);

  // A second stop from the model does not downgrade the user's source, and the hold stands.
  await say(fixture, parent.id, "userstop-turn-4", "stop the child", "stopped");
  const control = await read<{ control: { state: string; stopSource?: string } }>(await fetch(fixture.origin + "/api/conversations/" + child.id + "/control", { headers }), 200);
  assert.equal(control.control.state, "held");
  assert.equal(control.control.stopSource, "user", "an agent stop never downgrades a user stop");

  // The user's explicit resume is the one that clears it, and the model's next dispatch then succeeds.
  const resumed = await fetch(fixture.origin + "/api/conversations/" + child.id + "/continue", { method: "POST", headers, body: JSON.stringify({ requestId: "continue-child" }) });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const resumedBody = await resumed.clone().json() as { status: string; control: { state: string } };
  assert.equal(resumedBody.status, "resumed", JSON.stringify(resumedBody));
  await say(fixture, parent.id, "userstop-turn-5", "send now", "sent now");
  const sent = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.notEqual(sent?.message.isError, true, sent?.text);
  await waitForAnswer(fixture, child.id, "child answer two");
  await waitForAnswer(fixture, parent.id, "saw a report");
});

/**
 * Ticket 08: the model's own stop, and the two calls it must not make.
 *
 * An agent stop holds the conversation with the agent as its source, so the same model may explicitly resume it — and
 * that is the only stop it can clear. Stopping the conversation it is running in is refused, and no argument lets it
 * claim to be someone else: the trusted caller is the host's statement, and an unknown argument is refused rather than
 * ignored (spec D02, D07, A03, A09).
 */
test("an agent stop holds and is resumable by the model, while self-stop and a spoofed caller are refused", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-agentstop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  const selfId = parent.id;

  let childId = "";
  respondWith(fixture, (messages) => {
    const task = lastUserText(messages);
    if (task === "first task") return fauxAssistantMessage("child answer one");
    if (task === "second task") return fauxAssistantMessage("child answer two");
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("saw a report");
    if (task === "delegate now") return hasToolResult(messages, "agent_spawn")
      ? fauxAssistantMessage("delegated")
      : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "first task" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    if (task === "stop myself") return hasToolResult(messages, "agent_stop")
      ? fauxAssistantMessage("self-stopped")
      : fauxAssistantMessage([fauxToolCall("agent_stop", { conversationId: selfId }, { id: "call-self" })], { stopReason: "toolUse" });
    if (task === "spoof the caller") return hasToolResult(messages, "agent_send")
      ? fauxAssistantMessage("spoofed")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task", caller: "user" } as never, { id: "call-spoof" })], { stopReason: "toolUse" });
    if (task === "stop the child") return hasNamedResult(messages, "agent_stop", childId)
      ? fauxAssistantMessage("child stopped")
      : fauxAssistantMessage([fauxToolCall("agent_stop", { conversationId: childId }, { id: "call-stop" })], { stopReason: "toolUse" });
    if (task === "resume the child") return hasNamedResult(messages, "agent_send", childId)
      ? fauxAssistantMessage("child resumed")
      : fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "second task" }, { id: "call-resume" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("idle");
  });

  await say(fixture, parent.id, "agentstop-turn-1", "delegate now", "delegated");
  const child = await childOf(fixture, parent.id);
  childId = child.id;
  await waitForAnswer(fixture, child.id, "child answer one");
  await waitForAnswer(fixture, parent.id, "saw a report");

  // A model cannot stop the conversation it is running in, and the refusal names that reason.
  await say(fixture, parent.id, "agentstop-turn-2", "stop myself", "self-stopped");
  const selfStop = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_stop");
  assert.equal(selfStop?.message.isError, true, selfStop?.text);
  assert.match(selfStop?.text ?? "", /cannot stop the conversation/i, selfStop?.text);
  assert.equal((await read<{ control: { state: string } }>(await fetch(fixture.origin + "/api/conversations/" + parent.id + "/control", { headers }), 200)).control.state, "allowed");

  // No argument makes the model another caller: the unknown field is refused, and nothing was dispatched.
  await say(fixture, parent.id, "agentstop-turn-3", "spoof the caller", "spoofed");
  const spoof = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.equal(spoof?.message.isError, true, spoof?.text);
  assert.match(spoof?.text ?? "", /does not accept the argument caller|the argument caller is host configuration/i, spoof?.text);
  assert.equal(await childSubmission(fixture, child.id, parent.id + ":call-spoof"), null);

  // The model's own stop holds the child with the agent as its source, and the model may explicitly resume it.
  await say(fixture, parent.id, "agentstop-turn-4", "stop the child", "child stopped");
  const held = await read<{ control: { state: string; stopSource?: string } }>(await fetch(fixture.origin + "/api/conversations/" + child.id + "/control", { headers }), 200);
  const stopResult = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_stop");
  assert.equal(held.control.state, "held", JSON.stringify({ stop: stopResult?.text, error: stopResult?.message.isError }));
  assert.equal(held.control.stopSource, "agent");
  await say(fixture, parent.id, "agentstop-turn-5", "resume the child", "child resumed");
  const resumed = (await state(fixture, parent.id)).entries.findLast((entry) => entry.role === "toolResult" && entry.message.toolName === "agent_send");
  assert.notEqual(resumed?.message.isError, true, resumed?.text);
  assert.equal((await read<{ control: { state: string } }>(await fetch(fixture.origin + "/api/conversations/" + child.id + "/control", { headers }), 200)).control.state, "allowed");
  await waitForAnswer(fixture, child.id, "child answer two");
  await waitForAnswer(fixture, parent.id, "saw a report");
});

/**
 * Ticket 08's recovery window, at the seam a **second** dispatch to an existing conversation really has.
 *
 * A spawn's windows are its creating commit and its admission. A send has no creating commit: the child already exists,
 * and the only thing that makes the dispatch recoverable is the caller's own stable request id. So the stage dies inside
 * the publication that carries the **admission** — the task text is durable on the child and no dispatch record exists
 * yet — and this process reopens the same SQLite paused to prove that the replay re-admits the same identity instead of
 * admitting the task twice, and that the report of the second dispatch is delivered exactly once (spec D04, A19).
 */
test("a real SIGKILL between a second dispatch's admission and its record keeps one task and one report", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-crash-send-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, root, home, "send"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as CrashFacts;
  assert.equal(facts.mode, "send");
  assert.equal(facts.checkpoint, "send-admitted");
  assert.equal(facts.admissionDurable, true);
  assert.equal(facts.toolResultCommitted, false, "the tool that dispatched had committed no result at the kill point");
  assert.ok(facts.submissionId !== undefined, "the admission the stage made is named by the facts it printed");
  assert.ok(facts.submissionId === undefined || facts.submissionStatus === "placed" || facts.submissionStatus === "queued", String(facts.submissionStatus));

  // Reopen the same SQLite paused, so the recovered state is read before any task is scheduled.
  const crash = await openCrashHarness(dbPath, {
    root,
    home,
    startPaused: true,
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as unknown as Transcript;
        const task = lastUserText(messages);
        if (task === "crash work") return fauxAssistantMessage("child answer one");
        if (task === "crash send work") return fauxAssistantMessage("child answer two");
        if (task.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw a report");
        return fauxAssistantMessage("parent done");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());

  // The kill point, read back from the store: the task text is admitted on the child and the dispatch record that would
  // name it does not exist yet — which is exactly the state a replay has to close without admitting a second task.
  const sendRequestId = facts.parentId + ":" + facts.callId;
  const childId = Number(facts.childId) as ConversationId;
  const admission = await crash.harness.harness.commit((tx) => tx.submissionByRequest(childId, sendRequestId), BACKGROUND_CONTEXT);
  assert.equal(admission === undefined, false, "the second dispatch's admission is durable");
  assert.equal(String(admission!.id), facts.submissionId);
  const recorded = await crash.harness.harness.snapshot(DispatchDoc, Number(facts.parentId) as ConversationId, sendRequestId, BACKGROUND_CONTEXT);
  assert.equal(recorded?.reporterTaskId, undefined, "the dispatch record that would name the reporter was not written");

  crash.harness.harness.resume();

  // The second task ran exactly once, beside the first: one user entry per task and one answer per task, however many
  // times the interrupted call replays.
  const answered = await waitForEntries(crash, facts.childId, (entries) => entries.some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? "").includes("child answer two")), "the second task's answer");
  const userTexts = answered.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.model ?? ""));
  assert.equal(userTexts.filter((text) => text.includes("crash send work")).length, 1, JSON.stringify(userTexts));
  assert.equal(userTexts.filter((text) => text.includes("crash work")).length, 1, JSON.stringify(userTexts));
  const secondAdmission = await crash.harness.harness.commit((tx) => tx.submissionByRequest(childId, sendRequestId), BACKGROUND_CONTEXT);
  assert.equal(String(secondAdmission?.id), facts.submissionId, "the replay was answered with the submission the first attempt made");

  // The dispatch record now exists and names the reporter, and the report of the second dispatch reaches the parent
  // once — the delivery identity is the dispatch's own, so a replay of the reporter cannot write a second report.
  // The **second** dispatch's own report, waited for by its content: the first dispatch's report arrives on its own
  // schedule, so a wait for "a report" would read the wrong one.
  const parentSaw = await waitForEntries(crash, facts.parentId, (entries) => entries.some((entry) => entry.kind === "hepi.agent-report" && JSON.stringify(entry.model ?? "").includes("child answer two")), "the second dispatch's report");
  const reports = parentSaw.filter((entry) => entry.kind === "hepi.agent-report");
  assert.equal(reports.filter((entry) => JSON.stringify(entry.model ?? "").includes("child answer two")).length, 1, JSON.stringify(reports.map((entry) => entry.model)));
  const dispatched = await crash.harness.harness.snapshot(DispatchDoc, Number(facts.parentId) as ConversationId, sendRequestId, BACKGROUND_CONTEXT);
  assert.notEqual(dispatched?.reporterTaskId, undefined, "the recovered dispatch has its reporter");
  assert.equal(dispatched?.submissionId, facts.submissionId);
  const report = await crash.harness.harness.snapshot(ReportDoc, Number(facts.parentId) as ConversationId, sendRequestId, BACKGROUND_CONTEXT);
  assert.equal(report?.delivery, "delivered", JSON.stringify(report));
  assert.equal(report?.childConversationId, facts.childId);
});

/**
 * Ticket 08: turning the delegation tools off keeps the work, the history and the recovery.
 *
 * The tools are a capability a conversation selects; the task definitions are not. An anchor and its reporter are
 * resolved by name from the registry, so a delegation admitted while the extension was selected still reports itself
 * after the selection is gone — and the child's own history stays readable through the same read the extension would
 * have used. Nothing here invents a "disabled" placeholder task: the recovered work is the real anchor and the real
 * reporter, and the only thing that changed is what the model is offered (spec D15, A01).
 */
test("disabling the delegation tools leaves an admitted child, its history and its report intact", { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-subagents-disabled-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "worker", "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home);
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);

  // The child's task is held open, so the delegation is provably *at work* when the capability is withdrawn.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = true;
  respondWith(fixture, async (messages) => {
    const task = lastUserText(messages);
    if (task === "held task") {
      if (held) await gate;
      return fauxAssistantMessage("child answer");
    }
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw a report");
    if (task === "delegate now") return hasToolResult(messages, "agent_spawn")
      ? fauxAssistantMessage("delegated")
      : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "held task" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("idle");
  });

  await say(fixture, parent.id, "disabled-turn-1", "delegate now", "delegated");
  const child = await childOf(fixture, parent.id);

  // The capability is withdrawn while the child is still working: the conversation no longer selects the extension, so
  // the model is offered none of the five tools.
  const disabled = await fetch(fixture.origin + "/api/conversations/" + parent.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(disabled, 200)).extensions, ["coding-tools"]);
  const offered = (await state(fixture, parent.id)).toolNames;
  assert.deepEqual(offered.filter((name) => name.startsWith("agent_")), [], JSON.stringify(offered));

  // The admitted work finishes and reports itself anyway: the anchor and the reporter are the durable records the
  // delegation made, not the tools the conversation happens to offer now.
  held = false;
  release?.();
  await waitForAnswer(fixture, child.id, "child answer");
  const woken = await waitForAnswer(fixture, parent.id, "parent saw a report");
  const reports = woken.entries.filter((entry) => entry.role === "user" && entry.text.startsWith("The delegated child "));
  assert.equal(reports.length, 1, JSON.stringify(woken.entries.map((entry) => entry.text)));
  assert.match(reports[0]!.text, new RegExp(child.id), "the report names the child that was admitted");

  // The child's own history is still readable through the backend's own read, which is the one `agent_read` calls.
  const childState = await state(fixture, child.id);
  assert.deepEqual(childState.entries.filter((entry) => entry.role === "user").map((entry) => entry.text), ["held task"]);
  assert.equal(childState.entries.some((entry) => entry.role === "assistant" && entry.text === "child answer"), true, JSON.stringify(childState.entries));
  // And its relations are untouched: the delegation is still the delegation that created it.
  const childInfo = await info(fixture, child.id);
  assert.equal(childInfo.relations.createdBy, parent.id);
  assert.equal(childInfo.relations.displayParentId, parent.id);
});
