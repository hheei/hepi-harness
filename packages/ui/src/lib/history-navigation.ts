import {
  checkNavigationCoordinate,
  decodeNavigationAnchor,
  encodeNavigationAnchor,
  NAVIGATION_COORDINATE_VERSION,
  type NavigationAnchor,
  type NavigationCoordinate,
  type NavigationInvalidReason,
  type NavigationOutlinePage,
  type NavigationTargetWindow,
} from "@hepi/protocol/navigation";
import { errorText } from "@hepi/protocol/error-text";

/**
 * The navigation state and jump coordinator (history-navigation ticket 03).
 *
 * One target read, one settlement, seven named outcomes — for a rail jump and for a deep search hit alike, through the
 * same owner (spec decision 8: a search hit "resolves through the same bounded target coordinator as a rail jump").
 *
 * The transcript's owners are kept, and this module asks them for the two things it cannot answer on its own:
 *
 * - **the loaded window** stays the session projection's, with `decidePrefix` the one rule that says what the reader's
 *   paged prefix becomes when that window moves (spec decision 6: merged through the existing history owner). A landed
 *   target window therefore enters as history the projection does not carry — the same kind of statement a sentinel
 *   page is — and no second transcript accumulates here.
 * - **the history identity** is the conversation's own token (`snapshotRevision`), never a copy kept beside it: an
 *   append moves that token's entry fact and leaves its scope alone, the rule the outline contract is built on, so a
 *   held coordinate survives a turn arriving and is retired only by a compaction or a reset.
 *
 * What is deliberately **not** here is scroll or DOM work. The coordinator lands a target and says so; the surface that
 * owns the viewport performs its presentation scroll once the target's DOM exists. Nothing in here reads a scroll
 * position, so an animation cannot settle a landing, cancel a read, or request a node it passed over (spec decision 7)
 * — and no branch loops over pages, which is the sequential hydration this ticket replaces.
 *
 * The rail itself is ticket 04: {@link reduceOutlinePages} owns the paged outline **state** this ticket asks for, and a
 * rail reads that state and calls {@link NavigationCoordinator.jump} with an anchor it holds.
 */

/** How a landing was addressed: by a rail anchor's coordinate, or by a search hit's entry and block. */
export type NavigationRequest = {
  readonly conversationId: string;
  readonly target: { readonly entryId: string; readonly anchor?: string; readonly block?: number };
};

/**
 * Why a landing did not arrive.
 *
 * `missing`, `stale-snapshot`, `wrong-scope` and `malformed` are the navigation contract's own reasons: two of them
 * answered by this client before a request is issued (an address the contract cannot read, a scope the conversation no
 * longer states), the rest by the Backend's fence. `error` is everything the read could not answer at all — a transport
 * failure, a status the surface has no word for (the Backend's shared `frame_too_large` for a target no window can
 * carry is the shipped example), or an answer from an identity this conversation does not state. `cancelled` and
 * `deferred-busy` are this client's: the jump stopped belonging to the conversation on screen, or a run was in flight
 * and the reader had not asked to land afterwards.
 *
 * A `held` landing requires the window to carry its own target, so an answer that cannot mount the message the reader
 * jumped for is named rather than landed beside it.
 */
export type NavigationFailure =
  | "missing"
  | "stale-snapshot"
  | "wrong-scope"
  | "malformed"
  | "cancelled"
  | "deferred-busy"
  | "error";

/** Every outcome name a surface must render, each with its own word in every locale. */
export const NAVIGATION_OUTCOMES: readonly NavigationFailure[] = [
  "missing",
  "stale-snapshot",
  "wrong-scope",
  "malformed",
  "cancelled",
  "deferred-busy",
  "error",
];

/**
 * One settlement of one request.
 *
 * `held` is the only shape that says the reader was landed. Every other shape carries the reason, the Backend's or the
 * client's own sentence beside it, and the way back: `retry` re-issues the same request — one for each outcome, a
 * `deferred-busy` one being "land once the run ends" — and `clear` retires the outcome the surface is showing. A
 * landing that needed no read still answers `held` (`loaded: true`, no entries), because what the surface asks is
 * whether it owes a scroll, not whether a response arrived.
 */
