/**
 * The approved G2/G6 surface at its public seam, as **acceptance** evidence: a client reads one delegated child's
 * recovery facts per durable object, and asks for the retry of a failed preparation with the identities that read
 * returned.
 *
 * Every assertion reads an HTTP answer — `GET`/`POST /api/conversations/:id/recovery`, the catalogue row, the child's
 * own history — over the production backend, a real local execution host, real anchor/reporter/compaction tasks and a
 * controlled model. That is why this file is acceptance-only and is **not** part of the package's ordinary `test`
 * selection: it opens its own SQLite file and temporary workspace, listens on loopback, and waits for real task
 * progress against a wall-clock deadline (`poll`). The ordinary profile states the same projection over the records
 * themselves in `child-recovery-projection.test.ts`; nothing here is claimed as a deterministic run.
 *
 * The two cases are the ticket's acceptance, stated as ordinary facts:
 *
 * - **G2** — a normal failed preparation and a normal pending report are each visible as their object's own state, so a
 *   reporter waiting on a running child is not flattened into the child's one `runStatus`, and a parked preparation is
 *   not `idle` as if nothing were pending.
 * - **G6** — the retry is the seam's existing one: same child, same dispatch/request identity, the failed attempt's own
 *   task id, no second admission, and no automatic attempt. A request that names a different attempt is refused by name.
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

const TOKEN = "child-recovery-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Row = { id: string; runStatus?: { state: string }; workspaceId: string | null };
type Recovery = {
  requestId?: string;
  definition?: string;
  preparationStrategy?: string;
  preparation?: string;
  preparationFailedTaskId?: string;
  preparationRetriedTaskId?: string;
  preparationError?: string;
  preparationOutcome?: string;
  anchorPhase?: string;
  delivery?: string;
  childSubmissionStatus?: string;
};
type RecoveryAnswer = { conversationId: string; recovery: Recovery | null };
type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

type Fixture = { readonly origin: string; readonly backend: BackendServer; readonly faux: ReturnType<typeof fauxProvider>; close(): Promise<void> };

/** A real backend over a test-owned SQLite file, a real local execution host and the scripted model. */
async function startLocal(t: TestContext, root: string, home: string, respond: (faux: ReturnType<typeof fauxProvider>) => void): Promise<Fixture> {
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
  respond(faux);
  const backend = await createBackendServer({
    dbPath: join(root, "..", "hepi.sqlite"),
    authToken: TOKEN,
    models,
    defaultModel: SERVER_MODEL,
    workspaces: [binding],
    // The preparation is a real compaction, so the policy must make a short parent history compactable.
    settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); });
  return { origin: "http://127.0.0.1:" + serverAddress.port, backend, faux, close: async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); } };
}

async function read<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  assert.equal(response.status, status, body);
  return JSON.parse(body) as T;
}

/** Poll a real condition, so a loaded machine races no fixed sleep. */
async function poll<T>(accept: () => Promise<T | undefined>, description: string, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await accept();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const createConversation = async (fixture: Fixture, body: Record<string, unknown> = {}): Promise<Row> =>
  (await read<{ conversation: Row }>(await fetch(fixture.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local", ...body }) }), 201)).conversation;

async function enableSubagents(fixture: Fixture, id: string): Promise<void> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  assert.deepEqual((await read<{ extensions: string[] }>(response, 200)).extensions, ["coding-tools", "hepi-subagents"]);
}

const recoveryOf = async (fixture: Fixture, id: string): Promise<Recovery | null> =>
  (await read<RecoveryAnswer>(await fetch(fixture.origin + "/api/conversations/" + id + "/recovery", { headers }), 200)).recovery;

const retryRecovery = (fixture: Fixture, id: string, body: Record<string, unknown>) =>
  fetch(fixture.origin + "/api/conversations/" + id + "/recovery", { method: "POST", headers, body: JSON.stringify(body) });

const historyOf = async (fixture: Fixture, id: string): Promise<string> => {
  const answer = await read<{ output: readonly { type: string; text?: string }[] }>(await fetch(fixture.origin + "/api/conversations/" + id + "/read?limit=500", { headers }), 200);
  return answer.output.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
};

/** One parent with a delegated child, over the route the Web's quick create uses. */
async function delegated(fixture: Fixture, definition: string, requestId: string): Promise<{ parent: Row; child: string }> {
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: definition, task: "child work", requestId }) }),
    201,
  );
  return { parent, child: created.childConversationId };
}

/**
 * The same delegation from a parent that **has** history: a `compact` definition summarizes the delegating
 * conversation's own entries, so the ordinary workflow gives it one turn first. Nothing here shortcuts the seam — it is
 * the same route and the same admission a user's composer makes.
 */
