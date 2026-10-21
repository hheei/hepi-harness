import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { ResourceReader, ResourceResult } from "@hepi/session/resources";
import type { TextContent } from "./types.ts";

/** One refusal this reader states, as the loader surfaces it. */
type RefusalError = Error & { reason: string };


const { isDeferredTextBlock, loadDeferredText, loadTextBlockOriginals } = await createJiti(import.meta.url, { tsconfigPaths: true }).import<typeof import("./deferred-text.ts")>("./deferred-text.ts");
const { ResourceReadError } = await createJiti(import.meta.url, { tsconfigPaths: true }).import<typeof import("./resource-read.ts")>("./resource-read.ts");

/** One read a connection's reader answered, as a deferred block would state it. */
type ReadAnswer = ResourceResult<string>;

/** A connection's reader, answering from one table and recording every address it was asked for. */
function fakeReader(answers: Record<string, ReadAnswer>): ResourceReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    resolve: (address: string) => address,
    text: async (address: string) => { reads.push(address); return answers[address] ?? { ok: false, reason: "not_found" }; },
    image: async () => ({ ok: false, reason: "not_found" }),
    retained: { images: 0, imageBytes: 0, texts: 0, textBytes: 0 },
    dispose() {},
  };
}

test("a deferred text is read through the connection's reader, once per block, and never through the global fetch", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("the loader must not fetch directly"); };
  try {
    const first = "/api/sessions/originals/entries/11/text?blockIndex=0";
    const second = "/api/sessions/originals/entries/11/text?blockIndex=2";
    const original = "  α\r\n\tbytes preserved\n";
    const reader = fakeReader({
      [first]: { ok: true, value: original },
      [second]: { ok: true, value: "second whole" },
    });
    const blocks: TextContent[] = [
      { type: "text", text: "preview", deferred: true, textUrl: first },
      { type: "text", text: "inline" },
      { type: "text", text: "preview", deferred: true, textUrl: second },
    ];
    assert.equal(isDeferredTextBlock(blocks[0]), true);
    assert.equal(isDeferredTextBlock(blocks[1]), false);
    assert.deepEqual(await loadTextBlockOriginals(reader, blocks), [original, "inline", "second whole"]);
    assert.deepEqual(reader.reads, [first, second], "only the deferred blocks were read, in order");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched, [], "the loader never assembled a request of its own");
});

test("a refusal rejects with its name so a copy or edit refuses instead of acting on a preview", async () => {
  const block = "/api/sessions/refused/entries/12/text?blockIndex=0";
  const reader = fakeReader({ [block]: { ok: false, reason: "oversize" } });
  await assert.rejects(loadDeferredText(reader, block), (error: RefusalError) => {
    assert.equal(error instanceof ResourceReadError, true);
    assert.equal(error.reason, "oversize");
    return true;
  });
  // All-or-nothing: one refused block fails the whole action rather than letting half of it through.
  await assert.rejects(loadTextBlockOriginals(reader, [
    { type: "text", text: "inline" },
    { type: "text", text: "preview", deferred: true, textUrl: block },
  ]), (error: RefusalError) => error.reason === "oversize");
});

test("a surface outside a workbench has no reader, and says so instead of asking its own origin", async () => {
  await assert.rejects(loadDeferredText(null, "/api/sessions/s/entries/13/text?blockIndex=0"), (error: RefusalError) => error.reason === "unavailable");
});
