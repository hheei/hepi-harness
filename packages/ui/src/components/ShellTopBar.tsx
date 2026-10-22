"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile, useIsNarrowMobile } from "../hooks/useIsMobile";
import { useI18n } from "../hooks/useI18n";
import { useDismissOnOutsidePointer } from "../hooks/useSurfaceFocus";
import type { SessionInfo } from "../lib/types";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { ToolEntry } from "../lib/tool-presets";
import type { ProjectTrustStatus } from "@hepi/protocol/mcp-ui";
import type { SessionFamily } from "../lib/session-family";
import { ShellTopPanel, type TopPanel } from "./ShellTopPanel";
import type { SessionCopyField } from "./SessionStatsPopover";

export type { SessionCopyField };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const AGENT_PANEL_WIDTH = 420;

interface Props {
  /** Whether the sidebar is on screen, which is what its toggle states and what it returns focus to. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSidebarOpen: (open: boolean) => void;
  sidebarToggleRef: React.RefObject<HTMLButtonElement | null>;
  /** The bar's own element: the panel below it is anchored to the rect this states. */
  topBarRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the chat is showing something: a conversation, or a fresh composer with a folder. */
  showChat: boolean;
  /** The panel the bar has open, if any. */
  activePanel: TopPanel | null;
  onActivePanel: (panel: TopPanel | null) => void;
  /** The conversation on screen, or `null` while a fresh composer is. */
  session: SessionInfo | null;
  family: SessionFamily | null;
  runningSessionIds: ReadonlySet<string>;
  onSelectConversation: (session: SessionInfo) => void;
  onSubtreeControlled: () => void;
  onDelegated: () => void;
  canDelegate: boolean;
  delegateTargets: readonly { id: string; label: string }[];
  historyFocus: { sessionId: string; entryId: string } | null;
  onOpenSession: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  onSessionForked: (sessionId: string) => void;
  systemPrompt: string | null;
  systemTools: ToolEntry[] | null;
  /** Opening the system or tool panel asks for a read of it: one loader, one load id, one pending state. */
  systemInfoLoaderRef: React.RefObject<(() => Promise<void>) | null>;
  stats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  copiedField: SessionCopyField | null;
  onCopyField: (field: SessionCopyField, value: string) => void;
  autoNameStatus: AutoNameStatus;
  onAutoName: () => void;
  /** A run finished in this conversation: the full history behind it is worth offering. */
  onViewFullHistory: () => void;
  trust: ProjectTrustStatus | null;
  onOpenTrustDialog: () => void;
  /** Whether the file panel is on screen. */
  filesOpen: boolean;
  onToggleFiles: () => void;
}

/** What the top bar's auto-name button is doing, so its own icon and sentence can state it. */
export type AutoNameStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "naming" }
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly message: string };

/**
 * The bar above the chat: which surfaces are open, and the conversation's own readout.
 *
 * It is the shell's presentation of the facts the rest of the tree stated — the conversation on screen, its stats and
 * context window, its family and its capability to delegate — plus the reader's own layout choices: which side panels are
 * open, and which of the panels that hang from this bar is. Nothing here reads a resource or decides what the workbench
 * shows; every action is an intent the owner of that fact carries out.
 *
 * The narrow layout is this component's own rule, and it is a rule about *space*, not about data: below the narrow
 * breakpoint the secondary actions live behind one More control, and that control's own overlay is what closes on a
 * pointer down elsewhere or on Escape.
 */
