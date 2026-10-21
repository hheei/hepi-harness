import { dirname } from "node:path";
import type { WorkbenchFile } from "@hepi/protocol/gateway";
import type { SshProfile, SshRunner } from "../index.ts";
import { workspaceOwner, type WorkspaceRegistry } from "../workspaces.ts";
import type { GitCommandExecutor, GitCommandOptions, GitCommandResult } from "./app-store-diff.ts";
import type { WorkspaceTree } from "./app-store-files.ts";
import { GatewayWorkbench, type WorkbenchWorkspace } from "./index.ts";
import { pathDenied, resolveWorkspacePath } from "./workspace-paths.ts";

/**
 * The read-only workbench's two host adapters for an SSH gateway.
 *
 * A local workbench answers from this process: a preview opens a file here, and every Git read spawns `git` here. An
 * SSH gateway serves a host it does not own, so each of those becomes a call through a transport it was composed with —
 * the preview through the same `SshFilesystem` session `/v1/files` already uses, the Git reads through the same
 * `SshRunner` the worktree surface uses. Nothing new is invented on the remote side: the helper confines every path to
 * the session's root and names its own refusal, and the runner runs git in a directory it confined. What lives here is
 * the translation between those seams and the workbench's own shapes, so the request and answer protocol the browser
 * speaks stays the same on either host.
 */

/** The bounded text preview both hosts state: the local workbench's own limit, kept as one number for both. */
export const WORKBENCH_PREVIEW_BYTES = 200 * 1024;
/**
 * One workbench Git read's bound, on the host.
 *
 * It is deliberately below the deadline the control route applies to a workbench call (20s,
 * CONTROL_TIMEOUT_MS.workbench): a host that is merely slow then answers its own named failure
 * inside the caller's window, rather than both sides reaching for the same instant and the caller
 * reporting a lost control call for a command the host would still have ended. The listing's own
 * git reads already bound themselves at 15s for the same reason, so one number covers both.
 */
const GIT_READ_TIMEOUT_MS = 15_000;

/** The remote filesystem surface a preview reads through: the gateway's `SshFilesystem`, by the methods it serves. */
export type WorkbenchFiles = { execute(request: { workspaceId: string; method: string; path?: string; handle?: string; offset?: number; length?: number }): Promise<unknown> };

