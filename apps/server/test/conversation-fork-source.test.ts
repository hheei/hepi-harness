import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, UserEntry, type Conversation, type ConversationId, type Harness, type TaskRuntime } from "@earendil-works/pi-durable";
import { ConversationOperationRefusal, createConversationOperations, type ConversationSpawnRequest } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";
import { tombstoneConversation } from "../src/session-tombstone.ts";

/**
 * The one creation seam's **fork source**: a conversation created from a position in another conversation's history,
 * with every identity the caller resolved carried into one native commit.
 *
 * This is the foundation ticket 10 (a configuration strategy naming a source position) and ticket 11 (a user picking an
 * entry) both build on, so it is asserted at the core seam over real SQLite and never through a route or a helper's
 * internal structure. What is checked is what a caller and a UI can read afterwards: the inherited history, the owner
 * edge, the relations, the request identity and the refusals (spec D03, D13, D14).
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** A permanent anchor that admits nothing: the shape a child's native owner has, without any extension in the way. */
const TestAnchorTask = defineTask<{ tag: string }, { phase: "idle" }, null>({
  name: "hepi.test-fork-anchor",
  version: 1,
  initial: () => ({ phase: "idle" }),
  phases: { idle: async (_task: unknown, runtime: TaskRuntime<{ tag: string }, { phase: "idle" }, null, object>) => { await new Promise<void>((resolve) => { if (runtime.signal.aborted) return resolve(); runtime.signal.addEventListener("abort", () => resolve(), { once: true }); }); } },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "anchor_stopped" } }), context); },
});

const TestAnchorExtension = defineExtension({ name: "hepi.test-fork-anchor-extension", tasks: [TestAnchorTask] });

type Rig = { readonly harness: Harness; readonly close: () => Promise<void> };

