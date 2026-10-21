/**
 * How a recorded project appears in the browser's routing.
 *
 * A project's conversations are addressed by the folder they are bound to (`/workspace/<workspaceId>`), but they
 * belong to one group: a project may hold several folders of one computer, and every one of them is the same project
 * to the user. `/project/<id>` is that group key. Every folder resolves to the project's DEFAULT folder for new
 * conversations, so a new session always starts where the project says it does, whichever folder the sidebar happens
 * to be showing. Pure and client-safe: the sidebar, the adapter and the tests all use these rules.
 */

import { workspaceIdOfRoutingPath, workspaceRoutingPath } from "@hepi/protocol/files";

/** A project as the backend records it, with the /workspace/<id> routing of every folder. */
export interface ProjectRoutingFolder {
  id: string;
  workspaceId: string;
  root: string;
  cwd: string;
  default: boolean;
  /**
   * True when this folder's workspace is one a Project removal retained. The backend keeps reporting it so a
   * conversation bound to it resolves its display root; it is never offered as a target for a new conversation.
   */
  retained?: boolean;
}

export interface ProjectRouting {
  id: string;
  name: string;
  hostId: string;
  defaultFolderId: string;
  folders: ProjectRoutingFolder[];
}

export interface ProjectGroup {
  /** The group key every one of the project's folders resolves to. */
  key: string;
  name: string;
  /**
   * True when this project's default folder is one a Project removal retained. Its conversations keep their group and
   * their execution environment; a new session may not start there.
   */
  retained: boolean;
  /** The routing path of the folder new conversations of this project bind. */
  defaultCwd: string;
  /**
   * The **default folder's own path on its host** — what the project is shown as. A routing path is how the browser
   * *reaches* a folder, never what a folder is: the pickers, the group rows and the session details all name this
   * root, and nothing outside the API surfaces displays `/workspace/<id>`.
   */
  displayRoot: string;
}

export const projectGroupKey = (projectId: string): string => "/project/" + projectId;
export const folderRoutingPath = (workspaceId: string): string => workspaceRoutingPath(workspaceId);

/**
 * The routing path of a location the host itself reported — a workspace root or a project folder root — or null
 * when the path is no such location. The comparison is on the canonical root the host gave, ignoring a trailing
 * slash, so a legacy URL or a remembered path that names a real folder is recognised as that folder. Nothing is
 * guessed from the shape of a path: a directory the deployment does not serve has no routing path.
 */
export function routingPathForRoot(
  locations: readonly { workspaceId: string; root?: string | null }[],
  path: string,
): string | null {
  const wanted = normalizeRoot(path);
  if (wanted === "") return null;
  for (const location of locations) {
    if (location.root && normalizeRoot(location.root) === wanted) return folderRoutingPath(location.workspaceId);
  }
  return null;
}

/** A root as it compares: no trailing separator. An empty path stays empty; the filesystem root keeps its slash. */
function normalizeRoot(root: string): string {
  if (root === "") return "";
  const trimmed = root.replace(/[/\\]+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The group of one project: its key, its display name, the folder its new conversations bind and its own root. */
export function projectGroup(project: ProjectRouting): ProjectGroup | null {
  const firstFolder = project.folders[0];
  if (firstFolder === undefined) return null;
  const defaultFolder = project.folders.find(folder => folder.id === project.defaultFolderId) ?? firstFolder;
  return {
    key: projectGroupKey(project.id),
    name: project.name,
    // The backend reports retention on the folder itself; a project's group is retained when its default folder is.
    retained: defaultFolder.retained === true,
    defaultCwd: folderRoutingPath(defaultFolder.workspaceId),
    displayRoot: defaultFolder.root,
  };
}

/** Every project's group by key, for the sidebar and the pickers. */
export function projectGroups(projects: readonly ProjectRouting[]): Map<string, ProjectGroup> {
  const groups = new Map<string, ProjectGroup>();
  for (const project of projects) {
    const group = projectGroup(project);
    if (group !== null) groups.set(group.key, group);
  }
  return groups;
}

/**
 * The folder id one of a project's folders makes the operation target: the project's **default** folder, whichever of
 * the project's folders the caller is currently looking at. A folder that belongs to no project is its own target.
 */
export function projectDefaultWorkspaceId(projects: readonly ProjectRouting[], workspaceId: string): string {
  for (const project of projects) {
    if (!project.folders.some(folder => folder.workspaceId === workspaceId)) continue;
    const defaultFolder = project.folders.find(folder => folder.id === project.defaultFolderId) ?? project.folders[0];
    return defaultFolder?.workspaceId ?? workspaceId;
  }
  return workspaceId;
}

/** Which project group a routing path belongs to: its folder's project, or none for a configured workspace. */
export function projectGroupOfPath(projects: readonly ProjectRouting[], path: string): ProjectGroup | null {
  const workspaceId = workspaceIdOfRoutingPath(path);
  if (workspaceId === null) return null;
  for (const project of projects) {
    if (project.folders.some(folder => folder.workspaceId === workspaceId)) return projectGroup(project);
  }
  return null;
}
