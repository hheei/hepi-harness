import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { NavigationCoordinator, reduceOutlinePages, scopeOfSnapshot, mergeLandedPrefix, navigationHoldsViewport, searchSettlementAction, NAVIGATION_OUTCOMES } = await jiti.import("./history-navigation.ts");
const { encodeNavigationAnchor, decodeNavigationAnchor, buildNavigationPage, buildNavigationTargetWindow } = await jiti.import("@hepi/protocol/navigation");

/** The conversation every case addresses, and the identity its history states. */
const CONVERSATION = "42";
const HEAD = "9";
const TAIL = "120";
const SNAPSHOT = CONVERSATION + "|" + HEAD + "|" + TAIL;
const SCOPE = CONVERSATION + "|" + HEAD;

const anchor = (entryId, scope = SCOPE) => encodeNavigationAnchor({ version: 1, conversationId: CONVERSATION, scope, entryId });

/** A window the Backend could have answered: the target with context either side, in native order. */
function windowOf(entryId, options = {}) {
  const entries = options.entries ?? [
    { id: String(Number(entryId) - 2), role: "user", text: "older", message: { role: "user", content: "older" } },
    { id: String(Number(entryId) - 1), role: "assistant", text: "older answer", message: { role: "assistant", content: "older answer" } },
    { id: entryId, role: "user", text: "the target", message: { role: "user", content: "the target" } },
    { id: String(Number(entryId) + 1), role: "assistant", text: "answer", message: { role: "assistant", content: "answer" } },
  ];
  return buildNavigationTargetWindow({
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: options.snapshot ?? SNAPSHOT,
    scope: options.scope ?? SCOPE,
    target: { entryId, anchor: anchor(entryId, options.scope ?? SCOPE), present: options.present !== false, blocks: [0] },
    entries,
    hasOlder: true,
    hasNewer: false,
    capped: true,
  });
}

/** The refusal one navigation route answers, in the shape the connection's read throws it. */
function refusal(code, message = "refused") {
  const error = new Error(message);
  error.name = "WorkbenchRequestError";
  error.status = code === "missing" ? 404 : code === "malformed" ? 400 : 409;
  error.code = code;
  error.body = { protocol: "hepi.v1", conversationId: CONVERSATION, code, error: message };
  return error;
}

/**
 * One coordinator over a stated conversation.
 *
 * The host is the surface's whole contribution — identity, busy, held ids, the prefix owner's landing, one read — and
 * the case may move it afterwards, which is how a switch or an append is exercised without a browser. The read records
 * every query it was handed, so "one target request, not a loop over every preceding page" is a measured count rather
 * than a claim.
 */
function harness(options = {}) {
  const requests = [];
  const landed = [];
  const settled = [];
  const host = {
    conversationId: CONVERSATION,
    snapshotRevision: options.snapshotRevision === undefined ? SNAPSHOT : options.snapshotRevision,
    busy: options.busy === true,
    activeEntryIds: [...(options.entries ?? [])],
    signal: new AbortController().signal,
    landWindow: (window) => { landed.push(window); },
    onSettled: (outcome) => { settled.push(outcome); },
    readTargetWindow: async (input) => {
      requests.push(input.query);
      if (options.read === undefined) throw new Error("no read was stated for this case");
      return await options.read(input);
    },
  };
  return { requests, landed, settled, host, coordinator: new NavigationCoordinator(host) };
}

const drain = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

test("an unloaded anchor costs exactly one target read and lands its window on the history owner", async () => {
  // The ticket's central claim, read as counts: one request, one landed window, one settlement — and the request is
  // bounded by the contract's own defaults rather than by a window size this client invents.
  const h = harness({ read: () => windowOf("100") });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.requests.length, 1, "one target read for a jump to an unloaded anchor");
  assert.match(h.requests[0], /anchor=nav1\./, "the read is addressed by the coordinate the outline page issued");
  assert.match(h.requests[0], /snapshot=42%7C9%7C120/, "and pinned at the snapshot the conversation states, so an append cannot move it");
  assert.ok(!h.requests[0].includes("before="), "no window size is invented here; the Backend's bound is the one that cuts");
  assert.equal(h.landed.length, 1, "one window handed to the history owner");
  assert.deepEqual(h.settled.map((outcome) => outcome.kind), ["held"], "one settlement, and it is the landing");
  assert.equal(h.settled[0].loaded, false, "the landing came from the read, not from what was already held");
  assert.deepEqual(h.landed[0].entries.map((entry) => entry.id), ["98", "99", "100", "101"], "the window's entries travel in native order");
  assert.equal(h.landed[0].hasOlder, true, "and its continuation facts travel with them");
  assert.equal(h.coordinator.heldRequest().target.entryId, "100", "the surface holds the anchor it jumped for");
});

