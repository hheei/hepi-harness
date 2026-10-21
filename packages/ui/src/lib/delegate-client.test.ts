import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import type { WorkbenchClient } from "../client.ts";
import type { DelegateAnswer } from "./delegate-attempt.ts";

const jiti = createJiti(import.meta.url);
const { delegateFrom } = await jiti.import<typeof import("./delegate-client.ts")>("./delegate-client.ts");
const { catalogueRow } = await jiti.import<typeof import("./conversation-catalogue.ts")>("./conversation-catalogue.ts");
const { workspaceKeyOf } = await jiti.import<typeof import("./workspace-memory.ts")>("./workspace-memory.ts");

/**
 * The delegation answer as the panel opens it, at the seam the panel really crosses.
 *
 * A quick create answers with the child's own catalogue entry, and the panel opens that child in the same ChatWindow
 * from this row instead of waiting for a list read. What the row has to state is therefore the same thing the list
 * states: the child's folder, its Project and its relation to the conversation that delegated. A row handed on as it
 * arrived from the wire states none of them, and the shell — which decides whether the selection is a move to another
 * folder by comparing {@link workspaceKeyOf} — reads a child of the **same** folder as a folder change and clears the
 * file tabs the user had open.
 */

const parent = { id: "parent", workspaceId: "feature", gatewayId: "workstation", workspace: { gatewayId: "workstation", root: "/repo/feature", project: { id: "p1", name: "Repo", defaultWorkspaceId: "main", displayRoot: "/repo/main" } } };

/** The child a delegation created in the **same** workspace the parent is bound to, as the Backend answers it. */
const childRow = { ...parent, id: "child", title: "Child", messageCount: 1, subagentParentConversationId: "parent" };

/** One client whose only answer is the delegation the Backend states. */
const answering = (body: unknown) => ({ request: async () => new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } }) }) as unknown as WorkbenchClient;

/** The row a delegation answer carries, asserted present so its fields are readable. */
function sessionOf(answer: DelegateAnswer): NonNullable<DelegateAnswer["session"]> {
  assert.ok(answer.session !== undefined, "the answer carries the child's own catalogue row");
  return answer.session;
}

test("a delegation answer is projected into the same row the catalogue states for the child", async () => {
  const answer = await delegateFrom(answering({ childConversationId: "child", dispatchId: "d1", requestId: "r1", created: true, conversation: childRow }), "parent", { requestId: "r1", definition: "worker", task: "do work" });
  assert.equal(answer.ok, true);
  if (!answer.ok) throw new Error("the delegation was refused");
  const row = sessionOf(answer.answer);
  assert.deepEqual(row, catalogueRow(childRow), "the answer is the catalogue's own row for the child");
  assert.equal(row.cwd, "/workspace/feature");
  assert.equal(row.projectKey, "/project/p1");
  assert.equal(row.projectDisplayRoot, "/repo/main");
  assert.deepEqual(row.relation, { kind: "subagent", parentSessionId: "parent" });
  // The shell's own question, asked the way the shell asks it: a child of the folder already on screen is not a move
  // to another folder, so opening it keeps the file tabs the user has open.
  assert.equal(workspaceKeyOf(row), workspaceKeyOf(catalogueRow(parent)));
  assert.equal(workspaceKeyOf(row), "/project/p1");
});

test("a dispatch to a conversation that already exists is projected the same way", async () => {
  // A dispatch creates nothing, so the answer names the target instead of a child — and it carries the target's own
  // row, which is projected by the same rule rather than handed on raw.
  const answer = await delegateFrom(answering({ conversationId: "child", dispatchId: "d2", requestId: "r2", conversation: childRow }), "parent", { requestId: "r2", definition: "worker", task: "more work", conversationId: "child" });
  assert.equal(answer.ok, true);
  if (!answer.ok) throw new Error("the delegation was refused");
  assert.equal(answer.answer.childConversationId, "child");
  assert.equal(answer.answer.created, false);
  assert.equal(sessionOf(answer.answer).projectKey, "/project/p1");
  assert.equal(workspaceKeyOf(sessionOf(answer.answer)), workspaceKeyOf(catalogueRow(parent)));
});
