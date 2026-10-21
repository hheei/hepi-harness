/**
 * Ticket 13's combined multi-session acceptance: the relations of A02, the inherited execution binding of A15, and the
 * independent branch of A17, all in one session of real work.
 *
 * Each owning ticket proved its own slice (03 the relations, 06 the child's binding and limits, 11 the branch and the raw
 * history, 12 the Web adapter). What none of them could state is the combination the acceptance table asks for: one
 * parent, an independent main conversation it also created, a child of that parent, and a branch of that child, with
 * every edge read back after the work has run — and the child's execution binding inherited through a **retained**
 * workspace, which is the one binding shape nothing exercised for a delegated child.
 *
 * Every assertion reads the product's own answer: the by-id relations projection, the catalogue rows, the child's own
 * transcript, the native owner edge and the real file the child's tool wrote on its host (spec D03, D12, D14, A02, A15,
 * A17).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry, WorkspaceServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createProjectStore } from "../src/project-store.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const TOKEN = "acceptance-multisession-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Row = {
  id: string; workspaceId: string | null; gatewayId?: string | null; createdBy?: string; displayParentId?: string;
  displayParentDeleted?: boolean; parentConversationId?: string; subagentParentConversationId?: string;
  runStatus?: { state: string; reason?: string }; extensions?: readonly string[];
};
type Info = {
  conversation: Row;
  relations: { createdBy?: string; displayParentId?: string; provenance?: { origin?: string; definition?: { hostId: string; scope: string; name: string }; context?: { strategy: string; sourceConversationId?: string; sourceEntryId?: string } } };
  owner?: { conversationId: string; taskId: string };
  forkSource?: { conversationId: string; at: string };
  displayParentDeleted?: boolean;
  config: { model: { provider: string; modelId: string } | null; tools: string[]; extensions: string[] };
};
type State = { entries: { id: string; role: string; text: string; message?: { toolName?: string; isError?: boolean } }[]; toolNames: string[]; busy: boolean; control: { state: string } };
type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
};
const hasToolResult = (messages: Transcript, name: string): boolean => messages.some((message) => message.role === "toolResult" && message.toolName === name);
/** Whether this transcript already carries the result of **one particular** call, which tells one round from the next. */
const hasNamedToolResult = (messages: Transcript, name: string, callId: string): boolean =>
  messages.some((message) => message.role === "toolResult" && message.toolName === name && JSON.stringify(message.content ?? "").includes(callId));

async function read<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

