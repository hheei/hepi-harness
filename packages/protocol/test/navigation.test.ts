import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "../src/index.ts";
import {
  NAVIGATION_COORDINATE_VERSION,
  NAVIGATION_DEFAULT_LIMIT,
  NAVIGATION_MAX_LIMIT,
  NAVIGATION_PAGE_MAX_BYTES,
  NAVIGATION_PREVIEW_MAX_BYTES,
  NAVIGATION_TARGET_DEFAULT_AROUND,
  NAVIGATION_TARGET_MAX_AROUND,
  buildNavigationPage,
  buildNavigationTargetWindow,
  checkNavigationCoordinate,
  decodeNavigationAnchor,
  encodeNavigationAnchor,
  navigationAnchorOf,
  navigationPreview,
  parseNavigationPageRequest,
  parseNavigationTargetRequest,
  type NavigationAnchor,
} from "../src/navigation.ts";

/**
 * The navigation contract at its shared seam: the coordinate a jump is addressed by, the bounds a page request may
 * state, and the shape a page is assembled in. These are the rules **both** sides of the wire apply, so they are
 * asserted here rather than through one transport — and everything asserted is the contract's own published number,
 * read from the constant the route uses, so a bound cannot be changed on one side unnoticed.
 */

/** One anchor's worth of identity, so a test states the scope it means instead of re-deriving an encoding. */
const SCOPE = "41|7";
const coordinate = (entryId: string, scope = SCOPE, conversationId = "41") => ({
  version: NAVIGATION_COORDINATE_VERSION,
  conversationId,
  scope,
  entryId,
});

test("a coordinate round-trips opaquely and carries the scope inside it", () => {
  const encoded = encodeNavigationAnchor(coordinate("18"));
  assert.notEqual(encoded.includes("18"), true, "the entry id must not be readable as a bare position: " + encoded);
  const decoded = decodeNavigationAnchor(encoded);
  assert.deepEqual(decoded, {
    ok: true,
    coordinate: { version: NAVIGATION_COORDINATE_VERSION, conversationId: "41", scope: SCOPE, entryId: "18" },
  });
});

test("a coordinate that is not one is refused, and a version is stated rather than guessed", () => {
  // A coordinate the contract never issued: no prefix, no encoded payload, a payload that is not JSON, and a JSON
  // payload that is not an object. Each names nothing, so each is refused rather than read as a position.
  for (const value of ["", "18", "nav1.", "nav1.not-base64!!", "nav1.Zm9v", "nav1.MQ", "nav1.W10"]) {
    const decoded = decodeNavigationAnchor(value);
    assert.equal(decoded.ok, false, "a coordinate that names nothing must be refused: " + value);
    assert.equal(decoded.code, "malformed");
  }
  const otherVersion = encodeNavigationAnchor({ ...coordinate("18"), version: NAVIGATION_COORDINATE_VERSION + 1 });
  const refused = decodeNavigationAnchor(otherVersion);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "version_mismatch");
});

test("a coordinate cannot address another conversation or a history that re-baselined", () => {
  const decoded = decodeNavigationAnchor(encodeNavigationAnchor(coordinate("18")));
  assert.equal(decoded.ok, true);
  assert.equal(checkNavigationCoordinate(decoded.coordinate, { conversationId: "99", scope: SCOPE })?.code, "wrong-scope");
  assert.equal(checkNavigationCoordinate(decoded.coordinate, { conversationId: "41", scope: "41|9" })?.code, "stale-snapshot");
  assert.equal(checkNavigationCoordinate(decoded.coordinate, { conversationId: "41", scope: SCOPE }), undefined);
});

test("a preview is capped in UTF-8 bytes and never splits a code point", () => {
  // The cap is bytes, so the same character count costs different answers: an assertion on the character count alone
  // would pass while the wire bound was exceeded.
  const ascii = navigationPreview("a".repeat(NAVIGATION_PREVIEW_MAX_BYTES + 500));
  assert.equal(ascii.length, NAVIGATION_PREVIEW_MAX_BYTES);
  const cjk = navigationPreview("字".repeat(NAVIGATION_PREVIEW_MAX_BYTES));
  assert.equal(Buffer.byteLength(cjk, "utf8"), NAVIGATION_PREVIEW_MAX_BYTES, "a CJK preview is still inside the byte cap");
  assert.equal(cjk.includes("\ufffd"), false, "a cut code point would leave a replacement character");
  const emoji = navigationPreview("🙂".repeat(NAVIGATION_PREVIEW_MAX_BYTES));
  assert.equal(Buffer.byteLength(emoji, "utf8") <= NAVIGATION_PREVIEW_MAX_BYTES, true);
  assert.equal(emoji.includes("\ufffd"), false);
});

