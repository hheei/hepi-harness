"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChildRecoveryFacts } from "@hepi/protocol";
import { useI18n } from "../hooks/useI18n";
import { childRecoveryWords, createReadFence, readChildRecovery, retryChildPreparation, retryablePreparation } from "../lib/child-recovery";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import type { SessionInfo } from "../lib/types";

/**
 * One delegated child's recovery facts, shown on the child itself (the audit's G2 and G6).
 *
 * The child tree's row and the conversation header both show the child's own `runStatus` — one state per conversation —
 * and that is *not* enough to say what a delegation is waiting on: a parked preparation and a child that has simply not
 * been given its task yet can both read `idle`. This surface states the other three facts **per object**, exactly as the
 * backend projects them, and never merges them into a child verdict: what the dispatch's record says about its
 * preparation, where this dispatch's report stands, and the anchor's own phase.
 *
 * The retry it offers is the one the delegation seam already supports (spec D11, A14): it replays the **existing**
 * dispatch/request identity and the failed attempt's own task id — both read back from this very answer — so it wakes
 * the parked anchor of the same child. Nothing here creates a child, admits a task, mints an identity, retries by
 * itself, or aborts anything running; a lost answer is stated as lost, and the same identities are offered again
 * because a replay of that write is asking once, not twice.
 *
 * A conversation that is not a delegation's child — an ordinary one, or a branch a user took from a child (spec D14) —
 * is stated as having no delegation facts at all, and offers nothing.
 */

/** What the surface holds: the read's state, plus the outcome of a retry the user asked for. */
type Phase =
  | { readonly step: "idle" }
  | { readonly step: "loading" }
  | { readonly step: "facts"; readonly facts: ChildRecoveryFacts | null }
  | { readonly step: "unavailable"; readonly code: string; readonly message: string }
  | { readonly step: "retrying"; readonly facts: ChildRecoveryFacts }
  | { readonly step: "refused"; readonly facts: ChildRecoveryFacts; readonly code: string; readonly message: string }
  | { readonly step: "lost"; readonly facts: ChildRecoveryFacts; readonly reason: string };

const BUTTON = {
  minHeight: 26,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
} as const;

/** The colour one object's state is shown in: work in flight, the user's decision to take, and a stated problem. */
function wordColor(id: string): string {
  if (id.endsWith(".unretried-failure") || id.endsWith(".blocked") || id.endsWith(".interrupted")) return "#dc2626";
  if (id.endsWith(".awaiting-delivery")) return "#7c3aed";
  if (id.endsWith(".preparing") || id.endsWith(".admitting") || id.endsWith(".waiting-child") || id.endsWith(".delivering") || id.endsWith(".retried")) return "var(--accent)";
  return "var(--text-dim)";
}

