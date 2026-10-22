import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { GitCommandResult, GitCommandRunner, SshProfile, SshRunner, SshRunnerRequest, SshRunnerResult } from "../src/index.ts";
import type { ExistingPaths } from "../src/worktrees.ts";
import { REMOTE_FILESYSTEM_SCRIPT } from "../src/ssh-filesystem-helper.ts";
import { REMOTE_INSTALL_SCRIPT } from "../src/install.ts";

/**
 * One SSH execution host, held in memory: the same program contracts the gateway's real transport carries, without a
 * daemon, a namespace, a port or a process.
 *
 * Three surfaces of this package speak over the SSH runner — the workspace helper, the filesystem helper and the
 * installation helper, each a Python program run with `python3 -c <bootstrap> <source> ...` — and the worktree
 * surface speaks over the same runner with a plain `git` argv. This fake answers each of those argv shapes itself:
 *
 * - the helper programs are dispatched by the base64 source the request carries, so a request for a program this host
 *   does not serve is answered `exit 127` exactly as a host without that program would be;
 * - `git` is answered from an in-memory repository model — `rev-parse`, `worktree list --porcelain`,
 *   `worktree add` and `worktree remove` — including git's own refusals, so a create on a branch that is already
 *   checked out and a removal of a dirty worktree keep the messages the gateway recognises;
 * - the existence probe the worktree listing runs (`sh -c 'for p in "$@"; ...'`) is answered from the same model, so
 *   a checkout that is already gone is reported gone by the host rather than by this machine.
 *
 * The same host also offers a `GitCommandRunner` and an `ExistingPaths` view of the model, which is what a local
 * `GatewayWorktrees` needs: one model, two transports, so the local and the remote contract cannot drift apart in the
 * test the way the two surfaces are not allowed to drift apart in production.
 *
 * What is deliberately not modelled: file content digests, reader sessions, installation publishing and the remote
 * shell. Those are the filesystem and installation suites' own contracts; here an unserved operation answers the
 * helper's own `not_supported` (or the runner's `exit 127`), never a fabricated success. The resource snapshot is
 * modelled as far as its transport contract — the walk a snapshot reads, over this host's own tree — and no further:
 * the helper's gitignore grammar belongs to `ignore-parity` and the SSH resource suites.
 */

const FRAME_REQUEST = 10;
const FRAME_RESULT = 11;
const FRAME_CLOSE = 12;

/** One helper answer, in the shape both helpers emit: `{"ok": true, "value": ...}` or a named failure. */
type Payload = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } };

type FakeWorktree = { readonly path: string; readonly branch: string };

/** One repository the host holds: its main checkout, its branches and its checkouts, main one first. */
type FakeRepository = { readonly root: string; readonly branch: string; readonly refs: Set<string>; readonly worktrees: FakeWorktree[] };

export type FakeSshHost = {
  /** The directory the profile names as its root, and the one a listing of the main checkout runs in. */
  readonly root: string;
  readonly profile: SshProfile;
  /** The transport the gateway's SSH surfaces are composed with. */
  readonly runner: SshRunner;
  /** The same host's answers for a local worktree surface: git in a directory, and which of its paths exist. */
  readonly git: GitCommandRunner;
  readonly existingPaths: ExistingPaths;
  /** Every request the transport was handed, in order, so a test can assert which command ran where. */
  readonly requests: readonly SshRunnerRequest[];
  /** A repository with one branch and one checkout, as `git init` plus a first commit leaves it. */
  initRepository(root: string, branch: string): void;
  /** A linked checkout of `root` on `branch`, placed where the gateway places one: `<root>-worktrees/<branch>`. */
  worktree(root: string, branch: string): string;
  /** The branch a checkout is on, read from the model rather than from the answer under test. */
  branchOf(path: string): string | undefined;
  worktreesOf(root: string): readonly FakeWorktree[];
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
  /** Remove a directory and everything below it, as deleting a checkout outside the gateway does. */
  remove(path: string): void;
  exists(path: string): boolean;
  /** Everything this host holds, so a test can assert that a refusal wrote nothing. */
  state(): { directories: string[]; files: [string, string][]; worktrees: [string, string][] };
};

