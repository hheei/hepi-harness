/**
 * Baseline checkouts for comparison runs.
 *
 * A baseline is the pinned revision checked out **on its own**, in a detached
 * worktree, never the current tree with something set aside. That is what makes a
 * comparison meaningful, and it is also the only safe option: `git stash` is shared
 * across every worktree of a repository, so stashing or resetting to obtain a
 * baseline compares the current tree against itself and can clobber another
 * worktree's entry. Nothing in this module writes to the caller's working tree.
 *
 * A reused worktree is re-checked every time: it must be at the expected commit and it
 * must be clean. A dirty baseline measured something that commit does not name, so it
 * is refused rather than reused.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitOutput } from "./cli.mjs";

/** Resolve `rev` to a full SHA, or undefined when the revision does not exist. */
export function resolveRevision(repoRoot, rev) {
  const sha = gitOutput(repoRoot, ["rev-parse", "--verify", rev + "^{commit}"]).trim();
  return sha === "" ? undefined : sha;
}

/**
 * Create (or reuse) a detached worktree for `sha` under `dir`.
 *
 * The worktree is `--detach`ed at the resolved SHA, so the baseline is exactly that
 * commit regardless of any branch that has moved on. Reusing a directory keeps a
 * repeated run cheap; its SHA and its cleanliness are re-verified either way.
 */
export function ensureBaselineWorktree(repoRoot, sha, dir) {
  if (!existsSync(dir)) {
    const added = gitOutput(repoRoot, ["worktree", "add", "--detach", dir, sha]);
    if (!existsSync(dir)) {
      return { ok: false, dir, detail: "git worktree add failed: " + (added.trim() || "no output") };
    }
  }
  const checkedOut = gitOutput(dir, ["rev-parse", "HEAD"]).trim();
  if (checkedOut !== sha) {
    return { ok: false, dir, detail: "worktree " + dir + " is at " + (checkedOut || "nothing") + ", expected " + sha };
  }
  const dirty = gitOutput(dir, ["status", "--porcelain"]).split("\n").map((line) => line.trim()).filter(Boolean);
  if (dirty.length > 0) {
    return { ok: false, dir, detail: "worktree " + dir + " is dirty (" + dirty.length + " path(s)); a baseline must be the commit and nothing else" };
  }
  return { ok: true, dir, sha };
}

/** Where a baseline for `sha` lives: beside the repository's other dev artifacts. */
export function baselineDir(repoRoot, sha) {
  return join(repoRoot, ".dev", "baselines", sha);
}

/**
 * Remove a baseline worktree this repository created, and prune the registration.
 *
 * Reuse is why a baseline is kept between runs, but nothing removes one when the runs are
 * done, so a checkout that compares often accumulates worktrees and the registrations in
 * `git worktree list`. `--force` is deliberate: the directory is a derived artifact under
 * `.dev/baselines/`, and a caller asking for cleanup wants the directory gone whatever a
 * previous run left in it.
 */
export function removeBaselineWorktree(repoRoot, dir) {
  if (!existsSync(dir)) return { ok: true, dir, removed: false };
  gitOutput(repoRoot, ["worktree", "remove", "--force", dir]);
  gitOutput(repoRoot, ["worktree", "prune"]);
  return { ok: !existsSync(dir), dir, removed: true };
}
