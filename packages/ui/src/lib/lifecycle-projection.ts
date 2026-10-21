import type { AgentMessage } from "./types";

/**
 * One conversation's lifecycle, folded in exactly one place.
 *
 * The runtime is the only authority on a turn's outcome (ADR 0001), so the browser must not invent a second lifecycle
 * beside it. This module is the one place that decides: it validates, orders and folds observations from either
 * transport into a view, a set of notices and a set of requested effects. It owns no socket, timer, store, registry,
 * scheduler or retry queue — the transport, the hook and the shell stay the callers that perform the I/O a step
 * requests, and the two entry points here are pure.
 *
 * Vocabulary follows GLOSSARY.md: **Pending Submission** (staged, not yet in the transcript), **Committed Message**
 * (its own entry is in the transcript), **Submission Outcome Unknown** (the connection ended before either outcome).
 * The no-resend rule is ADR 0006: an unknown outcome is looked up, never replayed.
 */

/** An opaque identity the backend mints once per attachment, so two attachments' revisions are never compared. */
export type ProjectionId = string;
/** The client generation stamped when an acquisition begins; every read and callback of it captures that number. */
export type Acquisition = number;
/** The composer or conversation this projection belongs to. A fresh composer is keyed provisionally until promoted. */
export type Scope = { readonly composerKey: string; readonly conversationId?: string };
/** What a recovery lookup asks about: the browser's own request id, or a submission it learned by name. */
export type Subject = { readonly requestId: string } | { readonly submissionId: string };

/** The text and images to draw a staged turn with, and to put back in the draft when a submission is refused. */
export type StagedContent = {
  readonly text: string;
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
};

/**
 * One submission as the runtime reports it. A `done» input carries the native answer it produced — that identity, and
 * nothing else, is what a completion notice is keyed by. A write has no answer. An `unanswered» submission ended
 * without one and carries its reason (an abort, a failure, a recall the runtime cannot tell apart from a failure).
 */
export type Submission = {
  readonly type: "input" | "write";
  readonly submissionId: string;
  readonly requestId?: string;
  readonly status: "queued" | "placed" | "done" | "unanswered";
  readonly entryId?: string;
  readonly answerId?: string;
  readonly reason?: string;
};

/** One committed transcript entry, as the conversation reports it. */
export type SessionEntry = { readonly id: string; readonly message: AgentMessage };
/** The committed transcript a snapshot carries; the view keeps it whole and derives the messages from it. */
export type SessionData = { readonly entries: readonly SessionEntry[] };

/** One complete projection of a conversation, from either transport. */
export type Snapshot = {
  readonly projectionId: ProjectionId;
  readonly revision: number;
  readonly data: SessionData;
  /** The native run's inputs, or null when there is no run. An empty list is a run with nothing in it. */
  readonly run: null | { readonly inputs: readonly string[] };
  readonly submissions: readonly Submission[];
};

/**
 * What the surface knows about one send from the moment it is staged until its own entry is committed. The overlay is
 * the drawn turn; it ends at that entry and never at a busy edge or at a turn's absence from a set.
 */
export type PendingTurn = {
  readonly requestId: string;
  readonly content: StagedContent;
  readonly whenBusy: "steer" | "followUp" | "reject";
  readonly status: "staged" | "queued" | "placed" | "unknown";
  readonly submissionId?: string;
  readonly entryId?: string;
};

/** A committed user entry whose answer is not terminal yet. It survives the commitment of the message it belongs to. */
export type AnswerInterest = {
  readonly submissionId: string;
  readonly requestId?: string;
  readonly entryId?: string;
  /** The outcome could not be established (Submission Outcome Unknown) and is being looked up, never resent. */
  readonly unknown: boolean;
};

