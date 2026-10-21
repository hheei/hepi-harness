import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigationOutlinePage } from "@hepi/protocol/navigation";
import {
  NavigationCoordinator,
  navigationFailureOf,
  reduceOutlinePages,
  scopeOfSnapshot,
  type LandedWindow,
  type NavigationOutline,
  type NavigationOutcome,
} from "../lib/history-navigation.ts";
import type { ConversationApi } from "../lib/conversation-api.ts";

/**
 * The conversation's navigation owner (history-navigation ticket 03).
 *
 * It holds two things and nothing else: the paged **outline** of committed user anchors, and the state of the **one
 * target window** a jump or a deep search hit asks for.
 *
 * Why it is a hook of its own rather than more lines in the session hook is the boundaries it does not cross:
 *
 * - **acquisition, projection and the lifecycle fold** stay the session hook's. A landed window never enters the fold:
 *   it is history the projection's window does not carry, so it is handed to the paged-prefix owner — the same state
 *   the sentinel's older pages go to — and `decidePrefix` remains the one rule that says what that prefix becomes when
 *   the window moves. The active-context prefix rule and the view cache are untouched.
 * - **scrolling is not here at all.** This states a landing; the surface that owns the viewport performs the
 *   presentation scroll once the target's DOM exists, so an animation can request, settle or cancel nothing (spec
 *   decision 7).
 *
 * The host the coordinator reads is one object built per mount that reads the current surface through a ref, so a read
 * in flight is fenced by the conversation on screen *when it answers* rather than by the props it started under. That
 * is what makes a switch mid-read the named `cancelled` rather than a landing on the wrong conversation.
 */
export type HistoryNavigation = {
  /** The paged outline a rail reads, or null until a page has been answered for this conversation. */
  readonly outline: NavigationOutline | null;
  /** The outcome of the navigation this surface asked for, or none. */
  readonly outcome: NavigationOutcome | null;
  /** Ask for one bounded outline page. `cursor` continues the page this state just stated; nothing loops. */
  loadOutline(options?: { readonly cursor?: number; readonly signal?: AbortSignal }): Promise<void>;
  /** Jump to an anchor's coordinate: at most one target read, exactly one settlement. */
  jump(anchor: string): void;
  /** Land a deep search hit's exact block through this same coordinator. */
  locate(input: { readonly entryId: string; readonly block?: number }): void;
  /** Re-issue the held outcome's request. Every outcome offers exactly this. */
  retry(): void;
  /** Retire the outcome. A retired navigation is never reported as a landing. */
  dismiss(): void;
};

export type HistoryNavigationInput = {
  /** The conversation on screen, or null for a fresh composer with none. Nothing is readable without one. */
  readonly conversationId: string | null;
  /** The conversation's own `historyRevision` token, as its accepted snapshot states it. */
  readonly snapshotRevision: string | null;
  /** Whether a native run is in flight. A jump while busy is deferred unless the reader asked to land afterwards. */
  readonly busy: boolean;
  /** Every entry id the transcript carries — the projection's window and the paged prefix alike. */
  readonly activeEntryIds: readonly string[];
  readonly api: ConversationApi;
  /**
   * Hand one landed window to the paged-prefix owner.
   *
   * It is the session hook's own statement over the entries the Backend projected, so a landing and a sentinel page
   * enter the transcript as one kind of history rather than as two representations of it.
   */
  landWindow(window: LandedWindow): void;
};

