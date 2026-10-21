import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SshProfile, SshRunner, SshRunnerResult } from "./index.ts";
import type { WorktreeEntry, WorktreeRequest, WorktreeResult } from "@hepi/protocol/gateway";
import { isolatedGitEnvironment } from "./workbench/git-environment.ts";
import { workspaceOwner, type WorkspaceRegistry } from "./workspaces.ts";

// The request and answer shapes of `/v1/worktrees` are declared once for every consumer, in `@hepi/protocol/gateway`,
// and re-exported here under the names this package has always exported.
export type { WorktreeEntry, WorktreeFailureCode, WorktreeListing, WorktreeRequest, WorktreeResult } from "@hepi/protocol/gateway";

/**
 * Git worktree operations on an execution host: the worktrees of a registered root, creating one on a branch, and
 * removing one.
 *
 * The semantics follow pi-web's `lib/worktree.ts` (MIT, `agegr/pi-web@76bdc570`), which the retired Web copy
 * `apps/web/lib/worktree.ts` carried verbatim (ticket 04): a listing resolves the project root through the repository's shared git directory and falls
 * back to the inferred project root for a worktree that is already gone, a create needs an existing root and a branch
 * and writes nothing before both are checked, and a remove needs an explicit force and answers a distinct dirty refusal
 * when git refuses one.
 *
 * One implementation serves both transports. `GatewayWorktrees` runs git on this machine; `SshWorktreeServer` runs
 * the same git argv through the existing SSH runner, so a local host and a remote host cannot disagree about the rules.
 * The runner is given the directory the gateway itself resolved — never a path taken from a request — so its workspace
 * confinement is not weakened by a caller-supplied working directory.
 */

/** The worktree surface `GatewayRpcServer` serves on `/v1/worktrees`: the local one, or an SSH gateway's remote one. */
export type WorktreeServer = { execute(request: WorktreeRequest): Promise<WorktreeResult> };

/** One git call a host can run: its complete output, and the exit code that says whether it worked. */
export type GitCommandResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };
export type GitCommandRunner = (cwd: string, args: readonly string[], timeoutMs?: number) => Promise<GitCommandResult>;

/**
 * Which of these directories the host really has, asked on the host itself rather than on the gateway. The directory is
 * the one the listing runs in, so a host that answers by executing there is asked where that host still is: the
 * gateway's own resolved directory, never a path taken from a request. A transport that cannot answer throws its own
 * tagged failure, which the listing reports as the host-level failure it is.
 */
export type ExistingPaths = (directory: string, paths: readonly string[]) => Promise<readonly string[]>;

/** Directories that exist on this machine. Which directory the question is asked in is the host's own business. */
export const localExistingPaths: ExistingPaths = async (_directory, paths) => paths.filter(path => existsSync(path));

/** How long an ordinary git read or removal may take. */
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
/** Checking out a large repository can take minutes, so a create gets its own bound. */
export const WORKTREE_ADD_TIMEOUT_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

/** Git on this machine, with the inherited `GIT_*` overrides stripped and the message locale pinned. */
export const localGitRunner: GitCommandRunner = async (cwd, args, timeoutMs = WORKTREE_GIT_TIMEOUT_MS) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...isolatedGitEnvironment(), LC_ALL: "C" },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const stdout = failure.stdout ?? "";
    const stderr = failure.stderr ?? "";
    if (typeof failure.code === "number") return { stdout, stderr, exitCode: failure.code };
    // No git on this host at all reads exactly like a shell that cannot find it, which is what a host limit is.
    if (failure.code === "ENOENT") return { stdout, stderr: stderr || "git: command not found", exitCode: 127 };
    return { stdout, stderr: stderr || failure.message || "git could not be run", exitCode: 1 };
  }
};

/** A root this surface may run git in, how git runs there, and which of its paths are really there. */
type WorktreeHost = { readonly root: string; readonly git: GitCommandRunner; readonly existingPaths: ExistingPaths };

/** A host-level failure: no git, or a transport that could not answer. */
type GitFailure =
  | { readonly state: "missing" }
  | { readonly state: "unavailable"; readonly code: "unreachable" | "outcome_unknown" | "operation_failed"; readonly message: string };