export type View = {
  /** "unread": no complete projection arrived and a read failed, so there is a state to read rather than a spinner. */
  readonly ready: "loading" | "ready" | "unread";
  readonly data?: SessionData;
  readonly messages: readonly AgentMessage[];
  readonly pending: readonly PendingTurn[];
  readonly outstanding: readonly AnswerInterest[];
  readonly activity: null | { readonly inputs: readonly string[] };
  /**
   * What the surface may truthfully say is happening, folded here rather than tracked beside the projection. A live run
   * is `running`; a turn this surface sent that the conversation has not settled is `preparation` — the work has
   * started for the user and the run has not, which is exactly the window the surface used to leave silent. Nothing in
   * flight is `idle`.
   */
  readonly phase: "idle" | "preparation" | "running";
  readonly issue?: { readonly kind: "transport" | "protocol" | "outcome-unknown"; readonly message: string };
};

/**
 * What a step observed, for the caller to act on. A notice is an outcome the user may be told about; it is never a
 * mechanism the fold implements itself.
 */
export type Notice =
  | { readonly kind: "answered"; readonly answerId: string; readonly inputs: readonly string[] }
  | { readonly kind: "unanswered"; readonly submissionId: string; readonly reason: string }
  | { readonly kind: "refused"; readonly requestId: string; readonly reason: string; readonly restore: StagedContent };

/** I/O the caller performs. The fold requests it and does none of it. */
export type Effect =
  | { readonly kind: "lookup"; readonly acquisition: Acquisition; readonly subject: Subject }
  | { readonly kind: "reattach"; readonly acquisition: Acquisition };

/** One observation from a transport, always naming the conversation it is about. */
export type Observation = { readonly conversationId: string } & (
  | {
      readonly kind: "snapshot";
      readonly acquisition: Acquisition;
      readonly via: "http" | "sse";
      readonly snapshot: Snapshot;
    }
  | { readonly kind: "lifecycle"; readonly acquisition: Acquisition; readonly records: readonly Submission[] }
  | { readonly kind: "receipt"; readonly requestId: string; readonly submissionId: string }
  | { readonly kind: "lookup"; readonly acquisition: Acquisition; readonly subject: Subject; readonly record: Submission | null }
);

/**
 * A refusal is not a fact about a conversation: it is this surface's own answer about one staged turn, which is why it
 * may name no conversation at all — a composer whose conversation could not even be created refuses its turn locally.
 * When it does name one, the projection must already be that conversation's or the refusal is a contradiction.
 */
export type Refusal = { readonly kind: "refusal"; readonly conversationId?: string; readonly requestId: string; readonly reason: string };

/** Everything the caller can feed the fold: what it observed, and what it did. */
export type Input =
  | Observation
  | Refusal
  | { readonly kind: "stage"; readonly requestId: string; readonly content: StagedContent; readonly whenBusy: "steer" | "followUp" | "reject" }
  | { readonly kind: "promote"; readonly conversationId: string }
  | { readonly kind: "begin"; readonly acquisition: Acquisition }
  // A recovery is this surface's own intent about its unresolved turns, not an observation of a conversation, so it
  // names none: the projection is already bound to the conversation whose registry it holds.
  | { readonly kind: "recover"; readonly acquisition: Acquisition }
  | { readonly kind: "unavailable"; readonly acquisition: Acquisition; readonly requestId?: string; readonly reason: string };

/**
 * The fold's whole memory. Opaque to callers: create it once per composer or conversation, pass it back to advance
 * unchanged. It holds the transcript's own data, the unresolved turns and interests, and the per-acquisition ordering
 * bookkeeping — nothing else, and nothing unbounded.
 */
export type State = {
  readonly scope: Scope;
  readonly core: Core;
  readonly generation: Acquisition;
  readonly identity: ProjectionId | null;
  readonly revision: number;
  readonly source: "http" | "sse" | null;
  readonly turns: readonly PendingTurn[];
  readonly interests: readonly AnswerInterest[];
  readonly notified: readonly string[];
  /**
   * The request ids of turns a recovery sweep ran while they were still staged. A staged turn has no submission
   * identity yet, so the sweep had nothing to ask about and skipped it; the receipt that later names one owes exactly
   * that question, because the settlement the sweep was looking for may have happened in between and its own frame
   * may have been the one the reconnect lost. It holds request ids, not turns: the receipt is what pairs it back to
   * the turn, and a turn that never gets one leaves nothing behind.
   */
  readonly missedRecovery: readonly string[];
};

