import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The module is asked for as the page asks for it: the transitions it exports are the ones the panel runs, not a copy
// stated for the test. `jiti` is what resolves the extensionless imports the bundler resolves for the page.
const {
  activeFilePanelTab,
  closePanelTab,
  EMPTY_PANEL,
  openFilePanelTab,
  openTerminalPanelTab,
  panelIsEmpty,
  panelsAfterProjectTransition,
  restartTerminalTab,
  terminalPanelClosed,
  terminalWorkspaceKnown,
} = await createJiti(import.meta.url, { interopDefault: true }).import<typeof import("./panel-state.ts")>("./panel-state.ts");

/**
 * The panel's tab policy, stated where it is decided.
 *
 * The browser journeys prove that the tabs are on screen and that a shell keeps running; what a node check can hold is
 * the matrix itself: which tabs a project change costs, what a close falls back to, and that a restart keeps the tab the
 * reader asked to restart. Each case is one transition of `PanelState`, so a change to the rules fails here rather than
 * in a component that happened to consume them.
 */

const file = (path: string) => ({ fileName: path.slice(path.lastIndexOf("/") + 1), filePath: path });

test("a file tab is keyed by its path, so reopening one keeps the reader's place", () => {
  const opened = openFilePanelTab(EMPTY_PANEL, file("/repo/a.ts"));
  assert.equal(opened.fileTabs.length, 1);
  assert.equal(opened.activeTabId, "file:/repo/a.ts");

  const scrolled = { ...opened, fileTabs: opened.fileTabs.map((tab) => ({ ...tab, viewerState: { displayMode: "source" as const, wrapLines: true, scrollTop: 240, scrollLeft: 0 } })) };
  const reopened = openFilePanelTab(scrolled, file("/repo/a.ts"));
  assert.equal(reopened.fileTabs.length, 1, "one path is one tab");
  assert.equal(reopened.fileTabs[0].viewerState?.scrollTop, 240, "and it is the tab the reader left");
  assert.equal(reopened.fileTabs[0].viewerRevision, 0, "reopening what is already shown is not a new read");
});

test("a workspace has at most one terminal tab, and a new one takes its own folder as its name", () => {
  const first = openTerminalPanelTab(EMPTY_PANEL, "/workspace/ws-1", "/home/me/project");
  const second = openTerminalPanelTab(first, "/workspace/ws-1", "/home/me/project");
  assert.equal(second.terminalTabs.length, 1, "asking again focuses the shell that already runs");
  assert.equal(second.activeTabId, first.terminalTabs[0].id);
  assert.equal(first.terminalTabs[0].displayCwd, "/home/me/project");

  const known = terminalWorkspaceKnown(first, first.terminalTabs[0].id, "/home/me/project");
  assert.strictEqual(known, first, "the folder the host reports again is not a change");
});

test("closing a file tab falls back to the last remaining one, and the last tab closes the panel", () => {
  const one = openFilePanelTab(EMPTY_PANEL, file("/repo/a.ts"));
  const two = openFilePanelTab(one, file("/repo/b.ts"));
  const closed = closePanelTab(two, "file:/repo/b.ts");
  assert.equal(closed.empty, false);
  assert.equal(closed.state.activeTabId, "file:/repo/a.ts", "the nearest remaining file tab is shown");

  const last = closePanelTab(closed.state, "file:/repo/a.ts");
  assert.equal(last.empty, true);
  assert.equal(last.state.activeTabId, null);
  assert.equal(panelIsEmpty(last.state), true);
});

test("closing a terminal asks its own surface, which reports the tab gone", () => {
  const opened = openTerminalPanelTab(EMPTY_PANEL, "/workspace/ws-1");
  const id = opened.terminalTabs[0].id;
  const requested = closePanelTab(opened, id);
  assert.equal(requested.empty, false, "the panel stays while the shell is still stopping");
  assert.equal(requested.state.terminalTabs[0].closing, "close");
  assert.strictEqual(closePanelTab(requested.state, id).state.terminalTabs[0], requested.state.terminalTabs[0], "a second close is not a second request");

  const gone = terminalPanelClosed(requested.state, id, "close");
  assert.equal(gone.state.terminalTabs.length, 0);
  assert.equal(gone.empty, true);
});

test("a restart keeps the tab in place with a fresh shell of the same workspace", () => {
  const opened = openTerminalPanelTab(EMPTY_PANEL, "/workspace/ws-1", "/home/me/project");
  const id = opened.terminalTabs[0].id;
  const restarted = terminalPanelClosed(restartTerminalTab(opened, id), id, "restart");
  assert.equal(restarted.state.terminalTabs.length, 1, "the reader keeps the tab they restarted");
  assert.notEqual(restarted.state.terminalTabs[0].id, id, "with a shell of its own");
  assert.equal(restarted.state.terminalTabs[0].cwd, "/workspace/ws-1");
  assert.equal(restarted.state.activeTabId, restarted.state.terminalTabs[0].id);
  assert.equal(restarted.empty, false);
  assert.strictEqual(restartTerminalTab(EMPTY_PANEL, id), EMPTY_PANEL, "restarting a tab that is not there changes nothing");
});

test("a project change costs the file tabs and leaves a terminal the reader was watching", () => {
  const files = openFilePanelTab(EMPTY_PANEL, file("/repo/a.ts"));
  const terminals = openTerminalPanelTab(files, "/workspace/ws-1");
  const watching = { ...terminals, activeTabId: terminals.terminalTabs[0].id };
  const kept = panelsAfterProjectTransition(watching);
  assert.deepEqual(kept.fileTabs, [], "an absolute path would linger under a folder it does not belong to");
  assert.equal(kept.terminalTabs.length, 1, "the terminal's shell belongs to the page, not to the project");
  assert.equal(kept.activeTabId, watching.activeTabId, "so the reader keeps watching it");

  const reading = panelsAfterProjectTransition({ ...terminals, activeTabId: "file:/repo/a.ts" });
  assert.equal(reading.activeTabId, null, "a file tab on screen is one the project change took");
  assert.equal(activeFilePanelTab(reading), null);
});
