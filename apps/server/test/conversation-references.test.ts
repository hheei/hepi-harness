/**
 * Cross-conversation references: the target validation contract (ticket 01), at the seams that own it.
 *
 * A reference is stored on the referencing conversation and is a pointer, so every case here asks the same two
 * questions of the ordinary lifecycles a user can produce — is this reference storable, and what does following it
 * say now. Validation reads the target's own **visible committed fork-aware history**, which is why an inherited fork
 * entry validates, an entry behind a compaction still validates, and a sibling branch's entry does not. Nothing here
 * asserts a helper's internals, and no case is a bypass probe: the fixtures are ordinary creations, forks, compactions
 * and removals.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, UserEntry, type Conversation, type ConversationId, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { ConversationOperationRefusal, createConversationOperations, readConversationReferences, type ConversationOperations } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { tombstoneConversation } from "../src/session-tombstone.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const directories: string[] = [];
const token = "references-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Rig = { readonly harness: Harness; readonly operations: ConversationOperations; readonly close: () => Promise<void> };

/** A real harness over a native SQLite file, paused so no scheduler runs while a fixture is written. */
async function openStore(label: string): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-references-" + label + "-"));
  directories.push(directory);
  const server = await openServerHarness(join(directory, "references.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  return { harness: server.harness, operations: createConversationOperations(server.harness), close: () => server.close() };
}

async function createConversation(harness: Harness): Promise<Conversation> {
  return await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
}

async function appendUser(harness: Harness, conversationId: ConversationId, text: string): Promise<string> {
  const entry = await harness.commit(tx => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
  return String(entry.id);
}

/** The code one refused creation states, or a failure the test names when it was not refused at all. */
async function refusalOf(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  const answered = await work.then(() => undefined, (error: unknown) => error);
  assert.ok(answered instanceof ConversationOperationRefusal, "the seam refused by name: " + String(answered));
  return { code: answered.code, status: answered.status };
}

test("a conversation reference resolves, is idempotent by target plus entry, and copies no target content", async (t: TestContext) => {
  const rig = await openStore("resolve");
  t.after(() => rig.close());
  const source = await createConversation(rig.harness);
  const target = await createConversation(rig.harness);
  const entryId = await appendUser(rig.harness, target.id, "the entry a reference pins");

  // Conversation-only is the default target, and repeating it is the same reference.
  const once = await rig.operations.addReference(String(source.id), { conversationId: String(target.id), label: "see also" });
  assert.deepEqual(once, [{ conversationId: String(target.id), label: "see also" }], "a resolvable reference is answered without an outcome");
  const again = await rig.operations.addReference(String(source.id), { conversationId: String(target.id), label: "renamed" });
  assert.deepEqual(again, once, "the same target is the same reference, and the stored label is not rewritten by a repeat");

  // The entry is the second half of the identity, so a pinned reference to the same target is its own record.
  const pinned = await rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId, label: "that turn" });
  assert.deepEqual(pinned, [
    { conversationId: String(target.id), label: "see also" },
    { conversationId: String(target.id), entryId, label: "that turn" },
  ]);
  assert.deepEqual(await rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId }), pinned, "target plus entry is the idempotent pair");

  // What is stored is the pointer alone: no preview, no text, no copied entry and no second coordinate.
  assert.deepEqual(await readConversationReferences(rig.harness, String(source.id)), [
    { conversationId: String(target.id), label: "see also" },
    { conversationId: String(target.id), entryId, label: "that turn" },
  ]);
  const info = await rig.operations.get(String(source.id));
  assert.deepEqual(info?.references, pinned, "the by-id read resolves the same records the write answered");
  // The target is untouched: a reference grants nothing and records nothing on the conversation it points at.
  assert.deepEqual(await rig.operations.references(String(target.id)), []);
  assert.deepEqual((await rig.operations.get(String(target.id)))?.relations, {});
});

test("an entry outside the target's visible committed history is refused and nothing is stored", async (t: TestContext) => {
  const rig = await openStore("scope");
  t.after(() => rig.close());
  const source = await createConversation(rig.harness);
  const target = await createConversation(rig.harness);
  const elsewhere = await createConversation(rig.harness);
  const foreign = await appendUser(rig.harness, elsewhere.id, "another conversation's turn");

  // The entry exists in the store and is not in this target's history: the wrong-scope answer, not "missing".
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId: foreign })), { code: "entry-out-of-scope", status: 409 });
  // An id no conversation holds is the other named answer, so a caller can tell the two apart.
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId: "999999999" })), { code: "entry-missing", status: 404 });
  // An entry is addressed by the numeric identity the history owner issues; a coordinate or a typed ordinal is a
  // malformed request, not something looked up.
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId: "anchor-1" })), { code: "invalid_request", status: 400 });
  assert.deepEqual(await rig.operations.references(String(source.id)), [], "a refused creation stores nothing");
  assert.deepEqual(await readConversationReferences(rig.harness, String(source.id)), []);
});

