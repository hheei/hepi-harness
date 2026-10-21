import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const { computeWindowRanges, turnHeight, anchorScrollAdjustment, DEFAULT_ESTIMATED_TURN_HEIGHT } =
  await createJiti(import.meta.url, { tsconfigPaths: true }).import("./transcript-window.ts");
const turns = (count, prefix = "turn-") => Array.from({ length: count }, (_, i) => ({ key: prefix + i }));
const uniform = (count, height) => Object.fromEntries(turns(count).map(({ key }) => [key, height]));

test("transcript geometry mounts viewport, overscan and reveal ranges with bounded spacers", () => {
  for (const { label, count, top = 0, height = 300, overscan = 0, heights, revealKey, mountAll, ranges, total } of [
    { label: "viewport with overscan", count: 100, top: 300, height: 500, overscan: 2, ranges: [{ start: 1, end: 10 }], total: 10000 },
    { label: "tall turn intersects viewport", count: 3, top: 4000, height: 500, heights: { "turn-0": 50, "turn-1": 5000, "turn-2": 50 }, ranges: [{ start: 1, end: 2 }] },
    { label: "distant reveal has its own range", count: 100, revealKey: "turn-70", ranges: [{ start: 0, end: 3 }, { start: 70, end: 71 }] },
    { label: "visible reveal adds no range", count: 100, overscan: 1, revealKey: "turn-2", ranges: [{ start: 0, end: 4 }] },
    { label: "adjacent reveal merges", count: 100, revealKey: "turn-3", ranges: [{ start: 0, end: 4 }] },
    { label: "unmeasured turns use estimate", count: 10, height: 400, heights: {}, ranges: [{ start: 0, end: 2 }], total: DEFAULT_ESTIMATED_TURN_HEIGHT * 10 },
    { label: "explicit whole transcript", count: 3, height: 1000, mountAll: true, ranges: [{ start: 0, end: 3 }] },
    { label: "empty transcript", count: 0, height: 500, overscan: 4, ranges: [], total: 0 },
    { label: "overshot tail stays mounted", count: 20, top: 99999, height: 500, overscan: 2, ranges: [{ start: 13, end: 20 }] },
    { label: "short transcript mounts whole automatically", count: 3, height: 1000, ranges: [{ start: 0, end: 3 }] },
    { label: "long transcript still windows", count: 30, height: 1000, ranges: [{ start: 0, end: 10 }] },
  ]) {
    const result = computeWindowRanges({ turns: turns(count), viewport: { scrollTop: top, clientHeight: height }, overscan, heights: heights ?? uniform(count, 100), revealKey, mountAll });
    assert.deepEqual(result.ranges, ranges, label);
    if (total !== undefined) assert.equal(result.totalHeight, total, label);
    if (label === "viewport with overscan") {
      assert.equal(result.offsets[0], 0, label);
      assert.equal(result.offsets[10], 1000, label);
    }
  }
  for (const [label, heights, expected] of [
    ["measured", { a: 123 }, 123], ["absent", {}, DEFAULT_ESTIMATED_TURN_HEIGHT],
    ["zero", { a: 0 }, DEFAULT_ESTIMATED_TURN_HEIGHT], ["unmeasured", undefined, DEFAULT_ESTIMATED_TURN_HEIGHT],
  ]) assert.equal(turnHeight("a", heights), expected, label);
});

test("history prepends and height changes preserve distance into the reader's anchored turn", () => {
  const previous = turns(20);
  const offsets = previous.map((_, i) => i * 100);
  for (const { label, previousTurns = previous, previousOffsets = offsets, nextTurns = previous, nextOffsets = offsets, scrollTop = 250, expected } of [
    { label: "prepend page", nextTurns: [...turns(3, "new-"), ...previous], nextOffsets: Array.from({ length: 23 }, (_, i) => i * 100), expected: 550 },
    { label: "growth above reader", nextOffsets: offsets.map((v, i) => v + (i > 1 ? 300 : 0)), expected: 550 },
    { label: "growth below reader", nextOffsets: offsets.map((v, i) => v + (i > 9 ? 300 : 0)), expected: 250 },
    { label: "compaction removed anchor", nextTurns: turns(20, "rebuilt-"), expected: 250 },
    { label: "reader above first turn", previousTurns: turns(5), previousOffsets: [0, 100, 200, 300, 400], nextTurns: [...turns(2, "new-"), ...turns(5)], nextOffsets: [0, 100, 200, 300, 400, 500, 600], scrollTop: 0, expected: 200 },
    { label: "anchor moved upward", previousTurns: turns(3), previousOffsets: [0, 500, 600], nextTurns: turns(3), nextOffsets: [0, 100, 200], scrollTop: 700, expected: 300 },
  ]) assert.equal(anchorScrollAdjustment({ previousTurns, previousOffsets, nextTurns, nextOffsets, scrollTop }), expected, label);
});
