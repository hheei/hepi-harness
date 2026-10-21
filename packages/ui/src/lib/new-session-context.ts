/**
 * Where a new session starts, and what the bar above a fresh composer offers
 * to change it: the project and, at the top of a git checkout, its worktrees.
 * The sidebar owns the cwd and the project identity; it reports a
 * `NewSessionContext` for its cwd, and every move goes back through it
 * (`SessionSidebarControl`). Pure and client-safe, so the rules are testable
 * without a DOM.
 */

import { folderRoutingPath } from "./project-routing";
import { projectNameOf } from "./session-tree";

export interface WorktreeChoice {
  /** The checkout's own directory on its host: what a removal names and what is shown. */
  path: string;
  branch: string | null;
  isMain: boolean;
  /**
   * The workspace this checkout is recorded as, when this deployment holds one. A conversation binds a workspace, so
   * only a recorded checkout is a target: an entry without an id is listed truthfully and cannot be picked.
   */
  workspaceId?: string;
}

/**
 * The path a checkout is *addressed* by: its routing path when this deployment records it, its own directory
 * otherwise. One rule, shared by the picker, the context and the sidebar, so a worktree pick and the cwd the sidebar
 * resolves cannot disagree about where a conversation would start.
 */
export function worktreeCwd(worktree: WorktreeChoice): string {
  return worktree.workspaceId === undefined ? worktree.path : folderRoutingPath(worktree.workspaceId);
}

/**
 * A project by its stable server key, the routing root its conversations are addressed by, and the folder it *is*.
 * The two paths are not the same thing: `root` is what an API call carries (`/workspace/<id>`), `displayRoot` is
 * what the user is shown ("~/Downloads"). Without a reported folder the routing root stands in for it.
 */
export interface ProjectChoice {
  key: string;
  root: string;
  /** The project's own folder on its host. Absent when nothing reported one; `root` then stands in. */
  displayRoot?: string;
  /** The display name a recorded project was given; without one the folder's last segment stands in. */
  name?: string;
  /**
   * True when this folder is one a Project removal retained. The choice is still shown as what the sidebar is
   * looking at; it is never offered as a target for a new session.
   */
  retained?: boolean;
}

/** The folder a choice is shown as. */
export function choiceDisplayRoot(choice: ProjectChoice): string {
  return choice.displayRoot ?? choice.root;
}

/** Where a new session starts: the header "+", a group's "+", the composer's bar. */
export interface NewSessionTarget {
  cwd: string;
  /** The target's project identity, handed to the shell so it adopts that project. */
  projectKey?: string;
  /** Server-resolved root of that identity: installed before the cwd changes. */
  projectRoot?: string;
  /** The target folder's own path on its host, for the surfaces that show it. */
  projectDisplayRoot?: string;
  /** The composer's bar: the fresh composer's draft and model picks move along. */
  carryComposer?: boolean;
}

/** How the shell starts a new session (`onNewSession`'s last argument). */
export interface NewSessionOptions {
  /** Move the fresh composer's draft and model picks to the new one instead of parking the draft. */
  carryComposer?: boolean;
}

/** What the sidebar reports for its cwd, for the bar above a fresh composer. */
export interface NewSessionContext {
  cwd: string;
  project: ProjectChoice;
  /**
   * The project's checkouts, only at the top of a git checkout (the files
   * tab's switcher rule): a subdirectory keeps its own identity. Else null.
   */
  worktrees: WorktreeChoice[] | null;
  /** The checkout of `cwd`, server-resolved: one of `worktrees` verbatim. */
  currentWorktreePath: string | null;
  /** Every project the sidebar knows, in its group order. */
  projects: readonly ProjectChoice[];
}

/**
 * What a project/worktree picker shows (components/ProjectWorktreePicker.tsx):
 * a context without its cwd, or no project yet (a sidebar with no cwd, whose
 * files tab still offers every project).
 */
export type ProjectWorktreeContext = Omit<NewSessionContext, "cwd" | "project"> & { project: ProjectChoice | null };

/** A move the shell made from the bar, kept until the sidebar reports its cwd. */
export interface NewSessionMove {
  /** The routing path the composer moved to. */
  cwd: string;
  project: ProjectChoice;
  /** The branch of a worktree the bar just created at `cwd`, which no report lists yet. */
  branch: string | null;
  /**
   * The checkout the move created, when it created one: its own directory and the workspace it is recorded as, so the
   * first bar after the create lists it exactly as the next listing will.
   */
  worktree?: WorktreeChoice;
}

/**
 * The context for the composer's cwd. The sidebar reports after the commit
 * that moved it, so for one render the report can still be the previous
 * cwd's: a sibling worktree keeps the project and its list, any other folder
 * gets a known project of that root (or one of its own) and no worktree list
 * until the sidebar has fetched it. The bar's own `move` names the project
 * at once: a checkout of the reported project the list lacks (a worktree just
 * created) joins that list, so the bar is right from its first frame.
 */
