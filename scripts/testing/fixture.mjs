/**
 * Fixture machinery for the script tests, owned in one place.
 *
 * A test here never mocks the thing under test. It builds a real throwaway repository, runs
 * the shipped CLI as a child process, and reads what the CLI left behind. This module owns the
 * four pieces every such test needs so none of them grows its own copy:
 *
 * - **directories** - `fixtureDir` creates one and registers it, and the process removes every
 *   registered directory on exit, so a failing test cannot leave a tree behind.
 * - **worktrees** - `initRepo` gives a real git repository with a real HEAD, and
 *   `worktreeList` reads the worktrees git knows about, which is how a test proves a
 *   comparison ran in its own checkouts and cleaned them up.
 * - **processes** - `runCli`/`runProcess` run a command with a timeout, capturing status,
 *   signal, stdout and stderr, so a hung fixture fails the test instead of the whole run.
 * - **commands** - `shim` writes an executable fixture command (the controlled `ssh` and the
 *   external `docker`), and `writeAt` places a file.
 *
 * Only `node:fs`, `node:os`, `node:child_process` and real `git`: no framework, no dependency.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const owned = new Set();
process.on("exit", () => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed when this process exits. */
export function fixtureDir(prefix = "hepi-fixture-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.add(dir);
  return dir;
}

/** Write `content` at `rel` under `root`, creating parent directories. Returns the path. */
export function writeAt(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write an executable fixture command at `rel` under `root`. Returns its path. */
export function shim(root, rel, text) {
  const path = writeAt(root, rel, text.endsWith("\n") ? text : text + "\n");
  chmodSync(path, 0o755);
  return path;
}

/** Run a command and capture everything about it, including a timeout that kills it. */
export function runProcess(command, args = [], { cwd, env = {}, timeoutMs = 120000, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error !== undefined && result.error.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run one of this repository's scripts as a child process. */
export function runCli(script, argv = [], options = {}) {
  return runProcess(process.execPath, [script, ...argv], options);
}

/** Run `git` in `cwd` and return the whole result, so a test can assert a failure too. */
export function git(cwd, args) {
  return runProcess("git", args, { cwd });
}

/** Run `git` in `cwd` and return stdout, or "" when the command fails. */
export function gitOutput(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout : "";
}

/**
 * Turn `root` into a git repository with one commit, so SHA and dirty-state reads are
 * exercised against real git rather than a stubbed `rev-parse`. Committer identity and
 * signing are set locally, so a fixture never depends on the caller's git config.
 */
export function initRepo(root) {
  const g = (...args) => git(root, args);
  g("init", "-q", "-b", "main");
  g("config", "user.name", "fixture");
  g("config", "user.email", "fixture@example.invalid");
  g("config", "commit.gpgsign", "false");
  writeAt(root, "fixture.txt", "fixture baseline\n");
  g("add", "-A");
  g("commit", "-q", "-m", "fixture: initial", "--no-gpg-sign");
  return {
    root,
    /** Stage everything and commit when something changed; returns HEAD either way. */
    commit(message) {
      g("add", "-A");
      if (gitOutput(root, ["status", "--porcelain"]).trim() !== "") g("commit", "-q", "-m", message, "--no-gpg-sign");
      return gitOutput(root, ["rev-parse", "HEAD"]).trim();
    },
    /** Raw `git` output for the assertions that read repository state directly. */
    raw(...args) {
      return gitOutput(root, args);
    },
  };
}

/** The worktrees git knows about in `root`, as `{path, head, detached}`. */
export function worktreeList(root) {
  return gitOutput(root, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      return {
        path: lines[0].replace(/^worktree /, ""),
        head: (lines.find((line) => line.startsWith("HEAD ")) ?? "").slice(5),
        detached: lines.includes("detached"),
      };
    });
}

/** Whether `dir` is a checkout of exactly `sha` with nothing else in it. */
export function isCleanCheckout(dir, sha) {
  return gitOutput(dir, ["rev-parse", "HEAD"]).trim() === sha && gitOutput(dir, ["status", "--porcelain"]).trim() === "";
}
