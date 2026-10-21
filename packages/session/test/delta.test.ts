import assert from "node:assert/strict";
import test from "node:test";
import { reduceSseFrame, type SessionState } from "../src/index.ts";

/**
 * The append path of the shared reducer, against the delta frames the server publishes after a baseline.
 *
 * A delta is not a snapshot with fewer fields: it is the statement that this frame continues the revision the client
 * already holds. The client therefore applies it **only** when `baseRevision` is exactly its current revision, keeps
 * the history it already loaded, and folds to the same tail window the equivalent snapshot would have produced —
 * which is the property an append-only design without eviction fails once the transcript passes the raw cap.
 */
const empty: SessionState = { protocol: "hepi.v1", conversationId: "c1", revision: 0, entries: [], partial: "", busy: false, hasMore: false, oldestEntryId: null };
const entry = (id: string, text = id) => ({ id, role: "user" as const, text });
const snapshotFrame = (revision: number, entries: ReturnType<typeof entry>[], boundary: { oldestEntryId: string | null; hasMore: boolean }) => ({ protocol: "hepi.v1", conversationId: "c1", revision, entries, partial: "", busy: false, oldestEntryId: boundary.oldestEntryId, hasMore: boundary.hasMore });
const deltaFrame = (revision: number, baseRevision: number, appended: ReturnType<typeof entry>[], boundary: { oldestEntryId: string | null; hasMore: boolean }) => ({ protocol: "hepi.v1", conversationId: "c1", revision, baseRevision, appended, partial: "", busy: false, oldestEntryId: boundary.oldestEntryId, hasMore: boundary.hasMore });

test("an append delta applies contiguously and keeps the history already loaded", () => {
  let state = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("1"), entry("2")], { oldestEntryId: null, hasMore: false }));
  state = reduceSseFrame(state, "state", deltaFrame(2, 1, [entry("3"), entry("4")], { oldestEntryId: "1", hasMore: false }));
  assert.equal(state.revision, 2, "the frame advanced the revision");
  assert.deepEqual(state.entries.map(item => item.id), ["1", "2", "3", "4"], "the appended entries extend the transcript exactly once");
  assert.equal(state.oldestEntryId, "1", "the window's own boundary reaches the caller");
  assert.equal(state.resyncRequired, false, "a contiguous delta is applied, not resynchronized");
  // `baseRevision` and `appended` are the frame's own continuity fields, not facts about the conversation: the state a
  // caller holds must not accumulate wire-only keys across a long stream, so they are read and never kept.
  assert.equal("baseRevision" in state, false, "the frame's base is not carried into the state");
  assert.equal("appended" in state, false, "and neither is what it appended");
});

test("a delta whose base is not the current revision is rejected and asks for a fresh read", () => {
  const held = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("1"), entry("2")], { oldestEntryId: null, hasMore: false }));
  // Stale: the client already folded revision 2, so a frame based on 1 is not a continuation of what it holds.
  const advanced = { ...held, revision: 2 };
  const stale = reduceSseFrame(advanced, "state", deltaFrame(3, 1, [entry("9")], { oldestEntryId: "1", hasMore: true }));
  assert.equal(stale.resyncRequired, true, "a frame that is not based on the held revision is not applied");
  assert.equal(stale.revision, 2, "and it does not advance the revision");
  assert.deepEqual(stale.entries.map(item => item.id), ["1", "2"], "and nothing is appended out of order");
  // Out of order: a base the client never held is rejected the same way rather than inferred.
  const ahead = reduceSseFrame(advanced, "state", deltaFrame(3, 7, [entry("9")], { oldestEntryId: "1", hasMore: true }));
  assert.equal(ahead.resyncRequired, true, "an inferred base is never accepted");
  assert.deepEqual(ahead.entries.map(item => item.id), ["1", "2"]);
});

