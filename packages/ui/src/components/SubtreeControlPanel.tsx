"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { StatusCell, sessionTitle } from "./AgentSessionPanel";
import {
  subtreeConfirm,
  subtreeControlFrom,
  subtreeReadFrom,
  subtreeRelease,
  type SubtreeAttempt,
  type SubtreeAttempts,
  type SubtreeControlAction,
  type SubtreeView,
} from "../lib/subtree-control";
import type { SessionInfo } from "../lib/types";
import { createRequestId } from "../lib/conversation-api";
import { listenForStackedDialogEscape } from "../lib/stacked-dialog";
import { useWorkbenchConnection } from "../lib/workbench-scope";

/**
 * Selective subtree control, offered beside the child tree it names.
 *
 * A conversation's own Stop — the composer's — holds that conversation and nothing beneath it (spec decision 1), so
 * stopping a subtree is a separate decision the user has to be able to make on purpose. This is the surface that makes
 * it: it names the addressed root, the descendants it is about to reach and each one's status **before** anything is
 * written, because a subtree request touches conversations the user is not looking at.
 *
 * What it can offer is only a **proposal**. The descendant set that governs is the one the Backend captures from
 * durable relations under the request id (spec decision 2), so a stale listing here cannot reach a conversation outside
 * the subtree — the Backend refuses the whole request with its own `outside_subtree` — and a child created after the
 * capture is never swept in by a retry. Nothing here truncates history, deletes a relation or cascades a removal: each
 * child answers its own outcome, and a partial result stays visible instead of being flattened.
 *
 * The answer keeps the two columns apart on purpose: `Requested` is what the request recorded when it reached that
 * child and `Now` is the child's own current state from the same row the session list shows. A stop that has drained
 * reads `stopping` over `held`; a child the user resumed on its own reads `accepted` over `running`. Collapsing either
 * one into the other is the aggregate-state lie this operation is built not to tell.
 *
 * Navigation stays available the whole time: these controls sit **below** the list, and a row is still a row. The
 * global sidebar and its running marks stay navigation-only — they list conversations, they do not control subtrees.
 */

/** A descendant offered for selection, named and stated from the catalogue row the panel already holds. */
type Candidate = { readonly id: string; readonly session: SessionInfo };
/**
 * One attempt, answered or not.
 *
 * `lost` is not an error to retry by re-sending: the write may have committed, so the only honest next move is to read
 * that request id back — which is what the Backend's durable record and the `Read back` control are for.
 */
type Phase =
  | { step: "idle" }
  | { step: "confirm"; action: SubtreeControlAction }
  | { step: "working"; action: SubtreeControlAction; requestId: string }
  | { step: "answered"; view: SubtreeView; attempt: SubtreeAttempt }
  | { step: "lost"; attempt: SubtreeAttempt; reason: string }
  | { step: "refused"; code: string; message: string };

const BUTTON = {
  minHeight: 30,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
} as const;

const ACTION_COLOR: Record<SubtreeControlAction, string> = { stop: "#d97706", interrupt: "#dc2626" };

/** The Backend's own outcome word, translated when this build has a word for it and passed through when it has none. */
function outcomeLabel(t: (key: string) => string, status: string, reason?: string): string {
  const key = "subtree.outcome." + status;
  const word = t(key);
  const base = word === key ? status : word;
  if (reason === undefined) return base;
  const reasonKey = "subtree.reason." + reason;
  const translated = t(reasonKey);
  return base + " · " + (translated === reasonKey ? reason : translated);
}

