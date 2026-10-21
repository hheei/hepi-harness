/**
 * Ticket 10 observable behavior: a delegation whose **definition** asks for `fork` or `compact` preparation runs it
 * through the real creation seam, and nothing reaches the child's model until that preparation is committed.
 *
 * Every assertion reads a fact the model, the user or a client can read — the child's own model context, the effective
 * configuration snapshot, the recorded provenance, the child's transcript, the catalogue — and never a helper internal
 * structure. The preparation is a real native compaction task over a real SQLite store, and the crash cases are real
 * SIGKILLs of a separate process (ticket 10, spec D11/D14; A13/A14/A19).
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
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { openCrashHarness, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const TOKEN = "context-prep-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const crashChild = fileURLToPath(new URL("./subagents-crash-child.ts", import.meta.url));

type Row = { id: string; createdBy?: string; displayParentId?: string; workspaceId: string | null };
type Info = {
  conversation: Row;
  forkSource?: { conversationId: string; at: string };
  relations: { createdBy?: string; displayParentId?: string; provenance?: { origin?: string; definition?: { hostId: string; scope: string; name: string }; context?: { strategy: string; sourceConversationId?: string; sourceEntryId?: string } } };
  owner?: { conversationId: string; taskId: string };
  config: { model: { provider: string; modelId: string } | null; tools: string[]; extensions: string[]; thinkingLevel: string; instructions?: string; cwd?: string };
};
type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

type Fixture = {
  readonly origin: string;
  readonly backend: BackendServer;
  readonly dbPath: string;
  readonly faux: ReturnType<typeof fauxProvider>;
  close(): Promise<void>;
};

async function writeDefinition(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", name + ".md"), body);
}

function lastUserText(messages: Transcript): string {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
}

async function read<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

async function startLocal(t: { after(fn: () => unknown): void }, dbPath: string, root: string, home: string, script?: (faux: ReturnType<typeof fauxProvider>) => void): Promise<Fixture> {
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
    files: new LocalFilesystem(workspaces, { identity: { user: "operator", home } }),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  script?.(faux);
  // A compaction is a real model request, so the policy is stated: a small context with nothing recent to keep, which
  // is what makes a short parent history genuinely compactable.
  const backend = await createBackendServer({
    dbPath,
    authToken: TOKEN,
    models,
    defaultModel: SERVER_MODEL,
    workspaces: [binding],
    settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  // One idempotent teardown, because a test that restarts a store closes its first fixture itself and the test's own
  // cleanup then runs again.
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    backend.server.closeAllConnections();
    await backend.close();
    await gateway.close();
  };
  t.after(close);
  return { origin: "http://127.0.0.1:" + serverAddress.port, backend, dbPath, faux, close };
}

const createConversation = async (fixture: Fixture, body: Record<string, unknown> = {}): Promise<Row> => {
  const response = await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local", ...body }) });
  return (await read<{ conversation: Row }>(response, 201)).conversation;
};

const enableSubagents = async (fixture: Fixture, id: string): Promise<void> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(response, 200)).extensions, ["coding-tools", "hepi-subagents"]);
};

const info = async (fixture: Fixture, id: string): Promise<Info> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id, { headers });
  return await read<Info>(response, 200);
};

/** The raw history one conversation committed, read through the same route a client reads. */
const history = async (fixture: Fixture, id: string): Promise<string> => {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/read?limit=200", { headers });
  const answer = await read<{ output: readonly { type: string; text?: string }[] }>(response, 200);
  return answer.output.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
};

/** One turn of a conversation, waited for by the answer the script produced. */
async function turn(fixture: Fixture, id: string, requestId: string, expected: string, deadlineMs = 30_000): Promise<void> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "delegate this" }) });
  await read<unknown>(response, 202);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const text = await history(fixture, id);
    if (text.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no answer " + JSON.stringify(expected) + " in conversation " + id);
}

