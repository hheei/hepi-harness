import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
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
const same = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

function reactShim() {
  let current = null;
  const set = (slot) => (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; };
  return {
    begin(mount) { current = mount; mount.index = 0; },
    api: {
      useState(initial) {
        const index = current.index++;
        const slot = current.slots[index];
        if (slot === undefined) {
          const created = { value: typeof initial === "function" ? initial() : initial };
          current.slots[index] = created;
          return [created.value, set(created)];
        }
        return [slot.value, set(slot)];
      },
      useRef(initial) { const index = current.index++; return current.slots[index] ?? (current.slots[index] = { current: initial }); },
      useCallback(callback, deps) {
        const index = current.index++;
        const slot = current.slots[index];
        if (slot === undefined || !same(slot.deps, deps)) current.slots[index] = { deps, value: callback };
        return current.slots[index].value;
      },
      useEffect(effect, deps) {
        const index = current.index++;
        const slot = current.slots[index];
        if (slot === undefined) current.slots[index] = { deps, effect, cleanup: effect() };
        else if (!same(slot.deps, deps)) { slot.cleanup?.(); slot.deps = deps; slot.effect = effect; slot.cleanup = effect(); }
      },
    },
  };
}

const CONVERSATION = "42";
const SNAPSHOT = "42|9|120";

/** One window the Backend could answer, carrying the entry the surface asked for. */
function windowOf(entryId) {
  return {
    protocol: "hepi.v1", conversationId: CONVERSATION, snapshot: SNAPSHOT, scope: "42|9", order: "oldest-first",
    target: { entryId, anchor: "", present: true, blocks: [0] }, capped: true, trimmed: false,
    entries: [{ id: entryId, role: "user", message: { role: "user", content: "the target" } }],
    hasOlder: false, hasNewer: false, bytes: 1,
  };
}

function harness() {
  const reads = [];
  const landed = [];
  const react = reactShim();
  const sandbox = {
    module: { exports: {} }, console, require: (name) => name === "react" ? react.api : require(name),
    AbortController, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(hookBundle, sandbox);
  const useHistoryNavigation = sandbox.module.exports.useHistoryNavigation;
  const input = {
    conversationId: CONVERSATION,
    snapshotRevision: SNAPSHOT,
    busy: false,
    activeEntryIds: [],
    api: {
      navigationTarget: async (conversationId, query, options) => {
        reads.push({ conversationId, query, aborted: options?.signal?.aborted === true });
        return windowOf("100");
      },
      navigationOutline: async () => { throw new Error("not used"); },
    },
    landWindow: (window) => { landed.push(window); },
  };
  const mount = { slots: [], index: 0, out: null };
  return {
    reads, landed,
    get out() { return mount.out; },
    render() { react.begin(mount); mount.out = useHistoryNavigation(input); return mount.out; },
    /** The replay a development `StrictMode` performs: the same state, its cleanup and then its effect again. */
    replay() { for (const slot of mount.slots) { slot?.cleanup?.(); if (slot?.effect !== undefined) slot.cleanup = slot.effect(); } },
  };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test("a StrictMode replay leaves a live lifetime, so the next jump is read rather than cancelled", async () => {
  const h = harness();
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
});