/** A real harness over a native SQLite file, paused so no scheduler runs while a fixture is written. */
async function openStore(label: string): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-fork-source-" + label + "-"));
  directories.push(directory);
  const server = await openServerHarness(join(directory, "fork.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  server.install(TestAnchorExtension);
  return { harness: server.harness, close: () => server.close() };
}

async function createConversation(harness: Harness): Promise<Conversation> {
  return await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
}

async function appendUser(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/** The user text lines of one conversation's own fork-aware history, oldest first. */
async function history(harness: Harness, conversationId: string): Promise<string[]> {
  const conversation = await harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(conversation !== undefined);
  const page = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
  return page.items.flatMap(entry => (entry.model ?? []).filter(message => message.role === "user").map(message => String(message.content)));
}

/** The request shape a user fork sends: a task-owned child of the source's own owner conversation. */
function forkRequest(source: Conversation, at: string, requestId: string): ConversationSpawnRequest {
  const owner = String(source.id);
  return {
    requestId,
    source: { conversationId: owner, entryId: at },
    ownership: {
      kind: "created-task",
      create: (tx) => tx.createTask(TestAnchorTask, { tag: requestId }, { ownership: { kind: "conversation" }, conversationId: source.id, background: true }),
    },
    createdBy: owner,
    displayParentId: owner,
    workspaceId: "w-1",
    provenance: { origin: "user" },
  };
}

test("a fork inherits the source's history at the named entry, with its own owner, relations and request identity", async () => {
  const rig = await openStore("inherit");
  try {
    const operations = createConversationOperations(rig.harness);
    const source = await createConversation(rig.harness);
    const first = await appendUser(rig.harness, source.id, "first");
    const second = await appendUser(rig.harness, source.id, "second");

    const forked = await operations.spawn(forkRequest(source, first, "fork-1"));
    assert.equal(forked.created, true);
    // The branch holds the history up to the named entry, and not the entry after it.
    assert.deepEqual(await history(rig.harness, forked.conversationId), ["first"]);
    assert.deepEqual(await history(rig.harness, String(source.id)), ["first", "second"]);

    // The native edges: the fork source is the branch point, the owner is a task of the **source** conversation, and
    // neither is inferred from the other.
    const info = await operations.get(forked.conversationId);
    assert.deepEqual(info?.forkSource, { conversationId: String(source.id), at: first });
    assert.equal(info?.owner?.conversationId, String(source.id));
    assert.ok(info?.owner?.taskId !== undefined);
    // The hepi-owned relations are the new conversation's own: display parent preserved, provenance its own.
    assert.deepEqual(info?.relations, { createdBy: String(source.id), displayParentId: String(source.id), provenance: { origin: "user" } });
    assert.equal(info?.displayParentDeleted, false);
    assert.equal(info?.conversationId, forked.conversationId);

    // Independent run state: a fresh conversation, allowed and with an empty queue, not the source's.
    const control = await operations.control(forked.conversationId);
    assert.equal(control.control.state, "allowed");

    // A replay of the same request identity answers the branch the first call created, and forks nothing again.
    const replay = await operations.spawn(forkRequest(source, second, "fork-1"));
    assert.equal(replay.created, false);
    assert.equal(replay.conversationId, forked.conversationId);
    assert.deepEqual(await history(rig.harness, replay.conversationId), ["first"]);
  } finally {
    await rig.close();
  }
});

test("an entry that is not in the source's own history is refused, and nothing is created", async () => {
  const rig = await openStore("membership");
  try {
    const operations = createConversationOperations(rig.harness);
    const source = await createConversation(rig.harness);
    const at = await appendUser(rig.harness, source.id, "only");
    const other = await createConversation(rig.harness);
    const foreign = await appendUser(rig.harness, other.id, "elsewhere");

    await assert.rejects(
      operations.spawn(forkRequest(source, foreign, "fork-foreign")),
      (error: unknown) => error instanceof ConversationOperationRefusal && error.code === "unknown_source_entry" && error.status === 404,
    );
    // The refusal wrote nothing: the same request identity still creates a real branch afterwards.
    const created = await operations.spawn(forkRequest(source, at, "fork-foreign"));
    assert.equal(created.created, true);
    assert.deepEqual(await history(rig.harness, created.conversationId), ["only"]);
  } finally {
    await rig.close();
  }
});

test("the branch keeps the source position's configuration and an explicit override replaces it", async () => {
  const rig = await openStore("config");
  try {
    const operations = createConversationOperations(rig.harness);
    const source = await createConversation(rig.harness);
    await source.configure({ model: SERVER_MODEL, thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    const at = await appendUser(rig.harness, source.id, "work");
    // A later change to the source is **not** what the branch inherits: the native agent document forks `asOf`, so
    // omitted fields are the configuration in force at the source position, which is what makes "the configuration
    // this branch was taken under" a fact rather than a re-resolution at fork time (spec D14).
    await source.configure({ thinkingLevel: "off" }, BACKGROUND_CONTEXT);

    const inherited = await operations.spawn(forkRequest(source, at, "fork-config"));
    assert.deepEqual((await operations.get(inherited.conversationId))?.config.model, SERVER_MODEL);
    assert.equal((await operations.get(inherited.conversationId))?.config.thinkingLevel, "high");

    // An explicit user override is applied after that copy, in the same commit, and replaces the field it names.
    const overridden = await operations.spawn({ ...forkRequest(source, at, "fork-override"), agent: { thinkingLevel: "off" } });
    assert.equal((await operations.get(overridden.conversationId))?.config.thinkingLevel, "off");
    assert.deepEqual((await operations.get(overridden.conversationId))?.config.model, SERVER_MODEL);
    assert.equal((await operations.get(inherited.conversationId))?.config.thinkingLevel, "high");
  } finally {
    await rig.close();
  }
});

test("a hidden display parent does not stop a legal branch from a child's own inherited history", async () => {
  const rig = await openStore("tombstone");
  try {
    const operations = createConversationOperations(rig.harness);
    // A parent, and a real subagent child of it: task-owned by a task of the parent's conversation and displayed
    // under it, inheriting the parent's history through the same creation seam a user fork uses. The child is the
    // scenario's actual subject, so its display parent is a fact this fixture sets rather than a conversation it
    // merely happens to be next to.
    const parent = await createConversation(rig.harness);
    const inherited = await appendUser(rig.harness, parent.id, "parent work");
    const child = await operations.spawn(forkRequest(parent, inherited, "child-1"));
    const childWork = await appendUser(rig.harness, child.conversation.id, "child work");
    const childInfo = await operations.get(child.conversationId);
    assert.deepEqual(childInfo?.relations, { createdBy: String(parent.id), displayParentId: String(parent.id), provenance: { origin: "user" } });
    assert.deepEqual(childInfo?.owner?.conversationId, String(parent.id));
    assert.equal(childInfo?.displayParentDeleted, false);

    // The display parent leaves the catalogue. The child keeps its own edge and its inherited history; it is not
    // promoted to a conversation of its own, and nothing about it is rewritten.
    await tombstoneConversation(rig.harness, parent.id, [String(parent.id)], Date.now());
    const hidden = await operations.get(child.conversationId);
    assert.deepEqual(hidden?.relations, { createdBy: String(parent.id), displayParentId: String(parent.id), provenance: { origin: "user" } });
    assert.equal(hidden?.displayParentDeleted, true);
    assert.deepEqual(await history(rig.harness, child.conversationId), ["parent work", "child work"]);

    // The branch point is an entry the **child inherited** from that removed parent. Membership is the child's own
    // fork-aware history, not a same-conversation lookup of the entry table, so this is a legal position even though
    // the entry's own conversation is gone from the catalogue.
    const forked = await operations.spawn(forkRequest(child.conversation, inherited, "fork-hidden"));
    assert.deepEqual(await history(rig.harness, forked.conversationId), ["parent work"]);
    const info = await operations.get(forked.conversationId);
    // The branch is displayed under the live child it was taken from — the identity the user picked — so the removal
    // of the grandparent is not inherited by the branch and no conversation is promoted.
    assert.deepEqual(info?.relations, { createdBy: String(child.conversationId), displayParentId: String(child.conversationId), provenance: { origin: "user" } });
    assert.equal(info?.displayParentDeleted, false);
    assert.deepEqual(info?.forkSource, { conversationId: String(child.conversationId), at: inherited });
    // Its owner is its own background anchor on the child, not the child's own task and not the removed parent's.
    assert.equal(info?.owner?.conversationId, String(child.conversationId));
    assert.notEqual(info?.owner?.taskId, childInfo?.owner?.taskId);
    assert.equal((await operations.control(forked.conversationId)).control.state, "allowed");
    // The entry after the branch point is not in the branch: the position really is the one the caller named.
    assert.notEqual(childWork, inherited);
    assert.equal((await operations.read({ conversationId: forked.conversationId })).details.entries.some(entry => entry.entryId === childWork), false);
  } finally {
    await rig.close();
  }
});
