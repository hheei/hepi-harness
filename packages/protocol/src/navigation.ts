/**
 * The full-history navigation contract: one conversation's committed user messages as a paged outline, and the
 * coordinate a later bounded target read is addressed by.
 *
 * The Backend owns every fact here; a client round-trips them and derives none. This module holds only what two sides
 * must agree on byte for byte — the wire shape, the bounds, the coordinate's encoding and the named outcomes — and no
 * history logic: which entries exist, their order and the snapshot's identity stay the Backend's, read through the
 * runtime's own fork-aware entry scan.
 *
 * Navigation reads the conversation's **fork-aware committed history**, never its active window. Compaction moves the
 * active context behind a head marker, and a fork inherits its parent's entries; neither removes a committed user
 * message, so neither removes an anchor. This is the same record `GET /api/conversations/:id/read` already serves, and
 * the outline is an index over it: one entry per user message, with a short preview, and no message bodies.
 *
 * Two identities travel with a page, because they answer two different questions:
 *
 * - `snapshot` is the window's own {@link ServerSnapshot.historyRevision} token — over the newest head marker **and**
 *   the newest committed entry — so a client can compare an outline page with the transcript window it holds and see
 *   that a turn arrived, which is what extends the outline without renumbering anything.
 * - `scope` is the same token over the newest head marker **alone**. It is the identity a coordinate is stamped with,
 *   because it is the one that survives an append: an anchor's identity may not move when the conversation grows, and
 *   the required behavior says an append extends the outline rather than invalidating it. A reset or a compaction moves
 *   the head marker, and that is exactly the event the spec names for a stale outline — the committed anchors are still
 *   there, but the page a coordinate came from is no longer the page the Backend would hand out, so it is refused by
 *   name and the caller re-pages.
 */

// Type-only by design: this module declares the contract and takes no runtime dependency, so the index that
// re-exports it and the surfaces that import both cannot form an import cycle.
import type { ConversationId, ProtocolVersion, ServerEntry } from "./index.ts";

/** The default page size, when the caller names none. */
export const NAVIGATION_DEFAULT_LIMIT = 100;
/**
 * The most anchors one page may carry, whatever the caller asked for. A page is additionally measured against
 * {@link NAVIGATION_PAGE_MAX_BYTES}, because a preview is capped by bytes-per-anchor and a full page of them must not
 * be an unbounded body: one unbounded index response is forbidden, and `?limit=0` is no index at all.
 */
export const NAVIGATION_MAX_LIMIT = 200;
/** The UTF-8 budget of one built page, its own bookkeeping included. */
export const NAVIGATION_PAGE_MAX_BYTES = 64 * 1024;
/** How many UTF-8 bytes of one user message a preview may carry. */
export const NAVIGATION_PREVIEW_MAX_BYTES = 240;
/** The version of the coordinate's encoding. A mismatch is `version_mismatch`, never a guess. */
export const NAVIGATION_COORDINATE_VERSION = 1;
/** Entries fetched from the runtime per scan page. It bounds one read; the scan follows its cursor. */
export const NAVIGATION_SCAN_PAGE = 100;
/**
 * Committed entries one target window may hold before the count rules decide it. It is the loaded window's own
 * raw-entry cap (\`rawWindowCap(VISIBLE_WINDOW)\` in \`apps/server/src/history-window.ts\`), stated here because a target
 * window is read from the entry table rather than from that window and still has to be bounded by the same number:
 * one span of tool traffic cannot make a "window of N messages" cost an unbounded read.
 */
export const NAVIGATION_TARGET_MAX_RAW_ENTRIES = 300;

/**
 * One user-message anchor as the outline publishes it.
 *
 * `entryId` is the committed entry's own identity: never generated, never a position, and inherited by a fork as the
 * entry itself is. `anchor` is the opaque coordinate a target read is addressed by. `cursor` is the entry id as a
 * number and orders pages only — a lower bound for the next scan — so an ordinal never becomes jump identity.
 * `preview` is the committed user text under {@link NAVIGATION_PREVIEW_MAX_BYTES}.
 *
 * A page is ordered `cursor` ascending (oldest first), so the rail's top edge is the conversation's beginning and the
 * newest turn sits at the bottom edge, where the transcript puts it.
 */
