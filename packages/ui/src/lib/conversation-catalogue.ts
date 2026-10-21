import type { ConversationRunStatus, SessionInfo } from "./types.ts";
import { UNBOUND_CWD, workspaceIdOfRoutingPath } from "@hepi/protocol/files";
import { folderRoutingPath, projectGroupKey } from "./project-routing.ts";

/**
 * The Backend's conversation catalogue, projected into the row the sidebar renders.
 *
 * The Backend answers one catalogue read that already states everything a row needs: the conversation's workspace, its
 * host, the root this deployment recorded for that folder, the Project it is a folder of, its run status, its relations
 * and its summary. This module is the one place that turns that answer into the row shape, so the list, the search and
 * the fork answer cannot hand the sidebar three different rows for one conversation.
 *
 * What it deliberately does **not** do is state a fact the Backend did not. A conversation bound to no workspace has no
 * folder and no project; a configured workspace's path is the host's answer and comes from the deployment's workspace
 * listing, because this side holds only its id; a Project folder's root arrives with the row. And the list version is
 * the Backend's own number, passed through — deriving a second one here would let two readers of the same catalogue
 * disagree about whether it changed.
 */

/** The workspace facts a catalogue row states, as the Backend resolves them for that conversation. */
export type CatalogueWorkspace = {
  gatewayId?: string;
  /** The root this deployment recorded for the folder — a Project folder's or a retained binding's, never a guess. */
  root?: string;
  /** Present exactly when a removal or an unlink retained the binding: it is never a target for a new conversation. */
  retained?: true;
  project?: { id: string; name: string; defaultWorkspaceId: string; displayRoot: string };
};

/** One catalogue entry, as the Backend's `GET /api/conversations` states it. */
export type CatalogueEntry = {
  id: string;
  workspaceId?: string | null;
  gatewayId?: string | null;
  workspace?: CatalogueWorkspace;
  busy?: boolean;
  revision?: number;
  messageCount?: number;
  firstMessage?: string;
  title?: string | null;
  lastRunEndedAt?: number;
  createdBy?: string;
  displayParentId?: string;
  displayParentDeleted?: boolean;
  parentConversationId?: string;
  subagentParentConversationId?: string;
  runStatus?: ConversationRunStatus;
  extensions?: readonly string[];
};

/** One catalogue read, with the revisions the sidebar compares against what it already shows. */
export type Catalogue = {
  conversations: CatalogueEntry[];
  sidebarStateRevision?: number;
  projectsRevision?: number;
  sessionListVersion: number;
};

/** What `GET /api/conversations?running=compact` answers: the busy ids and the revisions, and no rows. */
export type CompactRunningCatalogue = {
  runningConversationIds: string[];
  sessionListVersion: number;
  sidebarStateRevision: number;
  projectsRevision: number;
};

/** The roots a configured workspace's own host reported, by workspace id. */
export type WorkspaceRoots = ReadonlyMap<string, string>;

const bound = (item: { workspaceId?: string | null }): boolean => typeof item.workspaceId === "string" && item.workspaceId !== "";

/**
 * A conversation's folder as the catalogue reports it: the routing identity the API addresses it by, and the folder's
 * own path on its host.
 *
 * The two are deliberately different. `projectRoot` is an address and stays `/workspace/<id>`, while
 * `projectDisplayRoot` is what every surface *shows*. A folder of a Project is that project's group, addressed by its
 * default folder and shown as that folder's root; any other workspace is its own group, shown as the root the
 * deployment recorded for it — and a configured workspace, which this side holds as an id and a host, is shown at the
 * root its host reported in the workspace listing.
 */
function sessionWorkspace(cwd: string, workspace: CatalogueWorkspace | undefined, roots: WorkspaceRoots): { projectRoot: string; projectKey: string; projectDisplayRoot: string } {
  const project = workspace?.project;
  if (project !== undefined) return { projectRoot: folderRoutingPath(project.defaultWorkspaceId), projectKey: projectGroupKey(project.id), projectDisplayRoot: project.displayRoot };
  return { projectRoot: cwd, projectKey: cwd, projectDisplayRoot: workspace?.root ?? displayRootOfPath(roots, cwd) };
}