export type NavigationOutcome =
  | {
      readonly kind: "held";
      readonly request: NavigationRequest;
      readonly window: NavigationTargetWindow;
      readonly coordinate: NavigationCoordinate;
      /** True when the conversation's history already carried the target, so no window was read. */
      readonly loaded: boolean;
    }
  | {
      readonly kind: "failed";
      readonly request: NavigationRequest;
      readonly failure: NavigationFailure;
      readonly detail: string;
      readonly retry: () => void;
      readonly clear: () => void;
    };

/** What one landed window brings to the history owner. Its entries are the Backend's own projected shape. */
export type LandedWindow = {
  readonly conversationId: string;
  /** The landed entries in native order, oldest first — the transcript's own shape, ids included. */
  readonly entries: readonly { readonly id: string; readonly message?: unknown }[];
  readonly snapshot: string;
  readonly scope: string;
  /** Committed history lies older than what this window reached, in the snapshot it was read against. */
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
};

/** What the coordinator may ask of the conversation it is mounted inside. */
export type NavigationHost = {
  /** The conversation the surface shows right now. Every completion is fenced by it: a jump never lands on another. */
  readonly conversationId: string;
  /** The conversation's own history-revision token (`conversation|head|tail`), or null before its first statement. */
  readonly snapshotRevision: string | null;
  /** Whether a native run is in flight. A jump while a run is active is deferred and named, not guessed at. */
  readonly busy: boolean;
  /** Every entry id the conversation's history now carries — projection window and paged prefix alike. */
  readonly activeEntryIds: readonly string[];
  /** Hand one bounded target window to the history owner. Called exactly once per request that reads. */
  landWindow(window: LandedWindow): void;
  /** Render the outcome. Every request settles exactly once, including a read the surface no longer wants. */
  onSettled(outcome: NavigationOutcome): void;
  /** The surface's own lifetime: an unmount aborts it, and a switch is fenced by the conversation above. */
  readonly signal: AbortSignal;
  readTargetWindow(input: { conversationId: string; anchor: string; query: string; signal: AbortSignal }): Promise<NavigationTargetWindow>;
};

/**
 * The entry a navigation currently owns the viewport for, or null when nothing does.
 *
 * "In flight" spans the request and the presentation scroll that follows a landing: from the moment the shell hands a
 * target over until that target is on screen, retired, or answered with a named outcome. The scroll sentinel reads it
 * to stay silent for exactly that span, so a window moving toward a deep target cannot page every entry between here
 * and there in behind the reader — spec decision 7's "intermediate scroll events load nothing", expressed as one value
 * rather than as a rule each caller interprets.
 *
 * Two shapes hold the viewport, and they are deliberately the only two, because a gate that outlived its navigation
 * would silence the reader's own paging for the rest of the session:
 *  - **being scrolled to** — the target is mounted and the surface is aligning it (`pending`);
 *  - **a read owed** — the shell named an entry the transcript does not carry and no answer has been given for that
 *    entry yet, or the answer is a window that was just mounted and whose scroll has not been reported finished. A
 *    `loaded` short-circuit and every failure close the span, and both shapes need the shell to still hold a target, so
 *    a landing the surface has stopped asking about gates nothing.
 */
export function navigationHoldsViewport(input: {
  /** The entry the surface is scrolling to, or none. */
  readonly pending: { readonly entryId: string } | null;
  /** The outcome this navigation settled to, or none. */
  readonly outcome: NavigationOutcome | null;
  /** The target the shell handed over, or none. */
  readonly request: { readonly entryId: string } | null;
  /** Every entry id the transcript carries right now. */
  readonly entryIds: readonly string[];
}): { readonly entryId: string } | null {
  if (input.pending !== null) return input.pending;
  if (input.request === null) return null;
  // An answer already given for *this* entry. A landing still owes its scroll — the entries reach the transcript in one
  // commit and the settlement starts on the next render, so this is the span between them — while a named failure or an
  // already-mounted target has nothing moving to gate.
  if (input.outcome !== null && input.outcome.request.target.entryId === input.request.entryId) {
    return input.outcome.kind === "held" && !input.outcome.loaded ? input.request : null;
  }
  return input.entryIds.includes(input.request.entryId) ? null : input.request;
}

