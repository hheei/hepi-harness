import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

/**
 * The execution target a surface is showing, as a lifecycle: one target per selection, created and retired by the
 * effect, and never handed to a caller that has already left it.
 *
 * The harness runs the real hook with a React stand-in that can do what StrictMode does — run an effect, clean it up,
 * and run it again — because that replay is the failure these cases are about: a memoized target survives the cleanup
 * and comes back already disposed, so every later read of the surface is refused.
 */
const bundle = buildSync({
  entryPoints: [path.join(import.meta.dirname, "workbench-scope.ts")],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
}).outputFiles[0].text;

function harness(t) {
  let current;
  const selections = [];
  const execution = {
    select(workspaceId) {
      const target = { workspaceId, disposed: false, dispose() { target.disposed = true; } };
      selections.push(target);
      return target;
    },
    dispose() {},
  };
  const react = {
    createContext: (value) => ({ value }),
    useContext: () => ({ client: { execution }, scope: "test", identity: { profile: "test", backendId: "b", accountScope: "a" } }),
    useState(initial) {
      const mount = current, index = mount.index++;
      if (!(index in mount.slots)) mount.slots[index] = typeof initial === "function" ? initial() : initial;
      return [mount.slots[index], (next) => {
        const value = typeof next === "function" ? next(mount.slots[index]) : next;
        if (!Object.is(value, mount.slots[index])) { mount.slots[index] = value; mount.dirty = true; }
      }];
    },
    useRef(initial) { const mount = current, index = mount.index++; return mount.slots[index] ?? (mount.slots[index] = { current: initial }); },
    useCallback(callback) { return callback; },
    useEffect(effect, deps) { const mount = current, index = mount.index++; mount.effects.push({ index, deps, effect }); },
  };
  const sandbox = { module: { exports: {} }, require: (name) => (name === "react" ? react : require(name)), console };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(bundle, sandbox);
  const hook = sandbox.module.exports.useExecutionTarget;
  const fence = sandbox.module.exports.useTargetFence;

  const mount = (workspaceId) => {
    const m = { workspaceId, slots: [], index: 0, effects: [], ran: [], dirty: true, out: undefined, fence: undefined, mounted: true };
    m.render = () => {
      current = m; m.index = 0; m.effects = []; m.dirty = false;
      m.out = hook(m.workspaceId);
      m.fence = fence(m.out);
      return m;
    };
    /** One commit: render, run the effects whose deps changed, then render again if one of them set state. */
    m.commit = () => {
      m.render();
      for (const entry of m.effects) {
        const previous = m.ran[entry.index];
        const same = previous !== undefined && previous.deps !== undefined && entry.deps !== undefined
          && previous.deps.length === entry.deps.length && previous.deps.every((value, i) => Object.is(value, entry.deps[i]));
        if (same) continue;
        previous?.cleanup?.();
        m.ran[entry.index] = { deps: entry.deps, cleanup: entry.effect() };
      }
      if (m.dirty) m.render();
    };
    /** What StrictMode does to a mount: the effect's cleanup runs and the effect runs again, unchanged deps. */
    m.replay = () => {
      for (const entry of m.ran) entry?.cleanup?.();
      m.ran = [];
      m.render();
      for (const entry of m.effects) m.ran[entry.index] = { deps: entry.deps, cleanup: entry.effect() };
      if (m.dirty) m.render();
    };
    m.unmount = () => { for (const entry of m.ran) entry?.cleanup?.(); m.mounted = false; };
    t.after(() => m.unmount());
    return m.commit() ?? m;
  };
  return { mount, selections, execution };
}

test("a StrictMode replay hands back a live target, not the one its own cleanup disposed", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const first = m.out;
  assert.equal(first.workspaceId, "alpha");

  m.replay();

  assert.equal(h.selections.length, 2, "the replay selects its own target");
  assert.equal(first.disposed, true, "the cleanup retired the target it had created");
  assert.notEqual(m.out, first, "the replayed effect does not hand back the disposed instance");
  assert.equal(m.out.disposed, false, "the target the surface holds now is alive");
  assert.equal(m.out.workspaceId, "alpha");
});

test("a selection change never hands out the previous workspace's target", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const alpha = m.out;

  // The render that shows the new selection runs before the effect that creates its target: what it returns is nothing,
  // not the folder the user just left.
  m.workspaceId = "beta";
  m.render();
  assert.equal(m.out, null, "the frame between two selections shows no target");
  assert.equal(alpha.disposed, false, "the frame before the new effect has not retired anything yet");
  assert.equal(m.fence(alpha), false, "and the previous target's answers are no longer this surface's");

  m.commit();
  assert.equal(m.out.workspaceId, "beta");
  assert.equal(alpha.disposed, true, "changing the selection retired the target that asked");
  assert.equal(m.fence(m.out), true);
});

test("unmounting retires the target it was showing", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const target = m.out;
  m.unmount();
  assert.equal(target.disposed, true);
  assert.equal(h.selections.length, 1);
});

test("no workspace selects nothing at all", (t) => {
  const h = harness(t);
  const m = h.mount(null);
  assert.equal(m.out, null);
  assert.equal(h.selections.length, 0);
  assert.equal(m.fence({ workspaceId: "alpha", dispose() {} }), false);
});