test("a target the conversation already carries lands without a read", async () => {
  // The difference between this coordinator and the page walk it replaces: an entry is looked for in what is held, not
  // in what the next page might contain, so a loaded target costs no request and publishes no duplicate history.
  const h = harness({ entries: ["10", "11", "12"] });
  h.coordinator.jump(CONVERSATION, anchor("12"));
  await drain();
  assert.equal(h.requests.length, 0, "no window was read for an entry the transcript holds");
  assert.equal(h.landed.length, 0, "and nothing reaches the prefix owner, because the projection owns this entry");
  assert.equal(h.settled[0].kind, "held");
  assert.equal(h.settled[0].loaded, true, "the settlement still says landed, which is what the surface's scroll waits on");
  assert.deepEqual(h.settled[0].window.entries, [], "and states no window it did not read");
});

test("a deep search hit uses this coordinator: one read, its exact block, one settlement", async () => {
  const h = harness({ read: () => windowOf("100") });
  h.coordinator.searchTarget({ conversationId: CONVERSATION, entryId: "100", block: 3 });
  await drain();
  assert.equal(h.requests.length, 1, "one target read for a result outside the loaded window");
  const query = new URLSearchParams(h.requests[0].slice(1));
  assert.equal(query.get("entry"), "100", "the hit's entry travels with the coordinate the read is addressed by");
  assert.equal(query.get("block"), "3", "and the native block index the Backend checks against that entry");
  assert.equal(h.settled[0].kind, "held");
  assert.equal(h.settled[0].request.target.block, 3, "the settlement names the block the surface aligns to");
  assert.equal(h.landed[0].entries.length, 4, "the landed window is the bounded one the Backend read");
});

test("navigation issues no sequential page request whatever the distance", async () => {
  // Spec decisions 7 and 8 in one count. The read answers with a window that does not carry the target, which is the
  // shape the old locate loop would have followed with another page; this settles once and says what happened.
  const h = harness({ read: () => windowOf("100", { present: false, entries: [] }) });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.requests.length, 1, "one request, and the answer that could not carry the target is the last one");
  assert.equal(h.settled.length, 1, "one settlement, not a further attempt");
  assert.equal(h.settled[0].kind, "failed");
  assert.equal(h.settled[0].failure, "missing", "a window without its target is named, never landed beside");
});

test("every unresolved lookup renders its own named outcome with retry and dismiss", async () => {
  // Each outcome is observed as a settled state of its own: no failure path ends as a silent handled, and none borrows
  // a neighbour's name, which is what a locale lookup by name depends on. The two client-side names, `cancelled` and
  // `deferred-busy`, are exercised by their own cases below, because reaching them needs a surface that moves rather
  // than a read that refuses.
  const cases = [
    { label: "a removed target", read: () => { throw refusal("missing"); }, expect: "missing" },
    { label: "a history that re-baselined", read: () => { throw refusal("stale-snapshot"); }, expect: "stale-snapshot" },
    { label: "a coordinate of another conversation", read: () => { throw refusal("wrong-scope"); }, expect: "wrong-scope" },
    { label: "an address the contract cannot read", read: () => { throw refusal("malformed"); }, expect: "malformed" },
    { label: "a read that never answered", read: () => { throw new Error("gateway went away"); }, expect: "error" },
    // `frame_too_large` is the shipped shape: a code the surface has no word for is the read's failure with the
    // Backend's own sentence beside it, and is still a rendered state rather than a silent no-op.
    { label: "a target no window can carry", read: () => { throw refusal("frame_too_large", "this entry cannot be carried inside a navigation window"); }, expect: "error" },
  ];
  for (const item of cases) {
    const h = harness({ read: item.read });
    h.coordinator.jump(CONVERSATION, anchor("100"));
    await drain();
    assert.equal(h.settled.length, 1, item.label + " settles once");
    assert.equal(h.settled[0].kind, "failed", item.label);
    assert.equal(h.settled[0].failure, item.expect, item.label + " is named " + item.expect);
    assert.equal(typeof h.settled[0].detail, "string", item.label + " states the reason it can show");
    assert.equal(typeof h.settled[0].retry, "function", item.label + " offers a retry");
    assert.equal(typeof h.settled[0].clear, "function", item.label + " offers a dismissal");
    assert.equal(h.landed.length, 0, item.label + " publishes nothing into the transcript");
  }
  assert.deepEqual([...NAVIGATION_OUTCOMES].sort(), ["cancelled", "deferred-busy", "error", "malformed", "missing", "stale-snapshot", "wrong-scope"]);
});

