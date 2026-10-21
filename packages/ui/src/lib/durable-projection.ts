import type { LiveToolSlot, QueuedItemProjection, ServerEntry, ServerSnapshot } from "@hepi/protocol";
import type { SessionState } from "@hepi/session";
import { normalizeStreamingToolCalls, normalizeToolCalls } from "./normalize";
import type { AgentMessage } from "./types";
import type { SessionFileStats } from "./session-stats";
import type { WireSubmission } from "./lifecycle-acquisition";

/**
 * The browser's own projection of the durable wire: the **one** place the reads the Web host forwards as the backend
 * stated them become the UI shape the copied app renders.
 *
 * The Web host no longer maps the wire. `GET /api/sessions/:id`, `GET /api/sessions/:id/state`,
 * `GET /api/agent/:id`, the `get_state` command and `GET /api/sessions/:id/context` each answer the backend's own
 * payload — the native `ServerSnapshot` and the native page — and this module projects it. That is what makes the
 * browser the owner of the projection rather than a second copy of the backend's UI synthesis: the backend's
 * `entries[].message` (the committed native message, deferred-block metadata included) and every scalar it states
 * (`projectionId`, `revision`, `historyRevision`, `historyHead`, `run`, `submissions`, `settings`,
 * `extensions`, `toolNames`, `failure`) travel into the surface **as they arrived**, and nothing here re-reads
 * them from a second store.
 *
 * The shape it produces is the copied app's own `SessionData`, so the UI, the session-view cache and the lifecycle
 * statements keep working without a second adapter. Every field it states is a fact the backend stated; the payload
 * carries no session file, no active time and no branch tree, so the shape has none of them. The Web host used to
 * synthesize those three as the UI's own defaults (`""`, `0`, `[]`), which made an in-memory conversation and an
 * always-empty branch navigator look like facts. Ticket 09 retired them rather than restating a placeholder.
 */
type NativeSnapshot = ServerSnapshot<AgentMessage>;
/** The backend's own older-history page, exactly as `/api/conversations/:id/entries` answers it. */
export type NativeEntryPage = { readonly entries: readonly ServerEntry<AgentMessage>[]; readonly oldestEntryId: string | null; readonly hasMore: boolean };
/** One native frame as the backend publishes it on a conversation's stream: a complete window or an advance on one. */
export type NativeFrame = ServerSnapshot<AgentMessage> | Omit<ServerSnapshot<AgentMessage>, "entries"> & { readonly baseRevision: number; readonly appended: readonly ServerEntry<AgentMessage>[] };
export type { NativeSnapshot };

/**
 * The committed transcript as the copied app reads it. The message is the **native** entry payload, normalized in the
 * browser: an assistant tool call declared with a name field other than `toolName` is read into the shape the
 * renderer's own type states, and every other role is handed back untouched. Normalizing here rather than at the Web
 * host is what keeps the two transports from normalizing twice or disagreeing: the object the surface renders is the
 * one the backend committed.
 */
/**
 * `message` is optional on the type only because `packages/session` declares it so — a caller may assemble entries of
 * its own — and every entry either transport folds from a frame carries it. A missing one has no native payload to
 * project, which is why this reads the message rather than inventing one.
 */
export function projectMessages(entries: readonly { readonly message?: AgentMessage }[]): AgentMessage[] {
  return entries.map(entry => normalizeToolCalls(entry.message as AgentMessage));
}

/**
 * One conversation's complete lifecycle payload as the UI holds it. This is the shape the copied app already read from
 * the Web host's own projection, produced here from the native snapshot instead: the lifecycle identity with its
 * revision, the native run's inputs and the outstanding submission projections are carried through untouched, because
 * they are the facts the lifecycle fold orders and a mapping that dropped one would break a rule the client cannot
 * re-derive.
 */
export interface SessionData {
  sessionId: string;
  /** The attachment identity and this attachment's own publication counter, as the backend stated them. */
  projectionId?: string;
  revision?: number;
  /** The native run's inputs, or null for a conversation whose newest run is not in flight. */
  run?: null | { readonly inputs: readonly string[] };
  /** The outstanding submission projections, with the answer identity each terminal input was answered by. */
  submissions?: readonly WireSubmission[];
  leafId: string | null;
  toolNames?: readonly string[];
  /** Opaque freshness token for the session view cache (summary tree reads). */
  snapshotRevision?: string | null;
  /** The newest head marker's id, or null when the conversation has none. A client that sees it move re-baselines. */
  historyHead?: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    oldestEntryId: string | null;
    hasMore: boolean;
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** The framework's own outcome for the newest terminal run: a missing model or a failed request. Never an entry. */
  failure?: { reason: string; message: string } | null;
  /**
   * The pending queue as items, carried beside the transcript so the composer can act on one of them. It is the same
   * queue the live frame states, projected here because the session payload is what the surface holds (spec D09).
   */
  queuedItems?: readonly QueuedItemProjection[];
  /** The conversation's committed input control, read from the same frame the queue beside it is (spec D07, D09). */
  control?: ServerSnapshot<AgentMessage>["control"];
  /** Cumulative usage over ALL session-file entries (incl. compacted history). */
  stats?: SessionFileStats;
}

