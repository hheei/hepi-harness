import type { AgentMessage } from "./types";
import {
  advance,
  type Acquisition,
  type Input,
  type Observation,
  type SessionEntry,
  type Step,
  type Submission,
} from "./lifecycle-projection";

/**
 * The browser's half of the ordering contract: what the durable wire states, and the acquisition generation a read or a
 * stream is stamped with when it begins.
 *
 * The backend's revision is a counter per attachment instance, not a native commit sequence, so two attachments are two
 * clocks and only their opaque projection identity can tell them apart (spec decision 2). The client's own generation is
 * therefore stamped *when an acquisition begins* — never when a response arrives — and every callback of that
 * acquisition carries the number it was stamped with. A read whose answer lands after a newer acquisition began is
 * fenced out by the fold instead of overwriting a fresher view, which is exactly what cancellation alone cannot do: a
 * response may already be queued when the read is abandoned.
 *
 * The sequence has one owner: the generation the projection has accepted. A caller asks for the next one from that
 * number rather than keeping a counter of its own, so a projection restored from page memory — with the generation it
 * had already reached — cannot be handed reads and streams numbered below it and fence its own mount's frames out.
 *
 * This module only names the wire and turns it into observations. It owns no socket, timer or store, and it performs no
 * I/O: the caller opens the read and the stream and calls advance() with what this returns.
 */

/**
 * The generation to stamp a read or a stream with as it begins, given the generation the projection has accepted. It is
 * always strictly newer, which is what the fold requires of an acquisition that opens a new one.
 */
export function nextAcquisition(accepted: Acquisition): Acquisition {
  return accepted + 1;
}

/**
 * One submission as the durable wire states it: the protocol's own projection of a durable record. The answer identity
 * a terminal input was answered by travels here, and it is the only key a completion notice may be grouped by.
 */
export type WireSubmission = {
  readonly protocol?: string;
  readonly conversationId?: string;
  readonly submissionId: string;
  readonly requestId?: string;
  readonly type: "input" | "write";
  readonly status: "queued" | "placed" | "done" | "unanswered";
  readonly entryId?: string;
  readonly answerId?: string;
  readonly reason?: string;
};

/**
 * One complete lifecycle frame, the shape both transports carry: the stream's state frame and the HTTP conversation
 * read. `sessionId` is the conversation the frame is about, and `context` is the committed transcript as the adapter
 * reports it — the entry ids and the messages they belong to, index for index.
 */
export type LifecycleFrame = {
  readonly sessionId: string;
  readonly projectionId: string;
  readonly revision: number;
  readonly run: null | { readonly inputs: readonly string[] };
  readonly submissions?: readonly WireSubmission[];
  readonly context: { readonly messages: readonly AgentMessage[]; readonly entryIds: readonly string[] };
};

/** The stream's live frame about one submission. It is a statement about a turn, not a projection of the conversation. */
export type LifecycleRecordFrame = { readonly sessionId: string; readonly submission: WireSubmission };

/** Pair the committed transcript's ids with the messages they belong to, which is what the projection folds. */
function entriesOf(frame: LifecycleFrame): readonly SessionEntry[] {
  return frame.context.entryIds.map((id, index) => ({ id, message: frame.context.messages[index] }));
}

/**
 * Every field the projection consumes, carried across rather than dropped: an absent identity stays absent instead of
 * becoming an invented one, and a terminal input keeps the answer it was answered by.
 */