/** Wait until one conversation's raw history satisfies a predicate, which is how a child's own schedule is observed. */
async function waitForHistory(fixture: Fixture, id: string, accept: (text: string) => boolean, description: string, deadlineMs = 30_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await history(fixture, id);
    if (accept(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no " + description + " in conversation " + id + "\n" + text.slice(0, 4000));
}

const childOf = async (fixture: Fixture, parentId: string): Promise<Row> => {
  const response = await fetch(fixture.origin + "/api/conversations?createdBy=" + parentId, { headers });
  const listed = await read<{ conversations: Row[] }>(response, 200);
  assert.equal(listed.conversations.length, 1, JSON.stringify(listed.conversations));
  return listed.conversations[0]!;
};

/**
 * A child's first model request is the whole point of the ticket: what the provider was actually sent is the only
 * evidence that the preparation happened **before** the task text, so the fixture records the messages of every child
 * request as they are made and the tests assert on that record.
 */
test("a compact definition prepares the child before its first task, and the summary is what the child first sees", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-compact-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "preparer", "---\nname: preparer\ndescription: preparer\nmodel: faux/faux-1\ntools:\n  - read\ncontext: compact\n---\n\nPrepare then work.\n");
  // Every model request of the fixture, so the child's own first request can be told from the parent's: the parent's
  // request merely *mentions* the task text inside its tool call, while the child's carries it as its last user message.
  const requests: { role: string; text: string; lastUser: string }[][] = [];
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      requests.push(messages.map((message) => ({ role: message.role, text: JSON.stringify(message.content ?? ""), lastUser: lastUserText(messages) })));
      const first = messages[0];
      const isCompaction = first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant");
      if (isCompaction) return fauxAssistantMessage("## Goal\ncarry the parent's decisions forward");
      if (lastUserText(messages).includes("child task")) return fauxAssistantMessage("child answer");
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "preparer", task: "child task" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  });
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  // A parent with a history: the compaction has something to summarize, so a real summary entry is placed.
  await turn(fixture, parent.id, "parent-turn-1", "parent done");
  await turn(fixture, parent.id, "parent-turn-2", "parent done");

  const child = await childOf(fixture, parent.id);
  const childInfo = await info(fixture, child.id);
  // The definition decided the strategy, and the branch point is recorded: the parent, at one entry of its own history.
  assert.equal(childInfo.relations.provenance?.context?.strategy, "compact");
  assert.equal(childInfo.relations.provenance?.context?.sourceConversationId, parent.id);
  assert.ok((childInfo.relations.provenance?.context?.sourceEntryId ?? "") !== "", "the source entry is recorded");
  // The child's own history starts from that position: the inherited entries are the parent's, up to the recorded one.
  const inherited = await history(fixture, child.id);
  assert.match(inherited, /delegate this/);

  // Wait for the child's first real request, which is the fact the ticket is about.
  const deadline = Date.now() + 30_000;
  let childRequest: { role: string; text: string; lastUser: string }[] | undefined;
  while (Date.now() < deadline && childRequest === undefined) {
    childRequest = requests.find((messages) => messages.at(-1)?.lastUser === "child task");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(childRequest !== undefined, "the child made a model request");
  // The preparation ran **before** the task text reached the model: the child's first request already carries the
  // summary, and the task text is the message after it.
  const summaryIndex = childRequest.findIndex((message) => message.text.includes("compacted into the following summary"));
  assert.ok(summaryIndex >= 0, "the child's first request carries the summary: " + JSON.stringify(childRequest));
  // The request the child's own work is answered from ends with the task text, and the summary is already in it: the
  // preparation was committed before the task was admitted, which is the whole claim of this test.
  assert.ok(summaryIndex < childRequest.length - 1, "the summary precedes the task text: " + JSON.stringify(childRequest));
  assert.equal(childRequest.at(-1)?.text.includes("child task"), true, "the request ends with the task text: " + JSON.stringify(childRequest));
  // The compaction really happened in the child: its raw history carries the summary entry as a committed record, and
  // the inherited entries before it stay readable (spec D13: compact is lossy for the model, not for the store).
  await waitForHistory(fixture, child.id, (text) => text.includes("compacted into the following summary"), "the summary entry");
  assert.match(await history(fixture, child.id), /delegate this/);
});

