import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, type FileErrorCode, type FileInfo, type LineScan } from "@earendil-works/pi-durable/env";
import { createSystemSshRunner, type SshProfile, type SshRunner } from "./index.ts";
import { MAX_FILE_BYTES, MAX_READERS, READER_TTL_MS, ReaderRegistry, agentDefinitionRoots, asFileError, contentOf, fileFailure, readerMethod, relativePath, resolveWorkspacePath, tempName, within, type ExecutionHost, type ExecutionHostIdentity, type FileRequest, type FilesystemServer, type GatewayReader, type ResourceRoot } from "./filesystem.ts";
import { REMOTE_FILESYSTEM_SCRIPT } from "./ssh-filesystem-helper.ts";
import { workspaceOwner, type WorkspaceRegistry } from "./workspaces.ts";

/** One remote filesystem request may run this long before the session drops it with an unknown outcome. */
export const SSH_FILE_TIMEOUT_MS = 60_000;
/**
 * Bytes of one base64 chunk sent to the remote writer. A chunk travels as one request frame, and the frame bound
 * (`MAX_REQUEST_BYTES`) is what a chunk has to fit under, so a write of the maximum size costs at most
 * `MAX_FILE_BYTES / WRITE_CHUNK_BYTES` frames.
 */
const WRITE_CHUNK_BYTES = 32 * 1024;

/**
 * The program reaches the host as one argv word, so the remote shell never has to parse it; `ssh` hands the whole
 * command to the remote shell, and the bootstrap restores `sys.argv` to the program's own arguments.
 */
const REMOTE_FILESYSTEM_BASE64 = Buffer.from(REMOTE_FILESYSTEM_SCRIPT, "utf8").toString("base64");
const REMOTE_BOOTSTRAP = "import base64,sys;src=base64.b64decode(sys.argv[1]);sys.argv=[sys.argv[0]]+sys.argv[2:];exec(compile(src,'hepi','exec'))";

/** One request frame's own bound, and the answer bound the session refuses to slice past. Both sides enforce them. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FRAME_REQUEST = 10;
const FRAME_RESULT = 11;
const FRAME_CLOSE = 12;
/** How long a session with no caller attached is kept before it is closed. The terminal's own reconnect window. */
const SESSION_IDLE_MS = 120_000;
/** How long a closed session's helper is given to end itself, staging cleanup included, before it is killed. */
const SESSION_END_GRACE_MS = 5000;

export type SshFilesystemOptions = {
  readonly id: string;
  readonly profiles: readonly SshProfile[];
  readonly runner?: SshRunner;
  /** The gateway's shared registry: a folder registered at runtime is served here at the root it was registered with. */
  readonly workspaces: WorkspaceRegistry;
  readonly readerTtlMs?: number;
  readonly maxReaders?: number;
  /** Overridden by tests that need a session to close at a known moment; the default is `SESSION_IDLE_MS`. */
  readonly sessionIdleMs?: number;
  /**
   * Overridden by tests that need the deadline at a known moment; the default is `SSH_FILE_TIMEOUT_MS`, the deadline
   * the one-shot transport applied to every file operation.
   */
  readonly requestTimeoutMs?: number;
};

/**
 * The read locations the remote helper accepts for one request, beyond the workspace root it always has: the
 * execution-side resource roots (ADR 0002) and the context, system-prompt and append-prompt files that live outside any
 * root. Everything else on the host stays unreachable, so resource access does not widen into a general home read.
 */
export type ReadAuthorization = {
  /** Execution-side resource roots a read may also name; empty for a mutation. */
  readonly roots: readonly string[];
  /** Execution-side resource files a read may also name; empty for a mutation. */
  readonly files: readonly string[];
  /** The same resource locations, for a mutation that refuses them instead of remapping them into the workspace. */
  readonly denied: readonly string[];
  /**
   * The one restricted resource surface a mutation may name besides the workspace: the host's agent definition
   * directories, when the request declared \`resource: "agent-definitions"\`. Each entry carries the directory and the
   * account home (or workspace) whose existing ancestors are the boundary the directory may be created under. Empty for
   * every other mutation.
   */
  readonly writes: readonly { readonly path: string; readonly boundary: string }[];
};

/** The reader identity the remote helper keeps: the opened path and the device/inode it was opened as. */
type RemoteReader = { readonly path: string; readonly dev: number; readonly ino: number; close(context: Context): Promise<void> };

