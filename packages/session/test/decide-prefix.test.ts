import assert from "node:assert/strict";
import test from "node:test";
import { decidePrefix, reduceSseFrame, type SessionState } from "../src/index.ts";

/**
 * The one rule about what a reader's loaded pages become when the window moves, and the proof that the two consumers
 * of it agree.
 *
 * A window is a suffix of the active range: it moves forward, and entries leave its oldest end. An entry the reader had
 * **already loaded** — sitting directly below the window and contiguous with the pages it paged — is history on screen
 * rather than window content, so it **migrates** into the loaded prefix instead of being dropped. An entry that left a
 * window nobody paged behind is dropped, because a client that never paged holds no prefix and must not grow past the
 * server's own window.
 *
 * The rule is stated once and called from both places that decide it — the browser's page state and the shared
 * `reduceSseFrame` — so the matrix at the end of this file compares the **complete transcript** each side holds after
 * the same transition, rather than comparing two differently shaped return values.
 */
const prefix = (ids: string[], historyHead: string | null = "h") => ({ entryIds: ids, messages: ids.map(id => "m-" + id), historyHead });
const messageOf = (id: string) => "m-" + id;

test("a window that moves migrates the entries it evicted while they were loaded", () => {
  // The reader paged e1/e2, and the window it was handed held e3/e4. The window then starts at e4: e3 left it, and
  // because e3 sat directly below the pages the reader paged it migrates into them rather than disappearing.
  const decided = decidePrefix(prefix(["e1", "e2"]), { entryIds: ["e4", "e5"], previousEntryIds: ["e3", "e4"], historyHead: "h", hasMore: true }, messageOf);
  assert.deepEqual(decided, prefix(["e1", "e2", "e3"]), "the evicted window entry migrates behind the kept pages");
});

test("the decision is idempotent, so a read and a render reach the same prefix", () => {
  const window = { entryIds: ["e4", "e5"], previousEntryIds: ["e3", "e4"], historyHead: "h", hasMore: true };
  const once = decidePrefix(prefix(["e1", "e2"]), window, messageOf)!;
  assert.deepEqual(decidePrefix(once, window, messageOf), once, "deciding again against the same windows states the same pages");
});

test("nothing loaded, a moved head, or a complete range all end the prefix", () => {
  const window = { entryIds: ["e4", "e5"], previousEntryIds: ["e3", "e4"], historyHead: "h", hasMore: true };
  assert.equal(decidePrefix(null, window, messageOf), null, "a reader that paged nothing keeps nothing");
  assert.equal(decidePrefix(prefix(["e1", "e2"]), { ...window, historyHead: "moved" }, messageOf), null, "a compaction or a reset re-baselines and drops the prefix whole");
  assert.equal(decidePrefix(prefix(["e1", "e2"]), { ...window, hasMore: false }, messageOf), null, "a window that is the whole active range has nothing behind it to have paged to");
});

test("pages the window now holds are dropped, and a wholly non-overlapping window migrates the old one", () => {
  // The window moved back over the pages: what it holds is not the reader's history any more, and what remains of the
  // reader's pages is still ahead of it.
  assert.deepEqual(decidePrefix(prefix(["e1", "e2"]), { entryIds: ["e2", "e3"], previousEntryIds: ["e1", "e2"], historyHead: "h", hasMore: true }, messageOf)!.entryIds, ["e1"]);
  // The window moved past the whole old window at once: both entries it evicted were loaded, so both migrate.
  assert.deepEqual(decidePrefix(prefix(["e1", "e2"]), { entryIds: ["e5", "e6"], previousEntryIds: ["e3", "e4"], historyHead: "h", hasMore: true }, messageOf)!.entryIds, ["e1", "e2", "e3", "e4"]);
});

/**
 * One transition, decided twice: as the shared reducer folds it and as the browser's page state decides it.
 *
 * The comparison is over the **whole transcript** each side ends up holding — the browser's prefix concatenated with
 * the window it was given, which is how those two stores are drawn. Comparing a prefix to a transcript would compare
 * two different things and prove nothing about either.
 */
const entry = (id: string) => ({ id, role: "user" as const, text: id });
const held: SessionState = { protocol: "hepi.v1", conversationId: "c1", revision: 5, entries: [entry("p0"), entry("p1"), entry("w0"), entry("w1")], partial: "", busy: false, oldestEntryId: "w0", hasMore: true, historyHead: "h" };
const page = prefix(["p0", "p1"]);
const previousWindowIds = ["w0", "w1"];
const frame = (entries: string[], boundary: string | null, hasMore: boolean, historyHead = "h") => ({ protocol: "hepi.v1" as const, conversationId: "c1", revision: 6, entries: entries.map(entry), partial: "", busy: false, oldestEntryId: boundary, hasMore, historyHead });

const folded = (entries: string[], boundary: string | null, hasMore: boolean, historyHead = "h") =>
  reduceSseFrame(held, "snapshot", frame(entries, boundary, hasMore, historyHead)).entries.map(item => item.id);
const drawn = (entries: string[], boundary: string | null, hasMore: boolean, historyHead = "h") => {
  const decided = decidePrefix(page, { entryIds: entries, previousEntryIds: previousWindowIds, historyHead, hasMore }, messageOf);
  return [...(decided?.messages ?? []), ...entries].map(id => id.replace(/^m-/, ""));
};

test("both consumers hold the same complete transcript across every window transition", () => {
  const transitions: { name: string; entries: string[]; boundary: string | null; hasMore: boolean; historyHead?: string }[] = [
    { name: "the window extends at the same boundary", entries: ["w0", "w1", "w2"], boundary: "w0", hasMore: true },
    { name: "the window overlaps the previous one", entries: ["w1", "w2"], boundary: "w1", hasMore: true },
    { name: "the window moved past the previous one", entries: ["w2", "w3"], boundary: "w2", hasMore: true },
    { name: "the head marker moved", entries: ["w1", "w2"], boundary: "w1", hasMore: true, historyHead: "h2" },
    { name: "the window is the whole active range", entries: ["z"], boundary: null, hasMore: false },
  ];
  for (const transition of transitions) {
    const { name, entries, boundary, hasMore, historyHead = "h" } = transition;
    assert.deepEqual(folded(entries, boundary, hasMore, historyHead), drawn(entries, boundary, hasMore, historyHead), name);
  }
  assert.deepEqual(folded(["w0", "w1", "w2"], "w0", true), ["p0", "p1", "w0", "w1", "w2"], "the same-boundary read is unchanged");
  assert.deepEqual(folded(["w2", "w3"], "w2", true), ["p0", "p1", "w0", "w1", "w2", "w3"], "and neither side drops the old window the reader already had");
  assert.deepEqual(folded(["w1", "w2"], "w1", true, "h2"), ["w1", "w2"], "a moved head is a re-baseline on both sides");
  assert.deepEqual(folded(["z"], null, false), ["z"], "and a complete range replaces on both sides");
});

test("entries neither consumer saw are not recovered by either", () => {
  // Two reads landed with a whole window in between, so w2/w3 were published and rolled out without this client ever
  // holding them. Neither side can state them: a fold only knows what it holds plus what the frame declares, and the
  // missing entries are in neither. Both sides agree on what they do hold, and the limitation is recorded rather than
  // papered over with a re-read of the newest state, which would state the same window again. See docs/chat.md.
  const withGap = drawn(["w4", "w5"], "w4", true);
  assert.deepEqual(folded(["w4", "w5"], "w4", true), withGap, "the two consumers agree");
  assert.equal(withGap.includes("w2"), false, "and neither invents the entries it never saw");
});
