import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { turnAnchorEntryId, turnKeyForEntry, turnKeyForAnchorEntry, turnByKey } = await jiti.import("./chat-turn-identity.ts");
const { buildTurnModel } = await jiti.import("./chat-turn-model.ts");

const messages = [
  { role: "assistant", content: [{ type: "text", text: "first half of a split turn" }] },
  { role: "user", content: "question one" },
  { role: "assistant", content: [{ type: "text", text: "answer one" }] },
  { role: "user", content: "question two" },
  { role: "assistant", content: [{ type: "text", text: "answer two" }] },
];
const entryIds = ["e1", "e2", "e3", "e4", "e5"];
const model = buildTurnModel({ messages, entryIds, sessionBusy: false, isStreaming: false });

test("chat turn identity resolution and leading mid-turn segment invariants", () => {
  // 1. Leading mid-turn segment identified by first message, not anchor
  const leading = model.turns[0];
  assert.equal(leading.anchorEntryId, null);
  assert.equal(turnAnchorEntryId(leading, entryIds), "e1");
  assert.equal(turnAnchorEntryId(model.turns[1], entryIds), "e2");

  // 2. Entry resolves to containing turn, including leading segment
  assert.equal(turnKeyForEntry(model.turns, entryIds, "e1"), model.turns[0].key);
  assert.equal(turnKeyForEntry(model.turns, entryIds, "e3"), model.turns[1].key);
  assert.equal(turnKeyForEntry(model.turns, entryIds, "e5"), model.turns[2].key);
  assert.equal(turnKeyForEntry(model.turns, entryIds, "absent"), null);

  // 3. Turn resolves from anchor entry and leading segment resolves from first entry
  assert.equal(turnKeyForAnchorEntry(model.turns, entryIds, "e2"), model.turns[1].key);
  assert.equal(turnKeyForAnchorEntry(model.turns, entryIds, "e1"), model.turns[0].key);
  assert.equal(turnByKey(model.turns, model.turns[2].key), model.turns[2]);
  assert.equal(turnByKey(model.turns, "turn-absent"), null);

  // 4. Leading segment has no anchor message, positional index defect prevented by identity
  assert.equal(model.turns[0].anchorEntryId, null);
  assert.equal(model.turns[0].key, "turn-e1");
  assert.equal(turnKeyForEntry(model.turns, entryIds, "e1"), model.turns[0].key);
  assert.equal(turnKeyForAnchorEntry(model.turns, entryIds, "e1"), model.turns[0].key);
});