export function contextForCwd(
  context: NewSessionContext | null,
  cwd: string,
  move: NewSessionMove | null = null,
): NewSessionContext {
  if (context?.cwd === cwd) return context;
  const listed = context?.worktrees?.find((worktree) => worktreeCwd(worktree) === cwd);
  if (context && listed) return { ...context, cwd, currentWorktreePath: listed.path };
  const moved = move?.cwd === cwd ? move : null;
  if (moved && context?.worktrees && context.project.key === moved.project.key) {
    const created = moved.worktree ?? { path: cwd, branch: moved.branch, isMain: false };
    return {
      ...context,
      cwd,
      worktrees: context.worktrees.some((worktree) => worktree.path === created.path) ? context.worktrees : [...context.worktrees, created],
      currentWorktreePath: created.path,
    };
  }
  const projects = context?.projects ?? [];
  return {
    cwd,
    // A known project is the one its folder belongs to; a folder nobody listed is a project of its own, and its own
    // path is both what it is addressed by and what it is shown as.
    project: moved?.project ?? projects.find((project) => project.root === cwd) ?? { key: cwd, root: cwd, displayRoot: cwd },
    worktrees: null,
    currentWorktreePath: null,
    projects,
  };
}

/**
 * A picker's project list: the current project first when the list does not have it (a folder just opened). A folder
 * a Project removal retained is never a target, so it is neither listed nor added back as the current one — its
 * conversations stay open and running, and a new session is not offered there (spec decisions 23 and 55).
 */
export function projectChoices(context: ProjectWorktreeContext): ProjectChoice[] {
  const current = context.project;
  const listed = context.projects.filter((project) => project.retained !== true);
  if (!current || current.retained === true || listed.some((project) => project.key === current.key)) return listed;
  return [current, ...listed];
}

/** `first` in order, then whatever of `more` it does not list yet (by key), keeping a recorded display name. */
export function mergeProjectChoices(first: readonly ProjectChoice[], more: readonly ProjectChoice[]): ProjectChoice[] {
  const seen = new Set<string>();
  const merged: ProjectChoice[] = [];
  for (const { key, root, displayRoot, name } of [...first, ...more]) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      key,
      root,
      ...(displayRoot === undefined ? {} : { displayRoot }),
      ...(name === undefined ? {} : { name }),
    });
  }
  return merged;
}

function parentFolderName(root: string): string | null {
  const trimmed = root.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator > 0 ? projectNameOf(trimmed.slice(0, separator)) : null;
}

/**
 * Each choice's folder name, and its parent folder's name as a note only
 * where two choices share a name: a full path would be cut at its tail, the
 * part that tells them apart.
 */
export function describeProjectChoices(choices: readonly ProjectChoice[]): Array<{ choice: ProjectChoice; name: string; note: string | null }> {
  // A recorded project is shown by the name the user gave it; another choice by its folder's own name. The folder is
  // the host's own path, so a project in ~/Downloads is named "Downloads", never after the id it is addressed by.
  const named = choices.map((choice) => ({ choice, name: choice.name ?? projectNameOf(choiceDisplayRoot(choice)) }));
  const counts = new Map<string, number>();
  for (const { name } of named) counts.set(name, (counts.get(name) ?? 0) + 1);
  return named.map(({ choice, name }) => ({
    choice,
    name,
    note: (counts.get(name) ?? 0) > 1 ? parentFolderName(choiceDisplayRoot(choice)) : null,
  }));
}

/** The checkout a picker shows: `currentWorktreePath`'s, else the main one. */
export function currentWorktreeOf(context: ProjectWorktreeContext): WorktreeChoice | null {
  const worktrees = context.worktrees ?? [];
  return worktrees.find((worktree) => worktree.path === context.currentWorktreePath)
    ?? worktrees.find((worktree) => worktree.isMain)
    ?? null;
}

/**
 * Equal for contexts that show the same: the sidebar rebuilds its context on
 * every session-list refresh and running poll, and reports it only when this
 * changes.
 */
export function newSessionContextKey(context: NewSessionContext | null): string {
  if (!context) return "";
  return JSON.stringify([
    context.cwd,
    context.project.key,
    context.project.root,
    choiceDisplayRoot(context.project),
    context.currentWorktreePath,
    context.worktrees?.map((worktree) => [worktree.path, worktree.branch, worktree.isMain, worktree.workspaceId ?? null]) ?? null,
    context.projects.map((project) => [project.key, project.root, choiceDisplayRoot(project), project.retained === true]),
  ]);
}
