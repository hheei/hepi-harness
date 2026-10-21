import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getLastOpenSession, setLastOpenSession, clearLastOpen, workspaceKeyOf } = await createJiti(import.meta.url).import<typeof import("./workspace-memory.ts")>("./workspace-memory.ts");

/** The part of the browser's store the memory writes through, plus the raw map a case inspects. */
type FakeStorage = {
  readonly values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function createStorage(initial: Record<string, string> = {}): FakeStorage {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
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
  const roots: readonly (readonly [root: string, expected: string | null])[] = [["root-a", null], ["root-b", null], ["root-c", "ok"]];
  for (const [root, expected] of roots) assert.equal(getLastOpenSession(root, odd), expected, root);
  // A workspace key is the server's project identity when it stated one, and otherwise the root or the cwd it gave.
  const sessions: readonly (readonly [session: Parameters<typeof workspaceKeyOf>[0], expected: string])[] = [
    [{ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a", projectKey: "project:a" }, "project:a"],
    [{ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a" }, "/repos/a"],
    [{ cwd: "/plain/dir", projectRoot: null }, "/plain/dir"],
    [{ cwd: "/plain/dir" }, "/plain/dir"],
  ];
  for (const [session, expected] of sessions) assert.equal(workspaceKeyOf(session), expected, JSON.stringify(session));
});
