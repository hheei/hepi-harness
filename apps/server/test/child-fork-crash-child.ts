/**
 * One stage of ticket 11's SIGKILL recovery matrix, run as its own process over a test-owned SQLite file.
 *
 * The window is the one the ticket names: the branch's creating commit is durable and its **answer** is not, because the
 * process died before the HTTP response could be written. `create` forks the child, prints nothing, and kills itself
 * with SIGKILL from inside the commit publication that carries the branch — so the branch, its anchor and its
 * relations are exactly what the store holds when the next process opens it. `replay` opens the same file again,
 * repeats the same request identity through the product's own fork route and asserts it is answered with that branch
 * instead of creating a second one.
 */
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { CommitPublication, ConversationId, EntryId } from "@earendil-works/pi-durable";
import { openServerHarness } from "../src/harness.ts";
import { createConversationOperations } from "../src/conversation-operations.ts";
import { createForkAnchor } from "../src/subagents/anchor.ts";
import { SUBAGENT_ANCHOR_TASK, SUBAGENT_REPORTER_TASK } from "../src/subagents/host.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, childIdText, atText, requestId] = process.argv;
assert.ok(dbPath !== undefined && childIdText !== undefined && atText !== undefined && requestId !== undefined, "usage: child-fork-crash-child <db> <childId> <entryId> <requestId>");
const childId = Number(childIdText) as ConversationId;
const at = Number(atText) as EntryId;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const server = await openServerHarness(dbPath, SERVER_MODEL, models, undefined, { startPaused: true });
const operations = createConversationOperations(server.harness);

/** The one creation seam, with the same shape the fork route sends: a created-task anchor on the child. */
const request = {
  requestId,
  source: { conversationId: childIdText, entryId: atText },
  ownership: { kind: "created-task" as const, create: (tx: Parameters<typeof createForkAnchor>[0]) => createForkAnchor(tx, childId) },
  createdBy: childIdText,
  displayParentId: childIdText,
  provenance: { origin: "user" as const },
};

if (stage === "create") {
  // The kill runs synchronously inside the commit that carries the branch, before anything below it has run: the
  // branch is durable and no caller has been answered.
  server.harness.subscribeCommits((publication: CommitPublication) => {
    if (!publication.changes.some((change) => change.type === "conversation" && String(change.value.id) !== childIdText)) return;
    process.kill(process.pid, "SIGKILL");
  });
  const created = await operations.spawn(request);
  assert.fail("the creating stage must die inside its own commit, not answer: " + created.conversationId);
} else if (stage === "replay") {
  const first = await operations.spawn(request);
  // The branch the crashed attempt created is answered to the replay: the same identity, and not a second branch.
  const replay = await operations.spawn(request);
  assert.equal(replay.created, false, "a replay creates nothing");
  assert.equal(replay.conversationId, first.conversationId, "a replay answers the branch the first attempt created");
  const info = await operations.get(first.conversationId);
  const listed = await server.harness.commit(tx => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
  const branches = listed.items.filter(record => record.parent !== undefined && String(record.parent.conversationId) === childIdText);
  // Ticket 07's reporter meets this ticket's idle arm here: a user's branch has no delegation to admit, so its anchor
  // must leave **no** reporter anywhere, and the recovered store is where that is a fact rather than a code path. The
  // branch's one task is the permanent idle anchor on the child — its owner, not a delegation at work.
  const tasks = await server.harness.commit(tx => tx.scanTasks({}, 200), BACKGROUND_CONTEXT);
  const reporters = await server.harness.commit(tx => tx.scanTasks({ kind: SUBAGENT_REPORTER_TASK }, 200), BACKGROUND_CONTEXT);
  console.log(JSON.stringify({
    branchId: first.conversationId,
    created: first.created,
    branches: branches.length,
    displayParentId: info?.relations.displayParentId,
    ownerConversationId: info?.owner?.conversationId,
    forkSource: info?.forkSource?.conversationId,
    forkAt: info?.forkSource?.at,
    anchors: tasks.items.filter(record => record.kind === SUBAGENT_ANCHOR_TASK).map(record => ({ id: String(record.id), conversationId: String(record.conversationId), background: record.background, input: record.input, state: record.state })),
    reporters: reporters.items.length,
  }));
} else {
  assert.fail("unknown stage " + stage);
}
