import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The linked-worktree context shadow, resolved from real git metadata. Adapted from
 * `@earendil-works/pi-coding-agent@1.1.0` (MIT, revision `6fb2e7815167e6b19006fc526d1a5d0f5f998787`):
 * `dist/core/resource-loader.js` `findShadowedContextFile` and `dist/core/footer-data-provider.js` `findGitPaths`.
 *
 * It lives here rather than in the resource loader because computing it needs git metadata — the nearest `.git`, a
 * `.git` file's `gitdir:` target, the `commondir` file — and the loader may read only resource roots and the
 * workspace. The gateway resolves the path on the host and reports it as `ExecutionHost.shadowedContextFile`; the loader
 * then subtracts it by path. The SSH helper carries the same rule in its Python program, since the git metadata it needs
 * is on the remote host.
 */

/** Upstream's context file names, in the order one directory's single file is chosen. */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** `realpath`, or the path unchanged when it does not resolve — upstream's `canonicalizePath`. */
async function canonicalize(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

/** The first conventional context file present in `dir`, as its canonical path. */
async function contextFileIn(dir: string): Promise<string | undefined> {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name);
    try {
      const real = await realpath(path);
      if ((await stat(real)).isFile()) return real;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * From `start` upward, the directory holding `.git` — whether that is a directory or a `gitdir:` file — and the
 * repository's common git directory (a linked worktree's `commondir` target, its own git directory otherwise).
 * Undefined when no repository encloses `start`, or when the git directory has no `HEAD`, so a bare or otherwise
 * non-checked-out layout is not mistaken for a repository.
 */
async function findGitPaths(start: string): Promise<{ repoDir: string; commonGitDir: string } | undefined> {
  let dir = resolve(start);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const entry = await stat(gitPath);
        if (entry.isFile()) {
          const content = (await readFile(gitPath, "utf8")).trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice("gitdir: ".length).trim());
            if (!existsSync(join(gitDir, "HEAD"))) return undefined;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath) ? resolve(gitDir, (await readFile(commonDirPath, "utf8")).trim()) : gitDir;
            return { repoDir: dir, commonGitDir };
          }
        } else if (entry.isDirectory()) {
          if (!existsSync(join(gitPath, "HEAD"))) return undefined;
          return { repoDir: dir, commonGitDir: gitPath };
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main repository's context file that a nested linked worktree's own file shadows: both occupy the same logical
 * repository scope, so loading both would apply that context twice.
 *
 * Undefined for anything else: an ordinary repository (the workspace is the repository), a sibling worktree (`git
 * worktree add ../feat`, whose main repository is not an ancestor), a bare layout, and a submodule (whose git directory
 * has no `commondir`, so its common git directory lands under `modules` where the second check rejects it).
 */
export async function findShadowedContextFile(workspaceRoot: string): Promise<string | undefined> {
  const gitPaths = await findGitPaths(workspaceRoot);
  if (gitPaths === undefined) return undefined;
  const commonGitDir = await canonicalize(gitPaths.commonGitDir);
  const worktreeRoot = await canonicalize(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  if (!worktreeRoot.startsWith(mainRepoRoot + sep)) return undefined;
  // dirname of the common git directory is the main worktree root only when that directory is itself checked out from
  // the same repository. A bare layout puts `.bare` there, which tracks nothing.
  if (await canonicalize(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
  const worktreeContextFile = await contextFileIn(worktreeRoot);
  return worktreeContextFile === undefined ? undefined : await canonicalize(join(mainRepoRoot, basename(worktreeContextFile)));
}
