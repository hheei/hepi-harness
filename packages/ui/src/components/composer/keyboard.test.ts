import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { decideComposerKey, COMPOSITION_END_ENTER_GRACE_MS } = await jiti.import<typeof import("./keyboard.ts")>("./keyboard.ts");

const enter = (overrides: Record<string, unknown> = {}) => ({
  key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
  isComposing: false, keyCode: 13, ...overrides,
});

const base = {
  isMobile: false,
  enterSendMode: "enter" as const,
  composing: false,
  msSinceCompositionEnd: COMPOSITION_END_ENTER_GRACE_MS + 1,
  isStreaming: false,
  canSteer: true,
  hasAbortHandler: true,
  draftEmpty: false,
  inputHistoryLength: 1,
  historyMenuOpen: false,
  slashMenuOpen: false,
  slashQuery: null as string | null,
  atMenuOpen: false,
  atQueryOpen: false,
  atHasMatch: false,
  value: "",
};

test("Enter sends when idle and queues when a turn streams", () => {
  assert.deepEqual(decideComposerKey(base, enter()), { kind: "submit" });
  assert.deepEqual(
    decideComposerKey({ ...base, isStreaming: true }, enter()),
    { kind: "queue", mode: "steer" },
  );
  assert.deepEqual(
    decideComposerKey({ ...base, isStreaming: true }, enter({ altKey: true })),
    { kind: "queue", mode: "followup" },
  );
  assert.deepEqual(
    decideComposerKey({ ...base, isStreaming: true, canSteer: false }, enter()),
    { kind: "queue", mode: "followup" },
    "a surface with no Steer queues a follow-up",
  );
});

test("Shift+Enter is the textarea's, so a newline never sends", () => {
  assert.deepEqual(decideComposerKey(base, enter({ shiftKey: true })), { kind: "native" });
});

test("an IME composition is never a command", () => {
  // The three signals an IME leaves: the composer's own flag, the native event's flag, and keyCode 229.
  for (const state of [{ composing: true }, {}]) {
    for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.deepEqual(decideComposerKey({ ...base, ...state }, enter(event)), { kind: "native" });
    }
  }
});

test("the Enter that confirms an IME composition is swallowed, and a later one is not", () => {
  assert.deepEqual(
    decideComposerKey({ ...base, msSinceCompositionEnd: COMPOSITION_END_ENTER_GRACE_MS - 1 }, enter()),
    { kind: "swallow" },
    "the confirming keystroke must not send",
  );
  assert.deepEqual(
    decideComposerKey({ ...base, msSinceCompositionEnd: COMPOSITION_END_ENTER_GRACE_MS }, enter()),
    { kind: "submit" },
  );
});

test("the palette owns Enter and Tab before the send does", () => {
  const extension = { name: "help", source: "extension" as const };
  const slash = { ...base, slashMenuOpen: true, slashQuery: "he", slashSelected: extension, value: "/he" };
  assert.deepEqual(decideComposerKey(slash, enter()), { kind: "slash-complete", command: extension });
  assert.deepEqual(decideComposerKey(slash, enter({ key: "Tab" })), { kind: "slash-complete", command: extension });
  assert.deepEqual(decideComposerKey(slash, enter({ key: "Escape" })), { kind: "slash-close" });
  assert.deepEqual(decideComposerKey(slash, enter({ key: "ArrowDown" })), { kind: "slash-move", direction: "down" });

  // A built-in typed in full submits at once; every other command takes the second Enter.
  const builtin = { name: "reload", description: "x", source: "builtin" as const };
  assert.deepEqual(
    decideComposerKey({ ...slash, slashSelected: builtin, value: "/reload" }, enter()),
    { kind: "slash-submit", command: builtin },
  );
});

test("the file list owns arrows, Tab and Enter while it is open", () => {
  const at = { ...base, atMenuOpen: true, atQueryOpen: true, atHasMatch: true };
  assert.deepEqual(decideComposerKey(at, enter()), { kind: "file-complete" });
  assert.deepEqual(decideComposerKey(at, enter({ key: "ArrowDown" })), { kind: "file-move", delta: 1 });
  assert.deepEqual(decideComposerKey(at, enter({ key: "ArrowUp" })), { kind: "file-move", delta: -1 });
  assert.deepEqual(decideComposerKey(at, enter({ key: "Escape" })), { kind: "file-close" });
  assert.deepEqual(
    decideComposerKey({ ...at, atHasMatch: false }, enter()),
    { kind: "submit" },
    "with no match the key falls through to the send",
  );
});

test("ArrowUp on an empty draft opens the history, and the history owns its keys", () => {
  const up = enter({ key: "ArrowUp" });
  assert.deepEqual(decideComposerKey({ ...base, draftEmpty: true }, up), { kind: "history-open" });
  assert.deepEqual(decideComposerKey({ ...base, draftEmpty: false }, up), { kind: "native" });
  assert.deepEqual(decideComposerKey({ ...base, draftEmpty: true, isStreaming: true }, up), { kind: "native" });

  const history = { ...base, historyMenuOpen: true };
  assert.deepEqual(decideComposerKey(history, up), { kind: "history-move", delta: -1 });
  assert.deepEqual(decideComposerKey(history, enter({ key: "ArrowDown" })), { kind: "history-move", delta: 1 });
  assert.deepEqual(decideComposerKey(history, enter()), { kind: "history-apply" });
  assert.deepEqual(decideComposerKey(history, enter({ key: "Escape" })), { kind: "history-close" });
});

test("Escape stops a running turn only when no menu and no composition is active", () => {
  const escape = enter({ key: "Escape" });
  assert.deepEqual(decideComposerKey({ ...base, isStreaming: true }, escape), { kind: "abort" });
  assert.deepEqual(decideComposerKey(base, escape), { kind: "native" });
  assert.deepEqual(decideComposerKey({ ...base, isStreaming: true, composing: true }, escape), { kind: "native" });
  assert.deepEqual(
    decideComposerKey({ ...base, isStreaming: true, hasAbortHandler: false }, escape),
    { kind: "native" },
  );
});

test("ctrlEnter send mode makes plain Enter the textarea's", () => {
  const ctrlEnter = { ...base, enterSendMode: "ctrlEnter" as const };
  assert.deepEqual(decideComposerKey(ctrlEnter, enter()), { kind: "native" });
  assert.deepEqual(decideComposerKey(ctrlEnter, enter({ ctrlKey: true })), { kind: "submit" });
  assert.deepEqual(decideComposerKey({ ...ctrlEnter, isMobile: true }, enter()), { kind: "native" });
});