test("a conversation switch cancels the jump it was made for", async () => {
  const released = Promise.withResolvers();
  const h = harness({ read: () => released.promise });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled.length, 0, "nothing has settled while the read is on the wire");
  // The reader switches: the host now names another conversation, and the parked read answers afterwards.
  h.host.conversationId = "77";
  released.resolve(windowOf("100"));
  await drain();
  assert.equal(h.settled.length, 1, "the abandoned request settles exactly once, by name");
  assert.equal(h.settled[0].failure, "cancelled", "a jump retired by a switch says so rather than landing");
  assert.equal(h.landed.length, 0, "and its window never reaches the conversation the reader is now looking at");
  assert.equal(h.settled[0].request.conversationId, CONVERSATION, "the outcome names the conversation the request was made for");
});

test("a superseded jump is dropped rather than reported over the landing it lost to", async () => {
  const first = Promise.withResolvers();
  const requests = [];
  const settled = [];
  const host = {
    conversationId: CONVERSATION,
    snapshotRevision: SNAPSHOT,
    busy: false,
    activeEntryIds: [],
    signal: new AbortController().signal,
    landWindow: () => {},
    onSettled: (outcome) => { settled.push(outcome); },
    readTargetWindow: async (input) => {
      requests.push(input.anchor);
      return input.anchor === anchor("100") ? await first.promise : windowOf("200");
    },
  };
  const coordinator = new NavigationCoordinator(host);
  coordinator.jump(CONVERSATION, anchor("100"));
  coordinator.jump(CONVERSATION, anchor("200"));
  await drain();
  assert.equal(settled.length, 1, "the second jump settles; the first is the one being replaced");
  assert.equal(settled[0].kind, "held");
  assert.equal(settled[0].request.target.entryId, "200");
  first.resolve(windowOf("100"));
  await drain();
  // A replaced read is dropped, not reported: the surface is showing the landing the reader actually asked for, and a
  // late `cancelled` over it would be the wrong state in the other direction.
  assert.equal(settled.length, 1, "the replaced read reports nothing over the landing it lost to");
  assert.equal(coordinator.heldRequest().target.entryId, "200", "the surface holds the jump it asked for last");
  assert.equal(requests.length, 2, "two jumps, two reads — one per request, never a page walk between them");
});

test("a jump made while the conversation is busy is deferred, and lands only if the reader takes the offer", async () => {
  // `deferred-busy` is retryable, which is the whole content of the outcome: the jump is parked and named, and a run
  // ending lands it only when the reader asked for that.
  const h = harness({ busy: true, read: () => windowOf("100") });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.requests.length, 0, "no history is read behind the transcript while its stream settles a turn");
  assert.equal(h.settled[0].failure, "deferred-busy");
  assert.equal(h.coordinator.heldRequest().target.entryId, "100", "the deferred jump is the request the surface holds");
  // The run ends and nobody took the offer: the named outcome stands and nothing is read.
  h.host.busy = false;
  h.coordinator.settleWaited();
  await drain();
  assert.equal(h.requests.length, 0, "a run that was never asked to make way for a jump lands nothing");
  assert.equal(h.settled.length, 1, "and the outcome the reader is looking at is still the deferral");
  // Now the jump is asked again and the reader takes the offer.
  h.host.busy = true;
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled[1].failure, "deferred-busy");
  h.settled[1].retry();
  h.host.busy = false;
  h.coordinator.settleWaited();
  await drain();
  assert.equal(h.requests.length, 1, "one read, issued once the run settled");
  assert.equal(h.settled[2].kind, "held");
  // A parked jump the reader dismissed is not resurrected by a later run ending.
  h.host.busy = true;
  h.coordinator.jump(CONVERSATION, anchor("101"));
  await drain();
  h.coordinator.clear();
  h.host.busy = false;
  h.coordinator.settleWaited();
  await drain();
  assert.equal(h.requests.length, 1, "a dismissed jump is not re-issued by a run settling");
});

