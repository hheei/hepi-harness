"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useGlobalKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { SessionSidebar, type SessionSidebarControl } from "./SessionSidebar";
import { NewSessionContextBar, type NewSessionContextControl } from "./NewSessionContextBar";
import type { ChatScrollPosition } from "../lib/chat/chat-scroll-position";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { activeFilePanelTab, openFilePanelTab, openTerminalPanelTab, panelsAfterProjectTransition } from "./panel-state";
import { ChatArea } from "./ChatArea";
import { ShellTopBar } from "./ShellTopBar";
import type { TopPanel } from "./ShellTopPanel";
import { WorkspacePanel } from "./WorkspacePanel";
import { useTerminalFanIn } from "../hooks/useTerminalFanIn";
import { TerminalFanIn, type FanInSubscription } from "../lib/terminal-fan-in";
import { useTheme } from "../hooks/useTheme";
import { useFontPreferences } from "../hooks/useFontPreferences";
import { useI18n } from "../hooks/useI18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useViewportHeight } from "../hooks/useViewportHeight";
import { useShellPanels } from "../hooks/useShellPanels";
import { useWorkspacePanel } from "../hooks/useWorkspacePanel";
import { useFocusReturn } from "../hooks/useSurfaceFocus";
import { useAudio } from "../hooks/useAudio";
import { copyText } from "../lib/clipboard";
import { createRequestId, operationFailure } from "../lib/conversation-api";
import { useWorkbenchChange, useWorkbenchConnection } from "../lib/workbench-scope";
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
import { contextForCwd, type NewSessionTarget, type ProjectChoice } from "../lib/new-session-context";
import {
  useSelectionStateOf,
  useWorkbenchSelectionStore,
  WorkbenchSelectionProvider,
  type SelectConversationOptions,
  type StartComposerOptions,
  type WorkspaceTarget,
} from "../lib/workbench-selection";
import type { SessionInfo } from "../lib/types";
import type { ProjectTrustStatus } from "@hepi/protocol/mcp-ui";
import type { ChatInputHandle } from "./ChatInput";
import type { NewSessionChoices } from "../hooks/useAgentSession";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { AutoNameStatus, SessionCopyField } from "./ShellTopBar";
import type { ToolEntry } from "../lib/tool-presets";
import { getSessionFamily } from "../lib/session-family";
import { CompletionDelivery, type CompletionNotice } from "../lib/completion-delivery";
import type { Step } from "../lib/lifecycle-projection";
import type { AgentEventLike } from "../lib/agent-event-wire";
import { getLastSettingsSection, settingsSectionRequiresProject, type SettingsSection } from "../lib/settings-navigation";

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
  const { t: translate } = useI18n();
  const isMobile = useIsMobile();
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
  // What this shell observed about the workbench: the catalogue's rows are stale, or the files under a workspace are.
  // The surfaces that read those resources subscribe, so no counter travels down as a protocol between two ends.
  const catalogueChange = useWorkbenchChange("catalogue");
  const filesChange = useWorkbenchChange("files");
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  // The file panel: its tabs, its own memory across a reload, and whether it is on screen. It is declared before the
  // sidebar because the sidebar's own maximum is what the panel leaves beside it.
  const workspacePanel = useWorkspacePanel();
  const { panel } = workspacePanel;
  const rightPanelOpen = workspacePanel.open;
  const setRightPanelOpen = workspacePanel.setOpen;
  const [sidebarOpen, setSidebarOpen] = useState(() => !locationQuery.get("sidebar"));
  const desktopSidebarOpenRef = useRef(sidebarOpen);
  // A close that strands focus hands it back to the toggle: the offer is recorded while the sidebar still holds it.
  const returnSidebarFocus = useFocusReturn("#session-sidebar");
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
    returnSidebarFocus(sidebarInert && !sidebarOpen ? "dismissed" : "shown", () => sidebarToggleRef.current);
  }, [returnSidebarFocus, sidebarInert, sidebarOpen]);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // The two panels this shell drags, and the widths they were last left at: each one's maximum is what is left beside
  // the other, so they are one binding rather than two sets of numbers.
  const { sidebar: sidebarResizer, rightPanel: rightPanelResizer } = useShellPanels({
    sidebarOpen,
    rightPanelOpen,
    sidebarLabel: translate("layout.resizeSidebar"),
    rightPanelLabel: translate("layout.resizeFilePanel"),
  });
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions must not change the remembered desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  // The system prompt and the tool list, as the conversation's own surface stated them, and the loader it publishes so
  // the bar can ask for a fresh read when one of those panels opens. Whether a read is in flight is the bar's own state:
  // it is the surface that asked, and the answer arrives as these two values.
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => setSystemPrompt(prompt), []);
  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => setSystemTools(tools), []);
  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoaderRef.current = loader;
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

  /**
   * Which of the bar's own panels is open. One at a time, and only while its subject is on screen: it is the shell's
   * presentation state, so what opens and closes it is stated here rather than inside the bar's own chrome.
   */
  const [activeTopPanel, setActiveTopPanel] = useState<TopPanel | null>(null);

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

  const toggleTopPanel = useCallback((panel: TopPanel) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  // The composer opens Settings too: a bare /mcp opens Settings › MCP (useAgentSession).
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [isMobile]);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
    }
    setRightPanelOpen(!rightPanelOpen);
  }, [isMobile, rightPanelOpen, setRightPanelOpen]);

  const handleRightPanelExpandToggle = useCallback(() => {
    setActiveTopPanel(null);
    setRightPanelExpanded((expanded) => !expanded);
  }, []);

  // A mounted terminal tab costs one pool connection, and the page holds exactly one for all of them: while any tab is
  // mounted the background watches have one slot less, because the count that matters is per-origin and includes both.
  useEffect(() => {
    completionDelivery.terminalStream(panel.terminalTabs.length > 0);
  }, [completionDelivery, panel.terminalTabs.length]);

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
  useEffect(() => {
    // The page's own restore of its saved tabs is not a project change; only a later acceptance is.
    const transitioned = projectTransition !== projectTransitionSeenRef.current;
    projectTransitionSeenRef.current = projectTransition;
    const newRequest = rawHistoryFocus !== rawHistoryRequestRef.current;
    rawHistoryRequestRef.current = rawHistoryFocus;
    if (transitioned) {
      // The panel's own policy decides what a project change costs: the file tabs go, and a terminal the reader was
      // watching keeps its panel because neither it nor its shell belongs to the project that moved.
      workspacePanel.apply(panelsAfterProjectTransition);
      // A cross-project acceptance states its own position, so what is on screen is what this choice asked for.
      setActiveTopPanel(rawHistoryFocus !== null ? "history" : null);
      return;
    }
    if (newRequest && rawHistoryFocus !== null) setActiveTopPanel("history");
  }, [projectTransition, rawHistoryFocus, workspacePanel]);

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
    catalogueChange.notify();
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
    // A finished run changed the conversation's row and the files it wrote: both are stated as the facts they are.
    catalogueChange.notify();
    filesChange.notify();
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
      catalogueChange.notify();
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
  }, [autoNameStatus.kind, catalogueChange, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  /**
   * A delegation created a child. The catalogue is re-read rather than the child being guessed at: the new row's
   * relations, its own status and its own selection come from the backend, and the sidebar's own poll carries them the
   * same way it carries any other conversation's (spec D15).
   */
  const handleDelegated = useCallback(() => {
    catalogueChange.notify();
  }, [catalogueChange]);

  /**
   * A subtree request was answered or refused. The catalogue is re-read rather than patched from the answer: the rows
   * the list and the running poll publish are the Backend's own, and this surface shows them as they arrive.
   */
  const handleSubtreeControlled = useCallback(() => {
    catalogueChange.notify();
  }, [catalogueChange]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    catalogueChange.notify();
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

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; page?: number },
  ) => {
    workspacePanel.apply((state) => openFilePanelTab(state, {
      fileName,
      filePath,
      ...(options?.modeHint === undefined ? {} : { modeHint: options.modeHint }),
      ...(options?.page === undefined ? {} : { page: options.page }),
      sourceSessionId: options?.sourceSessionId ?? null,
    }));
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [workspacePanel.apply, isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string, page?: number) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null, page });
  }, [handleOpenFile, selectedSession?.id]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    // A new tab takes the workspace it was opened in as its own name from the start, so its label is right before the
    // host has answered and stays right after a project switch.
    workspacePanel.apply((state) => openTerminalPanelTab(state, cwd, activeDisplayCwd));
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [activeDisplayCwd, workspacePanel.apply, isMobile]);

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
    // trust dialog fetches the listing again when it opens, since the file can change in between. The read goes through
    // this connection's client for the same reason the dialog's does: a relative `fetch` would ask the App bundle's own
    // origin instead of the Gateway the reader was admitted to.
    connection.client.request(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
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
  }, [connection, projectTrustCwd]);

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
        onOpenFile={handleOpenFile}
        onOpenTerminal={handleOpenTerminal}
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
        <ShellTopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={handleSidebarToggle}
          onSidebarOpen={setSidebarOpen}
          sidebarToggleRef={sidebarToggleRef}
          topBarRef={topBarRef}
          showChat={showChat}
          activePanel={activeTopPanel}
          onActivePanel={setActiveTopPanel}
          session={selectedSession}
          family={activeSessionFamily}
          runningSessionIds={runningSessionIds}
          onSelectConversation={handleSelectConversation}
          onSubtreeControlled={handleSubtreeControlled}
          onDelegated={handleDelegated}
          canDelegate={canDelegate}
          delegateTargets={delegateTargets}
          historyFocus={rawHistoryFocus}
          onOpenSession={handleOpenSession}
          onSessionForked={handleSessionForked}
          systemPrompt={systemPrompt}
          systemTools={systemTools}
          systemInfoLoaderRef={systemInfoLoaderRef}
          stats={sessionStats}
          contextUsage={contextUsage}
          copiedField={copiedSessionField}
          onCopyField={handleCopySessionField}
          autoNameStatus={autoNameStatus}
          onAutoName={handleAutoName}
          onViewFullHistory={handleViewFullHistory}
          trust={projectTrust}
          onOpenTrustDialog={openProjectTrustDialog}
          filesOpen={rightPanelOpen}
          onToggleFiles={handleRightPanelToggle}
        />

        <ChatArea
          chatIdentity={chatIdentity}
          session={selectedSession}
          showChat={showChat}
          openFailure={openFailure}
          openRetrying={openRetrying}
          onRetryOpen={retryOpenSession}
          onDismissOpenFailure={() => selection.dismissOpenFailure()}
          initialCwd={selectionState.initialCwd}
          cwd={activeCwd}
          showPlaceholder={showPlaceholder}
          searchTarget={searchTarget}
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
          carriedChoices={carriedNewSessionChoices}
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
      </div>

      <WorkspacePanel
        panel={panel}
        onChange={workspacePanel.apply}
        open={rightPanelOpen}
        fullWidth={rightPanelFullWidth}
        onToggleFullWidth={handleRightPanelExpandToggle}
        onClose={() => setRightPanelOpen(false)}
        cwd={activeCwd}
        displayCwd={activeDisplayCwd}
        resizer={rightPanelResizer}
        terminalStream={subscribeTerminal}
        terminalConnection={terminalConnection}
        onMentionLines={handleFileLineMention}
        onAtMention={handleAtMention}
        onOpenFile={(filePath, page) => handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: activeFilePanelTab(panel)?.sourceSessionId ?? null, page })}
      />
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