export type Step = {
  readonly state: State;
  readonly view: View;
  readonly notices: readonly Notice[];
  readonly effects: readonly Effect[];
  /**
   * Whether the input this step folded was a snapshot the projection took as the conversation's **current statement**.
   * The ordering rules above are the only authority on a snapshot, and a caller that publishes facts carried *beside*
   * the window — the attachment's revision, the head marker, the active leaf, the run's outcome, the model and the
   * queue — has to obey the same decision: a read the fold refused may not publish them any more than it may replace
   * the window. A read that restates the accepted revision is still the current statement and does count, because a
   * remount starts with no beside-view facts at all and refusing its read would leave the conversation with none.
   * Anything that is not a snapshot — a lifecycle fact, a begin, a refusal, an unavailable read — is not a statement
   * about the window, so it says false.
   */
  readonly snapshotAccepted: boolean;
};

type Core = {
  readonly ready: View["ready"];
  readonly data?: SessionData;
  readonly messages: readonly AgentMessage[];
  readonly activity: View["activity"];
  readonly issue?: NonNullable<View["issue"]>;
};

/** The unfinished-interest registry's bound: a conversation with more outstanding turns than this is not a real one. */
export const MAX_UNFINISHED_INTERESTS = 64;
/** The answer-key dedup set's bound. It only has to outlive a reconnect, not the conversation. */
export const MAX_NOTIFIED_KEYS = 128;

type Rank = 0 | 1 | 2 | 3;
const RANK: Readonly<Record<Submission["status"], Rank>> = { queued: 1, placed: 2, done: 3, unanswered: 3 };
/** An outcome-unknown turn ranks below the queue: any fact about it is news and resolves it. */
function rankOfTurn(turn: PendingTurn): Rank {
  switch (turn.status) {
    case "staged":
    case "unknown":
      return 0;
    case "queued":
      return 1;
    case "placed":
      return 2;
  }
}
const terminal = (status: Submission["status"]): boolean => status === "done" || status === "unanswered";

/**
 * Whether a conversation still has work someone must keep watching for: a live run, a turn this surface is waiting to
 * see committed, or an answer it still expects. It is the one statement of "unfinished", so the surface that holds a
 * stream open and the background watch that inherits it cannot disagree about when the work is over.
 */
export function hasUnfinishedWork(view: View): boolean {
  return view.activity !== null || view.pending.length > 0 || view.outstanding.length > 0;
}

/**
 * The one statement of the work in flight. `preparation` is a turn this surface sent that the conversation has not
 * settled — staged, queued or placed and still awaiting its answer — and a live run is `running`. An unknown outcome
 * is deliberately neither: its own state says the surface cannot tell what happened, so a status claiming progress
 * would be the lie the fold exists to prevent.
 */
function phaseOf(core: Core, turns: readonly PendingTurn[], interests: readonly AnswerInterest[]): View["phase"] {
  if (core.activity !== null) return "running";
  const inFlight = turns.some((turn) => turn.status !== "unknown") || interests.some((interest) => !interest.unknown);
  return inFlight ? "preparation" : "idle";
}

function viewOf(state: State): View {
  return {
    ...state.core,
    pending: state.turns,
    outstanding: state.interests,
    phase: phaseOf(state.core, state.turns, state.interests),
  };
}

function stepOf(state: State, notices: readonly Notice[] = [], effects: readonly Effect[] = [], snapshotAccepted = false): Step {
  return { state, view: viewOf(state), notices, effects, snapshotAccepted };
}