/** Git's answer: its output, or a refusal carrying git's own message, or a host-level failure. */
type GitAnswer = { readonly state: "ok"; readonly stdout: string } | GitFailure | { readonly state: "refused"; readonly message: string };

type Repository = { readonly repoRoot: string; readonly commonDir: string; readonly gitDir: string; readonly toplevel: string };

/** A host that cannot serve worktree operations says so plainly instead of failing generically. */
function limit(): WorktreeResult {
  return { ok: false, code: "not_supported", message: "this host cannot serve worktree operations" };
}

/** A directory that is not a checkout answers upstream's own empty listing rather than a failure. */
function notGit(root: string): WorktreeResult {
  return { ok: true, value: { projectRoot: root, isGit: false, isTopLevel: false, currentWorktreePath: null, worktrees: [] } };
}

/** A transport that threw instead of answering, as the host-level failure its own code names. */
function hostFailure(error: unknown): GitFailure {
  const code = (error as { code?: string }).code;
  return {
    state: "unavailable",
    code: code === "unreachable" ? "unreachable" : code === "outcome_unknown" ? "outcome_unknown" : "operation_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function gitAnswer(host: WorktreeHost, cwd: string, args: readonly string[], timeoutMs?: number): Promise<GitAnswer> {
  let result: GitCommandResult;
  try {
    result = await host.git(cwd, args, timeoutMs);
  } catch (error) {
    return hostFailure(error);
  }
  if (result.exitCode === 0) return { state: "ok", stdout: result.stdout };
  if (result.exitCode === 127 || /git: (command )?not found/i.test(result.stderr)) return { state: "missing" };
  return { state: "refused", message: result.stderr.trim() || result.stdout.trim() || "git exited with " + result.exitCode };
}

function unavailable(answer: Extract<GitAnswer, { state: "unavailable" }>): WorktreeResult {
  return { ok: false, code: answer.code, message: answer.message };
}

/** The repository a directory belongs to, through the shared git directory a linked worktree also points at. */
async function resolveRepository(host: WorktreeHost, cwd: string): Promise<{ state: "ok"; value: Repository } | GitFailure | { state: "refused"; message: string }> {
  const answer = await gitAnswer(host, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"]);
  if (answer.state !== "ok") return answer;
  const [commonDir, gitDir, toplevel] = answer.stdout.split("\n").map(line => line.trim());
  if (!commonDir || !gitDir || !toplevel) return { state: "refused", message: "git reported no repository for " + cwd };
  return { state: "ok", value: { commonDir, gitDir, toplevel, repoRoot: dirname(commonDir) } };
}

/** Upstream's inferred project root: a checkout placed at `<repo>-worktrees/<branch>` names the repository it is of. */
function inferMainRepository(path: string): string | undefined {
  const parent = dirname(path);
  if (!parent.endsWith("-worktrees")) return undefined;
  const repoRoot = parent.slice(0, -"-worktrees".length);
  return repoRoot === "" ? undefined : repoRoot;
}

/** Whether two spellings name one checkout. Git reports real paths, so only a trailing separator can differ. */
function sameCheckoutPath(left: string, right: string): boolean {
  const trimmed = (value: string) => (value.length > 1 ? value.replace(/\/+$/, "") : value);
  return trimmed(left) === trimmed(right);
}

async function listEntries(host: WorktreeHost, cwd: string): Promise<{ state: "ok"; value: readonly WorktreeEntry[] } | GitFailure | { state: "refused"; message: string }> {
  const answer = await gitAnswer(host, cwd, ["worktree", "list", "--porcelain"]);
  if (answer.state !== "ok") return answer;
  const found: { path: string; branch: string | null; prunable: boolean }[] = [];
  let current: { path?: string; branch?: string | null; prunable?: boolean } | null = null;
  const flush = () => {
    if (current?.path !== undefined) found.push({ path: current.path, branch: current.branch ?? null, prunable: current.prunable === true });
    current = null;
  };
  for (const line of answer.stdout.split("\n")) {
    if (line.startsWith("worktree ")) { flush(); current = { path: line.slice("worktree ".length).trim() }; }
    else if (line.startsWith("branch ") && current !== null) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line.startsWith("prunable") && current !== null) current.prunable = true;
    else if (line.trim() === "") flush();
  }
  flush();
  // A prunable entry points at a git directory that is already gone, and a path that is no longer a directory can be
  // neither browsed nor selected. The second check is the host's own answer, so both kinds of host apply one rule.
  const candidates = found.filter(entry => !entry.prunable);
  let asked: readonly string[];
  try {
    asked = await host.existingPaths(cwd, candidates.map(entry => entry.path));
  } catch (error) {
    return hostFailure(error);
  }
  const present = new Set(asked);
  const worktrees = candidates
    .filter(entry => present.has(entry.path))
    .map(entry => ({ path: entry.path, branch: entry.branch, isMain: false }));
  if (worktrees.length > 0) worktrees[0] = { ...worktrees[0]!, isMain: true };
  return { state: "ok", value: worktrees };
}

/**
 * The worktrees of the root a workspace id names. A root that is no longer a checkout still names its project through
 * the `-worktrees` convention, so a removed worktree falls back to the repository it belongs to instead of failing.
 */
async function listWorktrees(host: WorktreeHost): Promise<WorktreeResult> {
  const resolved = await resolveRepository(host, host.root);
  if (resolved.state === "missing") return limit();
  if (resolved.state === "unavailable") return unavailable(resolved);

  const inferred = resolved.state === "ok" ? undefined : inferMainRepository(host.root);
  if (resolved.state !== "ok" && inferred === undefined) return notGit(host.root);
  const directory = resolved.state === "ok" ? host.root : inferred!;
  const repository = resolved.state === "ok" ? resolved : await resolveRepository(host, directory);
  if (repository.state === "missing") return limit();
  if (repository.state === "unavailable") return unavailable(repository);
  if (repository.state !== "ok") return notGit(host.root);

  const entries = await listEntries(host, directory);
  if (entries.state === "missing") return limit();
  if (entries.state === "unavailable") return unavailable(entries);
  if (entries.state !== "ok") return notGit(host.root);

  const { commonDir, gitDir, toplevel, repoRoot } = repository.value;
  const fellBack = resolved.state !== "ok";
  const isTopLevel = fellBack || sameCheckoutPath(toplevel, host.root);
  const isWorktreeTopLevel = !sameCheckoutPath(gitDir, commonDir) && isTopLevel;
  const current = fellBack ? undefined : entries.value.find(entry => sameCheckoutPath(entry.path, host.root));
  return {
    ok: true,
    value: {
      projectRoot: isTopLevel ? (isWorktreeTopLevel ? repoRoot : toplevel) : host.root,
      isGit: true,
      isTopLevel,
      currentWorktreePath: current?.path ?? null,
      worktrees: entries.value,
    },
  };
}

/** A branch name as a directory name, upstream's rule: separators and blanks become dashes. */
function sanitizeBranchForDir(branch: string): string {
  return branch.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
}

async function refExists(host: WorktreeHost, cwd: string, ref: string): Promise<{ state: "ok"; value: boolean } | GitFailure> {
  const answer = await gitAnswer(host, cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (answer.state === "ok") return { state: "ok", value: true };
  if (answer.state === "refused") return { state: "ok", value: false };
  return answer;
}

/**
 * Create a worktree of the root's repository on `branch`, at `<repo>-worktrees/<branch>` as upstream places them.
 * Every refusal is decided before git is asked to write anything: a root that is not a checkout and a branch that is
 * missing or unusable leave the host exactly as it was.
 */
async function createWorktree(host: WorktreeHost, branch: string): Promise<WorktreeResult> {
  const trimmed = branch.trim();
  if (trimmed === "") return { ok: false, code: "invalid_request", message: "a branch name is required" };
  const directory = sanitizeBranchForDir(trimmed);
  if (directory === "") return { ok: false, code: "invalid_request", message: "invalid branch name: " + branch };

  const repository = await resolveRepository(host, host.root);
  if (repository.state === "missing") return limit();
  if (repository.state === "unavailable") return unavailable(repository);
  if (repository.state !== "ok") return { ok: false, code: "invalid_root", message: repository.message };
  const repoRoot = repository.value.repoRoot;
  const worktreePath = join(resolve(repoRoot) + "-worktrees", directory);

  // An existing branch is checked out as it is; a new one starts from the remote tip when it has already been fetched
  // and from the local HEAD otherwise. Nothing is fetched here: creating a worktree stays a local, offline operation.
  const known = await refExists(host, repoRoot, "refs/heads/" + trimmed);
  if (known.state === "missing") return limit();
  if (known.state === "unavailable") return unavailable(known);
  const remoteRef = "refs/remotes/origin/" + trimmed;
  const remote = known.value ? { state: "ok" as const, value: false } : await refExists(host, repoRoot, remoteRef);
  if (remote.state === "missing") return limit();
  if (remote.state === "unavailable") return unavailable(remote);

  const args = known.value
    ? ["worktree", "add", "--", worktreePath, trimmed]
    : ["worktree", "add", "-b", trimmed, "--", worktreePath, ...(remote.value ? [remoteRef] : [])];
  const added = await gitAnswer(host, repoRoot, args, WORKTREE_ADD_TIMEOUT_MS);
  if (added.state === "missing") return limit();
  if (added.state === "unavailable") return unavailable(added);
  if (added.state !== "ok") return { ok: false, code: "operation_failed", message: added.message };
  return { ok: true, value: { path: worktreePath, branch: trimmed } };
}

/**
 * Git refuses to remove a dirty worktree, or one holding initialized submodules, without `--force`. A locked
 * worktree needs a double force and is deliberately not matched: offering one force there would only fail again.
 */
export function worktreeRemovalRequiresForce(message: string): boolean {
  return /contains modified or untracked files|is dirty|containing submodules/i.test(message);
}

/** Remove one checkout of the root's repository. Without force a dirty worktree is refused under its own name. */
async function removeWorktree(host: WorktreeHost, path: string, force: boolean): Promise<WorktreeResult> {
  const repository = await resolveRepository(host, host.root);
  if (repository.state === "missing") return limit();
  if (repository.state === "unavailable") return unavailable(repository);
  if (repository.state !== "ok") return { ok: false, code: "invalid_root", message: repository.message };

  const entries = await listEntries(host, repository.value.repoRoot);
  if (entries.state === "missing") return limit();
  if (entries.state === "unavailable") return unavailable(entries);
  if (entries.state !== "ok") return { ok: false, code: "invalid_root", message: entries.message };
  const target = entries.value.find(entry => sameCheckoutPath(entry.path, path));
  if (target === undefined) return { ok: false, code: "not_a_worktree", message: "not a worktree of this repository: " + path };
  if (target.isMain) return { ok: false, code: "main_worktree", message: "the main checkout cannot be removed" };

  const removed = await gitAnswer(host, repository.value.repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), target.path], WORKTREE_ADD_TIMEOUT_MS);
  if (removed.state === "missing") return limit();
  if (removed.state === "unavailable") return unavailable(removed);
  if (removed.state !== "ok") {
    // Whether to lose uncommitted work is the caller's decision, so git's refusal keeps its own name.
    return worktreeRemovalRequiresForce(removed.message)
      ? { ok: false, code: "dirty", message: removed.message }
      : { ok: false, code: "operation_failed", message: removed.message };
  }
  return { ok: true, value: { removed: target.path } };
}

