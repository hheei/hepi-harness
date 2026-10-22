import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { DraftStore } from "./draft-store";
import { getInitialNavigation, withTabOpen, type InitialNavigation } from "./initial-navigation";
import { classifyReadFailure, type ReadFailure } from "./read-recovery";
import {
  clearTabOpenSession,
  getTabOpen,
  setTabOpenNewSession,
  setTabOpenSession,
} from "./tab-session";
import { errorText } from "@hepi/protocol/error-text";
import type { NewSessionContext, NewSessionMove, WorktreeChoice } from "./new-session-context";
import { mergeCatalogueRow } from "./conversation-catalogue";
import type { SessionInfo } from "./types";
import { clearLastOpen, getLastOpenSession, setLastOpenSession, workspaceKeyOf } from "./workspace-memory";

/**
 * The workbench's one selection: which workspace it is showing, which conversation or fresh composer is in it, and
 * which restore or open the reader is waiting on.
 *
 * It exists because the same facts used to be owned three times — the shell's selected session, the sidebar's cwd, and
 * the fresh composer's cwd and draft id — and kept in step by reporting: the sidebar told the shell its cwd, the shell
 * answered with suppression flags so a report would not look like a switch, and the sidebar then moved its own local cwd
 * to match a prop. This module replaces that triangle with one owner: every surface reads this readout and sends an
 * intent, and nothing reports a change back.
 *
 * Three things stay outside on purpose. A view's own imperatives — focus, an open menu, a measured panel — belong to the
 * surface that shows them. A catalogue's listing and polling belong to the sidebar, which hands its rows here
 * (`setCatalogue`) so a restore can use them. And a *transition* of presentation — a project switch clearing the
 * previous project's file tabs — is the shell's own policy, read from `projectKey`, not a decision this store makes.
 *
 * The rules it does own are the ones with user-visible consequences: URL before tab memory before workspace memory;
 * an explicit new choice retiring an older restore; identity hydration not being a switch; and the draft operations —
 * park, carry, New, promotion — staying four different things.
 */

/** A workspace the reader chose: a project's folder, a checkout, a validated path. */
export interface WorkspaceTarget {
  /** The routing path a session is addressed by: what every API call carries. */
  cwd: string;
  /** The target's project identity, when the surface that resolved it knows it. */
  projectKey?: string | null;
  /** The server-resolved root of that identity. */
  projectRoot?: string | null;
  /** The folder's own path on its host, for the surfaces that show it. */
  displayRoot?: string | null;
  /**
   * A checkout the surface just created at this target, which no listing holds yet: the bar above the composer shows it
   * from its first frame instead of waiting for the next listing to catch up.
   */
  createdWorktree?: WorktreeChoice;
  /** The branch of a checkout just created at this target. */
  branch?: string | null;
}

/** A fresh composer's location: its cwd and the draft key every one of its edits is stored under. */
export interface ComposerSelection {
  cwd: string;
  /** `new:<id>:<cwd>`, where the id distinguishes consecutive composers in one folder. */
  draftKey: string;
  /** The folder's own path on its host, for display; null while nothing reported one. */
  displayCwd: string | null;
  /** The project the composer's session will bind, once anything resolved it. */
  projectKey: string | null;
}

/** What the reader is waiting on a read for: which conversation, and where in it. */
export interface NavigationTarget {
  sessionId: string;
  entryId?: string;
  blockIndex?: number;
  /** The entry may sit outside the transcript's window, so the raw-history surface positions on it. */
  rawHistory?: boolean;
}

/** A read that did not answer, and the target it was asked for. */
export interface OpenFailure {
  sessionId: string;
  entryId?: string;
  failure: ReadFailure;
}