/** A contradiction keeps the last good view, reports it and announces nothing. */
function contradiction(state: State, message: string): Step {
  return stepOf({ ...state, core: { ...state.core, issue: { kind: "protocol", message } } });
}

function matches(entry: { readonly requestId?: string; readonly submissionId?: string }, record: Submission): boolean {
  return (record.requestId !== undefined && entry.requestId === record.requestId)
    || (entry.submissionId !== undefined && entry.submissionId === record.submissionId);
}

function findTurn(state: State, record: Submission): PendingTurn | undefined {
  return state.turns.find((turn) => matches(turn, record));
}

function findInterest(state: State, record: Submission): AnswerInterest | undefined {
  return state.interests.find((interest) => matches(interest, record));
}

function matchesSubject(entry: { readonly requestId?: string; readonly submissionId?: string }, subject: Subject): boolean {
  return "requestId" in subject ? entry.requestId === subject.requestId : entry.submissionId === subject.submissionId;
}

/** Keep the registry bounded: the newest entries stay, the oldest are forgotten. */
function bounded<T>(entries: readonly T[]): readonly T[] {
  return entries.length > MAX_UNFINISHED_INTERESTS ? entries.slice(entries.length - MAX_UNFINISHED_INTERESTS) : entries;
}

function remember(keys: readonly string[], key: string): readonly string[] {
  if (keys.includes(key)) return keys;
  const next = [...keys, key];
  return next.length > MAX_NOTIFIED_KEYS ? next.slice(next.length - MAX_NOTIFIED_KEYS) : next;
}

/** The answer interest a placed submission creates, from the turn that owns it. */
function interestOf(turn: PendingTurn, record: Submission): AnswerInterest {
  return {
    submissionId: record.submissionId,
    requestId: record.requestId ?? turn.requestId,
    entryId: record.entryId,
    unknown: false,
  };
}

/** How far a submission is known to have got, so a fact can be ordered rather than trusted. */
function knownRank(state: State, record: Submission): number {
  const turn = findTurn(state, record);
  if (turn !== undefined) return rankOfTurn(turn);
  return findInterest(state, record) === undefined ? -1 : RANK.placed;
}

/** An input that ended without naming its answer is a protocol contradiction: the notice key would be invented. */
function missingAnswer(records: readonly Submission[]): string | undefined {
  const broken = records.find((record) => record.type === "input" && record.status === "done" && record.answerId === undefined);
  return broken === undefined ? undefined : "input " + broken.submissionId + " arrived done without its answer identity";
}

/** A lifecycle frame states transitions, so one that moves a submission backwards is a contradiction, not an ordering. */
function backwards(state: State, records: readonly Submission[]): string | undefined {
  const seen = new Map<string, number>();
  for (const record of records) {
    const best = Math.max(knownRank(state, record), seen.get(record.submissionId) ?? -1);
    if (RANK[record.status] < best) return "submission " + record.submissionId + " moved backwards from " + best + " to " + RANK[record.status];
    seen.set(record.submissionId, Math.max(best, RANK[record.status]));
  }
  return undefined;
}

/**
 * Apply a set of submission facts. A snapshot is a projection, not a live outcome, so it orders facts (terminal beats
 * placed beats queued) and never regresses one — the same reason a receipt cannot put a placed turn back in the queue.
 * Only live facts produce notices.
 */
