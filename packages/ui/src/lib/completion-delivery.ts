import type { AgentEventSubscription } from "@hepi/session/browser";
import { emptyStreamState, reduceSseFrame, type SessionState } from "@hepi/session";
import type { AgentEventLike } from "./agent-event-wire";
import { projectSession } from "./durable-projection";
import type { AgentMessage } from "./types";
import {
  lifecycleObservation,
  nextAcquisition,
  snapshotObservation,
  type WireSubmission,
} from "./lifecycle-acquisition";
import { advance, createProjection, hasUnfinishedWork, type Input, type Step } from "./lifecycle-projection";

/**
 * Completion delivery: a conversation the user is not looking at still finishes, and the user is told — but only by a
 * fact the runtime actually stated on a stream that was open while the run was in flight.
 *
 * Nothing here infers a completion from a `busy` disappearance, from a turn's absence, or from a read that returned
 * after the fact — and nothing else in the page does either: this is the one place a completion tone is decided. A
 * background watch folds the same live frames through the same pure projection the open conversation uses
 * (lib/lifecycle-projection.ts), so the notice rule is one rule in one place, and an acquired baseline, a recovery
 * lookup, a resync and a reconnect are silent because the fold already says so.
 *
 * What this owns is a registry, not a scheduler: which conversations are watched, each one's place on the shared
 * stream, and the answers already noticed. The stream itself belongs to the connection the page was admitted to — its
 * one `AgentEventConnection`, reached through the workbench client's `subscribe` — so the conversation on screen and a
 * background interest in that same conversation are two readers of one stream, never two streams, and a handover
 * between them closes nothing. This registry opens no connection of its own: a second one would be a second socket to
 * the same conversation, and on the App's Gateway it would not even be the same origin.
 * The diagnostic page under apps/server joins its conversations through the same transport, assembled with its own
 * bearer source.
 *
 * What it also owns is how much of the page's connection budget the watches may spend, because it is the one place
 * that knows how many sources the page holds. A browser allows six connections per origin over HTTP/1.1 — the transport
 * the deployment serves — and the page spends them on the conversation on screen, the page's one terminal fan-in stream
 * while a terminal tab is mounted, headroom for the send POST, the lease POST and ordinary reads, and the background
 * watches. A watch over that budget is **deferred, never dropped**: it keeps its projection, its nomination and its
 * place, opens nothing, and acquires the moment a slot frees. There is no timer and no scheduler behind it — acquisition
 * is driven by the same events that already call `reconsider`.
 *
 * Interest is work in flight and nothing else, and the projection is its only statement: the poll nominates a
 * conversation it saw running, and the surface showing one hands its own projection over, so the watch that inherits a
 * conversation the user left continues from exactly the turns and interests that surface was still waiting on — rather
 * than from a flag that cannot say what it is about, which its own first terminal frame would then read as the end of
 * the work. Neither a projection with nothing in flight nor the mere fact of a conversation being on screen creates an
 * interest, because a watch that exists for no reason is a stream that is never released.
 */

/**
 * One completion the runtime stated: the conversation it belongs to, and the answer that produced it. It is both what
 * this registry reports to the caller that owns it and what a surface hands in as its own observation, so one answer is
 * one notice however many owners saw it.
 */
export type CompletionNotice = { readonly conversationId: string; readonly answerKey: string };

export interface CompletionDeliveryOptions {
  /**
   * Join one conversation's stream on the page's connection. It is the client's own subscription seam, so this
   * registry is a reader of the stream the open surface reads, never an owner of a second one.
   */
  readonly subscribe: (conversationId: string, listener: (event: AgentEventLike) => void) => AgentEventSubscription<AgentMessage>;
  /** The existing submission lookup, by the request id the browser generated. Never a resend (ADR 0006). */
  readonly lookup: (conversationId: string, requestId: string) => Promise<WireSubmission | null>;
  /**
   * A completion observed while the conversation was not on screen, already claimed by this registry: the sound for a
   * conversation the user is not looking at, and nothing else. Suppression is the caller's, because only the caller
   * knows which conversations the user is not to be told about.
   */
  readonly onAnswered: (notice: CompletionNotice) => void;
  /** A conversation whose completions are not the user's to hear about (a subagent's), claimed but never reported. */
  readonly isSuppressed?: (conversationId: string) => boolean;
}

