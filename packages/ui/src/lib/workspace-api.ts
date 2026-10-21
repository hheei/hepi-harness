"use client";

import { useEffect, useMemo, useState } from "react";
import type { CapabilityRequest } from "./capability-availability";
import { folderRoutingPath, UNBOUND_CWD, projectGroupOfPath, workspaceIdOfRoutingPath, type ProjectRouting } from "./project-routing";
import { useWorkbenchConnection } from "./workbench-scope";

/**
 * The workspace, project and worktree API the shared workbench asks its connection for.
 *
 * One vocabulary, the Backend's own: `/api/workspaces`, `/api/projects`, `/api/hosts`, `/api/host/directories` and
 * `/api/worktrees` are the routes the client ingress forwards unchanged, so what a surface reads here is the contract
 * the Backend publishes rather than a translation of the retired Next BFF's `/api/cwd/browse`, `/api/home`,
 * `/api/default-cwd` and `/api/worktrees?cwd=` vocabulary. The only thing that changes between the two hosts is the
 * origin and the credential, which the client already owns.
 *
 * What this module owns is the two things that genuinely differ from a raw request:
 *
 * - **which computer a request acts on.** No client names the computer it is served from: the ingress states the
 *   deployment's default host on every request it forwards and the Backend resolves it, so a local read names none.
 *   A *remote* target — one of the execution targets `/api/hosts` reports — is named explicitly, and only there.
 * - **the worktree operation**, which is one Backend route with an `operation` field rather than a verb per shape, and
 *   whose refusals (`dirty`, `not_supported`, `unreachable`, `outcome_unknown`) keep their own names.
 *
 * There is no `/api/default-cwd`, `/api/home` or `/api/open-in-explorer` here: those were the Next BFF's own
 * vocabulary, and what they meant is derived below from the workspaces and projects the Backend actually publishes.
 */

/** The execution account a host itself reported: who the tools run as, and where that account's home is. */
export interface WorkspaceAccount {
  user: string;
  home: string;
}

/** One execution workspace this deployment can bind, as `GET /api/workspaces` states it. */
export interface WorkspaceEntry {
  id: string;
  gatewayId?: string;
  /** True when a Project removal kept this binding resolvable: shown, and never a target for a new conversation. */
  retained?: true;
  host?: WorkspaceAccount;
  workspaceRoot?: string;
  /** Why this workspace's host could not report its account and root, when it could not. */
  hostError?: string;
}

/** One execution target a configured gateway offers: a local host, or one of its SSH profiles. */
export interface HostProfile {
  id: string;
  host: string;
  root: string;
  user?: string;
  home?: string;
  error?: string;
}

export interface HostEntry {
  id: string;
  profiles: HostProfile[];
  error?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

/** One host's own read-only listing, as `GET /api/host/directories` forwards it. */
export interface DirectoryListing {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  host?: WorkspaceAccount;
}

/** One checkout as `POST /api/worktrees { operation: "list" }` states it. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
  /** The workspace this checkout is recorded as; an entry without one is listed and is not a conversation target. */
  workspaceId?: string;
}

export interface WorktreeListing {
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

/** A remote execution target to act on: a configured gateway, and for a remote one the profile to act through. */
export interface DirectoryTarget {
  hostId?: string;
  profileId?: string;
}

export interface ProjectFolderInput {
  root: string;
  default: boolean;
}

/** What one folder's unlink answered: the Project as it stands, or null when its last folder's removal removed it. */
export interface FolderUnlinkAnswer {
  project: ProjectRouting | null;
  removedFolderId: string;
}

/**
 * One refusal the deployment stated, so a caller distinguishes a named limit from a transport failure: the Backend's
 * own status, its code, and whether the host refused a checkout because it holds uncommitted work.
 */
export class WorkspaceRefusal extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly dirty = false) {
    super(message);
    this.name = "WorkspaceRefusal";
  }
}

/** One JSON answer, or the refusal it stated. A body that states no reason leaves the status as the only thing there is. */
async function answered<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return body as T;
  const reason = typeof body.error === "string" && body.error !== "" ? body.error
    : typeof body.message === "string" && body.message !== "" ? body.message
      : "HTTP " + response.status;
  throw new WorkspaceRefusal(reason, response.status, typeof body.code === "string" ? body.code : undefined, body.dirty === true);
}