export interface WorkbenchSelectionState {
  /** The conversation on screen, or null while a fresh composer is. */
  readonly conversation: SessionInfo | null;
  /** The fresh composer on screen, or null while a conversation is. */
  readonly composer: ComposerSelection | null;
  /**
   * The workspace in effect: what the files tab, the terminal and a new conversation address. It is not always the open
   * conversation's cwd — a project switch within one group and a worktree pick move it while a conversation stays open.
   */
  readonly cwd: string | null;
  /** The project identity of `cwd`, as far as anything has resolved it: the key the memories are stored under. */
  readonly projectKey: string | null;
  /** The folder's own path on its host, for what the reader is shown. */
  readonly displayCwd: string | null;
  /** The first navigation a page performs: an explicit `?cwd=`, or one still being validated. */
  readonly initialCwd: { readonly requested: string | null; readonly status: "idle" | "validating" | "ready" | "error"; readonly error: string | null };
  /**
   * A read the reader is waiting on. While it is true the shell shows the opening state rather than "pick a
   * conversation", because nothing has been decided yet.
   */
  readonly restoring: boolean;
  /** A conversation the reader asked for and could not open. It never takes the selection's place. */
  readonly openFailure: OpenFailure | null;
  readonly openRetrying: boolean;
  /** Where a navigation must land inside its conversation, once it is open. */
  readonly navigation: NavigationTarget | null;
  /** The entry the raw-history surface positions on, when the transcript cannot carry it. */
  readonly rawHistoryFocus: { sessionId: string; entryId: string } | null;
  /**
   * How many times the accepted project identity changed, which is what a presentation owned by the shell follows.
   *
   * It is not the same fact as `projectKey`: resolving which project the folder in use belongs to states the key without
   * changing it, and a transition that fired there would close the reader's file tabs for a hydration.
   */
  readonly projectTransition: number;
  /**
   * The project and worktrees the sidebar lists for the current workspace, and the projects a picker may offer.
   *
   * It is the sidebar's reading of the workspace registry, published here because the bar above a fresh composer shows
   * the same thing: one report for the two surfaces that display it, rather than the sidebar telling the shell what it
   * found and the shell telling the bar.
   */
  readonly workspace: NewSessionContext | null;
  /**
   * A move that created its own checkout, kept until the listing catches up.
   *
   * Only a created worktree needs it: the picker names a checkout no listing has yet, so the bar would show the previous
   * project's list for one frame and a checkout missing from it after that.
   */
  readonly move: NewSessionMove | null;
  /**
   * How many times the on-screen conversation or composer identity has been replaced.
   *
   * It is the mount key of the chat surface: a new conversation, a fork and a fresh composer are new attachments, while
   * identity hydration and a same-project worktree move are not. Explicit handovers like a settings-driven reload are the
   * shell's own key; conversation lifetime gives the chat its own identity (ticket 03).
   */
  readonly attachment: number;
}

/** What a conversation open may ask for beyond its id. */
export interface SelectConversationOptions {
  /** The entry a navigation named: a search hit, a reference, a citation. */
  entryId?: string;
  blockIndex?: number;
  /** The entry may be outside the transcript's window, so the raw-history surface takes the reader there. */
  rawHistory?: boolean;
  /** A phone's drawer stays open: the sidebar has more to show (a fork's revealed row and its toast). */
  keepSidebarOpen?: boolean;
}

/** A fresh composer's move: New, a group's "+", the bar above it, the keyboard shortcut. */
export interface StartComposerOptions {
  /**
   * Carry the live composer instead of parking it: its text, images and model picks move to the new target. This is the
   * bar's own operation, and the one thing that must never merge with a draft already parked at the destination.
   */
  carry?: boolean;
  /** A phone's drawer stays open after the move (a fork opened from a row). */
  keepSidebarOpen?: boolean;
}

/** What the store needs from the page it is part of. All of it is a seam a test states directly. */
export interface WorkbenchSelectionDeps {
  /** This connection's drafts. Every park, carry and promote below is an operation on them. */
  readonly drafts: DraftStore;
  /**
   * The connection's conversation read, by id.
   *
   * There is no listing here: a workspace restore resolves its remembered row from the catalogue the sidebar delivers
   * (`setCatalogue`), so a restore cannot race that listing with a second one of its own.
   */
  readonly conversation: {
    open(sessionId: string): Promise<SessionInfo>;
  };
  /** Validate a cwd the URL named, the way the sidebar's folder picker does. */
  readonly validateCwd: (path: string) => Promise<{ cwd: string; projectKey?: string | null; projectRoot?: string | null; displayRoot?: string | null }>;
  /** Replace the current entry's search string. */
  readonly navigate: (search: string) => void;
  /** The logical query of the newest render, for the write-back checks below. */
  readonly query: () => URLSearchParams;
  /** Report a selection that landed, so the shell can close a phone's drawer over what it now shows. */
  readonly onLanded?: (kind: "conversation" | "composer", options: { keepSidebarOpen: boolean }) => void;
}