/** One conversation's background watch: its fold, its place on the shared stream, and whose projection it holds. */
type Watch = {
  step: Step;
  /**
   * Its place on the shared stream, or null while the page's budget defers it. A deferred watch is not a lesser watch:
   * it keeps its projection and its nomination, and it is admitted as soon as a slot frees.
   */
  subscription: AgentEventSubscription<AgentMessage> | null;
  /** The poll reported this conversation running. The poll nominates; it never decides a completion. */
  nominated: boolean;
  /** The open conversation's own surface folds this conversation's frames, so this watch folds nothing. */
  dormant: boolean;
  /**
   * This watch's own stream continuity: the native state its frames are folded onto, so a delta can be assembled from
   * what it has already received. It is separate from `step`, which holds the conversation's **accepted** facts — the
   * two are different questions, and a frame this stream can continue may still be refused as the current statement.
   */
  held: SessionState<AgentMessage>;
};

/** The answer-key dedup bound: it only has to outlive a reconnect, not the conversation. */
const MAX_NOTICED_KEYS = 256;

/**
 * What the page's connections are spent on before any background watch gets one.
 *
 * A browser allows six connections per origin over HTTP/1.1, which is the transport the deployment serves, and every
 * held source on the page's origin is one of them. The conversation on screen is one — the send handshake waits on it,
 * so it is reserved and never deferred. Two are headroom, because a page that holds every connection it may open cannot
 * send a prompt, renew its lease or read anything. The page's one terminal fan-in stream is one more, and only while a
 * terminal tab is mounted. Everything left over is the background budget: three with no terminal mounted, two with one.
 * The arithmetic is derived from the pool rather than assumed, and a test asserts both numbers.
 */
const POOL_BUDGET = 6;
const SELECTED_STREAM = 1;
const HEADROOM = 2;

export class CompletionDelivery {
  private readonly watches = new Map<string, Watch>();
  private readonly noticed: string[] = [];
  private selected: string | null = null;
  /** Whether the page's one terminal fan-in stream is held: a mounted terminal tab costs one background slot. */
  private terminalHeld = false;
  private closed = false;

  constructor(private readonly options: CompletionDeliveryOptions) {}

  /**
   * Join a conversation's stream. The open conversation's own surface and a background watch both come here, and the
   * conversation's one source is opened by whichever arrives first.
   */
  subscribe(conversationId: string, listener: (event: AgentEventLike) => void): AgentEventSubscription<AgentMessage> {
    return this.options.subscribe(conversationId, listener);
  }

  /**
   * The conversations the poll saw running. A nomination opens a watch and nothing more: whether anything finished is
   * the stream's own fact, and a conversation that stops being nominated keeps its watch only while it still has work.
   */
  nominate(conversationIds: Iterable<string>): void {
    const nominated = new Set(conversationIds);
    for (const id of nominated) this.ensure(id).nominated = true;
    for (const [id, watch] of [...this.watches]) {
      if (nominated.has(id)) continue;
      watch.nominated = false;
      this.reconsider(id, watch);
    }
  }

  /**
   * The open surface hands its own projection over. What that projection is still waiting for is the interest the
   * stream is kept for, so the projection travels rather than a flag: a watch handed only "unfinished" folds its own
   * frames into a projection that never saw the surface's turns, and the first terminal fact it reads then looks like
   * the end of work the surface was still waiting on — which is how a queued follow-up's own answer was lost.
   *
   * A projection with nothing in flight is not an interest, and a watch is only made for one that has work: opening a
   * stream to be told there is nothing to watch is how a conversation nobody left keeps one forever.
   *
   * The owner's latest projection is authoritative, and that includes a settled one: while the surface is on screen
   * this watch folds nothing, so the handover is the only thing that can tell it the work it was watching for is over.
   * What is not authoritative is a projection that has accepted no fact at all — a surface that has not loaded yet. It
   * does not say the work is done, it says it does not know, and a watch that read that as an ending would lose the
   * very notice the stream is being kept for.
   */
  handover(conversationId: string | null, step: Step): void {
    if (conversationId === null) return;
    // A projection bound to another conversation is never adopted: every frame this watch then folded would
    // contradict it. One that is not bound yet is this conversation's own — a composer names its conversation only
    // once it has one.
    const bound = step.state.scope.conversationId;
    if (bound !== undefined && bound !== conversationId) return;
    // A projection that has not accepted a fact says nothing about the conversation. Its one exception is a turn the
    // surface has staged but not yet seen committed: that is a real interest, and it is the only thing such a
    // projection can be holding.
    if (step.state.identity === null && !hasUnfinishedWork(step.view)) return;
    const watch = hasUnfinishedWork(step.view) ? this.ensure(conversationId) : this.watches.get(conversationId);
    if (watch === undefined) return;
    watch.step = step;
    this.reconsider(conversationId, watch);
  }

