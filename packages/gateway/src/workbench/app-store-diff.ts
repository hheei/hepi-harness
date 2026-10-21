import { execFile } from "node:child_process";
import type { WorkbenchChangedFile, WorkbenchChanges } from "@hepi/protocol/gateway";
import { isolatedGitEnvironment } from "./git-environment.ts";
import { resolveWorkspacePath } from "./workspace-paths.ts";

export interface GitCommandOptions {
  readonly cwd: string;
  readonly maxBuffer?: number;
  readonly timeout?: number;
  /**
   * The caller's own cancellation. Both hosts honour it: locally it is the execFile option it already accepts, and on
   * an SSH gateway it is composed with the command's deadline and ends the remote command through the runner. A command
   * the caller cancelled is an operation that did not answer, never an empty listing or an empty diff.
   */
  readonly signal?: AbortSignal;
}

export interface GitCommandResult {
  readonly error: Error | null;
  readonly stdout: string;
}

export type GitCommandExecutor = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

export interface StageFileOptions {
  readonly sourcePath?: string;
  readonly executeGit?: GitCommandExecutor;
}

export async function getChangedFiles(
  workspacePath: string,
  executeGit: GitCommandExecutor = executeGitCommand,
  signal?: AbortSignal,
): Promise<WorkbenchChanges> {
  let result: GitCommandResult;
  try {
    result = await executeGit(["status", "--porcelain=v1", "-z"], {
      cwd: workspacePath,
      maxBuffer: 2 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // A thrown executor never ran the command: on a remote host that is the transport's own tagged failure, which is
    // reported as the operation's failure rather than as a workspace without a usable Git. A Git that ran and failed
    // is the returned `error` below, and keeps this answer.
    if (didNotAnswer(error)) throw error;
    return gitStatusUnavailable(
      "git-status-failed",
      "Git status is unavailable for this workspace.",
    );
  }

  if (result.error !== null && didNotAnswer(result.error)) throw result.error;
  if (result.error) {
    return gitStatusUnavailable(
      "git-status-failed",
      "Git status is unavailable for this workspace.",
    );
  }

  try {
    return {
      state: "available",
      files: parseGitStatusPorcelainV1Z(result.stdout),
    };
  } catch {
    return gitStatusUnavailable(
      "git-status-invalid",
      "Git returned an unreadable changed-file status.",
    );
  }
}

export function parseGitStatusPorcelainV1Z(output: string): WorkbenchChangedFile[] {
  if (output === "") {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw new Error("NUL-delimited Git status output is missing its terminator");
  }

  const fields = output.slice(0, -1).split("\0");
  const entries: WorkbenchChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4 || record[2] !== " ") {
      throw new Error("Malformed Git status record");
    }

    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!isRenameOrCopy(xy)) {
      entries.push(toChangedFileEntry(xy, filePath));
      continue;
    }

    const previousPath = fields[index + 1];
    if (!previousPath) {
      throw new Error("Git rename or copy record is missing its source path");
    }
    entries.push(toChangedFileEntry(xy, filePath, previousPath));
    index += 1;
  }
  return entries;
}

export async function getFileDiff(
  workspacePath: string,
  filePath: string,
  executeGit: GitCommandExecutor = executeGitCommand,
  signal?: AbortSignal,
): Promise<string> {
  resolveWorkspacePath(workspacePath, filePath);
  const options: GitCommandOptions = {
    cwd: workspacePath,
    maxBuffer: 5 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  };

  const unstaged = await executeGit(["--literal-pathspecs", "diff", "--", filePath], options);
  // A diff is three forms tried in order, so a failed form is normally just Git's judgement about that form (an
  // untracked file has no staged diff, and an unmodified one has no unstaged diff). A command that never answered is
  // not that: there is no patch to report and no reason to prefer one form over another, so it is the operation's
  // failure rather than an empty diff a caller would read as "this file changed nothing".
  if (didNotAnswer(unstaged.error)) throw unstaged.error;
  if (!unstaged.error && unstaged.stdout.trim()) {
    return unstaged.stdout;
  }

  const staged = await executeGit(
    ["--literal-pathspecs", "diff", "--cached", "--", filePath],
    options,
  );
  if (didNotAnswer(staged.error)) throw staged.error;
  if (!staged.error && staged.stdout.trim()) {
    return staged.stdout;
  }

  const untracked = await executeGit(
    ["--literal-pathspecs", "diff", "--no-index", "--", "/dev/null", filePath],
    options,
  );
  if (didNotAnswer(untracked.error)) throw untracked.error;
  // git diff --no-index exits 1 when files differ, which is expected.
  return untracked.stdout || "";
}

