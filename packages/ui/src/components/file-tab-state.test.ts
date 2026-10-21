import assert from "node:assert/strict";
import test from "node:test";
import { openFileTab, saveFileViewerState } from "./file-tab-state.ts";
import type { Tab } from "./TabBar.tsx";

test("reopening a file preserves its view and fences stale state after a mode change", () => {
  const tab: Tab = {
    id: "file:/repo/a.ts", label: "a.ts", filePath: "/repo/a.ts", viewerRevision: 0,
    viewerState: { displayMode: "source", wrapLines: true, scrollTop: 240, scrollLeft: 16 },
  };
  const request = { fileName: "a.ts", filePath: tab.filePath, tabId: tab.id };
  const tabs: Tab[] = [tab];
  assert.strictEqual(openFileTab(tabs, request), tabs);
  const switched = openFileTab(tabs, { ...request, sourceSessionId: "session-2" });
  assert.equal(switched[0].viewerRevision, 1);
  assert.strictEqual(switched[0].viewerState, tab.viewerState);

  const diff = openFileTab(switched, { ...request, sourceSessionId: "session-2", modeHint: "diff" });
  assert.equal(diff[0].viewerRevision, 2);
  assert.equal(diff[0].viewerState?.displayMode, "diff");
  assert.strictEqual(saveFileViewerState(diff, tab.id, 1, tab.viewerState ?? { displayMode: "source", wrapLines: true, scrollTop: 0, scrollLeft: 0 }), diff);
  const state = { ...diff[0].viewerState!, scrollTop: 480 };
  const saved = saveFileViewerState(diff, tab.id, 2, state);
  assert.deepEqual(saved[0].viewerState, state);
});