test("a fork definition branches from the parent's position without inheriting its capabilities", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-fork-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "brancher", "---\nname: brancher\ndescription: brancher\nmodel: faux/faux-1\ntools:\n  - read\ncontext: fork\n---\n\nBranch then work.\n");
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      if (lastUserText(messages).includes("child task")) return fauxAssistantMessage("child answer");
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "brancher", task: "child task" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  });
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  await turn(fixture, parent.id, "parent-turn-1", "parent done");
  const child = await childOf(fixture, parent.id);
  const childInfo = await info(fixture, child.id);
  assert.equal(childInfo.relations.provenance?.context?.strategy, "fork");
  assert.equal(childInfo.relations.provenance?.context?.sourceConversationId, parent.id);
  // The branch is a real native fork edge, so the runtime's own history semantics apply to it.
  assert.equal(childInfo.forkSource?.conversationId, parent.id);
  assert.equal(childInfo.forkSource?.at, childInfo.relations.provenance?.context?.sourceEntryId);
  // The parent's history is inherited; the parent's *later* turn is not, because the branch point was pinned before it.
  const inherited = await history(fixture, child.id);
  assert.match(inherited, /delegate this/);
  // The fork copies the source's agent as of the branch point, and the definition's own snapshot is applied on top of
  // it, so the source's capabilities do not survive into the child: the child selects the coding tools its definition
  // names and not the extension its parent delegates through (spec D11, A13).
  assert.deepEqual(childInfo.config.tools, ["read"], JSON.stringify(childInfo.config));
  assert.deepEqual(childInfo.config.extensions, ["coding-tools"], JSON.stringify(childInfo.config));
  assert.equal(childInfo.config.instructions, "Branch then work.");
  assert.deepEqual(childInfo.config.model, { provider: "faux", modelId: "faux-1" });
  assert.equal(childInfo.config.cwd, "/");
  await turn(fixture, parent.id, "parent-turn-2", "parent done");
  const afterLaterTurn = await history(fixture, child.id);
  assert.equal(afterLaterTurn.includes("parent done"), false, "a later parent answer is not in the branch: " + afterLaterTurn.slice(0, 2000));
});