test("one parent, a separate main conversation, a child and a branch keep every relation separate, and the child runs on the retained binding it inherited", { timeout: 120_000 }, async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-acceptance-multi-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n");
  await writeFile(join(root, "evidence.txt"), "the child really ran here");

  // One local execution host and one Project folder on it. The Project is then **removed**, which is what turns its
  // workspace id into a retained binding: the shape a conversation bound before the removal keeps.
  const registry = new WorkspaceRegistry([]);
  const identity = { user: "operator", home };
  const gateway = new GatewayRpcServer(
    new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }),
    undefined,
    new LocalFilesystem(registry, { identity }),
    undefined,
    new WorkspaceServer(registry, { identity }),
  );
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(() => { gateway.server.closeAllConnections(); return gateway.close(); });

  const projects = createProjectStore({ path: join(base, "projects.sqlite") });
  t.after(() => projects.close());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const backend: BackendServer = await createBackendServer({
    dbPath: join(base, "hepi.sqlite"), authToken: TOKEN, models, defaultModel: SERVER_MODEL,
    gateways: [{ gatewayId: "workstation", gatewayOrigin: origin, gatewayToken: "gateway-token" }],
    projects,
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  const api = "http://127.0.0.1:" + serverAddress.port;
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); });

  const created = await read<{ project: { id: string; folders: { id: string; workspaceId: string; root: string }[]; defaultFolderId: string } }>(
    await fetch(api + "/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Retained", hostId: "workstation", folders: [{ root, default: true }] }) }), 201,
  );
  const folder = created.project.folders.find((candidate) => candidate.root === root)!;
  const workspaceId = folder.workspaceId;

  const createConversation = async (body: Record<string, unknown> = {}): Promise<Row> =>
    (await read<{ conversation: Row }>(await fetch(api + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId, ...body }) }), 201)).conversation;
  const state = async (id: string): Promise<State> => (await read<State>(await fetch(api + "/api/conversations/" + id + "/state", { headers }), 200));
  const info = async (id: string): Promise<Info> => (await read<Info>(await fetch(api + "/api/conversations/" + id, { headers }), 200));
  const catalogue = async (query = ""): Promise<{ conversations: Row[] }> => (await read<{ conversations: Row[] }>(await fetch(api + "/api/conversations" + query, { headers }), 200));
  const enable = async (id: string): Promise<void> => {
    await read<{ extensions: string[] }>(await fetch(api + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) }), 200);
  };
  /** Poll a conversation's transcript until it carries the answer a script produced. */
  const waitForAnswer = async (id: string, expected: string, timeoutMs = 60_000): Promise<State> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state(id);
      if (current.entries.some((entry) => entry.role === "assistant" && entry.text === expected)) return current;
      if (Date.now() > deadline) throw new Error("no answer " + JSON.stringify(expected) + " in " + id + ": " + JSON.stringify(current.entries.map((entry) => entry.text)));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const say = async (id: string, requestId: string, text: string, expected: string): Promise<State> => {
    await read<unknown>(await fetch(api + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) }), 202);
    return await waitForAnswer(id, expected);
  };

  const parent = await createConversation();
  await enable(parent.id);
  let childId = "";
  // One controlled model for every conversation, so each answer is chosen from the transcript it answers: the child's
  // own task, the parent's delegating turn, the second conversation's delegating turn, and a report's wake.
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as unknown as Transcript;
    const task = lastUserText(messages);
    if (task === "read the evidence") {
      return hasToolResult(messages, "read")
        ? fauxAssistantMessage("child read it")
        : fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" }, { id: "call-read" })], { stopReason: "toolUse" });
    }
    if (task.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw a report");
    if (task === "delegate now") {
      return hasToolResult(messages, "agent_spawn")
        ? fauxAssistantMessage("delegated")
        : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "read the evidence" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    // A second delegation of the same parent, under its own call id so it is a new dispatch rather than a replay. The
    // transcript already carries the first turn's tool result, so the test is this call's own result, not any result.
    if (task === "delegate again now") {
      return hasNamedToolResult(messages, "agent_spawn", "call-spawn-2")
        ? fauxAssistantMessage("delegated again")
        : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "read the evidence" }, { id: "call-spawn-2" })], { stopReason: "toolUse" });
    }
    if (task === "delegate to a new main") {
      return hasToolResult(messages, "agent_spawn")
        ? fauxAssistantMessage("other delegated")
        : fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "read the evidence" }, { id: "call-other" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("idle");
  };
  faux.setResponses([respond]);

  // 1. The parent delegates, and the child runs a real tool on its own host.
  await say(parent.id, "multi-turn-1", "delegate now", "delegated");
  const children = await catalogue("?createdBy=" + parent.id);
  assert.equal(children.conversations.length, 1, JSON.stringify(children.conversations));
  childId = children.conversations[0]!.id;
  const childAfterRun = await waitForAnswer(childId, "child read it");
  // The child inherited the parent's execution binding, and its tool really read the file on that host.
  assert.equal(childAfterRun.entries.some((entry) => entry.role === "toolResult" && entry.text.includes("the child really ran here")), true, JSON.stringify(childAfterRun.entries.map((entry) => entry.text.slice(0, 80))));
  const childRow = (await catalogue()).conversations.find((row) => row.id === childId)!;
  assert.equal(childRow.workspaceId, workspaceId, "the child is bound to the parent's own workspace");
  assert.equal(childRow.gatewayId, "workstation", "and to the host that workspace lives on");
  const childInfo = await info(childId);
  assert.equal(childInfo.relations.provenance?.definition?.hostId, "workstation");

  // 2. A second, **separate main conversation** the parent also creates: it has a creator and a native owner, and no
  //    display parent, so it is a main conversation of its own rather than a child shown under the parent.
  const other = await createConversation();
  await enable(other.id);
  await say(other.id, "multi-turn-2", "delegate to a new main", "other delegated");
  const otherChild = (await catalogue("?createdBy=" + other.id)).conversations[0]!;
  assert.notEqual(otherChild.id, childId, "the second main conversation created its own child");
  const otherChildInfo = await info(otherChild.id);
  assert.equal(otherChildInfo.relations.createdBy, other.id);
  assert.equal(otherChildInfo.relations.displayParentId, other.id);
  assert.equal(otherChildInfo.owner?.conversationId, other.id);

  // 3. The parent's child keeps its own relations when another conversation acts on it: a dispatch changes no edge.
  const beforeBorrow = await info(childId);
  // A dispatch to a conversation that already exists answers 202 (it is one more admission, not a creation).
  const borrowed = await fetch(api + "/api/conversations/" + other.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: "worker", task: "read the evidence", requestId: "multi-borrow-1", conversationId: childId }) });
  await read<unknown>(borrowed, 202);
  await waitForAnswer(childId, "child read it");
  const afterBorrow = await info(childId);
  assert.deepEqual(afterBorrow.relations, beforeBorrow.relations, "a cross-conversation dispatch changed no relation");
  assert.deepEqual(afterBorrow.owner, beforeBorrow.owner, "and no owner edge");
  assert.equal(afterBorrow.conversation.workspaceId, beforeBorrow.conversation.workspaceId);

  // 4. The Project is removed: its workspace id becomes a **retained** binding. The conversations bound to it keep
  //    running there, and the child's inherited binding is the retained one.
  const removed = await fetch(api + "/api/projects/" + encodeURIComponent(created.project.id), { method: "DELETE", headers: { ...headers, "x-hepi-gateway-id": "workstation" } });
  assert.equal(removed.status, 200, await removed.clone().text());
  const workspaces = await read<{ workspaces: { id: string; retained?: true; workspaceRoot: string }[] }>(await fetch(api + "/api/workspaces", { headers }), 200);
  assert.equal(workspaces.workspaces.find((workspace) => workspace.id === workspaceId)?.retained, true, "the workspace id is now a retained binding");
  // The child answers again on the retained binding, which is the point: a removal does not strand a delegated child.
  // The callback id is the model's, so the second delegation needs its own call: the third turn repeats the first one's
  // transcript shape, and a replay of an existing call id would be answered from the record rather than create anything.
  const thirdTurn = await fetch(api + "/api/conversations/" + parent.id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "multi-turn-3", text: "delegate again now" }) });
  assert.equal(thirdTurn.status, 202, await thirdTurn.clone().text());
  const delegatedAgain = await waitForAnswer(parent.id, "delegated again");
  const thirdResults = delegatedAgain.entries.filter((entry) => entry.role === "toolResult" && entry.message?.toolName === "agent_spawn");
  assert.equal(thirdResults.at(-1)?.message?.isError === true, false, "the third delegation was accepted: " + JSON.stringify(thirdResults.at(-1)?.text));
  const secondChild = (await catalogue("?createdBy=" + parent.id)).conversations.find((row) => row.id !== childId)!;
  assert.notEqual(secondChild, undefined, "the retained binding still admits a new delegation: " + JSON.stringify(await catalogue("?createdBy=" + parent.id)));
  assert.equal(secondChild.workspaceId, workspaceId);
  const secondState = await waitForAnswer(secondChild.id, "child read it");
  assert.equal(secondState.entries.some((entry) => entry.role === "toolResult" && entry.text.includes("the child really ran here")), true, "the new child really ran on the retained binding");
  const secondInfo = await info(secondChild.id);
  assert.equal(secondInfo.config.model?.modelId, SERVER_MODEL.modelId, "the definition's own model snapshot travelled to the child");

  // 5. A branch of the first child: its own owner and control, the child as its display parent and fork source.
  const branchCreated = await read<{ conversationId: string }>(await fetch(api + "/api/conversations/" + childId + "/fork", { method: "POST", headers, body: JSON.stringify({ requestId: "multi-fork-1" }) }), 201);
  const branchInfo = await info(branchCreated.conversationId);
  assert.equal(branchInfo.relations.displayParentId, childId, "the branch is displayed under the child");
  assert.equal(branchInfo.relations.createdBy, childId, "the child is its creator");
  assert.notEqual(branchInfo.owner?.taskId, childInfo.owner?.taskId, "the branch has its own native owner, not the child's");
  assert.equal(branchInfo.owner?.conversationId, childId, "and that owner is a task of the child's own scope");
  assert.equal(branchInfo.forkSource?.conversationId, childId, "the fork source is the child it branched from");
  assert.equal(branchInfo.conversation.workspaceId, workspaceId, "the branch keeps the retained binding too");
  // The branch inherited no work: it is idle, and it is not a delegation the parent is still waiting on.
  const branchState = await state(branchCreated.conversationId);
  assert.equal(branchState.busy, false);
  assert.equal(branchState.control.state, "allowed");

  // 6. Removing the parent hides it without promoting or cascading to the child or the branch.
  assert.equal((await fetch(api + "/api/conversations/" + parent.id, { method: "DELETE", headers })).status, 200);
  const childAfterRemoval = await info(childId);
  assert.equal(childAfterRemoval.relations.displayParentId, parent.id, "the child keeps its display parent");
  assert.equal(childAfterRemoval.displayParentDeleted, true, "and states that parent is hidden");
  assert.deepEqual((await state(childId)).entries.filter((entry) => entry.role === "user").map((entry) => entry.text).slice(0, 1), ["read the evidence"], "the child's history is intact");
  const branchAfterRemoval = await info(branchCreated.conversationId);
  assert.equal(branchAfterRemoval.relations.displayParentId, childId, "the branch still hangs under the live child");
  assert.equal(branchAfterRemoval.displayParentDeleted, false);
});