function applyFacts(
  state: State,
  records: readonly Submission[],
  live: boolean,
): { turns: readonly PendingTurn[]; interests: readonly AnswerInterest[]; notices: readonly Notice[]; notified: readonly string[]; missedRecovery: readonly string[] } {
  let turns = state.turns;
  let interests = state.interests;
  let notified = state.notified;
  const notices: Notice[] = [];
  const groups = new Map<string, string[]>();
  if (live) {
    for (const record of records) {
      if (record.type === "input" && record.status === "done" && record.answerId !== undefined) {
        groups.set(record.answerId, [...(groups.get(record.answerId) ?? []), record.submissionId]);
      }
    }
  }
  for (const record of records) {
    const turn = turns.find((candidate) => matches(candidate, record));
    const interest = interests.find((candidate) => matches(candidate, record));
    if (terminal(record.status)) {
      if (turn !== undefined) turns = turns.filter((candidate) => candidate !== turn);
      if (interest !== undefined) interests = interests.filter((candidate) => candidate !== interest);
      if (live && record.status === "unanswered") {
        const key = record.submissionId;
        if (!notified.includes(key)) {
          notified = remember(notified, key);
          notices.push({ kind: "unanswered", submissionId: record.submissionId, reason: record.reason ?? "" });
        }
      }
      continue;
    }
    if (record.status === "placed") {
      if (turn !== undefined) {
        turns = turns.filter((candidate) => candidate !== turn);
        interests = bounded([...interests, interestOf(turn, record)]);
      } else if (interest !== undefined) {
        interests = interests.map((candidate) => candidate === interest ? { ...candidate, entryId: record.entryId ?? candidate.entryId, unknown: false } : candidate);
      }
      continue;
    }
    if (turn !== undefined && rankOfTurn(turn) < RANK.queued) {
      turns = turns.map((candidate) => candidate === turn ? { ...candidate, submissionId: record.submissionId, status: "queued" } : candidate);
    } else if (interest !== undefined && interest.unknown) {
      interests = interests.map((candidate) => candidate === interest ? { ...candidate, unknown: false } : candidate);
    }
  }
  if (live) {
    for (const [answerId, inputs] of groups) {
      if (notified.includes(answerId)) continue;
      notified = remember(notified, answerId);
      notices.push({ kind: "answered", answerId, inputs });
    }
  }
  // A turn a fact has moved out of the staged state carries its receipt or its settlement itself, so the question a
  // recovery sweep owed it is not owed any more. A turn the facts left staged keeps it.
  const missedRecovery = state.missedRecovery.length === 0
    ? state.missedRecovery
    : state.missedRecovery.filter((requestId) => turns.some((turn) => turn.requestId === requestId && turn.status === "staged"));
  return { turns, interests, notices, notified, missedRecovery };
}

function begin(state: State, acquisition: Acquisition): Step {
  if (acquisition <= state.generation) return stepOf(state);
  // A new acquisition fences every callback of an older one; it does not discard what the accepted view already knows.
  // Keeping the accepted identity is what makes the two transports' rules tell apart: a stream acquisition selects the
  // identity for its generation, so a snapshot from another attachment rebases onto it, while an HTTP read that follows
  // one may only keep the accepted view and ask for a fresh acquisition — an opaque identity has no numerical order, so
  // a newer generation must not turn "another backend" into "the current one".
  return stepOf({ ...state, generation: acquisition });
}

/** Fence a callback against the acquisition that is current: an older generation is a callback nobody waits for. */
function fence(state: State, acquisition: Acquisition): State | null {
  if (acquisition < state.generation) return null;
  return begin(state, acquisition).state;
}