export function useHistoryNavigation(input: HistoryNavigationInput): HistoryNavigation {
  const [outcome, setOutcome] = useState<NavigationOutcome | null>(null);
  const [outline, setOutline] = useState<NavigationOutline | null>(null);
  /** The snapshot a dropped page was already retried under, which bounds the refresh at one read. */
  const retriedForRef = useRef<string | null>(null);
  /** Which outline read this surface is last asking for. Every older answer is retired by it. */
  const outlineGenerationRef = useRef(0);
  const surface = useRef(input);
  surface.current = input;

  // The one controller per mounted surface, reading its host through getters so the identity, the busy flag and the
  // held ids it fences against are the ones on screen when a read answers.
  const hostRef = useRef<NavigationCoordinator | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new NavigationCoordinator({
      get conversationId() { return surface.current.conversationId ?? ""; },
      get snapshotRevision() { return surface.current.snapshotRevision; },
      get busy() { return surface.current.busy; },
      get activeEntryIds() { return surface.current.activeEntryIds; },
      get signal() { return lifetime.current!.signal; },
      landWindow(window: LandedWindow): void { surface.current.landWindow(window); },
      onSettled(settled: NavigationOutcome): void { setOutcome(settled); },
      readTargetWindow: async ({ conversationId, query, signal }) =>
        await surface.current.api.navigationTarget(conversationId, query, { signal }),
    });
  }
  const coordinator = hostRef.current;
  const lifetime = useRef<AbortController | null>(null);
  if (lifetime.current === null) lifetime.current = new AbortController();

  // A conversation switch is a retirement, not a re-addressing: the outline described the history the reader left, and
  // so did any outcome about to be reported on it. The retired generation is what fences a page of the conversation
  // the reader left, and the refresh bound starts over because this is a different history.
  useEffect(() => {
    outlineGenerationRef.current += 1;
    retriedForRef.current = null;
    setOutline(null);
    setOutcome(null);
    coordinator.clear();
  }, [coordinator, input.conversationId]);

  // The surface's own end retires its in-flight read. A switch is fenced by conversation identity inside the
  // coordinator, which is the half the reader is told about; this is the half that stops the request.
  //
  // The controller is created in the effect rather than beside the ref, because both hosts render under `StrictMode`
  // and a replay runs this cleanup and then this setup again on the same state: a controller built once would be
  // aborted by that cleanup and handed back, and every read after the replay would be refused as the surface's own
  // cancellation. Building it per setup makes the replay a new lifetime with a live signal, which is what the reader's
  // next jump needs.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      // The controller is aborted and **left in place**, never cleared.
      //
      // Clearing it is what made the getter above read a null signal: between this cleanup and the next setup — the
      // gap a StrictMode replay opens, and the state after any unmount — a coordinator that asked for its signal threw
      // a page error instead of being told its read was over. An aborted controller left in the ref answers the same
      // question with the same meaning (this surface is finished reading), without a window in which the host has no
      // signal at all.
      controller.abort();
    };
  }, []);

  // The run's own end is what finishes a parked jump — no timer, no poll, and nothing re-issued for a reader who never
  // took the offer, which the coordinator decides against the request it still holds.
  const wasBusy = useRef(input.busy);
  useEffect(() => {
    if (wasBusy.current && !input.busy) coordinator.settleWaited();
    wasBusy.current = input.busy;
  }, [coordinator, input.busy]);

  const loadOutline = useCallback(async (options?: { readonly cursor?: number; readonly signal?: AbortSignal }) => {
    const current = surface.current;
    const conversationId = current.conversationId;
    if (conversationId === null) return;
    const scope = current.snapshotRevision === null ? undefined : scopeOfSnapshot(current.snapshotRevision);
    // A second issue retires the first, so an older page cannot overwrite a newer answer. `started` is the surface's
    // own lifetime: an unmount or a StrictMode replay ends this read too.
    const generation = (outlineGenerationRef.current += 1);
    const started = lifetime.current!;
    setOutline((held) => held === null || held.conversationId !== conversationId
      ? { conversationId, snapshot: "", scope: "", anchors: [], hasMore: false, capped: true, loading: true, failure: null }
      : { ...held, loading: true, failure: null });
    // A page is published only while the read, the lifetime, the connection and the conversation that made it *this*
    // surface's page still hold: a conversation id and a scope can be reused by another connection and by a remount, so
    // both are read from current props rather than assumed from the ones the read started under.
    const stillThisSurface = () => outlineGenerationRef.current === generation
      && started === lifetime.current
      && !started.signal.aborted
      && surface.current.api === current.api
      && surface.current.conversationId === conversationId;
    const scopeStillCurrent = () => {
      const now = surface.current.snapshotRevision;
      return (now === null ? undefined : scopeOfSnapshot(now)) === scope;
    };
    // A page of a history the conversation has replaced is dropped and the scope effect re-reads once; a second drop
    // for the same snapshot is the backend disagreeing about which history is current, so it is named, not looped.
    const abandonStaleAnswer = () => {
      const key = surface.current.snapshotRevision;
      if (retriedForRef.current === key) {
        setOutline((held) => (held === null ? held : { ...held, loading: false, failure: "stale-snapshot" }));
        return;
      }
      retriedForRef.current = key;
      setOutline((held) => (held === null ? held : { ...held, snapshot: "", scope: "", anchors: [], hasMore: false, capped: true, nextCursor: undefined, loading: false, failure: null }));
    };
    try {
      const page: NavigationOutlinePage = await current.api.navigationOutline(conversationId, {
        ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(scope === undefined ? {} : { scope }),
        ...(options?.signal === undefined ? { signal: started.signal } : { signal: options.signal }),
      });
      if (!stillThisSurface()) return;
      // A page read without a stated scope is not comparable to one: the page always names the scope it answered over.
      if (!scopeStillCurrent() || (scope !== undefined && page.scope !== scope)) {
        abandonStaleAnswer();
        return;
      }
      retriedForRef.current = null;
      setOutline((held) => reduceOutlinePages(held, { kind: "page", page }));
    } catch (error) {
      if (!stillThisSurface()) return;
      if (!scopeStillCurrent()) {
        abandonStaleAnswer();
        return;
      }
      // The same names the target read answers with, mapped by the one rule that holds them.
      setOutline((held) => reduceOutlinePages(held, { kind: "failure", failure: navigationFailureOf(error) }));
    }
  }, []);
  /**
   * A history that re-baselined retires the rail's list: the anchors are addresses over the scope the conversation
   * stated when they were read, so once a compaction or a reset moves that scope every held anchor is refused by the
   * coordinator's own fence. A different scope is answered by reading the first page again. An **append** is not that
   * — it moves the entry fact and leaves the scope — so a growing conversation re-pages nothing.
   */
  const scope = input.snapshotRevision === null ? null : scopeOfSnapshot(input.snapshotRevision);
  useEffect(() => {
    if (input.conversationId === null || scope === null) return;
    // Only this conversation's own list is comparable: the one the reader left is retired by the switch effect above,
    // and re-reading against it here would ask for a history the surface is not showing. A list still reading is not
    // stale yet, and one that already failed is the reader's state, whose control is its own retry.
    if (outline === null || outline.conversationId !== input.conversationId) return;
    if (outline.loading || outline.failure !== null || outline.scope === scope) return;
    setOutline({
      conversationId: outline.conversationId,
      snapshot: "",
      scope,
      anchors: [],
      hasMore: false,
      capped: true,
      loading: true,
      failure: null,
    });
    void loadOutline();
  }, [input.conversationId, loadOutline, outline, scope]);

  const jump = useCallback((anchor: string) => {
    if (surface.current.conversationId !== null) coordinator.jump(surface.current.conversationId, anchor);
  }, [coordinator]);

  const locate = useCallback((request: { readonly entryId: string; readonly block?: number }) => {
    if (surface.current.conversationId !== null) coordinator.searchTarget({ conversationId: surface.current.conversationId, ...request });
  }, [coordinator]);

  const retry = useCallback(() => {
    if (outcome !== null && outcome.kind === "failed") outcome.retry();
  }, [outcome]);

  const dismiss = useCallback(() => {
    coordinator.clear();
    setOutcome(null);
  }, [coordinator]);

  return { outline, outcome, loadOutline, jump, locate, retry, dismiss };
}
