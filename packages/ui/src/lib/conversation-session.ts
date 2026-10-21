import type { AgentEventSubscription } from "@hepi/session/browser";
import type { SessionState } from "@hepi/session";
import type { AgentMessage } from "./types";
import type { AgentEventLike } from "./agent-event-wire";
import {
  operationFailure,
  type ConversationApi,
  type NativeSnapshot,
  type SubmissionRecord,
} from "./conversation-api";

/**
 * One conversation's UI I/O, owned in one place: which stream this surface has joined, which read is in flight, one
 * submission's admission, the by-id lookup that resolves an unknown outcome, an explicit reload, and the release that
 * gives the stream back.
 *
 * What this is *not* is a second lifecycle. It performs no ordering of its own: the pure fold
 * (`lib/lifecycle-projection.ts`) decides what a read or a frame means, and the surface that renders it decides, and
 * this module only carries the requests and the stream that feed that fold. It owns no timer, no retry queue and no
 * scheduler, and it opens no connection of its own — the stream it joins is the shell's one source per conversation.
 *
 * The reason it exists as a value rather than as more of the hook is the lifetime it states: a conversation's reads,
 * its one stream reader and its submission attempts all belong to **one connection and one conversation identity**, so
 * they are released together and a request made under a previous connection cannot be re-accepted by the surface that
 * replaced it. The hook owns the React state; this owns the I/O those states are read from.
 */

/** The connection seams this session is assembled with. A connection replaces them; nothing else does. */
export type ConversationSessionSeams = {
  /** The connection's own conversation API: its origin, its credential and its disposal. */
  readonly api: Pick<ConversationApi, "read" | "reload" | "submission" | "control">;
  /**
   * The shell's one source per conversation. A session joins it as a reader; it never opens a stream of its own, so the
   * open surface and a background watch of the same conversation are two readers of one source. A host that states no
   * source joins nothing, which is the same as a surface with no conversation stream at all.
   */
  readonly subscribe?: (conversationId: string, listener: (event: AgentEventLike) => void) => AgentEventSubscription<AgentMessage> | null;
};

/** What joining a stream handed this reader: the state it continues from, and the handshake to wait on. */
export type StreamJoin = {
  /**
   * The state the stream already holds, or null when this reader is the first one (or the stream could not be
   * continued). A surface that adopts it shows the window the stream has right now instead of waiting for a read.
   */
  readonly continuity: SessionState<AgentMessage> | null;
  /** Wait for the handshake, opening the stream if nobody has it open. */
  ready(): Promise<void>;
};

/** One submission attempt: the identity a lost answer is resolved by, and the content it carries. */
export type SubmissionAttempt = {
  readonly requestId: string;
  readonly text: string;
  readonly images?: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[];
  /** Queue behind the run in flight instead of admitting immediately (a steer or a follow-up). */
  readonly queueOnly?: boolean;
  readonly whenBusy?: "steer" | "followUp";
};

/** What one admission stated. The turn stays staged until its own entry is committed; this only names the record. */
export type Admission = { readonly submissionId?: string };

/**
 * One conversation's I/O for the lifetime of the surface showing it.
 *
 * Every method is an explicit operation on the connection it was assembled with, and every one of them is safe to
 * repeat: a join for the conversation already joined releases nothing, a read of the conversation already being read
 * answers from that one request, and an admission is keyed by the caller's request id rather than by this object.
 */
export class ConversationSession {
  /** The stream reader this surface holds, and the conversation it is on. */
  private joined: { readonly conversationId: string; readonly subscription: AgentEventSubscription<AgentMessage> } | null = null;
  /** Reads in flight, keyed by conversation — or by a forced read, which shares nothing. */
  private readonly reads = new Map<string, Promise<NativeSnapshot | null>>();

  constructor(private readonly seams: ConversationSessionSeams) {}

  /**
   * Join one conversation's stream through the shell's shared source.
   *
   * A join for the conversation already joined is a no-op that hands back the same continuity, so a render, a Strict
   * Mode replay or a promotion cannot restart the stream the conversation is already on. A join for another
   * conversation leaves the first: this surface reads one conversation at a time, and the one it left keeps its stream
   * only while the shell still has work to watch for.
   */
  join(conversationId: string, listener: (event: AgentEventLike) => void): StreamJoin {
    const held = this.joined;
    if (held !== null && held.conversationId === conversationId) {
      return { continuity: held.subscription.continuity(), ready: () => held.subscription.ready() };
    }
    held?.subscription.release();
    const subscription = this.seams.subscribe?.(conversationId, listener) ?? null;
    if (subscription === null) {
      this.joined = null;
      return { continuity: null, ready: async () => {} };
    }
    this.joined = { conversationId, subscription };
    return { continuity: subscription.continuity(), ready: () => subscription.ready() };
  }