/** A refusal the host gave: the code and message both seams already state. */
type Refusal = { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function refusal(result: unknown): Refusal | undefined {
  const answer = result as { ok?: unknown } | undefined;
  return answer !== null && answer !== undefined && answer.ok === false ? result as Refusal : undefined;
}

function valueOf<T>(result: unknown): T {
  return (result as { value: T }).value;
}

/**
 * The failure a refused host answer becomes, in the workbench's own vocabulary.
 *
 * The helper names a path outside the session's root `permission_denied`, which is the same fact the local workbench
 * raises as a path that escapes the workspace: one refusal, reported under one name on both hosts. Every other code
 * stays the operation's own failure, so a missing file, a transport that could not answer and a path that left the
 * root stay three different outcomes.
 */
function hostRefusal(refusal: Refusal): Error {
  if (refusal.error.code === "permission_denied") return pathDenied(refusal.error.message);
  return Object.assign(new Error(refusal.error.message), { code: refusal.error.code });
}

/**
 * The remote host's directories, as the listing's own walk asks for them.
 *
 * Both calls are the filesystem's own methods, so the helper confines each directory and file to the session's root
 * before it answers, and a directory the host does not have is reported missing rather than as an empty one. The
 * entries' `isDirectory` is the helper's `kind`, which is the same fact a local `readdir` reports.
 */
export function sshWorkspaceTree(files: WorkbenchFiles, workspaceId: string): WorkspaceTree {
  return {
    async list(directory) {
      const listed = await files.execute({ workspaceId, method: "listDir", path: directory });
      const failed = refusal(listed);
      if (failed !== undefined) throw hostRefusal(failed);
      return valueOf<readonly { readonly name: string; readonly kind: string }[]>(listed).map((entry) => ({ name: entry.name, isDirectory: entry.kind === "directory" }));
    },
    async readTextFile(file) {
      const read = await files.execute({ workspaceId, method: "readTextFile", path: file });
      const failed = refusal(read);
      if (failed !== undefined) throw hostRefusal(failed);
      return valueOf<string>(read);
    },
  };
}

/**
 * Whether the host really has this path, as the workbench's diff asks before Git runs.
 *
 * The helper's `canonicalPath` resolves the path and refuses one whose real location leaves the root, which is the
 * symlink escape a lexical check cannot see. A path that does not exist yet — an untracked file, or a deleted one —
 * is asked about by its directory, exactly as the local workbench does, and only a directory the host does not have is
 * a failure of its own.
 */
export function sshResolveExisting(files: WorkbenchFiles, workspaceId: string, root: string) {
  return async (filePath: string): Promise<void> => {
    resolveWorkspacePath(root, filePath);
    const answer = await files.execute({ workspaceId, method: "canonicalPath", path: filePath });
    const failed = refusal(answer);
    if (failed === undefined) return;
    if (failed.error.code !== "not_found") throw hostRefusal(failed);
    const parent = dirname(filePath);
    const directory = await files.execute({ workspaceId, method: "canonicalPath", path: parent === "." ? "/" : parent });
    const missing = refusal(directory);
    if (missing !== undefined) throw hostRefusal(missing);
  };
}

/**
 * One bounded text preview of a workspace file, read on the SSH host.
 *
 * The path is resolved against the workspace root here as well as there: `path_denied` is a refusal of the request,
 * not of the transport, so a path that leaves the root never becomes a helper request. The host's own
 * `canonicalPath` then stands in for the local host's `realpath`: a preview reads the file the path really names, so
 * a symbolic link that stays inside the workspace previews its target's content and size, exactly as the local
 * workbench previews it, and one that leaves it is refused by the helper's confinement. The preview is the
 * filesystem's bounded reader — the same one a byte download uses — so exactly `WORKBENCH_PREVIEW_BYTES + 1` bytes
 * cross the transport however large the file is, and the handle is closed on the way out whether the read answered or
 * not.
 */
export async function readRemoteWorkspaceFile(
  files: WorkbenchFiles,
  workspaceId: string,
  root: string,
  filePath: string,
): Promise<WorkbenchFile> {
  resolveWorkspacePath(root, filePath);
  const canonical = await files.execute({ workspaceId, method: "canonicalPath", path: filePath });
  const unreachable = refusal(canonical);
  if (unreachable !== undefined) throw hostRefusal(unreachable);
  const resolved = valueOf<string>(canonical);
  const info = await files.execute({ workspaceId, method: "fileInfo", path: resolved });
  const unreadable = refusal(info);
  if (unreadable !== undefined) throw hostRefusal(unreadable);
  const metadata = valueOf<{ kind: string; size: number }>(info);
  // A directory is not a preview: the local workbench answers the same placeholder rather than an empty text file.
  if (metadata.kind !== "file") return { path: filePath, content: "", truncated: false, binary: true, sizeBytes: metadata.size, shownBytes: 0 };

  const opened = await files.execute({ workspaceId, method: "openBinaryReader", path: resolved });
  const unopened = refusal(opened);
  if (unopened !== undefined) throw hostRefusal(unopened);
  const handle = valueOf<string>(opened);
  try {
    const read = await files.execute({ workspaceId, method: "reader.read", handle, offset: 0, length: WORKBENCH_PREVIEW_BYTES + 1 });
    const unread = refusal(read);
    if (unread !== undefined) throw hostRefusal(unread);
    const bytes = Buffer.from(valueOf<string>(read), "base64");
    const preview = bytes.subarray(0, WORKBENCH_PREVIEW_BYTES);
    // A NUL byte is how the local workbench already tells a binary file from a text one, so both hosts answer alike.
    const binary = preview.includes(0);
    return {
      path: filePath,
      content: binary ? "" : preview.toString("utf8"),
      truncated: bytes.byteLength > WORKBENCH_PREVIEW_BYTES || metadata.size > WORKBENCH_PREVIEW_BYTES,
      binary,
      sizeBytes: metadata.size,
      shownBytes: preview.byteLength,
    };
  } finally {
    // The handle is the gateway's own registry entry: closing it releases the remote reader even when the read failed.
    await files.execute({ workspaceId, method: "reader.close", handle }).catch(() => undefined);
  }
}

/**
 * Git on the SSH host, as the workbench's own executor shape.
 *
 * The argv the workbench builds is handed to `git` unchanged, in the workspace root the gateway resolved — never a path
 * a request named — and the working directory is also the root the runner confines it to. The workbench's own bounds
 * travel with the call: `timeout` is the command's deadline, and `maxBuffer` is the output bound a local `execFile`
 * would have applied, so a listing, a status and a diff each keep the bound the local host gives them.
 *
 * Git's own non-zero exit is an answer, not a transport failure: a diff of an untracked file exits 1 by design and a
 * directory that is no checkout exits 128, which is what the workbench's own status parsing reports as unavailable. A
 * transport that failed is the opposite — the command never ran — so its tagged error is rethrown and the workbench
 * reports `operation_failed`, instead of an empty change set or an empty diff that would read as a real answer.
 */
export function sshGitExecutor(runner: SshRunner, profile: SshProfile): GitCommandExecutor {
  return async (args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> => {
    const timeoutMs = options.timeout ?? GIT_READ_TIMEOUT_MS;
    const maxBytes = options.maxBuffer ?? Number.MAX_SAFE_INTEGER;
    try {
      const result = await runner.execute({
        profile: profile.id,
        host: profile.host,
        cwd: options.cwd,
        root: options.cwd,
        port: profile.port,
        identityFile: profile.identityFile,
        knownHostsFile: profile.knownHostsFile,
        // The isolation the local executor applies: an inherited GIT_DIR or GIT_WORK_TREE must not redirect the command
        // away from the checkout, and a repository with no terminal must not start a prompt. The locale is pinned so a
        // refusal reads the same on a host configured in another language.
        env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        command: ["git", ...args],
        timeoutMs,
        // The command's own deadline and the caller's cancellation: either one ends the remote command, so a workbench
        // read nobody waits for does not keep running on the host. A cancellation is reported as the transport's own
        // failure, which is what makes the operation fail rather than answer an empty change set.
        signal: options.signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]),
      });
      // The runner collects the whole output, so the local executor's bound is applied here: past it the answer is the
      // failure `execFile` would have reported, not a value the workbench would treat as complete.
      if (Buffer.byteLength(result.stdout, "utf8") > maxBytes) {
        return { error: Object.assign(new Error("git output exceeded the " + maxBytes + " byte workbench bound"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), stdout: "" };
      }
      return {
        error: result.exitCode === 0 ? null : Object.assign(new Error(result.stderr.trim() || "git exited with " + result.exitCode), { code: String(result.exitCode) }),
        stdout: result.stdout,
      };
    } catch (error) {
      // The transport's own failure: the command never ran on the host, so there is no Git answer to report.
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}

export type SshWorkbenchOptions = {
  /** The registry every surface serves, so a folder registered at runtime is browsable here too. */
  readonly workspaces: WorkspaceRegistry;
  /** The profiles this gateway serves; the registry decides which of them one workspace id names. */
  readonly profiles: readonly SshProfile[];
  /** The filesystem the previews and listings read through: the gateway's own `SshFilesystem`. */
  readonly files: WorkbenchFiles;
  /** The transport Git runs over: the same runner the worktree surface uses. */
  readonly runner: SshRunner;
};

/**
 * The read-only workbench of an SSH gateway: the same `GatewayWorkbench`, the same protocol, and every read answered
 * by the host the workspace really lives on.
 *
 * The registry is the gateway's own, so the workspace id the wire names resolves to the profile and the canonical root
 * it was registered with — never to a prefix of a profile's name, and never to a path this machine resolved. Each
 * adapter looks the owner up on its own turn, because a folder registered at runtime must be browsable without
 * rebuilding the surface, and the credentials stay where they already were: in the profile the gateway started with.
 */
export function sshWorkbench(options: SshWorkbenchOptions): GatewayWorkbench {
  const profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
  const owner = (workspace: WorkbenchWorkspace) => {
    const found = workspaceOwner(options.workspaces, profiles, workspace.id);
    if (found === undefined) throw new Error("unknown workspace");
    return found;
  };
  return new GatewayWorkbench(options.workspaces, {
    host: (workspace) => {
      const found = owner(workspace);
      return {
        executeGit: sshGitExecutor(options.runner, found.profile),
        tree: sshWorkspaceTree(options.files, workspace.id),
        readFile: (filePath) => readRemoteWorkspaceFile(options.files, workspace.id, found.root, filePath),
        resolveExisting: sshResolveExisting(options.files, workspace.id, found.root),
      };
    },
  });
}
