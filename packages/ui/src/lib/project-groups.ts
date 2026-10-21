import type { SessionInfo } from "./types";
import { isUnboundCwd } from "./project-routing";
import { workspaceKeyOf } from "./workspace-memory";

export interface RecentProject {
  /** Stable server-provided identity used for comparison and Map keys. */
  key: string;
  /** The routing path the project's conversations are addressed by (`/workspace/<id>`), used for API calls. */
  root: string;
  /** The project's own folder on its host — what a picker shows. Falls back to `root` when nothing reported one. */
  displayRoot: string;
}

/** Projects sorted by most recent activity and deduplicated by stable key. */
export function getRecentProjects(sessions: readonly SessionInfo[]): RecentProject[] {
  const latestByProject = new Map<string, { root: string; displayRoot: string; modified: string }>();
  for (const session of sessions) {
    // A conversation with no execution workspace is not a project: it has no folder to open, so it never becomes a
    // "recent project" whose cwd the shell would adopt and hand to the file and Git surfaces.
    if (isUnboundCwd(session.cwd)) continue;
    // Nor is a folder a Project removal retained: its conversations stay listed and keep running, but the folder is
    // never offered back as a target for a new one (spec decisions 22, 23 and 55).
    if (session.workspaceRetained === true) continue;
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const displayRoot = session.projectDisplayRoot ?? root;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, displayRoot, modified: session.modified });
    }
  }
  return [...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root, displayRoot }]) => ({ key, root, displayRoot }));
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (runningSessionIds.has(session.id)) entry.running++;
    if (unreadSessionIds.has(session.id)) entry.unread++;
  }
  return counts;
}