test("the definition's strategy is not overridable by the model, and a failed preparation is stated instead of falling back to fresh", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-authority-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  // A definition whose preparation cannot succeed: its summarizer answers with a tool call, which is not a summary, so
  // the native compaction task settles failed with a named reason instead of placing one.
  await writeDefinition(root, "failing", "---\nname: failing\ndescription: failing\nmodel: faux/faux-1\ntools:\n  - read\ncontext: compact\n---\n\nbody\n");
  await writeDefinition(root, "fine", "---\nname: fine\ndescription: fine\nmodel: faux/faux-1\ntools:\n  - read\n---\n\nbody\n");
  let parentId = "";
  let parentTurns = 0;
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      const first = messages[0];
      const isCompaction = first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant");
      if (isCompaction) return fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" });
      if (lastUserText(messages).includes("child task")) return fauxAssistantMessage("child answer");
      parentTurns += 1;
      if (parentTurns === 1) {
        return fauxAssistantMessage([
          // A strategy, a plugin set or a source position is host configuration, so the arguments carry none of it.
          fauxToolCall("agent_spawn", { name: "fine", task: "child task", context: "fresh", source: { conversationId: "1", entryId: "1" } }, { id: "call-override" }),
          fauxToolCall("agent_spawn", { name: "failing", task: "child task" }, { id: "call-failing" }),
        ], { stopReason: "toolUse" });
      }
      // Later turns ask the delegation's own record — the public seam a caller reads it through — until the
      // preparation's failure is stated there. The dispatch id is the one the spawn answered with, and asking again is
      // how a caller waits for a preparation that is still running.
      const asked = messages.filter((message) => message.role === "toolResult" && message.toolName === "agent_get").length;
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_get" && JSON.stringify(message.content ?? "").includes("preparation_failed"))) {
        return fauxAssistantMessage("preparation_failed");
      }
      return fauxAssistantMessage([fauxToolCall("agent_get", { conversationId: parentId, requestId: parentId + ":call-failing" }, { id: "call-read-dispatch-" + asked })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  });
  const parent = await createConversation(fixture);
  parentId = parent.id;
  await enableSubagents(fixture, parent.id);
  await turn(fixture, parent.id, "parent-turn-1", "host configuration the model does not set");

  // The override attempt is refused as an argument the model does not set, and nothing was created for it: the one
  // child that exists belongs to the other call, whose definition is the only thing that chose a strategy.
  const overrideText = await waitForHistory(fixture, parent.id, (text) => text.includes("host configuration the model does not set"), "the override refusal");
  assert.match(overrideText, /host configuration the model does not set/);
  // The failing delegation's child is created by the tool's own commit, so it appears on its own schedule: wait for it
  // rather than racing the parent's turn.
  const deadline = Date.now() + 30_000;
  let listed: { conversations: Row[] } = { conversations: [] };
  while (Date.now() < deadline && listed.conversations.length === 0) {
    listed = await read<{ conversations: Row[] }>(await fetch(fixture.origin + "/api/conversations?createdBy=" + parent.id, { headers }), 200);
    if (listed.conversations.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(listed.conversations.length, 1, JSON.stringify(listed.conversations) + "\n" + (await history(fixture, parent.id)).slice(0, 4000));
  const childId = listed.conversations[0]!.id;
  const childInfo = await info(fixture, childId);
  assert.equal(childInfo.relations.provenance?.definition?.name, "failing");
  assert.equal(childInfo.relations.provenance?.context?.strategy, "compact");

  // The child was never given its task: nothing admitted the task text, so the child's model was never asked to work.
  const childHistory = await history(fixture, childId);
  assert.equal(childHistory.includes("child task"), false, childHistory.slice(0, 2000));
  assert.equal(childHistory.includes("child answer"), false, childHistory.slice(0, 2000));

  // The failure is stated on the delegation's own durable record, which is what agent_get answers from: a caller learns
  // that preparation failed, and does not get a silently fresh child.
  await turn(fixture, parent.id, "parent-turn-2", "preparation_failed", 60_000);
  const answered = await history(fixture, parent.id);
  assert.match(answered, /"preparationOutcome": "failed"/);
  assert.match(answered, /Summarization attempted to call a tool/);
  assert.match(answered, /"preparation": "compact"/);
});