export function ChildRecoveryPanel({ session }: {
  /** The conversation on screen, as the catalogue row states it. No row, no read: a fresh composer has no facts. */
  session: { readonly id: string; readonly relation?: SessionInfo["relation"] } | null;
}) {
  const sessionId = session?.id ?? "";
  // The catalogue's own creator edge decides whether anything is asked at all: an ordinary conversation and a branch a
  // user took from a child have no delegation to report, and this surface asks nothing about them.
  const isChild = session?.relation?.kind === "subagent";
  const { t } = useI18n();
  const { client } = useWorkbenchConnection();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  // Which answer belongs on screen: the newest attempt's, and only while this surface still owns it. A refresh, a retry,
  // a conversation change, a replaced connection and an unmount each move the fence on, so an answer that was superseded
  // — or that arrives after this surface stopped showing this child — is dropped rather than written over newer facts.
  const [fence] = useState(createReadFence);

  const read = useCallback(async () => {
    const attempt = fence.begin();
    setPhase({ step: "loading" });
    const answered = await readChildRecovery(client, sessionId);
    if (!fence.settled(attempt)) return;
    setPhase(answered.ok ? { step: "facts", facts: answered.facts } : { step: "unavailable", code: answered.code, message: answered.message });
  }, [client, fence, sessionId]);

  useEffect(() => {
    if (!isChild) return;
    // The facts are a read of durable records, so this surface asks once per conversation and once per explicit
    // refresh: no stream is opened here and nothing is polled, which is what keeps a child's row from becoming a
    // per-conversation connection (spec D15).
    void read();
    // Leaving the child, or this connection being replaced, ends this surface's claim on the answer still in flight.
    return () => fence.release();
  }, [fence, isChild, read]);

  const retry = useCallback(async (identities: { readonly requestId: string; readonly failedTaskId: string }, current: ChildRecoveryFacts) => {
    const attempt = fence.begin();
    setPhase({ step: "retrying", facts: current });
    const answered = await retryChildPreparation(client, sessionId, identities);
    if (!fence.settled(attempt)) return;
    if (answered.ok) { setPhase({ step: "facts", facts: answered.facts }); return; }
    // A lost answer is not a reason to send the write again on the caller's behalf: the retry identity is idempotent by
    // the record's own rule, so the facts stay on screen and the same offer stands.
    setPhase(answered.code === "network_unreachable"
      ? { step: "lost", facts: current, reason: answered.message }
      : { step: "refused", facts: current, code: answered.code, message: answered.message });
  }, [client, fence, sessionId]);

  // A surface with nothing to state yet states nothing: an empty announced region is noise in a transcript header,
  // and the read's own state is what the reader needs to see once there is one.
  if (!isChild || phase.step === "idle") return null;

  if (phase.step === "facts" && phase.facts === null) {
    // A child the catalogue named as delegated but that states no delegation is stated, not hidden: the relation the row
    // shows and the record the runtime holds are two different facts, and the reader has to know which one is missing.
    return (
      <div role="status" data-child-recovery="none" style={{ margin: "0 16px 8px", padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text-dim)", fontSize: 11 }}>
        {t("childRecovery.none")}
      </div>
    );
  }

  const facts = phase.step === "facts" || phase.step === "retrying" || phase.step === "refused" || phase.step === "lost" ? phase.facts : null;
  if (facts === null) {
    return (
      <div role="status" aria-busy={phase.step === "loading"} data-child-recovery={phase.step} style={{ margin: "0 16px 8px", padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text-dim)", fontSize: 11 }}>
        <span>
          {phase.step === "unavailable"
            ? t("childRecovery.unavailable") + ": " + phase.message
            : phase.step === "loading" ? t("childRecovery.loading") : null}
        </span>
        {phase.step === "unavailable" && (
          // A read that did not answer says nothing about the child, so the reader can ask again without leaving the
          // child: the connection may be back, and the facts and the retry are otherwise unreachable from here.
          <button type="button" data-child-recovery-action="read-again" onClick={() => { void read(); }} style={BUTTON}>{t("childRecovery.refresh")}</button>
        )}
      </div>
    );
  }

  const words = childRecoveryWords(facts, t);
  const identities = retryablePreparation(facts);
  const error = facts.preparationError;

  return (
    <div
      role="status"
      data-child-recovery="facts"
      data-child-preparation={facts.preparation ?? "none"}
      data-child-delivery={facts.delivery ?? "none"}
      data-child-anchor={facts.anchorPhase ?? "none"}
      style={{ margin: "0 16px 8px", padding: "7px 12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}
    >
      <span style={{ fontWeight: 600, color: "var(--text)" }}>{t("childRecovery.title")}</span>
      {words.map((entry) => (
        <span key={entry.id} data-recovery-word={entry.id.split(".").slice(-2).join(".")} style={{ color: wordColor(entry.id) }}>{entry.text}</span>
      ))}
      {error !== undefined && (
        // The runtime's own sentence about the failed attempt, shown as it arrived: paraphrasing a cause is how a
        // reader ends up acting on words nobody wrote.
        <span title={error} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>{error}</span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        {phase.step === "refused" && <span data-child-recovery-notice style={{ color: "#dc2626" }}>{phase.code} · {phase.message}</span>}
        {phase.step === "lost" && <span data-child-recovery-notice style={{ color: "#d97706" }}>{t("childRecovery.lost")}</span>}
        {identities !== null && (
          <button
            type="button"
            data-child-recovery-retry="true"
            disabled={phase.step === "retrying"}
            aria-busy={phase.step === "retrying"}
            onClick={() => { void retry(identities, facts); }}
            title={t("childRecovery.retryHint", { request: identities.requestId, attempt: identities.failedTaskId })}
            style={{ ...BUTTON, borderColor: "var(--accent)", color: "var(--accent)" }}
          >
            {phase.step === "retrying" ? t("childRecovery.retrying") : t("childRecovery.retry")}
          </button>
        )}
        <button type="button" onClick={() => { void read(); }} style={BUTTON}>{t("childRecovery.refresh")}</button>
      </span>
    </div>
  );
}