/** A fresh composer's draft key: the id distinguishes consecutive composers in one folder. */
export function composerDraftKey(draftId: string, cwd: string): string {
  return `new:${draftId}:${cwd}`;
}

/** Where a composer's unsent draft waits while the reader is somewhere else in the same folder. */
export function parkedComposerDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

/**
 * The composer a remembered tab key names for this folder, or null when it names nothing this folder may use.
 *
 * A fresh composer's key is `new:<id>:<cwd>`, so only a key whose folder matches is this tab's composer here: any other
 * key belongs to another workspace, and adopting it would open one folder's draft in another's composer.
 */
export function rememberedComposerId(key: string | null, cwd: string): string | null {
  if (!key || !key.startsWith("new:") || !key.endsWith(":" + cwd)) return null;
  const id = key.slice("new:".length, key.length - cwd.length - 1);
  return id || null;
}

function newDraftId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function emptyState(): WorkbenchSelectionState {
  return {
    conversation: null,
    composer: null,
    cwd: null,
    projectKey: null,
    displayCwd: null,
    initialCwd: { requested: null, status: "idle", error: null },
    restoring: false,
    openFailure: null,
    openRetrying: false,
    navigation: null,
    rawHistoryFocus: null,
    workspace: null,
    move: null,
    projectTransition: 0,
    attachment: 0,
  };
}

/** The selection every surface reads and every surface sends an intent to. */
export interface WorkbenchSelection {
  getState(): WorkbenchSelectionState;
  subscribe(listener: () => void): () => void;
  /**
   * Apply the page's first navigation: an explicit URL, else this tab's memory, else the workspace's own restore.
   *
   * It is one call from the shell's mount, because the tab's stores do not exist on the server: applying them during the
   * first render would make the client tree differ from the HTML it hydrated.
   */
  start(): void;
  /** A catalogue the sidebar listed, so a workspace restore can resolve its remembered id without a second read. */
  setCatalogue(sessions: readonly SessionInfo[]): void;
  /** The workspace listing the sidebar read, for the bar above a fresh composer. */
  setWorkspaceContext(context: NewSessionContext | null): void;
  /** Open a conversation the catalogue states, as a row click or a search hit does. */
  selectConversation(session: SessionInfo, options?: SelectConversationOptions): void;
  /** Read a conversation by id: a deep link, a reference, a restored target. A stale answer changes nothing. */
  openConversation(sessionId: string, options?: SelectConversationOptions): Promise<void>;
  /** Read the conversation the shell failed to open again. Only the read is repeated, never the navigation's writes. */
  retryOpen(): Promise<void>;
  /** Stay where the reader was: the failure belongs to a request, not to the selection. */
  dismissOpenFailure(): void;
  /** Start a fresh composer in `target`: the header's "+", a group's "+", the keyboard, the bar's pick. */
  startComposer(target: WorkspaceTarget, options?: StartComposerOptions): void;
  /**
   * The workspace the reader chose: a project, a checkout, a validated path.
   *
   * An open conversation of the same project stays open — moving between worktrees is not leaving it — while a different
   * project's workspace replaces it with the destination's own restore.
   */
  selectWorkspace(target: WorkspaceTarget): void;
  /**
   * Identity, not a choice: the server resolved which project the current cwd belongs to.
   *
   * It never moves the selection, never remounts the chat and never rewrites the URL; it only records the key the
   * memories and the same-project checks are stated in.
   */
  acceptWorkspaceIdentity(target: WorkspaceTarget): void;
  /**
   * A fresh composer's first submission was confirmed: the conversation it became is the selection now.
   *
   * `sourceDraftKey` is the composer that submitted. A confirmation for a composer the reader has already left is not
   * this selection's news: accepting it would replace whatever they are writing now with a conversation they left.
   */
  acceptPromotion(session: SessionInfo, sourceDraftKey?: string | null): void;
  /** A conversation was forked: the copy is what the reader is shown. */
  conversationForked(session: SessionInfo): void;
  /** A conversation is gone. Only the one on screen is left; everything else keeps its place and its draft. */
  conversationDeleted(sessionId: string): void;
  /** The conversation on screen cannot be read at all: leave for the composer of the folder it was in. */
  leaveUnreadableConversation(): void;
  /** The conversation a navigation named has been positioned on, so the target is not applied twice. */
  navigationHandled(sessionId: string, entryId: string): void;
  /**
   * The catalogue's own row for the open conversation arrived — a hydration, a rename, a new run's status.
   *
   * The row is merged into the selection in place, so the conversation on screen gains the metadata without being
   * replaced: nothing remounts, and a field the row stopped stating is cleared rather than left standing.
   */
  refreshConversationRow(sessions: readonly SessionInfo[]): void;
  /** The conversation on screen was renamed by an answer of its own. */
  renameConversation(sessionId: string, name: string): void;
}