/**
 * One native snapshot as the copied app's complete session payload. Both facts the window states come from the
 * backend's own statement about the window it just published — `oldestEntryId` is the first entry it carries, and
 * `null` when it carries the whole active range — so the surface trims to that window instead of guessing from what
 * it holds.
 */
/**
 * The fields a session payload is projected from: a native snapshot, and the browser-held stream state a fold produced
 * from one. The scalars a fold may not have written yet are optional here rather than absent, because the two inputs
 * are the same facts at different points of the same fold — a held state that has accepted no frame yet is not a
 * different kind of conversation.
 */
export type SessionScalars = {
  readonly conversationId: string;
  readonly projectionId?: string;
  readonly revision?: number;
  readonly historyRevision?: string;
  readonly historyHead?: string | null;
  readonly run?: null | { readonly inputs: readonly string[] };
  readonly submissions?: readonly WireSubmission[];
  readonly entries: readonly { readonly id: string; readonly message?: AgentMessage }[];
  readonly oldestEntryId?: string | null;
  readonly hasMore?: boolean;
  readonly toolNames?: readonly string[];
  readonly settings?: { readonly model: { readonly provider: string; readonly modelId: string } | null; readonly thinkingLevel: string };
  readonly failure?: { readonly reason: string; readonly message: string } | null;
  readonly queuedItems?: readonly QueuedItemProjection[];
  readonly control?: ServerSnapshot<AgentMessage>["control"];
};

export function projectSession(snapshot: SessionScalars): SessionData {
  // A fold that has written no settings yet states no model and no reasoning level: the composer keeps what the
  // transcript shows instead of being handed a fabricated selection.
  const settings = snapshot.settings ?? { model: null, thinkingLevel: "off" };
  const selected = settings.model;
  return {
    sessionId: snapshot.conversationId,
    projectionId: snapshot.projectionId,
    revision: snapshot.revision,
    snapshotRevision: snapshot.historyRevision,
    historyHead: snapshot.historyHead,
    run: snapshot.run,
    submissions: snapshot.submissions ?? [],
    // The runtime's window states no active leaf — the wire has no branch semantics — so the value is read off the
    // window's own last entry exactly as the Web host read it, and the branch navigator it feeds stays hidden.
    leafId: snapshot.entries.at(-1)?.id ?? null,
    toolNames: snapshot.toolNames,
    context: {
      messages: projectMessages(snapshot.entries),
      entryIds: snapshot.entries.map(entry => entry.id),
      oldestEntryId: snapshot.oldestEntryId ?? null,
      hasMore: snapshot.hasMore === true,
      thinkingLevel: settings.thinkingLevel,
      model: selected === null ? null : { provider: selected.provider, modelId: selected.modelId },
    },
    failure: snapshot.failure ?? null,
    queuedItems: [...(snapshot.queuedItems ?? [])],
    // A frame that states no control states the runtime's default: an inbox no stop has ever held is `allowed`, and a
    // surface that kept a stale "held" would offer a Continue for a hold that is already gone.
    control: snapshot.control ?? { state: "allowed", revision: 0 },
  };
}

/**
 * One conversation's live state as the surfaces that read it state it: whether a run is in flight, the extensions the
 * conversation selects, and the composer's own facts — the model, the reasoning level and the queue. Every field is a
 * scalar the native snapshot carries; the fields of the old Web-host answer that were never a wire fact
 * (`contextUsage`, `systemPrompt`, the extension status and widget lists, the bash and compaction flags) stay absent,
 * exactly as they were, because absence is the honest statement that this read does not carry them.
 */
export type AgentStateView = {
  running: boolean;
  extensions: readonly string[];
  state: {
    isStreaming: boolean;
    isPromptRunning: boolean;
    model?: { provider: string; id: string };
    thinkingLevel: string;
    queuedMessages: { steering: string[]; followUp: string[] };
    /**
     * The same queue as items, with the identity, the source and the edit token each per-item control needs. It rides
     * the same frame as the text lists and the control state, so a surface that shows "held" and one that offers to
     * edit an item read them from one statement (spec D09).
     */
    queuedItems: readonly QueuedItemProjection[];
    /**
     * The conversation's committed input control, read off the same frame as the queue it governs: `held` means the
     * queued items wait for the user's own continue or immediate send.
     */
    control: { state: "allowed" | "held"; revision: number; stopSource?: "user" | "agent"; stoppedAt?: number };
  };
};

