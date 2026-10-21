import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const { buildRailNodes, railPreview, RAIL_PREVIEW_MAX_CHARS } = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("./history-rail.ts");

const CONVERSATION = "42";
const HEAD = "h1";

function anchorOf(entryId, options = {}) {
  return {
    anchor: "anchor-" + entryId,
    entryId,
    cursor: Number(entryId),
    preview: options.preview ?? "user message " + entryId,
  };
}

function outlineOf(entryIds, options = {}) {
  return {
    conversationId: CONVERSATION,
    snapshot: CONVERSATION + "|" + HEAD + "|" + (entryIds.at(-1) ?? "-"),
    scope: CONVERSATION + "|" + HEAD,
    anchors: entryIds.map((entryId) => anchorOf(entryId, options)),
    hasMore: options.hasMore === true,
    capped: true,
    loading: false,
    failure: null,
  };
}

const measured = (entryId, turn = { top: 0 }) => ({ anchorEntryId: entryId, preview: "shown " + entryId, turn });

test("the rail is the measured transcript until an outline page arrives", () => {
  // The first frame of a conversation has no page yet. The rail then shows what it always showed rather than nothing,
  // and a turn the transcript drew without a committed anchor (a streaming reply) gets no node.
  const nodes = buildRailNodes({ outline: null, turns: [measured("10"), { anchorEntryId: null, preview: "streaming", turn: {} }, measured("20")] });
  assert.deepEqual(nodes.map((node) => node.entryId), ["10", "20"]);
  assert.ok(nodes.every((node) => node.loaded && node.turn !== null), "every node of the fallback is measured");
});

test("an outline lists nodes beyond the loaded window, and only the loaded ones carry a measured turn", () => {
  // The acceptance this ticket exists for: a long conversation's rail names nodes the transcript never mounted. An
  // unloaded node states an identity, an order and a preview — and no turn, because there is no geometry to state.
  const nodes = buildRailNodes({
    outline: outlineOf(["10", "20", "30", "40"]),
    turns: [measured("10"), measured("20")],
  });
  assert.deepEqual(nodes.map((node) => node.entryId), ["10", "20", "30", "40"], "every committed anchor is a node");
  assert.deepEqual(nodes.map((node) => node.loaded), [true, true, false, false]);
  assert.deepEqual(nodes.map((node) => node.turn === null), [false, false, true, true], "an unloaded node carries no measured turn");
  assert.ok(nodes[2].anchor.length > 0, "an unloaded node still carries the coordinate a jump is addressed by");
  assert.equal(nodes[2].preview, "user message 30", "and the server's bounded preview, so the reader can read it");
});

test("nodes are ordered by the server cursor, not by the measured list", () => {
  // The measured list is the transcript's own order, which can begin mid-history. The rail's order is the server's
  // cursor, because that is the order of the conversation rather than of the viewport.
  const nodes = buildRailNodes({ outline: outlineOf(["10", "20", "30"]), turns: [measured("30"), measured("10")] });
  assert.deepEqual(nodes.map((node) => node.entryId), ["10", "20", "30"]);
});

test("a measured turn the outline does not list is a node only when it is newer than the newest page", () => {
  // The reader's window sits at the tail. A turn committed after the last page was read is newer than that page and is
  // the reader's own message, so the rail's bottom edge must not lag behind it. An older measured turn the outline does
  // not list is the non-anchor content the outline deliberately does not enumerate — a compaction marker, a subagent
  // report, an assistant-only prefix — and gets no fabricated node (spec decision 10).
  const nodes = buildRailNodes({
    outline: outlineOf(["10", "20"]),
    turns: [
      { anchorEntryId: "5", preview: "assistant-only prefix", turn: {} },
      measured("10"),
      measured("20"),
      measured("30"),
      measured("40"),
    ],
  });
  assert.deepEqual(nodes.map((node) => node.entryId), ["10", "20", "30", "40"], "the tail the outline has not paged in yet is kept");
  assert.deepEqual(nodes.map((node) => node.loaded), [true, true, true, true]);
  assert.ok(nodes.every((node) => node.anchor === "" || Number(node.entryId) <= 20), "only the outline's own nodes carry a coordinate");
});

test("a node stays one node when the outline refreshes and the transcript carries it", () => {
  // The identity is the entry id on both sides, so the same message listed by a page and measured by the transcript is
  // one node: an append moves the snapshot, and the rail must not gain a duplicate at the seam.
  const before = buildRailNodes({ outline: outlineOf(["10", "20"]), turns: [measured("10"), measured("20")] });
  const after = buildRailNodes({
    outline: { ...outlineOf(["10", "20", "30"]), snapshot: CONVERSATION + "|" + HEAD + "|300" },
    turns: [measured("10"), measured("20"), measured("30")],
  });
  assert.deepEqual(after.map((node) => node.entryId), ["10", "20", "30"]);
  assert.equal(new Set(after.map((node) => node.entryId)).size, after.length, "no entry is listed twice");
  assert.deepEqual(after.slice(0, 2).map((node) => node.anchor), before.map((node) => node.anchor), "an append changed no anchor's identity");
});

test("a preview is bounded, whether it came from the server or from the measured message", () => {
  const long = "x".repeat(RAIL_PREVIEW_MAX_CHARS + 40);
  assert.equal(railPreview(long).length, RAIL_PREVIEW_MAX_CHARS + 1, "an over-long preview is cut to the rail's bound plus its ellipsis");
  assert.ok(railPreview(long).endsWith("…"));
  assert.equal(railPreview("  short  "), "short", "a short preview is trimmed and kept whole");
  assert.equal(railPreview("x".repeat(RAIL_PREVIEW_MAX_CHARS)), "x".repeat(RAIL_PREVIEW_MAX_CHARS), "a preview exactly at the bound is not cut");
});
