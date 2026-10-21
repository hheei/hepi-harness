import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import type { DocxPreviewState } from "./useDocxPreview.ts";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as { buildSync: (options: Record<string, unknown>) => { outputFiles: { text: string }[] } };
const here = path.dirname(new URL(import.meta.url).pathname);
const hookBundle = buildSync({
  entryPoints: [path.join(here, "useDocxPreview.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react", "mammoth"],
}).outputFiles[0].text;

/**
 * The viewer's document read belongs to the mount, not to the render.
 *
 * The hook hands the byte read an `AbortController` of its own and aborts it when the document leaves the screen. That
 * is only a promise if the signal reaches the request the host is answering and the read parked on it: until
 * `readDocxBytes` put the signal on the request and closed the reader it was checked between chunks, so switching away
 * from a document a host had stopped sending, the answer was: keep waiting for a byte nobody would look at, and keep
 * the browser's side of that read - its stream, and the host reader serving it until the registry's TTL - open.
 * These cases drive the real call site (the address, the abort, the unmount) against a transport that stalls the way a
 * stalled host does, which is the only shape that shows the difference.
 *
 * mammoth stays external and is asserted never to load: every case here ends before a document is whole.
 */
const same = <T,>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean =>
  left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/** One hook slot as this harness keeps it: the deps it was installed with and the cleanup it must be released by. */
type Slot = { deps?: readonly unknown[]; effect?: () => (() => void) | undefined; cleanup?: () => void; value?: unknown };

/** The sandbox the bundled hook runs in: the CommonJS module it exports through, and the platform it reads. */
type Sandbox = {
  module: { exports: Record<string, unknown> };
  exports?: Record<string, unknown>;
  console: Console;
  AbortController: typeof AbortController;
  Response: typeof Response;
  ReadableStream: typeof ReadableStream;
  Headers: typeof Headers;
  Uint8Array: Uint8ArrayConstructor;
  require: (name: string) => unknown;
  globalThis?: unknown;
};

/** The React API the hook reads, with the dependency rule React itself applies. */
function reactShim() {
  let current: { slots: Slot[]; index: number } | null = null;
  const set = (slot: Slot) => (next: unknown) => {
    slot.value = typeof next === "function" ? (next as (previous: unknown) => unknown)(slot.value) : next;
  };
  return {
    begin(mount: { slots: Slot[]; index: number }) { current = mount; mount.index = 0; },
    api: {
      useEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]) {
        const mount = current;
        assert.ok(mount, "a hook ran outside a render");
        const index = mount.index++;
        const slot = mount.slots[index];
        if (slot === undefined) mount.slots[index] = { deps, effect, cleanup: effect() };
        else if (!same(slot.deps, deps)) { slot.cleanup?.(); slot.deps = deps; slot.effect = effect; slot.cleanup = effect(); }
      },
      useState(initial: unknown) {
        const mount = current;
        assert.ok(mount, "a hook ran outside a render");
        const index = mount.index++;
        const slot = mount.slots[index];
        if (slot === undefined) {
          const created = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
          mount.slots[index] = created;
          return [created.value, set(created)];
        }
        return [slot.value, set(slot)];
      },
    },
  };
}

/** One document request the hook made, with what the transport did to it. */
type Request = { url: string; signal: AbortSignal | undefined; aborted: boolean; closed: number; pulls: number; delivered: number };