const WORKSPACES = "/api/workspaces";
const PROJECTS = "/api/projects";
const WORKTREES = "/api/worktrees";
const HOSTS = "/api/hosts";
const HOST_DIRECTORIES = "/api/host/directories";

/** The host refusals that name a limit rather than a failure: a host that cannot serve worktrees says so. */
export const WORKTREE_LIMIT_CODES: ReadonlySet<string> = new Set(["not_supported", "unreachable", "outcome_unknown", "gateway_offline"]);

/**
 * The workspaces this deployment was configured with: a Project folder is a Project location rather than one of them,
 * and a binding a removal retained is never offered back — the home and default-directory answers come from real
 * configured workspaces only (spec decisions 23 and 58).
 */
export function configuredWorkspaces(workspaces: readonly WorkspaceEntry[], projects: readonly ProjectRouting[]): WorkspaceEntry[] {
  const folders = new Set(projects.flatMap(project => project.folders.map(folder => folder.workspaceId)));
  return workspaces.filter(workspace => !folders.has(workspace.id) && workspace.retained !== true);
}

/** The home the paths show as `~`: the account the configured workspace's host itself reported, or nothing. */
export function configuredHome(workspaces: readonly WorkspaceEntry[], projects: readonly ProjectRouting[]): string {
  const [workspace] = configuredWorkspaces(workspaces, projects);
  return workspace?.host?.home ?? "";
}

/** "Use default directory": the configured workspace's routing path, or the sentinel when there is none to start in. */
export function configuredDefaultCwd(workspaces: readonly WorkspaceEntry[], projects: readonly ProjectRouting[]): string {
  const [workspace] = configuredWorkspaces(workspaces, projects);
  return workspace === undefined ? UNBOUND_CWD : folderRoutingPath(workspace.id);
}

/**
 * One routing path's identity, from the listings the Backend publishes: the Project group it belongs to, or its own
 * identity with the root its host reported. A path naming no served workspace is its own root, which is what the
 * retired `/api/cwd/validate` resolved against a second server-side read of these same two listings.
 */
export function workspaceIdentity(workspaces: readonly WorkspaceEntry[], projects: readonly ProjectRouting[], path: string): { root: string; key: string; displayRoot: string; retained: boolean } {
  const group = projectGroupOfPath(projects, path);
  if (group !== null) return { root: group.defaultCwd, key: group.key, displayRoot: group.displayRoot, retained: group.retained };
  const workspaceId = workspaceIdOfRoutingPath(path);
  const root = workspaces.find(workspace => workspace.id === workspaceId)?.workspaceRoot;
  return { root: path, key: path, displayRoot: root ?? path, retained: workspaces.find(workspace => workspace.id === workspaceId)?.retained === true };
}

export interface WorkspaceApi {
  /** Every execution workspace this deployment can bind, each with the account its host reported. */
  workspaces(): Promise<WorkspaceEntry[]>;
  /** Every execution target the configured gateways offer: ids and profiles only, never a gateway URL or token. */
  hosts(): Promise<HostEntry[]>;
  /** One host's own directories. Absent a target, the deployment's stated default host is browsed. */
  browse(target?: DirectoryTarget, path?: string): Promise<DirectoryListing>;
  /** The recorded projects, each with the folders chosen on one computer. */
  projects(): Promise<ProjectRouting[]>;
  createProject(input: { name: string; folders: readonly ProjectFolderInput[]; target?: DirectoryTarget }): Promise<ProjectRouting>;
  removeProject(projectId: string): Promise<ProjectRouting>;
  unlinkFolder(projectId: string, folderId: string, replacementFolderId?: string | null): Promise<FolderUnlinkAnswer>;
  listWorktrees(workspaceId: string): Promise<WorktreeListing>;
  createWorktree(workspaceId: string, branch: string): Promise<{ path: string; branch: string; workspaceId?: string }>;
  removeWorktree(workspaceId: string, path: string, force: boolean): Promise<void>;
}

