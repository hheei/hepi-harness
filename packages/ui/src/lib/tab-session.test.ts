import assert from "node:assert/strict";
import test from "node:test";
import { getTabOpen, setTabOpenSession, setTabOpenNewSession, clearTabOpenSession, type TabOpen } from "./tab-session.ts";

/** The part of the tab's store the memory writes through, plus the raw map a case inspects. */
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

test("tab memory round-trips session and composer transitions and clears only a matching session", () => {
  const storage = createStorage();
  assert.equal(getTabOpen(storage), null, "empty tab");
  for (const sessionId of ["session-1", "session-2"]) {
    setTabOpenSession(sessionId, storage);
    assert.deepEqual(getTabOpen(storage), { kind: "session", sessionId }, sessionId);
    assert.equal(storage.values.get("pi-web:tab-open-session"), JSON.stringify({ kind: "session", sessionId }), sessionId);
  }
  clearTabOpenSession("other", storage);
  assert.deepEqual(getTabOpen(storage), { kind: "session", sessionId: "session-2" }, "mismatched clear");
  clearTabOpenSession("session-2", storage);
  assert.equal(storage.values.has("pi-web:tab-open-session"), false);
  setTabOpenSession("session-1", storage);
  setTabOpenNewSession(" /work/project ", undefined, storage);
  clearTabOpenSession("session-1", storage);
  assert.deepEqual(getTabOpen(storage), { kind: "new", cwd: "/work/project" }, "composer survives session clear");
  setTabOpenNewSession("/work/project", "new:composer-1:/work/project", storage);
  assert.deepEqual(
    getTabOpen(storage),
    { kind: "new", cwd: "/work/project", draftKey: "new:composer-1:/work/project" },
    "the composer's own draft key travels with the folder",
  );
  const stored: readonly (readonly [raw: string, expected: TabOpen | null])[] = [
    ["legacy-session", { kind: "session", sessionId: "legacy-session" }], ["", null],
  ];
  for (const [raw, expected] of stored) {
    assert.deepEqual(getTabOpen(createStorage({ "pi-web:tab-open-session": raw })), expected, `stored ${JSON.stringify(raw)}`);
  }
  // A key this build cannot use is dropped rather than carried as a key no composer owns.
  for (const raw of [
    { kind: "new", cwd: "/work", draftKey: "" },
    { kind: "new", cwd: "/work", draftKey: 7 },
  ]) {
    assert.deepEqual(getTabOpen(createStorage({ "pi-web:tab-open-session": JSON.stringify(raw) })), { kind: "new", cwd: "/work" }, JSON.stringify(raw));
  }
  const empty = createStorage();
  setTabOpenSession("", empty);
  setTabOpenNewSession("  ", undefined, empty);
  assert.equal(getTabOpen(empty), null, "blank writes");
});
