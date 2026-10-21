import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const { openResourceImage, readResourceText, resourceRefusalKey, ResourceReadError } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./resource-read.ts");

/** A reader that answers exactly what one case needs and records what it was asked. */
function fakeReader(answers) {
  const reads = [];
  return {
    reads,
    resolve: (address) => address,
    text: async (address, options) => { reads.push({ kind: "text", address, signal: options?.signal }); return answers.text(address); },
    image: async (address, options) => { reads.push({ kind: "image", address, signal: options?.signal }); return answers.image(address); },
    retained: { images: 0, imageBytes: 0, texts: 0, textBytes: 0 },
    dispose() {},
  };
}

test("a text read is the reader's own answer, and every refusal keeps its name", async () => {
  const reader = fakeReader({ text: async (address) => address.endsWith("good") ? { ok: true, value: "the whole text" } : { ok: false, reason: "forbidden" } });
  assert.equal(await readResourceText(reader, "/api/sessions/s/entries/e/text?blockIndex=0/good"), "the whole text");
  await assert.rejects(readResourceText(reader, "/api/sessions/s/entries/e/text?blockIndex=1"), (error) => {
    assert.equal(error instanceof ResourceReadError, true);
    assert.equal(error.reason, "forbidden");
    assert.equal(error.message, "forbidden");
    return true;
  });
  // Every reason is a label a surface can say out loud rather than an empty failure.
  for (const reason of ["unauthorized", "forbidden", "not_found", "oversize", "unavailable", "disposed"]) {
    assert.match(resourceRefusalKey(reason), /^i18n\.resource/, reason);
  }
  assert.equal(new Set(["unauthorized", "forbidden", "not_found", "oversize", "unavailable", "disposed"].map(resourceRefusalKey)).size, 6);
});

test("a surface with no connection refuses as unavailable instead of asking the document's own origin", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => { calls.push(args[0]); throw new Error("no raw fetch may happen"); };
  try {
    await assert.rejects(readResourceText(null, "/api/sessions/s/entries/e/text?blockIndex=0"), (error) => error.reason === "unavailable");
    const states = [];
    const release = openResourceImage(null, "/api/sessions/s/entries/e/tool-result-image?blockIndex=0", (state) => states.push(state));
    release();
    assert.deepEqual(states, [{ status: "loading" }, { status: "refused", reason: "unavailable" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [], "a surface without a connection never reached for the global fetch");
});

test("an image read publishes the leased blob, and releasing it hands the lease back", async () => {
  let released = 0;
  const lease = { url: "blob:hepi/1", mimeType: "image/png", bytes: 3, release: () => { released += 1; }, revoked: false };
  const reader = fakeReader({ image: async () => ({ ok: true, value: lease }) });
  const states = [];
  const release = openResourceImage(reader, "/api/sessions/s/entries/e/tool-result-image?blockIndex=0", (state) => states.push(state));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(states, [{ status: "loading" }, { status: "ready", url: "blob:hepi/1", mimeType: "image/png" }]);
  assert.equal(released, 0, "the lease is held while the surface shows it");
  release();
  assert.equal(released, 1, "unmount or a change of address releases the lease");
  release();
  assert.equal(released, 1, "releasing twice does not take another reader's blob");
});

test("an answer that arrives after the surface left is released, never published into the next scope", async () => {
  let released = 0;
  let settle;
  const lease = { url: "blob:hepi/2", mimeType: "image/png", bytes: 3, release: () => { released += 1; }, revoked: false };
  const reader = fakeReader({ image: () => new Promise((resolve) => { settle = resolve; }) });
  const states = [];
  const release = openResourceImage(reader, "/api/sessions/s/entries/e/tool-result-image?blockIndex=0", (state) => states.push(state));
  // The connection or the address changed before the Gateway answered.
  release();
  settle({ ok: true, value: lease });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(states, [{ status: "loading" }], "a surface that stopped asking publishes nothing");
  assert.equal(released, 1, "the late lease is released rather than left to a blob nobody would revoke");
});

test("a refused image is a named state, and a failing reader is unavailable", async () => {
  const refusing = fakeReader({ image: async () => ({ ok: false, reason: "oversize" }) });
  const refused = [];
  openResourceImage(refusing, "/api/sessions/s/entries/e/tool-result-image?blockIndex=0", (state) => refused.push(state));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(refused.at(-1), { status: "refused", reason: "oversize" });

  const failing = fakeReader({ image: async () => { throw new Error("transport"); } });
  const failed = [];
  openResourceImage(failing, "/api/sessions/s/entries/e/tool-result-image?blockIndex=0", (state) => failed.push(state));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(failed.at(-1), { status: "refused", reason: "unavailable" });
});

test("the surfaces that render read blocks reach them through the connection, never through a raw global fetch", async () => {
  const sources = await Promise.all([
    readFile(new URL("../components/MessageView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./deferred-text.ts", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /\bfetch\s*\(/, "a resource consumer reached for the global fetch");
    assert.doesNotMatch(source, /["'`]\/api\/sessions\//, "a resource consumer assembled a relative read-block URL");
  }
  assert.match(sources[0], /useOptionalResourceReader\(\)/, "MessageView does not read its connection's reader");
  assert.match(sources[0], /thinkingUrl\(/, "thinking is not addressed by the protocol's own read block");
  assert.match(sources[1], /readResourceText\(/, "the deferred-text loader does not read through the connection's reader");
});
