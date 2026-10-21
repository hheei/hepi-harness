import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AgentMessage } from "./types.ts";
import type { SessionViewSnapshot } from "./session-view-cache.ts";

const {
  clearSessionViewCache, deleteSessionViewSnapshot, getSessionViewSnapshot,
  resetSessionViewCacheForTests, setSessionViewSnapshot,
} = await createJiti(import.meta.url).import<typeof import("./session-view-cache.ts")>("./session-view-cache.ts");

// Every view is stored inside one connection scope. These cases are about the window own bounds, so they state one
// scope; the last case states what a second connection may and may not see of the first.
const S = "profile|backend|account";
const OTHER = "profile|other-backend|account";

const MI = 1024 * 1024;

/** One settled view: a window with a paged prefix in front of it, whose size a case states by its text. */
const snapshot = (sessionId: string, chars = 0): SessionViewSnapshot => ({
  sessionId, revision: "rev-" + sessionId,
  messages: [{ role: "user", content: "tail" }], entryIds: ["e1"], leafId: "e1",
  oldestEntryId: "e1", hasMore: true, historyHead: "h1", thinkingLevel: "off", model: null,
  loadedEntryIds: ["e-old", "e1"], prefixEntryIds: ["e-old"],
  prefixMessages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(chars) }], model: "fixture", provider: "fixture" }], prefixHistoryHead: "h1",
});

/** The view a case restored: a cache that returned nothing would be the failure the assertion is about. */
function restoredOf(scope: string, sessionId: string): SessionViewSnapshot {
  const restored = getSessionViewSnapshot(scope, sessionId);
  assert.ok(restored, "the cached view of " + sessionId + " is still held");
  return restored;
}

/** The text of a message's first block, for a case that reads what was stored rather than how much. */
function firstText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  const [block] = content;
  return block !== undefined && block.type === "text" ? block.text : "";
}

test("switching restores loaded history; reads refresh LRU and logout clears it", (t) => {
  resetSessionViewCacheForTests();
  t.after(clearSessionViewCache);
  const saved = snapshot("s0");
  assert.equal(setSessionViewSnapshot(S, saved), true);
  const restored = restoredOf(S, "s0");
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
  assert.equal(firstText(restoredOf(S, "shared").messages[0]), "tail");
  assert.equal(firstText(restoredOf(OTHER, "shared").messages[0]), "other");
  deleteSessionViewSnapshot(OTHER, "shared");
  assert.ok(getSessionViewSnapshot(S, "shared"), "deleting one connection's view leaves the other's alone");
});
