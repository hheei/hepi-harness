import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SUBMISSION_IMAGE_BYTES, MAX_SUBMISSION_IMAGES, validateCommand } from "../src/index.ts";

/** A real 1x1 RGBA PNG, so the accepted data is bytes a decoder accepts rather than a marker. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = { type: "image" as const, data: TINY_PNG, mimeType: "image/png" };
const submit = (extra: Record<string, unknown>) => ({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "", ...extra });

test("accepts an image-only submission and reports the image limits as codes", () => {
  assert.deepEqual(validateCommand(submit({ images: [image] })), { ok: true });
});

test("does not treat an empty image list as an image submission", () => {
  assert.deepEqual(validateCommand(submit({ images: [] })), { ok: false, code: "invalid_text" });
  assert.deepEqual(validateCommand(submit({ text: "hello", images: [] })), { ok: true });
});

test("keeps a text-only submission valid with the same limits", () => {
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello" }), { ok: true });
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: " " }), { ok: false, code: "invalid_text" });
  assert.deepEqual(validateCommand(submit({})), { ok: false, code: "invalid_text" });
});

test("rejects unsupported, oversized and too many image attachments with a readable message", () => {
  const rejections: [unknown, RegExp][] = [
    [[{ ...image, type: "text" }], /must be an image/],
    [[{ ...image, mimeType: "text/plain" }], /image data/],
    [[{ ...image, data: "not base64!" }], /valid base64/],
    [[{ ...image, data: "A".repeat(Math.ceil((MAX_SUBMISSION_IMAGE_BYTES + 1) / 3) * 4) }], /10MB/],
    [Array.from({ length: MAX_SUBMISSION_IMAGES + 1 }, () => image), /at most 10 images/],
    ["images", /must be an array/],
  ];
  for (const [images, pattern] of rejections) {
    const result = validateCommand(submit({ images }));
    assert.equal(result.ok, false, JSON.stringify(images).slice(0, 60));
    assert.equal(result.code, "invalid_images");
    assert.match(result.message, pattern);
  }
});

test("counts decoded bytes, not base64 characters, against the documented limit", () => {
  // 3 bytes per 4 base64 characters, so the largest whole block below the limit is 10MB - 1.
  const atLimit = "A".repeat((MAX_SUBMISSION_IMAGE_BYTES - 1) / 3 * 4);
  assert.deepEqual(validateCommand(submit({ images: [{ ...image, data: atLimit }] })), { ok: true });
  assert.equal(validateCommand(submit({ images: [{ ...image, data: atLimit + "AAAA" }] })).ok, false);
});
