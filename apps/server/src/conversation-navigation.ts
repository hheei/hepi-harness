import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { PROTOCOL_VERSION, type ServerEntry } from "@hepi/protocol";
import { visibleEntry as entryOfHistory } from "./conversation-read.ts";
import { tokenFromFacts, type HistoryFacts } from "./history-window.ts";
import {
  NAVIGATION_COORDINATE_VERSION,
  NAVIGATION_PAGE_MAX_BYTES,
  NAVIGATION_SCAN_PAGE,
  NAVIGATION_TARGET_MAX_RAW_ENTRIES,
  buildNavigationPage,
  buildNavigationTargetWindow,
  checkNavigationCoordinate,
  encodeNavigationAnchor,
  navigationAnchorOf,
  navigationPreview,
  parseNavigationPageRequest,
  parseNavigationTargetRequest,
  type NavigationAnchor,
  type NavigationCoordinate,
  type NavigationOutlinePage,
  type NavigationPageRequest,
  type NavigationPrefix,
  type NavigationTargetRequest,
  type NavigationTargetWindow,
} from "@hepi/protocol/navigation";

/**
 * The navigation reads over one conversation's committed history: the outline of its user messages (ticket 01) and
 * the bounded target window a coordinate from that outline addresses (ticket 02).
 *
 * Both are thin adapters over the same record. The scan is the primitive the raw history read already uses —
 * `Conversation.entries()` is the runtime's membership-checked, fork-aware walk over the entry table, not a window of
 * it — so the three facts these routes owe, and the active range cannot state, all hold here: a compaction's head
 * marker bounds the *model's* context and not this scan, a fork reads the prefix it inherited as its own history, and
 * an entry of a conversation that did not inherit it is not in it. The bounds, a coordinate's encoding, the preview
 * rule, the page and window assemblers and the named refusals are declared once in `@hepi/protocol/navigation`; this
 * module holds the reading, and nothing here re-decides a rule the contract already states.
 *
 * The outline is an **index** over that record: one anchor per user message with a short preview and no message body, which is what keeps a page of a long conversation small enough for a transport that also has to carry
 * a transcript window. Nothing is counted against a stored index: one scan walks the entries a page needs and stops,
 * so a page costs what it read and the entries between two anchors are passed over rather than held.
 *
 * An anchor is a committed entry whose first model message is a user message **and** which carries no head marker.
 * Both halves are structural facts the runtime states, not a kind registry: the first makes a user message the node
 * and an assistant, tool or system contribution not; the second keeps a context marker out of the rail, because a
 * compaction summary and a reset handoff are each stored as a user message and neither is something the user wrote. An
 * input an application placed under its own entry kind (a subagent's report) keeps the user-role message the transcript
 * shows, so it keeps its node.
 */

/**
 * The identity one navigation read is stamped with, from the history owner the conversation already has.
 *
 * `snapshot` and `scope` are the window's own two facts, not a second clock: `snapshot` is the {@link
 * ServerSnapshot.historyRevision} token (head marker plus newest committed entry) and `tail` is that token's entry
 * fact, which is what pins the page the snapshot describes. `scope` drops the tail and keeps the head marker — the
 * one part an append cannot move — and is the identity a coordinate is stamped with, so a rail's anchors survive every
 * turn that follows them while a reset or a compaction, which is the one event that re-baselines the range, retires
 * the page a coordinate came from.
 */
export type NavigationHistory = {
  readonly conversation: Conversation;
  readonly snapshot: string;
  readonly scope: string;
  /** The newest committed entry of this conversation's own history, or null when it holds none. */
  readonly tail: string | null;
};

/**
 * One outline request: the parsed form of the route's query, so the size a caller asked for, the size the deployment
 * imposed, the continuation and the paging scope travel as one statement instead of being re-derived per surface.
 */
export type NavigationOutlineRequest = NavigationPageRequest;

/**
 * A refusal a caller names by code and status instead of matching on a message.
 *
 * `data` carries the facts that make a refusal actionable rather than merely named — the entry a window could not
 * bring inside its byte budget, the size it cost — the same pair the stream and the older-page routes state with
 * `frame_too_large`, so one caller-side branch handles a size the whole backend answers the same way.
 */