/**
 * What one settlement asks the surface that requested it to do.
 *
 * The shell's pending target is what *retires* a navigation, not what creates the alignment: a landing whose request the
 * shell has already retired — because a failure was shown and the reader may still retry — is entries the transcript
 * carries and a scroll it still owes. Reading the pending target as the condition for aligning is what left a retry's
 * landing unmounted and the viewport gate closed; so the alignment is decided by the request the settlement answers, and
 * only a *different* entry replaces it.
 */
export function searchSettlementAction(input: {
  /** The outcome the coordinator settled, or none yet. */
  readonly settled: NavigationOutcome | null;
  /** The request the surface asked for: the shell's target while it is pending, and the one it last handed over. */
  readonly request: { readonly entryId: string } | null;
}): "align" | "settle" | "ignore" {
  const settled = input.settled;
  if (settled === null || input.request === null) return "ignore";
  if (settled.request.target.entryId !== input.request.entryId) return "ignore";
  // A landing from a read owes the presentation scroll; one that needed no read was settled where it stands. Every
  // failure ends the movement, and the request stays the reader's — a retry answers it again.
  if (settled.kind !== "held") return "settle";
  return settled.loaded ? "ignore" : "align";
}

/** The scope part of the conversation's own snapshot token: that token with its entry fact dropped. */
export function scopeOfSnapshot(snapshotRevision: string): string {
  const at = snapshotRevision.lastIndexOf("|");
  return at < 0 ? snapshotRevision : snapshotRevision.slice(0, at);
}

/** The navigation reason one thrown answer states, if it states one. */
function statedReason(error: unknown): { readonly code: NavigationFailure; readonly message: string } | null {
  if (!(error instanceof Error)) return null;
  const carried = error as Error & { code?: unknown; body?: { code?: unknown } };
  const bodyCode = typeof carried.body === "object" && carried.body !== null ? carried.body.code : undefined;
  const code = typeof bodyCode === "string" ? bodyCode : typeof carried.code === "string" ? carried.code : null;
  if (code === null) return null;
  // The contract's own reason names are the outcome names, with one narrowing: `version_mismatch` is a coordinate this
  // deployment never issued, which is exactly what the surface's `malformed` sentence says, and the Backend's own
  // sentence stays in `detail`. `frame_too_large` and any other code deliberately falls through to `error` — the
  // surface has no word for a size the whole backend answers, and inventing one here would be a second vocabulary.
  if (code === "version_mismatch") return { code: "malformed", message: error.message };
  return (NAVIGATION_OUTCOMES as readonly string[]).includes(code)
    ? { code: code as NavigationFailure, message: error.message }
    : null;
}

/**
 * The outcome name one thrown answer states, or `error` when it states none the surface has a word for.
 *
 * Both reads of this contract — the outline's pages and one target window — are refused by the same codes, so the
 * mapping is stated once: a caller that catches on its own cannot name a refusal differently from the coordinator, and
 * a code the surface has no sentence for is the read's failure rather than a name invented for it.
 */
export function navigationFailureOf(error: unknown): NavigationFailure {
  const reason = statedReason(error);
  return reason === null ? "error" : reason.code;
}

/**
 * The outcome name one reason this contract's own coordinate check states, narrowed by the same rule {@link
 * navigationFailureOf} applies to a thrown answer, so a refusal read here and a refusal read off the wire cannot be
 * given two different names.
 */
function clientReason(code: NavigationInvalidReason): NavigationFailure {
  return code === "version_mismatch" ? "malformed" : code;
}

