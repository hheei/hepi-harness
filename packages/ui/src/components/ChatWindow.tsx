"use client";
import { registerAbortHandler } from "../hooks/useKeyboardShortcuts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, SessionInfo, ToolResultMessage } from "../lib/types";
import { buildTurnModel, resolveSearchTarget, type TurnDescription, type TurnItem } from "../lib/chat/chat-turn-model";
import { turnAnchorEntryId, turnByKey, turnKeyForAnchorEntry, turnKeyForEntry } from "../lib/chat/chat-turn-identity";
import { extractTurnWrittenFiles, type WrittenFile } from "../lib/turn-written-files";
import { buildQuotedSelection } from "../lib/quoted-selection";
import { dropMentionText, splitDroppedItems, type DroppedItem } from "../lib/file/file-upload-client";
import { uploadFiles } from "../lib/file/file-seam";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import { useHistoryNavigation } from "../hooks/useHistoryNavigation";
import { NavigationOutcomeBanner } from "./NavigationOutcomeBanner";
import { navigationHoldsViewport, searchSettlementAction } from "../lib/history-navigation";
import { MessageView } from "./MessageView";
import { pendingMessage } from "../lib/lifecycle-projection";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { AnsiText } from "./AnsiText";
import { useI18n } from "../hooks/useI18n";
import { phaseLabel } from "../lib/chat/chat-phase-label";
import { ReadFailurePanel } from "./ReadFailurePanel";
import { ChildRecoveryPanel } from "./ChildRecoveryPanel";
import { useAgentSession, type NewSessionChoices, type UseAgentSessionOptions } from "../hooks/useAgentSession";
import { useTranscriptPresentation } from "../hooks/useTranscriptPresentation";
import { NoticeShelf } from "./NoticeShelf";
import { useDragDrop } from "../hooks/useDragDrop";
import { useIsMobile } from "../hooks/useIsMobile";
import { useScrollbarVisibility } from "../hooks/useScrollbarVisibility";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { AppUpdateResponse } from "../lib/api-types";
import type { ToolEntry } from "../lib/tool-presets";
import type { SettingsSection } from "../lib/settings-navigation";
import { findChatScrollAnchor, type ChatScrollPosition } from "../lib/chat/chat-scroll-position";
import { isScrollAtTail } from "../lib/chat/chat-lazy-load";
import { useTranscriptWindow } from "../lib/transcript-window";
import { startScrollSettlement, type ScrollSettlementHandle } from "../lib/scroll-settlement";

/**
 * Subscribe to the reader's own scrolling gestures on a container.
 *
 * The events are the reader's *input* — a wheel, a touch, a drag of the scrollbar, a scroll key — and deliberately not
 * the `scroll` event. A windowed transcript moves the scroll position itself when the geometry above the reader
 * changes, and those corrections are the surface's own doing; a listener on `scroll` could not tell them apart from a
 * person, so a navigation waiting for a newly measured page would abandon itself the instant that page was measured.
 */
function onReaderScrollIntent(container: HTMLElement, listener: () => void): () => void {
  const events = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
  const handleKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowUp" || key === "ArrowDown" || key === "PageUp" || key === "PageDown" || key === "Home" || key === "End" || key === " ") listener();
  };
  for (const name of events) container.addEventListener(name, name === "keydown" ? handleKey : listener, { passive: true });
  return () => {
    for (const name of events) container.removeEventListener(name, name === "keydown" ? handleKey : listener);
  };
}
import { TranscriptWindowSurface } from "../lib/transcript-window-surface";

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  /** Join the conversation's event stream through the shell's one connection per conversation. */
  subscribeAgentEvents?: UseAgentSessionOptions["subscribeAgentEvents"];
  /** Hand this conversation's projection over, so leaving it keeps its stream. */
  onProjectionChange?: UseAgentSessionOptions["onProjectionChange"];
  /** Report this conversation's live settlements to the page's one registry. */
  onLiveSettlement?: UseAgentSessionOptions["onLiveSettlement"];
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Shown above the composer while a fresh composer is still empty: where its session starts. */
  newSessionContextBar?: ReactNode;
  /** A fresh composer's model and reasoning picks, carried from the composer it replaces. */
  initialNewSessionChoices?: NewSessionChoices | null;
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  /** Registers this conversation's explicit reload for the surfaces that ask for one from outside the chat. */
  onConversationReloadChange?: UseAgentSessionOptions["onConversationReloadChange"];
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  /** Opens Settings on a section: a bare `/mcp` that pi's built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Files dropped onto the chat were written into the working directory. */
  onFilesUploaded?: () => void;
  onOpenSession?: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  /**
   * Leave this conversation for one that is known to work: the composer of the folder it is in.
   *
   * It is the other half of a read failure's recovery. A Retry is the honest step for a read that never answered; a
   * conversation the Backend says is gone, or a projection it refuses, will answer the same way however many times it
   * is asked, so what the reader needs is a way back to a context that is not broken — with their draft still theirs,
   * because the composer keeps it under the session key it was written under.
   */
  onReadFailureBack?: () => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}
const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;

// One update check per page. Every fresh composer mounts the header again
// (each move of the new-session bar does), and a link that turned up late
// each time could push the bar onto a line of its own under the composer's
// eyes; from the second header on it is there in the first paint.
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch("/api/app-update")
    .then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as AppUpdateResponse;
      return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(() => appUpdateFound);

  useEffect(() => {
    if (appUpdateFound) return;
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (!cancelled && result) setUpdate(result);
    });
    return () => { cancelled = true; };
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        gap: 3,
        minHeight: 32,
        minWidth: 0,
        padding: "0 4px",
        background: "transparent",
        borderRadius: 5,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.2,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * A process group's expansion, owned above the group.
 *
 * The group is mounted and unmounted as the window moves, so an expansion kept in the group's own `useState` is lost
 * the moment its turn leaves the window and comes back — the reader collapses or expands a turn, scrolls away, and
 * returns to find the opposite. The state therefore lives here, keyed on the turn's stable identity rather than on a
 * mounted component, and the group reads it rather than owning it.
 *
 * The key is the *turn* key, not the process group's own: a turn has one process group, and keying on the turn means a
 * toggle survives the group being re-created with a different message count as the turn grows.
 */
function useProcessExpansion(initial?: Readonly<Record<string, boolean>>): {
  getSnapshot: () => Readonly<Record<string, boolean>>;
  isExpanded: (turnKey: string, defaultExpanded: boolean) => boolean;
  toggle: (turnKey: string, current: boolean) => void;
  reveal: (turnKeys: readonly string[]) => void;
} {
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>(() => initial ?? {});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const getSnapshot = useCallback(() => expandedRef.current, []);
  const isExpanded = useCallback(
    (turnKey: string, defaultExpanded: boolean) => expanded[turnKey] ?? defaultExpanded,
    [expanded],
  );
  const toggle = useCallback((turnKey: string, current: boolean) => {
    setExpanded((previous) => ({ ...previous, [turnKey]: !current }));
  }, []);
  // A reveal is the surface asking for a group to be open (a search hit inside it), not the reader's own choice, so it
  // is recorded as expanded rather than as an override of one — collapsing afterwards still works. The keys are
  // compared against what is already open and the state is left untouched when nothing changes, because this runs from
  // an effect and must not re-render on every transcript change.
  const reveal = useCallback((turnKeys: readonly string[]) => {
    setExpanded((previous) => {
      let next: Record<string, boolean> | null = null;
      for (const key of turnKeys) {
        if (previous[key] === true) continue;
        next = next ?? { ...previous };
        next[key] = true;
      }
      return next ?? previous;
    });
  }, []);
  return { getSnapshot, isExpanded, toggle, reveal };
}

