import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GitCommandResult, GitCommandRunner } from "@hepi/gateway";

/**
 * One execution host's repositories, held in memory: the git argv `GatewayWorktrees` runs, answered from a model of the
 * repository instead of from a git process.
 *
 * The seam is the gateway's own `GitCommandRunner`: `GatewayWorktrees` takes the runner as a constructor argument, so a
 * host is only something that answers `rev-parse`, `worktree list --porcelain`, `worktree add` and
 * `worktree remove` — including git's own refusals, which are the messages the gateway classifies. The model is the
 * same one `packages/gateway/test/fake-ssh.ts` answers its SSH transport with, so the local and the remote contract
 * are exercised against one repository rather than two machines.
 *
 * A checkout is a real directory: a conversation created in one runs its tools there, so a create makes the directory
 * and a removal deletes it, and whether a checkout is dirty is read from what is actually inside it. The git metadata a
 * linked checkout has is written too — its `.git` file, the git directory that file points at, and that directory's
 * `commondir` — because the gateway resolves a linked worktree's shadowed context file from that layout rather than
 * from a model.
 */

/** One checkout of a repository: its real path and the branch it is on. */
type FakeWorktree = { readonly path: string; readonly branch: string };
/** One repository the host holds: its main checkout, its branches and its checkouts, main one first. */
type FakeRepository = { readonly root: string; readonly refs: Set<string>; readonly worktrees: FakeWorktree[] };

export type FakeGitHost = {
  /** Git on this host, in the shape `GatewayWorktrees` takes. */
  readonly git: GitCommandRunner;
  /** A repository with one branch and one checkout, as `git init` plus a first commit leaves it. */
  initRepository(root: string, branch: string): void;
  /**
   * A linked checkout of `root` on `branch`, at `path` when a test names one, and where the gateway places one
   * otherwise: `<root>-worktrees/<branch>`.
   */
  worktree(root: string, branch: string, path?: string): string;
};

const gitOk = (stdout = ""): GitCommandResult => ({ stdout, stderr: "", exitCode: 0 });
const gitFailure = (message: string): GitCommandResult => ({ stdout: "", stderr: message + "\n", exitCode: 128 });

/** The SHA a ref resolves to, as git prints one: stable per ref, and enough for a porcelain listing. */
const sha = (ref: string): string => createHash("sha256").update(ref).digest("hex").slice(0, 40);

/** A branch name as a directory name, upstream's rule: separators and blanks become dashes. */
const directoryForBranch = (branch: string): string => branch.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");

