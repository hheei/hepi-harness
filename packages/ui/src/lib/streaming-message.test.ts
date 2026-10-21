import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AssistantContentBlock, AgentMessage, AssistantMessage } from "./types.ts";
import type { StreamingState } from "./streaming-message.ts";

const { INITIAL_STREAMING_STATE, streamReducer } = await createJiti(import.meta.url).import<typeof import("./streaming-message.ts")>("./streaming-message.ts");

/** An assistant message as a live frame states one, with the tool call written the way the runtime writes it. */
const assistant = (content: AssistantContentBlock[]): AgentMessage =>
  ({ role: "assistant", content, model: "fixture", provider: "fixture" });
const snapshot = (message: AgentMessage): StreamingState =>
  streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message });

/** The live bubble's message: a case that reached this point is about its content, not about its presence. */
function bubble(state: StreamingState): AssistantMessage {
  assert.ok(state.streamingMessage, "the run's live message is on screen");
  return state.streamingMessage;
}

test("a live snapshot replaces the bubble with the message the frame states, and the run's end clears it", () => {
  // A tool call arrives with the fields the native message carries, and the bubble renders it exactly as its committed
  // entry will: the normalisation is the one piece of assembly left now that whole messages replace block deltas.
  // The runtime writes a streamed tool call as id/name/arguments; the bubble states it as the committed entry does.
  const streamed = { type: "toolCall", id: "c", name: "write", arguments: { path: "/tmp/a" } } as unknown as AssistantContentBlock;
  const streaming = snapshot(assistant([streamed]));
  assert.equal(streaming.isStreaming, true);
  assert.deepEqual(bubble(streaming).content, [
    { type: "toolCall", toolCallId: "c", toolName: "write", input: { path: "/tmp/a" } },
  ]);

  // A later snapshot is the newer message, not a merge of the two.
  const replaced = streamReducer(streaming, { type: "snapshot", message: assistant([{ type: "text", text: "done" }]) });
  assert.deepEqual(bubble(replaced).content, [{ type: "text", text: "done" }]);
  assert.notEqual(replaced.streamingMessage, streaming.streamingMessage);

  // A message that is not an assistant's is not the live bubble.
  assert.equal(streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message: { role: "user", content: "hi" } }), INITIAL_STREAMING_STATE);

  const resumed = streamReducer(replaced, { type: "resume" });
  assert.equal(resumed.isStreaming, true);
  assert.deepEqual(bubble(resumed).content, bubble(replaced).content);
  assert.equal(streamReducer(resumed, { type: "end" }), INITIAL_STREAMING_STATE);
});
