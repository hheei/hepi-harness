import type { ServerDelta, ServerEntry, ServerResyncFrame, ServerSnapshot } from "@hepi/protocol";

/**
 * One entry as this client holds it: the server's own entry — its id, its role and the `text` rendering of it — beside
 * the native payload the runtime committed (`message`).
 *
 * The payload is **kept, never re-derived**: a consumer that renders text and one that reads the structured message
 * read one object, and the deferred-block metadata inside it travels with it. It is declared optional only because a
 * caller may assemble entries of its own; every entry this client folds from a frame carries it.
 */
export type HeldEntry<TMessage = unknown> = Omit<ServerEntry<TMessage>, "message"> & { readonly message?: TMessage };

/**
 * One conversation as this client holds it. `entries` is the **loaded transcript**: the newest window the server
 * published, plus the earlier entries a caller paged in. `oldestEntryId` and `hasMore` are the server's own
 * statement about its window, so a caller can trim to it or page behind it rather than guessing from what it holds.
 *
 * Every other field a frame stated rides along unchanged, so the state is declared as the wire's own snapshot with the
 * fields the fold itself reads overridden: the frame's metadata — the run, the outstanding submissions, the live
 * message and tools, the settings and the queues — is what a lifecycle consumer reads, and a state that dropped what
 * it did not interpret would make every caller re-derive it.
 *
 * `historyHead` is the head marker the held transcript was loaded **under**, which is the one input that tells an
 * ordinary advance from a compaction or a reset. It is written only after a frame has been decided, so the decision
 * reads the head this state was loaded under and the frame's own head is what the state then holds.
 */
export type SessionState<TMessage = unknown> = Partial<Omit<ServerSnapshot<TMessage>, "protocol" | "conversationId" | "revision" | "entries" | "partial" | "busy">> & {
  protocol: "hepi.v1";
  conversationId: string;
  revision: number;
  /** The loaded transcript: the server's window, plus the earlier pages the caller asked for. */
  entries: readonly HeldEntry<TMessage>[];
  partial: string;
  busy: boolean;
  historyHead?: string | null;
  /** The fold's own signal that this state cannot continue the stream; never a field of a frame. */
  resyncRequired?: boolean;
};

/**
 * A stream's continuity before any frame has arrived: a state bound to the conversation and stating no window.
 *
 * It is stated once here because every reader of a conversation's stream begins from it — the transport that owns the
 * one source, the Web surface that shows it and the Web background watch that keeps it — and a reader that began from
 * a state bound to a **different** conversation would have every frame it received refused as another stream's.
 */
export function emptyStreamState<TMessage = unknown>(conversationId: string): SessionState<TMessage> {
  return { protocol: "hepi.v1", conversationId, revision: 0, entries: [], partial: "", busy: false };
}

/**
 * The history a reader paged in, decided against the window the server just published.
 *
 * A page holds two stores and this is the rule that keeps them apart. The **window** is what the server gave: a
 * bounded suffix of the active range, authoritative for everything it covers. The **prefix** is what the reader asked
 * for: the older pages behind it. The prefix is history, and a window that moves must not delete it — a reader who
 * scrolled back should not lose the message they are reading when the next turn arrives.
 *
 * Every input is a **history fact or an id**: the newest head marker, the window's own ids, and which ids the previous
 * window held. Nothing here is keyed on an attachment identity, and that is the point — a reconnect is a new lifecycle
 * clock for the same history, so a rule that treated a reattachment as "different history" would throw the loaded pages
 * away on every reconnect, which is exactly the behaviour this replaces.
 *
 * Comparison is by **identity**, never by comparing id values: the runtime's ids are not ordered the way a numeric
 * comparison assumes (a compaction's summary is kept first while carrying a newer id than the entries it heads), so
 * "which of these ids does the window still hold" is asked as set membership and answered exactly.
 *
 * The history token is deliberately **not** an input. Its "nothing committed since" case is not a separate rule: an
 * unchanged token means an unchanged window, and the id computation below then returns the prefix untouched with
 * nothing to migrate — the same answer, derived rather than short-circuited. Leaving it out is also what lets one
 * function serve both transports, because the stream path carries the window's ids and its head but not the token.
 *
 * This rule is the **only** implementation of it: the browser and the session reducer both call it, so a read and a
 * stream advance cannot disagree about what a moving window keeps.
 */