test("a failed preparation is retryable under the same dispatch identity, without a second child or admission", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-retry-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "flaky", "---\nname: flaky\ndescription: flaky\nmodel: faux/faux-1\ntools:\n  - read\ncontext: compact\n---\n\nRetry then work.\n");
  // The summarizer fails its first attempt — a tool call is not a summary — and answers the second. Everything the
  // fixture counts is a real model request or a real transcript fact, never an internal task count.
  let attempts = 0;
  let step = 0;
  const childWork: string[] = [];
  let parentId = "";
  // One responder for the whole fixture, driven by the transcript it is handed: the parent's own tool results say how
  // far its script has got, so no counter can race the child's requests through the same provider queue.
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    const first = messages[0];
    if (first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant")) {
      attempts += 1;
      return attempts === 1
        ? fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })
        : fauxAssistantMessage("## Goal\nretried summary");
    }
    // The child's own work: recorded, so "was the task text ever run, and how many times" is a request count.
    if (lastUserText(messages).includes("retry work")) {
      childWork.push(lastUserText(messages));
      return fauxAssistantMessage("child answer");
    }
    // The parent is the only conversation reaching this branch, so its own script is a plain sequence: delegate, read
    // the delegation's own record, replay the same call twice, then finish.
    step += 1;
    const call = { id: "call-flaky" };
    if (step === 1) return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "flaky", task: "retry work" }, call)], { stopReason: "toolUse" });
    // The public seam a caller reads a delegation through: it is what states that the preparation failed.
    if (step === 2) return fauxAssistantMessage([fauxToolCall("agent_get", { conversationId: parentId, requestId: parentId + ":call-flaky" }, { id: "call-read" })], { stopReason: "toolUse" });
    if (step <= 4) return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "flaky", task: "retry work" }, call)], { stopReason: "toolUse" });
    return fauxAssistantMessage("parent done");
    };
    faux.setResponses([respond]);
  });
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  parentId = parent.id;
  await turn(fixture, parent.id, "parent-turn-1", "parent done", 60_000);

  // The preparation failed and nothing was admitted: the delegation's own record says so, the child holds no task text,
  // and the child's model was never asked to work.
  const answered = await history(fixture, parent.id);
  assert.match(answered, /"status": "preparation_failed"/, answered.slice(-4000));
  assert.match(answered, /Summarization attempted to call a tool/, answered.slice(-4000));
  assert.equal(attempts, 2, "one failed attempt and the one the replay asked for, and no more");
  const child = await childOf(fixture, parent.id);
  const listing = await read<{ conversations: Row[] }>(await fetch(fixture.origin + "/api/conversations?createdBy=" + parent.id, { headers }), 200);
  assert.equal(listing.conversations.length, 1, "the retry created no second child: " + JSON.stringify(listing.conversations));

  // The retry prepared the same child: one summary, one admission of the task text, and one child answer.
  await waitForHistory(fixture, child.id, (text) => text.includes("child answer"), "the child's answer", 60_000);
  assert.deepEqual(childWork, ["retry work"], "the task text ran exactly once, after the preparation succeeded");
  const childHistory = await history(fixture, child.id);
  assert.match(childHistory, /retried summary/);
  assert.equal(childHistory.split("retry work").length - 1, 1, "one admission of the task text: " + childHistory.slice(0, 3000));
  // A replay of the retry is not a second retry: the delegation still names the same failed attempt as retried, so the
  // summarizer ran exactly twice in total and the child was admitted once.
  assert.equal(attempts, 2, "replaying the retry asked for nothing more");
});

