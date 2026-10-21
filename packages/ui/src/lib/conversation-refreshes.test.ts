import assert from "node:assert/strict";
import test from "node:test";
import { createConversationRefreshes } from "./conversation-refreshes.ts";

/**
 * The refresh a Settings surface asks for, at the seam it uses: a conversation id in, what the mounted chat established
 * out. Nothing here is about a component's state — it is the boundary between a panel's write and the conversation that
 * has to pick it up.
 */

test("a conversation nothing is mounted for is not_open rather than a claimed reload", async () => {
  const refreshes = createConversationRefreshes();
  assert.deepEqual(await refreshes.refresh("conversation-1"), { status: "not_open" });
  assert.deepEqual(await refreshes.refresh(null), { status: "not_open" });
});

test("the mounted conversation's own outcome is what a panel is told", async () => {
  const refreshes = createConversationRefreshes();
  let calls = 0;
  refreshes.hold("conversation-1", async () => {
    calls += 1;
    return { status: "reloaded", message: "Reloaded 2 skills and 1 prompts" };
  });
  assert.deepEqual(await refreshes.refresh("conversation-1"), { status: "reloaded", message: "Reloaded 2 skills and 1 prompts" });
  assert.equal(calls, 1, "the operation the chat published is what ran");
});

test("a failed read is reported as a failure, not as a reload", async () => {
  const refreshes = createConversationRefreshes();
  refreshes.hold("conversation-1", async () => ({ status: "failed", message: "Reload failed: 503" }));
  assert.deepEqual(await refreshes.refresh("conversation-1"), { status: "failed", message: "Reload failed: 503" });
});

test("a write to one conversation never reloads another", async () => {
  const refreshes = createConversationRefreshes();
  const reloaded: string[] = [];
  refreshes.hold("conversation-1", async () => { reloaded.push("conversation-1"); return { status: "reloaded", message: "" }; });
  refreshes.hold("conversation-2", async () => { reloaded.push("conversation-2"); return { status: "reloaded", message: "" }; });
  await refreshes.refresh("conversation-2");
  assert.deepEqual(reloaded, ["conversation-2"]);
});

test("a chat that unmounted is gone, and its cleanup does not withdraw a newer holder", async () => {
  const refreshes = createConversationRefreshes();
  const first = async () => ({ status: "reloaded", message: "first" }) as const;
  const second = async () => ({ status: "reloaded", message: "second" }) as const;
  refreshes.hold("conversation-1", first);
  refreshes.hold("conversation-1", second);
  // The replay's cleanup for the first registration runs after the second one published.
  refreshes.release("conversation-1", first);
  assert.deepEqual(await refreshes.refresh("conversation-1"), { status: "reloaded", message: "second" });

  refreshes.release("conversation-1", second);
  assert.deepEqual(await refreshes.refresh("conversation-1"), { status: "not_open" });
});