async function delegatedAfterTurn(fixture: Fixture, definition: string, requestId: string): Promise<{ parent: Row; child: string }> {
  const parent = await createConversation(fixture);
  await enableSubagents(fixture, parent.id);
  await read<unknown>(await fetch(fixture.origin + "/api/conversations/" + parent.id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "parent-turn", text: "parent question" }) }), 202);
  await poll(async () => ((await historyOf(fixture, parent.id)).includes("parent idle") ? true : undefined), "the parent's own answer", 8_000);
  const created = await read<{ childConversationId: string }>(
    await fetch(fixture.origin + "/api/conversations/" + parent.id + "/delegate", { method: "POST", headers, body: JSON.stringify({ name: definition, task: "child work", requestId }) }),
    201,
  );
  return { parent, child: created.childConversationId };
}

async function workspace(t: TestContext, prefix: string, definitions: Record<string, string>): Promise<{ root: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "hepi-child-recovery-" + prefix + "-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, body] of Object.entries(definitions)) await writeFile(join(root, ".pi", "agents", name + ".md"), body);
  return { root, home };
}

const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
};
const isSummarizer = (messages: Transcript): boolean => {
  const first = messages[0];
  return first !== undefined && first.role === "system" && JSON.stringify(first.content ?? "").includes("context summarization assistant");
};

test("a normal failed preparation is stated as the delegation's own fact, and the retry under the same identities prepares the same child once", async (t) => {
  const { root, home } = await workspace(t, "preparation", {
    flaky: "---\nname: flaky\ndescription: flaky\nmodel: faux/faux-1\ntools:\n  - read\ncontext: compact\n---\n\nRetry then work.\n",
  });
  let attempts = 0;
  const childRuns: string[] = [];
  const fixture = await startLocal(t, root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      if (isSummarizer(messages)) {
        attempts += 1;
        // A tool call is not a summary, so the native compaction settles failed with its own named reason.
        return attempts === 1
          ? fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })
          : fauxAssistantMessage("## Goal\nretried summary");
      }
      if (lastUserText(messages).includes("child work")) {
        childRuns.push(lastUserText(messages));
        return fauxAssistantMessage("child answer");
      }
      return fauxAssistantMessage("parent idle");
    };
    faux.setResponses([respond]);
  });

  const { parent, child } = await delegatedAfterTurn(fixture, "flaky", "parent:attempt-1");

  // The failure is the **dispatch's** fact, read per object: the record states the failed attempt and the runtime's own
  // reason, and the anchor's phase says the preparation is what is parked. The child's one `runStatus` says none of it.
  const failed = await poll(async () => {
    const facts = await recoveryOf(fixture, child);
    return facts !== null && facts.preparation === "unretried-failure" ? facts : undefined;
  }, "the recovery read to state the failed preparation");
  assert.equal(failed.preparationStrategy, "compact");
  assert.equal(failed.preparationOutcome, "failed", "the native outcome the attempt reached");
  assert.match(String(failed.preparationError), /tool/i, "the runtime's own reason, not a sentence this build invented");
  assert.equal(failed.anchorPhase, "preparing", "the anchor of this dispatch is the object parked on the failure");
  assert.ok(failed.preparationFailedTaskId !== undefined && failed.preparationFailedTaskId !== "", "the failed attempt names itself");
  assert.equal(failed.requestId, "parent:attempt-1", "the dispatch identity is the caller's request identity, unchanged");
  assert.equal(failed.delivery, undefined, "no reporter exists yet, so nothing is claimed about a report");
  const childRow = await read<{ conversation: Row }>(await fetch(fixture.origin + "/api/conversations/" + child, { headers }), 200);
  assert.equal(childRow.conversation.runStatus?.state, "idle", "the child's own status stays the child's own fact");
  assert.equal((await historyOf(fixture, child)).includes("child work"), false, "the task text was never admitted");

  // A request naming a **different** attempt is refused by name rather than retried into it, and it changes nothing.
  const stale = await read<{ code: string; error: string }>(await retryRecovery(fixture, child, { requestId: failed.requestId, failedTaskId: "999999" }), 409);
  assert.equal(stale.code, "identity_stale");
  assert.equal(attempts, 1, "a refused request prepared nothing");

  // The retry: the two identities this read itself returned, and nothing else.
  const retried = await read<{ recovery: Recovery }>(
    await retryRecovery(fixture, child, { requestId: failed.requestId, failedTaskId: failed.preparationFailedTaskId }),
    200,
  );
  assert.equal(retried.recovery.preparation, "retried");
  assert.equal(retried.recovery.preparationRetriedTaskId, failed.preparationFailedTaskId, "the write names the failed attempt it was told about");
  assert.equal(retried.recovery.requestId, failed.requestId, "no fresh identity was minted");

  // Asking again is asking once: the record already names that attempt as retried.
  const twice = await read<{ code: string }>(await retryRecovery(fixture, child, { requestId: failed.requestId, failedTaskId: failed.preparationFailedTaskId }), 409);
  assert.equal(twice.code, "already_retried");

  // The parked anchor wakes on the durable write and prepares the **same** child, then admits the task once.
  await poll(async () => ((await historyOf(fixture, child)).includes("child answer") ? true : undefined), "the same child to answer", 8_000);
  assert.equal(attempts, 2, "exactly one more preparation attempt: the one the retry asked for");
  assert.deepEqual(childRuns, ["child work"], "the task text ran once, after the preparation succeeded");
  const listing = await read<{ conversations: Row[] }>(await fetch(fixture.origin + "/api/conversations?createdBy=" + parent.id, { headers }), 200);
  assert.equal(listing.conversations.length, 1, "the retry created no second child: " + JSON.stringify(listing.conversations.map((row) => row.id)));
});

