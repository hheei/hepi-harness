import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-attachments.ts");
}

const image = { type: "image", mimeType: "image/png", data: "YWJj" };

test("image attachments enforce decoded byte limits, supported types and available slots", async () => {
  { // Decoded base64 length
  const { getBase64DecodedByteLength } = await loadSubject();

  assert.equal(getBase64DecodedByteLength("YQ=="), 1);
  assert.equal(getBase64DecodedByteLength("YWI="), 2);
  assert.equal(getBase64DecodedByteLength("YWJj"), 3);
  assert.equal(getBase64DecodedByteLength("not base64!"), null);
  }
  { // Browser file selection
  const { MAX_ATTACHED_IMAGE_BYTES, selectImageFiles } = await loadSubject();
  const file = (name: string, type: string, size: number) => ({ name, type, size });
  const { accepted, rejected } = selectImageFiles([
    file("ok.png", "image/png", 1024),
    file("notes.txt", "text/plain", 10),
    file("huge.png", "image/png", MAX_ATTACHED_IMAGE_BYTES + 1),
    file("extra.png", "image/png", 1024),
  ], 1);

  assert.deepEqual(accepted.map((entry) => entry.name), ["ok.png"]);
  assert.deepEqual(rejected, [
    { name: "notes.txt", reason: "unsupported" },
    { name: "huge.png", reason: "too-large" },
    { name: "extra.png", reason: "too-many" },
  ]);
  assert.deepEqual(selectImageFiles([file("ok.png", "image/png", 1)], 0), { accepted: [], rejected: [{ name: "ok.png", reason: "too-many" }] });
  }
  { // Agent input validation
  const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, validateAgentImages } = await loadSubject();
  const oversizedData = "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3));

  assert.equal(validateAgentImages([image]), null);
  assert.match(String(validateAgentImages([{ ...image, mimeType: "text/plain" }])), /valid base64 image/);
  assert.match(String(validateAgentImages([{ ...image, data: oversizedData }])), /10MB/);
  assert.match(String(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image))), /at most/);
  }
});
