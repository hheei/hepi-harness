import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import type { TurnDescription } from "./chat/chat-turn-model.ts";
import type { WindowRange } from "./transcript-window.ts";

const { computeWindowRanges, turnHeight, anchorScrollAdjustment, DEFAULT_ESTIMATED_TURN_HEIGHT } =
  await createJiti(import.meta.url, { tsconfigPaths: true }).import<typeof import("./transcript-window.ts")>("./transcript-window.ts");
/** One turn as the window sees it: its stable key is what the range arithmetic addresses it by. */
const turn = (key: string): TurnDescription => ({
  key, startIndex: 0, endIndex: 0, anchorIndex: null, anchorEntryId: null, anchorRefIndex: null, live: false, items: [],
});
const turns = (count: number, prefix = "turn-"): TurnDescription[] => Array.from({ length: count }, (_, i) => turn(prefix + i));
const uniform = (count: number, height: number): Record<string, number> =>
  Object.fromEntries(turns(count).map(({ key }) => [key, height]));

/** One geometry case: the transcript, the viewport onto it, and the ranges that must be mounted. */
type GeometryCase = {
  readonly label: string;
  readonly count: number;
  readonly top?: number;
  readonly height?: number;
  readonly overscan?: number;
  readonly heights?: Readonly<Record<string, number>>;
  readonly revealKey?: string;
  readonly mountAll?: boolean;
  readonly ranges: readonly WindowRange[];
  readonly total?: number;
};

test("transcript geometry mounts viewport, overscan and reveal ranges with bounded spacers", () => {
  const cases: readonly GeometryCase[] = [
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
  ];
  for (const { label, count, top = 0, height = 300, overscan = 0, heights, revealKey, mountAll, ranges, total } of cases) {
    const result = computeWindowRanges({ turns: turns(count), viewport: { scrollTop: top, clientHeight: height }, overscan, heights: heights ?? uniform(count, 100), revealKey, mountAll });
    assert.deepEqual(result.ranges, ranges, label);
    if (total !== undefined) assert.equal(result.totalHeight, total, label);
    if (label === "viewport with overscan") {
      assert.equal(result.offsets[0], 0, label);
      assert.equal(result.offsets[10], 1000, label);
    }
  }
  const heights: readonly (readonly [label: string, heights: Readonly<Record<string, number>> | undefined, expected: number])[] = [
    ["measured", { a: 123 }, 123], ["absent", {}, DEFAULT_ESTIMATED_TURN_HEIGHT],
    ["zero", { a: 0 }, DEFAULT_ESTIMATED_TURN_HEIGHT], ["unmeasured", undefined, DEFAULT_ESTIMATED_TURN_HEIGHT],
  ];
  for (const [label, held, expected] of heights) assert.equal(turnHeight("a", held), expected, label);
});

/** One anchoring case: the turns and offsets before and after, and the scroll position that keeps the reader's place. */
type AnchorCase = {
  readonly label: string;
  readonly previousTurns?: readonly TurnDescription[];
  readonly previousOffsets?: readonly number[];
  readonly nextTurns?: readonly TurnDescription[];
  readonly nextOffsets?: readonly number[];
  readonly scrollTop?: number;
  readonly expected: number;
};

test("history prepends and height changes preserve distance into the reader's anchored turn", () => {
  const previous = turns(20);
  const offsets = previous.map((_, i) => i * 100);
  const cases: readonly AnchorCase[] = [
    { label: "prepend page", nextTurns: [...turns(3, "new-"), ...previous], nextOffsets: Array.from({ length: 23 }, (_, i) => i * 100), expected: 550 },
    { label: "growth above reader", nextOffsets: offsets.map((v, i) => v + (i > 1 ? 300 : 0)), expected: 550 },
    { label: "growth below reader", nextOffsets: offsets.map((v, i) => v + (i > 9 ? 300 : 0)), expected: 250 },
    { label: "compaction removed anchor", nextTurns: turns(20, "rebuilt-"), expected: 250 },
    { label: "reader above first turn", previousTurns: turns(5), previousOffsets: [0, 100, 200, 300, 400], nextTurns: [...turns(2, "new-"), ...turns(5)], nextOffsets: [0, 100, 200, 300, 400, 500, 600], scrollTop: 0, expected: 200 },
    { label: "anchor moved upward", previousTurns: turns(3), previousOffsets: [0, 500, 600], nextTurns: turns(3), nextOffsets: [0, 100, 200], scrollTop: 700, expected: 300 },
  ];
  for (const { label, previousTurns = previous, previousOffsets = offsets, nextTurns = previous, nextOffsets = offsets, scrollTop = 250, expected } of cases) assert.equal(anchorScrollAdjustment({ previousTurns, previousOffsets, nextTurns, nextOffsets, scrollTop }), expected, label);
});