test("a stated preparation failure survives a SIGKILL, and the same dispatch identity retries it after the kill", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-parked-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const dbPath = join(base, "hepi.sqlite");
  // The first process dies by SIGKILL inside the commit that **states** the failure, so nothing about the parking came
  // from a clean close: the failure is durable store state, and the anchor that stated it is gone.
  const killed = spawnSync(process.execPath, [crashChild, dbPath, root, home, "parked"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
  const factsLine = killed.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1);
  assert.ok(factsLine !== undefined, "the stage stated its facts: " + killed.stdout);
  const facts = JSON.parse(factsLine) as { parentId: string; childId: string; checkpoint: string; admissionDurable: boolean; preparationFailedTaskId?: string };
  assert.equal(facts.checkpoint, "preparation-failed");
  assert.equal(facts.admissionDurable, false, factsLine);
  assert.ok(facts.preparationFailedTaskId !== undefined, factsLine);

  // Reopen the same store, paused, and read what the kill left: the delegation states the failure, the child holds no
  // task text, and the anchor is live and parked on the attempt that failed rather than settled.
  const crash = await openCrashHarness(dbPath, {
    root,
    home,
    settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } },
    // The summarizer answers every request, and the responder re-arms itself: the reopened store still has the parent's
    // own generation to finish, and that request consumes one response like any other.
    script: (faux) => {
      const respond: FauxResponseFactory = async () => { faux.setResponses([respond]); return fauxAssistantMessage("## Goal\nretried summary"); };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());
  const delegating = Number(facts.parentId) as ConversationId;
  const requestId = facts.parentId + ":call-crash-parked";
  const dispatch = async (): Promise<{ preparationFailedTaskId?: string; preparationRetriedTaskId?: string; preparationOutcome?: string; preparationError?: string }> =>
    (await crash.harness.harness.snapshot(DispatchDoc, delegating, requestId, BACKGROUND_CONTEXT)) ?? {};
  const childTasks = async (): Promise<readonly { id: string; kind: string; status: string }[]> => {
    const page = await crash.harness.harness.commit((tx) => tx.scanTasks({ conversationId: Number(facts.childId) as ConversationId }, 100, undefined), BACKGROUND_CONTEXT);
    return page.items.map((task) => ({ id: String(task.id), kind: task.kind, status: task.state.status }));
  };
  // The anchor's own record, read through the native task table: its phase is the fact that says whether the parked
  // preparation is still live or was settled by the failure.
  const anchor = async (): Promise<{ status: string; phase?: string; compaction?: unknown } | undefined> => {
    const page = await crash.harness.harness.commit((tx) => tx.scanTasks({ conversationId: delegating, kind: "hepi.subagent-anchor" }, 10, undefined), BACKGROUND_CONTEXT);
    const record = page.items[0];
    if (record === undefined) return undefined;
    const state = record.state as { status: string; checkpoint?: { phase?: string; compaction?: unknown } };
    return { status: state.status, ...(state.checkpoint === undefined ? {} : { phase: state.checkpoint.phase, compaction: state.checkpoint.compaction }) };
  };
  // The retry write, exactly as the caller's replay of its own request makes it: the same dispatch identity, naming the
  // failed attempt's own task.
  const retry = async (): Promise<void> => {
    await crash.harness.harness.commit(async (tx) => {
      const record = await tx.doc(DispatchDoc, delegating, requestId, null);
      record.preparationRetriedTaskId = facts.preparationFailedTaskId;
    }, BACKGROUND_CONTEXT);
  };
  const parked = await dispatch();
  assert.equal(parked.preparationFailedTaskId, facts.preparationFailedTaskId, "the kill left the failure durable");
  assert.equal(parked.preparationOutcome, "failed");
  assert.equal(parked.preparationRetriedTaskId, undefined, "nothing had asked to retry it yet");
  assert.equal((await anchor())?.phase, "prepare", "the anchor is still live and parked on the failed attempt: " + JSON.stringify(await anchor()));
  const before = await childTasks();
  assert.equal(before.filter((task) => task.kind === "pi.compaction").length, 1, "one preparation attempt exists: " + JSON.stringify(before));

  // The caller's retry: the **same** dispatch identity names the failed attempt. Resuming the store is what lets the
  // parked anchor act on it, and the retry must create exactly one more preparation over the same child.
  await retry();
  crash.harness.harness.resume();
  const deadline = Date.now() + 30_000;
  let after = await childTasks();
  while (Date.now() < deadline && after.filter((task) => task.kind === "pi.compaction").length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    after = await childTasks();
  }
  const compactions = after.filter((task) => task.kind === "pi.compaction");
  assert.equal(compactions.length, 2, "the retry ran exactly one more preparation attempt: " + JSON.stringify(after));
  // The retried attempt succeeded — the summarizer answers now — so the anchor admitted the task text once and the same
  // child ran it. One child conversation, one summary, one admission: no second child and no second dispatch.
  const listing = await crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: delegating }, 100, undefined), BACKGROUND_CONTEXT);
  assert.equal(listing.items.length, 1, "the retry created no second child: " + JSON.stringify(listing.items.map((row) => String(row.id))));
  const entries = await crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(facts.childId) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT);
  const summaries = entries.items.filter((entry) => entry.kind === "pi.compaction");
  assert.equal(summaries.length, 1, "one placed summary: " + JSON.stringify(entries.items.map((entry) => entry.kind)));
  const admissions = entries.items.slice(entries.items.indexOf(summaries[0]!)).filter((entry) => entry.kind === "pi.user");
  assert.equal(admissions.length, 1, "exactly one admission after the summary: " + JSON.stringify(admissions.map((entry) => String(entry.id))));
  // A second retry of the same failure is the same retry: the failed attempt's id is already the one named, so nothing
  // new is created and no third attempt starts.
  await retry();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await childTasks()).filter((task) => task.kind === "pi.compaction").length, 2, "replaying the retry asked for nothing more");
});

