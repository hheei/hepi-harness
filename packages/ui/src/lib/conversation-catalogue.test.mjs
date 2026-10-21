import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { catalogueRow, catalogueRows, catalogueRunning } = await jiti.import("./conversation-catalogue.ts");

/**
 * The Backend's own catalogue, projected into the row the sidebar renders.
 *
 * This is the seam that used to live in the Next BFF's `/api/sessions` handler. It moved here because both hosts need it
 * and because the Backend's catalogue — not a per-origin adapter — is the answer it reads. What it must not do is state
 * a fact the Backend did not: a row's folder, project group, host and run status are the Backend's, and a conversation
 * bound to nothing says so instead of borrowing a path.
 */

/** One catalogue entry as the Backend writes it, with only the fields a row reads. */
const entry = (overrides = {}) => ({ id: "1", workspaceId: null, busy: false, revision: 3, messageCount: 2, firstMessage: "hello", title: null, ...overrides });

test("a conversation bound to no workspace states no folder and no project", () => {
  const row = catalogueRow(entry());
  assert.equal(row.id, "1");
  assert.equal(row.workspaceBound, false);
  assert.equal(row.cwd, "/durable");
  assert.equal(row.path, "");
  assert.equal(row.projectRoot, undefined);
  assert.equal(row.projectKey, undefined);
  assert.equal(row.gatewayId, undefined);
  assert.equal(row.firstMessage, "hello");
  assert.equal(row.messageCount, 2);
  assert.equal(row.transient, false);
});

test("a configured workspace is its own group, shown at the root its host reported", () => {
  const row = catalogueRow(entry({ workspaceId: "local", gatewayId: "workstation", workspace: { gatewayId: "workstation" } }), new Map([["local", "/home/me/project"]]));
  assert.equal(row.workspaceBound, true);
  assert.equal(row.cwd, "/workspace/local");
  assert.equal(row.projectRoot, "/workspace/local");
  assert.equal(row.projectKey, "/workspace/local");
  assert.equal(row.projectDisplayRoot, "/home/me/project");
  assert.equal(row.gatewayId, "workstation");
});

test("a project folder is its project's group, addressed by the default folder and shown at its recorded root", () => {
  const row = catalogueRow(entry({
    workspaceId: "feature",
    gatewayId: "workstation",
    workspace: {
      gatewayId: "workstation",
      root: "/repo/feature",
      project: { id: "p1", name: "Repo", defaultWorkspaceId: "main", displayRoot: "/repo/main" },
    },
  }));
  assert.equal(row.cwd, "/workspace/feature", "the row's own cwd stays the folder it runs in");
  assert.equal(row.projectRoot, "/workspace/main", "the group is addressed by the project's default folder");
  assert.equal(row.projectKey, "/project/p1");
  assert.equal(row.projectDisplayRoot, "/repo/main");
});

test("a retained binding is marked, so a picker for a new conversation leaves it out while the row stays openable", () => {
  const row = catalogueRow(entry({ workspaceId: "gone", workspace: { gatewayId: "workstation", root: "/repo/gone", retained: true } }));
  assert.equal(row.workspaceRetained, true);
  assert.equal(row.projectDisplayRoot, "/repo/gone");
});

test("the relations, run status and extension selection are forwarded as the Backend stated them", () => {
  const row = catalogueRow(entry({
    createdBy: "9",
    displayParentId: "8",
    displayParentDeleted: true,
    parentConversationId: "7",
    runStatus: { state: "held" },
    extensions: ["delegate"],
    lastRunEndedAt: 42,
    title: "Named",
  }));
  assert.equal(row.name, "Named");
  assert.equal(row.createdBy, "9");
  assert.equal(row.displayParentSessionId, "8");
  assert.equal(row.displayParentDeleted, true);
  assert.equal(row.relation.kind, "fork");
  assert.equal(row.relation.originSessionId, "7");
  assert.equal(row.parentSessionId, "7");
  // A conversation a task created is a subagent's, and a fork of a subagent's is refused, so a row is one or the other.
  const child = catalogueRow(entry({ subagentParentConversationId: "6" }));
  assert.deepEqual(child.relation, { kind: "subagent", parentSessionId: "6" });
  assert.equal(child.parentSessionId, "6");
  assert.deepEqual(row.runStatus, { state: "held" });
  assert.deepEqual(row.extensions, ["delegate"]);
  assert.equal(row.lastRunEndedAt, 42);
});

test("a list answers its rows, its running set and the Backend's own list version", () => {
  const catalog = {
    conversations: [entry({ id: "1", busy: true, revision: 2 }), entry({ id: "2", revision: 4 })],
    sessionListVersion: 9,
    sidebarStateRevision: 5,
    projectsRevision: 7,
  };
  const answer = catalogueRows(catalog);
  assert.deepEqual(answer.sessions.map((row) => row.id), ["1", "2"]);
  assert.deepEqual(answer.runningSessionIds, ["1"]);
  assert.equal(answer.sessionListVersion, 9, "the version is the Backend's, not a second derivation");
  assert.equal(answer.sessionUiStateRevision, 5);
  assert.equal(answer.projectsRevision, 7);
});

test("the running poll answers the ids and the same three revisions from one catalogue read", () => {
  const poll = catalogueRunning({ runningConversationIds: ["1"], sessionListVersion: 9, sidebarStateRevision: 5, projectsRevision: 7 });
  assert.deepEqual(poll.runningSessionIds, ["1"]);
  assert.equal(poll.sessionListVersion, 9);
  assert.equal(poll.sessionUiStateRevision, 5);
  assert.equal(poll.projectsRevision, 7);
  // A catalogue that states no revision is zero, not absent: a client compares numbers.
  assert.equal(catalogueRows({ conversations: [], sessionListVersion: 0 }).sessionUiStateRevision, 0);
});