export class ConversationNavigationRefusal extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Record<string, unknown>;
  constructor(code: string, status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConversationNavigationRefusal";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** The answer for a coordinate or request the contract refused: the code a caller renders, plus what made it actionable. */
function refusalAnswer(conversationId: string, code: string, status: number, error: string, data: Record<string, unknown> = {}): NavigationAnswer {
  return { status, body: { protocol: PROTOCOL_VERSION, conversationId, code, error, ...data } };
}

/**
 * True for the entry of one committed user message: a user-role model contribution that starts no new context. `head`
 * is the runtime's own marker of an entry that re-baselines the active range, so a compaction summary or a reset is
 * excluded by the same field that makes it a context marker.
 */
function isUserAnchor(entry: EntryRecord): boolean {
  return entry.head === undefined && entry.model?.[0]?.role === "user";
}

/** The committed user text one anchor previews, capped as the contract caps it. */
function previewOf(entry: EntryRecord): string {
  const message = entry.model?.[0];
  return navigationPreview(message === undefined ? "" : contentText(message.content));
}

/**
 * Why a stated scope is not this conversation's current one.
 *
 * The scope is the Backend's own token over a conversation and its newest head marker, so its leading part names the
 * conversation it was issued for: a scope from another conversation is the caller addressing the wrong history
 * (`wrong-scope`), and a scope from this one whose head marker moved is a history that re-baselined under the pages it
 * holds (`stale-snapshot`). The two are refused apart because a caller renders them apart — one is a bug in its
 * addressing, the other is a refresh.
 */
function scopeRefusal(conversationId: string, scope: string): ConversationNavigationRefusal {
  return scope.startsWith(conversationId + "|")
    ? new ConversationNavigationRefusal("stale-snapshot", 409, "this conversation's history re-baselined since the page was issued")
    : new ConversationNavigationRefusal("wrong-scope", 409, "this scope belongs to another conversation");
}

/** The leading range that is not a user anchor, stated as the entries it holds rather than as a position. */
type PrefixRun = { readonly entries: number; readonly firstEntryId: string; readonly lastEntryId: string };

/**
 * One bounded page of the outline, in oldest-first order.
 *
 * The page is read against the `tail` the caller's history identity states, so the anchors it hands out and the
 * `snapshot` it stamps are one consistent answer: an entry committed after that read is not in this page, and a
 * re-read against the same scope states the same anchors in the same order — which is what lets a rail hold pages
 * from one snapshot while the conversation grows. `hasMore` is true only when the scan actually reached a further
 * anchor, so trailing tool traffic does not become a page a caller must ask for and get nothing from. A caller that
 * holds a scope whose head marker has since moved is refused `stale-snapshot` rather than handed anchors it cannot
 * land on.
 */
export async function readNavigationOutline(history: NavigationHistory, request: NavigationOutlineRequest): Promise<NavigationOutlinePage> {
  if (request.scope !== undefined && request.scope !== history.scope) throw scopeRefusal(String(history.conversation.id), request.scope);
  const wanted = request.limit;
  // `cursor` is exclusive and is an entry id. An id no longer in the active range is still a lower bound like any
  // other, so a page continues from the first committed entry at or after it — the rule the raw history scan already
  // applies, and the reason an ordinal never has to become an identity for paging to keep working.
  const minEntryId = request.cursor === undefined ? undefined : ((request.cursor + 1) as EntryId);

  const anchors: NavigationAnchor[] = [];
  let prefix: PrefixRun | undefined;
  let scanned = 0;
  let hasMore = false;
  let scanCursor: Cursor | undefined;
  if (history.tail !== null) {
    scan: do {
      const page = await history.conversation.entries(
        { ...(minEntryId === undefined ? {} : { minEntryId }), maxEntryId: Number(history.tail) as EntryId, order: "ascending" },
        NAVIGATION_SCAN_PAGE, scanCursor, BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        scanned += 1;
        if (isUserAnchor(entry)) {
          // The page ends at its last anchor. The anchor that would have been the next one is why `hasMore` is true,
          // and the caller continues from the anchor it holds, so no anchor is issued twice or reordered.
          if (anchors.length >= wanted) { hasMore = true; break scan; }
          anchors.push(navigationAnchorOf({ conversationId: String(history.conversation.id), scope: history.scope, entryId: String(entry.id), cursor: Number(entry.id), preview: previewOf(entry) }));
        } else if (anchors.length === 0) {
          prefix = prefix === undefined
            ? { entries: 1, firstEntryId: String(entry.id), lastEntryId: String(entry.id) }
            : { entries: prefix.entries + 1, firstEntryId: prefix.firstEntryId, lastEntryId: String(entry.id) };
        }
      }
      if (page.next === undefined) break;
      scanCursor = page.next;
    } while (true);
  }

  // The prefix is stated only by a page that began at the start of the history: a continuation never saw what precedes
  // the first anchor, and this contract does not answer a question it cannot check. A conversation with no entries
  // scanned at all has no leading range either, which is the honest `none`.
  const stated: NavigationPrefix | undefined = request.cursor === undefined
    ? scanned === 0 || prefix === undefined
      ? { kind: "none" }
      : { kind: "non-user", entries: prefix.entries, firstEntryId: prefix.firstEntryId, lastEntryId: prefix.lastEntryId }
    : undefined;

  return buildNavigationPage({
    protocol: PROTOCOL_VERSION,
    conversationId: String(history.conversation.id),
    snapshot: history.snapshot,
    scope: history.scope,
    anchors,
    hasMore,
    capped: request.capped,
    ...(stated === undefined ? {} : { prefix: stated }),
  });
}

/**
 * The bounded target read: one window of a conversation's committed history around the entry a coordinate names.
 *
 * The outline answers *which* user messages a conversation holds; this answers *what is around one of them*, from the
 * same record and with the same identities, so a rail jump or a deep search hit lands on a real turn instead of on a
 * re-derived approximation of one. It reads the entry table through the runtime's membership-checked, fork-aware scan —
 * never the active window — so a compacted user message is still readable, an inherited fork entry is readable in the
 * fork, and an entry of a sibling branch is `missing` rather than silently absent from a window that looked complete.
 *
 * Every entry it carries is the **projection the transcript already renders** (`ServerEntry`, produced by the one
 * expression `projectEntry` in `server.ts`, handed in as `project`), which is what keeps the window mountable by the
 * existing history owner: the same deferred text/thinking/image shapes, the same read blocks behind them, the same
 * redaction. Nothing here projects an entry itself, so a target entry and a streamed entry cannot differ.
 *
 * The window is bounded three ways — the two message counts the caller asked for, a raw-entry cap for spans of tool
 * traffic, and the same byte budget an outline page is measured against — and it states which of those cut it: the two
 * boundary cursors name the entries it did not carry, and `capped` says the deployment, not the caller, decided a
 * count. A caller therefore never has to guess whether a window is complete.
 */

/** What a target read needs: the history identity the outline uses, plus the transcript's own projection. */
export type NavigationTargetReader = NavigationHistory & {
  /** The one projection expression, the transcript's own: a wire entry, or nothing for an entry with no message. */
  readonly project: (entry: EntryRecord) => ServerEntry | undefined;
};

/**
 * One entry of this conversation's own fork-aware history, or undefined when it holds none.
 *
 * The raw history read's `visibleEntry`, reused rather than re-spelled: entry ids are **inherited**, so a lookup by id
 * alone would answer an entry of another conversation as though it were this history's. One fence decides what one
 * conversation can see, for a read block, a raw page and a navigation window alike.
 */
async function visibleEntry(conversation: Conversation, id: string): Promise<EntryRecord | undefined> {
  return await entryOfHistory(conversation, id);
}

/**
 * A coordinate the request already carries, checked against the identity this conversation's history states right now.
 *
 * The contract decoded and shape-checked the value before any history was read; this is the half that only the
 * Backend's own state can answer — is this the conversation being addressed, and is this still its scope. Two named
 * refusals, held apart for the same reason the outline holds them apart: one is bad addressing, the other is a
 * history that re-baselined under the page the caller jumped from.
 */
function resolveCoordinate(conversationId: string, history: NavigationHistory, coordinate: NavigationCoordinate): NavigationCoordinate {
  const refusal = checkNavigationCoordinate(coordinate, { conversationId, scope: history.scope });
  if (refusal !== undefined) throw new ConversationNavigationRefusal(refusal.code, 409, refusal.error);
  return coordinate;
}

/**
 * The head marker one scope names, read back through the identity's own spelling.
 *
 * `scope` is {@link scopeFromFacts}'s output over the same facts the snapshot is built from, so its part after the
 * conversation is the head fact (the empty marker spelled `-`). Reading it back is what lets a window state a snapshot
 * the history owner spelled, rather than a second place that builds that identity and a second rule for when history
 * moved.
 */
function headOfScope(conversationId: string, scope: string): string | null {
  const named = scope.slice(conversationId.length + 1);
  return named === "" || named === "-" ? null : named;
}

/**
 * The snapshot one window is stamped with, from the pin the read actually held.
 *
 * The pin is the window's newest committed entry, so it **is** the snapshot's entry fact: a caller that came from an
 * older page gets that page's own identity back, not the conversation's newest one, and the bytes it received and the
 * identity naming them are then one consistent answer. Stamping the conversation's current token instead would report
 * a history the window did not read — a turn committed while the caller was paging would appear in the identity while
 * staying out of the entries, which is the one thing the pin exists to prevent.
 */
function snapshotOfPin(conversationId: string, scope: string, pin: string | null): string {
  const facts: HistoryFacts = { head: headOfScope(conversationId, scope), tail: pin };
  return tokenFromFacts(conversationId, facts);
}

/**
 * The newest committed entry the window is pinned at.
 *
 * A caller that came from an outline page states that page's `snapshot`, and its tail is the pin: a turn committed
 * afterwards is outside this read, so the window and the page it jumped from stay one consistent answer — the same rule
 * the raw history read applies to its own `tail`. A caller that states none is pinned at the conversation's newest
 * committed entry, which is what an outline page would have handed it. The token is the history owner's own spelling
 * (`conversationId|head|tail`), so its parts are read back rather than a second identity being invented: a token from
 * another conversation is bad addressing, a head marker that moved is a history that re-baselined, and a tail this
 * history cannot see is a snapshot that no longer exists.
 */
async function pinnedTail(conversation: Conversation, history: NavigationHistory, conversationId: string, snapshot: string | undefined): Promise<string | null> {
  if (snapshot === undefined) return history.tail;
  const [tokenConversation, tokenHead, tokenTail] = snapshot.split("|");
  if (tokenConversation !== conversationId) throw new ConversationNavigationRefusal("wrong-scope", 409, "this snapshot belongs to another conversation");
  if (tokenHead !== history.scope.slice(conversationId.length + 1)) throw new ConversationNavigationRefusal("stale-snapshot", 409, "this conversation's history re-baselined since the snapshot was issued");
  if (tokenTail === undefined || tokenTail === "-") return history.tail;
  if (await visibleEntry(conversation, tokenTail) === undefined) throw new ConversationNavigationRefusal("stale-snapshot", 409, "the snapshot names an entry this history no longer holds");
  // A snapshot older than the history's newest entry still pins a real place, but never past what the history holds.
  return history.tail !== null && Number(tokenTail) > Number(history.tail) ? history.tail : tokenTail;
}

/**
 * The native text-block indices of one entry — the addressing the read blocks and the search hits already use, with
 * `0` for a message stored as a plain string. A block the entry does not carry is absent rather than guessed.
 */
function textBlocksOf(entry: EntryRecord): readonly number[] {
  const content = entry.model?.[0]?.content;
  if (typeof content === "string") return [0];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, blockIndex) => (block as { type?: unknown }).type === "text" ? [blockIndex] : []);
}

