import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

/** The text between one marker and the next, refused as an unrun case when either is missing. */
function between(startText: string, endText: string, label: string): string {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, label + ": " + startText + " not found");
  assert.notEqual(end, -1, label + ": " + endText + " not found after it");
  return source.slice(start, end);
}

/**
 * The fallback a delete and an unreadable conversation share.
 *
 * Both moves are the same one — leave the conversation for the composer of the folder it was in, keeping the unsent
 * draft under its own key — so they are one callback, and that callback is what this matrix drives. Reading it out of
 * the source keeps the case about the behaviour rather than about a copy of it.
 */
function fallBackToComposerBody(): string {
  return between("  const fallBackToComposer = useCallback", "  /** The recovery a failed conversation read offers", "fallBackToComposer");
}

function handleSessionDeletedBody(): string {
  return between("  const handleSessionDeleted = useCallback", "  const handleOpenFile = useCallback", "handleSessionDeleted");
}

/** One conversation row, as the sidebar states it: the three fields this callback reads. */
type Row = { id: string; cwd: string; projectKey: string };

/** What the callback did, read back rather than asserted inside the sandbox. */
type Captured = {
  setSelectedSession: (Row | null)[];
  setNewSessionCwd: string[];
  newSessionDraftId: string | null;
  sessionKey: number;
  navigatedTo: string | null;
  refreshBumped: boolean;
};

function runHandleSessionDeleted(capturedSelectedSession: Row, active: Row): Captured {
  // The workbench's own React API, narrowed to what the two callbacks call: state setters apply their value the way the
  // real ones do, and `useCallback` hands the body back unchanged so it is callable here.
  const state: Captured = {
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
    navigate: (search: string) => { state.navigatedTo = search; },
    capturedSelectedSession,
    selectedSession: capturedSelectedSession,
    selectedSessionRef: { current: active },
    activeNewSessionDraftKeyRef: { current: null },
    invalidateWorkspaceRestore() {},
    clearTabOpenSession() {},
    setRefreshKey: () => { state.refreshBumped = true; },
    setNewSessionDraftId: (id: string | null) => { state.newSessionDraftId = id; },
    setSelectedSession: (value: Row | null) => { state.setSelectedSession.push(value); },
    setNewSessionCwd: (value: string) => { state.setNewSessionCwd.push(value); },
    setSessionKey: (fn: (previous: number) => number) => { state.sessionKey = fn(state.sessionKey); },
    setBranchTree() {},
    setBranchActiveLeafId() {},
    setBranchSwitchLocked() {},
    setSystemPrompt() {},
    setSystemTools() {},
    setSystemInfoLoading() {},
    setActiveTopPanel() {},
    useCallback: (callback: unknown) => callback,
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