/** One worktree request, answered from the root a workspace id names and the git that host runs. */
async function worktreeRequest(request: WorktreeRequest, hostOf: (workspaceId: string) => WorktreeHost | undefined): Promise<WorktreeResult> {
  if (typeof request.workspaceId !== "string" || request.workspaceId === "") return { ok: false, code: "invalid_request", message: "a workspace is required" };
  const host = hostOf(request.workspaceId);
  if (host === undefined) return { ok: false, code: "unknown_workspace" };
  if (request.operation === "list") return await listWorktrees(host);
  if (request.operation === "create") {
    if (typeof request.branch !== "string") return { ok: false, code: "invalid_request", message: "a branch name is required" };
    return await createWorktree(host, request.branch);
  }
  if (request.operation === "remove") {
    if (typeof request.path !== "string" || request.path === "") return { ok: false, code: "invalid_request", message: "a worktree path is required" };
    return await removeWorktree(host, request.path, request.force === true);
  }
  return { ok: false, code: "invalid_request", message: "unknown worktree operation" };
}

/** The worktree surface of a local gateway: git runs on this machine, in the roots the registry serves. */
export class GatewayWorktrees implements WorktreeServer {
  readonly #workspaces: WorkspaceRegistry;
  readonly #git: GitCommandRunner;
  readonly #existingPaths: ExistingPaths;

