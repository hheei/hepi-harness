import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as typeof import("esbuild");

/**
 * The execution target a surface is showing, as a lifecycle: one target per selection, created and retired by the
 * effect, and never handed to a caller that has already left it.
 *
 * The harness runs the real hook with a React stand-in that can do what StrictMode does — run an effect, clean it up,
 * and run it again — because that replay is the failure these cases are about: a memoized target survives the cleanup
 * and comes back already disposed, so every later read of the surface is refused.
 */
const bundle: string = buildSync({
  entryPoints: [path.join(import.meta.dirname, "workbench-scope.ts")],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
}).outputFiles[0].text;

/** One selected execution target as this harness stands in for one: the lifecycle, not the host operations. */
type Target = {
  readonly workspaceId: string;
  /** True once the surface retired this target; a disposed target must never be handed out again. */
  disposed: boolean;
  dispose(): void;
};

/** The two hooks the bundle publishes, as the React it is handed drives them. */
type HookModule = {
  useExecutionTarget(workspaceId: string | null): Target | null;
  useTargetFence(shown: Target | null): (candidate: Target) => boolean;
};

/** One effect the stand-in recorded: its slot, the deps it was rendered with, and what it returned. */
type RecordedEffect = {
  readonly index: number;
  readonly deps: readonly unknown[] | undefined;
  readonly effect: () => (() => void) | void;
};

/** One effect that has run: the deps it ran with and the cleanup it returned. */
type RanEffect = { readonly deps: readonly unknown[] | undefined; readonly cleanup: (() => void) | void };

/** One mounted component: the hook slots React would keep, and the driver a case replays it through. */
type Mount = {
  /** The workspace this surface is showing; a case changes it to state a new selection. */
  workspaceId: string | null;
  readonly slots: unknown[];
  /** The hook slot the next hook call takes, reset at every render. */
  index: number;
  /** The effects this render created, in hook order. */
  effects: RecordedEffect[];
  /** The effects whose deps last changed, with the cleanup each returned. */
  ran: (RanEffect | undefined)[];
  /** True when a state setter changed a slot during this commit: the commit then renders again. */
  dirty: boolean;
  /** What the surface holds now: the selected target, or nothing between selections. */
  out: Target | null;
  /** The fence the surface asks with, for the target it is showing. */
  fence: (candidate: Target) => boolean;
  readonly render: () => Mount;
  readonly commit: () => void;
  readonly replay: () => void;
  readonly unmount: () => void;
};

/** The React the bundle is handed: one context, state and effects kept in the mount's own slots. */
type ReactStandIn = {
  readonly createContext: (value: unknown) => { readonly value: unknown };
  readonly useContext: () => unknown;
  readonly useState: (initial: unknown) => readonly [unknown, (next: unknown) => void];
  readonly useRef: (initial: unknown) => { current: unknown };
  readonly useCallback: (callback: (candidate: Target) => boolean) => (candidate: Target) => boolean;
  readonly useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => void;
};

/** One harness: everything a case drives, and every selection the connection made. */
type Harness = {
  readonly mount: (workspaceId: string | null) => Mount;
  /** Every target the connection was asked to select, in order. */
  readonly selections: Target[];
};