export async function stageFile(
  workspacePath: string,
  filePath: string,
  options: StageFileOptions = {},
): Promise<void> {
  resolveWorkspacePath(workspacePath, filePath);
  if (options.sourcePath !== undefined) {
    resolveWorkspacePath(workspacePath, options.sourcePath);
  }
  const paths = options.sourcePath === undefined ? [filePath] : [filePath, options.sourcePath];
  const result = await (options.executeGit ?? executeGitCommand)(
    ["--literal-pathspecs", "add", "--", ...paths],
    { cwd: workspacePath },
  );
  if (result.error) {
    throw result.error;
  }
}

export function executeGitCommand(
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    // Status must not take the index lock the user's own git commands need. The caller's cancellation is an execFile
    // option, so a cancelled read ends the process instead of letting it finish an answer nobody waits for.
    execFile("git", [...args], { windowsHide: true, ...options, env: isolatedGitEnvironment() }, (error, stdout) => {
      resolve({
        error,
        stdout,
      });
    });
  });
}

/**
 * Whether a failure means the command never answered, rather than Git answering about the checkout.
 *
 * Both hosts have to answer this the same way, because the workbench's contract depends on it: an operation that did
 * not answer is a failure a caller can act on, while Git's own non-zero exit is a real answer. A remote transport
 * tags its failure (unreachable, outcome_unknown, operation_failed); locally the same fact is a process that ran out
 * of its deadline or was ended by its caller (killed, ETIMEDOUT, ABORT_ERR). Neither one says anything about Git, so
 * neither may become an unavailable change set or an empty diff.
 */
function didNotAnswer(error: unknown): boolean {
  const failure = error as { code?: string; killed?: boolean } | undefined;
  const code = failure?.code;
  if (code === "unreachable" || code === "outcome_unknown" || code === "operation_failed") return true;
  return failure?.killed === true || code === "ETIMEDOUT" || code === "ABORT_ERR";
}

function gitStatusUnavailable(
  code: "git-status-failed" | "git-status-invalid",
  message: string,
): WorkbenchChanges {
  return {
    state: "unavailable",
    error: { code, message },
  };
}

function toChangedFileEntry(xy: string, filePath: string, previousPath?: string): WorkbenchChangedFile {
  return {
    path: filePath,
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(previousPath !== undefined && xy[1] === "R" ? { stagingSourcePath: previousPath } : {}),
    status: parseStatus(xy),
    staged: isFullyStaged(xy),
  };
}

function parseStatus(xy: string): WorkbenchChangedFile["status"] {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";

  if (x === "?" && y === "?") {
    return "untracked";
  }
  if (x === "R" || y === "R") {
    return "renamed";
  }
  if (x === "C" || y === "C") {
    return "copied";
  }
  if (x === "A" || y === "A") {
    return "added";
  }
  if (x === "D" || y === "D") {
    return "deleted";
  }
  return "modified";
}

function isRenameOrCopy(xy: string): boolean {
  return xy.includes("R") || xy.includes("C");
}

function isFullyStaged(xy: string): boolean {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" || x === " ") return false;
  return y === " ";
}