  constructor(workspaces: WorkspaceRegistry, git: GitCommandRunner = localGitRunner, existingPaths: ExistingPaths = localExistingPaths) {
    this.#workspaces = workspaces;
    this.#git = git;
    this.#existingPaths = existingPaths;
  }

  execute(request: WorktreeRequest): Promise<WorktreeResult> {
    return worktreeRequest(request, (workspaceId) => {
      const workspace = this.#workspaces.get(workspaceId);
      return workspace === undefined ? undefined : { root: workspace.root, git: this.#git, existingPaths: this.#existingPaths };
    });
  }
}

/**
 * The same git argv, run on the SSH host. The directory the gateway resolved is both the working directory and the root
 * the runner confines it to: the gateway, never a request, chooses it, and the worktree git creates lives outside the
 * workspace by design. The message locale is pinned so a dirty refusal is recognised on a host with another locale.
 */
function sshGitRunner(runner: SshRunner, profile: SshProfile): GitCommandRunner {
  return async (cwd, args, timeoutMs = WORKTREE_GIT_TIMEOUT_MS) => {
    const result = await runner.execute({
      profile: profile.id,
      host: profile.host,
      cwd,
      root: cwd,
      port: profile.port,
      identityFile: profile.identityFile,
      knownHostsFile: profile.knownHostsFile,
      env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      command: ["git", ...args],
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };
}

/**
 * Which of these paths exist on the remote host. One call for the whole listing, so a project with several checkouts
 * still costs one round trip beyond the git command itself. A host that cannot answer reports nothing as present
 * rather than as present: an unreadable listing is never filled in from this machine.
 */
function sshExistingPaths(runner: SshRunner, profile: SshProfile): ExistingPaths {
  return async (directory, paths) => {
    if (paths.length === 0) return [];
    const script = "for p in \"$@\"; do [ -d \"$p\" ] && printf '%s\\n' \"$p\"; done";
    const result: SshRunnerResult = await runner.execute({
      profile: profile.id,
      host: profile.host,
      cwd: directory,
      root: directory,
      port: profile.port,
      identityFile: profile.identityFile,
      knownHostsFile: profile.knownHostsFile,
      command: ["sh", "-c", script, "sh", ...paths],
      timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
      signal: AbortSignal.timeout(WORKTREE_GIT_TIMEOUT_MS),
    });
    if (result.exitCode !== 0) throw Object.assign(new Error("the SSH host did not answer which checkouts exist"), { code: "outcome_unknown" });
    const present = new Set(result.stdout.split("\n").map(line => line.trim()).filter(line => line !== ""));
    return paths.filter(path => present.has(path));
  };
}

/**
 * The worktree surface of an SSH gateway, served on the same `/v1/worktrees` route the local gateway answers. Every id
 * is resolved through the shared registry, so a folder the backend registered is served by execution, files,
 * installation and worktrees at once, and git runs on the host the profile names rather than on this machine.
 */
export class SshWorktreeServer implements WorktreeServer {
  readonly #registry: WorkspaceRegistry;
  readonly #profiles: ReadonlyMap<string, SshProfile>;
  readonly #runner: SshRunner;

  constructor(registry: WorkspaceRegistry, options: { profiles: readonly SshProfile[]; runner: SshRunner }) {
    this.#registry = registry;
    this.#profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
    this.#runner = options.runner;
  }

  execute(request: WorktreeRequest): Promise<WorktreeResult> {
    return worktreeRequest(request, (workspaceId) => {
      const owner = workspaceOwner(this.#registry, this.#profiles, workspaceId);
      return owner === undefined ? undefined : { root: owner.root, git: sshGitRunner(this.#runner, owner.profile), existingPaths: sshExistingPaths(this.#runner, owner.profile) };
    });
  }
}