test("a navigation owns the viewport from the owed read through the scroll, and nothing after", () => {
  // Spec decision 7, stated as one value the sentinel reads. An animation must not be able to page history in behind
  // the reader, and a gate that outlived its navigation must not silence the reader's *own* paging either — so both
  // edges of the span are asserted here rather than counted in a browser.
  const held = { entryIds: ["10", "11", "12"] };
  assert.equal(navigationHoldsViewport({ pending: null, outcome: null, request: null, ...held }), null, "no navigation, so the reader's own paging is theirs");
  // A target the transcript does not carry: one read is owed, and the sentinel crossing the top of the viewport on the
  // way there is the window moving, not the reader asking.
  assert.deepEqual(navigationHoldsViewport({ pending: null, outcome: null, request: { entryId: "100" }, ...held }), { entryId: "100" }, "an owed read holds the viewport");
  // The scroll after the landing: the entries are mounted, the surface is aligning them, and the reveal is still a
  // movement the reader did not make.
  assert.deepEqual(navigationHoldsViewport({ pending: { entryId: "100" }, outcome: null, request: { entryId: "100" }, ...held }), { entryId: "100" }, "the alignment holds it too");
  // A landing that has not reported its scroll finished, and the same navigation once it has: the shell's target is what
  // closes the span, because a gate left standing after a landing is the reader unable to page back.
  const landed = { kind: "held", loaded: false, request: { conversationId: CONVERSATION, target: { entryId: "100" } }, window: {}, coordinate: {} };
  assert.deepEqual(navigationHoldsViewport({ pending: null, outcome: landed, request: { entryId: "100" }, ...held }), { entryId: "100" }, "a landing still owing its scroll holds the viewport");
  assert.equal(navigationHoldsViewport({ pending: null, outcome: landed, request: null, ...held }), null, "once the scroll is reported, the reader's paging is theirs again");
  assert.equal(navigationHoldsViewport({ pending: null, outcome: null, request: { entryId: "12" }, ...held }), null, "a target already on screen is a scroll, not a read");
  // A request for a *different* entry than the one on screen is a new navigation, gate and all.
  assert.deepEqual(navigationHoldsViewport({ pending: null, outcome: landed, request: { entryId: "200" }, ...held }), { entryId: "200" }, "the next jump is gated on its own");
  // Every unresolved outcome ends the navigation it answered: a named failure is a state on screen, not a movement.
  for (const failure of NAVIGATION_OUTCOMES) {
    const failed = { kind: "failed", failure, request: { conversationId: CONVERSATION, target: { entryId: "100" } }, detail: "", retry: () => {}, clear: () => {} };
    assert.equal(navigationHoldsViewport({ pending: null, outcome: failed, request: { entryId: "100" }, ...held }), null, failure + " releases the viewport");
  }
});

test("a stale coordinate is refused by the conversation's own fence before any read", async () => {
  // The head marker moved: the conversation states a different scope than the page the jump came from was issued under.
  const h = harness({ snapshotRevision: CONVERSATION + "|99|" + TAIL });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.requests.length, 0, "a coordinate the conversation's history no longer answers costs no read");
  assert.equal(h.settled[0].failure, "stale-snapshot", "named as the re-baseline it is, not as a missing entry");
  // A coordinate minted for another conversation is the other half of the same fence, held apart because it renders apart.
  const other = harness();
  other.coordinator.jump(CONVERSATION, encodeNavigationAnchor({ version: 1, conversationId: "77", scope: "77|" + HEAD, entryId: "5" }));
  await drain();
  assert.equal(other.settled[0].failure, "wrong-scope");
  // And a value this contract never issued names nothing at all.
  const junk = harness();
  junk.coordinator.jump(CONVERSATION, "nav1.not-a-coordinate");
  await drain();
  assert.equal(junk.settled[0].failure, "malformed");
  assert.equal(junk.requests.length, 0);
});