export function ShellTopBar(props: Props) {
  const {
    sidebarOpen, onToggleSidebar, onSidebarOpen, sidebarToggleRef, topBarRef, showChat, activePanel, onActivePanel,
    session, family, runningSessionIds, onSelectConversation, onSubtreeControlled, onDelegated, canDelegate,
    delegateTargets, historyFocus, onOpenSession, onSessionForked, systemPrompt, systemTools,
    systemInfoLoaderRef, stats, contextUsage, copiedField, onCopyField, autoNameStatus, onAutoName, onViewFullHistory,
    trust, onOpenTrustDialog, filesOpen, onToggleFiles,
  } = props;
  const { locale, t } = useI18n();
  const mobile = useIsMobile();
  const narrow = useIsNarrowMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [systemInfoPending, setSystemInfoPending] = useState(false);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  // The child tree and the delegate entry exist only when the conversation states them: a family with subagents, and a
  // capability the conversation's own selection carries.
  const hasSubagents = (family?.subagents.length ?? 0) > 0;
  const systemInfoLoadIdRef = useRef(0);

  // The More control's overlay is a surface of its own: a pointer down outside it and Escape both dismiss it, and the
  // Escape that closes it is not also the one that stops a run.
  useDismissOnOutsidePointer(moreOpen, mobileToolbarRef, useCallback(() => setMoreOpen(false), []));

  // The bar's own layout moved with the reader: a fresh conversation, a different viewport or a switch between the wide
  // and narrow toolbars all close the overlay rather than leaving it over the wrong controls.
  useEffect(() => setMoreOpen(false), [mobile, narrow, session?.id]);

  /** Open or close one of the panels that hang from this bar. One at a time, and the sidebar steps aside for it. */
  const onTogglePanel = useCallback((panel: Exclude<TopPanel, null>, keepMobileToolbarOpen = false) => {
    if (mobile) onSidebarOpen(false);
    onActivePanel(activePanel === panel ? null : panel);
    if (mobile && narrow && keepMobileToolbarOpen) setMoreOpen(true);
  }, [activePanel, mobile, narrow, onActivePanel, onSidebarOpen]);

  /**
   * The system prompt and the tool list are read when their panel is opened, not on every render of the bar.
   *
   * One load id fences the pending state: a read that a second open superseded must not clear the flag the newer one
   * set. A loader that fails is stated in the panel, which is why nothing is reported here but the pending flag.
   */
  const onSystemInfoToggle = useCallback((panel: "system" | "tools", keepMobileToolbarOpen = false) => {
    const opening = activePanel !== panel;
    onTogglePanel(panel, keepMobileToolbarOpen);
    if (!opening || systemInfoPending) return;
    const load = systemInfoLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoPending(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) setSystemInfoPending(false);
    });
  }, [activePanel, onTogglePanel, systemInfoLoaderRef, systemInfoPending]);

  const onToggleMore = useCallback(() => {
    onSidebarOpen(false);
    onActivePanel(null);
    setMoreOpen((open) => !open);
  }, [onActivePanel, onSidebarOpen]);

  // The panel is anchored to the bar it hangs from, measured rather than guessed: the bar's height and left edge are the
  // host's own safe-area padding plus whatever the viewport is, so a fixed number would land the panel over the bar on
  // one platform and below it on another.
  useEffect(() => {
    if (!activePanel || !topBarRef.current) return;
    const update = () => {
      const bar = topBarRef.current!.getBoundingClientRect();
      if (activePanel === "agents" || activePanel === "delegate") {
        setTopPanelPos({ top: bar.bottom, left: bar.left, width: Math.min(AGENT_PANEL_WIDTH, bar.width) });
        return;
      }
      setTopPanelPos({ top: bar.bottom, left: bar.left, width: bar.width });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(topBarRef.current);
    return () => observer.disconnect();
  }, [activePanel, mobile, topBarRef]);

  // What the system and tool panels show: the pending state is this bar's own, and the values are the conversation's.
  const systemInfo = { prompt: systemPrompt, tools: systemTools, loading: systemInfoPending };

    const toolbarActions = (mobile: boolean) => {
      if (!mobile && !showChat) return null;
      return (
        <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
          <button
            type="button"
            onClick={() => {
              onViewFullHistory();
              if (mobile && narrow) setMoreOpen(true);
            }}
            disabled={!session}
            title={session ? t("history.full") : t("history.unsaved")}
            aria-label={t("history.full")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%",
              padding: mobile ? 0 : "0 12px",
              background: "none",
              border: "none",
              borderTop: "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: session ? "var(--text-muted)" : "var(--text-dim)",
              cursor: session ? "pointer" : "not-allowed",
              opacity: session ? 1 : 0.45,
              flexShrink: 0,
              fontSize: 11,
              whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s, opacity 0.1s",
            }}
            onMouseEnter={(event) => {
              if (!session) return;
              event.currentTarget.style.color = "var(--text)";
              event.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = session ? "var(--text-muted)" : "var(--text-dim)";
              event.currentTarget.style.background = "none";
            }}
            data-mobile-toolbar-action={mobile ? "history" : undefined}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                color: session ? "var(--text-muted)" : "var(--text-dim)",
                flexShrink: 0,
              }}
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
            {!mobile && <span>{t("history.label")}</span>}
          </button>
          {(() => {
            // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
            const hasMessages = Boolean(
              session
              && ((stats?.userMessages ?? 0) > 0 || session.messageCount > 0),
            );
            const disabled = !session || session.transient || !hasMessages || autoNameStatus.kind === "naming";
            const isSuccess = autoNameStatus.kind === "success";
            const isError = autoNameStatus.kind === "error";
            const label = autoNameStatus.kind === "naming"
              ? t("title.generating")
              : isSuccess
                ? t("title.updated")
                : isError
                  ? t("title.failed")
                  : t("title.generate");
            const title = !session || session.transient
              ? t("title.unsaved")
              : !hasMessages
                ? t("title.noMessages")
                : isError
                  ? autoNameStatus.message
                  : t("title.generateSession");

            return (
              <button
                type="button"
                onClick={() => {
                  void onAutoName();
                  if (mobile && narrow) setMoreOpen(true);
                }}
                disabled={disabled}
                title={title}
                aria-label={label}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                  height: "100%", padding: mobile ? 0 : "0 12px",
                  background: "none", border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                  flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(event) => {
                  if (disabled) return;
                  event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                  event.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                  event.currentTarget.style.background = "none";
                }}
                data-mobile-toolbar-action={mobile ? "name" : undefined}
              >
                {autoNameStatus.kind === "naming" ? (
                  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : isSuccess ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 4 5 5L7 22l-5-5Z" />
                    <path d="m14 5 5 5" />
                    <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                  </svg>
                )}
                {!mobile && <span>{label}</span>}
              </button>
            );
          })()}
          {canDelegate && (
            <button
              type="button"
              onClick={() => onTogglePanel("delegate", mobile)}
              title={t("delegate.open")}
              aria-label={t("delegate.open")}
              aria-pressed={activePanel === "delegate"}
              data-delegate-entry
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: activePanel === "delegate" ? "var(--bg-selected)" : "none",
                border: "none",
                borderTop: activePanel === "delegate" ? "2px solid var(--accent)" : "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: activePanel === "delegate" ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s",
              }}
              data-mobile-toolbar-action={mobile ? "delegate" : undefined}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12h9" /><path d="m11 8 4 4-4 4" /><rect x="16" y="7" width="5" height="10" rx="1.5" />
              </svg>
              {!mobile && <span>{t("delegate.open")}</span>}
            </button>
          )}
          {hasSubagents && (
            <button
              type="button"
              onClick={() => onTogglePanel("agents", mobile)}
              title={t("agentSwitcher.title")}
              aria-label={t("agentSwitcher.title")}
              aria-pressed={activePanel === "agents"}
              data-agent-switcher
              style={{
                position: "relative",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: activePanel === "agents" ? "var(--bg-selected)" : "none",
                border: "none",
                borderTop: activePanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: activePanel === "agents" ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s",
              }}
              data-mobile-toolbar-action={mobile ? "agents" : undefined}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
              </svg>
              {!mobile && <span>{t("agentSwitcher.title")}</span>}
              <span
                aria-hidden="true"
                style={{
                  minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                  borderRadius: 7, background: "var(--bg-selected)", color: "var(--accent)",
                  fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                  ...(mobile ? { position: "absolute", top: 2, right: 2, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
                }}
              >
                {family!.subagents.length}
              </span>
            </button>
          )}
          <button
              type="button"
            onClick={() => onSystemInfoToggle("system", mobile)}
            disabled={mobile && !showChat}
            title={t("system.prompt")}
            aria-label={t("system.prompt")}
            aria-pressed={activePanel === "system"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activePanel === "system" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activePanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              cursor: mobile && !showChat ? "not-allowed" : "pointer",
              color: activePanel === "system" ? "var(--text)" : "var(--text-muted)",
              opacity: mobile && !showChat ? 0.45 : 1,
              fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
            }}
            onMouseEnter={(event) => {
              if (mobile && !showChat) return;
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = activePanel === "system" ? "var(--text)" : "var(--text-muted)";
            }}
            data-mobile-toolbar-action={mobile ? "system" : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            {!mobile && <span>{t("system.label")}</span>}
          </button>
          <button
            type="button"
            onClick={() => onSystemInfoToggle("tools", mobile)}
            disabled={mobile && !showChat}
            title={t("tools.title")}
            aria-label={t("tools.title")}
            aria-pressed={activePanel === "tools"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activePanel === "tools" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activePanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              cursor: mobile && !showChat ? "not-allowed" : "pointer",
              color: activePanel === "tools" ? "var(--text)" : "var(--text-muted)",
              opacity: mobile && !showChat ? 0.45 : 1,
              fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
            }}
            onMouseEnter={(event) => {
              if (mobile && !showChat) return;
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = activePanel === "tools" ? "var(--text)" : "var(--text-muted)";
            }}
            data-mobile-toolbar-action={mobile ? "tools" : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
            </svg>
            {!mobile && <span>{t("tools.label")}</span>}
          </button>
        </div>
      );
    };


    const sessionStatsButton = (mobile: boolean) => {
      if (!mobile && (!showChat || (!stats && !contextUsage))) return null;

      const tokens = stats?.tokens;
      const cost = stats?.cost ?? 0;
      const formatCompact = (value: number) => value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1000
          ? `${(value / 1000).toFixed(0)}k`
          : String(value);
      const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

      let contextColor = "var(--text-muted)";
      let desktopContextText: string | null = null;
      let mobileContextText: string | null = null;
      if (contextUsage?.contextWindow) {
        const percent = contextUsage.percent;
        if (percent !== null && percent > 90) contextColor = "#ef4444";
        else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
        desktopContextText = percent !== null
          ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
          : `? / ${formatCompact(contextUsage.contextWindow)}`;
        mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
      }

      const tooltipParts: string[] = [];
      if (tokens) {
        tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
        tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
        tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
        tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
        if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
      }
      if (contextUsage?.contextWindow) {
        const percent = contextUsage.percent;
        tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
      }
      const tooltip = tooltipParts.join("  |  ");
      const covered = mobile && narrow && moreOpen;
      const hasMobileValues = Boolean(
        (tokens && (tokens.input > 0 || tokens.output > 0))
        || costText
        || mobileContextText,
      );

      return (
        <button
          type="button"
          onClick={() => onTogglePanel("session")}
          disabled={!showChat || covered}
          tabIndex={covered ? -1 : undefined}
          title={tooltip || t("session.title")}
          aria-label={t("session.title")}
          aria-pressed={activePanel === "session"}
          aria-hidden={covered ? true : undefined}
          className={mobile ? "mobile-session-stats" : undefined}
          data-mobile-toolbar-stats={mobile ? "true" : undefined}
          style={{
            marginLeft: mobile ? 0 : "auto",
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            flex: mobile ? 1 : undefined,
            minWidth: 0,
            gap: mobile ? 7 : 10,
            paddingLeft: mobile ? 6 : 12,
            paddingRight: mobile ? 6 : 12,
            height: "100%",
            overflow: "hidden",
            visibility: covered ? "hidden" : "visible",
            pointerEvents: covered ? "none" : "auto",
            background: activePanel === "session" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activePanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
            fontSize: 11, color: "var(--text-muted)",
            whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
            fontVariantNumeric: "tabular-nums",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activePanel === "session" ? "var(--text)" : "var(--text-muted)";
          }}
        >
          {mobile ? (
            <>
              {tokens && tokens.input > 0 && (
                <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                  </svg>
                  {formatCompact(tokens.input)}
                </span>
              )}
              {tokens && tokens.output > 0 && (
                <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                  </svg>
                  {formatCompact(tokens.output)}
                </span>
              )}
              {costText && (
                <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                  {costText}
                </span>
              )}
              {mobileContextText && (
                <span style={{ color: contextColor, flexShrink: 0 }}>
                  {mobileContextText}
                </span>
              )}
              {!hasMobileValues && showChat && (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                  {t("session.title")}
                </span>
              )}
            </>
          ) : (
            <>
              {tokens && tokens.input > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                  </svg>
                  {formatCompact(tokens.input)}
                </span>
              )}
              {tokens && tokens.output > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                  </svg>
                  {formatCompact(tokens.output)}
                </span>
              )}
              {tokens && tokens.cacheRead > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                  </svg>
                  {formatCompact(tokens.cacheRead)}
                </span>
              )}
              {costText && (
                <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                  {costText}
                </span>
              )}
              {desktopContextText && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                  </svg>
                  {desktopContextText}
                </span>
              )}
            </>
          )}
        </button>
      );
    };


    const filesToggle = (mobile: boolean) => {
      const covered = mobile && narrow && moreOpen;
      return (
        <button
          type="button"
          onClick={onToggleFiles}
          disabled={covered}
          tabIndex={covered ? -1 : undefined}
          aria-controls="file-panel"
          aria-expanded={filesOpen}
          aria-hidden={covered ? true : undefined}
          title={filesOpen ? t("files.hidePanel") : t("files.showPanel")}
          aria-label={filesOpen ? t("files.hidePanel") : t("files.showPanel")}
          data-mobile-toolbar-file={mobile ? "true" : undefined}
          style={{
            marginLeft: !mobile && !stats && !contextUsage ? "auto" : 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
            visibility: covered ? "hidden" : "visible",
            pointerEvents: covered ? "none" : "auto",
            background: filesOpen ? "var(--bg-selected)" : "none",
            border: "none", borderLeft: "1px solid var(--border)",
            color: filesOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
          }}
          onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = filesOpen ? "var(--text)" : "var(--text-muted)"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
      );
    };

    const trustBanner = (mobileBanner: boolean) => {
      if (!showChat || !trust?.requiresTrust || trust.trusted) return null;
      return (
        <button
          type="button"
          onClick={onOpenTrustDialog}
          title={t("trust.resourcesNotLoaded")}
          aria-label={t("trust.resourcesNotLoaded")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: mobileBanner ? "flex-start" : "center",
            gap: 6,
            width: mobileBanner ? "100%" : undefined,
            minHeight: mobileBanner ? 32 : undefined,
            height: mobileBanner ? undefined : "100%",
            padding: mobileBanner ? "6px 12px" : "0 12px",
            background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
            border: "none",
            borderRight: mobileBanner ? "none" : "1px solid var(--border)",
            borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
            color: "#d97706",
            cursor: "pointer",
            flexShrink: 0,
            fontSize: 11,
            lineHeight: 1.35,
            textAlign: "left",
          }}
          data-mobile-trust-banner={mobileBanner ? "true" : undefined}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span>{t("trust.resourcesNotLoaded")}</span>
        </button>
      );
    };

  return (
    <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            ref={sidebarToggleRef}
            onClick={onToggleSidebar}
             title={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")}
             aria-label={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {mobile && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {narrow && (
                <button
                  type="button"
                  onClick={onToggleMore}
                  title={moreOpen ? t("chat.close") : t("chat.moreControls")}
                  aria-label={moreOpen ? t("chat.close") : t("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={moreOpen}
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: moreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                    background: moreOpen ? "var(--bg-selected)" : "none",
                    border: "none", borderRight: "1px solid var(--border)",
                    color: moreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {moreOpen ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                    </svg>
                  )}
                </button>
              )}
              {!narrow && toolbarActions(true)}
              {sessionStatsButton(true)}
              {filesToggle(true)}
              {narrow && moreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={t("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {toolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!mobile && (
            <>
              {trustBanner(false)}
              {toolbarActions(false)}
              {sessionStatsButton(false)}
            </>
          )}
          {!mobile && filesToggle(false)}
          {/* The one panel the bar can have open, and where it is anchored: the bar's own rect, measured. */}
          {activePanel && topPanelPos && (
            <ShellTopPanel
              activePanel={activePanel}
              position={topPanelPos}
              session={session}
              family={family}
              runningSessionIds={runningSessionIds}
              onSelectConversation={onSelectConversation}
              onSubtreeControlled={onSubtreeControlled}
              onDelegated={onDelegated}
              canDelegate={canDelegate}
              delegateTargets={delegateTargets}
              historyFocus={historyFocus}
              onOpenSession={onOpenSession}
              onSessionForked={onSessionForked}
              systemInfo={systemInfo}
              stats={stats}
              contextUsage={contextUsage}
              copiedField={copiedField}
              onCopyField={onCopyField}
              mobile={mobile}
            />
          )}
      </div>
      {mobile && trustBanner(true)}
    </div>
  );
}
