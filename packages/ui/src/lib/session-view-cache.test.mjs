import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  clearSessionViewCache, deleteSessionViewSnapshot, getSessionViewSnapshot,
  resetSessionViewCacheForTests, setSessionViewSnapshot,
} = await createJiti(import.meta.url).import("./session-view-cache.ts");

// Every view is stored inside one connection scope. These cases are about the window own bounds, so they state one
// scope; the last case states what a second connection may and may not see of the first.
const S = "profile|backend|account";
const OTHER = "profile|other-backend|account";

const MI = 1024 * 1024;
const snapshot = (sessionId, chars = 0) => ({
  sessionId, revision: "rev-" + sessionId,
  messages: [{ role: "user", content: "tail" }], entryIds: ["e1"], leafId: "e1",
  oldestEntryId: "e1", hasMore: true, thinkingLevel: "off", model: null,
  loadedEntryIds: ["e-old", "e1"], prefixEntryIds: ["e-old"],
  prefixMessages: [{ role: "assistant", content: "x".repeat(chars) }], prefixHistoryHead: "h1",
});

test("switching restores loaded history; reads refresh LRU and logout clears it", (t) => {
  resetSessionViewCacheForTests();
  t.after(clearSessionViewCache);
  const saved = snapshot("s0");
  assert.equal(setSessionViewSnapshot(S, saved), true);
  const restored = getSessionViewSnapshot(S, "s0");
  assert.equal(restored.messages, saved.messages);
  assert.equal(restored.prefixMessages, saved.prefixMessages);
  assert.equal(restored.prefixEntryIds, saved.prefixEntryIds);
  assert.equal(restored.prefixHistoryHead, "h1");
  for (let i = 1; i < 8; i++) setSessionViewSnapshot(S, snapshot("s" + i));
  assert.ok(getSessionViewSnapshot(S, "s0"));
  setSessionViewSnapshot(S, snapshot("s8"));
  assert.equal(getSessionViewSnapshot(S, "s1"), null, "untouched oldest is evicted");
  assert.ok(getSessionViewSnapshot(S, "s0"), "recently viewed session survives");
  deleteSessionViewSnapshot(S, "s0");
  assert.equal(getSessionViewSnapshot(S, "s0"), null);
  clearSessionViewCache();
  assert.equal(getSessionViewSnapshot(S, "s8"), null);
});

test("prefix bytes bound the cache; replacement, expiry and refusal preserve its budget", (t) => {
  resetSessionViewCacheForTests();
  t.after(clearSessionViewCache);
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  for (let i = 0; i < 8; i++) assert.equal(setSessionViewSnapshot(S, snapshot("b" + i, 4.5 * MI)), true);
  assert.equal(getSessionViewSnapshot(S, "b0"), null, "prefix bytes count toward the 32 Mi budget");
  assert.equal(setSessionViewSnapshot(S, snapshot("b1", MI)), true);
  assert.equal(setSessionViewSnapshot(S, snapshot("b8", 0.5 * MI)), true);
  assert.ok(getSessionViewSnapshot(S, "b2"), "replacement releases its old measure");
  assert.equal(setSessionViewSnapshot(S, snapshot("huge", 33 * MI)), false);
  assert.ok(getSessionViewSnapshot(S, "b2"), "refusing an oversize write preserves existing history");
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal(getSessionViewSnapshot(S, "b2"), null, "old windows expire");
  assert.equal(setSessionViewSnapshot(S, snapshot("fresh", 20 * MI)), true);
  assert.ok(getSessionViewSnapshot(S, "fresh"), "expired windows release their bytes");
});

test("a second connection never sees the first one's view of the same session id", (t) => {
  resetSessionViewCacheForTests();
  t.after(clearSessionViewCache);
  // The same durable conversation id on two Backends: the ids are unique within one Backend, so this is the case a
  // bare session-id key gets wrong, and the one a page switching connection would show the previous one's history in.
  assert.equal(setSessionViewSnapshot(S, snapshot("shared")), true);
  assert.equal(getSessionViewSnapshot(OTHER, "shared"), null, "another connection has no view of this id");
  setSessionViewSnapshot(OTHER, { ...snapshot("shared"), revision: "other-rev", messages: [{ role: "user", content: "other" }] });
  assert.equal(getSessionViewSnapshot(S, "shared").messages[0].content, "tail");
  assert.equal(getSessionViewSnapshot(OTHER, "shared").messages[0].content, "other");
  deleteSessionViewSnapshot(OTHER, "shared");
  assert.ok(getSessionViewSnapshot(S, "shared"), "deleting one connection's view leaves the other's alone");
});