/** What one side of a window collected: the entries it carries and whether the history has more beyond them. */
type WindowSide = { readonly items: ServerEntry[]; readonly more: boolean };

/**
 * The carried entries on one side of a target, walked in that direction over the fork-aware history.
 *
 * `wanted` counts entries the **transcript would mount**: a projection that yields no message is passed over without
 * using a slot, so an `after` of ten means ten mountable messages rather than ten entries of which seven were
 * bookkeeping. The raw-entry cap is what keeps a span of tool traffic from turning "ten messages" into an unbounded
 * read; when the walk stops before the count is met, `more` says so and the caller gets a boundary cursor instead of
 * context that was silently cut short. The walk also stops at the pin — a turn committed after the snapshot is not in
 * this window — and at the history's own end, which is the only honest `more: false`.
 */
async function scanSide(conversation: Conversation, project: NavigationTargetReader["project"], from: string, wanted: number, pin: string | null, direction: "older" | "newer"): Promise<WindowSide> {
  const items: ServerEntry[] = [];
  const query = direction === "older"
    ? { maxEntryId: (Number(from) - 1) as EntryId, order: "descending" as const }
    : { minEntryId: (Number(from) + 1) as EntryId, ...(pin === null ? {} : { maxEntryId: Number(pin) as EntryId }), order: "ascending" as const };
  let scanned = 0;
  let scanCursor: Cursor | undefined;
  for (;;) {
    const page = await conversation.entries(query, NAVIGATION_SCAN_PAGE, scanCursor, BACKGROUND_CONTEXT);
    for (const [index, entry] of page.items.entries()) {
      scanned += 1;
      if (scanned > NAVIGATION_TARGET_MAX_RAW_ENTRIES) return { items, more: true };
      const made = project(entry);
      if (made === undefined) continue;
      // A caller that asked for no context on this side still gets the truth about it: the flag answers "does
      // committed history lie this way", not "did this read carry any", so the first mountable entry is enough and it
      // is not collected. A zero count is then bounded the same way a non-zero one is — one entry of read, no walk.
      if (wanted > 0) items.push(made);
      if (wanted === 0) return { items, more: true };
      if (items.length < wanted) continue;
      // A further mountable entry in what this page already holds is the honest answer to "is there more"; otherwise
      // the scan's own continuation decides.
      const rest = page.items.slice(index + 1).some(candidate => project(candidate) !== undefined);
      return { items, more: rest || page.next !== undefined };
    }
    if (page.next === undefined) return { items, more: false };
    scanCursor = page.next;
  }
}