  /**
   * Leave the stream. The conversation keeps it when the shell still has work to watch for: the source closes when its
   * last reader leaves, so leaving here is a withdrawal of this reader's interest and not a decision about the run.
   */
  release(): void {
    this.joined?.subscription.release();
    this.joined = null;
  }

  /**
   * Drop and reopen one conversation's stream: a restarted backend is a new attachment, not a lost reader. It does
   * nothing when this surface is not on that conversation, because another conversation's stream is not its to reset.
   */
  reconnect(conversationId: string): void {
    const held = this.joined;
    if (held === null || held.conversationId !== conversationId) return;
    held.subscription.reconnect();
  }

  /** Whether this session is currently reading the conversation named: its frames are the ones this surface folds. */
  isJoined(conversationId: string): boolean {
    return this.joined?.conversationId === conversationId;
  }

  /**
   * Read one conversation's native snapshot.
   *
   * Concurrent reads of the same conversation are one request: a mount, a stream settle and a reconcile routinely ask
   * at the same moment, and three requests would race their three answers. A forced read shares nothing — it is the
   * caller saying the answer it already had is the one it is replacing — so a Retry cannot be answered from the failed
   * flight it is recovering from.
   *
   * The snapshot is handed back untreated: whether it is the conversation's current statement, and what the surface
   * publishes from it, is the fold's decision and not this module's.
   */
  async read(conversationId: string, options: { readonly force?: boolean } = {}): Promise<NativeSnapshot | null> {
    const key = options.force === true ? `force:${conversationId}` : conversationId;
    if (options.force !== true) {
      const inflight = this.reads.get(key);
      if (inflight !== undefined) return await inflight;
    }
    const flight = this.seams.api.read(conversationId);
    this.reads.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.reads.get(key) === flight) this.reads.delete(key);
    }
  }

  /**
   * Reload this conversation's workspace resources. The Backend's own route, through this connection: what it answers
   * is a fact about the conversation's resources, and the read that follows is the surface's own.
   */
  async reload(conversationId: string): Promise<{ resources?: { pending?: boolean; skills?: number; prompts?: number } }> {
    return await this.seams.api.reload(conversationId);
  }

  /**
   * Admit one submission under the request id the caller generated.
   *
   * This is the one admission path: an immediate send, a queued steer and a queued follow-up are the same operation
   * with different queue options, so no send path can stage a turn and then reach the wire by a route of its own. A
   * refusal is thrown as the Backend stated it and an answer that never arrived is thrown as an unknown outcome — the
   * caller keeps the turn staged and resolves it by lookup, never by sending again (ADR 0006).
   */
  async send(conversationId: string, attempt: SubmissionAttempt): Promise<Admission> {
    const images = attempt.images === undefined || attempt.images.length === 0 ? undefined : { images: attempt.images };
    const answer = await this.seams.api.control(conversationId).send(attempt.requestId, attempt.text, {
      ...(attempt.queueOnly === true ? { queueOnly: true } : {}),
      ...(attempt.whenBusy === undefined ? {} : { whenBusy: attempt.whenBusy }),
      ...(images === undefined ? {} : images),
    });
    if (!answer.ok) throw operationFailure(answer);
    return { ...(answer.value.submissionId === undefined ? {} : { submissionId: answer.value.submissionId }) };
  }

  /**
   * Resolve one turn whose outcome this surface could not establish, by the request id it was sent under.
   *
   * A lookup repairs a turn's state and is silent by design: a record it finds is folded as the fact it is, and no
   * record is the honest "never admitted" rather than a rejection. Nothing here resends.
   */
  async lookup(conversationId: string, requestId: string): Promise<SubmissionRecord | null> {
    return await this.seams.api.submission(conversationId, requestId);
  }

  /**
   * Give up this session's interest: its stream reader is released and the reads it was sharing are forgotten, so a
   * replay of the setup (a Strict Mode mount, a re-created tree) joins and reads again rather than being answered by a
   * flight of the lifetime that ended. The requests themselves are the connection's, not this object's: another reader
   * may be waiting on the same one, so they are left to complete and their answers are simply no longer published
   * through this session.
   */
  dispose(): void {
    this.release();
    this.reads.clear();
  }
}