  /**
   * Whether the page holds its one terminal fan-in stream. A mounted terminal tab spends a pool connection, so the
   * background budget shrinks by one for as long as it does: the count is global and per-origin, and a page that
   * budgeted as if terminals were free would spend the connections the budget exists to protect.
   */
  terminalStream(held: boolean): void {
    if (this.terminalHeld === held) return;
    this.terminalHeld = held;
    this.rebalance();
  }

  /**
   * The conversation the open surface is showing. Its frames belong to that surface's own projection, so the watch for
   * it keeps the stream open and folds nothing: one conversation is never folded twice by two owners, and one turn is
   * never asked about twice. Every other conversation's watch folds normally.
   */
  select(conversationId: string | null): void {
    this.selected = conversationId;
    for (const [id, watch] of [...this.watches]) {
      const dormant = id === conversationId;
      if (watch.dormant === dormant) continue;
      watch.dormant = dormant;
      // Taking the frames back is a fresh acquisition, which fences every callback of the surface's older generation.
      // What is not discarded is the projection: it is the one the surface handed over, and the work it is still
      // waiting for is exactly what the stream is kept for. Keeping it is what makes a handover lose no notice — a
      // watch that re-baselined here would read the first terminal fact of a queued group as the end of the work.
      if (!dormant) watch.step = advance(watch.step.state, { kind: "begin", acquisition: nextAcquisition(watch.step.state.generation) });
      this.reconsider(id, watch);
    }
    this.rebalance();
  }

  /**
   * Report one live completion to the page's one registry, whichever surface observed it. A duplicate frame, a second
   * reader, a handover and a reconnect all collapse to one notice per conversation and answer. The answer says whether
   * this surface is the owner that reports it: the first to name an answer sounds it, and the one that is told so is
   * the one that plays the tone.
   */
  settle(notice: CompletionNotice): boolean {
    return this.claim(notice);
  }

  private claim(notice: CompletionNotice): boolean {
    const key = notice.conversationId + "\u0000" + notice.answerKey;
    if (this.noticed.includes(key)) return false;
    this.noticed.push(key);
    if (this.noticed.length > MAX_NOTICED_KEYS) this.noticed.splice(0, this.noticed.length - MAX_NOTICED_KEYS);
    return true;
  }

  /**
   * Stop watching: every watch leaves its place on the shared stream. The stream is the connection's, so this releases
   * the readers it added and closes nothing — the open surface, another caller, or the connection's own disposal decides
   * when the socket ends.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watch of this.watches.values()) watch.subscription?.release();
    this.watches.clear();
  }

  /**
   * Watch again after a `close`, which is what the shell that owns this registry does when it remounts (a Strict Mode
   * double mount, or the same connection's tree re-created). Nothing of the closed lifetime survives: the watches were
   * released and cleared, and the conversation on screen and the nominations arrive again from the render and the poll
   * that state them.
   */
  open(): void {
    if (!this.closed) return;
    this.closed = false;
    // The watches the closed lifetime left behind kept their projections and their nominations, so opening reconciles
    // them the same way any other interest change does: each one takes a slot again when the budget allows.
    this.rebalance();
  }

  private ensure(conversationId: string): Watch {
    const existing = this.watches.get(conversationId);
    if (existing !== undefined) return existing;
    const dormant = this.selected === conversationId;
    const watch: Watch = {
      step: createProjection({ composerKey: conversationId, conversationId }),
      subscription: null,
      nominated: false,
      dormant,
      held: emptyStreamState(conversationId),
    };
    // A fresh watch starts a fresh acquisition, which fences every callback of an older generation — the same thing
    // `select` does when it takes a conversation's frames back from a surface.
    if (!dormant) watch.step = advance(watch.step.state, { kind: "begin", acquisition: nextAcquisition(0) });
    this.watches.set(conversationId, watch);
    this.rebalance();
    return watch;
  }

