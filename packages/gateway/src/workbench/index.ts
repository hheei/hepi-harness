import { dirname } from "node:path";
import type { WorkbenchChanges, WorkbenchFile, WorkbenchRequest, WorkbenchResult } from "@hepi/protocol/gateway";
import type { WorkspaceRegistry } from "../workspaces.ts";
import { executeGitCommand, getChangedFiles, getFileDiff, type GitCommandExecutor } from "./app-store-diff.ts";
import { listWorkspaceFiles, readWorkspaceFile, type WorkspaceTree } from "./app-store-files.ts";
import { isPathDenied, isWorkspacePathMissing, resolveExistingWorkspacePath, resolveWorkspacePath } from "./workspace-paths.ts";

/**
 * One workspace a workbench answers for: the id the wire names, the root it is confined to, and — on an SSH gateway —
 * the profile that root lives behind, so a host adapter can name the connection it reads through.
 */
export type WorkbenchWorkspace = { readonly id: string; readonly root: string; readonly profileId?: string };

/**
 * Everything one workbench operation reads from, for one workspace.
 *
 * This is the seam a host implements, and the whole of it: the Git commands the listing, the changed files and the diff
 * run; the directory tree the listing walks when Git cannot answer for the checkout; one bounded text preview; and the
 * confirmation that a path a diff names really exists inside the root. A host that supplies its own keeps every one of
 * those off this process. The local workbench is the same class with no host given, which is why both hosts answer one
 * protocol with one set of path and status rules.
 */
export type WorkbenchHost = {
  readonly executeGit: GitCommandExecutor;
  readonly tree?: WorkspaceTree;
  readonly readFile: (filePath: string) => Promise<WorkbenchFile>;
  readonly resolveExisting: (filePath: string) => Promise<void>;
};

/**
 * Where the operations run. `host` names one host per workspace, which is what a gateway serving a remote profile
 * needs; `executeGit` is the shorthand a caller with one executor for every workspace already used. A caller that
 * supplies neither reads this machine.
 */
export type WorkbenchDependencies = {
  readonly executeGit?: GitCommandExecutor;
  readonly host?: (workspace: WorkbenchWorkspace) => WorkbenchHost;
};

/** What one call may say about itself: the caller's cancellation, which reaches every host command the operation runs. */
export type WorkbenchCallOptions = { readonly signal?: AbortSignal };
// The request and answer shapes of `/v1/workbench` belong to the wire, so they are declared once in
// `@hepi/protocol/gateway` and re-exported here under the names this package has always exported.
export type { WorkbenchChangedFile, WorkbenchChanges, WorkbenchFile, WorkbenchOperation, WorkbenchRequest, WorkbenchResult } from "@hepi/protocol/gateway";

export class GatewayWorkbench {
  readonly #workspaces: WorkspaceRegistry;
  readonly #host: (workspace: WorkbenchWorkspace) => WorkbenchHost;
  constructor(workspaces: WorkspaceRegistry, dependencies: WorkbenchDependencies = {}) {
    this.#workspaces = workspaces;
    const host = dependencies.host;
    this.#host = host !== undefined
      ? host
      : (workspace) => localHost(workspace, dependencies.executeGit ?? executeGitCommand);
  }
  async execute(request: WorkbenchRequest, options: WorkbenchCallOptions = {}): Promise<WorkbenchResult> {
    const workspace = this.#workspaces.get(request.workspaceId);
    if (workspace === undefined) return { ok: false, code: "unknown_workspace" };
    const signal = options.signal;
    try {
      const host = this.#host(workspace);
      switch (request.operation) {
        case "files": return { ok: true, value: await listWorkspaceFiles(workspace.root, { force: true, maxFiles: 20000, executeGit: host.executeGit, ...(signal === undefined ? {} : { signal }), ...(host.tree === undefined ? {} : { tree: host.tree }) }) };
        case "read": return { ok: true, value: await host.readFile(requirePath(request.path)) };
        case "changes": return { ok: true, value: await getChangedFiles(workspace.root, host.executeGit, signal) };
        case "diff": {
          const filePath = requirePath(request.path);
          resolveWorkspacePath(workspace.root, filePath);
          await host.resolveExisting(filePath);
          return { ok: true, value: await getFileDiff(workspace.root, filePath, host.executeGit, signal) };
        }
        default: return { ok: false, code: "operation_failed" };
      }
    } catch (error) {
      // A path the host refused keeps the workbench's own `path_denied`, whichever host refused it, and a path the
      // host does not have keeps `not_found` — a file deleted after a tree was listed is that one fact, and reading
      // it as a broken operation would blame the host for an ordinary lifetime. Everything else is the operation's
      // failure, so a transport that could not answer never reads as an empty listing or an empty diff.
      return { ok: false, code: isPathDenied(error) ? "path_denied" : isWorkspacePathMissing(error) ? "not_found" : "operation_failed" };
    }
  }
}
function requirePath(path: string | undefined): string { if (path === undefined || path === "") throw new Error("Path required"); return path; }

/** This machine: git runs here, and a preview is this process opening the file. */
function localHost(workspace: WorkbenchWorkspace, executeGit: GitCommandExecutor): WorkbenchHost {
  return {
    executeGit,
    readFile: (filePath) => readWorkspaceFile(workspace.root, filePath),
    resolveExisting: async (filePath) => {
      // The real path, confined to the root; a path that does not exist yet — an untracked or deleted file — is asked
      // about by its directory, which is what the local workbench has always done.
      try {
        await resolveExistingWorkspacePath(workspace.root, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await resolveExistingWorkspacePath(workspace.root, dirname(filePath));
      }
    },
  };
}