function applySnapshot(state: State, observation: Extract<Observation, { kind: "snapshot" }>): Step {
  const { acquisition, via, snapshot } = observation;
  const fenced = fence(state, acquisition);
  if (fenced === null) return stepOf(state);
  const problem = missingAnswer(snapshot.submissions);
  if (problem !== undefined) return contradiction(fenced, problem);
  if (fenced.identity !== null && fenced.identity !== snapshot.projectionId) {
    // A different attachment is a different clock. Only a stream acquisition may rebase onto it; an HTTP read from
    // another identity keeps the accepted view and asks for a fresh acquisition instead of overwriting it.
    if (via !== "sse") return stepOf(fenced, [], [{ kind: "reattach", acquisition: fenced.generation }]);
  } else if (fenced.identity === snapshot.projectionId && snapshot.revision <= fenced.revision) {
    // An older revision of the accepted attachment is not this conversation's current statement, so the caller may
    // publish nothing from it. One that **restates** the accepted revision is: it says exactly what the projection
    // already holds, which is what makes a remount's first read — the one that states the revision the restored
    // projection reached — the current statement whose beside-view facts the caller still owes.
    return stepOf(fenced, [], [], snapshot.revision === fenced.revision);
  }
  const facts = applyFacts(fenced, snapshot.submissions, false);
  const core: Core = {
    ready: "ready",
    data: snapshot.data,
    messages: snapshot.data.entries.map((entry) => entry.message),
    activity: snapshot.run === null ? null : { inputs: snapshot.run.inputs },
  };
  // This snapshot is the conversation's current statement, whether it advanced the revision or restated it: the
  // beside-view facts the caller publishes travel with it, so the fold reports that decision here rather than leaving
  // every caller to compare revisions of its own.
  return stepOf({
    ...fenced,
    core,
    identity: snapshot.projectionId,
    revision: snapshot.revision,
    source: via,
    turns: facts.turns,
    interests: facts.interests,
    missedRecovery: facts.missedRecovery,
  }, [], [], true);
}

function applyLifecycle(state: State, observation: Extract<Observation, { kind: "lifecycle" }>): Step {
  const fenced = fence(state, observation.acquisition);
  if (fenced === null) return stepOf(state);
  const problem = missingAnswer(observation.records) ?? backwards(fenced, observation.records);
  if (problem !== undefined) return contradiction(fenced, problem);
  const facts = applyFacts(fenced, observation.records, true);
  return stepOf({ ...fenced, turns: facts.turns, interests: facts.interests, notified: facts.notified, missedRecovery: facts.missedRecovery }, facts.notices);
}

function applyReceipt(state: State, requestId: string, submissionId: string): Step {
  const turn = state.turns.find((candidate) => candidate.requestId === requestId);
  const owed = state.missedRecovery.includes(requestId);
  const settled: State = owed ? { ...state, missedRecovery: state.missedRecovery.filter((candidate) => candidate !== requestId) } : state;
  // A turn the conversation already admitted is not the receipt's to move, and a receipt for a turn this projection no
  // longer holds owes nothing: a later recovery asks about a turn by the name it now has.
  if (turn === undefined || rankOfTurn(turn) >= RANK.queued) return stepOf(settled);
  const next: State = { ...settled, turns: settled.turns.map((candidate) => candidate === turn ? { ...candidate, submissionId, status: "queued" as const } : candidate) };
  // A receipt for a turn a recovery sweep ran past while it was still staged is the one fact that says the question is
  // still owed: the sweep had no identity to ask about, the receipt has now given it one, and the submission may have
  // settled in between while its own frame was the one the reconnect lost. The lookup is asked by the request id the
  // browser generated — the same one the sweep would have used — and never becomes a resend or an inference from the
  // transcript.
  if (!owed) return stepOf(next);
  return stepOf(next, [], [{ kind: "lookup", acquisition: state.generation, subject: { requestId } }]);
}

function applyRefusal(state: State, requestId: string, reason: string): Step {
  const turn = state.turns.find((candidate) => candidate.requestId === requestId);
  if (turn === undefined) return stepOf(state);
  return stepOf(
    {
      ...state,
      turns: state.turns.filter((candidate) => candidate !== turn),
      // A refused turn will never carry a receipt, so the question its sweep owed is not owed any more.
      missedRecovery: state.missedRecovery.filter((candidate) => candidate !== requestId),
    },
    [{ kind: "refused", requestId, reason, restore: turn.content }],
  );
}