/**
 * The coordinator of one mounted surface: its held target, its outcome, its one read at a time.
 *
 * One instance per surface, and one host object that reads the surface through its current values, so a read in flight
 * is fenced by the conversation on screen *when it answers* rather than by the props it started under — that is what
 * makes a switch mid-read the named `cancelled` instead of a landing on the wrong conversation.
 *
 * Two abandonments are told apart, because they render apart: a jump the reader replaced is dropped without a report
 * (the surface is showing the landing the reader actually wants, and a late `cancelled` over it would be the wrong
 * state), while one retired by a conversation switch is reported — otherwise the reader's request would end as the
 * silent no-op this ticket exists to remove.
 */
export class NavigationCoordinator {
  #host: NavigationHost;
  #generation = 0;
  #held: NavigationRequest | null = null;
  /**
   * The jump a `deferred-busy` parked, and whether the reader took the offer to land once the run ends.
   *
   * The two are held apart because they are two different states of the surface: an untouched deferral stays named on
   * screen and lands nothing, while an accepted one waits for the run's own end. A run ending is never by itself a
   * reason to re-issue a jump the reader abandoned, replaced or dismissed.
   */
  #waited: { readonly request: NavigationRequest; readonly anchor: string | null; accepted: boolean } | null = null;

  constructor(host: NavigationHost) {
    this.#host = host;
  }

  /** The request this controller last landed, or is landing. */
  heldRequest(): NavigationRequest | null {
    return this.#held;
  }

  /** Retire the navigation: a running read has nowhere to land, and the outcome comes off screen. */
  clear(): void {
    this.#generation += 1;
    this.#held = null;
    this.#waited = null;
  }

  /** One rail jump, addressed by the coordinate an outline page issued. */
  jump(conversationId: string, anchor: string): void {
    const decoded = decodeNavigationAnchor(anchor);
    void this.#settle(conversationId, { entryId: decoded.ok ? decoded.coordinate.entryId : "", anchor }, anchor);
  }

  /**
   * One deep search result, through this same coordinator rather than a locate loop of its own.
   *
   * A hit names an entry and a block rather than a coordinate, so its address is minted over the scope the
   * conversation states — and the Backend re-checks that address against its own history. Opacity is not the authority;
   * the Backend's membership and scope check is, which is what lets a search hit be addressed at all.
   */
  searchTarget(input: { conversationId: string; entryId: string; block?: number }): void {
    // No coordinate is carried in: this address is minted when the request is issued, which is what lets a retry after
    // a re-baseline address the same message in the history the conversation now states instead of re-offering the
    // coordinate that was just refused.
    void this.#settle(input.conversationId, input, null);
  }

