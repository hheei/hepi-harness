import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { SshRunner } from "../src/index.ts";

/**
 * A deterministic SSH host in this process.
 *
 * The gateway's session contract is two things: the runner's open hands back a child whose standard streams carry the
 * framed protocol, and the program on the other end answers one request frame with one result frame. That is the whole
 * seam the filesystem uses, so this module implements the far side of it in TypeScript: a real temporary tree for the
 * remote paths (so realpath, symlink and device/inode identity behave as they do on a host), the helper's own
 * operations and confinement rules, and fault injection for the failures a session has to report. No process, no port,
 * no Python and no sleep is involved, so a test's barriers are the frames the host saw rather than elapsed time.
 *
 * sshd-fixture.test.ts uses the same shape for a real daemon: the transport is handed in, and the assertions are about
 * what the contract promises rather than about the program that happens to implement it.
 */

const MAX_FILE = 16 * 1024 * 1024;
const MAX_FRAME = 64 * 1024 * 1024;
const MAX_REQUEST = 1024 * 1024;
const FRAME_REQUEST = 10;
const FRAME_RESULT = 11;
const FRAME_CLOSE = 12;
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** One request frame the gateway wrote, decoded: the helper operation, its arguments, the claimed root and allow list. */
export type FakeFrame = {
  readonly mode: string;
  readonly args: readonly string[];
  readonly root: string;
  readonly allow: { readonly roots: readonly string[]; readonly files: readonly string[] };
};

/**
 * What the host does with one request instead of answering it. "hang" is a host that accepted the frame and never
 * answered, "exit" is a helper that ends without running its cleanup, and "oversize" writes a result header past the
 * session's own bound.
 */
export type FakeFault = "answer" | "hang" | "exit" | "oversize";

export type FakeSshOptions = {
  /** The profile's remote root: the confinement root of the session, exactly as the command line carries it. */
  readonly root: string;
  /** The account the host reports. unresolvable is a host whose own account lookup fails. */
  readonly account?: { readonly user: string; readonly home: string; readonly unresolvable?: boolean };
  /** A host that never serves the helper: what it writes to stderr and the code its process ends with. */
  readonly startup?: { readonly stderr?: string; readonly exitCode?: number };
  /** Per request: answer it (the default), or act out one of the session's failures. */
  readonly fault?: (frame: FakeFrame, session: number) => FakeFault | undefined;
};

export type FakeSshSession = {
  readonly index: number;
  /** The request frames this session was handed, in order. */
  readonly frames: readonly FakeFrame[];
  readonly closed: boolean;
  /** End this session the way a killed host does: no answer, no cleanup. */
  kill(): void;
};

export type FakeSsh = {
  readonly runner: SshRunner;
  /** Every request frame every session was handed, in order: what the host saw. */
  readonly frames: readonly FakeFrame[];
  readonly sessions: readonly FakeSshSession[];
  /** How many sessions were opened: one per (profile, root), so a test measures reuse rather than a log line. */
  opens(): number;
  /** Resolve when a session is handed a frame with this mode. A barrier, not a poll. */
  next(mode: string): Promise<FakeFrame>;
  /** End every live session the way a killed host does. */
  kill(): void;
};

type Result = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string; path?: string } };

