import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { ConversationOperationRefusal, createConversationOperations, WorkspaceDoc } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

/**
 * Ticket 03's observable behavior, through the two public seams it names: the core ConversationOperations create/get
 * seam, and the create/get/catalogue/reference HTTP routes above it. The tests read the fields a relation consumer
 * reads — who created a conversation, where it is displayed, from where it forked, who owns it, and what it references
 * — and never assert on a helper's internal structure (spec D03, acceptance A02/A22).
 */

const directories: string[] = [];
const token = "relations-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function listen(backend: BackendServer): Promise<string> {
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}

type Row = { id: string; createdBy?: string; displayParentId?: string; displayParentDeleted?: boolean; parentConversationId?: string; subagentParentConversationId?: string };
type Info = {
  conversation: Row;
  relations: { createdBy?: string; displayParentId?: string };
  references: { conversationId: string; entryId?: string; label?: string }[];
  config: Record<string, unknown>;
  displayParentDeleted: boolean;
};

async function create(origin: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (await JSON.parse(text) as { conversation: Row }).conversation;
}

async function info(origin: string, id: string): Promise<Info> {
  const response = await fetch(origin + "/api/conversations/" + id, { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return await JSON.parse(text) as Info;
}

async function catalogue(origin: string, query = ""): Promise<{ conversations: Row[]; nextCursor?: string }> {
  const response = await fetch(origin + "/api/conversations" + query, { headers });
  assert.equal(response.status, 200);
  return await response.json() as { conversations: Row[]; nextCursor?: string };
}

const refer = (origin: string, id: string, body: Record<string, unknown>) =>
  fetch(origin + "/api/conversations/" + id + "/references", { method: "POST", headers, body: JSON.stringify(body) });

test("core spawn dedupes one request identity and keeps creator, display parent and owner separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-core-"));
  directories.push(directory);
  const harness = await openServerHarness(join(directory, "core.sqlite"), SERVER_MODEL, fauxModels());
  try {
    const operations = createConversationOperations(harness.harness);
    const creator = await operations.spawn({ requestId: "creator", ownership: { kind: "ownerless" } });
    const independent = await operations.spawn({ requestId: "b", ownership: { kind: "ownerless" }, createdBy: creator.conversationId, workspaceId: "w-1" });
    // A second call with the same request identity answers the conversation the first call created, not a second one.
    const replay = await operations.spawn({ requestId: "b", ownership: { kind: "ownerless" }, createdBy: creator.conversationId });
    assert.equal(replay.conversationId, independent.conversationId);
    assert.equal(replay.created, false);
    // The independent conversation records its creator but has no display parent: it is a conversation of its own.
    const relations = await operations.relations(independent.conversationId);
    assert.deepEqual(relations, { createdBy: creator.conversationId });
    // The native record states no task owner for it, so the creator is an ordinary relation and not the ownership edge.
    const info = await operations.get(independent.conversationId);
    assert.equal(info?.owner, undefined, "native task ownership is a different edge from the creator, and this one has none");
    // The execution binding is written in the same commit as the creation, not by a later attach: the environment
    // resolver reads exactly this document before the conversation can run anything.
    assert.equal((await harness.harness.snapshot(WorkspaceDoc, Number(independent.conversationId) as ConversationId, BACKGROUND_CONTEXT))?.workspaceId, "w-1");
    // An identity that names no conversation is refused, so a broken relation is never stored.
    await assert.rejects(
      () => operations.spawn({ requestId: "ghost-creator", ownership: { kind: "ownerless" }, createdBy: "999999" }),
      (error: unknown) => error instanceof ConversationOperationRefusal && error.code === "unknown_creator",
    );
    await assert.rejects(
      () => operations.spawn({ requestId: "ghost-parent", ownership: { kind: "ownerless" }, displayParentId: "999999" }),
      (error: unknown) => error instanceof ConversationOperationRefusal && error.code === "unknown_display_parent",
    );
  } finally {
    await harness.close();
  }
});

