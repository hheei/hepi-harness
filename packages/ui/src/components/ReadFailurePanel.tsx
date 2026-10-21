"use client";

import { useI18n } from "../hooks/useI18n";
import { readFailureKey, readFailureRetryable, type ReadFailure } from "../lib/read-recovery";

/**
 * What a surface shows when a read did not answer.
 *
 * It exists because a failed read used to be two things it should not be: a raw error string on screen — the Backend's
 * own diagnostics, entry ids and byte counts — and, once the conversation had content, nothing at all. Both are fixed
 * here by one component with two placements:
 *
 * - `surface`: nothing of this conversation can be drawn, so the panel takes the transcript's place. It states which
 *   failure it was and offers the one action that can help — a Retry for a read that never answered, and a way back to
 *   the conversation list for one that cannot.
 * - `inline`: the conversation is still on screen — the projection keeps its accepted window across a failed read — so
 *   the panel is a banner above it. The reader keeps reading, keeps their draft, and may retry from here.
 *
 * The recovery is **read-only**: it re-runs the conversation read and nothing else. A submission, a control action or an
 * upload whose outcome was never established is not resent by this button — those go back through the request id they
 * were made under, which is the submission recovery's own seam (ADR 0006) and not this one.
 */
export function ReadFailurePanel({
  failure,
  message,
  variant,
  retrying = false,
  onRetry,
  onBack,
  onDismiss,
}: {
  failure: ReadFailure;
  /** An authored sentence to show instead of the failure's own. A refused projection names what it refused. */
  message?: string;
  variant: "surface" | "inline";
  retrying?: boolean;
  onRetry?: () => void;
  onBack?: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const retryable = readFailureRetryable(failure);
  const text = message ?? t(readFailureKey(failure));
  const action = retryable && onRetry
    ? (
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        aria-busy={retrying}
        style={buttonStyle(true)}
      >
        {retrying ? t("chat.readRetrying") : t("chat.readRetry")}
      </button>
    )
    : null;
  const back = onBack
    ? <button type="button" onClick={onBack} disabled={retrying} style={buttonStyle(false)}>{t("chat.readBack")}</button>
    : null;

  if (variant === "inline") {
    return (
      <div
        role="status"
        data-read-failure={failure.kind}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          margin: "0 16px 8px",
          padding: "8px 12px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          color: "var(--text-muted)",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <span style={{ minWidth: 0, flex: "1 1 240px", overflowWrap: "anywhere" }}>{text}</span>
        {action}
        {onDismiss && (
          <button type="button" onClick={onDismiss} style={buttonStyle(false)}>{t("chat.readDismiss")}</button>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      data-read-failure={failure.kind}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        textAlign: "center",
        color: "var(--text-muted)",
      }}
    >
      <div style={{ fontSize: 14, color: "var(--text)", maxWidth: 560, overflowWrap: "anywhere" }}>{text}</div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
        {action}
        {back}
      </div>
    </div>
  );
}

/** One button in the panel. A Retry is the primary action; everything else is the quiet one beside it. */
function buttonStyle(primary: boolean) {
  return {
    minHeight: 32,
    padding: "0 14px",
    border: primary ? "1px solid transparent" : "1px solid var(--border)",
    borderRadius: 6,
    background: primary ? "var(--accent)" : "transparent",
    color: primary ? "#fff" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  } as const;
}
