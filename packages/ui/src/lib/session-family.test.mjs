import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listSessionFamilies } = await jiti.import("./session-family.ts");

const base = { path: "", cwd: "/workspace/local", created: "", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "hello", workspaceBound: true };
const main = (id) => ({ ...base, id });
const subagent = (id, parentSessionId, modified = base.modified) => ({ ...base, id, modified, parentSessionId, relation: { kind: "subagent", parentSessionId } });

test("a subagent whose parent is no longer listed stays visible instead of vanishing with it", () => {
  // The listing the backend serves when a parent is tombstoned: the parent's row is gone, and the child's own row is
  // still there with its creator edge — the catalogue reports that edge whether or not the owner is listed. Dropping
  // the child here is the cascade the parent's removal must not cause (spec D14, A22).
  const listed = [main("1"), subagent("2", "1")];
  assert.deepEqual(listSessionFamilies(listed).map((family) => [family.root.id, family.subagents.map((session) => session.id)]), [["1", ["2"]]]);

  const parentHidden = [subagent("2", "1")];
  const families = listSessionFamilies(parentHidden);
  assert.equal(families.length, 1, "the child is still listed after its parent leaves: " + JSON.stringify(families.map((family) => family.root.id)));
  assert.equal(families[0].root.id, "2");
  // It is still a subagent's conversation: the relation is what every surface reads to keep its completion silent, and
  // losing the family must not rewrite it.
  assert.equal(families[0].root.relation?.kind, "subagent");
});

test("a hidden middle conversation leaves its descendant visible rather than dropping it", () => {
  // The listing holds the grandparent and the grandchild; the conversation between them was tombstoned. The
  // grandchild's own relation names only that hidden conversation, so the listing holds no path from it to the
  // grandparent: the only non-lossy answer is to keep the grandchild as a family of its own. Dropping it would make a
  // removal two levels up erase a conversation nobody removed (spec D14, A22).
  const listed = [main("1"), subagent("3", "2")];
  const families = listSessionFamilies(listed);
  assert.deepEqual(families.map((family) => family.root.id).sort(), ["1", "3"]);
  assert.equal(families.find((family) => family.root.id === "3")?.root.relation?.kind, "subagent", "the relation is kept");
  assert.deepEqual(families.find((family) => family.root.id === "3")?.subagents, []);
});

test("a listed parent keeps grouping its children, and a fork of a child is its own top-level family", () => {
  const listed = [main("1"), subagent("2", "1"), { ...base, id: "4", parentSessionId: "2", relation: { kind: "fork", originSessionId: "2" } }];
  const families = listSessionFamilies(listed);
  // The fork stays a family of its own — a fork is top-level in the sidebar and is only told apart by its relation —
  // while the delegated child sits under the conversation whose task owns it.
  assert.deepEqual(families.map((family) => [family.root.id, family.subagents.map((session) => session.id)]).sort(), [["1", ["2"]], ["4", []]]);
});
