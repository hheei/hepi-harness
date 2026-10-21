"use client";
import { useI18n } from "../hooks/useI18n";
import { navigationOutcomeKey, type NavigationOutcome } from "../lib/history-navigation";

/**
 * One navigation outcome, stated by name (history-navigation ticket 03).
 *
 * A jump or a deep locate that did not land is a state the reader can read and act on — retry, open the entry in the
 * raw-history surface, or leave it — never a silent no-op and never a report of success. The banner is rendered from
 * the settled outcome alone, so the seven names cannot collapse into one another: each carries its own sentence, and a
 * failure the reader cannot act on is still a failure on screen.
 *
 * It is a component of its own because that is the seam the acceptance reads: an outcome's rendered state is what a
 * reader sees, and it is checkable without a transcript, a viewport or a Backend.
 */
export function NavigationOutcomeBanner({
  outcome,
  conversationId,
  onOpenSession,
  onDismiss,
  minimapWidth,
  columnPadding,
  isMobile,
}: {
  /** The navigation this surface asked for, or none. A landing renders nothing. */
  readonly outcome: NavigationOutcome | null;
  /** The conversation on screen, which the raw-history offer addresses within. */
  readonly conversationId: string | null;
  /** The shell's own "open this entry" seam, the one every other navigation to an entry uses. */
  readonly onOpenSession?: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  /** Retire the outcome. The surface that owns the reader's request retires it with its own pending target. */
  readonly onDismiss: () => void;
  readonly minimapWidth: number;
  readonly columnPadding: number;
  readonly isMobile: boolean;
}) {
  const { t } = useI18n();
  if (outcome === null || outcome.kind !== "failed") return null;
  const entryId = outcome.request.target.entryId;
  return (
    <div
      data-navigation-outcome={outcome.failure}
      role="status"
      aria-live="polite"
      style={{
        position: "absolute", top: 12, left: 0, right: isMobile ? 0 : minimapWidth, zIndex: 41,
        display: "flex", justifyContent: "center", padding: `0 ${columnPadding}px`, pointerEvents: "none",
      }}
    >
      <div
        style={{
          pointerEvents: "auto", display: "flex", gap: 8, alignItems: "center", maxWidth: "min(100%, 620px)",
          border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg)", color: "var(--text-muted)",
          padding: "6px 10px", fontSize: 13,
        }}
      >
        <span>{t(navigationOutcomeKey(outcome.failure))}</span>
        <button type="button" data-navigation-retry onClick={() => { outcome.retry(); }}>{t("i18n.retryLoad")}</button>
        {/* The second offer the ticket asks an outcome to carry: the entry may be one this window cannot carry at all
            (a compacted or inherited entry), and the raw-history surface is the shell's own answer for that. An address
            this contract could not read names no entry, so there is nothing there to open either. */}
        {onOpenSession !== undefined && entryId !== "" && conversationId !== null && (
          <button
            type="button"
            onClick={() => { onOpenSession(conversationId, entryId, { rawHistoryFocus: true }); }}
          >{t("navigation.openRaw")}</button>
        )}
        <button type="button" onClick={onDismiss}>{t("navigation.dismiss")}</button>
      </div>
    </div>
  );
}