/** The workspace API of one connection: every request through the connection's own transport and nothing else. */
export function createWorkspaceApi(request: CapabilityRequest): WorkspaceApi {
  const query = (params: Readonly<Record<string, string | undefined>>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, value);
    return search.size === 0 ? "" : "?" + search.toString();
  };
  const body = (init: Record<string, unknown>): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) });
  return {
    async workspaces() {
      return (await answered<{ workspaces: WorkspaceEntry[] }>(await request(WORKSPACES))).workspaces;
    },
    async hosts() {
      return (await answered<{ hosts: HostEntry[] }>(await request(HOSTS))).hosts;
    },
    async browse(target, path) {
      return await answered<DirectoryListing>(await request(HOST_DIRECTORIES + query({ path, hostId: target?.hostId, profileId: target?.profileId })));
    },
    async projects() {
      return (await answered<{ projects: ProjectRouting[] }>(await request(PROJECTS))).projects;
    },
    async createProject({ name, folders, target }) {
      const answer = await answered<{ project?: ProjectRouting }>(await request(PROJECTS, body({
        name,
        folders: folders.map(folder => ({ root: folder.root, default: folder.default })),
        ...(target?.hostId === undefined ? {} : { hostId: target.hostId }),
        ...(target?.profileId === undefined ? {} : { profileId: target.profileId }),
      })));
      if (answer.project === undefined) throw new WorkspaceRefusal("the deployment recorded no project", 502);
      return answer.project;
    },
    async removeProject(projectId) {
      const answer = await answered<{ project?: ProjectRouting }>(await request(PROJECTS + "/" + encodeURIComponent(projectId), { method: "DELETE" }));
      if (answer.project === undefined) throw new WorkspaceRefusal("the deployment answered no removed project", 502);
      return answer.project;
    },
    async unlinkFolder(projectId, folderId, replacementFolderId) {
      const suffix = replacementFolderId === undefined || replacementFolderId === null || replacementFolderId === "" ? "" : query({ defaultFolderId: replacementFolderId });
      const answer = await answered<{ project: ProjectRouting | null; removedFolderId: string }>(
        await request(PROJECTS + "/" + encodeURIComponent(projectId) + "/folders/" + encodeURIComponent(folderId) + suffix, { method: "DELETE" }),
      );
      return { project: answer.project ?? null, removedFolderId: answer.removedFolderId };
    },
    async listWorktrees(workspaceId) {
      return (await answered<{ ok: true; value: WorktreeListing }>(await request(WORKTREES, body({ workspaceId, operation: "list" })))).value;
    },
    async createWorktree(workspaceId, branch) {
      const answer = await answered<{ ok: true; value?: { path: string; branch: string; workspaceId?: string } }>(await request(WORKTREES, body({ workspaceId, operation: "create", branch })));
      if (answer.value === undefined) throw new WorkspaceRefusal("the host created no checkout", 502);
      return answer.value;
    },
    async removeWorktree(workspaceId, path, force) {
      await answered<{ ok: true }>(await request(WORKTREES, body({ workspaceId, operation: "remove", path, force })));
    },
  };
}

/**
 * The workspace API of the connection this surface is rendered under: the sidebar, the folder picker and the dialogs are
 * mounted inside the connection they manage, so there is no second transport to fall back to.
 */
export function useWorkspaceApi(): WorkspaceApi {
  const request = useWorkbenchConnection().client.request;
  return useMemo(() => createWorkspaceApi(request), [request]);
}

// The home folder the paths show as ~, asked for once per connection: the composer's bar mounts again with every move
// of the fresh composer, and the sidebar mounts beside it.
const configuredHomes = new Map<string, string>();

/** The configured home of this connection, cached per connection scope so a remount does not ask again. */
export function useConfiguredHome(): string {
  const api = useWorkspaceApi();
  const scope = useWorkbenchConnection().scope;
  const [home, setHome] = useState<string>(() => configuredHomes.get(scope) ?? "");
  useEffect(() => {
    const known = configuredHomes.get(scope);
    if (known !== undefined) { setHome(known); return; }
    let cancelled = false;
    void Promise.all([api.workspaces(), api.projects()])
      .then(([workspaces, projects]) => {
        const value = configuredHome(workspaces, projects);
        configuredHomes.set(scope, value);
        if (!cancelled) setHome(value);
      })
      .catch(() => { /* a home that could not be read leaves the paths as they are */ });
    return () => { cancelled = true; };
  }, [api, scope]);
  return home;
}