test("a SIGKILL between the preparation commit and the admission resumes one child and admits it once", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-crash-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, root, home, "prepare"], { encoding: "utf8" });
  // SIGKILL is the only acceptable exit: a clean exit would mean the window was never reached.
  assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
  const factsLine = killed.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1);
  assert.ok(factsLine !== undefined, "the stage stated its facts: " + killed.stdout);
  const facts = JSON.parse(factsLine) as { parentId: string; childId: string; checkpoint: string; admissionDurable: boolean; compactionTaskId?: string };
  assert.equal(facts.checkpoint, "preparation-started");
  // The fact this window claims is read from the publication: the preparation task was created, and the child had no
  // submission yet. So the kill is strictly between "preparation committed" and "task text admitted".
  assert.equal(facts.admissionDurable, false, factsLine);
  assert.ok(facts.compactionTaskId !== undefined, factsLine);

  // Reopen the same store and resume. The anchor reads the compaction task it already created and continues from its
  // durable outcome instead of compacting again.
  const crash: CrashHarness = await openCrashHarness(dbPath, {
    root,
    home,
    settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } },
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as unknown as Transcript;
        const first = messages[0];
        const isCompaction = first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant");
        if (isCompaction) return fauxAssistantMessage("## Goal\nresumed summary");
        if (lastUserText(messages).includes("crash work")) return fauxAssistantMessage("child answer");
        return fauxAssistantMessage("parent done");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());
  const entries = (id: string): Promise<readonly EntryRecord[]> =>
    crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT).then((page) => page.items);
  const deadline = Date.now() + 30_000;
  let childEntries: readonly EntryRecord[] = [];
  while (Date.now() < deadline) {
    childEntries = await entries(facts.childId);
    if (childEntries.some((entry) => JSON.stringify(entry.model ?? "").includes("child answer"))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // One child, one summary, one admission, one answer: the resumed preparation placed its summary and the anchor
  // admitted the same dispatch's task text exactly once. The entries the child inherited from the parent are before the
  // summary, so the admission is counted from the summary onwards.
  const kinds = childEntries.map((entry) => entry.kind);
  const summaries = childEntries.filter((entry) => entry.kind === "pi.compaction");
  assert.equal(summaries.length, 1, JSON.stringify(kinds));
  const afterSummary = childEntries.slice(childEntries.indexOf(summaries[0]!));
  const admissions = afterSummary.filter((entry) => entry.kind === "pi.user");
  assert.equal(admissions.length, 1, "exactly one admission after the summary: " + JSON.stringify(afterSummary.map((entry) => entry.kind)));
  assert.match(JSON.stringify(admissions[0]!.model ?? ""), /crash work/, "the admitted entry is the delegation's task text");
  assert.equal(childEntries.filter((entry) => JSON.stringify(entry.model ?? "").includes("child answer")).length, 1, "the child answered once: " + JSON.stringify(kinds));
  const children = await crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(facts.parentId) as ConversationId }, 10, undefined), BACKGROUND_CONTEXT);
  assert.equal(children.items.length, 1, "one child for the one delegation");
});

/**
 * The preparation is committed before the task is admitted, so a store reopened **paused** in the middle of one must
 * show exactly that: a live preparation, and no submission and no model request of the child's own. Resuming is what
 * admits the task, and it does so once.
 */
test("a store reopened paused while a preparation is live has no child submission and no child model request", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-paused-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, root, home, "prepare"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
  const facts = JSON.parse(killed.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!) as { parentId: string; childId: string; compactionTaskId?: string };

  const requests: string[] = [];
  const crash: CrashHarness = await openCrashHarness(dbPath, {
    root,
    home,
    // Paused: nothing runs until this fixture says so, which is what makes the facts below a statement about the
    // committed store rather than about a scheduler that happened not to have run yet.
    startPaused: true,
    settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } },
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        requests.push(lastUserText(transcript.messages as unknown as Transcript));
        return fauxAssistantMessage("paused answer");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());
  const entries = (id: string): Promise<readonly EntryRecord[]> =>
    crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT).then((page) => page.items);
  const childEntries = await entries(facts.childId);
  // No submission was admitted for the child, and its own history carries no task text: the delegation's task has not
  // reached it. The preparation task, by contrast, is durable and still live.
  const admission = await crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(facts.childId) as ConversationId }, 50, undefined), BACKGROUND_CONTEXT);
  assert.equal(childEntries.some((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model ?? "").includes("crash work")), false, JSON.stringify(childEntries.map((entry) => entry.kind)));
  assert.equal(admission.items.length, childEntries.length);
  const compaction = await crash.harness.harness.getTask(Number(facts.compactionTaskId) as never, BACKGROUND_CONTEXT);
  assert.ok(compaction !== undefined, "the preparation task is durable");
  assert.equal(compaction.state.status === "terminal", false, "the preparation is still live, not finished");
  // Nothing ran: a paused harness makes no model request at all, so the child's model was never asked anything.
  assert.deepEqual(requests, [], JSON.stringify(requests));
});