  /**
   * How many pool connections the page's background watches may hold. The conversation on screen and the page's own
   * headroom are spent before any watch is considered, and a mounted terminal tab takes the fan-in's one.
   */
  private backgroundBudget(): number {
    return POOL_BUDGET - SELECTED_STREAM - HEADROOM - (this.terminalHeld ? 1 : 0);
  }

  /** The watches that hold a source right now, the conversation on screen excluded: its subscription is the surface's own. */
  private holding(): Watch[] {
    const holding: Watch[] = [];
    for (const [id, watch] of this.watches) {
      if (watch.subscription === null || id === this.selected) continue;
      holding.push(watch);
    }
    return holding;
  }

  /**
   * Give a slot to the watch that has waited longest for one, if the budget allows. A watch the budget defers keeps
   * everything it knows — its projection, its nomination, its place in the map — so the only thing it is missing is the
   * transport, and acquiring it is exactly the acquisition any other watch performs: a fresh source, whose first state
   * frame is the baseline the projection continues from.
   */
  private admit(): void {
    let deferred: Watch | null = null;
    for (const watch of this.watches.values()) {
      if (watch.subscription !== null) continue;
      // A dormant watch is the conversation on screen, whose frames belong to the surface that shows it. Its stream is
      // that surface's own subscription, so it neither spends nor waits for a background slot.
      if (watch.dormant) continue;
      deferred = watch;
      break;
    }
    if (deferred === null || this.holding().length >= this.backgroundBudget()) return;
    const conversationId = [...this.watches].find(([, watch]) => watch === deferred)?.[0];
    if (conversationId === undefined) return;
    const subscription = this.options.subscribe(conversationId, (event) => this.observe(conversationId, event as AgentEventLike));
    deferred.subscription = subscription;
    // The stream this watch just joined may have been running for the surface that was showing it, or for another
    // watch, and where it is now is what every frame after this continues from. It is transferred at the join — not
    // after the first frame, which would be a delta this watch cannot assemble — and then folded as this watch's own
    // facts, because continuing a stream and being the conversation's current statement are two questions.
    const joined = subscription.continuity();
    if (joined === null) return;
    deferred.held = joined;
    this.observeHeld(conversationId, deferred);
  }

  /**
   * Bring the page's held sources back to the budget after something changed: a watch released, a run settled, a
   * nomination that stopped, the conversation on screen moving, or a terminal tab mounting or closing.
   */
  private rebalance(): void {
    if (this.closed) return;
    // The budget can shrink below what is held — a terminal tab mounted after the background watches did. The extra
    // watches give up their slot rather than the budget being exceeded: what they keep is the projection and the
    // interest, and the same event that asks them to wait admits them again as soon as a slot is free.
    const holding = this.holding();
    for (let index = holding.length; index > this.backgroundBudget(); index -= 1) {
      const watch = holding[index - 1];
      if (watch === undefined) break;
      watch.subscription?.release();
      watch.subscription = null;
    }
    this.admit();
  }

  /**
   * Drop a watch when nothing needs it: the poll is no longer nominating it, its projection reports nothing in
   * flight, and it is not the conversation on screen. A watch whose stream still reports a live run keeps it — the
   * projection is a live fact and the poll is a read that can lag it — and a dropped stream re-baselines itself through
   * the connection's own reconnect, so that state resolves rather than lingering.
   *
   * The conversation on screen is the one case where the view cannot be read from this watch's own frames: its surface
   * folds them, so the watch folds nothing and its projection is the one the surface handed over through
   * {@link handover}. The stream is that surface's own subscription in any case, so the watch is dropped the moment the
   * surface's projection says there is nothing in flight.
   */
  private reconsider(conversationId: string, watch: Watch): void {
    if (!watch.nominated && !watch.dormant && !hasUnfinishedWork(watch.step.view)) {
      watch.subscription?.release();
      this.watches.delete(conversationId);
    }
    // A released watch frees its slot, and a nomination that arrived over budget waits for one: the two moves are the
    // same event, so the budget is reconciled wherever a watch's interest changed.
    this.rebalance();
  }