test("a task-owned child projects the native owner edge separately from its hepi creator", async () => {
  // A registered native task supplies the explicit ownership the seam must accept; ownerless is not a substitute for a
  // real subagent anchor. The task never runs: the fixture only needs the ownership edge it creates.
  const Holder = defineTask<{ note: string }, { phase: "done" }, null>({
    name: "test.relations-holder",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: async () => { throw new Error("a holder task never runs"); } },
    abort: async () => { throw new Error("a holder task never aborts"); },
  });
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-owned-"));
  directories.push(directory);
  const harness = await openServerHarness(join(directory, "owned.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true, resourceExtension: defineExtension({ name: "test.relations-holder", tasks: [Holder] }) });
  try {
    const operations = createConversationOperations(harness.harness);
    const owner = await operations.spawn({ requestId: "owner", ownership: { kind: "ownerless" } });
    const taskId = await owner.conversation.commit((tx) => tx.createTask(Holder, { note: "owner" }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
    const child = await operations.spawn({ requestId: "child", ownership: { kind: "task", taskId: taskId as TaskId }, createdBy: owner.conversationId, displayParentId: owner.conversationId });
    const info = await operations.get(child.conversationId);
    // The native owner edge is projected from the immutable record; the hepi creator and display parent are the seam's.
    assert.equal(info?.owner?.conversationId, owner.conversationId);
    assert.equal(info?.owner?.taskId, String(taskId));
    assert.deepEqual(info?.relations, { createdBy: owner.conversationId, displayParentId: owner.conversationId });
  } finally {
    await harness.close();
  }
});

test("HTTP create/get/catalogue/reference distinguish creator, display parent, fork source and owner", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-http-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "http.sqlite"), authToken: token });
  const origin = await listen(backend);
  t.after(() => backend.close());

  const a = await create(origin);
  const b = await create(origin, { createdBy: a.id, requestId: "b-request" });
  const c = await create(origin, { createdBy: a.id, displayParentId: a.id });

  // An independent conversation: created by A, but with no display parent and no native task owner.
  assert.equal(b.createdBy, a.id);
  assert.equal(b.displayParentId, undefined);
  assert.equal(b.subagentParentConversationId, undefined);
  assert.equal(c.createdBy, a.id);
  assert.equal(c.displayParentId, a.id);

  // B references C. The reference is B's own state; C's relations are untouched.
  const referenced = await refer(origin, b.id, { conversationId: c.id, label: "see also" });
  const referenceText = await referenced.text();
  assert.equal(referenced.status, 201, referenceText);
  assert.deepEqual((JSON.parse(referenceText) as { references: unknown[] }).references, [{ conversationId: c.id, label: "see also" }]);
  const repeated = await refer(origin, b.id, { conversationId: c.id, label: "see also" });
  assert.equal((await repeated.json() as { references: unknown[] }).references.length, 1, "a repeated reference is idempotent");
  const cInfo = await info(origin, c.id);
  assert.deepEqual(cInfo.relations, { createdBy: a.id, displayParentId: a.id });
  assert.deepEqual(cInfo.references, [], "a reference does not change its target");
  assert.deepEqual((await info(origin, b.id)).references, [{ conversationId: c.id, label: "see also" }]);

  // The catalogue filters and pages the same projection, by the same relation fields.
  assert.deepEqual((await catalogue(origin, "?createdBy=" + a.id)).conversations.map((row) => row.id).sort(), [b.id, c.id].sort());
  assert.deepEqual((await catalogue(origin, "?displayParentId=" + a.id)).conversations.map((row) => row.id), [c.id]);
  const first = await catalogue(origin, "?createdBy=" + a.id + "&limit=1");
  assert.equal(first.conversations.length, 1);
  assert.equal(typeof first.nextCursor, "string");
  const second = await catalogue(origin, "?createdBy=" + a.id + "&limit=1&cursor=" + first.nextCursor);
  assert.equal(second.conversations.length, 1);
  assert.notEqual(second.conversations[0].id, first.conversations[0].id);
  // A cursor at or past the last row is an exhausted listing, not a restart: following `nextCursor` to the end answers
  // one page per row and then an empty page with no cursor, instead of handing back the first page forever.
  assert.equal(second.nextCursor, undefined);
  const exhausted = await catalogue(origin, "?createdBy=" + a.id + "&limit=1&cursor=" + second.conversations[0].id);
  assert.deepEqual(exhausted.conversations, []);
  assert.equal(exhausted.nextCursor, undefined);

  // A replayed request id answers the same conversation instead of creating a second one.
  const before = (await catalogue(origin)).conversations.length;
  const replay = await create(origin, { createdBy: a.id, requestId: "b-request" });
  assert.equal(replay.id, b.id);
  assert.equal((await catalogue(origin)).conversations.length, before);
});