test("an unpaged client folding a random sequence of advances holds exactly the window a fresh baseline states", () => {
  // The window keeps at most three entries, so a transcript of a few dozen entries passes the cap many times over. The
  // sequence is **random but seeded**, and some advances append nothing at all (a submission transition).
  //
  // The oracle is the real one, and it is not a second fold of the same frames: it is the window a client that paged
  // nothing would be handed if it opened the conversation now — the baseline read on its own. A client that never paged
  // is the common case, and it must hold the server's window and nothing more: an advance that appends without trimming
  // to its own boundary leaves it holding entries the server has already dropped, which is exactly the difference this
  // sees. (What a client that *did* page keeps is the next case.)
  const windowOf = (ids: string[]) => ids.slice(-3);
  let seed = 20261014;
  const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
  const ids = ["1", "2", "3"];
  let delta: SessionState = reduceSseFrame(empty, "snapshot", snapshotFrame(1, ids.map(value => entry(value)), { oldestEntryId: "1", hasMore: true }));
  let revision = 1;
  const idsOf = (state: SessionState) => state.entries.map(item => item.id);
  for (let step = 0; step < 40; step += 1) {
    const appended = Array.from({ length: next(3) }, () => { const id = String(ids.length + 1); ids.push(id); return entry(id); });
    const window = windowOf(ids);
    const boundary = { oldestEntryId: window[0]!, hasMore: ids.length > window.length };
    revision += 1;
    delta = reduceSseFrame(delta, "state", deltaFrame(revision, revision - 1, appended, boundary));
    // The fresh baseline: the same window read now by a client that holds nothing, which is the state an unpaged
    // client must be in. Compared entry for entry over the **whole** transcript either fold holds.
    const fresh = reduceSseFrame(empty, "snapshot", snapshotFrame(revision, window.map(value => entry(value)), boundary));
    assert.deepEqual(idsOf(delta), idsOf(fresh), "the advancing client holds exactly the window a fresh read states, at revision " + revision);
    assert.deepEqual(idsOf(delta), window, "which is the window itself, not the window plus what it evicted");
    assert.deepEqual(
      { revision: delta.revision, oldestEntryId: delta.oldestEntryId, hasMore: delta.hasMore, partial: delta.partial, busy: delta.busy },
      { revision: fresh.revision, oldestEntryId: fresh.oldestEntryId, hasMore: fresh.hasMore, partial: fresh.partial, busy: fresh.busy },
      "and over every scalar at revision " + revision,
    );
  }
  // Every step advanced the revision, including the ones that appended nothing: a scalar-only frame is not a special
  // case, it is a frame with nothing appended, and the held window is still the server's after it.
  assert.equal(delta.revision, 41);
  assert.equal(delta.entries.length, 3, "the held transcript never grew past the window");
});

test("a prefix the caller paged in is kept while the window trims past it, in both folds", () => {
  // The other half of the rule: history a caller asked for through the older pages is **its own**, and a moving window
  // never prunes it. The baseline window starts at 3; the caller then asks for the page behind it and gets 1/2, which it
  // holds ahead of the window while the boundary still names 3 — the state a paging caller is really in.
  const opened = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("3"), entry("4")], { oldestEntryId: "3", hasMore: true }));
  const held = { ...opened, entries: [entry("1"), entry("2"), ...opened.entries] };
  assert.deepEqual(held.entries.map(item => item.id), ["1", "2", "3", "4"]);
  // The window moves to 4/5. Entry 3 leaves the window, and because it sits directly below the paged prefix it
  // **migrates** into it rather than being deleted: it was on screen, and a reader who scrolled back must not lose the
  // message they were reading when the next turn arrives. Ticket 05 owns this; the unpaged case is the case below,
  // where nothing was loaded below the window and the eviction is therefore a plain drop.
  const advanced = reduceSseFrame(held, "state", deltaFrame(2, 1, [entry("5")], { oldestEntryId: "4", hasMore: true }));
  assert.deepEqual(advanced.entries.map(item => item.id), ["1", "2", "3", "4", "5"], "the paged prefix survives and the evicted entry migrates into it, so the transcript has no gap");
  const snapshot = reduceSseFrame(held, "snapshot", snapshotFrame(2, [entry("4"), entry("5")], { oldestEntryId: "4", hasMore: true }));
  assert.deepEqual(snapshot.entries.map(item => item.id), advanced.entries.map(item => item.id), "and the two folds agree on it");
});

