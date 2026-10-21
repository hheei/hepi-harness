import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * The one refusal a path that leaves its workspace gets, in the words the workbench has always used.
 *
 * Both hosts raise it: the local one from its own lexical and real-path checks, and the remote one from the helper's
 * own confinement — the helper answers `permission_denied` for the same fact, and the workbench reports the request's
 * refusal as `path_denied` rather than as a transport failure. Keeping it here means the two hosts cannot drift into
 * reporting one refusal under two names.
 */
export const PATH_ESCAPES_WORKSPACE = "Path escapes workspace";

/** A refusal of a path that left its workspace, as both hosts raise it. */
export function pathDenied(message: string = PATH_ESCAPES_WORKSPACE): Error & { readonly code: "path_denied" } {
  return Object.assign(new Error(message), { code: "path_denied" as const });
}

/**
 * The fact that a path inside its workspace simply is not there.
 *
 * It is the ordinary lifetime of a file rather than a refusal: a tree was listed, someone deleted or moved the file, and
 * the read that followed names a path the host no longer has. This machine says so with `ENOENT`; an SSH host's helper
 * says `not_found`. Both are this one fact, so the workbench reports them under its own `not_found` code instead of
 * letting a deleted file read as a broken host or a refused path.
 */
export function isWorkspacePathMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ENOENT" || code === "not_found";
}


/** Whether a failure is the workspace refusing a path, on either host. */
export function isPathDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { code?: string }).code === "path_denied" || error.message.includes(PATH_ESCAPES_WORKSPACE);
}

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, filePath);
  assertInsideWorkspace(workspaceRoot, resolved);
  return resolved;
}

export async function resolveExistingWorkspacePath(
  workspacePath: string,
  filePath: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(workspacePath, filePath);
  const [realWorkspaceRoot, realTarget] = await Promise.all([
    realpath(path.resolve(workspacePath)),
    realpath(resolved),
  ]);
  assertInsideWorkspace(realWorkspaceRoot, realTarget);
  return realTarget;
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw pathDenied();
}