/**
 * The workbench's selection, over one connection's drafts.
 *
 * Every accepted target change bumps `attachment` and retires in-flight reads by the same counter: an answer that
 * belongs to a selection the reader already left cannot move the selection, rewrite the URL, or state an error about a
 * target nobody is looking at.
 */
export function createWorkbenchSelection(deps: WorkbenchSelectionDeps): WorkbenchSelection {
  let state = emptyState();
  let generation = 0;
  let catalogue: readonly SessionInfo[] = [];
  /** Whether any listing has arrived: an empty one is an answer, an absent one is not. */
  let catalogueDelivered = false;
  const listeners = new Set<() => void>();

  const emit = (next: Partial<WorkbenchSelectionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  /**
   * A target the reader chose was accepted.
   *
   * Landing in another project is a transition the shell's presentation follows — the file tabs are keyed by absolute
   * path, so the previous project's tabs cannot stay under a folder they do not belong to. Recording the transition here,
   * from what was actually accepted, is what keeps that decision off the callers that only report an identity.
   */
  const accept = (next: Partial<WorkbenchSelectionState>, projectKey: string | null) => {
    const changed = projectKey !== null && state.projectKey !== null && projectKey !== state.projectKey;
    emit({ ...next, projectTransition: state.projectTransition + (changed ? 1 : 0) });
  };

  const navigateTo = (search: string) => {
    const query = deps.query();
    const desired = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    if (desired.toString() === query.toString()) return;
    deps.navigate(search);
  };

  const navigateToConversation = (sessionId: string) => {
    if (deps.query().get("session") === sessionId && deps.query().get("cwd") === null) return;
    navigateTo(`?session=${encodeURIComponent(sessionId)}`);
  };

  const navigateToComposer = (cwd: string | null) => {
    if (cwd === null) {
      navigateTo("");
      return;
    }
    if (deps.query().get("cwd") === cwd && deps.query().get("session") === null) return;
    navigateTo(`?cwd=${encodeURIComponent(cwd)}`);
  };

  /**
   * Park the fresh composer's draft in the folder it was written in.
   *
   * A draft is stored under the composer's own key, so leaving it needs no copy: moving the key to the folder's parked
   * slot is what keeps the text for the next visit without leaving a composer nobody shows holding it.
   */
  const parkComposerDraft = () => {
    const composer = state.composer;
    if (composer === null) return;
    deps.drafts.rekeyDraft(composer.draftKey, parkedComposerDraftKey(composer.cwd));
  };

  /** Record the accepted selection: the tab's own memory, and the workspace's — both from what really landed. */
  const rememberConversation = (session: SessionInfo, projectKey: string | null) => {
    setTabOpenSession(session.id);
    setLastOpenSession(projectKey ?? workspaceKeyOf(session), session.id);
  };

  const rememberComposer = (composer: ComposerSelection) => {
    setTabOpenNewSession(composer.cwd, composer.draftKey);
    clearTabOpenSession("");
  };

  const adoptConversation = (
    session: SessionInfo,
    options: SelectConversationOptions,
    extra: { projectKey?: string | null; displayCwd?: string | null } = {},
  ) => {
    generation += 1;
    const projectKey = extra.projectKey ?? workspaceKeyOf(session);
    const displayCwd = extra.displayCwd ?? session.projectDisplayRoot ?? null;
    // Re-picking the conversation already on screen is not a new attachment: replacing the surface would remount the
    // transcript and re-run its read for a pick the reader already made. The target the pick names is still applied — an
    // entry, a block, a raw-history position — because that is what the pick asked for.
    const sameConversation = state.conversation?.id === session.id;
    accept({
      conversation: session,
      composer: null,
      cwd: session.cwd,
      projectKey,
      displayCwd,
      restoring: false,
      openFailure: null,
      openRetrying: false,
      navigation: options.entryId === undefined
        ? null
        : { sessionId: session.id, entryId: options.entryId, ...(options.blockIndex === undefined ? {} : { blockIndex: options.blockIndex }), ...(options.rawHistory === true ? { rawHistory: true } : {}) },
      rawHistoryFocus: options.rawHistory === true && options.entryId !== undefined
        ? { sessionId: session.id, entryId: options.entryId }
        : null,
      attachment: sameConversation ? state.attachment : state.attachment + 1,
    }, projectKey);
    rememberConversation(session, projectKey);
    if (!sameConversation) navigateToConversation(session.id);
    deps.onLanded?.("conversation", { keepSidebarOpen: options.keepSidebarOpen === true });
  };

  /**
   * Put a fresh composer on screen.
   *
   * `carry` is the bar's operation: the live composer's own draft moves to the new key and its model picks travel with
   * it. Without it — New, a group's "+", the keyboard, a project switch — the outgoing draft is parked where it was
   * written and the destination's parked draft, if any, comes back. The two never merge: a carried draft is what the
   * user is writing now, and a parked one is what they left.
   */
  const adoptComposer = (target: WorkspaceTarget, options: StartComposerOptions = {}) => {
    generation += 1;
    const projectKey = target.projectKey ?? target.projectRoot ?? state.projectKey;
    const displayCwd = target.displayRoot ?? state.displayCwd;
    const draftId = newDraftId();
    const draftKey = composerDraftKey(draftId, target.cwd);
    const previous = state.composer;
    if (options.carry === true && previous !== null && previous.draftKey !== draftKey) {
      // The composer's own handle moves the live text when it is mounted; the store move is what an unmounted or
      // already-replaced composer leaves, and both land on the same key.
      deps.drafts.rekeyDraft(previous.draftKey, draftKey);
    } else if (previous !== null) {
      parkComposerDraft();
      // A draft parked in *another* folder comes back, because moving there is what the reader asked for. New in the
      // folder the composer is already in is a separate identity: the text that was on screen stays parked, and the
      // composer that replaces it starts empty.
      if (previous.cwd !== target.cwd) deps.drafts.rekeyDraft(parkedComposerDraftKey(target.cwd), draftKey);
    } else {
      deps.drafts.rekeyDraft(parkedComposerDraftKey(target.cwd), draftKey);
    }
    accept({
      conversation: null,
      composer: { cwd: target.cwd, draftKey, displayCwd, projectKey },
      cwd: target.cwd,
      projectKey,
      displayCwd,
      restoring: false,
      openFailure: null,
      openRetrying: false,
      navigation: null,
      rawHistoryFocus: null,
      initialCwd: { requested: null, status: "ready", error: null },
      // A checkout the caller just created is not in any listing yet; the bar shows it from its first frame.
      move: target.createdWorktree === undefined && target.branch === undefined
        ? null
        : {
          cwd: target.cwd,
          project: { key: projectKey ?? target.cwd, root: target.projectRoot ?? target.cwd, ...(target.displayRoot == null ? {} : { displayRoot: target.displayRoot }) },
          branch: target.branch ?? null,
          ...(target.createdWorktree === undefined ? {} : { worktree: target.createdWorktree }),
        },
      attachment: state.attachment + 1,
    }, projectKey);
    rememberComposer({ cwd: target.cwd, draftKey, displayCwd, projectKey });
    navigateToComposer(target.cwd);
    deps.onLanded?.("composer", { keepSidebarOpen: options.keepSidebarOpen === true });
  };

  /**
   * The conversation the workspace memory has for a key, from the catalogue the sidebar already listed.
   *
   * It deliberately does not read again: a second list would race the sidebar's own and could answer with rows for a
   * workspace the reader is no longer in. A catalogue that has not been delivered yet is not an answer either — the
   * destination keeps the composer this choice already gave it, and the memory is left standing for the next visit
   * rather than being cleared on ignorance.
   */
  const rememberedRow = (projectKey: string): SessionInfo | null => {
    const sessionId = getLastOpenSession(projectKey);
    if (sessionId === null) return null;
    const found = catalogue.find((session) => session.id === sessionId);
    if (found === undefined) {
      // A listing that answered without the remembered row means it is gone from this workspace: the memory is not
      // retried forever. A listing that has not arrived says nothing about it.
      if (catalogueDelivered) clearLastOpen(projectKey);
      return null;
    }
    if (workspaceKeyOf(found) !== projectKey) {
      clearLastOpen(projectKey);
      return null;
    }
    return found;
  };

  const adoptWorkspaceIdentity = (target: WorkspaceTarget) => {
    const projectKey = target.projectKey ?? target.projectRoot ?? state.projectKey;
    const displayCwd = target.displayRoot ?? state.displayCwd;
    // A conversation whose folder is the one this identity is about takes the key too: a row the catalogue has not
    // hydrated yet states only its cwd, and without this the same-project check would read that cwd as another project
    // and close the chat the reader is in.
    const conversation = state.conversation !== null && state.conversation.cwd === target.cwd && projectKey !== null
      ? { ...state.conversation, projectKey }
      : state.conversation;
    emit({
      projectKey,
      displayCwd,
      composer: state.composer === null ? null : { ...state.composer, projectKey, displayCwd },
      conversation,
    });
    if (state.composer !== null) rememberComposer({ ...state.composer, projectKey, displayCwd });
  };

  const start = () => {
    deps.drafts.hydrate();
    const query = deps.query();
    const fromUrl = getInitialNavigation(query);
    const tabOpen = getTabOpen();
    const navigation: InitialNavigation = withTabOpen(fromUrl, tabOpen);
    const requestedCwd = navigation.requestedCwd;
    if (requestedCwd !== null) {
      generation += 1;
      const token = generation;
      emit({
        initialCwd: { requested: requestedCwd, status: "validating", error: null },
        restoring: true,
      });
      void deps.validateCwd(requestedCwd).then((validated) => {
        if (token !== generation) return;
        // A reload comes back to the composer this tab was showing, not to a new one: only an id the tab actually had is
        // reused, because an invented one would be a second composer beside the draft the tab was holding.
        const remembered = rememberedComposerId(tabOpen?.kind === "new" ? tabOpen.draftKey ?? null : null, validated.cwd);
        const draftKey = composerDraftKey(remembered ?? `initial:${requestedCwd}`, validated.cwd);
        const composer: ComposerSelection = {
          cwd: validated.cwd,
          draftKey,
          displayCwd: validated.displayRoot ?? null,
          projectKey: validated.projectKey ?? validated.projectRoot ?? null,
        };
        // A first-frame composer adopts only the key the tab named, which is where its own draft already is. The folder's
        // parked text is not taken here: it comes back on a move into the folder (the bar's pick, New, a workspace switch),
        // which is the shipped rule and the reason a parked draft is not silently merged into a reloaded composer.
        emit({
          conversation: null,
          composer,
          cwd: validated.cwd,
          projectKey: composer.projectKey,
          displayCwd: composer.displayCwd,
          initialCwd: { requested: requestedCwd, status: "ready", error: null },
          restoring: false,
          openFailure: null,
          navigation: null,
          rawHistoryFocus: null,
          attachment: state.attachment + 1,
        });
        rememberComposer(composer);
        // The URL stated the cwd only when it named it: a restored composer writes it back so a copied link is the view.
        if (query.get("cwd") === null) navigateToComposer(validated.cwd);
      }).catch((error: unknown) => {
        if (token !== generation) return;
        emit({
          initialCwd: {
            requested: requestedCwd,
            status: "error",
            error: errorText(error),
          },
          restoring: false,
        });
      });
      return;
    }
    const sessionId = navigation.sessionId;
    if (sessionId !== null) {
      emit({ restoring: true });
      void openConversation(sessionId, {});
    }
  };

  const selectConversation = (session: SessionInfo, options: SelectConversationOptions = {}) => {
    // The composer that was on screen keeps its text where it was written; the conversation's own draft is its own key.
    parkComposerDraft();
    adoptConversation(session, options);
  };

  const openConversation = async (sessionId: string, options: SelectConversationOptions = {}) => {
    const token = generation + 1;
    // A read of a target the reader is waiting for hides "pick a conversation"; one asked for over an already-open
    // conversation does not, because that conversation stays on screen until the answer replaces it.
    if (state.conversation === null) emit({ restoring: true });
    generation = token;
    try {
      const opened = await deps.conversation.open(sessionId);
      if (token !== generation) return;
      parkComposerDraft();
      adoptConversation(opened, options);
    } catch (error) {
      if (token !== generation) return;
      emit({
        restoring: false,
        openRetrying: false,
        openFailure: { sessionId, ...(options.entryId === undefined ? {} : { entryId: options.entryId }), failure: classifyReadFailure(error) },
      });
    }
  };

  const retryOpen = async () => {
    const pending = state.openFailure;
    if (pending === null || state.openRetrying) return;
    emit({ openRetrying: true });
    await openConversation(pending.sessionId, pending.entryId === undefined ? {} : { entryId: pending.entryId });
  };

  const startComposer = (target: WorkspaceTarget, options: StartComposerOptions = {}) => {
    adoptComposer(target, options);
  };

  const selectWorkspace = (target: WorkspaceTarget) => {
    const projectKey = target.projectKey ?? target.projectRoot ?? state.projectKey ?? target.cwd;
    const sameProject = state.projectKey !== null && state.projectKey === projectKey;
    // A choice is newer news than any read still in flight: the open the reader asked for a moment ago must not land on
    // top of the workspace they just picked, and a first-frame validation it replaced must not leave the page stating a
    // pending restore nothing is going to answer. Only the reads are retired — what is on screen keeps its attachment.
    generation += 1;
    if (state.restoring || state.openFailure !== null || state.initialCwd.status === "validating") {
      emit({ restoring: false, openRetrying: false, openFailure: null, initialCwd: { requested: null, status: "ready", error: null } });
    }
    // The workspace in effect moves either way; what it costs depends on what was in it.
    if (state.conversation !== null) {
      const conversationKey = workspaceKeyOf(state.conversation);
      if (target.cwd === state.cwd && conversationKey === projectKey) {
        adoptWorkspaceIdentity(target);
        return;
      }
      // A conversation of this project stays open while the workspace around it moves: switching checkouts is not
      // leaving the conversation, and it must not remount the chat or rewrite the URL.
      if (conversationKey === projectKey) {
        emit({
          cwd: target.cwd,
          projectKey,
          displayCwd: target.displayRoot ?? state.displayCwd,
        });
        return;
      }
    } else if (state.composer !== null) {
      if (state.composer.cwd === target.cwd) {
        adoptWorkspaceIdentity(target);
        return;
      }
      if (sameProject) {
        // Within one project a destination's parked draft is the thing to restore, which is what a fresh composer does.
        adoptComposer(target);
        return;
      }
    }
    // Another project's workspace, from either a conversation or a composer: what the destination holds decides it, and
    // that is answered *before* anything is adopted. Its memory names a conversation the delivered catalogue still
    // lists, so that conversation is the destination; otherwise the folder's composer is, and its parked draft comes
    // with it. A composer adopted first and discarded a moment later would consume the destination's parked draft into
    // a key nothing shows, so the text would be neither on screen nor reachable again. A bare route invents nothing:
    // only a choice restores, and a catalogue that names nothing leaves the reader in a working composer rather than in
    // a pending restore.
    const remembered = rememberedRow(projectKey);
    if (remembered === null) {
      adoptComposer(target);
      return;
    }
    // Leaving a composer parks its own text in its own folder — the destination's parked draft is not taken.
    parkComposerDraft();
    adoptConversation(remembered, {}, { projectKey });
  };

  const acceptPromotion = (session: SessionInfo, sourceDraftKey?: string | null) => {
    // A confirmation names the composer that submitted. If the reader has since left it — another composer, a
    // conversation, another workspace — this answer is about a target nobody is looking at, and accepting it would
    // replace what they are writing now with a conversation they left. The draft the conversation owns stays untouched.
    if (sourceDraftKey !== undefined && sourceDraftKey !== null && state.composer?.draftKey !== sourceDraftKey) return;
    // The fresh composer's draft was rekeyed to the conversation's own id at the confirmation point; what is left here
    // is to state that the composer became a conversation, without touching the draft that now belongs to it.
    adoptConversation(session, {}, { projectKey: state.projectKey });
  };

  const conversationForked = (session: SessionInfo) => {
    adoptConversation(session, {}, { projectKey: workspaceKeyOf(session) });
  };

  const conversationDeleted = (sessionId: string) => {
    clearTabOpenSession(sessionId);
    const open = state.conversation;
    if (open === null || open.id !== sessionId) return;
    // Leave for the composer of the folder the conversation was in. Its unsent draft is stored under its own key and is
    // still there when the reader comes back; nothing of it is cleared here.
    adoptComposer({ cwd: open.cwd, projectKey: workspaceKeyOf(open), displayRoot: open.projectDisplayRoot ?? null });
  };

  const leaveUnreadableConversation = () => {
    const open = state.conversation;
    if (open === null) return;
    adoptComposer({ cwd: open.cwd, projectKey: workspaceKeyOf(open), displayRoot: open.projectDisplayRoot ?? null });
  };

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    setCatalogue(sessions: readonly SessionInfo[]): void {
      catalogue = sessions;
      catalogueDelivered = true;
    },
    setWorkspaceContext(context: NewSessionContext | null): void {
      // The move is done once the listing holds the folder it named: from then on it is the listing's own word.
      const move = state.move !== null && context?.cwd === state.move.cwd ? null : state.move;
      if (context === state.workspace && move === state.move) return;
      emit({ workspace: context, move });
    },
    selectConversation,
    openConversation,
    retryOpen,
    dismissOpenFailure: () => emit({ openFailure: null }),
    startComposer,
    selectWorkspace,
    acceptWorkspaceIdentity(target: WorkspaceTarget): void {
      adoptWorkspaceIdentity(target);
    },
    acceptPromotion,
    conversationForked,
    conversationDeleted,
    leaveUnreadableConversation,
    navigationHandled(sessionId: string, entryId: string): void {
      if (state.navigation?.sessionId !== sessionId || state.navigation.entryId !== entryId) return;
      emit({ navigation: null });
    },
    refreshConversationRow(sessions: readonly SessionInfo[]): void {
      const open = state.conversation;
      if (open === null) return;
      const refreshed = sessions.find((session) => session.id === open.id);
      if (refreshed === undefined) return;
      const merged = mergeCatalogueRow(open, refreshed);
      // The identity the row now states is the one the memories and the same-project checks are stated in.
      emit({ conversation: merged, projectKey: workspaceKeyOf(merged) });
    },
    renameConversation(sessionId: string, name: string): void {
      const open = state.conversation;
      if (open === null || open.id !== sessionId) return;
      emit({ conversation: { ...open, name } });
    },
  };
}

