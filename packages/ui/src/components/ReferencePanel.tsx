"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReferenceOutcome, ResolvedReference } from "@hepi/protocol";
import { useI18n } from "../hooks/useI18n";
import type { ConversationApi } from "../lib/conversation-api";
import {
  mergeReferenceList,
  referenceEntryOptions,
  referenceFollow,
  referenceKey,
  referenceOffers,
  referenceOutcomeKey,
  referenceWrite,
  type ReferenceEntryOption,
} from "../lib/references";
import { useWorkbenchConnection } from "../lib/workbench-scope";

/**
 * The references surface: the links this conversation makes, and the one action that makes them.
 *
 * Creation is a deliberate user action with a picker (cross-session references, decision 2), and both halves read and
 * write through the existing reference owner over the client ingress — `GET /api/conversations/:id` lists the links
 * with the outcome each one has now, and `POST /api/conversations/:id/references` stores one (decision 1). Nothing is
 * cached here: the list is the Backend's answer, and a follow is a navigation the shell performs.
 *
 * Following is deliberately **not** this component's own walk. A conversation reference opens the conversation, and an
 * entry reference names the entry to the shell's existing open-session seam, which is the history owner's bounded target
 * coordinator (decision 4: one target read, no intervening history). A reference the Backend reports as unresolvable
 * opens nothing and shows its own named state instead — the nearest surviving view would be the silent substitute the
 * spec forbids (decision 6).
 */

/** The conversation reads and the one control write this surface needs, as its host hands them over. */
export type ReferenceApi = Pick<ConversationApi, "open" | "list" | "navigationOutline" | "control">;

/** One conversation a reference may name, as the picker lists it. */
type TargetOption = { readonly id: string; readonly label: string };

export interface ReferenceSurfaceProps {
  /** The conversation whose references these are. The links belong to it, not to the target. */
  readonly sessionId: string;
  /** The connection's conversation API. */
  readonly api: ReferenceApi;
  /** The shell's open-session seam: conversation only, or that conversation positioned on one entry. */
  readonly onOpenSession?: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  /** Told after a creation was stored, so a surface above can refresh what it lists. */
  readonly onCreated?: (references: readonly ResolvedReference[]) => void;
}

/** The surface with this connection's API, for the panel that has no seam of its own to hand it. */
export function ReferencePanel({ sessionId, onOpenSession, onCreated }: Omit<ReferenceSurfaceProps, "api">) {
  const api = useWorkbenchConnection().api;
  return <ReferenceSurface sessionId={sessionId} api={api} onOpenSession={onOpenSession} onCreated={onCreated} />;
}

/**
 * The same surface with its API handed in.
 *
 * The split is the seam the acceptance reads: the reads and writes go through the owner, and what a reader is told
 * about each of them is this component's, so every named state is checkable by rendering it rather than by driving a
 * Backend.
 */
