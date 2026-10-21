import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTICE_MAX_VISIBLE,
  NOTICE_VISIBLE_MS,
  remainingAfter,
  shelfOf,
  type NoticeFact,
} from "./notice-shelf.ts";

const fact = (id: string): NoticeFact => ({ id, message: "notice " + id, type: "info" });

test("the shelf draws the notices it was given, oldest first", () => {
  assert.deepEqual(shelfOf([fact("a"), fact("b")]), { visible: [fact("a"), fact("b")], overCapacity: false });
});

test("nothing stated is nothing drawn", () => {
  assert.deepEqual(shelfOf([]), { visible: [], overCapacity: false });
});

test("more notices than the shelf draws are not dropped, and the shelf states it has to make room", () => {
  const facts = Array.from({ length: NOTICE_MAX_VISIBLE + 2 }, (_, index) => fact("n" + index));
  const drawn = shelfOf(facts);
  // The facts beyond what is drawn are still held: the session states them, and they arrive as room is made. That is
  // the difference this module exists for - a shelf that dropped them would lose a statement nobody read.
  assert.equal(drawn.visible.length, NOTICE_MAX_VISIBLE);
  assert.equal(drawn.visible[0].id, "n0");
  assert.equal(drawn.visible.at(-1)?.id, "n" + (NOTICE_MAX_VISIBLE - 1));
  assert.equal(drawn.overCapacity, true, "the shelf states that the oldest notice has to leave for the next to appear");
});

test("a pause keeps the time that is left instead of restarting the notice", () => {
  // Seen for 2s of its 5s: hovering keeps the remaining 3s, which is what makes the resume a continuation.
  assert.equal(remainingAfter(NOTICE_VISIBLE_MS, 1_000, 3_000), 3_000);
  // A countdown that has already run out stays at zero rather than going negative.
  assert.equal(remainingAfter(NOTICE_VISIBLE_MS, 0, NOTICE_VISIBLE_MS + 500), 0);
  // A countdown that never started is the whole duration: the shelf draws a notice it has not begun timing.
  assert.equal(remainingAfter(NOTICE_VISIBLE_MS, null, 9_999), NOTICE_VISIBLE_MS);
});