type RemoteResult = { ok: true; value: unknown } | { ok: false; error: FileError };
type RemoteOpened = { path: string; size: number; mtimeMs: number; dev: number; ino: number };

const FILE_ERROR_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];

/**
 * One framed conversation with a host program: a request written, its result read, and what a death means. `settle`
 * detaches the request's abort listener before it answers, because the gateway's own controller outlives every request
 * and a listener left behind would accumulate for the life of the process.
 */
type Pending = { readonly answer: (result: RemoteResult) => void; written: boolean };

/**
 * One helper session for one `(profile, root)`: its process, the request it may have written, and the frames it reads.
 * A request waits its turn instead of opening a second channel, and the two ways a request can fail stay apart — a
 * request the session never wrote failed here and is reported as not sent, while one whose frame was written is the
 * host's outcome to report, which is unknown once the session dies. Nothing is ever replayed.
 */
class Session {
  readonly #profile: SshProfile;
  readonly #root: string;
  readonly #idleMs: number;
  #child: ChildProcess;
  #buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  /** The dispatch chain: one request in flight, every other waiter chained behind it. */
  #queue: Promise<void> = Promise.resolve();
  #idle: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  /** The one teardown this session runs, so a cancellation and a close cannot both end it. */
  #ending: Promise<void> | undefined;
  /** The gateway's file deadline for one request, the same bound the one-shot transport applied. */
  readonly #requestTimeoutMs: number;
  /** Set while a multi-part write is in progress, so an idle close cannot end the session under it. */
  #pinned = false;
  /** What the helper said before it answered anything, so a host that cannot run it at all is a named limit. */
  #stderr = "";
  #spawnError: string | undefined;
  #exitCode: number | null = null;
  /** Whether the helper has ever answered: a session that never did failed to start rather than failed a request. */
  #ready = false;

  constructor(profile: SshProfile, root: string, runner: SshRunner, command: readonly string[], idleMs: number, requestTimeoutMs: number) {
    this.#profile = profile;
    this.#root = root;
    this.#idleMs = idleMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    // The runner's transport owns the connection and the pipes; this session owns only the frames on them.
    this.#child = runner.open!({ profile: profile.id, host: profile.host, root, cwd: root, port: profile.port, identityFile: profile.identityFile, knownHostsFile: profile.knownHostsFile, command });
    this.#child.stdout!.on("data", (chunk: Buffer) => this.#consume(chunk));
    this.#child.stderr!.on("data", (chunk: Buffer) => { if (this.#stderr.length < 8192) this.#stderr += chunk.toString("utf8"); });
    // A write to a pipe whose far end is already gone reports EPIPE on the stream, not at the call site: it means the
    // session ended, which the close handler already reports, so it must not become an uncaught error.
    this.#child.stdin!.on("error", () => this.#die());
    this.#child.on("close", (code: number | null) => { this.#exitCode = code; this.#die(); });
    this.#child.on("error", (error: NodeJS.ErrnoException) => { this.#spawnError = error.code ?? error.message; this.#die(); });
    this.#touch();
  }

