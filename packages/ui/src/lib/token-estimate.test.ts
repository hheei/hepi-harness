import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, estimateUpdatedTokens, getTokenEstimateText } from "./token-estimate.ts";
import type { AssistantContentBlock } from "./types.ts";

test("a streamed chunk is charged for its appended suffix, not the whole text again", () => {
  const first = { text: "a".repeat(400), tokens: 100 };
  assert.equal(estimateUpdatedTokens(undefined, first.text), 100, "the first chunk is counted whole");
  // Four latin characters per token, so 400 more characters add exactly 100.
  assert.equal(estimateUpdatedTokens(first, "a".repeat(800)), 200);
  assert.equal(estimateUpdatedTokens(first, first.text), 100, "an unchanged text adds nothing");
});

test("CJK text counts one token per character beside latin text", () => {
  assert.equal(estimateTokens("汉".repeat(10)), 10);
  assert.equal(estimateTokens("a".repeat(8)), 2);
  assert.equal(estimateTokens(`${"汉".repeat(3)}${"a".repeat(8)}`), 5);
});

test("a rewritten block is counted from scratch instead of as a suffix", () => {
  const previous = { text: "the first answer", tokens: 4 };
  assert.equal(estimateUpdatedTokens(previous, "a different answer"), estimateTokens("a different answer"));
});

test("a delta completing a surrogate pair does not double-count the split character", () => {
  // The previous chunk ended on the high half of one astral character; the delta completes it.
  const previousText = "a".repeat(4) + "\u{20000}".charAt(0);
  const previous = { text: previousText, tokens: estimateTokens(previousText) };
  const next = previousText + "\u{20000}".charAt(1);
  assert.equal(estimateTokens(next), 2, "the completed pair is one CJK character beside the four latin ones");
  assert.equal(estimateUpdatedTokens(previous, next), 2, "the pair is not counted twice across the two chunks");
});

test("only the text being written contributes to the estimate", () => {
  const text: AssistantContentBlock = { type: "text", text: "answer" };
  const thinking: AssistantContentBlock = { type: "thinking", thinking: "reasoning" };
  const toolCall: AssistantContentBlock = { type: "toolCall", toolCallId: "c", toolName: "bash", input: { command: "ls" } };
  const image: AssistantContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
  assert.equal(getTokenEstimateText(text), "answer");
  assert.equal(getTokenEstimateText(thinking), "reasoning");
  assert.equal(getTokenEstimateText(toolCall), JSON.stringify({ command: "ls" }));
  assert.equal(getTokenEstimateText(image), null, "an image carries no text to estimate");
});