test("a report its child has not finished is the reporter's own fact, stated beside the child's status and never merged into it", async (t) => {
  const { root, home } = await workspace(t, "delivery", {
    worker: "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n",
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let holding = true;
  // Registered before the fixture's own teardown, so it runs **after** nothing that could wait on it: a failed
  // assertion must never leave a child's run held behind a closing backend.
  t.after(() => { holding = false; release(); });
  const fixture = await startLocal(t, root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as unknown as Transcript;
      if (lastUserText(messages).includes("child work")) {
        if (holding) await gate;
        return fauxAssistantMessage("child answer");
      }
      return fauxAssistantMessage("parent idle");
    };
    faux.setResponses([respond]);
  });
  const { child } = await delegated(fixture, "worker", "parent:dispatch-live");

  // While the child is at work its reporter is waiting on it: two statements, one per object, from one read.
  const live = await poll(async () => {
    const facts = await recoveryOf(fixture, child);
    return facts?.delivery === "waiting-child" && facts.anchorPhase === "idle" ? facts : undefined;
  }, "the reporter of the dispatch to be waiting on the child", 8_000);
  assert.equal(live.definition, "worker");
  assert.equal(live.requestId, "parent:dispatch-live");
  assert.equal(live.preparation, undefined, "a fresh-context delegation has no preparation state to claim");
  const running = await read<{ conversation: Row }>(await fetch(fixture.origin + "/api/conversations/" + child, { headers }), 200);
  assert.equal(running.conversation.runStatus?.state, "running", "the child's own status is its own fact, not the report's");

  // Settle the child and let the report reach its creator: the delivery is the report record's receipt.
  holding = false;
  release();
  const settled = await poll(async () => {
    const facts = await recoveryOf(fixture, child);
    return facts?.delivery === "delivered" ? facts : undefined;
  }, "the report to be delivered", 8_000);
  assert.equal(settled.childSubmissionStatus, "done", "the child's own settlement, as the reporter recorded it");

  // A retry offered here would be a retry of nothing: the delegation states no failed preparation.
  const refused = await read<{ code: string }>(await retryRecovery(fixture, child, { requestId: settled.requestId ?? "parent:dispatch-live", failedTaskId: "1" }), 409);
  assert.equal(refused.code, "not_failed");
});

test("a conversation with no delegation states no recovery facts, and the child of a delegation is addressed by its own id", async (t) => {
  const { root, home } = await workspace(t, "plain", {
    worker: "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nbody\n",
  });
  const fixture = await startLocal(t, root, home, (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      return fauxAssistantMessage("answer: " + lastUserText(transcript.messages as unknown as Transcript));
    };
    faux.setResponses([respond]);
  });

  const plain = await createConversation(fixture);
  assert.equal(await recoveryOf(fixture, plain.id), null, "an ordinary conversation is no delegation's child");
  const refusal = await read<{ code: string }>(await retryRecovery(fixture, plain.id, { requestId: "x", failedTaskId: "1" }), 409);
  assert.equal(refusal.code, "not_a_delegation", "the refusal names the fact that is missing");
  // An id this process holds no conversation for is refused by the shared conversation guard, before any action runs:
  // one refusal vocabulary for "no such conversation", whichever route asked.
  const malformed = await read<{ code: string }>(await retryRecovery(fixture, "999999", { requestId: "x", failedTaskId: "1" }), 404);
  assert.equal(malformed.code, "not_found");

  const { child } = await delegated(fixture, "worker", "parent:dispatch-plain");
  const facts = await poll(async () => {
    const readBack = await recoveryOf(fixture, child);
    return readBack?.requestId === undefined ? undefined : readBack;
  }, "the child's own recovery facts");
  assert.equal(facts.requestId, "parent:dispatch-plain", "the facts are the child's, read at the child's own address");
  // A delegation's facts belong to the child it describes: the delegating conversation still states none of its own.
  assert.equal(await recoveryOf(fixture, plain.id), null);
});