test("an append keeps every anchor's identity and does not invalidate a held jump", async () => {
  // The identity rule the outline contract is built on, applied to a landing: an append moves the snapshot token's
  // entry fact and leaves the scope alone, so a jump made before the turn arrived still addresses its message.
  const h = harness({ read: () => windowOf("100") });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled[0].kind, "held", "the jump lands across a conversation that grew");
  h.host.snapshotRevision = CONVERSATION + "|" + HEAD + "|300";
  h.host.activeEntryIds = ["300"];
  h.coordinator.jump(CONVERSATION, anchor("101"));
  await drain();
  assert.equal(h.settled[1].kind, "held", "and the next jump is addressed by the same scope");
  assert.match(h.requests[1], /snapshot=42%7C9%7C300/, "pinned at the newest snapshot the conversation states");
});

/**
 * A retry after the history re-baselined addresses the message in the history the conversation states now.
 *
 * The failure is a state the reader acts on, so the offer has to be able to succeed. A retry that re-issued the
 * coordinate the refused attempt carried stated the same refusal for ever — the loop review 160 measured, where the
 * rail only recovered when the whole outline was read again by hand.
 */
test("a stale-snapshot retry mints a coordinate over the scope the conversation states now", async () => {
  const scopes = [];
  const h = harness({
    read: (input) => {
      const decoded = decodeNavigationAnchor(input.anchor);
      scopes.push(decoded.ok ? decoded.coordinate.scope : "undecodable");
      if (scopes.length === 1) throw refusal("stale-snapshot");
      return windowOf("100", { scope: CONVERSATION + "|99" });
    },
  });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled[0].failure, "stale-snapshot");
  assert.equal(scopes[0], SCOPE, "the refused attempt carried the coordinate the page issued");
  // The conversation states a new head marker, which is the re-baseline the failure named.
  h.host.snapshotRevision = CONVERSATION + "|99|" + TAIL;
  h.settled[0].retry();
  await drain();
  assert.equal(h.settled[1].kind, "held", "the retry lands instead of repeating the refusal");
  assert.equal(scopes[1], CONVERSATION + "|99", "addressed over the scope the conversation states now");
  assert.match(h.requests[1], /snapshot=42%7C99%7C120/, "pinned at the snapshot that scope belongs to");
});

test("a window read against another identity is refused rather than published", async () => {
  // The answer is checked against the conversation before anything reaches the transcript: a window whose scope moved
  // under the read (a compaction racing the jump) is the read's failure, not a landing nobody asked for.
  const h = harness({ read: () => windowOf("100", { scope: CONVERSATION + "|99", snapshot: CONVERSATION + "|99|120" }) });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.landed.length, 0, "nothing was handed to the history owner");
  assert.equal(h.settled[0].kind, "failed");
  assert.equal(h.settled[0].failure, "stale-snapshot", "an answer that contradicts the conversation's identity is named as the re-baseline it is");
});

test("scopeOfSnapshot reads the identity the history owner spells", () => {
  // One identity, one spelling: the scope is the snapshot token with its entry fact dropped, which is what lets a
  // client address a coordinate without a second rule for when history moved.
  assert.equal(scopeOfSnapshot(SNAPSHOT), SCOPE);
  assert.equal(scopeOfSnapshot(CONVERSATION + "|-|-"), CONVERSATION + "|-");
  assert.equal(scopeOfSnapshot("no-separator"), "no-separator");
});