/** A host that answers a document request and then stops sending. */
function platform() {
  const opened: Request[] = [];
  const loads = { mammoth: 0 };
  const fetchDocument = async (url: string, init: RequestInit = {}) => {
    const record: Request = { url: String(url), signal: init.signal ?? undefined, aborted: init.signal?.aborted ?? false, closed: 0, pulls: 0, delivered: 0 };
    init.signal?.addEventListener("abort", () => { record.aborted = true; });
    opened.push(record);
    let unblock: (() => void) | undefined;
    const stream = new ReadableStream({
      pull(target) {
        record.pulls += 1;
        if (record.pulls === 1) { const chunk = new Uint8Array(2048); record.delivered += chunk.byteLength; target.enqueue(chunk); return; }
        return new Promise<void>((resolve) => { unblock = () => { record.closed += 1; resolve(); }; });
      },
      cancel() { unblock?.(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200 });
  };
  return { opened, loads, fetchDocument };
}

/** The bundled hook, run in a context that states the platform it reads and the reader it may not load. */
function harness() {
  const stub = platform();
  const react = reactShim();
  const sandbox: Sandbox = {
    module: { exports: {} }, exports: {}, console, AbortController, Response, ReadableStream, Headers, Uint8Array,
    require: (name: string) => {
      if (name === "react") return react.api;
      if (name === "mammoth") { stub.loads.mammoth += 1; throw new Error("the reader was imported for an abandoned preview"); }
      throw new Error("unexpected import: " + name);
    },
  };
  sandbox.exports = sandbox.module.exports;
  // The page the hook runs on: the byte read falls back to its own `fetch`, so the transport is the platform's.
  // The page's own fetch is what the byte read falls back to: replacing it keeps the request seam real.
  sandbox.globalThis = { fetch: stub.fetchDocument, AbortController, Response, ReadableStream, Headers, Uint8Array };
  vm.runInNewContext(hookBundle, sandbox);
  const useDocxPreview = sandbox.module.exports.useDocxPreview as (address: string | null) => DocxPreviewState;
  return {
    stub,
    mount() {
      const mount = { slots: [] as Slot[], index: 0, out: null as DocxPreviewState | null };
      return {
        render(address: string | null) { react.begin(mount); mount.out = useDocxPreview(address); return mount.out; },
        /** A development `StrictMode` replay: same state, cleanup then effect again. */
        replay() { for (const slot of mount.slots) { slot.cleanup?.(); if (slot.effect !== undefined) slot.cleanup = slot.effect(); } },
        unmount() { for (const slot of mount.slots) slot.cleanup?.(); },
      };
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a preview on screen asks the host with the signal its own unmount will abort", async () => {
  const h = harness();
  const view = h.mount();
  const state = view.render("https://gateway.test/report.docx");
  await settle();
  const request = h.stub.opened[0];
  assert.equal(h.stub.opened.length, 1, "one document read per preview");
  assert.ok(request.signal instanceof AbortSignal, "the document request went out with no abort to answer to");
  assert.equal(request.aborted, false);
  assert.equal(state.loading, true);

  view.unmount();
  await settle();
  assert.equal(request.aborted, true, "unmounting the preview did not abort its request");
  assert.equal(request.closed, 1, "the read parked on the stalled host was left open");
  assert.equal(request.pulls, 2, "it pulled from the host past the unmount: " + request.pulls);
  assert.equal(h.stub.loads.mammoth, 0, "an abandoned document still bought the reader");
});

test("switching documents stops the one that left the screen", async () => {
  const h = harness();
  const view = h.mount();
  view.render("https://gateway.test/first.docx");
  await settle();
  view.render("https://gateway.test/second.docx");
  await settle();
  const [first, second] = h.stub.opened;
  assert.equal(h.stub.opened.length, 2);
  assert.equal(first.aborted, true, "the previous document kept its remote read after the viewer moved on");
  assert.equal(first.closed, 1);
  assert.equal(second.aborted, false, "the new document inherited the previous preview's abort");
  view.unmount();
});

test("a StrictMode replay keeps one live read for one document", async () => {
  const h = harness();
  const view = h.mount();
  view.render("https://gateway.test/report.docx");
  await settle();
  view.replay();
  await settle();
  const [first, second] = h.stub.opened;
  assert.equal(h.stub.opened.length, 2);
  assert.equal(first.aborted, true, "the replayed preview left its earlier read running");
  assert.equal(first.closed, 1);
  assert.equal(second.aborted, false);
  view.unmount();
  await settle();
  assert.equal(second.aborted, true);
  assert.equal(second.closed, 1);
});
