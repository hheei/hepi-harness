import assert from "node:assert/strict";
import test from "node:test";
import { handleGlobalEscape, registerAbortHandler } from "../hooks/useKeyboardShortcuts.ts";
import { focusModalPanel, listenForPanelEscape, openStackedDialog } from "./stacked-dialog.ts";

class FakeNode {
  constructor(parent = null) {
    this.parent = parent;
    this.listeners = [];
    this.isConnected = true;
    this.focused = [];
  }
  addEventListener(type, listener, capture = false) {
    this.listeners.push({ type, listener, capture: Boolean(capture) });
  }
  removeEventListener(type, listener, capture = false) {
    this.listeners = this.listeners.filter(entry =>
      !(entry.type === type && entry.listener === listener && entry.capture === Boolean(capture)));
  }
  focus(options) { this.focused.push(options); }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
}

function press(target, init = {}) {
  const event = {
    key: "Escape", target, defaultPrevented: false, propagationStopped: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  const path = [];
  for (let node = target; node; node = node.parent) path.unshift(node);
  for (const capture of [true, false]) {
    for (const node of capture ? path : [...path].reverse()) {
      for (const entry of [...node.listeners]) {
        if (entry.type === "keydown" && entry.capture === capture) entry.listener(event);
      }
      if (event.propagationStopped) return event;
    }
  }
  return event;
}

test("Escape closes the top dialog, then Settings, then stops the agent; IME closes nothing", t => {
  const window = new FakeNode();
  const document = new FakeNode(window);
  const body = new FakeNode(document);
  const opener = new FakeNode(body);
  const dialog = new FakeNode(body);
  document.body = body;
  document.activeElement = opener;
  const calls = { dialog: 0, settings: 0, stop: 0 };
  registerAbortHandler(() => calls.stop++);
  t.after(() => registerAbortHandler(null));
  window.addEventListener("keydown", handleGlobalEscape);
  const stopSettings = listenForPanelEscape(document, () => calls.settings++);
  t.after(stopSettings);
  const close = openStackedDialog(document, dialog, () => calls.dialog++);
  t.after(close);
  assert.deepEqual(dialog.focused, [{ preventScroll: true }]);
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    press(dialog, init);
    assert.deepEqual(calls, { dialog: 0, settings: 0, stop: 0 }, JSON.stringify(init));
  }
  press(dialog);
  assert.deepEqual(calls, { dialog: 1, settings: 0, stop: 0 });
  close();
  assert.deepEqual(opener.focused, [{ preventScroll: true }]);
  assert.equal(document.listeners.filter(entry => entry.capture).length, 0);
  press(opener);
  assert.deepEqual(calls, { dialog: 1, settings: 1, stop: 0 });
  stopSettings();
  press(opener);
  assert.deepEqual(calls, { dialog: 1, settings: 1, stop: 1 });
});

test("Settings takes composer focus and restores it without stealing another surface's focus", () => {
  for (const [label, restoreTextEntry, movedElsewhere, expected] of [
    ["desktop returns to composer", true, false, 1],
    ["coarse pointer leaves keyboard closed", false, false, 0],
    ["another dialog keeps focus", true, true, 0],
  ]) {
    const document = new FakeNode();
    document.body = new FakeNode(document);
    const composer = Object.assign(new FakeNode(document.body), { tagName: "TEXTAREA" });
    const panel = new FakeNode(document.body);
    document.activeElement = composer;
    const close = focusModalPanel(document, panel, { restoreTextEntry });
    try {
      assert.deepEqual(panel.focused, [{ preventScroll: true }], label);
      document.activeElement = movedElsewhere ? new FakeNode(document.body) : panel;
    } finally { close(); }
    assert.equal(composer.focused.length, expected, label);
  }
});