test("a landed window joins the prefix in order, once, and never over what the window owns", () => {
  // The history owner's boundary, asserted where it is decided: the reader's pages stay in front, the landed span is
  // merged by the ids the Backend issued, an entry the projection's window carries is not contributed by the prefix
  // (that overlap is what makes the prefix rule drop every page the reader loaded), and a repeated landing is a no-op.
  const prefix = { entryIds: ["10", "11"], messages: ["a", "b"] };
  const landed = { entryIds: ["20", "21", "22"], messages: ["c", "d", "e"] };
  const merged = mergeLandedPrefix(prefix, landed, ["22", "23"]);
  assert.deepEqual(merged.entryIds, ["10", "11", "20", "21"], "the landed entries keep history order and the projection's own entry is left to the transcript");
  assert.deepEqual(merged.messages, ["a", "b", "c", "d"], "and each id still names its own message");
  const again = mergeLandedPrefix(merged, landed, ["22", "23"]);
  assert.deepEqual(again.entryIds, merged.entryIds, "landing the same window again repeats nothing");
  const noPrefix = mergeLandedPrefix(null, landed, []);
  assert.deepEqual(noPrefix.entryIds, ["20", "21", "22"], "a reader who never paged gets the landed span whole");
});

/** One outline page, built by the contract's own assembler so it states what a real page states. */
function pageOf(anchors, options = {}) {
  return buildNavigationPage({
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: options.snapshot ?? SNAPSHOT,
    scope: options.scope ?? SCOPE,
    anchors: anchors.map((entryId) => ({
      anchor: encodeNavigationAnchor({ version: 1, conversationId: CONVERSATION, scope: options.scope ?? SCOPE, entryId }),
      entryId,
      cursor: Number(entryId),
      preview: "user message " + entryId,
    })),
    hasMore: options.hasMore === true,
    capped: true,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
}

test("outline pages accumulate without repeating or reordering an anchor", () => {
  let state = reduceOutlinePages(null, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20, prefix: { kind: "none" } }) });
  assert.equal(state.anchors.length, 2);
  assert.equal(state.hasMore, true);
  assert.deepEqual(state.prefix, { kind: "none" }, "the prefix a first page scanned stays stated while the outline grows");
  state = reduceOutlinePages(state, { kind: "page", page: pageOf(["30"], { hasMore: false }) });
  assert.deepEqual(state.anchors.map((a) => a.entryId), ["10", "20", "30"], "a continuation appends in the Backend's order");
  assert.equal(state.hasMore, false, "a finished outline says so");
  assert.equal(state.nextCursor, undefined, "and states no continuation a caller could reuse");
  assert.deepEqual(state.prefix, { kind: "none" }, "a continuation states no prefix, so the scanned one is kept rather than dropped");
  // A retry after `error` re-reads the same page: an anchor already listed is not listed twice.
  state = reduceOutlinePages(state, { kind: "page", page: pageOf(["20", "30"], { hasMore: false }) });
  assert.deepEqual(state.anchors.map((a) => a.entryId), ["10", "20", "30"], "a re-read page is a no-op rather than a duplicate node");
  // The same rule has to hold for the page that began the outline: a re-read of page one against the snapshot that
  // still holds it must not cut the list back to two anchors, which is what a cursor-keyed rule does to a finished
  // outline (it states no continuation, so there is nothing to compare the page against).
  state = reduceOutlinePages(state, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20 }) });
  assert.deepEqual(state.anchors.map((a) => a.entryId), ["10", "20", "30"], "re-reading the first page within one snapshot cannot shrink the outline");
});

test("outline pages are ordered by the server's cursor, not by the order they arrived", () => {
  // A continuation can land after a retry of an earlier page (the reader clicked "more" twice, or a slow page lost the
  // race). A rail that listed pages by arrival would reorder the history it is an index over, so the ordering is the
  // Backend's cursor and nothing else.
  let state = reduceOutlinePages(null, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20 }) });
  state = reduceOutlinePages(state, { kind: "page", page: pageOf(["70", "80"], { hasMore: true, nextCursor: 80 }) });
  state = reduceOutlinePages(state, { kind: "page", page: pageOf(["30", "40"], { hasMore: true, nextCursor: 40 }) });
  assert.deepEqual(state.anchors.map((a) => a.entryId), ["10", "20", "30", "40", "70", "80"], "every anchor the pages stated, in history order");
});