test("a boundary that is a position, not an id: a compaction's summary heads the entries it keeps", () => {
  // The native view keeps a compaction summary **first** while giving it a *newer* id than the entries it heads, so a
  // fold that trims by comparing ids keeps history the window has dropped. The boundary is where the boundary entry
  // sits in the window, whatever its id says.
  const opened = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("1"), entry("2"), entry("3"), entry("4")], { oldestEntryId: "1", hasMore: false }));
  const marked = reduceSseFrame(opened, "snapshot", snapshotFrame(2, [entry("99"), entry("3"), entry("4")], { oldestEntryId: "99", hasMore: true }));
  assert.deepEqual(marked.entries.map(item => item.id), ["99", "3", "4"], "the summary heads its own window and nothing older is kept by id");
  const advanced = reduceSseFrame(marked, "state", deltaFrame(3, 2, [entry("5")], { oldestEntryId: "3", hasMore: true }));
  assert.deepEqual(advanced.entries.map(item => item.id), ["3", "4", "5"], "and an advancing boundary inside that window trims by position too");
});

test("a frame whose boundary this client does not hold is not trimmed by guesswork", () => {
  // A boundary naming an entry the client does not hold describes a window that does not overlap what is held. There is
  // no window to trim to, so the frame is not applied at all — the same answer a revision gap gets, and never an empty
  // transcript fabricated from a boundary that was not found.
  const held = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("1"), entry("2")], { oldestEntryId: "1", hasMore: false }));
  const unknown = reduceSseFrame(held, "state", deltaFrame(2, 1, [entry("9")], { oldestEntryId: "7", hasMore: true }));
  assert.equal(unknown.resyncRequired, true, "a boundary the client cannot be trimmed by is not a frame to continue");
  assert.deepEqual(unknown.entries.map(item => item.id), ["1", "2"], "and nothing is applied on the strength of a guess");
});
test("a native frame addressed to another conversation fails closed instead of leaving the state unchanged", () => {
  // The two answers a caller can read are "the state moved" and "this state cannot continue the stream". "Unchanged"
  // is neither, and a caller that cannot tell it from a frame that said nothing projects the state it holds — which is
  // how an empty window is published over the surface's own. A frame for another conversation, or for a state that was
  // never bound to one, is therefore refused exactly like a revision gap.
  const held = reduceSseFrame(empty, "snapshot", snapshotFrame(1, [entry("1"), entry("2")], { oldestEntryId: null, hasMore: false }));
  const foreign = reduceSseFrame(held, "state", { ...deltaFrame(2, 1, [entry("9")], { oldestEntryId: "1", hasMore: false }), conversationId: "c2" });
  assert.equal(foreign.resyncRequired, true, "another conversation's delta is refused, not ignored");
  assert.deepEqual(foreign.entries.map(item => item.id), ["1", "2"], "and nothing of it is applied");
  const unbound = reduceSseFrame({ ...empty, conversationId: "" }, "state", deltaFrame(1, 0, [entry("1")], { oldestEntryId: "1", hasMore: false }));
  assert.equal(unbound.resyncRequired, true, "a state bound to no conversation has no frame it can continue");
  const restated = reduceSseFrame(held, "snapshot", snapshotFrame(2, [entry("1")], { oldestEntryId: null, hasMore: false }));
  assert.equal(restated.resyncRequired, false, "this conversation's own frame is unaffected");
  assert.deepEqual(restated.entries.map(item => item.id), ["1"]);
});

