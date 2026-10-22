import assert from "node:assert/strict";
import test from "node:test";
import { createChange } from "./workbench-changes.ts";

/**
 * A change is a fact, not a counter.
 *
 * The shell used to keep a number and hand it down: the surface that read a resource had to know which value of it meant
 * "read again", and a mount that arrived in between read the number as unchanged. What a subscriber hears here is only
 * that the resource it reads is stale, and what it does about that is its own read.
 */
test("a subscriber hears the change and nothing else, and withdrawing is its own decision", () => {
  const change = createChange();
  let heard = 0;
  const withdraw = change.subscribe(() => { heard += 1; });
  change.notify();
  assert.equal(heard, 1, "the change reached the reader");
  withdraw();
  change.notify();
  assert.equal(heard, 1, "a withdrawn reader is not told again");
});

test("a listener that withdraws itself does not cost the next one its turn", () => {
  const change = createChange();
  const heard: string[] = [];
  const withdraw = change.subscribe(() => { heard.push("first"); withdraw(); });
  change.subscribe(() => { heard.push("second"); });
  change.notify();
  assert.deepEqual(heard, ["first", "second"]);
  heard.length = 0;
  change.notify();
  assert.deepEqual(heard, ["second"], "only the listener that is still interested is told");
});

test("a change has no replay: a surface that mounts afterwards reads the resource as it is now", () => {
  const change = createChange();
  change.notify();
  let heard = 0;
  change.subscribe(() => { heard += 1; });
  assert.equal(heard, 0, "nothing is replayed to a reader that was not there");
});