export function ReferenceSurface({ sessionId, api, onOpenSession, onCreated }: ReferenceSurfaceProps) {
  const { t } = useI18n();
  const [references, setReferences] = useState<readonly ResolvedReference[]>([]);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [targets, setTargets] = useState<readonly TargetOption[]>([]);
  const [targetId, setTargetId] = useState("");
  const [entries, setEntries] = useState<readonly ReferenceEntryOption[]>([]);
  const [entryId, setEntryId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [writeOutcome, setWriteOutcome] = useState<ReferenceOutcome | null>(null);
  const [writeStoredNothing, setWriteStoredNothing] = useState(false);

  /** The list as the Backend answers it: the links, and beside each one the outcome it has now. */
  const loadReferences = useCallback(async () => {
    setReading(true);
    setReadFailed(false);
    try {
      const answer = await api.open(sessionId) as { references?: readonly ResolvedReference[] };
      setReferences(answer.references ?? []);
    } catch {
      // A list that could not be read is stated rather than shown as an empty list: "no references" and "I could not
      // ask" are different facts, and only one of them is about the user's links.
      setReadFailed(true);
    } finally {
      setReading(false);
    }
  }, [api, sessionId]);

  // The conversation's own links, read with its identity. A switch starts from the Backend's answer again: a reference
  // belongs to the conversation that made it, and the previous conversation's list is not this one's.
  useEffect(() => {
    setReferences([]);
    setReadFailed(false);
    setReading(false);
    setCreating(false);
    setWriteOutcome(null);
    setWriteStoredNothing(false);
    void loadReferences();
  }, [loadReferences]);

  /** The conversations a reference may name: the catalogue, minus the one making the reference. */
  const loadTargets = useCallback(async () => {
    try {
      const { sessions } = await api.list();
      setTargets(sessions
        .filter((session) => session.id !== sessionId)
        .map((session) => ({ id: session.id, label: session.name ?? (session.firstMessage === "" ? session.id : session.firstMessage.slice(0, 80)) })));
    } catch {
      setTargets([]);
    }
  }, [api, sessionId]);

  /**
   * The entries a picker offers for the chosen target.
   *
   * They are the target's own paged outline — the anchors the history surface already issued — so an entry is chosen,
   * never typed or derived from an ordinal (decision 3). One bounded page is read; a target whose outline cannot be read
   * offers the conversation alone rather than a guessed entry.
   */
  const loadEntries = useCallback(async (conversationId: string) => {
    setEntries([]);
    setEntryId("");
    if (conversationId === "") return;
    try {
      setEntries(referenceEntryOptions(await api.navigationOutline(conversationId)));
    } catch {
      setEntries([]);
    }
  }, [api]);

  const submit = useCallback(async () => {
    if (targetId === "" || busy) return;
    setBusy(true);
    setWriteOutcome(null);
    setWriteStoredNothing(false);
    try {
      const written = referenceWrite(await api.control(sessionId).addReference({
        conversationId: targetId,
        ...(entryId === "" ? {} : { entryId }),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
      }));
      if (!written.ok) {
        // A refused creation stored nothing, and its reason is the Backend's own name, so the reader sees the same
        // state a follow would have shown rather than a sentence this surface composed.
        setWriteOutcome(written.outcome);
        setWriteStoredNothing(written.outcome !== "error");
        return;
      }
      setReferences((current) => mergeReferenceList(current, written.references));
      onCreated?.(written.references);
      setCreating(false);
      setTargetId("");
      setEntryId("");
      setEntries([]);
      setLabel("");
    } catch {
      // A write whose answer never arrived is `error`: its outcome is unestablished, and the retry it offers is safe
      // because creation is idempotent by target plus entry.
      setWriteOutcome("error");
      setWriteStoredNothing(false);
    } finally {
      setBusy(false);
    }
  }, [api, busy, entryId, label, onCreated, sessionId, targetId]);

  const follow = useCallback((reference: ResolvedReference) => {
    const decision = referenceFollow(reference);
    if (decision.kind === "refuse") return;
    onOpenSession?.(decision.conversationId, decision.entryId);
  }, [onOpenSession]);

  const resetCreator = useCallback(() => {
    setCreating(false);
    setWriteOutcome(null);
    setWriteStoredNothing(false);
    setTargetId("");
    setEntryId("");
    setEntries([]);
    setLabel("");
  }, []);

  return (
    <div data-reference-surface style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>{t("history.references")}</span>
        <button
          type="button"
          data-reference-create
          onClick={() => {
            if (creating) { resetCreator(); return; }
            setCreating(true);
            setWriteOutcome(null);
            void loadTargets();
          }}
          style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "2px 8px" }}
        >{t("references.create")}</button>
      </div>

      {readFailed && (
        <div data-reference-read-failed role="alert" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#dc2626" }}>
          <span>{t("references.readFailed")}</span>
          <button type="button" data-reference-reload onClick={() => void loadReferences()}>{t("references.retry")}</button>
        </div>
      )}

      {references.length === 0 && !reading && !readFailed && (
        <span data-reference-empty style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("references.empty")}</span>
      )}

      {references.map((reference) => {
        const decision = referenceFollow(reference);
        const outcome = decision.kind === "refuse" ? decision.outcome : null;
        const key = referenceKey(reference);
        const offers = outcome === null ? null : referenceOffers(outcome, reference);
        return (
          <div key={key} data-reference={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button
              type="button"
              data-reference-follow={key}
              onClick={() => follow(reference)}
              style={{ textAlign: "left", fontSize: 12, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", cursor: "pointer", padding: "4px 8px" }}
            >
              {reference.label ?? reference.conversationId}
              {reference.entryId === undefined ? "" : " · " + t("history.entry") + " " + reference.entryId}
            </button>
            {outcome !== null && (
              // The named state: what this reference is *now*, and the offers that match it. A target that is gone
              // offers no open — there is nothing behind it — while an entry the target no longer holds still offers
              // the conversation and its raw history, which are facts the reader can use.
              <div data-reference-outcome={outcome} role="status" aria-live="polite" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 11, color: "var(--text-muted)", paddingLeft: 8 }}>
                <span>{t(referenceOutcomeKey(outcome))}</span>
                {offers!.retry && (
                  <button type="button" data-reference-retry={key} onClick={() => void loadReferences()}>{t("references.retry")}</button>
                )}
                {offers!.openTarget && onOpenSession !== undefined && (
                  <button type="button" data-reference-open-target={key} onClick={() => { onOpenSession(reference.conversationId); }}>{t("references.openTarget")}</button>
                )}
                {offers!.openRaw && onOpenSession !== undefined && (
                  <button type="button" data-reference-open-raw={key} onClick={() => { onOpenSession(reference.conversationId, reference.entryId, { rawHistoryFocus: true }); }}>{t("references.openRaw")}</button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {creating && (
        <div data-reference-creator style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
            {t("references.target")}
            <select
              data-reference-target
              value={targetId}
              onChange={(event) => { setTargetId(event.target.value); void loadEntries(event.target.value); }}
              style={{ fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px" }}
            >
              <option value="">{t("references.targetNone")}</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
            {t("references.entry")}
            <select
              data-reference-entry
              value={entryId}
              onChange={(event) => setEntryId(event.target.value)}
              disabled={targetId === "" || entries.length === 0}
              style={{ fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px" }}
            >
              <option value="">{t("references.entryNone")}</option>
              {entries.map((entry) => <option key={entry.entryId} value={entry.entryId}>{entry.entryId + " · " + entry.preview}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
            {t("references.label")}
            <input
              data-reference-label
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              style={{ fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px" }}
            />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              data-reference-submit
              disabled={targetId === "" || busy}
              onClick={() => void submit()}
              style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: targetId === "" || busy ? "default" : "pointer", padding: "2px 8px" }}
            >{busy ? t("references.creating") : t("references.submit")}</button>
            <button
              type="button"
              data-reference-cancel
              onClick={resetCreator}
              style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "2px 8px" }}
            >{t("references.cancel")}</button>
            {writeOutcome !== null && (
              <span data-reference-write-outcome={writeOutcome} role="status" aria-live="polite" style={{ fontSize: 11, color: writeStoredNothing ? "#dc2626" : "var(--text-muted)" }}>
                {t(referenceOutcomeKey(writeOutcome))}
                {writeStoredNothing ? " " + t("references.notStored") : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