  /**
   * Land the jump a `deferred-busy` parked, once the run has settled — and only if the reader took that offer.
   *
   * This is the surface's busy-edge signal, not a timer: a run that was never asked to make way for a jump leaves the
   * named outcome standing.
   */
  settleWaited(): void {
    const waited = this.#waited;
    if (waited === null || !waited.accepted || this.#host.busy) return;
    this.#waited = null;
    void this.#settle(waited.request.conversationId, waited.request.target, waited.anchor);
  }

  /**
   * One request, one settlement, at most one read.
   *
   * The order is the behaviour: fence the addressing, ask whether the held history already carries the target, respect
   * a run in flight, read one bounded window, hand it to the owner, then name the result. Nothing between those steps
   * reads a scroll position, and no branch issues a second read because history moved.
   */
  async #settle(conversationId: string, target: NavigationRequest["target"], carried: string | null): Promise<void> {
    const host = this.#host;
    const request: NavigationRequest = { conversationId, target };
    const generation = ++this.#generation;
    this.#held = request;
    this.#waited = null;
    // The address this request is issued under: the coordinate a rail page carried, or one minted here for a search
    // hit — minted per attempt, so a retry is addressed by the scope the conversation states at that moment rather than
    // by the one the refused attempt used.
    const anchor = carried ?? (host.conversationId === conversationId && host.snapshotRevision !== null
      ? encodeNavigationAnchor({
          version: NAVIGATION_COORDINATE_VERSION,
          conversationId,
          scope: scopeOfSnapshot(host.snapshotRevision),
          entryId: target.entryId,
        })
      : "");
    // A retry re-issues the same request, with one exception: a coordinate the conversation has re-baselined is not
    // re-issued. The entry is the identity and the scope is the history, so a `stale-snapshot` retry mints a fresh
    // coordinate over the scope the conversation states by then — otherwise the reader's one way out of that failure
    // would state the same refusal forever, which is the loop review 160 measured.
    let retryAnchor: string | null = carried;
    const retry = () => { void this.#settle(conversationId, target, retryAnchor); };
    const fail = (failure: NavigationFailure, detail: string) => {
      if (generation !== this.#generation) return;
      if (failure === "stale-snapshot") retryAnchor = null;
      this.#report({ kind: "failed", request, failure, detail, retry, clear: () => this.clear() });
    };
    const scope = host.snapshotRevision === null ? null : scopeOfSnapshot(host.snapshotRevision);

    // An address this contract never issued names nothing, and is refused before any history is consulted — the rule
    // the route applies too, applied here so a surface does not spend a read on it.
    const decoded = decodeNavigationAnchor(anchor);
    if (!decoded.ok) {
      fail(clientReason(decoded.code), decoded.error);
      return;
    }
    // The conversation's fence, in the contract's own words: a coordinate of another conversation is `wrong-scope`, one
    // whose head marker moved is `stale-snapshot`. Read off the conversation's own token, so an append — which moves
    // the entry fact and not the scope — cannot retire a jump the reader is entitled to land.
    if (scope !== null) {
      const refusal = checkNavigationCoordinate(decoded.coordinate, { conversationId: host.conversationId, scope });
      if (refusal !== undefined) {
        fail(clientReason(refusal.code), refusal.error);
        return;
      }
    }

    // A target the conversation's history already carries needs no read at all. That is the difference between this
    // coordinator and the sequential page walk it replaces: the entry is looked for in what is held, not in what the
    // next page might contain.
    if (target.entryId !== "" && host.activeEntryIds.includes(target.entryId)) {
      this.#report({ kind: "held", request, loaded: true, coordinate: decoded.coordinate, window: absentWindow(conversationId, target.entryId) });
      return;
    }

    // A run in flight is no reason to refuse a reader who asked to land afterwards, and no reason to read history
    // behind the transcript while its own stream settles a turn: the jump is parked, named, and lands if the reader
    // takes the offer — which is what the outcome's `retry` is for this reason and for no other.
    if (host.busy) {
      const parked = { request, anchor, accepted: false };
      this.#waited = parked;
      if (generation !== this.#generation) return;
      this.#report({
        kind: "failed",
        request,
        failure: "deferred-busy",
        detail: "the conversation is mid-run; land once it settles",
        // The offer is taken, and the run may already be over: the busy edge this surface would otherwise wait for has
        // been consumed, so the settlement is attempted here and the edge's own call is a no-op if the run is still on.
        retry: () => { parked.accepted = true; this.settleWaited(); },
        clear: () => this.clear(),
      });
      return;
    }

    const query = "?" + new URLSearchParams({
      anchor,
      ...(host.snapshotRevision === null ? {} : { snapshot: host.snapshotRevision }),
      ...(target.block === undefined ? {} : { entry: target.entryId, block: String(target.block) }),
    }).toString();

    let window: NavigationTargetWindow;
    try {
      window = await this.#host.readTargetWindow({ conversationId, anchor, query, signal: this.#host.signal });
    } catch (error) {
      if (generation !== this.#generation) return;
      if (this.#host.conversationId !== conversationId || this.#host.signal.aborted) {
        fail("cancelled", "this navigation belongs to a conversation the surface no longer shows");
        return;
      }
      const reason = statedReason(error);
      // A reason the surface has a word for is reported as that word; anything else is the read's failure, with the
      // answer's own sentence kept, because a refusal is a fact a caller shows rather than an empty failure.
      if (reason !== null) fail(reason.code, reason.message);
      else fail("error", errorText(error));
      return;
    }
    if (generation !== this.#generation) return;
    // The answer arrived after the reader moved on: nothing is published and the reader is not moved by a read they
    // stopped asking for.
    if (this.#host.conversationId !== conversationId || this.#host.signal.aborted) {
      fail("cancelled", "this navigation belongs to a conversation the surface no longer shows");
      return;
    }
    // The identity is compared against the conversation *now*, not against the scope this attempt started under: a
    // compaction or reset that landed while the read was on the wire moves the scope, and the answer then describes a
    // history the surface no longer shows. Landing it would mount entries beside a transcript they do not belong to, so
    // it is named as the re-baseline it is — and a retry is addressed by the scope the conversation states by then.
    const landedScope = this.#host.snapshotRevision === null ? null : scopeOfSnapshot(this.#host.snapshotRevision);
    if (window.conversationId !== conversationId || (landedScope !== null && window.scope !== landedScope)) {
      fail("stale-snapshot", "this window was read against a history the conversation has since replaced");
      return;
    }
    // Landing beside the message the reader jumped for is the failure the spec forbids, so the Backend's own statement
    // that its window does not carry the target is named rather than presented as a success.
    if (!window.target.present) {
      fail("missing", "this history holds no mountable entry for that target");
      return;
    }
    // The window goes to the history owner before the landing is announced, so a surface that reads `held` sees the
    // entries it must mount rather than a promise that they are coming.
    this.#host.landWindow({
      conversationId,
      entries: window.entries,
      snapshot: window.snapshot,
      scope: window.scope,
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    });
    this.#report({ kind: "held", request, loaded: false, window, coordinate: decoded.coordinate });
  }

  #report(outcome: NavigationOutcome): void {
    if (outcome.kind === "held") this.#waited = null;
    this.#host.onSettled(outcome);
  }
}

