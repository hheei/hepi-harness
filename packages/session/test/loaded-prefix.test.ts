import assert from "node:assert/strict";
import test from "node:test";
import { reduceSseFrame, type SessionState } from "../src/index.ts";

/**
 * The history a caller loaded **itself** — the pages it asked for — across a window that keeps moving.
 *
 * The window is a suffix of the active range, so an advance pushes its start forward and evicts entries from its oldest
 * end. An evicted entry is window content, not the caller's own history, so a client that never paged must end up
 * holding the window and nothing more. But an entry the caller had **already loaded** — one that sits directly below
 * the window and is contiguous with the pages it paged — is history on screen, and the window moving past it must
 * **migrate** it into the prefix rather than delete it. Otherwise a reader who scrolled back loses the very messages
 * they were reading the moment a new turn arrives.
 *
 * Both halves are asserted here, because they are one rule read from two sides: what is kept is decided by whether a
 * prefix exists, never by whether an entry was once visible.
 */
const empty: SessionState = { protocol: "hepi.v1", conversationId: "c1", revision: 0, entries: [], partial: "", busy: false, hasMore: false, oldestEntryId: null };
const entry = (id: string) => ({ id, role: "user" as const, text: id });
const snapshotFrame = (revision: number, entries: ReturnType<typeof entry>[], boundary: { oldestEntryId: string | null; hasMore: boolean }) => ({ protocol: "hepi.v1", conversationId: "c1", revision, entries, partial: "", busy: false, oldestEntryId: boundary.oldestEntryId, hasMore: boundary.hasMore });
const deltaFrame = (revision: number, baseRevision: number, appended: ReturnType<typeof entry>[], boundary: { oldestEntryId: string | null; hasMore: boolean }) => ({ protocol: "hepi.v1", conversationId: "c1", revision, baseRevision, appended, partial: "", busy: false, oldestEntryId: boundary.oldestEntryId, hasMore: boundary.hasMore });
const ids = (state: SessionState) => state.entries.map(item => item.id);

/** A caller that paged: it holds entries 1..2 it asked for, and the window it was handed starts at 3. */
const paged: SessionState = { ...empty, revision: 5, entries: [entry("1"), entry("2"), entry("3"), entry("4")], oldestEntryId: "3", hasMore: true };

test("an evicted entry the caller had already loaded migrates into its prefix instead of being deleted", () => {
  // The window moves from [3,4] to [4,5]: entry 3 leaves the window, and it is contiguous with the pages the caller
  // paged (its prefix is 1..2). It is on screen, so it stays — below the window, never merged back above it.
  const next = reduceSseFrame(paged, "state", deltaFrame(6, 5, [entry("5")], { oldestEntryId: "4", hasMore: true }));
  assert.deepEqual(ids(next), ["1", "2", "3", "4", "5"], "the evicted entry migrates into the loaded prefix, so the transcript has no gap");
  assert.equal(next.resyncRequired, false, "and the frame is a continuation, not a resync");
});

test("a client that never paged holds the window and nothing more when the window evicts", () => {
  // The same eviction for a client whose transcript is exactly the window: entry 3 was window content, not history the
  // caller asked for, so the window's own statement is authoritative and 3 is gone. Migrating it here would let a
  // client that never paged grow past the server's window.
  const unpaged: SessionState = { ...empty, revision: 5, entries: [entry("3"), entry("4")], oldestEntryId: "3", hasMore: true };
  const next = reduceSseFrame(unpaged, "state", deltaFrame(6, 5, [entry("5")], { oldestEntryId: "4", hasMore: true }));
  assert.deepEqual(ids(next), ["4", "5"], "no prefix was loaded, so no prefix is invented");
});

test("a window that is the whole active range ends the prefix: there is nothing behind it to have paged to", () => {
  // A reset — a compaction, a re-baseline, an explicit clear — hands the caller the **complete** active range:
  // `oldestEntryId` null and `hasMore` false. Nothing precedes that window, so the pages the caller had loaded are not
  // behind anything: they are history the reset dropped, and a client that kept them would draw a transcript the model
  // can no longer be asked about. The window is a replacement here, never a merge.
  const next = reduceSseFrame(paged, "snapshot", snapshotFrame(6, [entry("9")], { oldestEntryId: null, hasMore: false }));
  assert.deepEqual(ids(next), ["9"], "the complete-range window replaces what was held, prefix included");
});

test("a snapshot that advances the window migrates the same way a delta does", () => {
  // The two folds are the same fold, so the migration cannot be a property of the delta path alone.
  const next = reduceSseFrame(paged, "snapshot", snapshotFrame(6, [entry("4"), entry("5")], { oldestEntryId: "4", hasMore: true }));
  assert.deepEqual(ids(next), ["1", "2", "3", "4", "5"], "the snapshot fold keeps and migrates exactly what the delta fold does");
});