test("a tombstoned target is target-unavailable, and an unknown one is target-missing", async (t: TestContext) => {
  const rig = await openStore("tombstone");
  t.after(() => rig.close());
  const source = await createConversation(rig.harness);
  const target = await createConversation(rig.harness);
  const entryId = await appendUser(rig.harness, target.id, "a turn before the removal");
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: "999999" })), { code: "target-missing", status: 404 });

  // A reference made while the target is visible stays stored when the target is removed — a removal never cascades
  // into another conversation's state — and the resolving read names why it cannot be followed now.
  const stored = await rig.operations.addReference(String(source.id), { conversationId: String(target.id), entryId, label: "before the removal" });
  await tombstoneConversation(rig.harness, target.id, [], Date.now());
  assert.deepEqual(await rig.operations.references(String(source.id)), [{ ...stored[0]!, outcome: "target-unavailable" }]);
  assert.deepEqual(await readConversationReferences(rig.harness, String(source.id)), stored, "the record itself is unchanged by the outcome it now reports");
  // Creating a new reference to the removed target is refused by the same name: the existence check alone would pass.
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: String(target.id) })), { code: "target-unavailable", status: 409 });
  assert.deepEqual((await rig.operations.get(String(source.id)))?.references, [{ ...stored[0]!, outcome: "target-unavailable" }]);
});

test("inherited fork entries and post-compaction entries validate, and a sibling branch's entry does not", async (t: TestContext) => {
  const rig = await openStore("fork");
  t.after(() => rig.close());
  const source = await createConversation(rig.harness);
  const parent = await createConversation(rig.harness);
  const inherited = await appendUser(rig.harness, parent.id, "a prompt both branches hold");
  const forkPoint = await appendUser(rig.harness, parent.id, "the turn the fork is taken at");
  const sibling = await appendUser(rig.harness, parent.id, "the parent's own later turn");
  const forked = await parent.fork(Number(forkPoint) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);

  // The fork inherited the prefix, so an inherited entry is in the fork's own visible committed history.
  assert.deepEqual(await rig.operations.addReference(String(source.id), { conversationId: String(forked.id), entryId: inherited }), [{ conversationId: String(forked.id), entryId: inherited }]);
  // The sibling turn exists in the store and is not in the fork's history.
  assert.deepEqual(await refusalOf(rig.operations.addReference(String(source.id), { conversationId: String(forked.id), entryId: sibling })), { code: "entry-out-of-scope", status: 409 });
  // The same entry is valid in the parent, which is what makes the refusal above a statement about scope.
  assert.equal((await rig.operations.addReference(String(source.id), { conversationId: String(parent.id), entryId: sibling })).length, 2);

  // A compaction moves the active context behind a head marker and removes no committed entry, so a reference to the
  // dropped prompt still validates and still names the entry the history holds.
  await appendUser(rig.harness, parent.id, "a prompt after the compaction");
  await rig.harness.commit(tx => tx.appendEntry(CompactionEntry, parent.id, { head: Number(sibling) as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  assert.equal((await rig.operations.addReference(String(source.id), { conversationId: String(parent.id), entryId: inherited })).length, 3);

  // References are the referencing conversation's own state, so the fork starts with none even though the source has
  // three: nothing is inherited by a copy, and a reference never changes its target.
  assert.deepEqual(await rig.operations.references(String(forked.id)), []);
});

test("the HTTP route states each named outcome as its own code, and the by-id read reports it", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-references-http-"));
  directories.push(directory);
  const backend: BackendServer = await createBackendServer({ dbPath: join(directory, "http.sqlite"), authToken: token });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(() => backend.close());

  const create = async (): Promise<string> => {
    const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: "{}" });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return (JSON.parse(text) as { conversationId: string }).conversationId;
  };
  const refer = (id: string, body: Record<string, unknown>) => fetch(origin + "/api/conversations/" + id + "/references", { method: "POST", headers, body: JSON.stringify(body) });
  const info = async (id: string): Promise<{ references: { conversationId: string; entryId?: string; label?: string; outcome?: string }[] }> => {
    const response = await fetch(origin + "/api/conversations/" + id, { headers });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as never;
  };

  const source = await create();
  const target = await create();
  const created = await refer(source, { conversationId: target, label: "the target" });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  assert.deepEqual((JSON.parse(createdText) as { references: unknown[] }).references, [{ conversationId: target, label: "the target" }]);
  assert.deepEqual((await info(source)).references, [{ conversationId: target, label: "the target" }]);

  // Each refusal is the outcome's own name, so a caller renders the state it already knows.
  const unknown = await refer(source, { conversationId: "999999" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as { code: string }).code, "target-missing");
  const absentEntry = await refer(source, { conversationId: target, entryId: "999999999" });
  assert.equal(absentEntry.status, 404);
  assert.equal((await absentEntry.json() as { code: string }).code, "entry-missing");
  // `entry-out-of-scope` needs an entry that exists in the store but not in this target's history, which is a fact
  // of the conversation lifecycles asserted at the owning seam above; this route test covers what an HTTP caller can
  // produce without a model run, and states that no refused creation was stored.
  assert.equal((await info(source)).references.length, 1, "no refused creation was stored");

  // Following it after the target is removed states the named outcome instead of a passing existence check, and the
  // record survives so the user's link is not silently lost.
  assert.equal((await fetch(origin + "/api/conversations/" + target, { method: "DELETE", headers })).status, 200);
  assert.deepEqual((await info(source)).references, [{ conversationId: target, label: "the target", outcome: "target-unavailable" }]);
  const unavailable = await refer(source, { conversationId: target });
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json() as { code: string }).code, "target-unavailable");
});