function applyLookup(state: State, observation: Extract<Observation, { kind: "lookup" }>): Step {
  const fenced = fence(state, observation.acquisition);
  if (fenced === null) return stepOf(state);
  const turn = fenced.turns.find((candidate) => matchesSubject(candidate, observation.subject));
  const interest = fenced.interests.find((candidate) => matchesSubject(candidate, observation.subject));
  if (observation.record === null) {
    // Absence is not a fact: the interest stays outstanding and unknown, and is never rejected or resent (ADR 0006).
    return stepOf({
      ...fenced,
      turns: fenced.turns.map((candidate) => candidate === turn ? { ...candidate, status: "unknown" } : candidate),
      interests: fenced.interests.map((candidate) => candidate === interest ? { ...candidate, unknown: true } : candidate),
      core: { ...fenced.core, issue: { kind: "outcome-unknown", message: "the submission's outcome is not known" } },
    });
  }
  // A recovery lookup repairs state silently; it is never a success signal.
  const facts = applyFacts(fenced, [observation.record], false);
  return stepOf({ ...fenced, turns: facts.turns, interests: facts.interests, missedRecovery: facts.missedRecovery, core: { ...fenced.core, issue: undefined } });
}

/**
 * Ask about every turn this projection is still waiting on. The registry of unresolved turns is the fold's own, so the
 * fold enumerates it rather than the caller: a connection that dropped or a stream that re-established may have missed
 * the frame that settled a turn, and the only honest answer is to ask the conversation about each one by the identity it
 * was sent under. It is deliberately not an inference from a later frame — a frame says what is outstanding now, not
 * what settled in between — and it is never a resend (ADR 0006). Every subject is asked about once.
 */
function applyRecover(state: State, acquisition: Acquisition): Step {
  const fenced = fence(state, acquisition);
  if (fenced === null) return stepOf(state);
  const subjects: Subject[] = [];
  const seen = new Set<string>();
  const ask = (subject: Subject) => {
    const key = "requestId" in subject ? "r:" + subject.requestId : "s:" + subject.submissionId;
    if (seen.has(key)) return;
    seen.add(key);
    subjects.push(subject);
  };
  // A turn still staged has not been dispatched yet, so its own send owns its outcome and there is nothing to ask
  // about; every turn the conversation admitted — queued, placed or already unknown — is asked about by name. What a
  // staged turn does owe is the question itself once its receipt names the submission: the sweep that could not ask is
  // recorded here, and the receipt that gives the turn an identity emits the lookup.
  const missed = bounded([...fenced.missedRecovery, ...fenced.turns.filter((turn) => turn.status === "staged" && !fenced.missedRecovery.includes(turn.requestId)).map((turn) => turn.requestId)]);
  const swept: State = missed.length === fenced.missedRecovery.length ? fenced : { ...fenced, missedRecovery: missed };
  for (const turn of swept.turns) if (turn.status !== "staged" && turn.requestId !== undefined) ask({ requestId: turn.requestId });
  for (const interest of swept.interests) ask(interest.requestId === undefined ? { submissionId: interest.submissionId } : { requestId: interest.requestId });
  if (subjects.length === 0) return stepOf(swept);
  const requested = (candidate: { readonly requestId?: string; readonly submissionId?: string }) => (
    candidate.requestId === undefined ? seen.has("s:" + candidate.submissionId) : seen.has("r:" + candidate.requestId)
  );
  return stepOf(
    {
      ...swept,
      turns: swept.turns.map((turn) => turn.status !== "staged" && requested(turn) ? { ...turn, status: "unknown" } : turn),
      interests: swept.interests.map((interest) => requested(interest) ? { ...interest, unknown: true } : interest),
      core: { ...swept.core, issue: { kind: "outcome-unknown", message: "the outcome of a turn is not known" } },
    },
    [],
    subjects.map((subject) => ({ kind: "lookup", acquisition: swept.generation, subject })),
  );
}

