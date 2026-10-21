/**
 * Ticket 02's restart window: one MCP call killed **inside** it, in its own backend process, over one SQLite file that
 * a later stage reopens.
 *
 * The adapter's registration runs a host call, and the host here is a stub that performs one external side effect — a
 * line appended to a real file outside the store — and then never returns. So the kill lands with the effect on disk and
 * the call in `execute`, which is the only state that says anything about a replay: the tool is registered
 * `replay: "unsafe"`, so a recovered runtime must settle it as `interrupted` and must not run the body again. Two
 * numbers carry that: the line count of the effects file (the external side effect happened once) and this reopened
 * build's own host-call counter (a replay would make it one, where the killed build left it at zero calls here).
 *
 * The gateway is deliberately out of frame: its own contract, including its rule that a lost mutation answer is
 * `outcome_unknown` and is never replayed, is ticket 01's and is tested at `POST /v1/mcp`. What this stage pins is the
 * seam ticket 02 owns — the durable lifecycle of a call that may have acted.
 *
 * The reopen stage is told which conversation the killed one left behind, because the settled call's own task record is
 * gone by the second reopen and a store with several conversations is not this stage's to guess about.
 *
 * Usage: node test/mcp-replay-crash-child.ts <kill-inside-call|reopen> <dbPath> <base> <effectsPath> [conversationId]
 */
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { McpToolCallRequest, McpToolCallResult } from "@hepi/protocol/gateway";
import { openServerHarness } from "../src/harness.ts";
import { createConversationOperations } from "../src/conversation-operations.ts";
import { createMcpToolBridge, mcpToolName } from "../src/mcp-conversation-tools.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, base, effectsPath, givenConversationId] = process.argv;
assert.ok(stage === "kill-inside-call" || stage === "reopen", "stage is kill-inside-call or reopen");
assert.ok(dbPath !== undefined && base !== undefined && effectsPath !== undefined, "usage: mcp-replay-crash-child <stage> <db> <base> <effects>");

/** The one tool of the one host, named exactly as a deployment's declaration would name it. */
const NAME = mcpToolName("workstation", "notes", "record");

/** How many times **this** process reached the host. In the reopened build, that count is the replay measurement. */
let hostCalls = 0;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond: FauxResponseFactory = async (transcript) => {
  faux.setResponses([respond]);
  // The script never calls the MCP tool a second time: what is being measured is recovery's own behaviour, not a
  // model that chose to retry. A turn that resumes after the interrupted settlement only answers.
  const answered = transcript.messages.some(message => message.role === "toolResult");
  return answered ? fauxAssistantMessage("recovered without a repeat") : fauxAssistantMessage([fauxToolCall(NAME, { note: "once" }, { id: "call-unsafe" })], { stopReason: "toolUse" });
};
faux.setResponses([respond]);

const bridge = createMcpToolBridge({
  declarations: [{ gatewayId: "workstation", scope: "global", server: "notes", tool: "record", description: "Return the note it was given.", inputSchema: { type: "object", properties: { note: { type: "string" } } } }],
  // The conversation's host is one fixed fact here: this stage pins the lifecycle, so it carries no workspace store.
  target: async () => ({ gatewayId: "workstation", workspaceId: "local" }),
  invoke: async (_gatewayId: string, _request: McpToolCallRequest): Promise<McpToolCallResult> => {
    hostCalls += 1;
    // The external side effect, then a call that never ends: the kill lands inside the body, not before it.
    await appendFile(effectsPath!, "published\n");
    return await new Promise<McpToolCallResult>(() => {});
  },
  diagnostics: () => {},
});
assert.deepEqual(bridge.refused(), [], "the declared tool installed");

// The real harness, the real creation seam and the real store: the same composition the backend's own server builds,
// with no execution environment because this call reaches a host stub rather than a workspace.
const harness = await openServerHarness(dbPath!, SERVER_MODEL, models, undefined, { startPaused: true });
harness.install(bridge.extension);
assert.deepEqual(harness.failures, [], "the MCP extension installed");
const operations = createConversationOperations(harness.harness);

/** The tool tasks this store holds. An unsettled one is a call still in flight. */
const toolTasks = async () => (await harness.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => task.record.kind === "pi.tool");

const conversationId = String(stage === "kill-inside-call"
  ? (await operations.spawn({ requestId: "unsafe-parent", ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, extensions: [bridge.extension] } })).conversationId
  : givenConversationId);
assert.ok(conversationId !== "undefined" && conversationId !== "", "the store names the conversation the call belongs to");

const conversation = await harness.harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
assert.ok(conversation !== undefined, "the conversation is readable by the reopened build");

if (stage === "kill-inside-call") {
  await conversation.submit({ type: "input", content: [{ type: "text", text: "publish it" }], requestId: "unsafe-turn" }, BACKGROUND_CONTEXT);
  harness.harness.resume();
  // The kill has to land **inside** the call, after its effect is on disk: the checkpoint alone says the task reached
  // `execute`, which is a statement made before the body ran. So the file the host appended is what is waited for.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const recorded = await readFile(effectsPath!, "utf8").catch(() => "");
    if (recorded.includes("published")) {
      const executing = (await toolTasks()).find(task => (task.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase === "execute");
      if (executing !== undefined) break;
    }
    if (Date.now() > deadline) throw new Error("the MCP call never reached its execute phase with its effect written");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  console.log(JSON.stringify({ stage, conversationId, checkpoint: "unsafe-executing", callsBeforeKill: hostCalls }));
  // No clean close, no drain, no flush: the kill is the stage. What the store holds afterwards is the input to the
  // reopen, and any graceful shutdown here would settle the call by agreement instead of leaving it interrupted.
  process.kill(process.pid, "SIGKILL");
} else {
  // A fresh build over the store the killed one left: recovery must settle the call and must not run it.
  harness.harness.resume();
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await toolTasks()).length === 0) break;
    if (Date.now() > deadline) throw new Error("the interrupted MCP call never settled: " + JSON.stringify((await toolTasks()).map(task => task.record.state)));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // The drain is the whole window: after it, a reopened build may have run a model round but must have reached no host.
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
  const entries = await harness.harness.commit(tx => tx.scanEntries({ conversationId: Number(conversationId) as ConversationId, order: "ascending" }, 200, undefined), BACKGROUND_CONTEXT);
  const results = entries.items.filter(entry => entry.kind === "pi.tool-result");
  // The runtime's own settlement wording is the evidence: it is what says the call was settled, not re-run.
  const settlement = JSON.stringify(results[0]?.data ?? {});
  console.log(JSON.stringify({
    stage,
    callsAfterRestart: hostCalls,
    results: results.length,
    interrupted: /may have partially run/.test(settlement),
    settlement: settlement.slice(0, 500),
  }));
  assert.equal(hostCalls, 0, "the reopened build reached the MCP host no time at all");
  assert.equal(results.length, 1, "the interrupted call settled exactly one result entry");
  assert.match(settlement, /may have partially run/);
}

// The reopen stage's own record is what is asserted, so it leaves the way the other crash children do.
process.exit(0);