export function SubtreeControlPanel({
  root,
  descendants,
  runningSessionIds,
  onSelectSession,
  onControlled,
}: {
  /** The conversation the request is addressed to, whose own stop stays local. */
  root: SessionInfo;
  /** The descendants the panel's own tree lists beneath it — a proposal, the Backend's capture governs. */
  descendants: readonly Candidate[];
  /** The poll's running set, for a row the catalogue stated no status of its own for. */
  runningSessionIds: ReadonlySet<string>;
  /** Open one child in the same window. The rows here stay selectable while a request is in flight. */
  onSelectSession: (session: SessionInfo) => void;
  /** The catalogue changed, so the tree re-reads each row's status rather than this surface guessing it. */
  onControlled?: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWorkbenchConnection();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  // Every descendant starts included: an omitted one is a decision the user makes, not a default that hides work. What
  // this state holds is therefore the exclusions, which is also what makes them survive a re-render, a child arriving in
  // the next poll, and the following decision on this subtree — an inclusion set would silently widen a request the user
  // had just narrowed.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  // The attempt identities live in a ref because they are bookkeeping, not something the screen shows: a re-render must
  // not mint a new one, and a retry has to carry the id the first attempt was made under.
  const attemptsRef = useRef<SubtreeAttempts>(new Map());
  // Which conversation this surface belongs to. An answer that arrives after the user navigated elsewhere describes a
  // subtree nobody is looking at, and writing it would put one conversation's outcomes under another's name.
  const rootIdRef = useRef(root.id);
  rootIdRef.current = root.id;
  const belongs = useCallback((conversationId: string) => rootIdRef.current === conversationId, []);

  // A different subtree is a different decision: another root's exclusions and another root's result mean nothing here,
  // and resuming a request addressed to a conversation this panel no longer describes would control the wrong subtree.
  // The identity map is keyed by root, so nothing from the previous one is reachable under this one.
  useEffect(() => {
    setExcluded(new Set());
    setPhase({ step: "idle" });
  }, [root.id]);

  // An open confirmation owns Escape: the key means "I did not mean that", and it must not fall through to the global
  // Escape, which stops the **addressed** conversation — a different decision from the one being confirmed (spec
  // decision 1). Listened for in the capture phase and stopped there, as a dialog above another panel does.
  useEffect(() => {
    if (phase.step !== "confirm") return;
    return listenForStackedDialogEscape(document, () => setPhase({ step: "idle" }));
  }, [phase.step]);

  const selected = useMemo(() => {
    const ids = descendants.map((row) => row.id).filter((id) => !excluded.has(id));
    return ids.length === descendants.length ? null : ids;
  }, [descendants, excluded]);

  /**
   * Release one settled attempt: its identity is dropped, so the next decision under this root, action and selection is
   * a **new** capture rather than a replay of a request that already finished. Both ways a request finishes do this —
   * its own answer and a read-back that states completion — because an identity held past completion would hand the
   * user's next decision the old subtree's outcomes while controlling nothing.
   */
  const release = useCallback((attempt: SubtreeAttempt) => subtreeRelease(attemptsRef.current, attempt), []);

  const run = useCallback(async (attempt: SubtreeAttempt) => {
    setPhase({ step: "working", action: attempt.action, requestId: attempt.requestId });
    // Everything sent is the attempt's own, frozen at confirmation: nothing here consults the current listing, and a
    // whole-subtree decision is sent as an omitted field so the Backend's capture governs it.
    const answered = await subtreeControlFrom(client, attempt);
    // An answer is written only for the conversation it was addressed to; the request itself already belongs there.
    if (!belongs(attempt.rootId)) return;
    if (answered.ok) {
      // A completed answer has done its work: the identity is released so the next decision is a new capture rather
      // than a replay of this one. A `pending` answer keeps it — that is the request a resume continues.
      if (answered.view.status === "completed") release(attempt);
      setPhase({ step: "answered", view: answered.view, attempt });
      onControlled?.();
      return;
    }
    if ("unknown" in answered) {
      // The answer never arrived. Nothing is re-sent here: the attempt holds its identity, its subset and its action,
      // and the user reads it back or resumes that same attempt.
      setPhase({ step: "lost", attempt, reason: answered.reason });
      return;
    }
    setPhase({ step: "refused", code: answered.refusal.code, message: answered.refusal.message });
    onControlled?.();
  }, [belongs, client, onControlled, release]);

  /**
   * The read that resolves a lost answer and the refresh that settles a lost race, in one call: it asks the Backend
   * about the id this attempt was made under, controls nothing and rewrites nothing.
   *
   * The attempt travels with the read because a read that itself never arrived still has to offer a resume, and the
   * panel must not re-derive what was asked: it names that attempt's action, subset and identity again.
   */
  const readBack = useCallback(async (attempt: SubtreeAttempt) => {
    const answered = await subtreeReadFrom(client, attempt);
    if (!belongs(attempt.rootId)) return;
    if (answered.ok) {
      if ("view" in answered) {
        // A read-back that answers `completed` finishes the request just as its own answer would: leaving the identity
        // held would make the user's next decision on that subtree a replay of a request that is already done — the
        // Backend would answer it from the old capture and control nothing new.
        if (answered.view.status === "completed") release(attempt);
        setPhase({ step: "answered", view: answered.view, attempt });
      } else {
        setPhase({ step: "refused", code: "unknown_request", message: t("subtree.noRecord") });
      }
      onControlled?.();
      return;
    }
    if ("unknown" in answered) {
      setPhase({ step: "lost", attempt, reason: answered.reason });
      return;
    }
    setPhase({ step: "refused", code: answered.refusal.code, message: answered.refusal.message });
  }, [belongs, client, onControlled, release, t]);

  const confirm = () => {
    if (phase.step !== "confirm") return;
    // The decision is frozen here: addressed conversation, action, the subset chosen at this moment, and the identity
    // minted under exactly that combination. Every later send and read of this attempt uses that record, so a listing
    // that moves while an answer is lost cannot widen what the user approved (see {@link SubtreeAttempt}). A retry of
    // the same decision repeats the identity, which is what makes the Backend answer from its own capture instead of
    // controlling a second subtree (spec acceptance 5).
    void run(subtreeConfirm(attemptsRef.current, { action: phase.action, rootId: root.id, selected }, createRequestId));
  };

  const toggle = (id: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const busy = phase.step === "working";
  // The answered phase holds both halves: the view the Backend stated and the attempt that asked for it. The attempt is
  // read from there, never re-derived from the listing shown now.
  const shown = phase.step === "answered" ? phase : null;
  const view = shown?.view ?? null;

  return (
    <div data-subtree-control style={{ borderTop: "1px solid var(--border)", padding: 8, display: "grid", gap: 8 }}>
      {phase.step !== "confirm" && phase.step !== "working" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Two separate actions, no hidden escalation from one to the other (spec open detail 1). */}
          <button
            type="button"
            data-subtree-action="stop"
            disabled={busy}
            onClick={() => setPhase({ step: "confirm", action: "stop" })}
            style={{ ...BUTTON, borderColor: ACTION_COLOR.stop, color: ACTION_COLOR.stop }}
          >
            {t("subtree.stop")}
          </button>
          <button
            type="button"
            data-subtree-action="interrupt"
            disabled={busy}
            onClick={() => setPhase({ step: "confirm", action: "interrupt" })}
            style={{ ...BUTTON, borderColor: ACTION_COLOR.interrupt, color: ACTION_COLOR.interrupt }}
          >
            {t("subtree.interrupt")}
          </button>
          {view !== null && (
            <span data-subtree-partial={view.partial ? "true" : "false"} style={{ color: view.partial ? "#dc2626" : "var(--text-dim)", fontSize: 11 }}>
              {view.partial ? t("subtree.partial") : t("subtree.done", { count: view.children.length })}
            </span>
          )}
        </div>
      )}

      {phase.step === "confirm" && (
        <div data-subtree-confirm role="group" aria-label={t("subtree.confirm", { action: t("subtree.action." + phase.action) })} style={{ display: "grid", gap: 6 }}>
          <strong style={{ fontSize: 12 }}>
            {t("subtree.confirmTitle", { action: t("subtree.action." + phase.action), root: sessionTitle(root), count: selected === null ? descendants.length : selected.length })}
          </strong>
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11 }}>{t("subtree.confirmHint")}</p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2, maxHeight: 180, overflowY: "auto" }}>
            {descendants.map(({ id, session }) => (
              <li key={id}>
                <label data-subtree-choice={id} style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr) auto", gap: 6, alignItems: "center", fontSize: 11, cursor: "pointer" }}>
                  <input type="checkbox" checked={!excluded.has(id)} disabled={busy} onChange={() => toggle(id)} aria-label={t("subtree.include")} />
                  <span style={{ minWidth: 0, overflow: "hidden" }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sessionTitle(session)}>{sessionTitle(session)}</span>
                    {/*
                      The host a child really runs on, stated when it is not the addressed conversation's own: one
                      confirmation can reach two execution hosts, and a user who is about to stop work on another
                      computer has to see that before pressing it rather than after (spec open detail 2). A row whose
                      catalogue states no host says nothing — an absent fact is not this panel's guess.
                    */}
                    {session.gatewayId !== undefined && session.gatewayId !== root.gatewayId ? (
                      <span data-subtree-host={session.gatewayId} style={{ display: "block", color: "#d97706", fontSize: 10 }}>{t("agentSwitcher.host", { host: session.gatewayId })}</span>
                    ) : null}
                  </span>
                  <StatusCell session={session} running={runningSessionIds.has(session.id)} t={t} />
                </label>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" data-subtree-confirm-submit disabled={selected !== null && selected.length === 0} onClick={confirm} style={{ ...BUTTON, background: "var(--accent)", color: "#fff", border: "none" }}>
              {t("subtree.confirmSubmit", { count: selected === null ? descendants.length : selected.length })}
            </button>
            <button type="button" data-subtree-confirm-cancel onClick={() => setPhase({ step: "idle" })} style={BUTTON}>{t("subtree.cancel")}</button>
          </div>
          {selected !== null && selected.length === 0 && (
            <p style={{ margin: 0, color: "#d97706", fontSize: 11 }}>{t("subtree.noneChosen")}</p>
          )}
        </div>
      )}

      {phase.step === "working" && <p role="status" style={{ margin: 0, color: "var(--text-dim)", fontSize: 11 }}>{t("subtree.working")}</p>}

      {phase.step === "lost" && (
        <div data-subtree-lost style={{ display: "grid", gap: 6 }}>
          {/* The Backend may have committed this. The retry below repeats the **same** attempt identity, so it is
              answered from the capture it already made rather than controlling a second subtree. */}
          <p role="alert" style={{ margin: 0, color: "#dc2626", fontSize: 11 }}>{t("subtree.lost", { reason: phase.reason })}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" data-subtree-read disabled={busy} onClick={() => void readBack(phase.attempt)} style={BUTTON}>{t("subtree.readBack")}</button>
            {/* The same attempt, unchanged: its own id, its own action and the subset the user confirmed, however the
                listing moved while this answer was lost. No second confirmation is asked for — the decision was made. */}
            <button type="button" data-subtree-resume disabled={busy} onClick={() => void run(phase.attempt)} style={BUTTON}>{t("subtree.resume")}</button>
          </div>
        </div>
      )}

      {phase.step === "refused" && (
        // The Backend's own words and code, together: `outside_subtree` and a removed conversation are different problems
        // and a user can only act on one of them if both are named.
        <p role="alert" data-subtree-refusal={phase.code} style={{ margin: 0, color: "#dc2626", fontSize: 11 }}>
          {phase.message}
        </p>
      )}

      {view !== null && (
        <div data-subtree-result={view.status} style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--text-dim)" }}>
            <span data-subtree-requested={view.requestId}>{t("subtree.requested", { action: t("subtree.action." + view.action), count: view.children.length })}</span>
            {view.status === "pending" && <span data-subtree-pending>{t("subtree.pending")}</span>}
            {view.selected !== null && <span>{t("subtree.selective", { count: view.selected.length })}</span>}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th scope="col" style={{ fontWeight: 500, padding: "2px 4px" }}>{t("subtree.col.child")}</th>
                <th scope="col" style={{ fontWeight: 500, padding: "2px 4px" }}>{t("subtree.col.requested")}</th>
                <th scope="col" style={{ fontWeight: 500, padding: "2px 4px" }}>{t("subtree.col.now")}</th>
              </tr>
            </thead>
            <tbody>
              {view.children.map((child) => {
                // `Now` is the child's own current row from the answer, projected by the same catalogue projection the
                // sidebar renders. A child the Backend stated no row for says so — an outcome is not a status, and
                // borrowing the parent's or inventing `idle` would be the aggregate lie this operation exists to avoid.
                const current = child.session;
                return (
                  <tr key={child.conversationId} data-subtree-child={child.conversationId} data-subtree-status={child.status} data-subtree-now={current?.runStatus?.state ?? "unknown"}>
                    <td style={{ padding: "2px 4px", maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {current === undefined ? (
                        <span data-subtree-unlisted={child.conversationId} style={{ color: "var(--text-dim)" }}>{child.conversationId.slice(0, 12)}</span>
                      ) : (
                        <button
                          type="button"
                          data-subtree-open={child.conversationId}
                          onClick={() => onSelectSession(current)}
                          style={{ ...BUTTON, border: "none", padding: 0, minHeight: 0, background: "none", color: "var(--accent)", fontSize: 11, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}
                        >
                          {sessionTitle(current)}
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "2px 4px", whiteSpace: "nowrap", color: child.status === "refused" || child.status === "conflict" || child.status === "not-found" ? "#dc2626" : "var(--text)" }}>
                      {outcomeLabel(t, child.status, child.reason)}
                    </td>
                    <td style={{ padding: "2px 4px", whiteSpace: "nowrap" }}>
                      {current === undefined
                        ? <span style={{ color: "var(--text-dim)" }}>{t("subtree.nowUnknown")}</span>
                        : <StatusCell session={current} running={runningSessionIds.has(child.conversationId)} t={t} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8 }}>
            {/* The refresh that settles a lost race, and the recovery read a lost answer is resolved with. It asks about
                the id this attempt was made under, controls nothing and rewrites nothing. */}
            <button type="button" data-subtree-refresh disabled={busy} onClick={() => { if (shown !== null) void readBack(shown.attempt); }} style={BUTTON}>{t("subtree.refresh")}</button>
            {view.status === "pending" && (
              <button type="button" data-subtree-resume disabled={busy} onClick={() => { if (shown !== null) void run(shown.attempt); }} style={BUTTON}>{t("subtree.resume")}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