export function createFakeGitHost(): FakeGitHost {
  const repositories = new Map<string, FakeRepository>();
  const key = (path: string): string => resolve(path);
  const parentOf = (path: string): string | undefined => (path === "/" ? undefined : dirname(path));

  /** The repository a directory belongs to, and the checkout of it the directory is in. */
  const repositoryAt = (path: string): { repository: FakeRepository; checkout: string } | undefined => {
    let current = key(path);
    for (;;) {
      const repository = repositories.get(current);
      if (repository !== undefined) {
        const worktree = repository.worktrees.find(entry => entry.path === current);
        if (worktree !== undefined) return { repository, checkout: worktree.path };
      }
      const parent = parentOf(current);
      if (parent === undefined) return undefined;
      current = parent;
    }
  };

  /** A checkout is dirty when it holds anything at all: git refuses to remove one without `--force`. */
  const checkoutDirty = (path: string): boolean => existsSync(path) && readdirSync(path).length > 0;

  const porcelain = (repository: FakeRepository): string =>
    repository.worktrees.map(entry => "worktree " + entry.path + "\nHEAD " + sha("refs/heads/" + entry.branch) + "\nbranch refs/heads/" + entry.branch + "\n\n").join("");

  /** The git metadata a linked checkout has on a real host: its own git directory, and the `.git` file that names it. */
  const writeWorktreeMetadata = (repository: FakeRepository, path: string, branch: string): void => {
    const commonGitDir = join(repository.root, ".git");
    const name = basename(path) + "-" + String(repository.worktrees.length);
    const gitDir = join(commonGitDir, "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/" + branch + "\n");
    // git writes the common directory relative to the worktree's own git directory.
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(path, ".git"), "gitdir: " + gitDir + "\n");
  };

  const addWorktree = (repository: FakeRepository, path: string, branch: string): GitCommandResult => {
    const canonical = key(path);
    const existing = repository.worktrees.find(entry => entry.branch === branch);
    if (existing !== undefined) return gitFailure("fatal: '" + branch + "' is already checked out at '" + existing.path + "'");
    if (existsSync(canonical)) return gitFailure("fatal: '" + canonical + "' already exists");
    mkdirSync(canonical, { recursive: true });
    writeWorktreeMetadata(repository, canonical, branch);
    repository.refs.add("refs/heads/" + branch);
    repository.worktrees.push({ path: canonical, branch });
    return gitOk("Preparing worktree (new branch '" + branch + "')\n");
  };

  const removeWorktree = (repository: FakeRepository, path: string, force: boolean): GitCommandResult => {
    const canonical = key(path);
    const entry = repository.worktrees.find(worktree => worktree.path === canonical);
    if (entry === undefined) return gitFailure("fatal: '" + canonical + "' is not a working tree");
    if (!force && checkoutDirty(canonical)) return gitFailure("fatal: '" + canonical + "' contains modified or untracked files, use --force to delete it");
    rmSync(canonical, { recursive: true, force: true });
    repository.worktrees.splice(repository.worktrees.indexOf(entry), 1);
    return gitOk();
  };

  /** Git's own argv, answered from the model. A subcommand this host does not serve is a refusal, never a success. */
  const git = (cwd: string, args: readonly string[]): GitCommandResult => {
    const found = repositoryAt(cwd);
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      if (found === undefined) return gitFailure("fatal: not a git repository (or any of the parent directories): .git");
      const { repository, checkout } = found;
      return gitOk([join(repository.root, ".git"), join(checkout, ".git"), checkout].join("\n") + "\n");
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      const ref = args[args.length - 1]!;
      return found !== undefined && found.repository.refs.has(ref) ? gitOk(sha(ref) + "\n") : { stdout: "", stderr: "", exitCode: 1 };
    }
    if (found === undefined) return gitFailure("fatal: not a git repository (or any of the parent directories): .git");
    const { repository } = found;
    if (args[0] === "worktree" && args[1] === "list") return gitOk(porcelain(repository));
    if (args[0] === "worktree" && args[1] === "add") {
      const separator = args.indexOf("--");
      if (separator < 0 || args[separator + 1] === undefined) return gitFailure("fatal: a worktree needs a path");
      const path = args[separator + 1]!;
      const created = args.indexOf("-b");
      // `-b <branch> -- <path>` starts a branch; `-- <path> <branch>` checks out one that already exists.
      const branch = created >= 0 ? args[created + 1]! : args[separator + 2]!;
      if (created < 0 && !repository.refs.has("refs/heads/" + branch)) return gitFailure("fatal: invalid reference: " + branch);
      return addWorktree(repository, path, branch);
    }
    if (args[0] === "worktree" && args[1] === "remove") return removeWorktree(repository, args[args.length - 1]!, args.includes("--force"));
    return gitFailure("git: '" + args[0] + "' is not a command this host serves");
  };

  const runner: GitCommandRunner = async (cwd, args) => git(cwd, args);

  const repositoryOf = (root: string): FakeRepository => {
    const repository = repositories.get(key(root));
    if (repository === undefined) throw new Error("no repository at " + root);
    return repository;
  };

  return {
    git: runner,
    initRepository(root, branch) {
      const canonical = key(root);
      mkdirSync(join(canonical, ".git"), { recursive: true });
      writeFileSync(join(canonical, ".git", "HEAD"), "ref: refs/heads/" + branch + "\n");
      repositories.set(canonical, { root: canonical, refs: new Set(["refs/heads/" + branch]), worktrees: [{ path: canonical, branch }] });
    },
    worktree(root, branch, path) {
      const repository = repositoryOf(root);
      const placed = key(path ?? join(repository.root + "-worktrees", directoryForBranch(branch)));
      const added = addWorktree(repository, placed, branch);
      if (added.exitCode !== 0) throw new Error(added.stderr);
      return placed;
    },
  };
}
