/**
 * Ticket 09's crash window, as its own process over a test-owned SQLite file.
 *
 * The stage composes the real pieces through public seams (`subagents-crash-harness.ts`), creates one parent
 * conversation, delegates once with a deterministic tool-call id, stops the parent while the child is still working so
 * the late report really queues, then edits one queued item and cancels another through the same per-item operations the
 * HTTP route calls. It then kills itself with SIGKILL — no clean close, no flush — so what the next process reads is
 * exactly what the killed one had committed.
 *
 * The kill is **after** both decisions have committed and not between them: the window this fixture pins is "the user's
 * decisions survived", which is the claim ticket 09 makes, not "a half-written commit is atomic" (that is the engine's
 * own contract, asserted by the native control tests).
 *
 * The facts it prints are the identities it read from the store at its own kill point.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createConversationItemOperations } from "../src/conversation-items.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { openCrashHarness, CRASH_WORKSPACE } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , dbPath, base] = process.argv;
assert.ok(dbPath !== undefined && base !== undefined, "usage: pending-item-crash-child <db> <base>");
const CALL_ID = "call-1";
const root = join(base, "workspace");
const home = join(base, "home");
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

// The child's own answer waits for the stop, so the report really is a late arrival and the queue really is held.
let releaseChild: (() => void) | undefined;
const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });

const crash = await openCrashHarness(dbPath, {
  root,
  home,
  script: (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
      const lastUser = messages.findLast((message) => message.role === "user");
      const text = lastUser === undefined ? "" : JSON.stringify(lastUser.content ?? "");
      if (text.includes("child work")) { await childGate; return fauxAssistantMessage("late child answer"); }
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: CALL_ID })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  },
});

const items = createConversationItemOperations(crash.harness.harness);
const parent = await crash.operations.spawn({
  requestId: "crash-parent",
  ownership: { kind: "ownerless" },
  workspaceId: CRASH_WORKSPACE,
  agent: { model: SERVER_MODEL, extensions: [crash.extension] },
});
const parentId = parent.conversationId;
const dispatchId = parentId + ":" + CALL_ID;
await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "crash-turn" }, BACKGROUND_CONTEXT);

/** Poll the store for the child the delegation created; a real child appears on its own schedule. */
const deadline = Date.now() + 30_000;
let childId = "";
while (childId === "" && Date.now() < deadline) {
  const dispatch = await crash.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);
  if (dispatch?.childConversationId !== undefined) childId = dispatch.childConversationId;
  else await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.notEqual(childId, "", "the delegation created a child");

// The user stops while the child is still working, then the child finishes: the report queues under the hold.
const stopped = await crash.operations.stop(parentId, { requestId: "stop-parent", stopSource: "user" });
assert.equal(stopped.control.state, "held", "the recipient is held before the delivery");
releaseChild?.();

const queued = await (async () => {
  const limit = Date.now() + 30_000;
  for (;;) {
    const projected = await items.items(parentId);
    if (projected.length === 1) return projected;
    if (Date.now() > limit) throw new Error("the late report never queued");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
})();
const kept = queued[0]!;
// A second queued item, so the cancel has something of its own to withdraw: one item is edited, the other cancelled.
const extra = await crash.operations.send(parentId, { requestId: "crash-extra", caller: "user", resume: false, triggerTurn: false, content: [{ type: "text", text: "cancel me before the kill" }] });
assert.notEqual(extra.submissionId, undefined, "the second item was admitted as a queued submission");
const cancelledId = extra.submissionId!;

const edited = await items.edit(parentId, { submissionId: kept.submissionId, contentToken: kept.contentToken, content: "edited before the kill" });
assert.equal(edited.status, "edited", JSON.stringify(edited));
const cancelled = await items.cancel(parentId, cancelledId);
assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));

// Both decisions are committed; the kill lands after them, with no clean close and no flush.
console.log(JSON.stringify({ parentId, childId, dispatchId, keptSubmissionId: kept.submissionId, cancelledSubmissionId: cancelledId }));
process.kill(process.pid, "SIGKILL");