/** The paged prefix as the page holds it: the entries the reader loaded, and the head marker they were loaded under. */
export type LoadedPrefix<T> = {
  readonly entryIds: readonly string[];
  readonly messages: readonly T[];
  readonly historyHead: string | null;
};

/** The window the server just published, and the one it published before it. */
export type WindowFacts = {
  readonly entryIds: readonly string[];
  readonly previousEntryIds: readonly string[];
  readonly historyHead: string | null;
  readonly hasMore: boolean;
};

/**
 * The prefix after the window moved, or `null` when nothing the reader loaded remains.
 *
 * Four outcomes, in the order they are decided:
 *
 * - nothing was loaded → nothing is kept;
 * - the head marker moved → a compaction or a reset re-baselines: the prefix is **dropped**, not truncated, because the
 *   transcript on screen must stay what the model can be asked about;
 * - the window is the whole active range (`hasMore` false) → there is nothing behind it to have paged to, so the prefix
 *   is dropped;
 * - otherwise the prefix is truncated **by id** to the ids the window does not hold, and the entries the window evicted
 *   while they were loaded — the ids the previous window held and this one does not — **migrate** into it.
 *
 * The migration is the half that keeps a moving window from eating the reader's place, and it is bounded by the same
 * condition that makes it safe: it happens only when a prefix is actually loaded. A reader who never paged has nothing
 * for the evicted entries to be contiguous with, so they are dropped and a client that never paged cannot grow past the
 * server's own window.
 *
 * `messageOf` resolves a message by id — the window the page held before this one — and is only consulted for ids the
 * prefix itself does not already carry. The returned messages are the reader's own history in transcript order: the
 * kept pages first, then what the window evicted, which is always newer than they are.
 */