export type NavigationAnchor = {
  readonly anchor: string;
  readonly entryId: string;
  readonly cursor: number;
  readonly preview: string;
};

/**
 * What precedes the conversation's first user anchor, stated as the fact it is rather than as a fabricated node.
 *
 * `none` means no committed entry precedes the first anchor — which includes a conversation that has no anchors at
 * all, and states so through an empty `anchors`. `non-user` means the history opens with content that is not a user
 * message (an assistant-only prefix, or leading tool or system traffic): the rail gets no node for it, the transcript
 * still renders it as its own leading segment, and the range is named by the entries it holds rather than by a
 * positional index.
 */
export type NavigationPrefix =
  | { readonly kind: "none" }
  | { readonly kind: "non-user"; readonly entries: number; readonly firstEntryId: string; readonly lastEntryId: string };

/**
 * One bounded page of the outline.
 *
 * `hasMore` says at least one further anchor exists in this snapshot, and `nextCursor` — present exactly when it is
 * true — is the value to pass back as `cursor` to reach it: the last anchor this page returned, exclusive. It is a
 * lower bound and not an entry, because the kinds the outline does not enumerate (a tool result, a system prompt, a
 * compaction summary) sit between anchors in native id order and a continuation still has to pass them. A page that
 * reached the end states no continuation, so a client cannot mistake a finished outline for a cursor it may reuse.
 *
 * `prefix` is stated only by a page that began at the start of the history: a page that continued a cursor never saw
 * what precedes the first anchor, and this contract does not answer a question it cannot check.
 */
export type NavigationOutlinePage = {
  readonly protocol: ProtocolVersion;
  readonly conversationId: ConversationId;
  /** The window's history-revision token this page was read against — head marker plus newest committed entry. */
  readonly snapshot: string;
  /** The append-invariant part of that identity — the head marker's scope. Coordinates are stamped with it. */
  readonly scope: string;
  readonly order: "oldest-first";
  readonly anchors: readonly NavigationAnchor[];
  readonly hasMore: boolean;
  readonly nextCursor?: number;
  readonly capped: boolean;
  readonly prefix?: NavigationPrefix;
  /** The page's own serialized size, so the bound that cut it is visible rather than guessed. */
  readonly bytes: number;
};

/** The scope a coordinate claims: a conversation, the head-marker scope it was read against, and the entry it names. */
export type NavigationCoordinate = {
  readonly version: number;
  readonly conversationId: ConversationId;
  readonly scope: string;
  readonly entryId: string;
};

/**
 * Why a coordinate was refused. Each one is a named outcome, so a caller can render the difference between "this
 * belongs to another conversation", "this history re-baselined", and "this entry is not in this history at all" —
 * and never lands on a nearby message or reports a failed locate as handled.
 */
export type NavigationInvalidReason =
  /** Not a coordinate this contract produced. */
  | "malformed"
  /** A coordinate from another version of this contract. */
  | "version_mismatch"
  /** The coordinate names a different conversation than the route addressed. */
  | "wrong-scope"
  /** The coordinate's head-marker scope is not what this conversation's history now has — a reset or a compaction. */
  | "stale-snapshot"
  /** No such entry in this conversation's fork-aware committed history. */
  | "missing";

/**
 * The refusal of a coordinate or a page request, and what the caller did wrong: one shape, so a route answers the
 * named code and a caller never has to match on an English sentence to decide what to render.
 */
export type NavigationRefusal = { readonly ok: false; readonly code: NavigationInvalidReason; readonly error: string };
/** One coordinate read either resolves to an entry of this history or names the reason it cannot. */
export type NavigationDecodeResult = { readonly ok: true; readonly coordinate: NavigationCoordinate } | NavigationRefusal;

/** The scope and identity a page request stated, after the defaults and the caps. */
export type NavigationPageRequest = {
  readonly limit: number;
  /** True when the default, not the caller, decided the size. */
  readonly capped: boolean;
  /** The exclusive lower bound to continue from, or undefined when the page starts at the history's beginning. */
  readonly cursor?: number;
  /** The scope the caller is paging within, refused by name when the history re-baselined under it. */
  readonly scope?: string;
};

