import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { createConversationOperations } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { createForkAnchor } from "../src/subagents/anchor.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

/**
 * Ticket 11's crash window: a real SIGKILL **between the branch's creating commit and the answer**.
 *
 * The stage process forks a child conversation through the product's own creation seam, dies synchronously inside the
 * commit publication that carries the branch, and never writes a response. The next process opens the same SQLite file,
 * replays the same request identity and must be answered with the branch the dead attempt created — one branch, one
 * anchor, one display parent — instead of a second branch or an ownerless fallback (spec D14, A19).
 *
 * Nothing here is a unit check of the dedupe document: the first stage really dies, the second really reopens the store,
 * and the facts asserted are the ones the store holds.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const child = fileURLToPath(new URL("./child-fork-crash-child.ts", import.meta.url));

type Stage = { readonly status: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string };

function runStage(stage: string, dbPath: string, childId: string, at: string, requestId: string): Stage {
  const result = spawnSync(process.execPath, [child, stage, dbPath, childId, at, requestId], { encoding: "utf8" });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("a real SIGKILL between the branch's commit and its answer still answers the same branch on replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-child-fork-crash-"));
  directories.push(directory);
  const dbPath = join(directory, "fork.sqlite");

  // The child the branch is taken from: a real task-owned conversation, created through the same seam, with entries of
  // its own so a branch point exists.
  const seeding = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const operations = createConversationOperations(seeding.harness);
  const parent = await seeding.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const parentId = String(parent.id);
  const childRecord = await operations.spawn({
    requestId: "seed-child",
    ownership: { kind: "created-task", create: (tx) => createForkAnchor(tx, parent.id) },
    createdBy: parentId,
    displayParentId: parentId,
    provenance: { origin: "user" },
  });
  const childId = childRecord.conversationId;
  const first = await seeding.harness.commit(tx => tx.appendEntry(UserEntry, childRecord.conversation.id, { model: [{ role: "user", content: "child first", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const second = await seeding.harness.commit(tx => tx.appendEntry(UserEntry, childRecord.conversation.id, { model: [{ role: "user", content: "child second", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const childInfoBefore = await operations.get(childId);
  await seeding.close();

  // The branch point is the child's **first** entry, so the branch is provably shorter than the child.
  const killed = runStage("create", dbPath, childId, String(first.id), "branch-crash-1");
  assert.equal(killed.signal, "SIGKILL", "the creating stage really died: " + killed.stderr + killed.stdout);

  // The replay reopens the same file: the branch is durable, its identity is the same, and no second one exists.
  const replayed = runStage("replay", dbPath, childId, String(first.id), "branch-crash-1");
  assert.equal(replayed.status, 0, "the replay stage succeeded: " + replayed.stderr + replayed.stdout);
  const facts = JSON.parse(replayed.stdout.trim().split("\n").at(-1)!) as { branchId: string; created: boolean; branches: number; displayParentId: string; ownerConversationId: string; forkSource: string; forkAt: string; anchors: Array<{ id: string; conversationId: string; background: boolean; input: { initialPhase?: string; delegatingConversationId: string }; state: { status: string; checkpoint?: { phase: string } } }>; reporters: number };
  assert.equal(facts.branches, 1, "exactly one branch of the child exists");
  assert.equal(facts.created, false, "the replay created nothing");
  assert.equal(facts.displayParentId, childId);
  assert.equal(facts.ownerConversationId, childId, "the branch's owner is its own anchor on the child");
  assert.equal(facts.forkSource, childId);
  assert.equal(facts.forkAt, String(first.id));
  // Ticket 07 added the reporter, created by an admitting anchor. A user's branch admits nothing, so its anchor must
  // leave no reporter at all — a reporter here would wake the child with a delivery for a delegation nobody made.
  assert.equal(facts.reporters, 0, "a user's branch creates no reporter");
  const branchAnchors = facts.anchors.filter(anchor => anchor.conversationId === childId);
  assert.equal(branchAnchors.length, 1, "the branch has exactly one anchor, on the child: " + JSON.stringify(facts.anchors));
  assert.ok(facts.anchors.every(anchor => anchor.background), "every anchor is background, so a stop of its conversation never reaches the branch");
  // The three tickets meet in this one record. Ticket 10 added the `prepare` phase, entered only by a delegation whose
  // definition asked for `compact`; ticket 07 added the reporter, created by an admitting anchor. A user's branch is
  // neither: its anchor states the permanent idle phase, names no dispatch and no preparation, and its committed
  // checkpoint is that idle phase — which is what leaves the recovered store with no reporter and no admission.
  assert.deepEqual(branchAnchors[0]!.input, { initialPhase: "idle", delegatingConversationId: childId }, "the branch's anchor names an idle phase, no dispatch and no preparation");
  // Live and never settled: the idle phase commits no progress, so the anchor parks rather than reaching a terminal
  // state. The stage opens the store paused, so an unscheduled anchor is `pending` rather than `running` — either way
  // it is work that still exists, which is what makes it the branch's owner for the branch's whole life.
  assert.ok(branchAnchors[0]!.state.status === "pending" || branchAnchors[0]!.state.status === "running", "the idle anchor is live, not settled: " + JSON.stringify(branchAnchors[0]!.state));
  assert.equal(branchAnchors[0]!.state.checkpoint?.phase, "idle", "the committed checkpoint is the idle phase, not prepare or admit: " + JSON.stringify(branchAnchors[0]!.state));

  // Read the recovered store directly: the branch's history stops at the branch point, and its owner is not the child's.
  const reopened = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  t.after(() => reopened.close());
  const recovered = createConversationOperations(reopened.harness);
  const branch = await reopened.harness.conversation(Number(facts.branchId) as never, BACKGROUND_CONTEXT);
  assert.ok(branch !== undefined, "the branch is readable after the crash");
  const branchEntries = await branch.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
  assert.deepEqual(branchEntries.items.map(entry => entry.id), [first.id], "the branch holds the history up to its branch point only");
  const branchInfo = await recovered.get(facts.branchId);
  assert.notEqual(branchInfo?.owner?.taskId, childInfoBefore?.owner?.taskId, "the branch did not reuse the child's own task");
  assert.deepEqual(branchInfo?.relations, { createdBy: childId, displayParentId: childId, provenance: { origin: "user" } });
  // The child is untouched by the crashed attempt and by its replay.
  const childAfter = await reopened.harness.conversation(Number(childId) as never, BACKGROUND_CONTEXT);
  const childEntries = await childAfter!.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
  assert.deepEqual(childEntries.items.map(entry => entry.id), [first.id, second.id], "the child keeps its own history");
});