function harness(t: test.TestContext): Harness {
  let current: Mount | null = null;
  const selections: Target[] = [];
  const execution = {
    select(workspaceId: string): Target {
      const target: Target = { workspaceId, disposed: false, dispose() { target.disposed = true; } };
      selections.push(target);
      return target;
    },
    dispose(): void {},
  };
  const react: ReactStandIn = {
    createContext: (value) => ({ value }),
    useContext: () => ({ client: { execution }, scope: "test", identity: { profile: "test", backendId: "b", accountScope: "a" } }),
    useState: (initial) => {
      const mount = mountOf(current);
      const index = mount.index++;
      if (!(index in mount.slots)) mount.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [mount.slots[index], (next: unknown) => {
        const previous = mount.slots[index];
        const value = typeof next === "function" ? (next as (held: unknown) => unknown)(previous) : next;
        if (!Object.is(value, previous)) { mount.slots[index] = value; mount.dirty = true; }
      }];
    },
    useRef: (initial) => {
      const mount = mountOf(current);
      const index = mount.index++;
      mount.slots[index] ??= { current: initial };
      return mount.slots[index] as { current: unknown };
    },
    useCallback: (callback) => callback,
    useEffect: (effect, deps) => {
      const mount = mountOf(current);
      mount.effects.push({ index: mount.index++, deps, effect });
    },
  };
  const sandbox: { module: { exports: unknown }; require: (name: string) => unknown; console: Console } = {
    module: { exports: {} },
    require: (name) => (name === "react" ? react : require(name)),
    console,
  };
  vm.runInNewContext(bundle, sandbox);
  const hooks = sandbox.module.exports as HookModule;

  const mount = (workspaceId: string | null): Mount => {
    const m = {
      workspaceId, slots: [] as unknown[], index: 0, effects: [] as RecordedEffect[], ran: [] as (RanEffect | undefined)[],
      dirty: true, out: null as Target | null, fence: (_candidate: Target) => false,
    } as unknown as Mount;
    Object.assign(m, {
      render: (): Mount => {
        current = m; m.index = 0; m.effects = []; m.dirty = false;
        m.out = hooks.useExecutionTarget(m.workspaceId);
        m.fence = hooks.useTargetFence(m.out);
        return m;
      },
      /** One commit: render, run the effects whose deps changed, then render again if one of them set state. */
      commit: (): void => {
        m.render();
        for (const entry of m.effects) {
          const previous = m.ran[entry.index];
          const same = previous !== undefined && previous.deps !== undefined && entry.deps !== undefined
            && previous.deps.length === entry.deps.length && previous.deps.every((value, i) => Object.is(value, entry.deps?.[i]));
          if (same) continue;
          previous?.cleanup?.();
          m.ran[entry.index] = { deps: entry.deps, cleanup: entry.effect() };
        }
        if (m.dirty) m.render();
      },
      /** What StrictMode does to a mount: the effect's cleanup runs and the effect runs again, unchanged deps. */
      replay: (): void => {
        for (const entry of m.ran) entry?.cleanup?.();
        m.ran = [];
        m.render();
        for (const entry of m.effects) m.ran[entry.index] = { deps: entry.deps, cleanup: entry.effect() };
        if (m.dirty) m.render();
      },
      unmount: (): void => { for (const entry of m.ran) entry?.cleanup?.(); },
    });
    t.after(() => { m.unmount(); });
    m.commit();
    return m;
  };
  return { mount, selections };
}

/** The mount a hook call belongs to: a hook called outside a render is the harness being driven wrongly. */
function mountOf(mount: Mount | null): Mount {
  assert.ok(mount, "a hook was called during a render");
  return mount;
}

/** The target a surface is showing: a case that reached this point is about which one, not whether there is one. */
function shown(mount: Mount): Target {
  assert.ok(mount.out, "the surface holds a selected target");
  return mount.out;
}

test("a StrictMode replay hands back a live target, not the one its own cleanup disposed", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const first = shown(m);
  assert.equal(first.workspaceId, "alpha");

  m.replay();

  assert.equal(h.selections.length, 2, "the replay selects its own target");
  assert.equal(first.disposed, true, "the cleanup retired the target it had created");
  assert.notEqual(m.out, first, "the replayed effect does not hand back the disposed instance");
  assert.equal(shown(m).disposed, false, "the target the surface holds now is alive");
  assert.equal(shown(m).workspaceId, "alpha");
});

test("a selection change never hands out the previous workspace's target", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const alpha = shown(m);

  // The render that shows the new selection runs before the effect that creates its target: what it returns is nothing,
  // not the folder the user just left.
  m.workspaceId = "beta";
  m.render();
  assert.equal(m.out, null, "the frame between two selections shows no target");
  assert.equal(alpha.disposed, false, "the frame before the new effect has not retired anything yet");
  assert.equal(m.fence(alpha), false, "and the previous target's answers are no longer this surface's");

  m.commit();
  assert.equal(shown(m).workspaceId, "beta");
  assert.equal(alpha.disposed, true, "changing the selection retired the target that asked");
  assert.equal(m.fence(shown(m)), true);
});

test("unmounting retires the target it was showing", (t) => {
  const h = harness(t);
  const m = h.mount("alpha");
  const target = shown(m);
  m.unmount();
  assert.equal(target.disposed, true);
  assert.equal(h.selections.length, 1);
});

test("no workspace selects nothing at all", (t) => {
  const h = harness(t);
  const m = h.mount(null);
  assert.equal(m.out, null);
  assert.equal(h.selections.length, 0);
  assert.equal(m.fence({ workspaceId: "alpha", disposed: false, dispose() {} }), false);
});