test("an unknown reference target is refused and copies nothing", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-refuse-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "refuse.sqlite"), authToken: token });
  const origin = await listen(backend);
  t.after(() => backend.close());

  const a = await create(origin);
  const response = await refer(origin, a.id, { conversationId: "999999" });
  assert.equal(response.status, 404);
  // The refusal is the named outcome a follow reports later, not a code of its own: one vocabulary for a target no
  // conversation holds (cross-session references ticket 01).
  assert.deepEqual(await response.json(), { protocol: "hepi.v1", code: "target-missing", error: "the referenced conversation does not exist: 999999" });
  assert.deepEqual((await info(origin, a.id)).references, []);
});

test("a tombstoned display parent keeps the child relation and the child is not promoted", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-tombstone-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "tombstone.sqlite"), authToken: token });
  const origin = await listen(backend);
  t.after(() => backend.close());

  const a = await create(origin);
  const c = await create(origin, { createdBy: a.id, displayParentId: a.id });
  assert.equal((await fetch(origin + "/api/conversations/" + a.id, { method: "DELETE", headers })).status, 200);

  // The removed parent leaves the list, but the child keeps its edge and states that the parent is unavailable.
  const listed = await catalogue(origin);
  assert.ok(!listed.conversations.some((row) => row.id === a.id));
  const row = listed.conversations.find((candidate) => candidate.id === c.id);
  assert.equal(row?.displayParentId, a.id);
  assert.equal(row?.displayParentDeleted, true);
  assert.equal(row?.createdBy, a.id);
  const cInfo = await info(origin, c.id);
  assert.equal(cInfo.relations.displayParentId, a.id);
  assert.equal(cInfo.displayParentDeleted, true);
  // The child is still an ordinary conversation, not a promoted independent one: its display edge is what it was.
  assert.equal(cInfo.conversation.displayParentId, a.id);

  // A conversation with no display parent is not refused by a relation it does not have.
  const b = await create(origin, { createdBy: a.id });
  assert.equal((await info(origin, b.id)).relations.createdBy, a.id);

  // The records survive a real SQLite reopen, read through a second backend over the same file.
  await backend.close();
  const reopened = await createBackendServer({ dbPath: join(directory, "tombstone.sqlite"), authToken: token });
  const reopenedOrigin = await listen(reopened);
  t.after(() => reopened.close());
  const reopenedInfo = await info(reopenedOrigin, c.id);
  assert.equal(reopenedInfo.relations.createdBy, a.id);
  assert.equal(reopenedInfo.relations.displayParentId, a.id);
  assert.equal(reopenedInfo.displayParentDeleted, true);
  assert.equal((await info(reopenedOrigin, b.id)).conversation.createdBy, a.id);
});

test("the by-id configuration is a credential-free projection", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-relations-config-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "config.sqlite"), authToken: token });
  const origin = await listen(backend);
  t.after(() => backend.close());

  const a = await create(origin);
  const projected = (await info(origin, a.id)).config;
  // This backend configured no default model, so the projection states none instead of a fabricated reference: the
  // offline scripted provider is a test fixture and never a production default.
  assert.equal(projected.model, null);
  assert.deepEqual(Object.keys(projected).sort(), ["cwd", "extensions", "model", "thinkingLevel", "tools"]);
  const serialized = JSON.stringify(projected).toLowerCase();
  for (const forbidden of ["apikey", "api_key", "token", "secret", "password"]) assert.ok(!serialized.includes(forbidden), forbidden);
});
