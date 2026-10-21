import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const here = path.dirname(new URL(import.meta.url).pathname);
const hookBundle = buildSync({
  entryPoints: [path.join(here, "useTerminalFanIn.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react"],
}).outputFiles[0].text;

/**
 * The page's one terminal stream belongs to the connection, not to a mount.
 *
 * A stream carries the connection's origin and credential, its tabs' cursors and their attachments on the host, so a
 * connection that is replaced must release the one it had. What this file holds is that rule against a real fan-in: a
 * new connection value aborts the previous stream's request and opens the next one, a re-render that states the same
 * value keeps the stream it has, and unmounting releases it.
 *
 * It also holds the lifecycle both hosts' `StrictMode` roots put the hook through. React replays an effect by running
 * its cleanup and then the effect again **on the same state**, so the replay is what the harness performs: the same
 * slots, the same deps, only the cleanup and the effect body run once more. A production build never does this, which is
 * why the hook's stream may not be memoized — a memoized instance is closed by that cleanup and handed back on the
 * replay, and every attachment the page makes afterwards is refused.
 *
 * The harness renders, runs the effects of that render, and re-renders when a hook changed its own state — the sequence
 * React itself performs, with the re-render stated explicitly instead of scheduled.
 */
const same = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/** The two hooks this hook uses, with the dependency rule React itself applies. */
function reactShim() {
  let current = null;
  const set = (slot) => (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; };
  return {
    begin(mount) { current = mount; mount.index = 0; },
    api: {
      useEffect(effect, deps) {
        const index = current.index++;
        const slot = current.slots[index];
        if (slot === undefined) current.slots[index] = { deps, effect, cleanup: effect() };
        else if (!same(slot.deps, deps)) { slot.cleanup?.(); slot.deps = deps; slot.effect = effect; slot.cleanup = effect(); }
      },
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
    },
  };
}

/** A platform fetch that answers an event stream nothing writes to, so the only thing under test is the request. */
function platform() {
  const opened = [];
  const fetch = async (url, init = {}) => {
    const record = { url: String(url), headers: new Headers(init.headers), credentials: init.credentials, aborted: false };
    init.signal?.addEventListener("abort", () => { record.aborted = true; });
    opened.push(record);
    return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { opened, fetch, live: () => opened.filter((record) => !record.aborted) };
}

function harness() {
  const stub = platform();
  const react = reactShim();
  // The sandbox is the browser's own surface, narrowed to what the fan-in reads: a request it can abort and the
  // timers a dropped stream is reopened on.
  const sandbox = {
    module: { exports: {} }, console, require: (name) => name === "react" ? react.api : require(name),
    AbortController, Response, ReadableStream, Headers, TextDecoder, TextEncoder, setTimeout, clearTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(hookBundle, sandbox);
  const useTerminalFanIn = sandbox.module.exports.useTerminalFanIn;
  return {
    stub,
    mount() {
      const mount = { slots: [], index: 0, out: null };
      return {
        /** One React render and the effects it runs; a state a hook set is visible to the next render. */
        render(connection) {
          react.begin(mount);
          mount.out = useTerminalFanIn(connection);
          return mount.out;
        },
        /** One mounted tab, which is what makes the stream a request rather than an idle fan-in. */
        attach(tab = { id: "one", cwd: "/workspace/a" }) {
          assert.notEqual(mount.out, null, "no stream to attach a tab to");
          return mount.out.subscribe(tab, { onFrame() {}, onOpen() {}, onError() {} });
        },
        /** The replay a development `StrictMode` performs: the same state, its cleanup and then its effect again. */
        replay() { for (const slot of mount.slots) { slot.cleanup?.(); if (slot.effect !== undefined) slot.cleanup = slot.effect(); } },
        unmount() { for (const slot of mount.slots) slot.cleanup?.(); },
      };
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a connection switch releases the stream it replaces, and the same value keeps it", async () => {
  const h = harness();
  const mount = h.mount();
  const web = { credential: { kind: "cookie" }, fetch: h.stub.fetch };
  const app = { origin: "https://gateway.example", credential: { kind: "bearer", token: "device-secret" }, fetch: h.stub.fetch };

  // The stream is created by the effect, so the render that runs it states no stream yet: a surface with none has
  // nothing to attach, which is what the next render's value is for.
  assert.equal(mount.render(web), null, "the first render states no stream");
  const first = mount.render(web);
  assert.notEqual(first, null);
  mount.attach();
  await settle();
  assert.equal(h.stub.live().length, 1);
  assert.equal(h.stub.opened[0].url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|");
  assert.equal(h.stub.opened[0].headers.get("authorization"), null, "the Web page states no credential");

  // A re-render that states the same connection — every keystroke on the page does — is not a new stream: a fresh fan-in
  // per render would detach and reattach every mounted tab.
  assert.equal(mount.render(web), first);
  await settle();
  assert.equal(h.stub.live().length, 1, "the stream survived a render with the same connection");

  // A switch is a different identity: the render that states it holds no stream for the connection it is leaving, the
  // previous stream's request is aborted, and the next render holds the stream of the connection it moved to.
  assert.equal(mount.render(app), null, "the render that switched states no stream for the connection being replaced");
  const second = mount.render(app);
  assert.notEqual(second, first);
  await settle();
  assert.equal(h.stub.opened[0].aborted, true, "the previous connection's stream was released");
  assert.equal(h.stub.live().length, 0, "a new stream names its own tabs; the surface attaches them again");

  // Unmounting ends the stream of the connection this mount was showing, which is the pair a Strict Mode double mount
  // needs: the second mount builds its own stream instead of inheriting a closed one.
  mount.attach();
  await settle();
  assert.equal(h.stub.live().length, 1, "the switched connection's stream is open");
  const live = h.stub.live()[0];
  assert.equal(live.headers.get("authorization"), "Bearer device-secret", "an App states its one device bearer");
  assert.equal(live.credentials, "omit", "an App has no cookie jar to send");
  mount.unmount();
  assert.equal(live.aborted, true, "unmounting releases the stream this mount was showing");
});

test("a StrictMode replay of the same state leaves a stream a tab can attach to", async () => {
  const h = harness();
  const mount = h.mount();
  const connection = { credential: { kind: "cookie" }, fetch: h.stub.fetch };

  mount.render(connection);
  const stream = mount.render(connection);
  const subscription = mount.attach();
  await settle();
  assert.equal(h.stub.live().length, 1, "the first pass opened its stream");
  assert.equal(stream, mount.render(connection), "and a render with the same connection keeps it");

  // React replays the effect on the same state: cleanup, then the effect body again. What the surface holds afterwards
  // must be a live stream, not the instance that cleanup closed.
  subscription.release();
  mount.replay();
  const replayed = mount.render(connection);
  assert.notEqual(replayed, stream, "the replay states the stream its own effect created");
  mount.attach();
  await settle();
  assert.equal(h.stub.live().length, 1, "the replayed state allows a live terminal attachment");
  assert.equal(h.stub.opened.filter((record) => record.aborted).length, 1, "the stream the cleanup closed is over");
  mount.unmount();
});