/**
 * A window for a target that needed no read.
 *
 * It carries no entries on purpose: `held` is the settlement, and the transcript the conversation states is already the
 * history the surface shows. A caller must not be able to mistake it for a page it may publish, which is why the shape
 * is stated rather than left undefined.
 */
function absentWindow(conversationId: string, entryId: string): NavigationTargetWindow {
  return {
    protocol: "hepi.v1",
    conversationId,
    snapshot: "",
    scope: "",
    order: "oldest-first",
    target: { entryId, anchor: "", present: true, blocks: [] },
    capped: true,
    trimmed: false,
    entries: [],
    hasOlder: false,
    hasNewer: false,
    bytes: 0,
  };
}

/** The surface's word for one outcome, looked up by its own name rather than mapped onto a neighbour's. */
export const navigationOutcomeKey = (failure: NavigationFailure): string => "navigation.outcome." + failure;

/**
 * Merge one landed window into the reader's paged prefix, in transcript order.
 *
 * A landed window is a bounded span of committed history around a target, and the prefix owner holds the pages the
 * reader reached before it. The two are not the same shape: the prefix must stay ordered oldest-first (that is what the
 * prepend anchoring and the sentinel's cursor read), must not carry an entry the projection's own window is
 * authoritative for, and must not list one entry twice — which is the same idempotence rule `decidePrefix` applies to
 * an evicted window.
 *
 * So the merge is an ordered union by the ids the Backend itself issued, with the projection's entries dropped: they
 * are the transcript's, and keeping them here would make the prefix stop applying and lose every page it holds.
 */
export function mergeLandedPrefix<T>(
  held: { readonly entryIds: readonly string[]; readonly messages: readonly T[] } | null,
  landed: { readonly entryIds: readonly string[]; readonly messages: readonly T[] },
  windowEntryIds: readonly string[],
): { readonly entryIds: string[]; readonly messages: T[] } {
  const authoritative = new Set(windowEntryIds);
  const pairs = [...(held?.entryIds ?? []).map((id, index) => [id, held!.messages[index]] as const),
    ...landed.entryIds.map((id, index) => [id, landed.messages[index]] as const)]
    .filter(([id, message]) => !authoritative.has(id) && message !== undefined);
  const unique = new Map<string, T>();
  for (const [id, message] of pairs) if (!unique.has(id)) unique.set(id, message);
  const sorted = [...unique.keys()].sort((left, right) => Number(left) - Number(right));
  return { entryIds: sorted, messages: sorted.map((id) => unique.get(id)!) };
}