function submissionOf(record: WireSubmission): Submission {
  return {
    type: record.type,
    submissionId: record.submissionId,
    status: record.status,
    ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
    ...(record.entryId === undefined ? {} : { entryId: record.entryId }),
    ...(record.answerId === undefined ? {} : { answerId: record.answerId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

/** One complete projection, from the HTTP conversation read or from the stream's state frame. */
export function snapshotObservation(frame: LifecycleFrame, acquisition: Acquisition, via: "http" | "sse"): Observation {
  return {
    kind: "snapshot",
    conversationId: frame.sessionId,
    acquisition,
    via,
    snapshot: {
      projectionId: frame.projectionId,
      revision: frame.revision,
      data: { entries: entriesOf(frame) },
      run: frame.run,
      submissions: (frame.submissions ?? []).map(submissionOf),
    },
  };
}

/** One live lifecycle fact the stream delivered about a submission, fenced by the connection it arrived on. */
export function lifecycleObservation(frame: LifecycleRecordFrame, acquisition: Acquisition): Observation {
  return {
    kind: "lifecycle",
    conversationId: frame.sessionId,
    acquisition,
    records: [submissionOf(frame.submission)],
  };
}

/**
 * A read or a stream that failed, stamped with the acquisition it began under. It names no conversation: a failure is
 * about the attempt, not about a fact of some conversation, so the fold only reports it against the scope it holds.
 */
export function unavailableObservation(acquisition: Acquisition, reason: string, requestId?: string): Input {
  return { kind: "unavailable", acquisition, reason, ...(requestId === undefined ? {} : { requestId }) };
}

/**
 * The facts every transport carries beside the window, as the receiver publishes them once the fold has accepted the
 * statement. `session` is the transport's own complete committed-transcript payload — published as it was received,
 * because what it contains beyond the entries (the window's boundary and head, the model and the reasoning level) is
 * the same payload on both transports.
 */
export type AcceptedFacts<TSession> = {
  /** The complete committed-transcript payload of this statement, published whole. */
  readonly session: TSession;
  /** The newest head marker's id, or null when the conversation has none. */
  readonly historyHead: string | null;
  /** The conversation's active leaf, which the runtime's own view states. */
  readonly leafId: string | null;
  /**
   * The outstanding queue, when this transport states it. The stream's own frame carries it; the HTTP conversation read
   * does not, and its queue arrives on the separate agent-state read, so an absent value publishes nothing here.
   */
  readonly queuedMessages?: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
};

/**
 * A normalized lifecycle statement, from either transport, as the one receiver consumes it: the acquisition its
 * callbacks belong to, the input the pure fold takes, the **common accepted facts** the receiver publishes, and a
 * source tag naming which transport stated it.
 *
 * The tag is a name for the one difference the two transports actually have — what each must do beside the window —
 * and it is deliberately not an origin dispatch: nothing downstream switches on it to decide what a fact means. What a
 * statement means is the fold's decision, taken once, and the receiver below applies the *same* decision to the shared
 * facts of both transports. `facts` is null only for a statement that is not a projection at all — a lifecycle fact, a
 * failure, a read that names no attachment — because there is no window for such a statement to carry facts beside.
 */
export type AcceptedStatement<TSession = never> = {
  readonly source: "http" | "sse";
  readonly acquisition: Acquisition;
  readonly input: Input;
  readonly facts: AcceptedFacts<TSession> | null;
};

/**
 * One complete projection as a transport published it: everything the fold consumes (the attachment's identity with
 * its revision, the native run, the outstanding submissions and the committed transcript) plus the facts that travel
 * beside the window (the active leaf, the head marker and the queue). Both transports publish this shape, so both feed
 * the same builder, and the published payload is the read itself — the receiver hands the caller's own object back
 * rather than rebuilding it field by field.
 */
export type AcceptedRead<TMessage = AgentMessage> = {
  readonly sessionId: string;
  readonly projectionId?: string;
  readonly revision?: number;
  readonly run: null | { readonly inputs: readonly string[] };
  readonly submissions?: readonly WireSubmission[];
  readonly context: { readonly messages: readonly TMessage[]; readonly entryIds: readonly string[] };
  readonly leafId: string | null;
  readonly historyHead?: string | null;
  readonly queuedMessages?: { readonly steering?: readonly string[]; readonly followUp?: readonly string[] } | null;
};

/** The facts of one read, typed to the read itself so the receiver publishes the caller's own payload. */
function factsOf<TSession>(read: TSession & AcceptedRead): AcceptedFacts<TSession> {
  return {
    session: read,
    historyHead: read.historyHead ?? null,
    leafId: read.leafId,
    ...(read.queuedMessages === undefined || read.queuedMessages === null ? {} : { queuedMessages: normalizeQueue(read.queuedMessages) }),
  };
}

/** The lifecycle frame of one read: what the pure fold orders, read off the payload the transport published. */
function frameOf(read: AcceptedRead): LifecycleFrame {
  return {
    sessionId: read.sessionId,
    projectionId: read.projectionId ?? "",
    revision: read.revision ?? 0,
    run: read.run ?? null,
    submissions: read.submissions ?? [],
    context: read.context,
  };
}

/**
 * A complete projection from the HTTP conversation read. A read that names no attachment is not a lifecycle statement
 * at all — there is nothing for the fold to order — so it carries no facts and the caller publishes its payload as the
 * transcript it is.
 */
export function httpStatement<TSession>(read: TSession & AcceptedRead, acquisition: Acquisition): AcceptedStatement<TSession> {
  return {
    source: "http",
    acquisition,
    input: snapshotObservation(frameOf(read), acquisition, "http"),
    facts: read.projectionId === undefined ? null : factsOf(read),
  };
}

/** A complete projection from the stream's own state frame. */
export function sseStatement<TSession>(read: TSession & AcceptedRead, acquisition: Acquisition): AcceptedStatement<TSession> {
  return {
    source: "sse",
    acquisition,
    input: snapshotObservation(frameOf(read), acquisition, "sse"),
    facts: factsOf(read),
  };
}

/** The queue as the wire states it, with an absent list meaning the empty one. */
function normalizeQueue(queue: { readonly steering?: readonly string[]; readonly followUp?: readonly string[] }): { readonly steering: readonly string[]; readonly followUp: readonly string[] } {
  return { steering: queue.steering ?? [], followUp: queue.followUp ?? [] };
}

/** One live lifecycle fact the stream delivered about a submission. It states no window, so it carries no facts. */
export function submissionStatement(frame: LifecycleRecordFrame, acquisition: Acquisition): AcceptedStatement {
  return { source: "sse", acquisition, input: lifecycleObservation(frame, acquisition), facts: null };
}

/** A read or a stream that failed. It states no window, so it carries no facts. */
export function unavailableStatement(acquisition: Acquisition, reason: string, requestId?: string): AcceptedStatement {
  return { source: "sse", acquisition, input: unavailableObservation(acquisition, reason, requestId), facts: null };
}

/**
 * The one accepted-facts receiver: the single place a statement from either transport is folded and its **shared**
 * facts published.
 *
 * The fold is asked first and is the only authority on whether a statement is the conversation's current one — this
 * receiver does not compare revisions, mint a second clock or guard the publication with a token of its own. When the
 * fold accepted a snapshot, the receiver publishes the facts every transport carries beside the window (the attachment
 * identity and revision the fold already keeps, the committed transcript, the native run and the outstanding
 * submissions) and reports that it did, so a source-specific caller can apply what belongs to its own transport under
 * the same decision rather than under one it made up. A statement the fold refused — an older window, another
 * attachment's read, a contradicted lifecycle fact — publishes nothing here, including the facts that are not the
 * transcript.
 *
 * The receiver owns no socket, timer or store and performs no I/O: it takes a statement, folds it, and hands the
 * caller the resulting step, the view to render and the one boolean that says whether the shared facts were published.
 * What each transport does *besides* that stays with the caller, where it is explicit and testable: the HTTP read's
 * prefix migration, cache checkpoint, pagination and tool loadout, and the stream's live rendering, are not facts this
 * receiver may state.
 */
export type StatementReceipt = {
  /** The projection after the statement was folded: the view to render and the state the next statement folds onto. */
  readonly step: Step;
  /** The facts this receiver owns: the accepted transcript, the run and the outstanding submissions. */
  readonly view: Step["view"];
  /**
   * Whether the shared facts were published — the fold's own acceptance decision, reported rather than re-derived.
   * `true` only for a snapshot the fold took as the conversation's current statement, including one that restates the
   * accepted revision (a remount's read); `false` for a refused snapshot and for every non-snapshot statement, which
   * states no window and therefore publishes no beside-window fact.
   */
  readonly accepted: boolean;
};

/**
 * Fold one statement and say whether its facts are to be published. The fold is asked first and its answer is the only
 * one: a caller publishes the statement's `facts` exactly when this returns `accepted`, and never on a comparison of
 * its own.
 */
export function receiveAccepted<TSession>(step: Step, statement: AcceptedStatement<TSession>): StatementReceipt {
  const next = advance(step.state, statement.input);
  return { step: next, view: next.view, accepted: next.snapshotAccepted };
}
