import assert from "node:assert/strict";
import test from "node:test";
import { isSettledOnTarget, startScrollSettlement, SETTLE_VIEWPORT_OFFSET } from "./scroll-settlement.ts";

function harness(options = {}) {
  const container = { scrollTop: 0, clientHeight: 800, getBoundingClientRect: () => ({ top: 100, bottom: 900 }) };
  const element = { getBoundingClientRect: () => ({ top: 400 - container.scrollTop, bottom: 700 - container.scrollTop }) };
  const frames = new Map(), events = [];
  let next = 0, reader;
  const handle = startScrollSettlement({
    container, target: () => options.missing ? null : element,
    scrollTo: target => {
      events.push("scroll");
      if (!options.stuck) container.scrollTop += target.getBoundingClientRect().top - 100 - SETTLE_VIEWPORT_OFFSET;
    },
    onReaderIntent: listener => { reader = listener; return () => { reader = null; }; },
    onSettled: () => events.push("settled"), onAbandoned: reason => events.push(reason),
    requestFrame: callback => { frames.set(++next, callback); return next; },
    cancelFrame: id => frames.delete(id), maxFrames: 6,
  });
  const step = () => {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback();
  };
  return { container, events, handle, step, reader: () => reader?.(), run: () => { while (frames.size) step(); } };
}

test("settlement aligns tall answers and stops on arrival, reader intent, unmount, timeout or cancellation", () => {
  assert.equal(isSettledOnTarget({ top: 116, bottom: 2116 }, { top: 100, bottom: 900 }, 800), true);
  assert.equal(isSettledOnTarget({ top: 400, bottom: 600 }, { top: 100, bottom: 900 }, 800), false);
  const arrived = harness();
  arrived.run();
  assert.deepEqual(arrived.events, ["scroll", "settled"]);
  const reader = harness();
  reader.step();
  reader.container.scrollTop += 400;
  const position = reader.container.scrollTop;
  reader.reader();
  reader.run();
  assert.equal(reader.events.at(-1), "reader");
  assert.equal(reader.container.scrollTop, position, "settlement stops fighting the reader");
  for (const [options, reason] of [[{ missing: true }, "unmounted"], [{ stuck: true }, "timeout"]]) {
    const world = harness(options);
    world.run();
    assert.equal(world.events.at(-1), reason);
    assert.equal(world.events.includes("settled"), false);
  }
  const cancelled = harness();
  cancelled.handle.cancel();
  cancelled.run();
  assert.equal(cancelled.events.includes("settled"), false);
  assert.equal(cancelled.events.includes("scroll"), false);
});
