import assert from "node:assert/strict";
import test from "node:test";
import { reduceSseFrame, type SessionState } from "../src/index.ts";

const empty: SessionState = { protocol: "hepi.v1", conversationId: "c1", revision: 0, entries: [], partial: "", busy: false, hasMore: false, oldestEntryId: null };
const entry = (id: string, text = id) => ({ id, role: "user" as const, text });

/**
 * A window frame in the shape the server publishes: the boundary is always stated, and `null` means the window is the
 * whole active range. `apps/server/test/session-reducer.test.ts` folds these rules against a running backend's own
 * bytes; these cases pin the rules themselves, so a change to one is a change that has to be argued here too.
 */
const windowFrame = (revision: number, entries: ReturnType<typeof entry>[], boundary: { oldestEntryId: string | null; hasMore: boolean }) => ({
  protocol: "hepi.v1", conversationId: "c1", revision, entries, partial: "", busy: false,
  oldestEntryId: boundary.oldestEntryId,
  hasMore: boundary.hasMore,
});

test("a window keeps the history the caller paged in behind it and replaces what it covers", () => {
  // The loaded transcript is two things, and the boundary is what tells them apart: the entries **before** it are the
  // pages the caller asked for, and the entries **from** it on are the window the server gave. A caller that paged e1
  // behind a window starting at e2 is in that state. A window that then starts at e3 keeps e1 — the caller's own
  // history — and **migrates** e2 into that prefix, because e2 is contiguous with it and was already loaded: the window
  // moving must not delete a message the reader can see. Ticket 05 owns this; the case below is the unpaged one, where
  // there is no prefix to migrate into and the eviction is a plain drop.
  let state: SessionState = reduceSseFrame(empty, "snapshot", windowFrame(1, [entry("e2"), entry("e3")], { oldestEntryId: "e2", hasMore: true }));
  // What paging behind the window produces: the page's entries ahead of the window, which is exactly what the caller
  // holds while the boundary still names e2.
  state = { ...state, entries: [entry("e1"), ...state.entries] };
  assert.deepEqual(state.entries.map((item) => item.id), ["e1", "e2", "e3"]);
  state = reduceSseFrame(state, "snapshot", windowFrame(2, [entry("e3"), entry("e4")], { oldestEntryId: "e3", hasMore: true }));
  assert.deepEqual(state.entries.map((item) => item.id), ["e1", "e2", "e3", "e4"], "the paged entry survives, and the evicted entry migrates into the prefix rather than vanishing");
  assert.equal(state.hasMore, true, "hasMore reaches the caller so it can page");
  assert.equal(state.oldestEntryId, "e3", "the window's own boundary reaches the caller");
});

test("a client that never paged holds the window and nothing the window evicted", () => {
  // The common case, and the one an id comparison gets wrong: nothing below the boundary is the caller's, so the state
  // after the window moves is the window. An entry the previous window held is not silently reclassified as history.
  let state: SessionState = reduceSseFrame(empty, "snapshot", windowFrame(1, [entry("e1"), entry("e2"), entry("e3"), entry("e4")], { oldestEntryId: null, hasMore: false }));
  state = reduceSseFrame(state, "snapshot", windowFrame(2, [entry("e4"), entry("e5")], { oldestEntryId: "e4", hasMore: true }));
  assert.deepEqual(state.entries.map((item) => item.id), ["e4", "e5"], "the whole loaded transcript is the window");
  state = reduceSseFrame(state, "snapshot", windowFrame(3, [entry("e6"), entry("e7")], { oldestEntryId: "e6", hasMore: true }));
  assert.deepEqual(state.entries.map((item) => item.id), ["e6", "e7"], "and it follows the window forward");
});

test("a window that is the whole active range replaces, so a short conversation is exact", () => {
  let state: SessionState = reduceSseFrame(empty, "snapshot", windowFrame(1, [entry("e1"), entry("e2")], { oldestEntryId: null, hasMore: false }));
  state = reduceSseFrame(state, "snapshot", windowFrame(2, [entry("e9")], { oldestEntryId: null, hasMore: false }));
  assert.deepEqual(state.entries.map((item) => item.id), ["e9"], "a window with no boundary states a complete transcript");
});

test("a frame that does not state its own boundary asks for a fresh read instead of guessing", () => {
  // Folding it as complete is exactly the silent history loss the boundary exists to prevent, so the answer is the
  // same one a revision gap gets: re-read rather than infer.
  const held: SessionState = reduceSseFrame(empty, "snapshot", windowFrame(1, [entry("e1"), entry("e2")], { oldestEntryId: null, hasMore: false }));
  const withoutBoundary = { protocol: "hepi.v1", conversationId: "c1", revision: 2, entries: [entry("e2"), entry("e3")], partial: "", busy: false };
  const next = reduceSseFrame(held, "snapshot", withoutBoundary);
  assert.equal(next.resyncRequired, true);
  assert.deepEqual(next.entries.map((item) => item.id), ["e1", "e2"], "nothing is dropped on the strength of a guess");
});
