import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AgentMessage } from "./types.ts";
import type { SessionData } from "./durable-projection.ts";

const {
  acceptSession, claimEarlierHistory, clearPrefix, emptyReadout, landHistory, prefixOf, prependOlderPage,
  transcriptOf, windowOf,
} = await createJiti(import.meta.url).import<typeof import("./conversation-readout.ts")>("./conversation-readout.ts");

/**
 * The accepted readout's own cases: what the reader sees once the fold has accepted a window.
 *
 * Ordering — which statement is the conversation's current one — is the lifecycle fold's and is tested there; these
 * cases start from windows that were already accepted, because that is the only input this module has.
 */

const message = (text: string): AgentMessage => ({ role: "user", content: text });

/** One accepted payload: a window of ids under one head, with the pagination claim the transport stated. */
const session = (
  ids: string[],
  { head = "h1", hasMore = true, conversationId = "conv", sessionId = conversationId }: { head?: string; hasMore?: boolean; conversationId?: string; sessionId?: string } = {},
  base: SessionData | null = null,
): SessionData => ({
  sessionId,
  leafId: ids.at(-1) ?? null,
  historyHead: head,
  stats: base?.stats,
  context: {
    messages: ids.map(message),
    entryIds: ids,
    oldestEntryId: ids[0] ?? null,
    hasMore,
    thinkingLevel: base?.context.thinkingLevel ?? "off",
    model: base?.context.model ?? null,
  },
});

/** A readout holding one accepted window. */
const accepted = (ids: string[], options?: { head?: string; hasMore?: boolean }) => acceptSession(emptyReadout(), session(ids, options));

/** The ids the transcript would draw, which is the one visible answer a readout produces. */
const visible = (readout: ReturnType<typeof accepted>): string[] => {
  const s = readout.session;
  assert.ok(s, "the readout holds an accepted window");
  return transcriptOf(readout.prefix, windowOf(s)).entryIds;
};

test("a window and the prefix it keeps are decided in one step, not a render later", () => {
  // A reader paged e1..e2 in and is looking at a window holding e3..e4. The window then advances under the same head:
  // the entries it dropped while they were loaded migrate into the prefix, and the eviction is read from the accepted
  // payload itself — nothing keeps a second copy of what the previous render held.
  let readout = accepted(["e3", "e4"]);
  readout = prependOlderPage(readout, { sessionId: "conv", entryIds: ["e1", "e2"], messages: [message("e1"), message("e2")], historyHead: "h1", hasMore: true });
  assert.deepEqual(visible(readout), ["e1", "e2", "e3", "e4"]);
  readout = acceptSession(readout, session(["e5", "e6"]));
  assert.deepEqual(visible(readout), ["e1", "e2", "e3", "e4", "e5", "e6"], "an evicted entry stays on screen in transcript order");
  assert.deepEqual(readout.prefix?.messages.map((m) => ("content" in m ? m.content : undefined)), ["e1", "e2", "e3", "e4"], "and each kept entry is the message the reader was looking at");
});

test("a head marker that moved drops the prefix whole, and a whole-range window leaves nothing behind", () => {
  const paged = prependOlderPage(accepted(["e3", "e4"]), { sessionId: "conv", entryIds: ["e1", "e2"], messages: [message("e1"), message("e2")], historyHead: "h1", hasMore: true });
  assert.equal(acceptSession(paged, session(["c9"], { head: "h2" })).prefix, null, "a compaction or a reset re-baselines the transcript");
  assert.equal(acceptSession(paged, session(["e3", "e4"], { hasMore: false })).prefix, null, "a window that is the whole active range has nothing behind it to have paged to");
  assert.deepEqual(visible(acceptSession(paged, session(["e3", "e4", "e5"]))), ["e1", "e2", "e3", "e4", "e5"], "the same head keeps the pages");
});

test("another conversation's pages are not carried into this one", () => {
  const other = acceptSession(emptyReadout(), session(["o1"], { conversationId: "other" }));
  assert.equal(acceptSession(other, session(["e1"])).prefix, null, "a switch starts this conversation's history");
  const paged = prependOlderPage(accepted(["e3"]), { sessionId: "other", entryIds: ["o1"], messages: [message("o1")], historyHead: "h1", hasMore: true });
  assert.deepEqual(paged.prefix?.entryIds, ["o1"], "a page for another conversation starts the prefix rather than extending this one's");
});

