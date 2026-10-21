/**
 * Ticket 04's two crash stages, each its own process over a test-owned SQLite file.
 *
 * Both end in a real `SIGKILL` and neither in a clean close:
 *
 * - `partial`: one parent with two children, a subtree stop, and the kill **inside the commit that records the first
 *   child's outcome**. The capture is durable and one child is answered; the other is not. That is the state a resumed
 *   request has to continue from, and dying in that exact publication is the only way to assert it.
 * - `blocked`: a delegating conversation and its child, then the kill inside the delegation's admission. Reopened by a
 *   build that installs no task definitions, that conversation's own anchor is `blocked` with the runtime's reason —
 *   which is how the blocked row of the acceptance matrix is reached from a store the product wrote.
 *
 * Nothing here is a fixture row or a patched engine: every conversation is created through the one creation seam, the
 * delegation is a real model tool call, and every task is the real one.
 *
 * Usage: `node test/subtree-control-acceptance-child.ts <db> [partial|blocked]`
 *        `HEPI_ACCEPTANCE_BASE=<dir>` for the `blocked` stage's workspace and home.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createConversationOperations } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { SubtreeControlDoc } from "../src/subtree-control.ts";
import { openCrashHarness, CRASH_WORKSPACE } from "./subagents-crash-harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const [, , dbPath, stage = "partial"] = process.argv;
assert.ok(dbPath !== undefined, "usage: subtree-control-acceptance-child <db> [partial|blocked]");
assert.ok(stage === "partial" || stage === "blocked", "stage is partial or blocked");

if (stage === "partial") {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels());
  const operations = createConversationOperations(harness.harness);
  const root = await operations.spawn({ requestId: "accept-root", ownership: { kind: "ownerless" } });
  await operations.spawn({ requestId: "accept-first", ownership: { kind: "ownerless" }, displayParentId: root.conversationId });
  await operations.spawn({ requestId: "accept-second", ownership: { kind: "ownerless" }, displayParentId: root.conversationId });
  // The kill runs inside the publication that records the **first** child's outcome: one child is answered and durable,
  // the other child's outcome is not, so the reopened store decides whether the request continues or repeats.
  harness.harness.subscribeCommits((publication: CommitPublication) => {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== SubtreeControlDoc.definition.kind || change.value === null) continue;
      const value = change.value as { scope?: string[]; outcomes?: Record<string, unknown> };
      const recorded = Object.keys(value.outcomes ?? {});
      if (recorded.length === 0) continue;
      console.log(JSON.stringify({ stage, rootId: root.conversationId, scope: value.scope ?? [], recorded }));
      process.kill(process.pid, "SIGKILL");
      return;
    }
  });
  await operations.subtreeControl(root.conversationId, { requestId: "accept-partial", action: "stop", stopSource: "user" });
  throw new Error("the first child's outcome commit was not observed");
}

// A delegating conversation and the child its real anchor admits. The process dies once the admission is durable, so the
// store holds a real anchor record a build without that definition has to describe.
const base = process.env.HEPI_ACCEPTANCE_BASE;
assert.ok(base !== undefined, "the blocked stage is given HEPI_ACCEPTANCE_BASE");
const workspace = join(base, "workspace");
const home = join(base, "home");
await mkdir(join(workspace, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(workspace, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
const crash = await openCrashHarness(dbPath, {
  root: workspace,
  home,
  script: (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
      if (messages.some(message => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-spawn" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  },
});
const parent = await crash.operations.spawn({
  requestId: "accept-parent",
  ownership: { kind: "ownerless" },
  workspaceId: CRASH_WORKSPACE,
  agent: { model: SERVER_MODEL, extensions: [crash.extension] },
});
await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "accept-delegate" }, BACKGROUND_CONTEXT);
const dispatchId = String(parent.conversationId) + ":call-spawn";
const deadline = Date.now() + 30_000;
let childId = "";
for (;;) {
  const dispatch = await crash.harness.harness.snapshot(DispatchDoc, Number(parent.conversationId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);
  childId = dispatch?.childConversationId ?? "";
  if (childId !== "" && dispatch?.submissionId !== undefined) break;
  if (Date.now() > deadline) throw new Error("the delegation never admitted its child");
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
}
console.log(JSON.stringify({ stage, rootId: parent.conversationId, childId, dispatchId }));
process.kill(process.pid, "SIGKILL");