const SelectionContext = createContext<WorkbenchSelection | null>(null);

export const WorkbenchSelectionProvider = SelectionContext.Provider;

/**
 * The workbench's selection, as the mounted tree reaches it.
 *
 * A surface gets the store itself rather than a copy of its state: it reads through `useSelectionState` when it wants the
 * readout, so a component that only sends intents does not re-render on every accepted selection.
 */
export function useWorkbenchSelection(): WorkbenchSelection {
  const selection = useContext(SelectionContext);
  if (selection === null) throw new Error("The workbench is mounted outside a selection.");
  return selection;
}

/** The selection's readout for this render, re-read whenever the selection accepts something. */
/**
 * The readout of one mounted tree's selection.
 *
 * The shell that owns the store reads through this rather than through context, because it is the component that puts the
 * store *into* context: a provider cannot answer its own render.
 */
export function useSelectionStateOf(selection: WorkbenchSelection): WorkbenchSelectionState {
  return useSyncExternalStore(selection.subscribe, selection.getState, selection.getState);
}

export function useSelectionState(): WorkbenchSelectionState {
  return useSelectionStateOf(useWorkbenchSelection());
}

/**
 * The selection one shell owns, created once for its lifetime.
 *
 * It is created from the connection's drafts, so a store can never outlive the connection it names entries under, and
 * from the shell's own navigation, so every accepted target rewrites the URL in one place.
 */
export function useWorkbenchSelectionStore(deps: WorkbenchSelectionDeps): WorkbenchSelection {
  const latest = useRef(deps);
  latest.current = deps;
  const ref = useRef<WorkbenchSelection | null>(null);
  if (ref.current === null) {
    // The store outlives the render that created it, so every dependency is read through the newest closure: a store that
    // kept the first frame's `navigate`, `query` or `onLanded` would rewrite another route or answer a phone's sidebar
    // from a viewport the page no longer has.
    const live: WorkbenchSelectionDeps = new Proxy({} as WorkbenchSelectionDeps, {
      get: (_target, name) => (latest.current as unknown as Record<string | symbol, unknown>)[name],
    });
    ref.current = createWorkbenchSelection(live);
  }
  return ref.current;
}
