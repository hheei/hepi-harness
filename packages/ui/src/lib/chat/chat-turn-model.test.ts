import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AgentMessage, AssistantContentBlock, ToolResultMessage } from "../types.ts";
import type { TurnItem } from "./chat-turn-model.ts";

const { buildTurnModel, resolveSearchTarget } = await createJiti(import.meta.url, { tsconfigPaths: true }).import<typeof import("./chat-turn-model.ts")>("./chat-turn-model.ts");

/** The items of one turn, asserted so the model is read as the turn it describes. */
function itemsOf(turn: { items: TurnItem[] }): TurnItem[] {
  assert.ok(turn.items.length > 0, "the turn carries items");
  return turn.items;
}

/** The text a search target resolved to, asserted to be a text block. */
function textOf(block: AssistantContentBlock | undefined): string {
  assert.ok(block !== undefined && block.type === "text", "the target resolved to the text block it names");
  return block.text;
}

/** One item asserted to be the process group it is expected to be. */
function processOf(item: TurnItem): Extract<TurnItem, { kind: "process" }> {
  assert.equal(item.kind, "process");
  return item as Extract<TurnItem, { kind: "process" }>;
}

/** One item asserted to be the answer it is expected to be. */
function answerOf(item: TurnItem): Extract<TurnItem, { kind: "answer" }> {
  assert.equal(item.kind, "answer");
  return item as Extract<TurnItem, { kind: "answer" }>;
}

test("settled turns group process and written files; live turns and search reveal retain entry identity", () => {
  const { entryIds, messages, toolResults } = fixture();
  const input = { messages, entryIds, cwd: "/repo", toolResults, sessionBusy: false, isStreaming: false };
  const model = buildTurnModel(input);
  const [turn] = model.turns;
  assert.equal(turn.anchorEntryId, "e0");
  assert.deepEqual(turn.items.map(item => item.kind), ["message", "process", "answer"]);
  assert.equal(processOf(turn.items[1]).toolCallCount, 1);
  assert.equal(processOf(turn.items[1]).defaultExpanded, false);
  assert.deepEqual(answerOf(turn.items[2]).writtenFiles.map(file => file.filePath), ["/repo/out.txt"]);
  assert.deepEqual(turn.items.filter(item => item.kind === "answer" && item.showTimestamp).map(item => item.kind === "answer" ? item.index : -1), [3]);
  const live = buildTurnModel({ ...input, sessionBusy: true, isStreaming: true });
  assert.equal(live.turns[0].live, true);
  assert.deepEqual(live.turns[0].items.map(item => item.kind), Array(4).fill("message"));
  assert.equal(live.turns[0].key, turn.key);
  assert.deepEqual([...buildTurnModel(input).refIndexByMessage], [...model.refIndexByMessage]);
  const found = buildTurnModel({ ...input, searchTarget: { entryId: "e1" } });
  assert.equal(processOf(found.turns[0].items[1]).reveal, true);
  assert.equal(textOf(resolveSearchTarget(messages, entryIds, { entryId: "e3", blockIndex: 1 }).block), "details");
  assert.equal(resolveSearchTarget(messages, entryIds, { entryId: "missing" }).message, undefined);
});

/** One settled turn: a prompt, a write call, its result and the answer that carries the written file. */
function fixture(): { messages: AgentMessage[]; entryIds: string[]; toolResults: Map<string, ToolResultMessage> } {
  const result: ToolResultMessage = { role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] };
  const messages: AgentMessage[] = [
    { role: "user", content: "write it" },
    { role: "assistant", model: "fixture", provider: "fixture", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "out.txt" } }] },
    result,
    { role: "assistant", model: "fixture", provider: "fixture", content: [{ type: "text", text: "written" }, { type: "text", text: "details" }] },
  ];
  return { messages, entryIds: ["e0", "e1", "e2", "e3"], toolResults: new Map([["w1", result]]) };
}