export function decidePrefix<T>(
  previous: LoadedPrefix<T> | null,
  window: WindowFacts,
  messageOf: (id: string) => T | undefined,
): LoadedPrefix<T> | null {
  if (previous === null) return null;
  if (previous.historyHead !== window.historyHead) return null;
  if (!window.hasMore) return null;
  const inWindow = new Set(window.entryIds);
  const kept = previous.entryIds.filter(id => !inWindow.has(id));
  if (kept.length === 0) return null;
  // An id already in the prefix is never added twice. That is not only a guard against a duplicated entry: it is what
  // makes the rule **idempotent**, so deciding twice against the same pair of windows — once where the read landed and
  // once where the window is rendered — states the same prefix instead of appending the same eviction again.
  const inKept = new Set(kept);
  const evicted = window.previousEntryIds.filter(id => !inWindow.has(id) && !inKept.has(id));
  const held = new Map(previous.entryIds.map((id, index) => [id, previous.messages[index]]));
  const ids = evicted.length === 0 ? kept : [...kept, ...evicted];
  const messages = ids.map(id => held.get(id) ?? messageOf(id)).filter((message): message is T => message !== undefined);
  return { entryIds: ids, messages, historyHead: previous.historyHead };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Fold one server frame into the state this client holds.
 *
 * A **snapshot** is the server's window, not necessarily the whole transcript: a long conversation's baseline carries
 * the newest messages and says so with `oldestEntryId` and `hasMore`. The window is **authoritative for everything
 * it covers**: the state's entries from its boundary on are replaced by it, and the entries before that boundary — the
 * history the caller paged in behind the window — are kept. An entry a previous window held and this one has dropped is
 * **evicted**: it was window content, not the caller's own history, and keeping it is how a client that never paged
 * anything ends up holding more than the server's window. A snapshot whose `oldestEntryId` is `null` states a
 * complete transcript and replaces, which is the short conversation's case.
 *
 * A frame that names this conversation but does not state its own boundary is not a window this client can fold —
 * reading it as complete is the silent history loss the boundary exists to prevent — so it is answered the way a
 * revision gap is: by asking for a fresh read.
 *
 * An **append delta** is applied only when its `baseRevision` is exactly this client's revision: it extends the
 * transcript by what it appended, takes the frame's own window bookkeeping, and trims the tail to the boundary the
 * frame states, because a frame that appends carries no window for a reader to trim against. A boundary naming an entry
 * this state does not hold is the same answer as a base it does not hold: the frame describes a window that does not
 * overlap what is held. A base the client does not hold is not "close enough" — it is a frame this client cannot continue, so it
 * is rejected without being applied and answered with a fresh read, exactly as a revision gap is.
 *
 * Which entries a moving window keeps is **not** decided here: the state is split at its own boundary and
 * `decidePrefix` — the one rule the browser calls too — states what the caller's pages become. What is kept is
 * therefore decided by whether a prefix really exists, never by whether an entry was once visible.
 *
 * The delta fold and the snapshot fold are the **same fold**: the frame's window is authoritative for everything it
 * covers, an entry the frame did not carry but the window still covers is one the caller is already holding, and the
 * entries below the window are the caller's own. So folding a sequence of advancing frames onto a baseline
 * produces exactly the state folding the equivalent snapshots would — asserted as equality, not as a similarity, in
 * `test/delta.test.ts`.
 */
export function reduceSseFrame<TMessage = unknown>(state: SessionState<TMessage>, event: string, data: unknown): SessionState<TMessage> {
  // A native frame addressed to another conversation — or to a state that was never bound to one — is not this state's
  // continuity, and "unchanged" is the one answer it must not get: a caller cannot tell an unchanged state from a frame
  // that said nothing, and the next thing it does is project the state it holds. A window published that way is an
  // empty transcript over the surface's own. So a frame this state cannot be folded by fails closed like any other.
  if ((event === "state" || event === "snapshot") && isRecord(data) && typeof data.conversationId === "string" && data.conversationId !== state.conversationId) {
    return { ...state, resyncRequired: true };
  }
  if (event === "state" && isRecord(data) && data.conversationId === state.conversationId && isDelta<TMessage>(data)) {
    if (data.baseRevision !== state.revision || data.revision <= state.revision) return { ...state, resyncRequired: true };
    // `baseRevision` and `appended` are the frame's own continuity fields, not facts about the conversation: they are
    // read here and never kept, so the state a caller holds does not accumulate wire-only keys across a long stream.
    const { baseRevision: _base, appended, ...scalars } = data;
    const entries = advanceWindow(state, data, appended);
    // A frame whose boundary this state cannot be trimmed by names a window that does not overlap what is held, so it
    // is not a frame this client can continue — the same answer a revision gap gets, and the reason nothing is applied.
    if (entries === undefined) return { ...state, resyncRequired: true };
    return { ...scalars, entries, resyncRequired: false };
  }
  if ((event === "snapshot" || event === "state") && isRecord(data) && data.conversationId === state.conversationId) {
    if (!isSnapshot<TMessage>(data)) return { ...state, resyncRequired: true };
    if (event === "state" && data.revision <= state.revision) return state;
    // A complete snapshot restates every scalar, so the frame's own values stand as they are: absence in a restatement
    // is authoritative, and keeping a held value the frame no longer states would leave a surface drawing a live
    // message or a tool slot the runtime has already ended. Only the transcript is folded, and the caller's pages below
    // the window are kept by the shared rule rather than by this statement.
    return { ...data, entries: mergeWindow(state, data), resyncRequired: false };
  }
  if (event === "resync_required" && isResync(data) && data.conversationId === state.conversationId) return { ...state, resyncRequired: true };
  // Any other event is not one this state can be folded by, so it states nothing: the native snapshot/state frames above
  // are the whole vocabulary a stream carries.
  return state;
}

export class DurableSession {
  readonly #origin: string;
  readonly #token: string;
  readonly #conversationId: string;
  readonly #fetch: Fetcher;
  #state: SessionState = emptyStreamState("");
  constructor(origin: string, token: string, conversationId: string, fetcher: Fetcher = fetch) { this.#origin = origin; this.#token = token; this.#conversationId = conversationId; this.#fetch = fetcher; this.#state = emptyStreamState(conversationId); }
  get state(): SessionState { return this.#state; }
  async submit(requestId: string, text: string): Promise<{ protocol: "hepi.v1"; requestId: string; submissionId: string }> {
    const response = await this.#fetch(this.#origin + "/api/conversations/" + encodeURIComponent(this.#conversationId) + "/messages", { method: "POST", headers: { authorization: "Bearer " + this.#token, "content-type": "application/json" }, body: JSON.stringify({ protocol: "hepi.v1", requestId, type: "conversation.submit", text }) });
    if (!response.ok) throw new Error("submit failed: " + response.status);
    return await response.json() as { protocol: "hepi.v1"; requestId: string; submissionId: string };
  }
  apply(event: string, data: unknown): SessionState { this.#state = reduceSseFrame(this.#state, event, data); return this.#state; }
  async stateSnapshot(): Promise<SessionState> {
    const response = await this.#fetch(this.#origin + "/api/conversations/" + encodeURIComponent(this.#conversationId) + "/state", { headers: { authorization: "Bearer " + this.#token } });
    if (!response.ok) throw new Error("state failed: " + response.status);
    this.#state = reduceSseFrame(this.#state, "snapshot", await response.json());
    return this.#state;
  }
}

/**
 * Where the window named by `boundary` begins inside `held`: the **position** of the boundary entry, not its id.
 *
 * Positions, because ids are not the runtime's order. A compaction's summary is kept **first** by the native view and
 * carries a *newer* id than the entries it heads, so an id comparison puts the marker on the wrong side of its own
 * boundary and keeps history the window has dropped. This is the same reason the server pages by position.
 *
 * `null` states a window that is the whole active range, so nothing precedes it. `undefined` is a state that was
 * never given a window at all — a caller that assembled its own entries — and there nothing is known to be the
 * window, so the arriving boundary is the only statement to trim by. A boundary this state does not hold constrains
 * nothing: it names a window that does not overlap what is held.
 */
function windowStart(held: readonly HeldEntry[], boundary: string | null | undefined): number {
  if (boundary === null) return 0;
  if (boundary === undefined) return held.length;
  const at = held.findIndex(entry => String(entry.id) === String(boundary));
  return at < 0 ? held.length : at;
}

/**
 * The two stores one state holds, split at the boundary the server stated: the **pages** the caller asked for
 * (everything below the boundary) and the **window** itself (from the boundary on).
 *
 * Where that split falls is the caller's own fact — a position inside what the caller holds — and it is the input the
 * shared rule is given, never a second copy of the rule.
 */
function splitHeld<TMessage>(state: SessionState<TMessage>): { readonly pages: readonly HeldEntry<TMessage>[]; readonly window: readonly HeldEntry<TMessage>[] } {
  const at = windowStart(state.entries, state.oldestEntryId);
  return { pages: state.entries.slice(0, at), window: state.entries.slice(at) };
}

/**
 * The pages this state holds, as the shared rule reads them: `null` when the caller paged nothing — the gate the
 * migration needs, because an evicted entry is only contiguous with a prefix that really exists.
 *
 * A state that never recorded a window at all — a caller that assembled its own entries — has no head its history was
 * loaded under, so the frame's own head is not a move and cannot end the prefix; `undefined` is exactly that state.
 */
function loadedPrefix<TMessage>(state: SessionState<TMessage>, pages: readonly HeldEntry<TMessage>[], historyHead: string | null): LoadedPrefix<HeldEntry<TMessage>> | null {
  if (pages.length === 0) return null;
  return { entryIds: pages.map(entry => entry.id), messages: pages, historyHead: state.historyHead === undefined ? historyHead : state.historyHead };
}

/**
 * The loaded transcript after one window: the caller's own pages, then the window itself, which is authoritative for
 * everything it covers. An entry the window evicted while it was loaded **migrates** into the pages through
 * `decidePrefix`, so a caller that paged keeps the message it was reading when the window moved, and a caller that
 * never paged drops the eviction instead of growing past the server's window.
 */
function mergeWindow<TMessage>(state: SessionState<TMessage>, frame: ServerSnapshot<TMessage>): HeldEntry<TMessage>[] {
  const { pages, window } = splitHeld(state);
  const decided = decidePrefix(
    loadedPrefix(state, pages, frame.historyHead),
    { entryIds: frame.entries.map(entry => entry.id), previousEntryIds: window.map(entry => entry.id), historyHead: frame.historyHead, hasMore: frame.hasMore },
    id => window.find(entry => entry.id === id),
  );
  return [...(decided?.messages ?? []), ...frame.entries];
}

/**
 * The loaded transcript after one advancing frame: the caller's own pages, then the **tail** — the entries the frame's
 * window still covers, extended by what it appended. `undefined` when the frame states a boundary this state cannot
 * be trimmed by, which is a frame it cannot continue exactly.
 *
 * A frame that appends carries no window for a reader to trim against, so its boundary is the whole statement of where
 * the window now starts, and the eviction is read from this state's own window. The extension covers everything held,
 * so the boundary is located in one array whether or not a prefix was loaded; the pages are still what the shared rule
 * is given, because the split is the caller's fact.
 */
function advanceWindow<TMessage>(state: SessionState<TMessage>, frame: ServerDelta<TMessage>, appended: readonly ServerEntry<TMessage>[]): HeldEntry<TMessage>[] | undefined {
  const { pages, window } = splitHeld(state);
  const extended = extendWindow(state.entries, appended);
  const at = frame.oldestEntryId === null ? 0 : extended.findIndex(entry => String(entry.id) === String(frame.oldestEntryId));
  if (frame.oldestEntryId !== null && at < 0) return undefined;
  const next = extended.slice(at);
  const decided = decidePrefix(
    loadedPrefix(state, pages, frame.historyHead),
    { entryIds: next.map(entry => entry.id), previousEntryIds: window.map(entry => entry.id), historyHead: frame.historyHead, hasMore: frame.hasMore },
    id => window.find(entry => entry.id === id),
  );
  return [...(decided?.messages ?? []), ...next];
}

/**
 * The tail store one advancing frame extends: what the client holds within the window, with the entries the frame
 * appended replacing any held copy **by id**, so a replayed frame cannot double an entry and an entry the window still
 * covers is never duplicated.
 */
function extendWindow<TMessage>(held: readonly HeldEntry<TMessage>[], appended: readonly ServerEntry<TMessage>[]): HeldEntry<TMessage>[] {
  if (appended.length === 0) return [...held];
  const ids = new Set(appended.map(entry => entry.id));
  return [...held.filter(entry => !ids.has(entry.id)), ...appended];
}
function isDelta<TMessage = unknown>(value: Record<string, unknown>): value is Record<string, unknown> & ServerDelta<TMessage> {
  return value.protocol === "hepi.v1" && typeof value.conversationId === "string" && typeof value.revision === "number"
    && typeof value.baseRevision === "number" && Array.isArray(value.appended) && !Array.isArray(value.entries)
    && typeof value.partial === "string" && typeof value.busy === "boolean"
    && (value.oldestEntryId === null || typeof value.oldestEntryId === "string") && typeof value.hasMore === "boolean";
}
function isSnapshot<TMessage = unknown>(value: unknown): value is ServerSnapshot<TMessage> { return isRecord(value) && value.protocol === "hepi.v1" && typeof value.conversationId === "string" && typeof value.revision === "number" && Array.isArray(value.entries) && typeof value.partial === "string" && typeof value.busy === "boolean" && (value.oldestEntryId === null || typeof value.oldestEntryId === "string") && typeof value.hasMore === "boolean"; }
function isResync(value: unknown): value is ServerResyncFrame { return isRecord(value) && value.protocol === "hepi.v1" && typeof value.conversationId === "string" && typeof value.revision === "number"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