/**
 * One bounded window around one anchor, read from the snapshot the caller names (or the history's newest) and stated
 * in the same identities an outline page uses.
 *
 * The refusals are named, and each is the one a caller can act on: `malformed` for a coordinate or count the contract
 * cannot read, `wrong-scope` for a coordinate minted for another conversation, `stale-snapshot` for one whose head
 * marker moved, and `missing` for an entry this conversation's fork-aware history does not hold — including an entry
 * a sibling branch added, which is the case a global id lookup would have got wrong. A window that cannot be brought
 * inside its byte budget answers `frame_too_large` with the entry that caused it, the same pair the stream and the
 * older-page routes state, so the caller has one branch for a size the whole backend answers the same way.
 */
export async function readNavigationTarget(reader: NavigationTargetReader, request: NavigationTargetRequest): Promise<NavigationTargetWindow> {
  const conversationId = String(reader.conversation.id);
  const coordinate = resolveCoordinate(conversationId, reader, request.coordinate);
  const pin = await pinnedTail(reader.conversation, reader, conversationId, request.snapshot);
  const snapshot = snapshotOfPin(conversationId, reader.scope, pin);
  const entry = await visibleEntry(reader.conversation, coordinate.entryId);
  if (entry === undefined) throw new ConversationNavigationRefusal("missing", 404, "this entry is not in this conversation's history");
  // The window is read from the snapshot the caller names, so an anchor newer than that snapshot is mixed addressing:
  // the entry exists, but not in the history the caller asked to land inside. It is named rather than answered with a
  // window bounded below the turn the caller jumped to.
  if (pin !== null && Number(entry.id) > Number(pin)) throw new ConversationNavigationRefusal("stale-snapshot", 409, "this snapshot is older than the anchor it is asked to be around");
  // `entry`/`block` are the search hit's own addressing: they must agree with the coordinate, because a window around
  // one entry that claims a block of another would land a caller inside a turn it did not jump to.
  if (request.entry !== undefined && request.entry !== coordinate.entryId) throw new ConversationNavigationRefusal("malformed", 400, "entry and anchor name two different entries");
  const blocks = textBlocksOf(entry);
  if (request.block !== undefined && !blocks.includes(request.block)) throw new ConversationNavigationRefusal("malformed", 400, "block is outside this entry's text blocks");
  const target: ServerEntry | undefined = reader.project(entry);
  const older = await scanSide(reader.conversation, reader.project, coordinate.entryId, request.before, pin, "older");
  const newer = await scanSide(reader.conversation, reader.project, coordinate.entryId, request.after, pin, "newer");
  const kept: ServerEntry[] = [...older.items.slice().reverse(), ...(target === undefined ? [] : [target]), ...newer.items];
  const window = buildNavigationTargetWindow({
    protocol: PROTOCOL_VERSION,
    conversationId,
    snapshot,
    scope: reader.scope,
    target: {
      entryId: coordinate.entryId,
      // The coordinate re-issued over the identity this read actually holds, so a caller that arrived from a search
      // result ends up with the same canonical address an outline page would have handed it.
      anchor: encodeNavigationAnchor({ version: NAVIGATION_COORDINATE_VERSION, conversationId, scope: reader.scope, entryId: coordinate.entryId }),
      present: target !== undefined,
      blocks,
      ...(request.block === undefined ? {} : { blockIndex: request.block }),
    },
    entries: kept,
    hasOlder: older.more,
    hasNewer: newer.more,
    capped: request.capped,
  });
  // The assembly never drops the target, so a window still over budget carries exactly one entry: the target's own
  // message. That entry stays whole and stays readable through the read block its deferred preview names, which is why
  // this is a named size rather than a truncated window a caller would land inside.
  if (window.bytes > NAVIGATION_PAGE_MAX_BYTES) throw new ConversationNavigationRefusal("frame_too_large", 413, "this entry cannot be carried inside a navigation window", { entryId: coordinate.entryId, bytes: window.bytes });
  return window;
}