test("a preview is the message's own text: whitespace collapsed, trimmed, and never a marker", () => {
  assert.equal(navigationPreview("  first   line\nsecond\tline  "), "first line second line");
  // An empty preview states that the message holds no text. An ellipsis would be a character the entry does not
  // contain, and a caller copies what it renders.
  assert.equal(navigationPreview(""), "");
  assert.equal(navigationPreview("   \n\t "), "");
  assert.equal(navigationPreview("short").includes("…"), false);
});

test("the page size is bounded, and a caller cannot ask past the cap or for no index at all", () => {
  assert.deepEqual(parseNavigationPageRequest({}), { ok: true, request: { limit: NAVIGATION_DEFAULT_LIMIT, capped: true } });
  assert.deepEqual(parseNavigationPageRequest({ limit: "5" }), { ok: true, request: { limit: 5, capped: false } });
  assert.deepEqual(parseNavigationPageRequest({ limit: String(NAVIGATION_MAX_LIMIT + 5_000) }), { ok: true, request: { limit: NAVIGATION_MAX_LIMIT, capped: false } });
  assert.deepEqual(parseNavigationPageRequest({ cursor: "18", scope: SCOPE }), { ok: true, request: { limit: NAVIGATION_DEFAULT_LIMIT, capped: true, cursor: 18, scope: SCOPE } });
  // A malformed value is refused, never coerced: a client must not be handed a page it believes it bounded itself.
  for (const limit of ["0", "-5", "1e3", "abc", " 5"]) {
    const refused = parseNavigationPageRequest({ limit });
    assert.equal(refused.ok, false, "limit=" + limit);
    assert.equal(refused.code, "malformed");
  }
  assert.equal(parseNavigationPageRequest({ cursor: "18.5" }).ok, false);
});

/** One anchor, from the identity the Backend would hold. */
const anchor = (entryId: string, preview: string): NavigationAnchor =>
  navigationAnchorOf({ conversationId: "41", scope: SCOPE, entryId, cursor: Number(entryId), preview });

test("a page states its own size, orders anchors oldest first, and continues from the last anchor it returned", () => {
  const page = buildNavigationPage({
    protocol: PROTOCOL_VERSION,
    conversationId: "41",
    snapshot: "41|7|52",
    scope: SCOPE,
    anchors: [anchor("9", "first"), anchor("18", "second"), anchor("44", "third")],
    hasMore: true,
    capped: true,
    prefix: { kind: "non-user", entries: 2, firstEntryId: "7", lastEntryId: "8" },
  });
  assert.equal(page.bytes <= NAVIGATION_PAGE_MAX_BYTES, true);
  assert.deepEqual(page.anchors.map(entry => entry.cursor), [9, 18, 44]);
  assert.equal(page.order, "oldest-first");
  assert.equal(page.nextCursor, 44);
  assert.equal(page.hasMore, true);
  assert.equal(page.snapshot, "41|7|52");
  assert.equal(page.scope, SCOPE);
  assert.equal(page.protocol, PROTOCOL_VERSION);
  assert.equal(page.conversationId, "41");
});

test("the byte budget shortens a page instead of producing an unbounded one, and says so as more history", () => {
  // Each anchor carries a full-cap preview, so a request for more anchors than the budget can hold is cut by size
  // rather than by count — and the cut page must still hand back the cursor that reaches what it dropped.
  const long = "x".repeat(NAVIGATION_PREVIEW_MAX_BYTES);
  const anchors = Array.from({ length: 400 }, (_unused, index) => anchor(String(index + 1), long));
  const page = buildNavigationPage({ protocol: PROTOCOL_VERSION, conversationId: "41", snapshot: "41|-|999", scope: "41|-", anchors, hasMore: false, capped: false });
  assert.equal(page.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "a page of full-cap previews must be bounded");
  assert.equal(page.anchors.length < anchors.length, true, "the budget, not the count, must have cut it");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, page.anchors.at(-1)!.cursor);
});

