import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildNavigationTargetWindow, encodeNavigationAnchor } from "@hepi/protocol/navigation";
import { createConversationApi } from "../lib/conversation-api.ts";
import { createClient } from "../client.ts";
import type { HistoryNavigation, HistoryNavigationInput } from "./useHistoryNavigation.ts";
import type { LandedWindow } from "../lib/history-navigation.ts";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as { buildSync: (options: Record<string, unknown>) => { outputFiles: { text: string }[] } };
const here = path.dirname(new URL(import.meta.url).pathname);
const uiRoot = path.resolve(here, "..", "..");
const hookBundle = buildSync({
  entryPoints: [path.join(here, "useHistoryNavigation.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react"], tsconfig: path.join(uiRoot, "tsconfig.json"),
}).outputFiles[0].text;

/**
 * The conversation's navigation owner under the lifecycle both hosts actually mount it in.
 *
 * Both hosts render the workbench inside `StrictMode`, whose replay runs an effect's cleanup and then its effect again on
 * the same state. The surface's lifetime controller is created by an effect, so a controller built once and kept in a ref
 * is aborted by that cleanup and handed straight back — and every read after the replay is refused as the surface's own
 * cancellation. The replay here is the real sequence: same slots, same deps, cleanup then effect body.
 */
const same = <T,>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean =>
  left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/** One hook slot: the deps it was installed with, the effect body, and the cleanup it must be released by. */
type Slot = { deps?: readonly unknown[]; effect?: () => (() => void) | undefined; cleanup?: () => void; value?: unknown; current?: unknown };

/** The sandbox the bundled hook runs in: the CommonJS module it exports through, and the globals its imports read. */
type Sandbox = {
  module: { exports: Record<string, unknown> };
  exports?: Record<string, unknown>;
  console: Console;
  require: (name: string) => unknown;
  AbortController: typeof AbortController;
  URLSearchParams: typeof URLSearchParams;
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
  btoa: typeof btoa;
  atob: typeof atob;
  crypto: Crypto;
};

function reactShim() {
  let current: { slots: Slot[]; index: number } | null = null;
  const set = (slot: Slot) => (next: unknown) => {
    slot.value = typeof next === "function" ? (next as (previous: unknown) => unknown)(slot.value) : next;
  };
  const useMemo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const mount = current;
    assert.ok(mount, "a hook ran outside a render");
    const index = mount.index++;
    const slot = mount.slots[index];
    if (slot === undefined || !same(slot.deps, deps)) mount.slots[index] = { deps, value: factory() };
    return mount.slots[index].value;
  };
  return {
    begin(mount: { slots: Slot[]; index: number }) { current = mount; mount.index = 0; },
    api: {
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
      useRef(initial: unknown) {
        const mount = current;
        assert.ok(mount, "a hook ran outside a render");
        const index = mount.index++;
        return mount.slots[index] ?? (mount.slots[index] = { current: initial });
      },
      useCallback(callback: unknown, deps?: readonly unknown[]) { return useMemo(() => callback, deps); },
      useEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]) {
        const mount = current;
        assert.ok(mount, "a hook ran outside a render");
        const index = mount.index++;
        const slot = mount.slots[index];
        if (slot === undefined) mount.slots[index] = { deps, effect, cleanup: effect() };
        else if (!same(slot.deps, deps)) { slot.cleanup?.(); slot.deps = deps; slot.effect = effect; slot.cleanup = effect(); }
      },
    },
  };
}

const CONVERSATION = "42";
const SNAPSHOT = "42|9|120";

/** One read the connection made, with the lifetime it was made under. */
type Read = { conversationId: string; query: string; aborted: boolean };

/**
 * One window the Backend could answer, carrying the entry the surface asked for.
 *
 * A real window, built by the contract's own helper: the coordinator reads the snapshot, the scope and the target out of
 * it, so a stand-in would be asserting against a shape the Backend never sends.
 */
function windowOf(entryId: string) {
  const scope = "42|9";
  return buildNavigationTargetWindow({
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: SNAPSHOT,
    scope,
    target: { entryId, anchor: encodeNavigationAnchor({ version: 1, conversationId: CONVERSATION, scope, entryId }), present: true, blocks: [0] },
    entries: [{ id: entryId, role: "user", text: "the target", message: { role: "user", content: "the target" } }],
    hasOlder: false,
    hasNewer: false,
    capped: true,
  });
}

/**
 * A mounted surface over the connection's own conversation API.
 *
 * The api is the one the connection builds, so the read the hook makes is the shipped read: the client resolves the
 * address, applies the lifetime, and the fetch below records what it was handed. Only the answer is synthetic.
 */
function harness() {
  const reads: Read[] = [];
  const landed: LandedWindow[] = [];
  const react = reactShim();
  const client = createClient({
    origin: "",
    credential: { kind: "cookie" },
    createSource: () => ({ readyState: 1, onmessage: null, onerror: null, close() {} }),
    fetch: async (input, init) => {
      const url = String(input);
      reads.push({ conversationId: CONVERSATION, query: url.slice(url.indexOf("?")), aborted: init?.signal?.aborted === true });
      return Response.json(windowOf("100"));
    },
  });
  const sandbox: Sandbox = {
    module: { exports: {} }, exports: {}, console, require: (name: string) => name === "react" ? react.api : "",
    AbortController, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
  };
  vm.runInNewContext(hookBundle, sandbox);
  const useHistoryNavigation = sandbox.module.exports.useHistoryNavigation as (input: HistoryNavigationInput) => HistoryNavigation;
  const input: HistoryNavigationInput = {
    conversationId: CONVERSATION,
    snapshotRevision: SNAPSHOT,
    busy: false,
    activeEntryIds: [],
    api: createConversationApi(client),
    landWindow: (window: LandedWindow) => { landed.push(window); },
  };
  const mount = { slots: [] as Slot[], index: 0, out: null as HistoryNavigation | null };
  return {
    reads, landed,
    get out(): HistoryNavigation { assert.notEqual(mount.out, null, "the surface has not rendered yet"); return mount.out!; },
    render() { react.begin(mount); mount.out = useHistoryNavigation(input); return mount.out; },
    /** The replay a development `StrictMode` performs: the same state, its cleanup and then its effect again. */
    replay() { for (const slot of mount.slots) { slot.cleanup?.(); if (slot.effect !== undefined) slot.cleanup = slot.effect(); } },
    dispose() { client.dispose(); },
  };
}

/**
 * Let every promise this read owes settle.
 *
 * The connection's read is a real `fetch`, its body a real stream, so the answer arrives over more turns than the eight
 * microtasks a stub answer needed: the case waits on the event loop rather than counting them.
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("a StrictMode replay leaves a live lifetime, so the next jump is read rather than cancelled", async () => {
  const h = harness();
  try {
    h.render();
    h.render();
    h.out.locate({ entryId: "100" });
    await settle();
    assert.equal(h.reads.length, 1, "the first jump is read");
    assert.equal(h.reads[0].aborted, false, "under a live lifetime");
    assert.equal(h.landed.length, 1, "and lands");

    // React replays the effects on the same state: cleanup, then the effect body again. The controller the surface holds
    // afterwards must be a live one — the aborted instance it was handed is exactly the bug this case is about.
    h.replay();
    h.out.locate({ entryId: "100" });
    await settle();
    assert.equal(h.reads.length, 2, "the jump after the replay is read, not refused as the surface's own cancellation");
    assert.equal(h.reads[1].aborted, false, "and it is read under a lifetime that is still open");
    assert.equal(h.landed.length, 2, "so the reader is landed");
  } finally {
    h.dispose();
  }
});
