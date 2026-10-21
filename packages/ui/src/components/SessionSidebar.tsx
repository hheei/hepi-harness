"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useState, useCallback, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type RefObject, type UIEvent as ReactUIEvent } from "react";
import type { SessionInfo } from "../lib/types";
import { listSessionFamilies, type SessionFamily } from "../lib/session-family";
import { dispatchSessionRowContextMenu } from "../lib/session-row-context-menu";
import { getProjectActivity, getRecentProjects } from "../lib/project-groups";
import { advanceRunMarks } from "../lib/run-marks";
import { workspaceKeyOf } from "../lib/workspace-memory";
import {
  adjacentProjectMove,
  buildArchiveRows,
  buildSessionTree,
  familiesToArchive,
  familyIds,
  isFamilyArchived,
  isGroupExpanded,
  keepOutgoingGroupOpen,
  nextProjectKeysToRecord,
  showLessFamilies,
  showMoreFamilies,
  type SidebarProject,
  type SidebarRow,
} from "../lib/session-tree";
import {
  forgetRetiredSidebarKeys,
  loadGroupExpansion,
  loadPinnedCollapsed,
  loadSidebarTab,
  saveGroupExpansion,
  savePinnedCollapsed,
  saveSidebarTab,
  type SidebarTab,
} from "../lib/sidebar-prefs";
import { forkFailureMessage, sessionMenuEntries, type SessionMenuActionId } from "../lib/sidebar-actions";
import { splitBeforeForkSuffix } from "../lib/session-fork-name";
import {
  mergeProjectChoices,
  newSessionContextKey,
  type NewSessionContext,
  type NewSessionOptions,
  type NewSessionTarget,
  type ProjectChoice,
  type WorktreeChoice,
  worktreeCwd,
} from "../lib/new-session-context";
import {
  chunkForSessionUiRequests,
  MAX_PROJECT_ORDER_KEYS,
  MAX_SESSION_UI_IDS_PER_REQUEST,
  type ProjectMovePosition,
  type SessionUiAnyRequest,
} from "@hepi/protocol";
import { projectGroup, projectGroupKey, projectGroupOfPath, projectGroups, type ProjectRouting } from "../lib/project-routing";
import { isWorkspaceRoutingPath, workspaceIdOfRoutingPath } from "@hepi/protocol/files";
import {
  applyFolderUnlink,
  removalRefusal,
  removeProject as dropRecordedProject,
  type FolderUnlinkAnswer,
} from "../lib/project-removal";
import { configuredDefaultCwd, configuredHome, useWorkspaceApi, workspaceIdentity, WorkspaceRefusal, WORKTREE_LIMIT_CODES, type WorkspaceEntry } from "../lib/workspace-api";
import { focusIfLost } from "../lib/stacked-dialog";
import { createRequestId, operationFailure } from "../lib/conversation-api";
import { catalogueRow, type CatalogueEntry } from "../lib/conversation-catalogue";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import { useSelectionState, useWorkbenchSelection, type SelectConversationOptions } from "../lib/workbench-selection";
import { useI18n } from "../hooks/useI18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useScrollbarVisibility } from "../hooks/useScrollbarVisibility";
import { useSessionUiState } from "../hooks/useSessionUiState";
import { DirectoryPicker } from "./DirectoryPicker";
import { NewProjectDialog, type CreatedProject } from "./NewProjectDialog";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { ProjectWorktreePicker, type CreatedWorktree, type ProjectWorktreePickerHandle, type WorktreeRemoval } from "./ProjectWorktreePicker";
import { SessionSearch } from "./SessionSearch";
import { MAX_SEARCH_QUERY_CHARS } from "../lib/session-search";
import { SessionTree, sessionRowTitle, type SessionTreeReveal } from "./SessionTree";
import { ProjectRemovalMenu, type ProjectRemovalBody, type ProjectRemovalStep } from "./ProjectRemovalMenu";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { SidebarToast, type SidebarToastAction, type SidebarToastData } from "./SidebarToast";
import {
  ArchiveIcon,
  ChangesIcon,
  CheckIcon,
  ChevronIcon,
  DotIcon,
  DotOutlineIcon,
  FolderIcon,
  MessageIcon,
  ForkIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshIcon,
  RestoreIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  UploadIcon,
} from "./SidebarIcons";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

/** An icon button of the files tab's action row, under the project and worktree. */
function ToolbarIconButton({
  onClick,
  title,
  disabled,
  pressed,
  done,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  /** A toggle's state: shown pressed (accent) and exposed as aria-pressed. */
  pressed?: boolean;
  /** Brief confirmation after an action (refresh). */
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      className={`sidebar-tool-button${pressed ? " is-active" : ""}${done ? " is-done" : ""}`}
    >
      {children}
    </button>
  );
}

interface Props {
  /** What the bar above a fresh composer reaches through (`SessionSidebarControl`). */
  controlRef?: Ref<SessionSidebarControl>;
  refreshKey?: number;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

/**
 * What the bar above a fresh composer (components/NewSessionContextBar.tsx) reaches through the sidebar for.
 *
 * Only the two things that are genuinely the sidebar's own are here: the folder picker it already owns, and the worktree
 * listing and creation it already reads. A move is **not** one of them — it is an intent the selection carries out — so
 * nothing about which session or folder is current travels through this handle.
 */
export interface SessionSidebarControl {
  /**
   * Opens the folder picker; the validated folder goes to `onPicked`. Focus goes back to `returnFocusTo` when the picker
   * closes without moving the composer.
   */
  openFolderForNewSession(onPicked: (target: NewSessionTarget) => void, returnFocusTo: HTMLElement | null): void;
  /** "Use default directory": today's ~/pi-cwd folder, validated as the folder picker's, goes to `onPicked`. */
  openDefaultDirectoryForNewSession(onPicked: (target: NewSessionTarget) => void): void;
  /** Lists the worktrees of the sidebar's workspace again (the composer's worktree menu opening). */
  refreshWorktrees(): void;
  /** Creates a worktree of `project` and lists it at once; the caller starts the session in it. */
  createWorktree(project: ProjectChoice, branch: string): Promise<CreatedWorktree | { error: string }>;
}

type WorktreeEntry = WorktreeChoice;

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** The project's own folder on its host, for the surfaces that show it. */
  projectDisplayRoot?: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
  /**
   * Why this host serves no worktree list at all, when it cannot: a named limit is shown as one, so an empty list
   * reads as "none here" rather than as "this host cannot do that" (spec decision 28).
   */
  limit?: string;
}

interface ProjectSelection {
  /** The routing root: what the project's conversations are addressed by. */
  root: string;
  /** The project's own folder on its host, for display. A selection without one shows its routing root. */
  displayRoot: string;
  key: string;
  /** True when this folder is one a Project removal retained: shown, and never a target for a new session. */
  retained?: boolean;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
  displayRoot?: string;
  /** The path resolved to a folder a Project removal retained: shown, and never a target for a new session. */
  retained?: boolean;
}

type SessionRow = Extract<SidebarRow, { kind: "session" }>;

/** The one popup menu of the sidebar; kept here, above the virtualized rows. */
type SidebarMenuState =
  | { kind: "row"; row: SessionRow; anchor: SidebarMenuAnchor; opener: HTMLElement | null }
  | { kind: "group"; project: SidebarProject; olderCount: number; anchor: SidebarMenuAnchor; opener: HTMLElement; body?: ProjectRemovalBody };

const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;
const SESSION_DETAILS_HYDRATION_DELAY_MS = 750;
/** "Archive sessions older than 7 days" in a project's menu. */
const ARCHIVE_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;
const TOAST_TITLE_MAX = 28;

const SESSION_ACTION_LABEL_KEYS: Record<SessionMenuActionId, string> = {
  pin: "sidebar.pin",
  unpin: "sidebar.unpin",
  rename: "sidebar.rename",
  fork: "sidebar.fork",
  "mark-read": "sidebar.markRead",
  "mark-unread": "sidebar.markUnread",
  archive: "sidebar.archive",
  unarchive: "sidebar.unarchive",
  delete: "sidebar.delete",
};

function sessionActionIcon(id: SessionMenuActionId): ReactNode {
  switch (id) {
    case "pin": return <PinIcon />;
    case "unpin": return <PinOffIcon />;
    case "rename": return <PencilIcon />;
    case "fork": return <ForkIcon />;
    case "mark-read": return <DotOutlineIcon />;
    case "mark-unread": return <DotIcon />;
    case "archive": return <ArchiveIcon />;
    case "unarchive": return <RestoreIcon />;
    case "delete": return <TrashIcon />;
  }
}

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * The running set for a polled id list: `previous` itself while it holds the
 * same ids. A new Set every 2.5 s poll would rebuild every tree row (memoized
 * by identity) and re-run everything that watches the set, for nothing.
 */
export function sameIdsOr(previous: Set<string>, ids: readonly string[]): Set<string> {
  const next = new Set(ids);
  if (next.size !== previous.size) return next;
  for (const id of next) {
    if (!previous.has(id)) return next;
  }
  return previous;
}

function shortTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/**
 * focusIfLost, also when focus is still on an element that is no longer
 * rendered (in a view just hidden): browsers move it to <body> only at their
 * next rendering update, so it does not count as lost yet.
 */
function focusIfHidden(target: HTMLElement | null): void {
  const active = document.activeElement;
  if (target && active instanceof HTMLElement && active !== document.body && active.getClientRects().length === 0) {
    target.focus({ preventScroll: true });
    return;
  }
  focusIfLost(document, target);
}

/** A menu placed below (or above) a button, lined up with one of its edges. */
/**
 * How much of the toolbar row's labels fit (`data-fit`, app/sidebar.css):
 * all (0), New's + alone (1), the tabs' icons too (2). Measured, not a fixed
 * width, since the labels' widths change with the language; on the row
 * itself, before paint, again whenever it resizes or `labels` change.
 */
