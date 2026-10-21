import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { INITIAL_STREAMING_STATE, streamReducer } = await createJiti(import.meta.url).import("./streaming-message.ts");
const assistant = content => ({ role: "assistant", content, model: "fixture", provider: "fixture" });
const snapshot = message => streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message });

test("a live snapshot replaces the bubble with the message the frame states, and the run's end clears it", () => {
  // A tool call arrives with the fields the native message carries, and the bubble renders it exactly as its committed
  // entry will: the normalisation is the one piece of assembly left now that whole messages replace block deltas.
  const streaming = snapshot(assistant([{ type: "toolCall", id: "c", name: "write", arguments: { path: "/tmp/a" } }]));
  assert.equal(streaming.isStreaming, true);
  assert.deepEqual(streaming.streamingMessage.content, [
    { type: "toolCall", toolCallId: "c", toolName: "write", input: { path: "/tmp/a" } },
  ]);

  // A later snapshot is the newer message, not a merge of the two.
  const replaced = streamReducer(streaming, { type: "snapshot", message: assistant([{ type: "text", text: "done" }]) });
  assert.deepEqual(replaced.streamingMessage.content, [{ type: "text", text: "done" }]);
  assert.notEqual(replaced.streamingMessage, streaming.streamingMessage);

  // A message that is not an assistant's is not the live bubble.
  assert.equal(streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message: { role: "user", content: "hi" } }), INITIAL_STREAMING_STATE);

  const resumed = streamReducer(replaced, { type: "resume" });
  assert.equal(resumed.isStreaming, true);
  assert.deepEqual(resumed.streamingMessage.content, replaced.streamingMessage.content);
  assert.equal(streamReducer(resumed, { type: "end" }), INITIAL_STREAMING_STATE);
});
