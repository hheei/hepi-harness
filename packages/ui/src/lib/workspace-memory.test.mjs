import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getLastOpenSession, setLastOpenSession, clearLastOpen, workspaceKeyOf } = await createJiti(import.meta.url).import("./workspace-memory.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("workspace memory isolates sessions by workspace, removes empty maps, and recovers malformed storage", () => {
  const storage = createStorage();
  assert.equal(getLastOpenSession("root-a", storage), null);
  setLastOpenSession("root-a", "session-a", storage);
  setLastOpenSession("root-b", "session-b", storage);
  assert.equal(getLastOpenSession("root-a", storage), "session-a");
  assert.equal(getLastOpenSession("root-b", storage), "session-b");
  clearLastOpen("root-a", storage);
  assert.equal(getLastOpenSession("root-a", storage), null);
  assert.equal(getLastOpenSession("root-b", storage), "session-b", "other workspace survives");
  clearLastOpen("root-b", storage);
  assert.equal(storage.values.has("pi-web:last-open-by-workspace"), false);
  for (const raw of ["{not-json", '"just a string"', "[]"]) {
    const malformed = createStorage({ "pi-web:last-open-by-workspace": raw });
    assert.equal(getLastOpenSession("root-a", malformed), null, raw);
    setLastOpenSession("root-a", "session-a", malformed);
    assert.equal(getLastOpenSession("root-a", malformed), "session-a", `recover ${raw}`);
  }
  const odd = createStorage({ "pi-web:last-open-by-workspace": '{"root-a":"","root-b":42,"root-c":"ok"}' });
  for (const [root, expected] of [["root-a", null], ["root-b", null], ["root-c", "ok"]]) assert.equal(getLastOpenSession(root, odd), expected, root);
  for (const [session, expected] of [
    [{ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a", projectKey: "project:a" }, "project:a"],
    [{ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a" }, "/repos/a"],
    [{ cwd: "/plain/dir", projectRoot: null }, "/plain/dir"],
    [{ cwd: "/plain/dir" }, "/plain/dir"],
  ]) assert.equal(workspaceKeyOf(session), expected, JSON.stringify(session));
});
