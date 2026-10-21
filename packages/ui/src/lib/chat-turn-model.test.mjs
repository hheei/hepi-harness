import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildTurnModel, resolveSearchTarget } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./chat-turn-model.ts");

test("settled turns group process and written files; live turns and search reveal retain entry identity", () => {
  const messages = [
    { role: "user", content: "write it" },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "out.txt" } }] },
    { role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "written" }, { type: "text", text: "details" }] },
  ];
  const input = {
    messages, entryIds: ["e0", "e1", "e2", "e3"], cwd: "/repo",
    toolResults: new Map([["w1", messages[2]]]), sessionBusy: false, isStreaming: false,
  };
  const model = buildTurnModel(input);
  const [turn] = model.turns;
  assert.equal(turn.anchorEntryId, "e0");
  assert.deepEqual(turn.items.map(item => item.kind), ["message", "process", "answer"]);
  assert.equal(turn.items[1].toolCallCount, 1);
  assert.equal(turn.items[1].defaultExpanded, false);
  assert.deepEqual(turn.items[2].writtenFiles.map(file => file.filePath), ["/repo/out.txt"]);
  assert.deepEqual(turn.items.filter(item => item.showTimestamp).map(item => item.index), [3]);
  const live = buildTurnModel({ ...input, sessionBusy: true, isStreaming: true });
  assert.equal(live.turns[0].live, true);
  assert.deepEqual(live.turns[0].items.map(item => item.kind), Array(4).fill("message"));
  assert.equal(live.turns[0].key, turn.key);
  assert.deepEqual([...buildTurnModel(input).refIndexByMessage], [...model.refIndexByMessage]);
  const found = buildTurnModel({ ...input, searchTarget: { entryId: "e1" } });
  assert.equal(found.turns[0].items[1].reveal, true);
  assert.equal(resolveSearchTarget(messages, input.entryIds, { entryId: "e3", blockIndex: 1 }).block.text, "details");
  assert.equal(resolveSearchTarget(messages, input.entryIds, { entryId: "missing" }).message, undefined);
});