/**
 * The paged outline as one surface holds it.
 *
 * `anchors` are what has actually been read, in the order the Backend answered; `nextCursor` and `hasMore` are that
 * page's own claim, so a finished outline cannot be paged further and nothing is inferred from an anchor count.
 * `conversationId` and `scope` say what the list is *for* — an outline is only comparable with the history it was read
 * from — and `prefix` is the Outline Prefix only a first page can state.
 */
export type NavigationOutline = {
  readonly conversationId: string;
  readonly snapshot: string;
  readonly scope: string;
  readonly anchors: readonly NavigationAnchor[];
  readonly hasMore: boolean;
  readonly nextCursor?: number;
  readonly capped: boolean;
  readonly prefix?: NavigationOutlinePage["prefix"];
  readonly loading: boolean;
  readonly failure: NavigationFailure | null;
};

/** What one outline event changes. */
export type NavigationOutlineChange =
  | { readonly kind: "loading" }
  | { readonly kind: "page"; readonly page: NavigationOutlinePage }
  | { readonly kind: "failure"; readonly failure: NavigationFailure };

/**
 * Accumulate one outline page into the state a surface holds.
 *
 * The rule exists because an outline is a long-lived list over a growing conversation, and the two ways it can be wrong
 * are the two the spec names: an anchor repeated or reordered when a page arrives, and a page of one history pasted
 * onto another.
 *
 *  - a page read against the conversation, the snapshot **and** the scope the state already holds **appends**, because
 *    ticket 01's rule is that a re-read within one history states the same anchors in the same order: such a page can
 *    only add anchors, and one that carried the tail of the list again would otherwise *shrink* the outline down to
 *    that page — the failure a continuation-keyed rule has, since a finished outline states no continuation at all;
 *  - a page read against a conversation, a snapshot or a scope the state does not hold **replaces** it, which is how a
 *    re-baselined history refreshes an outline instead of corrupting it;
 *  - an entry id already listed is never listed twice, so a re-read of the same page (a retry after `error`, the
 *    commonest way a second page arrives) is a no-op rather than a duplicate node, and the merged list is ordered by
 *    the cursor the Backend stated rather than by the order two pages happened to arrive in.
 */
export function reduceOutlinePages(state: NavigationOutline | null, change: NavigationOutlineChange): NavigationOutline | null {
  if (change.kind === "loading") return state === null ? null : { ...state, loading: true };
  if (change.kind === "failure") {
    if (state === null) return { conversationId: "", snapshot: "", scope: "", anchors: [], hasMore: false, capped: true, loading: false, failure: change.failure };
    return { ...state, loading: false, failure: change.failure };
  }
  const page = change.page;
  const continuing = state !== null
    && state.conversationId === page.conversationId
    // Both halves of the history identity decide comparability. `snapshot` moves when a turn is committed, which is
    // exactly when one outline stops describing the transcript it was read beside; `scope` moves on a reset or a
    // compaction, which retires the anchors' own addresses. A page that matches neither is a new list, not a chapter.
    && state.snapshot === page.snapshot
    && state.scope === page.scope;
  const listed = new Map(continuing ? state!.anchors.map((anchor) => [anchor.entryId, anchor]) : []);
  for (const anchor of page.anchors) if (!listed.has(anchor.entryId)) listed.set(anchor.entryId, anchor);
  // Ordered by the server's own cursor, which is the entry id: a continuation and a retry can arrive in either order,
  // and a rail that listed them by arrival would reorder the history it is an index over.
  const anchors = [...listed.values()].sort((left, right) => left.cursor - right.cursor);
  const prefix = page.prefix !== undefined
    ? { prefix: page.prefix }
    : continuing && state!.prefix !== undefined ? { prefix: state!.prefix } : {};
  return {
    conversationId: page.conversationId,
    snapshot: page.snapshot,
    scope: page.scope,
    anchors,
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    capped: page.capped,
    ...prefix,
    loading: false,
    failure: null,
  };
}