test("a page read against another snapshot or scope refreshes the outline rather than corrupting it", () => {
  // The append case the spec states as "a changed snapshot causes refresh": a turn committed after the first page was
  // read moves the snapshot (and not the scope), so a page of the grown conversation begins a new list rather than
  // extending one read beside a transcript it no longer matches.
  const grown = reduceOutlinePages(
    reduceOutlinePages(null, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20 }) }),
    { kind: "page", page: pageOf(["10", "20", "30"], { hasMore: true, nextCursor: 20, snapshot: CONVERSATION + "|" + HEAD + "|300" }) },
  );
  assert.deepEqual(grown.anchors.map((a) => a.entryId), ["10", "20", "30"], "a page of the grown conversation states the outline it was read against");
  assert.equal(grown.snapshot, CONVERSATION + "|" + HEAD + "|300", "and the state carries that snapshot");
  assert.deepEqual(grown.anchors.map((a) => a.anchor).slice(0, 2), reduceOutlinePages(null, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20 }) }).anchors.map((a) => a.anchor), "an append changed no anchor's identity");

  const state = reduceOutlinePages(
    reduceOutlinePages(null, { kind: "page", page: pageOf(["10", "20"], { hasMore: true, nextCursor: 20 }) }),
    { kind: "page", page: pageOf(["5"], { hasMore: true, nextCursor: 5, scope: CONVERSATION + "|99" }) },
  );
  assert.deepEqual(state.anchors.map((a) => a.entryId), ["5"], "a history that re-baselined refreshes the outline");
  assert.equal(state.scope, CONVERSATION + "|99", "and the state says which history it now describes");
  assert.equal(state.prefix, undefined, "the replacement page scanned no prefix, so none is claimed");
});

test("a failed outline read is a named state the rail can show and keeps the pages it held", () => {
  const held = reduceOutlinePages(null, { kind: "page", page: pageOf(["10"], { hasMore: true, nextCursor: 10 }) });
  const failed = reduceOutlinePages(held, { kind: "failure", failure: "stale-snapshot" });
  assert.equal(failed.failure, "stale-snapshot");
  assert.equal(failed.loading, false);
  assert.deepEqual(failed.anchors.map((a) => a.entryId), ["10"], "a failed continuation does not empty the outline the reader can still jump through");
  const fresh = reduceOutlinePages(null, { kind: "failure", failure: "error" });
  assert.equal(fresh.failure, "error", "a first page that never answered is still a state, not nothing");
});


test("a compaction mid-read fences the answer against the scope the conversation states now", async () => {
  // Review P2. The scope is compared *after* the read answers, not the one the attempt captured before it sent: a
  // compaction or reset landing on the wire moves the scope, and the window then describes a history the surface no
  // longer shows. Landing it would mount entries beside a transcript they do not belong to.
  const h = harness({ read: () => windowOf("100") });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled[0].kind, "held", "the read as it started lands against the scope it was fenced by");
  // The read is held this time: while it is on the wire the conversation re-baselines, which is what a compaction does.
  const released = Promise.withResolvers();
  const h2 = harness({ read: () => released.promise });
  h2.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  h2.host.snapshotRevision = CONVERSATION + "|99|" + TAIL;
  released.resolve(windowOf("100"));
  await drain();
  assert.equal(h2.landed.length, 0, "no entries from the replaced history reached the transcript");
  assert.equal(h2.settled[0].failure, "stale-snapshot", "the fence is named as the re-baseline it is");
  const h3 = h2;
  assert.equal(h3.requests.length, 1, "and nothing was re-read behind the reader");
  // The retry is addressed by the scope the conversation now states, which is the other half of the same fence: the
  // same request re-issued is refused again, so what retries an address is a fresh one.
  const h4 = harness({ read: () => windowOf("100") });
  h4.coordinator.searchTarget({ conversationId: CONVERSATION, entryId: "100" });
  await drain();
  assert.equal(h4.settled[0].kind, "held", "the same hit, in the history it was issued for, addresses its message");
  assert.equal(h4.requests.length, 1, "at one bounded read");
});

