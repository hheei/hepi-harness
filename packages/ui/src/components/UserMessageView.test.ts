import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import type { ResourceReader, ResourceResult } from "@hepi/session/resources";
import type { TextContent, UserMessage } from "../lib/types.ts";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as typeof import("esbuild");

/**
 * The whole prompt a copy or an edit acts on.
 *
 * A heavy prompt arrives as a bounded preview that names the read block restoring it, and `useWholePrompt` is the one
 * place that turns those previews back into the text the reader typed. Its answer is what the clipboard and the edit
 * draft get, so the rule these cases pin is the one a reader would state: after the prompt has been read once, every
 * later answer is still the **whole** text — not the preview the frame carried.
 *
 * The failure this replaced: the resolved texts were reported only while some block was still unread, so the second copy
 * of a prompt — and a copy after the reader expanded the block by hand — wrote the truncated preview while the bubble
 * showed the whole text. Both triggers are driven here through the hook the surface uses.
 */
const bundle: string = buildSync({
  entryPoints: [path.join(import.meta.dirname, "UserMessageView.tsx")],
  bundle: true, write: false, platform: "node", format: "cjs",
  // The hook reads React and the connection; the presentation imports are the component's, which these cases never
  // render, so they stay out of the bundle and are answered by a stub below.
  external: [
    "react", "./MarkdownBody", "./MessageImages", "./MessageTextBlocks", "../hooks/useI18n", "../lib/clipboard",
    "../lib/slash-display", "../lib/workbench-scope",
  ],
}).outputFiles[0].text;

type WholePrompt = {
  textBlocks: TextContent[];
  readWholePrompt(): Promise<string[]>;
  textAt(index: number): string;
  resolveText(index: number, text: string): void;
};

type HookModule = { useWholePrompt(message: UserMessage): WholePrompt };

/** A connection's reader answering one table and recording every address it was asked for. */
function fakeReader(answers: Record<string, ResourceResult<string>>): ResourceReader & { reads: string[] } {
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

/** One mount: the state slots React would keep, rendered again whenever a setter changed one. */
function mountHook(t: test.TestContext, message: UserMessage, reader: ResourceReader) {
  const slots: unknown[] = [];
  let current: { index: number } | null = null;
  let output: WholePrompt | null = null;
  const react = {
    useState(initial: unknown) {
      assert.ok(current, "a hook ran outside a render");
      const index = current.index++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[index], (next: unknown) => {
        const previous = slots[index];
        const value = typeof next === "function" ? (next as (held: unknown) => unknown)(previous) : next;
        if (Object.is(value, previous)) return;
        slots[index] = value;
        render();
      }];
    },
    useContext: () => ({ client: { resources: reader } }),
  };
  // The connection is the hook's only collaborator here: the reader it hands out is the fixture's, and the presentation
  // modules the component imports are never rendered.
  const stubs: Record<string, unknown> = {
    "../lib/workbench-scope": { useOptionalResourceReader: () => reader },
    "../hooks/useI18n": { useI18n: () => ({ t: (key: string) => key }) },
    "../lib/clipboard": { copyText: async () => {} },
    "../lib/slash-display": { skillExpansionToCommand: () => null },
    "./MarkdownBody": { MarkdownBody: () => null },
    "./MessageImages": { MessageImage: () => null },
    "./MessageTextBlocks": { DeferredText: () => null, SafeMarkdownBody: () => null },
  };
  const sandbox = {
    module: { exports: {} as unknown },
    require: (name: string) => (name === "react" ? react : stubs[name]),
    console,
  };
  vm.runInNewContext(bundle, sandbox);
  const hooks = sandbox.module.exports as HookModule;
  const render = () => {
    current = { index: 0 };
    output = hooks.useWholePrompt(message);
  };
  render();
  t.after(() => { output = null; });
  return { current: () => { assert.ok(output, "the hook has rendered"); return output; }, slots };
}

const deferred = (textUrl: string, preview: string): TextContent => ({ type: "text", text: preview, deferred: true, textUrl });
/** The texts an answer holds, as this realm's array: the hook runs in its own context, so its arrays are its own. */
const textsOf = (texts: readonly string[]): string[] => Array.from(texts);
const WHOLE = "the whole prompt, restored from its read block";
const INLINE = "an inline tail block";

test("a prompt is read once, and a second copy still reports the whole text", async (t) => {
  const reader = fakeReader({ "/api/sessions/s/entries/p/text?blockIndex=0": { ok: true, value: WHOLE } });
  const message: UserMessage = { role: "user", content: [deferred("/api/sessions/s/entries/p/text?blockIndex=0", "the whole prompt…"), { type: "text", text: INLINE }] };
  const prompt = mountHook(t, message, reader);

  assert.deepEqual(textsOf(await prompt.current().readWholePrompt()), [WHOLE, INLINE], "the first copy reads the block it names");
  assert.deepEqual(reader.reads, ["/api/sessions/s/entries/p/text?blockIndex=0"], "one read, through the connection's reader");

  // Nothing is unread now, and the answer is still the prompt itself rather than the preview the frame carried.
  assert.deepEqual(textsOf(await prompt.current().readWholePrompt()), [WHOLE, INLINE], "a repeated copy reports the resolved text");
  assert.deepEqual(reader.reads, ["/api/sessions/s/entries/p/text?blockIndex=0"], "a resolved block is not read again");
  assert.equal(prompt.current().textAt(0), WHOLE, "the bubble and a copy agree");
});

test("a block the reader expanded by hand is what a later copy reports", async (t) => {
  const reader = fakeReader({ "/api/sessions/s/entries/p/text?blockIndex=0": { ok: true, value: WHOLE } });
  const message: UserMessage = { role: "user", content: [deferred("/api/sessions/s/entries/p/text?blockIndex=0", "the whole prompt…")] };
  const prompt = mountHook(t, message, reader);

  // The expand control reads the block and reports what it is now showing, which is the surface's own state.
  prompt.current().resolveText(0, WHOLE);
  assert.equal(prompt.current().textAt(0), WHOLE, "the expanded block shows the whole text");

  assert.deepEqual(textsOf(await prompt.current().readWholePrompt()), [WHOLE], "a copy after expanding writes what the bubble shows");
  assert.deepEqual(reader.reads, [], "the copy reads nothing: the text was already loaded");
});