/** The folder a routing path names, as its host reported it. A path naming no workspace is its own display root. */
function displayRootOfPath(roots: WorkspaceRoots, routingPath: string): string {
  const workspaceId = workspaceIdOfRoutingPath(routingPath);
  return (workspaceId === null ? undefined : roots.get(workspaceId)) ?? routingPath;
}

/**
 * One catalogue row as the session list shows it.
 *
 * A fork stays top-level in the sidebar and is told apart from its source by the relation the Backend reports from the
 * conversation's own record; a conversation a task created is a subagent's and carries that edge instead. A removed
 * parent is reported as such rather than erasing the relation: the child keeps its place and is never promoted.
 */
export type CatalogueRow = SessionInfo & {
  /** False for a conversation bound to no execution workspace: it has no folder, no project and no host. */
  workspaceBound: boolean;
};

export function catalogueRow(item: CatalogueEntry, roots: WorkspaceRoots = new Map()): CatalogueRow {
  const cwd = bound(item) ? folderRoutingPath(item.workspaceId!) : UNBOUND_CWD;
  const fork = item.parentConversationId === undefined ? {} : { parentSessionId: item.parentConversationId, relation: { kind: "fork" as const, originSessionId: item.parentConversationId } };
  const subagent = item.subagentParentConversationId === undefined ? {} : { parentSessionId: item.subagentParentConversationId, relation: { kind: "subagent" as const, parentSessionId: item.subagentParentConversationId } };
  const name = item.title ?? undefined;
  const lastRun = item.lastRunEndedAt === undefined ? {} : { lastRunEndedAt: item.lastRunEndedAt };
  const relations = {
    ...(item.createdBy === undefined ? {} : { createdBy: item.createdBy }),
    ...(item.displayParentId === undefined ? {} : { displayParentSessionId: item.displayParentId }),
    ...(item.displayParentDeleted === true ? { displayParentDeleted: true as const } : {}),
  };
  const run = item.runStatus === undefined ? {} : { runStatus: item.runStatus };
  const extensions = item.extensions === undefined ? {} : { extensions: [...item.extensions] };
  const gatewayId = item.gatewayId === undefined || item.gatewayId === null || item.gatewayId === "" ? {} : { gatewayId: item.gatewayId };
  const summary = { name, created: "", modified: "", messageCount: item.messageCount ?? 0, firstMessage: item.firstMessage ?? "", transient: false, ...lastRun, ...run, ...extensions, ...relations, ...fork, ...subagent };
  if (!bound(item)) return { id: item.id, path: "", cwd, workspaceBound: false, ...summary };
  const { projectRoot, projectKey, projectDisplayRoot } = sessionWorkspace(cwd, item.workspace, roots);
  const kept = item.workspace?.retained === true ? { workspaceRetained: true as const } : {};
  return { id: item.id, path: "", cwd, workspaceBound: true, projectRoot, projectKey, projectDisplayRoot, ...kept, ...summary, ...gatewayId };
}

/** One catalogue read as the session list answers it: the rows, the running set, and the revisions beside them. */
export function catalogueRows(catalog: Catalogue, roots: WorkspaceRoots = new Map()): {
  sessions: CatalogueRow[];
  runningSessionIds: string[];
  sessionListVersion: number;
  sessionUiStateRevision: number;
  projectsRevision: number;
} {
  return {
    sessions: catalog.conversations.map((item) => catalogueRow(item, roots)),
    runningSessionIds: catalog.conversations.filter((item) => item.busy === true).map((item) => item.id),
    sessionListVersion: catalog.sessionListVersion,
    sessionUiStateRevision: catalog.sidebarStateRevision ?? 0,
    projectsRevision: catalog.projectsRevision ?? 0,
  };
}

/**
 * The poll's projection: the ids the Backend stated and the revisions beside them. Nothing is derived here — a second
 * answer to "what is running" is one too many.
 */
export function catalogueRunning(catalog: CompactRunningCatalogue): { runningSessionIds: string[]; sessionListVersion: number; sessionUiStateRevision: number; projectsRevision: number } {
  return {
    runningSessionIds: catalog.runningConversationIds,
    sessionListVersion: catalog.sessionListVersion,
    sessionUiStateRevision: catalog.sidebarStateRevision,
    projectsRevision: catalog.projectsRevision,
  };
}