/**
 * The HTTP adapter for the target read: the query parsed by the contract, the read's own answer or its named refusal.
 * It holds no second implementation of the scope rule, the pin or the bounds — a route caller and any other consumer
 * of a window therefore cannot be handed two histories.
 *
 * Query: `anchor` (required, the opaque coordinate an outline page or a search hit holds), `before`/`after` (messages
 * of context, default 10 each, capped at 50), `snapshot` (the page's identity, so an append cannot move the window),
 * `entry`/`block` (a search hit's exact block, checked against the entry).
 */
export async function handleConversationNavigationTarget(reader: NavigationTargetReader, conversationId: string, query: URLSearchParams): Promise<NavigationAnswer> {
  const parsed = parseNavigationTargetRequest({
    ...(query.get("anchor") === null ? {} : { anchor: query.get("anchor")! }),
    ...(query.get("before") === null ? {} : { before: query.get("before")! }),
    ...(query.get("after") === null ? {} : { after: query.get("after")! }),
    ...(query.get("snapshot") === null ? {} : { snapshot: query.get("snapshot")! }),
    ...(query.get("entry") === null ? {} : { entry: query.get("entry")! }),
    ...(query.get("block") === null ? {} : { block: query.get("block")! }),
  });
  if (!parsed.ok) return refusalAnswer(conversationId, parsed.code, 400, parsed.error);
  try {
    return { status: 200, body: await readNavigationTarget(reader, parsed.request) };
  } catch (error) {
    if (!(error instanceof ConversationNavigationRefusal)) throw error;
    return refusalAnswer(conversationId, error.code, error.status, error.message, error.data);
  }
}