test("a landed jump joins the prefix in order, once, and never over what the window owns", () => {
  let readout = prependOlderPage(accepted(["e6", "e7"]), { sessionId: "conv", entryIds: ["e3", "e4", "e5"], messages: [message("e3"), message("e4"), message("e5")], historyHead: "h1", hasMore: true });
  const landing = (ids: string[], windowEntryIds = ["e6", "e7"]) => ({ sessionId: "conv", entryIds: ids, messages: ids.map(message), windowEntryIds });
  readout = landHistory(readout, landing(["e3", "e4", "e5", "e6", "e7"])) ?? readout;
  assert.deepEqual(visible(readout), ["e3", "e4", "e5", "e6", "e7"], "the landed span is in history order in front of the window");
  assert.equal(new Set(visible(readout)).size, visible(readout).length, "no entry is contributed twice");
  assert.deepEqual(landHistory(readout, landing(["e6", "e7"])), null, "a landing the window already covers contributes nothing");
  assert.equal(landHistory(readout, { ...landing(["e1"]), sessionId: "other" }), null, "a landing naming another conversation reaches this transcript as nothing");
  // A jump that crossed a compaction is a landing against a history this readout has left: accepting the re-baselined
  // window retires the pages first, so the landing below is the only thing in front of the new window.
  const rebaselined = acceptSession(readout, session(["c9"], { head: "h2" }));
  assert.equal(rebaselined.prefix, null, "the re-baselined window states the transcript and the pages go with the head they were read under");
  assert.deepEqual(visible(landHistory(rebaselined, landing(["e1", "e2"], ["c9"])) ?? rebaselined), ["e1", "e2", "c9"], "a landing after the re-baseline is history of the new head");
});

test("a page states its own pagination claim, and the window states its own", () => {
  let readout = accepted(["e3", "e4"]);
  assert.equal(readout.hasMore, true, "the accepted window's claim is what the sentinel reads");
  readout = prependOlderPage(readout, { sessionId: "conv", entryIds: ["e1", "e2"], messages: [message("e1"), message("e2")], historyHead: "h1", hasMore: false });
  assert.equal(readout.hasMore, false, "a page that reached the start states no older history");
  assert.deepEqual(visible(readout), ["e1", "e2", "e3", "e4"], "and keeps the page it answered with");
  assert.equal(claimEarlierHistory(readout, true).hasMore, true, "a later page that finds more restates the claim");
  assert.equal(clearPrefix(readout).prefix, null, "a read that replaces the window is not extended by older pages");
});

test("the transcript draws a prefix only while it still precedes the window", () => {
  const prefix = prefixOf(["e2", "e3"], [message("e2"), message("e3")], "h1");
  assert.deepEqual(transcriptOf(prefix, { entryIds: ["e4"], messages: [message("e4")] }).entryIds, ["e2", "e3", "e4"]);
  // A prefix overlapping the window is not drawn at all: the window is authoritative for everything it covers, and
  // prepending an entry it carries would draw that entry twice.
  const overlapping = transcriptOf(prefix, { entryIds: ["e3", "e4"], messages: [message("e3"), message("e4")] });
  assert.deepEqual(overlapping.entryIds, ["e3", "e4"]);
  assert.deepEqual(transcriptOf(null, { entryIds: ["e4"], messages: [message("e4")] }), { entryIds: ["e4"], messages: [message("e4")], cursor: "e4" }, "the paging cursor is the oldest entry on screen");
  assert.equal(transcriptOf(null, { entryIds: [], messages: [] }).cursor, null, "an empty transcript has no cursor to page from");
});

test("a payload the fold refined beside the window keeps the prefix it was accepted with", () => {
  // The composer's own model and reasoning level are stated beside the window on the payload the readout holds. A
  // refinement of those fields is not a new window, so accepting the same entries again changes no page.
  const readout = prependOlderPage(accepted(["e3", "e4"]), { sessionId: "conv", entryIds: ["e1", "e2"], messages: [message("e1"), message("e2")], historyHead: "h1", hasMore: true });
  const refined: SessionData = { ...readout.session!, context: { ...readout.session!.context, thinkingLevel: "high", model: { provider: "p", modelId: "m" } } };
  const next = { ...readout, session: refined };
  assert.deepEqual(visible(next), ["e1", "e2", "e3", "e4"]);
  assert.equal(next.session?.context.thinkingLevel, "high", "the beside-window fact is published without touching the window");
});