/**
 * A user stop that arrives while the child is being prepared is the user's own decision about the **child**, and the
 * preparation completing afterwards cannot undo it: the task text is admitted into a held conversation, so it waits for
 * the user's explicit continue instead of starting a run behind their back (spec D07, D08, D11).
 */
test("a user stop during preparation survives the preparation and the admission", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-prep-held-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeDefinition(root, "preparer", "---\nname: preparer\ndescription: preparer\nmodel: faux/faux-1\ntools:\n  - read\ncontext: compact\n---\n\nbody\n");
  let releaseSummarizer: (() => void) | undefined;
  const summarizerGate = new Promise<void>((resolve) => { releaseSummarizer = resolve; });
  const childWork: string[] = [];
  const fixture = await startLocal(t, join(base, "hepi.sqlite"), root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      const first = messages[0];
      const isCompaction = first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant");
      // The summarizer is held open, which is what makes the stop arrive *during* the preparation rather than after it.
      if (isCompaction) {
        await summarizerGate;
        return fauxAssistantMessage("## Goal\nheld summary");
      }
      if (lastUserText(messages).includes("child task")) {
        childWork.push(lastUserText(messages));
        return fauxAssistantMessage("child answer");
      }
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "preparer", task: "child task" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  });
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  await turn(fixture, parent.id, "parent-turn-1", "parent done");

  // The child exists and is being prepared. Stop it while the summarizer is still held.
  const child = await childOf(fixture, parent.id);
  const stopped = await fetch(fixture.origin + "/api/conversations/" + child.id + "/stop", { method: "POST", headers, body: JSON.stringify({ requestId: "held-stop" }) });
  const stopAnswer = await read<{ status: string; control: { state: string } }>(stopped, 202);
  assert.equal(stopAnswer.control.state, "held", JSON.stringify(stopAnswer));

  // The preparation finishes now, and the anchor admits the task text. Both are model-visible, so a held conversation
  // places neither: the summary and the task text are queued, in that order, and the child's model is not asked.
  releaseSummarizer?.();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(childWork, [], "no child work request while the user holds the conversation");
  const heldHistory = await history(fixture, child.id);
  assert.equal(heldHistory.includes("held summary"), false, "a held conversation places no model-visible write: " + heldHistory.slice(0, 2000));
  const control = await read<{ control: { state: string } }>(await fetch(fixture.origin + "/api/conversations/" + child.id + "/control", { headers }), 200);
  assert.equal(control.control.state, "held");

  // The user's explicit continue is what runs it, once, and the preparation's summary is placed **before** the task
  // text, because a boundary places the held period's writes before its inputs.
  const resumed = await fetch(fixture.origin + "/api/conversations/" + child.id + "/continue", { method: "POST", headers, body: JSON.stringify({ requestId: "held-continue" }) });
  assert.equal((await read<{ status: string }>(resumed, 202)).status, "resumed");
  await waitForHistory(fixture, child.id, (text) => text.includes("child answer"), "the child's answer");
  const resumedHistory = await history(fixture, child.id);
  assert.ok(resumedHistory.indexOf("held summary") < resumedHistory.indexOf("child answer"), "the summary precedes the work");
  assert.deepEqual(childWork, ["child task"], "the held task text ran exactly once, after the user's continue");
});