/** The status and body one outline request answers. */
export type NavigationAnswer = { readonly status: number; readonly body: unknown };

/**
 * The HTTP adapter: a thin translation of the query into the read's own request and the answer into the wire shape,
 * holding no second implementation of the bounds, the ordering or the scope rule. A route caller and any other
 * consumer of the outline therefore cannot be handed two different histories, and a refusal is the core's own code and
 * status rather than a message matched on.
 *
 * Query: `limit` (default 100, capped at 200), `cursor` (a page's ordering cursor, exclusive), `scope` (the scope a
 * previous page stated, refused by name when the head marker moved).
 */
export async function handleConversationNavigation(history: NavigationHistory, conversationId: string, query: URLSearchParams): Promise<NavigationAnswer> {
  const parsed = parseNavigationPageRequest({
    ...(query.get("limit") === null ? {} : { limit: query.get("limit")! }),
    ...(query.get("cursor") === null ? {} : { cursor: query.get("cursor")! }),
    ...(query.get("scope") === null ? {} : { scope: query.get("scope")! }),
  });
  if (!parsed.ok) return refusalAnswer(conversationId, parsed.code, 400, parsed.error);
  try {
    return { status: 200, body: await readNavigationOutline(history, parsed.request) };
  } catch (error) {
    if (!(error instanceof ConversationNavigationRefusal)) throw error;
    return refusalAnswer(conversationId, error.code, error.status, error.message, error.data);
  }
}