  /**
   * One native state this watch holds, folded into the conversation's accepted facts. A state this watch cannot
   * continue is asked about by the identity its turns were sent under rather than projected, and a watch for the
   * conversation on screen folds nothing at all — the surface that shows it folds its frames, and this watch's stream
   * stays open, which is what keeps a handover from losing the run. A frame is a projection, not an outcome: it is the
   * baseline a watch continues from and it announces nothing; only the live facts that follow it can.
   */
  private observeHeld(conversationId: string, watch: Watch, acquisition = watch.step.state.generation): void {
    if (watch.held.resyncRequired === true) {
      this.fold(conversationId, watch, { kind: "recover", acquisition });
      return;
    }
    if (watch.dormant) return;
    const session = projectSession(watch.held);
    this.fold(conversationId, watch, snapshotObservation({
      sessionId: conversationId,
      projectionId: session.projectionId ?? "",
      revision: session.revision ?? 0,
      run: session.run ?? null,
      submissions: session.submissions ?? [],
      context: session.context,
    }, acquisition, "sse"));
  }

  private observe(conversationId: string, event: AgentEventLike): void {
    const watch = this.watches.get(conversationId);
    if (watch === undefined || this.closed) return;
    const acquisition = watch.step.state.generation;
    if (event.type === "frame") {
      // A watch folds the same native frames the open surface does, through the same reducer, so a delta is assembled
      // from what this watch has received. Its stream-local state is its own continuity and is deliberately separate
      // from the projection it hands to the fold: continuing a stream and being the conversation's current statement
      // are two questions, and only the fold below answers the second.
      const frame = event.data as { conversationId?: unknown };
      if (frame.conversationId !== conversationId) return;
      watch.held = reduceSseFrame(watch.held, String(event.event), event.data);
      this.observeHeld(conversationId, watch, acquisition);
      return;
    }
    if (watch.dormant) return;
    if (event.type === "submission") {
      const submission = (event as unknown as { submission?: WireSubmission }).submission;
      if (submission === undefined) return;
      this.fold(conversationId, watch, lifecycleObservation({ sessionId: conversationId, submission }, acquisition));
      return;
    }
    if (event.type === "connected") {
      // A new attachment is a new lifecycle clock for the same history, so this watch's own continuity starts over.
      watch.held = emptyStreamState(conversationId);
      this.fold(conversationId, watch, { kind: "recover", acquisition });
      return;
    }
    if (event.type === "resync") {
      // The backend's own "a frame was missed" marker: ask about every turn still waiting, by the identity it was sent
      // under. A repair is never a success signal.
      this.fold(conversationId, watch, { kind: "recover", acquisition });
    }
  }

  private fold(conversationId: string, watch: Watch, input: Input): void {
    const next = advance(watch.step.state, input);
    watch.step = next;
    for (const effect of next.effects) {
      if (effect.kind === "lookup") {
        if ("requestId" in effect.subject) void this.lookup(conversationId, watch, effect.acquisition, effect.subject.requestId);
        continue;
      }
      // A watch the budget deferred has no source to reconnect: acquiring one is exactly what admitting it does, and
      // its first frame is the baseline the resync asked for.
      if (watch.subscription === null) this.rebalance();
      else watch.subscription.reconnect();
    }
    for (const notice of next.notices) {
      // Only a live terminal fact that answered is a completion: an aborted, failed or withdrawn run is not one, and
      // nothing here reports it as the user's news.
      if (notice.kind !== "answered") continue;
      // Claimed even when it is not reported: a suppressed conversation's completion is silent for good, not until the
      // next owner happens to look at it.
      if (!this.claim({ conversationId, answerKey: notice.answerId })) continue;
      if (this.options.isSuppressed?.(conversationId) === true) continue;
      this.options.onAnswered({ conversationId, answerKey: notice.answerId });
    }
    this.reconsider(conversationId, watch);
  }

  /** The by-id lookup, whose answer is folded silently: it repairs a turn's state and is never a success signal. */
  private async lookup(conversationId: string, watch: Watch, acquisition: number, requestId: string): Promise<void> {
    let record: WireSubmission | null = null;
    try {
      record = await this.options.lookup(conversationId, requestId);
    } catch {
      // Still unreachable: the turn stays unknown, which is the honest state, and a later reconnect asks again.
      return;
    }
    if (this.watches.get(conversationId) !== watch) return;
    this.fold(conversationId, watch, { kind: "lookup", conversationId, acquisition, subject: { requestId }, record });
  }
}
