import assert from "node:assert/strict";
import test from "node:test";
import { asBracketedPaste, toTerminalKeyData, type TerminalKeyEventLike } from "./terminal-input.ts";

/** One case: the key, the modifiers the event states on top of the defaults, and the bytes it must become. */
type KeyCase = readonly [key: string, modifiers: Partial<Omit<TerminalKeyEventLike, "key">>, expected: string | null];

test("terminal input translates navigation and modifiers, leaves browser text alone and brackets paste", () => {
  const cases: readonly KeyCase[] = [
    ["ArrowDown", {}, "\u001b[B"], ["Home", {}, "\u001b[H"], ["Delete", {}, "\u001b[3~"],
    ["Tab", { shiftKey: true }, "\u001b[Z"], ["Enter", { shiftKey: true }, "\n"],
    ["c", { ctrlKey: true }, "\u0003"], ["]", { ctrlKey: true }, "\u001d"],
    ["ArrowLeft", { altKey: true }, "\u001bb"], ["x", { altKey: true }, "\u001bx"],
    ["v", { ctrlKey: true }, null], ["x", { metaKey: true }, null], ["a", {}, null], [" ", {}, null],
  ];
  for (const [key, modifiers, expected] of cases) assert.equal(toTerminalKeyData({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers }), expected, `${key} ${JSON.stringify(modifiers)}`);
  assert.equal(asBracketedPaste("first\nsecond"), "\u001b[200~first\nsecond\u001b[201~");
});