/**
 * One host. Every path is absolute: the helpers canonicalize what they are given, and a test that names a path names
 * the canonical one, so no `realpath` of this machine's filesystem takes part in a remote answer.
 */
export function createFakeSshHost(options: { readonly root: string; readonly user?: string; readonly home?: string; readonly host?: string }): FakeSshHost {
  const account = { user: options.user ?? "builder", home: options.home ?? "/home/builder" };
  const profile: SshProfile = { id: "prod", host: options.host ?? "builder@fake-host", remoteRoot: options.root };
  const requests: SshRunnerRequest[] = [];
  // The configured root and the account's home are directories the host really has, as they are on a real host.
  const directories = new Set<string>(["/"]);
  const files = new Map<string, string>();
  const repositories = new Map<string, FakeRepository>();

  const key = (path: string): string => resolve(path);
  const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
  const parentOf = (path: string): string | undefined => (path === "/" ? undefined : dirname(path));

  const addDirectory = (path: string): void => {
    for (let current = key(path); ; ) {
      directories.add(current);
      const parent = parentOf(current);
      if (parent === undefined) return;
      current = parent;
    }
  };

  addDirectory(options.root);
  addDirectory(account.home);

  const addFile = (path: string, content: string): void => {
    const canonical = key(path);
    addDirectory(dirname(canonical));
    files.set(canonical, content);
  };

  const deleteTree = (path: string): void => {
    const canonical = key(path);
    directories.delete(canonical);
    files.delete(canonical);
    for (const known of [...directories]) if (within(canonical, known) && known !== canonical) directories.delete(known);
    for (const known of [...files.keys()]) if (within(canonical, known) && known !== canonical) files.delete(known);
  };

  /** The device/inode identity one opened file keeps: stable per path, so a read can check it was the same file. */
  const identityOf = (path: string): number => Number.parseInt(createHash("sha256").update(key(path)).digest("hex").slice(0, 8), 16);

  const info = (path: string): { name: string; path: string; kind: string; size: number; mtimeMs: number } => {
    const canonical = key(path);
    const directory = directories.has(canonical);
    const content = files.get(canonical);
    return {
      name: canonical === "/" ? "/" : canonical.slice(canonical.lastIndexOf("/") + 1),
      path: canonical,
      kind: directory ? "directory" : "file",
      size: directory ? 0 : (content ?? "").length,
      mtimeMs: 0,
    };
  };

  const entries = (path: string): ReturnType<typeof info>[] => {
    const canonical = key(path);
    const names = [...new Set([...directories, ...files.keys()]
      .filter(known => known !== canonical && dirname(known) === canonical)
      .map(known => known.slice(known.lastIndexOf("/") + 1)))].sort();
    return names.map(name => info(join(canonical, name)));
  };

  /** The same confinement the helper applies: a path outside the session's root is a named refusal, not a read. */
  const confine = (root: string, path: string): void => {
    const canonical = key(path);
    if (directories.has(canonical) || files.has(canonical)) {
      if (!within(root, canonical)) throw Object.assign(new Error("path outside workspace"), { code: "permission_denied" });
      return;
    }
    for (let head = dirname(canonical); ; ) {
      if (directories.has(head) || files.has(head)) {
        if (!within(root, head)) throw Object.assign(new Error("path outside workspace"), { code: "permission_denied" });
        return;
      }
      const parent = parentOf(head);
      if (parent === undefined) throw Object.assign(new Error("path outside workspace"), { code: "permission_denied" });
      head = parent;
    }
  };

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

  /** The SHA a ref resolves to, as git prints one: stable per ref, and enough for a porcelain listing. */
  const sha = (ref: string): string => createHash("sha256").update(ref).digest("hex").slice(0, 40);

  const checkoutDirty = (path: string): boolean => [...files.keys()].some(known => within(key(path), known) && known !== key(path));

  const porcelain = (repository: FakeRepository): string =>
    repository.worktrees.map(worktree => "worktree " + worktree.path + "\nHEAD " + sha("refs/heads/" + worktree.branch) + "\nbranch refs/heads/" + worktree.branch + "\n\n").join("");

  const gitFailure = (message: string): GitCommandResult => ({ stdout: "", stderr: message + "\n", exitCode: 128 });
  const gitOk = (stdout = ""): GitCommandResult => ({ stdout, stderr: "", exitCode: 0 });

  const addWorktree = (repository: FakeRepository, path: string, branch: string): GitCommandResult => {
    const canonical = key(path);
    const existing = repository.worktrees.find(entry => entry.branch === branch);
    if (existing !== undefined) return gitFailure("fatal: '" + branch + "' is already checked out at '" + existing.path + "'");
    if (directories.has(canonical) || files.has(canonical)) return gitFailure("fatal: '" + canonical + "' already exists");
    addDirectory(canonical);
    repository.refs.add("refs/heads/" + branch);
    repository.worktrees.push({ path: canonical, branch });
    return gitOk("Preparing worktree (new branch '" + branch + "')\n");
  };

  const removeWorktree = (repository: FakeRepository, path: string, force: boolean): GitCommandResult => {
    const canonical = key(path);
    const entry = repository.worktrees.find(worktree => worktree.path === canonical);
    if (entry === undefined) return gitFailure("fatal: '" + canonical + "' is not a working tree");
    if (!force && checkoutDirty(canonical)) return gitFailure("fatal: '" + canonical + "' contains modified or untracked files, use --force to delete it");
    deleteTree(canonical);
    repository.worktrees.splice(repository.worktrees.indexOf(entry), 1);
    return gitOk();
  };

  /** Git's own argv, answered from the model. Every other subcommand is a refusal this host does not serve. */
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

  const discovery = (root: string) => {
    const agentDirectory = join(account.home, ".pi", "agent");
    // A scope root is a directory and a context or prompt file is a file: the host's answer names whichever exists.
    const existing = (...candidates: string[]): string[] => candidates.filter(candidate => directories.has(key(candidate)) || files.has(key(candidate)));
    return {
      user: account.user,
      home: account.home,
      workspaceRoot: root,
      roots: [
        ...existing(join(root, ".pi", "skills")).map(path => ({ scope: "project", kind: "skills", path, requiresTrust: true })),
        ...existing(join(root, ".agents", "skills")).map(path => ({ scope: "project", kind: "skills", path })),
        ...existing(join(agentDirectory, "skills"), join(account.home, ".agents", "skills")).map(path => ({ scope: "global", kind: "skills", path })),
        ...existing(join(root, ".pi", "prompts")).map(path => ({ scope: "project", kind: "prompts", path, requiresTrust: true })),
        ...existing(join(agentDirectory, "prompts")).map(path => ({ scope: "global", kind: "prompts", path })),
      ],
      contextFiles: existing(join(agentDirectory, "AGENTS.md"), join(root, "AGENTS.md")),
      systemPromptFiles: existing(join(agentDirectory, "SYSTEM.md"), join(root, ".pi", "SYSTEM.md")).map(path => ({ scope: path.startsWith(agentDirectory) ? "global" : "project", path })),
      appendSystemPromptFiles: existing(join(agentDirectory, "APPEND_SYSTEM.md"), join(root, ".pi", "APPEND_SYSTEM.md")).map(path => ({ scope: path.startsWith(agentDirectory) ? "global" : "project", path })),
    };
  };

  /** One frontmatter declaration, cut where the helper's own head ends: at the closing delimiter. */
  const declaration = (text: string): string => /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0] ?? text;

  /**
   * The resource walk, over this host's own model: a directory declaring SKILL.md is that one skill and carries only
   * its declaration, a skills root carries the frontmatter of its markdown files, and a prompts root carries them
   * whole. The helper's gitignore grammar is not re-implemented here, so what this answers is the transport contract a
   * snapshot test reads rather than a second ignore engine.
   */
  const snapshot = (root: string): Payload => {
    const host = discovery(root);
    const carried = new Map<string, { path: string; real: string; read: string; text: string }>();
    const take = (path: string, read: "whole" | "frontmatter"): void => {
      const canonical = key(path);
      const content = files.get(canonical);
      if (content === undefined) return;
      const existing = carried.get(canonical);
      if (existing !== undefined && existing.read === read) return;
      carried.set(canonical, { path: canonical, real: canonical, read, text: read === "whole" ? content : declaration(content) });
    };
    const walk = (path: string, kind: string): void => {
      const canonical = key(path);
      if (!directories.has(canonical)) return;
      const listed = entries(canonical).filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules");
      const terminal = kind === "skills" && listed.some(entry => entry.name === "SKILL.md");
      for (const entry of listed) {
        if (terminal && entry.name !== "SKILL.md") continue;
        if (entry.kind === "directory") {
          if (kind === "skills" && !terminal) walk(entry.path, kind);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        take(entry.path, kind === "skills" ? "frontmatter" : "whole");
      }
    };
    for (const item of host.roots) walk(item.path, item.kind);
    for (const path of host.contextFiles) take(path, "whole");
    for (const item of [...host.systemPromptFiles, ...host.appendSystemPromptFiles]) take(item.path, "whole");
    return { ok: true, value: { host, directories: [], files: [...carried.values()] } };
  };

  /** The filesystem helper's dispatch: the operations these surfaces use, and a named limit for the rest. */
  const filesystem = (root: string, mode: string, args: readonly string[]): Payload => {
    try {
      switch (mode) {
        case "info": { const path = args[0]!; confine(root, path); return { ok: true, value: info(path) }; }
        case "list": { const path = args[0]!; confine(root, path); return directories.has(key(path)) ? { ok: true, value: entries(path) } : { ok: false, error: { code: "not_found", message: "no such directory: " + path } }; }
        // The helper's canonical form of a path: the location it really names, refused when the host has no such thing
        // or it lies outside the root. The workbench reads through it, so a preview follows a link to its target here
        // exactly as the local workbench's realpath does.
        case "canonical": {
          const path = args[0]!;
          const canonical = key(path);
          if (!directories.has(canonical) && !files.has(canonical)) return { ok: false, error: { code: "not_found", message: "no such path: " + path } };
          confine(root, canonical);
          return { ok: true, value: canonical };
        }
        case "exists": return { ok: true, value: directories.has(key(args[0]!)) || files.has(key(args[0]!)) };
        case "read_text": { const path = args[0]!; confine(root, path); const content = files.get(key(path)); return content === undefined ? { ok: false, error: { code: "not_found", message: "no such file: " + path } } : { ok: true, value: content }; }
        // One opened reader, as the helper keeps it: the path and the identity it was opened as, which every later read
        // checks. The workbench's bounded preview is the surface that reads through it, so a host that did not serve it
        // would answer a named limit instead of a preview.
        case "open_reader": {
          const path = args[0]!;
          confine(root, path);
          const content = files.get(key(path));
          if (content === undefined) return { ok: false, error: { code: "not_found", message: "no such file: " + path } };
          return { ok: true, value: { path, size: Buffer.byteLength(content, "utf8"), mtimeMs: 0, dev: 0, ino: identityOf(path) } };
        }
        case "reader_read": {
          const path = args[0]!;
          confine(root, path);
          const content = files.get(key(path));
          if (content === undefined) return { ok: false, error: { code: "not_found", message: "no such file: " + path } };
          if (Number(args[2]) !== identityOf(path)) return { ok: false, error: { code: "invalid", message: "file changed since the reader was opened" } };
          const bytes = Buffer.from(content, "utf8");
          const offset = Number(args[3]);
          const length = Number(args[4]);
          return { ok: true, value: bytes.subarray(offset, offset + length).toString("base64") };
        }
        case "discover": return { ok: true, value: discovery(root) };
        case "snapshot": return snapshot(root);
        default: return { ok: false, error: { code: "not_supported", message: "unknown remote filesystem operation: " + mode } };
      }
    } catch (error) { return failure(error); }
  };

  /** The workspace helper's dispatch: the account, the directories below a path, and a root the host confirms. */
  const workspaces = (mode: string, args: readonly string[]): Payload => {
    if (mode === "host") return { ok: true, value: { user: account.user, home: account.home } };
    if (mode === "browse") {
      const requested = args[0]!;
      if (!isAbsolute(requested)) return { ok: false, error: { code: "invalid_request", message: "an absolute path is required" } };
      const canonical = key(requested);
      if (!directories.has(canonical)) return { ok: false, error: { code: "not_found", message: requested } };
      const parent = parentOf(canonical);
      return {
        ok: true,
        value: {
          path: canonical,
          parentPath: parent === undefined ? null : parent,
          directories: entries(canonical).filter(entry => entry.kind === "directory").map(entry => ({ name: entry.name, path: entry.path })),
        },
      };
    }
    if (mode === "register") {
      const requested = args[0]!;
      if (!isAbsolute(requested)) return { ok: false, error: { code: "invalid_root", message: "an absolute path is required" } };
      return directories.has(key(requested)) ? { ok: true, value: { root: key(requested) } } : { ok: false, error: { code: "invalid_root", message: requested } };
    }
    return { ok: false, error: { code: "not_supported", message: "unknown remote workspace operation: " + mode } };
  };

  /** The installation helper's dispatch: what is installed under one scope, and a named limit for the rest. */
  const installs = (root: string, mode: string, args: readonly string[]): Payload => {
    if (mode !== "inspect") return { ok: false, error: { code: "not_supported", message: "unknown installation operation: " + mode } };
    const scope = args[0]!;
    const directory = args[1]!;
    const scopeRoot = scope === "workspace" ? join(root, ".pi", "skills") : join(account.home, ".pi", "agent", "skills");
    const path = join(scopeRoot, directory);
    if (!directories.has(key(path))) return { ok: false, error: { code: "not_found", message: "no installed directory at " + path } };
    return { ok: true, value: { path: key(path), files: {}, contentHash: "sha256-" + createHash("sha256").update(key(path)).digest("hex") } };
  };

  const failure = (error: unknown): Payload => {
    const code = (error as { code?: string }).code;
    const mapped = code === "ENOENT" ? "not_found" : code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ENOTDIR" ? "not_directory" : code === "EISDIR" ? "is_directory" : code === "permission_denied" ? "permission_denied" : "unknown";
    return { ok: false, error: { code: mapped, message: error instanceof Error ? error.message : String(error) } };
  };

  /** Which program a request carries, by the source it hands the interpreter: a program this host does not serve is a 127. */
  const program = (command: readonly string[]): { kind: "filesystem" | "workspaces" | "install"; root: string; args: readonly string[] } | undefined => {
    if (command[0] !== "python3" || command[1] !== "-c") return undefined;
    const source = Buffer.from(command[3] ?? "", "base64").toString("utf8");
    const args = command.slice(4);
    if (source === REMOTE_FILESYSTEM_SCRIPT) return { kind: "filesystem", root: args[0] ?? "", args: args.slice(1) };
    if (source === REMOTE_INSTALL_SCRIPT) return { kind: "install", root: args[0] ?? "", args: args.slice(1) };
    // The workspace helper's own source is not exported by its module; its refusals are its fingerprint, and a rename
    // there fails this fake loudly instead of silently answering as another program.
    if (source.includes("unknown remote workspace operation")) return { kind: "workspaces", root: profile.remoteRoot, args };
    return undefined;
  };

  /**
   * The existence probe the worktree listing runs, by its own argv: `sh -c <script> sh <paths>`. Anything else a
   * caller names is not a program this host serves, which is the `exit 127` a host without that program gives.
   */
  const probe = (command: readonly string[]): string[] | undefined =>
    command[0] === "sh" && command[1] === "-c" && command[3] === "sh" && String(command[2]).startsWith("for p in") ? command.slice(4) : undefined;

  const execute = async (request: SshRunnerRequest): Promise<SshRunnerResult> => {
    requests.push(request);
    if (request.command[0] === "git") return git(request.cwd, request.command.slice(1));
    const paths = probe(request.command);
    if (paths !== undefined) {
      const present = paths.filter(path => directories.has(key(path)));
      return { stdout: present.map(path => path + "\n").join(""), stderr: "", exitCode: 0 };
    }
    const served = program(request.command);
    if (served === undefined) return { stdout: "", stderr: request.command[0] + ": command not found", exitCode: 127 };
    const payload = served.kind === "filesystem"
      ? filesystem(served.root, served.args[0] ?? "", served.args.slice(1))
      : served.kind === "install"
        ? installs(served.root, served.args[0] ?? "", served.args.slice(1))
        : workspaces(served.args[0] ?? "", served.args.slice(1));
    return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
  };

  const runner: SshRunner = {
    execute,
    open: (request) => {
      requests.push(request as SshRunnerRequest);
      const served = program(request.command);
      // A session that never answered is a host that cannot run the helper at all, which is what `exit 127` reports.
      if (served === undefined) return fakeChild(() => ({ ok: false, error: { code: "not_supported", message: "this host does not serve that program" } }), 127);
      return fakeChild((mode, args) => served.kind === "filesystem" ? filesystem(served.root, mode, args) : workspaces(mode, args), 0);
    },
  };

  const gitRunner: GitCommandRunner = async (cwd, args) => git(cwd, args);
  const existingPaths: ExistingPaths = async (_directory, paths) => paths.filter(path => directories.has(key(path)));

  const worktreePath = (root: string, branch: string): string => join(key(root) + "-worktrees", branch.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, ""));

  return {
    root: key(options.root),
    profile,
    runner,
    git: gitRunner,
    existingPaths,
    requests,
    initRepository(root, branch) {
      const canonical = key(root);
      addDirectory(canonical);
      repositories.set(canonical, { root: canonical, branch, refs: new Set(["refs/heads/" + branch]), worktrees: [{ path: canonical, branch }] });
    },
    worktree(root, branch) {
      const repository = repositories.get(key(root));
      if (repository === undefined) throw new Error("no repository at " + root);
      const path = worktreePath(repository.root, branch);
      const added = addWorktree(repository, path, branch);
      if (added.exitCode !== 0) throw new Error(added.stderr);
      return key(path);
    },
    branchOf(path) {
      const canonical = key(path);
      for (const repository of repositories.values()) {
        const entry = repository.worktrees.find(worktree => worktree.path === canonical);
        if (entry !== undefined) return entry.branch;
      }
      return undefined;
    },
    worktreesOf(root) {
      return repositories.get(key(root))?.worktrees ?? [];
    },
    writeFile(path, content) { addFile(path, content); },
    mkdir(path) { addDirectory(path); },
    remove(path) { deleteTree(path); },
    exists(path) { return directories.has(key(path)) || files.has(key(path)); },
    state() {
      const worktrees: [string, string][] = [];
      for (const repository of repositories.values()) for (const entry of repository.worktrees) worktrees.push([entry.path, entry.branch]);
      return { directories: [...directories].sort(), files: [...files].map(([path, content]) => [path, content] as [string, string]).sort(), worktrees };
    },
  };
}