test("an empty page states no continuation, because nothing would reach it", () => {
  const page = buildNavigationPage({ protocol: PROTOCOL_VERSION, conversationId: "41", snapshot: "41|-|-", scope: "41|-", anchors: [], hasMore: false, capped: true, prefix: { kind: "none" } });
  assert.deepEqual(page.anchors, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, undefined);
  assert.deepEqual(page.prefix, { kind: "none" });
});
/** One entry of a window, as the transcript's own projection would hand it over. */
const sized = (entryId: string, padding = 0): WindowEntryFixture => ({
  id: entryId,
  role: entryId === "10" ? "user" : "assistant",
  text: "t" + entryId + "x".repeat(padding),
  message: { role: "assistant", content: [] },
});

/** The projection's own wire shape, stated locally so the fixture does not import a transport type. */
type WindowEntryFixture = { readonly id: string; readonly role: "user" | "assistant" | "toolResult"; readonly text: string; readonly message: unknown };

/** A window around entry 10, from entries the read already collected. */
const windowFacts = (entries: readonly WindowEntryFixture[], facts: { hasOlder: boolean; hasNewer: boolean; capped?: boolean }) => ({
  protocol: PROTOCOL_VERSION,
  conversationId: "41",
  snapshot: "41|-|99",
  scope: "41|-",
  target: { entryId: "10", anchor: encodeNavigationAnchor(coordinate("10")), present: true, blocks: [0] },
  entries,
  hasOlder: facts.hasOlder,
  hasNewer: facts.hasNewer,
  capped: facts.capped ?? false,
});

/**
 * The size a navigation read states is the size it **ships**. Both reads carry their own `bytes` field, and that
 * field's width is part of the object reporting it (review note N1), so this is asserted against the serialized
 * response rather than against the assembler's arithmetic: a caller that measures what it received against what the
 * response said can never be handed two different numbers.
 */
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

test("a read states the size it ships, its own bytes field included", () => {
  const short = buildNavigationPage({ protocol: PROTOCOL_VERSION, conversationId: "41", snapshot: "41|-|3", scope: "41|-", anchors: [anchor("3", "a prompt")], hasMore: false, capped: true, prefix: { kind: "none" } });
  assert.equal(short.bytes, wireBytes(short), "the stated size is the response's size: " + short.bytes);

  // The ceiling the review measured: the maximum count of anchors, each carrying a full-cap preview, nothing dropped
  // and no continuation to state.
  const long = "x".repeat(NAVIGATION_PREVIEW_MAX_BYTES);
  const ceiling = buildNavigationPage({ protocol: PROTOCOL_VERSION, conversationId: "41", snapshot: "41|-|99999", scope: "41|-", anchors: Array.from({ length: NAVIGATION_MAX_LIMIT }, (_unused, index) => anchor(String(index + 1), long)), hasMore: false, capped: false });
  assert.equal(ceiling.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "the budget admits it: " + ceiling.bytes);
  assert.equal(ceiling.bytes, wireBytes(ceiling), "and does not outstate it: " + ceiling.bytes + " against " + wireBytes(ceiling));

  // The same rule for a window, whose byte field sits beside message bodies rather than previews.
  const window = buildNavigationTargetWindow(windowFacts([sized("9"), sized("10")], { hasOlder: true, hasNewer: true }));
  assert.equal(window.bytes, wireBytes(window), "one measurement, one meaning, in both reads");
});

test("a target window is bounded, keeps its target, and names both boundaries it stopped at", () => {
  const around = ["6", "7", "8", "9", "10", "11", "12"];
  const window = buildNavigationTargetWindow(windowFacts(around.map(id => sized(id)), { hasOlder: true, hasNewer: true, capped: true }));
  assert.equal(window.order, "oldest-first");
  assert.deepEqual(window.entries.map(entry => entry.id), around, "a window that fits carries exactly what the read collected");
  assert.equal(window.capped, true, "the default, not the caller, decided the counts");
  assert.equal(window.trimmed, true);
  assert.equal(window.olderCursor, 6, "the boundary is the oldest entry it carries, exclusive, so a continuation never repeats it");
  assert.equal(window.newerCursor, 12);
  assert.equal(window.target.entryId, "10");
  assert.deepEqual(decodeNavigationAnchor(window.target.anchor), { ok: true, coordinate: coordinate("10") });
});