function useHeaderFit(ref: RefObject<HTMLElement | null>, labels: string): void {
  useLayoutEffect(() => {
    const header = ref.current;
    if (!header) return;
    const fit = () => {
      for (const level of ["0", "1", "2"]) {
        header.dataset.fit = level;
        if (header.scrollWidth <= header.clientWidth) return;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(header);
    return () => observer.disconnect();
  }, [ref, labels]);
}

function buttonAnchor(element: HTMLElement, align: "start" | "end"): SidebarMenuAnchor {
  const rect = element.getBoundingClientRect();
  return { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align };
}

export function SessionSidebar({ controlRef, refreshKey, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t } = useI18n();
  // The workbench's one selection. This surface reads it — which conversation is open, which folder is in effect — and
  // sends it intents; it holds no selection of its own beyond the search, expansion and menus that are this panel's
  // presentation.
  const selection = useWorkbenchSelection();
  const selectionState = useSelectionState();
  const selectedSessionId = selectionState.conversation?.id ?? null;
  // The workspace in effect: a conversation's own folder, or the fresh composer's. It is the same value the shell and the
  // bar above the composer read.
  const selectedCwd = selectionState.cwd;
  const isMobile = useIsMobile();
  // The catalogue this sidebar reads is the connection's own: the list, its running poll and the folder validation are
  // requests to the Gateway this page was admitted to, under its credential — never to whatever origin happens to serve
  // the document.
  const connection = useWorkbenchConnection();
  // The catalogue and the row writes are this connection's own: the Backend's `/api/conversations…` vocabulary, asked
  // under this page's credential rather than around it, and assembled with the connection rather than here.
  const api = connection.api;
  // The workspaces, projects, hosts and worktrees this sidebar manages are the same connection's: the Backend's own
  // `/api/workspaces`, `/api/projects`, `/api/hosts` and `/api/worktrees` vocabulary, under this page's credential.
  const workspaceApi = useWorkspaceApi();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  // Tracked in a ref only: the version is compared against the polled value to
  // decide whether the list needs reloading, and no render reads it.
  const sessionListVersionRef = useRef<number | null>(null);
  // The project registry's own version, read from the same poll: a Project created, changed or removed in another
  // window is heard here rather than never. A ref only: it is compared, never rendered.
  const projectsRevisionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  // The first paint lists summary rows (their time is the file's mtime); the
  // project order is first saved from the full details.
  const [sessionDetailsLoaded, setSessionDetailsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const newProjectReturnFocusRef = useRef<HTMLElement | null>(null);
  // The projects the backend recorded for this Web origin's host. Every folder of one project carries that project's
  // key, so its conversations share one group, are listed by the name the user gave it, and start their new sessions
  // in the project's default folder — whichever of its folders the sidebar happens to be showing.
  const [projects, setProjects] = useState<readonly ProjectRouting[]>([]);
  // Every execution workspace this deployment can bind, with the account its host reported. A configured workspace's
  // path is the host's own answer and appears nowhere else, so a path's display root is resolved from here.
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>([]);
  // What the registry records per project key: the display name the user gave it, and the folder the project is —
  // its default folder's own root on its host, never the /workspace/<id> routing path it is addressed by.
  const recordedProjects = useMemo(
    () => new Map([...projectGroups(projects)].map(([key, group]) => [key, { name: group.name, root: group.displayRoot, defaultCwd: group.defaultCwd }])),
    [projects],
  );
  // The registry's own record of a Project, by the group key the sidebar and the picker address it under. A group
  // the registry does not know — a configured folder, or a conversation bound to a folder no Project holds any more —
  // has no folders to unlink and no Project to remove.
  const projectRecordByKey = useMemo(
    () => new Map(projects.map(project => [projectGroupKey(project.id), project])),
    [projects],
  );
  // True once the registry has been read: before that an empty list says nothing about what it holds.
  const projectsLoadedRef = useRef(false);
  const listProjects = useCallback(async () => {
    try {
      // The registry and the workspace listing are independent, so they are read together. Both belong to this
      // connection: a deployment's own host is what answers, and no client names it.
      const [listed, bound] = await Promise.all([workspaceApi.projects(), workspaceApi.workspaces()]);
      projectsLoadedRef.current = true;
      setProjects(listed);
      setWorkspaces(bound);
    } catch {
      // A sidebar without the registry keeps the names and folders it already has.
    }
  }, [workspaceApi]);
  useEffect(() => { void listProjects(); }, [listProjects]);
  // The home the paths show as ~: the account the deployment's own configured workspace reported, never the Web
  // process's or the document's. Derived from the two listings above rather than asked of a route of its own.
  const homeDir = useMemo(() => configuredHome(workspaces, projects), [workspaces, projects]);
  // Open for the files tab's project list, or for the composer's bar ("new-session").
  const [customPathOpen, setCustomPathOpen] = useState<false | "files" | "new-session">(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  // The files tab's project and worktree picker.
  const filesPickerRef = useRef<ProjectWorktreePickerHandle>(null);
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());

  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // What this window has been told about each conversation's newest run end, and whether its first listing has been
  // taken as the baseline yet. The first listing is history; everything after it is a run the user was there for.
  const seenRunEndsRef = useRef<Map<string, number>>(new Map());
  const runMarksSeededRef = useRef(false);
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const detailsHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Sessions | Files. Both panels stay mounted; only the active one is shown.
  // The tab, the group choices and the pinned section start as the server
  // renders them and are restored from browser storage after hydration.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("sessions");
  const sessionsTabRef = useRef<HTMLButtonElement>(null);
  const filesTabRef = useRef<HTMLButtonElement>(null);
  const sessionsPanelRef = useRef<HTMLDivElement>(null);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const panelScrollTopsRef = useRef(new WeakMap<Element, number>());
  // Project groups: explicit expand/collapse choices, how many families "show
  // more" has revealed per group (SHOW_MORE_STEP a click), the pinned section,
  // the archive view.
  const [groupExpansion, setGroupExpansion] = useState<Readonly<Record<string, boolean>>>({});
  const [moreShown, setMoreShown] = useState<Readonly<Record<string, number>>>({});
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [archiveView, setArchiveView] = useState(false);
  // Row states that must survive virtualization live here, not in the rows.
  const [renamingRootId, setRenamingRootId] = useState<string | null>(null);
  const [confirmDeleteRootId, setConfirmDeleteRootId] = useState<string | null>(null);
  const [menu, setMenu] = useState<SidebarMenuState | null>(null);
  // A row the main tree should scroll to (a fork's new row); see
  // SessionTreeReveal. Held until the tree says it is done with it.
  const [treeReveal, setTreeReveal] = useState<SessionTreeReveal | null>(null);
  const treeRevealIdRef = useRef(0);
  const handleRevealHandled = useCallback((id: number) => {
    setTreeReveal((current) => (current?.id === id ? null : current));
  }, []);
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const [toast, setToast] = useState<SidebarToastData | null>(null);
  const toastIdRef = useRef(0);
  const [uiWriteFailures, setUiWriteFailures] = useState(0);
  const shownUiWriteFailuresRef = useRef(0);
  // Focus to hand to the files tab once it shows (the control that moved
  // there was in the sessions tab, which hides with its focus).
  const filesTabFocusRef = useRef<"project-button" | "project-list" | null>(null);
  const contextMenuFocusRef = useRef<HTMLElement | null>(null);
  // The composer's "Open another project…": where the validated folder goes,
  // and the control focus returns to when the composer does not move.
  const folderPickRef = useRef<((target: NewSessionTarget) => void) | null>(null);
  const folderReturnFocusRef = useRef<HTMLElement | null>(null);

  // Focus to settle once a change is on the page, after the control that had
  // it went away with that change (a toast's button, a delete confirmation's
  // Cancel, the folder picker). Only focus that fell to <body> moves
  // (focusIfLost): focus the user put elsewhere stays.
  const focusAfterCommitRef = useRef<(() => HTMLElement | null) | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusAfterCommit = useCallback((target: () => HTMLElement | null) => {
    focusAfterCommitRef.current = target;
    setFocusRequest((count) => count + 1);
  }, []);
  useEffect(() => {
    const target = focusAfterCommitRef.current;
    focusAfterCommitRef.current = null;
    if (target) focusIfLost(document, target());
  }, [focusRequest]);

  // Pins, archive and project order: pi-web's own state, kept on the server for every window.
  const {
    state: uiState,
    loaded: uiStateLoaded,
    synced: uiStateSynced,
    error: uiStateError,
    apply: applyUiStateRequest,
    snapshot: snapshotUiState,
    refresh: refreshUiState,
    noteRevision: noteUiRevision,
  } = useSessionUiState();

  // Pin and archive changes apply at once and are saved in the background; a
  // refused save rolls back (useSessionUiState) and says why in a toast.
  const applyUiState = useCallback(async (request: SessionUiAnyRequest) => {
    const ok = await applyUiStateRequest(request);
    if (!ok) setUiWriteFailures((count) => count + 1);
    return ok;
  }, [applyUiStateRequest]);

  // A pin is what would keep a Project the registry no longer holds on screen: an empty group of its own. The pin goes
  // with the Project, whether this window removed it or another one did — the same rule either way, applied to the
  // registry's own record rather than to the answer of one request.
  useEffect(() => {
    if (!projectsLoadedRef.current) return;
    const listed = new Set(projects.map(project => projectGroupKey(project.id)));
    for (const key of Object.keys(uiState.projects)) {
      if (!key.startsWith("/project/") || listed.has(key)) continue;
      void applyUiState({ action: "pin-project", projectKey: key, root: uiState.projects[key]?.root ?? key, pinned: false });
    }
  }, [applyUiState, projects, uiState.projects]);

  // Unread markers are part of the shared sidebar state, not browser storage: they live in the same document as the
  // pins and archive, so a marker set in one window shows in the other and survives a reload for the same reason.
  const unreadSessionIds = useMemo(() => new Set(
    Object.entries(uiState.sessions).filter(([, family]) => family.unreadAt !== undefined).map(([id]) => id),
  ), [uiState]);
  // The marker is written by the same optimistic path as a pin, so the row shows it at once and a refused write rolls
  // it back. Only the ids whose marker really differs are sent: a poll that recomputes the same set writes nothing.
  const unreadRef = useRef<ReadonlySet<string>>(unreadSessionIds);
  unreadRef.current = unreadSessionIds;
  const writeUnread = useCallback((ids: Iterable<string>, unread: boolean) => {
    const changed = [...new Set(ids)].filter((id) => unread !== unreadRef.current.has(id));
    for (const part of chunkForSessionUiRequests(changed)) void applyUiState({ action: "set-unread", ids: part, unread });
  }, [applyUiState]);

  // The explorer's scroll container is always mounted (empty without a cwd),
  // so the scrollbar hook stays bound to the element that is on the page.
  const headerRef = useRef<HTMLDivElement>(null);
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  useScrollbarVisibility(explorerScrollRef);

  // Browser storage is unavailable during server rendering. Restore the
  // sidebar preferences after hydration: read in a state initializer, a saved
  // Files tab would make the first client render differ from the server's
  // HTML (a hydration error, and the server markup thrown away).
  useEffect(() => {
    const tab = loadSidebarTab();
    if (tab !== "sessions") setSidebarTab(tab);
    const groups = loadGroupExpansion();
    if (Object.keys(groups).length > 0) setGroupExpansion(groups);
    if (loadPinnedCollapsed()) setPinnedCollapsed(true);
    forgetRetiredSidebarKeys();
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false, summary = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      // One catalogue read answers the list: the rows, the running set and the revisions beside them. The Backend
      // states them, so nothing here reconciles two reads of the same fact.
      const data = await api.list();
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setAllSessions(data.sessions);
      if (!summary) setSessionDetailsLoaded(true);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds((previous) => sameIdsOr(previous, data.runningSessionIds ?? []));
      }
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    let active = true;

    if (isFirst) {
      // Header/stat metadata is enough to select the URL session and paint the
      // sidebar. Hydrate exact counts, names, and first messages once the
      // selected chat has had a chance to start loading.
      void loadSessions(true, false, true).then(() => {
        if (!active) return;
        detailsHydrationTimerRef.current = setTimeout(() => {
          detailsHydrationTimerRef.current = null;
          if (active) void loadSessions(false, true);
        }, SESSION_DETAILS_HYDRATION_DELAY_MS);
      });
    } else {
      void loadSessions(false, true);
    }

    return () => {
      active = false;
      if (detailsHydrationTimerRef.current) {
        clearTimeout(detailsHydrationTimerRef.current);
        detailsHydrationTimerRef.current = null;
      }
    };
  }, [loadSessions, refreshKey]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const data = await api.running({ signal: current.signal });
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds((previous) => sameIdsOr(previous, data.runningSessionIds ?? []));
        // Pins and archive changed in another window: reload them.
        noteUiRevision(data.sessionUiStateRevision);
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
        // A Project changed in another window: the registry this sidebar shows and the rows that name it both follow
        // it. The first read only records the version — this window's own load already has what it says.
        if (typeof data.projectsRevision === "number" && data.projectsRevision !== projectsRevisionRef.current) {
          const known = projectsRevisionRef.current !== null;
          projectsRevisionRef.current = data.projectsRevision;
          if (known) { await listProjects(); await loadSessions(); }
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [listProjects, loadSessions, noteUiRevision]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  // The unread marker is derived from the run's own end, which the catalogue states from the run's durable receipt —
  // not from the poll's absence. Absence can only report a run the page *saw* running, so a run that started and
  // finished between two polls left nothing behind at all; the receipt says it happened whether or not anyone watched.
  // This effect still never rings, never notifies and never reports to the shell: a marker says a run ended, and how it
  // ended is the transcript's and the submission's business. Both the marker and its clearing go through the shared
  // document, so the other window's list agrees without a page reload.
  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));
    // A subagent's conversation is a task's, not the user's: it is listed and it can be running, but its completion is
    // not an event to mark as unread. The catalogue reports the creator edge, so this reads a real fact.
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const marks = advanceRunMarks(seenRunEndsRef.current, allSessions, {
      selectedSessionId,
      subagentIds: knownSubagentIds,
      // The first listing is history: every value in it is a baseline, not a run the user missed. An empty listing is
      // not that first listing, so the seed waits for one that has something in it.
      seeding: !runMarksSeededRef.current,
    });
    seenRunEndsRef.current = marks.seen;
    if (allSessions.length > 0) runMarksSeededRef.current = true;
    if (marks.completed.length > 0) {
      // Only a marker is written here, and running is deliberately not a reason to remove one. The rule reads the run's
      // own end, and this window has now consumed it: a conversation that answered and then started a queued follow-up
      // is still running, so clearing it here would throw away the only statement of that answer — the receipt has
      // already been recorded and cannot be re-derived. A marker therefore leaves only when the user reads the
      // conversation, or marks it read, or archives or deletes it. The row shows running ahead of unread meanwhile, so
      // work in flight is never hidden behind a badge.
      writeUnread(marks.completed, true);
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (newlyRunning.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, writeUnread]);

  // The session that is open is read: its marker is cleared in the shared state rather than only on screen. The
  // effect also watches the marker set, so a marker that arrives on the open session later — an Undo restoring an
  // archived family, or another window marking it — is cleared too, and a write that changes nothing sends nothing.
  useEffect(() => {
    if (!selectedSessionId) return;
    writeUnread([selectedSessionId], false);
  }, [selectedSessionId, unreadSessionIds, writeUnread]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  const projectSelection = useCallback((root: string, key: string, displayRoot?: string, retained = false): ProjectSelection => ({
    root,
    key,
    // No reported folder: the routing root is the only path known for this selection, and it is what is shown.
    displayRoot: displayRoot ?? root,
    ...(retained ? { retained: true } : {}),
  }), []);

  /** Resolve the routing root, the folder to show and the stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key, validatedProject.displayRoot, validatedProject.retained === true);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey, worktreeState.projectDisplayRoot);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => worktreeCwd(w) === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey, worktreeState.projectDisplayRoot);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    if (match) return projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match), match.projectDisplayRoot, match.workspaceRetained === true);
    // A folder of a recorded project belongs to that project even before it has a session: its identity is the
    // project's group and its root the project's default folder, never the folder itself.
    const group = projectGroupOfPath(projects, cwd);
    return group === null ? projectSelection(cwd, cwd) : projectSelection(group.defaultCwd, group.key, group.displayRoot, group.retained);
  }, [validatedProject, worktreeState, allSessions, projects, projectSelection]);

  // The project of the sidebar's cwd: the files tab shows it, and its group in
  // the sessions tab exists even before it has a session.
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);

  // A worktree or session read can resolve which project this folder belongs to without the folder changing. That is
  // identity, not a choice: the selection is told the key the memories and the same-project checks are stated in, and it
  // moves nothing, remounts nothing and rewrites no URL. The last value is kept here so an unchanged answer is not sent
  // again.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    if (selectedCwd === null) return;
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    selection.acceptWorkspaceIdentity({
      cwd: selectedCwd,
      projectKey: project?.key ?? null,
      projectRoot: project?.root ?? null,
      displayRoot: project?.displayRoot ?? null,
    });
  }, [selectedCwd, projectFor, selection]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    // The worktree list belongs to a workspace. A cwd that names none — the cwd of a conversation with no execution
    // workspace — has no project to ask about, so the sidebar reports none instead of asking the workspace API.
    if (!selectedCwd || !isWorkspaceRoutingPath(selectedCwd)) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    // The workspace id the cwd names is what the Backend's worktree operation is addressed by: the host's own
    // `POST /api/worktrees` surface, never a cwd the retired BFF resolved to one.
    const workspaceId = workspaceIdOfRoutingPath(selectedCwd);
    if (workspaceId === null) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    // The cwd's identity comes from the same two listings the Backend publishes — the Project group it belongs to, or
    // its own root as its host reported it — so the project box cannot report a different project than the folder.
    const identity = workspaceIdentity(workspaces, projects, selectedCwd);
    workspaceApi.listWorktrees(workspaceId)
      .then((listing) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: identity.root,
          ...(identity.displayRoot === identity.root ? {} : { projectDisplayRoot: identity.displayRoot }),
          projectKey: identity.key,
          isGit: listing.isGit,
          isTopLevel: listing.isTopLevel,
          currentWorktreePath: listing.currentWorktreePath,
          worktrees: listing.worktrees,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        // A host that cannot serve worktrees answers a named limit with the identity it could still resolve: the
        // project and worktree boxes keep working, and the limit is shown where the list would be.
        const limit = error instanceof WorkspaceRefusal && error.code !== undefined && WORKTREE_LIMIT_CODES.has(error.code) ? error.message : null;
        if (limit === null) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: identity.root,
          ...(identity.displayRoot === identity.root ? {} : { projectDisplayRoot: identity.displayRoot }),
          projectKey: identity.key,
          isGit: false,
          isTopLevel: false,
          currentWorktreePath: null,
          worktrees: [],
          limit,
        });
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey, workspaceApi, workspaces, projects]);


  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktreeCwd(worktree) === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  // `purpose`: who asked, the folder picker's opener by default ("Use default directory" names its own).
  const commitCustomPath = useCallback(async (candidate?: string, { remember = true, purpose = customPathOpen } = {}) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await connection.client.request("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        displayRoot?: string;
        retained?: boolean;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (remember) {
        saveLastCustomCwd(data.cwd);
        setCustomPathValue(data.cwd);
      }
      setCustomPathOpen(false);
      if (purpose === "new-session") {
        // The composer's bar asked: the shell decides whether its fresh
        // composer moves there, and the sidebar's cwd moves only with it.
        const pick = folderPickRef.current;
        const opener = folderReturnFocusRef.current;
        folderPickRef.current = null;
        folderReturnFocusRef.current = null;
        pick?.({ cwd: data.cwd, projectKey: data.projectKey, projectRoot: data.projectRoot, ...(data.displayRoot === undefined ? {} : { projectDisplayRoot: data.displayRoot }) });
        // Not moved (the folder in use): the bar's control takes focus back.
        focusAfterCommit(() => (opener?.isConnected ? opener : null));
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
        ...(data.displayRoot === undefined ? {} : { displayRoot: data.displayRoot }),
        ...(data.retained === true ? { retained: true } : {}),
      });
      // A validated folder is a workspace the reader chose: the selection carries out the move, and this panel only
      // reports what it resolved.
      selection.selectWorkspace({
        cwd: data.cwd,
        projectKey: data.projectKey,
        projectRoot: data.projectRoot,
        displayRoot: data.displayRoot ?? null,
      });
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathOpen, customPathValue, customPathValidating, focusAfterCommit, selection]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen("files");
    setCustomPathError(null);
  }, []);
  const handleDefaultCwd = useCallback(async (purpose: "files" | "new-session" = "files") => {
    // "Use default directory" is the deployment's own configured workspace, derived from the two listings this sidebar
    // already read rather than asked of a route of its own. It is selected like any other directory, so validation,
    // project identity and the file allow-list all go through the same resolution. It is not a path the user typed, so
    // the custom-path picker does not remember it.
    const cwd = configuredDefaultCwd(workspaces, projects);
    if (cwd !== "") await commitCustomPath(cwd, { remember: false, purpose });
  }, [commitCustomPath, workspaces, projects]);
  // The composer's bar asks through the handle, which is made once.
  const handleDefaultCwdRef = useRef(handleDefaultCwd);
  handleDefaultCwdRef.current = handleDefaultCwd;

  // Both pickers create through here: the worktree is listed at once, so
  // projectFor() keeps it in the project before the refetch lands, and
  // listed even when nobody moves there. The picker moves there itself.
  const createWorktree = useCallback(async (project: ProjectChoice, branch: string): Promise<CreatedWorktree | { error: string }> => {
    // The operation is addressed by the workspace the project is, which the Backend's own route resolves to the host
    // that holds the project's folders; the cwd is the routing path that names it.
    const workspaceId = workspaceIdOfRoutingPath(project.root);
    if (workspaceId === null) return { error: t("sidebar.worktreeNotRecorded") };
    try {
      const created: CreatedWorktree = await workspaceApi.createWorktree(workspaceId, branch);
      setWorktreeState((prev) => (prev && prev.projectKey === project.key && !prev.worktrees.some((worktree) => worktree.path === created.path)
        ? { ...prev, worktrees: [...prev.worktrees, { path: created.path, branch: created.branch ?? branch, isMain: false, ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }) }] }
        : prev));
      setWtRefreshKey((k) => k + 1);
      return created;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [workspaceApi, t]);

  // The files tab's remove button. A checkout with changes answers "dirty",
  // and the picker asks before retrying with force.
  const handleRemoveWorktree = useCallback(async (project: ProjectChoice, path: string, force: boolean): Promise<WorktreeRemoval> => {
    const workspaceId = workspaceIdOfRoutingPath(project.root);
    if (workspaceId === null) return { error: t("sidebar.worktreeNotRecorded") };
    try {
      await workspaceApi.removeWorktree(workspaceId, path, force);
      // The checkout is gone, so the folder record that made it a target went with it: the project's own list is
      // refetched as well as the worktrees, and a composer that was in that checkout falls back to the project root.
      // A composer that was in the removed checkout falls back to the project's own root.
      if (currentWorktreePath === path) {
        selection.selectWorkspace({ cwd: project.root, projectKey: project.key, projectRoot: project.root, displayRoot: project.displayRoot ?? null });
      }
      setWorktreeState((prev) => (prev === null ? prev : { ...prev, worktrees: prev.worktrees.filter((worktree) => worktree.path !== path) }));
      void listProjects();
      setWtRefreshKey((k) => k + 1);
      return "removed";
    } catch (e) {
      // Git's own refusal of a checkout that holds uncommitted work: the picker asks before retrying with force.
      if (e instanceof WorkspaceRefusal && e.dirty && !force) return "dirty";
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [currentWorktreePath, workspaceApi, t, listProjects, selection]);

  const refreshWorktrees = useCallback(() => setWtRefreshKey((k) => k + 1), []);

  // The files tab's picks choose a workspace, with the identity the picker read from the project list or the worktree
  // listing: a pinned project without sessions keeps its server key.
  const handleFilesPick = useCallback(({ cwd, projectKey, projectRoot, projectDisplayRoot }: NewSessionTarget) => {
    if (projectKey && projectRoot) setValidatedProject({ cwd, root: projectRoot, key: projectKey, ...(projectDisplayRoot === undefined ? {} : { displayRoot: projectDisplayRoot }) });
    selection.selectWorkspace({
      cwd,
      projectKey: projectKey ?? null,
      projectRoot: projectRoot ?? null,
      displayRoot: projectDisplayRoot ?? null,
    });
  }, [selection]);

  // Clicking a session opens it: the selection owns the target, so this is the intent and nothing else. The row is added
  // to this list when a fork's answer named one the listing has not carried yet, so the tree it belongs to shows it.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number, options?: SelectConversationOptions) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    selection.selectConversation(s, {
      ...(entryId === undefined ? {} : { entryId }),
      ...(blockIndex === undefined ? {} : { blockIndex }),
      ...(options?.rawHistory === true ? { rawHistory: true } : {}),
      ...(options?.keepSidebarOpen === true ? { keepSidebarOpen: true } : {}),
    });
  }, [selection]);

  // Every "new session" goes through here: a fresh composer in the target, with the target's project so a session in
  // another project is not mistaken for identity hydration.
  const startNewSessionIn = useCallback(({ cwd, projectKey, projectRoot, projectDisplayRoot, carryComposer }: NewSessionTarget) => {
    // A worktree without sessions has no other source of identity yet.
    if (projectKey && projectRoot) setValidatedProject({ cwd, root: projectRoot, key: projectKey, ...(projectDisplayRoot === undefined ? {} : { displayRoot: projectDisplayRoot }) });
    selection.startComposer({
      cwd,
      projectKey: projectKey ?? null,
      projectRoot: projectRoot ?? null,
      displayRoot: projectDisplayRoot ?? null,
    }, carryComposer === true ? { carry: true } : undefined);
  }, [selection]);
  // The handle below is made once: it calls the newest closure.
  const startNewSessionInRef = useRef(startNewSessionIn);
  startNewSessionInRef.current = startNewSessionIn;

  useImperativeHandle(controlRef, () => ({
    openFolderForNewSession: (onPicked, returnFocusTo) => {
      folderPickRef.current = onPicked;
      folderReturnFocusRef.current = returnFocusTo;
      setCustomPathError(null);
      setCustomPathOpen("new-session");
    },
    openDefaultDirectoryForNewSession: (onPicked) => {
      folderPickRef.current = onPicked;
      folderReturnFocusRef.current = null;
      void handleDefaultCwdRef.current("new-session");
    },
    refreshWorktrees,
    createWorktree,
  }), [createWorktree, refreshWorktrees]);

  // Header "+": a new session in the sidebar's current cwd (worktree). A recorded project's folder redirects to the
  // project's default folder, so every new-session affordance of that project binds the same one workspace.
  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    const group = projectGroupOfPath(projects, selectedCwd);
    startNewSessionIn(group === null
      ? { cwd: selectedCwd }
      : { cwd: group.defaultCwd, projectKey: group.key, projectRoot: group.defaultCwd, projectDisplayRoot: group.displayRoot });
  }, [projects, selectedCwd, startNewSessionIn]);

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);

  const sessionFamilies = useMemo(() => listSessionFamilies(allSessions), [allSessions]);
  const familyByRootId = useMemo(
    () => new Map(sessionFamilies.map((family) => [family.root.id, family])),
    [sessionFamilies],
  );

  // Every session id of an archived family (search tags them), and how many
  // families each project has in the archive.
  const archiveIndex = useMemo(() => {
    const ids = new Set<string>();
    const countByProject = new Map<string, number>();
    for (const family of sessionFamilies) {
      if (!isFamilyArchived(family, uiState, runningSessionIds)) continue;
      for (const id of familyIds(family)) ids.add(id);
      const key = workspaceKeyOf(family.root);
      countByProject.set(key, (countByProject.get(key) ?? 0) + 1);
    }
    return { ids, countByProject };
  }, [sessionFamilies, uiState, runningSessionIds]);

  // Per-project activity counts (running / unread) for the files tab's project menu.
  // Uses the same stable server key as the project list and filtering. An
  // archived family is out of sight, so it does not count as activity.
  const projectActivity = useMemo(
    () => getProjectActivity(
      archiveIndex.ids.size === 0 ? allSessions : allSessions.filter((session) => !archiveIndex.ids.has(session.id)),
      runningSessionIds,
      unreadSessionIds,
    ),
    [allSessions, archiveIndex, runningSessionIds, unreadSessionIds],
  );

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.limit !== undefined
      ? {
           label: t("sidebar.worktreeHostLimit"),
           title: t("sidebar.worktreeHostLimitTitle", { reason: worktreeState.limit }),
        }
      : worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // The tree of every project. Its group for the current project exists even
  // without sessions (a fresh custom path, a new worktree).
  const currentProjectKey = selectedProject?.key ?? null;
  const currentProjectRoot = selectedProject?.root ?? null;
  const currentProjectDisplayRoot = selectedProject?.displayRoot ?? null;
  const currentProject = useMemo(
    () => (currentProjectKey && currentProjectRoot ? { key: currentProjectKey, root: currentProjectRoot, ...(currentProjectDisplayRoot === null ? {} : { displayRoot: currentProjectDisplayRoot }) } : null),
    [currentProjectKey, currentProjectRoot, currentProjectDisplayRoot],
  );
  const model = useMemo(() => buildSessionTree({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
    currentProject,
    groupExpansion,
    moreShown,
    pinnedCollapsed,
    recordedProjects,
  }), [allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId, currentProject, groupExpansion, moreShown, pinnedCollapsed, recordedProjects]);
  const archiveRows = useMemo(() => (archiveView ? buildArchiveRows({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
    currentProject,
    recordedProjects,
  }) : []), [archiveView, allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId, currentProject, recordedProjects]);
  const projectByKey = useMemo(
    () => new Map(model.projects.map((project) => [project.key, project])),
    [model.projects],
  );

  // The project order is saved as projects turn up: a project without a place
  // renders at the top of its band, and saving it puts it at the top of the
  // list, so nothing moves on screen; from then on only a drag or Move up/down
  // moves it. The first save (an empty order) records the activity order the
  // user sees. It waits for real server state (a failed GET leaves the local
  // state empty: archived projects would count as live) and for the session
  // details (the summary rows' times are file mtimes). When more keys wait
  // than one request holds, the bottom ones go first
  // (nextProjectKeysToRecord): a batch never lands below keys still unsaved.
  // Each key is sent once per page: a refused save is not retried in a loop,
  // and keys that do not fit a full list are not sent again and again. A
  // background save fails quietly (the raw apply, no toast).
  const recordedOrderKeysRef = useRef(new Set<string>());
  const projectKeysToRecord = model.projectKeysToRecord;
  const storedOrderLength = uiState.projectOrder?.length ?? 0;
  useEffect(() => {
    if (loading || !uiStateSynced || !sessionDetailsLoaded) return;
    if (storedOrderLength >= MAX_PROJECT_ORDER_KEYS) return;
    const recorded = recordedOrderKeysRef.current;
    const keys = nextProjectKeysToRecord(projectKeysToRecord, recorded, MAX_SESSION_UI_IDS_PER_REQUEST);
    if (keys.length === 0) return;
    for (const key of keys) recorded.add(key);
    void applyUiStateRequest({ action: "add-projects", keys });
  }, [applyUiStateRequest, loading, projectKeysToRecord, sessionDetailsLoaded, storedOrderLength, uiStateSynced]);

  // Every project in the groups' order, then those with sessions but no
  // group (all of them archived, or pinned while the project is not): the
  // project menus of the files tab and of the bar above a fresh composer.
  // Every project the sidebar knows — a recorded project with the name it was given and its default folder as root —
  // then those with sessions but no group. A project's folders are one entry here too: the picker offers projects.
  // A folder a Project removal retained is left out: its conversations keep their group and keep running, and the
  // picker that offers a target for a *new* conversation never offers the removed folder back (spec decisions 22, 23).
  const projectChoiceList = useMemo(
    () => mergeProjectChoices(
      model.projects.filter((project) => !project.retained).map((project) => ({ key: project.key, root: project.root, displayRoot: project.displayRoot, name: project.name })),
      recentProjects,
    ),
    [model.projects, recentProjects],
  );

  // What both pickers show for this cwd: the project, its worktrees where the
  // files tab offers them (the top of a git checkout), every project. The
  // tree is rebuilt on every refresh and running poll; the bar above a fresh
  // composer hears of it only when something it shows changed.
  const newSessionContext = useMemo<NewSessionContext | null>(() => {
    if (!selectedCwd || !selectedProject) return null;
    const listed = showWorktreeSwitcher && worktreeState !== null;
    return {
      cwd: selectedCwd,
      // The project's routing root is what a pick carries; the folder it *is* is what the bar shows. A folder a
      // Project removal retained says so, so the bar's picker neither offers it nor re-adds it as the current choice.
      project: { key: selectedProject.key, root: selectedProject.root, displayRoot: selectedProject.displayRoot, ...(selectedProject.retained ? { retained: true as const } : {}) },
      worktrees: listed ? worktreeState.worktrees.map(({ path, branch, isMain, workspaceId }) => ({ path, branch, isMain, ...(workspaceId === undefined ? {} : { workspaceId }) })) : null,
      currentWorktreePath: listed ? currentWorktreePath : null,
      projects: projectChoiceList,
    };
  }, [selectedCwd, selectedProject, showWorktreeSwitcher, worktreeState, currentWorktreePath, projectChoiceList]);
  // The project and worktrees of the workspace in effect are published to the selection, which is what the bar above a
  // fresh composer reads. One report for the two surfaces that show it, and no shell in between.
  const newSessionContextSignature = newSessionContextKey(newSessionContext);
  useEffect(() => {
    selection.setWorkspaceContext(newSessionContext);
  }, [newSessionContextSignature, newSessionContext, selection]);

  // Picking a session in another group makes its project current. The group
  // that was current keeps its look instead of folding up under the pointer
  // (keepOutgoingGroupOpen), before the browser paints the change.
  const previousCurrentProjectKeyRef = useRef(currentProjectKey);
  useLayoutEffect(() => {
    const previous = previousCurrentProjectKeyRef.current;
    previousCurrentProjectKeyRef.current = currentProjectKey;
    if (previous === null || previous === currentProjectKey) return;
    const next = keepOutgoingGroupOpen(groupExpansion, projectByKey.get(previous));
    if (next === groupExpansion) return;
    setGroupExpansion(next);
    saveGroupExpansion(next);
  }, [currentProjectKey, groupExpansion, projectByKey]);

  const showToast = useCallback((message: string, actions: SidebarToastAction[] = [], tail?: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message, ...(tail ? { tail } : {}), actions });
  }, []);

  /** The selected tab: focus has somewhere to go when the control it was on is gone. */
  const selectedTabButton = useCallback(
    () => (sessionsPanelRef.current?.hidden ? filesTabRef : sessionsTabRef).current,
    [],
  );

  // A family's row where the tree shows it now (pinned, in its group, or in
  // the open archive view), else the selected tab.
  const familyRowButton = useCallback((rootId: string): HTMLElement | null => {
    const panel = sessionsPanelRef.current;
    for (const context of ["pinned", "group", "archive"]) {
      const key = CSS.escape(`session:${context}:${rootId}`);
      const button = panel?.querySelector<HTMLElement>(`[data-row-key="${key}"] .session-tree-main`);
      if (button && button.getClientRects().length > 0) return button;
    }
    return selectedTabButton();
  }, [selectedTabButton]);

  // A refused pin, archive or marker is rolled back, and the reason is shown once per failure.
  useEffect(() => {
    if (uiWriteFailures === shownUiWriteFailuresRef.current) return;
    shownUiWriteFailuresRef.current = uiWriteFailures;
    showToast(t("sidebar.uiStateFailed", { error: uiStateError ?? "" }));
  }, [uiWriteFailures, uiStateError, showToast, t]);

  // A drop, or Move up/down: the project goes next to another of its band.
  // Its band's projects without a place are saved first, top to bottom, so
  // it lands where the user saw it; past one request's worth (a full list, a
  // move before the first save), the bottom ones, which land where they
  // show. The moved group is then scrolled into view (a drop past a tall
  // group, a keyboard move); kept mounted until then, it is still there for
  // the menu to give focus back to.
  const moveProject = useCallback((projectKey: string, anchorKey: string, position: ProjectMovePosition) => {
    const project = projectByKey.get(projectKey);
    const anchor = projectByKey.get(anchorKey);
    // Pinned or unpinned in another window meanwhile: a move never crosses bands.
    if (!project || !anchor || project === anchor || project.pinned !== anchor.pinned) return;
    const add = model.unorderedKeysByBand[project.pinned ? "pinned" : "other"].slice(-MAX_SESSION_UI_IDS_PER_REQUEST);
    void applyUiState({ action: "move-project", projectKey, anchorKey, position, add });
    treeRevealIdRef.current += 1;
    setTreeReveal({ id: treeRevealIdRef.current, at: Date.now(), rowKey: `group:${projectKey}` });
  }, [applyUiState, model.unorderedKeysByBand, projectByKey]);

  const switchTab = useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    saveSidebarTab(tab);
  }, []);

  // A hidden panel is display: none, and browsers do not reliably keep the
  // scroll position of what it holds. Positions are noted as the user
  // scrolls and put back when the panel (or the tree under the archive
  // view) shows again; SessionTree then re-reads its window from them.
  const rememberScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element) panelScrollTopsRef.current.set(target, target.scrollTop);
  }, []);
  useLayoutEffect(() => {
    const panel = (sidebarTab === "sessions" ? sessionsPanelRef : filesPanelRef).current;
    if (!panel) return;
    for (const element of panel.querySelectorAll<HTMLElement>(".session-tree-scroll, .sidebar-files-scroll")) {
      const saved = panelScrollTopsRef.current.get(element);
      if (saved !== undefined && element.scrollTop !== saved) element.scrollTop = saved;
    }
  }, [sidebarTab, archiveView]);

  const openArchiveView = useCallback(() => {
    setMenu(null);
    setArchiveView(true);
    // Search results would cover it.
    setSessionSearchOpen(false);
    switchTab("sessions");
  }, [switchTab]);

  // Opening the archive hides the tree that held focus (the footer link, a
  // menu's opener, the toast's View) and Back removes the archive's own
  // controls. Focus that went with them moves to the archive's Back button,
  // then back to the footer link, or to the tab when that row is not shown.
  const archiveBackRef = useRef<HTMLButtonElement>(null);
  const previousArchiveViewRef = useRef(archiveView);
  // Where closing the archive put focus: a fork opened from the archive
  // reveals its row and may take focus from there.
  const archiveCloseFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (previousArchiveViewRef.current === archiveView) return;
    previousArchiveViewRef.current = archiveView;
    if (archiveView) {
      focusIfHidden(archiveBackRef.current);
      return;
    }
    const footer = sessionsPanelRef.current?.querySelector<HTMLElement>('[data-row-key="footer-archived"] button');
    const target = footer && footer.getClientRects().length > 0 ? footer : selectedTabButton();
    focusIfHidden(target);
    if (target && document.activeElement === target) archiveCloseFocusRef.current = target;
  }, [archiveView, selectedTabButton]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: SidebarTab = event.key === "Home" ? "sessions"
      : event.key === "End" ? "files"
      : sidebarTab === "sessions" ? "files" : "sessions";
    switchTab(next);
    (next === "sessions" ? sessionsTabRef : filesTabRef).current?.focus();
  };

  // A session family's pin and archive flags live on its root session.
  const setFamilyPinned = useCallback((family: SessionFamily, pinned: boolean) => {
    void applyUiState({ action: "set", ids: [family.root.id], pinned });
  }, [applyUiState]);

  // Read means read for the whole family, and unread only ever marks its root: a subagent's completion is silent.
  const markFamilyRead = useCallback((family: SessionFamily, read: boolean) => {
    writeUnread(read ? familyIds(family) : [family.root.id], !read);
  }, [writeUnread]);

  const archiveFamilies = useCallback((families: readonly SessionFamily[]) => {
    const archivable = families.filter((family) => !family.root.transient);
    if (archivable.length === 0) return;
    // The undo snapshot carries every flag of each family, so archiving (which clears the unread marker as part of the
    // same write) and its Undo are each one action, and a refused part rolls back to exactly what it was.
    const snapshot = snapshotUiState(archivable.map((family) => family.root.id));
    // A request carries at most MAX_SESSION_UI_IDS_PER_REQUEST families, so a
    // big "Archive sessions older than 7 days" goes in parts; the write queue
    // of useSessionUiState keeps them, and an Undo after them, in order.
    for (const part of chunkForSessionUiRequests(archivable)) {
      const ids = part.map((family) => family.root.id);
      void applyUiState({ action: "set", ids, archived: true });
    }
    const message = archivable.length === 1
      ? t("sidebar.archivedToast", { title: shortTitle(sessionRowTitle(archivable[0].root), TOAST_TITLE_MAX) })
      : t("sidebar.archivedManyToast", { count: archivable.length });
    showToast(message, [
      {
        id: "undo",
        label: t("sidebar.undo"),
        onClick: () => {
          for (const entries of chunkForSessionUiRequests(snapshot)) {
            void applyUiState({ action: "restore", entries });
          }
          // The toast held focus; the first family back in the tree takes it.
          focusAfterCommit(() => familyRowButton(archivable[0].root.id));
        },
      },
      { id: "view", label: t("sidebar.viewArchive"), onClick: openArchiveView },
    ]);
  }, [applyUiState, focusAfterCommit, familyRowButton, openArchiveView, showToast, snapshotUiState, t]);

  // The row's archive button. A running family would come straight back, so
  // it is not archived (the row offers no button for it either).
  const archiveFamily = useCallback((family: SessionFamily) => {
    if (familyIds(family).some((id) => runningSessionIds.has(id))) return;
    archiveFamilies([family]);
  }, [archiveFamilies, runningSessionIds]);

  const restoreFamily = useCallback((family: SessionFamily) => {
    const ids = [family.root.id];
    const snapshot = snapshotUiState(ids);
    void applyUiState({ action: "set", ids, archived: false });
    showToast(t("sidebar.restoredToast", { title: shortTitle(sessionRowTitle(family.root), TOAST_TITLE_MAX) }), [
      {
        id: "undo",
        label: t("sidebar.undo"),
        onClick: () => {
          void applyUiState({ action: "restore", entries: snapshot });
          // Back in the archive view if it is open; else the tab takes focus.
          focusAfterCommit(() => familyRowButton(family.root.id));
        },
      },
    ]);
  }, [applyUiState, familyRowButton, focusAfterCommit, showToast, snapshotUiState, t]);

  const startRename = useCallback((family: SessionFamily) => {
    if (family.root.transient) return;
    setConfirmDeleteRootId(null);
    setRenamingRootId(family.root.id);
  }, []);

  const commitRename = useCallback(async (family: SessionFamily, renameValue: string) => {
    const session = family.root;
    const title = sessionRowTitle(session);
    const name = renameValue.trim();
    setRenamingRootId((current) => (current === session.id ? null : current));
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed first message, so an untouched rename of a
    // skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      // A refused rename leaves the row showing the name it had and says why, rather than looking applied.
      const renamed = await api.control(session.id).rename(name);
      if (!renamed.ok) {
        showToast(t("sidebar.renameFailed", { error: operationFailure(renamed).message }));
        return;
      }
      // The name the backend now holds is the row's own: the sidebar and the catalogue the shell reads both take it
      // from this one list, so the change is visible without a reload and without a second round trip.
      setAllSessions((current) => current.map((item) => (item.id === session.id ? { ...item, name } : item)));
    } catch (error) {
      showToast(t("sidebar.renameFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [showToast, t]);

  // Delete: the backend removes the session from the catalogue by writing a hepi tombstone, and clears the
  // session's pin, archive and unread entries in the same commit. The row goes without a page reload, the sidebar
  // state is re-read so no orphan entry is left showing, and a refusal says what failed and leaves the row where it
  // is. Nothing here states or implies that the removal is not permanent: it is an ordinary removal.
  const performDelete = useCallback(async (family: SessionFamily) => {
    const session = family.root;
    if (session.transient) return;
    setConfirmDeleteRootId((current) => (current === session.id ? null : current));
    try {
      const removed = await api.control(session.id).remove();
      if (!removed.ok) {
        showToast(t("sidebar.deleteFailed", { error: operationFailure(removed).message }));
        // A session the Backend no longer lists is gone whatever this answer said: the list is the truth.
        if (removed.kind === "refused" && removed.status === 404) void loadSessions();
        return;
      }
      // The row leaves at once, and the shared state is re-read because the removal cleared this session's entries.
      setAllSessions((current) => current.filter((item) => item.id !== session.id));
      void refreshUiState();
      // The removal is the selection's to hear: it leaves only the conversation it was showing, and every other
      // conversation — and every draft — keeps its place.
      selection.conversationDeleted(session.id);
      void loadSessions();
    } catch (error) {
      showToast(t("sidebar.deleteFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [loadSessions, refreshUiState, selection, showToast, t]);

  // Only Shift skips the confirmation (Shift+click, Shift+Enter or Shift+D in the menu).
  const requestDelete = useCallback((family: SessionFamily, shiftKey: boolean) => {
    if (shiftKey) {
      void performDelete(family);
    } else {
      setRenamingRootId(null);
      setConfirmDeleteRootId(family.root.id);
    }
  }, [performDelete]);

  // Fork (the row menu's F): the server copies the family's current branch
  // into a new session beside it (POST /api/sessions/[id]/fork) and leaves
  // the source as it is, running or not. The copy opens where its row is: the
  // archive view closes (the copy has no pin or archive flag), a group the
  // user collapsed opens, and the main tree scrolls to the row, which takes
  // focus when it is still on the source's row (or fell to the page). Called
  // after a request and from a toast, so always through openForkedRef: the
  // newest state and AppShell's newest selection handler, never a click-time
  // closure. `fromRowKey` is the row whose Fork this answers: focus may move
  // from it, and a phone's drawer stays open, since the copy looks just like
  // its source and only the sidebar (its row, the toast) tells them apart.
  // null is the toast's Open, which opens the copy as a row click does.
  const openForked = (forked: SessionInfo, fromRowKey: string | null) => {
    archiveCloseFocusRef.current = null;
    if (archiveView) {
      // The main tree's saved position would be put back over the reveal.
      const main = sessionsPanelRef.current?.querySelector(".sidebar-sessions-view .session-tree-scroll");
      if (main) panelScrollTopsRef.current.delete(main);
      setArchiveView(false);
    }
    const groupKey = workspaceKeyOf(forked);
    if (Object.hasOwn(groupExpansion, groupKey) && groupExpansion[groupKey] === false) {
      const next = { ...groupExpansion };
      // Re-inserted, so the choice counts as the newest one kept.
      delete next[groupKey];
      next[groupKey] = true;
      setGroupExpansion(next);
      saveGroupExpansion(next);
    }
    handleSelectSessionFromList(forked, undefined, undefined, { keepSidebarOpen: fromRowKey !== null });
    // The route invalidated the list: the next load has the copy.
    void loadSessions();
    const fromRow = fromRowKey ? `[data-row-key="${CSS.escape(fromRowKey)}"]` : null;
    treeRevealIdRef.current += 1;
    setTreeReveal({
      id: treeRevealIdRef.current,
      at: Date.now(),
      rowKey: `session:group:${forked.id}`,
      takeFocusFrom: (active) => (fromRow !== null && active.closest(fromRow) !== null) || active === archiveCloseFocusRef.current,
    });
  };
  const openForkedRef = useRef(openForked);
  openForkedRef.current = openForked;

  // One fork per session at a time: F again on a session whose fork is under
  // way does nothing; another session's Fork goes ahead.
  const forkingIdsRef = useRef(new Set<string>());
  // The identity of a fork whose **answer** this page never received. The backend answers a repeated request identity
  // with the branch the first attempt created, so a retry after a dropped response returns the branch that really
  // exists instead of making a second one. The identity is kept until a fork is answered — a failure leaves it in
  // place for exactly that retry — and it is per source session, so two sessions' forks never share one.
  const pendingForkIdsRef = useRef(new Map<string, string>());
  const forkFamily = useCallback(async (row: SessionRow) => {
    const source = row.family.root;
    if (source.transient || forkingIdsRef.current.has(source.id)) return;
    forkingIdsRef.current.add(source.id);
    const selectedAtClick = selectedSessionIdRef.current;
    const requestId = pendingForkIdsRef.current.get(source.id) ?? createRequestId();
    pendingForkIdsRef.current.set(source.id, requestId);
    try {
      const answered = await api.control(source.id).fork({ requestId });
      if (!answered.ok) {
        const refusal = operationFailure(answered);
        const { key, params } = forkFailureMessage(refusal.code, refusal.message);
        showToast(t(key, params));
        // Deleted elsewhere (the pi CLI, another window): its row goes.
        if (refusal.code === "not_found") void loadSessions();
        return;
      }
      // The branch's identity and its catalogue row, as the Backend stated them, so the sidebar opens the copy without
      // a second list read that would have to race it.
      const forked = catalogueRow(answered.value.conversation as CatalogueEntry);
      // The answer arrived, so the identity has done its work: the next Fork of this session is a new branch.
      pendingForkIdsRef.current.delete(source.id);
      // The copy's name ends in the suffix that tells it from its source: the
      // toast's ellipsis cuts the name before it, never the suffix. A copy
      // left unnamed (its source had no title) is cut as other toasts are.
      const title = sessionRowTitle(forked);
      const { head: message, tail } = splitBeforeForkSuffix(t("sidebar.forkedToast", { title }), title)
        ?? { head: t("sidebar.forkedToast", { title: shortTitle(title, TOAST_TITLE_MAX) }), tail: undefined };
      if (selectedSessionIdRef.current !== selectedAtClick) {
        // Another session was opened meanwhile: the user stays there. The
        // copy waits in its group, unread (so it shows beyond the group's
        // limit), and the toast offers to open it.
        setAllSessions((current) => (current.some((session) => session.id === forked.id) ? current : [forked, ...current]));
        writeUnread([forked.id], true);
        void loadSessions();
        showToast(message, [{ id: "open", label: t("sidebar.open"), onClick: () => openForkedRef.current(forked, null) }], tail);
        return;
      }
      openForkedRef.current(forked, row.key);
      showToast(message, [], tail);
    } catch (error) {
      showToast(t("sidebar.forkFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      forkingIdsRef.current.delete(source.id);
    }
  }, [loadSessions, showToast, t]);

  const runSessionAction = (id: SessionMenuActionId, row: SessionRow, shiftKey: boolean) => {
    const { family } = row;
    switch (id) {
      case "pin": setFamilyPinned(family, true); break;
      case "unpin": setFamilyPinned(family, false); break;
      case "rename": startRename(family); break;
      case "fork": void forkFamily(row); break;
      case "mark-read": markFamilyRead(family, true); break;
      case "mark-unread": markFamilyRead(family, false); break;
      case "archive": archiveFamily(family); break;
      case "unarchive": restoreFamily(family); break;
      case "delete": requestDelete(family, shiftKey); break;
    }
  };

  const openRowMenu = useCallback((row: SessionRow, anchor: SidebarMenuAnchor, opener: HTMLElement | null) => {
    if (row.status.transient) return;
    setMenu({ kind: "row", row, anchor, opener });
  }, []);

  // Right-click: an extension listening for the downstream event (a pi-web
  // integration) claims the row first; only an unclaimed event opens the
  // built-in menu. A transient row has nothing to offer, so the browser's own
  // menu stays.
  const handleContextMenu = useCallback((row: SessionRow, event: ReactMouseEvent) => {
    const session = row.family.root;
    if (session.id === renamingRootId || session.id === confirmDeleteRootId) return;
    if (dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: event.clientX,
      clientY: event.clientY,
      refresh: () => { void loadSessions(); },
    })) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (session.transient) return;
    event.preventDefault();
    const rowElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    // The keyboard's context-menu key reports no pointer position.
    const anchor: SidebarMenuAnchor = event.clientX === 0 && event.clientY === 0 && rowElement
      ? buttonAnchor(rowElement, "start")
      : { kind: "point", x: event.clientX, y: event.clientY };
    // Focus goes back into the row it came from (the keyboard case). An
    // element elsewhere (the composer) is not made the menu's opener, whose
    // next click the menu would take as "close"; it gets focus back after.
    const active = document.activeElement;
    const inRow = active instanceof HTMLElement && rowElement !== null && rowElement.contains(active);
    contextMenuFocusRef.current = !inRow && active instanceof HTMLElement && active !== document.body ? active : null;
    openRowMenu(row, anchor, inRow ? active : null);
  }, [confirmDeleteRootId, loadSessions, openRowMenu, renamingRootId]);

  const treeSelectionInput = useMemo(() => ({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
  }), [allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId]);

  const handleGroupMenu = useCallback((project: SidebarProject, opener: HTMLElement) => {
    const olderCount = familiesToArchive(treeSelectionInput, project.key, ARCHIVE_OLDER_THAN_MS, Date.now()).length;
    setMenu({ kind: "group", project, olderCount, anchor: buttonAnchor(opener, "end"), opener });
  }, [treeSelectionInput]);

  const archiveOlderSessions = useCallback((project: SidebarProject) => {
    const ids = familiesToArchive(treeSelectionInput, project.key, ARCHIVE_OLDER_THAN_MS, Date.now());
    archiveFamilies(ids.flatMap((id) => {
      const family = familyByRootId.get(id);
      return family ? [family] : [];
    }));
  }, [archiveFamilies, familyByRootId, treeSelectionInput]);

  // A group's "+": a new session at once. The current project starts in the
  // sidebar's worktree, another one in its root (the main checkout); the bar
  // above the fresh composer picks another worktree. The group's own key and
  // root go along, so a worktree is never taken for another project, and a
  // pinned project without sessions keeps its server identity.
  // A recorded project's new session starts in its default folder, never in the extra folder the sidebar may be
  // showing: the other folders are metadata, and only the default is a new conversation's tool root.
  const handleGroupNew = useCallback((project: SidebarProject) => {
    // A folder a Project removal retained is never a target for a new conversation (spec decisions 23 and 55); its
    // control is disabled, and this is the same rule stated where the action is taken.
    if (project.retained) return;
    setMenu(null);
    startNewSessionIn({
      cwd: project.recorded || !project.current || !selectedCwd ? project.root : selectedCwd,
      projectKey: project.key,
      projectRoot: project.root,
      projectDisplayRoot: project.displayRoot,
    });
  }, [selectedCwd, startNewSessionIn]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // One Project's removal, and one folder's unlink. Both are metadata-only on the backend — no directory is touched,
  // no conversation is deleted — and the answer to each is the project list the sidebar shows and hands the picker. A
  // refusal changes nothing here and reads as the reason the backend gave. The rows are read again either way: the
  // folders a removal retained have to be marked as such, so their conversations stay listed and runnable while their
  // folders stop being a target for a new one.
  const removeRecordedProject = useCallback(async (record: ProjectRouting): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await workspaceApi.removeProject(record.id);
    } catch (error) {
      return { ok: false, message: removalRefusal(error instanceof WorkspaceRefusal ? error.status : 0, error instanceof WorkspaceRefusal ? { error: error.message } : undefined) };
    }
    setProjects(current => dropRecordedProject(current, record.id));
    await loadSessions();
    return { ok: true };
  }, [loadSessions, workspaceApi]);

  const unlinkRecordedFolder = useCallback(async (record: ProjectRouting, folderId: string, replacementFolderId?: string): Promise<{ ok: true; projectGone: boolean } | { ok: false; message: string }> => {
    let answer: FolderUnlinkAnswer;
    try {
      answer = await workspaceApi.unlinkFolder(record.id, folderId, replacementFolderId);
    } catch (error) {
      return { ok: false, message: removalRefusal(error instanceof WorkspaceRefusal ? error.status : 0, error instanceof WorkspaceRefusal ? { error: error.message } : undefined) };
    }
    setProjects(current => applyFolderUnlink(current, record.id, answer));
    await loadSessions();
    // The last folder's removal answered a project of null: the Project itself is gone, and so is its place here.
    return { ok: true, projectGone: answer.project === null };
  }, [loadSessions, workspaceApi]);

  // The removal body's steps: the folder list, a Project's confirmation, and one folder's confirmation with the
  // replacement default it may need. Each step is one body, and a refusal stays on the step that asked.
  const showRemovalStep = useCallback((step: ProjectRemovalStep) => {
    setMenu(current => (current?.kind === "group" ? { ...current, body: { step, busy: false, error: null } } : current));
  }, []);
  const setRemovalBody = useCallback((update: (body: ProjectRemovalBody) => ProjectRemovalBody) => {
    setMenu(current => (current?.kind === "group" && current.body !== undefined ? { ...current, body: update(current.body) } : current));
  }, []);

  const runProjectRemoval = useCallback(async (record: ProjectRouting) => {
    setRemovalBody(body => ({ ...body, busy: true, error: null }));
    const result = await removeRecordedProject(record);
    if (result.ok) { closeMenu(); return; }
    setRemovalBody(body => ({ ...body, busy: false, error: result.message }));
  }, [closeMenu, removeRecordedProject, setRemovalBody]);

  const runFolderUnlink = useCallback(async (record: ProjectRouting, folderId: string, replacementFolderId?: string) => {
    setRemovalBody(body => ({ ...body, busy: true, error: null }));
    const result = await unlinkRecordedFolder(record, folderId, replacementFolderId);
    if (!result.ok) { setRemovalBody(body => ({ ...body, busy: false, error: result.message })); return; }
    // The last folder took the Project with it: there is nothing left for this menu to be about.
    if (result.projectGone) { closeMenu(); return; }
    showRemovalStep({ kind: "folders" });
  }, [closeMenu, setRemovalBody, showRemovalStep, unlinkRecordedFolder]);


  // After a right-click menu, focus returns to where it was unless the chosen
  // action put it somewhere (a rename field, a delete confirmation).
  useEffect(() => {
    if (menu !== null) return;
    const previous = contextMenuFocusRef.current;
    contextMenuFocusRef.current = null;
    if (!previous?.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body) previous.focus({ preventScroll: true });
  }, [menu]);

  // A row whose menu is open can leave the tree (archived or deleted in
  // another window): its menu goes with it.
  const visibleRows = archiveView ? archiveRows : model.rows;
  useEffect(() => {
    if (menu?.kind !== "row") return;
    if (!visibleRows.some((row) => row.key === menu.row.key)) setMenu(null);
  }, [menu, visibleRows]);

  // Rows are rebuilt on every refresh; the menu acts on the current one.
  const menuRow = menu?.kind === "row"
    ? (visibleRows.find((row): row is SessionRow => row.kind === "session" && row.key === menu.row.key) ?? menu.row)
    : null;

  const handleSelectFamily = useCallback((family: SessionFamily) => {
    handleSelectSessionFromList(family.root);
  }, [handleSelectSessionFromList]);

  // Every group at once: a group's menu, or Alt+click on its header.
  // Re-inserted, so the choices count as the newest ones kept.
  const setAllGroupsExpanded = useCallback((expanded: (project: SidebarProject) => boolean) => {
    const next = { ...groupExpansion };
    for (const project of model.projects) {
      delete next[project.key];
      next[project.key] = expanded(project);
    }
    setGroupExpansion(next);
    saveGroupExpansion(next);
  }, [groupExpansion, model.projects]);

  // Expanding or collapsing a group only changes the view: it never moves the
  // cwd (picking a project does that, in the files tab). With Alt, every
  // group follows the one clicked, as in a Finder outline.
  const handleToggleGroup = useCallback((projectKey: string, all: boolean) => {
    const project = projectByKey.get(projectKey);
    if (!project) return;
    const expanded = !isGroupExpanded(project, groupExpansion);
    if (all) {
      setAllGroupsExpanded(() => expanded);
      return;
    }
    const next = { ...groupExpansion };
    // Re-inserted, so the choice counts as the newest one kept.
    delete next[projectKey];
    next[projectKey] = expanded;
    setGroupExpansion(next);
    saveGroupExpansion(next);
  }, [groupExpansion, projectByKey, setAllGroupsExpanded]);

  const handleShowMore = useCallback((key: string) => {
    setMoreShown((prev) => showMoreFamilies(prev, key));
  }, []);
  const handleShowLess = useCallback((key: string) => {
    setMoreShown((prev) => showLessFamilies(prev, key));
  }, []);

  const handleTogglePinned = () => {
    const next = !pinnedCollapsed;
    setPinnedCollapsed(next);
    savePinnedCollapsed(next);
  };

  // "Open in Files" of another project is a deliberate project switch, the
  // same as choosing it in the files tab's project list.
  const openProjectInFiles = (project: SidebarProject) => {
    if (!project.current) selection.selectWorkspace({ cwd: project.root, projectKey: project.key, projectRoot: project.root, displayRoot: project.displayRoot ?? null });
    filesTabFocusRef.current = "project-button";
    switchTab("files");
  };

  const handleOpenOtherProject = () => {
    filesTabFocusRef.current = "project-list";
    switchTab("files");
  };

  // "New Project…" records a name and one existing folder on the Web host, then starts the first conversation in it.
  const handleNewProject = useCallback((opener: HTMLElement) => {
    newProjectReturnFocusRef.current = opener;
    setNewProjectOpen(true);
  }, []);
  const handleProjectCreated = useCallback((project: CreatedProject) => {
    setNewProjectOpen(false);
    const opener = newProjectReturnFocusRef.current;
    newProjectReturnFocusRef.current = null;
    // The project's default folder is the first conversation's working location, routed as /workspace/<id> exactly as
    // a configured workspace is: the shell creates the conversation and the backend binds it to that workspace.
    const group = projectGroup(project);
    if (group !== null) startNewSessionInRef.current({ cwd: group.defaultCwd, projectKey: group.key, projectRoot: group.defaultCwd, projectDisplayRoot: group.displayRoot });
    void listProjects();
    if (opener) focusAfterCommit(() => (opener.isConnected ? opener : null));
  }, [focusAfterCommit, listProjects]);
  // Once the files tab shows, the project button takes the focus, or its
  // menu opens below it (the menu takes the focus: its filter or first project).
  useEffect(() => {
    const target = filesTabFocusRef.current;
    if (!target || sidebarTab !== "files") return;
    filesTabFocusRef.current = null;
    if (target === "project-list") filesPickerRef.current?.openMenu("project");
    else filesPickerRef.current?.button("project")?.focus({ preventScroll: true });
  }, [sidebarTab]);

  const sessionMenuItems = (row: SessionRow): SidebarMenuItem[] => sessionMenuEntries(row.context, row.status).map((entry, index) => {
    if (entry.kind === "separator") return { type: "separator", id: `separator-${index}` };
    const label = t(SESSION_ACTION_LABEL_KEYS[entry.id]);
    return {
      type: "item",
      id: entry.id,
      label: entry.id === "delete" ? `${label}…` : label,
      icon: sessionActionIcon(entry.id),
      shortcut: entry.shortcut,
      danger: entry.id === "delete",
      disabled: entry.disabledReason !== undefined,
      disabledReason: entry.disabledReason === "running" ? t("sidebar.cannotArchiveRunning") : undefined,
      onSelect: ({ shiftKey }) => runSessionAction(entry.id, row, shiftKey),
    };
  });

  const groupMenuItems = (project: SidebarProject, olderCount: number): SidebarMenuItem[] => {
    const archivedCount = archiveIndex.countByProject.get(project.key) ?? 0;
    const record = projectRecordByKey.get(project.key);
    // The registry's own Project: its folders, and the Project itself. A group the registry does not know — a folder
    // nobody recorded — has neither, so it offers neither control.
    const removalItems: SidebarMenuItem[] = record === undefined ? [] : [
      { type: "separator", id: "separator-removal" },
      {
        type: "item",
        id: "project-folders",
        label: t("sidebar.projectFoldersHeading", { name: project.name }),
        icon: <FolderIcon size={13} />,
        onSelect: ({ keepOpen }) => { keepOpen(); showRemovalStep({ kind: "folders" }); },
      },
      {
        type: "item",
        id: "remove-project",
        label: `${t("sidebar.removeProject")}…`,
        icon: <TrashIcon size={13} />,
        danger: true,
        onSelect: ({ keepOpen }) => { keepOpen(); showRemovalStep({ kind: "remove-project" }); },
      },
    ];

    // Within the project's band; disabled at its edges.
    const up = adjacentProjectMove(model.projects, project.key, "up");
    const down = adjacentProjectMove(model.projects, project.key, "down");
    return [
      {
        type: "item",
        id: "pin-project",
        label: t(project.pinned ? "sidebar.unpinProject" : "sidebar.pinProject"),
        icon: project.pinned ? <PinOffIcon /> : <PinIcon />,
        onSelect: () => { void applyUiState({ action: "pin-project", projectKey: project.key, root: project.root, pinned: !project.pinned }); },
      },
      {
        type: "item",
        id: "move-up",
        label: t("sidebar.moveProjectUp"),
        icon: <ChevronIcon className="sidebar-icon-up" />,
        disabled: up === null,
        onSelect: () => { if (up) moveProject(project.key, up.anchorKey, up.position); },
      },
      {
        type: "item",
        id: "move-down",
        label: t("sidebar.moveProjectDown"),
        icon: <ChevronIcon className="sidebar-icon-down" />,
        disabled: down === null,
        onSelect: () => { if (down) moveProject(project.key, down.anchorKey, down.position); },
      },
      {
        type: "item",
        id: "archive-older",
        label: t("sidebar.archiveOlderThanWeek", { count: olderCount }),
        icon: <ArchiveIcon />,
        disabled: olderCount === 0,
        onSelect: () => archiveOlderSessions(project),
      },
      {
        type: "item",
        id: "open-in-files",
        label: t("sidebar.openInFilesTab"),
        icon: <FolderIcon />,
        onSelect: () => openProjectInFiles(project),
      },
      { type: "separator", id: "separator-groups" },
      {
        // This project open, every other one closed.
        type: "item",
        id: "collapse-others",
        label: t("sidebar.collapseOtherGroups"),
        icon: <ChevronIcon />,
        disabled: model.projects.every((other) => isGroupExpanded(other, groupExpansion) === (other.key === project.key)),
        onSelect: () => setAllGroupsExpanded((other) => other.key === project.key),
      },
      {
        type: "item",
        id: "expand-all",
        label: t("sidebar.expandAllGroups"),
        icon: <ChevronIcon className="sidebar-icon-down" />,
        disabled: model.projects.every((other) => isGroupExpanded(other, groupExpansion)),
        onSelect: () => setAllGroupsExpanded(() => true),
      },
      { type: "separator", id: "separator" },
      {
        type: "item",
        id: "view-archived",
        label: t("sidebar.viewArchived", { count: archivedCount }),
        icon: <ArchiveIcon />,
        disabled: archivedCount === 0,
        onSelect: openArchiveView,
      },
      ...removalItems,
    ];
  };

  let menuTitle: string | undefined;
  let menuLabel = "";
  // Room for "Archive sessions older than 7 days · N".
  let menuWidth: number | undefined;
  let menuItems: SidebarMenuItem[] | undefined;
  if (menu?.kind === "row" && menuRow) {
    menuTitle = sessionRowTitle(menuRow.family.root);
    menuLabel = t("sidebar.sessionActions");
    menuItems = sessionMenuItems(menuRow);
  } else if (menu?.kind === "group") {
    menuTitle = menu.project.name;
    menuLabel = t("sidebar.projectActions", { name: menu.project.name });
    // The project as the tree has it now: pinned, unpinned or moved in another window while the menu is open.
    menuItems = groupMenuItems(projectByKey.get(menu.project.key) ?? menu.project, menu.olderCount);
    menuWidth = 264;
  }

  // The removal body replaces the group menu's items: the folder list, or the confirmation for the Project or one
  // folder. It acts on the registry's own record — the same list the backend's answer is applied to — and a group the
  // registry does not know has no body at all.
  const removalRecord = menu?.kind === "group" ? projectRecordByKey.get(menu.project.key) : undefined;
  const removalBody = menu?.kind === "group" && menu.body !== undefined && removalRecord !== undefined
    ? (
      <ProjectRemovalMenu
        project={removalRecord}
        body={menu.body}
        onStep={showRemovalStep}
        onUnlink={(folderId, replacementFolderId) => { void runFolderUnlink(removalRecord, folderId, replacementFolderId); }}
        onRemoveProject={() => { void runProjectRemoval(removalRecord); }}
        onCancel={closeMenu}
      />
    )
    : undefined;
  const removalStep = menu?.kind === "group" ? menu.body?.step : undefined;
  // A body's own step: the menu moves its focus there when the step changes, and a phone's Cancel takes it on a
  // question whose other answer removes something.
  const removalFocusKey = removalStep === undefined
    ? "items"
    : removalStep.kind === "unlink" ? `removal:unlink:${removalStep.folderId}` : `removal:${removalStep.kind}`;


  // The tree row (and the button in it) that the open menu belongs to.
  const activeMenuRowKey = menu?.kind === "row"
    ? menu.row.key
    : menu?.kind === "group" ? `group:${menu.project.key}` : null;

  const treeLayout = isMobile ? "mobile" : "desktop";
  // Until pins and archive have loaded, archived rows would flash in.
  const treeLoading = loading || !uiStateLoaded;
  const treeProps = {
    layout: treeLayout,
    loading: treeLoading,
    error,
    renamingRootId,
    confirmDeleteRootId,
    activeMenuRowKey,
    onSelectFamily: handleSelectFamily,
    onToggleGroup: handleToggleGroup,
    onShowMore: handleShowMore,
    onShowLess: handleShowLess,
    onTogglePinned: handleTogglePinned,
    onArchiveFamily: archiveFamily,
    onRestoreFamily: restoreFamily,
    onOpenRowMenu: openRowMenu,
    onRowContextMenu: handleContextMenu,
    onRenameCommit: (family: SessionFamily, value: string) => { void commitRename(family, value); },
    onRenameCancel: () => setRenamingRootId(null),
    onDeleteConfirm: (family: SessionFamily) => { void performDelete(family); },
    onDeleteCancel: () => {
      const rootId = confirmDeleteRootId;
      setConfirmDeleteRootId(null);
      // Cancel goes with the confirmation: the row's own button takes focus.
      if (rootId) focusAfterCommit(() => familyRowButton(rootId));
    },
    onGroupNew: handleGroupNew,
    onGroupMenu: handleGroupMenu,
    onNewProject: handleNewProject,
    onOpenOtherProject: handleOpenOtherProject,
    onOpenArchive: openArchiveView,
    // The archive view has no group rows: only the main tree's can be dragged.
    onMoveGroup: moveProject,
  } as const;

  const explorerCwd = selectedCwd;
  // The toolbar row's search button searches the files on the files tab:
  // the head has no search of its own.
  const searchesFiles = sidebarTab === "files" && explorerCwd !== null;
  // What the toolbar row's widths depend on (the chosen tab's label is bolder).
  useHeaderFit(headerRef, [t("sidebar.tabSessions"), t("sidebar.tabFiles"), t("sidebar.new"), explorerCwd && changesCount > 0 ? changesCount : "", sidebarTab].join("\n"));
  const archivedCount = model.archivedCount;

  return (
    <div className={`session-sidebar${toast ? " has-toast" : ""}`}>
      {newProjectOpen && (
        <NewProjectDialog
          onCancel={() => {
            setNewProjectOpen(false);
            const opener = newProjectReturnFocusRef.current;
            newProjectReturnFocusRef.current = null;
            if (opener) focusAfterCommit(() => (opener.isConnected ? opener : null));
          }}
          onCreated={handleProjectCreated}
        />
      )}
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            // The composer's "Open another project…" puts focus back on its
            // control: the picker took it and leaves nothing behind.
            const opener = customPathOpen === "new-session" ? folderReturnFocusRef.current : null;
            folderPickRef.current = null;
            folderReturnFocusRef.current = null;
            setCustomPathOpen(false);
            setCustomPathError(null);
            if (opener) focusAfterCommit(() => (opener.isConnected ? opener : null));
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* One toolbar row, in the cells of the chat's top bar beside it (its
          line continues that bar's): Sessions | Files, then New and the
          search of the tab in view. Only the two tabs are the tablist. */}
      <div ref={headerRef} className="sidebar-header">
        <div className="sidebar-tabs-list" role="tablist" aria-label={t("sidebar.tabsLabel")}>
          <button
            ref={sessionsTabRef}
            type="button"
            role="tab"
            id="session-sidebar-tab-sessions"
            aria-selected={sidebarTab === "sessions"}
            aria-controls="session-sidebar-panel-sessions"
            tabIndex={sidebarTab === "sessions" ? 0 : -1}
            className={`sidebar-tab${sidebarTab === "sessions" ? " is-selected" : ""}`}
            onClick={() => switchTab("sessions")}
            onKeyDown={handleTabKeyDown}
          >
            <MessageIcon size={13} className="sidebar-tab-icon" />
            <span className="sidebar-tab-label">{t("sidebar.tabSessions")}</span>
          </button>
          <button
            ref={filesTabRef}
            type="button"
            role="tab"
            id="session-sidebar-tab-files"
            aria-selected={sidebarTab === "files"}
            aria-controls="session-sidebar-panel-files"
            tabIndex={sidebarTab === "files" ? 0 : -1}
            title={explorerCwd && changesCount > 0 ? t("sidebar.changedFiles", { count: changesCount }) : undefined}
            className={`sidebar-tab${sidebarTab === "files" ? " is-selected" : ""}`}
            onClick={() => switchTab("files")}
            onKeyDown={handleTabKeyDown}
          >
            <FolderIcon size={13} className="sidebar-tab-icon" />
            <span className="sidebar-tab-label">{t("sidebar.tabFiles")}</span>
            {explorerCwd && changesCount > 0 && <span className="sidebar-tab-count" aria-hidden="true">{changesCount}</span>}
          </button>
        </div>
        <span className="sidebar-header-spacer" />
        <button
          type="button"
          className="sidebar-new-button"
          onClick={handleNewSession}
          disabled={!selectedCwd}
          title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
        >
          <PlusIcon size={12} />
          <span className="sidebar-new-label">{t("sidebar.new")}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            // The search of the tab in view: the files tab's searches its
            // files; without a folder there, it opens the sessions tab's.
            if (searchesFiles) {
              setFileSearchOpen((open) => !open);
              return;
            }
            if (sidebarTab !== "sessions") {
              switchTab("sessions");
              setSessionSearchOpen(true);
              return;
            }
            setSessionSearchOpen((open) => !open);
          }}
          title={searchesFiles ? t("sidebar.searchFiles") : t("sidebar.toggleSessionSearch")}
          aria-label={searchesFiles ? t("sidebar.searchFiles") : t("sidebar.toggleSessionSearch")}
          aria-expanded={searchesFiles ? fileSearchOpen : sessionSearchOpen}
          aria-controls={searchesFiles ? "file-search-input" : "session-search-input"}
          className={`sidebar-search-toggle${(searchesFiles ? fileSearchOpen : sessionSearchOpen) ? " is-active" : ""}`}
        >
          <SearchIcon size={16} />
        </button>
      </div>

      {/* Sessions tab: every project's sessions, or the archive */}
      <div
        ref={sessionsPanelRef}
        id="session-sidebar-panel-sessions"
        role="tabpanel"
        aria-labelledby="session-sidebar-tab-sessions"
        hidden={sidebarTab !== "sessions"}
        className="sidebar-panel"
        onScrollCapture={rememberScroll}
      >
        {sessionSearchOpen && (
          <div className="sidebar-search">
            <input
              id="session-search-input"
              type="search"
              autoFocus
              value={sessionSearchQuery}
              maxLength={MAX_SEARCH_QUERY_CHARS}
              aria-label={t("sidebar.searchSessions")}
              placeholder={t("sidebar.searchSessions")}
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.stopPropagation();
                  setSessionSearchQuery("");
                }
              }}
              className="sidebar-search-input"
            />
          </div>
        )}
        <SessionSearch
          open={sessionSearchOpen}
          query={sessionSearchQuery}
          selectedSessionId={selectedSessionId}
          onSelectSession={handleSelectSessionFromList}
          archivedSessionIds={archiveIndex.ids}
        >
          {/* Kept mounted under the archive view, so going back finds it as it was. */}
          <div className="sidebar-sessions-view" hidden={archiveView}>
            <SessionTree
              {...treeProps}
              rows={model.rows}
              emptyLabel={t("sidebar.noSessions")}
              reveal={treeReveal}
              onRevealHandled={handleRevealHandled}
            />
          </div>
          {archiveView && (
            <div className="sidebar-sessions-view">
              <div className="sidebar-archive-bar">
                <button
                  ref={archiveBackRef}
                  type="button"
                  className="sidebar-archive-back"
                  title={t("sidebar.backToSessions")}
                  aria-label={`${t("sidebar.backToSessions")}: ${t("sidebar.archivedCount", { count: archivedCount })}`}
                  onClick={() => setArchiveView(false)}
                >
                  <ChevronIcon size={13} className="sidebar-icon-back" />
                  <span>{t("sidebar.archived")}</span>
                  <span className="sidebar-archive-count">· {archivedCount}</span>
                </button>
              </div>
              <SessionTree {...treeProps} rows={archiveRows} emptyLabel={t("sidebar.noArchived")} />
            </div>
          )}
        </SessionSearch>
      </div>

      {/* Files tab: the project and worktree in use, and its files */}
      <div
        ref={filesPanelRef}
        id="session-sidebar-panel-files"
        role="tabpanel"
        aria-labelledby="session-sidebar-tab-files"
        hidden={sidebarTab !== "files"}
        className="sidebar-panel"
        onScrollCapture={rememberScroll}
      >
        {/* One head: the folder in use, then what is done with it. The
            buttons are the head's, not the picker's: its group names only
            the project and worktree. */}
        <div className="sidebar-files-head">
          {/* The project and worktree in use: the same picker as the bar above a
              fresh composer, as two boxes. Its worktree box shows only at the
              top of a git checkout (repo subdirs keep their own project
              identity, so switching from them would jump projects); a disabled
              box says why elsewhere. The list comes from the loaded project
              (not just its forCwd), so switching between worktrees of one
              project keeps the box instead of flickering while it refetches. */}
          <ProjectWorktreePicker
            handleRef={filesPickerRef}
            layout="stacked"
            context={newSessionContext ?? { project: null, worktrees: null, currentWorktreePath: null, projects: projectChoiceList }}
            mobile={isMobile}
            label={t("sidebar.projectAndWorktree")}
            placeholder={selectionState.restoring ? "" : t("sidebar.selectProject")}
            homeDir={homeDir}
            projectActivity={projectActivity}
            worktreeHint={inactiveWorktreeSelector}
            newWorktreeTitle={t("sidebar.createWorktreeTitle")}
            onPick={handleFilesPick}
            onUseDefaultDirectory={() => { void handleDefaultCwd(); }}
            onOpenFolder={handleCustomPathClick}
            onRefreshWorktrees={refreshWorktrees}
            onCreateWorktree={createWorktree}
            onRemoveWorktree={handleRemoveWorktree}
          />
          {/* Always the same buttons in the same places: the changes view
              stays (disabled) while there is nothing changed, so nothing
              moves as an agent edits files and commits. The folder's
              actions first, the tree's changes view last; its search is the
              header's search button. */}
          {explorerCwd && (
            <div className="sidebar-files-actions" role="group" aria-label={t("sidebar.fileActions")}>
              {onOpenTerminal && (
                <ToolbarIconButton
                  onClick={() => onOpenTerminal(explorerCwd)}
                  title={t("terminal.open")}
                >
                  <TerminalIcon size={14} />
                </ToolbarIconButton>
              )}
              {/* Opening a folder in the desktop file manager is a capability of the machine the browser runs on, and
                  no Backend route serves it: the retired BFF's `/api/open-in-explorer` always answered "unsupported
                  platform", so the control is stated as the limit it is rather than asked and refused on click. */}
              <ToolbarIconButton
                onClick={() => {}}
                disabled
                title={t("sidebar.openInExplorerUnsupported")}
              >
                <FolderIcon size={14} />
              </ToolbarIconButton>
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
              >
                <UploadIcon size={14} />
              </ToolbarIconButton>
              <ToolbarIconButton
                onClick={() => {
                  if (onExplorerRefresh) onExplorerRefresh();
                  else setExplorerKey((k) => k + 1);
                  setExplorerRefreshDone(true);
                  if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                  explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
                }}
                title={t("sidebar.refreshExplorer")}
                done={explorerRefreshDone}
              >
                {explorerRefreshDone ? <CheckIcon size={14} /> : <RefreshIcon size={14} />}
              </ToolbarIconButton>
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                disabled={changesCount === 0}
                title={t("sidebar.changedFiles", { count: changesCount })}
                pressed={changesCount > 0 && !changesCollapsed}
              >
                <ChangesIcon size={14} />
              </ToolbarIconButton>
            </div>
          )}
        </div>

        {/* Mounted whenever there is a cwd, also while the tab is hidden, so the
            expanded tree, a search and an upload in progress survive a switch. */}
        <div ref={explorerScrollRef} className="sidebar-files-scroll scrollbar-subtle">
          {explorerCwd && (
            <FileExplorer
              ref={fileExplorerRef}
              cwd={explorerCwd}
              displayCwd={selectedProject?.displayRoot ?? null}
              onOpenFile={onOpenFile ?? (() => {})}
              refreshKey={explorerKey}
              onAtMention={onAtMention}
              onAtMentions={onAtMentions}
              onUploadBusyChange={setExplorerUploadBusy}
              changesCollapsed={changesCollapsed}
              onChangesCountChange={setChangesCount}
              fileSearchOpen={fileSearchOpen}
              onFileSearchOpenChange={setFileSearchOpen}
            />
          )}
        </div>
      </div>

      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={isMobile}
        ariaLabel={menuLabel}
        // A removal body carries its own heading; the sheet's title would repeat it.
        title={removalBody === undefined ? menuTitle : undefined}
        items={menuItems}
        cancelLabel={t("sidebar.cancel")}
        focusCancel={removalStep !== undefined && removalStep.kind !== "folders"}
        focusKey={removalFocusKey}
        onClose={closeMenu}
        returnFocusTo={menu?.opener ?? null}
        width={menuWidth}
      >
        {removalBody}
      </SidebarMenu>
      <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel={t("sidebar.dismiss")} />
    </div>
  );
}