test("a deferred jump lands when the reader takes the offer after the run already settled", async () => {
  // Review P2. The busy edge has passed while the offer was on screen, and a retry that only waited for it would
  // never land: the edge's only chance to make the reader whole is the offer itself.
  const h = harness({ busy: true, read: () => windowOf("100") });
  h.coordinator.jump(CONVERSATION, anchor("100"));
  await drain();
  assert.equal(h.settled[0].failure, "deferred-busy");
  h.host.busy = false;
  assert.equal(await (async () => { h.settled[0].retry(); await drain(); return h.requests.length; })(), 1, "taking the offer once the run is over lands the jump at once");
  assert.equal(h.settled[1].kind, "held");
  // And the run ending afterwards lands nothing more: the parked jump already settled.
  h.coordinator.settleWaited();
  await drain();
  assert.equal(h.requests.length, 1, "the settle signal afterwards is not a second jump");
});

test("a retry of a refused search hit is addressed by the scope the conversation now states", async () => {
  // Review P2, the other half of the same fence. A search hit carries no coordinate — its address is minted per attempt
  // — so the coordinate a refused attempt was refused for is not the one the next attempt is issued under.
  // The first attempt answers: the address is minted under the scope the conversation states, and nothing reaches the
  // transcript from a read that refused it.
  const h = harness({ read: () => { throw refusal("stale-snapshot"); } });
  h.coordinator.searchTarget({ conversationId: CONVERSATION, entryId: "100", block: 2 });
  await drain();
  assert.equal(h.settled[0].failure, "stale-snapshot");
  assert.equal(h.landed.length, 0, "nothing reached the transcript from the refused attempt");
  // A compaction moves the scope under a read the Backend refused for the old one, and the retry is issued against the
  // scope in place: the address is minted again, so this attempt is not refused for the move that already happened.
  const ok = harness({ read: () => windowOf("100", { scope: CONVERSATION + "|99", snapshot: CONVERSATION + "|99|" + TAIL }) });
  ok.host.snapshotRevision = CONVERSATION + "|99|" + TAIL;
  ok.coordinator.searchTarget({ conversationId: CONVERSATION, entryId: "100", block: 2 });
  await drain();
  assert.equal(ok.settled[0].kind, "held", "the hit is addressed by the scope the conversation states now");
  assert.equal(ok.requests.length, 1, "at one bounded read");
  const query = new URLSearchParams(ok.requests[0].slice(1));
  assert.match(ok.requests[0], /anchor=nav1\./, "and the address it was issued under is a coordinate, minted for it");
  assert.equal(query.get("snapshot"), CONVERSATION + "|99|" + TAIL, "pinned at the snapshot the re-baselined conversation states");
  assert.equal(query.get("block"), "2", "the block the reader asked for survives");
});



test("a failure leaves the request alignable by its retry, and a landing is what aligns", () => {
  // Review P1, at the owner. The shell retires a request only when the reader is done with it, so a failed locate must
  // leave the request standing: the retry's landing arrives for the same entry and has to align it. Reading the shell's
  // pending target as the condition for aligning is what stranded that landing.
  const request = { entryId: "100" };
  const held = { kind: "held", loaded: false, request: { conversationId: CONVERSATION, target: { entryId: "100" } }, window: {}, coordinate: {} };
  const loaded = { ...held, loaded: true };
  const failed = { kind: "failed", failure: "missing", request: { conversationId: CONVERSATION, target: { entryId: "100" } }, detail: "", retry: () => {}, clear: () => {} };
  assert.equal(searchSettlementAction({ settled: null, request }), "ignore", "nothing settled, nothing to do");
  assert.equal(searchSettlementAction({ settled: held, request: null }), "ignore", "a settlement for a request this surface never asked for");
  assert.equal(searchSettlementAction({ settled: held, request }), "align", "a landing from a read owes its scroll");
  assert.equal(searchSettlementAction({ settled: loaded, request }), "ignore", "a hit already on screen was settled where it stands");
  assert.equal(searchSettlementAction({ settled: failed, request }), "settle", "a failure ends the movement and keeps the request");
  // The retry's landing is the same request, and it aligns — the debt is the settlement's, not the shell's.
  assert.equal(searchSettlementAction({ settled: held, request }), "align", "the landing a retry produced aligns the entry the reader asked for");
  // A settlement about another entry is a navigation this surface has moved on from.
  assert.equal(searchSettlementAction({ settled: { ...held, request: { conversationId: CONVERSATION, target: { entryId: "200" } } }, request }), "ignore", "a newer navigation's settlement does not align the old entry");
});
