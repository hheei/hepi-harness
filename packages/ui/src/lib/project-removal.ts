/**
 * Removing a Project, and unlinking one of its folders, as the browser does it.
 *
 * Both are metadata-only operations on the durable backend (tickets 07 and 08): the directories on disk, the
 * conversations bound to the removed folders and the workspace ids those conversations hold are all left alone, and
 * the backend answers with the project as it stands — or `null` when its last folder's removal removed it. The rules
 * live here rather than in the sidebar because they are what the request and the answer mean, not how they are drawn:
 * which folder's removal must name a replacement, what the request addresses, and what the list becomes afterwards.
 * Pure and client-safe.
 */

import type { ProjectRouting } from "./project-routing";

/** One folder of a Project as its folder list shows it. */
export interface ProjectFolderRow {
  id: string;
  /** The folder's own path on its host — what the user recognizes, never the `/workspace/<id>` it is addressed by. */
  root: string;
  /** The routing path this folder's conversations are addressed by. */
  cwd: string;
  default: boolean;
  /**
   * True when this folder's removal must name another of the Project's folders as the replacement default in the same
   * call: it is the default folder and the Project has another folder to fall back to.
   */
  needsReplacement: boolean;
  /** True when this folder is the Project's last: removing it removes the Project record itself, so no replacement. */
  removesProject: boolean;
}

/** A Project's folders in the order the backend records them, with what removing each one means. */
export function projectFolderRows(project: ProjectRouting): ProjectFolderRow[] {
  const last = project.folders.length === 1;
  return project.folders.map(folder => ({
    id: folder.id,
    root: folder.root,
    cwd: folder.cwd,
    default: folder.id === project.defaultFolderId,
    needsReplacement: folder.id === project.defaultFolderId && !last,
    removesProject: last,
  }));
}

/**
 * The Web adapter route one folder's unlink goes to. The folder is named inside its Project's own path because it is
 * the Project's folder and not a workspace, and the replacement default a default folder's removal chose rides on the
 * same call: the backend refuses the request outright when the replacement is missing.
 */
export function folderUnlinkPath(projectId: string, folderId: string, replacementFolderId?: string | null): string {
  const path = "/api/projects/" + encodeURIComponent(projectId) + "/folders/" + encodeURIComponent(folderId);
  if (replacementFolderId === undefined || replacementFolderId === null || replacementFolderId === "") return path;
  return path + "?" + new URLSearchParams({ defaultFolderId: replacementFolderId }).toString();
}

/** What the backend answered for one folder's unlink: the Project as it stands, or null when it was the last folder. */
export interface FolderUnlinkAnswer {
  project: ProjectRouting | null;
  removedFolderId: string;
}

/** The project list after one folder's unlink, as the backend's own answer states it. */
export function applyFolderUnlink(projects: readonly ProjectRouting[], projectId: string, answer: FolderUnlinkAnswer): ProjectRouting[] {
  const index = projects.findIndex(project => project.id === projectId);
  if (index === -1) return [...projects];
  if (answer.project === null) return projects.filter(project => project.id !== projectId);
  return projects.map(project => (project.id === projectId ? answer.project as ProjectRouting : project));
}

/** The project list without a removed Project. */
export function removeProject(projects: readonly ProjectRouting[], projectId: string): ProjectRouting[] {
  return projects.filter(project => project.id !== projectId);
}

/**
 * Why a removal or an unlink was refused, as the backend stated it. A refusal always carries a readable reason; a
 * body that does not, or a response that is not JSON at all, leaves the status as the only thing there is to say.
 */
export function removalRefusal(status: number, body: unknown): string {
  const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() !== "" ? error : "HTTP " + status;
}