export function projectAgentState(snapshot: NativeSnapshot): AgentStateView {
  const selected = snapshot.settings.model;
  return {
    running: snapshot.busy,
    extensions: snapshot.extensions,
    state: {
      isStreaming: snapshot.busy,
      isPromptRunning: snapshot.busy,
      // A conversation with no selected model reports none: the composer keeps whatever the transcript shows instead of
      // being handed a fabricated default.
      ...(selected === null ? {} : { model: { provider: selected.provider, id: selected.modelId } }),
      thinkingLevel: snapshot.settings.thinkingLevel,
      queuedMessages: { steering: [...snapshot.queuedMessages.steering], followUp: [...snapshot.queuedMessages.followUp] },
      queuedItems: [...(snapshot.queuedItems ?? [])],
      control: { ...snapshot.control },
    },
  };
}

/**
 * The one statement of a conversation's **live** rendering, read from the same native frame as the committed window it
 * belongs to: whether a run is in flight, the partial assistant text, the assistant message the run is building, the
 * tool calls that have not finished, the queue, the resource summary and the selected extensions.
 *
 * It is stated here, beside `projectSession`, because it is the same kind of statement: a projection of the native
 * wire into the shape the copied app renders. The Web host used to build these fields while it folded the frame; now
 * the browser folds the frame and projects it here, so there is still exactly one owner of the UI shape and no second
 * mapping can drift from it.
 *
 * Absence is authoritative: a frame that states no live message, no live tools and no run says the run is over, so the
 * projection states the empty value rather than keeping whatever the previous frame carried.
 */
export type LiveProjection = {
  readonly busy: boolean;
  readonly partial: string;
  readonly liveMessage: AgentMessage | null;
  readonly liveTools: readonly LiveToolSlot[];
  readonly queuedMessages: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  /** The same queue as items, so the surface can act on one of them (spec D09). */
  readonly queuedItems: readonly QueuedItemProjection[];
  /**
   * The conversation's committed input control, read off the same frame as the queue it governs. A surface that shows
   * "held" and a surface that shows the items being held read them from one statement (spec D07, D09).
   */
  readonly control: ServerSnapshot<AgentMessage>["control"];
  readonly resources?: ServerSnapshot<AgentMessage>["resources"];
  readonly extensions: readonly string[];
};

/** The fields `projectLive` reads: a native frame and a browser-held `SessionState` are both this shape. */
export type LiveFacts = {
  readonly busy: boolean;
  readonly partial: string;
  readonly liveMessage?: AgentMessage;
  readonly liveTools?: readonly LiveToolSlot[];
  readonly queuedMessages?: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  readonly queuedItems?: readonly QueuedItemProjection[];
  readonly control?: ServerSnapshot<AgentMessage>["control"];
  readonly resources?: ServerSnapshot<AgentMessage>["resources"];
  readonly extensions?: readonly string[];
};

export function projectLive(facts: LiveFacts): LiveProjection {
  return {
    busy: facts.busy,
    partial: facts.partial,
    // The run's own message is normalized the way the streaming surface reads it: a tool call the runtime declared
    // under another name field is read into the shape the renderer's own type states, so a partial call renders as it
    // does once committed.
    liveMessage: facts.liveMessage === undefined ? null : normalizeStreamingToolCalls(facts.liveMessage),
    liveTools: facts.liveTools ?? [],
    queuedMessages: { steering: [...(facts.queuedMessages?.steering ?? [])], followUp: [...(facts.queuedMessages?.followUp ?? [])] },
    // A frame that states no items states an empty queue, exactly as the text lists do: a queue the runtime has consumed
    // must not leave rows on screen for items that are about to run.
    queuedItems: [...(facts.queuedItems ?? [])],
    // A frame that states no control states the runtime's default, which is what an inbox with no stop has: a surface
    // that kept a stale "held" would offer a Continue for a hold that is already gone.
    control: facts.control ?? { state: "allowed", revision: 0 },
    ...(facts.resources === undefined ? {} : { resources: facts.resources }),
    extensions: facts.extensions ?? [],
  };
}

/**
 * One page of older history as the surface holds it: the committed messages with the entry ids they belong to, and the
 * page's own boundary and `hasMore`.
 *
 * The page states no settings — the model and the reasoning level are the conversation's, and the accepted snapshot the
 * surface already holds is where they are read from — so this projection deliberately does not carry them: a page that
 * restated them would be a second reader of the conversation's settings beside the transcript that owns them.
 */
export type ContextPage = {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
};

export function projectContext(page: NativeEntryPage): ContextPage {
  return {
    messages: projectMessages(page.entries),
    entryIds: page.entries.map(entry => entry.id),
    oldestEntryId: page.oldestEntryId,
    hasMore: page.hasMore === true,
  };
}