  get profile(): SshProfile { return this.#profile; }
  get closed(): boolean { return this.#closed; }

  /** Whether this session serves that profile and root: one session per pair, and nothing else reuses it. */
  matches(profile: SshProfile, root: string): boolean {
    return this.#profile.id === profile.id && this.#profile.host === profile.host && this.#root === root
      && this.#profile.port === profile.port && this.#profile.identityFile === profile.identityFile
      && this.#profile.knownHostsFile === profile.knownHostsFile;
  }

  /** Whether this session may be closed for being unused: nothing in flight and no pinned write. */
  get idle(): boolean { return this.#pending === undefined && !this.#pinned && !this.#closed; }

  pin(): void { this.#pinned = true; }

  unpin(): void { this.#pinned = false; this.#touch(); }

  /**
   * One request: wait for the session to be free, write the frame, and answer with what comes back. The request has
   * the gateway's own file deadline, so a host that accepts a frame and never answers cannot hold the request, or the
   * waiters chained behind it, forever.
   */
  request(mode: string, args: readonly string[], allow: ReadAuthorization | undefined, signal: AbortSignal): Promise<RemoteResult> {
    const expiresAt = Date.now() + this.#requestTimeoutMs;
    const run = this.#queue.then(() => this.#dispatch(mode, args, allow, signal, expiresAt));
    // A failed request is a value, not a broken chain: the next waiter still gets its turn.
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #dispatch(mode: string, args: readonly string[], allow: ReadAuthorization | undefined, signal: AbortSignal, expiresAt: number): Promise<RemoteResult> {
    if (this.#closed) return Promise.resolve(notSent());
    if (signal.aborted) return Promise.resolve(notSent());
    // A request that waited past its deadline was never written: that is a local failure, not an unknown remote
    // outcome, so it is reported as not sent rather than as a write that may have happened.
    if (Date.now() >= expiresAt) return Promise.resolve(notSent());
    const payload = Buffer.from(JSON.stringify({ mode, args, root: this.#root, allow: allow === undefined ? {} : { roots: allow.roots, files: allow.files, writes: allow.writes } }), "utf8");
    if (payload.length > MAX_REQUEST_BYTES) return Promise.resolve(dispatchFailure("invalid", "the request exceeds the " + MAX_REQUEST_BYTES + " byte session limit"));
    return new Promise<RemoteResult>((settle) => {
      const abort = () => {
        if (this.#pending !== pending) return;
        // The frame may or may not have reached the host: nothing is replayed, and the session is dropped rather than
        // letting a late answer be attributed to a later request.
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      };
      // The deadline starts when the frame is written: the host has the request, so the answer is its outcome to
      // report, and a late one is never attributed to a later request.
      const deadline = setTimeout(() => {
        if (this.#pending !== pending) return;
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      }, Math.max(0, expiresAt - Date.now()));
      const pending: Pending = {
        answer: (result) => { clearTimeout(deadline); signal.removeEventListener("abort", abort); settle(result); },
        written: false,
      };
      this.#pending = pending;
      this.#clearIdle();
      signal.addEventListener("abort", abort, { once: true });
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_REQUEST, 0);
      header.writeUInt32BE(payload.length, 1);
      pending.written = true;
      try {
        this.#child.stdin!.write(Buffer.concat([header, payload]));
      } catch {
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      }
    });
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 5) {
      const kind = this.#buffer.readUInt8(0);
      const length = this.#buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        // The stream is no longer trustworthy: the request fails and the session ends, rather than resynchronising.
        this.#fail("unknown", "the remote filesystem answer is above the " + MAX_FRAME_BYTES + " byte session limit");
        this.#drop();
        return;
      }
      if (this.#buffer.length < 5 + length) return;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      if (kind === FRAME_RESULT) this.#answer(payload);
      else if (kind === FRAME_CLOSE) this.#drop();
    }
  }

  #answer(payload: Buffer): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    this.#ready = true;
    let parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string; path?: string } };
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      pending.answer(dispatchFailure("unknown", "remote filesystem returned no result"));
      this.#drop();
      return;
    }
    pending.answer(parsed.ok === true
      ? { ok: true, value: parsed.value }
      : { ok: false, error: new FileError(fileErrorCode(parsed.error?.code), parsed.error?.message ?? "remote filesystem failed", parsed.error?.path) });
    this.#touch();
  }

  /** End the request in flight as the given failure, keeping "never sent" for one whose frame was not written. */
  #fail(code: FileErrorCode, message: string): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.answer(pending.written ? dispatchFailure(code, message) : notSent());
  }

  /**
   * The session is over: the request in flight is the host's unknown outcome, and no waiter was ever sent. A session
   * that never answered at all is a host that could not run the helper — a named limit, not an unknown outcome.
   */
  #die(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdle();
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.answer(pending.written ? this.#death() : notSent());
  }

  /**
   * What a death means for the request that was written and never answered. A session that never answered at all
   * failed to start, and how it failed is known: the transport could not reach the host, or the host cannot run the
   * helper. Only a session that had answered and then died leaves the operation's outcome unknown.
   */
  #death(): RemoteResult {
    if (this.#spawnError !== undefined) return dispatchFailure("unknown", "ssh host unreachable");
    if (!this.#ready) {
      const message = this.#stderr.trim();
      if (/python3: (command )?not found/i.test(this.#stderr)) return dispatchFailure("not_supported", "the SSH host needs Python 3 on PATH for gateway filesystem operations: " + (message || "the host has no python3"));
      // ssh's own failure code: the connection never carried a request, so the host is unreachable rather than unknown.
      if (this.#exitCode === 255) return dispatchFailure("unknown", "ssh host unreachable" + (message === "" ? "" : ": " + message));
    }
    return dispatchFailure("unknown", "ssh filesystem outcome unknown");
  }

  /** End the session the way `close` does: every gateway-initiated end is graceful and bounded. */
  #drop(): void { void this.close(); }

  /**
   * End the session: the helper is asked to close, and given the bounded grace to remove the staging files it created
   * itself, then it is killed. Every end the gateway initiates — an idle close, a cancellation, a deadline — takes
   * this path, so a session the gateway ends cleans up after itself. A host that has already gone cannot be asked,
   * which is why an abnormal death still leaves its residue.
   */
  async close(): Promise<void> {
    this.#ending ??= this.#end();
    await this.#ending;
  }

  async #end(): Promise<void> {
    this.#closed = true;
    this.#clearIdle();
    this.#fail("unknown", "ssh filesystem outcome unknown");
    const gone = this.#child.exitCode !== null || this.#child.signalCode !== null;
    const ending = gone ? Promise.resolve() : new Promise<void>((resolveEnd) => {
      const timer = setTimeout(() => { this.#child.kill("SIGKILL"); resolveEnd(); }, SESSION_END_GRACE_MS);
      this.#child.once("close", () => { clearTimeout(timer); resolveEnd(); });
    });
    const stdin = this.#child.stdin;
    if (stdin !== null && !stdin.destroyed) {
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_CLOSE, 0);
      header.writeUInt32BE(0, 1);
      try { stdin.write(header); } catch { /* the helper is already gone; the grace below still bounds the end */ }
      stdin.end();
    }
    await ending;
  }

  #touch(): void {
    this.#clearIdle();
    if (this.#closed || this.#pinned) return;
    this.#idle = setTimeout(() => { this.#idle = undefined; if (this.idle) void this.close(); }, this.#idleMs);
    this.#idle.unref?.();
  }

  #clearIdle(): void { if (this.#idle !== undefined) { clearTimeout(this.#idle); this.#idle = undefined; } }
}

function dispatchFailure(code: FileErrorCode, message: string): RemoteResult { return { ok: false, error: new FileError(code, message) }; }

/** A request the session never wrote: a local failure, never an unknown remote outcome. */
function notSent(): RemoteResult { return dispatchFailure("aborted", "the request was not sent"); }

/**
 * Serves `/v1/files` for SSH workspaces: `remote-<profile>` names a profile and the profile's `remoteRoot` is the
 * workspace. Read, write and edit work through one persistent Python 3 session per (profile, root) over the runner's
 * interactive transport; the gateway installs nothing on the host and no service listens there.
 *
 * Remote writes are staged: the target's directory holds a temporary file that receives the content and is then
 * renamed over the target, so a failed write leaves the previous content. A dispatched mutation whose response is lost
 * is not retried: the caller sees an unknown outcome rather than a second write. A request the session never wrote is
 * reported as not sent, which is a local failure with no remote effect.
 */
export class SshFilesystem implements FilesystemServer {
  readonly id: string;
  readonly #profiles: ReadonlyMap<string, SshProfile>;
  readonly #workspaces: WorkspaceRegistry;
  readonly #runner: SshRunner;
  readonly #sessions: Session[] = [];
  readonly #idleMs: number;
  readonly #requestTimeoutMs: number;
  readonly readers: ReaderRegistry<RemoteReader>;
  readonly #controller = new AbortController();

  constructor(options: SshFilesystemOptions) {
    this.id = options.id;
    this.#profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
    this.#workspaces = options.workspaces;
    this.#runner = options.runner ?? createSystemSshRunner();
    this.#idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? SSH_FILE_TIMEOUT_MS;
    this.readers = new ReaderRegistry(options.readerTtlMs ?? READER_TTL_MS, options.maxReaders ?? MAX_READERS);
  }

  async execute(request: FileRequest): Promise<unknown> {
    try {
      // The registry decides which profile and root an id names; an id it does not hold is unknown, never a prefix
      // that happens to match a profile's name.
      const owner = workspaceOwner(this.#workspaces, this.#profiles, request.workspaceId);
      if (owner === undefined) return fileFailure(new FileError("permission_denied", "unknown workspace"));
      const profile = owner.profile;
      this.readers.reap();
      const root = owner.root;
      // A transport that cannot hold a session open is a named limit, and there is no second per-call code path: the
      // capability is reported once instead of quietly changing what every request costs and how it can fail.
      if (this.#runner.open === undefined) return fileFailure(new FileError("not_supported", "this SSH transport cannot hold a filesystem session open"));
      if (request.method === "executionHost") return await this.#executionHost(profile, root);
      // One discovery is one helper request: the account, the roots and the text of every file the walk needs come back
      // together, so the per-request host resolution and the per-file read of the resource walk disappear.
      if (request.method === "resourceSnapshot") return await this.#snapshot(profile, root);
      // Every other method names a path, and a read also names the host locations it may reach. The read authorization
      // is resolved from the host itself, so a request can never name a resource root the host does not have. The three
      // methods that name no target path and pass no allow list resolve nothing: a temporary file and a reader close
      // have no resource location to refuse and no path to remap.
      const allow = NAMELESS_METHODS.includes(request.method) ? undefined : await this.#readAuthorization(profile, root, request);
      // A resource location is read-only, exactly as it is on the local filesystem: a mutation naming one is refused
      // instead of being remapped under the workspace, where it would create an unrelated file.
      // A mutation names one or two paths: `renameFile` also names its destination, which must be refused the same way.
      if (allow !== undefined && !READ_METHODS.includes(request.method)) {
        for (const target of [request.path, request.destinationPath]) {
          if (target !== undefined && mutationDenied(allow, root, target)) {
            return fileFailure(new FileError("permission_denied", "execution-side resource locations are read-only", target));
          }
        }
      }
      // The temporary-directory methods name no target path; everything else does. A read may name a resource
      // location by its real host path, which is not below the workspace and must not be remapped into it.
      const resourceRead = READ_METHODS.includes(request.method) && allow !== undefined && isResourceRead(allow, request.path);
      if (request.handle !== undefined) return await this.#reader(profile, request, allow, resourceRead);
      // A mutation inside an agent definition directory names a real absolute host path; every other mutation keeps the
      // workspace mapping, so an unauthorized absolute path still lands inside the workspace and is reported missing.
      const mutationTarget = (target: string | undefined): string | undefined => target === undefined ? undefined
        : allow !== undefined && isAgentWrite(allow, target) ? resolve(target) : remotePath(root, target);
      const path = request.path === undefined ? undefined : READ_METHODS.includes(request.method) ? remoteReadPath(root, request.path, allow) : mutationTarget(request.path);
      switch (request.method) {
        case "readTextFile": return await this.#readText(profile, root, path!, allow);
        case "readBinaryFile": return await this.#readBinary(profile, root, path!, allow);
        case "writeFile": return await this.#write(profile, root, path!, contentOf(request), allow);
        case "appendFile": return await this.#append(profile, root, path!, contentOf(request));
        case "truncateFile": return await this.#simple(profile, root, ["truncate", path!, String(request.size ?? 0)], allow);
        case "flushFile": return await this.#simple(profile, root, ["flush", path!], allow);
        case "renameFile": return await this.#simple(profile, root, ["rename", path!, mutationTarget(request.destinationPath)!, request.options?.preserveMode === true ? "1" : "0"], allow);
        case "remove": return await this.#simple(profile, root, ["remove", path!, request.options?.recursive === true ? "1" : "0", request.options?.force === true ? "1" : "0"], allow);
        case "createDir": return await this.#simple(profile, root, ["mkdir", path!, request.options?.recursive === false ? "0" : "1"], allow);
        case "createTempDir": { const result = await this.#call(profile, root, ["tmpdir", tempName(request.prefix ?? "tmp-")]); return result.ok ? { ok: true, value: relativePath(root, String(result.value)) } : fileFailure(result.error); }
        case "createTempFile": { const result = await this.#call(profile, root, ["tmpfile", tempName(request.prefix ?? "tmp-"), tempName(request.suffix ?? "")]); return result.ok ? { ok: true, value: relativePath(root, String(result.value)) } : fileFailure(result.error); }
        case "fileInfo": return await this.#info(profile, root, path!, allow, resourceRead);
        case "listDir": {
          const result = await this.#call(profile, root, ["list", path!], allow);
          return result.ok ? { ok: true, value: (result.value as FileInfo[]).map(item => reportInfo(root, item, resourceRead)) } : fileFailure(result.error);
        }
        case "canonicalPath": { const result = await this.#call(profile, root, ["canonical", path!], allow); return result.ok ? { ok: true, value: reportPath(root, String(result.value), resourceRead) } : fileFailure(result.error); }
        case "exists": return await this.#simple(profile, root, ["exists", path!], allow);
        case "openBinaryReader": return await this.#open(profile, root, path!, request.options?.noFollow === true, allow);
        default: return fileFailure(new FileError("not_supported", request.method + " is not supported by the SSH filesystem"));
      }
    } catch (error) { return fileFailure(asFileError(error)); }
  }

  /** Close every session this filesystem opened, after aborting the work in flight. */
  async close(): Promise<void> {
    this.#controller.abort();
    await this.readers.close();
    const sessions = this.#sessions.splice(0, this.#sessions.length);
    await Promise.all(sessions.map((session) => session.close()));
  }

  /** The host's own account, home and resource roots, discovered by the remote helper (ADR 0002). */
  async #executionHost(profile: SshProfile, root: string): Promise<unknown> {
    const host = await this.#host(profile, root);
    return host.ok ? { ok: true, value: host.value } : fileFailure(host.error);
  }

  /** The whole resource scope set of this host in one helper request (ADR 0002). */
  async #snapshot(profile: SshProfile, root: string): Promise<unknown> {
    const result = await this.#call(profile, root, ["snapshot"]);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  /**
   * The host's own account, home and scope set. The account and the discovery are one request, so the locations reads
   * are authorized against are still the host's answer and never a value the gateway supplied (ADR 0002), while a
   * request that needs them pays one round trip instead of two.
   */
  async #host(profile: SshProfile, root: string): Promise<{ ok: true; value: ExecutionHost } | { ok: false; error: FileError }> {
    const discovered = await this.#call(profile, root, ["discover"]);
    return discovered.ok ? { ok: true, value: discovered.value as ExecutionHost } : { ok: false, error: discovered.error };
  }

  /**
   * The read locations one request may name. Every method that names a path resolves them, because the workspace root
   * is also the helper's confinement root, so an unreachable host fails a write too. A mutation keeps only the
   * workspace: the resource roots stay readable and never writable through the file RPC.
   */
  async #readAuthorization(profile: SshProfile, root: string, request: FileRequest): Promise<ReadAuthorization> {
    const host = await this.#host(profile, root);
    if (!host.ok) throw host.error;
    return readAuthorization(host.value, request.method, request.resource === "agent-definitions");
  }

  /** A read whose own bound is the gateway's: the helper applies it and reports it in the gateway's words. */
  async #readText(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["read_text", path], allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #readBinary(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["read_binary", path], allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #info(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined, resourceRead: boolean): Promise<unknown> {
    const result = await this.#call(profile, root, ["info", path], allow);
    return result.ok ? { ok: true, value: reportInfo(root, result.value as FileInfo, resourceRead) } : fileFailure(result.error);
  }

  async #simple(profile: SshProfile, root: string, argv: readonly string[], allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, argv, allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #open(profile: SshProfile, root: string, path: string, noFollow: boolean, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["open_reader", path, noFollow ? "1" : "0"], allow);
    if (!result.ok) return fileFailure(result.error);
    const opened = result.value as RemoteOpened;
    // Nothing stays open on the host: each read re-opens the file and checks the identity it was opened as.
    const reader: RemoteReader = { path: opened.path, dev: opened.dev, ino: opened.ino, close: async () => {} };
    return { ok: true, value: this.readers.add(profile.id, root, reader) };
  }

  async #reader(profile: SshProfile, request: FileRequest, allow: ReadAuthorization | undefined, resourceRead: boolean): Promise<unknown> {
    const stored = this.readers.take(request.handle!, profile.id);
    if (stored === undefined) return fileFailure(new FileError("invalid", "unknown or expired reader"));
    if (request.method === "reader.close") { this.readers.remove(request.handle!); return { ok: true }; }
    const { path, dev, ino } = stored.reader;
    const reader: GatewayReader = {
      info: async () => {
        const result = await this.#call(profile, stored.root, ["reader_info", path, String(dev), String(ino)], allow);
        return result.ok ? { ok: true as const, value: reportInfo(stored.root, result.value as FileInfo, resourceRead) } : result;
      },
      read: async (offset: number, length: number) => {
        const result = await this.#call(profile, stored.root, ["reader_read", path, String(dev), String(ino), String(offset), String(length)], allow);
        return result.ok ? { ok: true as const, value: String(result.value) } : result;
      },
      scanLines: async (options: { startLine: number; endLine?: number }) => {
        const result = await this.#call(profile, stored.root, ["reader_scan", path, String(dev), String(ino), String(options.startLine), options.endLine === undefined ? "-1" : String(options.endLine)], allow);
        return result.ok ? { ok: true as const, value: result.value as LineScan } : result;
      },
    };
    return await readerMethod(reader, request);
  }

  /**
   * Stage `content` in the target directory, then rename it over the target so a failed write changes nothing. The
   * whole write rides one pinned session: an idle close or a cancellation cannot move a half-written file to another
   * helper, and a lost commit answer is an unknown outcome that is never re-sent.
   */
  async #write(profile: SshProfile, root: string, path: string, content: string | Uint8Array, allow?: ReadAuthorization): Promise<unknown> {
    const bytes = toBytes(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return fileFailure(new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit"));
    const staging = dirname(path) + "/.hepi-write-" + randomUUID() + ".tmp";
    const session = this.#session(profile, root);
    session.pin();
    try {
      const begun = await session.request("write_begin", [staging], allow, this.#controller.signal);
      if (!begun.ok) return fileFailure(begun.error);
      for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
        const chunk = Buffer.from(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)).toString("base64");
        const written = await session.request("write_chunk", [staging, chunk], allow, this.#controller.signal);
        if (!written.ok) { await session.request("write_abort", [staging], allow, this.#controller.signal); return fileFailure(written.error); }
      }
      const committed = await session.request("write_commit", [staging, path], allow, this.#controller.signal);
      if (!committed.ok) { await session.request("write_abort", [staging], allow, this.#controller.signal); return fileFailure(committed.error); }
      return { ok: true, value: undefined };
    } finally {
      session.unpin();
    }
  }

  /** Append `content` in bounded chunks, so no single request frame carries more than one chunk. */
  async #append(profile: SshProfile, root: string, path: string, content: string | Uint8Array): Promise<unknown> {
    const bytes = toBytes(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return fileFailure(new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit"));
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)).toString("base64");
      const written = await this.#call(profile, root, ["append", path, chunk]);
      if (!written.ok) return fileFailure(written.error);
    }
    if (bytes.byteLength === 0) return await this.#simple(profile, root, ["append", path, ""], undefined);
    return { ok: true, value: undefined };
  }

  /** One request on this (profile, root)'s session. */
  async #call(profile: SshProfile, root: string, argv: readonly string[], allow?: ReadAuthorization): Promise<RemoteResult> {
    return await this.#session(profile, root).request(argv[0]!, argv.slice(1), allow, this.#controller.signal);
  }

  /**
   * The one session for this (profile, root), opening it when there is none. A session that has ended is replaced by
   * the next request, which is why a death mid-write is reported rather than papered over: the write's own session
   * object is pinned and cannot be swapped for another.
   */
  #session(profile: SshProfile, root: string): Session {
    const existing = this.#sessions.find((session) => session.matches(profile, root) && !session.closed);
    if (existing !== undefined) return existing;
    // A session that has ended is forgotten here rather than kept: the next request opens its own.
    for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
      if (this.#sessions[index]!.closed) this.#sessions.splice(index, 1);
    }
    const session = new Session(profile, root, this.#runner, ["python3", "-c", REMOTE_BOOTSTRAP, REMOTE_FILESYSTEM_BASE64, root], this.#idleMs, this.#requestTimeoutMs);
    this.#sessions.push(session);
    return session;
  }
}

/** Methods that name no target path and pass no allow list: they resolve no authorization and run no discovery. */
const NAMELESS_METHODS: readonly string[] = ["createTempDir", "createTempFile", "reader.close"];

/** Whether a request only reads: those may name a resource location as well as the workspace. */
const READ_METHODS: readonly string[] = ["readTextFile", "readBinaryFile", "fileInfo", "listDir", "canonicalPath", "exists", "openBinaryReader", "reader.info", "reader.read", "reader.scanLines"];

/**
 * The host locations one request may name. A read reaches the workspace, the execution-side resource roots and the
 * host's own resource files; every other method is confined to the workspace and may only refuse those locations, so a
 * resource path is read-only exactly as it is on the local filesystem. An unauthorized absolute path is not remapped to
 * a resource; it keeps the workspace mapping and is reported missing, so it cannot be used to probe the host.
 */
export function readAuthorization(host: ExecutionHost, method: string, agentDefinitions = false): ReadAuthorization {
  const reading = READ_METHODS.includes(method);
  const resourceRoots = host.roots.map((root: ResourceRoot) => root.path);
  const resourceFiles = [host.contextFiles, host.systemPromptFiles.map((file) => file.path), host.appendSystemPromptFiles.map((file) => file.path)].flat();
  // The agent definition directories are the one named capability that reaches outside the workspace. A read may name
  // them; a mutation may write them, so they are added to neither the read roots nor the refused locations.
  const agentRoots = agentDefinitions ? agentDefinitionRoots(host) : [];
  return {
    roots: reading ? [...resourceRoots, ...agentRoots] : [],
    files: reading ? resourceFiles : [],
    denied: reading ? [] : [...resourceRoots, ...resourceFiles],
    writes: reading ? [] : agentRoots.map((path) => ({ path, boundary: within(host.workspaceRoot, path) ? host.workspaceRoot : host.home })),
  };
}

/**
 * Whether a request names an execution-side resource location rather than a workspace path. Such a read keeps its real
 * host path in results, while a workspace read keeps the logical workspace path — the same distinction the local
 * filesystem makes, so a project resource inside the workspace is still reported at the path the host's tools use.
 */
export function isResourceRead(allow: ReadAuthorization, path: string | undefined): boolean {
  if (path === undefined || !isAbsolute(path)) return false;
  const target = resolve(path);
  return allow.roots.some((location) => within(location, target)) || allow.files.includes(target);
}

/** Whether a mutating request names one of the request's own writable agent definition directories. */
export function isAgentWrite(allow: ReadAuthorization, path: string | undefined): boolean {
  if (path === undefined || !isAbsolute(path)) return false;
  const target = resolve(path);
  return allow.writes.some((location) => within(location.path, target));
}

/**
 * A result's path: the logical workspace path inside the workspace, and the real host path outside it. A resource root
 * lives outside the workspace, and its real path is the one ordinary host tools can read (ADR 0002), so it is reported
 * as-is rather than mangled into a workspace-relative form that names no file.
 */
export function reportPath(root: string, path: string, resourceRead: boolean): string {
  return resourceRead ? path : relativePath(root, path);
}

export function reportInfo(root: string, info: FileInfo, resourceRead: boolean): FileInfo {
  return { ...info, path: reportPath(root, info.path, resourceRead) };
}

/** A remote path in any of the three accepted forms; the helper confines the result to the profile's root. */
function remotePath(root: string, path: string | undefined): string { return resolveWorkspacePath(root, path); }

/**
 * Whether a mutating request names an execution-side resource location. Both accepted forms are checked: the raw
 * absolute host path a resource lives at, and the workspace-mapped path the logical (`/.agents/skills/...`) and
 * relative (`AGENTS.md`) aliases resolve to, so an alias cannot write a resource its physical path is refused.
 */
export function mutationDenied(allow: ReadAuthorization, root: string, path: string): boolean {
  return [path, remotePath(root, path)].some((candidate) => allow.denied.some((location) => within(location, resolve(candidate))));
}

/**
 * A read path: a relative or logical path is the workspace path it always was, and an absolute path inside one of the
 * request's read locations is taken as the real host path it is. Anything else keeps the workspace mapping, so an
 * unauthorized absolute path lands inside the workspace and is reported missing rather than served.
 */
function remoteReadPath(root: string, path: string | undefined, allow: ReadAuthorization | undefined): string {
  if (path === undefined || path === "") throw new FileError("invalid", "path is required");
  if (allow !== undefined && isAbsolute(path)) {
    const target = resolve(path);
    if (allow.roots.some((allowed) => within(allowed, target)) || allow.files.includes(target)) return target;
  }
  return remotePath(root, path);
}

function toBytes(content: string | Uint8Array): Uint8Array { return typeof content === "string" ? Buffer.from(content, "utf8") : content; }

function fileErrorCode(code: string | undefined): FileErrorCode { return FILE_ERROR_CODES.includes(code as FileErrorCode) ? code as FileErrorCode : "unknown"; }