/** One request's refusal: the helper's own fail, so the operation unwinds and the session keeps serving. */
class Refusal extends Error {
  readonly code: string;
  readonly path: string | undefined;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

function refuse(code: string, message: string, path?: string): never { throw new Refusal(code, message, path); }

/** The helper's own answer shape: a value only when the operation produced one, so an ack carries no value key. */
function ok(value?: unknown): Result { return value === undefined ? { ok: true } : { ok: true, value }; }

/** A path with every existing symlink resolved and a missing tail kept as written: os.path.realpath, not strict. */
function realish(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...[...missing].reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function lexists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

function lexicalWithin(candidate: string, path: string): boolean {
  if (path === candidate) return true;
  return path.startsWith(candidate.replace(/\/+$/, "") + "/");
}

function realWithin(candidate: string, path: string): string | undefined {
  const real = realish(path);
  return real === candidate || real.startsWith(candidate + "/") ? real : undefined;
}

function realDir(path: string): string | null {
  const real = realish(path);
  try { return statSync(real).isDirectory() ? real : null; } catch { return null; }
}

function realFile(path: string): string | null {
  const real = realish(path);
  try { return statSync(real).isFile() ? real : null; } catch { return null; }
}

function kindOf(st: Stats): "file" | "directory" | "symlink" | "other" {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}

function infoOf(path: string, st: Stats): Record<string, unknown> {
  return { name: basename(path), path, kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs };
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ENOTDIR") return "not_directory";
  if (code === "EISDIR") return "is_directory";
  if (code === "EINVAL" || code === "ELOOP" || code === "ENXIO") return "invalid";
  return "unknown";
}

function contextFile(directory: string): string | null {
  for (const name of CONTEXT_NAMES) {
    const found = realFile(join(directory, name));
    if (found !== null) return found;
  }
  return null;
}

/**
 * From `start` upward, the directory holding `.git` and the repository's common git directory, exactly as the helper's
 * `find_git_paths` reads them: a worktree's `.git` file names its own git directory, whose `commondir` names the one
 * the repository keeps. Undefined when no checked-out repository encloses `start`.
 */
function gitPaths(start: string): { repoDir: string; commonGitDir: string } | null {
  let directory = realish(start);
  for (;;) {
    const gitPath = join(directory, ".git");
    if (lexists(gitPath)) {
      try {
        if (statSync(gitPath).isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            // The target is resolved against the directory holding the `.git` file, as the helper's `os.path.join`
            // does: a `gitdir:` written by git is absolute, and a relative one is relative to that directory.
            const gitDir = realish(resolve(directory, content.slice("gitdir: ".length).trim()));
            if (!lexists(join(gitDir, "HEAD"))) return null;
            const commonPath = join(gitDir, "commondir");
            const commonGitDir = lexists(commonPath) ? realish(resolve(gitDir, readFileSync(commonPath, "utf8").trim())) : gitDir;
            return { repoDir: directory, commonGitDir };
          }
        } else if (statSync(gitPath).isDirectory()) {
          if (!lexists(join(gitPath, "HEAD"))) return null;
          return { repoDir: directory, commonGitDir: gitPath };
        }
      } catch { return null; }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** The main repository's context file a nested linked worktree's own file shadows: the helper's `find_shadowed_context_file`. */
function shadowedContextFile(workspace: string): string | null {
  const paths = gitPaths(workspace);
  if (paths === null) return null;
  const commonGitDir = realish(paths.commonGitDir);
  const worktreeRoot = realish(paths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  if (!worktreeRoot.startsWith(mainRepoRoot + "/")) return null;
  if (realish(join(mainRepoRoot, ".git")) !== commonGitDir) return null;
  const own = contextFile(worktreeRoot);
  if (own === null) return null;
  return realish(join(mainRepoRoot, basename(own)));
}

/** The nearest ancestor that holds a .git entry: where the ancestor walk of the resource roots stops. */
function repositoryRoot(start: string): string | null {
  let directory = start;
  for (;;) {
    if (lexists(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

type Scan = { newlines: number; start: number; end: number; firstLineEnd: number; lastLineStart: number; selectedBytes: number; firstLineBytes: number };

/** The helper's line scan over a whole file: the same offsets and newline count its streaming scanner produces. */
function scan(bytes: Buffer, startLine: number, endLine: number | undefined): Scan {
  const offsets: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x0a) offsets.push(index);
  const size = bytes.length;
  const last = endLine === undefined ? Number.POSITIVE_INFINITY : endLine;
  const start = startLine === 0 ? 0 : startLine - 1 < offsets.length ? offsets[startLine - 1]! + 1 : size;
  const end = Number.isFinite(last) && last - 1 < offsets.length ? offsets[last - 1]! : size;
  const firstLineEnd = startLine < offsets.length ? offsets[startLine]! : size;
  const lastLineStart = Number.isFinite(last) && last >= 2 && last - 2 < offsets.length ? offsets[last - 2]! + 1 : start;
  const decoded = (from: number, to: number): number => Buffer.byteLength(bytes.subarray(from, to).toString("utf8"), "utf8");
  return {
    newlines: offsets.length,
    start,
    end,
    firstLineEnd,
    lastLineStart,
    selectedBytes: decoded(start, end),
    firstLineBytes: decoded(start, firstLineEnd),
  };
}

/**
 * The host program the gateway's session talks to, in TypeScript: the operations, the confinement rules and the
 * discovery the filesystem relies on, over a real temporary tree.
 */
class FakeHelper {
  readonly root: string;
  readonly account: { user: string; home: string; unresolvable?: boolean };
  /** The staging files this session created, removed on a graceful end and left behind by a death. */
  readonly staging = new Set<string>();
  #allow: { roots: readonly string[]; files: readonly string[] } = { roots: [], files: [] };

  constructor(root: string, account: { user: string; home: string; unresolvable?: boolean }) {
    this.root = realish(root);
    this.account = account;
  }

  request(frame: FakeFrame): Result {
    try {
      if (realish(frame.root) !== this.root) refuse("permission_denied", "path outside workspace");
      this.#allow = frame.allow;
      return ok(this.#dispatch(frame.mode, [...frame.args]));
    } catch (error) {
      if (error instanceof Refusal) {
        return { ok: false, error: error.path === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, path: error.path } };
      }
      const failure = error as NodeJS.ErrnoException;
      return { ok: false, error: { code: codeOf(error), message: failure.message } };
    }
  }

  #dispatch(mode: string, args: string[]): unknown {
    switch (mode) {
      case "info": { const path = args[0]!; this.#confineRead(path); return infoOf(path, lstatSync(path)); }
      case "list": {
        const path = args[0]!;
        this.#confineRead(path);
        return readdirSync(path).flatMap((name) => {
          try { return [infoOf(join(path, name), lstatSync(join(path, name)))]; } catch { return []; }
        });
      }
      case "canonical": { const path = args[0]!; this.#confineRead(path); return realpathSync(path); }
      case "exists": {
        const path = args[0]!;
        if (!lexists(path)) return false;
        this.#confineRead(path);
        return true;
      }
      case "read_text": { const path = args[0]!; this.#confineRead(path); this.#regular(path); return readFileSync(path, "utf8"); }
      case "read_binary": { const path = args[0]!; this.#confineRead(path); this.#regular(path); return readFileSync(path).toString("base64"); }
      case "open_reader": {
        const path = args[0]!;
        const noFollow = args[1] === "1";
        this.#confineRead(path);
        if (noFollow && lstatSync(path).isSymbolicLink()) refuse("invalid", "Refusing to follow a symbolic link");
        this.#regular(path);
        const st = statSync(path);
        return { path, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
      }
      case "reader_info": {
        const { fd, st } = this.#identity(args[0]!, Number(args[1]), Number(args[2]));
        closeSync(fd);
        return infoOf(args[0]!, st);
      }
      case "reader_read": {
        const { fd } = this.#identity(args[0]!, Number(args[1]), Number(args[2]));
        const offset = Number(args[3]);
        const length = Number(args[4]);
        try {
          const buffer = Buffer.alloc(length);
          const read = readSync(fd, buffer, 0, length, offset);
          return buffer.subarray(0, read).toString("base64");
        } finally { closeSync(fd); }
      }
      case "reader_scan": {
        const path = args[0]!;
        const startLine = Number(args[3]);
        const endLine = args[4] === "-1" ? undefined : Number(args[4]);
        if (startLine < 0 || (endLine !== undefined && endLine <= startLine)) refuse("invalid", "Invalid line range");
        const { fd } = this.#identity(path, Number(args[1]), Number(args[2]));
        try { return scan(readFileSync(fd), startLine, endLine); } finally { closeSync(fd); }
      }
      case "write_begin": {
        const path = args[0]!;
        this.#confine(this.root, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
        this.staging.add(path);
        return undefined;
      }
      case "write_chunk":
      case "append": {
        const path = args[0]!;
        const encoded = args[1] ?? "";
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) refuse("invalid", "Invalid base64-encoded string");
        const data = Buffer.from(encoded, "base64");
        this.#confine(this.root, path);
        if (mode === "append") mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data, { flag: "a" });
        return undefined;
      }
      case "write_commit": {
        const source = args[0]!;
        const destination = args[1]!;
        this.#confine(this.root, source);
        this.#confine(this.root, destination);
        renameSync(source, destination);
        this.staging.delete(source);
        return undefined;
      }
      case "write_abort": {
        const path = args[0]!;
        this.#confine(this.root, path);
        try { unlinkSync(path); } catch { /* a staging file that is already gone needs no second removal */ }
        this.staging.delete(path);
        return undefined;
      }
      case "truncate": {
        const path = args[0]!;
        const size = Number(args[1]);
        this.#confine(this.root, path);
        this.#regular(path);
        if (size < 0) refuse("invalid", "Invalid argument");
        truncateSync(path, size);
        return undefined;
      }
      case "flush": {
        const path = args[0]!;
        this.#confine(this.root, path);
        if (statSync(path).isDirectory()) refuse("is_directory", "Is a directory");
        return undefined;
      }
      case "rename": {
        const source = args[0]!;
        const destination = args[1]!;
        this.#confine(this.root, source);
        this.#confine(this.root, destination);
        if (args[2] === "1" && lexists(destination) && !lstatSync(destination).isSymbolicLink()) chmodSync(source, statSync(destination).mode & 0o7777);
        renameSync(source, destination);
        return undefined;
      }
      case "remove": {
        const path = args[0]!;
        const recursive = args[1] === "1";
        const force = args[2] === "1";
        if (force && !lexists(path)) return undefined;
        this.#confine(this.root, path);
        try {
          if (recursive && statSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) rmSync(path, { recursive: true });
          else unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !force) throw error;
        }
        return undefined;
      }
      case "mkdir": {
        const path = args[0]!;
        this.#confine(this.root, path);
        mkdirSync(path, { recursive: args[1] === "1" });
        return undefined;
      }
      case "tmpdir": return mkdtempSync(join(this.root, args[0] || "tmp-"));
      case "tmpfile": {
        const path = join(this.root, (args[0] || "tmp-") + randomUUID() + (args[1] ?? ""));
        writeFileSync(path, "", { flag: "wx" });
        return path;
      }
      case "snapshot": return { host: this.#discovery(), directories: [], files: [] };
      case "discover": return this.#discovery();
      default: refuse("not_supported", "unknown remote filesystem operation: " + mode);
    }
  }

  #discovery(): Record<string, unknown> {
    if (this.account.unresolvable === true) refuse("unknown", "the remote host did not report the execution account: KeyError('no such user')");
    const home = realish(this.account.home);
    const agentDir = join(home, ".pi", "agent");
    const shadowed = shadowedContextFile(this.root);
    return {
      user: this.account.user,
      home,
      workspaceRoot: this.root,
      roots: this.#resourceRoots(home, agentDir),
      contextFiles: this.#contextFiles(agentDir),
      systemPromptFiles: this.#promptFiles(agentDir, "SYSTEM.md"),
      appendSystemPromptFiles: this.#promptFiles(agentDir, "APPEND_SYSTEM.md"),
      ...(shadowed === null ? {} : { shadowedContextFile: shadowed }),
    };
  }

  /** Upstream's discovery order: project .pi, project .agents, the ancestors, the account, then prompts. */
  #resourceRoots(home: string, agentDir: string): Record<string, unknown>[] {
    const roots: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const add = (path: string, scope: string, kind: string, trusted = false): void => {
      const real = realDir(path);
      if (real === null || seen.has(real)) return;
      seen.add(real);
      roots.push(trusted ? { scope, kind, path: real, requiresTrust: true } : { scope, kind, path: real });
    };
    const stop = repositoryRoot(this.root);
    const accountAgents = realish(join(home, ".agents", "skills"));
    add(join(this.root, ".pi", "skills"), "project", "skills", true);
    add(join(this.root, ".agents", "skills"), "project", "skills");
    let directory = this.root;
    for (;;) {
      if (realish(join(directory, ".agents", "skills")) !== accountAgents) add(join(directory, ".agents", "skills"), "ancestor", "skills");
      if (stop !== null && directory === stop) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    add(join(agentDir, "skills"), "global", "skills");
    add(join(home, ".agents", "skills"), "global", "skills");
    add(join(this.root, ".pi", "prompts"), "project", "prompts", true);
    add(join(agentDir, "prompts"), "global", "prompts");
    return roots;
  }

  /** The account's context file first, then the workspace chain outermost first, deduplicated by real path. */
  #contextFiles(agentDir: string): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    const first = contextFile(agentDir);
    if (first !== null) { seen.add(first); found.push(first); }
    const chain: string[] = [];
    let directory = this.root;
    for (;;) {
      const current = contextFile(directory);
      if (current !== null && !seen.has(current)) chain.unshift(current);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const path of chain) if (!seen.has(path)) { seen.add(path); found.push(path); }
    return found;
  }

  #promptFiles(agentDir: string, name: string): { scope: string; path: string }[] {
    const files: { scope: string; path: string }[] = [];
    const global = realFile(join(agentDir, name));
    if (global !== null) files.push({ scope: "global", path: global });
    const project = realFile(join(this.root, ".pi", name));
    if (project !== null) files.push({ scope: "project", path: project });
    return files;
  }

  /** A read: the workspace root, the request's resource roots, and its resource files. Nothing else on the host. */
  #confineRead(path: string): void {
    for (const candidate of [this.root, ...this.#allow.roots]) {
      if (!lexicalWithin(candidate, path)) continue;
      if (realWithin(candidate, path) === undefined) refuse("permission_denied", "symlink outside " + candidate);
      return;
    }
    if (this.#allow.files.includes(path) && this.#allow.files.includes(realish(path))) return;
    refuse("permission_denied", "path outside workspace");
  }

  /** A mutation: confined to the workspace root, and a link out of it is refused at the nearest existing ancestor. */
  #confine(root: string, path: string): void {
    if (lexists(path)) {
      if (realWithin(root, path) === undefined) refuse("permission_denied", "path outside workspace");
      return;
    }
    let head = dirname(path);
    for (;;) {
      if (lexists(head)) {
        if (realWithin(root, head) === undefined) refuse("permission_denied", "path outside workspace");
        return;
      }
      const parent = dirname(head);
      if (parent === head) refuse("permission_denied", "path outside workspace");
      head = parent;
    }
  }

  /** The gateway's read bound in the gateway's own words: a refused read is one helper run, never a second pre-check. */
  #regular(path: string): void {
    const st = statSync(path);
    const kind = kindOf(st);
    if (kind === "directory") refuse("is_directory", "Not a regular file", path);
    if (kind !== "file") refuse("invalid", "Not a regular file", path);
    if (st.size > MAX_FILE) refuse("invalid", "file is " + st.size + " bytes; the gateway limit is " + MAX_FILE + " bytes", path);
  }

  /** The reader identity the helper keeps: the opened path and the device/inode it was opened as. */
  #identity(path: string, dev: number, ino: number): { fd: number; st: Stats } {
    this.#confineRead(path);
    const fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (st.dev !== dev || st.ino !== ino) {
      closeSync(fd);
      refuse("invalid", "file changed since the reader was opened");
    }
    return { fd, st };
  }
}

/** The child the runner's open returns: the streams the gateway's session writes frames to and reads them from. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #end: (signal: NodeJS.Signals) => void = () => {};

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.#end(signal); return true; }
  onEnd(end: (signal: NodeJS.Signals) => void): void { this.#end = end; }
}

class FakeSession implements FakeSshSession {
  readonly index: number;
  readonly frames: FakeFrame[] = [];
  readonly child = new FakeChild();
  #helper: FakeHelper;
  #options: FakeSshOptions;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onFrame: (frame: FakeFrame) => void;

  constructor(index: number, options: FakeSshOptions, onFrame: (frame: FakeFrame) => void) {
    this.index = index;
    this.#options = options;
    this.#onFrame = onFrame;
    this.#helper = new FakeHelper(options.root, options.account ?? { user: "remote-operator", home: join(options.root, "..", "remote-home") });
    this.child.onEnd(() => this.#die(null, "SIGKILL"));
    this.child.stdin.on("data", (chunk: Buffer) => this.#read(chunk));
    this.child.stdin.on("end", () => this.#graceful());
    this.child.stdin.on("finish", () => this.#graceful());
  }

  get closed(): boolean { return this.#closed; }

  kill(): void { this.#die(null, "SIGKILL"); }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 5) {
      const kind = this.#buffer.readUInt8(0);
      const length = this.#buffer.readUInt32BE(1);
      if (this.#buffer.length < 5 + length) return;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      if (kind === FRAME_CLOSE) { this.#graceful(); return; }
      if (kind !== FRAME_REQUEST || length > MAX_REQUEST) {
        this.#send(FRAME_RESULT, { ok: false, error: { code: "invalid", message: "the remote filesystem request exceeds the " + MAX_REQUEST + " byte session limit" } });
        this.#graceful();
        return;
      }
      this.#serve(payload);
    }
  }

  #serve(payload: Buffer): void {
    if (this.#options.startup !== undefined) { this.#startupFailure(); return; }
    const frame = JSON.parse(payload.toString("utf8")) as { mode: string; args?: string[]; root: string; allow?: { roots?: string[]; files?: string[] } };
    const request: FakeFrame = { mode: frame.mode, args: frame.args ?? [], root: frame.root, allow: { roots: frame.allow?.roots ?? [], files: frame.allow?.files ?? [] } };
    this.frames.push(request);
    this.#onFrame(request);
    const fault = this.#options.fault?.(request, this.index);
    if (fault === "exit") { this.#die(0); return; }
    if (fault === "oversize") {
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_RESULT, 0);
      header.writeUInt32BE(MAX_FRAME + 1, 1);
      this.child.stdout.write(header);
      return;
    }
    if (fault === "hang") return;
    this.#send(FRAME_RESULT, this.#helper.request(request));
  }

  #startupFailure(): void {
    const startup = this.#options.startup!;
    this.child.stderr.write(startup.stderr ?? "");
    setImmediate(() => this.#die(startup.exitCode ?? 255));
  }

  #send(kind: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(kind, 0);
    header.writeUInt32BE(payload.length, 1);
    this.child.stdout.write(Buffer.concat([header, payload]));
  }

  /** A graceful end: the staging files this session created are removed, exactly as the helper's own cleanup does. */
  #graceful(): void {
    if (this.#closed) return;
    for (const path of this.#helper.staging) { try { unlinkSync(path); } catch { /* already gone */ } }
    this.#helper.staging.clear();
    this.#die(0);
  }

  #die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    if (signal !== null) this.child.signalCode = signal; else this.child.exitCode = code;
    setImmediate(() => this.child.emit("close", code));
  }
}

/**
 * The gateway's SSH runner, served in this process. open hands back the session child; execute refuses, because the
 * session is the only filesystem path there is and a test must not be able to fall back to a per-call one.
 */
export function fakeSsh(options: FakeSshOptions): FakeSsh {
  const sessions: FakeSession[] = [];
  const frames: FakeFrame[] = [];
  const waiting: { mode: string; resolve: (frame: FakeFrame) => void }[] = [];
  const runner: SshRunner = {
    execute: async () => { throw new Error("the fake transport serves sessions only"); },
    open: (request) => {
      // The request names the helper the transport serves: the exact argv shape the gateway builds, with the profile's
      // root as the helper's own first argument, so a request cannot smuggle another program into the transport.
      assert.equal(request.command[0], "python3");
      assert.equal(request.command[1], "-c");
      assert.equal(request.command[4], request.root, "the session carries its own root");
      const session = new FakeSession(sessions.length, options, (frame) => {
        frames.push(frame);
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          if (waiting[index]!.mode !== frame.mode) continue;
          const waiter = waiting.splice(index, 1)[0]!;
          waiter.resolve(frame);
        }
      });
      sessions.push(session);
      return session.child as unknown as ChildProcess;
    },
  };
  return {
    runner,
    frames,
    sessions,
    opens: () => sessions.length,
    next: (mode) => new Promise<FakeFrame>((resolveFrame) => waiting.push({ mode, resolve: resolveFrame })),
    kill: () => { for (const session of sessions) session.kill(); },
  };
}
