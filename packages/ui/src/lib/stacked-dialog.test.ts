import assert from "node:assert/strict";
import test from "node:test";
import { handleGlobalEscape, registerAbortHandler } from "../hooks/useKeyboardShortcuts.ts";
import { focusModalPanel, listenForPanelEscape, openStackedDialog } from "./stacked-dialog.ts";

/** One listener a fake node holds, and the phase it was registered for. */
type RegisteredListener = { readonly type: string; readonly listener: (event: KeyboardEvent) => void; readonly capture: boolean };

/** One key a case presses: the key itself plus whatever the composition it cancels states. */
type PressInit = Partial<Pick<KeyboardEvent, "isComposing" | "keyCode">>;

/**
 * A stand-in for a DOM node: only the parts these seams read — listeners in both phases, focus, containment, and the
 * record of what was focused.
 *
 * The seams under test are typed against Element and a small document interface, and a double is not one. The two
 * casts below are the only places that boundary is crossed, so each case passes what the module signature asks for
 * while the double stays inspectable data.
 */
class FakeNode {
  readonly parent: FakeNode | null;
  readonly listeners: RegisteredListener[] = [];
  readonly focused: { readonly preventScroll?: boolean }[] = [];
  readonly isConnected = true;
  tagName?: string;
  body: FakeNode | null = null;
  activeElement: FakeNode | null = null;

  constructor(parent: FakeNode | null = null) {
    this.parent = parent;
  }

  addEventListener(type: string, listener: (event: KeyboardEvent) => void, capture = false): void {
    this.listeners.push({ type, listener, capture: Boolean(capture) });
  }

  removeEventListener(type: string, listener: (event: KeyboardEvent) => void, capture = false): void {
    const index = this.listeners.findIndex(entry =>
      entry.type === type && entry.listener === listener && entry.capture === Boolean(capture));
    if (index !== -1) this.listeners.splice(index, 1);
  }

  focus(options?: { readonly preventScroll?: boolean }): void {
    this.focused.push(options ?? {});
  }

  contains(other: FakeNode | null): boolean {
    for (let walk = other; walk; walk = walk.parent) if (walk === this) return true;
    return false;
  }
}

/** The document a stacked-dialog seam sees, for a double tree standing in for one. */
type DialogDocument = Parameters<typeof openStackedDialog>[0];
/** The panel a focus seam sees, for a double standing in for one. */
type FocusPanel = Parameters<typeof focusModalPanel>[1];
/** The document a focus seam sees. */
type FocusDoc = Parameters<typeof focusModalPanel>[0];

const dialogDocumentOf = (fake: FakeNode): DialogDocument => fake as unknown as DialogDocument;
const focusDocumentOf = (fake: FakeNode): FocusDoc => fake as unknown as FocusDoc;
const panelOf = (fake: FakeNode): FocusPanel => fake as unknown as FocusPanel;

/** One key press, dispatched through the fake tree exactly as the browser capture and bubble phases would. */
function press(target: FakeNode, init: PressInit = {}): { defaultPrevented: boolean; propagationStopped: boolean } {
  const event = {
    key: "Escape", target, defaultPrevented: false, propagationStopped: false, ...init,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
  };
  const path: FakeNode[] = [];
  for (let walk: FakeNode | null = target; walk; walk = walk.parent) path.unshift(walk);
  for (const capture of [true, false]) {
    for (const walked of capture ? path : [...path].reverse()) {
      for (const entry of [...walked.listeners]) {
        if (entry.type === "keydown" && entry.capture === capture) entry.listener(event as unknown as KeyboardEvent);
      }
      if (event.propagationStopped) return event;
    }
  }
  return event;
}

test("Escape closes the top dialog, then Settings, then stops the agent; IME closes nothing", (t) => {
  const window = new FakeNode();
  const document = new FakeNode(window);
  const body = new FakeNode(document);
  const opener = new FakeNode(body);
  const dialog = new FakeNode(body);
  document.body = body;
  document.activeElement = opener;
  const calls = { dialog: 0, settings: 0, stop: 0 };
  registerAbortHandler(() => { calls.stop += 1; });
  t.after(() => { registerAbortHandler(null); });
  window.addEventListener("keydown", handleGlobalEscape);
  const stopSettings = listenForPanelEscape(dialogDocumentOf(document), () => { calls.settings += 1; });
  t.after(stopSettings);
  const close = openStackedDialog(dialogDocumentOf(document), panelOf(dialog), () => { calls.dialog += 1; });
  t.after(close);
  assert.deepEqual(dialog.focused, [{ preventScroll: true }]);
  // An Escape that cancels an IME composition keeps the dialog open: it belongs to the input method, not to the page.
  const compositions: readonly PressInit[] = [{ isComposing: true }, { keyCode: 229 }];
  for (const init of compositions) {
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
  // Each case: the pointer, whether focus moved elsewhere meanwhile, and how often the composer was focused back.
  const cases: readonly (readonly [label: string, restoreTextEntry: boolean, movedElsewhere: boolean, expected: number])[] = [
    ["desktop returns to composer", true, false, 1],
    ["coarse pointer leaves keyboard closed", false, false, 0],
    ["another dialog keeps focus", true, true, 0],
  ];
  for (const [label, restoreTextEntry, movedElsewhere, expected] of cases) {
    const document = new FakeNode();
    document.body = new FakeNode(document);
    const composer = new FakeNode(document.body);
    composer.tagName = "TEXTAREA";
    const panel = new FakeNode(document.body);
    document.activeElement = composer;
    const close = focusModalPanel(focusDocumentOf(document), panelOf(panel), { restoreTextEntry });
    try {
      assert.deepEqual(panel.focused, [{ preventScroll: true }], label);
      document.activeElement = movedElsewhere ? new FakeNode(document.body) : panel;
    } finally { close(); }
    assert.equal(composer.focused.length, expected, label);
  }
});