/** A page request the caller cannot make sense of, before any history is read. */
export type NavigationRequestResult = { readonly ok: true; readonly request: NavigationPageRequest } | NavigationRefusal;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The width a page's own `bytes` field adds to the page: `,"bytes":` plus the digits of the number it states.
 *
 * Every navigation read carries a `bytes` field, so every one of them has to answer the same awkward question — the
 * field reports the size of the object that contains it, and its own width is part of that size. Counting it is what
 * makes the stated number the truth rather than an underestimate of the wire (review note N1 on the outline), and
 * doing it here, once, is what keeps a page and a window from stating the same bound two ways.
 */
function bytesFieldWidth(stated: number): number {
  return 9 + String(stated).length;
}

/**
 * A body's own serialized size **as the object it will become**, `bytes` included.
 *
 * The digit count depends on the answer, so it settles by iteration; the fixed point is reached in two steps at any
 * size this contract produces, because the width grows only when the total crosses a power of ten. The result equals
 * `utf8Bytes(JSON.stringify({ ...body, bytes: result }))` exactly — a caller can measure the response it received
 * against the number the response states, which is the check no "body plus a guess" version could pass.
 */
export function navigationSerializedBytes(body: unknown): number {
  const withoutField = utf8Bytes(JSON.stringify(body));
  let stated = withoutField + bytesFieldWidth(withoutField);
  for (;;) {
    const next = withoutField + bytesFieldWidth(stated);
    if (next === stated) return stated;
    stated = next;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string | undefined {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The named refusal every check in this module answers with: the code a caller renders, and the reason it can show. */
function refusal(code: NavigationInvalidReason, message: string): NavigationRefusal {
  return { ok: false, code, error: message };
}

/**
 * The coordinate a target read is addressed by: one opaque, backend-issued string over the conversation, its
 * head-marker scope and the entry it names.
 *
 * It is encoded rather than a bare entry id so the scope travels *inside* the value the caller holds: a read can then
 * refuse a coordinate minted for another conversation, for a fork that never inherited the entry, or for a history that
 * re-baselined, instead of guessing what the caller meant. Opacity is so a caller round-trips it unchanged, not
 * authority — the fence is the Backend's own membership and scope check, which a hand-written value cannot pass.
 */
export function encodeNavigationAnchor(coordinate: NavigationCoordinate): string {
  return "nav1." + encodeBase64Url(JSON.stringify({ v: coordinate.version, c: coordinate.conversationId, s: coordinate.scope, e: coordinate.entryId }));
}

/** One encoded coordinate, checked as a whole. A malformed one names nothing; a mismatch names its own reason. */
export function decodeNavigationAnchor(value: string): NavigationDecodeResult {
  if (typeof value !== "string" || !value.startsWith("nav1.")) return refusal("malformed", "the coordinate is not a navigation anchor");
  const json = decodeBase64Url(value.slice("nav1.".length));
  if (json === undefined) return refusal("malformed", "the coordinate is not a navigation anchor");
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return refusal("malformed", "the coordinate is not a navigation anchor");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refusal("malformed", "the coordinate is not a navigation anchor");
  const record = payload as Record<string, unknown>;
  if (typeof record.c !== "string" || typeof record.s !== "string" || typeof record.e !== "string") {
    return refusal("malformed", "the coordinate is not a navigation anchor");
  }
  if (record.v !== NAVIGATION_COORDINATE_VERSION) {
    return refusal("version_mismatch", "this coordinate was produced by navigation version " + String(record.v) + "; the current version is " + NAVIGATION_COORDINATE_VERSION);
  }
  // The Backend's own vocabulary for an id: decimal, so a hand-written coordinate cannot address a range no history holds.
  if (!/^[0-9]+$/.test(record.c)) return refusal("malformed", "the coordinate names no conversation of this deployment");
  if (!/^[0-9]+$/.test(record.e)) return refusal("malformed", "the coordinate names no entry");
  return { ok: true, coordinate: { version: NAVIGATION_COORDINATE_VERSION, conversationId: record.c, scope: record.s, entryId: record.e } };
}

/**
 * A coordinate against the conversation and scope a read actually holds.
 *
 * This is the whole scope rule, stated once so the outline and a later target read cannot answer it twice: the
 * addressed conversation must be the one the coordinate names, and the coordinate's scope must still be the one this
 * conversation's history has. Whether the entry itself belongs to this history is a fact only the runtime's
 * fork-aware scan can answer, so it stays `missing` at the read that performs that scan.
 */
export function checkNavigationCoordinate(coordinate: NavigationCoordinate, against: { conversationId: ConversationId; scope: string }): NavigationRefusal | undefined {
  if (coordinate.conversationId !== against.conversationId) return refusal("wrong-scope", "this coordinate belongs to another conversation");
  if (coordinate.scope !== against.scope) return refusal("stale-snapshot", "this conversation's history re-baselined since the coordinate was issued");
  return undefined;
}

/** One anchor, from the identity the Backend holds. */
export function navigationAnchorOf(input: { conversationId: ConversationId; scope: string; entryId: string; cursor: number; preview: string }): NavigationAnchor {
  return {
    anchor: encodeNavigationAnchor({ version: NAVIGATION_COORDINATE_VERSION, conversationId: input.conversationId, scope: input.scope, entryId: input.entryId }),
    entryId: input.entryId,
    cursor: input.cursor,
    preview: input.preview,
  };
}

/**
 * One user message as the rail previews it: the leading characters inside {@link NAVIGATION_PREVIEW_MAX_BYTES}, cut at
 * a code-point boundary, with surrounding whitespace and every run of whitespace collapsed to one space.
 *
 * The cap is UTF-8 bytes rather than characters because a preview is wire bytes: 240 CJK characters would cost three
 * times the answer for ASCII. A cut never splits a code point, so an emoji or a combining sequence is kept whole or
 * dropped, and no replacement character reaches a rail node. A message that is all whitespace previews empty — the
 * anchor still exists and still jumps, and the rail is not given text the entry does not contain.
 */
export function navigationPreview(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  let bytes = 0;
  let end = 0;
  for (const character of collapsed) {
    const size = utf8Bytes(character);
    if (bytes + size > NAVIGATION_PREVIEW_MAX_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return collapsed.slice(0, end);
}

/**
 * A page query, as the route's own parameters state it.
 *
 * Every refusal is named before any history is read, and a malformed value is never coerced: `limit` and `cursor` are
 * decimal integers or nothing, so a client cannot be handed a page it believes it bounded itself when it did not.
 */
export function parseNavigationPageRequest(params: { limit?: string | undefined; cursor?: string | undefined; scope?: string | undefined }): NavigationRequestResult {
  if (params.limit !== undefined && !/^[0-9]+$/.test(params.limit)) return refusal("malformed", "limit must be a positive integer");
  if (params.cursor !== undefined && !/^[0-9]+$/.test(params.cursor)) return refusal("malformed", "cursor must be an entry id");
  const named = params.limit === undefined ? undefined : Number(params.limit);
  if (named !== undefined && named < 1) return refusal("malformed", "limit must be a positive integer");
  const bounded = named === undefined
    ? { limit: NAVIGATION_DEFAULT_LIMIT, capped: true }
    : { limit: Math.min(named, NAVIGATION_MAX_LIMIT), capped: false };
  const cursor = params.cursor === undefined ? undefined : Number(params.cursor);
  const scope = params.scope === undefined || params.scope === "" ? undefined : params.scope;
  return { ok: true, request: { ...bounded, ...(cursor === undefined ? {} : { cursor }), ...(scope === undefined ? {} : { scope }) } };
}

/** The fields a page carries once the scan decided its anchors. */
export type NavigationPageFacts = {
  readonly protocol: ProtocolVersion;
  readonly conversationId: ConversationId;
  readonly snapshot: string;
  readonly scope: string;
  readonly anchors: readonly NavigationAnchor[];
  readonly hasMore: boolean;
  readonly capped: boolean;
  readonly prefix?: NavigationPrefix;
};

/**
 * One outline page, assembled under the page's own byte budget.
 *
 * The scan already holds the anchors in native order; this decides how many a page may carry and states the
 * continuation from the anchor it **actually returned**, so `hasMore` and `nextCursor` never disagree with the body:
 * a page that the budget shortened says more exists and hands back the cursor that reaches it. The last anchor is
 * never dropped to fit — a preview cannot be split, and a page carrying nothing would state a continuation no cursor
 * can reach — which is safe because one anchor costs at most an id, one coordinate and {@link
 * NAVIGATION_PREVIEW_MAX_BYTES} bytes of preview, far inside the page budget.
 */
export function buildNavigationPage(facts: NavigationPageFacts): NavigationOutlinePage {
  const body = (anchors: readonly NavigationAnchor[], hasMore: boolean): Omit<NavigationOutlinePage, "bytes"> => {
    const last = anchors.at(-1);
    return {
      protocol: facts.protocol,
      conversationId: facts.conversationId,
      snapshot: facts.snapshot,
      scope: facts.scope,
      order: "oldest-first",
      anchors,
      hasMore,
      ...(hasMore && last !== undefined ? { nextCursor: last.cursor } : {}),
      capped: facts.capped,
      ...(facts.prefix === undefined ? {} : { prefix: facts.prefix }),
    };
  };
  let kept = facts.anchors;
  for (;;) {
    const candidate = body(kept, kept.length < facts.anchors.length ? true : facts.hasMore);
    const bytes = navigationSerializedBytes(candidate);
    if (bytes <= NAVIGATION_PAGE_MAX_BYTES || kept.length <= 1) return { ...candidate, bytes };
    kept = kept.slice(0, kept.length - 1);
  }
}

/**
 * The bounded target read a rail jump or a deep search hit asks for: one window of committed history around one
 * anchor, from the same record and the same identity rules the outline page was read from.
 *
 * The choice ticket 01's spec left open is made here and delivered by ticket 02's route: the window **reuses the
 * projected entry shape the transcript already renders** (`ServerEntry`, produced by the Backend's one projection
 * expression) over the runtime's fork-aware committed history, rather than the raw `conversation-read` text lines and
 * rather than a new projection. The reasons are the four constraints the ticket names:
 *
 * - **Committed user text after compaction.** The scan reads the entry table, not the active range, so a compacted
 *   message is projected from the same record a live one is; the head marker bounds the *model's* context, not this read.
 * - **Bounded output, UTF-8 limits.** The window is a count of messages, a raw-entry cap and one byte budget — the same
 *   `NAVIGATION_PAGE_MAX_BYTES` the outline page measures itself against — and a heavy block is deferred by the
 *   projection into the read-block family (`textUrl`, `thinkingUrl`, `toolResultImageUrl`) that already serves it, so
 *   a target never becomes an unbounded body and needs no second deferral rule.
 * - **Fork visibility.** Entry identity is resolved by the conversation's own membership-checked scan, so an inherited
 *   entry is readable in the fork and an entry of a sibling branch is not readable at all.
 * - **A clear rendering contract.** `ServerEntry` is what the transcript mounts, so a target window lands in the
 *   existing history owner with no new renderer, and its entries obey the same bounded-window facts (`hasOlder`,
 *   `hasNewer`, exclusive boundary cursors) a loaded prefix already handles.
 *
 * Placement is stated by identity, never by a position: `target` names the entry the caller jumped for and the native
 * block indices of its text — what a search hit aligns to — while an oversized answer names the entry that caused it,
 * which its own read block still serves whole. A client is given no offset, no ordinal and no pixel.
 */
export type NavigationTargetWindow = {
  readonly protocol: ProtocolVersion;
  readonly conversationId: ConversationId;
  /**
   * The identity this window's bytes were read against: the pinned history, head marker plus newest committed entry.
   * A caller that named a `snapshot` gets that identity back; a caller that named none gets the conversation's own. It
   * therefore describes the entries returned, which is the point — the current token would name a history this window
   * did not read.
   */
  readonly snapshot: string;
  readonly scope: string;
  readonly order: "oldest-first";
  /** The anchor this window is around, as the Backend resolved the coordinate. */
  readonly target: NavigationTarget;
  /** True when the default decided a count, as on an outline page. */
  readonly capped: boolean;
  /** True when a bound (a count or the byte budget) left committed history out of this window. */
  readonly trimmed: boolean;
  /** The committed entries the window carries, in native history order, oldest first — the transcript's own shape. */
  readonly entries: readonly ServerEntry[];
  /** Committed entries exist behind this window, within the history it was read against. */
  readonly hasOlder: boolean;
  /**
   * Committed entries exist ahead of it, within the snapshot it was read against — not whether this read carried any:
   * a window asked for no newer context still answers whether newer history exists.
   */
  readonly hasNewer: boolean;
  /** The boundary to continue older from, in the same exclusive-cursor vocabulary the outline pages use; stated exactly when `hasOlder`. */
  readonly olderCursor?: number;
  readonly newerCursor?: number;
  /** The response's own serialized size, this field included, under {@link NAVIGATION_PAGE_MAX_BYTES}. */
  readonly bytes: number;
};

/**
 * The target as the Backend resolved it.
 *
 * `anchor` is the coordinate re-issued over the identity the read actually holds, so a caller that came from a search
 * result rather than an outline page still ends up holding one canonical address for the entry. `present` says the
 * window carries that entry: it is the honest statement that the target's own message is inside the bytes returned,
 * which is the difference between landing on a turn and landing beside it. `blocks` lists the native content indices of
 * the target's text blocks — the addressing every read block and every search hit already uses — and `blockIndex`
 * echoes a caller-supplied one back after the Backend checked it against the entry, so a hit names a block that exists
 * rather than one the caller counted.
 */
export type NavigationTarget = {
  readonly entryId: string;
  readonly anchor: string;
  readonly present: boolean;
  readonly blocks: readonly number[];
  readonly blockIndex?: number;
};

/** Why the caller addressed a target the contract cannot answer. */
export type NavigationTargetRequest = {
  /** The coordinate the caller addressed, decoded before any history was read. */
  readonly coordinate: NavigationCoordinate;
  /** Messages of leading context asked for; never over-delivered, so a caller can size its landing. */
  readonly before: number;
  readonly after: number;
  /** True when the default, not the caller, decided at least one of the two counts. */
  readonly capped: boolean;
  /** The snapshot to pin the window's newest end at, so a turn committed afterwards cannot move it. */
  readonly snapshot?: string;
  /** The entry whose block a search hit landed in. */
  readonly entry?: string;
  /** The native block index within `entry`, validated by the read that resolves the entry. */
  readonly block?: number;
};

export type NavigationTargetRequestResult = { readonly ok: true; readonly request: NavigationTargetRequest } | NavigationRefusal;

/** The most messages one side of a target window may carry, whatever the caller asked for. */
export const NAVIGATION_TARGET_MAX_AROUND = 50;
/** The count each side carries when the caller names none — a turn's worth of context either way. */
export const NAVIGATION_TARGET_DEFAULT_AROUND = 10;

/**
 * A target request, as the route's own parameters state it.
 *
 * The `anchor` is decoded here, so a coordinate the contract never issued, or one from another navigation version, is
 * refused **before any history is read**; `before`/`after`/`block` are decimal integers or nothing,
 * and a count is clamped rather than rejected because a caller that asked for a thousand messages is served a bounded
 * window. `capped` means what it means on an outline page — the **default**, not the caller, decided at least one
 * count — and `trimmed` is the window's own statement that a bound shortened it further. `entry` requires nothing of the anchor:
 * they name the same entry by two addresses, and the read checks that they agree.
 */
export function parseNavigationTargetRequest(params: { anchor?: string | undefined; before?: string | undefined; after?: string | undefined; snapshot?: string | undefined; entry?: string | undefined; block?: string | undefined }): NavigationTargetRequestResult {
  if (params.anchor === undefined || params.anchor === "") return refusal("malformed", "a target window needs the anchor it is around");
  const decoded = decodeNavigationAnchor(params.anchor);
  if (!decoded.ok) return decoded;
  const counts: Record<string, string | undefined> = { before: params.before, after: params.after };
  for (const [name, value] of Object.entries(counts)) {
    if (value !== undefined && !/^[0-9]+$/.test(value)) return refusal("malformed", name + " must be a whole number of messages");
  }
  if (params.block !== undefined && !/^[0-9]+$/.test(params.block)) return refusal("malformed", "block must be a block index");
  if (params.entry !== undefined && !/^[0-9]+$/.test(params.entry)) return refusal("malformed", "entry must be an entry id");
  const asked = (value: string | undefined): { count: number; capped: boolean } => value === undefined
    ? { count: NAVIGATION_TARGET_DEFAULT_AROUND, capped: true }
    : { count: Math.min(Number(value), NAVIGATION_TARGET_MAX_AROUND), capped: false };
  const before = asked(params.before);
  const after = asked(params.after);
  return {
    ok: true,
    request: {
      coordinate: decoded.coordinate,
      before: before.count,
      after: after.count,
      capped: before.capped || after.capped,
      ...(params.snapshot === undefined || params.snapshot === "" ? {} : { snapshot: params.snapshot }),
      ...(params.entry === undefined || params.entry === "" ? {} : { entry: params.entry }),
      ...(params.block === undefined ? {} : { block: Number(params.block) }),
    },
  };
}

/** The fields a window carries once the read decided its entries. */
export type NavigationTargetFacts = {
  readonly protocol: ProtocolVersion;
  readonly conversationId: ConversationId;
  readonly snapshot: string;
  readonly scope: string;
  readonly target: NavigationTarget;
  /** The window's entries in native order, exactly as the transcript's own projection made them. */
  readonly entries: readonly ServerEntry[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  /** True when the default, not the caller, decided at least one of the two counts. */
  readonly capped: boolean;
};

/**
 * One target window, assembled under the same byte budget an outline page is measured against.
 *
 * A window is built to fit, so the count caps and the raw-entry cap already bounded it; when the serialized entries
 * still exceed the budget the **outer** ends are dropped, alternating, and the target is never one of them: dropping
 * from one end only would push the target to the edge of a window a caller jumped to be able to read in the middle.
 * Dropping stops at the target, so a target whose single message is itself over the budget is not silently emptied —
 * the read answers the same named size the stream and the older-page routes answer with that entry, and the entry stays
 * whole through the read block its own deferred preview names.
 *
 * `bytes` is the size of the response as it goes on the wire, its own `bytes` field counted (`navigationSerializedBytes`),
 * which is the rule the outline page applies too: one measurement, one meaning, wherever a navigation read states a size.
 */
export function buildNavigationTargetWindow(facts: NavigationTargetFacts): NavigationTargetWindow {
  const body = (kept: readonly ServerEntry[], hasOlder: boolean, hasNewer: boolean): Omit<NavigationTargetWindow, "bytes"> => {
    const oldest = kept[0];
    const newest = kept.at(-1);
    return {
      protocol: facts.protocol,
      conversationId: facts.conversationId,
      snapshot: facts.snapshot,
      scope: facts.scope,
      order: "oldest-first",
      target: facts.target,
      capped: facts.capped,
      trimmed: hasOlder || hasNewer,
      entries: kept,
      hasOlder,
      hasNewer,
      ...(hasOlder && oldest !== undefined ? { olderCursor: Number(oldest.id) } : {}),
      ...(hasNewer && newest !== undefined ? { newerCursor: Number(newest.id) } : {}),
    };
  };
  let kept = [...facts.entries];
  let hasOlder = facts.hasOlder;
  let hasNewer = facts.hasNewer;
  let fromOlder = true;
  const isTarget = (entry: ServerEntry): boolean => entry.id === facts.target.entryId;
  for (;;) {
    const candidate = body(kept, hasOlder, hasNewer);
    const bytes = navigationSerializedBytes(candidate);
    if (bytes <= NAVIGATION_PAGE_MAX_BYTES || kept.length <= 1) return { ...candidate, bytes };
    // Drop an **outer** end, alternating, and never the target: a caller jumped to read this turn, so a window that
    // lost it would be a window about a turn it does not carry. The end that was dropped is then stated as lying
    // behind or ahead of what remains, which is what keeps the two cursors agreeing with the entries they name.
    const oldest = kept[0]!;
    const newest = kept.at(-1)!;
    const dropOldest = isTarget(oldest) ? false : isTarget(newest) ? true : fromOlder;
    kept = dropOldest ? kept.slice(1) : kept.slice(0, -1);
    if (dropOldest) hasOlder = true;
    else hasNewer = true;
    fromOlder = !fromOlder;
  }
}
