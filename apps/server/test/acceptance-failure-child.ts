/**
 * Ticket 13's failure-state stages: two stores left by a process that died, for the states a *different build* has to
 * describe truthfully.
 *
 * - unsafe: a model calls a tool whose definition says replay: "unsafe"; the body appends one line to a real file
 *   outside the store and then never returns, and the process dies inside it. The line count is the side-effect
 *   evidence: a later build that reran the call would make it two, and refusing to rerun it is the whole promise
 *   (spec D16, A20).
 * - delegation: a real delegation is created and admitted by the real anchor, then the process dies. The same store is
 *   later opened by builds that differ only in the task definitions they install, which is how missing_task, an
 *   incompatible version and a healthy recovery are read from one durable state instead of three fixtures.
 *
 * Usage: node test/acceptance-failure-child.ts <unsafe|delegation> <dbPath> <base>
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DispatchDoc } from "../src/subagents/host.ts";
import { openCrashHarness, CRASH_WORKSPACE, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, base] = process.argv;
assert.ok(stage !== undefined && dbPath !== undefined && base !== undefined, "usage: acceptance-failure-child <stage> <db> <base>");
assert.ok(stage === "unsafe" || stage === "delegation", "stage is unsafe or delegation");
const root = join(base, "workspace");
const home = join(base, "home");
/** The file the unsafe tool writes: one line per real execution, and the evidence a replay would double. */
export const SIDE_EFFECTS = join(base, "side-effects.log");
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

/**
 * The side effect that is not safe to repeat. Its body records one line and then never returns, so the kill lands inside
 * the call with exactly one recorded effect.
 */
const UnsafeTool = defineExtension({
  name: "acceptance-unsafe-tool",
  tools: [{
    name: "publish_external",
    description: "Publish something outside this machine. Not safe to repeat.",
    replay: "unsafe",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } as never,
    execute: async (): Promise<never> => {
      await appendFile(SIDE_EFFECTS, "published\n");
      return await new Promise<never>(() => {});
    },
  }],
});

const script = (faux: Parameters<NonNullable<Parameters<typeof openCrashHarness>[1]["script"]>>[0]): void => {
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
    if (messages.some((message) => message.role === "toolResult" && message.toolName === "publish_external")) return fauxAssistantMessage("published");
    if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
    if (stage === "unsafe") return fauxAssistantMessage([fauxToolCall("publish_external", { target: "prod" }, { id: "call-unsafe" })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-spawn" })], { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
};

const crash: CrashHarness = await openCrashHarness(dbPath!, { root, home, script });
if (stage === "unsafe") {
  crash.harness.install(UnsafeTool);
  assert.deepEqual(crash.harness.failures, [], "the unsafe tool extension installed");
}
const parent = await crash.operations.spawn({
  requestId: "failure-parent",
  ownership: { kind: "ownerless" },
  workspaceId: CRASH_WORKSPACE,
  agent: { model: SERVER_MODEL, extensions: [crash.extension, ...(stage === "unsafe" ? [UnsafeTool] : [])] },
});
const parentId = parent.conversationId;
const deadline = Date.now() + 30_000;

if (stage === "unsafe") {
  await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "publish it" }], requestId: "unsafe-turn" }, BACKGROUND_CONTEXT);
  // The kill has to land **inside** the call, after its effect is on disk: the checkpoint alone says the task reached
  // its execute phase, which is a statement before the body ran. So the file the body appends is what is waited for,
  // and the tool then never returns — the window is the body's own hang, not a race with it.
  for (;;) {
    const recorded = await readFile(SIDE_EFFECTS, "utf8").catch(() => "");
    if (recorded.includes("published")) {
      const executing = (await crash.harness.harness.inspect(BACKGROUND_CONTEXT)).tasks
        .filter((task) => task.record.kind === "pi.tool")
        .find((task) => (task.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase === "execute");
      if (executing !== undefined) break;
    }
    if (Date.now() > deadline) throw new Error("the unsafe tool never published inside its execute phase: " + JSON.stringify(await crash.harness.harness.inspect(BACKGROUND_CONTEXT)).slice(0, 600));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log(JSON.stringify({ stage, parentId, childId: "", dispatchId: "call-unsafe", checkpoint: "unsafe-executing" }));
} else {
  await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "failure-turn" }, BACKGROUND_CONTEXT);
  let childId = "";
  while (childId === "" && Date.now() < deadline) {
    const dispatch = await crash.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, parentId + ":call-spawn", BACKGROUND_CONTEXT);
    childId = dispatch?.childConversationId ?? "";
    if (childId !== "" && dispatch?.submissionId !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(childId, "", "the delegation created and admitted its child");
  console.log(JSON.stringify({ stage, parentId, childId, dispatchId: parentId + ":call-spawn", checkpoint: "anchor-v1-admitted" }));
}
process.kill(process.pid, "SIGKILL");
process.exit(1);