test("the byte budget trims a window's outer ends and never its target", () => {
  // Heavy context around a lighter target, so the budget has to choose which neighbours to leave out.
  const around = ["8", "9", "10", "11", "12", "13"];
  const entries = around.map(id => sized(id, id === "10" ? 2_000 : 30_000));
  const window = buildNavigationTargetWindow(windowFacts(entries, { hasOlder: true, hasNewer: true }));
  assert.equal(window.bytes <= NAVIGATION_PAGE_MAX_BYTES, true, "a window outgrows nothing: " + window.bytes);
  assert.equal(window.entries.some(entry => entry.id === "10"), true, "the entry the caller jumped for is in the window it asked for");
  assert.equal(window.entries.length < around.length, true, "the budget, not the count, cut it: " + window.entries.length);
  assert.equal(window.trimmed, true);
  assert.equal(window.hasOlder && window.hasNewer, true, "what was dropped is stated as lying beyond a boundary");
  assert.equal(window.olderCursor, Number(window.entries[0]!.id));
  assert.equal(window.newerCursor, Number(window.entries.at(-1)!.id));

  // A target whose own message cannot fit is not emptied: it is carried whole, and the read that assembled it sees
  // that the budget was passed and answers the named size instead of a window about a turn it does not carry.
  const alone = buildNavigationTargetWindow(windowFacts([sized("10", 2 * NAVIGATION_PAGE_MAX_BYTES)], { hasOlder: false, hasNewer: false }));
  assert.deepEqual(alone.entries.map(entry => entry.id), ["10"], "one oversized entry ships rather than a window of nothing");
  assert.equal(alone.bytes > NAVIGATION_PAGE_MAX_BYTES, true, "and the read can see the budget was passed: " + alone.bytes);
});

test("a target request is bounded by the contract, before any history is read", () => {
  const anchorValue = encodeNavigationAnchor(coordinate("18"));
  const defaults = parseNavigationTargetRequest({ anchor: anchorValue });
  assert.equal(defaults.ok, true);
  if (defaults.ok) {
    assert.deepEqual(
      { before: defaults.request.before, after: defaults.request.after, capped: defaults.request.capped },
      { before: NAVIGATION_TARGET_DEFAULT_AROUND, after: NAVIGATION_TARGET_DEFAULT_AROUND, capped: true },
    );
    assert.deepEqual(defaults.request.coordinate, coordinate("18"), "the coordinate the caller addressed is the request");
  }

  const asked = parseNavigationTargetRequest({ anchor: anchorValue, before: "0", after: String(NAVIGATION_TARGET_MAX_AROUND + 500), snapshot: "41|-|52", entry: "18", block: "2" });
  assert.equal(asked.ok, true);
  if (asked.ok) {
    assert.deepEqual(
      { before: asked.request.before, after: asked.request.after, capped: asked.request.capped, snapshot: asked.request.snapshot, entry: asked.request.entry, block: asked.request.block },
      { before: 0, after: NAVIGATION_TARGET_MAX_AROUND, capped: false, snapshot: "41|-|52", entry: "18", block: 2 },
      "a count is clamped, and `capped` still means the default decided it",
    );
  }

  // Nothing is coerced: a caller that mis-stated a bound, or handed a value the contract never issued, is told
  // before the Backend reads any history rather than served a window it believes it sized.
  assert.equal(refusedCode(parseNavigationTargetRequest({})), "malformed", "a window with no target names nothing to be around");
  for (const params of [{ anchor: "nav1.nonsense" }, { anchor: anchorValue, before: "-1" }, { anchor: anchorValue, after: "1.5" }, { anchor: anchorValue, block: "x" }, { anchor: anchorValue, entry: "1.5" }]) {
    assert.equal(refusedCode(parseNavigationTargetRequest(params)), "malformed", JSON.stringify(params));
  }
  // A coordinate from another version is named as that rather than as a malformed one, because the caller's fix differs.
  const otherVersion = parseNavigationTargetRequest({ anchor: encodeNavigationAnchor({ ...coordinate("18"), version: NAVIGATION_COORDINATE_VERSION + 1 }) });
  assert.equal(refusedCode(otherVersion), "version_mismatch");
});

/** The code a refused navigation result carries, or a test failure: the contract was asked to refuse this. */
function refusedCode(result: { readonly ok: boolean; readonly code?: string }): string {
  assert.equal(result.ok, false, "the contract was asked to refuse this");
  return result.code ?? "";
}