function applyUnavailable(state: State, observation: Extract<Input, { kind: "unavailable" }>): Step {
  const fenced = fence(state, observation.acquisition);
  if (fenced === null) return stepOf(state);
  if (observation.requestId === undefined) {
    // A read that failed with nothing to show is a state, not an endless spinner; after a good projection the view stays.
    const ready = fenced.core.ready === "loading" ? "unread" : fenced.core.ready;
    return stepOf({ ...fenced, core: { ...fenced.core, ready, issue: { kind: "transport", message: observation.reason } } });
  }
  const requestId = observation.requestId;
  const turn = fenced.turns.find((candidate) => candidate.requestId === requestId);
  const interest = fenced.interests.find((candidate) => candidate.requestId === requestId);
  if (turn === undefined && interest === undefined) return stepOf(state);
  return stepOf(
    {
      ...fenced,
      turns: fenced.turns.map((candidate) => candidate === turn ? { ...candidate, status: "unknown" } : candidate),
      interests: fenced.interests.map((candidate) => candidate === interest ? { ...candidate, unknown: true } : candidate),
      core: { ...fenced.core, issue: { kind: "outcome-unknown", message: observation.reason } },
    },
    [],
    [{ kind: "lookup", acquisition: fenced.generation, subject: { requestId } }],
  );
}

function applyObservation(state: State, observation: Observation): Step {
  const bound = state.scope.conversationId;
  if (bound !== undefined && bound !== observation.conversationId) {
    return contradiction(state, "the fact names conversation " + observation.conversationId + ", not " + bound);
  }
  const scoped: State = bound === undefined ? { ...state, scope: { ...state.scope, conversationId: observation.conversationId } } : state;
  switch (observation.kind) {
    case "snapshot":
      return applySnapshot(scoped, observation);
    case "lifecycle":
      return applyLifecycle(scoped, observation);
    case "receipt":
      return applyReceipt(scoped, observation.requestId, observation.submissionId);
    case "lookup":
      return applyLookup(scoped, observation);
  }
}

/**
 * The user message to draw for one staged turn. It is presentation of the overlay's own value, so the surface shows a
 * send without owning it in the transcript: the transcript is what the conversation reports and does not hold it yet.
 */
export function pendingMessage(turn: PendingTurn): AgentMessage {
  const images = turn.content.images;
  const imageBlocks = images?.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType, data: image.data } }));
  const content = imageBlocks?.length
    ? [...(turn.content.text.trim() ? [{ type: "text" as const, text: turn.content.text }] : []), ...imageBlocks]
    : turn.content.text;
  return { role: "user", content, timestamp: 0 } as AgentMessage;
}

/** Start a projection. It is loading with nothing to show: a lifecycle frame alone never claims hydration. */
export function createProjection(scope: Scope): Step {
  const state: State = {
    scope,
    core: { ready: "loading", messages: [], activity: null },
    generation: 0,
    identity: null,
    revision: -1,
    source: null,
    turns: [],
    interests: [],
    notified: [],
    missedRecovery: [],
  };
  return stepOf(state);
}

/** Fold one input into the conversation's view. Pure: it opens nothing and runs nothing. */
export function advance(state: State, input: Input): Step {
  switch (input.kind) {
    case "stage": {
      if (state.turns.some((turn) => turn.requestId === input.requestId)) return stepOf(state);
      const turn: PendingTurn = { requestId: input.requestId, content: input.content, whenBusy: input.whenBusy, status: "staged" };
      return stepOf({ ...state, turns: [...state.turns, turn] });
    }
    case "promote": {
      if (state.scope.conversationId !== undefined && state.scope.conversationId !== input.conversationId) {
        return contradiction(state, "the projection is bound to conversation " + state.scope.conversationId);
      }
      return stepOf({ ...state, scope: { ...state.scope, conversationId: input.conversationId } });
    }
    case "begin":
      return begin(state, input.acquisition);
    case "recover":
      return applyRecover(state, input.acquisition);
    case "refusal": {
      const bound = state.scope.conversationId;
      if (input.conversationId !== undefined && bound !== undefined && bound !== input.conversationId) {
        return contradiction(state, "the refusal names conversation " + input.conversationId + ", not " + bound);
      }
      return applyRefusal(state, input.requestId, input.reason);
    }
    case "unavailable":
      return applyUnavailable(state, input);
    default:
      return applyObservation(state, input);
  }
}