function ProcessDetailsGroup({ messageCount, toolCallCount, expanded, reveal = false, onToggle, children, t }: { messageCount: number; toolCallCount: number; expanded: boolean; reveal?: boolean; onToggle: () => void; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const open = expanded || reveal;
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={open ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, onReadFailureBack, initialScrollPosition, onScrollPositionChange, newSessionCwd, newSessionDraftKey, newSessionContextBar, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd, onSessionCreated, onSessionForked, subscribeAgentEvents, onProjectionChange, onLiveSettlement, chatInputRef, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onConversationReloadChange, onSessionStatsChange, onOpenSettings, onContextUsageChange, onOpenFile, onFilesUploaded, onOpenSession, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // The completion tone is a callback, not a transport handler: the session reports one answered turn through
  // `onAgentEnd`, and the surface it is showing decides whether that is a sound for this reader.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [completionNotificationsEnabled, onAgentEnd]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const processExpansion = useProcessExpansion(initialScrollPositionRef.current?.processExpansion);
  const snapshotProcessExpansion = processExpansion.getSnapshot;
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    data: sessionData, loading, error, readFailure, retryRead, dismissReadFailure, messages, pendingSubmissions, outstandingSubmissions, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, modelNames, modelList, modelError, runFailure, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel,
    contextUsage, forkingEntryId,
    displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, queuedItems, control,
    notices, extensionStatuses, extensionWidgets, addNotice, dismissNotice,
    ownSends,
    isAutoModelSelection,
    isAutoThinkingSelection,
    statusPhase,
    isNew,
    sessionIdRef,
    handleSend, handleAbort, handleFork, handleModelChange,
    handleSteer, handleFollowUp, handlePromptWithStreamingBehavior,
    handleRecallQueue, handleEditItem, handleCancelItem, handleContinue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, loadSlashCommands,
    loadContext, activeLeafId, landWindow, retryModels,
  } = useAgentSession({
    session, newSessionCwd, newSessionDraftKey, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    subscribeAgentEvents, onProjectionChange, onLiveSettlement,
    chatInputRef, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange,
    onConversationReloadChange, onOpenSettings,
  });
  const sessionBusy = agentRunning;
  /**
   * A Retry in flight. The read itself already reports whether it is loading — but a read that failed leaves `loading`
   * false, so without this the panel's own button would be the only thing that moved while the retry ran, and a second
   * click would start a second read. The state belongs to the button, not to the projection: the projection's readiness
   * is the fold's, and a recovery must not fake it.
   */
  const [readRetrying, setReadRetrying] = useState(false);
  const runReadRetry = useCallback(async () => {
    if (readRetrying) return;
    setReadRetrying(true);
    try {
      await retryRead();
    } finally {
      setReadRetrying(false);
    }
  }, [readRetrying, retryRead]);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    window.getSelection()?.removeAllRanges();
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Older history ---
  // The window mounts the turns near the viewport, so which page of history is loaded is a separate question from
  // which turns are drawn. The sentinel at the top asks for the previous page; the loaded pages and their cursors
  // belong to the hook, and the window never reads one.
  const sentinelRef = useRef<HTMLDivElement>(null);
  /**
   * The transcript's own boxes, as this surface draws them.
   *
   * They are pure UI refs and stay local: the scrolling element the window measures, the content box a reading position
   * is measured against, and the box the reader's text selection is taken from. What a scroll *means* — following the
   * tail, placing a target, holding the reader's prompt — is the transcript presentation's (`useTranscriptPresentation`);
   * this component only hands it the elements and asks it to move.
   */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const restoreStartedRef = useRef(false);
  /** The page read a restore is waiting on, cancelled only when the position it was for is replaced. */
  const restoreAbortRef = useRef<AbortController | null>(null);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;

  // A restore is started once **per position**, and that is a property of the position rather than of the component.
  // The effect below re-runs whenever the hook hands back a new `loadContext` as the projection loads, and both of the
  // obvious ways to handle that re-run are wrong: leaving the start latch set means the retry never happens, and
  // clearing the position (or aborting the page read) on every re-run cancels the very fetch that mounts the reader's
  // turn. Tying the latch and the cancellation to the position is what makes a re-run a no-op and a replacement a
  // real cancellation.
  useEffect(() => {
    restoreStartedRef.current = false;
    return () => {
      restoreAbortRef.current?.abort();
      restoreAbortRef.current = null;
    };
  }, [pendingScrollRestore, session?.id]);
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  /**
   * The landing the **rail** asked for, when the reader clicked a node the transcript does not carry.
   *
   * A rail jump and the shell's deep search hit are the same navigation — one coordinate, one bounded target read, one
   * settlement — and they land through the same reveal and the same settlement below. What differs is only who retires
   * the request: the shell handed its target over and expects it back, while a rail click has nobody to hand anything
   * to. So the rail's own target is held here, beside the shell's, and the two effects treat them alike.
   *
   * It is state rather than a ref because `navigationHoldsViewport` reads it every render: from the moment the reader
   * clicks an unloaded node until its alignment finishes, the sentinel must stay silent, or a window moving toward an
   * entry three hundred turns back pages every entry on the way (spec decision 7).
   */
  const [railLanding, setRailLanding] = useState<{ sessionId: string; entryId: string } | null>(null);
  const railLandingRef = useRef(railLanding);
  railLandingRef.current = railLanding;
  /**
   * The request the pending scroll belongs to.
   *
   * A landing is aligned by the surface that asked for it, and both askers — the shell's deep search target and the
   * rail's own jump — produce the same pending scroll. What the alignment needs is not *which* surface asked but that
   * the debt it is holding still belongs to the request it was created for, so a newer request replaces it rather than
   * being aligned against an older entry's geometry.
   */
  const pendingScrollOwnerRef = useRef<{ readonly entryId: string } | null>(null);
  // Every read this surface makes — the transcript's, the files', and the navigation ones — belongs to the connection
  // the workbench is showing, so the connection is taken here rather than beside the upload that first used it.
  const connection = useWorkbenchConnection();
  /**
   * The conversation's navigation owner: one bounded target read per jump or deep search hit, and the outcome it
   * settled to (history-navigation ticket 03).
   *
   * It reads the transcript's own identity and entry ids, and writes history back through the session hook's paged
   * prefix owner, so a landing and a sentinel page are one kind of statement. Nothing here scrolls: `held` says the
   * target's entries are in the transcript, and the settlement effect below starts the presentation scroll once the
   * target's DOM exists — which is what keeps an animation presentation-only.
   */
  const conversationApi = connection.api;
  const { outcome: navigationOutcome, outline: navigationOutline, loadOutline: loadNavigationOutline, jump: jumpNavigationAnchor, locate: locateNavigation, dismiss: dismissNavigation } = useHistoryNavigation({
    conversationId: session?.id ?? null,
    snapshotRevision: sessionData?.snapshotRevision ?? null,
    busy: sessionBusy,
    activeEntryIds: entryIds,
    api: conversationApi,
    landWindow: (landed) => { if (sessionIdRef.current !== null) landWindow(sessionIdRef.current, landed); },
  });
  /**
   * The rail's outline pages.
   *
   * One page is read when a conversation opens and every further page is read when the reader reaches the end of what
   * the rail has listed, so a long history costs a bounded page rather than an unbounded index (spec decision 5). The
   * continuation cursor is the owner's own state, which is what makes a retry of the same page a no-op rather than a
   * duplicate: `reduceOutlinePages` de-duplicates an anchor it already holds.
   */
  const loadOutlinePage = useCallback((cursor?: number) => {
    void loadNavigationOutline(cursor === undefined ? undefined : { cursor });
  }, [loadNavigationOutline]);
  /**
   * The rail's own "more": one page, continued from the cursor the owner holds.
   *
   * The cursor is the owner's, never the rail's: a page states the continuation that reaches what it dropped, and a
   * surface that computed one from an anchor count would page from a position the Backend never issued. That cursor
   * survives a failed read (the state keeps what it read, which is what `reduceOutlinePages` guarantees), so a retry
   * of a lost continuation is that continuation and not a re-read of the first page.
   */
  const requestOutlinePage = useCallback(() => {
    loadOutlinePage(navigationOutline?.nextCursor);
  }, [loadOutlinePage, navigationOutline?.nextCursor]);
  // The first page is read once the conversation is on screen and its loading has settled. Reading before that would
  // page a history the surface cannot name, and re-reading on every snapshot would re-page the whole outline each time
  // a turn commits.
  const outlineLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    const conversationId = session?.id ?? null;
    if (conversationId === null || loading || outlineLoadedRef.current === conversationId) return;
    outlineLoadedRef.current = conversationId;
    loadOutlinePage();
  }, [loadOutlinePage, loading, session?.id]);
  /**
   * A conversation switch ends the rail's own request.
   *
   * The coordinator retires its held jump when the identity moves, so a landing for the conversation the reader left
   * never arrives. The rail's half of that retirement is here: its request and any pending scroll it owned are dropped
   * with the conversation, because a request left standing would hold the viewport gate shut for a target this surface
   * can no longer reach — the one state the spec refuses to leave a reader in.
   */
  useEffect(() => {
    setRailLanding(null);
    // The rail's own pending scroll goes with its request; the shell's target is retired by the shell, which is the
    // path ticket 03 already owns. The owner ref is what tells the two apart, so a scroll belonging to the shell's
    // request is not dropped by this surface's switch.
    if (pendingScrollOwnerRef.current !== railLandingRef.current) return;
    pendingScrollOwnerRef.current = null;
    setPendingSearchScroll(null);
  }, [session?.id]);
  // A conversation switch retires the outline the last one was read for: the rail's list describes the history the
  // reader left, and the owner clears its own state on the switch.
  useEffect(() => {
    if (session?.id) return;
    outlineLoadedRef.current = null;
  }, [session?.id]);
  /**
   * The window's "the caller moved the reader" signal, held by a ref rather than read from the hook's return value.
   *
   * The navigations that need it — restoring a position, settling a search — are declared above the window, and the
   * signal is a *side effect* rather than a rendered value: it has to reach the window before the scroll it describes
   * is handled, and depending on the hook object would re-create those effects whenever the window recomputed.
   */
  const adoptScrollPositionRef = useRef<(() => void) | null>(null);
  const adoptScrollPosition = useCallback(() => adoptScrollPositionRef.current?.(), []);
  // The transcript element as state, not only as a ref.
  //
  // The window computes its ranges in a layout effect that takes the element it measures. Read straight off the ref
  // during render, that value is whatever the ref held when the render began, and the transcript element does not exist
  // on a render that shows a read failure in the transcript place. The Retry that recovers such a read mounts the
  // element for the first time, and a ref assignment is not a render: the window kept measuring nothing and drew no turn
  // at all, so the panel left and an empty transcript arrived in its place. The element therefore lives in state as
  // well, and the callback ref below is what publishes it.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attachScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollContainerRef.current = element;
    setScrollElement(element);
  }, []);
  /**
   * The transcript's presentation: the viewport, follow-tail, the reader's own prompt, and the scrolls this surface asks
   * for. The conversation states what the transcript holds; where the reader is inside it is this owner's, so no scroll
   * ref or scroll decision of the session's is reachable from here (spec R4).
   */
  const presentation = useTranscriptPresentation({
    conversationId: session?.id ?? null,
    busy: sessionBusy,
    ownSends,
    messageCount: messages.length,
    loading,
    scrollElement,
    streamingMessage: streamState.streamingMessage,
    deferInitialScroll: Boolean(pendingScrollRestore),
    adoptScrollPosition,
  });
  const { message: searchMessage, block: searchBlock } = resolveSearchTarget(messages, entryIds, pendingSearchScroll);
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };

  /**
   * The navigation that currently owns the viewport, or none.
   *
   * "In flight" spans the request and the presentation scroll that follows a landing: from the moment the shell hands
   * a target over until the target is on screen, retired, or answered with a named outcome. The scroll sentinel reads
   * this to stay silent through a navigation, so an animation cannot page history in behind the reader (spec decision
   * 7: intermediate scroll events load nothing).
   */
  const navigationRef = useRef<{ entryId: string } | null>(null);
  // The entry this navigation owns the viewport for, if any. Read every render rather than in an effect, so the
  // sentinel's observer sees the same answer the render that moved the viewport did.
  navigationRef.current = navigationHoldsViewport({
    pending: pendingSearchScroll ?? null,
    outcome: navigationOutcome,
    // Both kinds of request hold the viewport: the shell's deep search target and the rail's own jump. A rail jump that
    // is still reading has no pending scroll yet, so it is the request half that gates the sentinel until it lands.
    request: railLanding ?? searchTarget ?? null,
    entryIds,
  });

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true, processExpansion: snapshotProcessExpansion() });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      // The window mounts *turn subtrees*, and a turn's messages are inside its own wrapper — so the elements that
      // carry `data-entry-id` are descendants, not children of the content container. Reading the children alone
      // found nothing on a windowed transcript and saved no position at all.
      const elements = Array.from(content.querySelectorAll<HTMLElement>("[data-entry-id]")).filter(
        (element) => Boolean(element.dataset.entryId),
      );
      const anchor = findChatScrollAnchor(elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { entryId: element.dataset.entryId!, top: rect.top, bottom: rect.bottom };
      }), viewportTop);
      if (!anchor) return;
      // What is saved is the *anchor entry* of the turn at the viewport's top edge, because that is the identity that
      // survives a prepend: the anchor is still an entry the transcript holds after a page arrives in front of it,
      // while the turn's first message may be an assistant entry that a page boundary moved.
      //
      // The identity and the offset must be the *same* box. The reader's position is measured from the entry they are
      // looking at, but the box the window can mount again is the turn around it, and those two tops differ by however
      // much of the turn stands above the reader — a process group, an earlier message, a long answer. Saving the
      // turn's identity with the message's offset put the turn's top where the message's top had been, which is a jump
      // of exactly that difference. So the offset is taken from the turn's own box, the one restore will move.
      const winning = elements[anchor.anchorIndex];
      const turnElement = winning?.closest<HTMLElement>("[data-window-turn]") ?? winning ?? null;
      const turnKey = turnKeyForEntry(turnModelRef.current.turns, searchHistoryRef.current.entryIds, anchor.anchorEntryId);
      const anchorEntryId = turnKey === null
        ? anchor.anchorEntryId
        : turnAnchorEntryId(turnByKey(turnModelRef.current.turns, turnKey)!, searchHistoryRef.current.entryIds) ?? anchor.anchorEntryId;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        anchorEntryId,
        anchorOffset: turnElement === null
          ? anchor.anchorOffset
          : Math.round(turnElement.getBoundingClientRect().top - viewportTop),
        oldestEntryId: searchHistoryRef.current.historyCursor,
        processExpansion: snapshotProcessExpansion(),
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id, snapshotProcessExpansion]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    // A restore may run before the transcript's first page has arrived — the hook reports "not loading" for a moment
    // while the window it will hold is still empty. Concluding "the entry is not here and there is no older history"
    // from an empty transcript abandons a restore that is merely early, and the reader is left at the bottom of a
    // conversation they had been reading the middle of. An empty transcript is therefore not a lookup at all: this
    // waits for the first page, and runs again when it arrives.
    if (searchHistoryRef.current.entryIds.length === 0) return;
    restoreStartedRef.current = true;
    const controller = restoreAbortRef.current = new AbortController();

    // A saved position names an *anchor entry*. The turn to mount is the one that entry anchors, which is resolved
    // from the descriptions: the key is `turn-<anchor id>` for an anchored turn but a message index for a leading
    // mid-turn segment, so rebuilding the key from the entry id alone would name a turn that does not exist.
    const keyForAnchor = (entryId: string): string | null => (
      turnKeyForAnchorEntry(turnModelRef.current.turns, searchHistoryRef.current.entryIds, entryId)
    );

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      // The anchor's turn is already loaded: the window can be asked for it by identity, whether or not it is mounted.
      const knownKey = keyForAnchor(position.anchorEntryId);
      if (knownKey !== null || initialHistory.entryIds.includes(position.anchorEntryId)) {
        setRestoreAnchorKey(knownKey ?? turnKeyForEntry(turnModelRef.current.turns, initialHistory.entryIds, position.anchorEntryId));
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      /**
       * The first page is asked for regardless of what the surface currently reports, and every page after that is
       * decided by the server's own answer.
       *
       * The reason is that the transcript right after a switch may be **page memory** — the window the cache kept,
       * restored immediately while the fresh read runs — and a cached window is deliberately partial. Its
       * "no older history" describes the window the cache chose to keep, not the conversation: reading it as the
       * server's answer abandons the restore of a reader who is nowhere near where they were, and leaves them at the
       * bottom. A page speaks for itself, so the loop continues on the page's own `hasMore` and stops when a page
       * stops advancing, which is a real end of history rather than a guess from a partial view.
       */
      let hasMore = true;
      try {
        while (hasMore && before && !controller.signal.aborted) {
          const context = await loadContext(sessionId, activeLeafId, before, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!context) {
            presentation.scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          // A page that arrived in front of the transcript is anchored where the reader is looking, so the window
          // keeps the turn under them and the newly loaded page is simply further up.
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorKey(keyForAnchor(position.anchorEntryId));
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === null || context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId;
          hasMore = context.hasMore;
        }
        if (!controller.signal.aborted) {
          presentation.scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        loadingOlderRef.current = false;
      }
    };

    void locate();
    // Nothing is cancelled here: this effect re-runs for reasons that are not a change of intent (the hook handing
    // back a new `loadContext`), and the position effect above is what cancels a restore whose position is gone.
    // `messages.length` is in the dependencies because it is the transcript's own arrival signal: a restore that is
    // waiting for the first page must be re-run when that page lands.
  }, [activeLeafId, loadContext, loading, messages.length, pendingScrollRestore, presentation, searchTarget, session?.id]);

  /**
   * A rail node the transcript does not carry is one navigation, not a walk.
   *
   * The node names a coordinate the outline issued, and the coordinator answers it with one bounded target window or
   * with a named outcome — never by paging toward it. The entry id travels with the coordinate so the landing below can
   * name the turn that arrives, which is the same alignment a deep search hit gets.
   *
   * A second click while the first is still settling replaces it rather than queueing: the reader changed their mind,
   * which the coordinator states by dropping the superseded request without reporting it.
   */
  const jumpToRailAnchor = useCallback((anchor: string, entryId: string) => {
    const sessionId = session?.id ?? null;
    if (sessionId === null) return;
    setRailLanding({ sessionId, entryId });
    jumpNavigationAnchor(anchor);
  }, [jumpNavigationAnchor, session?.id]);

  // A deep search result is one navigation, not a walk: the coordinator answers with the entry's own bounded target
  // window (ticket 02's read) or with a named outcome, and this asks for it exactly once per target the shell hands
  // over. A hit inside the loaded transcript is answered without any read at all.
  const searchedRef = useRef<NonNullable<Props["searchTarget"]> | null>(null);
  /**
   * The conversation's own history identity, as its accepted snapshot states it.
   *
   * A navigation is addressed *over* that identity — the coordinator mints a coordinate from the conversation and its
   * scope — so a target handed over before the snapshot is known has no address to be read under. That is the ordinary
   * shape of an entry reference followed into a conversation this page already holds: a restored projection is ready
   * with messages, so `loading` is false on the first render while the read that states the scope has not answered.
   * Waiting for the identity is what keeps such a follow from being refused as `malformed` for a coordinate that was
   * never issued, and it costs the reader nothing — the target stands until the answer arrives.
   */
  const historyIdentity = sessionData?.snapshotRevision ?? null;
  useEffect(() => {
    if (!searchTarget || loading || historyIdentity === null) return;
    if (searchedRef.current === searchTarget) return;
    searchedRef.current = searchTarget;
    if (entryIds.includes(searchTarget.entryId)) {
      pendingScrollOwnerRef.current = searchTarget;
      setPendingSearchScroll(searchTarget);
      return;
    }
    // An outcome for this very entry already on screen is the answer to this request. The shell's raw-history offer
    // re-issues the same target through its established open-session seam, and a second read would state the same
    // refusal again — so the displayed outcome stands, and the reader's new panel is left alone.
    if (navigationOutcome !== null && navigationOutcome.kind === "failed"
      && navigationOutcome.request.target.entryId === searchTarget.entryId) return;
    locateNavigation({
      entryId: searchTarget.entryId,
      ...(searchTarget.blockIndex === undefined ? {} : { block: searchTarget.blockIndex }),
    });
  }, [entryIds, historyIdentity, loading, locateNavigation, navigationOutcome, searchTarget]);

  /**
   * One settlement, read as what it asks this surface to do about the request it answers.
   *
   * A landing hands the target's window to the prefix owner and the reveal + scroll effects below do the rest. A
   * failure ends the movement and is shown as its own named outcome, and it does **not** retire the reader's request:
   * the banner it just rendered offers a retry of that very request, so the request has to be standing to answer it.
   * Retiring it here was the bug — the retry's landing arrived for a target the surface no longer named, so its
   * alignment was refused and the viewport gate never closed. `onSearchTargetHandled` is the shell's "stop waiting on
   * this target" signal and carries no success claim anywhere, so no failed locate is left pending and none is dropped
   * without a state on screen.
   *
   * Both kinds of request settle here, because a landing is a landing whichever surface asked for it (spec decision 8).
   * The rail's request is left standing on a failure for exactly the same reason the shell's is: its retry answers it.
   */
  useEffect(() => {
    const rail = railLanding;
    const searched = searchedRef.current;
    const railAction = searchSettlementAction({ settled: navigationOutcome, request: rail });
    if (railAction !== "ignore") {
      // A landing is handed to the pending scroll, which is what holds the viewport from here to the alignment's end,
      // so the rail's own request is released with it. A failure keeps the request standing for the retry the banner
      // just offered, and releases the gate on its own: a settled failure is nothing the viewport is owed.
      const target = railAction === "align" ? rail : null;
      pendingScrollOwnerRef.current = target;
      setPendingSearchScroll(target);
      if (railAction === "align") setRailLanding(null);
      return;
    }
    const searchedAction = searchSettlementAction({ settled: navigationOutcome, request: searched });
    if (searchedAction === "ignore") return;
    const target = searchedAction === "align" ? searched : null;
    pendingScrollOwnerRef.current = target;
    setPendingSearchScroll(target);
  }, [navigationOutcome, railLanding]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // A navigation owns the viewport for as long as it is in flight: the reader asked for one entry, the window is
        // moving toward it, and the sentinel crossing the top of the viewport on the way is not a reader asking for
        // older history. Left ungated, a settlement scroll toward a deep target loads every page it passes — the
        // sequential hydration this ticket replaces, arriving through an observer instead of through a loop. Read from
        // a ref so a navigation starting or ending does not re-subscribe the observer.
        if (navigationRef.current !== null) return;
        // No older history loaded yet: fetch the previous page from the server
        // and prepend it (loadContext handles prepend + scroll anchoring).
        // Skip while a page is already loading or nothing older exists.
        if (loadingOlderRef.current) return;
        if (!hasEarlierMessages) return;
        const oldestId = historyCursor;
        if (!oldestId) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        // The page is prepended in front of the transcript; the window's prepend anchor is what keeps the reader's
        // place, so nothing here touches the scroll position.
        void loadContext(sid, activeLeafId, oldestId).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyCursor, hasEarlierMessages, session, activeLeafId, loadContext, sessionIdRef, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Images attach to the prompt. Other files go through the file explorer's
  // upload into the working directory, never replacing a file already there,
  // and come back as @mentions.
  // Every file answer this surface shows — the dropped upload, the @ index, the previews — belongs to this connection.
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) {
      addNotice({ type: "warning", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const { status, data } = await uploadFiles(connection.client, cwd, files, "skip");
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = dropMentionText(files, [...uploaded, ...skipped]);
      if (mentions) chatInputRef?.current?.insertText(mentions);
      if (uploaded.length > 0) {
        addNotice({ type: "success", message: t("chat.dropUploaded", { count: uploaded.length }) });
        onFilesUploaded?.();
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.dropAlreadyExists", { names: skipped.join(", ") }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, chatInputRef, connection.client, newSessionCwd, onFilesUploaded, session?.cwd, t]);

  const onDrop = useCallback((items: DroppedItem[]) => {
    const { images, files, folders } = splitDroppedItems(items);
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    if (folders.length > 0) {
      addNotice({ type: "warning", message: t("chat.dropFoldersUnsupported", { names: folders.join(", ") }) });
    }
    if (files.length > 0) void uploadDroppedFiles(files);
  }, [addNotice, chatInputRef, t, uploadDroppedFiles]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);

  // An empty new conversation is one with nothing to draw: no committed message, no run in flight, and no turn this
  // surface has sent that the conversation has not committed yet. The staged turns count, because a fresh composer
  // becomes a real session while the chat stays mounted: between the session existing and the run's own frames
  // arriving, the busy flags can read false for a frame, and without this the whole transcript — including the turn
  // the user just sent — is swapped for the empty new-session shell and back.
  const isEmptyNew = isNew && messages.length === 0 && pendingSubmissions.length === 0 && !streamState.isStreaming && !sessionBusy;
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  // The transcript as data: complete turn descriptions, chosen before any JSX is created. The renderer below only
  // turns those descriptions into elements, so a window can select turns without re-deriving them.
  const turnModel = useMemo(() => buildTurnModel({
    messages,
    entryIds,
    toolResults: toolResultsMap,
    cwd: messageCwd,
    sessionBusy,
    isStreaming: streamState.isStreaming,
    searchTarget: pendingSearchScroll,
  }), [messages, entryIds, toolResultsMap, messageCwd, sessionBusy, streamState.isStreaming, pendingSearchScroll]);
  // The turn descriptions as a ref, so the effects that run on scroll and on restore read the current turns without
  // being re-created on every transcript change — a scroll-position save that re-subscribed on each new frame would
  // drop saves in between.
  const turnModelRef = useRef(turnModel);
  turnModelRef.current = turnModel;
  const messageRefs = useMessageRefs(turnModel.refCount);
  // A process group's expansion outlives the group: the window unmounts a turn that scrolls away, so the reader's own
  // toggle is kept by turn identity rather than by the component that happened to be mounted.
  // The turns whose process group a reveal names (a search hit inside the group), collected before rendering so the
  // group is already open on the frame the reveal lands rather than one frame later.
  const processRevealKeys = useMemo(
    () => turnModel.turns
      .filter((turn) => turn.items.some((item) => item.kind === "process" && item.reveal))
      .map((turn) => turn.key),
    [turnModel.turns],
  );
  useLayoutEffect(() => { processExpansion.reveal(processRevealKeys); }, [processExpansion, processRevealKeys]);

  // --- The window ---
  // Which turns are mounted is the window's question, and it is answered from the turn descriptions plus the measured
  // heights of what is on screen. Everything else — what a turn is, which page of history is loaded, where the reader
  // is — has its own owner and is only read here.
  const [revealTurnKey, setRevealTurnKey] = useState<string | null>(null);
  const [restoreAnchorKey, setRestoreAnchorKey] = useState<string | null>(null);
  /**
   * The running navigation settlement, if one is in flight.
   *
   * It is owned by the ref rather than by the effect because the effect re-runs on every geometry change, and a
   * settlement cancelled and restarted on each of those would never converge: each run would scroll once and have its
   * next frame cancelled by the change it caused.
   */
  const searchSettleRef = useRef<ScrollSettlementHandle | null>(null);
  /** The entry the running settlement is for, so a re-run of the effect does not restart the same settlement. */
  const searchSettleEntryRef = useRef<string | null>(null);
  useEffect(() => () => { searchSettleRef.current?.cancel(); searchSettleRef.current = null; }, []);
  // Measurement, the anchor and the range are one decision inside the hook: the position is corrected before the
  // range is chosen, so the turn the reader is looking at is always one the range mounts.
  // A search hit is a reveal like any other: the entry may be loaded but not mounted, and the window is asked for
  // its turn by key rather than the surface growing the rendered history until it appears.
  const searchRevealKey = useMemo(() => {
    if (!pendingSearchScroll) return null;
    const index = entryIds.indexOf(pendingSearchScroll.entryId);
    if (index < 0) return null;
    return turnModel.turns.find((turn) => index >= turn.startIndex && index < turn.endIndex)?.key ?? null;
  }, [pendingSearchScroll, entryIds, turnModel.turns]);
  const windowModel = useTranscriptWindow({
    turns: turnModel.turns,
    scrollElement,
    revealKey: revealTurnKey ?? restoreAnchorKey ?? searchRevealKey,
  });
  adoptScrollPositionRef.current = windowModel.adoptScrollPosition;

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    if (!position || searchTarget) return;
    // The restored anchor's turn may not be mounted; the window is asked for it by key, exactly as search and the
    // minimap do, and the scroll happens once the turn is on screen.
    if (!restoreAnchorReady) {
      setRestoreAnchorKey(turnKeyForAnchorEntry(turnModel.turns, entryIds, position.anchorEntryId));
      return;
    }
    // The window mounts turn subtrees, so the entry's element is a descendant of the content container rather than a
    // child of it, and the box that is restored is the turn's own — the same box the offset was measured from when the
    // position was saved, which is what makes the pair an identity and an offset in one coordinate system.
    const turnKey = turnKeyForAnchorEntry(turnModel.turns, entryIds, position.anchorEntryId);
    const turn = turnKey === null
      ? null
      : scrollContainerRef.current?.querySelector<HTMLElement>(`[data-window-turn="${CSS.escape(turnKey)}"]`);
    if (turn) {
      // The window is told first, so the scroll this causes is adopted as the baseline rather than corrected: the
      // position was computed from the geometry on screen now, and a prepend correction would move the reader a second
      // time by a change the caller has already accounted for.
      presentation.scrollTo(turn, position.anchorOffset);
      setPendingScrollRestore(null);
      setRestoreAnchorKey(null);
      return;
    }
    // The turn is not mounted yet (or this window does not hold it at all): the reveal above mounts it, and this
    // effect re-runs when the range changes. Falling back to the tail here would move the reader somewhere they never
    // were, which is the one thing restoring a position must not do.
    if (restoreAnchorReady && turnKey === null && !entryIds.includes(position.anchorEntryId)) {
      presentation.scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
    // The mounted range is a dependency for the same reason it is for search: the anchor's turn may not be mounted when
    // this first runs, the reveal above mounts it, and the scroll happens on the pass where it is finally on screen.
    // Without it the restore never lands, and the reader is left where the conversation opened.
  }, [entryIds, pendingScrollRestore, presentation, restoreAnchorReady, searchTarget, scrollContainerRef, windowModel.ranges]);

  // A reveal is a request, not a permanent mount: once the viewport alone would show the revealed turn, the request is
  // dropped and the turn stays mounted because the reader is looking at it. Without this the revealed turn would stay
  // mounted for the rest of the session, which is the growth a window exists to prevent.
  useEffect(() => {
    if (!windowModel.revealSettled) return;
    setRevealTurnKey((current) => (current === null ? current : null));
    setRestoreAnchorKey((current) => (current === null ? current : null));
  }, [windowModel.revealSettled]);

  // A search hit is scrolled to once its turn is mounted, which the reveal above causes; this effect runs again when
  // the range changes. Reporting the target handled before it is on screen would leave the search finished with
  // nothing shown.
  useLayoutEffect(() => {
    // The debt is this surface's own: `pendingSearchScroll` names the landing it must align, and the shell's target is
    // only what retires it. Comparing the prop here instead strands a landing whose request the shell already retired —
    // the entries are mounted, the reveal is owed, and the viewport gate would stay closed for good. A newer request
    // replaces this debt in the settlement effects above, so what is checked is that the debt still belongs to the
    // request that created it — whichever surface asked, the shell's deep search hit or the rail's own jump.
    if (!pendingSearchScroll) return;
    const aligning = pendingScrollOwnerRef.current;
    if (aligning !== null && aligning.entryId !== pendingSearchScroll.entryId) return;
    // The *matched block's* element is the target, and it is the same element the settlement below must be pointed
    // at. For a user message the entry is the target; for an assistant one it is the text block the search actually
    // matched, because an answer with a process group has other text blocks above it and settling on the entry would
    // stop with the matched block still below the fold.
    const targetSelector = searchMessage?.role === "user"
      ? `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`
      : `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"] [data-search-target]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(targetSelector);
    if (!element) return;
    // A newly mounted turn starts from the estimated height, so a scroll issued the instant it appears is computed
    // against spacers about to be replaced; when the real measurements land, everything below moves and the target can
    // end up off screen again. The scroll is therefore settled over the next frames, by `startScrollSettlement`, which
    // states its own end: it arrives, the reader takes over, or the target leaves the window.
    //
    // One settlement per navigation: this effect re-runs on every geometry change, and restarting on each of those
    // would reset the settlement before it ever held its alignment for the frames that mean "settled".
    const settleContainer = scrollContainerRef.current;
    if (settleContainer === null) return;
    if (searchSettleEntryRef.current !== pendingSearchScroll.entryId) {
      searchSettleRef.current?.cancel();
      searchSettleEntryRef.current = pendingSearchScroll.entryId;
      searchSettleRef.current = startScrollSettlement({
        container: settleContainer,
        onReaderIntent: (listener) => onReaderScrollIntent(settleContainer, listener),
        target: () => scrollContainerRef.current?.querySelector<HTMLElement>(targetSelector) ?? null,
        // Each step of a settlement is a scroll this surface decided, so the window adopts it instead of applying a
        // prepend correction for geometry the settlement has already measured.
        scrollTo: (target) => { presentation.scrollTo(target as HTMLElement); },
        onSettled: () => {
          searchSettleRef.current = null;
          searchSettleEntryRef.current = null;
          // Only the shell's own target is handed back to it. A rail landing has nobody to retire, and calling the
          // shell's retire seam for one would claim a search request this surface never made.
          if (pendingSearchScroll === searchTarget) onSearchTargetHandled?.(pendingSearchScroll);
          setPendingSearchScroll(null);
        },
        // The navigation ends either way; what differs is whether it *arrived*. A settlement that stops because the
        // reader scrolled has done its job — they are looking where they chose, and the request must not stay pending,
        // because a pending reveal is a permanently mounted turn. One that stops because the target left the window is
        // only waiting: the reveal is left in place for the surface to bring it back.
        onAbandoned: (reason) => {
          searchSettleRef.current = null;
          // The entry marker is cleared for *every* reason, including a target that left the window. That reason is a
          // pause rather than a finish — the reveal stays pending and the turn is mounted again — but the settlement
          // it named is over, and leaving the marker set would make the guard below read the next run as "the same
          // settlement still in flight" and never start another one. The paused navigation would then never resume,
          // which is the one outcome the pause reason exists to avoid.
          searchSettleEntryRef.current = null;
          if (reason === "unmounted") return;
          if (pendingSearchScroll === searchTarget) onSearchTargetHandled?.(pendingSearchScroll);
          setPendingSearchScroll(null);
        },
      });
    }
    element.animate([
      { backgroundColor: "var(--bg-selected)" },
      { backgroundColor: "transparent" },
    ], { duration: 2500 });
  }, [pendingSearchScroll, presentation, searchTarget, searchMessage, scrollContainerRef, onSearchTargetHandled, windowModel.ranges, windowModel.offsets]);

  // The minimap names the turn it could not find mounted by the entry that turn is anchored on; the window mounts
  // exactly that turn, without drawing the history between it and the viewport.
  //
  // The entry is resolved against the turn descriptions rather than used as a key. The minimap and the transcript do
  // not enumerate turns the same way — the transcript draws a leading mid-turn segment as a turn, which has no anchor
  // message — so a positional index from the minimap would name a different turn than the transcript's own list.
  const revealHistoryForMinimap = useCallback((anchorEntryId: string) => {
    const key = turnKeyForAnchorEntry(turnModel.turns, entryIds, anchorEntryId)
      ?? turnKeyForEntry(turnModel.turns, entryIds, anchorEntryId);
    if (key !== null) setRevealTurnKey(key);
  }, [entryIds, turnModel.turns]);

  const messageRef = (refIndex: number, index: number) => (el: HTMLDivElement | null) => {
    messageRefs.current[refIndex] = el;
    // The reader's own latest prompt is the box the prompt anchor is measured against, and the box a follow moves to.
    if (index === turnModel.lastUserIndex) presentation.anchors.lastPrompt(el);
  };

  const renderMessageView = (
    item: { viewKey: string; index: number; message: AgentMessage; showTimestamp: boolean },
    extra: { writtenFiles?: WrittenFile[]; recoverTruncation?: boolean } = {},
  ): ReactNode => (
    <MessageView
      key={item.viewKey}
      message={item.message}
      toolResults={toolResultsMap}
      modelNames={modelNames}
      cwd={messageCwd}
      onOpenFile={onOpenFile}
      onOpenSession={onOpenSession}
      entryId={entryIds[item.index]}
      searchBlock={entryIds[item.index] === pendingSearchScroll?.entryId ? searchBlock : undefined}
      onFork={isNew ? undefined : handleFork}
      forking={forkingEntryId === entryIds[item.index]}
      showTimestamp={item.showTimestamp}
      prevTimestamp={item.index > 0 ? (messages[item.index - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
      sessionId={session?.id ?? sessionIdRef.current ?? undefined}
      writtenFiles={extra.writtenFiles}
    />
  );

  const renderTurn = (turn: TurnDescription): ReactNode => (
    <>{turn.items.map((item) => renderTurnItem(turn, item))}</>
  );

  const renderTurnItem = (turn: TurnDescription, item: TurnItem): ReactNode => {
    if (item.kind === "process") {
      const { refIndex } = item;
      // The expansion belongs to the turn, so it is read and written under the turn's own key. That is what makes a
      // manual toggle survive the window unmounting this turn and mounting it again: the group's own component state
      // does not, because the component does not exist in between.
      const expanded = processExpansion.isExpanded(turn.key, item.defaultExpanded);
      return (
        <div key={item.key} ref={refIndex === null ? undefined : (el) => { messageRefs.current[refIndex] = el; }}>
          <ProcessDetailsGroup messageCount={item.messageCount} toolCallCount={item.toolCallCount} expanded={expanded} reveal={item.reveal} onToggle={() => processExpansion.toggle(turn.key, expanded)} t={t}>
            {item.entries.map((entry) => renderMessageView({ ...entry, showTimestamp: false }))}
          </ProcessDetailsGroup>
        </div>
      );
    }
    const view = item.kind === "answer"
      ? renderMessageView(item, { writtenFiles: item.writtenFiles, recoverTruncation: item.recoverTruncation })
      : renderMessageView(item);
    if (item.refIndex === null) return view;
    return (
      <div key={"wrap-" + item.key} data-entry-id={entryIds[item.index]} ref={messageRef(item.refIndex, item.index)}>
        {view}
      </div>
    );
  };

  // Older history is available above what is drawn: the sentinel asks for the previous page.
  //
  // Two different things put content above the reader, and the sentinel has to be there for either: history the
  // conversation has loaded but the window has not mounted (there are turns above the first mounted range), and
  // history the conversation has not loaded at all (`hasEarlierMessages`). Reading only the server's flag removed the
  // sentinel while loaded turns still stood above the reader, which left them unable to reach the rest of what they
  // had already paged in.
  const hasMoreItems = hasEarlierMessages || (windowModel.ranges[0]?.start ?? 0) > 0;
  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      onModelRetry={retryModels}
      runFailure={runFailure}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      thinkingLevel={thinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      queuedMessages={queuedMessages}
      queuedItems={queuedItems}
      control={control}
      onEditItem={handleEditItem}
      onCancelItem={handleCancelItem}
      onContinue={handleContinue}
      onOpenConversation={onOpenSession}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted" role="status">
         {t("chat.loadingSession")}
      </div>
    );
  }

  // Nothing of this conversation can be drawn, so the failure takes the transcript's place. That is the one case where
  // replacing is honest: there is no content to lose. A refusal the Backend named (an unreadable projection) carries a
  // sentence this build authored and keeps the raw-error shape it already had; every other failure is the classified
  // panel, which states what kind of read failed and offers the one step that can help.
  const nothingDrawn = messages.length === 0 && pendingSubmissions.length === 0;
  if (nothingDrawn && readFailure) {
    return (
      <ReadFailurePanel
        failure={readFailure}
        variant="surface"
        retrying={readRetrying}
        onRetry={() => { void runReadRetry(); }}
        onBack={onReadFailureBack}
      />
    );
  }
  if (nothingDrawn && error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-red-400" role="alert">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf facts={notices} onRetire={dismissNotice} floating />
      </div>

      {/* A read that failed while the conversation was still on screen. The projection keeps its accepted window across
          a failed read, so the transcript, the draft and the reader's place all stay; the banner states what could not
          be read and offers the retry. It sits above the transcript rather than replacing it, which is the whole point
          of not discarding content the reader already had. */}
      {readFailure && (
        <ReadFailurePanel
          failure={readFailure}
          variant="inline"
          retrying={readRetrying}
          onRetry={() => { void runReadRetry(); }}
          onDismiss={dismissReadFailure}
        />
      )}

      {/*
       * One delegated child's recovery facts, stated above its own transcript: the preparation the delegation's record
       * holds, where this dispatch's report stands, and the anchor's phase — the per-object facts the row's single
       * `runStatus` cannot carry, including a reporter pending that is not the same thing as `waiting-report`. It offers
       * the retry of a failed preparation under the identities the read returned, which is the retry the delegation seam
       * already performs for a replayed request: same child, same dispatch, nothing aborted.
       */}
      <ChildRecoveryPanel session={session} />

      {/* A named refusal with the conversation still on screen — the Backend could not carry one frame, and said which.
          Its authored sentence is shown as a banner for the same reason the classified failure is: the window it could
          not carry is not a reason to throw away the window it did. */}
      {!readFailure && error && (
        <ReadFailurePanel failure={{ kind: "refused" }} message={error} variant="inline" onDismiss={dismissReadFailure} />
      )}

      {/* One navigation outcome, stated by name, with the two offers the ticket asks it to carry: a retry of the
          same request, or the raw-history view of the entry that could not be placed. A failed locate is never
          reported as handled, and never left pending. */}
      <NavigationOutcomeBanner
        outcome={navigationOutcome}
        conversationId={session?.id ?? null}
        onOpenSession={onOpenSession}
        minimapWidth={CHAT_MINIMAP_WIDTH}
        columnPadding={CHAT_COLUMN_PADDING}
        isMobile={isMobile}
        onDismiss={() => {
          // Dismissing retires the navigation: the banner comes off screen, the shell's pending target goes with it, and
          // the viewport is handed back to the reader. `onSearchTargetHandled` is the shell's *retire this request*
          // signal, not a report of success — a failed locate is cleared the same way, and nothing on this path claims
          // the reader was landed.
          const retiring = searchedRef.current;
          if (retiring !== null) onSearchTargetHandled?.(retiring);
          searchedRef.current = null;
          // The rail's own request goes with it. A dismissed outcome would otherwise leave this surface still holding
          // an entry the transcript does not carry, and navigationHoldsViewport reads exactly that as a navigation
          // owing nothing — which gates the older-history sentinel for the rest of the session.
          setRailLanding(null);
          pendingScrollOwnerRef.current = null;
          setPendingSearchScroll(null);
          dismissNavigation();
        }}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {!isEmptyNew && <>
        <div
          ref={attachScrollContainer}
          // The message list is the one place long output has to be dragged through,
          // so it shows its scrollbar instead of hiding it behind the minimap (#788).
          // A stable gutter keeps the centred column from shifting when a short
          // session grows past one screen.
          // `overflow-anchor: none` turns off the browser's own scroll anchoring. The window corrects the scroll
          // position itself when the geometry above the reader changes, and two anchoring authorities disagree: the
          // browser's adjustment lands on top of the window's, moving the reader by the height that changed twice.
          data-chat-scroll
          className="scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable] [overflow-anchor:none]"
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {hasMoreItems && (
              <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                {t("chat.loadEarlier")}
              </div>
            )}
            <TranscriptWindowSurface
              turns={turnModel.turns}
              ranges={windowModel.ranges}
              offsets={windowModel.offsets}
              totalHeight={windowModel.totalHeight}
              observe={windowModel.observe}
              renderTurn={renderTurn}
            />
            {/* A submission this surface admitted whose outcome the conversation never established. Its entry is in
                the transcript, so the truth is stated here rather than as a turn this surface would be inventing: the
                projection's own outstanding interest is what says the outcome is unknown, and it is neither a pending
                turn nor a run. */}
            {outstandingSubmissions.filter((interest) => interest.unknown).map((interest) => (
              <div key={`unknown-${interest.submissionId}`} data-submission-unknown={interest.submissionId} className="px-1 pb-2 text-[12px] text-text-muted">
                {t("chat.submissionUnknown")}
              </div>
            ))}

            {/* The turns sent from this surface the conversation has not committed yet. They are drawn after the
                transcript and before the streaming bubble, because that is their order in the conversation: the
                transcript is what the server reports and does not hold them yet. */}
            {pendingSubmissions.map((pending) => (
              <div key={`pending-${pending.requestId}`} data-pending-submission={pending.requestId}>
                <MessageView message={pendingMessage(pending)} toolResults={toolResultsMap} modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                {pending.status === "unknown" && (
                  <div className="px-1 pb-2 text-[12px] text-text-muted">{t("chat.submissionUnknown")}</div>
                )}
              </div>
            ))}

            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} toolResults={toolResultsMap} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
            )}

            {/* The status is the projection's own phase, so a turn this surface staged shows one before the run
                exists. `preparation` never claims a model the run has not asked: it becomes `waiting_model` when the
                projection reports the run. */}
            {!hasStreamingContent && statusPhase !== null && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                <span data-agent-status={statusPhase.kind} className="animate-[pulse_1.5s_infinite]">{phaseLabel(statusPhase, t)}</span>
              </div>
            )}

            <div ref={presentation.anchors.spacer} aria-hidden="true" />
            </div>
          </div>
        </div>
        {isMobile || pendingScrollRestore ? null : (
          <ChatMinimap
            messages={messages}
            entryIds={entryIds}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
            outline={navigationOutline}
            onJumpAnchor={jumpToRailAnchor}
            onRequestOutline={requestOutlinePage}
          />
        )}
        </>}
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
          >
            <span aria-hidden="true" style={{ fontSize: 15 }}>@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      <div className="relative shrink-0">
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${presentation.showScrollToBottom && !pendingScrollRestore ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={() => presentation.scrollToBottom("smooth")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
        {/* The brand, the project/worktree bar and the versions: one row, or
            the bar on a line of its own under the brand where it does not
            fit beside it (.new-session-hero in app/globals.css). The
            versions come first: floated right of the first line. */}
        {isEmptyNew && (
          <div className="new-session-hero" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
            <div className="new-session-hero-row" style={{ maxWidth: "var(--chat-content-max-width, 820px)" }}>
              <div className="new-session-versions">
                <span>web <span className="new-session-version">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span></span>
                <span>pi <span className="new-session-version">v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span></span>
              </div>
              <div className="new-session-brand" style={{ gap: isMobile ? 7 : 10 }}>
                <img src="/icons/apple-touch-icon.png" width={32} height={32} alt="" style={{ flexShrink: 0 }} />
                <span className="new-session-brand-name">Pi Web</span>
                <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
              </div>
              {newSessionContextBar}
            </div>
          </div>
        )}
        {chatInputElement}
        <ExtensionStatusBar
          statuses={extensionStatuses}
          widgets={extensionWidgets}
          onCommand={handleSend}
          commandsDisabled={sessionBusy}
        />
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}