/**
 * One long-lived helper process, as the session surface holds it: the frames a request writes are answered on the
 * standard output the session reads, and a close frame — or the end of the standard input — ends it. Nothing here is a
 * stream of a real child process; the session's own framing, queueing and teardown are the code under test.
 */
type MutableChild = { -readonly [Key in keyof ChildProcess]: ChildProcess[Key] };

function fakeChild(serve: (mode: string, args: readonly string[]) => Payload, exitCode: number): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as MutableChild;
  let ended = false;
  let buffer = Buffer.alloc(0);
  const end = (code: number): void => {
    if (ended) return;
    ended = true;
    child.exitCode = code;
    stdout.end();
    stderr.end();
    // The session reads a close as the end of the program, which is what a helper that finished looks like.
    setImmediate(() => child.emit("close", code, null));
  };
  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const kind = buffer.readUInt8(0);
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (kind === FRAME_CLOSE) { end(0); return; }
      if (kind !== FRAME_REQUEST) continue;
      const frame = JSON.parse(payload.toString("utf8")) as { mode: string; args?: string[] };
      const body = Buffer.from(JSON.stringify(serve(frame.mode, frame.args ?? [])), "utf8");
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_RESULT, 0);
      header.writeUInt32BE(body.length, 1);
      stdout.write(Buffer.concat([header, body]));
    }
  });
  stdin.on("end", () => end(exitCode));
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => { end(exitCode); return true; },
  });
  return child;
}
