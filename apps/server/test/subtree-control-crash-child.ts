/**
 * Ticket 01's crash window, as its own process over a test-owned SQLite file.
 *
 * The stage creates one parent and two children through the one creation seam, asks for a subtree stop, and kills
 * itself with SIGKILL **inside the commit publication that captures the scope** — synchronously in the publication
 * listener, before any child has been controlled. That is the exact window in which a request exists but its per-child
 * outcomes do not, so the reopened store is what decides whether the request resumes or restarts from nothing.
 *
 * Nothing here is a clean close: the evidence is what a real SIGKILL leaves behind.
 */
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId } from "@earendil-works/pi-durable";
import { createConversationOperations } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SubtreeControlDoc } from "../src/subtree-control.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const [, , dbPath, stage = "capture"] = process.argv;
assert.ok(dbPath !== undefined, "usage: subtree-control-crash-child <db> [capture|resume]");
assert.ok(stage === "capture" || stage === "resume", "stage is capture or resume");

const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels());
const conversationKey = (value: string): ConversationId => Number(value) as ConversationId;
const operations = createConversationOperations(harness.harness);
const root = await operations.spawn({ requestId: "crash-root", ownership: { kind: "ownerless" } });
const first = await operations.spawn({ requestId: "crash-first", ownership: { kind: "ownerless" }, displayParentId: root.conversationId });
const second = await operations.spawn({ requestId: "crash-second", ownership: { kind: "ownerless" }, displayParentId: root.conversationId });

if (stage === "capture") {
  // The kill runs inside the publication of the capture commit: the scope is durable and no child has an outcome yet.
  harness.harness.subscribeCommits((publication: CommitPublication) => {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== SubtreeControlDoc.definition.kind || change.value === null) continue;
      const value = change.value as { scope?: string[]; outcomes?: Record<string, unknown> };
      if (value.scope === undefined) continue;
      console.log(JSON.stringify({ stage, rootId: root.conversationId, scope: value.scope, outcomes: Object.keys(value.outcomes ?? {}).length }));
      process.kill(process.pid, "SIGKILL");
      return;
    }
  });
  await operations.subtreeControl(root.conversationId, { requestId: "crash-request", action: "stop", stopSource: "user" });
  throw new Error("the capture commit was not observed");
}

// The resumed process reads the capture the killed process committed and continues from it.
const captured = await operations.subtreeControlRequest(root.conversationId, "crash-request");
assert.ok(captured !== undefined, "the capture survived the kill");
assert.equal(captured.status, "pending", "no child had an outcome when the process died");
assert.deepEqual(captured.outcomes.map((outcome) => outcome.status), ["pending", "pending"], "the killed request has reached neither child");
const resumed = await operations.subtreeControl(root.conversationId, { requestId: "crash-request", action: "stop", stopSource: "user" });
assert.equal(resumed.status, "completed");
assert.deepEqual(resumed.scope, captured.scope);
assert.deepEqual(resumed.outcomes.map((outcome) => outcome.status), ["accepted", "accepted"]);
for (const id of [first.conversationId, second.conversationId]) {
  const control = await (await harness.harness.conversation(conversationKey(id), BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT);
  assert.equal(control.state, "held", id + " is held by the resumed request");
  assert.equal(control.revision, 1, id + " recorded exactly one control change");
}
assert.equal((await (await harness.harness.conversation(conversationKey(root.conversationId), BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT)).state, "allowed");
// A replay of the same identity after the resume changes nothing at all.
const replay = await operations.subtreeControl(root.conversationId, { requestId: "crash-request", action: "stop", stopSource: "user" });
assert.deepEqual(replay.outcomes.map((outcome) => outcome.status), ["accepted", "accepted"]);
for (const id of [first.conversationId, second.conversationId]) {
  const control = await (await harness.harness.conversation(conversationKey(id), BACKGROUND_CONTEXT))!.control(BACKGROUND_CONTEXT);
  assert.equal(control.revision, 1, id + " was not stopped twice");
}
console.log(JSON.stringify({ stage, scope: resumed.scope, statuses: resumed.outcomes.map((outcome) => outcome.status), capturedStatus: captured.status }));
await harness.close();
