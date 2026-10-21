"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useGlobalKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { SessionSidebar, type SessionSidebarControl } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { NewSessionContextBar, type NewSessionContextControl } from "./NewSessionContextBar";
import type { ChatScrollPosition } from "../lib/chat/chat-scroll-position";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { displayPathUnder } from "../lib/display-path";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { SubtreeControlPanel } from "./SubtreeControlPanel";
import { QuickDelegatePanel } from "./QuickDelegatePanel";
import { RawHistoryPanel } from "./RawHistoryPanel";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { useTerminalFanIn } from "../hooks/useTerminalFanIn";
import { TerminalFanIn, type FanInSubscription } from "../lib/terminal-fan-in";
import { useTheme } from "../hooks/useTheme";
import { useFontPreferences } from "../hooks/useFontPreferences";
import { useI18n } from "../hooks/useI18n";
import { useIsMobile, useIsNarrowMobile } from "../hooks/useIsMobile";
import { useViewportHeight } from "../hooks/useViewportHeight";
import { useResizablePanel } from "../hooks/useResizablePanel";
import { useAudio } from "../hooks/useAudio";
import { copyText } from "../lib/clipboard";
import { catalogueRow, type CatalogueEntry } from "../lib/conversation-catalogue";
import { createRequestId, operationFailure } from "../lib/conversation-api";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import type { ConversationRefresh, ConversationRefreshes } from "../lib/conversation-refreshes";
import type { ReloadOutcome } from "../hooks/useAgentSession";
import { getFileName } from "../lib/file/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "../lib/file/file-fuzzy";
import {
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "../lib/browser-notifications";
import { useWorkbenchNavigation, useWorkbenchQuery } from "../lib/navigation";
import { isWorkspaceRoutingPath } from "@hepi/protocol/files";
import {
  contextForCwd,
  type NewSessionContext,
  type NewSessionMove,
  type NewSessionOptions,
  type NewSessionTarget,
  type ProjectChoice,
  type WorktreeChoice,
  worktreeCwd,
} from "../lib/new-session-context";
import { workspaceKeyOf } from "../lib/workspace-memory";
import {
  useSelectionStateOf,
  useWorkbenchSelectionStore,
  WorkbenchSelectionProvider,
  type SelectConversationOptions,
  type StartComposerOptions,
  type WorkspaceTarget,
} from "../lib/workbench-selection";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../lib/panel-layout";
import type { SessionInfo } from "../lib/types";
import type { ProjectTrustStatus } from "@hepi/protocol/mcp-ui";
import type { ChatInputHandle } from "./ChatInput";
import type { NewSessionChoices } from "../hooks/useAgentSession";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { FileViewerState } from "../lib/file/file-viewer-state";
import type { ToolEntry } from "../lib/tool-presets";
import { getSessionFamily } from "../lib/session-family";
import { CompletionDelivery, type CompletionNotice } from "../lib/completion-delivery";
import type { Step } from "../lib/lifecycle-projection";
import type { AgentEventLike } from "../lib/agent-event-wire";
import { getLastSettingsSection, settingsSectionRequiresProject, type SettingsSection } from "../lib/settings-navigation";
import { classifyReadFailure, readFailureRetryable, type ReadFailure } from "../lib/read-recovery";
import { ReadFailurePanel } from "./ReadFailurePanel";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const AGENT_PANEL_WIDTH = 420;
export function AppShell() {
  const { navigate } = useWorkbenchNavigation();
  // The logical query comes from the router the host chose, so a packaged App fragment query is the same value a Web
  // page search string is. Nothing here reads window.location, which in the App names the bundle and not the view.
  const locationQuery = useWorkbenchQuery();
  // The one selection: which workspace, which conversation or fresh composer, and which read the reader waits on. Every
  // surface below reads this and sends it an intent; nothing reports a selection back up.
  const connection = useWorkbenchConnection();
  const queryRef = useRef(locationQuery);
  queryRef.current = locationQuery;
  const selection = useWorkbenchSelectionStore({
    drafts: connection.drafts,
    conversation: {
      open: async (sessionId) => await connection.api.open(sessionId) as unknown as SessionInfo,
    },
    validateCwd: async (path) => {
      const answer = await connection.client.request("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await answer.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        displayRoot?: string;
        error?: string;
      };
      if (!answer.ok || !data.cwd) throw new Error(data.error ?? "HTTP " + answer.status);
      return { cwd: data.cwd, projectKey: data.projectKey ?? null, projectRoot: data.projectRoot ?? null, displayRoot: data.displayRoot ?? null };
    },
    navigate,
    query: () => queryRef.current,
    onLanded: (_kind, { keepSidebarOpen }) => {
      if (isMobile && !keepSidebarOpen) setSidebarOpen(false);
    },
  });
  const selectionState = useSelectionStateOf(selection);
  const selectedSession = selectionState.conversation;
  const composer = selectionState.composer;
  const activeCwd = selectionState.cwd;
  const activeDisplayCwd = selectionState.displayCwd;
  const openFailure = selectionState.openFailure;
  const openRetrying = selectionState.openRetrying;
  const rawHistoryFocus = selectionState.rawHistoryFocus;
  const workspaceContext = selectionState.workspace;
  const workspaceMove = selectionState.move;
  const initialCwdStatus = selectionState.initialCwd.status;
  const initialCwdError = selectionState.initialCwd.error;
  const initialSessionRestored = !selectionState.restoring;
  const newSessionCwd = composer?.cwd ?? null;
  const newSessionDraftKey = composer?.draftKey ?? null;
  /**
   * The chat's mount identity: the conversation it is showing, or the fresh composer it is showing.
   *
   * That is the whole rule, and it is the chat's own. A fork or a new conversation is a different identity and so a
   * different surface; identity hydration, a same-project worktree move and — the case this replaced a shell counter for
   * — a settings-driven reload of the **same** conversation are the same identity, so they re-render the chat rather
   * than rebuilding it. A reload is a read and a re-acquire of the resources, which the chat performs itself; the shell
   * no longer knows that a remount ever stood in for one.
   */
  const chatIdentity = selectedSession?.id ?? newSessionDraftKey ?? null;
  // The same identity, for the one registration that happens after a commit rather than during this render: the chat
  // publishes its reload from an effect, and the conversation it belongs to is the one on screen when it does.
  const chatIdentityRef = useRef<string | null>(chatIdentity);
  chatIdentityRef.current = chatIdentity;
  /**
   * The reload this shell published, the registry it published into, and the conversation it was published for.
   *
   * It is held so the withdrawal names exactly what was published: the chat reports a registration change without
   * carrying the identity it had, and a cleanup must not remove a registration that a newer chat already made. The
   * registry is part of the record because a connection can be replaced while the chat stays mounted, and the
   * withdrawal then belongs to the registry that holds the registration rather than to the new connection's.
   */
  const publishedConversationReloadRef = useRef<{
    readonly refreshes: ConversationRefreshes;
    readonly conversationId: string;
    readonly refresh: ConversationRefresh;
  } | null>(null);
  // Keep the system-theme subscription mounted for the lifetime of the app.
  useTheme();
  // Restore fonts even when Settings and the chat composer have not been opened.
  useFontPreferences();
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  const isNarrowMobile = useIsNarrowMobile();
  useViewportHeight();

  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem("pi-quote-selection-enabled", String(enabled));
    } catch {
      // Keep the current page usable when storage is unavailable.
    }
  }, []);
  // One completion tone, however the completion was observed: the open conversation's own surface and a background
  // watch of another conversation both claim here, and the first to name an answer is the one that sounds it. The
  // absence-based path that predates this delivery asks before it sounds, so the changeover cannot double a tone.
  //
  // The registry belongs to the connection it is showing, so a switch builds the next one instead of reusing this: the
  // outgoing one holds the replaced client's source, its watches and the answers it already noticed, and none of those
  // describes the connection now on screen.
  //
  // Why this is the shell's own work rather than something a remount gives it: a **scope** change does remount this tree,
  // because the I18nProvider above it is keyed by the connection's scope — and a remount is exactly the case that made a
  // ref look correct. A switch that keeps the scope does **not** remount: the provider value is replaced and this shell
  // renders again inside it, so the registry initialized once in a ref would survive with the replaced client's watches
  // still attached. Comparing against the connection object is what covers both, and it is the identity that is the rule
  // rather than a counter nobody can state the meaning of.
  // The relations the sidebar states are read by the registry's suppression rule, so the ref is stated before it.
  const subagentSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const buildCompletionDelivery = (forConnection: typeof connection): CompletionDelivery => new CompletionDelivery({
    // The conversation's stream is the connection's own source: the host stated how to reach it (a same-origin BFF
    // under the page's cookie, or the App's Gateway origin under its device bearer), and this registry joins that
    // transport rather than assembling a second way in.
    subscribe: (conversationId, listener) => forConnection.client.subscribe(conversationId, listener),
    // The by-id lookup, exactly as the open surface performs it: a repair, never a resend (ADR 0006).
    lookup: async (conversationId, requestId) => {
      const answer = await forConnection.api
        .submission(conversationId, requestId)
        .catch(() => null);
      return answer ?? null;
    },
    // The stream, the handshake and the passive reconnect are the connection's own — the client's numbers are the
    // ones the open conversation's surface already uses — so a background watch behaves the same way it does on screen.
    // A subagent conversation's completion is not the user's to be told about, and the catalogue's own relation is
    // what says so — the same source the sidebar's suppression reads.
    isSuppressed: (conversationId) => subagentSessionIdsRef.current.has(conversationId),
    // The open conversation's own surface reports its completions through the same registry, so a notice arriving
    // here is one for a conversation the user is not looking at: it is the sound for exactly that.
    onAnswered: () => {
      if (soundEnabledRef.current) playDoneSound();
    },
  });
  const [completionDelivery, setCompletionDelivery] = useState(() => buildCompletionDelivery(connection));
  // Which connection the registry this shell is showing was built for. The identity is the whole rule: a switch
  // replaces the connection object, so comparing against it is what makes the swap happen once per connection rather
  // than once per render.
  const completionDeliveryConnection = useRef(connection);
  if (completionDeliveryConnection.current !== connection) {
    completionDeliveryConnection.current = connection;
    setCompletionDelivery((previous) => {
      // The outgoing registry's watches are released with it: nothing of the replaced connection stays attached.
      previous.close();
      return buildCompletionDelivery(connection);
    });
  }
  // The page's one terminal stream, shared by every mounted tab. It is a peer of the completion registry: the panels
  // own their widgets and their writers, and this owns the connection they attach through.
  //
  // It belongs to the connection it is showing: the client states its origin, its own credential and the platform's fetch
  // once, so the stream, the panel's requests and the conversation's stream present one identity, and a connection switch
  // closes this stream and opens the next one rather than carrying a tab's cursor into a scope where it means something
  // else. That value is the client's own object, which is what makes the switch a change of identity rather than a render.
  const terminalConnection = connection.client.connection;
  const terminalFanIn = useTerminalFanIn(terminalConnection);
  // The stream is created by the effect that shows this connection, so a render can precede it: a tab mounted in that
  // frame is handed no stream rather than the one belonging to the connection being replaced. The next render states the
  // live stream, the panel's effect re-runs with it, and the tab attaches then.
  const subscribeTerminal = useMemo(
    () => terminalFanIn === null
      ? null
      : (tab: { id: string; cwd: string }, handlers: Parameters<TerminalFanIn["subscribe"]>[1]): FanInSubscription => terminalFanIn.subscribe(tab, handlers),
    [terminalFanIn],
  );
  // The conversation API of this connection: the Backend's own `/api/conversations…` vocabulary, assembled with the
  // connection itself rather than per surface. The terminal stream above reads the same `connection` value, so the shell
  // states one identity for both.
  const api = connection.api;
  // Leaving this shell ends its watches — a profile switch unmounts this tree, so the previous connection's watches are
  // released rather than left attached to a connection nothing shows. The connection's own stream is not this registry's
  // to close (the workbench disposes the client, and another caller may still be reading), so what is released is this
  // shell's interest alone; `open` is the other half of the pair, for the mount that replaces this one.
  useEffect(() => {
    completionDelivery.open();
    return () => completionDelivery.close();
  }, [completionDelivery]);
  /**
   * The page's one registry of live completions, whichever surface observed the fact. The answer says whether this
   * caller is the owner that reports it: the open conversation asks first and sounds its own tone when it is, and a
   * background watch that folded the fact reports it here instead — so a handover, a second reader and a duplicate
   * frame all collapse to one tone per answer.
   */
  const handleLiveSettlement = useCallback((notice: CompletionNotice) => completionDelivery.settle(notice), [completionDelivery]);
  // The conversation on screen owns its own frames: the background watch for it keeps the stream open and folds nothing,
  // so one conversation is never folded twice and one turn is never looked up twice.
  //
  // It is stated **during render**, and that is deliberate: a switch re-renders this shell before the surface it is
  // replacing runs its own cleanup, so the watch that inherits the conversation has joined the stream before the
  // surface leaves it. Doing this in an effect would run the surface's release first, and the conversation's one source
  // would be closed and reopened for a handover that never needed a new connection. The call is idempotent, so a
  // re-render that selects the same conversation changes nothing.
  completionDelivery.select(selectedSession?.id ?? null);
  // Leaving a conversation hands its projection over rather than a summary of it: the watch that keeps the stream
  // continues from the surface's own turns and interests, so a queued follow-up is still waited for.
  const handleProjectionChange = useCallback((conversationId: string, step: Step) => {
    completionDelivery.handover(conversationId, step);
  }, [completionDelivery]);
  const subscribeAgentEvents = useCallback(
    (conversationId: string, listener: (event: AgentEventLike) => void) => completionDelivery.subscribe(conversationId, listener),
    [completionDelivery],
  );
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
    // The sidebar lists the catalogue; the selection hears it too, because a workspace restore resolves its remembered
    // conversation from rows that are already here rather than from a second read that would have to race this one.
    selection.setCatalogue(sessions);
    // The sidebar hydrates metadata after the selected session has already
    // mounted. Merge that update into the active session without changing the
    // ChatWindow key or restarting its history load.
    selection.refreshConversationRow(sessions);
  }, [selection]);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  // A subagent conversation's completion is not the user's to be told about. The relation the catalogue reports is the
  // same one the sidebar's own suppression reads, so this reads that rather than inventing a second source for it.
  subagentSessionIdsRef.current = new Set(
    sessionsWithSelection.filter((session) => session.relation?.kind === "subagent").map((session) => session.id),
  );
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(activeSessionFamily?.subagents.length);
  /**
   * The conversations a delegation from here may address: the children of the conversation on screen, as the catalogue
   * states their relation. An existing child is offered so "delegate again" is an explicit choice, and a child's own
   * view also offers itself, because giving that same child another task is what a user in the child usually means.
   */
  const delegateTargets = useMemo(() => {
    const rows = (activeSessionFamily?.subagents ?? []).map((session) => ({
      id: session.id,
      label: session.name || session.firstMessage || session.id.slice(0, 12),
    }));
    if (selectedSession?.relation?.kind === "subagent") {
      rows.unshift({ id: selectedSession.id, label: selectedSession.name || selectedSession.firstMessage || selectedSession.id.slice(0, 12) });
    }
    return rows;
  }, [activeSessionFamily?.subagents, selectedSession]);
  /**
   * Whether the conversation on screen may delegate, read from **its own** selected extensions as the catalogue states
   * them. It is the same fact the Extensions panel toggles, so turning the capability off removes the entry while the
   * child tree, the child histories and the generic control of every existing child stay exactly as they are (spec D15,
   * A01). A conversation whose selection the catalogue has not stated yet offers nothing rather than guessing.
   */
  const canDelegate = selectedSession?.extensions?.includes("hepi-subagents") === true;
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    // The poll nominates and nothing more: a busy conversation is one worth watching, and whether it finished is the
    // stream's own fact rather than the poll's absence.
    completionDelivery.nominate(ids);
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, [completionDelivery]);
  // The bar above a fresh composer (NewSessionContextBar): the sidebar keeps the folder picker and the worktree listing,
  // and every move is an intent the selection carries out, which is what replaces a fresh composer.
  const sidebarControlRef = useRef<SessionSidebarControl | null>(null);
  const newSessionBarFocusRef = useRef<NewSessionContextControl | null>(null);
  // The picks the composer it replaces had. They travel with a carried draft, and they are taken once by the composer
  // that receives them: a later report from that composer clears the handover rather than re-sending it.
  const newSessionChoicesRef = useRef<NewSessionChoices | null>(null);
  const [carriedNewSessionChoices, setCarriedNewSessionChoices] = useState<NewSessionChoices | null>(null);
  const handleNewSessionChoicesChange = useCallback((choices: NewSessionChoices) => {
    newSessionChoicesRef.current = choices;
    setCarriedNewSessionChoices(null);
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);
  // Where a navigation must land inside its conversation, read from the selection: the entry the reader asked for, and
  // whether the raw-history surface is the one that can show it.
  const navigationTarget = selectionState.navigation;
  const searchTarget = navigationTarget === null
    ? null
    : { sessionId: navigationTarget.sessionId, entryId: navigationTarget.entryId ?? "", ...(navigationTarget.blockIndex === undefined ? {} : { blockIndex: navigationTarget.blockIndex }) };
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    selection.navigationHandled(target.sessionId, target.entryId);
  }, [selection]);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !locationQuery.get("sidebar"));
  const desktopSidebarOpenRef = useRef(sidebarOpen);
  // Recorded on `focusin`: `inert` blurs its contents, so at close time `activeElement` has already left.
  const sidebarHoldsFocusRef = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      sidebarHoldsFocusRef.current = target !== null && target.closest("#session-sidebar") !== null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const rightPanelFullWidth = rightPanelOpen && rightPanelExpanded && !isMobile;
  useEffect(() => {
    if (!rightPanelOpen || isMobile) setRightPanelExpanded(false);
  }, [rightPanelOpen, isMobile]);
  // Collapsed hides it as surely as full-width does, and a keyboard walks whatever is still mounted.
  const sidebarInert = rightPanelFullWidth || !sidebarOpen;
  // A close that strands focus hands it back to the toggle. Full-width expansion hides the sidebar without the reader
  // closing it, so it disarms the offer instead of earning one.
  useEffect(() => {
    if (!sidebarInert || sidebarOpen) { sidebarHoldsFocusRef.current = false; return; }
    if (!sidebarHoldsFocusRef.current) return;
    sidebarHoldsFocusRef.current = false;
    sidebarToggleRef.current?.focus();
  }, [sidebarInert, sidebarOpen]);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions must not change the remembered desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);
  /**
   * The conversation's own reload, published by the chat that owns it.
   *
   * Settings › General and Settings › Agents change resources the open conversation runs with, and that conversation
   * then picks them up. The pick-up is one operation on the conversation — the Backend's reload, the read that states
   * it and the notice reporting it — so the chat publishes that operation on the connection and a panel asks the
   * conversation its write landed on. The shell holds no key, no callback and no result of its own: a reload of the
   * same conversation is not a new conversation, so nothing here rebuilds the tree for one.
   */
  const handleConversationReloadChange = useCallback((reload: (() => Promise<ReloadOutcome>) | null) => {
    const published = publishedConversationReloadRef.current;
    // The registration being withdrawn is the one this shell published, whichever conversation it named: a chat that
    // unmounted must not leave its operation behind for the next one to answer with.
    if (published !== null) {
      published.refreshes.release(published.conversationId, published.refresh);
      publishedConversationReloadRef.current = null;
    }
    const conversationId = chatIdentityRef.current;
    if (reload === null || conversationId === null) return;
    connection.refreshes.hold(conversationId, reload);
    publishedConversationReloadRef.current = { refreshes: connection.refreshes, conversationId, refresh: reload };
  }, [connection]);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "delegate" | "system" | "tools" | "session" | "history" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  // The delegate entry follows the conversation's own capability. A panel left open when the capability is turned off
  // closes rather than staying on screen over a conversation that may no longer delegate (spec D15).
  useEffect(() => {
    if (!canDelegate) {
      setActiveTopPanel((panel) => panel === "delegate" ? null : panel);
    }
  }, [canDelegate]);

  useEffect(() => {
    if (rightPanelFullWidth) setActiveTopPanel(null);
  }, [rightPanelFullWidth]);

  const toggleTopPanel = useCallback((
    panel: "agents" | "delegate" | "system" | "tools" | "session" | "history",
    keepMobileToolbarOpen = false,
  ) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const handleSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, keepMobileToolbarOpen);
    if (!opening || systemInfoLoading) return;

    const load = systemInfoLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, systemInfoLoading, toggleTopPanel]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  // The composer opens Settings too: a bare /mcp opens Settings › MCP (useAgentSession).
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [isMobile]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  const handleRightPanelExpandToggle = useCallback(() => {
    setActiveTopPanel(null);
    setRightPanelExpanded((expanded) => !expanded);
  }, []);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftKey]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "agents" || activeTopPanel === "delegate") {
        setTopPanelPos({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  // The page's terminal stream is owned by the tabs attached to it, not by this component's mount: the fan-in opens it
  // when the first tab joins and closes it when the last one leaves, so there is nothing to close here. Closing it on an
  // effect cleanup would make the shared instance permanently closed — a development double-invoked effect would leave
  // every terminal tab of the page without a stream at all.
  const [terminalsRestored, setTerminalsRestored] = useState(false);

  /**
   * A mounted terminal tab costs one pool connection, and the page holds exactly one for all of them: while any tab is
   * mounted the background watches have one slot less, because the count that matters is per-origin and includes both.
   * The panel tells the fan-in when it attaches, so the budget follows the real count rather than a guess.
   */
  useEffect(() => {
    completionDelivery.terminalStream(terminalTabs.length > 0);
  }, [completionDelivery, terminalTabs.length]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveFileTabId(saved.activeId);
        setRightPanelOpen(saved.open);
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        // The tab's own workspace travels with it, so a restored tab is named by its folder rather than by whichever
        // project happens to be selected when the page loads.
        tabs: terminalTabs.filter((tab) => !tab.closing).map(({ id, cwd, displayCwd }) => ({ id, cwd, ...(displayCwd === undefined ? {} : { displayCwd }) })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, terminalsRestored]);

  /**
   * What an accepted selection means for this shell's own surfaces: the file tabs and the raw-history panel.
   *
   * Both decisions read the same committed selection, so they belong in one effect. Written apart, the cleanup of the
   * project just left could erase the presentation the very same acceptance asked for — a reference in another
   * project's conversation whose block is no longer in the transcript opens its raw surface *and* changes project, and
   * the reader should not have to watch a panel that closes the instant it was asked to open.
   *
   * Tabs are keyed by absolute path, so the previous project's must not linger under a folder they do not belong to,
   * while a same-project worktree move keeps them and a resolved identity — the same project, learned rather than
   * chosen — is not a transition at all.
   *
   * The panel follows a *new* request, not the standing one: closing it is the reader's own decision and the position
   * stays where the request put it, so an effect keyed on the value alone would reopen a panel they just dismissed.
   * Every intent that moves the selection either states a fresh position or clears it, which is what keeps a stale one
   * from being presented in a project it was never asked about.
   */
  const projectTransition = selectionState.projectTransition;
  const projectTransitionSeenRef = useRef(projectTransition);
  const rawHistoryRequestRef = useRef(rawHistoryFocus);
  const activeFileTabIdRef = useRef(activeFileTabId);
  activeFileTabIdRef.current = activeFileTabId;
  useEffect(() => {
    // The page's own restore of its saved tabs is not a project change; only a later acceptance is.
    const transitioned = projectTransition !== projectTransitionSeenRef.current;
    projectTransitionSeenRef.current = projectTransition;
    const newRequest = rawHistoryFocus !== rawHistoryRequestRef.current;
    rawHistoryRequestRef.current = rawHistoryFocus;
    if (transitioned) {
      setFileTabs([]);
      // A terminal tab belongs to the page, not to a project, and stays; the file tab it replaced cannot.
      const open = activeFileTabIdRef.current;
      if (open === null || open.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
      // A cross-project acceptance states its own position, so what is on screen is what this choice asked for.
      setActiveTopPanel(rawHistoryFocus !== null ? "history" : null);
      return;
    }
    if (newRequest && rawHistoryFocus !== null) setActiveTopPanel("history");
  }, [projectTransition, rawHistoryFocus]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  // A terminal tab is addressed by its routing cwd and named by its own workspace: the folder the host reported for
  // that tab, never the currently selected project's. Switching projects therefore leaves an open terminal's label
  // alone.
  const panelTabs: Tab[] = [...fileTabs, ...terminalTabs.map((tab) => ({
    id: tab.id,
    label: getFileName(displayPathUnder(tab.cwd, tab.cwd, tab.displayCwd)) || tab.cwd,
    filePath: tab.cwd,
    kind: "terminal" as const,
    closing: Boolean(tab.closing),
  }))];

  /**
   * Apply the page's first navigation, once, after mount.
   *
   * The tab's own stores and the tab memory do not exist on the server, so reading them during the first render would
   * make the client tree differ from the HTML it hydrated. The selection reads them here instead, and the drafts it
   * brings back are adopted before any composer mounts.
   */
  useLayoutEffect(() => {
    selection.start();
  }, [selection]);

  // The workspace's last open conversation is restored by the selection itself, from the catalogue the sidebar lists —
  // so this only has to hand it the listing and tell it the workspace moved.

  /**
   * A workspace switch the reader made, from the sidebar's pickers or the files tab.
   *
   * The selection decides what it costs: a conversation of the same project stays open while the folder around it
   * moves; anything else is replaced by the destination's own restore.
   */
  const handleNewSession = useCallback((target: WorkspaceTarget, options?: StartComposerOptions) => {
    if (options?.carry === true) setCarriedNewSessionChoices(newSessionChoicesRef.current);
    selection.startComposer(target, options);
  }, [selection]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession({ cwd }),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check relies on.
  // Hydrate it from the session list so switching worktrees right after
  // creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void api.list()
      .then((catalogue) => ({ sessions: catalogue.sessions as SessionInfo[] }))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        selection.refreshConversationRow(d.sessions);
      })
      .catch(() => {});
  }, [selection]);

  /**
   * Open a conversation by id: a deep link, a reference, a citation, the raw-history surface's own rows.
   *
   * The catalogue the sidebar already delivered answers first, so a row click costs no detail read; anything else is the
   * by-id read, which is the conversation's identity *and* its row. The selection fences both by the target the reader
   * is on, so an answer for a target they already left changes nothing.
   */
  const handleOpenSession = useCallback(async (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => {
    const selectOptions: SelectConversationOptions = {
      ...(entryId === undefined ? {} : { entryId }),
      ...(options?.rawHistoryFocus === true ? { rawHistory: true } : {}),
    };
    const catalogued = sessionCatalog.find((session) => session.id === sessionId);
    if (catalogued && !catalogued.transient) {
      selection.selectConversation(catalogued, selectOptions);
      return;
    }
    await selection.openConversation(sessionId, selectOptions);
  }, [selection, sessionCatalog]);

  /** Open a row a panel already holds: the child tree, a delegate's existing child, a search hit. */
  const handleSelectConversation = useCallback((session: SessionInfo, entryId?: string, blockIndex?: number) => {
    selection.selectConversation(session, {
      ...(entryId === undefined ? {} : { entryId }),
      ...(blockIndex === undefined ? {} : { blockIndex }),
    });
  }, [selection]);

  /** Read the conversation the shell failed to open again. Only the read is repeated — never the navigation's writes. */
  const retryOpenSession = useCallback(async () => {
    await selection.retryOpen();
  }, [selection]);

  /**
   * Leave a conversation for the composer of the folder it belonged to.
   *
   * It is one action with two callers, because they are the same move: a conversation that was deleted, and one that
   * cannot be read at all. Both land the reader in a context the shell already knows how to open, and neither touches
   * the unsent draft, which is stored under its own key and is still there when they come back.
   */
  /** The recovery a failed conversation read offers: back to a context that is not broken. */
  const leaveUnreadableSession = useCallback(() => {
    selection.leaveUnreadableConversation();
  }, [selection]);

  // Called by ChatWindow when a new session gets its real id from pi: the fresh composer became this conversation, and
  // the promotion is the one place that handover happens.
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    // The confirmation names the composer that submitted: a promotion the reader has already left by picking somewhere
    // else must not replace what they are writing now.
    selection.acceptPromotion(session, sourceDraftKey);
    hydrateSelectedSession(session.id);
  }, [hydrateSelectedSession, selection]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) selection.selectConversation(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") fire();
      });
    }
  }, [selection]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const body = await api.autoName(sessionId);
      if (!body.title) throw new Error("The Backend answered no name");

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      selection.renameConversation(sessionId, title);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  /**
   * A delegation created a child. The catalogue is re-read rather than the child being guessed at: the new row's
   * relations, its own status and its own selection come from the backend, and the sidebar's own poll carries them the
   * same way it carries any other conversation's (spec D15).
   */
  const handleDelegated = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  /**
   * A subtree request was answered or refused. The catalogue is re-read rather than patched from the answer: the rows
   * the list and the running poll publish are the Backend's own, and this surface shows them as they arrive.
   */
  const handleSubtreeControlled = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    // The copy is what the reader is shown: the selection adopts it as a conversation, and its own row is hydrated from
    // the catalogue so the same-project check does not mistake a transient row for another project.
    selection.conversationForked({
      path: "",
      id: newSessionId,
      cwd: activeCwd ?? "",
      created: "",
      modified: "",
      messageCount: 0,
      firstMessage: "",
      transient: false,
    });
    hydrateSelectedSession(newSessionId);
  }, [activeCwd, hydrateSelectedSession, selection]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    const forked = await api.control(sourceSessionId).fork({ at: sourceEntryId, requestId: createRequestId() });
    if (!forked.ok) throw operationFailure(forked);
    setPendingQuotePrompt({ sessionId: forked.value.conversationId, text: prompt });
    handleSessionForked(forked.value.conversationId);
  }, [handleSessionForked, translate]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    // The DELETE can outlive a session switch. The selection reads its own current state, so a removal that completes
    // after the reader moved on leaves the conversation they are on alone, and only the deleted one is left.
    selection.conversationDeleted(sessionId);
  }, [selection]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; page?: number },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const page = options?.page;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      page,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string, page?: number) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null, page });
  }, [handleOpenFile, selectedSession?.id]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    // A new tab takes the workspace it was opened in as its own name from the start, so its label is right before the
    // host has answered and stays right after a project switch.
    const tab = existing ?? newTerminalTab(cwd, activeDisplayCwd ?? undefined);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [terminalTabs, isMobile, activeDisplayCwd]);

  /** The folder the host itself reported for a terminal tab: its own workspace, which names it from then on. */
  const handleTerminalCwdKnown = useCallback((tabId: string, displayCwd: string) => {
    setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && tab.displayCwd !== displayCwd ? { ...tab, displayCwd } : tab));
  }, []);

  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveFileTabId((current) => current !== tab.id ? current : replacement?.id ?? remaining.at(-1)?.id ?? fileTabs.at(-1)?.id ?? null);
    if (!replacement && !remaining.length && !fileTabs.length) setRightPanelOpen(false);
  };

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && terminalTabs.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? null;
    });
  }, [fileTabs, terminalTabs]);

  /**
   * The raw history behind the window: the entries a compaction dropped and the prefix a fork inherited are not in the
   * transcript, and this is where they are read. It is the backend's own bounded read — the same one `agent_read`
   * calls — so the panel shows what the durable history really holds instead of an export of what the window already
   * had, and a block it names can be forked from or read on its own.
   */
  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    toggleTopPanel("history");
  }, [selectedSession, toggleTopPanel]);

  // Show chat area if a conversation is selected, or if the fresh composer has a folder to start in.
  const effectiveNewSessionCwd = selectedSession === null ? newSessionCwd : null;
  const composerDraftKeyNow = selectedSession === null ? newSessionDraftKey : null;

  // The bar above a fresh composer. Only a fresh composer moves, and only
  // somewhere else: the folder in use would remount it for nothing. The
  // control the move came from takes focus in the bar of the new composer.
  const handlePickNewSessionContext = useCallback((target: NewSessionTarget, from: NewSessionContextControl) => {
    if (selectedSession !== null || !effectiveNewSessionCwd || target.cwd === effectiveNewSessionCwd) return;
    newSessionBarFocusRef.current = from;
    // The composer's own draft and picks move with it: the bar's pick is the carry, and the target's parked draft stays
    // parked for the next visit rather than merging into what the user is writing.
    setCarriedNewSessionChoices(newSessionChoicesRef.current);
    selection.startComposer({
      cwd: target.cwd,
      ...(target.projectKey === undefined ? {} : { projectKey: target.projectKey }),
      ...(target.projectRoot === undefined ? {} : { projectRoot: target.projectRoot }),
      ...(target.projectDisplayRoot === undefined ? {} : { displayRoot: target.projectDisplayRoot }),
    }, { carry: true });
  }, [effectiveNewSessionCwd, selectedSession, selection]);
  // The folder picker answers later: its pick runs the newest closure, guard included.
  const pickNewSessionContextRef = useRef(handlePickNewSessionContext);
  pickNewSessionContextRef.current = handlePickNewSessionContext;
  const handleOpenFolderForNewSession = useCallback((opener: HTMLElement | null) => {
    sidebarControlRef.current?.openFolderForNewSession((target) => pickNewSessionContextRef.current(target, "project"), opener);
  }, []);
  const handleDefaultDirectoryForNewSession = useCallback(() => {
    sidebarControlRef.current?.openDefaultDirectoryForNewSession((target) => pickNewSessionContextRef.current(target, "project"));
  }, []);
  const handleRefreshNewSessionWorktrees = useCallback(() => {
    sidebarControlRef.current?.refreshWorktrees();
  }, []);
  const handleCreateNewSessionWorktree = useCallback(async (project: ProjectChoice, branch: string) => {
    const control = sidebarControlRef.current;
    if (!control) throw new Error("The session sidebar is not mounted");
    return await control.createWorktree(project, branch);
  }, []);
  const handleNewSessionBarFocusDone = useCallback(() => {
    newSessionBarFocusRef.current = null;
  }, []);
  const newSessionContextBar = selectedSession === null && effectiveNewSessionCwd ? (
    <NewSessionContextBar
      context={contextForCwd(workspaceContext, effectiveNewSessionCwd, workspaceMove)}
      mobile={isMobile}
      initialFocus={newSessionBarFocusRef.current}
      onInitialFocusDone={handleNewSessionBarFocusDone}
      onPick={handlePickNewSessionContext}
      onUseDefaultDirectory={handleDefaultDirectoryForNewSession}
      onOpenFolder={handleOpenFolderForNewSession}
      onRefreshWorktrees={handleRefreshNewSessionWorktrees}
      onCreateWorktree={handleCreateNewSessionWorktree}
    />
  ) : null;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    // Project trust is a question about a project's own files. A cwd that names no workspace — the cwd of a
    // conversation with no execution workspace — has no project to trust, so nothing is asked about it.
    if (!projectTrustCwd || !isWorkspaceRoutingPath(projectTrustCwd)) return;

    const controller = new AbortController();
    // The answer also lists the project's MCP servers (`mcpFile`, `mcpServers`), unused here: the
    // trust dialog fetches the listing again when it opens, since the file can change in between.
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  // The restricted-mode banner and Settings › MCP's trust notice open the same dialog. It reads the folder's
  // trust and says where the decision belongs: recording one is not this Web origin's to do, so there is no
  // request for one here (no POST /api/project-trust, and no state for a write's progress or failure).
  const openProjectTrustDialog = useCallback(() => setProjectTrustDialogOpen(true), []);

  // A project write changed the folder's trust (`.pi/mcp.json` alone makes a folder require trust, and the host
  // answers the listing after the change with the folder's trust as it stands). Every mounted section reloads in
  // place on the new status (projectTrustReloadKey); nothing was rebuilt, so the chat needs no new session key.
  const handleProjectTrustChanged = useCallback((cwd: string, status: ProjectTrustStatus) => {
    if (cwd === projectTrustCwd) setProjectTrust(status);
  }, [projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // The title names the folder the user knows, never the routing path the API is addressed by.
  const activeCwdLabel = activeDisplayCwd ?? activeCwd;
  const activeCwdName = activeCwdLabel ? getFileName(activeCwdLabel) || activeCwdLabel : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        controlRef={sidebarControlRef}
        refreshKey={refreshKey}
        onOpenFile={handleOpenFile}
        onOpenTerminal={handleOpenTerminal}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = settingsSectionRequiresProject(section) && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
      </div>
    </>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={openProjectTrustDialog}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
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
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !showChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button
          type="button"
          onClick={() => {
            handleViewFullHistory();
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
          disabled={!selectedSession}
          title={selectedSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
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
            color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
            cursor: selectedSession ? "pointer" : "not-allowed",
            opacity: selectedSession ? 1 : 0.45,
            flexShrink: 0,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!selectedSession) return;
            event.currentTarget.style.color = "var(--text)";
            event.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
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
              color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!mobile && <span>{translate("history.label")}</span>}
        </button>
        {(() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
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
            onClick={() => toggleTopPanel("delegate", mobile)}
            title={translate("delegate.open")}
            aria-label={translate("delegate.open")}
            aria-pressed={activeTopPanel === "delegate"}
            data-delegate-entry
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "delegate" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "delegate" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "delegate" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "delegate" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12h9" /><path d="m11 8 4 4-4 4" /><rect x="16" y="7" width="5" height="10" rx="1.5" />
            </svg>
            {!mobile && <span>{translate("delegate.open")}</span>}
          </button>
        )}
        {hasSubagentSessions && (
          <button
            type="button"
            onClick={() => toggleTopPanel("agents", mobile)}
            title={translate("agentSwitcher.title")}
            aria-label={translate("agentSwitcher.title")}
            aria-pressed={activeTopPanel === "agents"}
            data-agent-switcher
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
            {!mobile && <span>{translate("agentSwitcher.title")}</span>}
            <span
              aria-hidden="true"
              style={{
                minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                borderRadius: 7, background: "var(--bg-selected)", color: "var(--accent)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                ...(mobile ? { position: "absolute", top: 2, right: 2, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
              }}
            >
              {activeSessionFamily!.subagents.length}
            </span>
          </button>
        )}
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleSystemInfoToggle("system", mobile)}
          disabled={mobile && !showChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
          {!mobile && <span>{translate("system.label")}</span>}
        </button>
        <button
          type="button"
          onClick={() => handleSystemInfoToggle("tools", mobile)}
          disabled={mobile && !showChat}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={activeTopPanel === "tools"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "tools" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
          </svg>
          {!mobile && <span>{translate("tools.label")}</span>}
        </button>
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
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
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
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
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
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
                {translate("session.title")}
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

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelOpen ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <WorkbenchSelectionProvider value={selection}>
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        inert={sidebarInert}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          inert={sidebarInert}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div inert={rightPanelFullWidth} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            ref={sidebarToggleRef}
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
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
          {isMobile && (
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
              {isNarrowMobile && (
                <button
                  type="button"
                  onClick={handleMobileToolbarMoreToggle}
                  title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={mobileToolbarMoreOpen}
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                    background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                    border: "none", borderRight: "1px solid var(--border)",
                    color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {mobileToolbarMoreOpen ? (
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
              {!isNarrowMobile && renderChatToolbarActions(true)}
              {renderSessionStatsButton(true)}
              {renderMainFileToggle(true)}
              {isNarrowMobile && mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
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
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <>
                  <AgentSessionPanel
                    rootSession={activeSessionFamily.root}
                    subagents={activeSessionFamily.subagents}
                    selectedSessionId={selectedSession.id}
                    runningSessionIds={runningSessionIds}
                    onSelectSession={handleSelectConversation}
                  />
                  {/*
                    Subtree control sits **below** the tree it names: a row stays a row, and navigation stays available
                    while a request is in flight. The descendants offered are the family listing the panel already
                    holds — a proposal only, since the Backend captures the governing set from durable relations — and
                    the whole subtree is chosen by default so an omitted child is a decision rather than a silence.
                  */}
                  {activeSessionFamily.subagents.length > 0 && (
                    <SubtreeControlPanel
                      root={activeSessionFamily.root}
                      descendants={activeSessionFamily.subagents.map((session) => ({ id: session.id, session }))}
                      runningSessionIds={runningSessionIds}
                      onSelectSession={handleSelectConversation}
                      onControlled={handleSubtreeControlled}
                    />
                  )}
                </>
              )}
              {activeTopPanel === "delegate" && selectedSession && (
                <QuickDelegatePanel
                  sessionId={selectedSession.id}
                  cwd={selectedSession.cwd}
                  canDelegate={canDelegate}
                  isChild={selectedSession.relation?.kind === "subagent"}
                  existingChildren={delegateTargets}
                  onOpenChild={(session) => handleSelectConversation(session)}
                  onCreated={handleDelegated}
                />
              )}
              {activeTopPanel === "history" && selectedSession && (
                <RawHistoryPanel
                  sessionId={selectedSession.id}
                  focusEntryId={rawHistoryFocus?.sessionId === selectedSession.id ? rawHistoryFocus.entryId : null}
                  onOpenSession={handleOpenSession}
                  onForked={handleSessionForked}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const ws = selectedSession;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const projectRows = [
                      ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectDisplayRoot ?? ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
                      ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
                      ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                        </div>
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {/* A conversation the shell was asked for and could not open. It takes the chat's place because nothing else
              can honestly be shown for it: the selection did not move, so the panel names the target and offers the
              read again — or leaving it alone. */}
          {openFailure ? (
            <ReadFailurePanel
              failure={openFailure.failure}
              variant="surface"
              retrying={openRetrying}
              onRetry={readFailureRetryable(openFailure.failure) ? () => { void retryOpenSession(); } : undefined}
              onBack={() => selection.dismissOpenFailure()}
            />
          ) : showChat ? (
            <ChatWindow
              key={chatIdentity}
              session={selectedSession}
              searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
              onSearchTargetHandled={handleSearchTargetHandled}
              onReadFailureBack={leaveUnreadableSession}
              initialScrollPosition={selectedSession ? sessionScrollPositionsRef.current.get(selectedSession.id) ?? null : null}
              onScrollPositionChange={handleSessionScrollPositionChange}
              subscribeAgentEvents={subscribeAgentEvents}
              onProjectionChange={handleProjectionChange}
              onLiveSettlement={handleLiveSettlement}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionDraftKey={newSessionDraftKey}
              newSessionContextBar={newSessionContextBar}
              initialNewSessionChoices={selectedSession === null ? carriedNewSessionChoices : null}
              onNewSessionChoicesChange={handleNewSessionChoicesChange}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              chatInputRef={chatInputRef}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemToolsChange={handleSystemToolsChange}
              onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
              onConversationReloadChange={handleConversationReloadChange}
              onSessionStatsChange={handleSessionStatsChange}
              onOpenSettings={openSettingsSection}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
              onFilesUploaded={handleExplorerRefresh}
              onOpenSession={handleOpenSession}
              onAskInNewChat={handleAskInNewChat}
              quoteSelectionEnabled={quoteSelectionEnabled}
              initialPrompt={pendingQuotePrompt?.sessionId === selectedSession?.id ? pendingQuotePrompt?.text : undefined}
              onInitialPromptConsumed={() => setPendingQuotePrompt(null)}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {selectionState.initialCwd.requested}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {selectionState.initialCwd.requested}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          inert={rightPanelFullWidth}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelFullWidth ? " right-panel-full-width" : ""}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>
          <button
            type="button"
            className="file-panel-expand-button"
            onClick={handleRightPanelExpandToggle}
            aria-controls="file-panel"
            aria-pressed={rightPanelFullWidth}
            title={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
            aria-label={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={rightPanelFullWidth
                ? "M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"
                : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"} />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            aria-controls="file-panel"
            aria-expanded={rightPanelOpen}
            title={translate("files.hidePanel")}
            aria-label={translate("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              displayCwd={activeDisplayCwd}
              gitRefreshKey={explorerRefreshKey}
              onReloadFolder={handleExplorerRefresh}
              onClose={() => handleCloseFileTab(activeFileTab.id)}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialPage={activeFileTab.page}
              initialState={activeFileTab.viewerState}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath, page) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId, page },
              )}
            />
          ) : !terminalTabs.some((tab) => tab.id === activeFileTabId) ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                displayCwd={tab.displayCwd ?? activeDisplayCwd}
                active={rightPanelOpen && tab.id === activeFileTabId}
                stream={subscribeTerminal}
                connection={terminalConnection}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCwdKnown={(displayCwd) => handleTerminalCwdKnown(tab.id, displayCwd)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        displayCwd={activeDisplayCwd ?? projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        quoteSelectionEnabled={quoteSelectionEnabled}
        onQuoteSelectionChange={handleQuoteSelectionChange}
        onClose={() => setSettingsSection(null)}
        projectTrust={projectTrust}
        onProjectTrustChanged={handleProjectTrustChanged}
      />
    )}
    {/* After Settings, so it opens above it (z-index 1100 over 1000) when Settings › MCP asks for it. */}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        // This connection's own client, so the read carries its origin and credential; the dialog's own effect is
        // keyed on the folder, so a new function each render fetches nothing again.
        request={(path, init) => connection.client.request(path, init)}
        onClose={() => setProjectTrustDialogOpen(false)}
        onStatus={setProjectTrust}
      />
    )}
    </>
    </WorkbenchSelectionProvider>
  );
}
