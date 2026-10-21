import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function handleSessionDeletedBody() {
  const start = source.indexOf("  const handleSessionDeleted = useCallback");
  const end = source.indexOf("  const handleOpenFile = useCallback", start);
  assert.notEqual(start, -1, "handleSessionDeleted callback not found");
  assert.notEqual(end, -1, "handleOpenFile callback not found after handleSessionDeleted");
  return source.slice(start, end);
}

/**
 * The fallback a delete and an unreadable conversation share.
 *
 * Both moves are the same one — leave the conversation for the composer of the folder it was in, keeping the unsent
 * draft under its own key — so they are one callback, and that callback is what this matrix drives. Reading it out of
 * the source keeps the case about the behaviour rather than about a copy of it.
 */
function fallBackToComposerBody() {
  const start = source.indexOf("  const fallBackToComposer = useCallback");
  const end = source.indexOf("  /** The recovery a failed conversation read offers", start);
  assert.notEqual(start, -1, "fallBackToComposer callback not found");
  assert.notEqual(end, -1, "leaveUnreadableSession not found after fallBackToComposer");
  return source.slice(start, end);
}

function runHandleSessionDeleted(capturedSelectedSession, active) {
  const state = {
    setSelectedSession: [],
    setNewSessionCwd: [],
    newSessionDraftId: null,
    sessionKey: 0,
    navigatedTo: null,
    refreshBumped: false,
  };
  const context = vm.createContext({
    crypto: globalThis.crypto,
    // The workbench states its logical query to the host's router rather than reaching for the page's own address, so
    // this is the one navigation seam the callback has: a search string, and no path or history of its own.
    navigate: (search) => { state.navigatedTo = search; },
    capturedSelectedSession,
    selectedSession: capturedSelectedSession,
    selectedSessionRef: { current: active },
    activeNewSessionDraftKeyRef: { current: null },
    invalidateWorkspaceRestore() {},
    clearTabOpenSession() {},
    setRefreshKey: () => { state.refreshBumped = true; },
    setNewSessionDraftId: (id) => { state.newSessionDraftId = id; },
    setSelectedSession: (value) => { state.setSelectedSession.push(value); },
    setNewSessionCwd: (value) => { state.setNewSessionCwd.push(value); },
    setSessionKey: (fn) => { state.sessionKey = fn(state.sessionKey); },
    setBranchTree() {},
    setBranchActiveLeafId() {},
    setBranchSwitchLocked() {},
    setSystemPrompt() {},
    setSystemTools() {},
    setSystemInfoLoading() {},
    setActiveTopPanel() {},
    useCallback: (callback) => callback,
  });
  const bodies = fallBackToComposerBody() + "\n" + handleSessionDeletedBody();
  vm.runInContext(stripTypeScriptTypes(`${bodies}
    handleSessionDeleted("gone-session");
  `), context);
  return state;
}

test("session deletion callback ref-synchronization and navigation guard matrix", () => {
  { // keeps new chat untouched when delete completes after navigating away
    const deleting = { id: "gone-session", cwd: "/project-a", projectKey: "/project-a" };
    const navigatedTo = { id: "next-session", cwd: "/project-b", projectKey: "/project-b" };
    const state = runHandleSessionDeleted(deleting, navigatedTo);
    assert.equal(state.refreshBumped, true);
    assert.deepEqual(state.setSelectedSession, []);
    assert.deepEqual(state.setNewSessionCwd, []);
    assert.equal(state.sessionKey, 0);
  }
  { // falls back to empty composer when deleting the active session
    const session = { id: "gone-session", cwd: "/project-a", projectKey: "/project-a" };
    const state = runHandleSessionDeleted(session, session);
    assert.equal(state.refreshBumped, true);
    assert.deepEqual(state.setSelectedSession, [null]);
    assert.deepEqual(state.setNewSessionCwd, ["/project-a"]);
    assert.equal(state.sessionKey, 1);
    assert.equal(state.navigatedTo, `?cwd=${encodeURIComponent("/project-a")}`);
  }
});
